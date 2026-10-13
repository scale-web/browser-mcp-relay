// idle-reaper-cdp-clients.test.js — the idle reaper must not kill a Brave that
// a session is driving DIRECTLY over its CDP port (register A51 D1; 3 Braves
// killed mid-script on 2026-10-12).
//
//   1. parseLsofClients / externalClients on real-shaped `lsof -F pn` output.
//   2. listExternalCdpClients with a stubbed execFile: failures and hangs
//      resolve { ok: false } within the timeout, never throw.
//   3. Real processes: a TCP listener on port 0, clients in a CHILD process
//      and in this process, read back with the real lsof.
//   4. The real index.js main() (test/fixtures/relay-harness.js) with a tiny
//      BROWSER_RELAY_IDLE_MINUTES: an external client keeps Brave alive, its
//      disconnect lets the reap happen, and a hung lsof falls back to reaping.
//      The relay process and the upstream child each hold their own connection
//      to the fake Brave's port, so both must be excluded for the reap to run.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { lsofCommand, parseLsofClients, externalClients, listExternalCdpClients } = require("../src/cdp-clients.js");

const HARNESS = path.join(__dirname, "fixtures", "relay-harness.js");
const MOCK_BDMCP = path.join(__dirname, "fixtures", "mock-bdmcp-session.js");
const T = { timeout: 45000 };

// Shape copied from a real run (macOS lsof 4.91): Brave 28657 listens on 9335
// and holds the accepted (server) end of each connection; relay 15323,
// upstream 15400 and a shell script 40001 hold client ends.
const LSOF_OUT = [
  "p28657",
  "f31", "n127.0.0.1:9335->127.0.0.1:50001",
  "f32", "n127.0.0.1:9335->127.0.0.1:50002",
  "f33", "n127.0.0.1:9335->127.0.0.1:50003",
  "p15323",
  "f24", "n127.0.0.1:50001->127.0.0.1:9335",
  "p15400",
  "f19", "n127.0.0.1:50002->127.0.0.1:9335",
  "p40001",
  "f12", "n127.0.0.1:50003->127.0.0.1:9335",
  "f13", "n[::1]:50004->[::1]:9335",
  "f14", "n127.0.0.1:50005->127.0.0.1:19335",
  "",
].join("\n");

// ───── 1. parsing + exclusion ─────

test("parseLsofClients keeps only client sockets whose REMOTE end is 127.0.0.1:<port>", () => {
  const got = parseLsofClients(LSOF_OUT, 9335);
  assert.deepStrictEqual(got.map((c) => c.pid), [15323, 15400, 40001]);
  assert.deepStrictEqual(got[2], { pid: 40001, local: "127.0.0.1:50003", remote: "127.0.0.1:9335" });
  assert.ok(!got.some((c) => c.pid === 28657), "Brave's accepted (server) sockets are not clients");
});

test("externalClients excludes the relay, upstream and Brave pids", () => {
  assert.deepStrictEqual(externalClients(LSOF_OUT, 9335, [15323, 15400, 28657]).map((c) => c.pid), [40001]);
  assert.deepStrictEqual(externalClients(LSOF_OUT, 9335, [15323, 15400, 40001]), []);
  // A non-integer exclude (no upstream child yet: null) is ignored, not a crash.
  assert.deepStrictEqual(externalClients(LSOF_OUT, 9335, [15323, null, undefined, 28657]).map((c) => c.pid), [15400, 40001]);
});

test("server sockets only, IPv6 only, another port, or garbage → no clients", () => {
  const serverOnly = "p28657\nf31\nn127.0.0.1:9335->127.0.0.1:50001\n";
  assert.deepStrictEqual(parseLsofClients(serverOnly, 9335), []);
  assert.deepStrictEqual(parseLsofClients("p1\nf3\nn[::1]:50004->[::1]:9335\n", 9335), []);
  assert.deepStrictEqual(parseLsofClients("p1\nf3\nn127.0.0.1:5->127.0.0.1:93350\n", 9335), []);
  assert.deepStrictEqual(parseLsofClients("", 9335), []);
  assert.deepStrictEqual(parseLsofClients("n127.0.0.1:1->127.0.0.1:9335\nnot lsof\n", 9335), [], "an n line with no p line has no owner");
});

// ───── 2. stubbed execFile ─────

