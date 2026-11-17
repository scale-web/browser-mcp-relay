// Rules A (warn), B (refuse) and the ownership half of C, through the real
// RelayServer. Kit staging 2026-10-13-relay-active-page/FINDINGS.md. Since the
// re-pin (ask as-ops/ask-5ojuum rev 3) a desync means a pin FAILED; the relay
// re-pins upstream to the active tab before each forwarded call.
const test = require("node:test");
const assert = require("node:assert");
const { RelayServer } = require("../src/relay-server.js");
const sync = require("../src/own-tools/_upstream-sync.js");
const { pinUpstreamToPage } = require("../src/own-tools/_propagate-active-page.js");
const { setActivePage, clearActivePage } = require("../src/own-tools/_active-page.js");
const { fakeUpstream, fakeTab, fakeContext } = require("./fixtures/fake-upstream-page.js");
// A76: in production src/index.js marks the request-body source patch as in
// effect before upstream spawns; these tests drive RelayServer directly, so
// they set it themselves (otherwise execute is refused, fail closed).
require("../src/request-body-filter.js").setSourcePatchInEffect(true);

function setup(url = "about:blank", upOpts = {}) {
  clearActivePage();
  const tabs = [fakeTab("https://site.example/login")];
  globalThis.__relayBridge = { context: fakeContext(tabs) };
  const up = fakeUpstream({ url, ...upOpts });
  const restore0 = up.install();
  const restore = () => { restore0(); globalThis.__relayBridge = undefined; clearActivePage(); };
  const orig = up.client.request;
  up.client.request = async (m, p) => (m === "tools/list"
    ? { tools: [
      { name: "execute", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
      { name: "navigation_go-to", inputSchema: { type: "object" } },
      { name: "interaction_click", inputSchema: { type: "object", properties: { ref: { type: "string" } } } },
      { name: "content_take-screenshot", inputSchema: { type: "object" } },
    ] }
    : orig(m, p));
  const relay = new RelayServer({ getUpstream: async () => up.client });
  return { up, relay, restore, tab: tabs[0], tabs };
}
/** A failed pin (a generic re-pin error; R1 missing is the fallback: propagate-active-page.test.js): upstream still on its page. */
async function desyncByFailedPin(tab) {
  await pinUpstreamToPage(tab);
  assert.strictEqual(sync.isDesynced(), true);
}
const forwarded = (up, name) => up.calls.filter((c) => c.params && c.params.name === name
  && !(name === "execute" && (c.params.arguments.code === sync.URL_PROBE || /__relayPin\(/.test(c.params.arguments.code))));

test("isGuarded: execute, scenario-run, navigation_*, interaction_* only", () => {
  for (const n of ["execute", "scenario-run", "navigation_go-to", "navigation_reload", "navigation_go-back-or-forward", "interaction_click", "interaction_fill"]) {
    assert.strictEqual(sync.isGuarded(n), true, n);
  }
  for (const n of ["content_take-screenshot", "a11y_take-aria-snapshot", "o11y_get-console-messages", "stub_clear", "tabs_select", "scenario-list", undefined]) {
    assert.strictEqual(sync.isGuarded(n), false, String(n));
  }
});

test("stripOptIn: removes the key; only `true` opts in", () => {
  assert.deepStrictEqual(sync.stripOptIn({ code: "x", allowPinnedPage: true }), { args: { code: "x" }, optIn: true });
  assert.deepStrictEqual(sync.stripOptIn({ code: "x", allowPinnedPage: "true" }), { args: { code: "x" }, optIn: false });
  assert.deepStrictEqual(sync.stripOptIn({ code: "x" }), { args: { code: "x" }, optIn: false });
  assert.deepStrictEqual(sync.stripOptIn(undefined), { args: undefined, optIn: false });
});

test("B: while desynced, guarded tools are refused and never reach upstream", async () => {
  const { up, relay, restore, tab } = setup("https://user-signed-in.example/dashboard", { pinFail: "__relayPin: no page for target T0 in upstream's browser context" });
  try {
    await desyncByFailedPin(tab);
    for (const [name, args] of [["execute", { code: "await page.goto('https://x.example/')" }], ["navigation_go-to", { url: "https://x.example/" }], ["interaction_click", { ref: "e1" }], ["scenario-run", { name: "s" }]]) {
      const r = await relay.handleToolsCall({ name, arguments: args });
      assert.strictEqual(r.isError, true, name);
      assert.match(r.content[0].text, new RegExp(`REFUSED ${name}`), name);
      assert.match(r.content[0].text, /allowPinnedPage/);
      assert.strictEqual(forwarded(up, name).length, 0, `${name} must not reach upstream`);
    }
    assert.strictEqual(up.url, "https://user-signed-in.example/dashboard");
  } finally { restore(); }
});

test("A: while desynced, a read-only upstream tool runs and its result leads with the warning", async () => {
  const { up, relay, restore, tab } = setup("https://user-signed-in.example/dashboard", { pinFail: "__relayPin: no page for target T0 in upstream's browser context" });
  try {
    await desyncByFailedPin(tab);
    const r = await relay.handleToolsCall({ name: "content_take-screenshot", arguments: {} });
    assert.notStrictEqual(r.isError, true);
    assert.match(r.content[0].text, /UPSTREAM DESYNC.*user-signed-in\.example\/dashboard/);
    assert.strictEqual(r.content[1].text, "{}");
    assert.strictEqual(forwarded(up, "content_take-screenshot").length, 1);
  } finally { restore(); }
});

test("B: allowPinnedPage: true forwards (key stripped), still warns, and does not hand the user's tab to the relay", async () => {
  const { up, relay, restore, tab } = setup("https://user-signed-in.example/dashboard", { pinFail: "__relayPin: no page for target T0 in upstream's browser context" });
  try {
    await desyncByFailedPin(tab);
    const r = await relay.handleToolsCall({ name: "execute", arguments: { code: "return 1", allowPinnedPage: true } });
    assert.notStrictEqual(r.isError, true);
    assert.match(r.content[0].text, /UPSTREAM DESYNC/);
    const sent = forwarded(up, "execute");
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].params.arguments, { code: "return 1" }, "the relay-only key never reaches upstream");
    assert.strictEqual(sync.state().relayUrl, null);
    assert.strictEqual(sync.mayNavigate(up.url), false, "so tabs_new still spares the user's tab (rule C)");
    assert.strictEqual(up.navs().length, 0);
  } finally { restore(); }
});

