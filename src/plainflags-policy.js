// plainflags-policy.js — what the plain-flags relay lets a session do (spec v8
// §5.6 (6)(d), (7), (10)). RelayServer consults it only in plain-flags mode;
// the default relay never builds one, so its behaviour is unchanged.
//
//   tools/list   an ALLOWLIST (fail closed: a new upstream tool stays hidden
//                until named), with the header/body flags of
//                o11y_get-http-requests, capture_xhr's includeBody and the
//                relay-only allowPinnedPage of the fill/press-key tools removed
//                from their schemas.
//   tools/call   every other name refused at call time too (a client can call
//                an unlisted name); then the sign-in guard's layer 1; then the
//                per-tool limits:
//     - o11y_get-http-requests: includeRequestHeaders, includeResponseHeaders
//       and includeResponseBody refused (request headers can carry
//       Authorization / x-as-qa; response headers Set-Cookie; a body a token).
//       Request bodies are stripped relay-wide by A76 (a startup source patch
//       of upstream plus src/request-body-filter.js on this result); here the
//       remaining header/body keys are stripped from every item as well.
//     - capture_xhr: includeBody:true refused, includeBody:false forced; the
//       result carries no body and no set-cookie header.
//     - interaction_fill / form_fill: a CSS selector only — an aria-snapshot ref
//       (`@x`, `ref=x`, `e5`: upstream's parseRef) or a Playwright locator
//       expression (`getByRole(…)` etc.: upstream's
//       tryParsePlaywrightLocatorExpression) is refused, because upstream
//       resolves those its own way. The element is then inspected where the
//       fill will land — interaction_fill through UPSTREAM's own page (an
//       internal upstream `execute`, as readUpstreamUrl does; review r8 #2),
//       form_fill on the relay's active page, which it fills — with the same
//       `page.locator(s).first()` resolution, so frames and shadow roots are
//       followed; refused when it is type=password or its autocomplete holds
//       current-password, new-password or one-time-code, or cannot be inspected.
//     - interaction_press-key: named keys only (PRESS_KEYS), no modifier
//       combination — no printable character, no Space, no paste.
//     - interaction_fill / interaction_press-key: refused while upstream's tab
//       is not the selected one, and the allowPinnedPage opt-in is stripped —
//       never honoured here (review r8 #2).
//   after a call / before a call: the sign-in guard's cookie sweep (§5.6 (6)(f))
//                and, when the sign-in list lost an account, its clear (g).
// The check-then-fill gap (the DOM can change between the inspection and the
// fill) is argued, not demonstrated (§10 #28).

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pfMode = require("./plainflags-mode.js");
const { createLock, EXEMPT: LOCK_EXEMPT, LOCK_TEXT } = require("./plainflags-lock.js");
const sync = require("./own-tools/_upstream-sync.js");
const { getActivePage } = require("./own-tools/_active-page.js");

const ALLOW = new Set(pfMode.TOOL_ALLOWLIST);
const PRESS = new Set(pfMode.PRESS_KEYS);
const SECRET_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code"];
const O11Y_FLAGS = ["includeRequestHeaders", "includeResponseHeaders", "includeResponseBody"];
const O11Y_ITEM_KEYS = ["body", "headers", "requestHeaders", "responseHeaders", "responseBody"];
const KEY_GUARDED = new Set(["interaction_fill", "interaction_press-key"]);
// Upstream navigation tools return an ARIA snapshot by DEFAULT (includeSnapshot:
// true → `output` + `refs`), which carries input values (review round 2 item 1).
const SNAPSHOT_NAV = new Set(["navigation_go-to", "navigation_go-back-or-forward"]);
const NAV_SNAPSHOT_KEYS = ["output", "refs"];
// Round 3 B / C: every URL- and selector-taking argument, and the screenshot annotations.
const URL_KEYS = ["url", "navigateToUrl", "pageUrl"];
const SELECTOR_KEYS = ["selector", "sourceSelector", "targetSelector", "anchorSelector"];
const ANNOTATE_KEYS = ["annotate", "annotateContent", "annotateCursorInteractive"];

/** Only http(s) — or exactly about:blank — may be navigated to here (round 3 B). */
function urlSchemeProblem(u) {
  if (typeof u !== "string") return null;
  const t = u.trim();
  if (t === "about:blank") return null;
  let parsed;
  try { parsed = new URL(t); } catch { return `${JSON.stringify(u)} is not an absolute URL`; }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return null;
  return `the ${parsed.protocol} scheme is refused here (only http:, https: and about:blank) — a javascript:, data:, file:, blob:, chrome: or view-source: URL can run or show page code`;
}
const FIELD_TIMEOUT_MS = 5000;

/**
 * Round 6 item 4: in this profile every http(s) URL in every result string —
 * structured fields AND prose (upstream's desync warning, refusal texts,
 * thrown errors) — loses its query and fragment (codes, tokens, magic links).
 */
