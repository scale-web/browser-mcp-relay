// idle-reaper-overlap.test.js — the overlap window (BROWSER_RELAY_OVERLAP_IDLE_MINUTES,
// asks as-ops/ask-fr3yfn + as-ops/ask-ocrmvy): an idle relay Brave closes SOONER
// only while another relay Brave is alive, and never while a tab shows a
// sign-in page or a visible password / one-time-code field.
//
//   1. Unit: userDataDirOf, otherRelayBraves (fake ps output), signInHold (fake
//      Playwright pages), SECRET_FIELD_PROBE (run in a vm against a fake DOM).
//   2. The real index.js main() under test/fixtures/relay-harness.js with a 3 s
//      full window and a 0.6 s overlap window.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { otherRelayBraves, signInHold, userDataDirOf, executableOf, closedRootSecret, SECRET_FIELD_PROBE } = require("../src/overlap-reap.js");
const { waitFor, startRelay } = require("./helpers/reaper-relay.js");

const T = { timeout: 30000 };
const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

// ───── 1. unit ─────

test("userDataDirOf reads the flag up to the next flag, spaces included", () => {
  assert.strictEqual(userDataDirOf(`${BRAVE} --a=1 --user-data-dir=/x/My Cache/p1 --b`), "/x/My Cache/p1");
  assert.strictEqual(userDataDirOf(`${BRAVE} --user-data-dir=/x/c/p2`), "/x/c/p2");
  assert.strictEqual(userDataDirOf(`${BRAVE} --foo`), null);
});

const fakePs = (text) => (cmd, args, opts, cb) => { fakePs.last = { cmd, args }; cb(null, text, ""); };

test("otherRelayBraves counts only OTHER relay main processes under the cache root", async () => {
  const root = "/tmp/relay-cache-test";
  const ps = [
    `  100 ${BRAVE} --user-data-dir=${root}/profiles/mine --x`,                    // own pid
    `  101 ${BRAVE} --user-data-dir=${root}/profiles/other --x`,                   // counted
    `  102 ${BRAVE} --user-data-dir=${root}/session-clones-plainflags/a-p9-z`,     // counted
    `  103 ${BRAVE} --type=renderer --user-data-dir=${root}/profiles/other`,       // helper
    `  104 ${BRAVE}`,                                                              // Trevor's own Brave
    `  105 ${BRAVE} --user-data-dir=/Users/x/elsewhere`,                           // not a relay
    `  106 ${BRAVE} --user-data-dir=${root}-other/profiles/p`,                     // prefix trap
    `  107 ${BRAVE} --user-data-dir=${root}/profiles/mine`,                        // own dir, other pid
    `garbage line`,
  ].join("\n");
  const r = await otherRelayBraves({ cacheRoot: root, ownDir: `${root}/profiles/mine`, ownPid: 100, _execFile: fakePs(ps) });
  assert.deepStrictEqual(r, { ok: true, pids: [101, 102] });
  assert.strictEqual(fakePs.last.cmd, "/bin/ps");
  assert.ok(fakePs.last.args.includes("-axww"), "args must not be truncated (-ww)");
});

test("otherRelayBraves counts only the SAME executable as this relay's own Brave (review r1 L3)", async () => {
  const root = "/tmp/relay-cache-test";
  const BETA = "/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta";
  const CFT = "/x/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const ps = [
    `  200 ${BRAVE} --x --user-data-dir=${root}/profiles/mine --remote-debugging-pipe`,
    `  201 ${BRAVE} --x --user-data-dir=${root}/profiles/other --remote-debugging-pipe`,
    `  202 ${BETA} --user-data-dir=${root}/profiles/beta`,
    `  203 ${CFT} --user-data-dir=${root}/session-clones/script`,
  ].join("\n");
  // Own Brave found by pid, and (attached: bravePid null) by its dir.
  assert.deepStrictEqual(await otherRelayBraves({ cacheRoot: root, ownDir: `${root}/profiles/mine`, ownPid: 200, _execFile: fakePs(ps) }), { ok: true, pids: [201] });
  assert.deepStrictEqual(await otherRelayBraves({ cacheRoot: root, ownDir: `${root}/profiles/mine`, ownPid: null, _execFile: fakePs(ps) }), { ok: true, pids: [201] });
  // Own Brave not in the listing: no executable filter (every relay-dir main counts).
  assert.deepStrictEqual(await otherRelayBraves({ cacheRoot: root, ownDir: `${root}/profiles/gone`, ownPid: 999, _execFile: fakePs(ps) }), { ok: true, pids: [200, 201, 202, 203] });
  assert.strictEqual(executableOf(`${BRAVE} --a --b`), BRAVE);
  assert.strictEqual(executableOf(BRAVE), BRAVE);
});

