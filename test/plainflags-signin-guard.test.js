// plainflags-signin-guard.test.js — the sign-in guard (spec v8 §5.6 (6)):
// login matchers (r8 #7 normalisation), layer 2 against a FAKE CDP endpoint (a
// local websocket server speaking the few CDP methods the guard uses), the
// launch clear (c), the on-arrival delete (f) and the removal diff (g).
// The same guard against a real Brave: test/isolated-plainflags.test.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const { createSigninPolicy, installSigninGuard, MARKER } = require("../src/plainflags-signin-guard.js");
const { createSigninLoader } = require("../src/plainflags-signin.js");
const jar = require("../src/cdp-cookies.js");

const ACCOUNTS = [
  { name: "fixturebank", loginMatchers: [{ host: "login.fixturebank.test" }], cookieOrigins: ["https://login.fixturebank.test"], sessionCookies: ["FBSESS"], federating: false, signsInVia: [], confirmed: true },
  { name: "fixturedesign", loginMatchers: [{ host: "www.fixturedesign.test", pathPrefixes: ["/login"] }], cookieOrigins: ["https://www.fixturedesign.test"], sessionCookies: ["FDSESS"], federating: false, signsInVia: [], confirmed: true },
];

function loaderWith(accounts) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-pfguard-")), "plainflags-signin.json");
  const write = (list) => { fs.writeFileSync(p, JSON.stringify({ accounts: list })); const t = Date.now() / 1000 + Math.random(); fs.utimesSync(p, t, t); };
  write(accounts);
  return { loader: createSigninLoader({ path: p, log: () => {} }), write };
}

// ── matchers ────────────────────────────────────────────────────────────────

test("matchers: host and host+path, normalised (case, trailing dot, %-escapes, //), /login never matches /loginx", () => {
  const { loader } = loaderWith([]);
  const p = createSigninPolicy({ accounts: ACCOUNTS, loader, verifyAsk: () => ({ ok: true }) });
  const yes = ["https://login.fixturebank.test/", "https://LOGIN.FIXTUREBANK.TEST./a?b", "http://login.fixturebank.test:8080/",
    "https://www.fixturedesign.test/login", "https://www.fixturedesign.test/LOGIN/", "https://www.fixturedesign.test//login//x", "https://www.fixturedesign.test/%6c%6Fgin"];
  const no = ["https://fixturebank.test/", "https://www.fixturedesign.test/", "https://www.fixturedesign.test/loginx", "https://www.fixturedesign.test/en/page?login=1", "about:blank", "not a url"];
  for (const u of yes) assert.ok(p.checkUrl(u), u);
  for (const u of no) assert.strictEqual(p.checkUrl(u), null, u);
  assert.deepStrictEqual(p.classify("https://login.fixturebank.test/"), { blocked: true, host: "login.fixturebank.test", account: "fixturebank" });
});

test("takeRemoved: only accounts taken OFF the list; additions and unknown names are not removals", () => {
  const { loader, write } = loaderWith([{ name: "fixturebank", askId: "a" }, { name: "unknown-acct", askId: "b" }]);
  const p = createSigninPolicy({ accounts: ACCOUNTS, loader, verifyAsk: () => ({ ok: true }) });
  assert.deepStrictEqual(p.takeRemoved(), []);
  write([{ name: "fixturedesign", askId: "c" }]);
  assert.deepStrictEqual(p.takeRemoved().map((a) => a.name), ["fixturebank"]);
  assert.deepStrictEqual(p.takeRemoved(), []);
  assert.deepStrictEqual(p.notListed().map((a) => a.name), ["fixturebank"]);
});

// ── a fake CDP endpoint ─────────────────────────────────────────────────────