test("synced: guarded tools forward with no warning; a page the relay drove stays the relay's", async () => {
  const { up, relay, restore, tab } = setup("about:blank");
  try {
    assert.strictEqual((await pinUpstreamToPage(tab)).propagated, true);
    const r = await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://b.example/" } });
    assert.strictEqual(r.content.length, 1, "no warning while synced");
    assert.strictEqual(up.url, "https://b.example/");
    assert.strictEqual(tab.url(), "https://b.example/", "upstream navigated the relay's own tab");
    assert.strictEqual(sync.state().relayUrl, "https://b.example/", "the relay drove a → b, so b is the relay's");
  } finally { restore(); }
});

test("a sync clears the desync: guarded tools run again", async () => {
  const { up, relay, restore, tab } = setup("about:blank", { pinFail: "__relayPin: no page for target T0 in upstream's browser context" });
  try {
    await desyncByFailedPin(tab);
    assert.strictEqual((await relay.handleToolsCall({ name: "execute", arguments: { code: "1" } })).isError, true);
    up.pinFail = null;
    await pinUpstreamToPage(tab);
    const r = await relay.handleToolsCall({ name: "execute", arguments: { code: "1" } });
    assert.notStrictEqual(r.isError, true);
    assert.strictEqual(forwarded(up, "execute").length, 1);
  } finally { restore(); }
});

