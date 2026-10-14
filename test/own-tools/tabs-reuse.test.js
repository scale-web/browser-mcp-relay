// tabs-reuse.test.js — 2026-07-16 tab-leak fixes: same-host reuse in
// tabs_new, oldest-first pruning under BROWSER_RELAY_MAX_TABS.

const test = require("node:test");
const assert = require("node:assert");
const tabsNew = require("../../src/own-tools/tabs-new.js");
const sync = require("../../src/own-tools/_upstream-sync.js");
const { fakeUpstream } = require("../fixtures/fake-upstream-page.js");

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
  const existing = {
    url: () => "https://www.ups.com/track?n=OLD",
    isClosed: () => false,
    gotoUrls: [],
    async goto(u) { this.gotoUrls.push(u); },
    async bringToFront() {},
    once() {},
  };
  globalThis.__relayBridge = {
    context: {
      pages: () => [existing],
      newPage: async () => { newPageCalls++; throw new Error("should not create"); },
    },
  };
  const restore = fakeUpstream().install(); // upstream's own tab is blank: nothing to spare
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });

  const result = await tabsNew.handler({ url: "https://www.ups.com/track?n=NEW" });
  const payload = JSON.parse(result.content[0].text);
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

function navPage(url) {
  return {
    _url: url, gotoUrls: [], closedByTest: false,
    url() { return this._url; }, isClosed() { return this.closedByTest; },
    async goto(u) { this.gotoUrls.push(u); this._url = u; }, async bringToFront() {}, once() {},
    async close() { this.closedByTest = true; },
  };
}

test("H1: tabs_new never reuses upstream's pinned tab while it shows the user's page", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const users = navPage("https://site.example/dashboard");
  const fresh = navPage("about:blank");
  const pages = [users];
  globalThis.__relayBridge = { context: { pages: () => pages, newPage: async () => { pages.push(fresh); return fresh; } } };
  const up = fakeUpstream({ url: "https://site.example/dashboard" });
  const restore = up.install();
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });

  const result = await tabsNew.handler({ url: "https://site.example/reports" });
  const payload = JSON.parse(result.content[result.content.length - 1].text);
  assert.strictEqual(payload.reused, false);
  assert.deepStrictEqual(users.gotoUrls, [], "the user's tab is not navigated");
  assert.deepStrictEqual(fresh.gotoUrls, ["https://site.example/reports"]);
  assert.strictEqual(up.url, "https://site.example/dashboard");
  assert.match(result.content[0].text, /UPSTREAM DESYNC/);
});

test("H1: allowPinnedPage on tabs_new reclaims the pinned tab: reused, and upstream follows", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const mine = navPage("https://site.example/after-redirect");
  globalThis.__relayBridge = { context: { pages: () => [mine], newPage: async () => { throw new Error("should not create"); } } };
  const up = fakeUpstream({ url: "https://site.example/after-redirect" });
  const restore = up.install();
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });

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
  globalThis.__relayBridge = { context: { pages: () => pages, newPage: async () => { pages.push(fresh); return fresh; } } };
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
  globalThis.__relayBridge = { context: { pages: () => pages, newPage: async () => { pages.push(fresh); return fresh; } } };
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
  const up = fakeUpstream({ url: "https://site.example/a" });
  const restore = up.install();
  sync.markSynced("https://site.example/a"); // the relay put /a there
  // The relay's Playwright handle on upstream's own tab: its goto moves upstream's page.
  const pinned = navPage("https://site.example/a");
  pinned.goto = async function (u) { this.gotoUrls.push(u); this._url = u; up.url = u; };
  globalThis.__relayBridge = { context: { pages: () => [pinned], newPage: async () => { throw new Error("should not create"); } } };
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });

  const first = await tabsNew.handler({ url: "https://site.example/b" });
  assert.strictEqual(JSON.parse(first.content[first.content.length - 1].text).reused, true);
  assert.strictEqual(sync.state().relayUrl, "https://site.example/b");
  assert.strictEqual(sync.isDesynced(), false);
  assert.strictEqual((await require("../../src/own-tools/_propagate-active-page.js").propagateActivePageToUpstream("https://other.example/x")).propagated, true);
});

