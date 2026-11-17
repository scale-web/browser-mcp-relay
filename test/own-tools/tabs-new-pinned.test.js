// tabs-new-pinned.test.js — the first tabs_new({url}) of a relay session must
// leave the URL open in ONE tab (diagnosed 2026-11-17, ask as-ops/ask-bnyrbp).
//
// Before the fix: with no same-host tab, tabs_new adopted Brave's leftover
// about:blank; its upstream URL read then started upstream, which attached over
// CDP and opened its OWN page; propagation then navigated that page to the same
// URL — two tabs on the host. Now tabs_new uses upstream's pinned page itself
// (matched by CDP target id) and closes the residual blank only when the relay
// or upstream created it.
//
// Real Chromium (Chrome for Testing from Playwright's cache; skipped when
// absent): the relay's persistent context, plus a stub upstream that connects
// over CDP and opens its page on its FIRST call, as browser-devtools-mcp does
// (see _propagate-active-page.js). Assertions read context.pages(), not the
// tool's output.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tabsNew = require("../../src/own-tools/tabs-new.js");
const sync = require("../../src/own-tools/_upstream-sync.js");
const { clearActivePage } = require("../../src/own-tools/_active-page.js");

let chromium = null;
try { ({ chromium } = require("playwright")); if (!fs.existsSync(chromium.executablePath())) chromium = null; } catch { chromium = null; }
const REAL = { timeout: 60000, skip: chromium ? false : "Chrome for Testing not installed" };

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** A stub upstream: its first call attaches over CDP and opens its own page;
 *  `execute` runs the code with `page` bound (the relay's real URL probe runs
 *  for real), navigation_go-to navigates that page. */
function stubUpstream(endpoint) {
  let browser = null;
  let page = null;
  const st = { calls: [] };
  const client = {
    request: async (method, params) => {
      st.calls.push(params && params.name);
      if (!page) {
        browser = await chromium.connectOverCDP(endpoint);
        page = await browser.contexts()[0].newPage();
      }
      const { name, arguments: a = {} } = params || {};
      if (name === "execute") {
        let out;
        try { out = { toolOutputs: [], logs: [], result: await new AsyncFunction("page", a.code)(page) }; }
        catch (e) { out = { toolOutputs: [], logs: [], error: e.message }; }
        return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
      }
      if (name === "navigation_go-to") await page.goto(a.url);
      return { content: [{ type: "text", text: "{}" }] };
    },
  };
  st.install = () => {
    const prev = globalThis.__relayUpstream;
    globalThis.__relayUpstream = async () => client;
    sync.reset();
    return () => { globalThis.__relayUpstream = prev; sync.reset(); };
  };
  st.disconnect = async () => { if (browser) await browser.close().catch(() => {}); };
  return st;
}

async function launch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pinned-"));
  const context = await chromium.launchPersistentContext(dir, {
    headless: true, args: ["--remote-debugging-port=0"], handleSIGINT: false, handleSIGTERM: false,
  });
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  assert.ok(port, "DevToolsActivePort was written");
  const srv = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(`<p>${req.url}</p>`); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const up = stubUpstream(`http://127.0.0.1:${port}`);
  const restore = up.install();
  const events = [];
  const prevLog = globalThis.__relayEventLog;
  globalThis.__relayEventLog = (event, fields) => { events.push({ event, ...fields }); return true; };
  clearActivePage();
  t.after(async () => {
    globalThis.__relayBridge = undefined;
    globalThis.__relayEventLog = prevLog;
    clearActivePage();
    restore();
    await up.disconnect();
    await context.close().catch(() => {});
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = (host) => `http://${host}:${srv.address().port}`;
  return { context, up, events, base };
}

const open = (context) => context.pages().filter((p) => !p.isClosed());
const onHost = (context, host) => open(context).filter((p) => tabsNew._urlHost(p.url()) === host);

test("first tabs_new({url}) of a session: the URL is open in exactly one tab, no blank left", REAL, async (t) => {
  const { context, up, events, base } = await launch(t);
  const handle = { context };
  tabsNew.noteLaunchedPages(handle); // what index.js does for a launched (not attached) Brave
  globalThis.__relayBridge = handle;
  assert.strictEqual(open(context).length, 1, "a fresh launch has its one blank");

  const res = await tabsNew.handler({ url: `${base("127.0.0.1")}/first` });
  assert.notStrictEqual(res.isError, true, JSON.stringify(res));
  const host = `127.0.0.1:${new URL(base("127.0.0.1")).port}`;
  assert.strictEqual(onHost(context, host).length, 1, `one tab on the host, got ${open(context).map((p) => p.url())}`);
  assert.strictEqual(open(context).filter((p) => p.url() === "about:blank").length, 0, "no blank left");
  assert.strictEqual(open(context).length, 1);
  assert.strictEqual(sync.isDesynced(), false);
  assert.ok(up.calls.includes("execute"), "upstream was started");
  const tabsOpen = events.filter((e) => e.event === "tabs-open").pop();
  assert.deepStrictEqual([tabsOpen.open, tabsOpen.createdHere, tabsOpen.otherBlank, tabsOpen.other], [1, 0, 0, 1]);

  // A second host: upstream's tab is the relay's, so it is navigated — still one tab.
  await tabsNew.handler({ url: `${base("localhost")}/second` });
  assert.strictEqual(open(context).length, 1, `still one tab, got ${open(context).map((p) => p.url())}`);
  assert.match(open(context)[0].url(), /localhost:\d+\/second$/);
  assert.strictEqual(sync.isDesynced(), false);
});

test("first tabs_new({url}) with a blank the relay did not create (attached Brave) and a user's tab: both survive, one tab on the host", REAL, async (t) => {
  const { context, base } = await launch(t);
  const handle = { context, attached: true };
  tabsNew.noteLaunchedPages(handle); // attached: no page is the relay's
  const usersBlank = open(context)[0];
  const usersTab = await context.newPage();
  await usersTab.goto(`${base("localhost")}/users-own`);
  globalThis.__relayBridge = handle;

  const res = await tabsNew.handler({ url: `${base("127.0.0.1")}/first` });
  assert.notStrictEqual(res.isError, true, JSON.stringify(res));
  const host = `127.0.0.1:${new URL(base("127.0.0.1")).port}`;
  assert.strictEqual(onHost(context, host).length, 1, `one tab on the host, got ${open(context).map((p) => p.url())}`);
  assert.strictEqual(usersBlank.isClosed(), false, "a blank the relay did not create is never closed");
  assert.strictEqual(usersBlank.url(), "about:blank", "…nor navigated");
  assert.strictEqual(usersTab.isClosed(), false);
  assert.match(usersTab.url(), /\/users-own$/, "the user's tab is untouched");
  assert.strictEqual(open(context).length, 3);
});
