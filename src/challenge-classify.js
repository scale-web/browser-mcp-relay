// challenge-classify.js — pure half of challenge_detect (spec v8 §2 + §5.2).
// No I/O: the tool (own-tools/challenge-detect.js) gathers signals (curl
// headers, dig, the frame tree, the cookie jar) and this module decides.
//
// The §2 table, FIRST MATCHING ROW WINS, top to bottom. It must match the
// `cf-challenge` skill's rows and owner names exactly:
//   1 highlevel   x-ghl-serve-region, or CNAME sites.ludicrous.cloud, or A 162.159.140.166
//   2 shopify     powered-by: Shopify or shopify-complexity-score, or A 23.227.38.x, or CNAME shops.myshopify.com
//   3 access      302 to *.cloudflareaccess.com
//   4 agency-test the test-host list
//   5 agency      registrable domain in the 8 agency zones (this list, not the NS pair)
//   6 workersdev  *.scale-265.workers.dev
//   7 vendor      anything else with cf-ray
// go.revivemyhair.com and aloeheath.com sit on agency nameservers but are
// HighLevel; the test host sits in an agency zone but is meant to challenge —
// hence rows 1 and 4 above row 5.

"use strict";

const { matchLoginUrl } = require("./known-accounts.js");

const OWNERS = Object.freeze(["highlevel", "shopify", "access", "agency-test", "agency", "workersdev", "vendor", "none"]);
const KINDS = Object.freeze(["interstitial", "turnstile", "ratelimit", "none"]);

const TEST_HOSTS = Object.freeze(["cf-test.automatedscalinghq.com"]);
// Scale@automatedscaling.com account. Excluded on purpose (same NS, DNS-only to
// someone else's edge): aloeheath.com (HighLevel), aloestrips.com (Shopify).
const AGENCY_ZONES = Object.freeze([
  "revivemyhair.com", "cannonlandscape.com", "cannon-landscaping.com", "walletreminder.com",
  "aloewellnessclinic.com", "myaloehealth.com", "myaloewellness.com", "automatedscalinghq.com",
]);
const WORKERSDEV_SUFFIX = ".scale-265.workers.dev";

const GHL_CNAME = "sites.ludicrous.cloud";
const GHL_A = "162.159.140.166";
const SHOPIFY_CNAME = "shops.myshopify.com";
const SHOPIFY_A_PREFIX = "23.227.38.";

const CHALLENGE_HOST = "challenges.cloudflare.com";
const CF_COOKIE_NAMES = Object.freeze(["cf_clearance", "__cf_bm", "_cfuvid"]);

// Owner → the route a session takes when no plain-flags try applies (§2 step 2).
const OWNER_ROUTE = Object.freeze({
  highlevel: "§3.1",
  shopify: "§3.2",
  access: "§3.3",
  "agency-test": "expected",
  agency: "§3.3",
  workersdev: "report",
  vendor: "§3.4",
  none: "none",
});

// The plain-flags mode is not built (D22: measured first, phase 1b; built in
// 1c only if that passes). The 1c build flips this; until then every
// plainflagsEligible is false with reason `not-built`.
const PLAINFLAGS_BUILT = false;

// Bounds on anything read from curl, dig or the page (review r2 #4).
const MAX_HOST_LEN = 253;
const MAX_ANSWERS = 20;
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE = 200;

function normHost(h) {
  return String(h || "").toLowerCase().replace(/\.+$/, "");
}

function hostInZone(host, zone) {
  return host === zone || host.endsWith("." + zone);
}

/** Lines of `dig +short` output → { cnames, as } (trailing dots dropped). */
function parseDig(text) {
  const cnames = [];
  const as = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim().replace(/\.+$/, "").toLowerCase();
    if (!line || line.startsWith(";") || line.length > MAX_HOST_LEN) continue;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(line)) { if (as.length < MAX_ANSWERS) as.push(line); }
    else if (/^[a-z0-9.-]+$/.test(line)) { if (cnames.length < MAX_ANSWERS) cnames.push(line); }
  }
  return { cnames, as };
}

