// meta-guard.js — relay browsers never open Meta pages (spec v4 §1d).
//
// Why: a login typed into an automation browser is how Meta accounts get
// flagged. Agents reach Meta through the Graph APIs; a human uses the
// account owner's phone. There is NO override (r1 L3: nothing in the relay's
// reach can restrict one to Trevor).
//
// Three layers, top-level documents only — subresources (pixel /tr beacons,
// connect.facebook.net, fbcdn) and iframes (IG embeds) are never touched:
//   1. checkToolArgs()  — tool pre-check in RelayServer on URL arguments and
//      cookies_import: a clear error, before any browser work.
//   2. installMetaGuard() — raw CDP on a SECOND connection to the browser's
//      verified ws endpoint: browser-level Target.setAutoAttach({autoAttach,
//      waitForDebuggerOnStart, flatten}) so every page and popup is held until
//      Fetch.enable (resourceType Document patterns) is on, plus the page
//      targets that already exist. A blocked main-frame document is fulfilled
//      with a 403 page naming the route. Catches human typing, forwarded tools
//      (execute, scenario-run, clicks), redirects and popups. Never Playwright
//      context.route: it disables the HTTP cache and routes every request
//      through Node (r1 H4).
//   3. installWatchdog() — a main frame that lands on a blocked host anyway
//      (a service-worker-served navigation never reaches Fetch) is sent to
//      about:blank and reported on the next tool result.

const WebSocket = require("ws");

// ─────────────────────────────────────────────────────────────────────────────
// THE LISTS — PROPOSED, NOT YET CONFIRMED BY TREVOR (spec v4 "Decisions for
// Trevor" #1). Edit here; nothing else needs to change.
//   block: "host" = exactly that host; "*.host" = any subdomain (NOT the apex —
//          list the apex separately); "label.*" = that first label on any domain.
//   allow: "host" or "host/path-prefix*" — exceptions to `block` for top-level
//          documents. Subresources and iframes are never blocked at all.
// ─────────────────────────────────────────────────────────────────────────────
const META_GUARD_LISTS = Object.freeze({
  block: Object.freeze([
    "instagram.com", "*.instagram.com",
    "facebook.com", "*.facebook.com",
    "fb.com", "*.fb.com", "fb.me",
    "messenger.com", "*.messenger.com",
    "threads.net", "threads.com",
    "accountscenter.*",
    "auth.meta.com", "business.meta.com",
    "web.whatsapp.com", // recommended (same Meta account graph)
  ]),
  allow: Object.freeze([
    "www.facebook.com/ads/library*",
    "www.facebook.com/business/help*",
    "developers.facebook.com/docs*",
    "transparency.meta.com",
  ]),
});

const ROUTE_TEXT =
  "Relay browsers must never open Instagram/Facebook/Meta pages (an automation-browser login gets the account flagged). " +
  "Use the Instagram Graph API / Meta Graph API instead, or ask the account owner to do it on their phone.";

function compileBlock(entry) {
  if (entry.startsWith("*.")) { const suffix = entry.slice(1); return (h) => h.endsWith(suffix); }
  if (entry.endsWith(".*")) { const prefix = entry.slice(0, -1); return (h) => h.startsWith(prefix); }
  return (h) => h === entry;
}

function compileAllow(entry) {
  const slash = entry.indexOf("/");
  const host = slash === -1 ? entry : entry.slice(0, slash);
  let pathPart = slash === -1 ? null : entry.slice(slash);
  const prefix = pathPart && pathPart.endsWith("*");
  if (prefix) pathPart = pathPart.slice(0, -1);
  return (h, p) => h === host && (pathPart === null || (prefix ? p.startsWith(pathPart) : p === pathPart));
}

function compileLists(lists) {
  return {
    block: lists.block.map(compileBlock),
    allow: lists.allow.map(compileAllow),
    // Fetch prefilter: one coarse substring pattern per block entry. It also
    // pauses e.g. ports, trailing dots, userinfo and look-alike paths;
    // classifyUrl() decides precisely and everything else is continued.
    fetchNeedles: [...new Set(lists.block.map((e) => e.replace(/^\*\./, "").replace(/\*$/, "")))],
  };
}

const COMPILED = compileLists(META_GUARD_LISTS);

