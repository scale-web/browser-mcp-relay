// profile-lock.test.js — spec v4 §1a: kernel flock + v2 record + ONE predicate.
// Assertions are on state: flock EAGAIN, record files and inodes, which
// process holds what. Multi-process cases run only under the harness.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const lock = require("../src/profile-lock.js");
const pool = require("../src/pool-shared.js");
const { isolated, SKIP_MSG, homeTmp, nodeChild, claimHolder, flockHolder, sleeper, killAndWait, REPO } = require("./helpers/isolation.js");

const darwin = process.platform === "darwin";
const ISO = { skip: !isolated() ? SKIP_MSG : (!darwin ? "kernel flock is darwin-only" : false), timeout: 30000 };

function dirIn(prefix) {
  return isolated() ? homeTmp(prefix) : fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function writeRecord(dir, meta) {
  fs.writeFileSync(path.join(dir, lock.RECORD_NAME), typeof meta === "string" ? meta : JSON.stringify(meta));
}
function backdate(p, ms = 120_000) {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(p, t, t);
}
/** A pidStartTime string as a pre-change relay in ANOTHER time zone wrote it. */
function lstartIn(tz, pid) {
  return spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, TZ: tz, LC_ALL: "C" } }).stdout.trim();
}

// ── pure pieces ──────────────────────────────────────────────────────────

test("parseLstartUtc parses `ps -o lstart=` under TZ=UTC0, space-padded days included", () => {
  assert.strictEqual(lock.parseLstartUtc("Sun Oct 12 17:00:10 2026"), Date.UTC(2026, 9, 12, 17, 0, 10) / 1000);
  assert.strictEqual(lock.parseLstartUtc("Mon Oct  5 01:02:03 2026\n"), Date.UTC(2026, 9, 5, 1, 2, 3) / 1000);
  assert.strictEqual(lock.parseLstartUtc("garbage"), null);
  assert.strictEqual(lock.parseLstartUtc("Sun Foo 12 17:00:10 2026"), null);
});

test("procStartEpoch is time-zone independent (same answer from a process running in another TZ)", (t) => {
  if (process.platform === "win32") return t.skip("POSIX ps");
  const here = lock.procStartEpoch(process.pid);
  assert.ok(Number.isFinite(here));
  assert.ok(Math.abs(here - (Date.now() / 1000 - process.uptime())) < 5, "matches this process's real start");
  const code = `const l=require(${JSON.stringify(path.join(REPO, "src", "profile-lock.js"))});process.stdout.write(String(l.procStartEpoch(${process.pid})))`;
  for (const tz of ["Asia/Tokyo", "America/Denver", "UTC"]) {
    const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, TZ: tz } });
    assert.strictEqual(Number(r.stdout), here, `TZ=${tz}`);
  }
});

test("record predicate matrix (single process)", () => {
  const dir = dirIn("lock-matrix-");
  const held = () => lock.recordHeld(lock.readRecord(dir)).held;
  const myEpoch = lock.procStartEpoch(process.pid);
  writeRecord(dir, { v: 2, pid: process.pid, pidStartEpoch: myEpoch, startedAt: new Date().toISOString() });
  assert.strictEqual(held(), true, "v2, live holder, matching epoch");
  writeRecord(dir, { v: 2, pid: process.pid, pidStartEpoch: myEpoch - 1000, startedAt: new Date().toISOString() });
  assert.strictEqual(held(), false, "v2, same pid but a different start epoch → recycled");
  writeRecord(dir, { v: 2, pid: 2 ** 30, pidStartEpoch: 1 });
  assert.strictEqual(held(), false, "v2, dead pid");
  writeRecord(dir, { pid: process.pid, startedAt: new Date().toISOString() });
  assert.strictEqual(held(), true, "legacy, live, started before the record");
  writeRecord(dir, { pid: process.pid, startedAt: new Date((myEpoch - 60) * 1000).toISOString() });
  assert.strictEqual(held(), false, "legacy, record written before this pid started → recycled");
  writeRecord(dir, { pid: process.pid, startedAt: new Date((myEpoch - 1) * 1000).toISOString() });
  assert.strictEqual(held(), true, "legacy, within the 2 s slack");
  writeRecord(dir, { pid: process.pid });
  assert.strictEqual(held(), true, "legacy, live, startedAt missing → fail safe held");
  fs.rmSync(path.join(dir, lock.RECORD_NAME));
  assert.strictEqual(held(), false, "no record");
});