// Response headers kept from `curl -sI` — the skill's grep list. Anything else
// (set-cookie above all) is dropped before it reaches a result.
const KEPT_HEADER = /^(server|cf-ray|cf-mitigated|x-ghl-serve-region|powered-by|shopify-complexity-score|x-shopify[a-z0-9-]*|x-sorting-hat[a-z0-9-]*|platform|location|cf-access[a-z0-9-]*)$/;

/**
 * `curl -sI` output → { status, headers } with only the kept header names.
 * `location` is reduced to its host: a redirect URL can carry tokens.
 */
function parseCurlHead(text) {
  let status = null;
  const headers = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    const st = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line);
    if (st) {
      // A 100 Continue / proxy block can precede the real one: keep the last.
      status = Number(st[1]);
      for (const k of Object.keys(headers)) delete headers[k];
      continue;
    }
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!KEPT_HEADER.test(name)) continue;
    if (!(name in headers) && Object.keys(headers).length >= MAX_HEADERS) continue;
    let value = line.slice(i + 1).trim();
    if (name === "location") {
      try { value = new URL(value, "https://placeholder.invalid/").hostname; } catch { value = ""; }
    }
    headers[name] = value.slice(0, MAX_HEADER_VALUE);
  }
  return { status, headers };
}

// GHL's form and booking widgets render in their own cross-origin iframe on a
// HighLevel domain: `api.leadconnectorhq.com` (spec §2, KB 10-29 §5/§6),
// `widgets.leadconnectorhq.com` and `link.`/`app.msgsndr.com` (GHL KB). Both
// domains are HighLevel's own, so the suffix decides. A white-label `link.<client>`
// host cannot be told from its name and is not listed.
const GHL_WIDGET_DOMAINS = Object.freeze(["leadconnectorhq.com", "msgsndr.com"]);

function isGhlWidgetHost(host) {
  const h = normHost(host);
  return GHL_WIDGET_DOMAINS.some((d) => hostInZone(h, d));
}

function hasMarkers(f) {
  return !!f && ((f.challengeIframes || 0) > 0 || (f.turnstileInputs || []).length > 0 || (f.turnstileDivs || 0) > 0);
}

/**
 * Kind — from BROWSER evidence only (review r1 #1): the top title, the
 * interstitial's `_cf_chl_opt`, the frame markers and the page's own
 * navigation status. A separate `curl` (other TLS fingerprint, no cookies)
 * says nothing about what this page shows, so it never decides the kind.
 * @param {object} s
 * @param {Array<object>} s.frames — per frame: { host, isTop, challengeFrame,
 *   parentHost, title, chlOpt, challengeIframes, turnstileInputs: number[]
 *   (value LENGTHS), turnstileDivs, errorCodes: string[] }
 * @param {number|null} s.navStatus — the page's navigation status
 */
function classifyKind({ frames = [], navStatus = null } = {}) {
  const top = frames.find((f) => f.isTop) || {};
  if (/^\s*just a moment/i.test(top.title || "") || top.chlOpt === true) return "interstitial";
  if (frames.some((f) => f.challengeFrame || hasMarkers(f))) return "turnstile";
  if (navStatus === 429) return "ratelimit";
  return "none";
}

/**
 * A Turnstile has passed — not a wall (review r1 #7) — only when EVERY frame
 * showing a widget holds a token input and every such input is filled
 * (review r2 #3): one filled form beside an unsolved one is still a wall.
 */
function turnstilePassed(frames) {
  const marked = (frames || []).filter(hasMarkers);
  return marked.length > 0 && marked.every((f) => {
    const ins = f.turnstileInputs || [];
    return ins.length > 0 && ins.every((n) => n > 0);
  });
}

/** DNS answers that rows 1/2 read: CNAME/A of HighLevel or Shopify. */
function dnsOwner(dns) {
  const cnames = (dns && dns.cnames) || [];
  const as = (dns && dns.as) || [];
  if (cnames.includes(GHL_CNAME) || as.includes(GHL_A)) return "highlevel";
  if (as.some((a) => a.startsWith(SHOPIFY_A_PREFIX)) || cnames.includes(SHOPIFY_CNAME)) return "shopify";
  return null;
}

