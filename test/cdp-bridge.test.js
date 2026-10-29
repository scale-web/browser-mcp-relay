const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { closeBrave } = require("../src/cdp-bridge.js");

// launchBrave really deletes <udd>/Default/Sessions, so unit tests must not point
// it at a shared literal path like /tmp/x — that is an unstubbed destructive side
// effect in a test whose browser is fully mocked.
const SAFE_UDD = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-bridge-udd-"));
process.on("exit", () => { try { fs.rmSync(SAFE_UDD, { recursive: true, force: true }); } catch {} });

// ─────────────────── Unit tests via chromium mock ────────────────────
//
// Captures the launchOpts that launchBrave passes to launchPersistentContext.
// Bypasses the real Brave launch (too slow/flaky for unit tests) and asserts
// the launch shape is correct. Each test isolates the require cache + restores.
//
// Since spec v4 §1b launchBrave reads the port back from
// <udd>/DevToolsActivePort and proves it with /json/version, so the mock does
// what a port-0 Brave does: writes the file at launch and answers
// /json/version with the same browser uuid.
const MOCK_PORT = 54321;
const MOCK_UUID = "11111111-2222-3333-4444-555555555555";

function writeMockActivePort(userDataDir, uuid = MOCK_UUID) {
  fs.writeFileSync(path.join(userDataDir, "DevToolsActivePort"), `${MOCK_PORT}\n/devtools/browser/${uuid}`);
}

