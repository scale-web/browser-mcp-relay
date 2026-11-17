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

test("R1 not applied (review r1 L3): pinUpstreamToPage falls back to navigating upstream's own tab, under rule C", async () => {
  const a = fakeTab("https://a.example/");
  const b = fakeTab("https://b.example/");
  // Upstream's own tab shows the user's page: rule C protects it — a desync, nothing navigated.
  const { up, done } = setup([a, b], { url: "https://user.example/dashboard", pinFail: "__relayPin is not defined" });
  try {
    const r = await pinUpstreamToPage(a);
    assert.strictEqual(r.propagated, false);
    assert.strictEqual(r.via, "navigation");
    assert.match(r.reason, /protected/);
    assert.strictEqual(sync.repinState().available, false, "relay_status can say so");
    assert.match(sync.repinState().reason, /not patched for re-pinning/);
    assert.strictEqual(sync.isDesynced(), true);
    assert.strictEqual(up.navs().length, 0);
    assert.strictEqual(up.pins().length, 1, "asked once");
    // The caller's allowPinnedPage: upstream's tab is navigated to the tab's URL; no second pin attempt.
    const forced = await pinUpstreamToPage(b, { force: true });
    assert.strictEqual(forced.propagated, true, JSON.stringify(forced));
    assert.deepStrictEqual(up.navs().map((c) => c.params.arguments.url), ["https://b.example/"]);
    assert.strictEqual(up.url, "https://b.example/");
    assert.strictEqual(sync.isDesynced(), false);
    assert.strictEqual(up.pins().length, 1);
    // Upstream's tab is now the relay's (rule C): the next select navigates without force.
    assert.strictEqual((await pinUpstreamToPage(a)).propagated, true);
    assert.strictEqual(up.url, "https://a.example/");
  } finally { done(); }
});

test("R1 not applied: pinUpstreamToActivePage never navigates and records no desync (it would undo upstream's own navigations)", async () => {
  const a = fakeTab("https://a.example/");
  const { up, done } = setup([a], { url: "https://a.example/moved-by-upstream", pinFail: "__relayPin is not defined" });
  try {
    setActivePage(a);
    await pinUpstreamToActivePage(); // discovers it
    assert.strictEqual(sync.repinState().available, false);
    assert.strictEqual(sync.isDesynced(), false);
    const calls = up.calls.length;
    assert.strictEqual(await pinUpstreamToActivePage(), null, "known: not even asked");
    assert.strictEqual(up.calls.length, calls);
    assert.strictEqual(up.navs().length, 0);
    assert.strictEqual(up.url, "https://a.example/moved-by-upstream");
  } finally { done(); }
});

test("pinUpstreamToPage: a working pin records R1 as available", async () => {
  const a = fakeTab("https://a.example/");
  const { done } = setup([a]);
  try {
    assert.strictEqual(sync.repinState().available, null);
    await pinUpstreamToPage(a);
    assert.strictEqual(sync.repinState().available, true);
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

test("R1 not applied: tabs_select's allowPinnedPage lets it navigate upstream's own tab off a page the relay did not put there", async () => {
  const tabsSelect = require("../../src/own-tools/tabs-select.js");
  const quiet = require("../../src/own-tools/_quiet-focus.js");
  const origFront = quiet.braveIsFront;
  quiet.braveIsFront = async () => false;
  const a = fakeTab("https://a.example/");
  const { up, done } = setup([a], { url: "https://user.example/dashboard", pinFail: "__relayPin is not defined" });
  try {
    await tabsSelect.handler({ index: 0 });
    assert.strictEqual(up.navs().length, 0, "without it: protected (rule C)");
    assert.strictEqual(sync.isDesynced(), true);
    await tabsSelect.handler({ index: 0, allowPinnedPage: true });
    assert.deepStrictEqual(up.navs().map((c) => c.params.arguments.url), ["https://a.example/"]);
    assert.strictEqual(sync.isDesynced(), false);
  } finally { quiet.braveIsFront = origFront; done(); }
});

test("R1 state survives sync.reset() (a new upstream child: index.js sets it from the patch just before)", () => {
  sync.noteRepin(false, "R1 re-pin patch not applied: shape changed");
  try {
    sync.reset();
    assert.deepStrictEqual(sync.repinState(), { available: false, reason: "R1 re-pin patch not applied: shape changed" });
  } finally { sync.noteRepin(null, null); }
});