test("a live holder whose start time cannot be read counts as HELD (fail safe)", () => {
  const dir = dirIn("lock-unknown-");
  writeRecord(dir, { v: 2, pid: process.pid, pidStartEpoch: 5 });
  assert.strictEqual(lock.recordHeld(lock.readRecord(dir), { _procStartEpoch: () => null }).held, true);
});

// ── the flock itself ─────────────────────────────────────────────────────

test("flock: the holder's own second open gets EAGAIN; release makes it acquirable", { skip: !darwin }, () => {
  const dir = dirIn("lock-self-");
  const a = lock.openFlock(dir);
  assert.ok(a && a.fd !== null);
  assert.strictEqual(lock.openFlock(dir), null, "per open-file-description: a second open by the same process is refused");
  lock.closeFlock(a);
  const b = lock.openFlock(dir);
  assert.ok(b && b.fd !== null);
  lock.closeFlock(b);
});

test("flock: another process gets EAGAIN while held; the kernel releases it when the holder dies; a child does not inherit it", ISO, async () => {
  const dir = homeTmp("lock-xproc-");
  // The holder spawns `sleep` (stdio pipes like Playwright's launcher) and
  // exits; the sleep keeps running.
  const holder = nodeChild(`
    const lock = require(${JSON.stringify(path.join(REPO, "src", "profile-lock.js"))});
    const h = lock.openFlock(${JSON.stringify(dir)});
    const s = require("node:child_process").spawn("sleep", ["20"], { stdio: ["pipe", "pipe", "pipe", "pipe"], detached: true });
    s.unref();
    console.log("HELD " + (h ? h.fd : "none") + " SLEEP " + s.pid);
    process.stdin.on("data", () => process.exit(0));
  `);
  const line = await holder.waitLine(/^HELD/);
  const sleepPid = Number(line.split(" ")[3]);
  try {
    const other = flockHolder(dir, 0);
    assert.match(await other.waitLine(/HELD|EAGAIN/), /EAGAIN/, "another process must get EAGAIN");
    await other.exited;
    holder.child.stdin.write("x");
    await holder.exited;
    process.kill(sleepPid, 0); // the spawned child is alive…
    const after = lock.openFlock(dir);
    assert.ok(after && after.fd !== null, "…yet the lock is free: the kernel released it and the child did not inherit it");
    lock.closeFlock(after);
  } finally {
    try { process.kill(sleepPid, "SIGKILL"); } catch { /* gone */ }
  }
});

// ── claimDir: the record ────────────────────────────────────────────────

test("claimDir writes a compact v2 record (0600) that save-handoff's sed regex still parses", { skip: process.platform === "win32" }, () => {
  const dir = dirIn("lock-record-");
  const c = lock.claimDir(dir);
  try {
    const text = fs.readFileSync(path.join(dir, lock.RECORD_NAME), "utf8");
    const meta = JSON.parse(text);
    assert.deepStrictEqual(Object.keys(meta), ["v", "pid", "ppid", "startedAt", "pidStartEpoch", "sessionId", "host"]);
    assert.strictEqual(meta.v, 2);
    assert.strictEqual(text, JSON.stringify(meta), "compact JSON");
    assert.ok(!/pidStartTime/.test(text));
    assert.strictEqual(fs.statSync(path.join(dir, lock.RECORD_NAME)).mode & 0o777, 0o600);
    // ~/.claude/commands/save-handoff.md: sed -nE 's/.*"pid":([0-9]+).*/\1/p'
    const sed = spawnSync("sed", ["-nE", 's/.*"pid":([0-9]+).*/\\1/p', path.join(dir, lock.RECORD_NAME)], { encoding: "utf8" });
    assert.strictEqual(sed.stdout.trim(), String(process.pid), "the greedy sed must not pick up ppid/pidStartEpoch");
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "no tmp file left behind");
  } finally {
    c.release();
  }
});