function mockJsonVersion(uuid = MOCK_UUID) {
  return async () => ({
    ok: true,
    json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:${MOCK_PORT}/devtools/browser/${uuid}` }),
  });
}

// Stub for the `ws` module: records every socket the first-window path opens
// and answers each CDP call from `replies` (an error object, a result,
// { connectError } to fail the connection, { noReply }, { closeWithoutReply },
// or { junkFirst } to send another id's reply first), so no unit test
// ever opens a real socket.
function installWsStub(replies = []) {
  const { EventEmitter } = require("node:events");
  const wsPath = require.resolve("ws");
  const orig = require.cache[wsPath];
  const sockets = [];
  class FakeWs extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.sent = [];
      sockets.push(this);
      this.reply = replies[sockets.length - 1] || { result: { targetId: "T" } };
      if (this.reply.connectError) setImmediate(() => this.emit("error", new Error(this.reply.connectError)));
      else setImmediate(() => this.emit("open"));
    }
    send(data) {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      if (this.reply.noReply) return;
      if (this.reply.closeWithoutReply) { setImmediate(() => this.emit("close")); return; }
      if (this.reply.junkFirst) {
        setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({ id: 999, error: { message: "not yours" } }))));
      }
      setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({ id: msg.id, ...this.reply }))));
    }
    terminate() { this.terminated = true; }
  }
  require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: FakeWs };
  return {
    sockets,
    restore() { if (orig) require.cache[wsPath] = orig; else delete require.cache[wsPath]; },
  };
}

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

async function withMockChromium(fn) {
  const playwrightCorePath = require.resolve("playwright-core");
  const cdpBridgePath = require.resolve("../src/cdp-bridge.js");
  const origPlaywright = require.cache[playwrightCorePath];
  const origCdpBridge = require.cache[cdpBridgePath];
  const wsStub = installWsStub();
  const captured = { userDataDir: null, launchOpts: null, ws: wsStub.sockets };
  // Stub module
  require.cache[playwrightCorePath] = {
    id: playwrightCorePath,
    filename: playwrightCorePath,
    loaded: true,
    exports: {
      chromium: {
        launchPersistentContext: async (userDataDir, launchOpts) => {
          captured.userDataDir = userDataDir;
          captured.launchOpts = launchOpts;
          writeMockActivePort(userDataDir);
          return { close: async () => {} };
        },
      },
    },
  };
  // Reset cdp-bridge so it picks up the stubbed chromium.
  delete require.cache[cdpBridgePath];
  // Stub fetch: /json/version names the uuid the mock wrote.
  const origFetch = global.fetch;
  global.fetch = mockJsonVersion();
  try {
    const fresh = require("../src/cdp-bridge.js");
    const out = await fn(fresh, captured);
    // Let a detached first-window call finish under the stubs, not after them.
    await new Promise((r) => setTimeout(r, 100));
    return out;
  } finally {
    if (origPlaywright) require.cache[playwrightCorePath] = origPlaywright;
    else delete require.cache[playwrightCorePath];
    if (origCdpBridge) require.cache[cdpBridgePath] = origCdpBridge;
    else delete require.cache[cdpBridgePath];
    global.fetch = origFetch;
    wsStub.restore();
  }
}

test("launchBrave: ignoreDefaultArgs always includes --use-mock-keychain", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: SAFE_UDD,
      port: 9999,
      headless: false,
      executablePath: "/fake/brave",
    });
    assert.ok(Array.isArray(captured.launchOpts.ignoreDefaultArgs));
    assert.ok(
      captured.launchOpts.ignoreDefaultArgs.includes("--use-mock-keychain"),
      "expected --use-mock-keychain in ignoreDefaultArgs",
    );
  });
});

test("launchBrave: when extensionPath is set, ignoreDefaultArgs also includes --disable-extensions", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: SAFE_UDD,
      port: 9999,
      executablePath: "/fake/brave",
      extensionPath: "/fake/ext",
    });
    assert.ok(captured.launchOpts.ignoreDefaultArgs.includes("--use-mock-keychain"));
    assert.ok(captured.launchOpts.ignoreDefaultArgs.includes("--disable-extensions"));
  });
});

// SUPERSEDED 2026-08-25. This asserted `ignoreHTTPSErrors === true` with no
// proxy — encoding the always-on TLS bypass as intended behaviour, which is why
// the exposure survived review. The contract is now opt-in; see the
// "TLS-cert acceptance is OPT-IN" block at the end of this file for the
// default-validates / proxy / env-override / falsy-string cases.
test("launchBrave: ignoreHTTPSErrors is NOT enabled without opt-in", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: SAFE_UDD,
      port: 9999,
      executablePath: "/fake/brave",
    });
    assert.strictEqual(captured.launchOpts.ignoreHTTPSErrors, false);
  });
});

test("W0-7: launchBrave with proxyUrl=null still strips BROWSER_RELAY_* from env", async () => {
  // Pre-W0-7: when proxyUrl was null, no `env` was set on launchOpts and
  // Playwright passed process.env wholesale (BROWSER_RELAY_* leaked).
  // Post-W0-7: env is always sanitized; BROWSER_RELAY_* never reaches Brave.
  //
  // F1-20 fixup (2026-05-10): also stash + clear HTTP_PROXY / HTTPS_PROXY
  // so the test passes on developer machines that have a system-wide HTTP
  // proxy set (e.g. powhttp debug proxy at 127.0.0.1:8888). Without this,
  // process.env.HTTP_PROXY leaks through the relay's
  // `for (k of Object.entries(process.env))` env copy and the assertion
  // `env.HTTP_PROXY === undefined` fires on a perfectly working relay.
  // CI runners don't have this env var → test passes there. CLAUDE.md
  // anti-pattern: "tests that pass on my env state."
  const stashed = {
    BROWSER_RELAY_INSPECTOR_PORT: process.env.BROWSER_RELAY_INSPECTOR_PORT,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
  };
  process.env.BROWSER_RELAY_INSPECTOR_PORT = "9091";
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  try {
    await withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({
        userDataDir: SAFE_UDD,
        port: 9999,
        executablePath: "/fake/brave",
        proxyUrl: null,
      });
      assert.ok(captured.launchOpts.env, "env must be set even without proxy (W0-7)");
      assert.strictEqual(captured.launchOpts.env.BROWSER_RELAY_INSPECTOR_PORT, undefined,
        "BROWSER_RELAY_* must NEVER reach the spawned Brave");
      // No HTTP_PROXY when proxy is unset (and no host-env HTTP_PROXY leaked).
      assert.strictEqual(captured.launchOpts.env.HTTP_PROXY, undefined);
    });
  } finally {
    for (const [k, v] of Object.entries(stashed)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("launchBrave: proxyUrl set → HTTP_PROXY + HTTPS_PROXY in launchOpts.env", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: SAFE_UDD,
      port: 9999,
      executablePath: "/fake/brave",
      proxyUrl: "http://127.0.0.1:8888",
    });
    assert.ok(captured.launchOpts.env, "expected env to be set");
    assert.strictEqual(captured.launchOpts.env.HTTP_PROXY, "http://127.0.0.1:8888");
    assert.strictEqual(captured.launchOpts.env.HTTPS_PROXY, "http://127.0.0.1:8888");
  });
});

// V2-7: BROWSER_RELAY_* env vars are relay-internal — Brave shouldn't see them.
test("V2-7: launchBrave with proxyUrl strips BROWSER_RELAY_* env from spawned Brave", async () => {
  // Stash + set test env vars before triggering launchBrave.
  const stash = {};
  const testKeys = ["BROWSER_RELAY_INSPECTOR_PORT", "BROWSER_RELAY_VAULT_FILES", "BROWSER_RELAY_BRAVE_PATH"];
  for (const k of testKeys) {
    stash[k] = process.env[k];
    process.env[k] = "test-value-" + k;
  }
  process.env.PATH = process.env.PATH || "/usr/bin"; // make sure PATH passes through
  try {
    await withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({
        userDataDir: SAFE_UDD,
        port: 9999,
        executablePath: "/fake/brave",
        proxyUrl: "http://127.0.0.1:8888",
      });
      const env = captured.launchOpts.env;
      assert.ok(env, "env must be set with proxyUrl");
      // Critical: BROWSER_RELAY_* must NOT leak.
      for (const k of testKeys) {
        assert.strictEqual(env[k], undefined, `expected BROWSER_RELAY_* var ${k} to be stripped from Brave env`);
      }
      // Sanity: PATH still passes through. Case-insensitive lookup because
      // on Windows, process.env preserves key casing as `Path` (or rarely
      // `path`) — and the relay's `for (k of Object.entries(process.env))`
      // copy preserves whatever case the OS gave us. Locally on Win
      // git-bash it usually surfaces as PATH; on a fresh GitHub Actions
      // windows-latest pwsh runner it surfaces as Path. Either is correct.
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
      assert.ok(pathKey, `expected PATH to pass through to Brave (got keys: ${Object.keys(env).slice(0, 10).join(", ")}...)`);
      assert.ok(env[pathKey] && env[pathKey].length > 0, "PATH must have a non-empty value");
      // Sanity: proxy still set.
      assert.strictEqual(env.HTTP_PROXY, "http://127.0.0.1:8888");
    });
  } finally {
    for (const k of testKeys) {
      if (stash[k] === undefined) delete process.env[k];
      else process.env[k] = stash[k];
    }
  }
});

// The real-Brave round trip (launch + connect + identity) lives in
// test/isolated/real-brave.test.js: it needs the isolated harness
// (scripts/test-harness.js) so the test Brave keeps the mock keychain.

// ──────────────────────────────────────────────────────────────────
// V0-3 → spec v4 §1b: launchBrave must close the BrowserContext when it
// cannot PROVE the CDP endpoint is this Brave (the file never appears, or
// /json/version names a different browser). Otherwise the live context
// (with its file lock on userDataDir) leaks, and — worse — a mismatch means
// 127.0.0.1:<port> is somebody else's browser (F9).
// ──────────────────────────────────────────────────────────────────

async function launchExpectingFailure({ writeFile, fetchImpl, expect }) {
  const playwrightCorePath = require.resolve("playwright-core");
  const cdpBridgePath = require.resolve("../src/cdp-bridge.js");
  const origPlaywright = require.cache[playwrightCorePath];
  const origCdpBridge = require.cache[cdpBridgePath];
  const origFetch = global.fetch;
  const wsStub = installWsStub();
  let closeCalls = 0;
  require.cache[playwrightCorePath] = {
    id: playwrightCorePath,
    filename: playwrightCorePath,
    loaded: true,
    exports: {
      chromium: {
        launchPersistentContext: async (udd) => {
          if (writeFile) writeFile(udd);
          return { close: async () => { closeCalls++; } };
        },
      },
    },
  };
  delete require.cache[cdpBridgePath];
  global.fetch = fetchImpl;
  try {
    const fresh = require("../src/cdp-bridge.js");
    await assert.rejects(fresh.launchBrave({ userDataDir: SAFE_UDD, executablePath: "/fake/brave" }), expect);
    assert.strictEqual(closeCalls, 1, "context.close() must fire exactly once on the way out");
    // The first-window path must never talk to a port it could not prove.
    await new Promise((r) => setTimeout(r, 1200));
    assert.strictEqual(wsStub.sockets.length, 0, "no CDP socket may open when the port is unproven");
  } finally {
    if (origPlaywright) require.cache[playwrightCorePath] = origPlaywright;
    else delete require.cache[playwrightCorePath];
    if (origCdpBridge) require.cache[cdpBridgePath] = origCdpBridge;
    else delete require.cache[cdpBridgePath];
    global.fetch = origFetch;
    wsStub.restore();
    fs.rmSync(path.join(SAFE_UDD, "DevToolsActivePort"), { force: true });
  }
}

test("V0-3/§1b: launchBrave closes the context when /json/version names a DIFFERENT browser", async () => {
  await launchExpectingFailure({
    writeFile: (udd) => writeMockActivePort(udd, MOCK_UUID),
    fetchImpl: mockJsonVersion("99999999-8888-7777-6666-555555555555"),
    expect: /identity check failed/,
  });
});

test("V0-3/§1b: launchBrave closes the context when /json/version does not answer", async () => {
  await launchExpectingFailure({
    writeFile: (udd) => writeMockActivePort(udd),
    fetchImpl: async () => ({ ok: false, status: 503 }),
    expect: /identity check failed/,
  });
});

test("V0-3/§1b: launchBrave closes the context when DevToolsActivePort never appears (3 s deadline)", async () => {
  await launchExpectingFailure({
    writeFile: null,
    fetchImpl: mockJsonVersion(),
    expect: /did not appear/,
  });
});

test("§1b: launchBrave deletes a leftover DevToolsActivePort BEFORE launching", async () => {
  // A stale file naming a live decoy must never be read back: the mock Brave
  // here writes nothing, so if the stale file survived, launchBrave would
  // "verify" the decoy (fetch answers for its uuid) and succeed.
  const stale = "22222222-3333-4444-5555-666666666666";
  writeMockActivePort(SAFE_UDD, stale);
  await launchExpectingFailure({
    writeFile: null,
    fetchImpl: mockJsonVersion(stale),
    expect: /did not appear/,
  });
});

test("§1b: launchBrave passes --remote-debugging-port=0 and returns the proven port + ws endpoint", async () => {
  await withMockChromium(async (fresh, captured) => {
    const h = await fresh.launchBrave({ userDataDir: SAFE_UDD, executablePath: "/fake/brave" });
    assert.ok(captured.launchOpts.args.includes("--remote-debugging-port=0"));
    assert.ok(!captured.launchOpts.args.some((a) => a.startsWith("--remote-debugging-address")));
    assert.strictEqual(h.port, MOCK_PORT);
    assert.strictEqual(h.wsEndpoint, `ws://127.0.0.1:${MOCK_PORT}/devtools/browser/${MOCK_UUID}`);
    assert.strictEqual(h.cdpConnectUrl, `http://127.0.0.1:${MOCK_PORT}`);
  });
});

