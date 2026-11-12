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

// Runs in each frame's main world. Returns the KIND of field someone may be
// typing a secret into ("password" | "code" | "email-first"), or "" for none.
// Review r2 (MEDIUM-1 false holds vs MEDIUM-2 missed 2FA boxes): strong signals
// hold at any length, weak ones only on a short (maxlength 1..8) box that does
// not read like an ordinary field:
//   - password: a VISIBLE password input;
//   - code: autocomplete one-time-code; a name / id / aria-label / placeholder /
//     <label> text (camelCase split) with a strong word (otp, totp, mfa, 2fa,
//     2sv, one time, passcode, two factor, 2 step, verification, verify,
//     security / auth / authentication / sms / login / access code); a weak word
//     (code, token, pin) on a short box with no ordinary-field word (zip,
//     postal, country, currency, area, promo, discount, coupon, gift, voucher,
//     referral, invite, hex, color, product, sku); or a run of 4+ visible
//     maxlength=1 inputs under one parent (digit-per-box entry);
//   - email-first: a visible email / username input in the same <form> (or the
//     same shadow root) as any password input, visible or not.
// Open shadow roots are walked; CLOSED roots are covered by closedRootSecret()
// over CDP. Visible = layout boxes, > 1x1 px, checkVisibility (opacity /
// visibility), and not placed entirely off the top/left of the page (the
// left:-9999px anti-autofill trap).
const SECRET_FIELD_PROBE = `(() => {
  const STRONG = /(^| )(otp|totp|mfa|2fa|2sv|one ?time|passcode|two ?factor|2 ?step|verification|verify|(security|auth|authentication|sms|login|access|sign ?in) (code|pin))( |$)/;
  const WEAK = /(^| )(code|token|pin)( |$)/;
  const ORDINARY = /(^| )(zip|postal|post|country|currency|area|promo|promotion|discount|coupon|gift|voucher|referral|invite|invitation|hex|color|colour|product|sku|tracking|reference|ref)( |$)/;
  const words = (t) => String(t || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
    return r.width > 1 && r.height > 1 && r.right > 0 && r.bottom > 0;
  };
  const attr = (el, n) => String(el.getAttribute(n) || "").toLowerCase();
  const textOf = (el) => {
    const parts = [el.name, el.id, el.getAttribute("aria-label"), el.placeholder];
    try { for (const l of el.labels || []) parts.push(l.textContent); } catch (e) {}
    return words(parts.join(" "));
  };
  const TEXTY = ["text", "tel", "number", ""];
  const isCode = (el, t) => {
    if (/(^|\\s)one-time-code(\\s|$)/.test(attr(el, "autocomplete"))) return true;
    if (!TEXTY.includes(t)) return false;
    const w = textOf(el);
    if (STRONG.test(w)) return true;
    const ml = Number(el.maxLength);
    return ml >= 1 && ml <= 8 && WEAK.test(w) && !ORDINARY.test(w);
  };
  const groupOf = (el) => el.form || (el.getRootNode() !== document ? el.getRootNode() : null);
  const isUser = (el, t) => t === "email" || /(^|\\s)(username|email)(\\s|$)/.test(attr(el, "autocomplete"))
    || (TEXTY.includes(t) && /(^| )(email|e mail|username|user name|login)( |$)/.test(words([el.name, el.id].join(" "))));
  const passwordGroups = new Set();
  for (const el of inputs) if (String(el.type).toLowerCase() === "password") { const g = groupOf(el); if (g) passwordGroups.add(g); }
  const singleRuns = new Map();
  for (const el of inputs) {
    const t = String(el.type || "").toLowerCase();
    if (!visible(el)) continue;
    if (t === "password") return "password";
    if (isCode(el, t)) return "code";
    if (isUser(el, t) && passwordGroups.has(groupOf(el))) return "email-first";
    if (Number(el.maxLength) === 1 && TEXTY.includes(t)) {
      const k = el.parentElement && el.parentElement.parentElement ? el.parentElement.parentElement : el.parentNode;
      singleRuns.set(k, (singleRuns.get(k) || 0) + 1);
      if (singleRuns.get(k) >= 4) return "code";
    }
  }
  return "";
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

// Playwright's error for a frame that shares its parent's process (no CDP session of its own).
const SAME_PROCESS_FRAME = /separate CDP session|part of the parent frame/i;

/** Closed-root read of one target (a page, or an out-of-process frame) over its own CDP session.
 *  true / false; "same-process" for a frame without its own session; throws when unreadable. */
async function closedRootRead(context, target) {
  let session = null;
  try {
    try { session = await context.newCDPSession(target); } catch (e) {
      if (SAME_PROCESS_FRAME.test(String(e && e.message))) return "same-process";
      throw e;
    }
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    return closedRootSecret(root);
  } finally {
    if (session) { try { await session.detach(); } catch { /* gone */ } }
  }
}

/**
 * Must this Brave stay open through the overlap window because someone may be
 * signing in on it? Reads every frame of every tab of `context` (a Playwright
 * BrowserContext), plus each non-blank tab's — and each out-of-process frame's
 * — closed shadow roots over CDP. Never throws; anything it cannot read holds.
 * `closedCache` (a Map the caller clears on activity): the closed-root result
 * per target URL, so the full-DOM CDP read runs once per page per idle period
 * (review r2 LOW-2: 34 MB per tick on a 100k-node page).
 * @returns {Promise<{hold: boolean, reason: string, kind?: string, host?: string|null}>}
 *   reason: "sign-in-page" | "secret-field" | "unreadable" | "none"
 */
async function signInHold(context, { timeoutMs = 4000, closedCache = null } = {}) {
  const unreadable = (host = null) => ({ hold: true, reason: "unreadable", host });
  const secret = (kind, host) => ({ hold: true, reason: "secret-field", kind, host });
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
        if (has === true) return secret("password", host);
        if (typeof has === "string" && has) return secret(has, host);
      }
      // Closed shadow roots: the page target, then each child frame that has its own process.
      const targets = [[page, pageUrl], ...frames.slice(1).map((f) => [f, (() => { try { return f.url(); } catch { return ""; } })()])];
      for (const [target, url] of targets) {
        const key = target === page ? `page ${url}` : `frame ${url}`;
        if (closedCache && closedCache.has(key)) {
          if (closedCache.get(key)) return secret("closed-root", host);
          continue;
        }
        let r;
        try { r = await closedRootRead(context, target); } catch { return unreadable(host); }
        if (r === "same-process") continue;
        if (closedCache) closedCache.set(key, r);
        if (r) return secret("closed-root", host);
      }
    }
    return { hold: false, reason: "none" };
  };
  return capped((finish) => { run().then(finish, () => finish(unreadable())); },
    Math.max(0, timeoutMs - 1000), unreadable());
}

module.exports = { otherRelayBraves, signInHold, userDataDirOf, executableOf, closedRootSecret, SECRET_FIELD_PROBE, BLANK_URLS };
