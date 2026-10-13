const test = require("node:test");
const assert = require("node:assert");
const { propagateActivePageToUpstream } = require("../../src/own-tools/_propagate-active-page.js");
const sync = require("../../src/own-tools/_upstream-sync.js");
const { fakeUpstream } = require("../fixtures/fake-upstream-page.js");

test("propagateActivePageToUpstream: empty url skips, calls nothing, and is a desync", async () => {
  const up = fakeUpstream();
  const restore = up.install();
  try {
    const r = await propagateActivePageToUpstream("");
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /empty|about:blank/);
    assert.strictEqual(up.calls.length, 0, "a blank selection must not start upstream's session");
    assert.strictEqual(sync.isDesynced(), true);
  } finally { restore(); }
});

test("propagateActivePageToUpstream: null url skips", async () => {
  const restore = fakeUpstream().install();
  try {
    const r = await propagateActivePageToUpstream(null);
    assert.strictEqual(r.propagated, false);
  } finally { restore(); }
});

test("propagateActivePageToUpstream: about:blank skips without calling upstream (the 2026-10-13 incident's first step)", async () => {
  const up = fakeUpstream({ url: "https://user-signed-in.example/dashboard" });
  const restore = up.install();
  try {
    const r = await propagateActivePageToUpstream("about:blank");
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /about:blank/);
    assert.strictEqual(up.calls.length, 0);
    assert.strictEqual(sync.isDesynced(), true);
    assert.match(sync.warning(), /UPSTREAM DESYNC/);
  } finally { restore(); }
});

test("propagateActivePageToUpstream: missing __relayUpstream skips and leaves the state alone", async () => {
  const prev = globalThis.__relayUpstream;
  globalThis.__relayUpstream = undefined;
  sync.reset();
  try {
    const r = await propagateActivePageToUpstream("https://example.com/");
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /__relayUpstream/);
    assert.strictEqual(sync.isDesynced(), false);
  } finally {
    globalThis.__relayUpstream = prev;
  }
});

test("propagateActivePageToUpstream: reads first, then forwards to upstream navigation_go-to when upstream's tab is blank", async () => {
  const up = fakeUpstream({ url: "about:blank" });
  const restore = up.install();
  try {
    const r = await propagateActivePageToUpstream("https://example.com/");
    assert.strictEqual(r.propagated, true);
    assert.strictEqual(up.calls[0].params.name, "execute", "the URL read comes first");
    const navs = up.navs();
    assert.strictEqual(navs.length, 1);
    assert.strictEqual(navs[0].method, "tools/call");
    assert.strictEqual(navs[0].params.arguments.url, "https://example.com/");
    assert.strictEqual(navs[0].params.arguments.includeSnapshot, false);
    assert.strictEqual(navs[0].params.arguments.includeScreenshot, false);
    assert.strictEqual(sync.isDesynced(), false);
    assert.strictEqual(sync.state().relayUrl, "https://example.com/");
  } finally { restore(); }
});

test("C: upstream's tab on a page the relay did not put there is NOT navigated", async () => {
  const up = fakeUpstream({ url: "https://user-signed-in.example/dashboard" });
  const restore = up.install();
  try {
    const r = await propagateActivePageToUpstream("https://example.com/");
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /protected/);
    assert.strictEqual(r.upstreamUrl, "https://user-signed-in.example/dashboard");
    assert.strictEqual(up.navs().length, 0, "the user's tab must not be navigated");
    assert.strictEqual(up.url, "https://user-signed-in.example/dashboard");
    assert.strictEqual(sync.isDesynced(), true);
    assert.match(sync.warning(), /reclaim the tab.*ask them first/);
  } finally { restore(); }
});

test("C: the page the relay last put there IS navigated; a user's change to it is not", async () => {
  const up = fakeUpstream();
  const restore = up.install();
  try {
    assert.strictEqual((await propagateActivePageToUpstream("https://a.example/")).propagated, true);
    assert.strictEqual((await propagateActivePageToUpstream("https://b.example/")).propagated, true, "relay-owned a → b");
    assert.strictEqual(up.navs().length, 2);
    up.url = "https://b.example/after-sign-in"; // the user signs in inside that tab
    const r = await propagateActivePageToUpstream("https://c.example/");
    assert.strictEqual(r.propagated, false);
    assert.strictEqual(up.navs().length, 2);
    assert.strictEqual(up.url, "https://b.example/after-sign-in");
  } finally { restore(); }
});