test("§1b: launchBrave refuses a non-absolute userDataDir before launching", async () => {
  await withMockChromium(async (fresh, captured) => {
    await assert.rejects(fresh.launchBrave({ userDataDir: "relative/dir" }), /non-absolute/);
    assert.strictEqual(captured.launchOpts, null, "must not launch");
  });
});

test("§1e: launchBrave strips CLAUDE_CODE_MESSAGING_* from Brave's env", async () => {
  const stash = { s: process.env.CLAUDE_CODE_MESSAGING_SOCKET, t: process.env.CLAUDE_CODE_MESSAGING_TOKEN };
  process.env.CLAUDE_CODE_MESSAGING_SOCKET = "/tmp/fake.sock";
  process.env.CLAUDE_CODE_MESSAGING_TOKEN = "fake-token";
  try {
    await withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({ userDataDir: SAFE_UDD, executablePath: "/fake/brave" });
      const keys = Object.keys(captured.launchOpts.env).filter((k) => k.startsWith("CLAUDE_CODE_MESSAGING_"));
      assert.deepStrictEqual(keys, []);
    });
  } finally {
    if (stash.s === undefined) delete process.env.CLAUDE_CODE_MESSAGING_SOCKET; else process.env.CLAUDE_CODE_MESSAGING_SOCKET = stash.s;
    if (stash.t === undefined) delete process.env.CLAUDE_CODE_MESSAGING_TOKEN; else process.env.CLAUDE_CODE_MESSAGING_TOKEN = stash.t;
  }
});