async function fakeCdp(initialJar) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const st = { jar: initialJar.slice(), sent: [], cleared: [], fulfilled: [], continued: [], socket: null };
  wss.on("connection", (ws) => {
    st.socket = ws;
    ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      st.sent.push(m);
      const reply = (result) => ws.send(JSON.stringify({ id: m.id, result }));
      switch (m.method) {
        case "Target.setAutoAttach":
          reply({});
          ws.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "S1", targetInfo: { targetId: "P1", type: "page" }, waitingForDebugger: true } }));
          ws.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "W1", targetInfo: { targetId: "SW1", type: "service_worker" }, waitingForDebugger: true } }));
          return;
        case "Target.getTargets": return reply({ targetInfos: [{ targetId: "P1", type: "page" }] });
        case "Storage.getCookies": return reply({ cookies: st.jar.map((c) => ({ ...c })) });
        case "Network.deleteCookies": {
          if (m.sessionId !== "S1") return ws.send(JSON.stringify({ id: m.id, error: { message: "Network.deleteCookies wasn't found" } }));
          const p = m.params;
          st.jar = st.jar.filter((c) => !(c.name === p.name && c.domain === p.domain && (c.path || "/") === p.path &&
            jar.partitionSite(c.partitionKey) === jar.partitionSite(p.partitionKey)));
          return reply({});
        }
        case "Storage.clearDataForOrigin": st.cleared.push(m.params); return reply({});
        case "Fetch.fulfillRequest": st.fulfilled.push(m.params); return reply({});
        case "Fetch.continueRequest": st.continued.push(m.params); return reply({});
        default: return reply({});
      }
    });
  });
  const url = `ws://127.0.0.1:${wss.address().port}/devtools/browser/fake`;
  const emit = (method, params, sessionId) => st.socket.send(JSON.stringify({ method, params, sessionId }));
  return { url, st, emit, close: () => new Promise((r) => wss.close(r)) };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

const BANK = [
  { name: "FBSESS", value: "SECRET-1", domain: "login.fixturebank.test", path: "/" },
  { name: "pref", value: "SECRET-2", domain: ".fixturebank.test", path: "/" },
  { name: "chips", value: "SECRET-3", domain: "login.fixturebank.test", path: "/", partitionKey: { topLevelSite: "https://elsewhere.test", hasCrossSiteAncestor: true } },
];
const OTHER = [{ name: "keep", value: "SECRET-4", domain: "www.other.test", path: "/" }];

test("layer 2: page targets armed (Fetch Document patterns for every login host + Network); a worker is released, not kept", async () => {
  const cdp = await fakeCdp([]);
  const { loader } = loaderWith([]);
  const g = await installSigninGuard({ wsEndpoint: cdp.url, policy: createSigninPolicy({ accounts: ACCOUNTS, loader, verifyAsk: () => ({ ok: true }) }) });
  try {
    await settle();
    const fetchEnable = cdp.st.sent.filter((m) => m.method === "Fetch.enable");
    assert.strictEqual(fetchEnable.length, 1);
    assert.strictEqual(fetchEnable[0].sessionId, "S1");
    assert.deepStrictEqual(fetchEnable[0].params.patterns.map((p) => p.urlPattern).sort(), ["*://*login.fixturebank.test*", "*://*www.fixturedesign.test*"]);
    assert.ok(fetchEnable[0].params.patterns.every((p) => p.resourceType === "Document"));
    assert.ok(cdp.st.sent.some((m) => m.method === "Network.enable" && m.sessionId === "S1"));
    assert.ok(cdp.st.sent.some((m) => m.method === "Runtime.runIfWaitingForDebugger" && m.sessionId === "W1"), "the worker is resumed");
    assert.ok(cdp.st.sent.some((m) => m.method === "Target.detachFromTarget" && m.params.sessionId === "W1"));
  } finally { g.close(); await cdp.close(); }
});