// Round 7 item 3: brackets and backslashes no longer end a URL ("…/a]?code=" kept its
// query before), ws(s) URLs count, and the cut is at the first "?" or "#".
const URL_IN_TEXT_RE = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;
function scrubUrls(text) {
  return String(text).replace(URL_IN_TEXT_RE, (u) => {
    const cut = u.search(/[?#]/);
    if (cut < 0) return u;
    // closing brackets (and a JSON escape's backslash) that end the match were the prose's, not the URL's: put them back
    const trail = /[)\]}\\]+$/.exec(u.slice(cut));
    return u.slice(0, cut) + (trail ? trail[0] : "");
  });
}

function refuse(text) {
  return { isError: true, content: [{ type: "text", text: scrubUrls(`[mcp-relay] REFUSED (plain-flags relay): ${text}`) }] };
}

/**
 * Why a selector is not accepted (null = accepted). The rule (review round 4
 * L9) is "the check and the action resolve the selector IDENTICALLY": CSS,
 * xpath=, text=, id=, `>>` chains and internal:control=enter-frame resolve the
 * same way through page.locator() in the relay and in upstream, so they are
 * accepted; an aria-snapshot ref, a getBy*() expression and the role / label /
 * test-id / attr engines are refused (upstream resolves refs and getBy*() its
 * own way, and the engines are kept out with them as round 3 C asked).
 */
function selectorProblem(sel) {
  if (typeof sel !== "string" || sel.trim() === "") return "a CSS selector string is required";
  const s = sel.trim();
  if (s.startsWith("@") || /^ref=/i.test(s) || /^e\d+$/.test(s)) {
    return `${JSON.stringify(sel)} is an aria-snapshot ref — this relay takes only a selector it resolves the same way upstream does (CSS, xpath=, text=, id= …; it cannot check what a ref reaches)`;
  }
  if (/^\s*(getByRole|getByLabel|getByText|getByPlaceholder|getByAltText|getByTitle|getByTestId)\s*\(/.test(s)) {
    return `${JSON.stringify(sel)} is a Playwright locator expression — this relay takes only a selector it resolves the same way upstream does (CSS, xpath=, text=, id= …)`;
  }
  // Role / label / test-id engines, alone or in a `>>` chain (review round 3 C).
  if (s.split(">>").some((part) => /^\s*(role|internal:role|internal:label|internal:testid|internal:attr)\s*=/i.test(part))) {
    return `${JSON.stringify(sel)} uses a role / label / test-id locator — this relay takes only a selector it resolves the same way upstream does (CSS, xpath=, text=, id= …)`;
  }
  return null;
}

/**
 * Runs in the page on the element the selector resolves to, and reports the
 * element the ACTION will actually reach (review round 1 item 1). For "fill"
 * and "select" that is Playwright's own retarget(node, "follow-label")
 * (playwright-core injectedScriptSource.js, read 2026-10-30, copied step for
 * step): a <label> — `label[for=pw]`, a <span> inside a wrapping label, a
 * nested label — fills its `.control`. For "focus" (press-key's selector)
 * Playwright focuses the node itself. Never reads a value.
 */
const fieldProbe = (node, mode) => {
  "use strict";
  let el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
  if (!el) return null;
  if (mode !== "focus") {
    if (!el.matches("input, textarea, select") && !el.isContentEditable) {
      el = el.closest("button, [role=button], [role=checkbox], [role=radio]") || el;
    }
    if (!el.matches("a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]") && !el.isContentEditable) {
      const label = el.closest("label");
      if (label && label.control) el = label.control;
    }
  }
  // A show-password toggle turns type=password into text: its name / id and a
  // masking style still say what it is (review round 2 item 4).
  let textSecurity = "";
  try {
    const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    if (cs) textSecurity = String(cs.webkitTextSecurity || cs.getPropertyValue("-webkit-text-security") || "").toLowerCase();
  } catch { /* not an element in a window */ }
  return {
    tag: String(el.tagName || "").toLowerCase(),
    type: String(el.getAttribute("type") || "").toLowerCase(),
    prop: String(el.type || "").toLowerCase(),
    ac: String(el.getAttribute("autocomplete") || "").toLowerCase(),
    name: String(el.getAttribute("name") || "").slice(0, 200),
    id: String(el.getAttribute("id") || "").slice(0, 200),
    textSecurity,
    editable: !!el.isContentEditable,
    retargeted: el !== node,
  };
};

/** A name or id that says "secret" (review round 2 item 4). Matches "passport" or "footprint" too — fail closed. */
const SECRET_NAME_RE = /pass|pwd/i;
/** Words of a name / id, split as the lock's probe splits them (acronyms first: "OTPCode" → otp code; "TwoFA" → 2fa). */
function nameWords(s) {
  const w = String(s || "").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = w.length - 2; i >= 0; i--) if ((w[i] === "two" || w[i] === "2") && w[i + 1] === "fa") w.splice(i, 2, "2fa");
  return w;
}
/** Words that make a name secret on their own (round 6 item 3; round 7 item 2 adds the 2FA words). */
const SECRET_WORDS = ["otp", "mfa", "totp", "2fa"];
/** A name / id that says "secret": pass… / pwd as a substring (fail closed), otp / mfa / totp / 2fa as WORDS — "footprint" is not one. */
function secretName(s) {
  const t = String(s || "");
  if (SECRET_NAME_RE.test(t)) return true;
  return nameWords(t).some((w) => SECRET_WORDS.includes(w));
}