test("release(): owner-checked — a record that is no longer ours is left alone", () => {
  const dir = dirIn("lock-release-");
  const c = lock.claimDir(dir);
  writeRecord(dir, { v: 2, pid: 424242, pidStartEpoch: 1, startedAt: "x" });
  c.release();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, lock.RECORD_NAME), "utf8")).pid, 424242);
  const again = lock.openFlock(dir);
  assert.ok(again, "flock released");
  lock.closeFlock(again);
  const c2 = lock.claimDir(dir); // stale (dead) record → replaced
  assert.ok(c2);
  c2.release();
  assert.ok(!fs.existsSync(path.join(dir, lock.RECORD_NAME)), "our own record is removed on release");
});

test("EEXIST: a live pre-change holder that writes its record between our predicate and link() wins; we back off cleanly", ISO, async () => {
  const dir = homeTmp("lock-eexist-");
  const s = sleeper();
  try {
    const c = lock.claimDir(dir, {
      _beforeLink: () => writeRecord(dir, { pid: s.pid, startedAt: new Date().toISOString(), relay: true }),
      _log: () => {},
    });
    assert.strictEqual(c, null, "must be busy");
    const meta = JSON.parse(fs.readFileSync(path.join(dir, lock.RECORD_NAME), "utf8"));
    assert.strictEqual(meta.pid, s.pid, "the live holder's record is untouched");
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
    const f = lock.openFlock(dir);
    assert.ok(f, "our flock was released on the way out");
    lock.closeFlock(f);
  } finally {
    await killAndWait(s);
  }
});

test("read-back: a record replaced right after our link() means we do NOT hold the dir", () => {
  const dir = dirIn("lock-readback-");
  const c = lock.claimDir(dir, {
    _afterLink: () => writeRecord(dir, { pid: 2 ** 30, startedAt: new Date().toISOString() }),
    _log: () => {},
  });
  assert.strictEqual(c, null);
  const f = lock.openFlock(dir);
  assert.ok(f, "flock released after a failed read-back");
  lock.closeFlock(f);
});

// ── the predicate across processes and formats ──────────────────────────

test("a live LEGACY holder (pidStartTime written in another time zone) keeps its dir: busy", ISO, async () => {
  const dir = homeTmp("lock-legacy-tz-");
  const s = sleeper();
  try {
    await new Promise((r) => setTimeout(r, 1100)); // record strictly after the process started
    writeRecord(dir, {
      pid: s.pid,
      startedAt: new Date().toISOString(),
      pidStartTime: lstartIn("Asia/Tokyo", s.pid), // the H2 field case
      host: os.hostname(),
      relay: true,
    });
    const c = lock.classifyDir(dir);
    assert.strictEqual(c.free, false, c.reason);
    const f = lock.openFlock(dir);
    assert.ok(f, "busy-by-record must not keep the flock");
    lock.closeFlock(f);
  } finally {
    await killAndWait(s);
  }
});

test("a live v2 holder whose flock file was deleted and recreated: ANOMALY → busy, never a double claim", ISO, async () => {
  const dir = homeTmp("lock-anomaly-");
  const h = claimHolder(dir);
  try {
    await h.waitLine(/^CLAIMED/);
    fs.rmSync(path.join(dir, lock.FLOCK_NAME)); // e.g. an agent "clearing stale locks"
    const logs = [];
    const c = lock.classifyDir(dir, { _log: (m) => logs.push(m) });
    assert.strictEqual(c.free, false);
    assert.strictEqual(c.anomaly, true);
    assert.match(logs.join("\n"), /ANOMALY/);
    assert.strictEqual(lock.claimDir(dir, { _log: () => {} }), null, "claimDir must refuse too");
  } finally {
    await killAndWait(h.child);
  }
});

