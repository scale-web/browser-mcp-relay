// cdp-cookies.js — cookie-jar helpers shared by the plain-flags sign-in guard
// and cf_cookies_clear (spec v8 §5.6 (6)(c)/(f)/(g), (9)).
//
// Reads: CDP Storage.getCookies on the BROWSER target (every partition —
// partitioned cookies come back with their partitionKey). Deletes: CDP
// Network.deleteCookies on a PAGE session, one call per cookie with its exact
// name, domain, path and partitionKey (§10 #24: that a partitioned cookie goes
// is measured by test/isolated-plainflags.test.js). Storage: CDP
// Storage.clearDataForOrigin with storageTypes "all" (cookies, local storage,
// IndexedDB, cache storage, service workers …).
//
// NEVER VALUES: describe() rebuilds a cookie from name, domain, path and
// partition site only.

"use strict";

const CHALLENGE_HOST = "challenges.cloudflare.com";

function normHost(h) {
  return String(h || "").toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

/** A cookie with `cookieDomain` is sent to (or set by) `host`. */
function domainMatchesHost(host, cookieDomain) {
  const h = normHost(host);
  const d = normHost(cookieDomain);
  return !!d && (h === d || h.endsWith("." + d));
}

/** A cookie's domain lies within registrable site `site` (the site or a subdomain). */
function domainWithinSite(cookieDomain, site) {
  const d = normHost(cookieDomain);
  const s = normHost(site);
  return !!d && !!s && (d === s || d.endsWith("." + s));
}

function partitionSite(pk) {
  if (!pk) return null;
  const s = typeof pk === "string" ? pk : pk.topLevelSite;
  if (typeof s !== "string" || s === "") return null;
  try { return normHost(new URL(s).hostname); } catch { return null; }
}

function describe(c) {
  return {
    name: String(c.name),
    domain: String(c.domain || ""),
    path: String(c.path || "/"),
    partitionSite: partitionSite(c.partitionKey),
  };
}

function hostOfOrigin(origin) {
  try { return normHost(new URL(origin).hostname); } catch { return null; }
}

/** Every cookie in the jar. `sendBrowser(method, params)` targets the browser. */
async function getAllCookies(sendBrowser) {
  const r = await sendBrowser("Storage.getCookies", {});
  return Array.isArray(r && r.cookies) ? r.cookies : [];
}

/** Delete each cookie exactly (partition included). `sendPage` targets a page session. */
async function deleteCookies(sendPage, list) {
  let deleted = 0;
  const errors = [];
  for (const c of list) {
    const params = { name: c.name, domain: c.domain, path: c.path || "/" };
    if (c.partitionKey) params.partitionKey = c.partitionKey;
    try { await sendPage("Network.deleteCookies", params); deleted++; } catch (e) { errors.push(`${c.name}@${c.domain}: ${e.message}`); }
  }
  return { deleted, errors };
}

/** Every storage type except cookies (the sweep keeps Cloudflare's cookies; the cookie deletes are explicit). */
const STORAGE_NO_COOKIES = "file_systems,indexeddb,local_storage,websql,service_workers,cache_storage";

/** Storage.clearDataForOrigin for each origin — all storage types, or all but cookies. */
async function clearOrigins(sendPage, origins, { keepCookies = false } = {}) {
  const errors = [];
  for (const origin of origins) {
    try { await sendPage("Storage.clearDataForOrigin", { origin, storageTypes: keepCookies ? STORAGE_NO_COOKIES : "all" }); } catch (e) { errors.push(`${origin}: ${e.message}`); }
  }
  return { errors };
}

/** Cookies a known account's cookie origins carry (any partition). */
function accountCookies(jar, account) {
  const hosts = (account.cookieOrigins || []).map(hostOfOrigin).filter(Boolean);
  return jar.filter((c) => c && typeof c.name === "string" && hosts.some((h) => domainMatchesHost(h, c.domain)));
}

/**
 * The account's session cookies present in the jar. A confirmed account: its
 * NAMED session cookies. An unconfirmed one (known-accounts.js
 * sessionCookieRule): also EVERY cookie that applies to one of its login
 * hosts, Cloudflare's three names excepted — fail closed.
 */
function accountSessionCookies(jar, account) {
  const { sessionCookieRule, isCloudflareCookie } = require("./known-accounts.js");
  const names = new Set(account.sessionCookies || []);
  const named = names.size === 0 ? [] : accountCookies(jar, account).filter((c) => names.has(c.name));
  if (sessionCookieRule(account) === "named") return named;
  const loginHosts = (account.loginMatchers || []).map((m) => normHost(m.host)).filter(Boolean);
  const onLogin = jar.filter((c) => c && typeof c.name === "string" && !isCloudflareCookie(c.name) &&
    loginHosts.some((h) => domainMatchesHost(h, c.domain)));
  return [...new Set([...named, ...onLogin])];
}

/** The hosts whose responses can set this account's cookies: its login hosts and cookie-origin hosts. */
function accountHosts(account) {
  return [...new Set([
    ...(account.loginMatchers || []).map((m) => normHost(m.host)),
    ...(account.cookieOrigins || []).map(hostOfOrigin),
  ].filter(Boolean))];
}

/**
 * Whether a Set-Cookie of these names, on a response from `responseHosts`,
 * must trigger a sweep for `account` (review round 2 item 6): only when a
 * response host is one of the account's hosts (or a subdomain of one) — a
 * cookie set by any other host goes by the per-call sweep. `responseHosts`
 * null (the request's URL was never seen) → relevant: fail closed.
 */
function setCookieWatched(account, setNames, responseHosts = null) {
  const { sessionCookieRule, isCloudflareCookie } = require("./known-accounts.js");
  if (Array.isArray(responseHosts)) {
    const mine = accountHosts(account);
    if (!responseHosts.some((r) => mine.some((h) => normHost(r) === h || normHost(r).endsWith("." + h)))) return false;
  }
  if ((account.sessionCookies || []).some((n) => setNames.has(n))) return true;
  // Unconfirmed: any non-Cloudflare cookie may be its session (the sweep reads the jar and decides by host).
  return sessionCookieRule(account) !== "named" && [...setNames].some((n) => !isCloudflareCookie(n));
}

/** Same identity: name, domain, path and partition site. */
function sameCookie(a, b) {
  return a.name === b.name && normHost(a.domain) === normHost(b.domain) && (a.path || "/") === (b.path || "/") &&
    partitionSite(a.partitionKey) === partitionSite(b.partitionKey);
}

module.exports = {
  CHALLENGE_HOST, normHost, domainMatchesHost, domainWithinSite, partitionSite, describe, hostOfOrigin,
  getAllCookies, deleteCookies, clearOrigins, accountCookies, accountSessionCookies, setCookieWatched, accountHosts, sameCookie,
};
