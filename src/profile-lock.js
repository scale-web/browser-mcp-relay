// profile-lock.js — who owns a profile dir, decided by the kernel.
//
// Spec v4 §1a (+ amendments 1–3, 7). Two files live in every profile dir:
//
//   .mcp-relay.flock   — opened O_CREAT|O_RDWR|O_EXLOCK|O_NONBLOCK and held for
//                        the relay's life. The kernel releases it when the
//                        process dies, so relays need no staleness logic
//                        between themselves. libuv adds O_CLOEXEC, so neither
//                        Brave nor the upstream child inherits it. Never
//                        deleted, except with its whole (clone) dir.
//   .mcp-wrapper-lock  — the compatibility RECORD, compact JSON, written
//                        tmp-then-link() under the flock:
//                        {"v":2,"pid":…,"ppid":…,"startedAt":"<ISO UTC>",
//                         "pidStartEpoch":…,"sessionId":…,"host":…}
//                        Pre-change relays, save-handoff.md, boot-check.sh and
//                        the inspector read it. No pidStartTime: no running
//                        relay reads it, and its local-time string was the bug.
//
// ONE predicate, used by the base claim, the start sweep, clone GC, the
// inspector's Reap and the one-time prune (classifyDir):
//   free ⇔ flock acquired ∧ the record is not held, where the record is held iff
//     - absent                     → not held
//     - unparseable                → held while younger than 10 s
//     - v ≥ 2                      → held iff the pid is alive with start epoch
//                                    == pidStartEpoch (a live v2 holder whose
//                                    flock we can still take is an ANOMALY:
//                                    busy + log — e.g. the flock file was
//                                    deleted and recreated under it)
//     - legacy (pre-change)        → held iff the pid is alive and
//                                    procStartEpoch(pid) ≤ startedAt + 2 s
//   Unknown answers (ps failed, unparseable startedAt) count as HELD: the cost
//   of a false "held" is a clone; the cost of a false "free" is a SIGKILLed
//   Brave in someone else's session.
//
// Darwin only for the kernel lock (O_EXLOCK = 0x20, sys/fcntl.h; Node does not
// export it). Elsewhere openFlock() returns a lock-less handle and the record
// alone decides — the pre-change behaviour, minus its TZ bug.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const processShim = require("./process-shim.js");

const FLOCK_NAME = ".mcp-relay.flock";
const RECORD_NAME = ".mcp-wrapper-lock";
const RECORD_VERSION = 2;
const O_EXLOCK_DARWIN = 0x20;
const UNPARSEABLE_GRACE_MS = 10_000;
const LEGACY_SLACK_S = 2;

function kernelLockSupported(platform = process.platform) {
  return platform === "darwin";
}

/**
 * Take the profile dir's flock. Returns { fd, path } on success (fd is null on
 * platforms without O_EXLOCK), or null when another open file description
 * holds it — including one in THIS process (BSD flock is per open-file
 * description, so a second open by the holder also gets EAGAIN).
 */
function openFlock(dir, opts = {}) {
  const p = path.join(dir, FLOCK_NAME);
  if (!kernelLockSupported(opts._platform)) return { fd: null, path: p, kernel: false };
  const flags = fs.constants.O_CREAT | fs.constants.O_RDWR | O_EXLOCK_DARWIN | fs.constants.O_NONBLOCK;
  try {
    return { fd: fs.openSync(p, flags, 0o600), path: p, kernel: true };
  } catch (e) {
    if (e.code === "EAGAIN" || e.code === "EWOULDBLOCK") return null;
    throw e;
  }
}

function closeFlock(handle) {
  if (!handle || handle.fd == null) return;
  try { fs.closeSync(handle.fd); } catch { /* already closed */ }
  handle.fd = null;
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Parse `ps -o lstart=` printed under TZ=UTC0 LC_ALL=C ("Sun Oct 12 17:00:10 2026",
 *  day space-padded) into epoch seconds. Never Date.parse on the ps string. */
function parseLstartUtc(text) {
  const m = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(String(text || ""));
  if (!m || !(m[1] in MONTHS)) return null;
  return Date.UTC(+m[6], MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]) / 1000;
}

let ownStartEpoch;
/** Start time of `pid` in epoch seconds, or null when unknown. */
function procStartEpoch(pid, opts = {}) {
  if (opts._procStartEpoch) return opts._procStartEpoch(pid);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (pid === process.pid && ownStartEpoch !== undefined) return ownStartEpoch;
  const platform = opts._platform || process.platform;
  let epoch = null;
  if (platform === "win32") {
    // getPidStartTime returns CreationDate.ToFileTimeUtc() (100 ns since 1601).
    const ft = processShim.getPidStartTime(pid, opts);
    if (ft && /^\d+$/.test(ft)) epoch = Math.floor(Number(ft) / 1e7 - 11644473600);
  } else {
    const r = (opts._spawnSync || spawnSync)("ps", ["-p", String(Math.floor(pid)), "-o", "lstart="], {
      encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
      env: { ...process.env, TZ: "UTC0", LC_ALL: "C" },
    });
    if (r && !r.error && r.status === 0) epoch = parseLstartUtc(r.stdout);
  }
  if (pid === process.pid && epoch !== null) ownStartEpoch = epoch;
  return epoch;
}

