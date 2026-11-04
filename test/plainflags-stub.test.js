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
/** The stub's relay child only — not a short-lived `ps` the stub runs to read the relay's tree. */
const relayOf = (pid) => childrenOf(pid).filter((c) => /launch-project-isolated\.js/.test(spawnSync("ps", ["-o", "command=", "-p", String(c)], { encoding: "utf8" }).stdout || ""));

/** The stub, its client side, and the fake relay's records. */
/** `real`: no test child — the stub starts the real launcher beside it, with `env` and `cwd`. */
/** `file`: a different plainflags-tools.json — the stub is then run from a copy beside it. */
function startStub({ mode = "", timings = "5,3,1.5", tools = null, env = {}, fakePath = null, real = false, cwd = null, file = null, stub = STUB } = {}) {
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
  let stubPath = stub;
  if (file) {
    stubPath = path.join(dir, "plainflags-stub.py");
    fs.copyFileSync(STUB, stubPath);
    fs.writeFileSync(path.join(dir, "plainflags-tools.json"), JSON.stringify(file));
  }
  const child = spawn(PY, [stubPath], { cwd, env: fullEnv, stdio: ["pipe", "pipe", "pipe"] });
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
  const spawned = () => {
    try { return fs.readFileSync(path.join(dir, "spawned"), "utf8").trim().split("\n").filter(Boolean).map(Number); } catch { return []; }
  };
  const info = (pid) => JSON.parse(fs.readFileSync(path.join(dir, `info-${pid}.json`), "utf8"));
  const stop = async () => {
    LIVE.delete(api);
    if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); await Promise.race([exited, sleep(15000)]); }
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    // Anything a failing test left: this test's fake relays and their grandchildren only.
    for (const p of [...pids().flat(), ...spawned()]) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
    if (!real) fs.rmSync(cwd, { recursive: true, force: true });
  };
  const api = { child, cwd, dir, messages, waitFor, send, sendRaw, request, handshake, call, received, pids, spawned, info, exited, stop, stderr: () => stderr };
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

test("Claude Code 2.1.296's opening (server/discover before initialize, then initialize / initialized / tools/list, resources/list, prompts/list) starts no relay; the first tools/call replays the client's exact initialize", OPTS, async () => {
  const s = startStub();
  try {
    const disc = await s.request("server/discover", {}, "server-discover-probe-1");
    assert.deepStrictEqual(disc.error, FILE.otherMethods["server/discover"].error, "the relay's own reply, from the file");
    assert.deepStrictEqual(disc.error, { code: -32601, message: "Method not found" });
    await s.handshake();
    assert.strictEqual((await s.request("tools/list", {})).result.tools.length, FILE.toolsList.tools.length);
    for (const m of ["resources/list", "resources/templates/list", "prompts/list"]) {
      assert.deepStrictEqual((await s.request(m, {})).error, FILE.otherMethods[m].error, m);
    }
    await sleep(500);
    assert.deepStrictEqual(s.pids(), [], "no relay was started");
    assert.deepStrictEqual(childrenOf(s.child.pid), [], "the stub has no child process");
    const r = await s.call("echo", { n: 1 }, 40);
    assert.deepStrictEqual(text(r), { id: 40, args: { n: 1 } });
    const got = s.received();
    assert.strictEqual(got[0].method, "initialize");
    assert.deepStrictEqual(got[0].params, CLIENT_INIT, "the client's own initialize, not a made-up one");
    assert.ok(!got.some((m) => m.method === "server/discover" || m.method === "resources/list"), "the probes never reached the relay");
    assert.strictEqual(s.pids().length, 1);
  } finally { await s.stop(); }
});

test("a request before initialize is refused and starts no relay; after initialize the relay gets the client's initialize", OPTS, async () => {
  const s = startStub();
  try {
    const early = await s.call("echo", {}, 41);
    assert.strictEqual(early.error.code, -32600);
    assert.match(early.error.message, /before initialize/);
    await sleep(300);
    assert.deepStrictEqual(s.pids(), [], "no relay before the client's initialize");
    await s.handshake();
    assert.deepStrictEqual(text(await s.call("echo", {}, 42)), { id: 42, args: {} });
    assert.deepStrictEqual(s.received()[0].params, CLIENT_INIT);
  } finally { await s.stop(); }
});

