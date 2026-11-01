// isolated-plainflags.test.js — spec v8 §5.6 (phase 1c) against a REAL test
// Brave and the REAL relay. Runs only under scripts/test-harness.js (temp HOME,
// real-state snapshot). Every Brave is launched through the
// BROWSER_RELAY_TEST_LAUNCH hook (headless, mock keychain kept,
// --host-resolver-rules="MAP * 127.0.0.1"), so every host below resolves to the
// local HTTP server — nothing reaches a real site. Plain HTTP on purpose: the
// plain-flags mode refuses insecure TLS, so a self-signed HTTPS server cannot
// be used here. The server logs every request's Host: "no request reached the
// login host" is asserted from that log.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { isolated, SKIP_MSG, homeTmp, REPO } = require("./helpers/isolation.js");
const { startRelay } = require("./helpers/mcp.js");

let BRAVE = null;
try { BRAVE = require("../src/detect-browser.js").detectBravePath(); } catch { /* skip */ }
const ISO = {
  skip: !isolated() ? SKIP_MSG : (!BRAVE ? "no Brave installed" : (process.platform !== "darwin" ? "darwin" : false)),
  timeout: 180000,
};
if (isolated()) {
  process.env.BROWSER_RELAY_TEST_LAUNCH = "1";
  delete process.env.BROWSER_RELAY_INSECURE_TLS;
}

const https = require("node:https");
const { launchBrave, closeBrave, _cdpCall } = require("../src/cdp-bridge.js");
const pool = require("../src/pool-shared.js");
const { createSigninLoader } = require("../src/plainflags-signin.js");
const { createSigninPolicy, installSigninGuard, installSigninWatchdog } = require("../src/plainflags-signin-guard.js");
const { installMetaGuard } = require("../src/meta-guard.js");
const { createClickCounter } = require("../src/challenge-clicks.js");
const challengeClick = require("../src/own-tools/challenge-click.js");
const cfCookiesClear = require("../src/own-tools/cf-cookies-clear.js");
const { setActivePage, clearActivePage } = require("../src/own-tools/_active-page.js");
const pfMode = require("../src/plainflags-mode.js");

const PASSWORD = "Fixture-Pa55word-Zq9";

// ── local HTTP server standing in for every host ────────────────────────────

let server = null;
let PORT = 0;
const hits = [];
const hostHits = (host) => hits.filter((h) => h.host === host).length;
const TOKEN_LISTENER = `<script>addEventListener("message",(e)=>{if(e.data==="fixture-token")document.querySelector('input[name="cf-turnstile-response"]').value="T".repeat(752);});</script>`;
const pageHtml = (body, head = "") => `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">${head}</head><body>${body}</body></html>`;

const SW_JS = `self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode === "navigate" && new URL(e.request.url).pathname.startsWith("/sw-login")) {
    e.respondWith(new Response("<html><body>SERVED-BY-SERVICE-WORKER</body></html>", { headers: { "content-type": "text/html" } }));
  }
});`;

async function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    const url = new URL(req.url, `http://${req.headers.host}`);
    hits.push({ host, path: url.pathname, method: req.method });
    const P = PORT;
    const send = (code, body, headers = {}) => { res.writeHead(code, { "content-type": "text/html", ...headers }); res.end(body); };
    switch (url.pathname) {
      case "/links": return send(200, pageHtml(
        `<a id="login" href="http://login.fixturebank.test:${P}/signin">bank</a>` +
        `<a id="redir" href="/redirect-login">redir</a>` +
        `<a id="fb" href="http://www.facebook.com:${P}/">fb</a>` +
        `<button id="pop" onclick="window.open('http://login.fixturebank.test:${P}/popup')">pop</button>`));
      case "/redirect-login": return send(302, "", { location: `http://login.fixturebank.test:${P}/redirected` });
      case "/form": return send(200, pageHtml(
        `<input id="first" name="first"><input id="pw" type="password"><input id="shown" type="text" autocomplete="current-password">` +
        `<input id="otp" autocomplete="one-time-code">` +
        `<label for="pw" id="lblfor">Password</label><label id="wrap"><span id="wrapspan">Pass</span><input type="password" id="pw2"></label>` +
        `<label id="outer">x<label id="inner"><span id="deep">y</span><input type="password" id="pw3"></label></label>` +
        `<label for="first" id="lblfirst">First</label><input type="password" id="pwv">` +
        `<input type="text" id="pin" name="user_pwd"><input type="text" id="masked" style="-webkit-text-security:disc">` +
        `<button id="post" onclick="fetch('/session',{method:'POST',body:'email=zz@example.invalid&password=${PASSWORD}'})">post</button>` +
        `<iframe id="fr" src="http://frame.fixture.test:${P}/inner"></iframe>`));
      case "/inner": return send(200, pageHtml(`<input id="ipw" type="password">`));
      // round 3 lock fixtures
      case "/signin-fixture": return send(200, pageHtml(`<h1>SIGNIN-FIXTURE</h1><input id="user" name="email"><input type="password" id="pw"><button id="go">go</button><script>console.log("console-line")</script>`));
      case "/spa-signin": return send(200, pageHtml(`<form id="f"><input type="password" id="spw"><button id="sub" type="submit">sign in</button></form><div id="msg"></div><script>document.getElementById("f").addEventListener("submit",(e)=>{e.preventDefault();document.getElementById("msg").textContent="SPA-SUBMITTED";});</script>`));
      case "/xo-parent": return send(200, pageHtml(`<h1>XO-PARENT</h1><iframe id="xo" src="http://www.fixturexo.test:${P}/xo-child" width="400" height="200"></iframe>`));
      case "/xo-child": return send(200, pageHtml(`<input type="password" id="xpw">`));
      // round 4 fixtures
      case "/m4-top": return send(200, pageHtml(
        `<input type="password" id="pw"><iframe id="kid" src="http://www.fixturespy.test:${P}/m4-child" width="300" height="80"></iframe>`,
        `<script>const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");Object.defineProperty(HTMLInputElement.prototype,"value",{get(){return ""},set(v){d.set.call(this,v)},configurable:true});</script>`));
      case "/m4-child": return send(200, pageHtml(`<input type="text" name="note">`,
        `<script>window.__qsa=0;for(const P of [Document.prototype,Element.prototype,DocumentFragment.prototype]){const o=P.querySelectorAll;P.querySelectorAll=function(...a){window.__qsa++;return o.apply(this,a);};}</script>`));
      case "/m1-falsepos": return send(200, pageHtml(
        `<form><input type="checkbox" name="remember_password" checked><input type="radio" name="otp_method" value="sms" checked>` +
        `<input type="hidden" name="passengers" value="2"><input type="submit" id="password-submit" value="Sign in">` +
        `<input type="text" name="first" value="Zed"></form>`));
      case "/l6-otp": return send(200, pageHtml(`<div id="otp">${Array.from({ length: 6 }, (_, i) => `<input id="d${i}" maxlength="1" inputmode="numeric">`).join("")}</div>`));
      // round 5 fixtures: a cross-site pair, each with a same-origin iframe; a show-password toggle; a 2FA field
      case "/xs-a": return send(200, pageHtml(`<h1>SITE-A</h1>`));
      case "/swap-top": return send(200, pageHtml(`<h1>SWAP-TOP</h1><iframe id="f" src="${url.searchParams.get("src") || "about:blank"}" width="400" height="120"></iframe>`));
      case "/swap-pw": return send(200, pageHtml(`<input type="password" id="pw">`));
      case "/swap-plain": return send(200, pageHtml(`<h1>PLAIN</h1>`));
      case "/xs-b": return send(200, pageHtml(`<input type="password" id="pw">${"<iframe src=\"/xs-frame\"></iframe>".repeat(Math.max(1, Number(url.searchParams.get("n")) || 1))}`));
      case "/xs-frame": return send(200, pageHtml(`<p>FRAME</p>`));
      // round 6: the reviewer's hostile child — forges any stamp it can read off its caller, poisons the probe's globals, counts calls
      case "/hostile-b": return send(200, pageHtml(`<input type="password" id="pw"><iframe src="/f"></iframe>`));
      case "/f": return send(200, `<!doctype html><html><head><script>
        window.__touched = 0;
        Object.defineProperty(window, "__relayLockStamp", { configurable: true, get: function g() {
          window.__touched++;
          try { const src = String(g.caller); const m = /!== ("[^"]*")/.exec(src); if (m) return JSON.parse(m[1]); } catch (e) {}
          return undefined; } });
        window.__relayLockSeen = { has: () => { window.__touched++; return false; }, add: () => {} };
        for (const P of [Document.prototype, Element.prototype, DocumentFragment.prototype]) { const o = P.querySelectorAll; P.querySelectorAll = function (...a) { window.__touched++; return o.apply(this, a); }; }
        </script></head><body><input type="text" name="decoy"></body></html>`);
      case "/toggle": return send(200, pageHtml(`<input type="password" id="tpw"><button id="eye" onclick="const i=document.getElementById('tpw');i.type=i.type==='password'?'text':'password'">eye</button>`));
      case "/two-fa": return send(200, pageHtml(`<input type="text" name="twoFactorCode" inputmode="numeric" maxlength="6" id="code">`));
      case "/busy-frame": return send(200, pageHtml(`<script>setTimeout(()=>{for(;;){}},300)</script>`));
      case "/m3-a": return send(200, pageHtml(`<h1>TAB-A</h1><iframe src="http://www.fixturebusy.test:${P}/busy-frame"></iframe>`));
      case "/m3-b": return send(200, pageHtml(`<input type="password" id="bpw">`));
      case "/chl-busy-page": return send(200, pageHtml(`<input type="password" id="pw"><iframe src="https://challenges.cloudflare.com:${TLS_PORT}/busy-frame" width="300" height="65"></iframe>`));
      case "/login-form": return send(200, pageHtml(`<form method="post" action="/session"><input name="email" id="email" autocomplete="username"><input type="password" name="pw" id="lpw"><button id="go">go</button></form>`));
      case "/session": return send(200, pageHtml("SESSION-OK"));
      // A77 (the default relay's lock)
      case "/a77-nolock": return send(200, pageHtml(`<h1>A77-NOLOCK</h1><input type="password" id="pw"><input type="checkbox" name="password" id="cb" checked><input type="text" name="first" value="Zed">`));
      case "/a77-shadow": return send(200, pageHtml(`<div id="h"></div><script>const r=document.getElementById("h").attachShadow({mode:"open"});r.innerHTML='<div id="h2"></div>';r.getElementById("h2").attachShadow({mode:"open"}).innerHTML='<input type="password" id="spw">';</script>`));
      // fix rounds 1–2: a settings page's saved password + a pre-filled passenger name, a React-style attribute mirror, a script-set value,
      // the reviewer's show-password names (round 2 F1), a dialog beside an empty password field (round 2 F3)
      case "/a77-names": return send(200, pageHtml(`<input type="text" name="password1" id="n1"><input type="text" id="passwordconfirm"><input type="text" name="passenger_name" id="n3"><input type="text" name="loginByPassword" id="n4"><input type="text" id="comPassword">`));
      case "/a77-dialog": return send(200, pageHtml(`<input type="password" id="pw"><button id="two" onclick="setTimeout(()=>{alert('A77-ONE');alert('A77-TWO');},0)">two</button>`));
      case "/a77-settings": return send(200, pageHtml(`<h1>A77-SETTINGS</h1><input type="password" name="current" id="cur" value="Saved-Pw-Server-1"><input type="text" name="passenger_name" id="pn" value="Zed Fixture">`));
      case "/a77-mirror": return send(200, pageHtml(`<input type="password" id="mpw"><script>const m=document.getElementById("mpw");m.addEventListener("input",()=>m.setAttribute("value",m.value));</script>`));
      case "/a77-scriptset": return send(200, pageHtml(`<input type="password" id="spw2"><script>document.getElementById("spw2").value="Script-Set-Pw-9";</script>`));
      case "/a77-busy": return send(200, pageHtml(`<input type="password" id="pw">${Array.from({ length: Number(url.searchParams.get("n")) || 3 }, (_, i) => `<iframe src="http://www.fixturebusy${i}.test:${P}/busy-frame"></iframe>`).join("")}`));
      case "/a77-xo5": return send(200, pageHtml(`<input type="password" id="pw">${Array.from({ length: 5 }, (_, i) => `<iframe src="http://www.fixturexo${i}.test:${P}/xs-frame"></iframe>`).join("")}`));
      case "/api/modal-login": return send(200, "{}", { "content-type": "application/json", "set-cookie": "FDSESS=abc123; Path=/; HttpOnly" });
      case "/sw.js": return send(200, SW_JS, { "content-type": "text/javascript", "service-worker-allowed": "/" });
      case "/sw-setup": return send(200, pageHtml(`<script>navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready).then(() => { document.title = "SW-READY"; });</script>`));
      case "/chl-page": return send(200, pageHtml(`<div style="height:2200px">spacer</div><iframe id="form" src="https://www.fixtureform.test:${TLS_PORT}/form-frame" width="600" height="400" style="border:0"></iframe>`, `<script>window.__topDown=0;addEventListener("mousedown",()=>window.__topDown++);</script>`));
      case "/chl-page-shadow": return send(200, pageHtml(`<div style="height:1600px">spacer</div><iframe id="form" src="https://www.fixtureform.test:${TLS_PORT}/form-frame-shadow" width="600" height="400" style="border:0"></iframe>`));
      case "/no-widget": return send(200, pageHtml(`<p>nothing here</p>`, `<script>window.__topDown=0;addEventListener("mousedown",()=>window.__topDown++);</script>`));
      case "/form-frame": return send(200, pageHtml(`<input name="cf-turnstile-response" value=""><div style="height:120px"></div><iframe src="https://challenges.cloudflare.com:${TLS_PORT}/widget" width="300" height="65" style="border:0"></iframe>`, TOKEN_LISTENER));
      case "/form-frame-compact": return send(200, pageHtml(`<input name="cf-turnstile-response" value=""><iframe src="https://challenges.cloudflare.com:${TLS_PORT}/widget" width="150" height="140" style="border:0"></iframe>`, TOKEN_LISTENER));
      case "/chl-page-compact": return send(200, pageHtml(`<iframe id="form" src="https://www.fixtureform.test:${TLS_PORT}/form-frame-compact" width="400" height="300" style="border:0"></iframe>`));
      case "/form-frame-shadow": return send(200, pageHtml(`<div id="h"></div><script>const r=document.getElementById("h").attachShadow({mode:"closed"});r.innerHTML='<div style="height:80px"></div><iframe src="https://challenges.cloudflare.com:${TLS_PORT}/widget" width="300" height="65" style="border:0"></iframe>';</script>`));
      // A trusted click hands a fixture "token" to the parent form (as Turnstile's postMessage does).
      case "/widget": return send(200, `<!doctype html><html><body style="margin:0"><input type="checkbox" id="cb" style="position:absolute;left:18px;top:22px;width:22px;height:22px"><script>window.__clicks=[];addEventListener("click",(e)=>{__clicks.push({t:e.isTrusted,x:e.clientX,y:e.clientY});if(e.isTrusted)parent.postMessage("fixture-token","*");});</script></body></html>`);
      default: return send(200, pageHtml(`OK ${host}${url.pathname}`));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
}
// challenges.cloudflare.com is HSTS-preloaded: http to it is upgraded to https
// before any request, so the challenge_click fixture is served over HTTPS (a
// self-signed cert) — which only a DEFAULT-mode test Brave with
// BROWSER_RELAY_INSECURE_TLS accepts (the plain-flags mode refuses insecure
// TLS by design). The click path (frame tree → owner boxes → one CDP input
// sequence on the top page) does not depend on the launch flags.
let tlsServer = null;
let TLS_PORT = 0;
async function startTlsServer() {
  await startServer();
  if (tlsServer) return;
  const dir = homeTmp("pf-tls-");
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=relay-test"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
  tlsServer = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, (req, res) => server.emit("request", req, res));
  await new Promise((res) => tlsServer.listen(0, "127.0.0.1", res));
  TLS_PORT = tlsServer.address().port;
}
test.after(() => { if (server) server.close(); if (tlsServer) tlsServer.close(); });
const U = (host, p = "/") => `http://${host}:${PORT}${p}`;
const S = (host, p = "/") => `https://${host}:${TLS_PORT}${p}`;

