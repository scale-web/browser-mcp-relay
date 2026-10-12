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

test("attach-first across relays: a relay killed uncleanly leaves its Brave; the next relay attaches to it (proven endpoint), tabs kept", ISO, async (t) => {
  const home = homeTmp("home-");
  const proj = path.join(home, "proj-attach");
  const base = profileOf(home, proj);
  const a = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV() } });
  const opened = await a.call("tabs_new", { url: "data:text/html,KEEP-THIS-TAB" }, 90000);
  assert.ok(!opened.isError, opened.text);
  const bravePid = sidecar(base).bravePid;
  a.child.kill("SIGKILL");
  await a.exited;
  await new Promise((res) => setTimeout(res, 1000));
  if (!alive(bravePid)) {
    // Measured 2026-10-12 (headless test Brave): it exits when its relay is
    // SIGKILLed (the --remote-debugging-pipe closes), so there is nothing to
    // attach to. Attach-first itself is covered against live Braves in
    // isolated-brave.test.js.
    t.skip("the test Brave exited with its relay (pipe closed) — no orphan to attach to");
    return;
  }
  const b = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV() } });
  try {
    const list = await b.call("tabs_list", {}, 90000);
    assert.ok(!list.isError, list.text);
    assert.match(b.stderr(), new RegExp(`live Brave pid=${bravePid} already owns`));
    assert.match(list.text, /KEEP-THIS-TAB/, "the orphan's tabs are still there");
    assert.strictEqual(sidecar(base).bravePid, bravePid);
  } finally {
    await b.stop();
    try { process.kill(bravePid, "SIGKILL"); } catch { /* closed */ }
  }
});