/** { blocked, host } for a top-level navigation to `url`. */
function classifyUrl(url, compiled = COMPILED) {
  let u;
  try { u = new URL(String(url)); } catch { return { blocked: false, host: null }; }
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return { blocked: false, host: null };
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!compiled.block.some((m) => m(host))) return { blocked: false, host };
  if (compiled.allow.some((m) => m(host, u.pathname))) return { blocked: false, host };
  return { blocked: true, host };
}

function blockedMessage(what) {
  return `[mcp-relay] BLOCKED: ${what} is a Meta property. ${ROUTE_TEXT}`;
}

// ── Layer 1: tool-argument pre-check ─────────────────────────────────────────
const URL_ARG_KEYS = ["url", "navigateToUrl"];

function cookieTargetsMeta(c) {
  if (!c || typeof c !== "object") return null;
  if (typeof c.url === "string" && classifyUrl(c.url).blocked) return c.url;
  if (typeof c.domain === "string") {
    const host = c.domain.replace(/^\./, "");
    if (classifyUrl(`https://${host}/`).blocked) return c.domain;
  }
  return null;
}

/** null when the call may proceed; otherwise an MCP isError result. */
function checkToolArgs(name, args) {
  const a = args && typeof args === "object" ? args : {};
  for (const k of URL_ARG_KEYS) {
    if (typeof a[k] === "string" && classifyUrl(a[k]).blocked) {
      return { isError: true, content: [{ type: "text", text: blockedMessage(`${name}: ${a[k]}`) }] };
    }
  }
  if (name === "cookies_import" && Array.isArray(a.cookies)) {
    for (const c of a.cookies) {
      const hit = cookieTargetsMeta(c);
      if (hit) return { isError: true, content: [{ type: "text", text: blockedMessage(`cookies_import for ${hit}`) }] };
    }
  }
  return null;
}

// ── Layer 2: CDP Fetch on a second browser connection ───────────────────────

function blockedPageHtml(host) {
  const esc = String(host).replace(/[^a-z0-9.-]/gi, "");
  // The inline icon stops the browser's automatic /favicon.ico request, which
  // would otherwise go to the blocked host's origin from our own page.
  return `<!doctype html><html data-relay-meta-guard="1"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Blocked by browser-mcp-relay</title></head>` +
    `<body style="font:16px system-ui;margin:3em;max-width:44em"><h1>Blocked: ${esc}</h1><p>${ROUTE_TEXT}</p></body></html>`;
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result || {});
        return;
      }
      const h = this.handlers.get(msg.method);
      if (h) { try { h(msg.params || {}, msg.sessionId); } catch { /* handler errors are logged inside */ } }
    });
    ws.on("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
    ws.on("error", () => { /* close follows */ });
  }
  static open(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
      ws.once("open", () => resolve(new CdpConnection(ws)));
      ws.once("error", reject);
    });
  }
  on(method, fn) { this.handlers.set(method, fn); }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(msg));
    });
  }
  close() { try { this.ws.close(); } catch { /* already */ } }
  terminate() { try { this.ws.terminate(); } catch { /* already */ } }
}

/**
 * Install layer 2 on the browser behind `wsEndpoint`. Resolves once the guard
 * is armed for every existing page target and for every future one.
 *
 * @returns {Promise<{ alive: () => boolean, close: () => void, recentlyBlocked: (url: string) => boolean, stats: object, _conn }>}
 */
