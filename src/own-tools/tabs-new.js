// tabs_new — open (or REUSE) a tab, optionally navigating to a URL.
//
// Tab-reuse (2026-07-16): repeated tabs_new calls used to leak a tab per
// call — each call created a fresh Playwright page AND the upstream
// propagation navigated upstream's pinned page to the same URL, so "check
// ups.com again" grew the tab strip by one stale ~50-150MB renderer every
// time. Now, when an OPEN tab already exists on the target URL's host, we
// navigate THAT tab instead of creating another. `forceNew: true` opts out
// (genuinely parallel pages on one site). URL-less calls and non-http(s)
// schemes always create a fresh page.
//
// Tab cap: BROWSER_RELAY_MAX_TABS (env, default 8, 0 disables) prunes the
// OLDEST non-active tabs after a create pushes the count over the cap —
// a backstop for multi-site sprawl that reuse alone can't bound. Brave's
// residual about:blank (pages[0]) is deliberately prunable.
//
// Upstream follows by re-pin (2026-11-17, ask as-ops/ask-5ojuum rev 3): the
// resulting tab becomes the page upstream's tools act on — its pin is MOVED
// here by CDP target id (_propagate-active-page.js, scripts/patch-bdmcp-repin.js).
// Nothing is navigated to follow, so a URL loads in one tab, and the tab the
// previous call used keeps its page and state. Before this, upstream's own page
// was navigated to the same URL: every session's first URL was open twice.
//
// Blank adoption: with no same-host tab, a residual about:blank is navigated
// instead of opening a new tab only when it is the relay's — one tabs_new made,
// or one a Brave this relay LAUNCHED opened at launch (noteLaunchedPages, from
// index.js). Any other blank (an attached Brave's, the user's) is left alone.
//
// T0-7 / T1-10 fixes (2026-05-09):
//   • try/catch around page.goto so a bad URL doesn't leave an orphan tab
//     visible in tabs_list with no error context. On goto failure we now
//     still call setActivePage (the page exists) and return a structured
//     `{ navError, isError: true }` response.
//   • accept `waitUntil` parameter — SPA-heavy sites need 'networkidle'.

const { pinUpstreamToPage, propagateActivePageToUpstream } = require("./_propagate-active-page.js");
const { applyLocalConfigToEnv } = require("../local-config.js");
const { setActivePage, getActivePageRaw } = require("./_active-page.js");
const sync = require("./_upstream-sync.js");
const quiet = require("./_quiet-focus.js");

// Pages this relay process created (tabs_new's newPage). When upstream's URL
// can't be read, only these (and about:blank tabs) may be reused or pruned:
// the user's tab can't be told apart, but the 2026-07-16 tab leak must not
// come back while upstream is unreadable.
const created = new WeakSet();
// The URL the relay last left each of its tabs on (after newPage / its own
// goto). Measurement only (register A55 MED-3): a reused or pruned tab whose
// URL has moved since was changed by someone else — the user, or the page.
const relayLeft = new WeakMap();
let lastTabsOpen = null;
// The about:blank pages a Brave this relay LAUNCHED opened at launch
// (noteLaunchedPages, from index.js). Kept apart from `created`, which the
// tab-reuse / tabs-open log reads as "made by tabs_new" (32dab4a).
const launchBlanks = new WeakSet();

/** index.js, once per Brave: remember a launched Brave's launch blanks. An
 *  attached Brave's pages are nobody's we can name, so none. Never throws. */
function noteLaunchedPages(handle) {
  try {
    if (!handle || handle.attached) return;
    for (const p of handle.context.pages()) if (!p.isClosed() && p.url() === "about:blank") launchBlanks.add(p);
  } catch { /* a fake or closing context: nothing to note */ }
}

/**
 * MED-3 measurement (log only, no behaviour change; reviewed with A51's log
 * around 2026-10-19): one line per tab the relay reuses or prunes, saying
 * whether this relay created it and whether its page changed since the relay
 * last left it. Host only — never a path or query. Never throws.
 */
function logTab(event, p, upstreamUrl, extra = {}, url = null) {
  try {
    const log = globalThis.__relayEventLog;
    if (typeof log !== "function") return;
    const u = url === null ? p.url() : url;
    log(event, {
      host: urlHost(u) || (u === "about:blank" ? "about:blank" : "(non-http)"),
      createdHere: created.has(p),
      changedSinceRelay: relayLeft.has(p) ? relayLeft.get(p) !== u : null,
      // Same URL as upstream's tab: with createdHere false, most likely upstream's
      // own tab. A relay tab synced to it shows the same URL too.
      sameUrlAsUpstream: typeof upstreamUrl === "string" ? upstreamUrl === u : null,
      ...extra,
    });
  } catch { /* measurement must never break a tool */ }
}

/** Host of an http(s) URL, else null (about:blank, chrome://, bad URLs). */
function urlHost(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.host;
  } catch {
    return null;
  }
}