const accountsFixture = () => [
  { name: "fixturebank", loginMatchers: [{ host: "login.fixturebank.test", signInPage: true }], cookieOrigins: [U("login.fixturebank.test").slice(0, -1)], sessionCookies: ["FBSESS"], federating: false, signsInVia: [] },
  { name: "fixturedesign", loginMatchers: [{ host: "www.fixturedesign.test", pathPrefixes: ["/login"] }], cookieOrigins: [U("www.fixturedesign.test").slice(0, -1)], sessionCookies: ["FDSESS"], federating: false, signsInVia: [] },
  { name: "fixturesw", loginMatchers: [{ host: "localhost", pathPrefixes: ["/sw-login"] }], cookieOrigins: [U("localhost").slice(0, -1)], sessionCookies: [], federating: false, signsInVia: [] },
];

function signinFile(dir) {
  const p = path.join(dir, "plainflags-signin.json");
  const write = (names) => {
    fs.writeFileSync(p, JSON.stringify({ accounts: names.map((name) => ({ name, askId: "as-ops/ask-fixture" })) }));
    const t = Date.now() / 1000 + Math.random();
    fs.utimesSync(p, t, t);
  };
  write([]);
  return { p, write };
}

async function launchPf(prefix, mode = "plainflags") {
  const dir = homeTmp(prefix);
  const h = await launchBrave({ userDataDir: dir, headless: true, executablePath: BRAVE, profileMode: mode });
  return { dir, h };
}

async function armGuards(h, listed = []) {
  const sdir = homeTmp("pf-signin-");
  const sf = signinFile(sdir);
  sf.write(listed);
  const loader = createSigninLoader({ path: sf.p, log: () => {} });
  const policy = createSigninPolicy({ accounts: accountsFixture(), loader, verifyAsk: () => ({ ok: true }) });
  const logs = [];
  const blocked = [];
  const guard = await installSigninGuard({ wsEndpoint: h.wsEndpoint, policy, log: (m) => logs.push(m), onBlocked: (host, acct) => blocked.push([host, acct]) });
  installSigninWatchdog(h.context, { policy, recentlyBlocked: (u) => guard.recentlyBlocked(u), onBlocked: (host) => blocked.push([host, "watchdog"]), log: (m) => logs.push(m) });
  return { guard, policy, sf, logs, blocked };
}

const isGuardPage = async (p) => /sign-in guard/.test(await p.title().catch(() => ""));
const cmdline = (pid) => spawnSync("ps", ["-p", String(pid), "-o", "command=", "-ww"], { encoding: "utf8" }).stdout;
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 100)); } };

// ── launch: the flag set, password saving off ───────────────────────────────

test("launch: plain-flags → navigator.webdriver false, no --enable-automation, the blink flag, port 0; default → webdriver true", ISO, async () => {
  await startServer();
  for (const [mode, want] of [["plainflags", false], ["default", true]]) {
    const { dir, h } = await launchPf(`pf-wd-${mode}-`, mode);
    try {
      const page = h.context.pages()[0] || (await h.context.newPage());
      await page.goto(U("probe.fixture.test", "/"));
      assert.strictEqual(await page.evaluate(() => navigator.webdriver), want, mode);
      const cmd = cmdline(pool.findBraveMainPid(dir));
      assert.match(cmd, /--remote-debugging-port=0(\s|$)/);
      if (mode === "plainflags") {
        assert.ok(!/--enable-automation/.test(cmd), "no --enable-automation");
        assert.match(cmd, /--disable-blink-features=AutomationControlled/);
      } else {
        assert.match(cmd, /--enable-automation/);
        assert.ok(!/AutomationControlled/.test(cmd));
      }
    } finally { await closeBrave(h); }
  }
});

test("password saving off: both prefs in Default/Preferences after launch; a submitted login leaves Login Data with 0 rows; a relaunch deletes Login Data* first", ISO, async () => {
  await startServer();
  const { dir, h } = await launchPf("pf-pw-");
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(dir, "Default", "Preferences"), "utf8"));
    assert.strictEqual(prefs.credentials_enable_service, false);
    assert.strictEqual(prefs.profile.password_manager_enabled, false);
    const page = h.context.pages()[0] || (await h.context.newPage());
    await page.goto(U("localhost", "/login-form"));
    await page.fill("#email", "zz@example.invalid");
    await page.fill("#lpw", PASSWORD);
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click("#go")]);
    await page.waitForTimeout(1500);
  } finally { await closeBrave(h); }
  const ld = path.join(dir, "Default", "Login Data");
  if (fs.existsSync(ld)) {
    const copy = path.join(homeTmp("pf-ld-"), "ld.sqlite");
    fs.copyFileSync(ld, copy);
    const r = spawnSync("sqlite3", [copy, "select count(*) from logins;"], { encoding: "utf8" });
    assert.strictEqual(r.stdout.trim(), "0", `logins rows: ${r.stdout} ${r.stderr}`);
  }
  const prefsAfter = JSON.parse(fs.readFileSync(path.join(dir, "Default", "Preferences"), "utf8"));
  assert.strictEqual(prefsAfter.credentials_enable_service, false, "Brave kept the pref (§10 #30)");
  // Relaunch with fixture Login Data* DATABASES in place (valid SQLite, a marker
  // table Brave would keep if it opened them): deleted before Brave starts, so
  // whatever Login Data Brave then creates is new and holds no marker.
  for (const f of ["Login Data", "Login Data For Account"]) {
    const fp = path.join(dir, "Default", f);
    try { fs.rmSync(fp, { force: true }); } catch {}
    const mk = spawnSync("sqlite3", [fp, "create table fixture_marker(x); insert into fixture_marker values('FIXTURE-LOGIN-DATA');"], { encoding: "utf8" });
    assert.strictEqual(mk.status, 0, mk.stderr);
  }
  const h2 = await launchBrave({ userDataDir: dir, headless: true, executablePath: BRAVE, profileMode: "plainflags" });
  try {
    const p2 = h2.context.pages()[0] || (await h2.context.newPage());
    await p2.goto(U("localhost", "/login-form"));
    await p2.waitForTimeout(800);
    const left = fs.readdirSync(path.join(dir, "Default")).filter((n) => n.startsWith("Login Data"));
    for (const n of left) {
      const bytes = fs.readFileSync(path.join(dir, "Default", n));
      assert.ok(!bytes.includes("fixture_marker") && !bytes.includes("FIXTURE-LOGIN-DATA"), `${n} holds the fixture's data`);
    }
  } finally { await closeBrave(h2); }
});

// ── the sign-in guard on a real Brave ───────────────────────────────────────

test("sign-in guard layer 2: a typed URL, a link click, a redirect and a window.open popup to a not-listed login → the 403 route page, ZERO requests to it; host+path matcher; listed → loads", ISO, async () => {
  await startServer();
  const { h } = await launchPf("pf-l2-");
  try {
    const g = await armGuards(h);
    const before = hostHits("login.fixturebank.test");
    const page = h.context.pages()[0] || (await h.context.newPage());
    await page.goto(U("login.fixturebank.test", "/signin")).catch(() => {});
    assert.ok(await isGuardPage(page), "typed URL");
    await page.goto(U("www.fixturepublic.test", "/links"));
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click("#login")]);
    assert.ok(await isGuardPage(page), "link click");
    await page.goto(U("www.fixturepublic.test", "/links"));
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click("#redir")]);
    assert.ok(await isGuardPage(page), "redirect");
    await page.goto(U("www.fixturepublic.test", "/links"));
    const [pop] = await Promise.all([h.context.waitForEvent("page"), page.click("#pop")]);
    await pop.waitForLoadState().catch(() => {});
    assert.ok(await waitFor(() => isGuardPage(pop)), "window.open popup");
    assert.strictEqual(hostHits("login.fixturebank.test") - before, 0, "the login host received no request");
    // host + path matcher
    await page.goto(U("www.fixturedesign.test", "/login")).catch(() => {});
    assert.ok(await isGuardPage(page), "/login refused");
    await page.goto(U("www.fixturedesign.test", "/"));
    assert.match(await page.textContent("body"), /OK www\.fixturedesign\.test\//, "/ loads");
    assert.ok(g.guard.stats.blocked >= 5);
    // listed → loads
    g.sf.write(["fixturebank"]);
    await page.goto(U("login.fixturebank.test", "/signin"));
    assert.match(await page.textContent("body"), /OK login\.fixturebank\.test\/signin/);
    assert.strictEqual(hostHits("login.fixturebank.test") - before, 1);
    g.guard.close();
  } finally { await closeBrave(h); }
});

