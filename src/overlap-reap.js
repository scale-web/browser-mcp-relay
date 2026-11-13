// overlap-reap.js — the two checks behind the idle reaper's SHORTER window
// while another relay Brave is open (BROWSER_RELAY_OVERLAP_IDLE_MINUTES,
// default 10; ask as-ops/ask-fr3yfn rev 5 "Shorter idle close + tell
// CFC-GHL", design amended by Trevor in ask as-ops/ask-ocrmvy rev 2).
//
// Why: macOS replayd keeps ONE connection per app bundle id. Two or more
// Braves with their own --user-data-dir running at once evict each other's
// connection in a loop — replayd measured at 115–119% CPU with 3 idle relay
// Braves (2026-11-12). One relay Brave alone (next to Trevor's own Brave)
// does not loop. So an idle relay Brave closes sooner only while ANOTHER
// relay Brave is alive.
//
// What must never be closed early: a window someone is using by hand — above
// all a sign-in in progress (a flat 10-minute close was tried and reverted for
// exactly that). Guessing secret fields from page markup did not converge (two
// review rounds traded false holds for missed 2FA boxes), so Trevor ruled a
// PRESENCE hold (ask as-ops/ask-b7xcc7 rev 2, "Hold while you're using it"):
//   1. this relay's Brave was the FRONTMOST process at any sample in the last
//      overlap window (frontmostPid(): `lsappinfo front` + `info -only pid`,
//      `lsappinfo list` only as a fallback; sampled by the caller);
//   2. a known account's sign-in page is open (known-accounts matchSignInPage);
//   3. an unambiguous secret field is on a tab: an <input type=password>, or an
//      input whose autocomplete says current-password / new-password /
//      one-time-code (open shadow roots walked; any input with layout boxes).
// Anything that cannot be determined holds.
//
// Every other hold of the full reaper (keep-alive file within the FULL idle
// window, external CDP clients, in-flight calls) is applied by the caller.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { matchSignInPage } = require("./known-accounts.js");

const BLANK_URLS = new Set(["", "about:blank", "chrome://newtab/", "brave://newtab/", "chrome://new-tab-page/"]);

/** Resolve with what `run` passes to finish, or `fallback` after timeoutMs + 1 s
 *  (a child stuck in uninterruptible sleep never calls back). Never rejects. */
function capped(run, timeoutMs, fallback) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(cap); resolve(v); };
    const cap = setTimeout(() => finish(fallback), timeoutMs + 1000);
    if (typeof cap.unref === "function") cap.unref();
    try { run(finish); } catch { finish(fallback); }
  });
}

function realOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** The --user-data-dir value in a ps args line (up to the next " --" flag), or null. */
function userDataDirOf(args) {
  const m = /(?:^|\s)--user-data-dir=(.*?)(?=\s--|$)/.exec(args);
  return m ? m[1].trim() : null;
}

/** The executable part of a ps args line: everything before the first " --" flag. */
function executableOf(args) {
  const i = args.search(/\s--/);
  return (i === -1 ? args : args.slice(0, i)).trim();
}

/**
 * Relay browser MAIN processes other than this relay's own, from one
 * `ps -axww -o pid=,args=`: no `--type=` (renderers, GPU and helpers carry
 * one), a --user-data-dir under the relay cache root (profiles,
 * session-clones and the plain-flags dirs all live there), and — when this
 * relay's own Brave is in the listing (by `ownPid` or `ownDir`) — the SAME
 * executable as it: replayd's loop is per app bundle id, so a Brave Beta, a
 * Chrome for Testing or a script's Chromium on a dir under the cache root is
 * not counted (review r1 L3). Excludes `ownPid` and any process using `ownDir`.
 * @returns {Promise<{ok: true, pids: number[], selfPid: number|null} | {ok: false, reason: string}>}
 *   never throws; ok:false means "unknown" — the caller must NOT reap early.
 *   selfPid: this relay's own Brave main process (by ownPid or ownDir), null if not listed.
 */
