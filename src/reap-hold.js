// reap-hold.js — what holds the idle reaper off a Brave, and the record of it.
//
// 1. KEEP-ALIVE FILE. `<claimed profile dir>/.mcp-relay-keepalive`. A helper
//    that drives this relay's Brave outside MCP `touch`es it each time it uses
//    the browser. The reaper treats it as activity while it is a REGULAR file
//    (lstat: a symlink, directory or anything else is ignored) whose mtime is
//    less than one idle window old. Protection therefore ends one idle window
//    after the last touch — it can never hold a Brave forever. An mtime more
//    than a few seconds in the future is ignored for the same reason.
//
// 2. HOLD / REAP LOG. `<userCacheRoot>/reap-events.log`, one JSON line per
//    event, mode 0600, rotated to `reap-events.log.1` (one kept) past ~1 MB:
//      { ts, slug, pid, event, idleS?, ... }
//      event "held"        heldBy: [{ pid, command }] — once per hold, and
//                          again when the holder pid set changes
//            "released"    reason, heldS, pids — the hold ended (no clients,
//                          an MCP call, a keep-alive, a reap, Brave gone,
//                          lsof failed); the next hold, even by the same pids,
//                          writes a new "held"
//            "keepalive"   keepaliveAgeS
//            "lsof-failed" reason
//            "reaped"
//    `command` is redacted to the executable's basename plus a script's
//    basename ("node own-relay-port.mjs") — never arguments, which can carry
//    tokens. Several relays share the file: appends are O_APPEND, and the
//    rotation (size check + rename) runs under a short lock on a sibling
//    `reap-events.log.lock`, re-checking the size once the lock is held, so
//    two relays never both rotate and overwrite a full `.1` with a near-empty
//    one. Measurement only: no write error ever reaches the reaper.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const KEEPALIVE_NAME = ".mcp-relay-keepalive";
const REAP_LOG_NAME = "reap-events.log";
const MAX_FUTURE_MS = 5000;
const O_EXLOCK_DARWIN = 0x20;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const SCRIPT_RE = /^[\w.@+-]+\.(?:mjs|cjs|js|ts|py|sh|rb|pl)$/;

/** "node own-relay-port.mjs": the executable's basename, plus the first
 *  non-option argument's basename when it is a script file name. Nothing else
 *  from the command line — arguments can carry tokens. */
function redactCommand(comm, args) {
  const exe = path.basename(String(comm || "").trim());
  if (!exe) return null;
  const a = String(args || "").trim();
  const rest = a.startsWith(String(comm).trim()) ? a.slice(String(comm).trim().length) : a.replace(/^\S+/, "");
  const script = rest.trim().split(/\s+/).find((t) => t && !t.startsWith("-"));
  const base = script ? path.basename(script) : null;
  return (base && SCRIPT_RE.test(base) ? `${exe} ${base}` : exe).slice(0, 120);
}

/** Run fn under an exclusive lock on `lockPath` (darwin: O_EXLOCK; elsewhere
 *  an O_EXCL file, broken when > 10 s old). Gives up after `waitMs` and
 *  returns false without running fn. Never throws. */
function withFileLock(lockPath, fn, { waitMs = 250, _fs = fs, _platform = process.platform } = {}) {
  const darwin = _platform === "darwin";
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd = null;
    try {
      fd = darwin
        ? _fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | O_EXLOCK_DARWIN | fs.constants.O_NONBLOCK, 0o600)
        : _fs.openSync(lockPath, "wx", 0o600);
    } catch (e) {
      if (!darwin && e.code === "EEXIST") {
        try { if (Date.now() - _fs.statSync(lockPath).mtimeMs > 10_000) _fs.unlinkSync(lockPath); } catch { /* raced */ }
      } else if (e.code !== "EAGAIN" && e.code !== "EWOULDBLOCK") {
        return false;
      }
      if (Date.now() >= deadline) return false;
      Atomics.wait(SLEEP, 0, 0, 5);
      continue;
    }
    try { fn(); return true; } catch { return false; } finally {
      try { _fs.closeSync(fd); } catch { /* closed */ }
      if (!darwin) { try { _fs.unlinkSync(lockPath); } catch { /* gone */ } }
    }
  }
}

/** Age (ms) of a fresh keep-alive in `dir`, or null when absent, not a regular
 *  file, stale (age ≥ idleMs) or dated in the future. Never throws. */