test("layer 2: a top-level document to a not-listed login → the 403 route page; a subframe, a public path and a listed account continue", async () => {
  const cdp = await fakeCdp([]);
  const { loader, write } = loaderWith([]);
  const blocked = [];
  const g = await installSigninGuard({ wsEndpoint: cdp.url, policy: createSigninPolicy({ accounts: ACCOUNTS, loader, verifyAsk: () => ({ ok: true }) }), onBlocked: (h, a) => blocked.push([h, a]) });
  try {
    await settle();
    const paused = (id, url, frameId = "P1", resourceType = "Document") => cdp.emit("Fetch.requestPaused", { requestId: id, request: { url }, frameId, resourceType }, "S1");
    paused("r1", "https://login.fixturebank.test/signin");
    paused("r2", "https://login.fixturebank.test/signin", "CHILD-FRAME");
    paused("r3", "https://www.fixturedesign.test/");
    paused("r4", "https://www.fixturedesign.test/login");
    await settle();
    assert.deepStrictEqual(cdp.st.fulfilled.map((f) => f.requestId), ["r1", "r4"]);
    assert.strictEqual(cdp.st.fulfilled[0].responseCode, 403);
    assert.match(Buffer.from(cdp.st.fulfilled[0].body, "base64").toString("utf8"), new RegExp(`${MARKER}="1"`));
    assert.deepStrictEqual(cdp.st.continued.map((f) => f.requestId), ["r2", "r3"]);
    assert.deepStrictEqual(blocked, [["login.fixturebank.test", "fixturebank"], ["www.fixturedesign.test", "fixturedesign"]]);
    assert.strictEqual(g.recentlyBlocked("https://login.fixturebank.test/signin#x"), true, "one token per block, fragment ignored");
    assert.strictEqual(g.recentlyBlocked("https://login.fixturebank.test/signin"), false);
    write([{ name: "fixturebank", askId: "a" }]);
    paused("r5", "https://login.fixturebank.test/signin");
    await settle();
    assert.ok(cdp.st.continued.some((f) => f.requestId === "r5"), "listed → loads");
  } finally { g.close(); await cdp.close(); }
});

test("(c) clearAccounts: every cookie of the account's origins — domain-level and PARTITIONED copies included — and all its storage; other sites untouched", async () => {
  const cdp = await fakeCdp([...BANK, ...OTHER]);
  const { loader } = loaderWith([]);
  const policy = createSigninPolicy({ accounts: ACCOUNTS, loader, verifyAsk: () => ({ ok: true }) });
  const g = await installSigninGuard({ wsEndpoint: cdp.url, policy });
  try {
    await settle();
    const out = await g.clearAccounts(policy.notListed(), "launch");
    assert.deepStrictEqual(out.map((o) => [o.account, o.cookies, o.errors.length]), [["fixturebank", 3, 0], ["fixturedesign", 0, 0]]);
    assert.deepStrictEqual(cdp.st.jar.map((c) => c.name), ["keep"]);
    assert.deepStrictEqual(cdp.st.cleared, [
      { origin: "https://login.fixturebank.test", storageTypes: "all" },
      { origin: "https://www.fixturedesign.test", storageTypes: "all" },
    ]);
    assert.ok(cdp.st.sent.filter((m) => m.method === "Network.deleteCookies").every((m) => m.sessionId === "S1"), "deletes go through a page session");
    assert.ok(cdp.st.sent.some((m) => m.method === "Network.deleteCookies" && m.params.partitionKey && m.params.partitionKey.topLevelSite === "https://elsewhere.test"));
  } finally { g.close(); await cdp.close(); }
});

