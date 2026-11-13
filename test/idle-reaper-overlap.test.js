// idle-reaper-overlap.test.js — the overlap window (BROWSER_RELAY_OVERLAP_IDLE_MINUTES,
// asks as-ops/ask-fr3yfn, as-ops/ask-ocrmvy, as-ops/ask-b7xcc7): an idle relay Brave
// closes SOONER only while another relay Brave is alive, and never while someone is
// using it (it was the frontmost process at a sample in the last overlap window), a
// known sign-in page is open, or a tab shows an unambiguous password / one-time-code
// field. Anything undeterminable holds.
//
//   1. Unit: userDataDirOf, otherRelayBraves (fake ps), frontmostPid (fake lsappinfo),
//      signInHold (fake Playwright pages).
//   2. SECRET_FIELD_PROBE and signInHold in a REAL Chromium DOM (Chrome for Testing from
//      Playwright's cache; skipped when absent).
//   3. The real index.js main() under test/fixtures/relay-harness.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { otherRelayBraves, frontmostPid, frontPidFromList, presenceVerdict, signInHold, userDataDirOf, executableOf, SECRET_FIELD_PROBE } = require("../src/overlap-reap.js");
const { waitFor, startRelay } = require("./helpers/reaper-relay.js");

const T = { timeout: 30000 };
const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

// ───── 1. unit ─────

test("userDataDirOf reads the flag up to the next flag, spaces included", () => {
  assert.strictEqual(userDataDirOf(`${BRAVE} --a=1 --user-data-dir=/x/My Cache/p1 --b`), "/x/My Cache/p1");
  assert.strictEqual(userDataDirOf(`${BRAVE} --user-data-dir=/x/c/p2`), "/x/c/p2");
  assert.strictEqual(userDataDirOf(`${BRAVE} --foo`), null);
});

const fakeExec = (text) => (cmd, args, opts, cb) => { fakeExec.last = { cmd, args }; cb(null, text, ""); };

test("otherRelayBraves counts only OTHER relay main processes under the cache root, and names its own", async () => {
  const root = "/tmp/relay-cache-test";
  const ps = [
    `  100 ${BRAVE} --user-data-dir=${root}/profiles/mine --x`,                    // own pid
    `  101 ${BRAVE} --user-data-dir=${root}/profiles/other --x`,                   // counted
    `  102 ${BRAVE} --user-data-dir=${root}/session-clones-plainflags/a-p9-z`,     // counted
    `  103 ${BRAVE} --type=renderer --user-data-dir=${root}/profiles/other`,       // helper
    `  104 ${BRAVE}`,                                                              // the user's own Brave
    `  105 ${BRAVE} --user-data-dir=/Users/x/elsewhere`,                           // not a relay
    `  106 ${BRAVE} --user-data-dir=${root}-other/profiles/p`,                     // prefix trap
    `  107 ${BRAVE} --user-data-dir=${root}/profiles/mine`,                        // own dir, other pid
    `garbage line`,
  ].join("\n");
  const r = await otherRelayBraves({ cacheRoot: root, ownDir: `${root}/profiles/mine`, ownPid: 100, _execFile: fakeExec(ps) });
  assert.deepStrictEqual(r, { ok: true, pids: [101, 102], selfPid: 100 });
  assert.strictEqual(fakeExec.last.cmd, "/bin/ps");
  assert.ok(fakeExec.last.args.includes("-axww"), "args must not be truncated (-ww)");
});

