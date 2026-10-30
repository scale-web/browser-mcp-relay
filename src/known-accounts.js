// known-accounts.js — the known-account list of spec v8 §5.6 (6), shipped with
// challenge_detect (§5.2, phase 1) and reused unchanged by the plain-flags
// sign-in guard (phase 1c, src/plainflags-signin-guard.js — not built yet).
//
// Vault spec: 04 - Recon/2026-10-29 Cloudflare Relay Challenge Recon/
//   04 - Playbooks/Browser Work Behind Cloudflare — Spec v8.
//
// What it is: every account whose LOGIN PAGE the plain-flags profile must refuse
// unless Trevor has put that account on the sign-in allowlist
// (plainflags-signin.json, see plainflags-signin.js). Phase 1 only CLASSIFIES
// with it (challenge_detect's `reason: signin-not-listed`); nothing enforces it
// until 1c. Edited only by a reviewed relay commit, like META_GUARD_LISTS.
//
// Each account:
//   name           — the key an allowlist entry names
//   loginMatchers  — { host } or { host, pathPrefixes } (a login that shares a
//                    host with public pages, e.g. Canva — review r7 #3)
//   cookieOrigins  — origins whose cookies/storage 1c clears for a not-listed account
//   sessionCookies — session-cookie NAMES (never values) 1c deletes on arrival
//   federating     — an identity provider other sites sign in through (r7 #4)
//   signsInVia     — providers this account itself signs in via
//
// ⚠ NOTHING BELOW IS CONFIRMED (`confirmed: false` on every entry). The spec
// says every host, path and cookie name is "to confirm at build time" (§10 #25:
// the session reads each login page's final host and path once in the DEFAULT
// relay and records names only; Trevor names the agency's white-label app host).
// This build made no browser launches and no network calls, so hosts come from
// the spec's own text and the session-cookie names are left EMPTY except where
// noted "inferred". Phase 1c must not enforce on an unconfirmed entry without
// that read.

"use strict";

