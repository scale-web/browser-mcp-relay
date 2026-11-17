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
// Failure (upstream unreadable, or the tab is not in upstream's context):
// logged, recorded as a desync (rules A and B), and the tabs_* call still
// succeeds. Never throws.
//
// R1 not applied (review r1 L3: an upstream upgrade changed the bundle shape,
// so __relayPin does not exist): the pre-re-pin behaviour, kept below as
// propagateActivePageToUpstream — tabs_new / tabs_select NAVIGATE upstream's
// own tab to the selected tab's URL (rule C protects a page the relay did not
// put there; `force` = the caller's allowPinnedPage). No re-pin before each
// upstream call in that mode: it would undo upstream's own navigations.
// relay_status shows the state (upstreamRepin, _upstream-sync.js repinState()).

const sync = require("./_upstream-sync.js");
const quiet = require("./_quiet-focus.js");
const { getActivePageRaw } = require("./_active-page.js");

function safeUrl(page) {
  try { return page.url(); } catch { return null; }
}

/**
 * Pin upstream's page to `page` (one of the relay's context pages).
 * R1 not applied: with onUnpatched "navigate" (default), navigate upstream's
 * own tab to this tab's URL instead (`force`: rule C does not apply); with
 * "none", return { propagated: false, unpatched: true } and record nothing
 * (tabs_new, which navigates after its goto).
 * @returns {Promise<{propagated: boolean, reason?: string, upstreamUrl?: string, closedOwnBlank?: boolean, unpatched?: boolean, via?: string}>}
 */
async function pinUpstreamToPage(page, { claim = true, force = false, onUnpatched = "navigate" } = {}) {
  if (typeof globalThis.__relayUpstream !== "function") {
    return { propagated: false, reason: "skipped: __relayUpstream not exposed" };
  }
  const bridge = globalThis.__relayBridge;
  const url = safeUrl(page);
  const unpatched = async () => (onUnpatched === "navigate"
    ? { ...(await propagateActivePageToUpstream(url, { force })), via: "navigation" }
    : { propagated: false, unpatched: true, reason: sync.NOT_PATCHED });
  if (sync.repinState().available === false) return unpatched();
  let targetId = null;
  try { targetId = await quiet.targetIdOf(bridge.context, page); } catch (e) {
    const reason = `could not read this tab's CDP target id: ${e.message}`;
    sync.markDesynced(url, null, reason);
    return { propagated: false, reason };
  }
  const pinned = await sync.pinUpstream(targetId);
  if (pinned.notPatched) {
    process.stderr.write(`[mcp-relay] tabs: ${pinned.error} — tabs_new / tabs_select navigate upstream's own tab instead\n`);
    sync.noteRepin(false, pinned.error);
    return unpatched();
  }
  if (pinned.error) {
    const reason = `upstream could not be pointed at this tab: ${pinned.error}`;
    process.stderr.write(`[mcp-relay] tabs: ${reason}\n`);
    const now = await sync.readUpstreamUrl();
    sync.markDesynced(url, typeof now.url === "string" ? now.url : null, reason);
    return { propagated: false, reason, upstreamUrl: typeof now.url === "string" ? now.url : undefined };
  }
  sync.noteRepin(true, null);
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
  if (sync.repinState().available === false) return null; // R1 not applied: tabs_* navigate instead
  try { if (page.isClosed()) return null; } catch { return null; }
  let want = null;
  try { want = await quiet.targetIdOf(bridge.context, page); } catch { return null; }
  const now = await sync.readUpstreamUrl();
  if (now.targetId === want) {
    if (sync.isDesynced()) sync.markSynced(null); // already on it: a stale failure no longer applies
    return now;
  }
  const r = await pinUpstreamToPage(page, { claim: false, onUnpatched: "none" });
  return r.propagated ? { url: r.upstreamUrl, targetId: want } : now;
}

/**
 * R1 not applied only (review r1 L3): the pre-re-pin propagation, unchanged
 * from main — point upstream's own tab at `url` through its navigation_go-to,
 * only when that tab shows a page the relay put there (rule C) or `force`.
 * Best-effort, never throws; records the outcome in _upstream-sync.js.
 * @returns {Promise<{propagated: boolean, reason?: string, upstreamUrl?: string}>}
 */
async function propagateActivePageToUpstream(url, { force = false } = {}) {
  // A blank tab is no navigation target, and asking upstream anything would
  // start its session. Upstream tools still act on another tab, though.
  if (!url || url === "about:blank") {
    const reason = "skipped: the selected tab is empty or about:blank";
    sync.markDesynced(url, null, reason);
    return { propagated: false, reason };
  }
  const getUpstream = globalThis.__relayUpstream;
  if (typeof getUpstream !== "function") {
    return { propagated: false, reason: "skipped: __relayUpstream not exposed" };
  }
  const read = await sync.readUpstreamUrl();
  if (typeof read.url !== "string") {
    const reason = `could not read upstream's page: ${read.error}`;
    sync.markDesynced(url, null, reason);
    return { propagated: false, reason };
  }
  const current = read.url;
  if (force) sync.claim(current);
  if (current === url) {
    sync.markSynced(sync.mayNavigate(current) ? url : null);
    return { propagated: true, reason: "already showing", upstreamUrl: current };
  }
  if (!sync.mayNavigate(current)) {
    const reason = "protected: upstream's tab shows a page the relay did not put there (the user's, or one that changed its own URL), so it was not navigated";
    process.stderr.write(`[mcp-relay] tabs: upstream tab shows ${current}, not the relay's; left as is\n`);
    sync.markDesynced(url, current, reason);
    return { propagated: false, reason, upstreamUrl: current };
  }
  try {
    const upstream = await getUpstream();
    // Upstream's own navigation pipeline; no snapshot / screenshot (latency).
    const result = await upstream.request("tools/call", {
      name: "navigation_go-to",
      arguments: { url, includeSnapshot: false, includeScreenshot: false },
    });
    // Upstream reports a failed tool as a normal result with isError: true.
    if (result && result.isError) {
      const text = Array.isArray(result.content)
        ? result.content.filter((c) => c && c.type === "text").map((c) => c.text).join(" ").trim()
        : "";
      throw new Error(text || "navigation_go-to returned isError");
    }
  } catch (e) {
    process.stderr.write(`[mcp-relay] tabs: upstream propagate to ${url} failed (continuing): ${e.message}\n`);
    // A navigation can fail after it committed: if upstream's tab now shows the URL, the relay put it there.
    const landedAnyway = await sync.readUpstreamUrl();
    if (landedAnyway.url === url) {
      sync.markSynced(url);
      return { propagated: true, reason: `landed despite: ${e.message}`, upstreamUrl: url };
    }
    const reason = `upstream error: ${e.message}`;
    sync.markDesynced(url, null, reason);
    return { propagated: false, reason };
  }
  // The relay put this page there: own its final URL (after redirects).
  const after = await sync.readUpstreamUrl();
  const landed = typeof after.url === "string" ? after.url : url;
  sync.markSynced(landed);
  return { propagated: true, upstreamUrl: landed };
}

module.exports = { pinUpstreamToPage, pinUpstreamToActivePage, propagateActivePageToUpstream };
