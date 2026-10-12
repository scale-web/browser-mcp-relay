// isolated-brave.test.js — spec v4 §1b/§1d/§1a against a REAL (test) Brave.
//
// Runs only under scripts/test-harness.js (temp HOME, real-state snapshot).
// Every Brave here is launched through the BROWSER_RELAY_TEST_LAUNCH hook:
// headless, Playwright's --use-mock-keychain KEPT (never the login keychain),
// and --host-resolver-rules="MAP * 127.0.0.1", so "www.facebook.com" etc.
// resolve to the local HTTPS server below — nothing reaches a real site.
// That server logs every request's Host, which is how "the Meta host received
// ZERO requests" is asserted (r3 F6: the Fetch layer's own kill check).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");
const { isolated, SKIP_MSG, homeTmp, nodeChild, killAndWait, REPO } = require("./helpers/isolation.js");

let BRAVE = null;
try { BRAVE = require("../src/detect-browser.js").detectBravePath(); } catch { /* skip */ }
const ISO = {
  skip: !isolated() ? SKIP_MSG : (!BRAVE ? "no Brave installed" : (process.platform !== "darwin" ? "darwin" : false)),
  timeout: 120000,
};
if (isolated()) {
  // Read by cdp-bridge.launchBrave in THIS test process only.
  process.env.BROWSER_RELAY_TEST_LAUNCH = "1";
  process.env.BROWSER_RELAY_INSECURE_TLS = "1"; // the local server's self-signed cert
}

const { launchBrave, closeBrave, attachBrave } = require("../src/cdp-bridge.js");
const id = require("../src/cdp-identity.js");
const pool = require("../src/pool-shared.js");
const lock = require("../src/profile-lock.js");
const guard = require("../src/meta-guard.js");
const { CdpConnection } = guard;

// ── local HTTPS server standing in for every host ───────────────────────

let server = null;
let PORT = 0;
const hits = [];
function hostHits(host) { return hits.filter((h) => h.host === host); }

const SW_JS = `self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate" && new URL(e.request.url).pathname.startsWith("/sw-login")) {
    e.respondWith(new Response("<html><body>SERVED-BY-SERVICE-WORKER</body></html>", { headers: { "content-type": "text/html" } }));
  }
});`;

function page(body) { return `<!doctype html><html><body>${body}</body></html>`; }

async function startServer() {
  if (server) return;
  const dir = homeTmp("tls-");
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=relay-test"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
  server = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, (req, res) => {
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    const url = new URL(req.url, `https://${req.headers.host}`);
    hits.push({ host, path: url.pathname });
    const P = PORT;
    const send = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "text/html", ...headers }); res.end(body); };
    switch (url.pathname) {
      case "/redirect-to-fb": return send(302, "", { location: `https://m.facebook.com:${P}/` });
      case "/relocate": return send(200, page(`<script>history.replaceState(null, "", "/ads/library/after");</script>RELOCATED-META-PAGE`));
      case "/popups": return send(200, page(`<a id="blank" target="_blank" href="https://www.instagram.com:${P}/p/x/">ig</a>`));
      case "/embeds": return send(200, page(`<img src="https://www.facebook.com:${P}/tr?ev=PageView"><iframe src="https://www.instagram.com:${P}/p/x/embed"></iframe>`));
      case "/sw.js": return send(200, SW_JS, { "content-type": "text/javascript", "service-worker-allowed": "/" });
      case "/ads/library/sw-setup": return send(200, page(`<script>navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready).then(() => { document.title = "SW-READY"; });</script>`));
      default: return send(200, page(`OK ${host}${url.pathname}`));
    }
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  PORT = server.address().port;
}

test.after(() => { if (server) server.close(); });

const U = (host, p = "/") => `https://${host}:${PORT}${p}`;

async function launch(prefix) {
  const dir = homeTmp(prefix);
  const h = await launchBrave({ userDataDir: dir, headless: true, executablePath: BRAVE });
  return { dir, h };
}

function mainBravePid(dir) {
  return pool.findBraveMainPid(dir);
}