test("otherRelayBraves counts only the SAME executable as this relay's own Brave", async () => {
  const root = "/tmp/relay-cache-test";
  const BETA = "/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta";
  const CFT = "/x/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const ps = [
    `  200 ${BRAVE} --x --user-data-dir=${root}/profiles/mine --remote-debugging-pipe`,
    `  201 ${BRAVE} --x --user-data-dir=${root}/profiles/other --remote-debugging-pipe`,
    `  202 ${BETA} --user-data-dir=${root}/profiles/beta`,
    `  203 ${CFT} --user-data-dir=${root}/session-clones/script`,
  ].join("\n");
  assert.deepStrictEqual(await otherRelayBraves({ cacheRoot: root, ownDir: `${root}/profiles/mine`, ownPid: 200, _execFile: fakeExec(ps) }), { ok: true, pids: [201], selfPid: 200 });
  // Attached (bravePid null): own Brave found by its dir.
  assert.deepStrictEqual(await otherRelayBraves({ cacheRoot: root, ownDir: `${root}/profiles/mine`, ownPid: null, _execFile: fakeExec(ps) }), { ok: true, pids: [201], selfPid: 200 });
  // Own Brave not listed: no executable filter, selfPid null.
  assert.deepStrictEqual(await otherRelayBraves({ cacheRoot: root, ownDir: `${root}/profiles/gone`, ownPid: 999, _execFile: fakeExec(ps) }), { ok: true, pids: [200, 201, 202, 203], selfPid: null });
  assert.strictEqual(executableOf(`${BRAVE} --a --b`), BRAVE);
  assert.strictEqual(executableOf(BRAVE), BRAVE);
});

test("otherRelayBraves: a failed or hung ps is ok:false (the caller must not reap early)", async () => {
  assert.strictEqual((await otherRelayBraves({ cacheRoot: "/tmp/rc", _execFile: (c, a, o, cb) => cb(new Error("boom"), "", "") })).ok, false);
  const t0 = Date.now();
  assert.deepStrictEqual(await otherRelayBraves({ cacheRoot: "/tmp/rc", timeoutMs: 100, _execFile: () => ({}) }), { ok: false, reason: "ps-timeout" });
  assert.ok(Date.now() - t0 < 2500, "hard cap must end the wait");
  assert.strictEqual((await otherRelayBraves({ cacheRoot: null })).ok, false);
});

// VERBATIM `lsappinfo` output captured on macOS 14.8.9, 2026-11-12 (review of 69fda6a:
// a hand-typed sample without the bundle path / executable path lines hid a parser
// that never found the pid on real output). Only the "(in front)" marker was moved.
const LIST = [
  ` 5) "Cursor" ASN:0x0-12012: `,
  `    bundleID="com.todesktop.230313mzl4w4u92"`,
  `    bundle path="/Applications/Cursor.app"`,
  `    executable path="/Applications/Cursor.app/Contents/MacOS/Cursor"`,
  `    pid = 876 type="Foreground" flavor=3 Version="3.26.16" fileType="APPL" creator="????" Arch=ARM64 `,
  `    parentASN="loginwindow" ASN:0x1-0x191: `,
  ` 8) "Brave Browser" ASN:0x0-1b01b: (in front) `,
  `    bundleID="com.brave.Browser"`,
  `    bundle path="/Applications/Brave Browser.app"`,
  `    executable path="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"`,
  `    pid = 899 type="Foreground" flavor=3 Version="199.55" fileType="APPL" creator="Cr24" Arch=ARM64 `,
  `    parentASN="loginwindow" ASN:0x1-0x191: `,
  `    launch time =  2026/11/06 12:22:35 ( 6 days, 6 hours, 24 minutes, 1.11786 seconds ago )`,
].join("\n");
const FRONT = "ASN:0x0-1b01b:\n";          // `lsappinfo front`
const INFO_PID = '"pid"=899\n';             // `lsappinfo info -only pid "ASN:0x0-0x1b01b:"`

/** A fake execFile answering `front`, `info -only pid <ASN>` and `list` per `answers` (string, or Error). */
function fakeLsappinfo(answers) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    calls.push([cmd, ...args]);
    const a = answers[args[0]];
    if (a instanceof Error) return cb(a, "", "");
    if (a === undefined) return {}; // never answers (hang)
    cb(null, a, "");
  };
  fn.calls = calls;
  return fn;
}

test("frontmostPid: front + info (the 0x-prefixed ASN), as on real output", async () => {
  const ex = fakeLsappinfo({ front: FRONT, info: INFO_PID, list: LIST });
  assert.deepStrictEqual(await frontmostPid({ _execFile: ex }), { ok: true, pid: 899 });
  assert.deepStrictEqual(ex.calls, [["/usr/bin/lsappinfo", "front"], ["/usr/bin/lsappinfo", "info", "-only", "pid", "ASN:0x0-0x1b01b:"]]);
});