test("otherRelayBraves: no other relay → ok with no pids", async () => {
  const r = await otherRelayBraves({ cacheRoot: "/tmp/rc", ownDir: "/tmp/rc/profiles/m", ownPid: 1, _execFile: fakePs(`  1 ${BRAVE} --user-data-dir=/tmp/rc/profiles/m\n`) });
  assert.deepStrictEqual(r, { ok: true, pids: [] });
});

test("otherRelayBraves: a failed or hung ps is ok:false (the caller must not reap early)", async () => {
  const failed = await otherRelayBraves({ cacheRoot: "/tmp/rc", _execFile: (c, a, o, cb) => cb(new Error("boom"), "", "") });
  assert.strictEqual(failed.ok, false);
  const t0 = Date.now();
  const hung = await otherRelayBraves({ cacheRoot: "/tmp/rc", timeoutMs: 100, _execFile: () => ({}) });
  assert.deepStrictEqual(hung, { ok: false, reason: "ps-timeout" });
  assert.ok(Date.now() - t0 < 2500, "hard cap must end the wait");
  assert.strictEqual((await otherRelayBraves({ cacheRoot: null })).ok, false);
});

const CLOSED_PW = { nodeName: "#document", children: [{ nodeName: "DIV", shadowRoots: [{ nodeName: "#document-fragment",
  shadowRootType: "closed", children: [{ nodeName: "INPUT", attributes: ["type", "password"] }] }] }] };
function fakeContext(specs, { cdp } = {}) {
  return {
    pages: () => specs.map((s) => {
      const frames = [{ url: () => s.url, evaluate: s.evaluate || (async () => !!s.secret) },
        ...(s.frameUrls || []).map((u) => ({ url: () => u, evaluate: async () => false }))];
      return { url: () => s.url, frames: () => frames, dom: s.dom };
    }),
    newCDPSession: cdp || (async (page) => ({ send: async () => ({ root: page.dom || { nodeName: "#document" } }), detach: async () => {} })),
  };
}

test("signInHold: blank and ordinary pages do not hold", async () => {
  assert.deepStrictEqual(await signInHold(fakeContext([{ url: "about:blank" }, { url: "chrome://newtab/" }])), { hold: false, reason: "none" });
  assert.deepStrictEqual(await signInHold(fakeContext([{ url: "https://app.gohighlevel.com/v2/location/x/dashboard" }])), { hold: false, reason: "none" });
  assert.deepStrictEqual(await signInHold(fakeContext([])), { hold: false, reason: "none" });
});

test("signInHold: a visible secret field in any frame holds", async () => {
  const r = await signInHold(fakeContext([{ url: "about:blank" }, { url: "https://vendor.example/login", secret: true }]));
  assert.deepStrictEqual(r, { hold: true, reason: "secret-field", kind: "password", host: "vendor.example" });
});

test("signInHold: a known sign-in page holds even with no secret field (email-first step)", async () => {
  const r = await signInHold(fakeContext([{ url: "https://accounts.google.com/v3/signin/identifier" }]));
  assert.strictEqual(r.hold, true);
  assert.strictEqual(r.reason, "sign-in-page");
  const framed = await signInHold(fakeContext([{ url: "https://app.example/", frameUrls: ["https://accounts.google.com/o/oauth2/auth"] }]));
  assert.strictEqual(framed.reason, "sign-in-page", "a sign-in page inside an iframe holds");
});

