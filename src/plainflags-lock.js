// plainflags-lock.js — the plain-flags relay's LOCK (review round 3 A; Trevor's
// ruling as-ops/ask-u5qaev, "Lock while secret on page"; refined in round 4,
// as-ops/ask-ht5fsa). Default-deny keyed on the secret: the primary protection
// of this profile, with the per-tool filters kept as a second layer.
//
// Before EVERY tool call but `relay_status` and `tabs_list` (and again after it,
// before its result leaves), one probe reads every tab of this Brave — every
// frame of each tab's frame tree, open shadow roots included — and the browser
// is LOCKED while any of these holds:
//   1. a SECRET TEXT-ENTRY field holds a value. Text-entry = <textarea>, or an
//      <input> whose type is text / password / email / tel / number / search /
//      url (or none). A checkbox, radio, hidden, submit, button, image, reset,
//      file, range or color input is never a secret: its `.value` is a fixed
//      string ("on", a method name), not something typed (round 4 M1).
//      Secret = type=password; autocomplete current-password / new-password /
//      one-time-code; a name or id matching /pass|pwd|otp|passcode/i; a computed
//      -webkit-text-security other than none; or one box of a SPLIT one-time
//      code — ≥4 inputs under one container with maxlength ≤ 2 and a numeric
//      inputmode / digit pattern / tel-number type, or an input right next to a
//      one-time-code input (round 4 L6). Contenteditable is not probed: it has
//      no value, and what it holds is page text, which the console / page-text
//      skill rules cover.
//   2. a tab's URL is a known account's SIGN-IN PAGE — a path-scoped matcher or
//      a dedicated sign-in host (src/known-accounts.js matchSignInPage), listed
//      or not. An APP host (app.gohighlevel.com's dashboard, admin.shopify.com,
//      dash.cloudflare.com, hpanel.hostinger.com) does not lock by URL — rule 1
//      covers its sign-in form (round 4 M2).
//   3. FAIL CLOSED, PER TAB (round 4 M3): a frame of a tab could not be read
//      (an error, a 2.5 s timeout) while a secret field was seen on THAT tab —
//      now, or on the last probe of the same page — or while one of that tab's
//      frames is on a sign-in page. A tab's memory is dropped when it navigates
//      (its URL changes) or closes.
//
// HOW IT READS (round 4 M4): in an ISOLATED WORLD of each frame (CDP
// Page.createIsolatedWorld + Runtime.evaluate on the frame's own target
// session; out-of-process frames through their own session), never the page's
// main world — page code cannot see the probe (its querySelectorAll / getter
// wrappers are not called) and cannot lie to it (a page-world override of
// HTMLInputElement.value does not reach the isolated world). Frames on
// challenges.cloudflare.com are never read at all (counted readable, no
// secret), like challenge_detect.
//
// Every tab, not the selected one, because upstream's tools act on the tab it
// pinned and a sign-in can run in a popup — so tabs_select / tabs_new /
// tabs_close are not exempt. The probe returns COUNTS only, never a value.
//
// Residuals (REFERENCE "The plain-flags relay"): a secret field in a CLOSED
// shadow root; a code in a plain text field the page never marks; console
// messages and page text; an app host's sign-in form is covered only once a
// value is typed (an empty form on an app host does not lock — nothing to leak
// yet). ACCIDENT GUARD, not a boundary — any local process can drive this Brave
// over its debugging port.

"use strict";

const { KNOWN_ACCOUNTS, matchSignInPage } = require("./known-accounts.js");

const EXEMPT = Object.freeze(["relay_status", "tabs_list"]);
const LOCK_TEXT =
  "Locked: a password or one-time code is on this page (Trevor may be signing in). Tools resume when the field is empty or the tab leaves the sign-in page.";
const FRAME_TIMEOUT_MS = 2500;
const CHALLENGE_HOST = "challenges.cloudflare.com";
const WORLD_NAME = "__browser_mcp_relay_lock__";

