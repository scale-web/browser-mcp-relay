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
const vm = require("node:vm");

const { otherRelayBraves, signInHold, userDataDirOf, SECRET_FIELD_PROBE } = require("../src/overlap-reap.js");
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

test("signInHold: a visible secret field in any frame holds", async () => {
  const r = await signInHold(fakeContext([{ url: "about:blank" }, { url: "https://vendor.example/login", secret: true }]));
  assert.deepStrictEqual(r, { hold: true, reason: "secret-field", host: "vendor.example" });
});

test("signInHold: a known sign-in page holds even with no secret field (email-first step)", async () => {
  const r = await signInHold(fakeContext([{ url: "https://accounts.google.com/v3/signin/identifier" }]));
  assert.strictEqual(r.hold, true);
  assert.strictEqual(r.reason, "sign-in-page");
  const framed = await signInHold(fakeContext([{ url: "https://app.example/", frameUrls: ["https://accounts.google.com/o/oauth2/auth"] }]));
  assert.strictEqual(framed.reason, "sign-in-page", "a sign-in page inside an iframe holds");
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

function runProbe(inputs) {
  const document = {
    querySelectorAll: (sel) => { assert.strictEqual(sel, "input"); return inputs; },
  };
  return vm.runInNewContext(SECRET_FIELD_PROBE, { document });
}
const input = (type, { ac = null, visible = true } = {}) => ({
  type, getAttribute: (n) => (n === "autocomplete" ? ac : null), getClientRects: () => (visible ? [{}] : []),
});

test("SECRET_FIELD_PROBE: visible password or one-time-code inputs only", () => {
  assert.strictEqual(runProbe([input("text"), input("password")]), true);
  assert.strictEqual(runProbe([input("PASSWORD")]), true);
  assert.strictEqual(runProbe([input("text", { ac: "one-time-code" })]), true);
  assert.strictEqual(runProbe([input("text", { ac: "section-x one-time-code" })]), true);
  assert.strictEqual(runProbe([input("password", { visible: false })]), false, "a hidden password input on a dashboard must not hold forever");
  assert.strictEqual(runProbe([input("text", { ac: "username" }), input("email")]), false);
  assert.strictEqual(runProbe([input("text", { ac: "not-one-time-codes" })]), false);
  assert.strictEqual(runProbe([]), false);
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