// ── the session-restore fix must be WIRED IN, not merely present ────────────
// Regression guard added after review: session-restore.test.js exercises
// clearSessionRestore() directly, so deleting the CALL SITE in launchBrave left
// all of its tests passing (demonstrated by mutation — 9/9 green with the fix
// removed). These two assert on launchBrave's observable effect instead, so a
// revert of the call site fails the suite.

test("launchBrave: deletes the profile's session store before launching", async () => {
  await withMockChromium(async (fresh, captured) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-clears-"));
    const sessions = path.join(dir, "Default", "Sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "Session_1"), "tabstate");
    fs.writeFileSync(path.join(dir, "Default", "Cookies"), "COOKIE-SENTINEL");
    try {
      // Pin a REAL env var: clearSessionRestore now reads local-config.json, and a
      // developer who sets BROWSER_RELAY_KEEP_TABS there — which docs/REFERENCE.md
      // explicitly tells operators to do — would otherwise fail this test.
      // applyLocalConfigToEnv only fills absent keys, so process.env wins.
      const origKeep = process.env.BROWSER_RELAY_KEEP_TABS;
      process.env.BROWSER_RELAY_KEEP_TABS = "0";
      try {
        await fresh.launchBrave({ userDataDir: dir, port: 9999 });
      } finally {
        if (origKeep === undefined) delete process.env.BROWSER_RELAY_KEEP_TABS;
        else process.env.BROWSER_RELAY_KEEP_TABS = origKeep;
      }
      assert.strictEqual(captured.userDataDir, dir, "sanity: launch actually happened");
      assert.strictEqual(fs.existsSync(sessions), false, "launchBrave must clear Default/Sessions");
      assert.strictEqual(
        fs.readFileSync(path.join(dir, "Default", "Cookies"), "utf8"), "COOKIE-SENTINEL",
        "launchBrave must not touch credential files",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("launchBrave: BROWSER_RELAY_KEEP_TABS=1 in the process env preserves the session store", async () => {
  await withMockChromium(async (fresh) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-keeps-"));
    const sessions = path.join(dir, "Default", "Sessions");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, "Session_1"), "tabstate");
    const orig = process.env.BROWSER_RELAY_KEEP_TABS;
    process.env.BROWSER_RELAY_KEEP_TABS = "1";
    try {
      await fresh.launchBrave({ userDataDir: dir, port: 9999 });
      assert.ok(fs.existsSync(sessions), "opt-out must survive a real launchBrave call");
    } finally {
      if (orig === undefined) delete process.env.BROWSER_RELAY_KEEP_TABS;
      else process.env.BROWSER_RELAY_KEEP_TABS = orig;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// TLS-cert acceptance is OPT-IN (2026-08-25).
// Regression guard: ignoreHTTPSErrors was `true` UNCONDITIONALLY, so every relay
// browser silently accepted forged certs with no proxy configured — while
// docs/REFERENCE.md claimed it applied only "when a proxy is set". These
// contexts drive authenticated sessions, so an always-on bypass is a standing
// silent-MITM exposure. The first test is the security property; the rest keep
// the legitimate MITM-debug and corporate-CA paths working.
// ---------------------------------------------------------------------------

async function launchWithEnv(fresh, captured, { proxyUrl = null, insecure } = {}) {
  const prev = process.env.BROWSER_RELAY_INSECURE_TLS;
  if (insecure === undefined) delete process.env.BROWSER_RELAY_INSECURE_TLS;
  else process.env.BROWSER_RELAY_INSECURE_TLS = insecure;
  try {
    await fresh.launchBrave({
      userDataDir: SAFE_UDD, port: 9999, headless: false,
      executablePath: "/fake/brave", proxyUrl,
    });
    return captured.launchOpts.ignoreHTTPSErrors;
  } finally {
    if (prev === undefined) delete process.env.BROWSER_RELAY_INSECURE_TLS;
    else process.env.BROWSER_RELAY_INSECURE_TLS = prev;
  }
}

test("launchBrave: TLS certs are VALIDATED by default (no proxy, no override)", async () => {
  await withMockChromium(async (fresh, captured) => {
    const v = await launchWithEnv(fresh, captured);
    assert.strictEqual(v, false, "default must NOT accept arbitrary TLS certs");
  });
});

test("launchBrave: a configured proxy opts into accepting its MITM cert", async () => {
  await withMockChromium(async (fresh, captured) => {
    const v = await launchWithEnv(fresh, captured, { proxyUrl: "http://127.0.0.1:8888" });
    assert.strictEqual(v, true, "proxy implies a MITM cert — must accept");
  });
});

test("launchBrave: BROWSER_RELAY_INSECURE_TLS=1 overrides with no proxy (corporate CA)", async () => {
  await withMockChromium(async (fresh, captured) => {
    const v = await launchWithEnv(fresh, captured, { insecure: "1" });
    assert.strictEqual(v, true);
  });
});

// "0" and "false" are TRUTHY strings in JS. A naive Boolean(env) gate would
// silently enable the bypass for someone explicitly disabling it — the same
// class of bug as DISABLE_AUTOUPDATER="false" reading as ON.
for (const off of ["0", "false", ""]) {
  test(`launchBrave: BROWSER_RELAY_INSECURE_TLS=${JSON.stringify(off)} does NOT enable the bypass`, async () => {
    await withMockChromium(async (fresh, captured) => {
      const v = await launchWithEnv(fresh, captured, { insecure: off });
      assert.strictEqual(v, false, `${JSON.stringify(off)} must read as OFF`);
    });
  });
}

// ──────────────────────────────────────────────────────────────────
// 2026-10-29: a headful launch opens its first window in the BACKGROUND
// (no startup window + CDP Target.createTarget background:true), because
// Chromium's startup window activates Brave and pulls a full-screen user out
// of their Space. Headless launches are unchanged.
// ──────────────────────────────────────────────────────────────────

test("first window: headful launch passes --no-startup-window and drops about:blank", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({ userDataDir: SAFE_UDD, executablePath: "/fake/brave" });
    assert.ok(captured.launchOpts.args.includes("--no-startup-window"));
    assert.ok(captured.launchOpts.ignoreDefaultArgs.includes("about:blank"));
    // This mock's launch returns at once (as if a page already existed), so
    // no extra window may be opened after it.
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(captured.ws.length, 0);
  });
});

test("first window: headless launch is unchanged (no flag, about:blank kept, no CDP call)", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({ userDataDir: SAFE_UDD, executablePath: "/fake/brave", headless: true });
    assert.ok(!captured.launchOpts.args.includes("--no-startup-window"));
    assert.ok(!captured.launchOpts.ignoreDefaultArgs.includes("about:blank"));
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(captured.ws.length, 0);
  });
});

async function withFirstWindowStubs(replies, fn) {
  const cdpBridgePath = require.resolve("../src/cdp-bridge.js");
  const origCdpBridge = require.cache[cdpBridgePath];
  const wsStub = installWsStub(replies);
  const origFetch = global.fetch;
  global.fetch = mockJsonVersion();
  delete require.cache[cdpBridgePath];
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-first-window-"));
  try {
    return await fn(require("../src/cdp-bridge.js"), wsStub.sockets, udd);
  } finally {
    global.fetch = origFetch;
    wsStub.restore();
    if (origCdpBridge) require.cache[cdpBridgePath] = origCdpBridge;
    else delete require.cache[cdpBridgePath];
    fs.rmSync(udd, { recursive: true, force: true });
  }
}

test("first window: if the background window fails, a normal window opens so the launch still completes", async () => {
  await withFirstWindowStubs([{ error: { message: "boom" } }], async (fresh, sockets, udd) => {
    writeMockActivePort(udd);
    const r = await fresh._openFirstWindow(udd);
    assert.deepStrictEqual(r, { background: false });
    assert.strictEqual(sockets.length, 3);
    assert.strictEqual(sockets[0].sent[0].params.background, true);
    assert.strictEqual(sockets[1].sent[0].method, "Target.getTargets");
    assert.deepStrictEqual(sockets[2].sent[0].params, { url: "about:blank", newWindow: true });
  });
});

test("first window: a background call that fails AFTER opening the window gets no second window", async () => {
  await withFirstWindowStubs(
    [{ error: { message: "slow" } }, { result: { targetInfos: [{ type: "page", targetId: "P" }] } }],
    async (fresh, sockets, udd) => {
      writeMockActivePort(udd);
      const r = await fresh._openFirstWindow(udd);
      assert.deepStrictEqual(r, { background: true, late: true });
      assert.strictEqual(sockets.length, 2, "no normal (focus-stealing) window");
    },
  );
});

test("first window: a refused CDP connection is handled, not an uncaught 'error'", async () => {
  await withFirstWindowStubs([{ connectError: "ECONNREFUSED" }], async (fresh, sockets, udd) => {
    writeMockActivePort(udd);
    const r = await fresh._openFirstWindow(udd);
    assert.deepStrictEqual(r, { background: false });
    assert.strictEqual(sockets.length, 3);
  });
});

test("cdpCall: a socket closed before the answer rejects at once, not at the timeout", async () => {
  await withFirstWindowStubs([{ closeWithoutReply: true }], async (fresh) => {
    const t0 = Date.now();
    await assert.rejects(fresh._cdpCall("ws://127.0.0.1:1/x", "Target.getTargets", {}, 5000), /socket closed before an answer/);
    assert.ok(Date.now() - t0 < 1000);
  });
});

test("first window: an unreadable DevToolsActivePort does not freeze the event loop", { timeout: 10000, skip: process.getuid && process.getuid() === 0 ? "root reads mode 000" : false }, async () => {
  await withFirstWindowStubs([], async (fresh, sockets, udd) => {
    writeMockActivePort(udd);
    fs.chmodSync(path.join(udd, "DevToolsActivePort"), 0o000);
    const t0 = Date.now();
    const r = await fresh._openFirstWindow(udd, { stopped: stopAfter(800) });
    assert.match(r.error, /launch settled first \(.*EACCES/);
    assert.ok(Date.now() - t0 < 3000);
    assert.strictEqual(sockets.length, 0);
  });
});

test("first window: a non-page target (e.g. an extension worker) does not count as the window", async () => {
  await withFirstWindowStubs(
    [{ error: { message: "slow" } }, { result: { targetInfos: [{ type: "service_worker", targetId: "W" }] } }],
    async (fresh, sockets, udd) => {
      writeMockActivePort(udd);
      const r = await fresh._openFirstWindow(udd);
      assert.deepStrictEqual(r, { background: false });
      assert.strictEqual(sockets.length, 3, "the normal-window fallback must still run");
    },
  );
});

test("first window: off macOS the launch args are unchanged", async () => {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...desc, value: "linux" });
  try {
    await withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({ userDataDir: SAFE_UDD, executablePath: "/fake/brave" });
      assert.ok(!captured.launchOpts.args.includes("--no-startup-window"));
      assert.ok(!captured.launchOpts.ignoreDefaultArgs.includes("about:blank"));
    });
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
});