test("signInHold: a secret input in a CLOSED shadow root holds; a CDP failure holds (review r1 M1)", async () => {
  assert.deepStrictEqual(await signInHold(fakeContext([{ url: "https://w.example/", dom: CLOSED_PW }])), { hold: true, reason: "secret-field", kind: "closed-root", host: "w.example" });
  const failed = await signInHold(fakeContext([{ url: "https://w.example/" }], { cdp: async () => { throw new Error("no cdp"); } }));
  assert.strictEqual(failed.reason, "unreadable");
  // A blank tab is not read over CDP at all.
  assert.deepStrictEqual(await signInHold(fakeContext([{ url: "about:blank" }], { cdp: async () => { throw new Error("must not be called"); } })), { hold: false, reason: "none" });
});

test("signInHold: every CDP session is detached; the closed-root read is cached per URL; same-process frames are skipped (review r2)", async () => {
  let opened = 0, detached = 0, reads = 0;
  const ctx = (sameProcessFrames) => ({
    pages: () => [{ url: () => "https://w.example/a", frames: () => [
      { url: () => "https://w.example/a", evaluate: async () => "" },
      { url: () => "https://w.example/inner", evaluate: async () => "", child: true },
    ] }],
    newCDPSession: async (t) => {
      if (t.child && sameProcessFrames) throw new Error("This frame does not have a separate CDP session, it is a part of the parent frame's session");
      opened++;
      return { send: async () => { reads++; if (t.child) throw new Error("boom"); return { root: { nodeName: "#document" } }; }, detach: async () => { detached++; } };
    },
  });
  // A same-process child frame is skipped, not unreadable.
  assert.deepStrictEqual(await signInHold(ctx(true)), { hold: false, reason: "none" });
  assert.strictEqual(opened, 1);
  assert.strictEqual(detached, 1, "the page's session is detached");
  // An out-of-process child whose read fails holds, and its session is still detached.
  opened = detached = 0;
  assert.strictEqual((await signInHold(ctx(false))).reason, "unreadable");
  assert.strictEqual(detached, opened, "every opened session is detached, the failing one too");
  // Cache: a second call within the idle period reads nothing over CDP.
  const cache = new Map();
  reads = 0;
  await signInHold(ctx(true), { closedCache: cache });
  assert.strictEqual(reads, 1);
  await signInHold(ctx(true), { closedCache: cache });
  assert.strictEqual(reads, 1, "cached per URL until the caller clears it");
});

test("closedRootSecret: only inputs inside a closed root, password / one-time-code / short code boxes", () => {
  const inClosed = (attributes) => ({ nodeName: "#document", children: [{ nodeName: "X", shadowRoots: [{ shadowRootType: "closed", children: [{ nodeName: "INPUT", attributes }] }] }] });
  assert.strictEqual(closedRootSecret(inClosed(["type", "password"])), true);
  assert.strictEqual(closedRootSecret(inClosed(["autocomplete", "one-time-code"])), true);
  assert.strictEqual(closedRootSecret(inClosed(["type", "tel", "maxlength", "6"])), true);
  assert.strictEqual(closedRootSecret(inClosed(["type", "text"])), false);
  assert.strictEqual(closedRootSecret(inClosed(["type", "search", "maxlength", "6"])), false);
  // An OPEN root is the probe's job, not this one's.
  const open = { nodeName: "#document", children: [{ nodeName: "X", shadowRoots: [{ shadowRootType: "open", children: [{ nodeName: "INPUT", attributes: ["type", "password"] }] }] }] };
  assert.strictEqual(closedRootSecret(open), false);
  // A closed root nested in an open one, and one inside a same-process iframe document.
  const nested = { nodeName: "#document", children: [{ nodeName: "X", shadowRoots: [{ shadowRootType: "open", children: [{ nodeName: "Y", shadowRoots: [{ shadowRootType: "closed", children: [{ nodeName: "INPUT", attributes: ["type", "password"] }] }] }] }] }] };
  assert.strictEqual(closedRootSecret(nested), true);
  assert.strictEqual(closedRootSecret({ nodeName: "IFRAME", contentDocument: inClosed(["type", "password"]) }), true);
});