test("(f) on arrival: a Set-Cookie of a NAMED session cookie of a not-listed account → deleted + its origins cleared, logged by name; a listed account's survives", async () => {
  const cdp = await fakeCdp([...BANK, ...OTHER]);
  const { loader, write } = loaderWith([]);
  const policy = createSigninPolicy({ accounts: ACCOUNTS, loader, verifyAsk: () => ({ ok: true }) });
  const clearedNames = [];
  const logs = [];
  const g = await installSigninGuard({ wsEndpoint: cdp.url, policy, onCleared: (n) => clearedNames.push(n), log: (m) => logs.push(m) });
  try {
    await settle();
    cdp.emit("Network.responseReceivedExtraInfo", { requestId: "x", headers: { "content-type": "text/html", "set-cookie": "other=1; Path=/" } }, "S1");
    await settle();
    assert.strictEqual(g.stats.cookieEvents, 0, "an unwatched cookie name triggers nothing");
    cdp.emit("Network.responseReceivedExtraInfo", { requestId: "y", headers: { "Set-Cookie": "a=1\nFBSESS=zzz; Path=/; HttpOnly" } }, "S1");
    await settle();
    await settle();
    assert.strictEqual(g.stats.cookieEvents, 1);
    assert.ok(!cdp.st.jar.some((c) => c.name === "FBSESS"), "the session cookie is gone");
    assert.deepStrictEqual(clearedNames, ["fixturebank"]);
    assert.ok(logs.some((l) => /cleared fixturebank \(session cookie arrived\)/.test(l)));
    assert.ok(!logs.join("\n").includes("SECRET"), "never a value");
    // a listed account's session cookie survives the sweep
    cdp.st.jar.push({ name: "FBSESS", value: "SECRET-5", domain: "login.fixturebank.test", path: "/" });
    write([{ name: "fixturebank", askId: "a" }]);
    assert.deepStrictEqual(await g.sweep(), []);
    assert.ok(cdp.st.jar.some((c) => c.name === "FBSESS"));
  } finally { g.close(); await cdp.close(); }
});

test("(f) backstop: the per-call sweep deletes a session cookie the page session never saw arrive (an iframe / worker set it — r8 #5)", async () => {
  const cdp = await fakeCdp([{ name: "FDSESS", value: "SECRET-6", domain: ".fixturedesign.test", path: "/" }, ...OTHER]);
  const { loader } = loaderWith([]);
  const g = await installSigninGuard({ wsEndpoint: cdp.url, policy: createSigninPolicy({ accounts: ACCOUNTS, loader, verifyAsk: () => ({ ok: true }) }) });
  try {
    await settle();
    assert.deepStrictEqual(await g.sweep(), ["fixturedesign"]);
    assert.deepStrictEqual(cdp.st.jar.map((c) => c.name), ["keep"]);
  } finally { g.close(); await cdp.close(); }
});

// ── round 1 item 3: unconfirmed accounts fail closed ────────────────────────

test("round 1 item 3: an UNCONFIRMED account — ANY cookie on its login hosts is a session cookie (Cloudflare's three names excepted); a confirmed one: named only", () => {
  const { sessionCookieRule, KNOWN_ACCOUNTS, matchLoginUrl } = require("../src/known-accounts.js");
  const unconf = { ...ACCOUNTS[1], confirmed: false, sessionCookies: [] };
  const conf = { ...ACCOUNTS[1], confirmed: true };
  const cookies = [
    { name: "anything", domain: "www.fixturedesign.test", path: "/" },
    { name: "domainwide", domain: ".fixturedesign.test", path: "/" },
    { name: "cf_clearance", domain: ".fixturedesign.test", path: "/" },
    { name: "__cf_bm", domain: "www.fixturedesign.test", path: "/" },
    { name: "FDSESS", domain: "www.fixturedesign.test", path: "/" },
    { name: "other", domain: "cdn.fixturedesign.test", path: "/" },
  ];
  assert.strictEqual(sessionCookieRule(unconf), "any-on-login-hosts");
  assert.strictEqual(sessionCookieRule(conf), "named");
  assert.deepStrictEqual(jar.accountSessionCookies(cookies, unconf).map((c) => c.name).sort(), ["FDSESS", "anything", "domainwide"]);
  assert.deepStrictEqual(jar.accountSessionCookies(cookies, conf).map((c) => c.name), ["FDSESS"]);
  assert.strictEqual(jar.setCookieWatched(unconf, new Set(["whatever"])), true);
  assert.strictEqual(jar.setCookieWatched(unconf, new Set(["cf_clearance", "__cf_bm"])), false, "a Cloudflare cookie never triggers a sweep");
  assert.strictEqual(jar.setCookieWatched(conf, new Set(["whatever"])), false);
  // every shipped entry is still unconfirmed → all fail closed
  for (const a of KNOWN_ACCOUNTS) assert.strictEqual(sessionCookieRule(a), "any-on-login-hosts", a.name);
  // Trevor's white-label HighLevel host (ask as-ops/ask-akpnud), same treatment as app.gohighlevel.com
  const hl = KNOWN_ACCOUNTS.find((a) => a.name === "highlevel");
  assert.strictEqual(matchLoginUrl("https://app.myautomatedbiz.com/").account.name, "highlevel");
  assert.ok(hl.cookieOrigins.includes("https://app.myautomatedbiz.com"));
  assert.deepStrictEqual(jar.accountSessionCookies([{ name: "a", domain: "app.myautomatedbiz.com", path: "/" }], hl).map((c) => c.name), ["a"]);
});