test("frontmostPid: falls back to list when info says nothing; list entry's pid is 4 lines down", async () => {
  assert.deepStrictEqual(await frontmostPid({ _execFile: fakeLsappinfo({ front: FRONT, info: "", list: LIST }) }), { ok: true, pid: 899 });
  assert.deepStrictEqual(await frontmostPid({ _execFile: fakeLsappinfo({ front: new Error("x"), list: LIST }) }), { ok: true, pid: 899 });
  assert.strictEqual(frontPidFromList(LIST), 899);
  // The pid search stops at the next entry header: a front entry with no pid line does not take the next app's.
  const noPid = LIST.replace(/    pid = 899[^\n]*\n/, "");
  assert.strictEqual(frontPidFromList(noPid), null);
  // ...also when a LATER entry has one: Cursor in front with its pid line gone, Brave (pid 899) after it.
  const frontNoPid = LIST.replace("(in front) ", "").replace(`ASN:0x0-12012: `, `ASN:0x0-12012: (in front) `).replace(/    pid = 876[^\n]*\n/, "");
  assert.ok(frontNoPid.includes(`"Cursor" ASN:0x0-12012: (in front)`) && !frontNoPid.includes("pid = 876"));
  assert.strictEqual(frontPidFromList(frontNoPid), null, "must not take the next entry's pid");
  assert.strictEqual(frontPidFromList(LIST.replace("(in front)", "")), null);
  assert.strictEqual((await frontmostPid({ _execFile: fakeLsappinfo({ front: FRONT, info: "", list: noPid }) })).ok, false);
});

test("frontmostPid: failures and hangs are ok:false within the cap", async () => {
  assert.strictEqual((await frontmostPid({ _execFile: fakeLsappinfo({ front: new Error("a"), list: new Error("b") }) })).ok, false);
  const t0 = Date.now();
  const r = await frontmostPid({ timeoutMs: 100, _execFile: fakeLsappinfo({}) });
  assert.deepStrictEqual(r, { ok: false, reason: "lsappinfo-timeout" });
  assert.ok(Date.now() - t0 < 4500, "each step is capped");
});

test("frontmostPid against the real lsappinfo (macOS only): a live pid", { skip: process.platform === "darwin" && fs.existsSync("/usr/bin/lsappinfo") ? false : "not macOS" }, async () => {
  const r = await frontmostPid();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(Number.isInteger(r.pid) && r.pid > 0);
  let alive = true; try { process.kill(r.pid, 0); } catch (e) { alive = e.code === "EPERM"; }
  assert.ok(alive, "the pid names a live process");
});

test("presenceVerdict: frontmost / away / unknown (no own pid, gaps, a failed sample)", () => {
  const W = 10_000, I = 1_000, now = 100_000, self = 5151;
  const every = (pidAt) => Array.from({ length: 12 }, (_, i) => ({ t: now - W - I + i * I, pid: pidAt(i) }));
  assert.deepStrictEqual(presenceVerdict(every(() => 700), { now, windowMs: W, intervalMs: I, self }), { verdict: "away" });
  assert.deepStrictEqual(presenceVerdict(every((i) => (i === 5 ? self : 700)), { now, windowMs: W, intervalMs: I, self }), { verdict: "frontmost" });
  // In front only BEFORE the window (more than one interval before its start): away.
  const old = [{ t: now - W - 5 * I, pid: self }, ...every(() => 700)];
  assert.deepStrictEqual(presenceVerdict(old, { now, windowMs: W, intervalMs: I, self }), { verdict: "away" });
  assert.strictEqual(presenceVerdict(every(() => 700), { now, windowMs: W, intervalMs: I, self: null }).verdict, "unknown");
  assert.strictEqual(presenceVerdict([], { now, windowMs: W, intervalMs: I, self }).verdict, "unknown");
  // Sampling began late (first sample 3 intervals into the window): unknown.
  const late = every(() => 700).filter((x) => x.t >= now - W + 3 * I);
  assert.deepStrictEqual(presenceVerdict(late, { now, windowMs: W, intervalMs: I, self }), { verdict: "unknown", detail: "samples do not cover the window" });
  // Two intervals late is still covered.
  const ok = every(() => 700).filter((x) => x.t >= now - W + 2 * I);
  assert.strictEqual(presenceVerdict(ok, { now, windowMs: W, intervalMs: I, self }).verdict, "away");
  const failed = every((i) => (i === 7 ? null : 700));
  failed[7].reason = "lsappinfo-timeout";
  assert.deepStrictEqual(presenceVerdict(failed, { now, windowMs: W, intervalMs: I, self }), { verdict: "unknown", detail: "lsappinfo-timeout" });
});