test("only a recorded -32601 is served by the stub: another recorded error or a result goes to the relay", OPTS, async () => {
  const file = JSON.parse(JSON.stringify(FILE));
  file.otherMethods["resources/list"] = { error: { code: -32603, message: "recorded internal error" } };
  file.otherMethods["prompts/list"] = { result: { prompts: [] } };
  const s = startStub({ file });
  try {
    await s.handshake();
    assert.deepStrictEqual((await s.request("server/discover", {}, 70)).error, FILE.otherMethods["server/discover"].error);
    assert.deepStrictEqual(s.pids(), [], "a -32601 one is still answered locally");
    const rl = await s.request("resources/list", {}, 71);
    const pl = await s.request("prompts/list", {}, 72);
    assert.deepStrictEqual([rl.error, pl.error], [{ code: -32601, message: "Method not found" }, { code: -32601, message: "Method not found" }], "the (fake) relay's own answers");
    assert.strictEqual(s.pids().length, 1, "the relay was started for them");
    assert.deepStrictEqual(s.received().filter((m) => m.id === 71 || m.id === 72).map((m) => m.method), ["resources/list", "prompts/list"]);
  } finally { await s.stop(); }
});

test("the recorded -32601 replies are served while the relay is starting and after it failed, not only while idle", OPTS, async () => {
  const want = FILE.otherMethods["server/discover"].error;
  const a = startStub({ mode: "no-init", timings: "3,30,1.5" });
  try {
    await a.handshake();
    const pending = a.call("echo", {}, 80); // starts a relay that never answers initialize
    await sleep(300);
    assert.deepStrictEqual((await a.request("server/discover", {}, 81, 1500)).error, want, "answered at once while starting");
    assert.ok((await pending).error, "the call fails at the initialize timeout");
  } finally { await a.stop(); }
  const b = startStub({ timings: "5,30,1.5" });
  try {
    await b.handshake();
    await b.call("echo");
    await b.call("crash", {}, 82);
    const after = await b.request("server/discover", {}, 83);
    assert.deepStrictEqual(after.error, want, "answered by the stub inside the restart window, not refused");
    assert.strictEqual(b.pids().length, 1, "and no restart");
  } finally { await b.stop(); }
});

test("a NOTIFICATION named like a recorded method (no id) is dropped: no reply, no crash, no relay", OPTS, async () => {
  const s = startStub();
  try {
    s.send({ jsonrpc: "2.0", method: "server/discover" });
    await s.handshake();
    s.send({ jsonrpc: "2.0", method: "server/discover", params: {} });
    s.send({ jsonrpc: "2.0", method: "resources/list" });
    assert.deepStrictEqual((await s.request("ping", undefined, 90)).result, {}, "the stub is alive");
    await sleep(300);
    assert.strictEqual(s.child.exitCode, null);
    assert.deepStrictEqual(s.messages.map((m) => m.id), [1, 90], "nothing answered the notifications");
    assert.deepStrictEqual(s.pids(), []);
  } finally { await s.stop(); }
});

