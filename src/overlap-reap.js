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
// What must never be closed early: a page someone is signing in on by hand
// (a flat 10-minute close was tried and reverted for exactly that). The
// first design kept any window whose pages were not all blank; measured
// 2026-11-12 3:45 PM MT that would have closed 1 of 3 idle Braves and left
// the loop running, so Trevor ruled the narrower hold: a known sign-in page
// (known-accounts matchSignInPage) or a VISIBLE password / one-time-code
// field — filled or empty — in any frame of any tab. A frame that cannot be
// read in time holds too. A page that fakes such a field only keeps its own
// window open, which is the pre-overlap behaviour, so the main-world read is
// enough here (unlike the secret lock, which must not be fooled the other way).
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

/**
 * Relay browser MAIN processes other than this relay's own, from one
 * `ps -axww -o pid=,args=`: no `--type=` (renderers, GPU and helpers carry
 * one) and a --user-data-dir under the relay cache root (profiles,
 * session-clones and the plain-flags dirs all live there). Excludes `ownPid`
 * and any process using `ownDir`.
 * @returns {Promise<{ok: true, pids: number[]} | {ok: false, reason: string}>}
 *   never throws; ok:false means "unknown" — the caller must NOT reap early.
 */
function otherRelayBraves({ cacheRoot, ownDir, ownPid, timeoutMs = 2000, _execFile = execFile } = {}) {
  if (!cacheRoot) return Promise.resolve({ ok: false, reason: "no-cache-root" });
  const roots = [...new Set([path.resolve(cacheRoot), realOrSelf(cacheRoot)])].map((r) => r + path.sep);
  const own = ownDir ? new Set([path.resolve(ownDir), realOrSelf(ownDir)]) : new Set();
  return capped((finish) => {
    _execFile("/bin/ps", ["-axww", "-o", "pid=,args="],
      { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return finish({ ok: false, reason: `ps: ${err.code || err.message}` });
        const pids = [];
        for (const line of String(stdout || "").split("\n")) {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!m) continue;
          const pid = Number(m[1]);
          const args = m[2];
          if (pid === ownPid || /(?:^|\s)--type=/.test(args)) continue;
          const udd = userDataDirOf(args);
          if (!udd) continue;
          const abs = path.resolve(udd);
          if (own.has(abs) || own.has(realOrSelf(abs))) continue;
          if (roots.some((r) => abs.startsWith(r))) pids.push(pid);
        }
        finish({ ok: true, pids });
      });
  }, timeoutMs, { ok: false, reason: "ps-timeout" });
}

// Runs in each frame's main world. True when a VISIBLE (has layout boxes)
// password or one-time-code input exists, whatever its value.
const SECRET_FIELD_PROBE = `(() => {
  for (const el of document.querySelectorAll("input")) {
    const t = String(el.type || "").toLowerCase();
    const ac = String(el.getAttribute("autocomplete") || "").toLowerCase();
    if ((t === "password" || /(^|\\s)one-time-code(\\s|$)/.test(ac)) && el.getClientRects().length > 0) return true;
  }
  return false;
})()`;

function hostOf(url) {
  try { return new URL(url).hostname || null; } catch { return null; }
}

/**
 * Must this Brave stay open through the overlap window because someone may be
 * signing in on it? Reads every frame of every tab of `context` (a Playwright
 * BrowserContext). Never throws.
 * @returns {Promise<{hold: boolean, reason: string, host?: string|null}>}
 *   reason: "sign-in-page" | "secret-field" | "unreadable" | "none"
 */
async function signInHold(context, { timeoutMs = 4000 } = {}) {
  const run = async () => {
    let pages;
    try { pages = context.pages(); } catch { return { hold: true, reason: "unreadable", host: null }; }
    for (const page of pages) {
      let frames;
      try { frames = typeof page.frames === "function" ? page.frames() : []; } catch { return { hold: true, reason: "unreadable", host: null }; }
      let pageUrl = "";
      try { pageUrl = page.url(); } catch { return { hold: true, reason: "unreadable", host: null }; }
      const urls = [pageUrl, ...frames.map((f) => { try { return f.url(); } catch { return ""; } })];
      for (const u of urls) if (u && matchSignInPage(u)) return { hold: true, reason: "sign-in-page", host: hostOf(u) };
      if (BLANK_URLS.has(pageUrl) && frames.length <= 1) continue;
      for (const f of frames) {
        let has;
        try { has = await f.evaluate(SECRET_FIELD_PROBE); } catch { return { hold: true, reason: "unreadable", host: hostOf(pageUrl) }; }
        if (has === true) return { hold: true, reason: "secret-field", host: hostOf(pageUrl) };
      }
    }
    return { hold: false, reason: "none" };
  };
  return capped((finish) => { run().then(finish, () => finish({ hold: true, reason: "unreadable", host: null })); },
    Math.max(0, timeoutMs - 1000), { hold: true, reason: "unreadable", host: null });
}

module.exports = { otherRelayBraves, signInHold, userDataDirOf, SECRET_FIELD_PROBE, BLANK_URLS };