function fakeContext(specs) {
  return {
    pages: () => specs.map((s) => {
      const frames = [{ url: () => s.url, evaluate: s.evaluate || (async () => !!s.secret) },
        ...(s.frameUrls || []).map((u) => ({ url: () => u, evaluate: async () => false }))];
      return { url: () => s.url, frames: () => frames };
    }),
  };
}

test("signInHold: blank and ordinary pages do not hold", async () => {
  assert.deepStrictEqual(await signInHold(fakeContext([{ url: "about:blank" }, { url: "chrome://newtab/" }])), { hold: false, reason: "none" });
  assert.deepStrictEqual(await signInHold(fakeContext([{ url: "https://app.gohighlevel.com/v2/location/x/dashboard" }])), { hold: false, reason: "none" });
  assert.deepStrictEqual(await signInHold(fakeContext([])), { hold: false, reason: "none" });
});

test("signInHold: a secret field in any frame holds", async () => {
  assert.deepStrictEqual(await signInHold(fakeContext([{ url: "about:blank" }, { url: "https://vendor.example/login", secret: true }])),
    { hold: true, reason: "secret-field", host: "vendor.example" });
});

test("signInHold: a known sign-in page holds even with no secret field, in a tab or an iframe", async () => {
  assert.strictEqual((await signInHold(fakeContext([{ url: "https://accounts.google.com/v3/signin/identifier" }]))).reason, "sign-in-page");
  assert.strictEqual((await signInHold(fakeContext([{ url: "https://app.example/", frameUrls: ["https://accounts.google.com/o/oauth2/auth"] }]))).reason, "sign-in-page");
});

test("signInHold: an unreadable, throwing or hung frame holds", async () => {
  assert.deepStrictEqual(await signInHold(fakeContext([{ url: "https://a.example/", evaluate: async () => { throw new Error("detached"); } }])),
    { hold: true, reason: "unreadable", host: "a.example" });
  const t0 = Date.now();
  const hung = await signInHold(fakeContext([{ url: "https://a.example/", evaluate: () => new Promise(() => {}) }]), { timeoutMs: 1200 });
  assert.strictEqual(hung.reason, "unreadable");
  assert.ok(Date.now() - t0 < 2500);
  assert.strictEqual((await signInHold({ pages: () => { throw new Error("closed"); } })).reason, "unreadable");
});

// ───── 2. real Chromium ─────

let chromium = null;
try { ({ chromium } = require("playwright")); if (!fs.existsSync(chromium.executablePath())) chromium = null; } catch { chromium = null; }
const REAL = { ...T, skip: chromium ? false : "Chrome for Testing not installed" };
const PROBE_CASES = [
  // [name, html, holds?]
  ["visible password", `<input type=password>`, true],
  ["password in an OPEN shadow root", `<div id=h></div><script>h.attachShadow({mode:"open"}).innerHTML="<input type=password>"</script>`, true],
  ["password two open roots deep", `<div id=h></div><script>const a=h.attachShadow({mode:"open"});a.innerHTML="<div id=i></div>";a.getElementById("i").attachShadow({mode:"open"}).innerHTML="<input type=password>"</script>`, true],
  ["eye toggle: type=text autocomplete=current-password", `<input type=text name=password autocomplete=current-password>`, true],
  ["sign-up: autocomplete=new-password", `<input type=text autocomplete=new-password>`, true],
  ["one-time-code", `<input autocomplete=one-time-code inputmode=numeric>`, true],
  ["opacity:0 one-time-code overlay", `<div style="position:relative"><input autocomplete=one-time-code style="opacity:0;position:absolute;inset:0"><div>1 2 3</div></div>`, true],
  ["visibility:hidden password (layout boxes; fails safe)", `<input type=password style="visibility:hidden">`, true],
  ["autocomplete with section prefix", `<input autocomplete="section-login current-password">`, true],
  ["display:none password", `<input type=password style="display:none">`, false],
  ["hidden-attribute password", `<div hidden><input type=password></div>`, false],
  ["ordinary text + search", `<input type=text name=q><input type=search>`, false],
  ["email + username only (presence covers an email-first step)", `<form><input type=email autocomplete=username></form>`, false],
  ["unmarked 2FA box (presence covers it)", `<input name=otp maxlength=6>`, false],
  ["ZIP / promo / CVC", `<input name=zip maxlength=5><input name=promo_code><input autocomplete=cc-csc>`, false],
  ["autocomplete off / username", `<input autocomplete=off><input autocomplete=username>`, false],
];
test("SECRET_FIELD_PROBE in real Chromium: unambiguous secret fields only", REAL, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const wrong = [];
    for (const [name, html, want] of PROBE_CASES) {
      await page.setContent(`<!doctype html><body>${html}</body>`);
      const got = await page.evaluate(SECRET_FIELD_PROBE);
      if (got !== want) wrong.push(`${name}: got ${got}, want ${want}`);
    }
    assert.deepStrictEqual(wrong, []);
  } finally { await browser.close(); }
});

