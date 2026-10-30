// plainflags-signin-guard.js — D21's sign-in allowlist, enforced in code
// (spec v8 §5.6 (6)). Plain-flags mode only.
//
// Two lists: the known-account list (src/known-accounts.js — reviewed relay
// commits only) and the sign-in allowlist plainflags-signin.json (loader:
// src/plainflags-signin.js; EMPTY at start, missing/malformed → empty). A known
// account NOT on the allowlist has its login refused and its session removed:
//   (a) layer 1   checkToolArgs(): a `url` / `navigateToUrl` argument that hits
//                 a login matcher is refused before any browser work.
//   (b) layer 2   installSigninGuard(): meta-guard's mechanism on its own CDP
//                 connection — browser-level Target.setAutoAttach{autoAttach,
//                 waitForDebuggerOnStart, flatten}, Fetch.enable on PAGE targets
//                 with Document patterns for every login host; a top-level
//                 document or popup that matches (host, or host + path) is
//                 fulfilled with a 403 page naming the route.
//   (c) at every launch, before the first tool call: clearAccounts() deletes
//                 every cookie of each not-listed account's cookie origins
//                 (partitioned copies included) and runs Storage.clearDataForOrigin
//                 (all storage types) on those origins.
//   (f) on arrival: Set-Cookie lines in Network.responseReceivedExtraInfo on the
//                 page sessions, plus a Storage.getCookies sweep at every tool
//                 call as the backstop — a NAMED session cookie of a not-listed
//                 account is deleted and (c) runs on its origins, logged by
//                 account name (never a value). Cookies set inside a cross-origin
//                 iframe or a worker are not seen by the page sessions (review r8
//                 #5): they go by the next tool call's sweep.
//   (g) live list: the loader re-reads the file when it changes (checked at
//                 every tool call); a REMOVED account gets (c) at once.
//   (h) watchdog: meta-guard's layer-3 watchdog with this guard's classifier —
//                 a main frame that reaches a not-listed login matcher anyway (a
//                 service-worker-served navigation never reaches Fetch) is sent
//                 to about:blank and reported on the next tool result.
// Top-level documents and popups only, like the Meta guard — no frame guard
// (spec §5.6 (6), argued). ACCIDENT GUARDS, not a security boundary.

"use strict";

const { KNOWN_ACCOUNTS, matchLoginUrl, _normHost: normHost } = require("./known-accounts.js");
const { CdpConnection, installWatchdog } = require("./meta-guard.js");
const jar = require("./cdp-cookies.js");

const URL_ARG_KEYS = ["url", "navigateToUrl"];
const MARKER = "data-relay-signin-guard";

const ROUTE_TEXT =
  "In the plain-flags relay a known account's login is refused until Trevor puts that account on plainflags-signin.json " +
  "(his GO by name, through the pop-up, --risk credentials — spec v8 §5.6 (6)). Use the account's official API, or the " +
  "default relay where that login already lives; never type a login here.";

function blockedText(what, account) {
  return `[mcp-relay] BLOCKED (plain-flags sign-in guard): ${what} is the login page of "${account}", which is not on the sign-in list. ${ROUTE_TEXT}`;
}

function blockedPageHtml(host, account) {
  const esc = (v) => String(v).replace(/[^a-z0-9.-]/gi, "");
  return `<!doctype html><html ${MARKER}="1"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Blocked by browser-mcp-relay (sign-in guard)</title></head>` +
    `<body style="font:16px system-ui;margin:3em;max-width:44em"><h1>Blocked: ${esc(host)}</h1><p>Account: ${esc(account)}</p><p>${ROUTE_TEXT}</p></body></html>`;
}

/**
 * @param {object} o
 * @param {object[]} [o.accounts]  the known-account list (test seam: a fixture)
 * @param {{ load: () => object }} o.loader  plainflags-signin.js loader
 * @param {(name: string, askId: string) => { ok: boolean, reason?: string }} [o.verifyAsk]
 *   plainflags-ask-verify.js (review round 1 item 6): an entry counts only when
 *   its claude-ask record grants it; otherwise it is REFUSED (treated as not
 *   listed) and announced. Default: refuse every entry (fail closed).
 * @param {() => number} [o.now]
 */
