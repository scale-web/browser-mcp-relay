// _propagate-active-page.js — upstream is RE-PINNED to the relay's tab by CDP
// target id (ask as-ops/ask-5ojuum rev 3); nothing is navigated to follow.
const test = require("node:test");
const assert = require("node:assert");
const sync = require("../../src/own-tools/_upstream-sync.js");
const { pinUpstreamToPage, pinUpstreamToActivePage } = require("../../src/own-tools/_propagate-active-page.js");
const { setActivePage, clearActivePage } = require("../../src/own-tools/_active-page.js");
const { fakeUpstream, fakeTab, fakeContext } = require("../fixtures/fake-upstream-page.js");

function setup(pages, upOpts = {}) {
  clearActivePage();
  globalThis.__relayBridge = { context: fakeContext(pages) };
  const up = fakeUpstream(upOpts);
  const restore = up.install();
  return { up, done: () => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); } };
}

test("pinUpstreamToPage: moves upstream's pin to the tab by target id; never navigates; claims its page", async () => {
  const a = fakeTab("https://a.example/one");
  const { up, done } = setup([a]);
  try {
    const r = await pinUpstreamToPage(a);
    assert.strictEqual(r.propagated, true);
    assert.strictEqual(up.targetId, a.tid);
    assert.strictEqual(up.url, "https://a.example/one");
    assert.strictEqual(up.navs().length, 0, "no navigation_go-to");
    assert.deepStrictEqual(a.gotoUrls, []);
    assert.strictEqual(sync.isDesynced(), false);
    assert.strictEqual(sync.state().relayUrl, "https://a.example/one");
  } finally { done(); }
});

test("pinUpstreamToPage: claim:false pins but does not hand the page to the relay", async () => {
  const a = fakeTab("https://user.example/signed-in");
  const { up, done } = setup([a]);
  try {
    assert.strictEqual((await pinUpstreamToPage(a, { claim: false })).propagated, true);
    assert.strictEqual(up.targetId, a.tid);
    assert.strictEqual(sync.state().relayUrl, null);
  } finally { done(); }
});

test("pinUpstreamToPage: about:blank is pinned too (upstream acts on the selected blank, not another tab)", async () => {
  const blank = fakeTab("about:blank");
  const { up, done } = setup([fakeTab("https://user.example/"), blank]);
  try {
    assert.strictEqual((await pinUpstreamToPage(blank)).propagated, true);
    assert.strictEqual(up.targetId, blank.tid);
  } finally { done(); }
});

test("pinUpstreamToPage: a failed pin (unpatched upstream) is a desync naming the reason; nothing navigated", async () => {
  const a = fakeTab("https://a.example/");
  const { up, done } = setup([a], { url: "https://user.example/dashboard", pinFail: "__relayPin is not defined" });
  try {
    const r = await pinUpstreamToPage(a);
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /not patched for re-pinning/);
    assert.strictEqual(r.upstreamUrl, "https://user.example/dashboard");
    assert.strictEqual(sync.isDesynced(), true);
    assert.match(sync.warning(), /UPSTREAM DESYNC.*user\.example\/dashboard/);
    assert.strictEqual(up.navs().length, 0);
  } finally { done(); }
});

test("pinUpstreamToPage: upstream down is a desync; a missing __relayUpstream leaves the state alone", async () => {
  const a = fakeTab("https://a.example/");
  const { done } = setup([a], { fail: "upstream blew up" });
  try {
    const r = await pinUpstreamToPage(a);
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /upstream blew up/);
    assert.strictEqual(sync.isDesynced(), true);
  } finally { done(); }
  const prev = globalThis.__relayUpstream;
  globalThis.__relayUpstream = undefined;
  sync.reset();
  try {
    const r = await pinUpstreamToPage(a);
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /__relayUpstream not exposed/);
    assert.strictEqual(sync.isDesynced(), false);
  } finally { globalThis.__relayUpstream = prev; }
});

test("pinUpstreamToPage: a tab whose target id cannot be read is a desync", async () => {
  const a = fakeTab("https://a.example/");
  const { done } = setup([a]);
  globalThis.__relayBridge.context.newCDPSession = async () => { throw new Error("target closed"); };
  try {
    const r = await pinUpstreamToPage({ ...a, tid: undefined }); // a different object: not cached
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /target id/);
    assert.strictEqual(sync.isDesynced(), true);
  } finally { done(); }
});

test("pinUpstreamToActivePage: re-pins only when upstream is elsewhere, claims nothing, and needs an active tab", async () => {
  const a = fakeTab("https://a.example/");
  const b = fakeTab("https://user.example/typed-by-hand");
  const { up, done } = setup([a, b]);
  try {
    assert.strictEqual(await pinUpstreamToActivePage(), null, "no active tab: nothing checked");
    assert.strictEqual(up.pins().length, 0);
    setActivePage(b);
    await pinUpstreamToActivePage();
    assert.strictEqual(up.targetId, b.tid);
    assert.strictEqual(sync.state().relayUrl, null, "an automatic re-pin claims nothing");
    await pinUpstreamToActivePage();
    assert.strictEqual(up.pins().length, 1, "already there: no second pin");
  } finally { done(); }
});

test("pinUpstreamToActivePage: when upstream is already on the active tab, a stale failure is cleared", async () => {
  const a = fakeTab("https://a.example/");
  const { up, done } = setup([a]);
  try {
    setActivePage(a);
    await pinUpstreamToPage(a);
    sync.markDesynced("x", null, "an earlier failure");
    await pinUpstreamToActivePage();
    assert.strictEqual(sync.isDesynced(), false);
    assert.strictEqual(up.pins().length, 1);
  } finally { done(); }
});
