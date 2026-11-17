// A fake upstream client for unit tests that models upstream's ONE pinned page:
// `execute` with the relay's URL probe returns the page's URL and target id (in
// structuredContent, as browser-devtools-mcp does), navigation_go-to moves it,
// and every call is recorded. install() sets globalThis.__relayUpstream and
// returns a restore function; it also resets _upstream-sync.js.
const sync = require("../../src/own-tools/_upstream-sync.js");

function fakeUpstream({ url = "about:blank", fail = null, navFail = null, targetId = null } = {}) {
  const st = { url, targetId, calls: [] };
  const client = {
    request: async (method, params) => {
      st.calls.push({ method, params });
      if (fail) throw new Error(fail);
      const { name, arguments: a = {} } = params || {};
      if (name === "execute" && a.code === sync.URL_PROBE) {
        const out = { toolOutputs: [], logs: [], result: { url: st.url, targetId: st.targetId } };
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false };
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
  st.install = () => {
    const prev = globalThis.__relayUpstream;
    globalThis.__relayUpstream = async () => client;
    sync.reset();
    return () => { globalThis.__relayUpstream = prev; sync.reset(); };
  };
  return st;
}

module.exports = { fakeUpstream };