function cmdline(pid) {
  return spawnSync("ps", ["-p", String(pid), "-o", "command=", "-ww"], { encoding: "utf8" }).stdout;
}

async function cdpTargets(wsEndpoint) {
  const conn = await CdpConnection.open(wsEndpoint);
  try { return (await conn.send("Target.getTargets")).targetInfos; } finally { conn.close(); }
}

// ── §1b: port 0 + identity ──────────────────────────────────────────────

test("T-port: DevToolsActivePort appears, matches /json/version, and the launch carries =0 + the mock keychain + the host map", ISO, async () => {
  const { dir, h } = await launch("tport-");
  try {
    const file = id.readDevToolsActivePort(dir);
    assert.ok(file, "file written by Brave");
    assert.strictEqual(h.port, file.port);
    assert.notStrictEqual(h.port, 0);
    const v = await (await fetch(`http://127.0.0.1:${h.port}/json/version`)).json();
    assert.strictEqual(new URL(v.webSocketDebuggerUrl).pathname, file.browserPath);
    assert.strictEqual(h.wsEndpoint, `ws://127.0.0.1:${h.port}${file.browserPath}`);
    const pid = mainBravePid(dir);
    const cmd = cmdline(pid);
    assert.match(cmd, /--remote-debugging-port=0(\s|$)/);
    assert.match(cmd, /--use-mock-keychain/, "the test hook keeps the mock keychain");
    assert.match(cmd, /--host-resolver-rules=MAP \* 127\.0\.0\.1/);
    assert.doesNotMatch(cmd, /--remote-debugging-address/);
  } finally {
    await closeBrave(h);
  }
});

test("the profile flock is not inherited by a real launched Brave", ISO, async () => {
  const dir = homeTmp("flock-inherit-");
  const claim = lock.claimDir(dir);
  const h = await launchBrave({ userDataDir: dir, headless: true, executablePath: BRAVE });
  try {
    const pid = mainBravePid(dir);
    const open = spawnSync("lsof", ["-p", String(pid), "-Fn"], { encoding: "utf8" }).stdout;
    assert.ok(!open.includes(lock.FLOCK_NAME), "Brave must not have the flock file open");
    claim.release(); // our fd closed while Brave keeps running…
    const probe = nodeChild(`const l=require(${JSON.stringify(path.join(REPO, "src", "profile-lock.js"))});console.log(l.openFlock(${JSON.stringify(dir)})?"HELD":"EAGAIN")`);
    assert.match(await probe.waitLine(/HELD|EAGAIN/), /HELD/, "…so another process can take it: Brave held nothing");
    await probe.exited;
  } finally {
    claim.release();
    await closeBrave(h);
  }
});

test("F9: two Braves get two ports, and each endpoint reaches ONLY its own browser", ISO, async () => {
  const a = await launch("two-a-");
  const b = await launch("two-b-");
  try {
    assert.notStrictEqual(a.h.port, b.h.port);
    const pa = await a.h.context.newPage();
    await pa.goto("data:text/html,MARKER-A");
    const ta = await cdpTargets(a.h.wsEndpoint);
    const tb = await cdpTargets(b.h.wsEndpoint);
    assert.ok(ta.some((t) => t.url === "data:text/html,MARKER-A"), "A's endpoint reaches A");
    assert.ok(!tb.some((t) => t.url === "data:text/html,MARKER-A"), "B's endpoint does not reach A");
  } finally {
    await closeBrave(a.h);
    await closeBrave(b.h);
  }
});

test("attach-first: a live port-0 Brave on our dir is found by its file + uuid and attached, tabs intact", ISO, async () => {
  const { dir, h } = await launch("attach0-");
  let att;
  try {
    const p = await h.context.newPage();
    await p.goto("data:text/html,KEEP-ME");
    const found = await pool.findAttachableBrave(dir);
    assert.ok(found);
    assert.strictEqual(found.legacy, false);
    assert.strictEqual(found.wsEndpoint, h.wsEndpoint);
    assert.strictEqual(found.pid, mainBravePid(dir));
    att = await attachBrave({ wsEndpoint: found.wsEndpoint, port: found.port });
    assert.ok(att.context.pages().some((pg) => pg.url() === "data:text/html,KEEP-ME"));
  } finally {
    if (att) await closeBrave(att);
    await closeBrave(h);
  }
});