/**
 * Pick an existing open page to reuse for `url`, or null to create fresh.
 * Preference order: the current active page if it matches the target host,
 * else the MOST RECENT (last in creation order) matching page. Exact host
 * match only — app.foo.com and www.foo.com are different surfaces.
 *
 * Pure over page-like objects ({ url(), isClosed() }) — exported for tests.
 */
function findReusablePage(pages, url, activePage) {
  const host = urlHost(url);
  if (!host) return null;
  const matches = pages.filter((p) => !p.isClosed() && urlHost(p.url()) === host);
  if (matches.length === 0) return null;
  if (activePage && matches.includes(activePage)) return activePage;
  return matches[matches.length - 1];
}

/**
 * Close the oldest prunable pages until `pages.length - closed <= cap`.
 * Never closes anything in `keep` (the just-created/reused page + the
 * active page). cap <= 0 disables. Best-effort per page — a close failure
 * skips that page. Exported for tests; returns count closed.
 */
async function pruneOldestTabs(pages, cap, keep, spare = () => false, onClosed = () => {}) {
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  const open = pages.filter((p) => !p.isClosed());
  let excess = open.length - cap;
  if (excess <= 0) return 0;
  let closed = 0;
  for (const p of open) {
    if (excess <= 0) break;
    if (keep.includes(p) || spare(p)) continue;
    try {
      const host = p.url(); // read before close: a closed page may not report it
      await p.close();
      onClosed(p, host);
      closed++;
      excess--;
    } catch { /* mid-close race — skip */ }
  }
  return closed;
}

// Default to the relay's resolved env (process.env OVERLAID with local-config),
// not bare process.env. Before this, BROWSER_RELAY_MAX_TABS in local-config.json
// was silently ignored — index.js builds RELAY_ENV = applyLocalConfigToEnv(...)
// as a NEW object and never mutates process.env, so the cap only ever saw a real
// env var while the idle reaper (which reads RELAY_ENV) honored the file. Two
// keys in the same file behaving differently is the kind of thing you debug for
// an hour. Callers may still pass an explicit env; tests rely on that.
function maxTabsFromEnv(env = applyLocalConfigToEnv(process.env)) {
  const raw = env.BROWSER_RELAY_MAX_TABS;
  if (raw === undefined || raw === "") return 8;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 8;
}

