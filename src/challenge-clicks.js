// challenge-clicks.js — the shared challenge_click count (spec v8 §5.6 (8),
// review r7 #8, r8 #4): ONE click per host per 10 min across EVERY plain-flags
// relay (base, clones, a second session, a restart). Not relay memory, which a
// clone or a restart resets.
//
// File: <profiles-plainflags>/.challenge-clicks.json  { "<host>": { "at": <ms>, "lane": "<lane>|null" } }
// Lock: <profiles-plainflags>/.challenge-clicks.flock — its OWN kernel lock,
// not the slot claim's .mcp-relay.flock (that one is held for a relay's whole
// life, O_EXLOCK|O_NONBLOCK, so a second claim on it always fails — r8 #4).
// Contention: a bounded retry (reap-hold.js withFileLock), then refuse.
// The file is written tmp + rename, so a reader never sees half a file.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { withFileLock } = require("./reap-hold.js");

const FILE_NAME = ".challenge-clicks.json";
const LOCK_NAME = ".challenge-clicks.flock";
const WINDOW_MS = 10 * 60 * 1000;

function normHost(h) {
  return String(h || "").toLowerCase().replace(/\.+$/, "");
}

/**
 * @param {object} o
 * @param {string} o.root   the profiles-plainflags root
 * @param {() => number} [o.now]
 * @param {number} [o.waitMs]  lock wait before refusing (bounded retry)
 */
function createClickCounter({ root, now = () => Date.now(), waitMs = 2000, _fs = fs } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("createClickCounter: absolute root required");
  const file = path.join(root, FILE_NAME);
  const lockPath = path.join(root, LOCK_NAME);

  function read() {
    let text;
    try { text = _fs.readFileSync(file, "utf8"); } catch (e) {
      if (e.code === "ENOENT") return { entries: {} };
      return { error: `${file}: ${e.message}` };
    }
    try {
      const v = JSON.parse(text);
      if (!v || typeof v !== "object" || Array.isArray(v)) return { error: `${file} is not an object` };
      return { entries: v };
    } catch (e) { return { error: `${file} does not parse: ${e.message}` }; }
  }

  function lastClick(entries, host) {
    const e = entries[normHost(host)];
    const at = e && Number(e.at);
    return Number.isFinite(at) && now() - at < WINDOW_MS && at <= now() + 5000 ? at : null;
  }

  /**
   * Spend the host's one click. { ok: true } — or { ok: false, reason, at? }:
   * a click on that host in the last 10 min, the lock still contended after
   * `waitMs`, or a count file that cannot be read (fail closed: refused).
   */
  function claim(host, lane = null) {
    const h = normHost(host);
    if (!h) return { ok: false, reason: "no host" };
    try { _fs.mkdirSync(root, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    let result = { ok: false, reason: "count file could not be read or written — refused" };
    const ran = withFileLock(lockPath, () => {
      const r = read();
      if (r.error) { result = { ok: false, reason: `count file unreadable (${r.error}) — refused; remove the file to reset` }; return; }
      const entries = r.entries;
      const prev = lastClick(entries, h);
      if (prev !== null) { result = { ok: false, reason: "already clicked on this host in the last 10 min", at: prev }; return; }
      for (const [k, v] of Object.entries(entries)) if (!(v && now() - Number(v.at) < WINDOW_MS)) delete entries[k];
      entries[h] = { at: now(), lane: typeof lane === "string" ? lane.slice(0, 80) : null };
      const tmp = `${file}.${process.pid}.tmp`;
      _fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
      _fs.renameSync(tmp, file);
      result = { ok: true, at: entries[h].at };
    }, { waitMs, _fs });
    if (ran === "busy") return { ok: false, reason: `count file lock busy after ${waitMs} ms — refused` };
    if (ran === "error") return { ok: false, reason: `count file lock ${lockPath} cannot be opened — refused` };
    return result;
  }

  /** A click was spent on `host` in the last 10 min (or the file is unreadable: fail closed). */
  function spent(host) {
    const r = read();
    if (r.error) return true;
    return lastClick(r.entries, host) !== null;
  }

  /** 0 or 1 — the clicks on `host` in the last 10 min (the outcome line's count). */
  function count(host) {
    const r = read();
    if (r.error) return 0;
    return lastClick(r.entries, host) !== null ? 1 : 0;
  }

  return { claim, spent, count, file, lockPath };
}

module.exports = { createClickCounter, FILE_NAME, LOCK_NAME, WINDOW_MS };
