// status-sidecar.js — what this relay is doing, readable by other relays and
// scripts (spec v4 §1c).
//
// `<profile dir>/.mcp-relay-status.json`, written tmp+rename, mode 0600:
//   { v, pid, ppid, sessionId, lane, lastToolCallAt, braveAlive, cdpPort,
//     bravePid, mode, conflict? }
// External consumers (gate 2: own-relay-port.mjs and friends) read cdpPort /
// bravePid here instead of guessing a port from the slot. Tool-call activity is
// written at most once a minute (an unref'd interval); Brave and mode changes
// are written immediately, because a consumer needs the new cdpPort right away.

const fs = require("node:fs");
const path = require("node:path");
const profileLock = require("./profile-lock.js");

const SIDECAR_NAME = ".mcp-relay-status.json";
const SIDECAR_VERSION = 1;

function writeSidecarFile(dir, data) {
  const p = path.join(dir, SIDECAR_NAME);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

function readSidecar(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, SIDECAR_NAME), "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

class StatusSidecar {
  /**
   * @param {{ dir: string, mode: string, intervalMs?: number, onTick?: () => void, _now?: () => number }} opts
   */
  constructor({ dir, mode, intervalMs = 60_000, onTick = null, _now = () => Date.now() }) {
    this.dir = dir;
    this.onTick = onTick;
    this._now = _now;
    this.intervalMs = intervalMs;
    this.lastWriteAt = 0;
    this.dirty = false;
    this.data = {
      v: SIDECAR_VERSION,
      pid: process.pid,
      ppid: process.ppid,
      sessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
      lane: null,
      lastToolCallAt: null,
      braveAlive: false,
      cdpPort: null,
      bravePid: null,
      mode,
    };
    this.timer = null;
  }

  /** Merge `partial`; write now if `force`, else at most once per interval. */
  update(partial, { force = false } = {}) {
    Object.assign(this.data, partial);
    this.dirty = true;
    if (force || this._now() - this.lastWriteAt >= this.intervalMs) this.flush();
  }

  flush() {
    if (!this.dirty) return;
    try {
      writeSidecarFile(this.dir, this.data);
      this.lastWriteAt = this._now();
      this.dirty = false;
    } catch (e) {
      process.stderr.write(`[mcp-relay] status sidecar write failed: ${e.message}\n`);
    }
  }

  start() {
    this.flush();
    this.timer = setInterval(() => {
      if (this.onTick) { try { this.onTick(); } catch { /* best-effort */ } }
      this.flush();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Remove the file at shutdown — only if it is still ours. */
  remove() {
    this.stop();
    const side = readSidecar(this.dir);
    if (side && side.pid === process.pid) {
      try { fs.unlinkSync(path.join(this.dir, SIDECAR_NAME)); } catch { /* gone */ }
    }
  }
}

/** Who holds `baseDir`, as far as its record and sidecar tell. */
function describeHolder(dir, opts = {}) {
  let rec;
  try { rec = profileLock.readRecord(dir, opts); } catch { rec = { kind: "unparseable" }; }
  if (rec.kind === "absent") return null;
  if (rec.kind !== "ok") return { format: "unreadable record" };
  const legacy = !(Number.isFinite(rec.meta.v) && rec.meta.v >= profileLock.RECORD_VERSION);
  const held = profileLock.recordHeld(rec, opts).held;
  const side = readSidecar(dir);
  const fresh = side && side.pid === rec.meta.pid ? side : null;
  return {
    pid: rec.meta.pid,
    alive: held,
    sessionId: rec.meta.sessionId || null,
    startedAt: rec.meta.startedAt || null,
    format: legacy ? "legacy (pre-change relay)" : "v2",
    lastToolCallAt: fresh ? fresh.lastToolCallAt : (legacy ? "unknown (pre-change relay)" : null),
    braveAlive: fresh ? fresh.braveAlive : null,
  };
}

const HOW_TO_GET_BASE =
  "The base profile (this project's saved logins) is held by another session. Logins made in this CLONE are deleted " +
  "when this session ends. To work in the base: finish (or close) the session that holds it, then reconnect this " +
  "relay (/mcp). Never sign in to client accounts here unless losing that login at session end is fine.";

/**
 * Build relay_status's payload. Reads only records and sidecars — never
 * launches Brave or claims anything.
 */
function buildRelayStatus({ self, dir, baseDir, mode, clonesRoot, cloneBelongsTo, metaGuard }) {
  const project = path.basename(baseDir || dir);
  const clones = [];
  let names = [];
  try { names = fs.readdirSync(clonesRoot); } catch { /* none yet */ }
  for (const name of names) {
    if (!cloneBelongsTo(name, project)) continue;
    const d = path.join(clonesRoot, name);
    const holder = describeHolder(d);
    clones.push({ name, self: d === dir, ownerPid: holder ? holder.pid : null, alive: holder ? holder.alive : false,
      lastToolCallAt: holder ? holder.lastToolCallAt : null, braveAlive: holder ? holder.braveAlive : null });
  }
  const out = {
    mode,
    profile: project,
    dir,
    pid: process.pid,
    sessionId: self.sessionId,
    braveAlive: self.braveAlive,
    cdpPort: self.cdpPort,
    bravePid: self.bravePid,
    metaGuard,
  };
  if (mode === "clone") {
    out.base = { dir: baseDir, holder: describeHolder(baseDir) };
    out.howToGetBase = HOW_TO_GET_BASE;
  }
  if (self.conflict) out.conflict = self.conflict;
  out.clonesInThisProject = clones;
  return out;
}

/** The leading text item announced on a mode change. */
function modeAnnouncement(mode, project) {
  if (mode === "base") {
    return `[browser-mcp-relay] Browser profile: BASE profile "${project}" — logins persist across sessions. Call relay_status for details.`;
  }
  if (mode === "clone") {
    return `[browser-mcp-relay] Browser profile: CLONE of "${project}" (another session holds the base) — logins made here are DELETED when this session ends. Call relay_status before any sign-in.`;
  }
  return `[browser-mcp-relay] Browser profile: TEMPORARY (temp-dir project) — nothing persists after this session. Call relay_status for details.`;
}

module.exports = {
  SIDECAR_NAME,
  SIDECAR_VERSION,
  StatusSidecar,
  readSidecar,
  describeHolder,
  buildRelayStatus,
  modeAnnouncement,
  HOW_TO_GET_BASE,
};