test("r2: with upstream unreadable, tabs the relay created are still reused and pruned; others are spared", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const users = navPage("https://user.example/signed-in");
  const pages = [users];
  let n = 0;
  globalThis.__relayBridge = { context: { pages: () => pages, newPage: async () => { const p = navPage("about:blank"); p.n = ++n; pages.push(p); return p; } } };
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

test("r2: reusing a separate relay tab that merely shows the pinned URL does not move ownership off upstream's tab", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const up = fakeUpstream({ url: "https://site.example/a" });
  const restore = up.install();
  sync.markSynced("https://site.example/a");
  const relayTab = navPage("https://site.example/a"); // a different tab: its goto leaves upstream's page alone
  globalThis.__relayBridge = { context: { pages: () => [relayTab], newPage: async () => { throw new Error("should not create"); } } };
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });

  const res = await tabsNew.handler({ url: "https://site.example/b" });
  const payload = JSON.parse(res.content[res.content.length - 1].text);
  assert.strictEqual(payload.reused, true);
  assert.strictEqual(payload.upstreamPropagated, true, "upstream's /a was still the relay's, so propagation moved it");
  assert.strictEqual(up.url, "https://site.example/b");
  assert.strictEqual(sync.isDesynced(), false);
});

test("r3: adopting upstream's own blank tab keeps it the relay's (the adopt-blank read)", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const up = fakeUpstream({ url: "about:blank" });
  const restore = up.install();
  const blank = navPage("about:blank");
  blank.goto = async function (u) { this.gotoUrls.push(u); this._url = u; up.url = u; }; // it IS upstream's tab
  globalThis.__relayBridge = { context: { pages: () => [blank], newPage: async () => { throw new Error("should not create"); } } };
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });

  const res = await tabsNew.handler({ url: "https://site.example/a" });
  assert.strictEqual(JSON.parse(res.content[res.content.length - 1].text).adoptedBlank, true);
  assert.strictEqual(sync.state().relayUrl, "https://site.example/a");
  assert.strictEqual((await require("../../src/own-tools/_propagate-active-page.js").propagateActivePageToUpstream("https://other.example/x")).propagated, true);
});

test("r3: a failed navigation of upstream's own reused tab is not reported as a desync", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const up = fakeUpstream({ url: "https://site.example/a" });
  const restore = up.install();
  sync.markSynced("https://site.example/a");
  const pinned = navPage("https://site.example/a");
  pinned.goto = async () => { throw new Error("net::ERR_TIMED_OUT"); };
  globalThis.__relayBridge = { context: { pages: () => [pinned], newPage: async () => { throw new Error("should not create"); } } };
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); restore(); });

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
  globalThis.__relayBridge = { context: { pages: () => pages, newPage: async () => { const p = navPage("about:blank"); pages.push(p); return p; } } };
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
    ["a.example", true, true, false],
    ["b.example", false, null, false],
  ]);
  assert.ok(reuse.every((e) => !JSON.stringify(e).includes("/1") && !JSON.stringify(e).includes("theirs")), "host only, never a path");
  const open = events.filter((e) => e.event === "tabs-open").pop();
  assert.deepStrictEqual([open.open, open.createdHere, open.other], [2, 1, 1]);
});

test("MED-3 log: each pruned tab is logged; a throwing logger never breaks tabs_new", async (t) => {
  const { clearActivePage } = require("../../src/own-tools/_active-page.js");
  clearActivePage();
  const events = collectEvents(t);
  const old = [navPage("https://x.example/"), navPage("https://y.example/")];
  const pages = [...old];
  globalThis.__relayBridge = { context: { pages: () => pages, newPage: async () => { const p = navPage("about:blank"); pages.push(p); return p; } } };
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

  globalThis.__relayEventLog = () => { throw new Error("log broke"); };
  const res = await tabsNew.handler({ url: "https://w.example/", forceNew: true });
  assert.notStrictEqual(res.isError, true);
  const reused = await tabsNew.handler({ url: "https://w.example/again" }); // the reuse path logs too
  assert.strictEqual(JSON.parse(reused.content[reused.content.length - 1].text).reused, true);
});