test("(c) launch clear: a not-listed account's cookies (partitioned too) and localStorage are gone; a listed account's survive", ISO, async () => {
  await startServer();
  const { h } = await launchPf("pf-clear-");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    for (const host of ["www.fixturedesign.test", "localhost"]) {
      await page.goto(U(host, "/"));
      await page.evaluate(() => localStorage.setItem("acct", "x"));
    }
    await _cdpCall(h.wsEndpoint, "Storage.setCookies", { cookies: [
      { name: "FDSESS", value: "v1", domain: "www.fixturedesign.test", path: "/" },
      { name: "pref", value: "v2", domain: ".fixturedesign.test", path: "/" },
      { name: "chips", value: "v3", domain: "www.fixturedesign.test", path: "/", secure: true, sameSite: "None", partitionKey: { topLevelSite: "https://fixturetop.test", hasCrossSiteAncestor: true } },
      { name: "LSESS", value: "v4", domain: "localhost", path: "/" },
      { name: "keep", value: "v5", domain: ".other.test", path: "/" },
    ] });
    const g = await armGuards(h, ["fixturesw"]); // fixturesw (localhost) listed; fixturedesign + fixturebank not
    const out = await g.guard.clearAccounts(g.policy.notListed(), "launch");
    assert.deepStrictEqual(out.filter((o) => o.errors.length).map((o) => o.errors), []);
    const { cookies } = await _cdpCall(h.wsEndpoint, "Storage.getCookies", {});
    const names = cookies.map((c) => c.name).sort();
    assert.ok(!names.includes("FDSESS") && !names.includes("pref") && !names.includes("chips"), names.join());
    assert.ok(names.includes("LSESS") && names.includes("keep"), names.join());
    await page.goto(U("www.fixturedesign.test", "/"));
    assert.strictEqual(await page.evaluate(() => localStorage.getItem("acct")), null, "not-listed storage cleared");
    await page.goto(U("localhost", "/"));
    assert.strictEqual(await page.evaluate(() => localStorage.getItem("acct")), "x", "listed storage survives");
    g.guard.close();
  } finally { await closeBrave(h); }
});

test("(f) on arrival: an in-page XHR on a public page sets a named session cookie of a not-listed account → gone by the next tool call, logged by name; listed → survives", ISO, async () => {
  await startServer();
  const { h } = await launchPf("pf-arrive-");
  try {
    const g = await armGuards(h);
    const page = h.context.pages()[0] || (await h.context.newPage());
    await page.goto(U("www.fixturedesign.test", "/"));
    await page.evaluate(() => fetch("/api/modal-login", { method: "POST" }).then((r) => r.text()));
    await g.guard.sweep(); // what every tool call runs (before and after) — the backstop
    const gone = await waitFor(async () => !(await h.context.cookies()).some((c) => c.name === "FDSESS"));
    assert.ok(gone, "FDSESS deleted");
    assert.ok(g.logs.some((l) => /cleared fixturedesign/.test(l)), g.logs.join("\n"));
    assert.ok(!g.logs.join("\n").includes("abc123"), "never the value");
    g.sf.write(["fixturedesign"]);
    await page.evaluate(() => fetch("/api/modal-login", { method: "POST" }).then((r) => r.text()));
    await g.guard.sweep();
    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await h.context.cookies()).some((c) => c.name === "FDSESS"), "a listed account's session survives");
    g.guard.close();
  } finally { await closeBrave(h); }
});

test("(h) watchdog: a service-worker-served navigation to a not-listed login matcher never stays on its content", ISO, async () => {
  await startServer();
  const { h } = await launchPf("pf-sw-");
  try {
    const g = await armGuards(h, ["fixturesw"]); // listed while the worker is installed
    const page = h.context.pages()[0] || (await h.context.newPage());
    await page.goto(U("localhost", "/sw-setup"));
    await page.waitForFunction(() => document.title === "SW-READY", null, { timeout: 15000 });
    g.sf.write([]); // now not listed
    await page.goto(U("localhost", "/sw-login")).catch(() => {});
    const ok = await waitFor(async () => {
      const u = page.url();
      const t = await page.textContent("body").catch(() => "");
      return u === "about:blank" || (await isGuardPage(page)) || !/SERVED-BY-SERVICE-WORKER/.test(t || "");
    }, 5000);
    assert.ok(ok, `still showing ${page.url()}`);
    g.guard.close();
  } finally { await closeBrave(h); }
});

test("(g) an account taken off the list: its cookies, storage and service worker are gone at once, no relaunch", ISO, async () => {
  await startServer();
  const { h } = await launchPf("pf-remove-");
  try {
    const g = await armGuards(h, ["fixturesw"]);
    const page = h.context.pages()[0] || (await h.context.newPage());
    await page.goto(U("localhost", "/sw-setup"));
    await page.waitForFunction(() => document.title === "SW-READY", null, { timeout: 15000 });
    await page.evaluate(() => { localStorage.setItem("acct", "x"); document.cookie = "LSESS=1; path=/"; });
    assert.strictEqual(g.policy.takeRemoved().length, 0);
    g.sf.write([]);
    const removed = g.policy.takeRemoved(); // what the policy runs at the next tool call
    assert.deepStrictEqual(removed.map((a) => a.name), ["fixturesw"]);
    await g.guard.clearAccounts(removed, "taken off the sign-in list");
    assert.ok(!(await h.context.cookies()).some((c) => c.name === "LSESS"));
    await page.goto(U("localhost", "/"));
    assert.strictEqual(await page.evaluate(() => localStorage.getItem("acct")), null);
    assert.strictEqual(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)), 0, "service worker gone");
    g.guard.close();
  } finally { await closeBrave(h); }
});

test("Meta guard in plain-flags mode, beside the sign-in guard: a link click to facebook.com → the Meta 403 page, stats.blocked++, zero requests", ISO, async () => {
  await startServer();
  const { h } = await launchPf("pf-meta-");
  try {
    const meta = await installMetaGuard({ wsEndpoint: h.wsEndpoint });
    const g = await armGuards(h);
    const page = h.context.pages()[0] || (await h.context.newPage());
    const before = hostHits("www.facebook.com");
    await page.goto(U("www.fixturepublic.test", "/links"));
    await Promise.all([page.waitForNavigation().catch(() => {}), page.click("#fb")]);
    assert.match(await page.title(), /Blocked by browser-mcp-relay/);
    assert.ok(!(await isGuardPage(page)), "the Meta guard's page, not the sign-in guard's");
    assert.strictEqual(meta.stats.blocked, 1);
    assert.strictEqual(hostHits("www.facebook.com") - before, 0);
    meta.close();
    g.guard.close();
  } finally { await closeBrave(h); }
});

// ── challenge_click on a real nested, cross-origin widget ───────────────────

async function clicksIn(page) {
  const f = page.frames().find((x) => x.url().startsWith(`https://challenges.cloudflare.com:${TLS_PORT}/`));
  return f ? f.evaluate(() => window.__clicks) : null;
}

test("challenge_click: page → cross-origin form iframe → challenges.cloudflare.com iframe below the fold, and in a CLOSED shadow root: exactly one click, isTrusted, at the offset; a second refused", ISO, async () => {
  await startTlsServer();
  process.env.BROWSER_RELAY_INSECURE_TLS = "1"; // the self-signed fixture cert; default mode (see startTlsServer)
  let h;
  try { ({ h } = await launchPf("pf-click-", "default")); } finally { delete process.env.BROWSER_RELAY_INSECURE_TLS; }
  const counter = createClickCounter({ root: homeTmp("pf-clicks-root-") });
  challengeClick.configure({ counter });
  try {
    globalThis.__relayBridge = { context: h.context, wsEndpoint: h.wsEndpoint };
    for (const [host, p] of [["www.fixturepublic.test", "/chl-page"], ["www.fixtureshadow.test", "/chl-page-shadow"]]) {
      const page = await h.context.newPage();
      await page.goto(S(host, p));
      await waitFor(async () => (await clicksIn(page)) !== null, 10000);
      clearActivePage();
      setActivePage(page);
      const r = await challengeClick.handler({ lane: "TEST" });
      assert.ok(!r.isError, r.content[0].text);
      const body = JSON.parse(r.content[0].text);
      assert.strictEqual(body.frameDepth, 2);
      // round 1 item 5: the outcome from the token, lengths only
      if (p === "/chl-page") assert.deepStrictEqual([body.passed, body.tokenAfter], [true, [752]], r.content[0].text);
      else assert.strictEqual(body.passed, null, "no readable token input on the shadow fixture");
      const clicks = await waitFor(async () => { const c = await clicksIn(page); return c && c.length > 0 ? c : null; }, 3000);
      assert.ok(clicks, `${p}: the challenge frame saw a click`);
      assert.strictEqual(clicks.length, 1, `${p}: exactly one click`);
      assert.strictEqual(clicks[0].t, true, `${p}: isTrusted (§10 #26)`);
      assert.ok(Math.abs(clicks[0].x - challengeClick.CLICK_OFFSET_X) <= 2 && Math.abs(clicks[0].y - 32.5) <= 2, JSON.stringify(clicks[0]));
      const again = await challengeClick.handler({ lane: "TEST" });
      assert.strictEqual(again.isError, true);
      assert.match(JSON.parse(again.content[0].text).refused, /last 10 min/);
      assert.strictEqual((await clicksIn(page)).length, 1, "the refused call sent nothing");
      await page.close();
    }
    // the compact layout: the measured point (24, 28)
    {
      const page = await h.context.newPage();
      await page.goto(S("www.fixturecompact.test", "/chl-page-compact"));
      await waitFor(async () => (await clicksIn(page)) !== null, 10000);
      clearActivePage();
      setActivePage(page);
      const r = await challengeClick.handler({ lane: "TEST" });
      const body = JSON.parse(r.content[0].text);
      assert.strictEqual(body.layout, "compact", r.content[0].text);
      const clicks = await waitFor(async () => { const c = await clicksIn(page); return c && c.length > 0 ? c : null; }, 3000);
      assert.ok(clicks && clicks.length === 1 && clicks[0].t === true);
      assert.ok(Math.abs(clicks[0].x - 24) <= 1 && Math.abs(clicks[0].y - 28) <= 1, JSON.stringify(clicks[0]));
      assert.strictEqual(body.passed, true);
      await page.close();
    }
    const page = await h.context.newPage();
    await page.goto(S("www.nowidget.test", "/no-widget"));
    clearActivePage();
    setActivePage(page);
    const none = await challengeClick.handler({ lane: "TEST" });
    assert.strictEqual(JSON.parse(none.content[0].text).widget, "absent");
    assert.strictEqual(await page.evaluate(() => window.__topDown), 0, "no input event reached any frame");
    assert.strictEqual(counter.spent("www.nowidget.test"), false);
  } finally { globalThis.__relayBridge = null; clearActivePage(); await closeBrave(h); }
});

// ── cf_cookies_clear: partitioned deletes in Brave (§10 #24) ────────────────

test("cf_cookies_clear (§10 #24): Storage.getCookies returns the partitioned cookies and Network.deleteCookies with the key removes them — the site's and the challenge host's; another site's stay", ISO, async () => {
  await startServer();
  const { h } = await launchPf("pf-cfclear-");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    await page.goto(U("www.fixturesite.test", "/"));
    await _cdpCall(h.wsEndpoint, "Storage.setCookies", { cookies: [
      { name: "cf_clearance", value: "c1", domain: ".fixturesite.test", path: "/", secure: true, sameSite: "None", partitionKey: { topLevelSite: "https://fixturesite.test", hasCrossSiteAncestor: false } },
      { name: "cf_clearance", value: "c2", domain: ".fixturesite.test", path: "/" },
      { name: "session", value: "c3", domain: "www.fixturesite.test", path: "/" },
      { name: "__cf_bm", value: "c4", domain: "challenges.cloudflare.com", path: "/", secure: true, sameSite: "None", partitionKey: { topLevelSite: "https://fixturesite.test", hasCrossSiteAncestor: true } },
      { name: "keep", value: "c5", domain: ".other.test", path: "/" },
    ] });
    const pre = (await _cdpCall(h.wsEndpoint, "Storage.getCookies", {})).cookies;
    assert.ok(pre.some((c) => c.name === "cf_clearance" && c.partitionKey), "the partitioned cookie is read with its key");
    const sdir = homeTmp("pf-cfclear-signin-");
    const sf = signinFile(sdir);
    cfCookiesClear._resetDeps();
    cfCookiesClear.configure({ signin: createSigninLoader({ path: sf.p, log: () => {} }) });
    globalThis.__relayBridge = { context: h.context, wsEndpoint: h.wsEndpoint };
    clearActivePage();
    setActivePage(page);
    const r = await cfCookiesClear.handler({ origin: "https://www.fixturesite.test" });
    assert.ok(!r.isError, r.content[0].text);
    const out = JSON.parse(r.content[0].text);
    assert.strictEqual(out.matched, 4);
    assert.deepStrictEqual(out.remaining, []);
    const left = (await _cdpCall(h.wsEndpoint, "Storage.getCookies", {})).cookies.map((c) => c.name);
    assert.deepStrictEqual(left, ["keep"]);
  } finally { globalThis.__relayBridge = null; clearActivePage(); cfCookiesClear._resetDeps(); await closeBrave(h); }
});