test("attach-first: a legacy fixed-port Brave (pre-change relay) is attached via lsof@127.0.0.1 + its /json/version ws", ISO, async () => {
  const { chromium } = require("playwright-core");
  const dir = homeTmp("attach-legacy-");
  const port = await new Promise((r) => { const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  // Launched the way a PRE-CHANGE relay did (fixed port), but by this test with
  // Playwright's defaults — the mock keychain stays on.
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true, executablePath: BRAVE, handleSIGINT: false, handleSIGTERM: false,
    args: [`--remote-debugging-port=${port}`, ...require("../src/cdp-bridge.js").TEST_LAUNCH_ARGS],
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const found = await pool.findAttachableBrave(dir);
    assert.ok(found, "legacy Brave must be attachable");
    assert.strictEqual(found.legacy, true);
    assert.strictEqual(found.port, port);
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    assert.strictEqual(found.wsEndpoint, `ws://127.0.0.1:${port}${new URL(v.webSocketDebuggerUrl).pathname}`);
  } finally {
    await ctx.close();
  }
});

// ── §1d: the Meta guard on a real browser ───────────────────────────────

async function guarded(prefix) {
  await startServer();
  const { dir, h } = await launch(prefix);
  const blocked = [];
  const g = await guard.installMetaGuard({ wsEndpoint: h.wsEndpoint, onBlocked: (host) => blocked.push(host) });
  guard.installWatchdog(h.context, { recentlyBlocked: g.recentlyBlocked, onBlocked: (host) => blocked.push(`watchdog:${host}`) });
  return { dir, h, g, blocked };
}

async function isGuardPage(p) {
  return /Blocked by browser-mcp-relay/.test(await p.title().catch(() => "")) ||
    (await p.evaluate(() => document.documentElement.getAttribute("data-relay-meta-guard")).catch(() => null)) === "1";
}

test("Meta guard (Fetch layer): direct, script, popup, _blank, redirect and second-CDP-client navigations all get the 403 page; the Meta hosts receive ZERO requests", ISO, async () => {
  const { h, g, blocked } = await guarded("guard-");
  try {
    const metaHosts = ["www.facebook.com", "www.instagram.com", "m.facebook.com", "business.facebook.com", "threads.net", "web.whatsapp.com"];
    const before = metaHosts.map((x) => hostHits(x).length);
    // 0. a page that ALREADY existed when the guard was installed (an
    //    attach-first Brave's open tabs)
    const pre = h.context.pages()[0];
    assert.ok(pre, "precondition: a pre-existing page");
    await pre.goto(U("www.instagram.com", "/already-open")).catch(() => {});
    assert.ok(await isGuardPage(pre), `pre-existing page: ${pre.url()}`);

    const p = await h.context.newPage();

    // a. direct navigation (forwarded navigation_go-to / human typing)
    const resp = await p.goto(U("www.facebook.com", "/login"));
    assert.strictEqual(resp.status(), 403);
    assert.ok(await isGuardPage(p), "the guard's own 403 page, not a TLS error");

    // b. script navigation (upstream `execute` → location.href)
    await p.goto(U("allowed.test", "/start"));
    await Promise.all([p.waitForNavigation(), p.evaluate((u) => { location.href = u; }, U("threads.net", "/@x"))]);
    assert.ok(await isGuardPage(p));

    // c. window.open popup
    await p.goto(U("allowed.test", "/popups"));
    const [pop1] = await Promise.all([h.context.waitForEvent("page"), p.evaluate((u) => window.open(u), U("web.whatsapp.com"))]);
    await pop1.waitForLoadState();
    assert.ok(await isGuardPage(pop1), `window.open popup: ${pop1.url()}`);

    // d. target=_blank link click
    const [pop2] = await Promise.all([h.context.waitForEvent("page"), p.click("#blank")]);
    await pop2.waitForLoadState();
    assert.ok(await isGuardPage(pop2), `_blank popup: ${pop2.url()}`);

    // e. 302 from an allowed URL
    const r302 = await p.goto(U("allowed.test", "/redirect-to-fb"));
    assert.strictEqual(r302.status(), 403);
    assert.ok(hostHits("allowed.test").some((x) => x.path === "/redirect-to-fb"), "the allowed hop itself was served");

    // f. a second raw CDP client the relay does not mediate (stands in for a human)
    await p.goto(U("allowed.test", "/start"));
    const conn = await CdpConnection.open(h.wsEndpoint);
    const targetId = (await conn.send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && t.url.includes("allowed.test")).targetId;
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    await conn.send("Page.enable", {}, sessionId);
    await conn.send("Page.navigate", { url: U("business.facebook.com", "/") }, sessionId);
    await new Promise((r) => setTimeout(r, 800));
    conn.close();
    await p.waitForLoadState();
    assert.ok(await isGuardPage(p), `second CDP client: ${p.url()}`);

    const after = metaHosts.map((x) => hostHits(x).length);
    assert.deepStrictEqual(after, before, `Meta hosts must receive no requests: ${JSON.stringify(hits.slice(-10))}`);
    assert.ok(g.stats.blocked >= 7, `blocked ${g.stats.blocked}`);
    assert.ok(blocked.length >= 7);
    assert.ok(!blocked.some((b) => b.startsWith("watchdog:")), "the watchdog must not fire on the guard's own 403 pages");
  } finally {
    g.close();
    await closeBrave(h);
  }
});

test("Meta guard negatives: the Ad Library loads; a pixel /tr beacon and an Instagram embed iframe still load", ISO, async () => {
  const { h, g } = await guarded("guard-neg-");
  try {
    const p = await h.context.newPage();
    const r = await p.goto(U("www.facebook.com", "/ads/library/?q=test"));
    assert.strictEqual(r.status(), 200);
    assert.match(await p.content(), /OK www\.facebook\.com\/ads\/library/);
    const n = hits.length;
    await p.goto(U("allowed.test", "/embeds"));
    await p.waitForTimeout(800);
    const fresh = hits.slice(n);
    assert.ok(fresh.some((x) => x.host === "www.facebook.com" && x.path === "/tr"), "pixel beacon must load");
    assert.ok(fresh.some((x) => x.host === "www.instagram.com" && x.path === "/p/x/embed"), "IG embed iframe must load");
  } finally {
    g.close();
    await closeBrave(h);
  }
});

test("Meta guard watchdog (layer 3): a Meta main frame that got past Fetch is sent to about:blank and reported", ISO, async () => {
  await startServer();
  const { h } = await launch("watchdog-");
  const reported = [];
  try {
    guard.installWatchdog(h.context, { onBlocked: (host) => reported.push(host) }); // no Fetch layer here
    const p = await h.context.newPage();
    await p.goto(U("www.instagram.com", "/"));
    await p.waitForURL("about:blank", { timeout: 5000 });
    assert.deepStrictEqual(reported, ["www.instagram.com"]);
  } finally {
    await closeBrave(h);
  }
});

test("Meta guard: a service-worker-served Meta navigation never shows Meta content (Fetch or the watchdog catches it)", ISO, async () => {
  // Chromium refuses to register a service worker on an origin with a
  // certificate error, and ignoreHTTPSErrors does not change that — so this
  // ONE test Brave is launched directly with --ignore-certificate-errors
  // (mock keychain still on, hosts still mapped to 127.0.0.1).
  await startServer();
  const { chromium } = require("playwright-core");
  const dir = homeTmp("guard-sw-");
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true, executablePath: BRAVE, handleSIGINT: false, handleSIGTERM: false,
    args: ["--remote-debugging-port=0", "--ignore-certificate-errors", ...require("../src/cdp-bridge.js").TEST_LAUNCH_ARGS],
  });
  let g;
  try {
    const file = await id.waitForDevToolsActivePort(dir);
    const ws = await id.verifyPortIdentity(file.port, file.browserPath);
    const blocked = [];
    const p = await ctx.newPage();
    await p.goto(U("www.facebook.com", "/ads/library/sw-setup")); // allowed path registers a root-scope SW
    await p.waitForFunction(() => document.title === "SW-READY", null, { timeout: 10000 });
    g = await guard.installMetaGuard({ wsEndpoint: ws, onBlocked: (host) => blocked.push(host) });
    guard.installWatchdog(ctx, { recentlyBlocked: g.recentlyBlocked, onBlocked: (host) => blocked.push(`watchdog:${host}`) });
    const n = hits.length;
    await p.goto(U("www.facebook.com", "/sw-login")).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const body = await p.content().catch(() => "");
    assert.doesNotMatch(body, /SERVED-BY-SERVICE-WORKER/, `SW content must not stay on screen (url ${p.url()})`);
    assert.ok(!hits.slice(n).some((x) => x.path === "/sw-login"), "and the network never saw it");
    const via = blocked.some((b) => b.startsWith("watchdog:")) ? "watchdog" : (g.stats.blocked > 0 ? "fetch" : "none");
    assert.notStrictEqual(via, "none");
    process.stderr.write(`[isolated-brave] service-worker navigation stopped by: ${via}\n`);
  } finally {
    if (g) g.close();
    await ctx.close();
  }
});

