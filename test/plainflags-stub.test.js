// plainflags-stub.test.js — plainflags-stub.py (the lazy plain-flags relay)
// against a FAKE relay (test/fixtures/fake-plainflags-relay.js, copied under
// the system temp dir — the only place the stub starts a test child from).
// Harness only: it spawns processes. The real relay through the stub is
// test/isolated-plainflags-stub.test.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { REPO, isolated, SKIP_MSG } = require("./helpers/isolation.js");

const PY = "/usr/bin/python3";
const STUB = path.join(REPO, "plainflags-stub.py");
const FAKE = path.join(REPO, "test", "fixtures", "fake-plainflags-relay.js");
const TOOLS_FILE = path.join(REPO, "plainflags-tools.json");
const FILE = JSON.parse(fs.readFileSync(TOOLS_FILE, "utf8"));
const TOKEN = "${os.tmpdir()}";
const OPTS = {
  skip: !isolated() ? SKIP_MSG : (!fs.existsSync(PY) ? "no /usr/bin/python3" : (process.platform === "win32" ? "posix only" : false)),
  timeout: 60000,
};
const CLIENT_INIT = { protocolVersion: "2025-06-18", capabilities: { roots: {} }, clientInfo: { name: "claude-code-test", version: "9.9.9" } };
const SECRET = "Typed-Secret-Value-q7Zx";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const untoken = (v, tmp) => JSON.parse(JSON.stringify(v).split(JSON.stringify(TOKEN)).join(JSON.stringify(tmp)));
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
async function waitDead(pids, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pids.every((p) => !alive(p))) return;
    await sleep(50);
  }
  assert.fail(`still alive after ${ms} ms: ${pids.filter(alive).join(", ")}`);
}
const LIVE = new Set();
const childrenOf = (pid) => (spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout || "").trim().split("\n").filter(Boolean).map(Number);

