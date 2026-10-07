// upstream-restart.test.js — the upstream child must not outlive the Brave it
// attached to (field report 2026-10-06).
//
// BDMCP caches its tool-session context (browser context + page) for the life
// of the child. When Brave dies, V1-5's invalidateBridge makes the next call
// relaunch Brave — usually on the SAME port — so the port-change check never
// fired, the child kept its dead context, and every forwarded tool returned
// "Target page, context or browser has been closed" until the relay restarted.
//
// These tests run the real index.js main() in a child (test/fixtures/
// relay-harness.js) and speak MCP to it over stdio. Only the browser, the pool
// claim and the upstream binary are fakes; spawn/restart/kill are real, and the
// assertions are on process STATE (which pid answered, which pids are alive).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HARNESS = path.join(__dirname, "fixtures", "relay-harness.js");
const MOCK_BDMCP = path.join(__dirname, "fixtures", "mock-bdmcp-session.js");
const SLOT = "700"; // port 9333+699 = 10032 — outside the live relay range 9333-9349

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(pred, ms = 3000, what = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function startRelay({ attachable, idleMinutes = "0" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-upstream-restart-"));
  if (attachable) fs.writeFileSync(path.join(dir, "attachable"), JSON.stringify(attachable));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("BROWSER_")) env[k] = v;
  }
  Object.assign(env, {
    HARNESS_DIR: dir,
    BROWSER_RELAY_UPSTREAM_PATH: MOCK_BDMCP,
    BROWSER_RELAY_POOL_SLOT: SLOT,
    BROWSER_RELAY_IDLE_MINUTES: idleMinutes,
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
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await request("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const upstreamPids = () => {
    try {
      return fs.readFileSync(path.join(dir, "upstream-pids"), "utf8").trim().split("\n").filter(Boolean).map(Number);
    } catch { return []; }
  };
  const braveLaunches = () => {
    try { return fs.readFileSync(path.join(dir, "brave-launches"), "utf8").trim().split("\n").filter(Boolean); } catch { return []; }
  };
  const call = async () => {
    const r = await request("tools/call", { name: "navigation_go-to", arguments: { url: "about:blank" } });
    return { isError: !!r.isError, text: r.content[0].text, body: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  const killBrave = async () => {
    const before = (stderr.match(/HARNESS brave-killed/g) || []).length;
    child.kill("SIGUSR2");
    await waitFor(() => (stderr.match(/HARNESS brave-killed/g) || []).length > before, 3000, "brave kill ack");
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.stdin.end(); // relay's onStdioGone → shutdownAsync → kills upstream
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    // Only ever signal pids this test's relay spawned.
    for (const pid of upstreamPids()) if (isAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { child, dir, request, call, killBrave, stop, upstreamPids, braveLaunches, stderr: () => stderr };
}

test("Brave relaunched on the SAME port → upstream child replaced; next forwarded call reaches the fresh child", async () => {
  const r = await startRelay();
  try {
    await r.request("tools/list", {});
    const first = await r.call();
    assert.strictEqual(first.isError, false, first.text);
    const [p1] = r.upstreamPids();
    assert.strictEqual(first.body.pid, p1);

    await r.killBrave();
    const second = await r.call();

    assert.strictEqual(second.isError, false, `wedged after Brave relaunch: ${second.text}`);
    const launches = r.braveLaunches();
    assert.strictEqual(launches.length, 2, "Brave must have been relaunched exactly once");
    assert.strictEqual(launches[0].split(" ")[1], launches[1].split(" ")[1], "precondition: relaunch landed on the SAME port");
    const pids = r.upstreamPids();
    assert.strictEqual(pids.length, 2, "exactly one replacement upstream child");
    assert.notStrictEqual(second.body.pid, p1, "call must be answered by a NEW upstream child");
    assert.strictEqual(second.body.pid, pids[1]);
    assert.strictEqual(second.body.brave, "brave-2");
    await waitFor(() => !isAlive(p1), 3000, "old upstream child to die");
    assert.strictEqual(r.child.exitCode, null, "deliberate restart must not shut the relay down");
  } finally {
    await r.stop();
  }
});

test("first Brave launch adopts the upstream spawned by tools/list (no wasted restart)", async () => {
  const r = await startRelay();
  try {
    await r.request("tools/list", {});
    const a = await r.call();
    const b = await r.call();
    assert.strictEqual(a.isError, false, a.text);
    assert.strictEqual(b.isError, false, b.text);
    assert.deepStrictEqual(r.upstreamPids(), [a.body.pid], "one upstream child for the whole session");
    assert.strictEqual(b.body.pid, a.body.pid);
  } finally {
    await r.stop();
  }
});

test("concurrent calls after Brave death share one relaunch and one upstream respawn", async () => {
  const r = await startRelay();
  try {
    await r.request("tools/list", {});
    const first = await r.call();
    await r.killBrave();
    const results = await Promise.all([r.call(), r.call(), r.call()]);
    for (const x of results) assert.strictEqual(x.isError, false, x.text);
    assert.strictEqual(r.braveLaunches().length, 2, "one relaunch, not one per call");
    const pids = r.upstreamPids();
    assert.strictEqual(pids.length, 2, "one respawn, not one per call");
    for (const x of results) assert.strictEqual(x.body.pid, pids[1]);
    assert.notStrictEqual(pids[1], first.body.pid);
  } finally {
    await r.stop();
  }
});

test("restart triggered by an OWN-tool call (no immediate respawn) is not treated as a fatal upstream exit", async () => {
  // Own tools run ensureBrave() but never getUpstream(), so after the restart
  // nothing respawns before the old child's exit event lands. Only the
  // clear-state-BEFORE-kill ordering keeps that exit from shutting the relay down.
  const r = await startRelay();
  try {
    await r.request("tools/list", {});
    const first = await r.call();
    await r.killBrave();
    const own = await r.request("tools/call", { name: "tabs_list", arguments: {} });
    assert.ok(!own.isError, JSON.stringify(own));
    await waitFor(() => !isAlive(first.body.pid), 3000, "old upstream child to die");
    await new Promise((res) => setTimeout(res, 300)); // let the exit handler run
    assert.strictEqual(r.child.exitCode, null, `relay exited on a deliberate restart:\n${r.stderr()}`);
    const next = await r.call();
    assert.strictEqual(next.isError, false, next.text);
    assert.notStrictEqual(next.body.pid, first.body.pid);
  } finally {
    await r.stop();
  }
});

test("attach to a Brave on a different port still restarts upstream onto that port", async () => {
  const r = await startRelay({ attachable: { pid: 1, port: 10040 } });
  try {
    await r.request("tools/list", {}); // spawns upstream pointed at the slot port 10032
    const res = await r.call();
    assert.strictEqual(res.isError, false, res.text);
    assert.strictEqual(res.body.cdp, "http://127.0.0.1:10040");
    assert.strictEqual(r.upstreamPids().length, 2);
  } finally {
    await r.stop();
  }
});

test("a fresh upstream whose FIRST call hits a dead Brave is replaced by the next relaunch, not adopted", async () => {
  // BDMCP caches a failed first session (rejected promise / dead context)
  // forever, so a child that saw a dead Brave must never be carried over to
  // the next Brave. Guards against "optimising" the generation record.
  const r = await startRelay();
  try {
    await r.request("tools/list", {});
    const first = await r.call();
    assert.strictEqual(first.isError, false, first.text);
    fs.writeFileSync(path.join(r.dir, "die-on-launch"), "2");
    await r.killBrave();
    const poisoned = await r.call(); // relaunch #2 dies before the call lands
    assert.strictEqual(poisoned.isError, true, `precondition: the fresh child's first call must hit the dead Brave; got ${poisoned.text}`);
    const p2 = r.upstreamPids()[1];
    await waitFor(() => /brave-died-late brave-2/.test(r.stderr()), 3000, "late close event for brave-2");
    const healed = await r.call();
    assert.strictEqual(healed.isError, false, `still wedged: ${healed.text}`);
    assert.strictEqual(r.braveLaunches().length, 3);
    assert.notStrictEqual(healed.body.pid, p2, "the poisoned child must not be reused");
    assert.strictEqual(healed.body.brave, "brave-3");
    await waitFor(() => !isAlive(p2), 3000, "poisoned upstream child to die");
  } finally {
    await r.stop();
  }
});

test("after an idle reap, tools/list then a call reaches a live upstream on the relaunched Brave", async () => {
  const r = await startRelay({ idleMinutes: "0.01" }); // ~0.6 s
  try {
    await r.request("tools/list", {});
    const first = await r.call();
    assert.strictEqual(first.isError, false, first.text);
    await waitFor(() => /reaping Brave \+ upstream/.test(r.stderr()), 5000, "idle reap");
    await waitFor(() => !isAlive(first.body.pid), 3000, "reaped upstream child to die");
    await r.request("tools/list", {});
    const next = await r.call();
    assert.strictEqual(next.isError, false, `wedged after idle reap: ${next.text}`);
    assert.strictEqual(next.body.brave, "brave-2");
    const pids = r.upstreamPids();
    assert.strictEqual(next.body.pid, pids[pids.length - 1], "answered by the newest upstream child");
    for (const pid of pids.slice(0, -1)) await waitFor(() => !isAlive(pid), 3000, `old upstream ${pid} to die`);
    assert.strictEqual(r.child.exitCode, null, "relay must stay up");
  } finally {
    await r.stop();
  }
});

test("an upstream spawned by an own-tool AFTER Brave died mid-tool is replaced, not adopted, by the next relaunch", async () => {
  // tabs_new / tabs_select reach upstream through __relayUpstream after their
  // own browser work. If Brave dies in between, that spawn happens with no
  // live Brave and its first call is poisoned for the child's life (BDMCP).
  // Recording generation 0 for such a child would let the next Brave adopt it.
  const r = await startRelay();
  try {
    await r.request("tools/list", {});
    const first = await r.call();
    assert.strictEqual(first.isError, false, first.text);
    await r.killBrave();
    const own = await r.request("tools/call", { name: "tabs_list", arguments: {} }); // relaunch #2 kills child #1; nothing respawns
    assert.ok(!own.isError, JSON.stringify(own));
    await waitFor(() => !isAlive(first.body.pid), 3000, "child #1 to die");
    const prop = await r.request("tools/call", { name: "harness_die_then_propagate", arguments: {} });
    const pids = r.upstreamPids();
    assert.strictEqual(pids.length, 2, `precondition: the own-tool must spawn child #2: ${JSON.stringify(prop)}`);
    const healed = await r.call();
    assert.strictEqual(healed.isError, false, `adopted a poisoned child: ${healed.text}`);
    assert.notStrictEqual(healed.body.pid, pids[1], "the child spawned with no live Brave must not be reused");
    assert.strictEqual(healed.body.brave, "brave-3");
  } finally {
    await r.stop();
  }
});
