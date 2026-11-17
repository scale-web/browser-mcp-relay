// tabs_select — bring a specific tab to the front by index.
//
// Upstream follows by re-pin (2026-11-17, ask as-ops/ask-5ojuum rev 3): the
// selected tab becomes the page upstream's tools act on — its pin is moved to
// this tab by CDP target id (_propagate-active-page.js). Nothing is navigated
// or reloaded, so selecting back to an earlier tab gives upstream that tab
// with its state intact. Selecting a tab claims its page for the relay
// (rule C, _upstream-sync.js), as selecting it always did.

const { pinUpstreamToPage } = require("./_propagate-active-page.js");
const { setActivePage } = require("./_active-page.js");
const sync = require("./_upstream-sync.js");
const quiet = require("./_quiet-focus.js");

module.exports = {
  name: "tabs_select",
  description: "Select a tab (the active page for subsequent tools) by its index. It is raised on screen only when this relay's Brave is already the front app, so the user's focus is never taken.",
  inputSchema: {
    type: "object",
    properties: {
      index: { type: "integer", minimum: 0 },
      allowPinnedPage: {
        type: "boolean",
        description: "Accepted for compatibility; selecting a tab always points upstream's tools at it (no navigation).",
      },
    },
    required: ["index"],
  },
  handler: async ({ index }) => {
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
      // Raising activates Brave and pulls a user out of a full-screen app,
      // so only when Brave is already in front (_quiet-focus.js); the tab is
      // live and tracked either way.
      await quiet.raiseIfFront(pages[index], bridge.bravePid);
    } catch (e) {
      // bringToFront is cosmetic (just visual focus); failure shouldn't
      // block the active-page tracking. Log + continue with propagation.
      process.stderr.write(`[tabs_select] bringToFront failed (continuing): ${e.message}\n`);
    }
    // Upstream's tools act on this tab from now on (best-effort).
    const propagation = await pinUpstreamToPage(pages[index], { claim: true });
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
