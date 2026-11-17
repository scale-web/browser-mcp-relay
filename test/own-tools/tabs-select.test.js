const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-select.js");
const sync = require("../../src/own-tools/_upstream-sync.js");
const { fakeUpstream, fakeTab, fakeContext } = require("../fixtures/fake-upstream-page.js");
const quiet = require("../../src/own-tools/_quiet-focus.js");

// Whether Brave is the frontmost app decides if tabs_select raises the tab
// (_quiet-focus.js); pin it so these tests do not depend on this machine.
function pinBraveFront(value) {
  const orig = quiet.braveIsFront;
  const seen = [];
  quiet.braveIsFront = async (pid) => { seen.push(pid); return value; };
  const unpin = () => { quiet.braveIsFront = orig; };
  unpin.seen = seen;
  return unpin;
}

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
  const pages = pageUrls.map((u) => fakeTab(u, { _bringCalled: 0, async bringToFront() { this._bringCalled++; } }));
  return { context: fakeContext(pages), _pages: pages };
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

test("tabs_select: an about:blank tab is pinned too — upstream acts on it, not on the user's tab (the 2026-10-13 incident)", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream({ url: "https://user-signed-in.example/dashboard" });
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridge(["about:blank", "https://user-signed-in.example/dashboard"]);
  const unpin = pinBraveFront(true);
  try {
    const result = await tool.handler({ index: 0 });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content.length, 1, "no warning: upstream is on the selected tab");
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.selected, 0);
    assert.strictEqual(payload.upstreamPropagated, true);
    assert.strictEqual(up.targetId, globalThis.__relayBridge._pages[0].tid);
    assert.strictEqual(up.navs().length, 0);
    assert.strictEqual(globalThis.__relayBridge._pages[1].url(), "https://user-signed-in.example/dashboard");
    // Brave in front → the tab is raised on screen
    assert.strictEqual(globalThis.__relayBridge._pages[0]._bringCalled, 1);
  } finally {
    unpin();
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

test("tabs_select: with another app in front the tab is selected but NOT raised (no focus steal)", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream();
  const restore = up.install();
  globalThis.__relayBridge = { ...makeFakeBridge(["about:blank", "file:///c/tmp/test.html"]), bravePid: 4242 };
  const unpin = pinBraveFront(false);
  try {
    const result = await tool.handler({ index: 1 });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[result.content.length - 1].text);
    assert.strictEqual(payload.selected, 1);
    assert.strictEqual(globalThis.__relayBridge._pages[1]._bringCalled, 0);
    assert.deepStrictEqual(unpin.seen, [4242], "asks about THIS relay's Brave pid");
    assert.strictEqual(require("../../src/own-tools/_active-page.js").getActivePageRaw(), globalThis.__relayBridge._pages[1]);
  } finally {
    unpin();
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

test("tabs_select: upstream is re-pinned to the selected tab — no navigation, no reload", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream();
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridge([
    "about:blank",
    "file:///c/tmp/test.html",
  ]);
  const unpin = pinBraveFront(true);
  try {
    const result = await tool.handler({ index: 1 });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content.length, 1, "no warning when synced");
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.selected, 1);
    assert.strictEqual(payload.url, "file:///c/tmp/test.html");
    assert.strictEqual(payload.upstreamPropagated, true);
    assert.strictEqual(up.targetId, globalThis.__relayBridge._pages[1].tid);
    assert.strictEqual(up.navs().length, 0, "upstream navigation_go-to is never used");
    assert.deepStrictEqual(globalThis.__relayBridge._pages[1].gotoUrls, []);
    assert.strictEqual(globalThis.__relayBridge._pages[1]._bringCalled, 1);
  } finally {
    unpin();
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

test("tabs_select: back and forth between two tabs moves upstream each time; neither is navigated", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream({ url: "https://user-signed-in.example/dashboard" });
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridge(["https://a.example/draft", "https://b.example/"]);
  const [a, b] = globalThis.__relayBridge._pages;
  try {
    await tool.handler({ index: 0 });
    assert.strictEqual(up.targetId, a.tid);
    await tool.handler({ index: 1 });
    assert.strictEqual(up.targetId, b.tid);
    const back = await tool.handler({ index: 0 });
    assert.strictEqual(up.targetId, a.tid);
    assert.strictEqual(back.content.length, 1);
    assert.deepStrictEqual([a.gotoUrls, b.gotoUrls], [[], []]);
    assert.strictEqual(up.navs().length, 0);
    assert.strictEqual(sync.isDesynced(), false);
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});
