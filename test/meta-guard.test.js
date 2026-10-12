// meta-guard.test.js — spec v4 §1d, the parts that need no browser: the lists,
// URL classification, the Fetch prefilter, and layer 1 (the tool pre-check in
// RelayServer). Layers 2 and 3 run against a real test Brave in
// test/isolated-brave.test.js.

const test = require("node:test");
const assert = require("node:assert");
const g = require("../src/meta-guard.js");
const { RelayServer } = require("../src/relay-server.js");

const BLOCK = [
  "https://instagram.com/", "https://www.instagram.com/p/abc/", "https://help.instagram.com/",
  "https://facebook.com/", "https://www.facebook.com/", "https://m.facebook.com/login.php",
  "https://business.facebook.com/", "https://adsmanager.facebook.com/", "https://web.facebook.com/",
  "https://fb.com/", "https://www.fb.com/x", "https://fb.me/abc",
  "https://messenger.com/", "https://www.messenger.com/t/1",
  "https://threads.net/", "https://threads.com/@x",
  "https://accountscenter.instagram.com/", "https://accountscenter.meta.com/", "https://accountscenter.facebook.com/",
  "https://auth.meta.com/", "https://business.meta.com/",
  "https://web.whatsapp.com/",
  "https://facebook.com/ads/library/", // only www. is allowed
  "https://www.facebook.com.:8443/login", "https://user@www.instagram.com:9443/p/1", "HTTPS://WWW.INSTAGRAM.COM/",
];
const ALLOW = [
  "https://www.facebook.com/ads/library/?q=x", "https://www.facebook.com/ads/library",
  "https://www.facebook.com/business/help/123", "https://developers.facebook.com/docs/graph-api/",
  "https://transparency.meta.com/policies/", "https://www.meta.com/", "https://about.meta.com/",
  "https://connect.facebook.net/en_US/fbevents.js", "https://scontent.cdninstagram.com/x.jpg",
  "https://static.xx.fbcdn.net/x.css", "https://www.whatsapp.com/", "https://example.com/?u=facebook.com",
  "about:blank", "data:text/html,hi", "chrome://newtab/", "not a url",
];

test("classifyUrl: every proposed block entry blocks; every allow entry and non-Meta URL passes", () => {
  for (const u of BLOCK) assert.strictEqual(g.classifyUrl(u).blocked, true, `should block ${u}`);
  for (const u of ALLOW) assert.strictEqual(g.classifyUrl(u).blocked, false, `should allow ${u}`);
});

test("the lists are one editable constant with the PROPOSED entries (incl. web.whatsapp.com)", () => {
  assert.ok(Object.isFrozen(g.META_GUARD_LISTS));
  assert.ok(g.META_GUARD_LISTS.block.includes("web.whatsapp.com"));
  assert.ok(g.META_GUARD_LISTS.block.includes("instagram.com") && g.META_GUARD_LISTS.block.includes("*.instagram.com"),
    "apex and subdomain listed separately");
  const custom = g.compileLists({ block: ["example.org"], allow: [] });
  assert.strictEqual(g.classifyUrl("https://example.org/", custom).blocked, true, "compileLists drives classification");
});

test("Fetch prefilter: every blocked sample URL matches at least one Document pattern needle", () => {
  const { fetchNeedles } = g.compileLists(g.META_GUARD_LISTS);
  for (const u of BLOCK) {
    const lower = u.toLowerCase();
    assert.ok(fetchNeedles.some((n) => lower.includes(n)), `no Fetch pattern would pause ${u}`);
  }
});