test("cdpCall: ignores another id's message and closes its socket", async () => {
  await withFirstWindowStubs([{ junkFirst: true, result: { ok: 1 } }], async (fresh, sockets) => {
    const r = await fresh._cdpCall("ws://127.0.0.1:1/x", "Target.getTargets", {}, 2000);
    assert.deepStrictEqual(r, { ok: 1 });
    assert.strictEqual(sockets[0].terminated, true);
  });
});

test("cdpCall: no answer rejects at its timeout", async () => {
  await withFirstWindowStubs([{ noReply: true }], async (fresh) => {
    const t0 = Date.now();
    await assert.rejects(fresh._cdpCall("ws://127.0.0.1:1/x", "Target.getTargets", {}, 150), /no answer within 150ms/);
    assert.ok(Date.now() - t0 < 1000);
  });
});

// Stops are driven by a TIMER in these loop tests: a loop that never yields to
// the event loop never sees it, so a hot spin hangs the test (timeout) instead
// of passing.
function stopAfter(ms) {
  let stop = false;
  setTimeout(() => { stop = true; }, ms);
  return () => stop;
}

test("first window: a different browser on the port gets NO CDP call", { timeout: 10000 }, async () => {
  await withFirstWindowStubs([], async (fresh, sockets, udd) => {
    writeMockActivePort(udd, "99999999-8888-7777-6666-555555555555");
    const r = await fresh._openFirstWindow(udd, { stopped: stopAfter(1000) });
    assert.match(r.error, /identity check failed/);
    assert.strictEqual(sockets.length, 0);
  });
});

