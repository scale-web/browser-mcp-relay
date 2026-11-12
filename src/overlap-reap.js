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
// (known-accounts matchSignInPage) or a secret field someone may be typing
// into — filled or empty — in any frame of any tab, open or closed shadow
// roots included (SECRET_FIELD_PROBE, closedRootSecret; review r1 M1/M2).
// A frame that cannot be read in time holds too. A page that fakes such a field only keeps its own
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
 * @returns {Promise<{ok: true, pids: number[]} | {ok: false, reason: string}>}
 *   never throws; ok:false means "unknown" — the caller must NOT reap early.
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
        const self = mains.find((p) => p.pid === ownPid) || mains.find((p) => isOwnDir(p.abs));
        const pids = mains
          .filter((p) => p.pid !== ownPid && !isOwnDir(p.abs))
          .filter((p) => roots.some((r) => p.abs.startsWith(r)))
          .filter((p) => !self || p.exe === self.exe)
          .map((p) => p.pid);
        finish({ ok: true, pids });
      });
  }, timeoutMs, { ok: false, reason: "ps-timeout" });
}

// Runs in each frame's main world (review r1 M1/M2/L1). True when the frame
// shows a field someone may be typing a secret into:
//   - a VISIBLE password input, or a visible code box (autocomplete
//     one-time-code; or a short text/tel/number input — maxlength 1..8 —
//     whose name / id / label / placeholder reads like a code, or that asks
//     for numeric entry: 2FA boxes often carry no autocomplete hint);
//   - an email-first sign-in step: a password input (visible or not) in the
//     same form / shadow root as a visible username or email input.
// Inputs inside OPEN shadow roots are walked; CLOSED roots are covered by
// closedRootSecret() over CDP. Visible = has layout boxes, a size above
// 1×1 px, and passes checkVisibility (opacity / visibility).
const SECRET_FIELD_PROBE = `(() => {
  const HINT = /otp|one.?time|passcode|2fa|mfa|totp|verif|security.?code|auth.?code|sms|pin(?![a-z])|(^|[^a-z])code/i;
  const inputs = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.tagName === "INPUT") inputs.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const visible = (el) => {
    if (el.getClientRects().length === 0) return false;
    if (typeof el.checkVisibility === "function" && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const attr = (el, n) => String(el.getAttribute(n) || "").toLowerCase();
  const isCode = (el, t) => {
    if (/(^|\\s)one-time-code(\\s|$)/.test(attr(el, "autocomplete"))) return true;
    const ml = Number(el.maxLength);
    if (!(ml >= 1 && ml <= 8) || !["text", "tel", "number", ""].includes(t)) return false;
    if (attr(el, "inputmode") === "numeric") return true;
    return HINT.test([el.name, el.id, el.getAttribute("aria-label"), el.placeholder].join(" "));
  };
  const isUser = (el, t) => t === "email" || /(^|\\s)(username|email)(\\s|$)/.test(attr(el, "autocomplete"));
  const passwordGroups = new Set();
  for (const el of inputs) if (String(el.type).toLowerCase() === "password") passwordGroups.add(el.form || el.getRootNode());
  for (const el of inputs) {
    const t = String(el.type || "").toLowerCase();
    if (!visible(el)) continue;
    if (t === "password" || isCode(el, t)) return true;
    if (isUser(el, t) && passwordGroups.has(el.form || el.getRootNode())) return true;
  }
  return false;
})()`;

const SECRET_TYPES = new Set(["password"]);
/** Over CDP (DOM.getDocument pierce): an <input> inside a CLOSED shadow root that is a password field or a
 *  one-time-code / short code box. Visibility cannot be judged there, so any such input holds (the safe way). */
function closedRootSecret(node, inClosed = false) {
  if (!node || typeof node !== "object") return false;
  if (inClosed && String(node.nodeName).toUpperCase() === "INPUT") {
    const a = {};
    const list = Array.isArray(node.attributes) ? node.attributes : [];
    for (let i = 0; i + 1 < list.length; i += 2) a[String(list[i]).toLowerCase()] = String(list[i + 1]).toLowerCase();
    const ml = Number(a.maxlength);
    if (SECRET_TYPES.has(a.type) || /(^|\s)one-time-code(\s|$)/.test(a.autocomplete || "")
      || (ml >= 1 && ml <= 8 && ["text", "tel", "number", undefined].includes(a.type))) return true;
  }
  for (const c of node.children || []) if (closedRootSecret(c, inClosed)) return true;
  for (const r of node.shadowRoots || []) if (closedRootSecret(r, inClosed || r.shadowRootType === "closed")) return true;
  if (node.contentDocument && closedRootSecret(node.contentDocument, inClosed)) return true;
  return false;
}

function hostOf(url) {
  try { return new URL(url).hostname || null; } catch { return null; }
}

/**
 * Must this Brave stay open through the overlap window because someone may be
 * signing in on it? Reads every frame of every tab of `context` (a Playwright
 * BrowserContext), plus each non-blank tab's closed shadow roots over CDP.
 * Never throws; anything it cannot read holds.
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
      const urls = [pageUrl, ...frames.map((f) => { try { return f.url(); } catch { return ""; } })];
      for (const u of urls) if (u && matchSignInPage(u)) return { hold: true, reason: "sign-in-page", host: hostOf(u) };
      if (BLANK_URLS.has(pageUrl) && frames.length <= 1) continue;
      for (const f of frames) {
        let has;
        try { has = await f.evaluate(SECRET_FIELD_PROBE); } catch { return unreadable(hostOf(pageUrl)); }
        if (has === true) return { hold: true, reason: "secret-field", host: hostOf(pageUrl) };
      }
      let session = null;
      try {
        session = await context.newCDPSession(page);
        const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
        if (closedRootSecret(root)) return { hold: true, reason: "secret-field", host: hostOf(pageUrl) };
      } catch { return unreadable(hostOf(pageUrl)); } finally {
        if (session) { try { await session.detach(); } catch { /* gone */ } }
      }
    }
    return { hold: false, reason: "none" };
  };
  return capped((finish) => { run().then(finish, () => finish(unreadable())); },
    Math.max(0, timeoutMs - 1000), unreadable());
}

module.exports = { otherRelayBraves, signInHold, userDataDirOf, executableOf, closedRootSecret, SECRET_FIELD_PROBE, BLANK_URLS };