test("tools/list: guarded upstream tools advertise allowPinnedPage; others and existing properties are untouched", async () => {
  const { relay, restore } = setup();
  try {
    const { tools } = await relay.handleToolsList();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.strictEqual(by.execute.inputSchema.properties.allowPinnedPage.type, "boolean");
    assert.strictEqual(by.execute.inputSchema.properties.code.type, "string");
    assert.deepStrictEqual(by.execute.inputSchema.required, ["code"]);
    assert.ok(by["navigation_go-to"].inputSchema.properties.allowPinnedPage);
    assert.ok(by.interaction_click.inputSchema.properties.ref);
    assert.strictEqual(by["content_take-screenshot"].inputSchema.properties, undefined);
  } finally { restore(); }
});

test("reset: a new upstream child forgets the desync and the relay's page", () => {
  sync.markSynced("https://a.example/");
  sync.markDesynced("about:blank", null, "x");
  sync.reset();
  assert.deepStrictEqual(sync.state(), { desynced: false, relayUrl: null });
});

test("H2: execute and interaction_* never hand the page to the relay; a navigation_* from the relay's page does", async () => {
  const { up, restore, tab } = setup("about:blank");
  try {
    await pinUpstreamToPage(tab);
    for (const name of ["execute", "scenario-run", "interaction_click", "interaction_fill"]) {
      const before = await sync.readUpstreamUrl();
      up.url = "https://site.example/dashboard"; // the user signed in while the call waited
      await sync.afterGuardedCall({ before, name });
      assert.strictEqual(sync.state().relayUrl, "https://site.example/login", name);
      up.url = "https://site.example/login";
    }
    const b3 = await sync.readUpstreamUrl();
    up.url = "https://heavy.example/";
    await sync.afterGuardedCall({ before: b3, name: "navigation_go-to" });
    assert.strictEqual(sync.state().relayUrl, "https://heavy.example/");
  } finally { restore(); }
});

test("H2: opted in, a navigation_* the caller chose is the relay's; an execute is not", async () => {
  const { up, restore } = setup("https://user.example/dashboard");
  try {
    const before = await sync.readUpstreamUrl();
    up.url = "https://user.example/elsewhere";
    await sync.afterGuardedCall({ before, name: "execute", optIn: true });
    assert.strictEqual(sync.state().relayUrl, null);
    up.url = "https://chosen.example/";
    await sync.afterGuardedCall({ before, name: "navigation_go-to", optIn: true });
    assert.strictEqual(sync.state().relayUrl, "https://chosen.example/");
  } finally { restore(); }
});

test("r3 through the relay: a click that waits while the user signs in does not claim the page", async () => {
  const { up, relay, restore, tab } = setup("about:blank");
  const orig = up.client.request;
  up.client.request = async (m, p) => {
    if (p && p.name === "interaction_click") {
      up.url = "https://site.example/dashboard"; // waitForNavigation resolved on the user's sign-in
      return { content: [{ type: "text", text: "{}" }] };
    }
    return orig(m, p);
  };
  try {
    await pinUpstreamToPage(tab);
    await relay.handleToolsCall({ name: "interaction_click", arguments: { selector: "#go", waitForNavigation: true } });
    assert.strictEqual(sync.state().relayUrl, "https://site.example/login");
    assert.strictEqual(sync.mayNavigate(up.url), false, "tabs_new spares it (rule C)");
    assert.strictEqual(up.url, "https://site.example/dashboard");
  } finally { restore(); }
});