/**
 * Why the action must not reach this element (null = allowed). mode "fill":
 * the target must be an input, a textarea or contenteditable, and not a secret
 * field; "select": a <select>; "focus": not a secret field.
 */
function secretFieldProblem(info, mode = "fill") {
  if (!info || typeof info !== "object") return "the field could not be inspected";
  if (mode === "fill" && !(info.tag === "input" || info.tag === "textarea" || info.editable)) {
    return `the fill would land on a <${info.tag || "?"}>, not a text field`;
  }
  if (mode === "select" && info.tag !== "select") return `the selection would land on a <${info.tag || "?"}>, not a <select>`;
  if (info.type === "password" || info.prop === "password") return `it ${info.retargeted ? "reaches" : "is"} a password field`;
  const tokens = String(info.ac || "").split(/\s+/);
  const hit = SECRET_AUTOCOMPLETE.find((t) => tokens.includes(t));
  if (hit) return `it ${info.retargeted ? "reaches" : "is"} a field with autocomplete "${hit}"`;
  if (secretName(info.name) || secretName(info.id)) {
    return `it ${info.retargeted ? "reaches" : "is"} a field whose name or id says password / code`;
  }
  if (info.textSecurity && info.textSecurity !== "none") return `it ${info.retargeted ? "reaches" : "is"} a masked field (-webkit-text-security: ${info.textSecurity})`;
  return null;
}

function pressKeyProblem(key) {
  if (typeof key !== "string") return "`key` must be a string";
  if (!PRESS.has(key)) {
    return `key ${JSON.stringify(key)} is not allowed — named keys only (${pfMode.PRESS_KEYS.join(", ")}), no modifier, no printable ` +
      "character, no Space, no paste. Fill text fields with interaction_fill / form_fill";
  }
  return null;
}

/** The element an action reaches on UPSTREAM's own page (what interaction_* acts on). */
async function upstreamFieldInfo(getUpstream, selector, mode = "fill") {
  const code = `const loc = page.locator(${JSON.stringify(selector)}).first();\n` +
    `return await loc.evaluate(${fieldProbe.toString()}, ${JSON.stringify(mode)}, { timeout: ${FIELD_TIMEOUT_MS} });`;
  const upstream = await getUpstream();
  const res = await upstream.request("tools/call", { name: "execute", arguments: { code, timeoutMs: FIELD_TIMEOUT_MS + 3000 } });
  if (!res || res.isError) return null;
  let out = res.structuredContent;
  if (!out || typeof out !== "object") {
    const text = Array.isArray(res.content) ? res.content.filter((c) => c && c.type === "text").map((c) => c.text).join("") : "";
    try { out = JSON.parse(text); } catch { out = null; }
  }
  if (!out || typeof out !== "object" || out.error || !out.result || typeof out.result !== "object") return null;
  return out.result;
}

/** The element a fill reaches on the relay's active page (what form_fill fills). */
async function relayFieldInfo(selector, mode = "fill") {
  const bridge = globalThis.__relayBridge;
  const page = bridge && getActivePage(bridge.context);
  if (!page) return null;
  try { return await page.locator(selector).first().evaluate(fieldProbe, mode, { timeout: FIELD_TIMEOUT_MS }); }
  catch { return null; }
}

function withoutProps(tool, props) {
  const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : null;
  if (!schema || !schema.properties) return tool;
  const properties = { ...schema.properties };
  for (const p of props) delete properties[p];
  const out = { ...schema, properties };
  if (Array.isArray(schema.required)) out.required = schema.required.filter((r) => !props.includes(r));
  return { ...tool, inputSchema: out };
}

function stripItems(obj) {
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.requests)) return null;
  return {
    ...obj,
    requests: obj.requests.map((r) => {
      if (!r || typeof r !== "object") return r;
      const copy = { ...r };
      for (const k of O11Y_ITEM_KEYS) delete copy[k];
      // Nested shapes too (review round 1 item 7): item.request / item.response.
      for (const sub of ["request", "response"]) {
        if (copy[sub] && typeof copy[sub] === "object") {
          const inner = { ...copy[sub] };
          for (const k of [...O11Y_ITEM_KEYS, "postData"]) delete inner[k];
          copy[sub] = inner;
        }
      }
      return copy;
    }),
  };
}

