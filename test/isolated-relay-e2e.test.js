// isolated-relay-e2e.test.js — the REAL relay (launch-project-isolated.js →
// src/index.js) with the REAL upstream (browser-devtools-mcp) and a test Brave,
// under the harness's temp HOME. Spec v4 §1b (sidecar port, upstream on the ws
// endpoint), §1d (guard + upstream stub coexisting; `execute` bypassing the
// tool pre-check), §1a/N6 + amendment 4 (shutdown order with an owned Brave),
// and attach-first across relays.
//
// BDMCP telemetry is switched off (TELEMETRY_ENABLE=false): it would otherwise
// post to PostHog from the upstream node process, outside the host map.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");
const { isolated, SKIP_MSG, homeTmp, nodeChild, killAndWait, REPO } = require("./helpers/isolation.js");
const { startRelay } = require("./helpers/mcp.js");
const id = require("../src/cdp-identity.js");
const lock = require("../src/profile-lock.js");

let BRAVE = null;
try { BRAVE = require("../src/detect-browser.js").detectBravePath(); } catch { /* skip */ }
const ISO = {
  skip: !isolated() ? SKIP_MSG : (!BRAVE ? "no Brave installed" : (process.platform !== "darwin" ? "darwin" : false)),
  timeout: 180000,
};

const RELAY_ENV = () => ({
  BROWSER_RELAY_TEST_LAUNCH: "1",
  BROWSER_RELAY_INSECURE_TLS: "1",
  BROWSER_HEADLESS_ENABLE: "true",
  BROWSER_RELAY_BRAVE_PATH: BRAVE,
  TELEMETRY_ENABLE: "false",
});

let server = null;
let PORT = 0;
const hits = [];
async function startServer() {
  if (server) return;
  const dir = homeTmp("tls-e2e-");
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=relay-test"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  server = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, (req, res) => {
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    hits.push({ host, path: new URL(req.url, "https://x").pathname });
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><link rel="icon" href="data:,"></head><body>SERVER-PAGE ${host}</body></html>`);
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  PORT = server.address().port;
}
test.after(() => { if (server) server.close(); });
const U = (host, p = "/") => `https://${host}:${PORT}${p}`;

// One home per test (files run in parallel; the cache root is not shared).
const slugOf = (p) => path.basename(p).replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
const profileOf = (home, p) => path.join(home, "Library", "Caches", "browser-mcp-relay", "profiles", slugOf(p));
const sidecar = (dir) => JSON.parse(fs.readFileSync(path.join(dir, ".mcp-relay-status.json"), "utf8"));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const cmdline = (pid) => spawnSync("ps", ["-p", String(pid), "-o", "command=", "-ww"], { encoding: "utf8" }).stdout;

test("e2e: Brave on port 0 published in the sidecar; guard + upstream stub coexist; `execute` cannot reach a Meta page; layer 1 refuses", ISO, async () => {
  await startServer();
  const home = homeTmp("home-");
  const proj = path.join(home, "proj-e2e");
  const base = profileOf(home, proj);
  const r = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV() }, realUpstream: true });
  try {
    const first = await r.call("tabs_list", {}, 90000);
    assert.ok(!first.isError, first.text);
    assert.match(first.notices[0] || "", /BASE profile/);

    // §1b: the port is OS-assigned, proven, and published for external consumers.
    const file = id.readDevToolsActivePort(base);
    const side = sidecar(base);
    assert.strictEqual(side.braveAlive, true);
    assert.strictEqual(side.cdpPort, file.port);
    assert.ok(alive(side.bravePid));
    assert.match(cmdline(side.bravePid), /--remote-debugging-port=0(\s|$)/);
    assert.match(cmdline(side.bravePid), /--use-mock-keychain/);
    const st = JSON.parse((await r.call("relay_status")).text);
    assert.strictEqual(st.metaGuard, "active");
    assert.strictEqual(st.cdpPort, file.port);

    // §1d coexistence: upstream's own context.route stub still works …
    const stub = await r.call("stub_mock-http-response", {
      pattern: `https://allowed.test:${PORT}/stubbed*`,
      response: { status: 200, headers: { "content-type": "text/html" }, body: "<html><body>STUBBED-BODY</body></html>" },
    }, 60000);
    assert.ok(!stub.isError, stub.text);
    const nav = await r.call("navigation_go-to", { url: U("allowed.test", "/stubbed"), includeSnapshot: false }, 60000);
    assert.ok(!nav.isError, nav.text);
    const txt = await r.call("content_get-as-text", {}, 60000);
    assert.match(txt.text, /STUBBED-BODY/);
    assert.strictEqual(hits.filter((h) => h.path === "/stubbed").length, 0, "the stub answered, not the network");

    // … while a Meta document reached through upstream's `execute` (which the
    // tool pre-check cannot see) is blocked by the Fetch layer.
    const igBefore = hits.filter((h) => h.host === "www.instagram.com").length;
    const ex = await r.call("execute", {
      code: `try { await callTool("navigation_go-to", { url: ${JSON.stringify(U("www.instagram.com", "/accounts/login/"))}, includeSnapshot: false }); } catch (e) {}
             const t = await callTool("content_get-as-text", {}, true); return t;`,
    }, 90000);
    assert.match(ex.text, /Blocked/, ex.text.slice(0, 500));
    assert.strictEqual(hits.filter((h) => h.host === "www.instagram.com").length, igBefore, "instagram received no request");
    assert.ok(ex.notices.some((n) => /BLOCKED a Meta page \(www\.instagram\.com\)/.test(n)) ||
      (await r.call("tabs_list")).notices.some((n) => /BLOCKED a Meta page/.test(n)), "the block is reported on a tool result");

    // Layer 1: the forwarded tool's URL argument never reaches Brave.
    const l1 = await r.call("navigation_go-to", { url: "https://www.facebook.com/" });
    assert.strictEqual(l1.isError, true);
    assert.match(l1.text, /BLOCKED/);
  } finally {
    await r.stop();
  }
});

