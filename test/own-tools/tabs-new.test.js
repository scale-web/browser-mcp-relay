const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-new.js");
const sync = require("../../src/own-tools/_upstream-sync.js");
const { fakeUpstream } = require("../fixtures/fake-upstream-page.js");

test("tabs_new has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_new");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.type, "object");
});

test("tabs_new returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({});
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// Mock helper: a fake bridge with a fake context that records page operations.
function makeFakeBridge() {
  const pages = [];
  const fakePage = {
    _url: "about:blank",
    url() { return this._url; },
    async goto(u) { this._url = u; return null; },
  };
  return {
    context: {
      pages: () => pages,
      newPage: async () => {
        const p = { ...fakePage, _url: "about:blank" };
        pages.push(p);
        return p;
      },
    },
  };
}

test("tabs_new without url: does NOT call upstream, and warns that upstream tools act on another tab", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream({ url: "https://a.example/" });
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridge();
  try {
    const result = await tool.handler({});
    assert.strictEqual(result.isError, undefined);
    assert.match(result.content[0].text, /UPSTREAM DESYNC/);
    const payload = JSON.parse(result.content[1].text);
    assert.strictEqual(payload.upstreamPropagated, false);
    assert.match(payload.upstreamReason, /about:blank/);
    assert.strictEqual(up.calls.length, 0, "upstream must NOT be called when no url");
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

test("tabs_new with url: calls upstream navigation_go-to with that url", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream();
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridge();
  try {
    const result = await tool.handler({ url: "https://example.com/foo" });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content.length, 1, "no warning when synced");
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.upstreamPropagated, true);
    assert.strictEqual(payload.url, "https://example.com/foo");
    const navs = up.navs();
    assert.strictEqual(navs.length, 1, "upstream navigation_go-to must be invoked");
    assert.strictEqual(navs[0].method, "tools/call");
    assert.strictEqual(navs[0].params.arguments.url, "https://example.com/foo");
    // Snapshot/screenshot must be disabled to keep the propagation cheap.
    assert.strictEqual(navs[0].params.arguments.includeSnapshot, false);
    assert.strictEqual(navs[0].params.arguments.includeScreenshot, false);
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

test("tabs_new: upstream failure does NOT fail the tool call", async () => {
  const prevBridge = globalThis.__relayBridge;
  const restore = fakeUpstream({ fail: "upstream blew up" }).install();
  globalThis.__relayBridge = makeFakeBridge();
  try {
    const result = await tool.handler({ url: "https://example.com/" });
    assert.strictEqual(result.isError, undefined, "tool must succeed even if upstream fails");
    const payload = JSON.parse(result.content[result.content.length - 1].text);
    assert.strictEqual(payload.upstreamPropagated, false);
    assert.match(payload.upstreamReason, /upstream blew up/);
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

test("tabs_new: upstream's tab on the user's page is left alone; the result warns first", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream({ url: "https://user-signed-in.example/dashboard" });
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridge();
  try {
    const result = await tool.handler({ url: "https://example.com/" });
    assert.strictEqual(result.isError, undefined);
    assert.match(result.content[0].text, /UPSTREAM DESYNC.*user-signed-in/);
    const payload = JSON.parse(result.content[1].text);
    assert.strictEqual(payload.upstreamPropagated, false);
    assert.strictEqual(payload.upstreamUrl, "https://user-signed-in.example/dashboard");
    assert.strictEqual(up.navs().length, 0);
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

test("tabs_new: about:blank URL skips upstream propagation", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream();
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridge();
  try {
    const result = await tool.handler({ url: "about:blank" });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[result.content.length - 1].text);
    assert.strictEqual(payload.upstreamPropagated, false);
    assert.strictEqual(up.calls.length, 0);
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

// ──────────────────────────────────────────────────────────────────
// T0-7: bad URL returns isError + structured navError, doesn't propagate.
// T1-10: waitUntil parameter is honored.
// ──────────────────────────────────────────────────────────────────

function makeFakeBridgeWithFailingGoto(errMsg = "net::ERR_NAME_NOT_RESOLVED") {
  const pages = [];
  return {
    context: {
      pages: () => pages,
      newPage: async () => {
        const p = {
          _url: "about:blank",
          url() { return this._url; },
          async goto() { throw new Error(errMsg); },
        };
        pages.push(p);
        return p;
      },
    },
  };
}

test("T0-7: tabs_new with bad URL returns isError + navError + does NOT propagate", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream();
  const restore = up.install();
  globalThis.__relayBridge = makeFakeBridgeWithFailingGoto();
  try {
    const result = await tool.handler({ url: "https://no-such-host.invalid/" });
    assert.strictEqual(result.isError, true);
    const payload = JSON.parse(result.content[result.content.length - 1].text);
    assert.match(payload.navError, /ERR_NAME_NOT_RESOLVED|invalid/i);
    assert.strictEqual(payload.upstreamPropagated, false);
    assert.strictEqual(up.calls.length, 0, "upstream must NOT be called when goto fails");
    assert.strictEqual(sync.isDesynced(), true, "upstream still shows another tab");
  } finally {
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

test("T0-7: tabs_new with bad URL still tracks the new page as active", async () => {
  // The page exists in context.pages() even after a failed goto. setActivePage
  // must have been called before goto so subsequent own-tools target this
  // (orphan) tab rather than the previous active page.
  const { getActivePageRaw, clearActivePage } = require("../../src/own-tools/_active-page.js");
  const prevBridge = globalThis.__relayBridge;
  globalThis.__relayBridge = makeFakeBridgeWithFailingGoto();
  clearActivePage();
  try {
    await tool.handler({ url: "https://no-such-host.invalid/" });
    const tracked = getActivePageRaw();
    assert.ok(tracked, "active page must be set even after goto failure");
  } finally {
    globalThis.__relayBridge = prevBridge;
    clearActivePage();
  }
});

test("T1-10: tabs_new accepts waitUntil parameter and passes it to goto", async () => {
  const prevBridge = globalThis.__relayBridge;
  let lastGotoOpts = null;
  const pages = [];
  globalThis.__relayBridge = {
    context: {
      pages: () => pages,
      newPage: async () => {
        const p = {
          _url: "about:blank",
          url() { return this._url; },
          async goto(u, opts) { this._url = u; lastGotoOpts = opts; return null; },
        };
        pages.push(p);
        return p;
      },
    },
  };
  try {
    await tool.handler({ url: "https://example.com/", waitUntil: "networkidle", timeoutMs: 60000 });
    assert.ok(lastGotoOpts, "goto must be called with options");
    assert.strictEqual(lastGotoOpts.waitUntil, "networkidle");
    assert.strictEqual(lastGotoOpts.timeout, 60000);
  } finally {
    globalThis.__relayBridge = prevBridge;
  }
});

// 2026-10-29: tabs_new must not take the user's screen (_quiet-focus.js).
const quiet = require("../../src/own-tools/_quiet-focus.js");

test("tabs_new: a NEW tab comes from newQuietPage (background), not context.newPage", async () => {
  const prevBridge = globalThis.__relayBridge;
  const up = fakeUpstream();
  const restore = up.install();
  const bridge = makeFakeBridge();
  let newPageCalls = 0;
  const realNewPage = bridge.context.newPage;
  bridge.context.newPage = async () => { newPageCalls++; return realNewPage(); };
  const origQuiet = quiet.newQuietPage;
  const quietCalls = [];
  quiet.newQuietPage = async (b) => { quietCalls.push(b); return realNewPage(); };
  globalThis.__relayBridge = bridge;
  try {
    const result = await tool.handler({ url: "https://fresh.example/", forceNew: true });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(quietCalls.length, 1);
    assert.strictEqual(quietCalls[0], bridge);
    assert.strictEqual(newPageCalls, 0);
  } finally {
    quiet.newQuietPage = origQuiet;
    globalThis.__relayBridge = prevBridge;
    restore();
  }
});

test("tabs_new: an adopted tab is raised only when Brave is already in front", async () => {
  for (const front of [false, true]) {
    const prevBridge = globalThis.__relayBridge;
    const up = fakeUpstream();
    const restore = up.install();
    let raised = 0;
    const blank = { _url: "about:blank", url() { return this._url; }, isClosed: () => false,
      async goto(u) { this._url = u; return null; }, async bringToFront() { raised++; } };
    globalThis.__relayBridge = { context: { pages: () => [blank], newPage: async () => { throw new Error("should adopt"); } } };
    const origFront = quiet.braveIsFront;
    quiet.braveIsFront = async () => front;
    try {
      await tool.handler({ url: "https://adopt.example/" });
      assert.strictEqual(raised, front ? 1 : 0, `front=${front}`);
    } finally {
      quiet.braveIsFront = origFront;
      globalThis.__relayBridge = prevBridge;
      restore();
    }
  }
});


test("tabs_new: a NEW tab is raised only when this relay's Brave is in front (asked by its pid)", async () => {
  for (const front of [false, true]) {
    const prevBridge = globalThis.__relayBridge;
    const up = fakeUpstream();
    const restore = up.install();
    let raised = 0;
    const fresh = { _url: "about:blank", url() { return this._url; }, isClosed: () => false,
      async goto(u) { this._url = u; return null; }, async bringToFront() { raised++; } };
    const pages = [];
    globalThis.__relayBridge = { bravePid: 777, context: { pages: () => pages, newPage: async () => { throw new Error("use newQuietPage"); } } };
    const origQuiet = quiet.newQuietPage;
    quiet.newQuietPage = async () => { pages.push(fresh); return fresh; };
    const origFront = quiet.braveIsFront;
    const seen = [];
    quiet.braveIsFront = async (pid) => { seen.push(pid); return front; };
    try {
      await tool.handler({ url: "https://new.example/", forceNew: true });
      assert.strictEqual(raised, front ? 1 : 0, `front=${front}`);
      assert.deepStrictEqual(seen, [777]);
    } finally {
      quiet.newQuietPage = origQuiet;
      quiet.braveIsFront = origFront;
      globalThis.__relayBridge = prevBridge;
      restore();
    }
  }
});