/**
 * Hosts of the frames that may hold the widget, in frame order: child frames
 * with markers, then the parents of challenge frames. The top host is left
 * out (same-host frames classify as the page itself).
 */
function widgetCandidates(frames) {
  const top = (frames || []).find((f) => f.isTop) || {};
  const marked = frames.filter((f) => !f.isTop && !f.challengeFrame && hasMarkers(f) && f.host).map((f) => f.host);
  const parents = frames.filter((f) => f.challengeFrame && f.parentHost).map((f) => f.parentHost);
  return [...new Set([...marked, ...parents])].filter((h) => h !== top.host);
}

/**
 * The host of the frame whose owner is the wall's owner, or null for the page
 * itself. A HighLevel frame — by domain, or by its own DNS (`dnsByHost`, the
 * white-label case: a form served from the location's own domain) — wins
 * whenever one holds the widget, wherever it sits in the frame order (review
 * r2 #1/#2). Otherwise: the top document holding markers → null; else the
 * first marked child (null when it is on the top host); else a challenge
 * frame's parent.
 */
function widgetFrameHost(frames, dnsByHost = {}) {
  frames = frames || [];
  const top = frames.find((f) => f.isTop) || {};
  const candidates = widgetCandidates(frames);
  const ghl = candidates.find((h) => isGhlWidgetHost(h) || dnsOwner(dnsByHost[h]) === "highlevel");
  if (ghl) return ghl;
  if (hasMarkers(top) || top.chlOpt === true) return null;
  const child = frames.find((f) => !f.isTop && !f.challengeFrame && hasMarkers(f) && f.host);
  if (child) return child.host === top.host ? null : child.host;
  const chl = frames.find((f) => f.challengeFrame && f.parentHost);
  if (chl && chl.parentHost !== top.host) return chl.parentHost;
  return null;
}

/**
 * The §2 owner row, first match wins. Returns { owner, row }.
 * `host` is the page host; `headers`/`dns` are curl's and dig's for it (they
 * decide the OWNER only). Access is the browser sitting on the Access login
 * page — curl's own 302 is a signal, never the owner (a signed-in browser has
 * the session curl lacks). When the widget is only in a child frame
 * (`widgetHost`), that frame's owner is the wall's owner: rows 5/6 are never
 * read off the top host then.
 */
function classifyOwner({ host, headers = {}, dns = { cnames: [], as: [] }, kind = "none", pageHost = null, widgetHost = null, widgetDns = null } = {}) {
  if (widgetHost) {
    if (isGhlWidgetHost(widgetHost)) return { owner: "highlevel", row: 1, from: `frame ${normHost(widgetHost)}` };
    // The frame's own DNS feeds rows 1 and 2 before the host lists (r2 #1).
    const r = classifyOwner({ host: widgetHost, dns: widgetDns || { cnames: [], as: [] }, kind, pageHost: widgetHost });
    return { ...r, from: `frame ${normHost(widgetHost)}` };
  }
  const h = normHost(host);
  const cnames = dns.cnames || [];
  const as = dns.as || [];
  // 1 HighLevel
  if ("x-ghl-serve-region" in headers || cnames.includes(GHL_CNAME) || as.includes(GHL_A) || isGhlWidgetHost(h)) {
    return { owner: "highlevel", row: 1 };
  }
  // 2 Shopify
  if (/shopify/i.test(headers["powered-by"] || "") || "shopify-complexity-score" in headers ||
      as.some((a) => a.startsWith(SHOPIFY_A_PREFIX)) || cnames.includes(SHOPIFY_CNAME)) {
    return { owner: "shopify", row: 2 };
  }
  // 3 Access — the browser is on the Access login page the 302 led to
  if (normHost(pageHost).endsWith(".cloudflareaccess.com")) return { owner: "access", row: 3 };
  // 4 test host
  if (TEST_HOSTS.includes(h)) return { owner: "agency-test", row: 4 };
  // 5 agency zones
  if (AGENCY_ZONES.some((z) => hostInZone(h, z))) return { owner: "agency", row: 5 };
  // 6 workers.dev
  if (h.endsWith(WORKERSDEV_SUFFIX)) return { owner: "workersdev", row: 6 };
  // 7 vendor — cf-ray. A Cloudflare challenge seen in the page itself (a
  // Turnstile widget on a site that is not proxied by Cloudflare, or a header
  // read that failed) is Cloudflare's too, so it counts here.
  if ("cf-ray" in headers || "cf-mitigated" in headers || kind === "interstitial" || kind === "turnstile") {
    return { owner: "vendor", row: 7 };
  }
  return { owner: "none", row: null };
}

