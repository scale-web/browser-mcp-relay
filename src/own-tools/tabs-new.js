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
// Active-page propagation: when `url` is given, we ALSO navigate
// upstream's tracked page (via its `navigation_go-to`) so upstream's
// screenshot / snapshot tools target this URL. See
// _propagate-active-page.js for the why; upstream pins `_page` to a
// specific Playwright Page reference and never re-evaluates it from
// CDP, so creating a Playwright page on our side alone leaves
// upstream targeting its original page.
//
// T0-7 / T1-10 fixes (2026-05-09):
//   • try/catch around page.goto so a bad URL doesn't leave an orphan tab
//     visible in tabs_list with no error context. On goto failure we now
//     still call setActivePage (the page exists) and return a structured
//     `{ navError, isError: true }` response.
//   • accept `waitUntil` parameter — SPA-heavy sites need 'networkidle'.

const { propagateActivePageToUpstream } = require("./_propagate-active-page.js");
const { applyLocalConfigToEnv } = require("../local-config.js");
const { setActivePage, getActivePageRaw } = require("./_active-page.js");
const sync = require("./_upstream-sync.js");

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
async function pruneOldestTabs(pages, cap, keep, spare = () => false) {
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  const open = pages.filter((p) => !p.isClosed());
  let excess = open.length - cap;
  if (excess <= 0) return 0;
  let closed = 0;
  for (const p of open) {
    if (excess <= 0) break;
    if (keep.includes(p) || spare(p)) continue;
    try {
      await p.close();
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
      if (typeof read.url !== "string") return undefined; // unknown: spare everything
      return sync.mayNavigate(read.url) ? null : read.url;
    };
    const spareFilter = (spared) => (p) => spared === undefined || (spared !== null && p.url() === spared);

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
      if (!page) {
        // No same-host tab — adopt a residual about:blank (Brave always
        // opens one at launch) instead of leaving it around forever next
        // to a freshly created tab.
        page = bridge.context.pages().find((p) => !p.isClosed() && p.url() === "about:blank") || null;
        adoptedBlank = !!page;
      }
    }
    if (!page) page = await bridge.context.newPage();
    // T0-7: track the page as active BEFORE goto so a goto failure still
    // leaves us in a usable state — subsequent own-tools target this new
    // tab, not the previous active page or pages[0]'s about:blank.
    setActivePage(page);
    if (reused || adoptedBlank) {
      try { await page.bringToFront(); } catch { /* headless / already front */ }
    }

    let navError = null;
    if (url) {
      try {
        await page.goto(url, { waitUntil, timeout: timeoutMs });
      } catch (e) {
        navError = e.message || String(e);
      }
    }

    // Cap backstop — only a CREATE can push the count over the cap. MUST
    // run BEFORE upstream propagation: the prune can't identify upstream's
    // pinned page and may close it (it's among the oldest). Pruning first
    // lets propagation's navigation_go-to trigger upstream's
    // ensureSessionPageOpen → page recreated AND navigated in this same
    // call. Pruning after would leave upstream pinned to a fresh
    // about:blank until the next navigation — screenshots would capture
    // the wrong page.
    let prunedTabs = 0;
    if (!reused && !adoptedBlank) {
      try {
        const cap = maxTabsFromEnv();
        const open = bridge.context.pages().filter((p) => !p.isClosed()).length;
        const spare = cap > 0 && open > cap ? spareFilter(await sparedUrl()) : () => false;
        prunedTabs = await pruneOldestTabs(bridge.context.pages(), cap, [page], spare);
      } catch { /* best-effort */ }
    }

    // Propagate to upstream (best-effort) only if navigation succeeded.
    let propagation;
    if (navError) {
      propagation = { propagated: false, reason: "skipped: this tab's navigation failed" };
      sync.markDesynced(page.url(), null, propagation.reason);
    } else {
      propagation = await propagateActivePageToUpstream(url, { force });
    }

    const pages = bridge.context.pages();
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
  // Test seams.
  _findReusablePage: findReusablePage,
  _pruneOldestTabs: pruneOldestTabs,
  _maxTabsFromEnv: maxTabsFromEnv,
  _urlHost: urlHost,
};
