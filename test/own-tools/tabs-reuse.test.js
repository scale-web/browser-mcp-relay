// tabs-reuse.test.js — 2026-07-16 tab-leak fixes: same-host reuse in
// tabs_new, oldest-first pruning under BROWSER_RELAY_MAX_TABS.

const test = require("node:test");
const assert = require("node:assert");
const tabsNew = require("../../src/own-tools/tabs-new.js");
const sync = require("../../src/own-tools/_upstream-sync.js");
const { fakeUpstream, fakeTab, fakeContext } = require("../fixtures/fake-upstream-page.js");
const { pinUpstreamToPage } = require("../../src/own-tools/_propagate-active-page.js");

const fakePage = (url, closed = false) => ({
  url: () => url,
  isClosed: () => closed,
  closedByTest: false,
  async close() { this.closedByTest = true; },
});

// ───── urlHost ─────

test("urlHost: http(s) hosts only", () => {
  assert.strictEqual(tabsNew._urlHost("https://www.ups.com/track?n=1"), "www.ups.com");
  assert.strictEqual(tabsNew._urlHost("http://localhost:5173/x"), "localhost:5173");
  assert.strictEqual(tabsNew._urlHost("about:blank"), null);
  assert.strictEqual(tabsNew._urlHost("chrome://settings"), null);
  assert.strictEqual(tabsNew._urlHost("not a url"), null);
  assert.strictEqual(tabsNew._urlHost("file:///tmp/x.html"), null);
});

// ───── findReusablePage ─────

test("findReusablePage: exact-host match reuses the most recent matching tab", () => {
  const older = fakePage("https://www.ups.com/track?n=OLD");
  const newer = fakePage("https://www.ups.com/track?n=NEW");
  const other = fakePage("https://example.com/");
  const picked = tabsNew._findReusablePage([older, other, newer], "https://www.ups.com/track?n=3", null);
  assert.strictEqual(picked, newer);
});

test("findReusablePage: prefers the active page when it matches", () => {
  const a = fakePage("https://app.gohighlevel.com/one");
  const b = fakePage("https://app.gohighlevel.com/two");
  const picked = tabsNew._findReusablePage([a, b], "https://app.gohighlevel.com/three", a);
  assert.strictEqual(picked, a);
});

test("findReusablePage: no cross-host or cross-subdomain reuse", () => {
  const pages = [fakePage("https://www.foo.com/")];
  assert.strictEqual(tabsNew._findReusablePage(pages, "https://app.foo.com/", null), null);
  assert.strictEqual(tabsNew._findReusablePage(pages, "https://bar.com/", null), null);
});

test("findReusablePage: skips closed pages; null for url-less/non-http targets", () => {
  const closed = fakePage("https://www.ups.com/", true);
  assert.strictEqual(tabsNew._findReusablePage([closed], "https://www.ups.com/", null), null);
  assert.strictEqual(tabsNew._findReusablePage([fakePage("https://x.com")], undefined, null), null);
  assert.strictEqual(tabsNew._findReusablePage([fakePage("https://x.com")], "about:blank", null), null);
});

// ───── pruneOldestTabs ─────

test("pruneOldestTabs: closes oldest-first down to cap, never the keep set", async () => {
  const pages = [fakePage("about:blank"), fakePage("https://a.com"), fakePage("https://b.com"), fakePage("https://c.com")];
  const keep = pages[3];
  const closed = await tabsNew._pruneOldestTabs(pages, 2, [keep]);
  assert.strictEqual(closed, 2);
  assert.ok(pages[0].closedByTest && pages[1].closedByTest, "oldest two must close");
  assert.ok(!pages[2].closedByTest && !keep.closedByTest);
});

test("pruneOldestTabs: no-op under cap or when cap disabled", async () => {
  const pages = [fakePage("https://a.com"), fakePage("https://b.com")];
  assert.strictEqual(await tabsNew._pruneOldestTabs(pages, 8, []), 0);
  assert.strictEqual(await tabsNew._pruneOldestTabs(pages, 0, []), 0);
  assert.ok(pages.every((p) => !p.closedByTest));
});

// ───── maxTabsFromEnv ─────