test("stale takeover race: N claimers vs one dead-holder record (delay between owner-check and unlink) → exactly one holder", ISO, async () => {
  const dir = homeTmp("lock-race-");
  writeRecord(dir, { pid: 2 ** 30, startedAt: new Date(Date.now() - 3600_000).toISOString(), relay: true });
  const N = 6;
  const kids = [];
  for (let i = 0; i < N; i++) {
    kids.push(nodeChild(`
      const lock = require(${JSON.stringify(path.join(REPO, "src", "profile-lock.js"))});
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const c = lock.claimDir(${JSON.stringify(dir)}, { _beforeUnlinkStale: () => sleep(300), _log: () => {} });
      console.log(c ? "CLAIMED" : "BUSY");
      setTimeout(() => process.exit(0), 2500);
    `));
  }
  const results = await Promise.all(kids.map((k) => k.waitLine(/^(CLAIMED|BUSY)$/, 15000)));
  await Promise.all(kids.map((k) => k.exited));
  const winners = results.filter((r) => r === "CLAIMED").length;
  assert.strictEqual(winners, 1, `exactly one holder, got ${winners}: ${results.join(",")}`);
});

// ── GC and the clone lifecycle ──────────────────────────────────────────

test("GC never opens a young clone's flock (its age is read first)", ISO, () => {
  const root = homeTmp("gc-young-");
  const young = path.join(root, "proj-p2147483646-aaa111");
  fs.mkdirSync(young);
  writeRecord(young, { v: 2, pid: 2 ** 30, pidStartEpoch: 1 }); // dead owner — would be removable if old
  backdate(path.join(young, lock.RECORD_NAME));
  assert.strictEqual(pool.gcSessionClones({ root, graceMs: 60_000, project: "proj" }), 0);
  assert.ok(fs.existsSync(young));
  assert.ok(!fs.existsSync(path.join(young, lock.FLOCK_NAME)), "GC must not create/open the flock of a clone younger than the grace");
});

test("GC removes an old dead-owner clone of THIS project only; keeps a live legacy clone (TZ-shifted record)", ISO, async () => {
  const root = homeTmp("gc-proj-");
  const s = sleeper();
  try {
    await new Promise((r) => setTimeout(r, 1100));
    const dead = path.join(root, "as-ops-p2147483646-aaa111");
    const other = path.join(root, "as-ops-pages-p2147483646-bbb222");
    const liveLegacy = path.join(root, `as-ops-p${s.pid}-ccc333`);
    for (const d of [dead, other, liveLegacy]) fs.mkdirSync(d);
    writeRecord(dead, { v: 2, pid: 2 ** 30, pidStartEpoch: 1 });
    writeRecord(other, { v: 2, pid: 2 ** 30, pidStartEpoch: 1 });
    writeRecord(liveLegacy, { pid: s.pid, startedAt: new Date().toISOString(), pidStartTime: lstartIn("Asia/Tokyo", s.pid), relay: true });
    for (const d of [dead, other, liveLegacy]) backdate(d);
    const removed = pool.gcSessionClones({ root, project: "as-ops" });
    assert.strictEqual(removed, 1);
    assert.ok(!fs.existsSync(dead), "dead clone of this project removed");
    assert.ok(fs.existsSync(other), "another project's clone is not this sweep's business");
    assert.ok(fs.existsSync(liveLegacy), "a live legacy clone under a TZ shift is NOT removed");
  } finally {
    await killAndWait(s);
  }
});

