const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-select.js");
const sync = require("../../src/own-tools/_upstream-sync.js");
const { fakeUpstream } = require("../fixtures/fake-upstream-page.js");

test("tabs_select has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_select");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.required[0], "index");
});

test("tabs_select returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ index: 0 });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// Mock helper: bridge with a fixed list of pages, each with a recordable
// bringToFront() and a fixed url.
function makeFakeBridge(pageUrls) {
  const pages = pageUrls.map((u) => ({
    _bringCalled: 0,
    url() { return u; },
    async bringToFront() { this._bringCalled++; },
  }));
  return { context: { pages: () => pages }, _pages: pages };
}

test("tabs_select: out-of-range index returns isError", async () => {
  const prevBridge = globalThis.__relayBridge;
  globalThis.__relayBridge = makeFakeBridge(["about:blank"]);
  try {
    const result = await tool.handler({ index: 5 });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /out of range/);
  } finally {
    globalThis.__relayBridge = prevBridge;
  }
});

// V1-5: JSON-Schema `minimum: 0` is not enforced by the MCP SDK at handler
// entry. Negative / non-integer / huge index must all produce isError, not
// an undefined-property TypeError.
test("V1-5: tabs_select with negative index returns isError (not crash)", async () => {
  const prevBridge = globalThis.__relayBridge;
  globalThis.__relayBridge = makeFakeBridge(["about:blank", "https://example.com/"]);
  try {
    const result = await tool.handler({ index: -1 });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /out of range/i);
    // bringToFront must NOT have been called on any page.
    for (const page of globalThis.__relayBridge._pages) {
      assert.strictEqual(page._bringCalled, 0);
    }
  } finally {
    globalThis.__relayBridge = prevBridge;
  }
});

test("V1-5: tabs_select with non-integer index returns isError", async () => {
  const prevBridge = globalThis.__relayBridge;
  globalThis.__relayBridge = makeFakeBridge(["about:blank"]);
  try {
    const result = await tool.handler({ index: "abc" });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /out of range/i);
  } finally {
    globalThis.__relayBridge = prevBridge;
  }
});

test("V1-5: tabs_select error message includes pages-count for actionability", async () => {
  const prevBridge = globalThis.__relayBridge;
  globalThis.__relayBridge = makeFakeBridge(["about:blank", "https://example.com/"]);
  try {
    const result = await tool.handler({ index: 999 });
    assert.match(result.content[0].text, /have 2 pages/);
  } finally {
    globalThis.__relayBridge = prevBridge;
  }
});

test("tabs_select: about:blank target skips upstream propagation and warns (the 2026-10-13 incident)", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream({ url: "https://user-signed-in.example/dashboard" });
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridge(["about:blank", "https://user-signed-in.example/dashboard"]);
  try {
    const result = await tool.handler({ index: 0 });
    assert.strictEqual(result.isError, undefined);
    assert.match(result.content[0].text, /UPSTREAM DESYNC/);
    const payload = JSON.parse(result.content[1].text);
    assert.strictEqual(payload.selected, 0);
    assert.strictEqual(payload.upstreamPropagated, false);
    assert.strictEqual(up.calls.length, 0);
    assert.strictEqual(sync.isDesynced(), true);
    // bringToFront still called (Playwright-side focus)
    assert.strictEqual(globalThis.__relayBridge._pages[0]._bringCalled, 1);
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

test("tabs_select: real URL triggers upstream navigation_go-to", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream();
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridge([
    "about:blank",
    "file:///c/tmp/test.html",
  ]);
  try {
    const result = await tool.handler({ index: 1 });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content.length, 1, "no warning when synced");
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.selected, 1);
    assert.strictEqual(payload.url, "file:///c/tmp/test.html");
    assert.strictEqual(payload.upstreamPropagated, true);
    assert.strictEqual(up.navs().length, 1, "upstream navigation_go-to must be invoked");
    assert.strictEqual(up.navs()[0].params.arguments.url, "file:///c/tmp/test.html");
    assert.strictEqual(globalThis.__relayBridge._pages[1]._bringCalled, 1);
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

test("tabs_select: upstream failure does NOT fail the tool call", async () => {
  const prevBridge = globalThis.__relayBridge;
  const restore = fakeUpstream({ fail: "upstream blew up" }).install();
  globalThis.__relayBridge = makeFakeBridge(["https://example.com/"]);
  try {
    const result = await tool.handler({ index: 0 });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[result.content.length - 1].text);
    assert.strictEqual(payload.upstreamPropagated, false);
    assert.match(result.content[0].text, /UPSTREAM DESYNC/);
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

test("tabs_select: selecting the tab upstream already shows syncs without reloading it", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream({ url: "https://user-signed-in.example/dashboard" });
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridge(["about:blank", "https://user-signed-in.example/dashboard"]);
  try {
    await tool.handler({ index: 0 });
    assert.strictEqual(sync.isDesynced(), true);
    const result = await tool.handler({ index: 1 });
    assert.strictEqual(result.content.length, 1);
    assert.strictEqual(JSON.parse(result.content[0].text).upstreamPropagated, true);
    assert.strictEqual(up.navs().length, 0, "no navigation, so no reload of the user's page");
    assert.strictEqual(sync.isDesynced(), false);
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});


test("tabs_select allowPinnedPage: reclaims upstream's tab and navigates it to the selected one", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream({ url: "https://mine.example/spa-route" });
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridge(["https://example.com/"]);
  try {
    const refused = await tool.handler({ index: 0 });
    assert.match(refused.content[0].text, /UPSTREAM DESYNC/);
    assert.strictEqual(up.navs().length, 0);
    const result = await tool.handler({ index: 0, allowPinnedPage: true });
    assert.strictEqual(result.content.length, 1);
    assert.strictEqual(JSON.parse(result.content[0].text).upstreamPropagated, true);
    assert.strictEqual(up.url, "https://example.com/");
    assert.strictEqual(sync.isDesynced(), false);
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});