test("maxTabsFromEnv: default 8, env override, 0 disables, garbage → default", () => {
  assert.strictEqual(tabsNew._maxTabsFromEnv({}), 8);
  assert.strictEqual(tabsNew._maxTabsFromEnv({ BROWSER_RELAY_MAX_TABS: "3" }), 3);
  assert.strictEqual(tabsNew._maxTabsFromEnv({ BROWSER_RELAY_MAX_TABS: "0" }), 0);
  assert.strictEqual(tabsNew._maxTabsFromEnv({ BROWSER_RELAY_MAX_TABS: "nope" }), 8);
});

// ───── handler-level reuse (fake bridge) ─────

test("handler reuses an existing same-host tab instead of creating (reused:true, no newPage)", async (t) => {
  const { setActivePage, clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  let newPageCalls = 0;
  const existing = fakeTab("https://www.ups.com/track?n=OLD");
  globalThis.__relayBridge = {
    context: fakeContext([existing], { newPage: async () => { newPageCalls++; throw new Error("should not create"); } }),
  };
  const restore = fakeUpstream().install(); // upstream's own tab is blank: nothing to spare
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });

  const result = await tabsNew.handler({ url: "https://www.ups.com/track?n=NEW" });
  const payload = JSON.parse(result.content[result.content.length - 1].text);
  assert.strictEqual(payload.reused, true);
  assert.strictEqual(newPageCalls, 0);
  assert.deepStrictEqual(existing.gotoUrls, ["https://www.ups.com/track?n=NEW"]);
  assert.strictEqual(payload.index, 0);
});

test("handler honors forceNew:true (creates despite same-host match)", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const existing = { url: () => "https://www.ups.com/", isClosed: () => false, async goto() {}, once() {} };
  const created = { url: () => "https://www.ups.com/new", isClosed: () => false, gotoUrls: [], async goto(u) { this.gotoUrls.push(u); }, once() {} };
  globalThis.__relayBridge = {
    context: { pages: () => [existing, created], newPage: async () => created },
  };
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); });

  const result = await tabsNew.handler({ url: "https://www.ups.com/new", forceNew: true });
  const payload = JSON.parse(result.content[0].text);
  assert.strictEqual(payload.reused, false);
  assert.deepStrictEqual(created.gotoUrls, ["https://www.ups.com/new"]);
});

// ───── rule C for the relay's own navigation (2026-10-13 review r1 H1/L6) ─────

const navPage = (url) => fakeTab(url);

test("H1: tabs_new never reuses upstream's pinned tab while it shows the user's page", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const users = navPage("https://site.example/dashboard");
  const fresh = navPage("about:blank");
  const pages = [users];
  globalThis.__relayBridge = { context: fakeContext(pages, { newPage: async () => { pages.push(fresh); return fresh; } }) };
  const up = fakeUpstream();
  const restore = up.install();
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });
  await pinUpstreamToPage(users, { claim: false }); // upstream is on the user's tab; the relay did not put /dashboard there

  const result = await tabsNew.handler({ url: "https://site.example/reports" });
  const payload = JSON.parse(result.content[result.content.length - 1].text);
  assert.strictEqual(payload.reused, false);
  assert.deepStrictEqual(users.gotoUrls, [], "the user's tab is not navigated");
  assert.strictEqual(users.url(), "https://site.example/dashboard");
  assert.deepStrictEqual(fresh.gotoUrls, ["https://site.example/reports"]);
  assert.strictEqual(up.targetId, fresh.tid, "upstream moves to the new tab");
  assert.strictEqual(up.navs().length, 0);
});

test("H1: allowPinnedPage on tabs_new reclaims the pinned tab: reused, and upstream follows", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const mine = navPage("https://site.example/after-redirect");
  globalThis.__relayBridge = { context: fakeContext([mine], { newPage: async () => { throw new Error("should not create"); } }) };
  const up = fakeUpstream();
  const restore = up.install();
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });
  await pinUpstreamToPage(mine, { claim: false }); // a redirect moved it: not the relay's URL any more

  const result = await tabsNew.handler({ url: "https://site.example/next", allowPinnedPage: true });
  const payload = JSON.parse(result.content[result.content.length - 1].text);
  assert.strictEqual(payload.reused, true);
  assert.strictEqual(payload.upstreamPropagated, true);
  assert.strictEqual(up.url, "https://site.example/next");
  assert.strictEqual(sync.isDesynced(), false);
});