const CAPTURE_HEADERS = Object.freeze(["content-type", "cf-mitigated", "cf-ray", "server", "location"]);

function stripCapture(obj) {
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.responses)) return null;
  return {
    ...obj,
    responses: obj.responses.map((r) => {
      if (!r || typeof r !== "object") return r;
      const { body, ...copy } = r;
      void body;
      // An ALLOWLIST of response headers (review round 3 D); `location` as its host only.
      if (copy.headers && typeof copy.headers === "object") {
        const kept = {};
        for (const [k, v] of Object.entries(copy.headers)) {
          const key = k.toLowerCase();
          if (!CAPTURE_HEADERS.includes(key)) continue;
          if (key === "location") { try { kept[key] = new URL(String(v), "https://placeholder.invalid/").hostname; } catch { /* dropped */ } continue; }
          kept[key] = String(v).slice(0, 200);
        }
        copy.headers = kept;
      }
      return copy;
    }),
  };
}

/**
 * content_get-as-html (review round 1 item 10, round 3 F): the `value`
 * attribute of every secret field — <input type=password>, an autocomplete
 * holding current-password / new-password / one-time-code, or a name / id
 * matching /pass|pwd|otp|passcode/i — is blanked. A scanner, not a regex:
 * comments and raw-text elements (script, style, textarea, title, xmp, …) are
 * skipped whole, and an <input> tag's end is found by its attribute tokenizer
 * (a quote opens a value only right after `=`). checkSecretValues() re-scans the
 * result; a secret input still carrying a non-empty value withholds it.
 */
const RAW_TEXT = ["script", "style", "textarea", "title", "xmp", "noscript", "noembed", "noframes", "iframe", "plaintext"];

/** Parse the <input …> tag at `start` (src[start] === "<"). { end, attrs }. */
function parseInputTag(src, start) {
  const attrs = [];
  let k = start + 6;
  while (k < src.length) {
    while (k < src.length && /[\s/]/.test(src[k])) k++;
    if (k >= src.length) break;
    if (src[k] === ">") { k++; break; }
    const ns = k;
    while (k < src.length && !/[\s=>/]/.test(src[k])) k++;
    if (k === ns) { k++; continue; }
    const name = src.slice(ns, k).toLowerCase();
    let p = k;
    while (p < src.length && /\s/.test(src[p])) p++;
    let value = "";
    let vs = -1;
    let ve = -1;
    if (src[p] === "=") {
      p++;
      while (p < src.length && /\s/.test(src[p])) p++;
      if (src[p] === '"' || src[p] === "'") {
        const qq = src[p];
        const e = src.indexOf(qq, p + 1);
        vs = p; ve = e < 0 ? src.length : e + 1;
        value = src.slice(p + 1, e < 0 ? src.length : e);
      } else {
        vs = p;
        while (p < src.length && !/[\s>]/.test(src[p])) p++;
        ve = p;
        value = src.slice(vs, ve);
      }
      k = ve;
    } else {
      k = p;
    }
    attrs.push({ name, value, vs, ve });
  }
  return { end: k, attrs };
}

function isSecretInput(attrs) {
  const first = (n) => attrs.find((a) => a.name === n);
  const type = String((first("type") || {}).value || "").toLowerCase();
  const ac = String((first("autocomplete") || {}).value || "").toLowerCase().split(/\s+/);
  const nm = String((first("name") || {}).value || "");
  const id = String((first("id") || {}).value || "");
  return type === "password" || SECRET_AUTOCOMPLETE.some((t) => ac.includes(t)) || secretName(nm) || secretName(id);
}

/** Walk the HTML; call onInput(start, parsed) for every <input> outside comments and raw text. */
function scanInputs(src, onInput) {
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) break;
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); i = e < 0 ? src.length : e + 3; continue; }
    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(lt, lt + 40));
    if (!m) { i = lt + 1; continue; }
    const tag = m[1].toLowerCase();
    if (tag === "input" && /[\s/>]/.test(src[lt + 6] || ">")) {
      const parsed = parseInputTag(src, lt);
      onInput(lt, parsed);
      i = Math.max(parsed.end, lt + 1);
      continue;
    }
    if (RAW_TEXT.includes(tag)) {
      const close = src.toLowerCase().indexOf(`</${tag}`, lt + 1 + tag.length);
      i = close < 0 ? src.length : close + 2 + tag.length;
      continue;
    }
    i = lt + 1 + tag.length;
  }
}

