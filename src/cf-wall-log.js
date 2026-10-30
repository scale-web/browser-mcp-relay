// cf-wall-log.js — append one line to the shared CF-WALL log (spec v8 §2), the
// cross-lane count that gates phase 2. Format and frontmatter match the
// `cf-challenge` skill exactly:
//   YYYY-MM-DDTHH:MM:SSZ | <lane> | <host> | <owner> | <route taken>
//
// APPEND-ONLY: the file is opened with O_APPEND for every line and never read,
// truncated or rewritten. When missing, the skill's frontmatter is written to a
// temp file in the same folder and hard-linked into place (link fails with
// EEXIST if the log appeared meanwhile — then it is left alone). So the log is
// never visible without its whole header, and two relays racing to create it
// cannot both write one, nor slip a line in above it.
//
// Path: BROWSER_RELAY_CF_WALL_LOG overrides the vault default (tests set it, or
// pass `path`, so a test never touches the real log).

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_LOG = path.join(
  os.homedir(), "ObsidianVault", "[AGENCY] Automated Scaling", "Claude Important", "04 - Recon",
  "2026-10-29 Cloudflare Relay Challenge Recon", "00 - Summary", "CF-WALL Log.md",
);

function logPath(env = process.env) {
  const p = env.BROWSER_RELAY_CF_WALL_LOG;
  return typeof p === "string" && p.trim() !== "" ? p : DEFAULT_LOG;
}

/** `date -u '+%Y-%m-%dT%H:%M:%SZ'` */
function isoSeconds(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function header(now) {
  return [
    "---",
    "title: CF-WALL log",
    "type: log",
    "vendor: Cloudflare",
    "recon-job: 2026-10-29 Cloudflare Relay Challenge Recon",
    `captured: ${now.toISOString().slice(0, 10)}`,
    "tags: [recon, vendor/cloudflare, log]",
    "---",
    "",
    "> ⬅ Back to recon: [[../_README]]",
    "",
    "# CF-WALL log",
    "",
    "Append-only, one line per wall: `YYYY-MM-DDTHH:MM:SSZ | <lane> | <host> | <owner> | <route taken>`. `agency-test` lines are expected and not counted.",
    "",
  ].join("\n") + "\n";
}

/** A field may not break the line format: no `|`, no line breaks, no control chars. */
function field(s) {
  return String(s == null ? "" : s).replace(/[\x00-\x1f\x7f|]+/g, " ").trim();
}

function formatLine({ now, lane, host, owner, route }) {
  return `${isoSeconds(now)} | ${field(lane)} | ${field(host)} | ${field(owner)} | ${field(route)}\n`;
}

/** Header to a same-folder temp file, then link() into place; EEXIST = someone else won. */
function createWithHeader(p, now, fsImpl) {
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    // Inside the try: a write that fails half-way still has its temp removed (r2 #6).
    fsImpl.writeFileSync(tmp, header(now), { flag: "wx" });
    fsImpl.linkSync(tmp, p);
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
  } finally {
    try { fsImpl.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * "missing" | "present" | "dangling". lstat, not exists(): a log path that is
 * a symlink to a missing file reads as missing to exists(), and appending
 * through it would create the target with no header (review r2 #6). Such a
 * path is REFUSED — never created through, never appended to.
 */
function logState(p, fsImpl) {
  let st;
  try { st = fsImpl.lstatSync(p); } catch (e) { if (e && e.code === "ENOENT") return "missing"; throw e; }
  if (st.isSymbolicLink()) {
    try { fsImpl.statSync(p); } catch (e) { if (e && e.code === "ENOENT") return "dangling"; throw e; }
  }
  return "present";
}

/**
 * @returns {{ logged: true, path: string, line: string } | { logged: false, path: string, error: string }}
 */
function appendLine({ lane, host, owner, route, now = new Date(), path: p = logPath(), fsImpl = fs }) {
  const line = formatLine({ now, lane, host, owner, route });
  try {
    const state = logState(p, fsImpl);
    if (state === "dangling") {
      return { logged: false, path: p, error: "the log path is a symlink to a missing file — refused (a line there would have no header); fix or remove the link" };
    }
    if (state === "missing") createWithHeader(p, now, fsImpl);
    fsImpl.appendFileSync(p, line, { flag: "a" });
    return { logged: true, path: p, line: line.trimEnd() };
  } catch (e) {
    return { logged: false, path: p, error: e.message };
  }
}

module.exports = { appendLine, formatLine, header, logPath, isoSeconds, DEFAULT_LOG };