function freshKeepaliveAgeMs(dir, idleMs, { now = Date.now(), _lstat = fs.lstatSync } = {}) {
  let st;
  try { st = _lstat(path.join(dir, KEEPALIVE_NAME)); } catch { return null; }
  if (!st || !st.isFile()) return null;
  const age = now - st.mtimeMs;
  if (age < -MAX_FUTURE_MS || age >= idleMs) return null;
  return Math.max(0, age);
}

/** { pid → column text } from one `ps -o pid=,<col>=`; never throws or hangs. */
function psColumn(pids, col, { timeoutMs, _execFile }) {
  return new Promise((resolve) => {
    const out = {};
    try {
      _execFile("/bin/ps", ["-o", `pid=,${col}=`, "-p", pids.join(",")],
        { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" },
        (err, stdout) => {
          for (const line of String(stdout || "").split("\n")) {
            const m = /^\s*(\d+)\s+(.*)$/.exec(line);
            if (m) out[Number(m[1])] = m[2];
          }
          resolve(out);
        });
    } catch { resolve(out); }
  });
}

/** { pid → redacted command } (see redactCommand); never throws or hangs. */
async function psCommands(pids, { timeoutMs = 2000, _execFile = execFile } = {}) {
  const out = {};
  if (!pids.length) return out;
  const [comm, args] = await Promise.all([
    psColumn(pids, "comm", { timeoutMs, _execFile }),
    psColumn(pids, "args", { timeoutMs, _execFile }),
  ]);
  for (const pid of pids) {
    if (comm[pid] !== undefined) out[pid] = redactCommand(comm[pid], args[pid]);
  }
  return out;
}

class ReapLog {
  /**
   * @param {{ file: string, slug: string, pid?: number, maxBytes?: number,
   *   _ps?: (pids: number[]) => Promise<object>, _fs?: object }} opts
   */
  constructor({ file, slug, pid = process.pid, maxBytes = 1024 * 1024, _ps = psCommands, _fs = fs, _lock = withFileLock }) {
    this.file = file;
    this.slug = slug;
    this.pid = pid;
    this.maxBytes = maxBytes;
    this._ps = _ps;
    this._fs = _fs;
    this._lock = _lock;
    this.holdKey = null; // sorted holder pids of the current hold, or null
    this.holdSince = null;
  }

  /** Append one event line. Returns true when written; never throws. */
  write(event, fields = {}) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), slug: this.slug, pid: this.pid, event, ...fields }) + "\n";
      const f = this._fs;
      f.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const size = () => { try { return f.statSync(this.file).size; } catch { return 0; } };
      const over = () => { const n = size(); return n > 0 && n + line.length > this.maxBytes; };
      if (over()) {
        // Re-check under the lock: a peer relay may have rotated meanwhile.
        this._lock(`${this.file}.lock`, () => { if (over()) f.renameSync(this.file, `${this.file}.1`); }, { _fs: f });
      }
      f.appendFileSync(this.file, line, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A reap was skipped because `pids` hold the Brave. Writes "held" on the
   * first skip of a hold and when the pid set changes. Resolves
   * { changed, pids, since }; never throws.
   */
  async held(pids, idleS) {
    try {
      const sorted = [...new Set(pids)].sort((a, b) => a - b);
      const key = sorted.join(",");
      if (key === this.holdKey) return { changed: false, pids: sorted, since: this.holdSince };
      if (this.holdKey === null) this.holdSince = new Date().toISOString();
      this.holdKey = key;
      let commands = {};
      try { commands = (await this._ps(sorted)) || {}; } catch { /* no commands */ }
      this.write("held", { heldBy: sorted.map((p) => ({ pid: p, command: commands[p] || null })), idleS });
      return { changed: true, pids: sorted, since: this.holdSince };
    } catch {
      return { changed: false, pids: [], since: null };
    }
  }

  /** The hold (if any) is over: write "released" { reason, heldS, pids } and
   *  forget it, so the next hold — even by the same pids — writes a new
   *  "held". Returns true when one was open; never throws. */
  release(reason) {
    if (this.holdKey === null) return false;
    const since = Date.parse(this.holdSince);
    const pids = this.holdKey.split(",").filter(Boolean).map(Number);
    this.holdKey = null;
    this.holdSince = null;
    this.write("released", { reason, heldS: Number.isFinite(since) ? Math.round((Date.now() - since) / 100) / 10 : null, pids });
    return true;
  }
}

module.exports = { KEEPALIVE_NAME, REAP_LOG_NAME, freshKeepaliveAgeMs, redactCommand, withFileLock, psCommands, ReapLog };