function blankSecretValues(html) {
  const src = String(html);
  const edits = [];
  scanInputs(src, (start, { attrs }) => {
    if (!isSecretInput(attrs)) return;
    for (const a of attrs) if (a.name === "value" && a.vs >= 0) edits.push(a);
  });
  let out = src;
  for (const a of edits.sort((x, y) => y.vs - x.vs)) out = out.slice(0, a.vs) + '""' + out.slice(a.ve);
  return out;
}

/** True when some secret input still carries a non-empty value (the backstop). */
function hasSecretValue(html) {
  let hit = false;
  scanInputs(String(html), (start, { attrs }) => {
    if (isSecretInput(attrs) && attrs.some((a) => a.name === "value" && a.value !== "")) hit = true;
  });
  return hit;
}

function mapStrings(v, fn) {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}
/** Apply `fn` to every string of a result: structuredContent, and each text item (as JSON when it parses). */
function mapResultStrings(response, fn) {
  if (!response || typeof response !== "object") return response;
  const out = { ...response };
  if (out.structuredContent !== undefined) out.structuredContent = mapStrings(out.structuredContent, fn);
  if (Array.isArray(out.content)) {
    out.content = out.content.map((item) => {
      if (!item || item.type !== "text" || typeof item.text !== "string") return item;
      try { return { ...item, text: JSON.stringify(mapStrings(JSON.parse(item.text), fn), null, 2) }; }
      catch { return { ...item, text: fn(item.text) }; }
    });
  }
  return out;
}

/** `blank` is a test seam (a blanker that misses must be caught by the re-scan). */
function filterHtmlResult(response, blank = blankSecretValues) {
  const out = mapResultStrings(response, blank);
  let leak = false;
  mapResultStrings(out, (t) => { if (hasSecretValue(t)) leak = true; return t; });
  if (leak) return { isError: true, content: [{ type: "text", text: "[mcp-relay] content_get-as-html output withheld (plain-flags relay): a secret field's value survived the blanking." }] };
  return out;
}

/**
 * Playwright error text quotes the element it was acting on — attributes and
 * all, a page-mirrored value included — under "Call log:" (review round 3 E).
 * Everything from "Call log:" on is cut from every string of every result.
 */
function stripCallLog(text) {
  const i = String(text).indexOf("Call log:");
  return i < 0 ? text : `${String(text).slice(0, i)}[call log removed by the plain-flags relay]`;
}