test("first window: stops waiting once the launch has settled", async () => {
  await withFirstWindowStubs([], async (fresh, sockets, udd) => {
    const t0 = Date.now();
    const r = await fresh._openFirstWindow(udd, { stopped: () => true });
    assert.deepStrictEqual(r, { error: "launch settled first" });
    assert.ok(Date.now() - t0 < 2000, "must return once the launch has settled");
    assert.strictEqual(sockets.length, 0);
  });
});

// A real Brave writes DevToolsActivePort hundreds of ms after spawn, and
// Playwright's launchPersistentContext does not return until a first page
// exists. This mock does both, so the first window must be opened WHILE the
// launch is pending, and the file wait must survive a missed first slice.
test("first window: opened while the launch is pending, after a late DevToolsActivePort", async () => {
  const playwrightCorePath = require.resolve("playwright-core");
  const cdpBridgePath = require.resolve("../src/cdp-bridge.js");
  const origPlaywright = require.cache[playwrightCorePath];
  const origCdpBridge = require.cache[cdpBridgePath];
  const origFetch = global.fetch;
  const wsStub = installWsStub();
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-pending-"));
  require.cache[playwrightCorePath] = {
    id: playwrightCorePath, filename: playwrightCorePath, loaded: true,
    exports: { chromium: { launchPersistentContext: async (dir) => {
      setTimeout(() => writeMockActivePort(dir), 700);
      const gotPage = await waitFor(() => wsStub.sockets.some((s) => s.sent.some((m) => m.method === "Target.createTarget")), 3000);
      if (!gotPage) throw new Error("mock: no first page within 3 s");
      return { close: async () => {} };
    } } },
  };
  delete require.cache[cdpBridgePath];
  global.fetch = mockJsonVersion();
  try {
    const h = await require("../src/cdp-bridge.js").launchBrave({ userDataDir: udd, executablePath: "/fake/brave" });
    assert.strictEqual(h.port, MOCK_PORT);
    assert.strictEqual(wsStub.sockets.length, 1);
    assert.strictEqual(wsStub.sockets[0].url, `ws://127.0.0.1:${MOCK_PORT}/devtools/browser/${MOCK_UUID}`);
    assert.deepStrictEqual(wsStub.sockets[0].sent[0], {
      id: 1, method: "Target.createTarget",
      params: { url: "about:blank", newWindow: true, background: true },
    });
  } finally {
    if (origPlaywright) require.cache[playwrightCorePath] = origPlaywright; else delete require.cache[playwrightCorePath];
    if (origCdpBridge) require.cache[cdpBridgePath] = origCdpBridge; else delete require.cache[cdpBridgePath];
    global.fetch = origFetch;
    wsStub.restore();
    fs.rmSync(udd, { recursive: true, force: true });
  }
});

