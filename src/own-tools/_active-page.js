// _active-page.js — shared "which page is the user looking at" state
// for own-tools. tabs_new + tabs_select update it; other tools read it.
//
// Why this exists: Playwright's context.pages() returns pages in CREATION
// order, and Brave auto-opens about:blank as pages[0]. Without this tracker,
// every own-tool would fire against the about:blank instead of the page
// the user actually just opened or selected.
//
// Pairs with _propagate-active-page.js which solves the same problem on
// the upstream-MCP side.

let activePage = null;

function setActivePage(page) {
  // Re-setting the SAME page is a no-op — tab reuse makes repeated
  // setActivePage(page) on one Page object the mainline path, and
  // re-attaching the close listener each time would accumulate one-shot
  // closures until MaxListenersExceededWarning.
  if (activePage === page) return;
  activePage = page;
  // G1-1 (2026-05-10): if the page closes externally (Brave UI close, page
  // crash, navigation that destroys the page object), null out the
  // tracked ref. Without this, the closed Page object stays GC-pinned by
  // the module scope until the next setActivePage call. Also matters for
  // getActivePage's fallback chain — `activePage.isClosed()` returns true
  // after close, but the explicit null means `getActivePageRaw()` and
  // anything else reading the variable directly sees the right answer.
  if (page && typeof page.once === "function") {
    page.once("close", () => {
      if (activePage === page) activePage = null;
    });
  }
}

/**
 * T0-8: clear the tracked active page. Used by tabs_close when closing the
 * active page itself — without this, the next own-tool call sees the closed
 * page, falls through `activePage.isClosed()` to `pages[length-1]`, which
 * may be Brave's residual about:blank. Tabs-close is the canonical caller.
 *
 * Test seam — exposed primarily so unit tests can reset module state, but
 * also used by tabs-close in production.
 */
function clearActivePage() {
  activePage = null;
}

/** Read-only accessor for tests + diagnostics. */
function getActivePageRaw() {
  return activePage;
}

/**
 * Get the page own-tools should target. Order:
 *   1. The explicit active page if set + still open
 *   2. The last page in the context (tabs_new appends, so this is usually right)
 *   3. The first page (last resort — works for the common single-page case)
 *
 * @param {import('playwright-core').BrowserContext} context
 * @returns {import('playwright-core').Page | null}
 */
function getActivePage(context) {
  if (activePage && !activePage.isClosed()) return activePage;
  const pages = context.pages();
  if (pages.length === 0) return null;
  return pages[pages.length - 1] || pages[0];
}

/**
 * V1-9: tool-handler wrapper that resolves bridge + active page, returning
 * a structured "bridge missing" / "no pages open" error result if either
 * is unavailable. Removes ~10 lines of identical boilerplate from each of
 * 13 own-tool handlers + standardizes the error messages.
 *
 * @template T
 * @param {(ctx: { bridge: { context: import('playwright-core').BrowserContext, port: number, cdpConnectUrl: string }, page: import('playwright-core').Page }) => Promise<T>} handler
 * @returns {Promise<T | { content: Array<{type:"text", text:string}>, isError: true }>}
 */
async function withActivePage(handler) {
  const bridge = globalThis.__relayBridge;
  if (!bridge) {
    return {
      content: [{ type: "text", text: "bridge missing" }],
      isError: true,
    };
  }
  const page = getActivePage(bridge.context);
  if (!page) {
    return {
      content: [{ type: "text", text: "no pages open" }],
      isError: true,
    };
  }
  return handler({ bridge, page });
}

module.exports = { setActivePage, getActivePage, withActivePage, clearActivePage, getActivePageRaw };