// ── the REAL relay in plain-flags mode (launcher → index → real upstream) ──

const RELAY_ENV = (fixturePath) => ({
  BROWSER_RELAY_TEST_LAUNCH: "1",
  BROWSER_HEADLESS_ENABLE: "true",
  BROWSER_RELAY_BRAVE_PATH: BRAVE,
  TELEMETRY_ENABLE: "false",
  BROWSER_RELAY_PROFILE_MODE: "plainflags",
  BROWSER_RELAY_TEST_PLAINFLAGS_FIXTURE: fixturePath,
});

function writeFixture(home, listed = [], asksDir = null) {
  const dir = homeTmp("pf-fixture-");
  const sf = signinFile(dir);
  sf.write(listed);
  const p = path.join(dir, "fixture.json");
  fs.writeFileSync(p, JSON.stringify({ accounts: accountsFixture(), signinFile: sf.p, asksDir: asksDir || path.join(dir, "no-asks") }));
  return { p, sf };
}

const slugOf = (p) => path.basename(p).replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
const cacheOf = (home) => path.join(home, "Library", "Caches", "browser-mcp-relay");

test("e2e plain-flags relay: its own unseeded folder (registry untouched), the exact tool list, the mode line, layer 1 + fill/press-key limits through the REAL upstream, no body out, Meta guard; a second session clones under session-clones-plainflags without Login Data", ISO, async () => {
  await startServer();
  const home = homeTmp("home-pf-");
  const proj = path.join(home, "proj-pf");
  const cache = cacheOf(home);
  fs.mkdirSync(cache, { recursive: true });
  const reg = path.join(cache, "project-registry.json");
  fs.writeFileSync(reg, JSON.stringify({ [proj]: { slot: 1, slug: slugOf(proj), dir: path.join(cache, "profiles", slugOf(proj)) } }, null, 2));
  const regBytes = fs.readFileSync(reg);
  const fx = writeFixture(home);
  // A vault entry for the fixture login form: in the default relay autofill
  // would fill it; in plain-flags mode no vault is loaded (§5.6 (6)(e)).
  const vaultCsv = path.join(homeTmp("pf-vault-"), "vault.csv");
  fs.writeFileSync(vaultCsv, `name,url,username,password,note\nfixture,${U("www.fixturepublic.test", "/login-form")},zz@example.invalid,VAULT-PASSWORD-X,\n`);
  const r = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV(fx.p), BROWSER_RELAY_VAULT_FILES: vaultCsv }, realUpstream: true });
  let r2 = null;
  try {
    const list = await r.request("tools/list", {});
    assert.deepStrictEqual(list.tools.map((t) => t.name).sort(), [...pfMode.TOOL_ALLOWLIST].sort());
    const first = await r.call("tabs_list", {}, 90000);
    assert.ok(!first.isError, first.text);
    assert.ok(first.notices.includes(pfMode.MODE_LINE), first.notices.join(" | "));
    const st = JSON.parse((await r.call("relay_status")).text);
    assert.strictEqual(st.profileMode, "plainflags");
    assert.strictEqual(st.dir, path.join(cache, "profiles-plainflags", slugOf(proj)));
    assert.strictEqual(st.signinGuard, "active");
    assert.strictEqual(st.metaGuard, "active");
    assert.ok(fs.readFileSync(reg).equals(regBytes), "the registry is byte-identical");
    assert.ok(!fs.existsSync(path.join(cache, "profiles", slugOf(proj))), "the registered profile was never created or used");

    // layer 1: no request reaches the login host
    const before = hostHits("login.fixturebank.test");
    const nav = await r.call("navigation_go-to", { url: U("login.fixturebank.test", "/signin") });
    assert.strictEqual(nav.isError, true);
    assert.match(nav.text, /sign-in guard/);
    assert.strictEqual(hostHits("login.fixturebank.test"), before);
    assert.match((await r.call("execute", { code: "return 1" })).text, /REFUSED \(plain-flags relay\)/);

    // fill / press-key limits through the real upstream
    const go = await r.call("navigation_go-to", { url: U("www.fixturepublic.test", "/form"), includeSnapshot: false, includeScreenshot: false }, 60000);
    assert.ok(!go.isError, go.text);
    for (const sel of ["#pw", "#shown", "#otp", "e5"]) {
      const f = await r.call("interaction_fill", { selector: sel, value: PASSWORD }, 30000);
      assert.strictEqual(f.isError, true, `${sel}: ${f.text}`);
    }
    const okFill = await r.call("interaction_fill", { selector: "#first", value: "Zed" }, 30000);
    assert.ok(!okFill.isError, okFill.text);
    assert.strictEqual((await r.call("interaction_press-key", { key: "a" })).isError, true);
    assert.ok(!(await r.call("interaction_press-key", { key: "Tab" }, 30000)).isError);
    const ff = await r.call("form_fill", { fields: [{ selector: "iframe#fr >> internal:control=enter-frame >> #ipw", value: PASSWORD }] }, 30000);
    assert.strictEqual(ff.isError, true, `password in a frame reached by a frame-entering selector: ${ff.text}`);
    // round 1 item 1: a label reaching a password field, through the REAL upstream (interaction_fill) and the relay page (form_fill)
    for (const sel of ["label[for=pw]", "#wrapspan", "#deep"]) {
      const lf = await r.call("interaction_fill", { selector: sel, value: PASSWORD }, 30000);
      assert.strictEqual(lf.isError, true, `${sel}: ${lf.text}`);
      assert.match(lf.text, /reaches a password field/, sel);
    }
    assert.strictEqual((await r.call("form_fill", { fields: [{ selector: "#lblfor", value: PASSWORD }] }, 30000)).isError, true);
    assert.ok(!(await r.call("interaction_fill", { selector: "#lblfirst", value: "Zed" }, 30000)).isError, "a label for an ordinary field fills");
    // round 2 item 4: a show-password field by name, and a masked one by style, through the real upstream
    for (const sel of ["#pin", "#masked"]) {
      const sf = await r.call("interaction_fill", { selector: sel, value: PASSWORD }, 30000);
      assert.strictEqual(sf.isError, true, `${sel}: ${sf.text}`);
    }
    // round 2 item 1: no ARIA snapshot from any tool — the aria tool is refused, and a navigation result carries none
    await r.call("interaction_fill", { selector: "#first", value: "ZZ-TYPED-MARK" }, 30000);
    const aria = await r.call("a11y_take-aria-snapshot", {});
    assert.strictEqual(aria.isError, true);
    const nav2 = await r.request("tools/call", { name: "navigation_go-to", arguments: { url: U("www.fixturepublic.test", "/form") } }, 60000);
    assert.ok(JSON.stringify(nav2).includes("/form"), "the navigation result still carries the URL");
    assert.ok(!/textbox|ZZ-TYPED-MARK|"refs"/.test(JSON.stringify(nav2)), JSON.stringify(nav2).slice(0, 400));
    const back = await r.request("tools/call", { name: "navigation_go-back-or-forward", arguments: { direction: "back" } }, 60000);
    assert.ok(!/textbox|"refs"/.test(JSON.stringify(back)), JSON.stringify(back).slice(0, 400));
    await r.call("navigation_go-to", { url: U("www.fixturepublic.test", "/form"), includeSnapshot: false, includeScreenshot: false }, 60000);
    // (a preset password value would now LOCK this page — round 3; the HTML blanker is unit-tested)
    const html = await r.request("tools/call", { name: "content_get-as-html", arguments: {} }, 30000);
    assert.ok(JSON.stringify(html).includes("lblfor"), "the HTML came back");

    // a login POST: o11y returns no body, the password nowhere
    const click = await r.call("interaction_click", { selector: "#post" }, 30000);
    assert.ok(!click.isError, click.text);
    await new Promise((res) => setTimeout(res, 800));
    const reqs = await r.request("tools/call", { name: "o11y_get-http-requests", arguments: {} }, 30000);
    assert.ok(!JSON.stringify(reqs).includes(PASSWORD), "the fixture password appears nowhere in the whole result");
    assert.ok(JSON.stringify(reqs).includes("/session"), "the request itself is listed");
    assert.strictEqual((await r.call("o11y_get-http-requests", { includeRequestHeaders: true })).isError, true);

    // Meta guard: layer 1, and layer 2 by a link click
    const fbBefore = hostHits("www.facebook.com");
    assert.strictEqual((await r.call("navigation_go-to", { url: U("www.facebook.com", "/") })).isError, true);
    await r.call("navigation_go-to", { url: U("www.fixturepublic.test", "/links"), includeSnapshot: false, includeScreenshot: false }, 60000);
    const fbClick = await r.call("interaction_click", { selector: "#fb" }, 30000);
    await new Promise((res) => setTimeout(res, 800));
    const after = await r.call("tabs_list");
    const metaNotices = [...fbClick.notices, ...after.notices];
    assert.ok(metaNotices.some((n) => /BLOCKED a Meta page/.test(n)), metaNotices.join(" | "));
    assert.strictEqual(hostHits("www.facebook.com"), fbBefore);

    // autofill off: the vault's login form stays empty
    await r.call("navigation_go-to", { url: U("www.fixturepublic.test", "/login-form"), includeSnapshot: false, includeScreenshot: false }, 60000);
    await new Promise((res) => setTimeout(res, 1500));
    const side = JSON.parse(fs.readFileSync(path.join(cache, "profiles-plainflags", slugOf(proj), ".mcp-relay-status.json"), "utf8"));
    const { chromium } = require("playwright-core");
    const peek = await chromium.connectOverCDP(`http://127.0.0.1:${side.cdpPort}`);
    try {
      const pg = peek.contexts()[0].pages().find((x) => x.url().includes("/login-form"));
      assert.ok(pg, "the login form tab");
      assert.deepStrictEqual(await pg.evaluate(() => [document.getElementById("email").value, document.getElementById("lpw").value]), ["", ""], "nothing autofilled");
    } finally { await peek.close(); }
    assert.ok(!/\] vault: /.test(r.stderr()), "no vault loaded in plain-flags mode");

    // §5.6 (14): the navigation log — host + time, never a path or query
    const navLines = fs.readFileSync(path.join(cache, "plainflags-navigations.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(navLines.some((l) => l.event === "navigation" && l.host === "www.fixturepublic.test" && l.ts), JSON.stringify(navLines.slice(-3)));
    assert.ok(navLines.every((l) => !JSON.stringify(l).includes("/form") && !JSON.stringify(l).includes("/links")), "no path in the log");

    // a second session: an ephemeral clone under session-clones-plainflags/, no Login Data* copied
    r2 = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV(fx.p) }, realUpstream: true });
    const st2 = JSON.parse((await r2.call("relay_status")).text);
    assert.strictEqual(st2.mode, "clone");
    assert.ok(st2.dir.startsWith(path.join(cache, "session-clones-plainflags") + path.sep), st2.dir);
    const def = path.join(st2.dir, "Default");
    const copied = fs.existsSync(def) ? fs.readdirSync(def).filter((n) => n.startsWith("Login Data")) : [];
    assert.deepStrictEqual(copied, [], "no Login Data* seeded into the clone");
    assert.ok(!fs.existsSync(path.join(cache, "session-clones")), "nothing under the default clone root");
  } finally {
    if (r2) await r2.stop();
    await r.stop();
  }
});