test("H1: an unreadable upstream URL means no reuse (the pinned tab can't be told apart)", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const users = navPage("https://site.example/dashboard");
  const fresh = navPage("about:blank");
  const pages = [users];
  globalThis.__relayBridge = { context: fakeContext(pages, { newPage: async () => { pages.push(fresh); return fresh; } }) };
  const restore = fakeUpstream({ fail: "upstream down" }).install();
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });
  const result = await tabsNew.handler({ url: "https://site.example/reports" });
  assert.strictEqual(JSON.parse(result.content[result.content.length - 1].text).reused, false);
  assert.deepStrictEqual(users.gotoUrls, []);
});

test("L6: pruning spares upstream's pinned tab while it shows the user's page", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const users = navPage("https://user.example/signed-in"); // oldest: first to go before the fix
  const others = [navPage("https://a.example/"), navPage("https://b.example/")];
  const fresh = navPage("about:blank");
  const pages = [users, ...others];
  globalThis.__relayBridge = { context: fakeContext(pages, { newPage: async () => { pages.push(fresh); return fresh; } }) };
  const prevMax = process.env.BROWSER_RELAY_MAX_TABS;
  process.env.BROWSER_RELAY_MAX_TABS = "2";
  const restore = fakeUpstream({ url: "https://user.example/signed-in" }).install();
  t.after(() => {
    globalThis.__relayBridge = undefined; clearActivePage(); restore();
    if (prevMax === undefined) delete process.env.BROWSER_RELAY_MAX_TABS; else process.env.BROWSER_RELAY_MAX_TABS = prevMax;
  });
  const result = await tabsNew.handler({ url: "https://c.example/", forceNew: true });
  const payload = JSON.parse(result.content[result.content.length - 1].text);
  assert.strictEqual(payload.prunedTabs, 2);
  assert.strictEqual(users.closedByTest, false, "the user's tab is never pruned");
  assert.ok(others.every((p) => p.closedByTest));
});

test("r2: reusing the relay's own pinned tab on the same host keeps it the relay's (no false 'protected')", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const up = fakeUpstream();
  const restore = up.install();
  const pinned = navPage("https://site.example/a");
  globalThis.__relayBridge = { context: fakeContext([pinned], { newPage: async () => { throw new Error("should not create"); } }) };
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });
  await pinUpstreamToPage(pinned); // the relay put /a there

  const first = await tabsNew.handler({ url: "https://site.example/b" });
  assert.strictEqual(JSON.parse(first.content[first.content.length - 1].text).reused, true);
  assert.strictEqual(sync.state().relayUrl, "https://site.example/b");
  assert.strictEqual(sync.isDesynced(), false);
  assert.strictEqual(up.url, "https://site.example/b", "upstream reads that same tab");
  assert.strictEqual(up.navs().length, 0);
});

test("r2: with upstream unreadable, tabs the relay created are still reused and pruned; others are spared", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const users = navPage("https://user.example/signed-in");
  const pages = [users];
  let n = 0;
  globalThis.__relayBridge = { context: fakeContext(pages, { newPage: async () => { const p = navPage("about:blank"); p.n = ++n; pages.push(p); return p; } }) };
  const prevMax = process.env.BROWSER_RELAY_MAX_TABS;
  process.env.BROWSER_RELAY_MAX_TABS = "2";
  const restore = fakeUpstream({ fail: "upstream wedged" }).install();
  t.after(() => {
    globalThis.__relayBridge = undefined; clearActivePage(); restore();
    if (prevMax === undefined) delete process.env.BROWSER_RELAY_MAX_TABS; else process.env.BROWSER_RELAY_MAX_TABS = prevMax;
  });
  await tabsNew.handler({ url: "https://a.example/1" });
  const again = await tabsNew.handler({ url: "https://a.example/2" });
  assert.strictEqual(JSON.parse(again.content[again.content.length - 1].text).reused, true, "a relay-created tab is reused");
  await tabsNew.handler({ url: "https://b.example/" });
  await tabsNew.handler({ url: "https://c.example/" });
  assert.strictEqual(users.closedByTest, false, "the user's tab is spared");
  assert.ok(pages.filter((p) => p !== users && p.closedByTest).length >= 1, "relay-created tabs are pruned");
});