test("signInHold: an unreadable, throwing or hung frame holds", async () => {
  const thrown = await signInHold(fakeContext([{ url: "https://a.example/", evaluate: async () => { throw new Error("detached"); } }]));
  assert.deepStrictEqual(thrown, { hold: true, reason: "unreadable", host: "a.example" });
  const t0 = Date.now();
  const hung = await signInHold(fakeContext([{ url: "https://a.example/", evaluate: () => new Promise(() => {}) }]), { timeoutMs: 1200 });
  assert.strictEqual(hung.reason, "unreadable");
  assert.ok(Date.now() - t0 < 2500);
  const noPages = await signInHold({ pages: () => { throw new Error("closed"); } });
  assert.strictEqual(noPages.reason, "unreadable");
});

// The probe in a REAL Chromium DOM (review r1: a fake DOM cannot show shadow-root or visibility behaviour).
// Chrome for Testing from Playwright's cache, headless, its own temp profile; skipped when not installed.
let chromium = null;
try { ({ chromium } = require("playwright")); if (!fs.existsSync(chromium.executablePath())) chromium = null; } catch { chromium = null; }
const PROBE_CASES = [
  // [name, html, the kind the probe must return ("" = must not hold)]
  ["plain visible password", `<input type=password>`, "password"],
  ["password in an OPEN shadow root", `<div id=h></div><script>h.attachShadow({mode:"open"}).innerHTML="<input type=password>"</script>`, "password"],
  ["password two open roots deep", `<div id=h></div><script>const a=h.attachShadow({mode:"open"});a.innerHTML="<div id=i></div>";a.getElementById("i").attachShadow({mode:"open"}).innerHTML="<input type=password>"</script>`, "password"],
  ["autocomplete one-time-code", `<input autocomplete="one-time-code">`, "code"],
  ["2FA: name=otp maxlength=6", `<input name=otp inputmode=numeric maxlength=6>`, "code"],
  ["2FA: aria-label Verification code", `<input aria-label="Verification code" maxlength=6>`, "code"],
  ["2FA: name=mfaCode, no maxlength (r2 MEDIUM-2)", `<input name=mfaCode>`, "code"],
  ["2FA: placeholder Enter security code, no maxlength", `<input placeholder="Enter security code">`, "code"],
  ["2FA: name=twofactor_token maxlength=6", `<input name=twofactor_token maxlength=6>`, "code"],
  ["2FA: name=token maxlength=6", `<input name=token maxlength=6>`, "code"],
  ["2FA: <label for> Verification code", `<label for=x>Verification code</label><input id=x maxlength=6>`, "code"],
  ["2FA: pinCode maxlength=4", `<input name=pinCode maxlength=4>`, "code"],
  ["2FA: six unhinted maxlength=1 boxes", `<div>${"<input maxlength=1>".repeat(6)}</div>`, "code"],
  ["2FA: four boxes each in its own span", `<div>${"<span><input maxlength=1></span>".repeat(4)}</div>`, "code"],
  ["email-first: visible email + hidden password in one form", `<form><input type=email><input type=password style="display:none"></form>`, "email-first"],
  ["email-first: autocomplete=username", `<form><input autocomplete=username><input type=password hidden></form>`, "email-first"],
  ["email-first: type=text name=email", `<form><input type=text name=email><input type=password hidden></form>`, "email-first"],
  // must NOT hold (r1 L1, r2 MEDIUM-1)
  ["display:none password alone", `<input type=password style="display:none">`, ""],
  ["visibility:hidden password", `<input type=password style="visibility:hidden">`, ""],
  ["opacity:0 password", `<input type=password style="opacity:0">`, ""],
  ["zero-size password", `<input type=password style="width:0;height:0;padding:0;border:0">`, ""],
  ["closed <details> password", `<details><input type=password></details>`, ""],
  ["off-screen anti-autofill password", `<input type=password style="position:absolute;left:-9999px">`, ""],
  ["newsletter email, no password", `<form><input type=email></form>`, ""],
  ["newsletter email outside a form + hidden modal password outside a form", `<input type=email><div hidden><input type=password></div>`, ""],
  ["email in one form, hidden password in another", `<form><input type=email></form><form><input type=password hidden></form>`, ""],
  ["ordinary text + search", `<input type=text name=q><input type=search maxlength=6>`, ""],
  ["ZIP: inputmode numeric maxlength 5", `<input name=zip inputmode=numeric maxlength=5>`, ""],
  ["postal_code maxlength 6", `<input name=postal_code maxlength=6>`, ""],
  ["country_code maxlength 3", `<input name=country_code maxlength=3>`, ""],
  ["countryCode maxlength 3", `<input name=countryCode maxlength=3>`, ""],
  ["currency_code maxlength 3", `<input name=currency_code maxlength=3>`, ""],
  ["ZIP code label", `<label for=z>ZIP code</label><input id=z maxlength=5>`, ""],
  ["Area code", `<input aria-label="Area code" maxlength=3>`, ""],
  ["Hex code", `<input placeholder="Hex code" maxlength=7>`, ""],
  ["Discount code", `<input name=discount_code maxlength=8>`, ""],
  ["promo_code long", `<input name=promo_code maxlength=40>`, ""],
  ["card expiry MM/YY", `<input name=exp inputmode=numeric maxlength=5>`, ""],
  ["year box", `<input name=year inputmode=numeric maxlength=4>`, ""],
  ["time HH", `<input name=hh inputmode=numeric maxlength=2>`, ""],
  ["go to page box", `<input aria-label="Go to page" inputmode=numeric maxlength=3>`, ""],
  ["id=footprint-size", `<input id=footprint-size maxlength=4>`, ""],
  ["smsConsent checkbox-ish text", `<input name=smsConsent maxlength=3>`, ""],
  ["verified_badge long", `<input name=verified_badge_text maxlength=40>`, ""],
  ["three single boxes only", `<div>${"<input maxlength=1>".repeat(3)}</div>`, ""],
];
test("SECRET_FIELD_PROBE in real Chromium: sign-in shapes hold, hidden / ordinary inputs do not", { ...T, skip: chromium ? false : "Chrome for Testing not installed" }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const wrong = [];
    for (const [name, html, want] of PROBE_CASES) {
      await page.setContent(`<!doctype html><body>${html}</body>`);
      const got = await page.evaluate(SECRET_FIELD_PROBE);
      if (got !== want) wrong.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    assert.deepStrictEqual(wrong, []);
  } finally { await browser.close(); }
});