test("signInHold in real Chromium: a password in a cross-site iframe holds; a page with same-site iframes and no secret does not", REAL, async () => {
  const http = require("node:http");
  const srv = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    const port = srv.address().port;
    if (req.url === "/pw") res.end(`<input type=password>`);
    else if (req.url === "/plain") res.end(`<p>widget</p>`);
    else if (req.url === "/cross") res.end(`<p>outer</p><iframe src="http://localhost:${port}/pw"></iframe>`);
    else res.end(`<p>dashboard</p><iframe src="/plain"></iframe><iframe src="about:blank"></iframe>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const base = `http://127.0.0.1:${srv.address().port}`;
    await page.goto(`${base}/`);
    await page.waitForLoadState("load");
    assert.deepStrictEqual(await signInHold(context), { hold: false, reason: "none" });
    await page.goto(`${base}/cross`);
    await page.waitForLoadState("load");
    assert.deepStrictEqual(await signInHold(context), { hold: true, reason: "secret-field", host: "127.0.0.1" });
  } finally { await browser.close(); srv.close(); }
});

// ───── 3. the real main() ─────

// Full window 3 s (unless a test widens it), overlap 0.6 s; the reaper ticks every
// 0.6 s and the presence sampler every 0.15 s. The fake Brave's pid is 5151.
const IDLE = "0.05";
const OVERLAP = "0.01";
const otherRelayLine = (dir) => `  4242 ${BRAVE} --flag --user-data-dir=${path.join(dir, "cache", "profiles", "other")} --flag2\n`;