/** Runs in each frame's ISOLATED world. COUNTS only — a value never leaves the page. */
const secretProbe = () => {
  "use strict";
  // Round 5 item 2: an element once seen as secret stays secret for the life
  // of this world (= this document) — a show-password toggle turns
  // type=password into type=text with nothing else to recognise it by.
  const mem = globalThis.__relayLockSeen || (globalThis.__relayLockSeen = new WeakSet());
  // Names are split into WORDS (snake, kebab, camelCase): "footprint" is not
  // "otp", "barcode" is not "code" (review round 6 item 3).
  // Round 7 item 2: acronym boundaries first ("OTPCode" → OTP Code), and "Two FA" / "2 FA" → "2fa".
  const words = (s) => {
    const w = String(s || "").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for (let i = w.length - 2; i >= 0; i--) if ((w[i] === "two" || w[i] === "2") && w[i + 1] === "fa") w.splice(i, 2, "2fa");
    return w;
  };
  const AC = ["current-password", "new-password", "one-time-code"];
  const TEXT_TYPES = ["", "text", "password", "email", "tel", "number", "search", "url"];
  const PASS_RE = /pass|pwd/i; // "password", "passcode", "passwd", "pwd" (substring, fail closed)
  const STRONG = (w) => w === "mfa" || w === "2fa" || w === "totp" || w === "otp" || w === "passcode" || w.startsWith("verif");
  const CODE_WORD = (w) => w === "code" || /^(sms|auth|login|access|security|email|onetime|confirm|confirmation|signin)code$/.test(w);
  const BOOST = ["sms", "auth", "2step", "twostep", "factor", "login", "signin", "security", "onetime"];
  const EXCLUDE = ["zip", "postal", "postcode", "promo", "coupon", "discount", "referral", "referrer", "voucher", "gift", "country",
    "area", "phone", "dial", "currency", "state", "lang", "language", "product", "sku", "item", "color", "colour", "region", "province"];
  /** Round 5 item 4, refined round 6 item 3: a single 2FA / verification code field. */
  const codeField = (el, nm, id, im, ml) => {
    const ws = [...words(nm), ...words(id)];
    const numeric = im === "numeric" || im === "decimal";
    const short = ml >= 1 && ml <= 8;
    if (ws.some(STRONG) && (numeric || short)) return true;
    if (ws.includes("pin") && numeric) return true;
    if (!ws.some(CODE_WORD)) return false;
    if (ws.some((w) => BOOST.includes(w)) && (numeric || short)) return true; // "sms_code_phone"
    // the bare word "code": exclusions apply, and maxlength ≥ 4 is required
    if (ws.some((w) => EXCLUDE.includes(w))) return false;
    return ml >= 4 && (numeric || ml <= 8);
  };
  const inputs = [];
  const visit = (root, depth) => {
    if (!root || depth > 30) return;
    let els = [];
    try { els = root.querySelectorAll("input, textarea"); } catch { /* not a container */ }
    for (const el of els) {
      if (el.tagName === "INPUT" && !TEXT_TYPES.includes(String(el.type || "").toLowerCase())) continue;
      inputs.push(el);
    }
    let all = [];
    try { all = root.querySelectorAll("*"); } catch { /* none */ }
    for (const e of all) if (e.shadowRoot) visit(e.shadowRoot, depth + 1);
  };
  visit(document, 0);
  const secret = new Set();
  const isOtpBox = (el) => {
    const ml = Number(el.maxLength);
    if (!(ml >= 1 && ml <= 2)) return false;
    const im = String(el.getAttribute("inputmode") || "").toLowerCase();
    const pat = String(el.getAttribute("pattern") || "");
    const t = String(el.type || "").toLowerCase();
    return im === "numeric" || im === "decimal" || /\d|0-9/.test(pat) || t === "number" || t === "tel";
  };
  const groups = new Map();
  for (const el of inputs) {
    const type = String(el.getAttribute("type") || "").toLowerCase();
    const prop = String(el.type || "").toLowerCase();
    const ac = String(el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    let ts = "";
    try {
      const cs = getComputedStyle(el);
      ts = String(cs.webkitTextSecurity || cs.getPropertyValue("-webkit-text-security") || "").toLowerCase();
    } catch { /* detached */ }
    const nm = String(el.getAttribute("name") || "");
    const id = String(el.getAttribute("id") || "");
    const im = String(el.getAttribute("inputmode") || "").toLowerCase();
    const ml = Number(el.maxLength);
    if (mem.has(el) || type === "password" || prop === "password" || AC.some((t) => ac.includes(t)) ||
      PASS_RE.test(nm) || PASS_RE.test(id) || [...words(nm), ...words(id)].includes("otp") || (ts !== "" && ts !== "none") || codeField(el, nm, id, im, ml)) {
      secret.add(el);
    }
    if (ac.includes("one-time-code")) {
      for (const sib of [el.previousElementSibling, el.nextElementSibling]) if (sib && inputs.includes(sib)) secret.add(sib);
    }
    if (isOtpBox(el)) {
      for (const c of [el.parentElement, el.parentElement && el.parentElement.parentElement]) {
        if (!c) continue;
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c).push(el);
      }
    }
  }
  for (const members of groups.values()) if (members.length >= 4) for (const m of members) secret.add(m);
  for (const el of secret) mem.add(el);
  let filled = 0;
  for (const el of secret) if (String(el.value || "").length > 0) filled++;
  return { seen: secret.size, filled };
};