/** The stub, its client side, and the fake relay's records. */
/** `real`: no test child — the stub starts the real launcher beside it, with `env` and `cwd`. */
function startStub({ mode = "", timings = "5,3,1.5", tools = null, env = {}, fakePath = null, real = false, cwd = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-stub-"));
  const fake = fakePath || path.join(dir, "fake-relay.js");
  if (!fakePath && !real) fs.copyFileSync(FAKE, fake);
  let toolsPath = null;
  if (tools) { toolsPath = path.join(dir, "fake-tools.json"); fs.writeFileSync(toolsPath, JSON.stringify(tools)); }
  const fullEnv = real ? { ...process.env, ...env } : {
    ...process.env,
    PLAINFLAGS_STUB_TEST_CHILD: fake,
    PLAINFLAGS_STUB_TEST_TIMINGS: timings,
    BROWSER_RELAY_PROFILE_MODE: "default-from-parent",
    FAKE_DIR: dir, FAKE_MODE: mode, FAKE_STATIC: TOOLS_FILE,
    ...(toolsPath ? { FAKE_TOOLS: toolsPath } : {}),
    ...env,
  };
  cwd = cwd || fs.mkdtempSync(path.join(os.tmpdir(), "pf-stub-cwd-"));
  const child = spawn(PY, [STUB], { cwd, env: fullEnv, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const waiters = [];
  let stderr = "";
  let buf = "";
  child.stderr.on("data", (c) => { stderr += c; });
  child.stdin.on("error", () => { /* the stub exited first (the refusal cases) */ });
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const msg = JSON.parse(line);
      messages.push(msg);
      for (const w of waiters.slice()) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  const exited = new Promise((r) => child.once("exit", (code, sig) => r({ code, sig })));
  const waitFor = (pred, ms = 10000) => new Promise((resolve, reject) => {
    const hit = messages.find(pred);
    if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error(`no matching message in ${ms} ms; got ${JSON.stringify(messages).slice(0, 2000)}\nstderr: ${stderr}`)), ms);
    waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
  let nextId = 1;
  const sendRaw = (text) => child.stdin.write(text + "\n");
  const send = (m) => sendRaw(JSON.stringify(m));
  /** Resolves to the whole response message (result or error). */
  const request = (method, params, id = nextId++, ms) => {
    send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return waitFor((m) => m.id === id && !m.method, ms);
  };
  const handshake = async () => {
    const r = await request("initialize", CLIENT_INIT);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r;
  };
  const call = (name, args = {}, id, ms) => request("tools/call", { name, arguments: args }, id, ms);
  const received = () => {
    try { return fs.readFileSync(path.join(dir, "received.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  const pids = () => {
    try { return fs.readFileSync(path.join(dir, "pids"), "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ").map(Number)); } catch { return []; }
  };
  const info = (pid) => JSON.parse(fs.readFileSync(path.join(dir, `info-${pid}.json`), "utf8"));
  const stop = async () => {
    LIVE.delete(api);
    if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); await Promise.race([exited, sleep(15000)]); }
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    // Anything a failing test left: this test's fake relays and their grandchildren only.
    for (const p of pids().flat()) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
    if (!real) fs.rmSync(cwd, { recursive: true, force: true });
  };
  const api = { child, cwd, dir, messages, waitFor, send, sendRaw, request, handshake, call, received, pids, info, exited, stop, stderr: () => stderr };
  LIVE.add(api);
  return api;
}

const text = (r) => JSON.parse(r.result.content[0].text);
/** Exit within `ms` or fail — a stub that never exits must fail the test, not hang the file. */
const exitedWithin = async (s, ms) => {
  const ex = await Promise.race([s.exited, sleep(ms).then(() => null)]);
  assert.ok(ex, `the stub did not exit within ${ms} ms\n${s.stderr()}`);
  return ex;
};
// A test that times out never reaches its finally: kill what it left (this file's stubs and fake relays only).
test.after(async () => { for (const s of LIVE) await s.stop(); });

test("handshake: initialize / initialized / tools/list / ping answered by the stub, no relay started", OPTS, async () => {
  const s = startStub();
  try {
    const init = await s.handshake();
    assert.strictEqual(init.result.protocolVersion, "2025-06-18", "the client's version is echoed");
    assert.deepStrictEqual(init.result.serverInfo, FILE.initialize.serverInfo);
    assert.strictEqual(init.result.instructions, FILE.initialize.instructions);
    assert.deepStrictEqual(init.result.capabilities, { ...FILE.initialize.capabilities, tools: { ...FILE.initialize.capabilities.tools, listChanged: true } });
    const list = await s.request("tools/list", {});
    assert.deepStrictEqual(list.result, untoken(FILE.toolsList, os.tmpdir()));
    assert.ok(JSON.stringify(list.result).includes(JSON.stringify(os.tmpdir())), "the tmpdir token is resolved");
    assert.deepStrictEqual((await s.request("ping")).result, {});
    const old = await s.request("initialize", { ...CLIENT_INIT, protocolVersion: "1999-01-01" });
    assert.strictEqual(old.result.protocolVersion, FILE.protocol.latest, "an unsupported version gets the SDK's latest");
    await sleep(500);
    assert.strictEqual(s.messages.length, 4, "nothing but the four answers (no reply to notifications/initialized)");
    assert.deepStrictEqual(s.pids(), [], "the fake relay never started");
    assert.deepStrictEqual(childrenOf(s.child.pid), [], "the stub has no child process");
    s.child.stdin.end();
    assert.deepStrictEqual(await exitedWithin(s, 5000), { code: 0, sig: null });
  } finally { await s.stop(); }
});

test("tools/list: the tmpdir token becomes the session's os.tmpdir() (trailing slash dropped, as Node does)", OPTS, async () => {
  const tmp = fs.realpathSync(os.tmpdir());
  const s = startStub({ env: { TMPDIR: tmp + "/" } });
  try {
    await s.handshake();
    const list = await s.request("tools/list", {});
    assert.deepStrictEqual(list.result, untoken(FILE.toolsList, tmp));
  } finally { await s.stop(); }
});

test("first tools/call starts the relay: exact initialize replayed under the stub's own id, queued calls in order, the client's ids kept", OPTS, async () => {
  const s = startStub();
  try {
    await s.handshake();
    const rs = await Promise.all([10, 11, 12].map((id) => s.call("echo", { n: id }, id)));
    for (const [i, r] of rs.entries()) {
      assert.deepStrictEqual(text(r), { id: 10 + i, args: { n: 10 + i } }, "the relay saw the client's id and args");
    }
    const got = s.received();
    assert.strictEqual(got[0].method, "initialize");
    assert.deepStrictEqual(got[0].params, CLIENT_INIT, "the client's initialize params, exactly");
    assert.match(String(got[0].id), /^plainflags-stub:/, "replayed under the stub's own id");
    assert.deepStrictEqual(got.slice(1).map((m) => [m.method, m.id]), [
      ["notifications/initialized", undefined], ["tools/list", "plainflags-stub:tools/list"],
      ["tools/call", 10], ["tools/call", 11], ["tools/call", 12],
    ]);
    const [[pid]] = s.pids();
    assert.deepStrictEqual(s.info(pid), { cwd: fs.realpathSync(s.cwd), profileMode: "plainflags" }, "the stub's cwd; the mode forced over the parent env");
    // concurrent calls answered out of order keep their ids
    const slow = s.call("echo", { delayMs: 400, k: "slow" }, 20);
    const fast = s.call("echo", { k: "fast" }, 21);
    const first = await Promise.race([slow.then(() => "slow"), fast.then(() => "fast")]);
    assert.strictEqual(first, "fast");
    assert.deepStrictEqual(text(await slow), { id: 20, args: { delayMs: 400, k: "slow" } });
    assert.deepStrictEqual(text(await fast), { id: 21, args: { k: "fast" } });
    // with the relay up, ping and tools/list go to it
    await s.request("ping", undefined, 30);
    await s.request("tools/list", {}, 31);
    assert.deepStrictEqual(s.received().slice(-2).map((m) => [m.method, m.id]), [["ping", 30], ["tools/list", 31]]);
    await sleep(200);
    assert.ok(s.messages.every((m) => typeof m.id !== "string"), "no answer to the stub's own requests reached the client");
    assert.ok(!s.messages.some((m) => m.method === "notifications/tools/list_changed"), "no drift → no list_changed");
    assert.strictEqual(s.pids().length, 1, "one relay");
  } finally { await s.stop(); }
});

test("relay → client notifications and the relay's stderr are passed through", OPTS, async () => {
  const s = startStub();
  try {
    await s.handshake();
    await s.call("echo");
    await s.waitFor((m) => m.method === "notifications/message" && m.params.data === "fake-note");
    await s.call("listchanged");
    await s.waitFor((m) => m.method === "notifications/tools/list_changed");
    assert.match(s.stderr(), /fake-relay: started pid=\d+/);
  } finally { await s.stop(); }
});

test("relay crash: in-flight calls get an error, a call inside the restart window is refused, the next one after it restarts the relay", OPTS, async () => {
  const s = startStub({ timings: "5,3,1.5" });
  try {
    await s.handshake();
    await s.call("echo");
    const [[pid1, gc1]] = s.pids();
    const slow = s.call("echo", { delayMs: 5000 }, 50);
    const crash = s.call("crash", {}, 51);
    for (const r of [await crash, await slow]) {
      assert.strictEqual(r.error.code, -32000);
      assert.match(r.error.message, /plain-flags relay exited \(code 3\)/);
    }
    await waitDead([pid1, gc1]);
    const early = await s.call("echo", {}, 52);
    assert.match(early.error.message, /exited \(code 3\).*retry in \d+ s/);
    assert.strictEqual(s.pids().length, 1, "no restart inside the window");
    await sleep(3100);
    const again = await s.call("echo", { n: 2 }, 53);
    assert.deepStrictEqual(text(again), { id: 53, args: { n: 2 } });
    assert.strictEqual(s.pids().length, 2, "restarted once");
  } finally { await s.stop(); }
});

test("a relay that refuses the replayed initialize: the call gets an error, its group is killed", OPTS, async () => {
  const s = startStub({ mode: "init-error" });
  try {
    await s.handshake();
    const r = await s.call("echo", {}, 60);
    assert.match(r.error.message, /refused the replayed initialize/);
    await waitDead(s.pids().flat());
  } finally { await s.stop(); }
});

test("initialize timeout: a relay that never answers is killed with its process group, the call gets an error", OPTS, async () => {
  const s = startStub({ mode: "no-init", timings: "1,30,1.5" });
  try {
    await s.handshake();
    const t0 = Date.now();
    const r = await s.call("echo", {}, 70);
    const ms = Date.now() - t0;
    assert.match(r.error.message, /did not answer initialize within 1 s/);
    assert.ok(ms >= 900 && ms < 5000, `answered after ${ms} ms`);
    await waitDead(s.pids().flat(), 3000);
  } finally { await s.stop(); }
});

for (const how of ["EOF", "SIGTERM", "SIGHUP"]) {
  test(`stub exit on ${how}: the relay and its whole process group are gone`, OPTS, async () => {
    const s = startStub();
    try {
      await s.handshake();
      await s.call("echo");
      const all = s.pids().flat();
      assert.ok(all.every(alive));
      if (how === "EOF") s.child.stdin.end(); else s.child.kill(how);
      await exitedWithin(s, 8000);
      await waitDead(all, 3000);
    } finally { await s.stop(); }
  });
}

test("stub exit: a relay that ignores SIGTERM and EOF is SIGKILLed with its group after the grace", OPTS, async () => {
  const s = startStub({ mode: "ignore-term", timings: "5,3,1" });
  try {
    await s.handshake();
    await s.call("echo");
    const all = s.pids().flat();
    const t0 = Date.now();
    s.child.kill("SIGTERM");
    await exitedWithin(s, 8000);
    const ms = Date.now() - t0;
    assert.ok(ms >= 900 && ms < 5000, `exited after ${ms} ms`);
    await waitDead(all, 3000);
    assert.match(s.stderr(), /still running 1 s after SIGTERM — killing its process group/);
  } finally { await s.stop(); }
});

test("drift: the relay's tools/list differs from the file → notifications/tools/list_changed, then the relay's list", OPTS, async () => {
  const changed = untoken(FILE.toolsList, os.tmpdir());
  changed.tools = changed.tools.slice(1);
  changed.tools[0] = { ...changed.tools[0], description: "changed upstream" };
  const s = startStub({ tools: changed });
  try {
    await s.handshake();
    assert.deepStrictEqual((await s.request("tools/list", {})).result, untoken(FILE.toolsList, os.tmpdir()), "before: the file's list");
    await s.call("echo");
    await s.waitFor((m) => m.method === "notifications/tools/list_changed");
    assert.match(s.stderr(), /tools\/list differs from plainflags-tools\.json/);
    assert.deepStrictEqual((await s.request("tools/list", {})).result, changed, "after: the relay's list");
    // and still the relay's list once the relay is gone (served by the stub)
    s.send({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "crash", arguments: {} } });
    await s.waitFor((m) => m.id === 90);
    assert.deepStrictEqual((await s.request("tools/list", {})).result, changed);
  } finally { await s.stop(); }
});

test("stderr never carries a message body: tool arguments in every path stay out of it", OPTS, async () => {
  const s = startStub({ timings: "5,3,1.5" });
  try {
    await s.handshake();
    s.sendRaw(`{"not json ${SECRET}`); // a malformed line while idle
    s.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: SECRET } }); // dropped while idle
    s.send({ jsonrpc: "2.0", method: { name: SECRET } }); // a non-string method: dropped, never printed
    const trigger = s.call("interaction_fill", { selector: "#pw", value: SECRET }, 100); // starts the relay
    const queued = s.call("interaction_fill", { selector: "#pw", value: SECRET }, 101); // queued while starting
    await trigger; await queued;
    await s.call("echo", { value: SECRET }, 102); // through a ready relay
    const slow = s.call("echo", { delayMs: 3000, value: SECRET }, 103);
    await s.call("crash", { value: SECRET }, 104); // crash → error replies
    await slow;
    const refused = await s.call("echo", { value: SECRET }, 105); // refused inside the restart window
    assert.ok(refused.error);
    s.child.stdin.end();
    await exitedWithin(s, 8000);
    assert.match(s.stderr(), /\[plainflags-stub\] tools\/call id=100 \(\d+ bytes\) — starting/, "the trigger is logged by method, id and size");
    assert.ok(!s.stderr().includes(SECRET), "no argument text in stderr");
    assert.ok(!s.stderr().includes("#pw"), "no argument text in stderr");
  } finally { await s.stop(); }
});