function otherRelayBraves({ cacheRoot, ownDir, ownPid, timeoutMs = 2000, _execFile = execFile } = {}) {
  if (!cacheRoot) return Promise.resolve({ ok: false, reason: "no-cache-root" });
  const roots = [...new Set([path.resolve(cacheRoot), realOrSelf(cacheRoot)])].map((r) => r + path.sep);
  const own = ownDir ? new Set([path.resolve(ownDir), realOrSelf(ownDir)]) : new Set();
  const isOwnDir = (abs) => own.has(abs) || own.has(realOrSelf(abs));
  return capped((finish) => {
    _execFile("/bin/ps", ["-axww", "-o", "pid=,args="],
      { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return finish({ ok: false, reason: `ps: ${err.code || err.message}` });
        const mains = [];
        for (const line of String(stdout || "").split("\n")) {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!m) continue;
          const args = m[2];
          if (/(?:^|\s)--type=/.test(args)) continue;
          const udd = userDataDirOf(args);
          if (!udd) continue;
          mains.push({ pid: Number(m[1]), exe: executableOf(args), abs: path.resolve(udd) });
        }
        const self = mains.find((p) => p.pid === ownPid) || mains.find((p) => isOwnDir(p.abs)) || null;
        const pids = mains
          .filter((p) => p.pid !== ownPid && !isOwnDir(p.abs))
          .filter((p) => roots.some((r) => p.abs.startsWith(r)))
          .filter((p) => !self || p.exe === self.exe)
          .map((p) => p.pid);
        finish({ ok: true, pids, selfPid: self ? self.pid : null });
      });
  }, timeoutMs, { ok: false, reason: "ps-timeout" });
}

/**
 * The frontmost process's pid (macOS). Primary: `lsappinfo front` (prints e.g.
 * `ASN:0x0-12012:`) then `lsappinfo info -only pid "ASN:0x0-0x12012:"` (prints
 * `"pid"=876`) — the low half needs its `0x` prefix or `info` prints nothing
 * (measured 2026-11-12; ~26 ms wall for both). Fallback when that yields no pid:
 * `lsappinfo list`, the entry marked "(in front)", its `pid = N` line searched up
 * to the next entry header (real entries carry bundleID / bundle path /
 * executable path lines before it; review of 69fda6a: a fixed 3-line window
 * found no pid on real output, so every sample was "unknown").
 * @returns {Promise<{ok: true, pid: number} | {ok: false, reason: string}>} never throws.
 */
const LSAPPINFO = "/usr/bin/lsappinfo";
function lsappinfoRun(args, { timeoutMs, _execFile }) {
  return capped((finish) => {
    _execFile(LSAPPINFO, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => finish(err ? { ok: false, reason: `lsappinfo: ${err.code || err.message}` } : { ok: true, out: String(stdout || "") }));
  }, timeoutMs, { ok: false, reason: "lsappinfo-timeout" });
}
/** The "(in front)" entry's pid in `lsappinfo list` output, or null. */
function frontPidFromList(out) {
  const lines = String(out).split("\n");
  const i = lines.findIndex((l) => /^\s*\d+\) ".*\(in front\)/.test(l));
  if (i === -1) return null;
  for (let j = i + 1; j < lines.length && !/^\s*\d+\) "/.test(lines[j]); j++) {
    const m = /^\s*pid = (\d+)\b/.exec(lines[j]);
    if (m) return Number(m[1]);
  }
  return null;
}
async function frontmostPid({ timeoutMs = 2000, _execFile = execFile } = {}) {
  const front = await lsappinfoRun(["front"], { timeoutMs, _execFile });
  const asn = front.ok ? /ASN:(0x[0-9a-fA-F]+)-(?:0x)?([0-9a-fA-F]+):?/.exec(front.out) : null;
  if (asn) {
    const info = await lsappinfoRun(["info", "-only", "pid", `ASN:${asn[1]}-0x${asn[2]}:`], { timeoutMs, _execFile });
    const m = info.ok ? /"pid"\s*=\s*(\d+)/.exec(info.out) : null;
    if (m) return { ok: true, pid: Number(m[1]) };
  }
  const list = await lsappinfoRun(["list"], { timeoutMs, _execFile });
  if (!list.ok) return list;
  const pid = frontPidFromList(list.out);
  return pid ? { ok: true, pid } : { ok: false, reason: "lsappinfo: no front app pid" };
}