test("re-pin: reusing a different same-host tab moves upstream to it; the tab upstream was on keeps its page", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const up = fakeUpstream();
  const restore = up.install();
  const other = navPage("https://other.example/draft");
  const relayTab = navPage("https://site.example/a");
  globalThis.__relayBridge = { context: fakeContext([other, relayTab], { newPage: async () => { throw new Error("should not create"); } }) };
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });
  await pinUpstreamToPage(other);

  const res = await tabsNew.handler({ url: "https://site.example/b" });
  const payload = JSON.parse(res.content[res.content.length - 1].text);
  assert.strictEqual(payload.reused, true);
  assert.strictEqual(payload.upstreamPropagated, true);
  assert.strictEqual(up.targetId, relayTab.tid);
  assert.strictEqual(up.url, "https://site.example/b");
  assert.strictEqual(other.url(), "https://other.example/draft", "never navigated to follow");
  assert.deepStrictEqual(other.gotoUrls, []);
  assert.strictEqual(sync.isDesynced(), false);
});

test("blank adoption: only the relay's blank (a launch blank, or a tabs_new tab) — never another", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const up = fakeUpstream();
  const restore = up.install();
  const usersBlank = navPage("about:blank");
  const pages = [usersBlank];
  globalThis.__relayBridge = { context: fakeContext(pages) };
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });

  const res = await tabsNew.handler({ url: "https://site.example/a" });
  assert.strictEqual(JSON.parse(res.content[res.content.length - 1].text).adoptedBlank, false);
  assert.deepStrictEqual(usersBlank.gotoUrls, [], "a blank the relay cannot name is not navigated");
  assert.strictEqual(pages.length, 2);

  const launched = navPage("about:blank");
  const pages2 = [launched];
  globalThis.__relayBridge = { context: fakeContext(pages2, { newPage: async () => { throw new Error("should adopt"); } }) };
  tabsNew.noteLaunchedPages({ context: globalThis.__relayBridge.context });
  tabsNew.noteLaunchedPages({ context: fakeContext([usersBlank]), attached: true }); // an attached Brave: nothing noted
  const res2 = await tabsNew.handler({ url: "https://site.example/b" });
  assert.strictEqual(JSON.parse(res2.content[res2.content.length - 1].text).adoptedBlank, true);
  assert.deepStrictEqual(launched.gotoUrls, ["https://site.example/b"]);
  assert.strictEqual(up.targetId, launched.tid);
});

test("r3: a failed navigation of the reused pinned tab is not reported as a desync", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const up = fakeUpstream();
  const restore = up.install();
  const pinned = navPage("https://site.example/a");
  pinned.goto = async () => { throw new Error("net::ERR_TIMED_OUT"); };
  globalThis.__relayBridge = { context: fakeContext([pinned], { newPage: async () => { throw new Error("should not create"); } }) };
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });
  await pinUpstreamToPage(pinned);

  const res = await tabsNew.handler({ url: "https://site.example/b" });
  assert.strictEqual(res.isError, true);
  assert.strictEqual(sync.isDesynced(), false, "it is the same tab upstream acts on");
  assert.doesNotMatch(res.content[0].text, /UPSTREAM DESYNC/);
});

// ───── MED-3 measurement: log only (register A55) ─────

function collectEvents(t) {
  const events = [];
  const prev = globalThis.__relayEventLog;
  globalThis.__relayEventLog = (event, fields) => { events.push({ event, ...fields }); return true; };
  t.after(() => { globalThis.__relayEventLog = prev; });
  return events;
}