const stub = (fn) => (cmd, args, opts, cb) => fn(cb, { cmd, args, opts });

test("listExternalCdpClients runs the address-specific ESTABLISHED lsof and filters its output", async () => {
  let seen;
  const r = await listExternalCdpClients({
    port: 9335, excludePids: [15323, 15400, 28657],
    _execFile: stub((cb, call) => { seen = call; cb(null, LSOF_OUT, ""); }),
  });
  assert.deepStrictEqual(r, { ok: true, clients: [{ pid: 40001, local: "127.0.0.1:50003", remote: "127.0.0.1:9335" }] });
  assert.strictEqual(seen.cmd, lsofCommand());
  assert.deepStrictEqual(seen.args, ["-nP", "-w", "-iTCP@127.0.0.1:9335", "-sTCP:ESTABLISHED", "-F", "pn"]);
  assert.strictEqual(seen.opts.timeout, 3000);
});

test("lsof exit 1 with no output means no sockets, not a failure", async () => {
  const e = Object.assign(new Error("exit 1"), { code: 1 });
  assert.deepStrictEqual(await listExternalCdpClients({ port: 9335, _execFile: stub((cb) => cb(e, "", "")) }), { ok: true, clients: [] });
});

test("lsof missing, erroring, timed out, throwing or never answering → { ok: false }, never a throw or a hang", async () => {
  const enoent = Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
  const errored = Object.assign(new Error("exit 1"), { code: 1 });
  const timedOut = Object.assign(new Error("killed"), { killed: true, signal: "SIGKILL", code: null });
  const cases = [
    ["ENOENT", stub((cb) => cb(enoent, "", "")), /ENOENT/],
    ["exit 1 + stderr", stub((cb) => cb(errored, "", "lsof: unacceptable port\n")), /unacceptable port/],
    ["timeout kill", stub((cb) => cb(timedOut, "", "")), /timed out/],
    ["sync throw", () => { throw new Error("EAGAIN"); }, /could not be started.*EAGAIN/],
    ["never calls back", stub(() => {}), /did not return within 1100ms/],
  ];
  for (const [name, fn, re] of cases) {
    const t0 = Date.now();
    const r = await listExternalCdpClients({ port: 9335, timeoutMs: 100, _execFile: fn });
    assert.strictEqual(r.ok, false, name);
    assert.match(r.reason, re, name);
    assert.ok(Date.now() - t0 < 2000, `${name}: must resolve within the hard cap`);
  }
});

test("lsofCommand: /usr/sbin/lsof on darwin when it exists, else a PATH lookup", () => {
  assert.strictEqual(lsofCommand({ platform: "darwin", exists: (p) => p === "/usr/sbin/lsof" }), "/usr/sbin/lsof");
  assert.strictEqual(lsofCommand({ platform: "darwin", exists: () => false }), "lsof");
  assert.strictEqual(lsofCommand({ platform: "linux", exists: () => true }), "lsof");
  assert.strictEqual(lsofCommand({ platform: "win32", exists: () => true }), "lsof");
  if (process.platform === "darwin") assert.strictEqual(lsofCommand(), "/usr/sbin/lsof", "this Mac has /usr/sbin/lsof");
});

test("listExternalCdpClients runs lsofCommand() unless a binary is injected", async () => {
  const seen = [];
  const exec = stub((cb, call) => { seen.push(call.cmd); cb(null, "", ""); });
  await listExternalCdpClients({ port: 9335, _execFile: exec });
  await listExternalCdpClients({ port: 9335, _execFile: exec, _lsofPath: "/tmp/fake-lsof" });
  assert.deepStrictEqual(seen, [lsofCommand(), "/tmp/fake-lsof"]);
});