test("shutdown order (owned Brave): a peer cannot claim the base until our Brave is gone", ISO, async () => {
  const home = homeTmp("home-");
  const proj = path.join(home, "proj-shutdown");
  const base = profileOf(home, proj);
  const r = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV() } });
  let peer;
  try {
    const res = await r.call("tabs_list", {}, 90000);
    assert.ok(!res.isError, res.text);
    const bravePid = sidecar(base).bravePid;
    assert.ok(alive(bravePid));
    peer = nodeChild(`
      const lock = require(${JSON.stringify(path.join(REPO, "src", "profile-lock.js"))});
      const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
      console.log("POLLING");
      const t = setInterval(() => {
        const c = lock.claimDir(${JSON.stringify(base)}, { _log: () => {} });
        if (c) { console.log("CLAIMED braveAlive=" + alive(${bravePid})); clearInterval(t); c.release(); process.exit(0); }
      }, 5);
    `);
    await peer.waitLine(/POLLING/);
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(!peer.lines.some((l) => l.startsWith("CLAIMED")), "precondition: the base is held while the relay runs");
    await r.stop();
    const line = await peer.waitLine(/^CLAIMED/, 20000);
    assert.strictEqual(line, "CLAIMED braveAlive=false", "the peer got the base only after our Brave exited");
  } finally {
    if (peer) await killAndWait(peer.child);
    await r.stop();
  }
});

// The orphan is kept alive DELIBERATELY. A Brave the relay LAUNCHED is driven
// over --remote-debugging-pipe and exits when that relay is SIGKILLed (the pipe
// closes), so with a launched Brave this test used to find no orphan and skip
// (30 of 33 runs), and under load it raced: still exiting after a fixed 1 s,
// so the second relay found nothing to attach to (Phase 1 review LOW #6).
// Here the TEST launches the Brave on the project's base profile and holds its
// pipe; relay A attaches to it, opens a tab and is SIGKILLed. That is the
// orphan attach-first exists for: a Brave a dead relay leaves running. A
// bounded poll then proves it alive AND attachable before relay B starts.
test("attach-first across relays: a relay killed uncleanly leaves its Brave; the next relay attaches to it (proven endpoint), tabs kept", ISO, async () => {
  const { chromium } = require("playwright-core");
  const pool = require("../src/pool-shared.js");
  const home = homeTmp("home-");
  const proj = path.join(home, "proj-attach");
  const base = profileOf(home, proj);
  fs.mkdirSync(base, { recursive: true });
  const orphan = await chromium.launchPersistentContext(base, {
    headless: true, executablePath: BRAVE, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    args: ["--remote-debugging-port=0", ...require("../src/cdp-bridge.js").TEST_LAUNCH_ARGS],
  });
  let a, b;
  try {
    await id.waitForDevToolsActivePort(base);
    const bravePid = pool.findBraveMainPid(base);
    assert.ok(bravePid && alive(bravePid), "precondition: the test Brave runs on the base profile");

    a = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV() } });
    const opened = await a.call("tabs_new", { url: "data:text/html,KEEP-THIS-TAB" }, 90000);
    assert.ok(!opened.isError, opened.text);
    assert.match(a.stderr(), new RegExp(`live Brave pid=${bravePid} already owns`), "relay A attached to the test Brave");
    a.child.kill("SIGKILL");
    await a.exited;

    // Bounded poll (≤ 5 s): the orphan must be alive and PROVABLY attachable
    // (DevToolsActivePort uuid == /json/version) when relay B starts.
    let found = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      found = alive(bravePid) ? await pool.findAttachableBrave(base) : null;
      if (found && found.pid === bravePid) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.ok(found && found.pid === bravePid && alive(bravePid),
      `the orphan Brave pid=${bravePid} must be alive and attachable within 5 s of relay A's death (found ${JSON.stringify(found)})`);

    b = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV() } });
    const list = await b.call("tabs_list", {}, 90000);
    assert.ok(!list.isError, list.text);
    assert.match(b.stderr(), new RegExp(`live Brave pid=${bravePid} already owns`));
    assert.doesNotMatch(b.stderr(), /launching Brave/, "relay B attached; it did not launch");
    assert.match(list.text, /KEEP-THIS-TAB/, "the orphan's tabs are still there");
    assert.strictEqual(sidecar(base).bravePid, bravePid);
  } finally {
    // stop() is a no-op on an exited relay; it matters when an assertion
    // fires while relay A (or B) is still running.
    if (b) await b.stop();
    if (a) await a.stop();
    await orphan.close().catch(() => {});
  }
});

