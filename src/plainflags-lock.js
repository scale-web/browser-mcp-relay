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
//      (its origin + path changes — 1c L5) or closes.
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
// THE DEFAULT RELAY (register A77; Trevor's ruling as-ops/ask-a2ggu5 rev 2,
// "Lock, except session-filled values") runs this same lock with
// `mode: "default"` (src/default-lock.js): rule 1 only (rule 2 and rule 3's
// sign-in-frame clause are URL rules and are off), plus one exception — a
// filled secret field whose value EXACTLY equals a value (≥ 6 characters —
// fix round 1) this relay process passed into a page with interaction_fill /
// form_fill does not lock — and one refinement of rule 1 (rulings
// as-ops/ask-75txd2, as-ops/ask-gnpqzm): the name / id substring rule skips
// only the ruled false positives (passeng… / passport… tokens, bypass,
// compass). Each lock / unlock is reported to `episode` (rule tags, counts, a host).
// The relay keeps only salted SHA-256 digests of those values (createSessionFills:
// the last 50, each forgotten after 30 min; never logged, never in
// relay_status, never on disk); the probe gets the digests and the salt, hashes
// each filled secret field in its isolated world and COUNTS the matches — a
// value still never leaves the page, and none is sent into one.
//
// Timeouts (review 1c L4, both modes): every newCDPSession, every CDP call,
// each tab (tabs are read in parallel) and the whole probe are bounded; a
// timeout = unreadable, which fails closed only per rule 3; a tab that times
// out keeps the frames already read (fix round 1). The per-tab
// memory is keyed on origin + path (L5), so a ?step= / #hash change keeps it.
//
// Residuals (REFERENCE "The plain-flags relay"): a secret field in a CLOSED
// shadow root; a code in a plain text field the page never marks; console
// messages and page text; an app host's sign-in form is covered only once a
// value is typed (an empty form on an app host does not lock — nothing to leak
// yet). ACCIDENT GUARD, not a boundary — any local process can drive this Brave
// over its debugging port.

"use strict";

const crypto = require("node:crypto");
const { KNOWN_ACCOUNTS, matchSignInPage } = require("./known-accounts.js");

const EXEMPT = Object.freeze(["relay_status", "tabs_list"]);
const LOCK_TEXT =
  "Locked: a password or one-time code is on this page (Trevor may be signing in). Tools resume when the field is empty or the tab leaves the sign-in page.";
const DEFAULT_LOCK_TEXT =
  "Locked: a password or one-time code typed on this page (Trevor may be signing in). Tools resume when the field is empty, or holds only a value this session filled.";
const FRAME_TIMEOUT_MS = 2500;
const SESSION_FILLS_MAX = 50;
const SESSION_FILLS_TTL_MS = 30 * 60 * 1000;
const SESSION_FILLS_MIN = 6; // characters (A77 fix 2)
// Fix round 3: a tab's budget covers its worst case — its frame targets' setup
// in parallel (session, Runtime, frame tree: 3 frame timeouts) and THEN the
// main frame's read (a 4th) — plus a margin. At exactly 3 frame timeouts a
// frame answering each setup step just under its timeout left the main frame
// unread (review of 6b61c6d, fake CDP).
const tabBudget = (frameTimeoutMs) => 4 * frameTimeoutMs + 500;
const CHALLENGE_HOST = "challenges.cloudflare.com";
const WORLD_NAME = "__browser_mcp_relay_lock__";

/**
 * Runs in each frame's ISOLATED world. COUNTS only — a value never leaves the page.
 * `allow` (default relay only; null in plain-flags): { dflt: true, salt?, digests? }.
 *   - a filled secret field whose SHA-256(salt + value) is one of `digests` is
 *     counted in `own`, not `filled` (the session-filled exception);
 *   - `dflt`: the name / id rule is plain-flags' substring rule minus the
 *     ruled false positives (as-ops/ask-75txd2; round 2), and the result
 *     carries `kinds` — which rules made the FILLED fields secret (tags only,
 *     for the lock-episode log; never a value, a name or an id).
 */
