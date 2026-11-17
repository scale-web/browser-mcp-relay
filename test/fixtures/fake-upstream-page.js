// A fake upstream client for unit tests that models upstream's ONE pinned page:
// `execute` with the relay's URL probe returns the page's URL and target id (in
// structuredContent, as browser-devtools-mcp does), `execute` with
// __relayPin(id) moves the pin to the fake tab with that `tid` in the relay's
// bridge (scripts/patch-bdmcp-repin.js), navigation_go-to navigates the pinned
// tab, and every call is recorded. `st.url` reads / writes the pinned tab's URL
// once a tab is pinned (before that, upstream's own page). install() sets
// globalThis.__relayUpstream and returns a restore function; it also resets
// _upstream-sync.js.
const sync = require("../../src/own-tools/_upstream-sync.js");

const PIN_RE = /^return await __relayPin\(("[^"]*")\);$/;

function fakeUpstream({ url = "about:blank", fail = null, navFail = null, targetId = null, pinFail = null } = {}) {
  let ownUrl = url;
  const st = { targetId, pinned: null, pinFail, calls: [] };
  Object.defineProperty(st, "url", {
    get: () => (st.pinned ? st.pinned.url() : ownUrl),
    set: (v) => { if (st.pinned) st.pinned._url = v; else ownUrl = v; },
    enumerable: true,
  });
  const client = {
    request: async (method, params) => {
      st.calls.push({ method, params });
      if (fail) throw new Error(fail);
      const { name, arguments: a = {} } = params || {};
      const ok = (result) => {
        const out = { toolOutputs: [], logs: [], result };
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false };
      };
      if (name === "execute" && a.code === sync.URL_PROBE) return ok({ url: st.url, targetId: st.targetId });
      const pin = name === "execute" && typeof a.code === "string" ? PIN_RE.exec(a.code) : null;
      if (pin) {
        if (st.pinFail) {
          const out = { toolOutputs: [], logs: [], error: st.pinFail };
          return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false };
        }
        const id = JSON.parse(pin[1]);
        const bridge = globalThis.__relayBridge;
        const tab = bridge && bridge.context.pages().find((p) => p.tid === id && !(p.isClosed && p.isClosed()));
        if (!tab) {
          const out = { toolOutputs: [], logs: [], error: `__relayPin: no page for target ${id} in upstream's browser context` };
          return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false };
        }
        const changed = st.targetId !== id;
        st.pinned = tab;
        st.targetId = id;
        return ok({ targetId: id, url: tab.url(), changed, closedOwnBlank: false });
      }
      if (name === "navigation_go-to") {
        if (navFail !== null) return { content: [{ type: "text", text: navFail }], isError: true };
        st.url = a.url;
      }
      return { content: [{ type: "text", text: "{}" }] };
    },
  };
  st.client = client;
  st.named = (n) => st.calls.filter((c) => c.params && c.params.name === n);
  st.navs = () => st.named("navigation_go-to");
  st.pins = () => st.calls.filter((c) => c.params && c.params.name === "execute" && PIN_RE.test(c.params.arguments.code || ""));
  st.install = () => {
    const prev = globalThis.__relayUpstream;
    globalThis.__relayUpstream = async () => client;
    sync.reset();
    return () => { globalThis.__relayUpstream = prev; sync.reset(); };
  };
  return st;
}

let nextTid = 1;
/** A fake relay tab with a CDP target id (`tid`). */
function fakeTab(url = "about:blank", extra = {}) {
  return {
    tid: `T${nextTid++}`, _url: url, gotoUrls: [], closedByTest: false,
    url() { return this._url; }, isClosed() { return this.closedByTest; },
    async goto(u) { this.gotoUrls.push(u); this._url = u; }, async bringToFront() {}, once() {},
    async close() { this.closedByTest = true; },
    ...extra,
  };
}

/** A fake BrowserContext over `pages` whose CDP sessions report each tab's `tid`. */
function fakeContext(pages, { newPage } = {}) {
  return {
    pages: () => pages,
    newPage: newPage || (async () => { const p = fakeTab(); pages.push(p); return p; }),
    newCDPSession: async (p) => ({ send: async () => ({ targetInfo: { targetId: p.tid } }), detach: async () => {} }),
  };
}

module.exports = { fakeUpstream, fakeTab, fakeContext };