module.exports = {
  name: "tabs_new",
  description: "Open a tab in the relay's browser context, optionally navigating to a URL. REUSES an existing tab when one is already open on the same host (keeps the tab strip lean) — pass forceNew:true if you genuinely need a second tab on that host. Tracks the resulting tab as the active page for subsequent own-tool calls.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Optional URL to navigate to" },
      forceNew: {
        type: "boolean",
        default: false,
        description: "Always create a fresh tab, even when one is already open on the same host.",
      },
      waitUntil: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle", "commit"],
        default: "load",
        description: "Playwright navigation lifecycle to wait for. Default 'load'. Use 'networkidle' for SPA-heavy sites.",
      },
      allowPinnedPage: {
        type: "boolean",
        description: "Only when the relay reported UPSTREAM DESYNC and the page in upstream's tab is one YOU put there: lets the relay reuse and navigate that tab. Never when the user may be using it.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 100,
        maximum: 300000,
        default: 30000,
        description: "Max wait for the navigation in ms. Default 30s.",
      },
    },
  },
  handler: async (_args = {}) => {
    // F0-9 (2026-05-10): treat null as missing.
    const url = _args.url ?? undefined;
    let waitUntil = _args.waitUntil;
    if (!["load", "domcontentloaded", "networkidle", "commit"].includes(waitUntil)) waitUntil = "load";
    let timeoutMs = _args.timeoutMs;
    if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs < 100) timeoutMs = 30000;
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };

    // Rule C (_upstream-sync.js) for the relay's OWN navigation too: never
    // reuse (navigate) or prune the tab upstream is pinned to while it shows a
    // page the relay did not put there. Tabs are matched across the two
    // Playwright connections by URL. Read lazily: it starts upstream's session.
    const force = _args.allowPinnedPage === true;
    let read = null;
    const sparedUrl = async () => {
      if (force) return null;
      if (read === null) read = await sync.readUpstreamUrl();
      if (typeof read.url !== "string") return undefined; // unknown: see `created`
      return sync.mayNavigate(read.url) ? null : read.url;
    };
    const spareFilter = (spared) => (p) => (spared === undefined
      ? !(created.has(p) || p.url() === "about:blank")
      : spared !== null && p.url() === spared);

    let page = null;
    let reused = false;
    let adoptedBlank = false;
    if (url && !_args.forceNew) {
      let candidates = bridge.context.pages();
      if (findReusablePage(candidates, url, getActivePageRaw())) {
        const spare = spareFilter(await sparedUrl());
        candidates = candidates.filter((p) => !spare(p));
      }
      page = findReusablePage(candidates, url, getActivePageRaw());
      reused = !!page;
      if (reused) logTab("tab-reuse", page, read && read.url);
      if (!page) {
        // No same-host tab — adopt a residual about:blank of the relay's
        // (Brave's launch tab, or one tabs_new made) instead of leaving it
        // around forever next to a freshly created tab. Never another blank.
        page = bridge.context.pages().find((p) => !p.isClosed() && p.url() === "about:blank"
          && (created.has(p) || launchBlanks.has(p))) || null;
        adoptedBlank = !!page;
      }
    }
    if (!page) {
      // Background tab: newPage() would activate Brave (_quiet-focus.js).
      page = await quiet.newQuietPage(bridge);
      created.add(page);
      relayLeft.set(page, "about:blank");
    }
    // T0-7: track the page as active BEFORE goto so a goto failure still
    // leaves us in a usable state — subsequent own-tools target this new
    // tab, not the previous active page or pages[0]'s about:blank.
    setActivePage(page);
    // Raise the tab only when this relay's Brave is already in front (the
    // user is watching it) — a new tab is created in the background.
    try { await quiet.raiseIfFront(page, bridge.bravePid); } catch { /* headless / already front */ }

    // A create over the cap will prune: read which tab upstream is on BEFORE
    // the re-pin moves it, so rule C still spares it (review r1 L6).
    const cap = maxTabsFromEnv();
    let overCap = false;
    try { overCap = !reused && !adoptedBlank && cap > 0 && bridge.context.pages().filter((p) => !p.isClosed()).length > cap; } catch { /* best-effort */ }
    let pruneSpare = () => false;
    if (overCap) { try { pruneSpare = spareFilter(await sparedUrl()); } catch { /* best-effort */ } }

    // Upstream acts on this tab from now on (best-effort; a failure is a
    // desync, rules A and B). BEFORE the goto, so upstream's console and
    // network capture (attached to the pinned page) sees this page load.
    let propagation = await pinUpstreamToPage(page, { claim: false, onUnpatched: "none" });

    let navError = null;
    if (url) {
      try {
        await page.goto(url, { waitUntil, timeout: timeoutMs });
      } catch (e) {
        navError = e.message || String(e);
      }
      try { relayLeft.set(page, page.url()); } catch { /* closed mid-call */ }
    }
    // The relay put this page there (rule C) — even after a failed goto: the
    // tab exists, is the active one, and shows what the relay's goto left.
    if (propagation.propagated) { try { sync.claim(page.url()); } catch { /* closed mid-call */ } }
    // R1 not applied (review r1 L3): as before the re-pin, navigate upstream's
    // own tab to the URL once this tab has loaded it (it claims what it lands on).
    if (propagation.unpatched) {
      if (navError) {
        propagation = { propagated: false, reason: "skipped: this tab's navigation failed" };
        sync.markDesynced(page.url(), null, propagation.reason);
      } else {
        propagation = { ...(await propagateActivePageToUpstream(url, { force })), via: "navigation" };
      }
    }

    // Cap backstop — only a CREATE can push the count over the cap. Runs
    // after the re-pin, so a pruned old tab is never the one upstream acts on.
    let prunedTabs = 0;
    if (overCap) {
      try {
        prunedTabs = await pruneOldestTabs(bridge.context.pages(), cap, [page], pruneSpare,
          (p, u) => logTab("tab-prune", p, read && read.url, {}, u));
      } catch { /* best-effort */ }
    }

    const pages = bridge.context.pages();
    try {
      const open = pages.filter((p) => !p.isClosed());
      const mine = open.filter((p) => created.has(p)).length;
      const blank = open.filter((p) => !created.has(p) && p.url() === "about:blank").length;
      const counts = { open: open.length, createdHere: mine, otherBlank: blank, other: open.length - mine - blank };
      const key = JSON.stringify(counts);
      // Only when the counts change, so a busy lane cannot rotate A51's rare events out of the shared log.
      if (key !== lastTabsOpen && typeof globalThis.__relayEventLog === "function") {
        globalThis.__relayEventLog("tabs-open", counts);
        lastTabsOpen = key;
      }
    } catch { /* measurement only */ }
    const result = {
      content: [{
        type: "text",
        text: JSON.stringify({
          index: pages.indexOf(page) !== -1 ? pages.indexOf(page) : pages.length - 1,
          url: page.url(),
          reused,
          adoptedBlank,
          prunedTabs,
          waitUntil,
          navError,
          upstreamPropagated: propagation.propagated,
          ...(propagation.propagated ? {} : { upstreamReason: propagation.reason, upstreamUrl: propagation.upstreamUrl || null }),
        }, null, 2),
      }],
    };
    // Rule A: say it where the caller is already looking.
    const warn = sync.warning();
    if (warn) result.content.unshift({ type: "text", text: warn });
    // Only set isError when truthy — keeping success-path shape `{ content }`
    // identical to the pre-T0-7 contract that existing tests assert on.
    if (navError) result.isError = true;
    return result;
  },
  noteLaunchedPages,
  // Test seams.
  _findReusablePage: findReusablePage,
  _pruneOldestTabs: pruneOldestTabs,
  _maxTabsFromEnv: maxTabsFromEnv,
  _urlHost: urlHost,
};