test("MED-3 log: reuse of the relay's own tab, of one the user changed, and of a foreign tab", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const events = collectEvents(t);
  const foreign = navPage("https://b.example/theirs");
  const pages = [foreign];
  globalThis.__relayBridge = { context: fakeContext(pages, { newPage: async () => { const p = navPage("about:blank"); pages.push(p); return p; } }) };
  const restore = fakeUpstream().install();
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });

  await tabsNew.handler({ url: "https://a.example/1" });             // created
  await tabsNew.handler({ url: "https://a.example/2" });             // reuses it, unchanged
  pages[1]._url = "https://a.example/user-went-here";                // someone else moves it
  await tabsNew.handler({ url: "https://a.example/3" });             // reuses it, changed
  await tabsNew.handler({ url: "https://b.example/mine" });          // reuses the foreign tab
  const reuse = events.filter((e) => e.event === "tab-reuse");
  assert.deepStrictEqual(reuse.map((e) => [e.host, e.createdHere, e.changedSinceRelay, e.sameUrlAsUpstream]), [
    ["a.example", true, false, true], // synced: upstream's tab shows the same URL
    // the tab someone else moved is upstream's (re-pinned) tab: rule C spares it, no reuse
    ["b.example", false, null, false],
  ]);
  assert.deepStrictEqual(pages[1].gotoUrls, ["https://a.example/1", "https://a.example/2"], "not navigated after the user moved it");
  assert.ok(reuse.every((e) => !JSON.stringify(e).includes("/1") && !JSON.stringify(e).includes("theirs")), "host only, never a path");
  const open = events.filter((e) => e.event === "tabs-open").pop();
  assert.deepStrictEqual([open.open, open.createdHere, open.other], [3, 2, 1]);
});

test("MED-3 log: each pruned tab is logged; a throwing logger never breaks tabs_new", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const events = collectEvents(t);
  const old = [navPage("https://x.example/"), navPage("https://y.example/")];
  const pages = [...old];
  globalThis.__relayBridge = { context: fakeContext(pages, { newPage: async () => { const p = navPage("about:blank"); pages.push(p); return p; } }) };
  const prevMax = process.env.BROWSER_RELAY_MAX_TABS;
  process.env.BROWSER_RELAY_MAX_TABS = "1";
  const restore = fakeUpstream().install();
  t.after(() => {
    globalThis.__relayBridge = undefined; clearActivePage(); restore();
    if (prevMax === undefined) delete process.env.BROWSER_RELAY_MAX_TABS; else process.env.BROWSER_RELAY_MAX_TABS = prevMax;
  });
  await tabsNew.handler({ url: "https://z.example/", forceNew: true });
  const pruned = events.filter((e) => e.event === "tab-prune");
  assert.deepStrictEqual(pruned.map((e) => [e.host, e.createdHere]), [["x.example", false], ["y.example", false]]);
  const opens = events.filter((e) => e.event === "tabs-open").length;
  await tabsNew.handler({ url: "https://z.example/again" }); // reuse: same counts
  assert.strictEqual(events.filter((e) => e.event === "tabs-open").length, opens, "unchanged counts are not logged again");

  globalThis.__relayEventLog = () => { throw new Error("log broke"); };
  const res = await tabsNew.handler({ url: "https://w.example/", forceNew: true });
  assert.notStrictEqual(res.isError, true);
  const reused = await tabsNew.handler({ url: "https://w.example/again" }); // the reuse path logs too
  assert.strictEqual(JSON.parse(reused.content[reused.content.length - 1].text).reused, true);
});

test("MED-3 log: a prune whose close fails is not logged", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const events = collectEvents(t);
  const stuck = navPage("https://stuck.example/");
  stuck.close = async () => { throw new Error("mid-close race"); };
  const pages = [stuck];
  globalThis.__relayBridge = { context: fakeContext(pages, { newPage: async () => { const p = navPage("about:blank"); pages.push(p); return p; } }) };
  const prevMax = process.env.BROWSER_RELAY_MAX_TABS;
  process.env.BROWSER_RELAY_MAX_TABS = "1";
  const restore = fakeUpstream().install();
  t.after(() => {
    globalThis.__relayBridge = undefined; clearActivePage(); restore();
    if (prevMax === undefined) delete process.env.BROWSER_RELAY_MAX_TABS; else process.env.BROWSER_RELAY_MAX_TABS = prevMax;
  });
  await tabsNew.handler({ url: "https://new.example/", forceNew: true });
  assert.strictEqual(events.filter((e) => e.event === "tab-prune").length, 0);
});