test("an invalid port never runs lsof", async () => {
  for (const port of [null, 0, 70000, "9335"]) {
    let ran = false;
    const r = await listExternalCdpClients({ port, _execFile: stub(() => { ran = true; }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(ran, false);
  }
});

// ───── 3. real processes, real lsof ─────

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function waitFor(pred, ms = 3000, what = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A 127.0.0.1 listener on an OS-assigned port, standing in for Brave's CDP port. */
async function listener() {
  const accepted = new Set();
  const srv = net.createServer((s) => { accepted.add(s); s.on("close", () => accepted.delete(s)); s.on("error", () => {}); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    port: srv.address().port,
    accepted: () => accepted.size,
    close: () => { for (const s of accepted) s.destroy(); srv.close(); },
  };
}

/** A child process that connects to 127.0.0.1:<port> and holds the socket. */
function cdpClientChild(port) {
  return spawn(process.execPath, ["-e",
    `const s=require("net").connect(${port},"127.0.0.1");s.on("error",()=>{});setInterval(()=>{},1e6);`,
  ], { stdio: "ignore" });
}

test("real lsof: a CHILD's client socket is reported; this process's own client and the listener's server sockets are not", T, async () => {
  const l = await listener();
  const child = cdpClientChild(l.port);
  const own = net.connect(l.port, "127.0.0.1");
  try {
    await waitFor(() => l.accepted() === 2, 3000, "both connections accepted");
    const r = await listExternalCdpClients({ port: l.port, excludePids: [process.pid] });
    assert.strictEqual(r.ok, true, r.reason);
    assert.deepStrictEqual(r.clients.map((c) => c.pid), [child.pid]);
    assert.strictEqual(r.clients[0].remote, `127.0.0.1:${l.port}`);

    const none = await listExternalCdpClients({ port: l.port, excludePids: [process.pid, child.pid] });
    assert.deepStrictEqual(none, { ok: true, clients: [] }, "excluded pids are not reported");

    // Without the exclusion this process's CLIENT socket shows up — and only
    // that one: its accepted (server) sockets never count.
    const all = await listExternalCdpClients({ port: l.port });
    assert.deepStrictEqual(all.clients.map((c) => c.pid).sort(), [process.pid, child.pid].sort());
  } finally {
    own.destroy();
    child.kill("SIGKILL");
    l.close();
  }
});

// ───── 4. the real relay ─────

async function startRelay({ idleMinutes, files = {}, extraEnv = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reaper-cdp-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("BROWSER_")) env[k] = v;
  Object.assign(env, {
    HARNESS_DIR: dir,
    BROWSER_RELAY_UPSTREAM_PATH: MOCK_BDMCP,
    BROWSER_RELAY_POOL_SLOT: "701",
    BROWSER_RELAY_IDLE_MINUTES: idleMinutes,
    ...extraEnv,
  });
  const child = spawn(process.execPath, [HARNESS], { stdio: ["pipe", "pipe", "pipe"], env });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    }
  });
  child.on("exit", (code, signal) => {
    for (const [, p] of pending) p.reject(new Error(`relay exited code=${code} signal=${signal}\n${stderr}`));
    pending.clear();
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const upstreamPids = () => {
    try { return fs.readFileSync(path.join(dir, "upstream-pids"), "utf8").trim().split("\n").filter(Boolean).map(Number); } catch { return []; }
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.stdin.end();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    for (const pid of upstreamPids()) if (isAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  } catch (e) {
    await stop();
    throw e;
  }
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const call = async () => {
    const r = await request("tools/call", { name: "navigation_go-to", arguments: { url: "about:blank" } });
    const rest = r.content.filter((c) => !c.text.startsWith("[browser-mcp-relay]"));
    return { isError: !!r.isError, text: rest[0].text };
  };
  const count = (re) => (stderr.match(re) || []).length;
  return { child, dir, request, call, stop, count, stderr: () => stderr };
}

const REAPED = /reaping Brave \+ upstream/g;

async function externalClientKeepsBrave(extraEnv = {}) {
  const l = await listener();
  const ext = cdpClientChild(l.port);
  let r;
  try {
    await waitFor(() => l.accepted() === 1, 3000, "external client connected");
    r = await startRelay({ idleMinutes: "0.01", files: { "brave-port": String(l.port), "upstream-connects": "1" }, extraEnv }); // ~0.6 s
    await r.request("tools/list", {});
    const first = await r.call();
    assert.strictEqual(first.isError, false, first.text);
    // Precondition for the exclusion mutants: the relay AND the upstream child
    // hold their own client connections to the port.
    await waitFor(() => l.accepted() === 3, 3000, "relay + upstream connected to the CDP port");

    await new Promise((res) => setTimeout(res, 3500)); // ≥ 5 idle periods
    assert.strictEqual(r.count(REAPED), 0, `reaped while an external client was connected:\n${r.stderr()}`);
    assert.ok(new RegExp(`external CDP client\\(s\\) on 127\\.0\\.0\\.1:${l.port} \\(pid ${ext.pid}\\)`).test(r.stderr()),
      `the reaper must name the external client (and only it):\n${r.stderr()}`);
    assert.ok(!/brave-closed/.test(r.stderr()), "Brave must not have been closed");

    ext.kill("SIGKILL");
    await waitFor(() => r.count(REAPED) === 1, 8000, "reap after the external client disconnected");
    await waitFor(() => /brave-closed brave-1 hard/.test(r.stderr()), 3000, "Brave hard-closed");
    assert.strictEqual(r.child.exitCode, null, "relay must stay up");
    assert.ok(!/check unavailable/.test(r.stderr()), "real lsof must have worked");
  } finally {
    if (isAlive(ext.pid)) ext.kill("SIGKILL");
    if (r) await r.stop();
    l.close();
  }
}

test("relay: an external CDP client keeps Brave alive; once it disconnects the reaper reaps", T, () => externalClientKeepsBrave());

test("relay: started with PATH=/usr/bin:/bin (no /usr/sbin) it still finds lsof and detects the external client", T,
  () => externalClientKeepsBrave({ PATH: "/usr/bin:/bin" }));

test("relay: a hung lsof neither crashes nor wedges the reaper — it falls back to reaping, logged once", T, async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fake-lsof-"));
  const marker = path.join(bin, "calls");
  fs.writeFileSync(path.join(bin, "lsof"), `#!/bin/sh\necho x >> '${marker}'\nexec sleep 30\n`, { mode: 0o755 });
  const r = await startRelay({ idleMinutes: "0.01", files: { "lsof-bin": path.join(bin, "lsof") } });
  try {
    await r.request("tools/list", {});
    assert.strictEqual((await r.call()).isError, false);
    await waitFor(() => r.count(REAPED) === 1, 10000, "reap after the lsof timeout");
    assert.match(r.stderr(), /external-CDP-client check unavailable \(lsof timed out after 3000ms\)/);

    // A second Brave, a second failed check: still reaped, still logged once.
    assert.strictEqual((await r.call()).isError, false);
    await waitFor(() => r.count(REAPED) === 2, 10000, "second reap");
    assert.strictEqual(r.count(/check unavailable/g), 1, "the failure is logged once per relay");
    const calls = fs.readFileSync(marker, "utf8").trim().split("\n").length;
    assert.strictEqual(calls, 2, `one lsof per reap decision, no stacking (got ${calls})`);
    assert.strictEqual(r.child.exitCode, null, "relay must stay up");
  } finally {
    await r.stop();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("relay: a tool call that lands WHILE lsof runs cancels that reap (the post-lsof re-check)", T, async () => {
  // Slow fake lsof: 1.5 s, then "no sockets" (exit 1, no output). Idle 0.05 min
  // = 3 s, ticks every 3 s. The call lands mid-lsof and resets the idle clock,
  // so the next reap is ≥ 3 s after it; without the re-check the tick that
  // started the lsof reaps right after it returns.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "relay-slow-lsof-"));
  const started = path.join(bin, "started");
  fs.writeFileSync(path.join(bin, "lsof"), `#!/bin/sh\necho x >> '${started}'\nsleep 1.5\nexit 1\n`, { mode: 0o755 });
  const r = await startRelay({ idleMinutes: "0.05", files: { "lsof-bin": path.join(bin, "lsof") } });
  try {
    await r.request("tools/list", {});
    assert.strictEqual((await r.call()).isError, false);
    await waitFor(() => fs.existsSync(started), 10000, "the reaper's lsof to start");
    assert.strictEqual(r.count(REAPED), 0, "precondition: nothing reaped before the lsof");
    const mid = await r.call();
    assert.strictEqual(mid.isError, false, mid.text);
    await new Promise((res) => setTimeout(res, 2000)); // lsof returns ~1.5 s after it started
    assert.strictEqual(r.count(REAPED), 0, `reaped although a call landed mid-lsof:\n${r.stderr()}`);
    assert.ok(!/check unavailable/.test(r.stderr()), "the slow lsof must have answered, not timed out");
    assert.strictEqual(r.child.exitCode, null, "relay must stay up");
  } finally {
    await r.stop();
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