async function relayWith({ pages, ps, psFail, overlap = OVERLAP, idle = IDLE, frontmost, selfUnknown, lsofFail }) {
  const files = {};
  if (pages) files["fake-pages"] = JSON.stringify(pages);
  if (psFail) files["ps-overlap-fail"] = "";
  if (frontmost !== undefined) files["frontmost-pid"] = String(frontmost);
  if (selfUnknown) files["self-unknown"] = "";
  if (lsofFail) files["lsof-bin"] = "/nonexistent/relay-test-lsof";
  const r = await startRelay({ idleMinutes: idle, files, extraEnv: { BROWSER_RELAY_OVERLAP_IDLE_MINUTES: overlap } });
  if (ps !== undefined) fs.writeFileSync(path.join(r.dir, "ps-overlap"), typeof ps === "function" ? ps(r.dir) : ps);
  fs.mkdirSync(path.join(r.dir, "cache"), { recursive: true });
  return r;
}
const closed = (r) => r.count(/HARNESS brave-closed .* hard/g);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const reapEvents = (r) => {
  try { return fs.readFileSync(path.join(r.dir, "cache", "reap-events.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const heldReasons = (r) => reapEvents(r).filter((e) => e.event === "overlap-held").map((e) => e.reason);

test("main(): idle Brave closes in the overlap window while another relay Brave is alive and nobody uses it", T, async () => {
  const r = await relayWith({ pages: ["https://app.example/dashboard"], ps: otherRelayLine });
  try {
    await r.call();
    const t0 = Date.now();
    await waitFor(() => closed(r) === 1, 2700, "overlap reap");
    assert.ok(Date.now() - t0 < 2700, "must close before the 3 s full window");
    assert.match(r.stderr(), /other relay Brave\(s\) are open/);
    assert.match(r.stderr(), /idle reaper armed \(0\.05min; 0\.01min while another relay Brave is open\)/);
    assert.ok(reapEvents(r).some((e) => e.event === "reaped-overlap" && e.others === 1));
    await r.call();
    assert.strictEqual(fs.readFileSync(path.join(r.dir, "brave-launches"), "utf8").trim().split("\n").length, 2, "the next call relaunches Brave");
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

test("main(): this Brave frontmost holds the overlap reap; one window after it leaves the front, it closes", T, async () => {
  const r = await relayWith({ pages: ["https://app.example/"], ps: otherRelayLine, frontmost: 5151, idle: "0.15" }); // full window 9 s
  try {
    await r.call();
    await sleep(2200);
    assert.strictEqual(closed(r), 0, "in use (frontmost) must hold");
    assert.ok(heldReasons(r).includes("frontmost"));
    fs.writeFileSync(path.join(r.dir, "frontmost-pid"), "700"); // switched to another app
    const t0 = Date.now();
    await waitFor(() => closed(r) === 1, 3500, "overlap reap after leaving the front");
    assert.ok(Date.now() - t0 >= 500, "not before one overlap window without a frontmost sample");
    assert.match(r.stderr(), /other relay Brave\(s\) are open/);
  } finally { await r.stop(); }
});

for (const [name, opts, reason] of [
  ["a secret field", { pages: [{ url: "https://vendor.example/login", secret: true }] }, "secret-field"],
  ["a known sign-in page", { pages: ["https://accounts.google.com/v3/signin/identifier"] }, "sign-in-page"],
  ["an unreadable frame", { pages: [{ url: "https://vendor.example/", throws: true }] }, "unreadable"],
  ["a failed lsappinfo", { pages: ["https://app.example/"], frontmost: "fail" }, "presence-unknown"],
  ["an unknown own Brave pid", { pages: ["https://app.example/"], selfUnknown: true }, "self-unknown"],
]) {
  test(`main(): ${name} holds the overlap reap (logged as ${reason}; the full window still applies)`, T, async () => {
    const r = await relayWith({ ...opts, ps: otherRelayLine });
    try {
      await r.call();
      await sleep(2200);
      assert.strictEqual(closed(r), 0, `${name} must hold`);
      assert.deepStrictEqual(heldReasons(r), [reason], "logged once");
      await waitFor(() => closed(r) === 1, 4000, "full reap");
    } finally { await r.stop(); }
  });
}

test("main(): a failed ps holds and is logged once (overlap-held ps-failed)", T, async () => {
  const r = await relayWith({ pages: ["https://app.example/"], psFail: true });
  try {
    await r.call();
    await sleep(2200);
    assert.strictEqual(closed(r), 0);
    assert.deepStrictEqual(heldReasons(r), ["ps-failed"]);
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

test("main(): a failed lsof holds in the overlap window, logged once; the full window keeps its fall-through", T, async () => {
  const r = await relayWith({ pages: ["https://app.example/"], ps: otherRelayLine, lsofFail: true });
  try {
    await r.call();
    await sleep(2400);
    assert.strictEqual(closed(r), 0, "an lsof that cannot answer must hold in the overlap window");
    assert.strictEqual(reapEvents(r).filter((e) => e.event === "lsof-failed").length, 1);
    await waitFor(() => closed(r) === 1, 4000, "full reap still falls through on a failed lsof");
  } finally { await r.stop(); }
});

test("main(): an overlap hold is logged once per idle period, and again after a tool call", T, async () => {
  const r = await relayWith({ pages: [{ url: "https://vendor.example/login", secret: true }], ps: otherRelayLine });
  try {
    await r.call();
    await waitFor(() => heldReasons(r).length === 1, 2500, "first overlap-held");
    await sleep(1300);
    assert.strictEqual(heldReasons(r).length, 1, "once per reason per idle period");
    await r.call();
    await waitFor(() => heldReasons(r).length === 2, 2500, "logged again after activity");
    const e = reapEvents(r).find((x) => x.event === "overlap-held");
    assert.strictEqual(e.host, "vendor.example");
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