function isAlive(pid, opts) {
  return opts._isPidAlive ? opts._isPidAlive(pid) : processShim.isPidAlive(pid, opts);
}

/** { kind: "absent" } | { kind: "unparseable", ino, mtimeMs } | { kind: "ok", meta, ino, mtimeMs } */
function readRecord(dir, opts = {}) {
  const p = path.join(dir, RECORD_NAME);
  let st;
  let text;
  try {
    st = fs.lstatSync(p);
    text = (opts._readFile || ((f) => fs.readFileSync(f, "utf8")))(p);
  } catch (e) {
    if (e.code === "ENOENT") return { kind: "absent" };
    throw e;
  }
  try {
    const meta = JSON.parse(text);
    if (meta && typeof meta === "object" && Number.isFinite(meta.pid)) {
      return { kind: "ok", meta, ino: st.ino, mtimeMs: st.mtimeMs };
    }
  } catch { /* fall through */ }
  return { kind: "unparseable", ino: st.ino, mtimeMs: st.mtimeMs };
}

function isV2(meta) {
  return Number.isFinite(meta.v) && meta.v >= RECORD_VERSION;
}

/** Is the record's holder alive? → { held, reason } (see header). */
function recordHeld(rec, opts = {}) {
  const now = opts._now ?? Date.now();
  if (rec.kind === "absent") return { held: false, reason: "no record" };
  if (rec.kind === "unparseable") {
    return now - rec.mtimeMs < UNPARSEABLE_GRACE_MS
      ? { held: true, reason: "unparseable record younger than 10 s (a writer may be mid-write)" }
      : { held: false, reason: "unparseable record older than 10 s" };
  }
  const { meta } = rec;
  if (!isAlive(meta.pid, opts)) return { held: false, reason: `holder pid ${meta.pid} is dead` };
  const epoch = procStartEpoch(meta.pid, opts);
  if (epoch === null) return { held: true, reason: `holder pid ${meta.pid} alive, start time unknown` };
  if (isV2(meta)) {
    if (!Number.isFinite(meta.pidStartEpoch)) return { held: true, reason: `v2 holder pid ${meta.pid} alive, no pidStartEpoch` };
    return epoch === meta.pidStartEpoch
      ? { held: true, reason: `v2 holder pid ${meta.pid} alive` }
      : { held: false, reason: `pid ${meta.pid} was recycled (start ${epoch} != ${meta.pidStartEpoch})` };
  }
  // Legacy rule: a recycled pid always starts after the original owner died,
  // and that death came after the record was written.
  const startedAt = Date.parse(meta.startedAt) / 1000;
  if (!Number.isFinite(startedAt)) return { held: true, reason: `legacy holder pid ${meta.pid} alive, startedAt unparseable` };
  return epoch <= startedAt + LEGACY_SLACK_S
    ? { held: true, reason: `legacy holder pid ${meta.pid} alive` }
    : { held: false, reason: `pid ${meta.pid} was recycled (started ${epoch - startedAt}s after the record)` };
}

/**
 * THE predicate. Returns { free: true, flock, record } with the flock HELD (the
 * caller must close it or keep it), or { free: false, reason, anomaly? } with
 * nothing held.
 */
function classifyDir(dir, opts = {}) {
  const log = opts._log || ((m) => process.stderr.write(`[mcp-relay] ${m}\n`));
  const flock = openFlock(dir, opts);
  if (!flock) return { free: false, reason: "flock held by a live relay" };
  let rec;
  try {
    rec = readRecord(dir, opts);
  } catch (e) {
    closeFlock(flock);
    return { free: false, reason: `record unreadable: ${e.code || e.message}` };
  }
  const h = recordHeld(rec, opts);
  if (!h.held) return { free: true, flock, record: rec, reason: h.reason };
  closeFlock(flock);
  if (rec.kind === "ok" && isV2(rec.meta) && flock.kernel) {
    // A live v2 holder always holds the flock. Getting it means the flock file
    // was replaced under that holder: never double-claim, say so loudly.
    log(`ANOMALY: ${dir} has a live v2 holder (pid ${rec.meta.pid}) but its flock was acquirable — the flock file was probably deleted and recreated; treating the dir as busy`);
    return { free: false, reason: h.reason, anomaly: true };
  }
  return { free: false, reason: h.reason };
}

function buildRecord(opts = {}) {
  return {
    v: RECORD_VERSION,
    pid: process.pid,
    ppid: process.ppid,
    startedAt: new Date(opts._now ?? Date.now()).toISOString(),
    pidStartEpoch: procStartEpoch(process.pid, opts),
    sessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
    host: os.hostname(),
  };
}

