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
//      { ts, slug, pid, event: "held" | "keepalive" | "reaped" | "lsof-failed",
//        heldBy?: [{ pid, command }], keepaliveAgeS?, idleS }
//    "held" is written once per hold (and again when the holder pid set
//    changes), not every tick. Measurement only: no write error ever reaches
//    the reaper.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const KEEPALIVE_NAME = ".mcp-relay-keepalive";
const REAP_LOG_NAME = "reap-events.log";
const MAX_FUTURE_MS = 5000;

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

/** { pid → command } from one `ps`, commands truncated; never throws or hangs. */
function psCommands(pids, { timeoutMs = 2000, _execFile = execFile } = {}) {
  return new Promise((resolve) => {
    const out = {};
    if (!pids.length) { resolve(out); return; }
    try {
      _execFile("/bin/ps", ["-o", "pid=,command=", "-p", pids.join(",")],
        { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" },
        (err, stdout) => {
          for (const line of String(stdout || "").split("\n")) {
            const m = /^\s*(\d+)\s+(.*)$/.exec(line);
            if (m) out[Number(m[1])] = m[2].slice(0, 120);
          }
          resolve(out);
        });
    } catch { resolve(out); }
  });
}

class ReapLog {
  /**
   * @param {{ file: string, slug: string, pid?: number, maxBytes?: number,
   *   _ps?: (pids: number[]) => Promise<object>, _fs?: object }} opts
   */
  constructor({ file, slug, pid = process.pid, maxBytes = 1024 * 1024, _ps = psCommands, _fs = fs }) {
    this.file = file;
    this.slug = slug;
    this.pid = pid;
    this.maxBytes = maxBytes;
    this._ps = _ps;
    this._fs = _fs;
    this.holdKey = null; // sorted holder pids of the current hold, or null
    this.holdSince = null;
  }

  /** Append one event line. Returns true when written; never throws. */
  write(event, fields = {}) {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), slug: this.slug, pid: this.pid, event, ...fields }) + "\n";
      const f = this._fs;
      f.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = f.statSync(this.file).size; } catch { /* absent */ }
      if (size + line.length > this.maxBytes && size > 0) f.renameSync(this.file, `${this.file}.1`);
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

  /** The hold (if any) is over. Returns true when one was open. */
  endHold() {
    const was = this.holdKey !== null;
    this.holdKey = null;
    this.holdSince = null;
    return was;
  }
}

module.exports = { KEEPALIVE_NAME, REAP_LOG_NAME, freshKeepaliveAgeMs, psCommands, ReapLog };