test("signInHold in real Chromium: a password in a CLOSED shadow root holds (over CDP); a plain page does not", { ...T, skip: chromium ? false : "Chrome for Testing not installed" }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(`<div id=h></div><script>document.getElementById("h").attachShadow({mode:"closed"}).innerHTML="<input type=password>"</script>`)}`);
    assert.strictEqual(await page.evaluate(SECRET_FIELD_PROBE), "", "the main-world probe cannot see a closed root");
    assert.deepStrictEqual(await signInHold(context), { hold: true, reason: "secret-field", kind: "closed-root", host: null });
    await page.goto(`data:text/html,${encodeURIComponent("<p>dashboard</p><input type=search>")}`);
    assert.deepStrictEqual(await signInHold(context), { hold: false, reason: "none" });
  } finally { await browser.close(); }
});

// ───── 2. the real main() ─────

// Full window 3 s, overlap 0.6 s; the reaper ticks every 0.6 s.
const IDLE = "0.05";
const OVERLAP = "0.01";
const otherRelayLine = (dir) => `  4242 ${BRAVE} --flag --user-data-dir=${path.join(dir, "cache", "profiles", "other")} --flag2\n`;

async function relayWith({ pages, ps, psFail, overlap = OVERLAP }) {
  const files = {};
  if (pages) files["fake-pages"] = JSON.stringify(pages);
  if (psFail) files["ps-overlap-fail"] = "";
  const r = await startRelay({ idleMinutes: IDLE, files, extraEnv: { BROWSER_RELAY_OVERLAP_IDLE_MINUTES: overlap } });
  if (ps !== undefined) fs.writeFileSync(path.join(r.dir, "ps-overlap"), typeof ps === "function" ? ps(r.dir) : ps);
  return r;
}
const closed = (r) => r.count(/HARNESS brave-closed .* hard/g);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test("main(): idle Brave closes in the overlap window while another relay Brave is alive", T, async () => {
  const r = await relayWith({ pages: ["https://app.example/dashboard"], ps: otherRelayLine });
  try {
    await r.call();
    const t0 = Date.now();
    await waitFor(() => closed(r) === 1, 2700, "overlap reap");
    assert.ok(Date.now() - t0 < 2700, "must close before the 3 s full window");
    assert.match(r.stderr(), /other relay Brave\(s\) are open/);
    assert.match(r.stderr(), /idle reaper armed \(0\.05min; 0\.01min while another relay Brave is open\)/);
    // The next call relaunches it.
    await r.call();
    const launches = fs.readFileSync(path.join(r.dir, "brave-launches"), "utf8").trim().split("\n");
    assert.strictEqual(launches.length, 2, "the next call relaunches Brave");
  } finally { await r.stop(); }
});

test("main(): no other relay Brave → only the full window reaps", T, async () => {
  const r = await relayWith({ pages: ["https://app.example/dashboard"], ps: `  1 ${BRAVE}\n` });
  try {
    await r.call();
    await sleep(2200);
    assert.strictEqual(closed(r), 0, "must not close early with no other relay Brave");
    assert.ok(fs.readFileSync(path.join(r.dir, "ps-overlap-calls"), "utf8").length > 0, "the overlap check ran");
    await waitFor(() => closed(r) === 1, 4000, "full reap");
    assert.match(r.stderr(), /idle 0\.05min — reaping/);
  } finally { await r.stop(); }
});

for (const [name, pages] of [
  ["a visible secret field", [{ url: "https://vendor.example/login", secret: true }]],
  ["a known sign-in page", ["https://accounts.google.com/v3/signin/identifier"]],
  ["an unreadable frame", [{ url: "https://vendor.example/", throws: true }]],
  ["a password in a closed shadow root", [{ url: "https://vendor.example/", closedSecret: true }]],
]) {
  test(`main(): ${name} holds the overlap reap (the full window still applies)`, T, async () => {
    const r = await relayWith({ pages, ps: otherRelayLine });
    try {
      await r.call();
      await sleep(2200);
      assert.strictEqual(closed(r), 0, `${name} must hold`);
      await waitFor(() => closed(r) === 1, 4000, "full reap");
    } finally { await r.stop(); }
  });
}

test("main(): a failed ps holds the overlap reap", T, async () => {
  const r = await relayWith({ pages: ["https://app.example/"], psFail: true });
  try {
    await r.call();
    await sleep(2200);
    assert.strictEqual(closed(r), 0);
  } finally { await r.stop(); }
});

test("main(): a fresh keep-alive file holds the overlap reap", T, async () => {
  const r = await relayWith({ pages: ["https://app.example/"], ps: otherRelayLine });
  try {
    await r.call();
    fs.writeFileSync(path.join(r.profileDir, ".mcp-relay-keepalive"), "");
    await sleep(2200);
    assert.strictEqual(closed(r), 0, "keep-alive within the FULL window must hold");
  } finally { await r.stop(); }
});

test("main(): BROWSER_RELAY_OVERLAP_IDLE_MINUTES=0 or >= the full window disables it", T, async () => {
  for (const overlap of ["0", "0.05", "nope"]) {
    const r = await relayWith({ pages: ["https://app.example/"], ps: otherRelayLine, overlap });
    try {
      await r.call();
      await sleep(2200);
      assert.strictEqual(closed(r), 0, `overlap=${overlap} must not close early`);
      assert.match(r.stderr(), /idle reaper armed \(0\.05min\)/);
    } finally { await r.stop(); }
  }
});

test("main(): a failed lsof holds the overlap reap (the full window keeps its old fall-through)", T, async () => {
  const files = { "fake-pages": JSON.stringify(["https://app.example/"]), "lsof-bin": "/nonexistent/relay-test-lsof" };
  const r = await startRelay({ idleMinutes: IDLE, files, extraEnv: { BROWSER_RELAY_OVERLAP_IDLE_MINUTES: OVERLAP } });
  fs.writeFileSync(path.join(r.dir, "ps-overlap"), otherRelayLine(r.dir));
  try {
    await r.call();
    await sleep(2200);
    assert.strictEqual(closed(r), 0, "an lsof that cannot answer must hold in the overlap window");
    assert.match(r.stderr(), /external-CDP-client check unavailable/);
    await waitFor(() => closed(r) === 1, 4000, "full reap still falls through on a failed lsof");
  } finally { await r.stop(); }
});

// Review r1 L2: what the reap log says about the overlap window.
const reapEvents = (r) => {
  try { return fs.readFileSync(path.join(r.dir, "cache", "reap-events.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

test("main(): an overlap hold is logged once per idle period, and again after a tool call", T, async () => {
  const r = await relayWith({ pages: [{ url: "https://vendor.example/login", secret: true }], ps: otherRelayLine });
  fs.mkdirSync(path.join(r.dir, "cache"), { recursive: true });
  try {
    await r.call();
    await waitFor(() => reapEvents(r).some((e) => e.event === "overlap-held"), 2500, "first overlap-held");
    await sleep(1300); // two more ticks, same reason
    assert.strictEqual(reapEvents(r).filter((e) => e.event === "overlap-held").length, 1, "once per reason per idle period");
    await r.call();
    await waitFor(() => reapEvents(r).filter((e) => e.event === "overlap-held").length === 2, 2500, "logged again after activity");
    const e = reapEvents(r).find((x) => x.event === "overlap-held");
    assert.strictEqual(e.reason, "secret-field");
    assert.strictEqual(e.host, "vendor.example");
  } finally { await r.stop(); }
});

test("main(): a failed lsof in the overlap window is logged once, not every tick", T, async () => {
  const files = { "fake-pages": JSON.stringify(["https://app.example/"]), "lsof-bin": "/nonexistent/relay-test-lsof" };
  const r = await startRelay({ idleMinutes: IDLE, files, extraEnv: { BROWSER_RELAY_OVERLAP_IDLE_MINUTES: OVERLAP } });
  fs.writeFileSync(path.join(r.dir, "ps-overlap"), otherRelayLine(r.dir));
  fs.mkdirSync(path.join(r.dir, "cache"), { recursive: true });
  try {
    await r.call();
    await sleep(2500);
    assert.strictEqual(closed(r), 0);
    assert.strictEqual(reapEvents(r).filter((e) => e.event === "lsof-failed").length, 1);
  } finally { await r.stop(); }
});

test("main(): a failed ps holds and is logged once (overlap-held ps-failed)", T, async () => {
  const r = await relayWith({ pages: ["https://app.example/"], psFail: true });
  fs.mkdirSync(path.join(r.dir, "cache"), { recursive: true });
  try {
    await r.call();
    await sleep(2200);
    assert.strictEqual(closed(r), 0);
    const held = reapEvents(r).filter((e) => e.event === "overlap-held");
    assert.strictEqual(held.length, 1);
    assert.strictEqual(held[0].reason, "ps-failed");
  } finally { await r.stop(); }
});

test("signInHold in real Chromium: a closed-root password inside a CROSS-SITE iframe holds (review r2 LOW-1)", { ...T, skip: chromium ? false : "Chrome for Testing not installed" }, async () => {
  const http = require("node:http");
  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/inner") res.end(`<div id=h></div><script>document.getElementById("h").attachShadow({mode:"closed"}).innerHTML="<input type=password>"</script>`);
    else res.end(`<p>outer</p><iframe src="http://localhost:${srv.address().port}/inner"></iframe>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForLoadState("load");
    assert.strictEqual(page.frames().length, 2);
    const h = await signInHold(context);
    assert.strictEqual(h.reason, "secret-field");
    assert.strictEqual(h.kind, "closed-root");
  } finally { await browser.close(); srv.close(); }
});

test("main(): the closed-root CDP read is cached for the idle period and read again after a tool call (review r2 LOW-2)", T, async () => {
  const r = await relayWith({ pages: ["https://app.example/"], ps: otherRelayLine });
  const reads = () => { try { return fs.readFileSync(path.join(r.dir, "cdp-reads"), "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  const keepalive = () => fs.writeFileSync(path.join(r.profileDir, ".mcp-relay-keepalive"), ""); // holds the reap, not the checks
  try {
    await r.call();
    keepalive();
    await waitFor(() => reads() >= 1, 2500, "first closed-root read");
    await sleep(1300); // two more overlap ticks
    assert.strictEqual(reads(), 1, "cached within the idle period");
    assert.strictEqual(closed(r), 0);
    await r.call();
    keepalive();
    await waitFor(() => reads() === 2, 2500, "read again after a tool call");
  } finally { await r.stop(); }
});