/**
 * The protected app's host on an Access login URL
 * (`<team>.cloudflareaccess.com/cdn-cgi/access/login/<app host>?…`), or null.
 */
function accessAppHost(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!normHost(u.hostname).endsWith(".cloudflareaccess.com")) return null;
  const m = /^\/cdn-cgi\/access\/login\/([^/?#]+)/i.exec(u.pathname);
  if (!m) return null;
  let h;
  try { h = decodeURIComponent(m[1]).toLowerCase(); } catch { return null; }
  if (h.length > MAX_HOST_LEN || h.split(".").some((l) => l.length > 63)) return null;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) ? h : null;
}

/**
 * The route when no plain-flags try applies (§2 step 2). No wall → `none`
 * for every owner (review r1 #4), Access aside; an in-page Turnstile follows
 * the widget branch of the tree, not the owner's interstitial route.
 */
function baseRoute(owner, kind) {
  if (owner === "access") return OWNER_ROUTE.access;
  if (kind === "none") return "none";
  if (owner === "agency-test") return OWNER_ROUTE["agency-test"];
  if (owner === "none") return "none";
  if (kind === "turnstile") return "in-page-turnstile";
  return OWNER_ROUTE[owner] || "none";
}

/** §2 step 2, the in-page Turnstile branch — the three ways on. */
function turnstileGuidance(owner) {
  const ghl = owner === "highlevel";
  return [
    "verify the page only (copy, links, pixel beacons, layout, mobile, field show/hide) → no submission needed; carry on" + (ghl ? " (§3.1 A)" : ""),
    ghl ? "exercise the backend (workflow actions, tags, email, stage) → the §3.1 B0 GO, then the HighLevel API with a ZZTEST contact (§3.1 B)"
        : "exercise what the form does → the site's official API (§3.4)",
    ghl ? "need the real widget path (form-submitted trigger + field mapping, appointment trigger, redirect rule, order form) → the §3.1 B0 GO, then the §4 one-click human step, verified by API (§3.1 C)"
        : "need the real widget path → the §4 one-click human step in the user's own browser",
  ];
}

/**
 * plainflagsEligible + reason + route + clickBudget (§5.2).
 * @param {object} o
 * @param {string} o.owner
 * @param {string} o.kind
 * @param {string} o.url        the page URL (for the login matchers)
 * @param {boolean} [o.built]   PLAINFLAGS_BUILT (test seam)
 * @param {"default"|"plainflags"} [o.mode]
 * @param {Set<string>} [o.signinNames] names on plainflags-signin.json
 * @param {boolean} [o.clickSpent] a challenge_click was spent on this host in
 *   the last 10 min by any plain-flags relay (1c's shared count file). Defaults
 *   to true: no count file → no click budget (fail closed).
 */