test("the test-child override is refused unless it is a file under the system temp dir (nothing is started)", OPTS, async () => {
  for (const bad of ["/etc/hosts", path.join(os.tmpdir(), "no-such-fake.js")]) {
    const s = startStub({ fakePath: bad });
    try {
      const ex = await exitedWithin(s, 5000);
      assert.strictEqual(ex.code, 2, bad);
      assert.match(s.stderr(), /PLAINFLAGS_STUB_TEST_CHILD is set but is not a file under the system temp dir — refusing/);
      assert.deepStrictEqual(s.pids(), []);
    } finally { await s.stop(); }
  }
});

// ── the REAL plain-flags relay through the stub, against a real test Brave ──

let BRAVE = null;
try { BRAVE = require("../src/detect-browser.js").detectBravePath(); } catch { /* skip */ }
const E2E = {
  skip: OPTS.skip || (!BRAVE ? "no Brave installed" : (process.platform !== "darwin" ? "darwin" : false)),
  timeout: 240000,
};
const homeBraves = (home) => (spawnSync("ps", ["-eo", "pid,command", "-ww"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout || "")
  .split("\n").filter((l) => /brave/i.test(l) && l.includes(`--user-data-dir=${home}`)).map((l) => Number(l.trim().split(/\s+/)[0]));
const resultText = (r) => r.result.content.filter((c) => c.type === "text" && !c.text.startsWith("[browser-mcp-relay]")).map((c) => c.text).join("\n");

test("e2e: the REAL plain-flags relay through the stub — handshake with no relay; first call starts it; navigation_go-to a local page and challenge_detect work; EOF leaves no relay or Brave", E2E, async () => {
  const { homeTmp } = require("./helpers/isolation.js");
  const http = require("node:http");
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><html><head><link rel=icon href=data:,></head><body><h1>STUB-E2E</h1></body></html>"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const home = homeTmp("home-pfstub-");
  const proj = path.join(home, "proj-pfstub");
  fs.mkdirSync(proj);
  const signin = path.join(home, "plainflags-signin.json");
  fs.writeFileSync(signin, JSON.stringify({ accounts: [] }));
  const fx = path.join(home, "fixture.json");
  fs.writeFileSync(fx, JSON.stringify({ accounts: [], signinFile: signin, asksDir: path.join(home, "no-asks") }));
  const env = {
    HOME: home, CLAUDE_PROJECT_DIR: proj,
    BROWSER_RELAY_TEST_LAUNCH: "1", BROWSER_HEADLESS_ENABLE: "true", BROWSER_RELAY_BRAVE_PATH: BRAVE,
    TELEMETRY_ENABLE: "false", BROWSER_RELAY_IDLE_MINUTES: "0", BROWSER_RELAY_TEST_PLAINFLAGS_FIXTURE: fx,
    BROWSER_RELAY_POOL_DIR: "", // the launcher sets it
  };
  delete process.env.BROWSER_RELAY_INSECURE_TLS;
  const s = startStub({ real: true, env, cwd: proj });
  try {
    await s.handshake();
    assert.deepStrictEqual((await s.request("tools/list", {})).result, untoken(FILE.toolsList, os.tmpdir()));
    assert.deepStrictEqual(childrenOf(s.child.pid), [], "no relay before a tool call");

    let t0 = Date.now();
    const st = await s.call("relay_status", {}, 200, 90000);
    const firstCallMs = Date.now() - t0;
    assert.ok(!st.error && !st.result.isError, JSON.stringify(st).slice(0, 2000));
    const status = JSON.parse(resultText(st));
    assert.strictEqual(status.profileMode, "plainflags");
    assert.strictEqual(status.dir, path.join(home, "Library", "Caches", "browser-mcp-relay", "profiles-plainflags", "proj-pfstub"));
    const relayPids = childrenOf(s.child.pid);
    assert.strictEqual(relayPids.length, 1, "one relay process");

    const url = `http://127.0.0.1:${server.address().port}/stub-page`;
    t0 = Date.now();
    const nav = await s.call("navigation_go-to", { url, includeScreenshot: false }, 201, 120000);
    const navMs = Date.now() - t0;
    assert.ok(!nav.error && !nav.result.isError, JSON.stringify(nav).slice(0, 2000));
    const det = await s.call("challenge_detect", { lane: "as-ops/stub-e2e" }, 202, 60000);
    assert.ok(!det.error && !det.result.isError, JSON.stringify(det).slice(0, 2000));
    const d = JSON.parse(resultText(det));
    assert.strictEqual(d.kind, "none", resultText(det));
    assert.ok(homeBraves(home).length > 0, "a test Brave is running");
    assert.ok(!/differs from plainflags-tools\.json/.test(s.stderr()), "the live relay's list equals the file");
    process.stderr.write(`[plainflags-stub e2e] first call (relay start through the stub) ${firstCallMs} ms; navigation_go-to incl. Brave launch ${navMs} ms\n`);

    s.child.stdin.end();
    await exitedWithin(s, 20000);
    await waitDead(relayPids, 5000);
    const end = Date.now() + 15000;
    while (homeBraves(home).length && Date.now() < end) await sleep(200);
    assert.deepStrictEqual(homeBraves(home), [], "no Brave left on the test profile");
  } finally {
    await s.stop();
    for (const p of homeBraves(home)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    server.close();
  }
});