async function installMetaGuard({ wsEndpoint, log = () => {}, onBlocked = () => {}, _beforeResume } = {}) {
  const conn = await CdpConnection.open(wsEndpoint);
  const patterns = COMPILED.fetchNeedles.map((n) => ({ urlPattern: `*://*${n}*`, resourceType: "Document", requestStage: "Request" }));
  const sessions = new Map(); // sessionId → { targetId, type }
  const armed = new Map(); // targetId → sessionId (one guard session per target)
  const recent = new Map(); // url → expiry ms (watchdog skips our own 403 pages)
  const stats = { blocked: 0, continued: 0, attached: 0 };

  async function arm(sessionId, targetInfo, waiting) {
    const dup = armed.has(targetInfo.targetId);
    if (!dup) {
      armed.set(targetInfo.targetId, sessionId);
      sessions.set(sessionId, { targetId: targetInfo.targetId, type: targetInfo.type });
      stats.attached++;
      try {
        if (targetInfo.type === "page") await conn.send("Fetch.enable", { patterns }, sessionId);
      } catch (e) {
        log(`meta-guard: Fetch.enable failed on ${targetInfo.type} ${targetInfo.targetId}: ${e.message}`);
      }
    }
    if (_beforeResume) await _beforeResume(targetInfo);
    if (waiting) { try { await conn.send("Runtime.runIfWaitingForDebugger", {}, sessionId); } catch { /* target gone */ } }
    if (dup || targetInfo.type !== "page") {
      // A second session on an armed target, or a worker that only had to be
      // released: don't keep it.
      try { await conn.send("Target.detachFromTarget", { sessionId }); } catch { /* gone */ }
      if (!dup) { sessions.delete(sessionId); armed.delete(targetInfo.targetId); }
    }
  }

  conn.on("Target.attachedToTarget", (p) => {
    arm(p.sessionId, p.targetInfo, p.waitingForDebugger).catch((e) => log(`meta-guard: arm failed: ${e.message}`));
  });
  conn.on("Target.detachedFromTarget", (p) => {
    const s = sessions.get(p.sessionId);
    if (s && armed.get(s.targetId) === p.sessionId) armed.delete(s.targetId);
    sessions.delete(p.sessionId);
  });
  conn.on("Fetch.requestPaused", (p, sessionId) => {
    const s = sessions.get(sessionId);
    const isMainFrameDoc = s && s.type === "page" && p.frameId === s.targetId && p.resourceType === "Document";
    const verdict = isMainFrameDoc ? classifyUrl(p.request.url) : { blocked: false };
    if (verdict.blocked) {
      stats.blocked++;
      recent.set(p.request.url, Date.now() + 30_000);
      log(`meta-guard: blocked top-level navigation to ${verdict.host}`);
      onBlocked(verdict.host);
      conn.send("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: 403,
        responseHeaders: [
          { name: "Content-Type", value: "text/html; charset=utf-8" },
          { name: "Cache-Control", value: "no-store" },
        ],
        body: Buffer.from(blockedPageHtml(verdict.host), "utf8").toString("base64"),
      }, sessionId).catch(() => {});
    } else {
      stats.continued++;
      conn.send("Fetch.continueRequest", { requestId: p.requestId }, sessionId).catch(() => {});
    }
  });

  await conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // Page targets that existed before the auto-attach (an attach-first Brave's
  // open tabs) are attached explicitly; arm() dedupes if auto-attach got them.
  const { targetInfos = [] } = await conn.send("Target.getTargets");
  for (const t of targetInfos) {
    if (t.type !== "page" || armed.has(t.targetId)) continue;
    try {
      const { sessionId } = await conn.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      await arm(sessionId, t, false);
    } catch (e) {
      log(`meta-guard: could not attach existing target ${t.targetId}: ${e.message}`);
    }
  }

  return {
    alive: () => !conn.closed,
    close: () => conn.close(),
    recentlyBlocked: (url) => {
      const exp = recent.get(url);
      if (!exp) return false;
      if (exp < Date.now()) { recent.delete(url); return false; }
      return true;
    },
    stats,
    _conn: conn,
  };
}

// ── Layer 3: framenavigated watchdog on the relay's Playwright context ──────

/**
 * @param {import('playwright-core').BrowserContext} context
 * @param {{ recentlyBlocked?: (url: string) => boolean, onBlocked: (host: string) => void, log?: Function }} hooks
 */
function installWatchdog(context, { recentlyBlocked = () => false, onBlocked, log = () => {} }) {
  const watched = new WeakSet();
  const watch = (page) => {
    if (watched.has(page)) return;
    watched.add(page);
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      const v = classifyUrl(url);
      if (!v.blocked || recentlyBlocked(url)) return; // our own 403 page is fine
      log(`meta-guard watchdog: main frame reached ${v.host} (not via Fetch — service worker?); sending it to about:blank`);
      onBlocked(v.host);
      page.goto("about:blank").catch(() => {});
    });
  };
  for (const p of context.pages()) watch(p);
  context.on("page", watch);
}

module.exports = {
  META_GUARD_LISTS,
  ROUTE_TEXT,
  compileLists,
  classifyUrl,
  checkToolArgs,
  blockedMessage,
  blockedPageHtml,
  installMetaGuard,
  installWatchdog,
  CdpConnection,
};
