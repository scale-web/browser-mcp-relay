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
//    `command` names the helper without arguments, which can carry tokens:
//    the executable's basename plus its script as `parent/base`
//    ("node lib/own-relay-port.mjs", "tsx scripts/drive.ts",
//    "python3 -m helpers.cdp_watch"); see redactCommand. Several relays share the file: appends are O_APPEND, and the
//    rotation (size check + rename) runs under a short lock on a sibling
//    `reap-events.log.lock`, re-checking the size once the lock is held, so
//    two relays never both rotate and overwrite a full `.1` with a near-empty
//    one. A lock that cannot be opened (not contention) does not stop
//    rotation, and appends stop at ~2x the cap whatever happens. Measurement only: no write error ever reaches the reaper.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { lsofCommand } = require("./cdp-clients.js");

const KEEPALIVE_NAME = ".mcp-relay-keepalive";
const REAP_LOG_NAME = "reap-events.log";
const MAX_FUTURE_MS = 5000;
const O_EXLOCK_DARWIN = 0x20;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
// Redaction: a name segment we may log. No "/", ":", "?", "=", "&", "#", "%".
const SAFE_SEG = /^[\w@+-][\w.@+-]*$/;
const SCRIPT_EXT = /\.(?:mjs|cjs|js|ts|mts|cts|tsx|jsx|py|sh|rb|pl)$/;
const PY_EXE = /^python[\d.]*$/;
const TOOLS = new Set(["npx", "tsx", "ts-node", "bunx", "pnpx"]);
const NPX_LIKE = new Set(["npx", "bunx", "pnpx"]);
// Options whose VALUE is the next token (so that value is never the script).
const VALUE_OPTS = new Set([
  "-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions",
  "--input-type", "--title", "--env-file", "--inspect-port", "--redirect-warnings",
  "-W", "-X", "--package",
]);
// Options after which the rest is inline code, not a script.
const CODE_OPTS = new Set(["-e", "--eval", "-p", "--print", "-c"]);

/** A path-like argument → "parent/base" (or "base"), each segment SAFE_SEG;
 *  null when it is not a path (URL, key=value, query string …). `cwd` names
 *  the parent of a bare relative file. */
function safePathLabel(tok, cwd) {
  if (!tok || /[:?=&#%]/.test(tok)) return null;
  const base = path.basename(tok);
  if (!SAFE_SEG.test(base)) return null;
  const dirPart = path.dirname(tok);
  let parent = dirPart === "." ? (cwd ? path.basename(cwd) : null) : path.basename(dirPart);
  if (parent && (!SAFE_SEG.test(parent) || parent === ".bin")) parent = null;
  return parent ? `${parent}/${base}` : base;
}

const isPathy = (tok) => tok.includes("/") || SCRIPT_EXT.test(tok);

/**
 * Which helper is this — without anything that could carry a secret. The
 * executable's basename, plus the script it runs as `parent/base` (a path
 * argument, with or without an extension). `python -m <module>` keeps the
 * module. A `.bin` shim or npx/tsx/ts-node keeps the tool name plus its own
 * script/package. Option values (`--require X`, `-r X`, `--inspect=…`) are
 * skipped; inline code (`-e`, `-c`) ends the search. Never an argument that is
 * not a path or module name — no URLs, query strings, key=value or tokens.
 */
function redactCommand(comm, args, cwd = null) {
  const commS = String(comm || "").trim();
  const exe = path.basename(commS);
  if (!exe) return null;
  const a = String(args || "").trim();
  const rest = (commS && a.startsWith(commS) ? a.slice(commS.length) : a.replace(/^\S+/, "")).trim();
  const toks = rest ? rest.split(/\s+/) : [];
  let tool = TOOLS.has(exe) ? exe : null; // tsx / npx run directly
  const parts = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (CODE_OPTS.has(t)) break;
    if (t === "-m" && PY_EXE.test(exe) && !tool) {
      const mod = toks[i + 1];
      if (mod && /^[\w.]+$/.test(mod)) parts.push("-m", mod);
      break;
    }
    if (VALUE_OPTS.has(t)) { i++; continue; }
    if (t.startsWith("-")) continue;
    if (tool) {
      // The tool's own target: a script path, or (npx-like) a package name.
      const label = isPathy(t) ? safePathLabel(t, cwd)
        : (NPX_LIKE.has(tool) && /^@?[\w.+-]+(?:\/[\w.+-]+)?$/.test(t) && !/[:?=&#%]/.test(t) ? t : null);
      if (label) parts.push(label);
      break;
    }
    if (!isPathy(t)) break; // a bare word may be an option's value — never log it
    const label = safePathLabel(t, cwd);
    if (!label) break;
    const base = path.basename(t);
    if (TOOLS.has(base) || path.basename(path.dirname(t)) === ".bin") {
      tool = base; // a shim: name the tool, then look for ITS script
      continue;
    }
    parts.push(label);
    break;
  }
  const head = tool && !TOOLS.has(exe) ? tool : exe;
  return [head, ...parts].join(" ").slice(0, 120);
}

/** Run fn under an exclusive lock on `lockPath` (darwin: O_EXLOCK; elsewhere
 *  an O_EXCL file, broken when > 10 s old). Returns "ran" (fn ran, even if it
 *  threw), "busy" (still contended after `waitMs`; fn not run) or "error"
 *  (the lock itself cannot be opened — mode 000, a directory, root-owned …;
 *  fn not run). Never throws. */
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
        return "error";
      }
      if (Date.now() >= deadline) return "busy";
      Atomics.wait(SLEEP, 0, 0, 5);
      continue;
    }
    try { fn(); } catch { /* fn's own failure */ } finally {
      try { _fs.closeSync(fd); } catch { /* closed */ }
      if (!darwin) { try { _fs.unlinkSync(lockPath); } catch { /* gone */ } }
    }
    return "ran";
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
/** Run `run(finish)`; resolve with what it passes to finish, or `{}` after
 *  timeoutMs + 1 s. execFile's own timeout kills a slow child, but one stuck
 *  in uninterruptible sleep (a dead mount) never exits, so its callback never
 *  fires — and the reaper awaits this. Same hard cap as cdp-clients.js. */
function capped(run, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(cap); resolve(v); };
    const cap = setTimeout(() => finish({}), timeoutMs + 1000);
    if (typeof cap.unref === "function") cap.unref();
    try { run(finish); } catch { finish({}); }
  });
}

