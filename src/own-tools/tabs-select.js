// tabs_select — bring a specific tab to the front by index.
//
// Active-page propagation: after Playwright's `bringToFront()`, we
// navigate upstream's tracked page (via its `navigation_go-to`) to the
// selected tab's URL. Upstream pins its `_page` reference at session
// init and never re-evaluates it from CDP `Target.activateTarget`
// notifications, so `bringToFront` alone leaves upstream's screenshot/
// snapshot tools targeting whatever page upstream originally grabbed —
// usually NOT the one the caller just selected. See
// _propagate-active-page.js for the full investigation.

const { propagateActivePageToUpstream } = require("./_propagate-active-page.js");
const { setActivePage } = require("./_active-page.js");
const sync = require("./_upstream-sync.js");

module.exports = {
  name: "tabs_select",
  description: "Bring a specific tab to the front (active page) by its index.",
  inputSchema: {
    type: "object",
    properties: {
      index: { type: "integer", minimum: 0 },
      allowPinnedPage: {
        type: "boolean",
        description: "Only when the relay reported UPSTREAM DESYNC and the page in upstream's tab is one YOU put there: lets the relay navigate that tab to this one. Never when the user may be using it.",
      },
    },
    required: ["index"],
  },
  handler: async ({ index, allowPinnedPage }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    const pages = bridge.context.pages();
    // V1-5: JSON-Schema `minimum: 0` is not enforced by the MCP SDK at
    // handler entry. Validate explicitly so bad inputs (-1, "abc", 999)
    // produce an actionable error instead of an undefined-property crash.
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
      return {
        content: [{ type: "text", text: `index out of range: ${index} (have ${pages.length} pages)` }],
        isError: true,
      };
    }
    // F1-3 (2026-05-10): track active page BEFORE bringToFront. If
    // bringToFront rejects (page being navigated, page closed mid-call),
    // we still track the user-intended page so subsequent own-tool calls
    // target it correctly. Previously a rejection meant setActivePage was
    // never called and the active page was whatever the prior caller set.
    setActivePage(pages[index]);
    const url = pages[index].url();
    try {
      await pages[index].bringToFront();
    } catch (e) {
      // bringToFront is cosmetic (just visual focus); failure shouldn't
      // block the active-page tracking. Log + continue with propagation.
      process.stderr.write(`[tabs_select] bringToFront failed (continuing): ${e.message}\n`);
    }
    // Propagate to upstream so content_take-screenshot etc. target this
    // tab's URL. Best-effort; about:blank is skipped to avoid churn.
    const propagation = await propagateActivePageToUpstream(url, { force: allowPinnedPage === true });
    const content = [{ type: "text", text: JSON.stringify({
      selected: index,
      url,
      upstreamPropagated: propagation.propagated,
      ...(propagation.propagated ? {} : { upstreamReason: propagation.reason, upstreamUrl: propagation.upstreamUrl || null }),
    }, null, 2) }];
    // Rule A: say it where the caller is already looking.
    const warn = sync.warning();
    if (warn) content.unshift({ type: "text", text: warn });
    return { content };
  },
};
