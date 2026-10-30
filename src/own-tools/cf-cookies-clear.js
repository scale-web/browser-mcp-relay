// cf_cookies_clear {origin} — after a failed plain-flags try (spec v8 §5.6 (9),
// review r6 #9, r7 #6). Registered ONLY in the plain-flags relay: in the
// default relay a whole-site clear would log a lane out of that site (the
// measured canva clear removed all 17 cookies and landed on the login page).
//
//   site with NO account on the sign-in allowlist (every site at start): delete
//     EVERY cookie of that registrable domain (partitioned copies included) —
//     the measured fix was clearCookies(), all 17 canva cookies (memory,
//     2026-08-25) — plus every challenges.cloudflare.com cookie partitioned
//     under the site (the widget keeps its state there, not on the page origin);
//   site whose account IS listed: only cf_clearance, __cf_bm and _cfuvid
//     (partitioned or not) and the challenge host's partition, so the account's
//     session survives — that those three names suffice is INFERRED.
// Mechanism: CDP Storage.getCookies (browser) → Network.deleteCookies with the
// cookie's own partitionKey (page session) → a re-read reports what remains
// (§10 #24). Returns names and counts, never values.
//
// "Registrable domain" is the last two labels, or three under a common
// two-level suffix (co.uk, com.au, …) — a heuristic, no public-suffix list ships
// with the relay; an IP address or a single label is its own site.

"use strict";

const { getActivePage } = require("./_active-page.js");
const jar = require("../cdp-cookies.js");
const { KNOWN_ACCOUNTS } = require("../known-accounts.js");

const CF_NAMES = Object.freeze(["cf_clearance", "__cf_bm", "_cfuvid"]);
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "ltd", "plc", "or", "ne", "go", "gob", "nic", "sch"]);

function registrableDomain(host) {
  const h = jar.normHost(host);
  if (!h) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return h;
  const labels = h.split(".");
  if (labels.length <= 2) return h;
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (tld.length === 2 && SECOND_LEVEL.has(sld)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

const DEFAULT_DEPS = {
  signin: null, // plainflags-signin.js loader (configure)
  accounts: KNOWN_ACCOUNTS,
  sendBrowser: (bridge) => {
    const { _cdpCall } = require("../cdp-bridge.js");
    return (m, p) => _cdpCall(bridge.wsEndpoint, m, p);
  },
  pageSession: async (bridge) => {
    const page = getActivePage(bridge.context) || bridge.context.pages()[0];
    if (!page) throw new Error("no pages open");
    const s = await bridge.context.newCDPSession(page);
    return { send: (m, p) => s.send(m, p), close: () => s.detach().catch(() => {}) };
  },
};
let deps = { ...DEFAULT_DEPS };

function fail(msg) {
  return { content: [{ type: "text", text: `cf_cookies_clear: ${msg}` }], isError: true };
}

module.exports = {
  name: "cf_cookies_clear",
  description:
    "PLAIN-FLAGS RELAY ONLY. After a failed plain-flags try: clear the site's Cloudflare state. On a site with no account on " +
    "the sign-in list (every site at start) it deletes EVERY cookie of the site's registrable domain (partitioned copies " +
    "included) plus the challenges.cloudflare.com cookies partitioned under it; on a site whose account is listed, only " +
    "cf_clearance, __cf_bm, _cfuvid and the challenge partition. Returns names and counts, never values.",
  inputSchema: {
    type: "object",
    properties: { origin: { type: "string", description: "The site's origin, e.g. https://www.example.com." } },
    required: ["origin"],
    additionalProperties: false,
  },
  handler: async (args = {}) => {
    let host;
    try {
      const u = new URL(String(args && args.origin || "").trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http(s)");
      host = jar.normHost(u.hostname);
    } catch { return fail("`origin` must be an http(s) origin such as https://www.example.com"); }
    const site = registrableDomain(host);
    if (!site || !site.includes(".")) return fail(`cannot tell the site of ${host}`);
    if (!deps.signin) return fail("the sign-in list is not configured (plain-flags relay only) — refused");
    const bridge = globalThis.__relayBridge;
    if (!bridge) return fail("bridge missing");
    const names = typeof deps.listedNames === "function" ? deps.listedNames() : deps.signin.load().names;
    const listed = deps.accounts.filter((a) => names.has(a.name) &&
      (a.cookieOrigins || []).some((o) => jar.domainWithinSite(jar.hostOfOrigin(o), site)));
    const restricted = listed.length > 0;
    const sendBrowser = deps.sendBrowser(bridge);
    let all;
    try { all = await jar.getAllCookies(sendBrowser); } catch (e) { return fail(`cookie read failed: ${e.message}`); }
    const targets = all.filter((c) => {
      if (!c || typeof c.name !== "string") return false;
      if (jar.domainMatchesHost(jar.CHALLENGE_HOST, c.domain)) {
        const ps = jar.partitionSite(c.partitionKey);
        return !!ps && jar.domainWithinSite(ps, site);
      }
      if (!jar.domainWithinSite(c.domain, site)) return false;
      return restricted ? CF_NAMES.includes(c.name) : true;
    });
    let session;
    let del;
    try {
      session = await deps.pageSession(bridge);
      del = await jar.deleteCookies(session.send, targets);
    } catch (e) {
      return fail(`delete failed: ${e.message}`);
    } finally {
      if (session) await session.close();
    }
    let after = [];
    try { after = await jar.getAllCookies(sendBrowser); } catch { /* reported below as unknown */ }
    const remaining = targets.filter((t) => after.some((a) => jar.sameCookie(a, t)));
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          origin: `${new URL(args.origin).protocol}//${host}`,
          site,
          scope: restricted ? `cloudflare-only (listed account: ${listed.map((a) => a.name).join(", ")})` : "all cookies of the site",
          matched: targets.length,
          deleted: del.deleted - remaining.length,
          cookies: targets.map(jar.describe),
          remaining: remaining.map(jar.describe),
          errors: del.errors,
        }, null, 2),
      }],
      ...(remaining.length > 0 || del.errors.length > 0 ? { isError: true } : {}),
    };
  },
  /** `listedNames`: the VERIFIED sign-in list (plainflags-signin-guard.js names()). */
  configure({ signin, accounts, listedNames } = {}) {
    deps = { ...deps, ...(signin ? { signin } : {}), ...(accounts ? { accounts } : {}), ...(listedNames ? { listedNames } : {}) };
  },
  _setDeps(over) { deps = { ...deps, ...over }; },
  _resetDeps() { deps = { ...DEFAULT_DEPS }; },
  registrableDomain,
  CF_NAMES,
};