function psColumn(pids, col, { timeoutMs, _execFile }) {
  return capped((resolve) => {
    const out = {};
    {
      _execFile("/bin/ps", ["-o", `pid=,${col}=`, "-p", pids.join(",")],
        { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" },
        (err, stdout) => {
          for (const line of String(stdout || "").split("\n")) {
            const m = /^\s*(\d+)\s+(.*)$/.exec(line);
            if (m) out[Number(m[1])] = m[2];
          }
          resolve(out);
        });
    }
  }, timeoutMs);
}

/** { pid → cwd } from one `lsof -a -d cwd` (to name the folder of a bare
 *  `node index.js`); {} on any failure. Never throws; resolves within
 *  timeoutMs + 1 s even if lsof never exits. */
function processCwds(pids, { timeoutMs, _execFile }) {
  return capped((resolve) => {
    const out = {};
    {
      _execFile(lsofCommand(), ["-nP", "-w", "-a", "-d", "cwd", "-p", pids.join(","), "-F", "pn"],
        { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" },
        (err, stdout) => {
          let pid = null;
          for (const line of String(stdout || "").split("\n")) {
            if (line.startsWith("p")) pid = Number(line.slice(1));
            else if (line.startsWith("n") && pid) out[pid] = line.slice(1);
          }
          resolve(out);
        });
    }
  }, timeoutMs);
}

/** { pid → redacted command } (see redactCommand). Never throws; resolves
 *  within timeoutMs + 1 s even if ps or lsof never exits. */
async function psCommands(pids, { timeoutMs = 2000, _execFile = execFile } = {}) {
  const out = {};
  if (!pids.length) return out;
  const [comm, args, cwds] = await Promise.all([
    psColumn(pids, "comm", { timeoutMs, _execFile }),
    psColumn(pids, "args", { timeoutMs, _execFile }),
    processCwds(pids, { timeoutMs, _execFile }),
  ]);
  for (const pid of pids) {
    if (comm[pid] !== undefined) out[pid] = redactCommand(comm[pid], args[pid], cwds[pid] || null);
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
      const rotate = () => { if (over()) f.renameSync(this.file, `${this.file}.1`); };
      if (over()) {
        // Re-check under the lock: a peer relay may have rotated meanwhile.
        // A lock that cannot be opened at all (not contention) must not stop
        // rotation forever: rotate without it, as before the lock existed.
        if (this._lock(`${this.file}.lock`, rotate, { _fs: f }) === "error") {
          try { rotate(); } catch { /* the backstop below still bounds the file */ }
        }
      }
      // Hard backstop: if rotation keeps failing (a .1 that cannot be
      // replaced, a busy lock), stop appending at ~2x the cap.
      if (size() + line.length > 2 * this.maxBytes) return false;
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
