// _propagate-active-page.js — shared helper for tabs_new / tabs_select.
//
// Why: upstream BDMCP captures ONE specific Playwright Page reference at
// CDP-attach time (see node_modules/browser-devtools-mcp/dist/core-*.js,
// `createToolSessionContext` → `newPage(browserContext)` →
// `BrowserToolSessionContext._page`). Upstream tools like
// `content_take-screenshot`, `a11y_take-aria-snapshot`,
// `content_get-as-text` etc. all dispatch on `context.page` (i.e. that
// single `_page` reference). Upstream does NOT listen to CDP
// `Target.activateTarget`, `Target.targetCreated`, or any other signal
// that would cause it to re-evaluate which Page is "active" — verified
// by grepping the dist bundle for those symbols (zero hits in upstream
// code paths). `_page` only swaps when it isClosed(), and even then
// upstream creates yet another fresh page via `browserContext.newPage()`
// rather than picking an existing one.
//
// Consequence: when our `tabs_new` calls `bridge.context.newPage()` or
// our `tabs_select` calls `pages[i].bringToFront()`, upstream's `_page`
// stays pinned to whatever it grabbed at first tool dispatch (typically
// pages[1] — pages[0] is Brave's auto-opened about:blank, pages[1] is
// upstream's dedicated page from its own newPage() call). A subsequent
// `content_take-screenshot` then captures upstream's `_page`, NOT the
// page the user just opened/selected.
//
// Fix: route the URL through upstream's own `navigation_go-to` tool, so
// upstream's tracked page navigates to the URL the user expects to be
// "active". The relay-side Playwright page still exists (visible via
// `tabs_list`) but upstream's screenshot/snapshot tools now target the
// correct URL. This is the only externally observable lever — anything
// else (closing upstream's page, monkey-patching newPage, sending CDP
// activateTarget) is either a no-op or strictly worse.
//
// Failure mode: if upstream isn't ready or `navigation_go-to` errors
// (e.g. blocked file://, network failure) — whether it throws or returns
// an `isError` result — we LOG and CONTINUE rather
// than fail the tabs_* call. The relay-side page is still created/
// brought to front; only the upstream-propagation half failed. This
// keeps the tabs_* tools robust for offline/file-only flows.
//
// Non-destructive (2026-10-13, ALA-CRO's lost tab): navigating upstream's
// pinned page REPLACES what it shows, and that page can be one the user is
// working in. So before navigating we read its URL (upstream `execute`,
// `return page.url()`) and navigate only a page the relay put there — see
// _upstream-sync.js rule C. Otherwise the pinned page is left as it is and
// the relay records the desync, which warns on, and guards, every later
// upstream call.

const sync = require("./_upstream-sync.js");

/**
 * Point upstream's tracked page at `url` so its tools (screenshot,
 * snapshots, execute, etc.) act on the URL the caller selected.
 * Best-effort — never throws. Records the outcome in _upstream-sync.js.
 *
 * Returns propagated: true when upstream's page now shows `url` (already
 * showing it counts — no reload). Returns propagated: false, with a reason,
 * when:
 * - url is empty / about:blank (no upstream call at all)
 * - globalThis.__relayUpstream is missing (only in unit tests; state untouched)
 * - upstream's URL can't be read (left as is: we can't tell whose page it is)
 * - upstream's page shows a page the relay did not put there (left as is)
 * - upstream's navigation_go-to fails
 *
 * @param {string} url - target URL
 * @returns {Promise<{propagated: boolean, reason?: string, upstreamUrl?: string}>}
 */
async function propagateActivePageToUpstream(url) {
  // A blank tab is no navigation target, and asking upstream anything would
  // start its session (it opens a page of its own on its first call). Upstream
  // tools still act on another tab, though: the 2026-10-13 incident began with
  // exactly this (tabs_select of a blank tab, then execute's page.goto).
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
  if (current === url) {
    sync.markSynced(sync.mayNavigate(current) ? url : null);
    return { propagated: true, reason: "already showing", upstreamUrl: current };
  }
  if (!sync.mayNavigate(current)) {
    const reason = "protected: upstream's tab shows a page the relay did not put there (likely the user's), so it was not navigated";
    process.stderr.write(`[mcp-relay] tabs: upstream tab shows ${current}, not the relay's; left as is\n`);
    sync.markDesynced(url, current, reason, true);
    return { propagated: false, reason, upstreamUrl: current };
  }
  try {
    const upstream = await getUpstream();
    // Forward as a tools/call so upstream runs its standard navigation
    // pipeline (CDP attach if needed, network-idle wait, etc.). Disable
    // snapshot/screenshot — we only care about the side effect of
    // upstream's `_page` being navigated. includeSnapshot/Screenshot
    // default true on upstream, which would double our latency.
    const result = await upstream.request("tools/call", {
      name: "navigation_go-to",
      arguments: { url, includeSnapshot: false, includeScreenshot: false },
    });
    // Upstream reports a failed tool as a normal result with isError: true,
    // not by throwing — treat it exactly like a throw.
    if (result && result.isError) {
      const text = Array.isArray(result.content)
        ? result.content.filter((c) => c && c.type === "text").map((c) => c.text).join(" ").trim()
        : "";
      throw new Error(text || "navigation_go-to returned isError");
    }
  } catch (e) {
    process.stderr.write(
      `[mcp-relay] tabs: upstream propagate to ${url} failed (continuing): ${e.message}\n`,
    );
    const reason = `upstream error: ${e.message}`;
    sync.markDesynced(url, null, reason);
    return { propagated: false, reason };
  }
  // The relay put this page there. Own its final URL (after redirects); if
  // that can't be read, own the URL we asked for.
  const after = await sync.readUpstreamUrl();
  const landed = typeof after.url === "string" ? after.url : url;
  sync.markSynced(landed);
  return { propagated: true, upstreamUrl: landed };
}

module.exports = { propagateActivePageToUpstream };