const secretProbe = (allow) => {
  "use strict";
  /** SHA-256 hex of a string's UTF-8 bytes (synchronous: crypto.subtle is async and absent on http pages). */
  const sha256hex = (str) => {
    const bytes = Array.from(new TextEncoder().encode(str));
    const P = [];
    for (let n = 2; P.length < 64; n++) if (P.every((p) => n % p)) P.push(n);
    const frac = (x) => ((x - Math.floor(x)) * 4294967296) | 0;
    const K = P.map((p) => frac(Math.cbrt(p)));
    const H = P.slice(0, 8).map((p) => frac(Math.sqrt(p)));
    const bits = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (const v of [Math.floor(bits / 4294967296), bits >>> 0]) bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    const r = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < bytes.length; o += 64) {
      const W = [];
      for (let i = 0; i < 64; i++) {
        if (i < 16) W[i] = (bytes[o + 4 * i] << 24) | (bytes[o + 4 * i + 1] << 16) | (bytes[o + 4 * i + 2] << 8) | bytes[o + 4 * i + 3];
        else W[i] = (W[i - 16] + (r(W[i - 15], 7) ^ r(W[i - 15], 18) ^ (W[i - 15] >>> 3)) + W[i - 7] + (r(W[i - 2], 17) ^ r(W[i - 2], 19) ^ (W[i - 2] >>> 10))) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
    }
    return H.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
  };
  const ownSet = allow && typeof allow.salt === "string" && Array.isArray(allow.digests) && allow.digests.length > 0 ? new Set(allow.digests) : null;
  const dflt = !!(allow && allow.dflt);
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
  const PASS_RE = /pass|pwd/i; // "password", "passcode", "passwd", "pwd", "passwort", "mot_de_passe" (substring, fail closed)
  // Default relay (Trevor's ruling as-ops/ask-75txd2; fix round 2): the SAME
  // substring rule, minus only the ruled false positives — a token STARTING
  // with "passeng" or "passport" (at the start, after a separator or at a
  // camelCase boundary) and any "bypass" / "compass" are cut out first, and
  // whatever is left is tested as above ("passengerPassword" still locks).
  // Fix round 3: each exception matches only as ONE word — all lower case,
  // ALL CAPS or Capitalised — never across a camelCase boundary, so
  // "loginByPassword", "comPassword" and "passPortal" keep their "Pass".
  const notPassword = (str) => String(str || "")
    .replace(/(^|[^A-Za-z0-9])(passeng|passport|PASSENG|PASSPORT|Passeng|Passport)/g, "$1")
    .replace(/([a-z0-9])(?:Passeng|Passport|PASSENG|PASSPORT)/g, "$1")
    // fix round 4: never when "pass" runs on into "w" ("bypassword", "COMPASSWORD", "authbypasswd" keep it)
    .replace(/(?:by|com)pass(?!w)|(?:BY|COM)PASS(?!W)|(?:By|Com)pass(?!w)/g, "");
  const nameSecret = (nm, id) => {
    const a = dflt ? notPassword(nm) : nm;
    const b = dflt ? notPassword(id) : id;
    return PASS_RE.test(a) || PASS_RE.test(b) || [...words(nm), ...words(id)].includes("otp");
  };
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
  const why = new Map(); // element → Set of rule tags
  const tag = (el, ...t) => { if (!why.has(el)) why.set(el, new Set()); for (const x of t) why.get(el).add(x); };
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
    // which rules make it secret — tags for the default relay's episode log (the decision is unchanged: any tag = secret)
    const tags = [];
    if (mem.has(el)) tags.push("remembered");
    if (type === "password" || prop === "password") tags.push("type=password");
    if (AC.some((t) => ac.includes(t))) tags.push("autocomplete");
    if (nameSecret(nm, id)) tags.push("name-rule");
    if (ts !== "" && ts !== "none") tags.push("text-security");
    if (codeField(el, nm, id, im, ml)) tags.push("otp");
    if (tags.length > 0) { secret.add(el); tag(el, ...tags); }
    if (ac.includes("one-time-code")) {
      for (const sib of [el.previousElementSibling, el.nextElementSibling]) if (sib && inputs.includes(sib)) { secret.add(sib); tag(sib, "otp"); }
    }
    if (isOtpBox(el)) {
      for (const c of [el.parentElement, el.parentElement && el.parentElement.parentElement]) {
        if (!c) continue;
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c).push(el);
      }
    }
  }
  for (const members of groups.values()) if (members.length >= 4) for (const m of members) { secret.add(m); tag(m, "otp"); }
  for (const el of secret) mem.add(el);
  let filled = 0;
  let own = 0;
  const kinds = new Set();
  for (const el of secret) {
    const v = String(el.value || "");
    if (v.length === 0) continue;
    if (ownSet && ownSet.has(sha256hex(allow.salt + v))) own++; // exactly a value this session filled
    else { filled++; for (const k of why.get(el) || []) kinds.add(k); }
  }
  if (dflt) return { seen: secret.size, filled, own, kinds: [...kinds].sort() };
  return ownSet ? { seen: secret.size, filled, own } : { seen: secret.size, filled };
};