function sameRecord(a, b) {
  return !!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt && a.pidStartEpoch === b.pidStartEpoch;
}

/**
 * Write our record while holding the flock (amendment 2): replace a stale
 * record by owner-check → unlink → link(); on EEXIST re-read and re-run the
 * predicate (a live holder → busy); after link() read it back once and confirm
 * it is ours. A residual race with pre-change relays (their check-then-unlink,
 * their openSync("wx")) is accepted for the mixed-version window.
 *
 * @returns {{ ok: true, meta } | { ok: false, reason }}
 */
function writeRecord(dir, staleRecord, opts = {}) {
  const lockPath = path.join(dir, RECORD_NAME);
  const meta = buildRecord(opts);
  const tmp = path.join(dir, `${RECORD_NAME}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(meta));
    try { fs.fsyncSync(fd); } catch { /* unsupported */ }
  } finally {
    fs.closeSync(fd);
  }
  try {
    let stale = staleRecord || { kind: "absent" };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (stale.kind !== "absent") {
        // Owner-check: unlink only the exact file we judged stale.
        let ino = null;
        try { ino = fs.lstatSync(lockPath).ino; } catch (e) { if (e.code !== "ENOENT") throw e; }
        if (ino !== null && ino === stale.ino) {
          if (opts._beforeUnlinkStale) opts._beforeUnlinkStale();
          try { fs.unlinkSync(lockPath); } catch (e) { if (e.code !== "ENOENT") throw e; }
        } else if (ino !== null) {
          const now = readRecord(dir, opts);
          if (recordHeld(now, opts).held) return { ok: false, reason: "record replaced by a live holder" };
          stale = now;
          continue;
        }
      }
      if (opts._beforeLink) opts._beforeLink();
      try {
        fs.linkSync(tmp, lockPath);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        const now = readRecord(dir, opts);
        if (recordHeld(now, opts).held) return { ok: false, reason: "EEXIST: a live holder wrote its record first" };
        stale = now;
        continue;
      }
      if (opts._afterLink) opts._afterLink();
      const back = readRecord(dir, opts);
      if (back.kind === "ok" && sameRecord(back.meta, meta)) return { ok: true, meta };
      return { ok: false, reason: "read-back did not return our record" };
    }
    return { ok: false, reason: "record kept changing under us" };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Owner-checked unlink: remove the record only if it is still ours. */
function releaseRecord(dir, meta) {
  if (!meta) return false;
  try {
    const rec = readRecord(dir);
    if (rec.kind === "ok" && sameRecord(rec.meta, meta)) {
      fs.unlinkSync(path.join(dir, RECORD_NAME));
      return true;
    }
  } catch { /* gone or unreadable — not ours to touch */ }
  return false;
}

/** Owner-checked unlink of a record we judged stale under the flock. */
function removeStaleRecord(dir, staleRecord) {
  if (!staleRecord || staleRecord.kind === "absent") return false;
  const p = path.join(dir, RECORD_NAME);
  try {
    if (fs.lstatSync(p).ino !== staleRecord.ino) return false;
    fs.unlinkSync(p);
    return true;
  } catch { return false; }
}

/**
 * Claim `dir`: the predicate, then our record. Returns
 * { dir, flock, meta, release } or null (busy). release() follows the base
 * shutdown order's tail: owner-checked record unlink, THEN the flock fd.
 */
function claimDir(dir, opts = {}) {
  const c = classifyDir(dir, opts);
  if (!c.free) return null;
  let w;
  try {
    w = writeRecord(dir, c.record, opts);
  } catch (e) {
    closeFlock(c.flock);
    throw e;
  }
  if (!w.ok) {
    (opts._log || ((m) => process.stderr.write(`[mcp-relay] ${m}\n`)))(`claim of ${dir} abandoned: ${w.reason}`);
    closeFlock(c.flock);
    return null;
  }
  if (c.record.kind !== "absent") {
    process.stderr.write(`[mcp-relay] replaced stale record at ${path.join(dir, RECORD_NAME)} (${c.reason})\n`);
  }
  let released = false;
  return {
    dir,
    flock: c.flock,
    meta: w.meta,
    release() {
      if (released) return;
      released = true;
      releaseRecord(dir, w.meta);
      closeFlock(c.flock);
    },
  };
}

module.exports = {
  FLOCK_NAME,
  RECORD_NAME,
  RECORD_VERSION,
  O_EXLOCK_DARWIN,
  UNPARSEABLE_GRACE_MS,
  kernelLockSupported,
  openFlock,
  closeFlock,
  parseLstartUtc,
  procStartEpoch,
  readRecord,
  recordHeld,
  classifyDir,
  buildRecord,
  writeRecord,
  releaseRecord,
  removeStaleRecord,
  claimDir,
};