test("kill_targets: live descendants and orphaned remembered ones only — a reused pid, a re-parented one, the stub and pid 1 never", OPTS, () => {
  // rows: pid -> [ppid, start]; the relay is 100, the stub 50 (its parent), a bystander 60.
  const rows = {
    50: [1, "S"], 60: [50, "B"], 100: [50, "R"],
    101: [100, "a"], 102: [101, "b"], // live tree
    200: [1, "c"],                    // remembered, orphaned, same start → killed
    201: [1, "NEW"],                  // remembered, but a new process on that pid → kept
    202: [60, "d"],                   // remembered, now under a bystander → kept
  };
  const remembered = { 101: "a", 200: "c", 201: "old", 202: "d", 999: "gone" };
  const code = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("stub", ${JSON.stringify(STUB)})`,
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "a = json.loads(sys.argv[1])",
    "rows = {int(k): tuple(v) for k, v in a['rows'].items()}",
    "rem = {int(k): v for k, v in a['remembered'].items()}",
    "print(json.dumps(sorted(m.kill_targets(100, rows, rem))))",
  ].join("\n");
  const r = spawnSync(PY, ["-c", code, JSON.stringify({ rows, remembered })], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), [101, 102, 200]);
});

test("brave_pids: a process name that is not UTF-8 never raises (it runs before the kill); only Brave-named pids are returned", OPTS, () => {
  const odd = spawn("perl", ["-e", '$0 = "/x/\\xff\\xfeBrave Browser Helper"; sleep 30'], { stdio: "ignore" });
  const plain = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const t0 = Date.now();
    while (!/Brave/.test(spawnSync("ps", ["-o", "comm=", "-p", String(odd.pid)], { encoding: "latin1" }).stdout || "") && Date.now() - t0 < 3000) spawnSync("sleep", ["0.05"]);
    const UTF8 = { ...process.env, LC_ALL: "en_US.UTF-8", PYTHONDONTWRITEBYTECODE: "1" }; // under C, ps escapes the bytes
    const raw = spawnSync("ps", ["-o", "comm=", "-p", String(odd.pid)], { env: UTF8 }).stdout;
    assert.ok(raw.includes(0xff) && /Brave/.test(raw.toString("latin1")), `the name really is not UTF-8: ${raw.toString("hex")}`);
    const code = [
      "import importlib.util, json, sys",
      `spec = importlib.util.spec_from_file_location("stub", ${JSON.stringify(STUB)})`,
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "a = json.loads(sys.argv[1])",
      "print(json.dumps(sorted(m.brave_pids(a))))",
    ].join("\n");
    const r = spawnSync(PY, ["-c", code, JSON.stringify([odd.pid, plain.pid, 999999])], { encoding: "utf8", env: UTF8 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), [odd.pid]);
  } finally { odd.kill("SIGKILL"); plain.kill("SIGKILL"); }
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
    // exactly once: one answer per request id, one relay notification per echo call (5: ids 10–12, 20, 21)
    const answers = s.messages.filter((m) => m.id !== undefined).map((m) => m.id);
    assert.deepStrictEqual(answers.slice().sort((a, b) => a - b), [1, 10, 11, 12, 20, 21, 30, 31], "every request answered exactly once");
    assert.strictEqual(s.messages.filter((m) => m.method === "notifications/message").length, 5, "each relay notification delivered once");
    assert.strictEqual(s.received().filter((m) => m.method === "tools/call").length, 5, "each call reached the relay once");
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
    await sleep(200);
    assert.strictEqual(s.messages.filter((m) => m.method === "notifications/tools/list_changed").length, 1, "delivered once");
    assert.strictEqual(s.messages.filter((m) => m.method === "notifications/message").length, 2, "delivered once each");
    assert.match(s.stderr(), /fake-relay: started pid=\d+/, "the relay writes to the stub's stderr (inherited)");
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

test("a relay that closes its stderr and then crashes: error replies, then a restart (the stub never reads the relay's stderr)", OPTS, async () => {
  const s = startStub({ mode: "close-stderr", timings: "5,1,1.5" });
  try {
    await s.handshake();
    await s.call("echo");
    await sleep(200);
    const r = await s.call("crash", {}, 61);
    assert.match(r.error.message, /exited \(code 3\)/);
    await sleep(1100);
    assert.deepStrictEqual(text(await s.call("echo", { n: 2 }, 62)), { id: 62, args: { n: 2 } }, "restarted");
    assert.strictEqual(s.pids().length, 2);
    assert.strictEqual(s.child.exitCode, null, "the stub is still running");
  } finally { await s.stop(); }
});

test("a relay that refuses the replayed initialize: the call gets an error, its process tree is killed", OPTS, async () => {
  const s = startStub({ mode: "init-error" });
  try {
    await s.handshake();
    const r = await s.call("echo", {}, 60);
    assert.match(r.error.message, /refused the replayed initialize/);
    await waitDead(s.pids().flat());
  } finally { await s.stop(); }
});

test("initialize timeout: a relay that never answers is killed with its process tree, the call gets an error", OPTS, async () => {
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
  test(`stub exit on ${how}: the relay and its whole process tree are gone, nothing else is touched`, OPTS, async () => {
    const s = startStub();
    const bystander = spawn("sleep", ["30"], { stdio: "ignore" }); // same process group, not the relay's
    try {
      await s.handshake();
      await s.call("echo");
      const all = s.pids().flat();
      assert.ok(all.every(alive));
      if (how === "EOF") s.child.stdin.end(); else s.child.kill(how);
      await exitedWithin(s, 8000);
      await waitDead(all, 3000);
      assert.ok(alive(bystander.pid), "a process outside the relay's tree survives");
    } finally { bystander.kill("SIGKILL"); await s.stop(); }
  });
}

/** Claude Code 2.1.296's shutdown of a server: SIGINT, SIGTERM 100 ms later, SIGKILL ~400 ms after that, to its pid only. */
async function claudeCodeShutdown(child) {
  const sig = (s) => { try { child.kill(s); } catch { /* already gone */ } };
  sig("SIGINT"); await sleep(100); sig("SIGTERM"); await sleep(400); sig("SIGKILL");
  return Date.now();
}

test("Claude Code's shutdown (SIGINT, +100 ms SIGTERM, +400 ms SIGKILL) with a relay that takes 7 s to stop: the second signal SIGKILLs the relay only — its descendants are left to close themselves (a Brave closes gracefully on pipe close)", OPTS, async () => {
  const s = startStub({ mode: "slow-exit" });
  try {
    await s.handshake();
    await s.call("spawn", {}, 500);
    const [[relay, grandchild]] = s.pids();
    const [extra] = s.spawned();
    const t0 = Date.now();
    s.child.kill("SIGINT"); await sleep(100); s.child.kill("SIGTERM");
    await waitDead([relay], 400); // before Claude Code's SIGKILL at +500 ms, and long before its own 7 s
    assert.ok(Date.now() - t0 < 600, "the relay was killed at the second signal");
    await exitedWithin(s, 2000);
    assert.ok(alive(grandchild) && alive(extra), "the stub did not kill the relay's descendants");
    assert.match(s.stderr(), /a second termination signal — killing the relay now/);
  } finally { await s.stop(); }
});

test("two termination signals back to back to an IDLE stub (no relay) exit cleanly", OPTS, async () => {
  for (let i = 0; i < 10; i++) {
    const s = startStub();
    try {
      await s.handshake();
      s.child.kill("SIGINT"); s.child.kill("SIGTERM");
      const ex = await exitedWithin(s, 5000);
      assert.deepStrictEqual(ex, { code: 0, sig: null }, s.stderr());
      assert.ok(!/Traceback/.test(s.stderr()), s.stderr());
    } finally { await s.stop(); }
  }
});

test("the relay's tree is not re-read while the relay is idle (no lines)", OPTS, async () => {
  const s = startStub();
  try {
    await s.handshake();
    await s.call("echo", {}, 540);
    await sleep(1500); // the deferred read after the last line has run
    const reads = () => (s.stderr().match(/\[plainflags-stub\] tree read/g) || []).length;
    const before = reads();
    assert.ok(before >= 1, "reads are traced in test mode");
    await sleep(3000);
    assert.strictEqual(reads(), before, "no tree read in 3 s without a relay line");
  } finally { await s.stop(); }
});

test("a relay that writes a line and exits at once, >1 s after the last tree read: its remembered descendants are still killed (a read against a dead relay merges, never wipes)", OPTS, async () => {
  for (const gap of [2200, 6000]) {
    const s = startStub({ timings: "5,30,1.5" });
    try {
      await s.handshake();
      await s.call("echo", {}, 550);
      const [[, grandchild]] = s.pids();
      await sleep(gap);
      const r = await s.call("lineexit", {}, 551);
      assert.match(r.error.message, /exited \(code 4\)/);
      await waitDead([grandchild], 3000);
    } finally { await s.stop(); }
  }
});

test("an EOF stop right after the first call kills the descendant that call started (the stop's own tree read)", OPTS, async () => {
  const s = startStub();
  try {
    await s.handshake();
    await s.call("spawn", {}, 510);
    const [extra] = s.spawned();
    s.child.stdin.end(); // well inside TREE_EVERY_S of the ready-time read
    await exitedWithin(s, 8000);
    await waitDead([...s.pids().flat(), extra], 3000);
  } finally { await s.stop(); }
});

test("a crash right after a relay line that came >1 s after the last tree read kills the descendant started for it", OPTS, async () => {
  const s = startStub({ timings: "5,30,1.5" });
  try {
    await s.handshake();
    await s.call("echo", {}, 520);
    await sleep(2200); // the deferred read has run; the next line is >1 s after it
    await s.call("spawn", {}, 521);
    const [extra] = s.spawned();
    const r = await s.call("crash", {}, 522); // at once: only the read on the spawn reply knows it
    assert.match(r.error.message, /exited \(code 3\)/);
    await waitDead([extra], 3000);
  } finally { await s.stop(); }
});

test("a crash 1.5 s after a quick first call kills the descendant it started (the deferred tree read)", OPTS, async () => {
  const s = startStub({ timings: "5,30,1.5" });
  try {
    await s.handshake();
    await s.call("spawn", {}, 530); // its reply comes < 1 s after the ready-time read: deferred
    const [extra] = s.spawned();
    await sleep(1500);
    await s.call("crash", {}, 531);
    await waitDead([extra], 3000);
  } finally { await s.stop(); }
});

test("stub exit: a relay that ignores SIGTERM and EOF is SIGKILLed with its process tree after the grace", OPTS, async () => {
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
    assert.match(s.stderr(), /still running 1 s after SIGTERM — killing its process tree/);
  } finally { await s.stop(); }
});

/** The event log's lines as {kind, why, others}; [] when the file does not exist. */
const readEvents = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : []).map((l) => {
  const m = /^\S+Z stub=\d+ (\S+) (.*)$/.exec(l);
  assert.ok(m, `event line shape: ${l}`);
  return { kind: m[1], why: (/why=("(?:[^"\\]|\\.)*")/.exec(m[2]) || [])[1] && JSON.parse(/why=("(?:[^"\\]|\\.)*")/.exec(m[2])[1]),
           others: /others=(\d+)/.test(m[2]) ? Number(/others=(\d+)/.exec(m[2])[1]) : undefined,
           brave: /brave=(\d+)/.test(m[2]) ? Number(/brave=(\d+)/.exec(m[2])[1]) : undefined };
});

test("event log: a single SIGTERM to a relay that ignores it logs a stop, then a tree-kill naming the descendants it SIGKILLed", OPTS, async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-ev-")), "events.log");
  const s = startStub({ mode: "ignore-term", timings: "5,3,1", env: { PLAINFLAGS_STUB_EVENT_LOG: log } });
  try {
    await s.handshake();
    await s.call("echo");
    s.child.kill("SIGTERM");
    await exitedWithin(s, 8000);
    const ev = readEvents(log);
    assert.deepStrictEqual(ev.map((e) => e.kind), ["stop", "tree-kill"], JSON.stringify(ev));
    assert.strictEqual(ev[0].why, "SIGTERM");
    assert.strictEqual(ev[1].why, "was stopped");
    assert.ok(ev[1].others >= 1, `the grandchild counted: ${ev[1].others}`);
    assert.strictEqual(ev[1].brave, 0, "a fake relay's descendants are not Brave");
    assert.strictEqual(fs.statSync(log).mode & 0o777, 0o600);
  } finally { await s.stop(); }
});

test("event log: Claude Code's shutdown logs a stop and a relay-only kill (others=0); an init timeout logs a tree-kill", OPTS, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ev-"));
  const log = path.join(dir, "a.log");
  const s = startStub({ mode: "slow-exit", env: { PLAINFLAGS_STUB_EVENT_LOG: log } });
  try {
    await s.handshake();
    await s.call("echo");
    s.child.kill("SIGINT"); await sleep(100); s.child.kill("SIGTERM");
    await exitedWithin(s, 3000);
    const ev = readEvents(log);
    assert.deepStrictEqual(ev.map((e) => [e.kind, e.others, e.brave]), [["stop", undefined, undefined], ["relay-kill", 0, 0]], JSON.stringify(ev));
  } finally { await s.stop(); }
  const log2 = path.join(dir, "b.log");
  const t = startStub({ mode: "no-init", timings: "1,30,1.5", env: { PLAINFLAGS_STUB_EVENT_LOG: log2 } });
  try {
    await t.handshake();
    await t.call("echo", {}, 70);
    const ev = readEvents(log2);
    assert.strictEqual(ev.length, 1, JSON.stringify(ev));
    assert.strictEqual(ev[0].kind, "tree-kill");
    assert.match(ev[0].why, /did not answer initialize within 1 s/);
  } finally { await t.stop(); }
});

test("event log: a fake-relay run never writes the real log, and a log path outside the temp dir is ignored", OPTS, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ev-home-"));
  const real = path.join(home, "Library", "Logs", "plainflags-stub.log");
  const outDir = fs.mkdtempSync("/private/var/tmp/pf-ev-out-"); // writable and outside the temp dir: a broken guard WOULD write here
  assert.ok(!fs.realpathSync(outDir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep), "the outside dir is not under the temp dir");
  const outside = path.join(outDir, "events.log");
  for (const env of [{ HOME: home }, { HOME: home, PLAINFLAGS_STUB_EVENT_LOG: outside }]) {
    const s = startStub({ mode: "ignore-term", timings: "5,3,1", env });
    try {
      await s.handshake();
      await s.call("echo");
      s.child.kill("SIGTERM");
      await exitedWithin(s, 8000);
    } finally { await s.stop(); }
  }
  assert.ok(!fs.existsSync(real), "no event log under the fake HOME");
  const wrote = fs.existsSync(outside);
  fs.rmSync(outDir, { recursive: true, force: true });
  assert.ok(!wrote, "no event log outside the temp dir");
});

test("event log: a FIFO at the log path never blocks a stop (the open is non-blocking; nothing is logged)", OPTS, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ev-"));
  const fifo = path.join(dir, "events.log");
  assert.strictEqual(spawnSync("mkfifo", [fifo]).status, 0, "mkfifo");
  const s = startStub({ mode: "ignore-term", timings: "5,3,1", env: { PLAINFLAGS_STUB_EVENT_LOG: fifo } });
  try {
    await s.handshake();
    await s.call("echo");
    const all = s.pids().flat();
    const t0 = Date.now();
    s.child.kill("SIGTERM");
    await exitedWithin(s, 8000);
    const ms = Date.now() - t0;
    assert.ok(ms >= 900 && ms < 5000, `exited after ${ms} ms (the 1 s grace, not a hang)`);
    await waitDead(all, 3000);
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

test("the test-child override is refused unless it is a file under the temp dir (nothing is started)", OPTS, async () => {
  for (const bad of ["/etc/hosts", path.join(os.tmpdir(), "no-such-fake.js")]) {
    const s = startStub({ fakePath: bad });
    try {
      const ex = await exitedWithin(s, 5000);
      assert.strictEqual(ex.code, 2, bad);
      assert.match(s.stderr(), /PLAINFLAGS_STUB_TEST_CHILD is set but is not a file under the temp dir — refusing/);
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

/** A local page, a temp HOME and project, the plain-flags test fixture, and the relay env. */
async function realSetup(tag) {
  const { homeTmp } = require("./helpers/isolation.js");
  const http = require("node:http");
  const server = http.createServer((req, res) => {
    // /cookie-page sets a persistent cookie: it reaches the profile's Cookies file only if Brave shuts down cleanly.
    const extra = req.url.startsWith("/cookie-page") ? { "set-cookie": "pfstub_keep=1; Max-Age=86400; Path=/" } : {};
    res.writeHead(200, { "content-type": "text/html", ...extra });
    res.end("<!doctype html><html><head><link rel=icon href=data:,></head><body><h1>STUB-E2E</h1></body></html>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const home = homeTmp(`home-pfstub-${tag}-`);
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
  return { server, home, proj, env, url: `http://127.0.0.1:${server.address().port}/stub-page` };
}

/** Every descendant of `pid` (the relay, its upstream, …). */
function descendants(pid) {
  const out = [];
  for (const c of childrenOf(pid)) out.push(c, ...descendants(c));
  return out;
}

test("e2e: the REAL plain-flags relay through the stub — Claude Code's opening (server/discover first) starts no relay; first call starts it; navigation_go-to a local page and challenge_detect work; EOF leaves no relay or Brave", E2E, async () => {
  const { server, home, proj, env, url } = await realSetup("eof");
  const s = startStub({ real: true, env, cwd: proj });
  try {
    assert.deepStrictEqual((await s.request("server/discover", {}, "server-discover-probe-1")).error, { code: -32601, message: "Method not found" });
    await s.handshake();
    assert.deepStrictEqual((await s.request("tools/list", {})).result, untoken(FILE.toolsList, os.tmpdir()));
    await sleep(500);
    assert.deepStrictEqual(childrenOf(s.child.pid), [], "no relay before a tool call");

    let t0 = Date.now();
    const st = await s.call("relay_status", {}, 200, 90000);
    const firstCallMs = Date.now() - t0;
    assert.ok(!st.error && !st.result.isError, JSON.stringify(st).slice(0, 2000));
    const status = JSON.parse(resultText(st));
    assert.strictEqual(status.profileMode, "plainflags");
    assert.strictEqual(status.dir, path.join(home, "Library", "Caches", "browser-mcp-relay", "profiles-plainflags", "proj-pfstub"));
    const relayPids = relayOf(s.child.pid);
    assert.strictEqual(relayPids.length, 1, "one relay process");

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

test("e2e: a bare SIGKILL of the stub leaves no relay and no Brave (the relay sees its stdin close; its stderr is not a pipe to the dead stub)", E2E, async () => {
  const { server, home, proj, env, url } = await realSetup("kill");
  const s = startStub({ real: true, env, cwd: proj });
  let tree = [];
  try {
    await s.handshake();
    const nav = await s.call("navigation_go-to", { url, includeScreenshot: false }, 300, 120000);
    assert.ok(!nav.error && !nav.result.isError, JSON.stringify(nav).slice(0, 2000));
    tree = descendants(s.child.pid);
    assert.ok(tree.length >= 1 && homeBraves(home).length > 0, "relay and Brave running");
    const t0 = Date.now();
    s.child.kill("SIGKILL");
    await exitedWithin(s, 5000);
    const end = Date.now() + 15000;
    while ((tree.some(alive) || homeBraves(home).length) && Date.now() < end) await sleep(100);
    const left = tree.filter(alive);
    assert.deepStrictEqual(left, [], `relay processes still alive after SIGKILL: ${left.join(", ")}`);
    assert.deepStrictEqual(homeBraves(home), [], "no Brave left on the test profile");
    process.stderr.write(`[plainflags-stub e2e] after SIGKILL of the stub: relay tree and Brave gone in ${Date.now() - t0} ms\n`);
  } finally {
    await s.stop();
    for (const p of [...tree, ...homeBraves(home)]) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    server.close();
  }
});

test("e2e: a process-group SIGKILL of the client and the stub together (a window crash) leaves no relay and no Brave — the relay is in that group, as a direct launch is", E2E, async () => {
  const { server, home, proj, env, url } = await realSetup("group");
  // A stand-in for Claude Code: its own process group, which the stub (and so the relay) joins.
  const client = path.join(home, "client.js");
  fs.writeFileSync(client, `
    const { spawn } = require("node:child_process");
    const stub = spawn(${JSON.stringify(PY)}, [${JSON.stringify(STUB)}], { cwd: ${JSON.stringify(proj)}, env: { ...process.env, ...JSON.parse(process.argv[2]) }, stdio: ["pipe", "pipe", "inherit"] });
    const send = (m) => stub.stdin.write(JSON.stringify(m) + "\\n");
    let buf = "";
    stub.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\\n")) !== -1) {
        const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
        if (m.id === 1) { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "navigation_go-to", arguments: { url: process.argv[3], includeScreenshot: false } } }); }
        if (m.id === 2) console.log("READY " + stub.pid + " " + (m.error || m.result.isError ? "ERR" : "OK"));
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: ${JSON.stringify(CLIENT_INIT)} });
    setInterval(() => {}, 1000);
  `);
  const c = spawn(process.execPath, [client, JSON.stringify(env), url], { env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; let err = "";
  c.stdout.on("data", (d) => { out += d; });
  c.stderr.on("data", (d) => { err += d; });
  let tree = [];
  try {
    const end0 = Date.now() + 120000;
    while (!/READY \d+ \w+/.test(out) && Date.now() < end0 && c.exitCode === null) await sleep(100);
    const m = /READY (\d+) (\w+)/.exec(out);
    assert.ok(m, `client never got the navigation result\n${err.slice(-3000)}`);
    assert.strictEqual(m[2], "OK", err.slice(-3000));
    tree = descendants(c.pid);
    const relay = relayOf(Number(m[1]));
    assert.strictEqual(relay.length, 1, "one relay under the stub");
    assert.strictEqual(spawnSync("ps", ["-o", "pgid=", "-p", String(relay[0])], { encoding: "utf8" }).stdout.trim(), String(c.pid), "the relay is in the client's process group");
    assert.ok(homeBraves(home).length > 0, "Brave running");
    const t0 = Date.now();
    process.kill(-c.pid, "SIGKILL");
    const end = Date.now() + 15000;
    while ((tree.some(alive) || homeBraves(home).length) && Date.now() < end) await sleep(100);
    assert.deepStrictEqual(tree.filter(alive), [], "every process of the client's tree is gone");
    assert.deepStrictEqual(homeBraves(home), [], "no Brave left on the test profile");
    process.stderr.write(`[plainflags-stub e2e] after a process-group SIGKILL of client + stub: relay tree and Brave gone in ${Date.now() - t0} ms\n`);
  } finally {
    try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ }
    for (const p of [...tree, ...homeBraves(home)]) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    server.close();
  }
});

test("e2e: the client dies abruptly (its stderr pipe closed, then stdin EOF) — the relay inherits a broken stderr; the stub's grace and tree kill still leave no relay or Brave", E2E, async () => {
  const { server, home, proj, env, url } = await realSetup("abrupt");
  const s = startStub({ real: true, env, cwd: proj });
  let tree = [];
  try {
    await s.handshake();
    const nav = await s.call("navigation_go-to", { url, includeScreenshot: false }, 400, 120000);
    assert.ok(!nav.error && !nav.result.isError, JSON.stringify(nav).slice(0, 2000));
    tree = descendants(s.child.pid);
    const t0 = Date.now();
    s.child.stderr.destroy(); // the reader is gone: the stub's and the relay's stderr writes now fail
    s.child.stdin.end();
    await exitedWithin(s, 20000);
    const end = Date.now() + 10000;
    while ((tree.some(alive) || homeBraves(home).length) && Date.now() < end) await sleep(100);
    assert.deepStrictEqual(tree.filter(alive), [], "every process of the relay's tree is gone");
    assert.deepStrictEqual(homeBraves(home), [], "no Brave left on the test profile");
    const ev = readEvents(path.join(home, "Library", "Logs", "plainflags-stub.log"));
    const kill = ev.find((e) => e.kind === "tree-kill");
    assert.ok(ev[0] && ev[0].kind === "stop" && kill && kill.brave >= 1 && kill.others >= kill.brave,
      `the event log names the Brave the tree kill took: ${JSON.stringify(ev)}`);
    process.stderr.write(`[plainflags-stub e2e] client gone abruptly (broken stderr + EOF): stub exited and relay tree + Brave gone in ${Date.now() - t0} ms; logged ${JSON.stringify(kill)}\n`);
  } finally {
    await s.stop();
    for (const p of [...tree, ...homeBraves(home)]) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    server.close();
  }
});

test("e2e: Claude Code's shutdown sequence while the real relay is still launching Brave — nothing left within ~1.5 s of the SIGKILL", E2E, async () => {
  const { server, home, proj, env, url } = await realSetup("ccstop");
  const s = startStub({ real: true, env, cwd: proj });
  let tree = [];
  try {
    await s.handshake();
    s.call("navigation_go-to", { url, includeScreenshot: false }, 600, 120000).catch(() => { /* never answered: the stub is stopped */ });
    const end0 = Date.now() + 60000;
    while (!homeBraves(home).length && Date.now() < end0) await sleep(20);
    assert.ok(homeBraves(home).length > 0, "Brave is launching");
    tree = descendants(s.child.pid);
    const killedAt = await claudeCodeShutdown(s.child);
    const end = killedAt + 1500;
    while ((tree.some(alive) || homeBraves(home).length) && Date.now() < end) await sleep(50);
    const left = [...new Set([...tree.filter(alive), ...homeBraves(home)])];
    assert.deepStrictEqual(left, [], `still running 1.5 s after the SIGKILL: ${left.join(", ")}`);
    process.stderr.write(`[plainflags-stub e2e] Claude Code's shutdown during a Brave launch: nothing left ${Date.now() - killedAt} ms after the SIGKILL\n`);
  } finally {
    await s.stop();
    for (const p of [...tree, ...homeBraves(home)]) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    server.close();
  }
});

/** A copy of the relay whose closeBrave waits 400 ms first (a Brave that needs >= 300 ms to close), with the stub beside it. */
function slowCloseCopy(root) {
  const dst = path.join(root, "relay-copy");
  fs.mkdirSync(dst);
  for (const f of ["launch-project-isolated.js", "package.json", "plainflags-stub.py", "plainflags-tools.json"]) fs.copyFileSync(path.join(REPO, f), path.join(dst, f));
  for (const d of ["src", "scripts"]) fs.cpSync(path.join(REPO, d), path.join(dst, d), { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.join(REPO, "node_modules")), path.join(dst, "node_modules"));
  const bridge = path.join(dst, "src", "cdp-bridge.js");
  const text = fs.readFileSync(bridge, "utf8");
  const anchor = "async function closeBrave(handle) {\n  if (!handle) return;\n";
  assert.strictEqual(text.split(anchor).length, 2, "closeBrave anchor");
  fs.writeFileSync(bridge, text.replace(anchor, anchor + "  await new Promise((r) => setTimeout(r, 400)); // test copy: a slow close\n"));
  return path.join(dst, "plainflags-stub.py");
}

test("e2e: Claude Code's exact stop sequence lets Brave close GRACEFULLY (relay closeBrave slowed to 400 ms in a copy) — a page-set persistent cookie is in the profile and exit_type is Normal", E2E, async () => {
  const { server, home, proj, env, url } = await realSetup("graceful");
  const s = startStub({ real: true, env, cwd: proj, stub: slowCloseCopy(home) });
  let tree = [];
  try {
    await s.handshake();
    const nav = await s.call("navigation_go-to", { url: url.replace("/stub-page", "/cookie-page"), includeScreenshot: false }, 700, 120000);
    assert.ok(!nav.error && !nav.result.isError, JSON.stringify(nav).slice(0, 2000));
    await sleep(500);
    tree = descendants(s.child.pid);
    assert.ok(homeBraves(home).length > 0, "Brave running");
    const killedAt = await claudeCodeShutdown(s.child);
    const end = killedAt + 15000;
    while ((tree.some(alive) || homeBraves(home).length) && Date.now() < end) await sleep(100);
    assert.deepStrictEqual(homeBraves(home), [], "Brave closed");
    const goneMs = Date.now() - killedAt;
    const profile = path.join(home, "Library", "Caches", "browser-mcp-relay", "profiles-plainflags", "proj-pfstub", "Default");
    const prefs = JSON.parse(fs.readFileSync(path.join(profile, "Preferences"), "utf8"));
    assert.strictEqual(prefs.profile && prefs.profile.exit_type, "Normal", "Brave recorded a clean exit");
    const q = spawnSync("/usr/bin/sqlite3", ["-readonly", path.join(profile, "Cookies"), "select count(*) from cookies where name='pfstub_keep'"], { encoding: "utf8" });
    assert.strictEqual(q.status, 0, q.stderr);
    assert.strictEqual(q.stdout.trim(), "1", "the page's persistent cookie was written to the profile");
    process.stderr.write(`[plainflags-stub e2e] Claude Code's stop with a 400 ms closeBrave: Brave closed cleanly ${goneMs} ms after the SIGKILL, cookie kept\n`);
  } finally {
    await s.stop();
    for (const p of [...tree, ...homeBraves(home)]) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    server.close();
  }
});