// Kit staging 2026-10-13-relay-active-page: upstream's pinned tab, once the
// user has changed it, is never navigated by propagation (rule C); upstream
// tools that change a page are refused while it is not the selected tab (B);
// every upstream result says so (A). Real upstream `execute` reads the URL.
test("e2e: a tab the user navigated is not taken over by tabs_new; execute is refused, then allowed by opt-in or by selecting it", ISO, async () => {
  await startServer();
  const home = homeTmp("home-");
  const proj = path.join(home, "proj-desync");
  const base = profileOf(home, proj);
  const r = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV() }, realUpstream: true });
  let browser = null;
  try {
    const nav = await r.call("navigation_go-to", { url: U("relay.test", "/a"), includeSnapshot: false }, 90000);
    assert.ok(!nav.isError, nav.text);

    // The user, in that same tab, goes somewhere the relay never sent it.
    const { chromium } = require("playwright-core");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${sidecar(base).cdpPort}`);
    const tabs = () => browser.contexts().flatMap((c) => c.pages());
    const pinned = tabs().find((p) => p.url() === U("relay.test", "/a"));
    assert.ok(pinned, "upstream's tab is visible over CDP");
    await pinned.goto(U("user.test", "/dashboard"));

    const opened = await r.call("tabs_new", { url: U("relay.test", "/b") }, 60000);
    assert.ok(!opened.isError, opened.text);
    const payload = JSON.parse(opened.rest[opened.rest.length - 1].text);
    assert.strictEqual(payload.upstreamPropagated, false, opened.text);
    assert.strictEqual(payload.upstreamUrl, U("user.test", "/dashboard"));
    assert.match(opened.text, /UPSTREAM DESYNC/);
    assert.strictEqual(pinned.url(), U("user.test", "/dashboard"), "the user's tab was not navigated");

    const refused = await r.call("execute", { code: `await page.goto(${JSON.stringify(U("relay.test", "/c"))}); return page.url();` }, 60000);
    assert.strictEqual(refused.isError, true);
    assert.match(refused.text, /REFUSED execute/);
    assert.strictEqual(hits.filter((h) => h.path === "/c").length, 0);
    assert.strictEqual(pinned.url(), U("user.test", "/dashboard"));

    const optIn = await r.call("execute", { code: "return page.url();", allowPinnedPage: true }, 60000);
    assert.ok(!optIn.isError, optIn.text);
    assert.ok(optIn.text.includes(U("user.test", "/dashboard")), optIn.text);
    assert.match(optIn.text, /UPSTREAM DESYNC/);

    // Selecting the user's tab is a sync with no reload.
    const listed = await r.call("tabs_list");
    const list = JSON.parse(listed.rest[listed.rest.length - 1].text);
    const idx = list.pages.findIndex((t) => t.url === U("user.test", "/dashboard"));
    assert.ok(idx >= 0, JSON.stringify(list));
    const dashHits = hits.filter((h) => h.path === "/dashboard").length;
    const sel = await r.call("tabs_select", { index: idx }, 60000);
    assert.doesNotMatch(sel.text, /UPSTREAM DESYNC/);
    assert.strictEqual(JSON.parse(sel.text).upstreamPropagated, true);
    assert.strictEqual(hits.filter((h) => h.path === "/dashboard").length, dashHits, "no reload of the user's page");
    const ok = await r.call("execute", { code: "return 2;" }, 60000);
    assert.ok(!ok.isError, ok.text);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await r.stop();
  }
});

test("e2e (review r1 H1): after the user signs in inside upstream's tab, tabs_new on the same host opens a new tab instead of reusing it", ISO, async () => {
  await startServer();
  const home = homeTmp("home-");
  const proj = path.join(home, "proj-desync-h1");
  const base = profileOf(home, proj);
  const r = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV() }, realUpstream: true });
  let browser = null;
  try {
    const nav = await r.call("navigation_go-to", { url: U("site.test", "/login"), includeSnapshot: false }, 90000);
    assert.ok(!nav.isError, nav.text);
    const { chromium } = require("playwright-core");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${sidecar(base).cdpPort}`);
    const pinned = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url() === U("site.test", "/login"));
    assert.ok(pinned);
    await pinned.goto(U("site.test", "/dashboard")); // the user signs in

    const opened = await r.call("tabs_new", { url: U("site.test", "/reports") }, 60000);
    assert.ok(!opened.isError, opened.text);
    const payload = JSON.parse(opened.rest[opened.rest.length - 1].text);
    assert.strictEqual(payload.reused, false, opened.text);
    assert.strictEqual(pinned.url(), U("site.test", "/dashboard"), "the user's tab was not navigated");
    assert.match(opened.text, /UPSTREAM DESYNC/);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await r.stop();
  }
});
