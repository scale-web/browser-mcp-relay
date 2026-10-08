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

/**
 * Navigate upstream's tracked page to `url` so its tools (screenshot,
 * snapshots, etc.) target this URL. Best-effort — never throws.
 *
 * Skips when:
 * - url is empty / null / undefined
 * - url === "about:blank" (upstream's `_page` already starts there for new
 *   sessions, and navigating to about:blank is a no-op churn)
 * - globalThis.__relayUpstream is missing (shouldn't happen at runtime
 *   under the relay; only in unit tests)
 *
 * @param {string} url - target URL
 * @returns {Promise<{propagated: boolean, reason?: string}>}
 */
async function propagateActivePageToUpstream(url) {
  if (!url || url === "about:blank") {
    return { propagated: false, reason: "skipped: empty or about:blank" };
  }
  const getUpstream = globalThis.__relayUpstream;
  if (typeof getUpstream !== "function") {
    return { propagated: false, reason: "skipped: __relayUpstream not exposed" };
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
    return { propagated: true };
  } catch (e) {
    process.stderr.write(
      `[mcp-relay] tabs: upstream propagate to ${url} failed (continuing): ${e.message}\n`,
    );
    return { propagated: false, reason: `upstream error: ${e.message}` };
  }
}

module.exports = { propagateActivePageToUpstream };