/**
 * The presence verdict from frontmost samples ({t, pid}, pid null = unknown), for
 * the window [now - windowMs, now] sampled every intervalMs, against this relay's
 * own Brave pid `self`:
 *   "unknown"   — no own pid, the samples do not cover the window (first one later
 *                 than two intervals after its start), or a sample in it failed;
 *   "frontmost" — this Brave was in front at a sample in the window;
 *   "away"      — covered, every sample known, never in front.
 */
function presenceVerdict(samples, { now, windowMs, intervalMs, self }) {
  if (!self) return { verdict: "unknown", detail: "own Brave pid unknown" };
  const since = now - windowMs;
  const win = samples.filter((x) => x.t >= since - intervalMs && x.t <= now);
  if (win.length === 0 || win[0].t > since + 2 * intervalMs) return { verdict: "unknown", detail: "samples do not cover the window" };
  const failed = win.find((x) => x.pid === null);
  if (failed) return { verdict: "unknown", detail: failed.reason || "a sample failed" };
  return win.some((x) => x.pid === self) ? { verdict: "frontmost" } : { verdict: "away" };
}

// Runs in each frame's main world: true when an UNAMBIGUOUS secret field is
// on the page — <input type=password>, or autocomplete current-password /
// new-password / one-time-code (so a password shown with an "eye" toggle,
// which turns it into type=text, still counts when the site marks it) — in
// the document or any OPEN shadow root, with layout boxes (display:none and
// detached inputs do not count; an opacity:0 code overlay does).
const SECRET_FIELD_PROBE = `(() => {
  const AC = /(^|\\s)(current-password|new-password|one-time-code)(\\s|$)/;
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.tagName === "INPUT") {
        const t = String(el.type || "").toLowerCase();
        const ac = String(el.getAttribute("autocomplete") || "").toLowerCase();
        if ((t === "password" || AC.test(ac)) && el.getClientRects().length > 0) return true;
      }
      if (el.shadowRoot && walk(el.shadowRoot)) return true;
    }
    return false;
  };
  return walk(document);
})()`;

function hostOf(url) {
  try { return new URL(url).hostname || null; } catch { return null; }
}

/**
 * Must this Brave stay open through the overlap window because of what its
 * tabs show? A known sign-in page, or an unambiguous secret field in any frame
 * (SECRET_FIELD_PROBE). Never throws; a frame that cannot be read holds.
 * (The presence hold — frontmost — is the caller's.)
 * @returns {Promise<{hold: boolean, reason: string, host?: string|null}>}
 *   reason: "sign-in-page" | "secret-field" | "unreadable" | "none"
 */
async function signInHold(context, { timeoutMs = 4000 } = {}) {
  const unreadable = (host = null) => ({ hold: true, reason: "unreadable", host });
  const run = async () => {
    let pages;
    try { pages = context.pages(); } catch { return unreadable(); }
    for (const page of pages) {
      let frames;
      try { frames = typeof page.frames === "function" ? page.frames() : []; } catch { return unreadable(); }
      let pageUrl = "";
      try { pageUrl = page.url(); } catch { return unreadable(); }
      const host = hostOf(pageUrl);
      const urls = [pageUrl, ...frames.map((f) => { try { return f.url(); } catch { return ""; } })];
      for (const u of urls) if (u && matchSignInPage(u)) return { hold: true, reason: "sign-in-page", host: hostOf(u) };
      if (BLANK_URLS.has(pageUrl) && frames.length <= 1) continue;
      for (const f of frames) {
        let has;
        try { has = await f.evaluate(SECRET_FIELD_PROBE); } catch { return unreadable(host); }
        if (has === true) return { hold: true, reason: "secret-field", host };
      }
    }
    return { hold: false, reason: "none" };
  };
  return capped((finish) => { run().then(finish, () => finish(unreadable())); },
    Math.max(0, timeoutMs - 1000), unreadable());
}

module.exports = { otherRelayBraves, frontmostPid, frontPidFromList, presenceVerdict, signInHold, userDataDirOf, executableOf, SECRET_FIELD_PROBE, BLANK_URLS };
