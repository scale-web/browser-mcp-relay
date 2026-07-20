// tabs-reuse.test.js — 2026-07-16 tab-leak fixes: same-host reuse in
// tabs_new, oldest-first pruning under BROWSER_RELAY_MAX_TABS.

const test = require("node:test");
const assert = require("node:assert");
const tabsNew = require("../../src/own-tools/tabs-new.js");

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
  globalThis.__relayUpstream = undefined;
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); });

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