test("r2 H2: a short execute on the relay's page never claims what it ends on (a sign-in wait returns when the user finishes)", async () => {
  const { up, relay, restore, tab } = setup("about:blank");
  const orig = up.client.request;
  up.client.request = async (m, p) => {
    if (p && p.name === "execute" && p.arguments.code === "waitForSignIn") {
      up.url = "https://site.example/dashboard"; // the user finished; execute returns at once
      return { content: [{ type: "text", text: "{}" }] };
    }
    return orig(m, p);
  };
  try {
    await pinUpstreamToPage(tab);
    await relay.handleToolsCall({ name: "execute", arguments: { code: "waitForSignIn" } });
    assert.strictEqual(sync.state().relayUrl, "https://site.example/login");
    assert.strictEqual(sync.mayNavigate(up.url), false, "tabs_new spares it (rule C)");
    assert.strictEqual(up.url, "https://site.example/dashboard");
  } finally { restore(); }
});

test("r2: a navigation_* from a page that is not the relay's, not opted in, does not claim", async () => {
  const { up, restore } = setup("https://user.example/dashboard");
  try {
    const before = await sync.readUpstreamUrl();
    up.url = "https://elsewhere.example/";
    await sync.afterGuardedCall({ before, name: "navigation_go-to", optIn: false });
    assert.strictEqual(sync.state().relayUrl, null);
  } finally { restore(); }
});

test("r3 LOW: go-back / go-forward land on a history entry the caller didn't choose, so they never claim", async () => {
  const { up, restore, tab } = setup("about:blank");
  tab._url = "https://site.example/r";
  try {
    await pinUpstreamToPage(tab);
    const before = await sync.readUpstreamUrl();
    up.url = "https://user.example/signed-in"; // forward lands on the user's page
    await sync.afterGuardedCall({ before, name: "navigation_go-back-or-forward" });
    assert.strictEqual(sync.state().relayUrl, "https://site.example/r");
    up.url = "https://site.example/r?reloaded";
    await sync.afterGuardedCall({ before: { url: "https://site.example/r" }, name: "navigation_reload" });
    assert.strictEqual(sync.state().relayUrl, "https://site.example/r?reloaded");
  } finally { restore(); }
});

test("r4: an opted-in reload of the user's page does not hand it to the relay", async () => {
  const { up, restore } = setup("https://user.example/signed-in");
  try {
    const before = await sync.readUpstreamUrl();
    await sync.afterGuardedCall({ before, name: "navigation_reload", optIn: true });
    assert.strictEqual(sync.state().relayUrl, null);
    assert.strictEqual(sync.mayNavigate(up.url), false);
    assert.strictEqual(up.url, "https://user.example/signed-in");
  } finally { restore(); }
});

test("before each forwarded call the relay re-pins upstream to the active tab (a restarted upstream), claiming nothing", async () => {
  const { up, relay, restore, tabs } = setup("about:blank");
  try {
    const typed = fakeTab("https://user.example/typed");
    tabs.push(typed);
    setActivePage(typed);
    const r = await relay.handleToolsCall({ name: "content_take-screenshot", arguments: {} });
    assert.notStrictEqual(r.isError, true);
    assert.strictEqual(up.targetId, typed.tid, "upstream now acts on the active tab");
    const order = up.calls.map((c) => c.params && (c.params.name === "execute" && /__relayPin/.test(c.params.arguments.code) ? "pin" : c.params.name));
    assert.ok(order.indexOf("pin") < order.indexOf("content_take-screenshot"), "the pin comes first");
    assert.strictEqual(sync.state().relayUrl, null, "an automatic re-pin claims nothing");
    await relay.handleToolsCall({ name: "content_take-screenshot", arguments: {} });
    assert.strictEqual(up.pins().length, 1, "no second pin while it is already there");
  } finally { restore(); }
});

test("a failed automatic re-pin is a desync: guarded tools are refused", async () => {
  const { up, relay, restore, tab } = setup("https://user.example/x", { pinFail: "boom" });
  try {
    setActivePage(tab);
    const r = await relay.handleToolsCall({ name: "execute", arguments: { code: "1" } });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /REFUSED execute/);
    assert.strictEqual(forwarded(up, "execute").length, 0);
  } finally { restore(); }
});