/** tabs_list in this profile (review round 4 M5): a URL as origin + path — no query, no fragment (codes, tokens, magic links). */
function urlOriginPath(text) {
  const t = String(text);
  if (!/^https?:\/\//i.test(t)) return text;
  try { const u = new URL(t); return u.origin + u.pathname; } catch { return text; }
}

/** Screenshot results: `annotations` never leave (review round 3 C); images pass. */
function stripAnnotations(response) {
  if (!response || typeof response !== "object") return response;
  const drop = (o) => { if (o && typeof o === "object" && !Array.isArray(o)) { const { annotations, ...rest } = o; void annotations; return rest; } return o; };
  const out = { ...response };
  if (out.structuredContent !== undefined) out.structuredContent = drop(out.structuredContent);
  if (Array.isArray(out.content)) {
    out.content = out.content.map((item) => {
      if (!item || item.type !== "text" || typeof item.text !== "string") return item;
      try { return { ...item, text: JSON.stringify(drop(JSON.parse(item.text)), null, 2) }; }
      catch { return /"?annotations"?\s*:/.test(item.text) ? { type: "text", text: WITHHELD("content_take-screenshot") } : item; }
    });
  }
  return out;
}

/** Drop a navigation result's snapshot fields; a result without them passes unchanged. */
function stripNavSnapshot(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const copy = { ...obj };
  for (const k of [...NAV_SNAPSHOT_KEYS, "annotations"]) delete copy[k];
  return copy;
}

const WITHHELD = (name) => `[mcp-relay] ${name} output withheld (plain-flags relay): it could not be parsed to strip bodies and cookie headers.`;

/** Strip a JSON-carrying result with `strip`; anything unparseable is withheld (fail closed). */
function filterJsonResult(name, response, strip) {
  if (!response || typeof response !== "object" || response.isError) return response;
  const out = { ...response };
  if (out.structuredContent !== undefined) {
    const s = strip(out.structuredContent);
    if (s) out.structuredContent = s; else delete out.structuredContent;
  }
  if (Array.isArray(out.content)) {
    out.content = out.content.map((item) => {
      if (!item || item.type !== "text") return { type: "text", text: WITHHELD(name) };
      let parsed;
      try { parsed = JSON.parse(item.text); } catch { return { type: "text", text: WITHHELD(name) }; }
      const s = strip(parsed);
      return s ? { ...item, text: JSON.stringify(s, null, 2) } : { type: "text", text: WITHHELD(name) };
    });
  }
  return out;
}

/**
 * @param {object} o
 * @param {ReturnType<import('./plainflags-signin-guard.js').createSigninPolicy>} o.signin
 * @param {() => (object|null)} o.getGuard   the live sign-in guard (null while no Brave)
 * @param {() => Promise<object>} o.getUpstream
 * @param {(text: string) => void} [o.notice]  text for the next tool result
 * @param {(m: string) => void} [o.log]
 */
function createPlainflagsPolicy({ signin, getGuard = () => null, getUpstream, notice = () => {}, log = () => {}, lock = null,
  screenshotDir = path.join(os.tmpdir(), `browser-mcp-relay-plainflags-shots-${process.pid}`) }) {
  /** Delete every screenshot file a withheld result names (review round 4 L7). */
  function deleteScreenshots(response) {
    const names = [];
    mapResultStrings(response, (t) => { if (typeof t === "string" && t.startsWith(screenshotDir + path.sep)) names.push(t); return t; });
    for (const f of names) {
      const real = path.resolve(f);
      if (!real.startsWith(path.resolve(screenshotDir) + path.sep)) continue;
      try { fs.rmSync(real, { force: true }); } catch { /* gone */ }
    }
  }
  // The lock (round 3 A): the primary protection; the filters below are the second layer.
  const theLock = lock || createLock({
    getContext: () => (globalThis.__relayBridge ? globalThis.__relayBridge.context : null),
    notice, log, accounts: signin.accounts,
  });
  /**
   * (g) and the list's additions / refusals (review round 1 items 2 and 6).
   * Runs AFTER ensureBrave (which re-arms a dead guard). A change is committed
   * only once applied: a removal whose clear fails stays pending and is
   * retried on the next call (and this call is refused).
   */
  async function applyListChanges() {
    const c = signin.pendingChanges();
    if (c.added.length === 0 && c.removed.length === 0 && c.refused.length === 0) return;
    if (c.removed.length > 0) {
      const guard = getGuard();
      if (guard && typeof guard.alive === "function" && !guard.alive()) {
        throw new Error("the sign-in guard is down — it is re-armed on the next browser call, which then clears the removed account");
      }
      // No Brave: the next launch's clear (§5.6 (6)(c)) covers every not-listed account.
      if (guard) {
        const out = await guard.clearAccounts(c.removed, "taken off the sign-in list");
        const errs = (out || []).flatMap((o) => o.errors || []);
        if (errs.length > 0) throw new Error(`clear failed: ${errs.join("; ")}`);
      }
    }
    signin.commit(c);
    for (const n of c.added) notice(`[browser-mcp-relay] PLAIN-FLAGS: "${n}" is ON the sign-in list (its claude-ask grants it) — its login page is allowed in this browser from now. Logins are typed by Trevor only.`);
    if (c.removed.length > 0) notice(`[browser-mcp-relay] PLAIN-FLAGS: ${c.removed.map((a) => a.name).join(", ")} taken off the sign-in list — its cookies and storage were cleared now.`);
    for (const r of c.refused) notice(`[browser-mcp-relay] PLAIN-FLAGS: sign-in list entry "${r.name}" REFUSED (${r.reason}) — treated as NOT listed.`);
  }

  async function sweep() {
    const guard = getGuard();
    if (!guard) return;
    const cleared = await guard.sweep();
    if (cleared.length > 0) {
      notice(`[browser-mcp-relay] PLAIN-FLAGS: deleted the session cookie(s) of ${cleared.join(", ")} on arrival (not on the sign-in list); its storage was cleared too.`);
    }
  }

  return {
    mode: pfMode.PLAINFLAGS,
    modeLine: pfMode.MODE_LINE,
    lock: theLock,

    filterToolsList(tools) {
      return tools.filter((t) => ALLOW.has(t.name)).map((t) => {
        if (t.name === "o11y_get-http-requests") return withoutProps(t, O11Y_FLAGS);
        if (t.name === "capture_xhr") return withoutProps(t, ["includeBody"]);
        if (KEY_GUARDED.has(t.name)) return withoutProps(t, [sync.OPT_IN]);
        if (SNAPSHOT_NAV.has(t.name)) return withoutProps(t, ["includeSnapshot", "snapshotOptions"]);
        if (t.name === "content_take-screenshot") return withoutProps(t, [...ANNOTATE_KEYS, "outputPath"]);
        return t;
      });
    },

    /**
     * Before the call. `ctx.ensureBrave()` launches Brave when the tool needs
     * it. Resolves { refusal } or { args } (the args to run with).
     */
    async beforeCall(name, args, ctx = {}) {
      // Every refusal, from any path (layer 1 included), leaves with its URLs scrubbed (round 6 item 4).
      const r = await this._beforeCall(name, args, ctx);
      return r && r.refusal ? { refusal: mapResultStrings(r.refusal, scrubUrls) } : r;
    },

    async _beforeCall(name, args, ctx = {}) {
      const a = args && typeof args === "object" ? args : {};
      const ensureBrave = typeof ctx.ensureBrave === "function" ? ctx.ensureBrave : async () => {};
      // Static checks first — no browser work for a refused call.
      if (!ALLOW.has(name)) {
        return { refusal: refuse(`"${name}" is not offered in the plain-flags relay — ${pfMode.refusedWhy(name)}. Use the default browser-mcp-relay for it.`) };
      }
      const layer1 = signin.checkToolArgs(name, a);
      if (layer1) return { refusal: layer1 };
      for (const k of URL_KEYS) {
        const p = urlSchemeProblem(a[k]);
        if (p) return { refusal: refuse(`${name} ${k}: ${p}`) };
      }
      for (const k of SELECTOR_KEYS) {
        if (a[k] === undefined) continue;
        const p = selectorProblem(a[k]);
        if (p) return { refusal: refuse(`${name} ${k}: ${p}`) };
      }
      let out = a;
      if (name === "content_take-screenshot") {
        const set = ANNOTATE_KEYS.filter((k) => a[k]);
        if (set.length > 0) return { refusal: refuse(`content_take-screenshot with ${set.join(", ")} — annotations name the page's elements (an input's value included); take the plain screenshot`) };
        // L7: the file goes to a relay-private dir (0700), whatever was asked.
        try { fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
        out = { ...a, annotate: false, annotateContent: false, annotateCursorInteractive: false, outputPath: screenshotDir };
      }
      if (SNAPSHOT_NAV.has(name) && a.screenshotOptions && typeof a.screenshotOptions === "object") {
        const set = ANNOTATE_KEYS.filter((k) => a.screenshotOptions[k]);
        if (set.length > 0) return { refusal: refuse(`${name} with screenshotOptions.${set.join(", ")} — annotations name the page's elements`) };
      }
      if (name === "o11y_get-http-requests") {
        const set = O11Y_FLAGS.filter((f) => a[f]);
        if (set.length > 0) return { refusal: refuse(`o11y_get-http-requests with ${set.join(", ")} — no request headers, response headers or response bodies leave this relay (request headers can carry Authorization or the agency's x-as-qa header, response headers Set-Cookie, a body a session token); challenge_detect reads cf-mitigated itself`) };
      }
      if (SNAPSHOT_NAV.has(name)) {
        if (a.includeSnapshot === true) return { refusal: refuse(`${name} with includeSnapshot: true — an ARIA snapshot carries typed input values; use content_take-screenshot or content_get-as-text`) };
        out = { ...a, includeSnapshot: false };
        if (a.screenshotOptions && typeof a.screenshotOptions === "object") {
          out.screenshotOptions = { ...a.screenshotOptions, annotate: false, annotateContent: false, annotateCursorInteractive: false };
        }
        if (a.includeScreenshot === true) {
          try { fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
          out.screenshotOptions = { ...(out.screenshotOptions || {}), outputPath: screenshotDir };
        }
      }
      if (name === "capture_xhr") {
        if (a.includeBody === true) return { refusal: refuse("capture_xhr with includeBody: true — response bodies never leave this relay (they can carry session tokens)") };
        out = { ...a, includeBody: false };
      }
      if (name === "interaction_fill") {
        const p = selectorProblem(a.selector);
        if (p) return { refusal: refuse(`interaction_fill: ${p}`) };
      }
      if (name === "form_fill" && Array.isArray(a.fields)) {
        for (const f of a.fields) {
          const p = selectorProblem(f && f.selector);
          if (p) return { refusal: refuse(`form_fill: ${p}`) };
        }
      }
      if (name === "interaction_select") {
        const p = selectorProblem(a.selector);
        if (p) return { refusal: refuse(`interaction_select: ${p}`) };
      }
      if (name === "interaction_press-key") {
        const p = pressKeyProblem(a.key);
        if (p) return { refusal: refuse(`interaction_press-key: ${p}`) };
        if (a.selector !== undefined) {
          const sp = selectorProblem(a.selector);
          if (sp) return { refusal: refuse(`interaction_press-key: ${sp}`) };
        }
      }
      if (KEY_GUARDED.has(name) && sync.OPT_IN in out) {
        const { [sync.OPT_IN]: dropped, ...rest } = out;
        void dropped;
        out = rest;
      }

      await ensureBrave();
      // (g) + additions: applied after ensureBrave, committed only on success.
      try { await applyListChanges(); } catch (e) { return { refusal: refuse(`the sign-in list changed and the change could not be applied (${e.message}) — retry`) }; }
      try { await sweep(); } catch (e) { return { refusal: refuse(`the sign-in guard's cookie sweep failed (${e.message}) — refused until it runs`) }; }

      // THE LOCK (round 3 A): nothing but relay_status / tabs_list runs while
      // a password or one-time code is on a tab, or a tab is on a sign-in page.
      if (!LOCK_EXEMPT.includes(name)) {
        let st;
        try { st = await theLock.probe(); } catch (e) { return { refusal: refuse(`${LOCK_TEXT} (the lock probe failed: ${e.message} — fail closed)`) }; }
        if (st.locked) return { refusal: { isError: true, content: [{ type: "text", text: `[mcp-relay] ${LOCK_TEXT} (${st.reason})` }] } };
      }

      if (KEY_GUARDED.has(name) && sync.isDesynced()) {
        return { refusal: refuse(`${name} while upstream's tab is not the selected one (the opt-in ${sync.OPT_IN} is not honoured here) — sync the tab with tabs_select / tabs_new first. ${sync.warning() || ""}`.trim()) };
      }
      // Every fill-like tool: inspect the element the action will reach on the
      // page it runs on (upstream's, for interaction_*).
      const upstreamCheck = name === "interaction_fill" ? "fill" : name === "interaction_select" ? "select"
        : (name === "interaction_press-key" && typeof a.selector === "string") ? "focus" : null;
      if (upstreamCheck) {
        let info = null;
        try { info = await upstreamFieldInfo(getUpstream, a.selector, upstreamCheck); } catch (e) { log(`plain-flags ${upstreamCheck} check failed: ${e.message}`); }
        const why = secretFieldProblem(info, upstreamCheck);
        if (why) return { refusal: refuse(`${name} on ${JSON.stringify(a.selector)}: ${why} — logins are typed by Trevor, never by a session`) };
      }
      if (name === "form_fill" && Array.isArray(a.fields)) {
        for (const f of a.fields) {
          if (!f || typeof f.selector !== "string") continue; // form_fill validates shapes itself
          const why = secretFieldProblem(await relayFieldInfo(f.selector, "fill"), "fill");
          if (why) return { refusal: refuse(`form_fill into ${JSON.stringify(f.selector)}: ${why} — logins are typed by Trevor, never by a session; nothing was filled`) };
        }
      }
      return { args: out };
    },

    /**
     * An error THROWN out of a call (an upstream JSON-RPC error, a closed
     * client) — review round 4 L8: its message gets the same treatment as a
     * result: the call log cut, and the lock's withhold if the lock came on.
     * RelayServer uses the returned Error for the client and the Inspector feed.
     */
    async filterThrown(name, err) {
      let msg = scrubUrls(stripCallLog(String((err && err.message) || err)));
      if (!LOCK_EXEMPT.includes(name)) {
        let st = null;
        try { st = await theLock.probe(); } catch { st = { locked: true, reason: "the lock probe failed — fail closed" }; }
        if (st.locked) msg = `[mcp-relay] ${LOCK_TEXT} (${st.reason}) — this call's error was withheld: the lock came on while it ran.`;
      }
      const out = new Error(msg);
      if (err && err.code !== undefined) out.code = err.code;
      return out;
    },

    /** After the call: the lock again (a secret typed DURING the call withholds its result), the sweep backstop, then the filters. */
    async afterCall(name, response) {
      if (!LOCK_EXEMPT.includes(name)) {
        let st = null;
        try { st = await theLock.probe(); } catch { st = { locked: true, reason: "the lock probe failed — fail closed" }; }
        if (st.locked) {
          deleteScreenshots(response);
          return { isError: true, content: [{ type: "text", text: `[mcp-relay] ${LOCK_TEXT} (${st.reason}) — the result of this call was withheld: the lock came on while it ran.` }] };
        }
      }
      try { await sweep(); } catch (e) { log(`plain-flags post-call sweep failed: ${e.message}`); }
      response = mapResultStrings(mapResultStrings(response, stripCallLog), scrubUrls);
      if (name === "content_take-screenshot") return stripAnnotations(response);
      // M5 (round 4) + round 5 item 5: every tabs_* result reports URLs as origin + path.
      if (name === "tabs_list" || name === "tabs_select" || name === "tabs_new" || name === "tabs_close") return mapResultStrings(response, urlOriginPath);
      if (name === "o11y_get-http-requests") return filterJsonResult(name, response, stripItems);
      if (name === "capture_xhr") return filterJsonResult(name, response, stripCapture);
      if (name === "content_get-as-html") return filterHtmlResult(response);
      if (SNAPSHOT_NAV.has(name)) return filterJsonResult(name, response, stripNavSnapshot);
      return response;
    },
  };
}

module.exports = {
  createPlainflagsPolicy, selectorProblem, secretFieldProblem, pressKeyProblem, fieldProbe,
  upstreamFieldInfo, relayFieldInfo, filterJsonResult, stripItems, stripCapture, O11Y_FLAGS, blankSecretValues,
  hasSecretValue, stripCallLog, urlSchemeProblem, stripAnnotations, CAPTURE_HEADERS, filterHtmlResult, urlOriginPath,
  scrubUrls, secretName,
};