test("Meta guard: a URL the Fetch layer just blocked, then served by a service worker, is still evicted (Phase 1 review: no 30 s watchdog skip)", ISO, async () => {
  await startServer();
  const { chromium } = require("playwright-core");
  const dir = homeTmp("guard-sw2-");
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true, executablePath: BRAVE, handleSIGINT: false, handleSIGTERM: false,
    args: ["--remote-debugging-port=0", "--ignore-certificate-errors", ...require("../src/cdp-bridge.js").TEST_LAUNCH_ARGS],
  });
  let g;
  try {
    const file = await id.waitForDevToolsActivePort(dir);
    const ws = await id.verifyPortIdentity(file.port, file.browserPath);
    const blocked = [];
    g = await guard.installMetaGuard({ wsEndpoint: ws, onBlocked: (host) => blocked.push(host) });
    guard.installWatchdog(ctx, { recentlyBlocked: g.recentlyBlocked, onBlocked: (host) => blocked.push(`watchdog:${host}`) });
    const p = await ctx.newPage();
    await p.goto(U("www.facebook.com", "/sw-login")).catch(() => {});   // 1. the Fetch layer blocks it
    await new Promise((r) => setTimeout(r, 800));
    assert.ok(await isGuardPage(p), `the guard's own 403 page stays (url ${p.url()})`);
    assert.strictEqual(g.recentlyBlocked(U("www.facebook.com", "/sw-login")), false, "its 403 page consumed the block's one token");
    await p.goto(U("www.facebook.com", "/ads/library/sw-setup"));       // 2. an allowed page registers a SW
    await p.waitForFunction(() => document.title === "SW-READY", null, { timeout: 10000 });
    await p.goto(U("www.facebook.com", "/sw-login")).catch(() => {});   // 3. same URL, within seconds, from the SW
    await new Promise((r) => setTimeout(r, 2500));
    const body = await p.content().catch(() => "");
    assert.doesNotMatch(body, /SERVED-BY-SERVICE-WORKER/, `SW content must not stay on screen (url ${p.url()})`);
  } finally {
    if (g) g.close();
    await ctx.close();
  }
});