function decideRoute({ owner, kind, url, built = PLAINFLAGS_BUILT, mode = "default", signinNames = new Set(), clickSpent = true }) {
  const base = baseRoute(owner, kind);
  const no = (reason, extra = {}) => ({ plainflagsEligible: false, reason, route: base, clickBudget: 0, ...extra });
  if (!built) return no("not-built");
  // owner `none` has no Cloudflare signal and no challenge marker: no wall.
  if (owner === "none") return no("kind");
  // Never Shopify, whatever the kind (its cause is request rate — r7 #13).
  if (owner !== "highlevel" && owner !== "vendor") return no("owner-route");
  if (kind !== "interstitial" && kind !== "turnstile") return no("kind");
  const login = matchLoginUrl(url);
  if (login && !signinNames.has(login.account.name)) return no("signin-not-listed", { signinAccount: login.account.name });
  if (mode === "plainflags") {
    return { plainflagsEligible: true, reason: "eligible", route: "plainflags-try", clickBudget: clickSpent ? 0 : 1 };
  }
  return { plainflagsEligible: true, reason: "eligible", route: "switch-to-plainflags-server", clickBudget: 0 };
}

/** One origin → the cookie-name state of §5.2 from a Storage.getCookies list. */
function partitionSite(pk) {
  if (!pk) return null;
  const s = typeof pk === "string" ? pk : pk.topLevelSite;
  if (typeof s !== "string" || s === "") return null;
  try { return normHost(new URL(s).hostname); } catch { return null; }
}

function domainMatches(host, cookieDomain) {
  const d = normHost(String(cookieDomain || "").replace(/^\.+/, ""));
  return !!d && (host === d || host.endsWith("." + d));
}

/**
 * NEVER-VALUES: a cookie is rebuilt from a fixed list of fields; `value` (and
 * anything else) never leaves this function.
 */
function describeCookie(c) {
  return {
    name: String(c.name),
    domain: String(c.domain || ""),
    path: String(c.path || "/"),
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite ? String(c.sameSite) : null,
    session: !!c.session,
    partitionKey: partitionSite(c.partitionKey) ? `https://${partitionSite(c.partitionKey)}` : null,
  };
}

/**
 * @param {string} origin  e.g. "https://go.example.com"
 * @param {Array<object>} jar  CDP Storage.getCookies().cookies
 * @returns {{ cfCookies: "none"|"present"|"partitioned", cookies: Array<object> }}
 */
function cfCookieState(origin, jar) {
  let host;
  try { host = normHost(new URL(origin).hostname); } catch { host = ""; }
  const site = [];
  const challenge = [];
  for (const c of Array.isArray(jar) ? jar : []) {
    if (!c || typeof c.name !== "string") continue;
    if (domainMatches(CHALLENGE_HOST, c.domain)) {
      // A challenge-host cookie counts only when it is partitioned under this site.
      const ps = partitionSite(c.partitionKey);
      if (ps && (host === ps || host.endsWith("." + ps))) challenge.push(c);
      continue;
    }
    if (CF_COOKIE_NAMES.includes(c.name) && domainMatches(host, c.domain)) site.push(c);
  }
  const all = [...site, ...challenge];
  let state = "none";
  if (all.length > 0) {
    const partitioned = challenge.length > 0 || site.some((c) => c.name === "cf_clearance" && partitionSite(c.partitionKey));
    state = partitioned ? "partitioned" : "present";
  }
  return { cfCookies: state, cookies: all.map(describeCookie) };
}

/** The outcome of a try from a fresh frame scan: passed or failed. */
function tryOutcome(kind, frames) {
  if (kind === "interstitial") return "failed";
  if (kind === "turnstile") return turnstilePassed(frames) ? "passed" : "failed";
  return "passed"; // the interstitial cleared and no widget is left
}

module.exports = {
  OWNERS, KINDS, TEST_HOSTS, AGENCY_ZONES, WORKERSDEV_SUFFIX, OWNER_ROUTE, CF_COOKIE_NAMES, CHALLENGE_HOST,
  PLAINFLAGS_BUILT,
  GHL_WIDGET_DOMAINS,
  parseDig, parseCurlHead, classifyKind, classifyOwner, decideRoute, cfCookieState, describeCookie, tryOutcome,
  MAX_HOST_LEN, MAX_ANSWERS, MAX_HEADERS, MAX_HEADER_VALUE,
  isGhlWidgetHost, widgetFrameHost, widgetCandidates, dnsOwner, turnstilePassed, accessAppHost, baseRoute, turnstileGuidance,
};