// A failed launch must stop the first-window poller: otherwise it lingers and
// can act on a LATER Brave's DevToolsActivePort in the same profile.
test("first window: a failed launch stops the poller (no CDP call on a later file)", async () => {
  const playwrightCorePath = require.resolve("playwright-core");
  const cdpBridgePath = require.resolve("../src/cdp-bridge.js");
  const origPlaywright = require.cache[playwrightCorePath];
  const origCdpBridge = require.cache[cdpBridgePath];
  const origFetch = global.fetch;
  const wsStub = installWsStub();
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-failed-"));
  require.cache[playwrightCorePath] = {
    id: playwrightCorePath, filename: playwrightCorePath, loaded: true,
    exports: { chromium: { launchPersistentContext: async () => { throw new Error("mock: Brave exited"); } } },
  };
  delete require.cache[cdpBridgePath];
  global.fetch = mockJsonVersion();
  try {
    await assert.rejects(require("../src/cdp-bridge.js").launchBrave({ userDataDir: udd, executablePath: "/fake/brave" }), /Brave exited/);
    writeMockActivePort(udd);
    await new Promise((r) => setTimeout(r, 1200));
    assert.strictEqual(wsStub.sockets.length, 0);
  } finally {
    if (origPlaywright) require.cache[playwrightCorePath] = origPlaywright; else delete require.cache[playwrightCorePath];
    if (origCdpBridge) require.cache[cdpBridgePath] = origCdpBridge; else delete require.cache[cdpBridgePath];
    global.fetch = origFetch;
    wsStub.restore();
    fs.rmSync(udd, { recursive: true, force: true });
  }
});