test("C: upstream already showing the URL is synced with no navigation (no reload of the user's page)", async () => {
  const up = fakeUpstream({ url: "https://user-signed-in.example/dashboard" });
  const restore = up.install();
  try {
    sync.markDesynced("about:blank", null, "earlier");
    const r = await propagateActivePageToUpstream("https://user-signed-in.example/dashboard");
    assert.strictEqual(r.propagated, true);
    assert.strictEqual(up.navs().length, 0);
    assert.strictEqual(sync.isDesynced(), false);
    assert.strictEqual(sync.state().relayUrl, null, "selecting the user's page does not make it the relay's");
  } finally { restore(); }
});

test("C: a redirect lands on a URL the relay owns", async () => {
  const up = fakeUpstream();
  const restore = up.install();
  const orig = up.client.request;
  up.client.request = async (m, p) => {
    const r = await orig(m, p);
    if (p.name === "navigation_go-to") up.url = p.arguments.url + "landed";
    return r;
  };
  try {
    await propagateActivePageToUpstream("https://a.example/");
    assert.strictEqual(sync.state().relayUrl, "https://a.example/landed");
    assert.strictEqual((await propagateActivePageToUpstream("https://b.example/")).propagated, true);
  } finally { restore(); }
});

test("propagateActivePageToUpstream: unreadable upstream URL leaves the tab alone and is a desync", async () => {
  const restore = fakeUpstream({ fail: "kaboom" }).install();
  try {
    const r = await propagateActivePageToUpstream("https://example.com/");
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /could not read.*kaboom/);
    assert.strictEqual(sync.isDesynced(), true);
  } finally { restore(); }
});

test("propagateActivePageToUpstream: upstream isError on navigation reported as failure, not success", async () => {
  // browser-devtools-mcp reports tool failures as a normal result with
  // isError: true, not as a thrown JSON-RPC error.
  const restore = fakeUpstream({ navFail: "Target page, context or browser has been closed" }).install();
  try {
    const r = await propagateActivePageToUpstream("https://example.com/");
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /has been closed/);
    assert.strictEqual(sync.isDesynced(), true);
  } finally { restore(); }
});

test("propagateActivePageToUpstream: isError with no text still reported as failure", async () => {
  const restore = fakeUpstream({ navFail: "" }).install();
  try {
    const r = await propagateActivePageToUpstream("https://example.com/");
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /returned isError/);
  } finally { restore(); }
});

test("C: force (allowPinnedPage on tabs_*) reclaims the tab and navigates it", async () => {
  const up = fakeUpstream({ url: "https://mine.example/spa-route" });
  const restore = up.install();
  try {
    const r = await propagateActivePageToUpstream("https://example.com/", { force: true });
    assert.strictEqual(r.propagated, true);
    assert.strictEqual(up.url, "https://example.com/");
    assert.strictEqual(sync.state().relayUrl, "https://example.com/");
  } finally { restore(); }
});

test("M4: a navigation that errors after landing is a sync the relay owns", async () => {
  const up = fakeUpstream();
  const restore = up.install();
  const orig = up.client.request;
  up.client.request = async (m, p) => {
    if (p.name === "navigation_go-to") { await orig(m, p); return { content: [{ type: "text", text: "Timeout waiting for load" }], isError: true }; }
    return orig(m, p);
  };
  try {
    const r = await propagateActivePageToUpstream("https://a.example/");
    assert.strictEqual(r.propagated, true);
    assert.match(r.reason, /landed despite: Timeout/);
    assert.strictEqual(sync.isDesynced(), false);
    assert.strictEqual(sync.state().relayUrl, "https://a.example/");
  } finally { restore(); }
});

test("L5: when the landed URL can't be read, the relay owns the URL it asked for", async () => {
  const up = fakeUpstream();
  const restore = up.install();
  const orig = up.client.request;
  let navigated = false;
  up.client.request = async (m, p) => {
    if (navigated && p.name === "execute") throw new Error("read failed");
    if (p.name === "navigation_go-to") navigated = true;
    return orig(m, p);
  };
  try {
    const r = await propagateActivePageToUpstream("https://a.example/");
    assert.strictEqual(r.propagated, true);
    assert.strictEqual(sync.state().relayUrl, "https://a.example/");
  } finally { restore(); }
});
