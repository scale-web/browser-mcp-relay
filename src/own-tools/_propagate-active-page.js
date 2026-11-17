// _propagate-active-page.js — point upstream at the relay's active tab.
//
// Why: upstream BDMCP runs every tool on ONE Playwright page,
// BrowserToolSessionContext._page, made at its first tool call and never
// re-evaluated (it ignores Target.activateTarget and the like; `_page` is only
// replaced when it closes). Until 2026-11-17 the relay kept it in step by
// NAVIGATING that page to the URL of the relay's tab: every session's first URL
// loaded in two tabs, and a second host navigated the session's working page
// away.
//
// Now (ask as-ops/ask-5ojuum rev 3, "Re-pin upstream to relay tab") the relay
// MOVES upstream's pin to its own tab, matched by CDP target id, through
// __relayPin in upstream's `execute` sandbox (scripts/patch-bdmcp-repin.js).
// No page is navigated to follow: tabs_select back to A gives upstream A again,
// with A's state intact. Upstream's own transient tab (made when it starts) is
// closed by the pin while it is still about:blank.
//
// Two entry points:
//   pinUpstreamToPage(page, {claim})  tabs_new / tabs_select: pin to that tab;
//                                     claim = the relay put its page there
//                                     (rule C, _upstream-sync.js).
//   pinUpstreamToActivePage()         relay-server, before each upstream call:
//                                     re-pin when upstream's pin is not the
//                                     tab tabs_new / tabs_select last made
//                                     active (upstream restarted, or its page
//                                     was re-created). Claims nothing; does
//                                     nothing without such a tab.
//
// Failure (upstream unreadable, not patched, or the tab is not in upstream's
// context): logged, recorded as a desync (rules A and B), and the tabs_* call
// still succeeds. Never throws.

const sync = require("./_upstream-sync.js");
const quiet = require("./_quiet-focus.js");
const { getActivePageRaw } = require("./_active-page.js");

function safeUrl(page) {
  try { return page.url(); } catch { return null; }
}

/**
 * Pin upstream's page to `page` (one of the relay's context pages).
 * @returns {Promise<{propagated: boolean, reason?: string, upstreamUrl?: string, closedOwnBlank?: boolean}>}
 */
async function pinUpstreamToPage(page, { claim = true } = {}) {
  if (typeof globalThis.__relayUpstream !== "function") {
    return { propagated: false, reason: "skipped: __relayUpstream not exposed" };
  }
  const bridge = globalThis.__relayBridge;
  const url = safeUrl(page);
  let targetId = null;
  try { targetId = await quiet.targetIdOf(bridge.context, page); } catch (e) {
    const reason = `could not read this tab's CDP target id: ${e.message}`;
    sync.markDesynced(url, null, reason);
    return { propagated: false, reason };
  }
  const pinned = await sync.pinUpstream(targetId);
  if (pinned.error) {
    const reason = `upstream could not be pointed at this tab: ${pinned.error}`;
    process.stderr.write(`[mcp-relay] tabs: ${reason}\n`);
    const now = await sync.readUpstreamUrl();
    sync.markDesynced(url, typeof now.url === "string" ? now.url : null, reason);
    return { propagated: false, reason, upstreamUrl: typeof now.url === "string" ? now.url : undefined };
  }
  sync.markSynced(null);
  if (claim) sync.claim(pinned.url);
  return { propagated: true, upstreamUrl: pinned.url, ...(pinned.closedOwnBlank ? { closedOwnBlank: true } : {}) };
}

/**
 * relay-server, before forwarding an upstream call: when tabs_new / tabs_select
 * made a tab active and upstream is pinned elsewhere, pin it there (no claim).
 * Returns upstream's read ({url, targetId} / {error}) or null when nothing was checked.
 */
async function pinUpstreamToActivePage() {
  const page = getActivePageRaw();
  const bridge = globalThis.__relayBridge;
  if (!page || !bridge || typeof globalThis.__relayUpstream !== "function") return null;
  try { if (page.isClosed()) return null; } catch { return null; }
  let want = null;
  try { want = await quiet.targetIdOf(bridge.context, page); } catch { return null; }
  const now = await sync.readUpstreamUrl();
  if (now.targetId === want) {
    if (sync.isDesynced()) sync.markSynced(null); // already on it: a stale failure no longer applies
    return now;
  }
  const r = await pinUpstreamToPage(page, { claim: false });
  return r.propagated ? { url: r.upstreamUrl, targetId: want } : now;
}

module.exports = { pinUpstreamToPage, pinUpstreamToActivePage };
