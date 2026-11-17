// tabs-new-pinned.test.js — upstream is RE-PINNED to the relay's tab (ask
// as-ops/ask-5ojuum rev 3, "Re-pin upstream to relay tab").
//
// Before: upstream (browser-devtools-mcp) ran on its own page, and the relay
// NAVIGATED that page to the URL of the relay's tab — every session's first
// URL loaded in two tabs, and a second host navigated the working page away.
// Now tabs_new / tabs_select move upstream's pin to the relay's tab by CDP
// target id (scripts/patch-bdmcp-repin.js); nothing is navigated to follow.
//
// Real Chromium (Chrome for Testing from Playwright's cache; skipped when
// absent) and the REAL upstream, patched in a temp copy (test/helpers/
// real-upstream.js). Upstream tools are called through the real RelayServer,
// so its re-pin before each call is in the path. Assertions read
// context.pages() and what upstream's tools return.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tabsNew = require("../../src/own-tools/tabs-new.js");
const tabsSelect = require("../../src/own-tools/tabs-select.js");
const sync = require("../../src/own-tools/_upstream-sync.js");
const { clearActivePage } = require("../../src/own-tools/_active-page.js");
const { RelayServer } = require("../../src/relay-server.js");
const { startRealUpstream } = require("../helpers/real-upstream.js");
require("../../src/request-body-filter.js").setSourcePatchInEffect(true);

let chromium = null;
try { ({ chromium } = require("playwright")); if (!fs.existsSync(chromium.executablePath())) chromium = null; } catch { chromium = null; }
const REAL = { timeout: 120000, skip: chromium ? false : "Chrome for Testing not installed" };