test("checkToolArgs: URL arguments of every navigating tool, and Meta cookies, are refused with the route", () => {
  const cases = [
    ["navigation_go-to", { url: "https://www.instagram.com/" }],
    ["tabs_new", { url: "https://facebook.com/" }],
    ["capture_xhr", { navigateToUrl: "https://business.facebook.com/" }],
    ["extract_structured", { navigateToUrl: "https://threads.net/" }],
    ["lighthouse_audit", { url: "https://www.messenger.com/" }],
    ["cookies_import", { cookies: [{ name: "sessionid", value: "x", domain: ".instagram.com", path: "/" }] }],
    ["cookies_import", { cookies: [{ name: "c_user", value: "x", url: "https://www.facebook.com/" }] }],
    // Phase 1 review: an ALLOWED page's URL still sets a facebook.com session cookie.
    ["cookies_import", { cookies: [{ name: "xs", value: "x", url: "https://www.facebook.com/ads/library/" }] }],
    ["cookies_import", { cookies: [{ name: "xs", value: "x", domain: "developers.facebook.com" }] }],
  ];
  for (const [name, args] of cases) {
    const r = g.checkToolArgs(name, args);
    assert.ok(r && r.isError, `${name} ${JSON.stringify(args)}`);
    assert.match(r.content[0].text, /Graph API/);
    assert.match(r.content[0].text, /phone/);
  }
  assert.strictEqual(g.checkToolArgs("navigation_go-to", { url: "https://www.facebook.com/ads/library/" }), null);
  assert.strictEqual(g.checkToolArgs("cookies_import", { cookies: [{ name: "a", value: "b", domain: ".example.com" }] }), null);
  assert.strictEqual(g.checkToolArgs("tabs_list", {}), null);
});

function relay({ calls, notices = () => [] }) {
  const r = new RelayServer({
    getUpstream: async () => ({ request: async (m, p) => { calls.upstream.push(p.name); return { content: [{ type: "text", text: "UPSTREAM" }] }; } }),
    ensureBrave: async () => { calls.ensureBrave++; },
    takeNotices: notices,
  });
  return r;
}

test("layer 1 in RelayServer: a Meta URL is refused BEFORE Brave is launched or upstream is called", async () => {
  const calls = { ensureBrave: 0, upstream: [] };
  const r = relay({ calls });
  const res = await r.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://www.instagram.com/accounts/login/" } });
  assert.strictEqual(res.isError, true);
  assert.match(res.content[0].text, /BLOCKED/);
  assert.strictEqual(calls.ensureBrave, 0, "no Brave launch for a refused call");
  assert.deepStrictEqual(calls.upstream, []);
});

test("RelayServer: needsBrave:false skips ensureBrave; own tools default to needing it", async () => {
  const calls = { ensureBrave: 0, upstream: [] };
  const r = relay({ calls });
  r.registerOwnTool({ name: "no_browser", description: "", inputSchema: {}, needsBrave: false, handler: async () => ({ content: [{ type: "text", text: "ok" }] }) });
  r.registerOwnTool({ name: "browser", description: "", inputSchema: {}, handler: async () => ({ content: [{ type: "text", text: "ok" }] }) });
  await r.handleToolsCall({ name: "no_browser", arguments: {} });
  assert.strictEqual(calls.ensureBrave, 0);
  await r.handleToolsCall({ name: "browser", arguments: {} });
  assert.strictEqual(calls.ensureBrave, 1);
});

test("RelayServer: notices become separate LEADING text items; upstream text untouched; a thrown call does not consume them", async () => {
  const calls = { ensureBrave: 0, upstream: [] };
  const queue = ["MODE"];
  let throwNext = true;
  const r = new RelayServer({
    getUpstream: async () => ({ request: async () => {
      if (throwNext) { throwNext = false; throw new Error("boom"); }
      return { content: [{ type: "text", text: "UPSTREAM" }] };
    } }),
    ensureBrave: async () => {},
    takeNotices: () => queue.splice(0),
  });
  await assert.rejects(r.handleToolsCall({ name: "x", arguments: {} }), /boom/);
  assert.deepStrictEqual(queue, ["MODE"], "notice still pending after a thrown call");
  const res = await r.handleToolsCall({ name: "x", arguments: {} });
  assert.deepStrictEqual(res.content, [{ type: "text", text: "MODE" }, { type: "text", text: "UPSTREAM" }]);
});