test("Meta guard watchdog: a Meta page holding a token but not the guard's marker is still evicted (the poll's own deadline)", ISO, async () => {
  await startServer();
  const { h } = await launch("watchdog-token-");
  const reported = [];
  try {
    guard.installWatchdog(h.context, { recentlyBlocked: () => true, onBlocked: (host) => reported.push(host) }); // a leftover token, always
    const p = await h.context.newPage();
    await p.goto(U("www.instagram.com", "/"));
    await p.waitForURL("about:blank", { timeout: 6000 });
    assert.deepStrictEqual(reported, ["www.instagram.com"]);
  } finally {
    await closeBrave(h);
  }
});

test("Meta guard watchdog: a page that replaceStates itself to an allowed path while being checked is still evicted (re-review)", ISO, async () => {
  await startServer();
  const { h } = await launch("watchdog-relocate-");
  const reported = [];
  try {
    guard.installWatchdog(h.context, { recentlyBlocked: () => true, onBlocked: (host) => reported.push(host) });
    const p = await h.context.newPage();
    await p.goto(U("www.facebook.com", "/relocate"));
    await p.waitForURL("about:blank", { timeout: 6000 });
    assert.doesNotMatch(await p.content(), /RELOCATED-META-PAGE/);
  } finally {
    await closeBrave(h);
  }
});