async function launch(t, { attached = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-repin-"));
  const context = await chromium.launchPersistentContext(dir, {
    headless: true, args: ["--remote-debugging-port=0"], handleSIGINT: false, handleSIGTERM: false,
  });
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  assert.ok(port, "DevToolsActivePort was written");
  const wsEndpoint = JSON.parse(await (await fetch(`http://127.0.0.1:${port}/json/version`)).text()).webSocketDebuggerUrl;
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(`${req.headers.host}${req.url}`);
    res.setHeader("content-type", "text/html");
    res.end(`<title>${req.url}</title><p>PAGE ${req.url}</p><input id=d><script>console.log("loaded ${req.url}")</script>`);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  // The user's own site: another host (127.0.0.1:<other port>). A user's tab on
  // the SAME host as a tabs_new URL can still be reused — register A55 MED-3,
  // unchanged here.
  const usersSrv = http.createServer((req, res) => { userHits.push(req.url); res.setHeader("content-type", "text/html"); res.end("<p>USER</p>"); });
  const userHits = [];
  await new Promise((r) => usersSrv.listen(0, "127.0.0.1", r));
  const up = startRealUpstream(wsEndpoint);
  const prevUp = globalThis.__relayUpstream;
  globalThis.__relayUpstream = async () => up.client;
  sync.reset();
  clearActivePage();
  const handle = { context, wsEndpoint, ...(attached ? { attached: true } : {}) };
  tabsNew.noteLaunchedPages(handle); // what index.js does (no-op for an attached Brave)
  globalThis.__relayBridge = handle;
  const relay = new RelayServer({ getUpstream: async () => up.client });
  t.after(async () => {
    globalThis.__relayBridge = undefined;
    globalThis.__relayUpstream = prevUp;
    sync.reset();
    clearActivePage();
    await up.stop();
    await context.close().catch(() => {});
    srv.close();
    usersSrv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port2 = srv.address().port;
  return { context, relay, up, hits, userHits, A: `http://127.0.0.1:${port2}/a`, B: `http://localhost:${port2}/b`, USER: `http://127.0.0.1:${usersSrv.address().port}/users-own` };
}

const open = (context) => context.pages().filter((p) => !p.isClosed());
const last = (r) => JSON.parse(r.content[r.content.length - 1].text);
/** What upstream's `execute` sees, through the relay (its re-pin runs first). */
async function upstreamEval(relay, code) {
  const r = await relay.handleToolsCall({ name: "execute", arguments: { code } });
  assert.notStrictEqual(r.isError, true, JSON.stringify(r));
  return (r.structuredContent || JSON.parse(r.content[r.content.length - 1].text)).result;
}

test("A, then B, then select A: one tab per URL, upstream acts on the selected tab, A's draft survives", REAL, async (t) => {
  const { context, relay, hits, userHits, A, B, USER } = await launch(t);
  // The user's own tab, opened before the relay's first call.
  const users = await context.newPage();
  await users.goto(USER);

  const ra = await tabsNew.handler({ url: A });
  assert.notStrictEqual(ra.isError, true, JSON.stringify(ra));
  assert.strictEqual(last(ra).upstreamPropagated, true, JSON.stringify(ra));
  assert.strictEqual(open(context).filter((p) => p.url() === A).length, 1, `one tab on A: ${open(context).map((p) => p.url())}`);
  assert.strictEqual(open(context).filter((p) => p.url() === "about:blank").length, 0, `no blank left (launch blank adopted, upstream's own closed): ${open(context).map((p) => p.url())}`);
  assert.strictEqual(hits.filter((h) => h.endsWith("/a")).length, 1, "A loaded once");
  assert.strictEqual(await upstreamEval(relay, "return page.url();"), A);
  const text = await relay.handleToolsCall({ name: "content_get-as-text", arguments: {} });
  assert.match(JSON.stringify(text), /PAGE \/a/, "upstream's content tool reads A");

  const tabA = open(context).find((p) => p.url() === A);
  await tabA.fill("#d", "draft in A");

  const rb = await tabsNew.handler({ url: B });
  assert.strictEqual(last(rb).upstreamPropagated, true);
  assert.strictEqual(open(context).filter((p) => p.url() === B).length, 1);
  assert.strictEqual(tabA.isClosed(), false, "A stays open");
  assert.strictEqual(tabA.url(), A, "A is not navigated away");
  assert.strictEqual(await tabA.inputValue("#d"), "draft in A");
  assert.strictEqual(await upstreamEval(relay, "return page.url();"), B, "upstream acts on B");
  assert.strictEqual(open(context).length, 3, `A, B and the user's tab only: ${open(context).map((p) => p.url())}`);

  const idxA = context.pages().indexOf(tabA);
  const rs = await tabsSelect.handler({ index: idxA });
  assert.strictEqual(last(rs).upstreamPropagated, true);
  assert.strictEqual(await upstreamEval(relay, "return page.url();"), A, "upstream acts on A again");
  assert.strictEqual(await upstreamEval(relay, "return await page.inputValue('#d');"), "draft in A", "A's state is intact");
  assert.strictEqual(hits.filter((h) => h.endsWith("/a")).length, 1, "A was never reloaded");

  assert.strictEqual(users.isClosed(), false, "the user's tab is never closed");
  assert.strictEqual(users.url(), USER, "…nor navigated");
  assert.deepStrictEqual(userHits, ["/users-own"], "…nor reloaded");
  assert.strictEqual(hits.length, 2, `only A and B were loaded: ${hits}`);
  assert.strictEqual(sync.isDesynced(), false);
});

test("console / network capture follows the pin; earlier entries stay", REAL, async (t) => {
  const { context, relay, A, B } = await launch(t);
  await tabsNew.handler({ url: A });
  const tabA = open(context).find((p) => p.url() === A);
  await tabsNew.handler({ url: B });
  const tabB = open(context).find((p) => p.url() === B);
  await tabA.evaluate(() => console.log("from A after the re-pin"));
  await tabB.evaluate(() => console.log("from B while pinned"));
  await new Promise((r) => setTimeout(r, 500));
  const res = await relay.handleToolsCall({ name: "o11y_get-console-messages", arguments: {} });
  const texts = (res.structuredContent || JSON.parse(res.content[res.content.length - 1].text)).messages.map((m) => m.text);
  assert.ok(texts.includes("loaded /a"), `A's console from while it was pinned stays: ${texts}`);
  assert.ok(texts.includes("from B while pinned"), `${texts}`);
  assert.ok(!texts.includes("from A after the re-pin"), `a tab upstream left is not captured: ${texts}`);
  const req = await relay.handleToolsCall({ name: "o11y_get-http-requests", arguments: {} });
  assert.match(JSON.stringify(req), /\/b/, "B's request was captured");
  // Back on A: A records again, once per message (its listeners are not attached twice).
  await tabsSelect.handler({ index: context.pages().indexOf(tabA) });
  await tabA.evaluate(() => console.log("from A once more"));
  await new Promise((r) => setTimeout(r, 500));
  const again = await relay.handleToolsCall({ name: "o11y_get-console-messages", arguments: {} });
  const texts2 = (again.structuredContent || JSON.parse(again.content[again.content.length - 1].text)).messages.map((m) => m.text);
  assert.strictEqual(texts2.filter((x) => x === "from A once more").length, 1, `${texts2}`);
});

test("attached Brave: a blank the relay cannot name is never adopted, navigated or closed", REAL, async (t) => {
  const { context, relay, A } = await launch(t, { attached: true });
  const usersBlank = open(context)[0];
  // Selected first: upstream is pinned to the user's blank; moving off it must not close it.
  await tabsSelect.handler({ index: context.pages().indexOf(usersBlank) });
  await tabsNew.handler({ url: A });
  assert.strictEqual(usersBlank.isClosed(), false);
  assert.strictEqual(usersBlank.url(), "about:blank");
  assert.strictEqual(open(context).filter((p) => p.url() === A).length, 1);
  assert.strictEqual(open(context).length, 2, `the user's blank and A: ${open(context).map((p) => p.url())}`);
  assert.strictEqual(await upstreamEval(relay, "return page.url();"), A);
});

test("upstream's tool list is unchanged: no hidden re-pin tool reaches the model", REAL, async (t) => {
  const { relay, up } = await launch(t);
  const fromUpstream = await up.client.request("tools/list", {});
  assert.ok(!JSON.stringify(fromUpstream).includes("__relay"), "upstream advertises nothing new");
  const { tools } = await relay.handleToolsList();
  assert.ok(!JSON.stringify(tools).includes("__relay"));
  assert.ok(tools.some((x) => x.name === "execute"));
});