test("round 1 item 3: the sweep deletes an UNCONFIRMED account's ordinary cookie on its login host, keeps its cf_clearance", async () => {
  const unconf = [{ ...ACCOUNTS[0], confirmed: false, sessionCookies: [] }];
  const cdp = await fakeCdp([
    { name: "prefs", value: "SECRET-7", domain: "login.fixturebank.test", path: "/" },
    { name: "cf_clearance", value: "SECRET-8", domain: ".fixturebank.test", path: "/" },
    ...OTHER,
  ]);
  const { loader } = loaderWith([]);
  const g = await installSigninGuard({ wsEndpoint: cdp.url, policy: createSigninPolicy({ accounts: unconf, loader, verifyAsk: () => ({ ok: true }) }) });
  try {
    await settle();
    cdp.emit("Network.responseReceivedExtraInfo", { requestId: "z", headers: { "set-cookie": "prefs=1" } }, "S1");
    await settle(); await settle();
    assert.strictEqual(g.stats.cookieEvents, 1, "any non-Cloudflare Set-Cookie triggers the sweep");
    assert.ok(!cdp.st.jar.some((c) => c.name === "prefs"), "the ordinary cookie went");
    assert.ok(cdp.st.jar.some((c) => c.name === "cf_clearance"), "the site's Cloudflare clearance survives the sweep");
    assert.deepStrictEqual(cdp.st.cleared.map((c) => c.storageTypes), ["file_systems,indexeddb,local_storage,websql,service_workers,cache_storage"], "storage cleared, cookies left to the explicit deletes");
    assert.ok(cdp.st.jar.some((c) => c.name === "keep"));
  } finally { g.close(); await cdp.close(); }
});

// ── round 2 items 6 and 7 ───────────────────────────────────────────────────

test("round 2 item 7: cf_chl_* cookies are Cloudflare's too — never a session cookie, never a sweep trigger", () => {
  const { isCloudflareCookie } = require("../src/known-accounts.js");
  for (const n of ["cf_clearance", "__cf_bm", "_cfuvid", "cf_chl_rc_m", "cf_chl_2"]) assert.strictEqual(isCloudflareCookie(n), true, n);
  for (const n of ["xcf_chl_", "session", "cf_clearance2"]) assert.strictEqual(isCloudflareCookie(n), false, n);
  const unconf = { ...ACCOUNTS[1], confirmed: false, sessionCookies: [] };
  assert.deepStrictEqual(jar.accountSessionCookies([{ name: "cf_chl_rc_m", domain: "www.fixturedesign.test", path: "/" }], unconf), []);
  assert.strictEqual(jar.setCookieWatched(unconf, new Set(["cf_chl_rc_m"])), false);
});

test("round 2 item 6: a Set-Cookie counts only from the account's own hosts; an unknown request URL fails closed", () => {
  const unconf = { ...ACCOUNTS[1], confirmed: false, sessionCookies: [] };
  const names = new Set(["any"]);
  assert.strictEqual(jar.setCookieWatched(unconf, names, ["www.fixturedesign.test"]), true);
  assert.strictEqual(jar.setCookieWatched(unconf, names, ["cdn.www.fixturedesign.test"]), true, "a subdomain of one of its hosts");
  assert.strictEqual(jar.setCookieWatched(unconf, names, ["tracker.example"]), false);
  assert.strictEqual(jar.setCookieWatched(unconf, names, ["tracker.example", "www.fixturedesign.test"]), true, "any hop of a redirect chain");
  assert.strictEqual(jar.setCookieWatched(unconf, names, null), true, "URL never seen → relevant");
});