test("e2e plain-flags relay (c): a not-listed account's cookie set in one session is gone after the relay restarts — the launch clear", ISO, async () => {
  await startServer();
  const home = homeTmp("home-pfc-");
  const proj = path.join(home, "proj-pfc");
  const fx = writeFixture(home);
  let r = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV(fx.p) }, realUpstream: true });
  try {
    assert.ok(!(await r.call("tabs_list", {}, 90000)).isError);
    const ws = JSON.parse(fs.readFileSync(path.join(cacheOf(home), "profiles-plainflags", slugOf(proj), ".mcp-relay-status.json"), "utf8"));
    const v = await (await fetch(`http://127.0.0.1:${ws.cdpPort}/json/version`)).json();
    await _cdpCall(v.webSocketDebuggerUrl, "Storage.setCookies", { cookies: [
      // NOT a named session cookie: the per-call sweep (f) leaves it, so only the launch clear (c) can remove it.
      { name: "fbprefs", value: "v1", domain: "login.fixturebank.test", path: "/", expires: Date.now() / 1000 + 3600 },
      { name: "keep", value: "v2", domain: ".other.test", path: "/", expires: Date.now() / 1000 + 3600 },
    ] });
  } finally { await r.stop(); }
  r = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV(fx.p) }, realUpstream: true });
  try {
    assert.ok(!(await r.call("tabs_list", {}, 90000)).isError);
    const ws = JSON.parse(fs.readFileSync(path.join(cacheOf(home), "profiles-plainflags", slugOf(proj), ".mcp-relay-status.json"), "utf8"));
    const v = await (await fetch(`http://127.0.0.1:${ws.cdpPort}/json/version`)).json();
    const names = (await _cdpCall(v.webSocketDebuggerUrl, "Storage.getCookies", {})).cookies.map((c) => c.name);
    assert.ok(!names.includes("fbprefs"), names.join());
    assert.ok(names.includes("keep"), `the persisted control cookie survived (${names.join()})`);
  } finally { await r.stop(); }
});

test("folder + launch refusals at relay start: a registered dir, the default clone root, a proxy (plain-flags); a plain-flags root (default)", ISO, async () => {
  const home = homeTmp("home-pfr-");
  const cache = cacheOf(home);
  const registered = path.join(cache, "profiles", "proj-x");
  fs.mkdirSync(registered, { recursive: true });
  fs.writeFileSync(path.join(cache, "project-registry.json"), JSON.stringify({ "/p/proj-x": { slot: 1, slug: "proj-x", dir: registered } }));
  const pfDir = path.join(cache, "profiles-plainflags", "proj-x");
  fs.mkdirSync(pfDir, { recursive: true });
  const run = (env) => spawnSync(process.execPath, [path.join(REPO, "src", "index.js")], {
    cwd: REPO, encoding: "utf8", timeout: 30000, input: "",
    env: { ...process.env, HOME: home, BROWSER_RELAY_IDLE_MINUTES: "0", BROWSER_RELAY_TEST_LAUNCH: "1", ...env },
  });
  const cases = [
    [{ BROWSER_RELAY_PROFILE_MODE: "plainflags", BROWSER_RELAY_POOL_DIR: registered }, /registered project profile/],
    [{ BROWSER_RELAY_PROFILE_MODE: "plainflags", BROWSER_RELAY_POOL_DIR: path.join(cache, "session-clones", "proj-x-p1-abc") }, /default session-clones/],
    [{ BROWSER_RELAY_PROFILE_MODE: "plainflags", BROWSER_RELAY_POOL_DIR: pfDir, BROWSER_RELAY_PROXY_URL: "http://127.0.0.1:9" }, /proxy/],
    [{ BROWSER_RELAY_PROFILE_MODE: "plainflags", BROWSER_RELAY_POOL_DIR: pfDir, BROWSER_RELAY_INSECURE_TLS: "1" }, /insecure TLS/],
    [{ BROWSER_RELAY_POOL_DIR: pfDir }, /plain-flags profile dir/],
  ];
  for (const [env, re] of cases) {
    const res = run(env);
    assert.notStrictEqual(res.status, 0, JSON.stringify(env));
    assert.match(res.stderr, re, `${JSON.stringify(env)}: ${res.stderr.slice(-400)}`);
    assert.ok(!fs.existsSync(path.join(registered, ".mcp-relay.flock")), "the registered profile was never claimed");
  }
});

test("e2e plain-flags relay (round 1 item 6): an entry is honoured only when its claude-ask record grants it; the addition and the refusal are announced and in relay_status", ISO, async () => {
  await startServer();
  const home = homeTmp("home-pfa-");
  const proj = path.join(home, "proj-pfa");
  const asks = homeTmp("pf-asks-");
  fs.mkdirSync(path.join(asks, "as-ops"), { recursive: true });
  const rec = (short, account, extra = {}) => fs.writeFileSync(path.join(asks, "as-ops", `${short}.json`), JSON.stringify({
    id: `as-ops/${short}`, project: "as-ops", kind: "permission", risk: "credentials", state: "in_progress",
    title: `Allow sign-in to ${account} in the plain-flags relay`, options: [{ key: "add" }, { key: "later", declines: true }],
    answer: { option: "add" }, ...extra,
  }));
  rec("ask-aaaaaa", "fixturebank");
  rec("ask-bbbbbb", "fixturedesign", { risk: "internal" });
  const dir = homeTmp("pf-fixture-a-");
  const sp = path.join(dir, "plainflags-signin.json");
  fs.writeFileSync(sp, JSON.stringify({ accounts: [{ name: "fixturebank", askId: "as-ops/ask-aaaaaa" }, { name: "fixturedesign", askId: "as-ops/ask-bbbbbb" }] }));
  const fxp = path.join(dir, "fixture.json");
  fs.writeFileSync(fxp, JSON.stringify({ accounts: accountsFixture(), signinFile: sp, asksDir: asks }));
  const r = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV(fxp) }, realUpstream: true });
  try {
    const first = await r.call("tabs_list", {}, 90000);
    assert.ok(first.notices.some((n) => /"fixturebank" is ON the sign-in list/.test(n)), first.notices.join(" | "));
    assert.ok(first.notices.some((n) => /"fixturedesign" REFUSED .*risk "internal"/.test(n)), first.notices.join(" | "));
    const st = JSON.parse((await r.call("relay_status")).text);
    assert.deepStrictEqual(st.signinList.accounts, ["fixturebank"]);
    assert.strictEqual(st.signinList.refused[0].name, "fixturedesign");
    const before = hostHits("login.fixturebank.test");
    const ok = await r.call("navigation_go-to", { url: U("login.fixturebank.test", "/signin"), includeSnapshot: false, includeScreenshot: false }, 60000);
    assert.strictEqual(hostHits("login.fixturebank.test"), before + 1, "a granted account's login loads");
    // round 3: the tab is now on a known account's sign-in page → LOCKED (the URL rule, listed or not);
    // the navigation's own result is withheld by the after-call probe.
    assert.strictEqual(ok.isError, true);
    assert.match(ok.text, /Locked: .*sign-in page \(login\.fixturebank\.test\)/);
    assert.strictEqual(JSON.parse((await r.call("relay_status")).text).lock.locked, true);
    const refused = await r.call("navigation_go-to", { url: U("www.fixturedesign.test", "/login") });
    assert.strictEqual(refused.isError, true, "a refused entry stays refused");
    assert.match(refused.text, /sign-in guard/, "refused by layer 1 (static), before the lock");
  } finally { await r.stop(); }
});

// ── round 3 A: the lock, through the REAL relay and REAL upstream ───────────

test("round 3 lock: a filled password (typed by 'Trevor' over CDP) refuses every tool but relay_status / tabs_list; clearing it or leaving the page unlocks; a SPA that keeps it filled stays locked; a cross-origin iframe's field locks; a javascript: URL never reaches upstream", ISO, async () => {
  await startServer();
  const home = homeTmp("home-pflock-");
  const proj = path.join(home, "proj-pflock");
  const fx = writeFixture(home);
  const r = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...RELAY_ENV(fx.p) }, realUpstream: true });
  const { chromium } = require("playwright-core");
  let peek = null;
  const seen = [];
  const call = async (n, a = {}, t = 30000) => { const x = await r.call(n, a, t); seen.push(JSON.stringify(x)); return x; };
  try {
    assert.ok(!(await call("tabs_list", {}, 90000)).isError);
    const cache = cacheOf(home);
    const side = JSON.parse(fs.readFileSync(path.join(cache, "profiles-plainflags", slugOf(proj), ".mcp-relay-status.json"), "utf8"));
    peek = await chromium.connectOverCDP(`http://127.0.0.1:${side.cdpPort}`);
    const pageAt = async (part) => waitFor(async () => peek.contexts()[0].pages().find((x) => x.url().includes(part)) || null, 10000);

    // (4) a javascript: URL is refused before upstream: the page's title never changes
    assert.ok(!(await call("navigation_go-to", { url: U("www.fixturepublic.test", "/signin-fixture"), includeScreenshot: false }, 60000)).isError);
    for (const [n, k] of [["navigation_go-to", "url"], ["tabs_new", "url"], ["capture_xhr", "navigateToUrl"]]) {
      const j = await call(n, { [k]: "javascript:document.title='PWNED'" });
      assert.strictEqual(j.isError, true, n);
      assert.match(j.text, /javascript: scheme is refused/, n);
    }
    const sp = await pageAt("/signin-fixture");
    assert.notStrictEqual(await sp.title(), "PWNED");

    // (1) Trevor types a password → locked
    await sp.fill("#pw", PASSWORD);
    const tools = [
      ["content_take-screenshot", {}], ["content_take-screenshot", { annotate: true }], ["content_get-as-text", {}], ["content_get-as-html", {}],
      ["navigation_go-to", { url: U("www.fixturepublic.test", "/") }], ["o11y_get-console-messages", {}], ["o11y_get-http-requests", {}],
      ["capture_xhr", { durationMs: 200 }], ["interaction_click", { selector: "#go" }], ["interaction_fill", { selector: "#user", value: "x" }],
      ["tabs_select", { index: 0 }], ["tabs_new", { url: U("www.fixturepublic.test", "/") }], ["sync_wait-for-network-idle", {}],
    ];
    for (const [n, a] of tools) {
      const x = await call(n, a);
      assert.strictEqual(x.isError, true, `${n} ${JSON.stringify(a)}: ${x.text.slice(0, 200)}`);
      assert.match(x.text, /Locked: a password or one-time code is on this page|annotat/, n);
    }
    const st = JSON.parse((await call("relay_status")).text);
    assert.strictEqual(st.lock.locked, true);
    const tl = await call("tabs_list");
    assert.ok(!tl.isError, "tabs_list is exempt");
    assert.ok([...seen].some((t) => /PLAIN-FLAGS: LOCKED/.test(t)), "the lock is announced");
    assert.strictEqual(await sp.inputValue("#user"), "", "nothing ran: the refused fill did not happen");

    // clearing the field unlocks
    await sp.fill("#pw", "");
    const t1 = await call("content_get-as-text", {});
    assert.ok(!t1.isError, t1.text.slice(0, 200));
    assert.match(t1.text, /SIGNIN-FIXTURE/);
    assert.ok(t1.notices.some((n) => /UNLOCKED/.test(n)), t1.notices.join(" | "));

    // refill, then the TAB leaves the sign-in page → unlocked
    await sp.fill("#pw", PASSWORD);
    assert.strictEqual((await call("content_get-as-text", {})).isError, true);
    await sp.goto(U("www.fixturepublic.test", "/"));
    assert.ok(!(await call("content_get-as-text", {})).isError, "unlocked after leaving");

    // (2) a SPA that keeps the field filled after "submit" stays locked
    assert.ok(!(await call("navigation_go-to", { url: U("www.fixturepublic.test", "/spa-signin") }, 60000)).isError);
    const spa = await pageAt("/spa-signin");
    await spa.fill("#spw", PASSWORD);
    await spa.click("#sub");
    assert.strictEqual(await spa.textContent("#msg"), "SPA-SUBMITTED");
    assert.strictEqual((await call("content_get-as-text", {})).isError, true, "still filled → still locked");
    await spa.fill("#spw", "");
    assert.ok(!(await call("content_get-as-text", {})).isError);

    // (3) a password typed into a CROSS-ORIGIN iframe locks
    assert.ok(!(await call("navigation_go-to", { url: U("www.fixturepublic.test", "/xo-parent") }, 60000)).isError);
    const xo = await pageAt("/xo-parent");
    const child = await waitFor(async () => xo.frames().find((f) => f.url().includes("/xo-child")) || null, 10000);
    await child.fill("#xpw", PASSWORD);
    assert.strictEqual((await call("content_get-as-text", {})).isError, true, "a filled field in a cross-origin frame locks");
    await child.fill("#xpw", "");
    assert.ok(!(await call("content_get-as-text", {})).isError);

    // round 4 M5: tabs_list returns origin + path only (no ?code=, no #token)
    assert.ok(!(await r.call("navigation_go-to", { url: U("www.fixturepublic.test", "/cb?code=CODE-MARK-7Q#access_token=TOKEN-MARK-8R") }, 60000)).isError);
    const tl2 = await call("tabs_list");
    assert.ok(tl2.text.includes("/cb"), tl2.text);
    assert.ok(!/CODE-MARK-7Q|TOKEN-MARK-8R|\?code/.test(tl2.text), tl2.text);
    // round 4 L7: a screenshot is written under the profile's private dir, whatever outputPath says
    const shot = await call("content_take-screenshot", { outputPath: home }, 60000);
    assert.ok(!shot.isError, shot.text);
    assert.ok(shot.text.includes(path.join(cacheOf(home), "profiles-plainflags", slugOf(proj), ".relay-screenshots")), shot.text);

    // (and a known account's sign-in page locks by its URL, listed or not — fixturedesign /login is refused here
    //  anyway, so the URL rule is unit-tested in plainflags-lock.test.js)
    assert.ok(seen.every((t) => !t.includes(PASSWORD)), "the password never appears in any tool result");
  } finally {
    if (peek) await peek.close().catch(() => {});
    await r.stop();
  }
});