function createSigninPolicy({ accounts = KNOWN_ACCOUNTS, loader, verifyAsk = () => ({ ok: false, reason: "no ask verifier configured" }), now = () => Date.now() }) {
  if (!loader || typeof loader.load !== "function") throw new Error("createSigninPolicy: loader required");
  const REVERIFY_MS = 30_000;
  let cache = null; // { snap, at, names: Set, refused: [{name, askId, reason}] }

  /** The VERIFIED list (re-read when the file changes; asks re-checked every 30 s). */
  function effective() {
    const snap = loader.load();
    if (cache && cache.snap === snap && now() - cache.at < REVERIFY_MS) return cache;
    const names = new Set();
    const refused = [];
    for (const e of snap.accounts) {
      if (!accounts.some((a) => a.name === e.name)) { refused.push({ name: e.name, askId: e.askId, reason: "not a known account (src/known-accounts.js)" }); continue; }
      let v;
      try { v = verifyAsk(e.name, e.askId); } catch (err) { v = { ok: false, reason: `ask check failed: ${err.message}` }; }
      if (v && v.ok) names.add(e.name);
      else refused.push({ name: e.name, askId: e.askId, reason: (v && v.reason) || "ask not verified" });
    }
    cache = { snap, at: now(), names, refused, problem: snap.problem || null };
    return cache;
  }
  const names = () => effective().names;
  // Applied (announced / cleared) state. Starts EMPTY, so the list in force at
  // start is announced on the first tool result.
  let applied = new Set();
  const announcedRefusals = new Set();
  const history = []; // recent changes, for relay_status

  const notListed = () => { const n = names(); return accounts.filter((a) => !n.has(a.name)); };
  /** The not-listed account whose login matcher `url` hits, or null. */
  function checkUrl(url) {
    const hit = matchLoginUrl(url, accounts);
    if (!hit || names().has(hit.account.name)) return null;
    return hit;
  }
  function classify(url) {
    let host = null;
    try { host = normHost(new URL(String(url)).hostname); } catch { /* not a URL */ }
    const hit = checkUrl(url);
    return hit ? { blocked: true, host, account: hit.account.name } : { blocked: false, host };
  }
  /** Layer 1: null, or an MCP isError result. */
  function checkToolArgs(name, args) {
    const a = args && typeof args === "object" ? args : {};
    for (const k of URL_ARG_KEYS) {
      if (typeof a[k] !== "string") continue;
      const hit = checkUrl(a[k]);
      if (hit) return { isError: true, content: [{ type: "text", text: blockedText(`${name}: ${a[k]}`, hit.account.name) }] };
    }
    return null;
  }
  /**
   * (g) + additions + refusals since the last COMMIT (review round 1 item 2: a
   * change is marked handled only by commit(), after it was applied). Pure.
   */
  function pendingChanges() {
    const eff = effective();
    const added = [...eff.names].filter((n) => !applied.has(n));
    const removed = [...applied].filter((n) => !eff.names.has(n)).map((n) => accounts.find((a) => a.name === n)).filter(Boolean);
    const refused = eff.refused.filter((r) => !announcedRefusals.has(`${r.name}\n${r.askId}\n${r.reason}`));
    return { names: new Set(eff.names), added, removed, refused };
  }
  function commit(changes) {
    applied = new Set(changes.names);
    for (const r of changes.refused) announcedRefusals.add(`${r.name}\n${r.askId}\n${r.reason}`);
    const at = new Date(now()).toISOString();
    for (const n of changes.added) history.push({ at, change: "added", account: n });
    for (const a of changes.removed) history.push({ at, change: "removed", account: a.name });
    for (const r of changes.refused) history.push({ at, change: "refused", account: r.name, askId: r.askId, reason: r.reason });
    if (history.length > 20) history.splice(0, history.length - 20);
  }
  /** Back-compat for callers that only clear: removals since the last call, committed at once. */
  function takeRemoved() {
    const c = pendingChanges();
    commit(c);
    return c.removed;
  }
  function status() {
    const eff = effective();
    return { listed: [...eff.names], refused: eff.refused, problem: eff.problem, recentChanges: history.slice() };
  }
  return { accounts, loader, names, notListed, checkUrl, classify, checkToolArgs, pendingChanges, commit, takeRemoved, status };
}