function withTimeout(p, ms, what = "frame probe") {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); })]).finally(() => clearTimeout(t));
}

function hostOf(u) {
  try { return new URL(String(u)).hostname.toLowerCase().replace(/\.+$/, ""); } catch { return null; }
}

/** The relay could not obtain (twice) a verified id for its own isolated world in a frame → fail closed on that tab. */
class StaleWorldError extends Error {}

/**
 * The production reader: per tab, every frame read in the relay's own
 * ISOLATED world over CDP. { tabs: [{ key, url, frames: [{ url, result: {seen, filled} | null, stale? }] }] }
 *
 * Review round 7, rule 0: NOTHING is cached between probes. Every probe opens
 * its own CDP sessions (one per tab and per out-of-process frame), so whether
 * a frame is in-process or out-of-process, which target it lives in, and which
 * context is the relay's world are all decided afresh from what that probe's
 * sessions report — and every session is detached when the probe ends. (Round
 * 6 cached "in-process" per Playwright Frame; Playwright keeps the SAME Frame
 * object when an iframe moves into its own process, so that frame stayed
 * unread for good — round 7 item 1.) The relay's named world itself is not a
 * relay-side cache: it lives in the page, one per document, and a new session
 * sees it on Runtime.enable (measured, Brave 156) — which is how the probe's
 * show-password memory survives from one probe to the next.
 *
 * Round 6 item 1: the world is addressed by its `uniqueContextId` (assigned
 * once, never reused), not by the numeric execution-context id, which Chrome
 * reuses after a cross-process navigation. The unique id comes from the
 * `Runtime.executionContextCreated` events of THIS probe's session: the live
 * context with the numeric id `Page.createIsolatedWorld` returned, in that
 * frame, with the relay's world name, type "isolated". No match → once more →
 * a second failure fails closed on the tab. No stamp, no numeric fallback.
 * Every evaluated function runs in strict mode.
 */