// ── round 4: the lock's reader and rules on a real Brave ────────────────────

test("round 4 M4: the probe runs in an ISOLATED world — a cross-origin child's wrapped querySelectorAll records 0 probe calls, and a page-world override of HTMLInputElement.value cannot hide a typed password", ISO, async () => {
  await startServer();
  const { createLock } = require("../src/plainflags-lock.js");
  const { h } = await launchPf("pf-m4-");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    await page.goto(U("www.fixturepublic.test", "/m4-top"));
    const kid = await waitFor(async () => page.frames().find((f) => f.url().includes("/m4-child")) || null, 10000);
    await kid.waitForFunction(() => document.readyState === "complete");
    const before = await kid.evaluate(() => window.__qsa);
    const lock = createLock({ getContext: () => h.context, accounts: accountsFixture() });
    assert.strictEqual((await lock.probe()).locked, false, "empty field");
    await page.fill("#pw", PASSWORD); // Trevor types; the page world's value getter now lies ("")
    assert.strictEqual(await page.evaluate(() => document.getElementById("pw").value), "", "the page world sees nothing");
    const st = await lock.probe();
    assert.strictEqual(st.locked, true, "the isolated world sees the real value");
    assert.strictEqual(st.unreadable, 0);
    assert.strictEqual(await kid.evaluate(() => window.__qsa) - before, 0, "the probe never called the page's querySelectorAll");
  } finally { await closeBrave(h); }
});

test("round 4 M1 + L6 on a real page: a checked remember-password box, an otp_method radio, a hidden 'passengers', a 'password-submit' button do not lock; six digit boxes do", ISO, async () => {
  await startServer();
  const { createLock } = require("../src/plainflags-lock.js");
  const { h } = await launchPf("pf-m1-");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    const lock = createLock({ getContext: () => h.context, accounts: accountsFixture() });
    await page.goto(U("www.fixturepublic.test", "/m1-falsepos"));
    assert.strictEqual((await lock.probe()).locked, false);
    await page.goto(U("www.fixturepublic.test", "/l6-otp"));
    assert.strictEqual((await lock.probe()).locked, false, "empty boxes");
    await page.fill("#d0", "4");
    const st = await lock.probe();
    assert.deepStrictEqual([st.locked, st.seen], [true, 6]);
  } finally { await closeBrave(h); }
});

test("round 4 M3 on a real Brave: tab A with a hung cross-origin frame + tab B with an EMPTY sign-in form do not lock; B leaving keeps it unlocked", ISO, async () => {
  await startServer();
  const { createLock } = require("../src/plainflags-lock.js");
  const { h } = await launchPf("pf-m3-");
  try {
    const a = h.context.pages()[0] || (await h.context.newPage());
    await a.goto(U("www.fixturepublic.test", "/m3-a"));
    await a.waitForTimeout(700); // the child's renderer is now stuck in its loop
    const b = await h.context.newPage();
    await b.goto(U("www.fixtureother.test", "/m3-b"));
    const lock = createLock({ getContext: () => h.context, accounts: accountsFixture(), frameTimeoutMs: 1000 });
    const st = await lock.probe();
    assert.strictEqual(st.locked, false, JSON.stringify(st));
    assert.ok(st.unreadable >= 1, "tab A's hung frame is unreadable");
    await b.goto(U("www.fixtureother.test", "/"));
    assert.strictEqual((await lock.probe()).locked, false);
  } finally { await closeBrave(h); }
});

test("round 4 M4: a challenges.cloudflare.com frame is never touched — a HUNG one beside an empty password field does not lock (it would, if it were read and timed out)", ISO, async () => {
  await startTlsServer();
  const { createLock } = require("../src/plainflags-lock.js");
  process.env.BROWSER_RELAY_INSECURE_TLS = "1"; // the challenge host is HSTS-preloaded: HTTPS fixture, default-mode test Brave
  let h;
  try { ({ h } = await launchPf("pf-m4c-", "default")); } finally { delete process.env.BROWSER_RELAY_INSECURE_TLS; }
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    await page.goto(S("www.fixturepublic.test", "/chl-busy-page"));
    await waitFor(async () => page.frames().some((f) => f.url().startsWith(`https://challenges.cloudflare.com:${TLS_PORT}/`)), 10000);
    await page.waitForTimeout(700);
    const st = await createLock({ getContext: () => h.context, accounts: accountsFixture(), frameTimeoutMs: 1000 }).probe();
    assert.deepStrictEqual([st.locked, st.unreadable, st.seen], [false, 0, 1], JSON.stringify(st));
  } finally { await closeBrave(h); }
});

// ── round 5 ─────────────────────────────────────────────────────────────────

test("round 5 item 1 (HIGH): same tab, CROSS-SITE navigation to a password page with a same-origin iframe, typed → LOCKED, every time (looped; the reused-context-id bug was intermittent)", ISO, async () => {
  await startServer();
  const { createLock } = require("../src/plainflags-lock.js");
  const { h } = await launchPf("pf-r5xs-");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    const lock = createLock({ getContext: () => h.context, accounts: accountsFixture() });
    const outcomes = [];
    for (let i = 0; i < 12; i++) {
      // site A: a plain page, so the world the probe creates there gets a SMALL context id …
      await page.goto(U(`www.fixturesitea${i}.test`, "/xs-a"));
      assert.strictEqual((await lock.probe()).locked, false, `round ${i}: site A has no secret`);
      // … which site B's new renderer can hand to another context: B has 1–3 same-origin iframes
      const n = 1 + (i % 3);
      await page.goto(U(`www.fixturesiteb${i}.test`, `/xs-b?n=${n}`));
      await page.waitForLoadState("load");
      await page.fill("#pw", PASSWORD);
      const st = await lock.probe();
      outcomes.push(st.locked);
      await page.fill("#pw", "");
    }
    assert.deepStrictEqual(outcomes, Array(12).fill(true), `locked in every round: ${outcomes.join(",")}`);
  } finally { await closeBrave(h); }
});

test("round 5 item 2: a masked, filled password stays LOCKED after the show-password eye turns it into type=text; a 2FA code field locks", ISO, async () => {
  await startServer();
  const { createLock } = require("../src/plainflags-lock.js");
  const { h } = await launchPf("pf-r5t-");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    const lock = createLock({ getContext: () => h.context, accounts: accountsFixture() });
    await page.goto(U("www.fixturepublic.test", "/toggle"));
    assert.strictEqual((await lock.probe()).locked, false);
    await page.fill("#tpw", PASSWORD);
    assert.strictEqual((await lock.probe()).locked, true, "masked + filled");
    await page.click("#eye");
    assert.strictEqual(await page.getAttribute("#tpw", "type"), "text");
    assert.strictEqual((await lock.probe()).locked, true, "still locked after show-password");
    await page.goto(U("www.fixturepublic.test", "/two-fa"));
    assert.strictEqual((await lock.probe()).locked, false);
    await page.fill("#code", "123456");
    assert.strictEqual((await lock.probe()).locked, true, "a filled 2FA code field locks");
  } finally { await closeBrave(h); }
});

// ── round 6 ─────────────────────────────────────────────────────────────────

test("round 6 item 1 (HIGH): a hostile same-site child frame (stamp-forging getter, poisoned globals, wrapped querySelectorAll) after a CROSS-SITE navigation cannot unlock a typed password on the main frame — looped 40×, and the child never sees the probe", ISO, async () => {
  await startServer();
  const { createLock } = require("../src/plainflags-lock.js");
  const { h } = await launchPf("pf-r6h-");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    const lock = createLock({ getContext: () => h.context, accounts: accountsFixture() });
    const outcomes = [];
    let touched = 0;
    for (let i = 0; i < 40; i++) {
      await page.goto(U(`www.hostilea${i}.test`, "/xs-a"));
      await lock.probe();
      await page.goto(U(`www.hostileb${i}.test`, "/hostile-b"));
      await page.waitForLoadState("load");
      const child = page.frames().find((f) => f.url().endsWith("/f"));
      await child.waitForFunction(() => typeof window.__touched === "number");
      await page.fill("#pw", PASSWORD);
      outcomes.push((await lock.probe()).locked);
      touched += await child.evaluate(() => window.__touched);
    }
    assert.strictEqual(outcomes.filter((x) => x !== true).length, 0, `locked in all 40: ${outcomes.join("")}`);
    assert.strictEqual(touched, 0, "the probe never ran in (or touched) the child's main world");
  } finally { await closeBrave(h); }
});

// ── round 7 ─────────────────────────────────────────────────────────────────
// Item 1 (HIGH): Playwright keeps the SAME Frame object when an iframe moves
// into (or out of) its own process; round 6 cached "in-process" per Frame, so
// a frame that moved stayed unread and a typed password did not lock. Rule 0:
// nothing is cached between probes. Each case is looped 10×, each probe comes
// straight after the move (no extra probe in between).

async function swapFrame(page, url) {
  await page.evaluate((u) => { document.getElementById("f").src = u; }, url);
  const fr = await waitFor(async () => { const f = page.frames()[1]; return f && f.url() === url ? f : null; }, 8000);
  assert.ok(fr, `the iframe reached ${url}`);
  await fr.waitForLoadState("load");
  return fr;
}
async function oopif(h, frame) {
  try { const s = await h.context.newCDPSession(frame); await s.detach(); return true; } catch { return false; }
}
async function swapMatrix(prefix, run) {
  await startServer();
  const { createLock } = require("../src/plainflags-lock.js");
  const { h } = await launchPf(prefix);
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    const lock = createLock({ getContext: () => h.context, accounts: accountsFixture() });
    const outcomes = [];
    for (let i = 0; i < 10; i++) outcomes.push(await run({ h, page, lock, i }));
    assert.deepStrictEqual(outcomes, Array(10).fill(true), outcomes.join(","));
  } finally { await closeBrave(h); }
}

test("round 7 item 1a (HIGH): an about:blank iframe is probed, then navigates CROSS-SITE (into its own process) to a password page → typed → LOCKED (10×)", ISO, async () => {
  await swapMatrix("pf-r7a-", async ({ h, page, lock, i }) => {
    await page.goto(U(`www.swaptopa${i}.test`, "/swap-top"));
    const before = page.frames()[1];
    assert.strictEqual(await oopif(h, before), false, "about:blank is in-process");
    assert.strictEqual((await lock.probe()).locked, false);
    const fr = await swapFrame(page, U(`www.swapxa${i}.test`, "/swap-pw"));
    assert.strictEqual(fr, before, "Playwright kept the same Frame object");
    assert.strictEqual(await oopif(h, fr), true, "now out-of-process");
    await fr.fill("#pw", PASSWORD);
    const st = await lock.probe();
    await fr.fill("#pw", "");
    return st.locked === true || JSON.stringify(st);
  });
});

test("round 7 item 1b (HIGH): a SAME-SITE iframe is probed, then navigates cross-site to a password page → typed → LOCKED (10×)", ISO, async () => {
  await swapMatrix("pf-r7b-", async ({ h, page, lock, i }) => {
    await page.goto(U(`www.swaptopb${i}.test`, `/swap-top?src=${encodeURIComponent(U(`www.swaptopb${i}.test`, "/swap-plain"))}`));
    await waitFor(async () => page.frames()[1] && page.frames()[1].url().endsWith("/swap-plain"));
    assert.strictEqual(await oopif(h, page.frames()[1]), false);
    assert.strictEqual((await lock.probe()).locked, false);
    const fr = await swapFrame(page, U(`www.swapxb${i}.test`, "/swap-pw"));
    await fr.fill("#pw", PASSWORD);
    const st = await lock.probe();
    await fr.fill("#pw", "");
    return st.locked === true || JSON.stringify(st);
  });
});