const KNOWN_ACCOUNTS = Object.freeze([
  Object.freeze({
    name: "highlevel",
    // The agency's white-label app host is NOT here: it is not in the spec's
    // evidence (§10 #25) — Trevor names it, then a reviewed commit adds it.
    loginMatchers: Object.freeze([
      Object.freeze({ host: "app.gohighlevel.com" }),
      Object.freeze({ host: "app.leadconnectorhq.com" }),
    ]),
    cookieOrigins: Object.freeze(["https://app.gohighlevel.com", "https://app.leadconnectorhq.com"]),
    sessionCookies: Object.freeze([]),
    federating: false,
    signsInVia: Object.freeze([]),
    confirmed: false,
  }),
  Object.freeze({
    name: "canva",
    // Canva signs in on the same host as its public pages (memory
    // solutions_relay_cloudflare_canva_signal.md) — a host-only entry would
    // refuse all of canva.com and contradict §3.4. Locale-prefixed login paths
    // (r8 #7) are to record at the §10 #25 read.
    loginMatchers: Object.freeze([Object.freeze({ host: "www.canva.com", pathPrefixes: Object.freeze(["/login"]) })]),
    cookieOrigins: Object.freeze(["https://www.canva.com"]),
    sessionCookies: Object.freeze([]),
    federating: false,
    signsInVia: Object.freeze([]), // e.g. ["google"] if Trevor's Canva signs in through Google — to confirm
    confirmed: false,
  }),
  Object.freeze({
    name: "hostinger",
    loginMatchers: Object.freeze([
      Object.freeze({ host: "auth.hostinger.com" }),
      Object.freeze({ host: "hpanel.hostinger.com" }),
    ]),
    cookieOrigins: Object.freeze(["https://auth.hostinger.com", "https://hpanel.hostinger.com"]),
    sessionCookies: Object.freeze([]),
    federating: false,
    signsInVia: Object.freeze([]),
    confirmed: false,
  }),
  Object.freeze({
    name: "shopify",
    loginMatchers: Object.freeze([
      Object.freeze({ host: "admin.shopify.com" }),
      Object.freeze({ host: "accounts.shopify.com" }),
    ]),
    cookieOrigins: Object.freeze(["https://admin.shopify.com", "https://accounts.shopify.com"]),
    sessionCookies: Object.freeze([]),
    federating: false,
    signsInVia: Object.freeze([]),
    confirmed: false,
  }),
  Object.freeze({
    name: "cloudflare",
    loginMatchers: Object.freeze([Object.freeze({ host: "dash.cloudflare.com" })]),
    cookieOrigins: Object.freeze(["https://dash.cloudflare.com"]),
    sessionCookies: Object.freeze([]),
    federating: false,
    signsInVia: Object.freeze([]),
    confirmed: false,
  }),
  Object.freeze({
    name: "google",
    loginMatchers: Object.freeze([Object.freeze({ host: "accounts.google.com" })]),
    cookieOrigins: Object.freeze(["https://accounts.google.com"]),
    // inferred (widely documented Google session cookies), not read in the relay
    sessionCookies: Object.freeze(["SID", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"]),
    federating: true,
    signsInVia: Object.freeze([]),
    confirmed: false,
  }),
  Object.freeze({
    name: "microsoft",
    loginMatchers: Object.freeze([
      Object.freeze({ host: "login.microsoftonline.com" }),
      Object.freeze({ host: "login.live.com" }),
    ]),
    cookieOrigins: Object.freeze(["https://login.microsoftonline.com", "https://login.live.com"]),
    // inferred (Entra ID's persistent-session cookies), not read in the relay
    sessionCookies: Object.freeze(["ESTSAUTH", "ESTSAUTHPERSISTENT"]),
    federating: true,
    signsInVia: Object.freeze([]),
    confirmed: false,
  }),
  Object.freeze({
    name: "apple",
    loginMatchers: Object.freeze([
      Object.freeze({ host: "appleid.apple.com" }),
      Object.freeze({ host: "idmsa.apple.com" }),
    ]),
    cookieOrigins: Object.freeze(["https://appleid.apple.com", "https://idmsa.apple.com"]),
    sessionCookies: Object.freeze([]),
    federating: true,
    signsInVia: Object.freeze([]),
    confirmed: false,
  }),
]);

/** Lower-cased host with trailing dots removed. */
function normHost(h) {
  return String(h || "").toLowerCase().replace(/\.+$/, "");
}

/**
 * The path a matcher compares (r8 #7): percent-decoded (once, tolerant of bad
 * escapes), lower-cased, with runs of `/` collapsed. Query and hash are never
 * part of it.
 */
function normPath(p) {
  let s = String(p || "/");
  try { s = decodeURIComponent(s); } catch { /* malformed escape: compare as-is */ }
  s = s.toLowerCase().replace(/\/{2,}/g, "/");
  return s.startsWith("/") ? s : "/" + s;
}

/** `/login` matches `/login`, `/login/`, `/login/x` — never `/loginx`. */
function pathHasPrefix(path, prefix) {
  const p = normPath(prefix).replace(/\/+$/, "");
  return path === p || path.startsWith(p + "/");
}

/**
 * The known account whose login matcher `url` hits, or null.
 * @returns {{ account: object, matcher: object } | null}
 */
function matchLoginUrl(url, accounts = KNOWN_ACCOUNTS) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = normHost(u.hostname);
  const path = normPath(u.pathname);
  for (const account of accounts) {
    for (const m of account.loginMatchers) {
      if (normHost(m.host) !== host) continue;
      if (!m.pathPrefixes || m.pathPrefixes.length === 0) return { account, matcher: m };
      if (m.pathPrefixes.some((pre) => pathHasPrefix(path, pre))) return { account, matcher: m };
    }
  }
  return null;
}

function findAccount(name, accounts = KNOWN_ACCOUNTS) {
  return accounts.find((a) => a.name === name) || null;
}

module.exports = { KNOWN_ACCOUNTS, matchLoginUrl, findAccount, _normPath: normPath, _normHost: normHost };
