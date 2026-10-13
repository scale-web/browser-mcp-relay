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

const { KEEPALIVE_NAME, REAP_LOG_NAME, freshKeepaliveAgeMs, psCommands, ReapLog } = require("../src/reap-hold.js");
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
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [REAP_LOG_NAME, `${REAP_LOG_NAME}.1`], "only one old file kept");
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
    assert.strictEqual(log.endHold(), true);
    assert.strictEqual(log.endHold(), false, "no hold open");
    assert.strictEqual((await log.held([100], 50)).changed, true, "a new hold after the old one ended");
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
    assert.match(real[process.pid], /node/);
    assert.ok(real[process.pid].length <= 120);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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

    // The sidecar's reapHeldBy rides its next write; a Brave death forces one.
    await r.killBrave();
    const side = sidecarOf(r);
    assert.deepStrictEqual(side.reapHeldBy && side.reapHeldBy.pids, held[1].heldBy.map((h) => h.pid));
    assert.match(side.reapHeldBy.since, /Z$/);

    // Brave gone: the next tick reaps the upstream; the hold ends.
    await waitFor(() => r.count(REAPED) === 1, 6000, "reap after the Brave died");
    const events = relayLog(r).map((x) => x.event);
    assert.deepStrictEqual(events, ["held", "held", "reaped"], JSON.stringify(events));
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