/**
 * Layers 2, (c), (f) on a second CDP connection to the browser.
 * @returns {Promise<{ alive, close, recentlyBlocked, clearAccounts, sweep, stats, _conn }>}
 */
async function installSigninGuard({ wsEndpoint, policy, log = () => {}, onBlocked = () => {}, onCleared = () => {}, sendTimeoutMs = 5000 } = {}) {
  const conn = await CdpConnection.open(wsEndpoint);
  // Every send the sweep / clear makes is bounded (review round 3 G): a CDP
  // call that never answers fails that call (fail closed) instead of hanging it.
  const timed = (p, what) => {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: no answer within ${sendTimeoutMs} ms`)), sendTimeoutMs); })]).finally(() => clearTimeout(t));
  };
  const hosts = [...new Set(policy.accounts.flatMap((a) => a.loginMatchers.map((m) => normHost(m.host))))].filter(Boolean);
  const patterns = hosts.map((h) => ({ urlPattern: `*://*${h}*`, resourceType: "Document", requestStage: "Request" }));
  const sessions = new Map(); // sessionId → { targetId, type }
  const armed = new Map(); // targetId → sessionId
  const recent = new Map(); // url → { n, exp }
  const stats = { blocked: 0, continued: 0, attached: 0, cookieEvents: 0, sweeps: 0, cleared: [] };

  async function arm(sessionId, targetInfo, waiting) {
    const dup = armed.has(targetInfo.targetId);
    if (!dup) {
      armed.set(targetInfo.targetId, sessionId);
      sessions.set(sessionId, { targetId: targetInfo.targetId, type: targetInfo.type });
      stats.attached++;
      if (targetInfo.type === "page") {
        if (patterns.length > 0) {
          try { await conn.send("Fetch.enable", { patterns }, sessionId); } catch (e) { log(`signin-guard: Fetch.enable failed on ${targetInfo.targetId}: ${e.message}`); }
        }
        try { await conn.send("Network.enable", {}, sessionId); } catch (e) { log(`signin-guard: Network.enable failed on ${targetInfo.targetId}: ${e.message}`); }
      }
    }
    if (waiting) { try { await conn.send("Runtime.runIfWaitingForDebugger", {}, sessionId); } catch { /* target gone */ } }
    if (dup || targetInfo.type !== "page") {
      try { await conn.send("Target.detachFromTarget", { sessionId }); } catch { /* gone */ }
      if (!dup) { sessions.delete(sessionId); armed.delete(targetInfo.targetId); }
    }
  }

  function pageSession() {
    for (const [sid, s] of sessions) if (s.type === "page") return sid;
    return null;
  }
  const sendBrowser = (m, p) => timed(conn.send(m, p), m);
  async function withPage(fn) {
    let sid = pageSession();
    let tmpTarget = null;
    if (!sid) {
      // No page to speak through (every tab closed): a background blank one.
      const { targetId } = await conn.send("Target.createTarget", { url: "about:blank", background: true });
      tmpTarget = targetId;
      for (let i = 0; i < 40 && !(sid = pageSession()); i++) await new Promise((r) => setTimeout(r, 25));
      if (!sid) ({ sessionId: sid } = await conn.send("Target.attachToTarget", { targetId, flatten: true }));
    }
    try { return await fn((m, p) => timed(conn.send(m, p, sid), m)); }
    finally { if (tmpTarget) { try { await conn.send("Target.closeTarget", { targetId: tmpTarget }); } catch { /* gone */ } } }
  }

  /**
   * (c) Every cookie and all storage of each account's cookie origins. With
   * `keepCloudflare` (the on-arrival sweep): Cloudflare's own cf_clearance /
   * __cf_bm / _cfuvid stay — they are no account's session, and a plain-flags
   * try on a known account's public pages (canva.com) needs its clearance.
   */
  async function clearAccounts(accounts, why, { keepCloudflare = false } = {}) {
    if (!accounts || accounts.length === 0) return [];
    const { isCloudflareCookie } = require("./known-accounts.js");
    const all = await jar.getAllCookies(sendBrowser);
    const out = [];
    await withPage(async (sendPage) => {
      for (const a of accounts) {
        const list = jar.accountCookies(all, a).filter((c) => !(keepCloudflare && isCloudflareCookie(c.name)));
        const del = await jar.deleteCookies(sendPage, list);
        const clr = await jar.clearOrigins(sendPage, a.cookieOrigins || [], { keepCookies: keepCloudflare });
        const errors = [...del.errors, ...clr.errors];
        out.push({ account: a.name, cookies: del.deleted, errors });
        if (list.length > 0 || errors.length > 0) {
          log(`signin-guard: cleared ${a.name} (${why}): ${del.deleted} cookie(s), storage of ${a.cookieOrigins.length} origin(s)${errors.length ? `; errors: ${errors.join("; ")}` : ""}`);
        }
      }
    });
    stats.cleared.push(...out.map((o) => ({ ...o, why })));
    if (stats.cleared.length > 50) stats.cleared.splice(0, stats.cleared.length - 50);
    return out;
  }

  /** (f) Named session cookies of not-listed accounts → deleted, plus (c). */
  let sweeping = null;
  let again = false;
  async function sweepOnce() {
    stats.sweeps++;
    const all = await jar.getAllCookies(sendBrowser);
    const hit = policy.notListed().filter((a) => jar.accountSessionCookies(all, a).length > 0);
    if (hit.length === 0) return [];
    await clearAccounts(hit, "session cookie arrived", { keepCloudflare: true });
    for (const a of hit) onCleared(a.name);
    return hit.map((a) => a.name);
  }
  // At most SWEEP_PASSES passes per sweep (review round 2 item 6): a page that
  // keeps setting cookies cannot hold the sweep forever; the next tool call's
  // sweep picks up whatever arrived after the last pass.
  const SWEEP_PASSES = 3;
  let inLastPass = false;
  let tail = null; // one extra pass for callers that joined during the last pass
  function sweep() {
    if (sweeping) {
      if (!inLastPass) { again = true; return sweeping; }
      // Joined during the LAST pass (review round 3 G): its cookie may have
      // arrived after that pass read the jar — one more pass after this sweep,
      // shared by every such caller.
      if (!tail) {
        const after = sweeping.catch(() => {});
        tail = after.then(() => sweepOnce().then((n) => [...new Set(n)])).finally(() => { tail = null; });
      }
      return tail;
    }
    // Claim the slot SYNCHRONOUSLY: a sweep() re-entered before this one's
    // first await (an event fired from inside the CDP send) must join it, not
    // start another (found by the 3-pass test: it recursed without bound).
    let resolveSweep;
    let rejectSweep;
    sweeping = new Promise((res, rej) => { resolveSweep = res; rejectSweep = rej; });
    const current = sweeping;
    (async () => {
      let names = [];
      let passes = 0;
      do { again = false; passes++; inLastPass = passes >= SWEEP_PASSES; names = names.concat(await sweepOnce()); } while (again && passes < SWEEP_PASSES);
      return [...new Set(names)];
    })().then((v) => { inLastPass = false; if (sweeping === current) sweeping = null; resolveSweep(v); },
      (e) => { inLastPass = false; if (sweeping === current) sweeping = null; rejectSweep(e); });
    return current;
  }

  conn.on("Target.attachedToTarget", (p) => {
    arm(p.sessionId, p.targetInfo, p.waitingForDebugger).catch((e) => log(`signin-guard: arm failed: ${e.message}`));
  });
  conn.on("Target.detachedFromTarget", (p) => {
    const s = sessions.get(p.sessionId);
    if (s && armed.get(s.targetId) === p.sessionId) armed.delete(s.targetId);
    sessions.delete(p.sessionId);
  });
  conn.on("Fetch.requestPaused", (p, sessionId) => {
    const s = sessions.get(sessionId);
    const isMainFrameDoc = s && s.type === "page" && p.frameId === s.targetId && p.resourceType === "Document";
    const v = isMainFrameDoc ? policy.classify(p.request.url) : { blocked: false };
    if (v.blocked) {
      stats.blocked++;
      const t = recent.get(p.request.url);
      recent.set(p.request.url, { n: (t && t.exp >= Date.now() ? t.n : 0) + 1, exp: Date.now() + 10_000 });
      log(`signin-guard: blocked top-level navigation to ${v.host} (${v.account} not on the sign-in list)`);
      onBlocked(v.host, v.account);
      conn.send("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: 403,
        responseHeaders: [
          { name: "Content-Type", value: "text/html; charset=utf-8" },
          { name: "Cache-Control", value: "no-store" },
        ],
        body: Buffer.from(blockedPageHtml(v.host, v.account), "utf8").toString("base64"),
      }, sessionId).catch(() => {});
    } else {
      stats.continued++;
      conn.send("Fetch.continueRequest", { requestId: p.requestId }, sessionId).catch(() => {});
    }
  });
  // requestId → the hosts it was sent to (a redirect chain adds hops), so a
  // Set-Cookie is judged by the host that set it. Bounded.
  const requestHosts = new Map();
  conn.on("Network.requestWillBeSent", (p) => {
    if (!p || !p.requestId || !p.request) return;
    let host = null;
    try { host = normHost(new URL(p.request.url).hostname); } catch { return; }
    const set = requestHosts.get(p.requestId) || new Set();
    set.add(host);
    requestHosts.delete(p.requestId);
    requestHosts.set(p.requestId, set);
    if (requestHosts.size > 2000) requestHosts.delete(requestHosts.keys().next().value);
  });
  conn.on("Network.responseReceivedExtraInfo", (p) => {
    const raw = p && p.headers ? Object.entries(p.headers).filter(([k]) => k.toLowerCase() === "set-cookie").map(([, v]) => String(v)).join("\n") : "";
    if (!raw) return;
    const setNames = new Set(raw.split("\n").map((l) => l.split("=")[0].trim()).filter(Boolean));
    const hosts = requestHosts.has(p.requestId) ? [...requestHosts.get(p.requestId)] : null; // unknown → fail closed
    const watched = policy.notListed().some((a) => jar.setCookieWatched(a, setNames, hosts));
    if (!watched) return;
    stats.cookieEvents++;
    sweep().catch((e) => log(`signin-guard: arrival sweep failed: ${e.message}`));
  });

  await conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const { targetInfos = [] } = await conn.send("Target.getTargets");
  for (const t of targetInfos) {
    if (t.type !== "page" || armed.has(t.targetId)) continue;
    try {
      const { sessionId } = await conn.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      await arm(sessionId, t, false);
    } catch (e) {
      log(`signin-guard: could not attach existing target ${t.targetId}: ${e.message}`);
    }
  }

  return {
    alive: () => !conn.closed,
    close: () => conn.close(),
    recentlyBlocked: (url) => {
      url = noFragment(url);
      const t = recent.get(url);
      if (!t) return false;
      if (t.exp < Date.now() || t.n < 1) { recent.delete(url); return false; }
      if (--t.n === 0) recent.delete(url);
      return true;
    },
    clearAccounts,
    sweep,
    stats,
    _conn: conn,
  };
}

function noFragment(u) {
  const i = String(u).indexOf("#");
  return i < 0 ? String(u) : String(u).slice(0, i);
}

/** (h) meta-guard's watchdog with this guard's classifier and 403 marker. */
function installSigninWatchdog(context, { policy, recentlyBlocked = () => false, onBlocked = () => {}, log = () => {} }) {
  installWatchdog(context, {
    recentlyBlocked,
    onBlocked: (host) => onBlocked(host),
    log,
    classify: (url) => policy.classify(url),
    marker: MARKER,
    label: "signin-guard",
  });
}

module.exports = {
  createSigninPolicy, installSigninGuard, installSigninWatchdog, blockedText, blockedPageHtml,
  ROUTE_TEXT, MARKER, URL_ARG_KEYS,
};