/**
 * The default relay's record of values IT filled (interaction_fill / form_fill
 * args): salted SHA-256 digests only — never the value — the last `max`, each
 * forgotten `ttlMs` after it was (last) filled. In memory only.
 */
function createSessionFills({ max = SESSION_FILLS_MAX, ttlMs = SESSION_FILLS_TTL_MS, now = () => Date.now() } = {}) {
  // A77 fix 2: a value shorter than SESSION_FILLS_MIN characters is not
  // recorded — single digits filled into split one-time-code boxes would
  // otherwise except Trevor's own code typed into the same boxes.
  const salt = crypto.randomBytes(16).toString("hex");
  const at = new Map(); // digest → time last filled (Map order = oldest first)
  const digest = (v) => crypto.createHash("sha256").update(salt + v, "utf8").digest("hex");
  const prune = () => {
    const t = now();
    for (const [d, when] of at) if (t - when >= ttlMs) at.delete(d);
    while (at.size > max) at.delete(at.keys().next().value);
  };
  return {
    record(value) {
      if (typeof value !== "string" || [...value].length < SESSION_FILLS_MIN) return;
      const d = digest(value);
      at.delete(d);
      at.set(d, now());
      prune();
    },
    /** What the probe needs ({ salt, digests }), or null when nothing is remembered. */
    allow() { prune(); return at.size > 0 ? { salt, digests: [...at.keys()] } : null; },
    size() { prune(); return at.size; },
  };
}

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
function createCdpReader({ frameTimeoutMs = FRAME_TIMEOUT_MS, tabTimeoutMs = tabBudget(frameTimeoutMs) } = {}) {
  const expressionFor = (allow) => `(() => { "use strict"; return (${secretProbe.toString()})(${JSON.stringify(allow || null)}); })()`;
  const IN_PROCESS = /does not have a separate CDP session/i;

  /** A NEW session for this probe (never one from an earlier probe). */
  async function sessionFor(ctx, target, opened) {
    // L4: bounded — a hung newCDPSession must not hang the probe (and with it every tool).
    const p = Promise.resolve().then(() => ctx.newCDPSession(target));
    try {
      const session = await withTimeout(p, frameTimeoutMs, "new CDP session");
      opened.push(session);
      return { session };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (msg === "new CDP session timed out") {
        p.then((s) => s.detach()).catch(() => {}); // a session that arrives late is detached, never used
        return { failed: true };
      }
      // An in-process frame has no session of its own (its parent's tree covers
      // it); any OTHER failure leaves the frame unread (round 6 item 5).
      return IN_PROCESS.test(msg) ? { inProcess: true } : { failed: true };
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

  async function evalIn(session, live, frameId, expression) {
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

  /** `frames` (A77 fix 1): every frame's outcome is pushed as soon as it is known, so a tab timeout keeps what was read. */
  async function readTab(ctx, page, expression, frames) {
    const opened = []; // every session this probe opened — all detached at the end
    try { return await readTabWith(ctx, page, opened, expression, frames); }
    finally { await Promise.allSettled(opened.map((s) => withTimeout(Promise.resolve().then(() => s.detach()), 1000, "detach"))); }
  }

  async function readTabWith(ctx, page, opened, expression, frames) {
    const children = page.frames().filter((f) => f !== page.mainFrame());
    const skipped = children.filter(underChallenge);
    const targets = [page, ...children.filter((f) => !skipped.includes(f))];
    const byFrame = new Map(); // CDP frameId → { url, sessions: [{ session, live }] }
    const failedTargets = new Set(); // Playwright frames whose own session or tree could not be had
    const ownSession = new Set(); // Playwright frames with a session of their own (out-of-process)
    // A77 fix 1: every target's session, Runtime and frame tree are had IN
    // PARALLEL (each step bounded), so N hung out-of-process frames cost one
    // frame timeout, not N — the main frame is then read first. The results
    // are applied in target order (main first), exactly as before.
    const setups = await Promise.all(targets.map(async (t) => {
      const r = await sessionFor(ctx, t, opened);
      if (r.inProcess || r.failed) return { t, ...r };
      try {
        const live = await withTimeout(runtimeFor(r.session), frameTimeoutMs, "runtime");
        const { frameTree: tree } = await withTimeout(r.session.send("Page.getFrameTree"), frameTimeoutMs, "frame tree");
        return { t, session: r.session, live, tree };
      } catch { return { t, session: r.session, failed: true }; }
    }));
    for (const x of setups) {
      if (x.inProcess) continue;
      if (x.session && x.t !== page) ownSession.add(x.t);
      if (x.failed) { failedTargets.add(x.t === page ? page.mainFrame() : x.t); continue; }
      for (const f of flatten(x.tree)) {
        if (!byFrame.has(f.id)) byFrame.set(f.id, { url: f.url, sessions: [] });
        byFrame.get(f.id).sessions.push({ session: x.session, live: x.live });
      }
    }
    for (const f of skipped) frames.push({ url: f.url(), result: { seen: 0, filled: 0 }, skipped: true });
    for (const [id, f] of byFrame) {
      if (hostOf(f.url) === CHALLENGE_HOST) { frames.push({ url: f.url, result: { seen: 0, filled: 0 }, skipped: true }); continue; }
      let result = null;
      let stale = false;
      for (const { session, live } of f.sessions) {
        try { result = await withTimeout(evalIn(session, live, id, expression), frameTimeoutMs); stale = false; break; }
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

  // L4: tabs are read in PARALLEL, each bounded by tabTimeoutMs — a tab that
  // does not finish is unreadable (rule 3 decides, per tab), and cannot starve
  // the others. A timed-out read finishes in the background (every step of it
  // is bounded) and detaches its own sessions.
  return async function readTabs(ctx, { allow = null } = {}) {
    const expression = expressionFor(allow);
    const pages = ctx.pages().filter((page) => { try { return !page.isClosed(); } catch { return true; } });
    const tabs = await Promise.all(pages.map(async (page) => {
      let url = "";
      try { url = page.url(); } catch { /* unknown */ }
      const read = []; // filled in as each frame is read (A77 fix 1)
      let frames;
      // A tab that times out (or fails) keeps every frame already read — a
      // filled secret there still locks, a seen one fails the rest closed —
      // plus one unreadable entry for what was not read.
      try { frames = await withTimeout(readTab(ctx, page, expression, read), tabTimeoutMs, "tab probe"); } catch { frames = [...read, { url, result: null }]; }
      return { key: page, url, frames };
    }));
    return { tabs };
  };
}

/** L5: the per-tab memory's page = origin + path (a ?step= or #hash change is the same page). */
function pageKey(u) {
  try { const x = new URL(String(u)); return `${x.protocol}//${x.host}${x.pathname}`; } catch { return String(u); }
}

/**
 * @param {object} o
 * @param {() => (object|null)} o.getContext  the relay's Playwright BrowserContext (null while no Brave)
 * @param {object[]} [o.accounts]  the known-account list (test seam)
 * @param {(text: string) => void} [o.notice]  lock / unlock announcements
 * @param {(ctx, {allow}) => Promise<{tabs}>} [o.readTabs]  test seam (default: the CDP isolated-world reader)
 * @param {"plainflags"|"default"} [o.mode]  "default" (A77): no URL rules, the session-filled exception, its own text
 * @param {ReturnType<typeof createSessionFills>} [o.sessionFills]  default mode: the values this relay filled
 * @param {(e: {event, reason, kinds, tabs, host, durationMs?}) => void} [o.episode]  default mode: one call per
 *   lock and per unlock (fix round 2, ruling as-ops/ask-gnpqzm) — rule tags, counts and a host only — and one
 *   per probe slower than `slowProbeMs` (fix round 3: {event: "slow-probe", ms, tabs, frames, unreadable})
 */
function createLock({ getContext, accounts = KNOWN_ACCOUNTS, notice = () => {}, frameTimeoutMs = FRAME_TIMEOUT_MS, log = () => {}, readTabs = null,
  mode = "plainflags", sessionFills = null, tabTimeoutMs = tabBudget(frameTimeoutMs), probeTimeoutMs = tabTimeoutMs + 1000, episode = null, slowProbeMs = 1000 } = {}) {
  const dflt = mode === "default";
  const urlRules = !dflt; // 1c rule 2 and rule 3's sign-in-frame clause: plain-flags only
  const lockText = dflt ? DEFAULT_LOCK_TEXT : LOCK_TEXT;
  const reader = readTabs || createCdpReader({ frameTimeoutMs, tabTimeoutMs });
  let state = { locked: false, reason: null, since: null, checkedAt: null, filled: 0, seen: 0, unreadable: 0, ...(dflt ? { sessionFilled: 0 } : {}) };
  const tabMemory = new Map(); // tab key → { url: pageKey, seen }
  let current = null; // default mode: the open lock episode { reason, kinds, tabs, host, at }

  async function probe() {
    const started = Date.now();
    let ctx = null;
    try { ctx = getContext(); } catch { /* none */ }
    let tabs = [];
    let readFailed = false;
    if (ctx) {
      // Default mode: the probe's own name rule and the session's digests.
      const allow = dflt ? { dflt: true, ...((sessionFills && sessionFills.allow()) || {}) } : null;
      // L4: the whole probe is bounded too (a backstop — the reader bounds each tab itself).
      try { ({ tabs } = await withTimeout(Promise.resolve().then(() => reader(ctx, { allow })), probeTimeoutMs, "lock probe")); } catch { readFailed = true; }
    }
    let own = 0;
    let filled = 0;
    let seenAll = 0;
    let unreadableAll = 0;
    let reason = null;
    const present = new Set();
    const filledTabs = []; // hosts of the tabs holding a filled secret (episode log)
    const closedTabs = []; // hosts of the tabs that failed closed (episode log)
    const kinds = new Set();
    for (const t of tabs) {
      present.add(t.key);
      let seen = 0;
      let unreadable = 0;
      let signInFrame = null;
      let stale = 0;
      let filledHere = 0;
      for (const f of t.frames) {
        if (f.stale) stale++;
        if (urlRules && f !== t.frames[0] && matchSignInPage(f.url, accounts)) signInFrame = hostOf(f.url);
        if (!f.result || typeof f.result !== "object") { unreadable++; continue; }
        seen += Math.max(0, Math.floor(Number(f.result.seen) || 0));
        filledHere += Math.max(0, Math.floor(Number(f.result.filled) || 0));
        own += Math.max(0, Math.floor(Number(f.result.own) || 0));
        if (Array.isArray(f.result.kinds)) for (const k of f.result.kinds) if (typeof k === "string") kinds.add(k);
      }
      filled += filledHere;
      if (filledHere > 0) filledTabs.push(hostOf(t.url));
      const mem = tabMemory.get(t.key);
      const samePage = mem && mem.url === pageKey(t.url);
      const seenHere = seen > 0 || (samePage && mem.seen);
      if (!reason && urlRules && matchSignInPage(t.url, accounts)) reason = `a tab is on a known account's sign-in page (${hostOf(t.url)})`;
      // Round 5 item 1: a frame whose probe world could not be verified locks its tab outright.
      if (stale > 0 || (unreadable > 0 && (seenHere || signInFrame))) closedTabs.push(hostOf(t.url));
      if (!reason && stale > 0) reason = `${stale} frame(s) of a tab could not be read in a verified isolated world — fail closed`;
      if (!reason && unreadable > 0 && (seenHere || signInFrame)) {
        reason = `${unreadable} frame(s) of a tab could not be read while ${signInFrame ? `a sign-in frame (${signInFrame}) is open there` : "a password field was seen there"} — fail closed`;
      }
      tabMemory.set(t.key, { url: pageKey(t.url), seen: unreadable > 0 ? !!seenHere : seen > 0 });
      seenAll += seen;
      unreadableAll += unreadable;
    }
    // Closed tabs drop their memory — but not when the read itself failed (then
    // `tabs` is empty and the memory is exactly what fails closed below).
    if (!readFailed) for (const k of [...tabMemory.keys()]) if (!present.has(k)) tabMemory.delete(k);
    if (filled > 0) reason = dflt ? "a password / one-time-code field on a tab holds a value this session did not fill" : "a password / one-time-code field on a tab holds a value";
    if (!reason && readFailed && [...tabMemory.values()].some((m) => m.seen)) reason = "the tabs could not be read while a password field was seen — fail closed";
    const locked = reason !== null;
    const now = new Date().toISOString();
    if (locked !== state.locked) {
      const tag = dflt ? "" : "PLAIN-FLAGS: ";
      notice(locked
        ? `[browser-mcp-relay] ${tag}LOCKED — ${reason}. Every tool but relay_status and tabs_list is refused until it clears.`
        : `[browser-mcp-relay] ${tag}UNLOCKED — no ${dflt ? "typed " : ""}password or one-time code on any tab any more; tools resume.`);
      log(`${dflt ? "lock" : "plain-flags lock"}: ${locked ? `LOCKED (${reason})` : "unlocked"}`);
      // Default mode: one log line per lock and per unlock — rule tags, counts, a host; never a value, a name, an id, a path or a query.
      if (dflt && episode) {
        try {
          if (locked) {
            const byFill = filled > 0;
            const hosts = byFill ? filledTabs : closedTabs;
            current = { reason: byFill ? "filled" : "unreadable", kinds: byFill ? [...kinds].sort() : [], tabs: hosts.length, host: hosts[0] || null, at: Date.now() };
            episode({ event: "lock", reason: current.reason, kinds: current.kinds, tabs: current.tabs, host: current.host });
          } else if (current) {
            episode({ event: "unlock", reason: current.reason, kinds: current.kinds, tabs: current.tabs, host: current.host, durationMs: Date.now() - current.at });
            current = null;
          }
        } catch { /* log-only: never affects the lock */ }
      }
    }
    state = { locked, reason, since: locked ? (state.locked ? state.since : now) : null, checkedAt: now, filled, seen: seenAll, unreadable: unreadableAll, ...(dflt ? { sessionFilled: own } : {}) };
    // Fix round 3 (log-only): a probe over slowProbeMs → one line of COUNTS (never a value, a name, a URL, a host or a path).
    const ms = Date.now() - started;
    if (dflt && episode && ms > slowProbeMs) {
      try { episode({ event: "slow-probe", ms, tabs: tabs.length, frames: tabs.reduce((n, t) => n + (Array.isArray(t.frames) ? t.frames.length : 0), 0), unreadable: unreadableAll }); } catch { /* log-only */ }
    }
    return state;
  }

  return { probe, status: () => ({ ...state }), EXEMPT, LOCK_TEXT: lockText };
}

module.exports = {
  createLock, createCdpReader, createSessionFills, secretProbe, EXEMPT, LOCK_TEXT, DEFAULT_LOCK_TEXT, CHALLENGE_HOST, StaleWorldError,
  SESSION_FILLS_MAX, SESSION_FILLS_TTL_MS, SESSION_FILLS_MIN,
};