test("round 2 item 6 (guard): the Set-Cookie is judged by the response host from Network.requestWillBeSent", async () => {
  const cdp = await fakeCdp([{ name: "x", value: "SECRET-9", domain: "login.fixturebank.test", path: "/" }]);
  const { loader } = loaderWith([]);
  const g = await installSigninGuard({ wsEndpoint: cdp.url, policy: createSigninPolicy({ accounts: [{ ...ACCOUNTS[0], confirmed: false, sessionCookies: [] }], loader, verifyAsk: () => ({ ok: true }) }) });
  try {
    await settle();
    cdp.emit("Network.requestWillBeSent", { requestId: "R1", request: { url: "https://tracker.example/p" } }, "S1");
    cdp.emit("Network.responseReceivedExtraInfo", { requestId: "R1", headers: { "set-cookie": "t=1" } }, "S1");
    await settle();
    assert.strictEqual(g.stats.cookieEvents, 0, "another host's cookie does not trigger");
    cdp.emit("Network.requestWillBeSent", { requestId: "R2", request: { url: "https://login.fixturebank.test/x" } }, "S1");
    cdp.emit("Network.responseReceivedExtraInfo", { requestId: "R2", headers: { "set-cookie": "s=1" } }, "S1");
    await settle(); await settle();
    assert.strictEqual(g.stats.cookieEvents, 1);
    assert.ok(!cdp.st.jar.some((c) => c.name === "x"));
  } finally { g.close(); await cdp.close(); }
});

test("round 2 item 6 (guard): a sweep makes at most 3 passes however often cookies keep arriving; round 3 G: a caller that joined during the LAST pass gets exactly one more pass", async () => {
  const cdp = await fakeCdp([]);
  const { loader } = loaderWith([]);
  const g = await installSigninGuard({ wsEndpoint: cdp.url, policy: createSigninPolicy({ accounts: ACCOUNTS, loader, verifyAsk: () => ({ ok: true }) }) });
  try {
    await settle();
    const before = g.stats.sweeps;
    // every Storage.getCookies of the FIRST sweep "sees" another arrival → a join
    let joins = 0;
    const joined = [];
    const origSend = g._conn.send.bind(g._conn);
    g._conn.send = (m, p, sid) => { if (m === "Storage.getCookies" && joins < 3) { joins++; joined.push(g.sweep()); } return origSend(m, p, sid); };
    const first = g.sweep();
    const passesOfFirst = await first.then(() => g.stats.sweeps - before);
    assert.strictEqual(passesOfFirst, 3, "capped at 3 passes");
    await Promise.all(joined);
    assert.strictEqual(g.stats.sweeps - before, 4, "the caller that joined during pass 3 got one more pass, and no more");
    assert.notStrictEqual(joined[2], first, "the last-pass joiner waits for the extra pass, not the capped sweep");
  } finally { g.close(); await cdp.close(); }
});

test("round 3 G: a CDP send the sweep makes that never answers fails the sweep within sendTimeoutMs (fail closed)", async () => {
  const cdp = await fakeCdp([]);
  const { loader } = loaderWith([]);
  const g = await installSigninGuard({ wsEndpoint: cdp.url, sendTimeoutMs: 200, policy: createSigninPolicy({ accounts: ACCOUNTS, loader, verifyAsk: () => ({ ok: true }) }) });
  try {
    await settle();
    const origSend = g._conn.send.bind(g._conn);
    g._conn.send = (m, p, sid) => (m === "Storage.getCookies" ? new Promise(() => {}) : origSend(m, p, sid));
    const t0 = Date.now();
    await assert.rejects(g.sweep(), /no answer within 200 ms/);
    assert.ok(Date.now() - t0 < 2000);
  } finally { g.close(); await cdp.close(); }
});
