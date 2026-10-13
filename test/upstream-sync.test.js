// Rules A (warn), B (refuse) and the ownership half of C, through the real
// RelayServer. Kit staging 2026-10-13-relay-active-page/FINDINGS.md.
const test = require("node:test");
const assert = require("node:assert");
const { RelayServer } = require("../src/relay-server.js");
const sync = require("../src/own-tools/_upstream-sync.js");
const { propagateActivePageToUpstream } = require("../src/own-tools/_propagate-active-page.js");
const { fakeUpstream } = require("./fixtures/fake-upstream-page.js");

function setup(url = "about:blank") {
  const up = fakeUpstream({ url });
  const restore = up.install();
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
  return { up, relay, restore };
}
const forwarded = (up, name) => up.calls.filter((c) => c.params && c.params.name === name && !(name === "execute" && c.params.arguments.code === "return page.url();"));

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
  const { up, relay, restore } = setup("https://user-signed-in.example/dashboard");
  try {
    await propagateActivePageToUpstream("https://example.com/"); // protected → desynced
    assert.strictEqual(sync.isDesynced(), true);
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
  const { up, relay, restore } = setup("https://user-signed-in.example/dashboard");
  try {
    await propagateActivePageToUpstream("https://example.com/");
    const r = await relay.handleToolsCall({ name: "content_take-screenshot", arguments: {} });
    assert.notStrictEqual(r.isError, true);
    assert.match(r.content[0].text, /UPSTREAM DESYNC.*user-signed-in\.example\/dashboard/);
    assert.strictEqual(r.content[1].text, "{}");
    assert.strictEqual(forwarded(up, "content_take-screenshot").length, 1);
  } finally { restore(); }
});

test("B: allowPinnedPage: true forwards (key stripped), still warns, and does not hand the user's tab to the relay", async () => {
  const { up, relay, restore } = setup("https://user-signed-in.example/dashboard");
  try {
    await propagateActivePageToUpstream("https://example.com/");
    const r = await relay.handleToolsCall({ name: "execute", arguments: { code: "return 1", allowPinnedPage: true } });
    assert.notStrictEqual(r.isError, true);
    assert.match(r.content[0].text, /UPSTREAM DESYNC/);
    const sent = forwarded(up, "execute");
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].params.arguments, { code: "return 1" }, "the relay-only key never reaches upstream");
    assert.strictEqual(sync.state().relayUrl, null);
    // So a later propagation still leaves the user's tab alone.
    assert.strictEqual((await propagateActivePageToUpstream("https://other.example/")).propagated, false);
    assert.strictEqual(up.navs().length, 0);
  } finally { restore(); }
});

test("synced: guarded tools forward with no warning; a page the relay drove stays the relay's", async () => {
  const { up, relay, restore } = setup("about:blank");
  try {
    assert.strictEqual((await propagateActivePageToUpstream("https://a.example/")).propagated, true);
    const r = await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://b.example/" } });
    assert.strictEqual(r.content.length, 1, "no warning while synced");
    assert.strictEqual(up.url, "https://b.example/");
    assert.strictEqual(sync.state().relayUrl, "https://b.example/", "the relay drove a → b, so b is the relay's");
    assert.strictEqual((await propagateActivePageToUpstream("https://c.example/")).propagated, true);
  } finally { restore(); }
});

test("a sync clears the desync: guarded tools run again", async () => {
  const { up, relay, restore } = setup("about:blank");
  try {
    await propagateActivePageToUpstream("about:blank");
    assert.strictEqual((await relay.handleToolsCall({ name: "execute", arguments: { code: "1" } })).isError, true);
    await propagateActivePageToUpstream("https://a.example/");
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

test("H2: a guarded call longer than the ownership window does not hand the page to the relay", async () => {
  const { up, restore } = setup("about:blank");
  try {
    await propagateActivePageToUpstream("https://site.example/login");
    const before = await sync.readUpstreamUrl();
    up.url = "https://site.example/dashboard"; // the user signed in while execute waited
    await sync.afterGuardedCall({ before, name: "execute", ms: sync.OWN_WINDOW_MS + 1 });
    assert.strictEqual(sync.state().relayUrl, "https://site.example/login");
    assert.strictEqual((await propagateActivePageToUpstream("https://other.example/x")).propagated, false);
    assert.strictEqual(up.url, "https://site.example/dashboard");
    // A short call on the relay's page does move ownership.
    up.url = "https://site.example/login";
    const b2 = await sync.readUpstreamUrl();
    up.url = "https://site.example/login?step=2";
    await sync.afterGuardedCall({ before: b2, name: "interaction_click", ms: 50 });
    assert.strictEqual(sync.state().relayUrl, "https://site.example/login?step=2");
    // A slow navigation_* the caller chose from the relay's page is still the relay's.
    const b3 = await sync.readUpstreamUrl();
    up.url = "https://heavy.example/";
    await sync.afterGuardedCall({ before: b3, name: "navigation_go-to", ms: sync.OWN_WINDOW_MS * 3 });
    assert.strictEqual(sync.state().relayUrl, "https://heavy.example/");
  } finally { restore(); }
});

test("H2: opted in, a navigation_* the caller chose is the relay's; an execute is not", async () => {
  const { up, restore } = setup("https://user.example/dashboard");
  try {
    const before = await sync.readUpstreamUrl();
    up.url = "https://user.example/elsewhere";
    await sync.afterGuardedCall({ before, name: "execute", optIn: true, ms: 10 });
    assert.strictEqual(sync.state().relayUrl, null);
    up.url = "https://chosen.example/";
    await sync.afterGuardedCall({ before, name: "navigation_go-to", optIn: true, ms: 10 });
    assert.strictEqual(sync.state().relayUrl, "https://chosen.example/");
  } finally { restore(); }
});

test("H2 through the relay: a slow guarded call on the relay's page keeps the old owner", async () => {
  const { up, relay, restore } = setup("about:blank");
  const orig = up.client.request;
  up.client.request = async (m, p) => {
    if (p && p.name === "execute" && p.arguments.code === "slow") {
      up.url = "https://site.example/dashboard";
      const realNow = Date.now;
      Date.now = () => realNow() + sync.OWN_WINDOW_MS + 5; // the call "took" longer than the window
      setImmediate(() => { Date.now = realNow; });
      return { content: [{ type: "text", text: "{}" }] };
    }
    return orig(m, p);
  };
  try {
    await propagateActivePageToUpstream("https://site.example/login");
    await relay.handleToolsCall({ name: "execute", arguments: { code: "slow" } });
    assert.strictEqual(sync.state().relayUrl, "https://site.example/login");
  } finally { restore(); }
});
