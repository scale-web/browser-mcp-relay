// reap-hold.test.js — the keep-alive file and the hold/reap log (A51 follow-up).
//
//   1. freshKeepaliveAgeMs: regular file only (lstat), fresh only within one
//      idle window, never a future mtime.
//   2. ReapLog: line shape + 0600, "held" once per hold and on a pid-set
//      change, rotation at the cap, a failing write never throws.
//   3. The real relay (test/fixtures/relay-harness.js): a fresh keep-alive
//      blocks the reap WITHOUT running lsof, a stale or symlinked one does
//      not, the log records held/reaped/lsof-failed, the sidecar carries
//      reapHeldBy, and an unwritable log changes nothing about reaping.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { KEEPALIVE_NAME, REAP_LOG_NAME, freshKeepaliveAgeMs, redactCommand, withFileLock, psCommands, ReapLog } = require("../src/reap-hold.js");
const { spawn } = require("node:child_process");
const { isAlive, waitFor, listener, cdpClientChild, startRelay } = require("./helpers/reaper-relay.js");

const T = { timeout: 45000 };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const readLog = (file) => {
  try { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const setAge = (p, ageMs) => { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(p, t, t); };

// ───── 1. keep-alive ─────

test("freshKeepaliveAgeMs: a regular file younger than the idle window counts; absent, stale, future, symlink, dir do not", () => {
  const dir = tmp("keepalive-");
  const ka = path.join(dir, KEEPALIVE_NAME);
  try {
    assert.strictEqual(freshKeepaliveAgeMs(dir, 60_000), null, "absent");
    fs.writeFileSync(ka, "");
    setAge(ka, 10_000);
    const age = freshKeepaliveAgeMs(dir, 60_000);
    assert.ok(age >= 9_000 && age < 12_000, `fresh: ${age}`);
    assert.strictEqual(freshKeepaliveAgeMs(dir, 5_000), null, "stale: older than the idle window");
    setAge(ka, -60_000);
    assert.strictEqual(freshKeepaliveAgeMs(dir, 60 * 60_000), null, "an mtime a minute in the future never holds");
    setAge(ka, -1_000);
    assert.ok(freshKeepaliveAgeMs(dir, 60_000) === 0, "a second of clock skew is tolerated (age clamped to 0)");

    fs.rmSync(ka);
    const target = path.join(dir, "target");
    fs.writeFileSync(target, "");
    fs.symlinkSync(target, ka);
    assert.strictEqual(freshKeepaliveAgeMs(dir, 60_000), null, "a symlink to a fresh file is ignored");
    fs.rmSync(ka);
    fs.mkdirSync(ka);
    assert.strictEqual(freshKeepaliveAgeMs(dir, 60_000), null, "a directory is ignored");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───── 2. ReapLog ─────

test("ReapLog.write: one JSON line per event with ts/slug/pid/event/fields, file mode 0600", () => {
  const dir = tmp("reaplog-");
  const file = path.join(dir, "sub", REAP_LOG_NAME);
  try {
    const log = new ReapLog({ file, slug: "proj-x", pid: 4242 });
    assert.strictEqual(log.write("reaped", { idleS: 2700 }), true);
    assert.strictEqual(log.write("keepalive", { keepaliveAgeS: 12, idleS: 2701 }), true);
    const lines = readLog(file);
    assert.strictEqual(lines.length, 2);
    assert.deepStrictEqual(Object.keys(lines[0]), ["ts", "slug", "pid", "event", "idleS"]);
    assert.match(lines[0].ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.strictEqual(lines[0].slug, "proj-x");
    assert.strictEqual(lines[0].pid, 4242);
    assert.strictEqual(lines[0].event, "reaped");
    assert.strictEqual(lines[1].keepaliveAgeS, 12);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ReapLog rotates to .1 past the cap, keeping exactly one old file", () => {
  const dir = tmp("reaplog-rot-");
  const file = path.join(dir, REAP_LOG_NAME);
  try {
    const log = new ReapLog({ file, slug: "p", maxBytes: 360 });
    for (let i = 0; i < 4; i++) log.write("reaped", { idleS: i }); // ~84 B each
    assert.ok(!fs.existsSync(`${file}.1`), "under the cap: no rotation");
    log.write("reaped", { idleS: 4 });
    assert.ok(fs.existsSync(`${file}.1`), "over the cap: rotated");
    assert.deepStrictEqual(readLog(`${file}.1`).map((l) => l.idleS), [0, 1, 2, 3]);
    assert.deepStrictEqual(readLog(file).map((l) => l.idleS), [4]);
    for (let i = 5; i < 10; i++) log.write("reaped", { idleS: i });
    assert.deepStrictEqual(readLog(`${file}.1`).map((l) => l.idleS), [4, 5, 6, 7], "the second rotation replaced .1");
    assert.deepStrictEqual(readLog(file).map((l) => l.idleS), [8, 9]);
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => !n.endsWith(".lock")).sort(), [REAP_LOG_NAME, `${REAP_LOG_NAME}.1`], "only one old file kept");
    assert.ok(fs.statSync(file).size <= 360);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ReapLog never throws: an unwritable path, a throwing fs, a null file", () => {
  const dir = tmp("reaplog-bad-");
  try {
    fs.mkdirSync(path.join(dir, REAP_LOG_NAME)); // the log path is a directory
    assert.strictEqual(new ReapLog({ file: path.join(dir, REAP_LOG_NAME), slug: "p" }).write("reaped", {}), false);
    const boom = { mkdirSync() { throw new Error("EACCES"); } };
    assert.strictEqual(new ReapLog({ file: path.join(dir, "x.log"), slug: "p", _fs: boom }).write("reaped", {}), false);
    assert.strictEqual(new ReapLog({ file: null, slug: "p" }).write("reaped", {}), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ReapLog.held: 'held' once per hold, again on a pid-set change, again after the hold ends", async () => {
  const dir = tmp("reaplog-held-");
  const file = path.join(dir, REAP_LOG_NAME);
  try {
    const psCalls = [];
    const log = new ReapLog({ file, slug: "p", _ps: async (pids) => { psCalls.push(pids); return Object.fromEntries(pids.map((x) => [x, `cmd-${x}`])); } });
    const a = await log.held([300, 100], 10);
    assert.strictEqual(a.changed, true);
    assert.deepStrictEqual(a.pids, [100, 300]);
    assert.match(a.since, /Z$/);
    assert.strictEqual((await log.held([100, 300, 300], 20)).changed, false, "same set, other order: same hold");
    assert.strictEqual((await log.held([100, 300], 30)).changed, false);
    const c = await log.held([100], 40);
    assert.strictEqual(c.changed, true, "pid set changed");
    assert.strictEqual(c.since, a.since, "still the same hold");
    assert.strictEqual(log.release("no-clients"), true);
    assert.strictEqual(log.release("no-clients"), false, "no hold open");
    assert.strictEqual((await log.held([100], 50)).changed, true, "a new hold by the SAME pids after the old one ended");
    const rel = readLog(file).filter((l) => l.event === "released");
    assert.strictEqual(rel.length, 1);
    assert.strictEqual(rel[0].reason, "no-clients");
    assert.deepStrictEqual(rel[0].pids, [100]);
    assert.ok(typeof rel[0].heldS === "number" && rel[0].heldS >= 0 && rel[0].heldS < 5);
    const held = readLog(file).filter((l) => l.event === "held");
    assert.deepStrictEqual(held.map((l) => l.idleS), [10, 40, 50]);
    assert.deepStrictEqual(held[0].heldBy, [{ pid: 100, command: "cmd-100" }, { pid: 300, command: "cmd-300" }]);
    assert.strictEqual(psCalls.length, 3, "ps runs only when a line is written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ReapLog.held survives a throwing ps (command: null); psCommands reads real commands, truncated", async () => {
  const dir = tmp("reaplog-ps-");
  try {
    const log = new ReapLog({ file: path.join(dir, REAP_LOG_NAME), slug: "p", _ps: async () => { throw new Error("no ps"); } });
    await log.held([7], 1);
    assert.deepStrictEqual(readLog(path.join(dir, REAP_LOG_NAME))[0].heldBy, [{ pid: 7, command: null }]);
    const real = await psCommands([process.pid]);
    assert.match(real[process.pid], /^node( [\w@+-][\w.@+-]*(\/[\w@+-][\w.@+-]*)?)*$/, real[process.pid]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("redactCommand names the helper — script path as parent/base, python -m, .bin shims, npx/tsx — never arguments", () => {
  const SECRET = "tok_SECRET123";
  const N = "/opt/homebrew/bin/node";
  const cases = [
    // the reviewer's shapes
    ["/usr/bin/python3", "python3 -m helpers.cdp_watch --port 9335", null, "python3 -m helpers.cdp_watch"],
    [N, `node /Users/x/p/node_modules/.bin/tsx scripts/drive.ts --url=https://h/?token=${SECRET}`, null, "tsx scripts/drive.ts"],
    [N, `node --require ./otel.js drive.mjs https://h/?token=${SECRET}`, "/Users/x/proj", "node proj/drive.mjs"],
    [N, "node index.js", "/Users/x/drive", "node drive/index.js"],
    [N, "node index.js", null, "node index.js"],
    [N, "node /Users/x/.npm/_npx/abc/node_modules/.bin/firecrawl-mcp", null, "firecrawl-mcp"],
    // more shapes
    [N, `node /opt/homebrew/bin/npx -y firecrawl-mcp --api-key ${SECRET}`, null, "npx firecrawl-mcp"],
    ["/opt/homebrew/bin/npx", `npx tsx scripts/drive.ts ?token=${SECRET}`, null, "npx tsx"],
    ["/usr/local/bin/tsx", "tsx /a/scripts/drive.ts", null, "tsx scripts/drive.ts"],
    [N, `node /Users/x/repo/scripts/lib/own-relay-port.mjs --url=https://h/?token=${SECRET}`, null, "node lib/own-relay-port.mjs"],
    [N, `/opt/homebrew/bin/node --inspect=127.0.0.1:9229 /a/b/xhr-capture-ghl.mjs https://app.example/?token=${SECRET}`, null, "node b/xhr-capture-ghl.mjs"],
    [N, "node -r ./otel.js -r dotenv/config /srv/bin/sniffer", null, "node bin/sniffer"],
    [N, `node -e require("net").connect(1) ${SECRET}`, null, "node"],
    [N, `node -p process.env.TOKEN ${SECRET}.js`, null, "node"],
    ["/usr/bin/python3", `python3 -c import os;print("${SECRET}")`, null, "python3"],
    ["/usr/bin/python3", `python3 /tmp/sniff.py ${SECRET}`, null, "python3 tmp/sniff.py"],
    ["/usr/bin/curl", `curl -s https://h/json?token=${SECRET}`, null, "curl"],
    ["/usr/bin/curl", `curl https://h/x.js?token=${SECRET}`, null, "curl"],
    ["/usr/bin/curl", `curl -H Authorization: Bearer ${SECRET} https://h/`, null, "curl"],
    ["/usr/local/bin/mytool", `mytool --token ${SECRET}`, null, "mytool"],
    ["/usr/local/bin/mytool", `mytool ${SECRET}`, null, "mytool"],
    [N, `node ./drive.mjs?token=${SECRET}`, null, "node"],
    [N, `node /a/b/c.js#${SECRET}`, null, "node"],
    [N, `node token=${SECRET}/x.js`, null, "node"],
    ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser --user-data-dir=/x?token=${SECRET}`, null, "Brave Browser"],
    ["", "anything", null, null],
  ];
  for (const [comm, args, cwd, want] of cases) {
    const got = redactCommand(comm, args, cwd);
    assert.strictEqual(got, want, `${args} -> ${got}`);
    assert.ok(!String(got).includes(SECRET) && !/token|[?=:&#%]|https?/.test(String(got)), `leaked: ${got}`);
  }
});

test("psCommands on real processes: names the helper (script parent/base, bare script via its cwd), never its ?token= arguments", T, async () => {
  const dir = tmp("ps-redact-");
  const sub = path.join(dir, "drive");
  fs.mkdirSync(sub);
  const script = path.join(dir, "own-relay-port.mjs");
  fs.writeFileSync(script, "setInterval(() => {}, 1e6);\n");
  fs.writeFileSync(path.join(sub, "index.js"), "setInterval(() => {}, 1e6);\n");
  const a = spawn(process.execPath, [script, "https://app.example/?token=tok_SECRET123", "--jwt=eyJhbGciOi"], { stdio: "ignore" });
  const b = spawn(process.execPath, ["index.js", "?token=tok_SECRET123"], { stdio: "ignore", cwd: sub });
  try {
    await waitFor(async () => Object.keys(await psCommands([a.pid, b.pid])).length === 2, 3000, "children visible to ps");
    const got = await psCommands([a.pid, b.pid]);
    assert.strictEqual(got[a.pid], `node ${path.basename(dir)}/own-relay-port.mjs`);
    assert.strictEqual(got[b.pid], "node drive/index.js", "a bare relative script is named with its cwd's folder");
  } finally {
    a.kill("SIGKILL");
    b.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("psCommands resolves {} within timeoutMs + 1 s when ps / lsof never call back", T, async () => {
  const calls = [];
  const never = (cmd, args) => { calls.push(cmd); };
  const t0 = Date.now();
  const got = await psCommands([123, 456], { timeoutMs: 200, _execFile: never });
  const ms = Date.now() - t0;
  assert.deepStrictEqual(got, {});
  assert.ok(ms >= 1100 && ms < 2500, `resolved after ${ms} ms`);
  assert.strictEqual(calls.length, 3, "ps comm + ps args + lsof cwd were all started");
  const log = new ReapLog({ file: null, slug: "p", _ps: (pids) => psCommands(pids, { timeoutMs: 200, _execFile: never }) });
  const h = await log.held([123], 1);
  assert.strictEqual(h.changed, true, "held() resolves too");
});

test("withFileLock: exclusive between holders, gives up after waitMs, never throws", () => {
  const dir = tmp("lock-");
  const lockPath = path.join(dir, "x.lock");
  try {
    let inner = null;
    let innerRan = false;
    let waited = 0;
    const outer = withFileLock(lockPath, () => {
      const t0 = Date.now();
      inner = withFileLock(lockPath, () => { innerRan = true; }, { waitMs: 60 });
      waited = Date.now() - t0;
    });
    assert.strictEqual(outer, "ran");
    assert.strictEqual(inner, "busy", "a held lock is not taken twice");
    assert.strictEqual(innerRan, false);
    assert.ok(waited >= 50, "the second taker waited");
    assert.strictEqual(withFileLock(lockPath, () => {}), "ran", "free again after release");
    assert.strictEqual(withFileLock(lockPath, () => { throw new Error("boom"); }), "ran", "fn throwing → no throw");
    assert.strictEqual(withFileLock(path.join(dir, "no", "such", "dir.lock"), () => {}), "error");
    const dirLock = path.join(dir, "d.lock");
    fs.mkdirSync(dirLock);
    assert.strictEqual(withFileLock(dirLock, () => {}), "error", "a directory is an error, not contention");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ReapLog: a lock that cannot be opened (mode 000, a directory) does not stop rotation", () => {
  for (const kind of ["mode000", "directory"]) {
    const dir = tmp("reaplog-badlock-");
    const file = path.join(dir, REAP_LOG_NAME);
    const lock = `${file}.lock`;
    try {
      if (kind === "mode000") { fs.writeFileSync(lock, ""); fs.chmodSync(lock, 0o000); } else fs.mkdirSync(lock);
      const log = new ReapLog({ file, slug: "p", maxBytes: 2000 });
      for (let i = 0; i < 400; i++) log.write("reaped", { idleS: i });
      assert.ok(fs.existsSync(`${file}.1`), `${kind}: rotated`);
      assert.ok(fs.statSync(file).size <= 2000, `${kind}: current log within the cap (${fs.statSync(file).size} B)`);
      assert.ok(fs.statSync(`${file}.1`).size <= 2000);
      assert.strictEqual(readLog(file).slice(-1)[0].idleS, 399, `${kind}: the newest line was written`);
    } finally {
      try { fs.chmodSync(lock, 0o600); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("ReapLog: when rotation keeps failing, appends stop at ~2x the cap", () => {
  const dir = tmp("reaplog-backstop-");
  const file = path.join(dir, REAP_LOG_NAME);
  try {
    // `.1` is a non-empty directory: rename(file, .1) fails every time.
    fs.mkdirSync(`${file}.1`);
    fs.writeFileSync(path.join(`${file}.1`, "x"), "");
    const log = new ReapLog({ file, slug: "p", maxBytes: 2000 });
    let written = 0;
    for (let i = 0; i < 400; i++) if (log.write("reaped", { idleS: i })) written++;
    const size = fs.statSync(file).size;
    assert.ok(size <= 4000, `the log grew past 2x the cap: ${size} B`);
    assert.ok(size > 3800, `the log stopped well before 2x the cap: ${size} B`);
    assert.ok(written < 400, "later writes report false");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 8 processes append concurrently across one rotation (~27 KB into a 20 KB
// cap): exactly one rotation, `.1` is the FULL rotated file, no line lost or
// torn. Unlocked, several writers see the file over the cap at once and the
// second rename replaces a full `.1` with a near-empty one. Five rounds.
test("ReapLog: 8 concurrent writers rotate once; .1 holds the full rotated file", T, async () => {
  const SRC = path.resolve(__dirname, "..", "src", "reap-hold.js");
  for (let round = 0; round < 5; round++) {
    const dir = tmp("reaplog-conc-");
    const file = path.join(dir, REAP_LOG_NAME);
    const go = path.join(dir, "go");
    try {
      const kids = [];
      for (let k = 0; k < 8; k++) {
        kids.push(spawn(process.execPath, ["-e", `
          const fs = require("fs");
          const { ReapLog } = require(${JSON.stringify(SRC)});
          const log = new ReapLog({ file: ${JSON.stringify(file)}, slug: "conc", maxBytes: 20000 });
          while (!fs.existsSync(${JSON.stringify(go)})) {}
          for (let i = 0; i < 40; i++) log.write("reaped", { idleS: i, k: ${k}, pad: "x".repeat(20) });
        `], { stdio: "ignore" }));
      }
      await new Promise((res) => setTimeout(res, 300));
      fs.writeFileSync(go, "");
      await Promise.all(kids.map((c) => new Promise((res) => c.once("exit", res))));
      const cur = readLog(file);
      const old = readLog(`${file}.1`);
      assert.strictEqual(old.length + cur.length, 320, `round ${round}: lines lost (.1=${old.length}, cur=${cur.length})`);
      assert.ok(fs.statSync(`${file}.1`).size > 19000, `round ${round}: .1 is not the full rotated file (${fs.statSync(`${file}.1`).size} B)`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ───── 3. the real relay ─────

const REAPED = /reaping Brave \+ upstream/g;
const relayLog = (r) => readLog(path.join(r.dir, "cache", REAP_LOG_NAME));
const sidecarOf = (r) => JSON.parse(fs.readFileSync(path.join(r.profileDir, ".mcp-relay-status.json"), "utf8"));

/** A fake lsof that records each call and reports "no sockets". */
function countingLsof() {
  const bin = tmp("relay-count-lsof-");
  const calls = path.join(bin, "calls");
  fs.writeFileSync(path.join(bin, "lsof"), `#!/bin/sh\necho x >> '${calls}'\nexit 1\n`, { mode: 0o755 });
  return { file: path.join(bin, "lsof"), calls: () => { try { return fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } }, rm: () => fs.rmSync(bin, { recursive: true, force: true }) };
}

test("relay: a fresh keep-alive blocks the reap and lsof never runs; once it goes stale the reap happens", T, async () => {
  const lsof = countingLsof();
  const r = await startRelay({ idleMinutes: "0.01", files: { "lsof-bin": lsof.file } }); // ~0.6 s window
  const ka = path.join(r.profileDir, KEEPALIVE_NAME);
  let toucher;
  try {
    fs.writeFileSync(ka, "");
    toucher = setInterval(() => { const t = Date.now() / 1000; try { fs.utimesSync(ka, t, t); } catch {} }, 150);
    await r.request("tools/list", {});
    assert.strictEqual((await r.call()).isError, false);
    await new Promise((res) => setTimeout(res, 3000)); // ≥ 4 idle windows
    assert.strictEqual(r.count(REAPED), 0, `reaped despite a fresh keep-alive:\n${r.stderr()}`);
    assert.strictEqual(lsof.calls(), 0, "the keep-alive stat must come BEFORE lsof");
    const kept = relayLog(r).filter((l) => l.event === "keepalive");
    assert.ok(kept.length >= 2, `keepalive events logged: ${JSON.stringify(relayLog(r))}`);
    assert.ok(kept.every((l) => typeof l.keepaliveAgeS === "number" && typeof l.idleS === "number" && l.slug === "profile"));

    clearInterval(toucher); toucher = null; // the helper stops touching
    await waitFor(() => r.count(REAPED) === 1, 6000, "reap once the keep-alive is stale");
    assert.ok(lsof.calls() >= 1, "with a stale keep-alive the CDP check runs");
    assert.strictEqual(relayLog(r).filter((l) => l.event === "reaped").length, 1);
    assert.strictEqual(r.child.exitCode, null);
  } finally {
    if (toucher) clearInterval(toucher);
    await r.stop();
    lsof.rm();
  }
});

test("relay: a SYMLINKED keep-alive is ignored — the reap happens (and a failing lsof is logged)", T, async () => {
  const bin = tmp("relay-bad-lsof-");
  fs.writeFileSync(path.join(bin, "lsof"), "#!/bin/sh\necho 'lsof: broken' >&2\nexit 2\n", { mode: 0o755 });
  const r = await startRelay({ idleMinutes: "0.01", files: { "lsof-bin": path.join(bin, "lsof") } });
  const target = path.join(r.dir, "ka-target");
  let toucher;
  try {
    fs.writeFileSync(target, "");
    fs.symlinkSync(target, path.join(r.profileDir, KEEPALIVE_NAME));
    toucher = setInterval(() => { const t = Date.now() / 1000; try { fs.utimesSync(target, t, t); } catch {} }, 150);
    await r.request("tools/list", {});
    assert.strictEqual((await r.call()).isError, false);
    await waitFor(() => r.count(REAPED) === 1, 6000, "reap despite the symlinked keep-alive");
    const events = relayLog(r).map((l) => l.event);
    assert.ok(!events.includes("keepalive"), `a symlink must not count: ${events}`);
    assert.deepStrictEqual(events.slice(-2), ["lsof-failed", "reaped"]);
    assert.match(relayLog(r).find((l) => l.event === "lsof-failed").reason, /lsof failed \(2: lsof: broken\)/);
  } finally {
    if (toucher) clearInterval(toucher);
    await r.stop();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("relay: an external-client hold logs 'held' once, again when the pid set changes, then 'reaped'; the sidecar carries reapHeldBy", T, async () => {
  const l = await listener();
  const ext1 = cdpClientChild(l.port);
  let ext2;
  let r;
  try {
    await waitFor(() => l.accepted() === 1, 3000, "ext1 connected");
    r = await startRelay({ idleMinutes: "0.01", files: { "brave-port": String(l.port), "upstream-connects": "1" } });
    await r.request("tools/list", {});
    assert.strictEqual((await r.call()).isError, false);
    await waitFor(() => l.accepted() === 3, 3000, "relay + upstream connected");
    await waitFor(() => r.count(/external CDP client/g) >= 3, 8000, "three held ticks");
    let held = relayLog(r).filter((x) => x.event === "held");
    assert.strictEqual(held.length, 1, `one 'held' line per hold, not per tick: ${JSON.stringify(held)}`);
    assert.deepStrictEqual(held[0].heldBy.map((h) => h.pid), [ext1.pid]);
    assert.match(held[0].heldBy[0].command, /node/);
    assert.ok(held[0].heldBy[0].command.length <= 120);

    ext2 = cdpClientChild(l.port);
    await waitFor(() => relayLog(r).filter((x) => x.event === "held").length === 2, 6000, "a second 'held' when ext2 joins");
    held = relayLog(r).filter((x) => x.event === "held");
    assert.deepStrictEqual(held[1].heldBy.map((h) => h.pid), [ext1.pid, ext2.pid].sort((a, b) => a - b));

    // Hold start/change are written to the sidecar at once.
    const side = sidecarOf(r);
    assert.deepStrictEqual(side.reapHeldBy && side.reapHeldBy.pids, held[1].heldBy.map((h) => h.pid));
    assert.match(side.reapHeldBy.since, /Z$/);

    // The Brave going away ends the hold: "released", reapHeldBy cleared.
    await r.killBrave();
    assert.strictEqual(sidecarOf(r).reapHeldBy, null, "reapHeldBy cleared when the hold ends");
    const rel = relayLog(r).filter((x) => x.event === "released");
    assert.strictEqual(rel.length, 1);
    assert.strictEqual(rel[0].reason, "brave-gone");
    assert.ok(rel[0].heldS > 0, JSON.stringify(rel[0]));
    await waitFor(() => r.count(REAPED) === 1, 6000, "reap after the Brave died");
    const events = relayLog(r).map((x) => x.event);
    assert.deepStrictEqual(events, ["held", "held", "released", "reaped"], JSON.stringify(events));
    assert.strictEqual(r.child.exitCode, null);
  } finally {
    for (const c of [ext1, ext2]) if (c && isAlive(c.pid)) c.kill("SIGKILL");
    if (r) await r.stop();
    l.close();
  }
});

test("relay: an unwritable reap log changes nothing — the reap still happens and the relay stays up", T, async () => {
  const lsof = countingLsof();
  const r = await startRelay({ idleMinutes: "0.01", files: { "lsof-bin": lsof.file } });
  try {
    fs.mkdirSync(path.join(r.dir, "cache", REAP_LOG_NAME), { recursive: true }); // log path is a directory
    await r.request("tools/list", {});
    assert.strictEqual((await r.call()).isError, false);
    await waitFor(() => r.count(REAPED) === 1, 6000, "reap with an unwritable log");
    assert.strictEqual((await r.call()).isError, false, "the relay still serves calls");
    await waitFor(() => r.count(REAPED) === 2, 6000, "a second reap");
    assert.strictEqual(r.child.exitCode, null, "relay must stay up");
    assert.ok(fs.statSync(path.join(r.dir, "cache", REAP_LOG_NAME)).isDirectory());
  } finally {
    await r.stop();
    lsof.rm();
  }
});

test("relay: one keep-alive touch holds for ONE idle window after the touch, not one window after the check", T, async () => {
  // Window 6 s, reaper tick 100 ms (as in production, tick << window). The
  // last MCP call is at A, the single touch at M = A + 1 s. The check at
  // ~A + 6 s finds the keep-alive fresh; the reap must follow at ~M + 6 s.
  // Resetting the idle clock to the CHECK time would hold until ~A + 12 s
  // (= M + 11 s). Bounds leave ~2.5 s for a loaded machine on either side.
  const lsof = countingLsof();
  const r = await startRelay({ idleMinutes: "0.1", files: { "lsof-bin": lsof.file, "reaper-tick-ms": "100" } });
  try {
    await r.request("tools/list", {});
    assert.strictEqual((await r.call()).isError, false);
    await new Promise((res) => setTimeout(res, 1000));
    const ka = path.join(r.profileDir, KEEPALIVE_NAME);
    fs.writeFileSync(ka, "");
    const touchedAt = fs.statSync(ka).mtimeMs;
    await waitFor(() => r.count(REAPED) === 1, 20000, "reap after the keep-alive expires");
    const reapedAt = Date.now();
    const kept = relayLog(r).filter((l) => l.event === "keepalive");
    assert.ok(kept.length >= 1, "precondition: the keep-alive held the reap at least once");
    const after = reapedAt - touchedAt;
    assert.ok(after >= 5800, `reaped ${after} ms after the touch — before the window ended`);
    assert.ok(after <= 8500, `reaped ${after} ms after the touch — the keep-alive held past one window`);
  } finally {
    await r.stop();
    lsof.rm();
  }
});

test("relay: a hold is released (and logged) on an MCP call, on a keep-alive taking over, and when no client is left", T, async () => {
  const l = await listener();
  const ext = cdpClientChild(l.port);
  let r;
  let toucher;
  try {
    await waitFor(() => l.accepted() === 1, 3000, "ext connected");
    r = await startRelay({ idleMinutes: "0.01", files: { "brave-port": String(l.port), "upstream-connects": "1", "reaper-tick-ms": "100" } });
    await r.request("tools/list", {});
    assert.strictEqual((await r.call()).isError, false);
    const evs = () => relayLog(r);
    const n = (e) => evs().filter((x) => x.event === e).length;
    await waitFor(() => n("held") === 1, 6000, "hold #1");
    assert.deepStrictEqual(sidecarOf(r).reapHeldBy.pids, [ext.pid]);

    // 1. An MCP call ends the idle state → released (mcp-call), sidecar cleared.
    assert.strictEqual((await r.call()).isError, false);
    assert.strictEqual(n("released"), 1);
    assert.strictEqual(evs().filter((x) => x.event === "released")[0].reason, "mcp-call");
    assert.strictEqual(sidecarOf(r).reapHeldBy, null);
    // … and the next hold by the same pid is a NEW hold.
    await waitFor(() => n("held") === 2, 6000, "hold #2 by the same pid");

    // 2. A keep-alive takes over → released (keepalive), then keepalive events.
    const ka = path.join(r.profileDir, KEEPALIVE_NAME);
    fs.writeFileSync(ka, "");
    toucher = setInterval(() => { const t = Date.now() / 1000; try { fs.utimesSync(ka, t, t); } catch {} }, 100);
    await waitFor(() => n("released") === 2, 6000, "release when the keep-alive takes over");
    assert.strictEqual(evs().filter((x) => x.event === "released")[1].reason, "keepalive");
    assert.strictEqual(sidecarOf(r).reapHeldBy, null);
    await waitFor(() => n("keepalive") >= 1, 3000, "keepalive event");
    clearInterval(toucher); toucher = null;
    fs.rmSync(ka);
    await waitFor(() => n("held") === 3, 6000, "hold #3 once the keep-alive is gone");

    // 3. The last client leaves → released (no-clients), then the reap.
    ext.kill("SIGKILL");
    await waitFor(() => n("reaped") === 1, 6000, "reap after the client left");
    const rel = evs().filter((x) => x.event === "released");
    assert.deepStrictEqual(rel.map((x) => x.reason), ["mcp-call", "keepalive", "no-clients"]);
    for (const x of rel) assert.ok(typeof x.heldS === "number" && x.heldS >= 0, JSON.stringify(x));
    const seq = evs().map((x) => x.event).filter((e) => e !== "keepalive");
    assert.deepStrictEqual(seq, ["held", "released", "held", "released", "held", "released", "reaped"], JSON.stringify(seq));
    assert.strictEqual(r.child.exitCode, null);
  } finally {
    if (toucher) clearInterval(toucher);
    if (isAlive(ext.pid)) ext.kill("SIGKILL");
    if (r) await r.stop();
    l.close();
  }
});

test("relay: a ps / lsof that never exits cannot wedge the reaper — the hold resolves within the cap and a later reap still happens", T, async () => {
  const l = await listener();
  const ext = cdpClientChild(l.port);
  let r;
  try {
    await waitFor(() => l.accepted() === 1, 3000, "ext connected");
    r = await startRelay({ idleMinutes: "0.01", files: { "brave-port": String(l.port), "upstream-connects": "1", "reaper-tick-ms": "100", "ps-hang": "1" } });
    await r.request("tools/list", {});
    assert.strictEqual((await r.call()).isError, false);
    await waitFor(() => relayLog(r).some((x) => x.event === "held"), 6000, "held() to resolve despite the hung ps (cap = 2 s + 1 s)");
    assert.ok(fs.existsSync(path.join(r.dir, "ps-hung")), "precondition: the ps/lsof children really hung");
    const held = relayLog(r).find((x) => x.event === "held");
    assert.deepStrictEqual(held.heldBy, [{ pid: ext.pid, command: null }]);
    const before = r.count(/external CDP client/g);
    await waitFor(() => r.count(/external CDP client/g) > before, 3000, "the reaper keeps ticking");
    ext.kill("SIGKILL");
    await waitFor(() => r.count(REAPED) === 1, 6000, "a reap after the client left");
    assert.strictEqual(r.child.exitCode, null);
  } finally {
    if (isAlive(ext.pid)) ext.kill("SIGKILL");
    if (r) await r.stop();
    l.close();
  }
});