test("GC keeps a clone whose flock a live relay holds, whatever its record says", ISO, async () => {
  const root = homeTmp("gc-held-");
  const d = path.join(root, "proj-p2147483646-ddd444");
  fs.mkdirSync(d);
  const h = flockHolder(d, 5000);
  try {
    await h.waitLine(/HELD/);
    writeRecord(d, { v: 2, pid: 2 ** 30, pidStartEpoch: 1 }); // record says dead
    backdate(d);
    assert.strictEqual(pool.gcSessionClones({ root, project: "proj" }), 0);
    assert.ok(fs.existsSync(d));
  } finally {
    await killAndWait(h.child);
  }
});

test("the owner's EAGAIN retry: a fresh clone whose flock is briefly held is still claimed (~1 s budget)", ISO, async () => {
  const d = path.join(homeTmp("clone-retry-"), "proj-p1-eee555");
  fs.mkdirSync(d);
  const h = flockHolder(d, 300);
  await h.waitLine(/HELD/);
  const t0 = Date.now();
  const c = await pool.claimFreshClone(d);
  try {
    assert.ok(c, "claimed after the probe let go");
    assert.ok(Date.now() - t0 >= 150, "it really had to wait");
  } finally {
    if (c) c.release();
    await h.exited;
  }
});

test("clone cleanup removes the dir while still holding the flock, then releases", ISO, async () => {
  const root = homeTmp("clone-cleanup-");
  const claim = await pool.claimSlotWithRetry({
    retries: 0, root, _sleep: async () => {},
    _claimSlot: () => { const e = new Error("busy"); e.code = "POOL_BUSY"; throw e; },
  });
  assert.strictEqual(claim.ephemeral, true);
  const other = flockHolder(claim.dir, 0);
  assert.match(await other.waitLine(/HELD|EAGAIN/), /EAGAIN/, "the clone is held while in use");
  await other.exited;
  claim.cleanup();
  assert.ok(!fs.existsSync(claim.dir));
});

// ── inspector: state + Reap under the flock ─────────────────────────────

test("inspector Reap refuses a dir whose flock is held, and reaps a free one under its flock", ISO, async () => {
  const dir = homeTmp("reap-");
  const h = claimHolder(dir);
  try {
    await h.waitLine(/^CLAIMED/);
    assert.strictEqual(pool.probeDirState(dir), "held");
    let reaped = 0;
    assert.throws(() => pool.reapDirUnderFlock(dir, { _reapOrphansFor: () => { reaped++; return 0; } }), /not reaping/);
    assert.strictEqual(reaped, 0, "no Brave was reaped");
    assert.ok(fs.existsSync(path.join(dir, lock.RECORD_NAME)), "the live record is untouched");
  } finally {
    await killAndWait(h.child);
  }
  // Holder dead: its v2 record is stale, the flock is free.
  assert.strictEqual(pool.probeDirState(dir), "free");
  let reapedDir = null;
  pool.reapDirUnderFlock(dir, { _reapOrphansFor: (d) => { reapedDir = d; return 0; } });
  assert.strictEqual(reapedDir, dir);
  assert.ok(!fs.existsSync(path.join(dir, lock.RECORD_NAME)), "stale record removed");
});

test("inspector buildStatus: a held flock is 'claimed' even when the record's pid reads as dead", ISO, async () => {
  const { buildStatus } = require("../src/inspector-server.js");
  const dir = homeTmp("insp-");
  const h = flockHolder(dir, 8000);
  try {
    await h.waitLine(/HELD/);
    writeRecord(dir, { v: 2, pid: 2 ** 30, pidStartEpoch: 1, startedAt: new Date().toISOString() });
    const status = buildStatus({
      _loadConfig: () => ({ poolDirs: [dir], slotRoles: {}, cookieFreshnessWarnDays: 7, cookieSourceProfile: null }),
      _listBraveProcessesRaw: () => "",
      _findCookiesFile: () => null,
      _loadVault: () => ({ summary: () => ({ totalEntries: 0, uniqueHosts: 0, filesLoaded: [], filesSkipped: [] }) }),
    });
    assert.strictEqual(status.slots[0].state, "claimed", "orphan = predicate free, never pid-alive alone");
  } finally {
    await killAndWait(h.child);
  }
});