test("Meta guard: the 403 page for a URL with a #fragment stays (tokens are keyed without it)", ISO, async () => {
  await startServer();
  const { h } = await launch("guard-frag-");
  let g;
  try {
    g = await guard.installMetaGuard({ wsEndpoint: h.wsEndpoint });
    guard.installWatchdog(h.context, { recentlyBlocked: g.recentlyBlocked, onBlocked: () => {} });
    const p = await h.context.newPage();
    await p.goto(U("www.facebook.com", "/frag#section")).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    assert.ok(await isGuardPage(p), `still the guard's page after the poll's deadline (url ${p.url()})`);
  } finally {
    if (g) g.close();
    await closeBrave(h);
  }
});

test("Meta guard: the agent's NEXT allowed page right after a block is never evicted (re-review 2: 15/15 were)", ISO, async () => {
  await startServer();
  const { h } = await launch("guard-next-");
  let g;
  const reported = [];
  try {
    g = await guard.installMetaGuard({ wsEndpoint: h.wsEndpoint });
    guard.installWatchdog(h.context, { recentlyBlocked: g.recentlyBlocked, onBlocked: (host) => reported.push(host) });
    const p = await h.context.newPage();
    for (let i = 0; i < 5; i++) {
      // a. a blocked goto, then the usual immediate retry somewhere allowed
      await p.goto(U("www.facebook.com", `/login-${i}`)).catch(() => {});
      await p.goto(U("allowed.test", `/after-${i}`));
      // b. an allowed page that 302s to a blocked one, then an allowed goto
      await p.goto(U("allowed.test", "/redirect-to-fb")).catch(() => {});
      await p.goto(U("allowed.test", `/after-302-${i}`));
      await new Promise((r) => setTimeout(r, 2600));                     // past the poll's deadline
      assert.strictEqual(p.url(), U("allowed.test", `/after-302-${i}`), `round ${i}: the allowed page stayed`);
    }
    // c. back/forward through a 403 page: A -> blocked -> B -> back (403) -> back to A
    await p.goto(U("allowed.test", "/A"));
    await p.goto(U("www.instagram.com", "/bf")).catch(() => {});
    await p.goto(U("allowed.test", "/B"));
    await p.goBack().catch(() => {});
    await p.goBack().catch(() => {});
    await new Promise((r) => setTimeout(r, 2600));
    assert.strictEqual(p.url(), U("allowed.test", "/A"), "back to A stays on A");
    assert.deepStrictEqual(reported, [], "the watchdog evicted nothing");
  } finally {
    if (g) g.close();
    await closeBrave(h);
  }
});

test("Meta guard: if the guard's CDP session dies while a new target waits for it, the target resumes (no hang)", ISO, async () => {
  await startServer();
  const { h } = await launch("guard-death-");
  let release;
  const stuck = new Promise((r) => { release = r; });
  let gref;
  try {
    gref = await guard.installMetaGuard({
      wsEndpoint: h.wsEndpoint,
      _beforeResume: async (t) => { if (t.type === "page" && t.url !== "about:blank" || t.type === "page") await stuck; },
    });
    const p = h.context.pages()[0] || await h.context.newPage();
    const n = hits.length;
    const popupP = h.context.waitForEvent("page");
    await p.evaluate((u) => { window.open(u); }, U("allowed.test", "/after-guard-death"));
    const popup = await popupP;
    await new Promise((r) => setTimeout(r, 500)); // the popup is held by our session
    gref._conn.terminate(); // the guard's session dies
    await popup.waitForLoadState("load", { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(hits.slice(n).some((x) => x.path === "/after-guard-death"), "the held popup resumed and loaded");
  } finally {
    release();
    await closeBrave(h);
  }
});