function createCdpReader({ frameTimeoutMs = FRAME_TIMEOUT_MS } = {}) {
  const expression = `(() => { "use strict"; return (${secretProbe.toString()})(); })()`;
  const IN_PROCESS = /does not have a separate CDP session/i;

  /** A NEW session for this probe (never one from an earlier probe). */
  async function sessionFor(ctx, target, opened) {
    try {
      const session = await ctx.newCDPSession(target);
      opened.push(session);
      return { session };
    } catch (e) {
      // An in-process frame has no session of its own (its parent's tree covers
      // it); any OTHER failure leaves the frame unread (round 6 item 5).
      return IN_PROCESS.test(String((e && e.message) || e)) ? { inProcess: true } : { failed: true };
    }
  }

  /** Runtime events on this probe's session: which relay world has which unique id. */
  async function runtimeFor(session) {
    // `live`: the relay-named isolated worlds that exist NOW in this session's
    // target, by numeric id. Runtime.enable replays every existing context, so
    // a world made by an earlier probe's session is announced here too; Chrome
    // also re-creates a named world by itself in each new document, and
    // Page.createIsolatedWorld then returns that existing id with no new event
    // — so the id is looked up here, not awaited as a fresh event. A process
    // change clears the map (executionContextsCleared) before the new
    // process's contexts are announced.
    const live = new Map();
    session.on("Runtime.executionContextCreated", ({ context }) => {
      if (!context || context.name !== WORLD_NAME) return;
      live.set(context.id, { uniqueId: context.uniqueId, frameId: context.auxData && context.auxData.frameId, type: context.auxData && context.auxData.type });
    });
    session.on("Runtime.executionContextDestroyed", (p) => {
      const u = p && p.executionContextUniqueId;
      for (const [id, c] of live) if ((u && c.uniqueId === u) || (!u && id === p.executionContextId)) live.delete(id);
    });
    session.on("Runtime.executionContextsCleared", () => live.clear());
    await session.send("Runtime.enable");
    return live;
  }

  async function worldId(session, live, frameId) {
    const { executionContextId: id } = await session.send("Page.createIsolatedWorld", { frameId, worldName: WORLD_NAME, grantUniveralAccess: false });
    // Two attempts must fit inside the frame's own timeout, so that a world that
    // cannot be identified twice FAILS CLOSED instead of timing out as merely unreadable.
    const deadline = Date.now() + Math.min(1000, Math.floor(frameTimeoutMs / 3));
    for (;;) {
      const ev = live.get(id);
      if (ev && ev.frameId === frameId && ev.type === "isolated" && typeof ev.uniqueId === "string" && ev.uniqueId) return ev.uniqueId;
      if (Date.now() >= deadline) throw new StaleWorldError("no executionContextCreated event identified the relay's isolated world");
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  async function evalIn(session, live, frameId) {
    let lastErr = null;
    let unverified = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const uid = await worldId(session, live, frameId);
        const r = await session.send("Runtime.evaluate", { expression, uniqueContextId: uid, returnByValue: true, awaitPromise: false });
        if (r && !r.exceptionDetails && r.result && r.result.value && typeof r.result.value === "object") return r.result.value;
        lastErr = new Error("the probe returned no counts");
      } catch (e) {
        if (e instanceof StaleWorldError) unverified++;
        lastErr = e; // a world that died with its document, or an unknown unique id
      }
    }
    if (unverified >= 2) throw new StaleWorldError("the relay's isolated world could not be identified twice");
    throw lastErr || new Error("probe failed in the isolated world");
  }

  function flatten(tree, out = []) {
    if (!tree || !tree.frame) return out;
    out.push({ id: tree.frame.id, url: String(tree.frame.url || "") + String(tree.frame.urlFragment || "") });
    for (const c of tree.childFrames || []) flatten(c, out);
    return out;
  }

  /** A frame on challenges.cloudflare.com, or inside one: never touched (no session, no world). */
  function underChallenge(f) {
    for (let x = f; x; x = x.parentFrame()) { try { if (hostOf(x.url()) === CHALLENGE_HOST) return true; } catch { /* detached */ } }
    return false;
  }

  async function readTab(ctx, page) {
    const opened = []; // every session this probe opened — all detached at the end
    try { return await readTabWith(ctx, page, opened); }
    finally { await Promise.allSettled(opened.map((s) => withTimeout(Promise.resolve().then(() => s.detach()), 1000, "detach"))); }
  }

  async function readTabWith(ctx, page, opened) {
    const children = page.frames().filter((f) => f !== page.mainFrame());
    const skipped = children.filter(underChallenge);
    const targets = [page, ...children.filter((f) => !skipped.includes(f))];
    const byFrame = new Map(); // CDP frameId → { url, sessions: [{ session, live }] }
    const failedTargets = new Set(); // Playwright frames whose own session or tree could not be had
    const ownSession = new Set(); // Playwright frames with a session of their own (out-of-process)
    for (const t of targets) {
      const r = await sessionFor(ctx, t, opened);
      if (r.inProcess) continue;
      if (r.failed) { failedTargets.add(t === page ? page.mainFrame() : t); continue; }
      const s = r.session;
      if (t !== page) ownSession.add(t);
      let tree;
      let live;
      try {
        live = await withTimeout(runtimeFor(s), frameTimeoutMs, "runtime");
        ({ frameTree: tree } = await withTimeout(s.send("Page.getFrameTree"), frameTimeoutMs, "frame tree"));
      } catch { failedTargets.add(t === page ? page.mainFrame() : t); continue; }
      for (const f of flatten(tree)) {
        if (!byFrame.has(f.id)) byFrame.set(f.id, { url: f.url, sessions: [] });
        byFrame.get(f.id).sessions.push({ session: s, live });
      }
    }
    const frames = skipped.map((f) => ({ url: f.url(), result: { seen: 0, filled: 0 }, skipped: true }));
    for (const [id, f] of byFrame) {
      if (hostOf(f.url) === CHALLENGE_HOST) { frames.push({ url: f.url, result: { seen: 0, filled: 0 }, skipped: true }); continue; }
      let result = null;
      let stale = false;
      for (const { session, live } of f.sessions) {
        try { result = await withTimeout(evalIn(session, live, id), frameTimeoutMs); stale = false; break; }
        catch (e) { if (e instanceof StaleWorldError) stale = true; /* try the next session that hosts it */ }
      }
      frames.push({ url: f.url, result, ...(stale ? { stale: true } : {}) });
    }
    // Round 5 item 3: unreadable frames by FRAME, not by comparing counts.
    // Playwright does not expose a frame's CDP id, so each Playwright frame is
    // matched to a frame some session described (by its URL, one each); a
    // frame inside a target whose session or tree could not be had, or one no
    // session described, is unreadable.
    const described = [...byFrame.values()].map((f) => f.url);
    const inFailed = (f) => {
      for (let x = f; x; x = x.parentFrame()) {
        if (failedTargets.has(x)) return true;
        if (x !== f && ownSession.has(x) && !failedTargets.has(x)) return false; // an out-of-process ancestor that answered
      }
      return false;
    };
    for (const pf of page.frames()) {
      if (skipped.includes(pf)) continue;
      let url = "";
      try { url = pf.url(); } catch { /* detached */ }
      if (inFailed(pf)) { frames.push({ url, result: null }); continue; }
      const k = described.indexOf(url);
      if (k >= 0) { described.splice(k, 1); continue; }
      frames.push({ url, result: null }); // no session described this frame
    }
    return frames;
  }

  return async function readTabs(ctx) {
    const tabs = [];
    for (const page of ctx.pages()) {
      let closed = false;
      try { closed = page.isClosed(); } catch { /* treat as open */ }
      if (closed) continue;
      let url = "";
      try { url = page.url(); } catch { /* unknown */ }
      let frames;
      try { frames = await readTab(ctx, page); } catch { frames = [{ url, result: null }]; }
      tabs.push({ key: page, url, frames });
    }
    return { tabs };
  };
}