test("round 7 item 1c (HIGH): the REVERSE move — a cross-site (out-of-process) iframe is probed, then navigates SAME-SITE (back in-process) to a password page → typed → LOCKED (10×)", ISO, async () => {
  await swapMatrix("pf-r7c-", async ({ h, page, lock, i }) => {
    await page.goto(U(`www.swaptopc${i}.test`, `/swap-top?src=${encodeURIComponent(U(`www.swapxc${i}.test`, "/swap-plain"))}`));
    await waitFor(async () => page.frames()[1] && page.frames()[1].url().endsWith("/swap-plain"));
    assert.strictEqual(await oopif(h, page.frames()[1]), true);
    assert.strictEqual((await lock.probe()).locked, false);
    const fr = await swapFrame(page, U(`www.swaptopc${i}.test`, "/swap-pw"));
    assert.strictEqual(await oopif(h, fr), false, "back in-process");
    await fr.fill("#pw", PASSWORD);
    const st = await lock.probe();
    await fr.fill("#pw", "");
    return st.locked === true || JSON.stringify(st);
  });
});

test("round 7 item 1d / item 4 (HIGH): an iframe moves out of process, is probed there, then swaps process a SECOND time (site X → site Y) — the very next probe locks a typed password (no one-probe gap) (10×)", ISO, async () => {
  await swapMatrix("pf-r7d-", async ({ h, page, lock, i }) => {
    await page.goto(U(`www.swaptopd${i}.test`, "/swap-top"));
    assert.strictEqual((await lock.probe()).locked, false);
    let fr = await swapFrame(page, U(`www.swapxd${i}.test`, "/swap-pw"));
    await fr.fill("#pw", PASSWORD);
    const first = await lock.probe();
    await fr.fill("#pw", "");
    const cleared = await lock.probe();
    fr = await swapFrame(page, U(`www.swapyd${i}.test`, "/swap-pw"));
    assert.strictEqual(await oopif(h, fr), true);
    await fr.fill("#pw", PASSWORD);
    const second = await lock.probe();
    await fr.fill("#pw", "");
    return (first.locked && !cleared.locked && second.locked) || JSON.stringify({ first, cleared, second });
  });
});

// ── A77: the DEFAULT relay's lock (ruling as-ops/ask-a2ggu5 rev 2, "Lock, except session-filled values") ──

const SESSION_PW = "Session-Fixture-Pw-41";
const DEFAULT_RELAY_ENV = () => ({
  BROWSER_RELAY_TEST_LAUNCH: "1",
  BROWSER_HEADLESS_ENABLE: "true",
  BROWSER_RELAY_BRAVE_PATH: BRAVE,
  TELEMETRY_ENABLE: "false",
  BROWSER_RELAY_PROFILE_MODE: "default",
});

test("A77 e2e DEFAULT relay: Trevor's typed password (over CDP) refuses the aria snapshot, navigation, get-as-html and the screenshot; tabs_list + relay_status work; clearing unlocks; a session form_fill of a password then interaction_click submit works; no lock on an empty password field or a checkbox named password", ISO, async () => {
  await startServer();
  const home = homeTmp("home-a77-");
  const proj = path.join(home, "proj-a77");
  const r = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...DEFAULT_RELAY_ENV() }, realUpstream: true });
  const { chromium } = require("playwright-core");
  let peek = null;
  const seen = [];
  const call = async (n, a = {}, t = 60000) => { const x = await r.call(n, a, t); seen.push(JSON.stringify(x)); return x; };
  try {
    assert.ok(!(await call("tabs_list", {}, 90000)).isError);
    const side = JSON.parse(fs.readFileSync(path.join(cacheOf(home), "profiles", slugOf(proj), ".mcp-relay-status.json"), "utf8"));
    peek = await chromium.connectOverCDP(`http://127.0.0.1:${side.cdpPort}`);
    const pageAt = async (part) => waitFor(async () => peek.contexts()[0].pages().find((x) => x.url().includes(part)) || null, 10000);
    const LOCKED_RE = /^\[mcp-relay\] Locked: a password or one-time code typed on this page \(Trevor may be signing in\)\. Tools resume when the field is empty, or holds only a value this session filled\./;

    // the default tool list is untouched (a11y_* and execute are still offered)
    const names = (await r.request("tools/list", {})).tools.map((t) => t.name);
    for (const n of ["a11y_take-aria-snapshot", "execute", "cookies_export", "navigation_reload"]) assert.ok(names.includes(n), n);

    // no lock: an EMPTY password field and a checked checkbox named password
    const nl = await call("navigation_go-to", { url: U("www.fixturepublic.test", "/a77-nolock") });
    assert.ok(!nl.isError, nl.text.slice(0, 300));
    assert.ok(!(await call("a11y_take-aria-snapshot")).isError);
    assert.ok(!(await call("content_get-as-html")).isError);

    // (1) Trevor types a password → every tool but relay_status / tabs_list is refused
    assert.ok(!(await call("navigation_go-to", { url: U("www.fixturepublic.test", "/signin-fixture"), includeSnapshot: false })).isError);
    const sp = await pageAt("/signin-fixture");
    await sp.fill("#pw", PASSWORD);
    for (const [n, a] of [
      ["a11y_take-aria-snapshot", {}], ["navigation_go-to", { url: U("www.fixturepublic.test", "/") }], ["navigation_go-back-or-forward", { direction: "back" }],
      ["content_get-as-html", {}], ["content_take-screenshot", {}], ["content_get-as-text", {}], ["execute", { script: "return 1" }], ["interaction_click", { selector: "#go" }],
    ]) {
      const x = await call(n, a);
      assert.strictEqual(x.isError, true, `${n}: ${x.text.slice(0, 200)}`);
      assert.match(x.text, LOCKED_RE, n);
    }
    assert.strictEqual(sp.url().includes("/signin-fixture"), true, "the refused navigation did not run");
    const tl = await call("tabs_list");
    assert.ok(!tl.isError, "tabs_list is exempt");
    const st = JSON.parse((await call("relay_status")).text);
    assert.strictEqual(st.lock.locked, true);
    assert.ok(seen.some((t) => /\[browser-mcp-relay\] LOCKED — /.test(t)), "the lock is announced");

    // clearing it unlocks
    await sp.fill("#pw", "");
    const t1 = await call("a11y_take-aria-snapshot");
    assert.ok(!t1.isError, t1.text.slice(0, 200));
    assert.ok(t1.notices.some((n) => /UNLOCKED/.test(n)), t1.notices.join(" | "));

    // (2) the SESSION fills a fixture password (form_fill) and submits (interaction_click): never locked
    assert.ok(!(await call("navigation_go-to", { url: U("www.fixturepublic.test", "/login-form"), includeSnapshot: false })).isError);
    const lf = await pageAt("/login-form");
    const ff = await call("form_fill", { fields: [{ selector: "#email", value: "zz@example.invalid" }, { selector: "#lpw", value: SESSION_PW }] });
    assert.ok(!ff.isError, ff.text.slice(0, 300));
    assert.strictEqual(await lf.inputValue("#lpw"), SESSION_PW);
    const snap = await call("a11y_take-aria-snapshot");
    assert.ok(!snap.isError, `the session's own value does not lock: ${snap.text.slice(0, 200)}`);
    const click = await call("interaction_click", { selector: "#go" });
    assert.ok(!click.isError, click.text.slice(0, 300));
    await waitFor(async () => (await lf.textContent("body").catch(() => "")).includes("SESSION-OK"), 10000);
    assert.match(await lf.textContent("body"), /SESSION-OK/, "submitted");

    // (3) interaction_fill too; then Trevor types a DIFFERENT value over it → locked
    assert.ok(!(await call("navigation_go-to", { url: U("www.fixturepublic.test", "/signin-fixture"), includeSnapshot: false })).isError);
    const sp2 = await pageAt("/signin-fixture");
    const fi = await call("interaction_fill", { selector: "#pw", value: SESSION_PW });
    assert.ok(!fi.isError, fi.text.slice(0, 300));
    assert.ok(!(await call("content_get-as-text")).isError);
    await sp2.fill("#pw", PASSWORD);
    assert.match((await call("content_get-as-text")).text, LOCKED_RE);
    await sp2.fill("#pw", "");
    assert.ok(!(await call("content_get-as-text")).isError);

    assert.ok(seen.every((t) => !t.includes(PASSWORD)), "Trevor's password never appears in any tool result");
    assert.ok(!r.stderr().includes(PASSWORD) && !r.stderr().includes(SESSION_PW), "nor in the relay's log");
    // round 2 (F2): the lock-episode log — one line per lock / unlock, 0600, no value, no path
    const epFile = path.join(cacheOf(home), "default-lock-episodes.log");
    const ep = fs.readFileSync(epFile, "utf8");
    const eps = ep.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(eps.length >= 4 && eps[0].event === "lock" && eps[1].event === "unlock", ep);
    for (const e of eps) {
      assert.deepStrictEqual(Object.keys(e).filter((k) => !["ts", "slug", "pid", "event", "reason", "kinds", "tabs", "host", "durationMs"].includes(k)), [], ep);
      assert.strictEqual(e.host, "www.fixturepublic.test");
    }
    assert.ok(eps[0].kinds.includes("type=password"), JSON.stringify(eps[0]));
    for (const e of eps) for (const k of e.kinds) assert.ok(["remembered", "type=password", "autocomplete", "name-rule", "text-security", "otp"].includes(k), k);
    assert.strictEqual((fs.statSync(epFile).mode & 0o777).toString(8), "600");
    for (const mark of [PASSWORD, SESSION_PW, "signin-fixture", "#pw"]) assert.ok(!ep.includes(mark), `${mark} in the episode log`);
  } finally {
    if (peek) await peek.close().catch(() => {});
    await r.stop();
  }
});

test("A77 default-mode lock on a real Brave: the in-page hash matches a session value in the main frame, a cross-origin iframe and two open shadow roots deep (1c L1); a different value locks", ISO, async () => {
  await startServer();
  const { createLock, createSessionFills } = require("../src/plainflags-lock.js");
  const { h } = await launchPf("pf-a77h-", "default");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    const fills = createSessionFills();
    const lock = createLock({ getContext: () => h.context, mode: "default", sessionFills: fills });
    fills.record(SESSION_PW);
    await page.goto(U("www.fixturepublic.test", "/signin-fixture"));
    await page.fill("#pw", SESSION_PW);
    const own = await lock.probe();
    assert.deepStrictEqual([own.locked, own.sessionFilled, own.unreadable], [false, 1, 0], JSON.stringify(own));
    await page.fill("#pw", PASSWORD);
    assert.strictEqual((await lock.probe()).locked, true);
    await page.goto(U("www.fixturepublic.test", "/xo-parent"));
    const child = await waitFor(async () => page.frames().find((f) => f.url().includes("/xo-child")) || null, 10000);
    await child.fill("#xpw", SESSION_PW);
    assert.strictEqual((await lock.probe()).locked, false, "a session value in a cross-origin frame");
    await child.fill("#xpw", PASSWORD);
    assert.strictEqual((await lock.probe()).locked, true);
    await page.goto(U("www.fixturepublic.test", "/a77-shadow"));
    assert.strictEqual((await lock.probe()).locked, false, "empty");
    await page.fill("#spw", PASSWORD); // Playwright pierces open shadow roots
    const sh = await lock.probe();
    assert.deepStrictEqual([sh.locked, sh.seen], [true, 1], JSON.stringify(sh));
  } finally { await closeBrave(h); }
});

test("A77 default-mode lock: the round-5 cross-site navigation (12×) and the round-7 process swaps (about:blank → cross-site; second swap) still lock a typed password", ISO, async () => {
  await startServer();
  const { createLock, createSessionFills } = require("../src/plainflags-lock.js");
  const { h } = await launchPf("pf-a77x-", "default");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    const fills = createSessionFills();
    fills.record(SESSION_PW); // an unrelated session value: the allow path runs on every probe
    const lock = createLock({ getContext: () => h.context, mode: "default", sessionFills: fills });
    const outcomes = [];
    for (let i = 0; i < 12; i++) {
      await page.goto(U(`www.a77sitea${i}.test`, "/xs-a"));
      assert.strictEqual((await lock.probe()).locked, false);
      await page.goto(U(`www.a77siteb${i}.test`, `/xs-b?n=${1 + (i % 3)}`));
      await page.waitForLoadState("load");
      await page.fill("#pw", PASSWORD);
      outcomes.push((await lock.probe()).locked);
      await page.fill("#pw", "");
    }
    assert.deepStrictEqual(outcomes, Array(12).fill(true), outcomes.join(","));
    const swaps = [];
    for (let i = 0; i < 5; i++) {
      await page.goto(U(`www.a77swaptop${i}.test`, "/swap-top"));
      assert.strictEqual((await lock.probe()).locked, false);
      let fr = await swapFrame(page, U(`www.a77swapx${i}.test`, "/swap-pw"));
      assert.strictEqual(await oopif(h, fr), true);
      await fr.fill("#pw", PASSWORD);
      const first = await lock.probe();
      await fr.fill("#pw", "");
      fr = await swapFrame(page, U(`www.a77swapy${i}.test`, "/swap-pw"));
      await fr.fill("#pw", PASSWORD);
      const second = await lock.probe();
      await fr.fill("#pw", "");
      swaps.push(first.locked && second.locked);
    }
    assert.deepStrictEqual(swaps, Array(5).fill(true), swaps.join(","));
  } finally { await closeBrave(h); }
});

test("A77 latency: the probe's cost per tool call in the default relay (2 probes per call) — a page with 0 iframes, 5 same-site and 5 cross-site iframes", ISO, async (t) => {
  await startServer();
  const { createLock, createSessionFills } = require("../src/plainflags-lock.js");
  const { h } = await launchPf("pf-a77l-", "default");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    const fills = createSessionFills();
    fills.record(SESSION_PW);
    const lock = createLock({ getContext: () => h.context, mode: "default", sessionFills: fills });
    const out = {};
    for (const [label, url] of [["0 iframes", U("www.a77lat.test", "/signin-fixture")], ["5 same-site iframes", U("www.a77lat.test", "/xs-b?n=5")], ["5 cross-site iframes", U("www.a77lat.test", "/a77-xo5")]]) {
      await page.goto(url);
      await page.waitForLoadState("load");
      await lock.probe(); // warm
      const ms = [];
      for (let i = 0; i < 15; i++) { const t0 = process.hrtime.bigint(); const st = await lock.probe(); ms.push(Number(process.hrtime.bigint() - t0) / 1e6); assert.strictEqual(st.unreadable, 0, label); }
      ms.sort((a, b) => a - b);
      out[label] = { medianMs: +ms[7].toFixed(1), p90Ms: +ms[13].toFixed(1), maxMs: +ms[14].toFixed(1), frames: page.frames().length };
    }
    t.diagnostic(`A77 probe latency (one probe; a tool call runs two): ${JSON.stringify(out)}`);
    process.stderr.write(`A77-LATENCY ${JSON.stringify(out)}\n`);
  } finally { await closeBrave(h); }
});

test("A77 fix 1 (HIGH): a password typed in the main frame beside 3 and 4 BUSY cross-site iframes still LOCKS, in both modes — the frames already read survive a tab timeout; the probe stays bounded", ISO, async (t) => {
  await startServer();
  const { createLock, createSessionFills } = require("../src/plainflags-lock.js");
  const { h } = await launchPf("pf-a77busy-", "default");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    const out = [];
    for (const n of [3, 4]) {
      await page.goto(U("www.a77busytop.test", `/a77-busy?n=${n}`), { waitUntil: "domcontentloaded" });
      await page.fill("#pw", PASSWORD);
      await page.waitForTimeout(700); // every child renderer is now stuck in its loop
      for (const mode of ["plainflags", "default"]) {
        const lock = createLock({ getContext: () => h.context, accounts: accountsFixture(), mode, sessionFills: createSessionFills() });
        const t0 = Date.now();
        const st = await lock.probe();
        const ms = Date.now() - t0;
        out.push({ n, mode, ms, locked: st.locked, filled: st.filled, unreadable: st.unreadable });
        assert.strictEqual(st.locked, true, `${n} busy frames, ${mode}: ${JSON.stringify(st)}`);
        assert.ok(st.filled >= 1, `the main frame's read counted: ${JSON.stringify(st)}`);
        assert.ok(ms < 9000, `bounded: ${ms} ms`);
      }
    }
    t.diagnostic(`A77 busy-frame probes: ${JSON.stringify(out)}`);
    process.stderr.write(`A77-BUSY ${JSON.stringify(out)}\n`);
  } finally { await closeBrave(h); }
});

test("A77 round 2 on a real Brave: a settings page's saved password LOCKS in default mode (the page-sent exception is gone — F2) and a pre-filled passenger_name does not (a ruled name exception); plain-flags locks both, exactly as before; the reviewer's show-password names (name=password1, id=passwordconfirm, type=text) lock (F1); typing, a React-style attribute mirror and a script-set value lock", ISO, async () => {
  await startServer();
  const { createLock, createSessionFills } = require("../src/plainflags-lock.js");
  const { h } = await launchPf("pf-a77r2-", "default");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    const dflt = createLock({ getContext: () => h.context, accounts: accountsFixture(), mode: "default", sessionFills: createSessionFills() });
    const plain = createLock({ getContext: () => h.context, accounts: accountsFixture() });
    await page.goto(U("www.a77settings.test", "/a77-settings"));
    const d = await dflt.probe();
    assert.deepStrictEqual([d.locked, d.filled, d.seen], [true, 1, 1], `default: the saved password locks; passenger_name is not secret: ${JSON.stringify(d)}`);
    const p = await plain.probe();
    assert.deepStrictEqual([p.locked, p.filled, p.seen], [true, 2, 2], `plain-flags exactly as before: ${JSON.stringify(p)}`);
    // default-mode probes FIRST on this document: the probe's "seen" memory lives in its isolated world, which both locks share
    // (only one mode ever drives a real Brave), so a plain-flags probe would mark passenger_name as remembered-secret
    await page.goto(U("www.a77settings.test", "/a77-names"));
    assert.strictEqual((await dflt.probe()).locked, false, "empty");
    await page.fill("#n3", "Zed Fixture");
    assert.strictEqual((await dflt.probe()).locked, false, "a filled passenger_name is not a secret in default mode");
    for (const target of ["#n1", "#passwordconfirm", "#n4", "#comPassword"]) { // round 3: ByPass… / comPass… keep their "Pass"
      await page.fill(target, PASSWORD);
      const st = await dflt.probe();
      assert.deepStrictEqual([st.locked, st.filled], [true, 1], `${target} (type=text) locks: ${JSON.stringify(st)}`);
      await page.fill(target, "");
      assert.strictEqual((await dflt.probe()).locked, false, `${target} cleared`);
    }
    assert.strictEqual((await plain.probe()).locked, true, "plain-flags: the filled passenger_name still locks");
    await page.goto(U("www.a77settings.test", "/a77-mirror"));
    await page.fill("#mpw", PASSWORD);
    assert.strictEqual(await page.getAttribute("#mpw", "value"), PASSWORD, "the page mirrored the typed value into its value attribute");
    assert.strictEqual((await dflt.probe()).locked, true, "a mirrored (React-style) typed value locks");
    await page.goto(U("www.a77settings.test", "/a77-scriptset"));
    assert.strictEqual((await dflt.probe()).locked, true, "a value set by script after load locks");
  } finally { await closeBrave(h); }
});

test("A77 round 2 (F3) on a real Brave: a JavaScript dialog open on a tab with an (empty) password field fails that tab closed — another tool is refused, but dialog_handle runs, handles the NEXT dialog and its result is returned once nothing holds the lock", ISO, async () => {
  await startServer();
  const { createLock, createSessionFills } = require("../src/plainflags-lock.js");
  const { createDefaultLockPolicy } = require("../src/default-lock.js");
  const { RelayServer } = require("../src/relay-server.js");
  const dialogHandle = require("../src/own-tools/dialog-handle.js");
  const { h } = await launchPf("pf-a77dlg-", "default");
  try {
    const page = h.context.pages()[0] || (await h.context.newPage());
    await page.goto(U("www.a77dialog.test", "/a77-dialog"));
    globalThis.__relayBridge = { context: h.context };
    setActivePage(page);
    const lock = createLock({ getContext: () => h.context, mode: "default", sessionFills: createSessionFills(), frameTimeoutMs: 800 });
    const relay = new RelayServer({ getUpstream: async () => ({ request: async () => ({ tools: [] }) }), ensureBrave: async () => {}, policy: createDefaultLockPolicy({ lock }) });
    relay.registerOwnTool(dialogHandle);
    relay.registerOwnTool({ name: "content_get-as-text", description: "", inputSchema: { type: "object" }, handler: async () => ({ content: [{ type: "text", text: "TEXT" }] }) });
    assert.ok(!(await relay.handleToolsCall({ name: "content_get-as-text", arguments: {} })).isError, "an empty password field: no lock");
    // hold the FIRST dialog open (a handler that does not answer it), let later ones go to dialog_handle
    let held = null;
    page.on("dialog", (dg) => { if (!held) held = dg; });
    await page.evaluate(() => document.getElementById("two").click());
    await waitFor(async () => held, 5000);
    assert.ok(held && held.message() === "A77-ONE");
    const refused = await relay.handleToolsCall({ name: "content_get-as-text", arguments: {} });
    assert.strictEqual(refused.isError, true, "while the dialog is open the tab fails closed");
    assert.match(refused.content[0].text, /Locked: a password or one-time code typed/);
    // dialog_handle is not refused: it waits for the next dialog; dismissing the held one lets the page open it
    const pending = relay.handleToolsCall({ name: "dialog_handle", arguments: { action: "accept", timeoutMs: 10000 } });
    await new Promise((r) => setTimeout(r, 300));
    await held.dismiss();
    const handled = await pending;
    assert.ok(!handled.isError, JSON.stringify(handled));
    assert.match(handled.content.map((c) => c.text).join(" "), /"handled": "accept"[\s\S]*A77-TWO/);
    assert.ok(!(await relay.handleToolsCall({ name: "content_get-as-text", arguments: {} })).isError, "no dialog left: unlocked");
  } finally { globalThis.__relayBridge = null; clearActivePage(); await closeBrave(h); }
});

test("A77 fix 2 e2e DEFAULT relay: the session fills single digits into six split-code boxes (which locks it — digits are never excepted), then Trevor types his code over them → LOCKED (aria snapshot refused, relay_status locked); his digits never reach a result", ISO, async () => {
  await startServer();
  const home = homeTmp("home-a77f2-");
  const proj = path.join(home, "proj-a77f2");
  const r = await startRelay({ env: { HOME: home, CLAUDE_PROJECT_DIR: proj, ...DEFAULT_RELAY_ENV() }, realUpstream: true });
  const { chromium } = require("playwright-core");
  let peek = null;
  const seen = [];
  const call = async (n, a = {}, t = 60000) => { const x = await r.call(n, a, t); seen.push(JSON.stringify(x)); return x; };
  try {
    assert.ok(!(await call("tabs_list", {}, 90000)).isError);
    const side = JSON.parse(fs.readFileSync(path.join(cacheOf(home), "profiles", slugOf(proj), ".mcp-relay-status.json"), "utf8"));
    peek = await chromium.connectOverCDP(`http://127.0.0.1:${side.cdpPort}`);
    assert.ok(!(await call("navigation_go-to", { url: U("www.a77otp.test", "/l6-otp"), includeSnapshot: false })).isError);
    const ff = await call("form_fill", { fields: Array.from({ length: 6 }, (_, i) => ({ selector: `#d${i}`, value: String(i + 1) })) });
    // single digits are not recorded (< 6 characters), so the session's own per-box fill locks itself — documented
    assert.strictEqual(ff.isError, true, ff.text.slice(0, 300));
    assert.match(ff.text, /the result of this call was withheld: the lock came on while it ran/);
    const pg = await waitFor(async () => peek.contexts()[0].pages().find((x) => x.url().includes("/l6-otp")) || null, 10000);
    const code = "531642";
    for (let i = 0; i < 6; i++) await pg.fill(`#d${i}`, code[i]);
    const snap = await call("a11y_take-aria-snapshot");
    assert.strictEqual(snap.isError, true, snap.text.slice(0, 300));
    assert.match(snap.text, /Locked: a password or one-time code typed on this page/);
    assert.strictEqual(JSON.parse((await call("relay_status")).text).lock.locked, true);
    assert.ok(seen.every((t) => !t.includes("textbox")), "no snapshot (and so none of his digits) left the relay");
  } finally {
    if (peek) await peek.close().catch(() => {});
    await r.stop();
  }
});