/**
 * @param {object} o
 * @param {() => (object|null)} o.getContext  the relay's Playwright BrowserContext (null while no Brave)
 * @param {object[]} [o.accounts]  the known-account list (test seam)
 * @param {(text: string) => void} [o.notice]  lock / unlock announcements
 * @param {(ctx) => Promise<{tabs}>} [o.readTabs]  test seam (default: the CDP isolated-world reader)
 */
function createLock({ getContext, accounts = KNOWN_ACCOUNTS, notice = () => {}, frameTimeoutMs = FRAME_TIMEOUT_MS, log = () => {}, readTabs = null } = {}) {
  const reader = readTabs || createCdpReader({ frameTimeoutMs });
  let state = { locked: false, reason: null, since: null, checkedAt: null, filled: 0, seen: 0, unreadable: 0 };
  const tabMemory = new Map(); // tab key → { url, seen }

  async function probe() {
    let ctx = null;
    try { ctx = getContext(); } catch { /* none */ }
    let tabs = [];
    let readFailed = false;
    if (ctx) {
      try { ({ tabs } = await reader(ctx)); } catch { readFailed = true; }
    }
    let filled = 0;
    let seenAll = 0;
    let unreadableAll = 0;
    let reason = null;
    const present = new Set();
    for (const t of tabs) {
      present.add(t.key);
      let seen = 0;
      let unreadable = 0;
      let signInFrame = null;
      let stale = 0;
      for (const f of t.frames) {
        if (f.stale) stale++;
        if (f !== t.frames[0] && matchSignInPage(f.url, accounts)) signInFrame = hostOf(f.url);
        if (!f.result || typeof f.result !== "object") { unreadable++; continue; }
        seen += Math.max(0, Math.floor(Number(f.result.seen) || 0));
        filled += Math.max(0, Math.floor(Number(f.result.filled) || 0));
      }
      const mem = tabMemory.get(t.key);
      const samePage = mem && mem.url === t.url;
      const seenHere = seen > 0 || (samePage && mem.seen);
      if (!reason && matchSignInPage(t.url, accounts)) reason = `a tab is on a known account's sign-in page (${hostOf(t.url)})`;
      // Round 5 item 1: a frame whose probe world could not be verified locks its tab outright.
      if (!reason && stale > 0) reason = `${stale} frame(s) of a tab could not be read in a verified isolated world — fail closed`;
      if (!reason && unreadable > 0 && (seenHere || signInFrame)) {
        reason = `${unreadable} frame(s) of a tab could not be read while ${signInFrame ? `a sign-in frame (${signInFrame}) is open there` : "a password field was seen there"} — fail closed`;
      }
      tabMemory.set(t.key, { url: t.url, seen: unreadable > 0 ? !!seenHere : seen > 0 });
      seenAll += seen;
      unreadableAll += unreadable;
    }
    // Closed tabs drop their memory — but not when the read itself failed (then
    // `tabs` is empty and the memory is exactly what fails closed below).
    if (!readFailed) for (const k of [...tabMemory.keys()]) if (!present.has(k)) tabMemory.delete(k);
    if (filled > 0) reason = "a password / one-time-code field on a tab holds a value";
    if (!reason && readFailed && [...tabMemory.values()].some((m) => m.seen)) reason = "the tabs could not be read while a password field was seen — fail closed";
    const locked = reason !== null;
    const now = new Date().toISOString();
    if (locked !== state.locked) {
      notice(locked
        ? `[browser-mcp-relay] PLAIN-FLAGS: LOCKED — ${reason}. Every tool but relay_status and tabs_list is refused until it clears.`
        : "[browser-mcp-relay] PLAIN-FLAGS: UNLOCKED — no password or one-time code on any tab any more; tools resume.");
      log(`plain-flags lock: ${locked ? `LOCKED (${reason})` : "unlocked"}`);
    }
    state = { locked, reason, since: locked ? (state.locked ? state.since : now) : null, checkedAt: now, filled, seen: seenAll, unreadable: unreadableAll };
    return state;
  }

  return { probe, status: () => ({ ...state }), EXEMPT, LOCK_TEXT };
}

module.exports = { createLock, createCdpReader, secretProbe, EXEMPT, LOCK_TEXT, CHALLENGE_HOST, StaleWorldError };
