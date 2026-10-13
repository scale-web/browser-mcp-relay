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
const T = { timeout: 30000 }; // a hang must fail the test, not the suite
const SLOT = "700"; // a label only since spec v4 §1b; the fake Brave's port is 10032
// Spec v4 §1b: the upstream child spawned by tools/list before any Brave
// exists carries this unreachable endpoint, and the first Brave ALWAYS
// replaces it ("generation 0 adopts" no longer holds — every launch gets a
// new port/uuid). So child #1 below is that placeholder child.
const PLACEHOLDER = "ws://127.0.0.1:1/devtools/browser/00000000-0000-0000-0000-000000000000";

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

async function startRelay({ attachable, idleMinutes = "0", extraEnv = {}, clone = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-upstream-restart-"));
  if (attachable) fs.writeFileSync(path.join(dir, "attachable"), JSON.stringify(attachable));
  if (clone) fs.writeFileSync(path.join(dir, "clone-mode"), "1");
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("BROWSER_")) env[k] = v;
  }
  Object.assign(env, {
    HARNESS_DIR: dir,
    BROWSER_RELAY_UPSTREAM_PATH: MOCK_BDMCP,
    BROWSER_RELAY_POOL_SLOT: SLOT,
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
  // A relay that dies (e.g. fails at startup) must fail the test, not hang it.
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
  try {
    await request("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" },
  });
  } catch (e) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const upstreamPids = () => {
    try {
      return fs.readFileSync(path.join(dir, "upstream-pids"), "utf8").trim().split("\n").filter(Boolean).map(Number);
    } catch { return []; }
  };
  const braveLaunches = () => {
    try { return fs.readFileSync(path.join(dir, "brave-launches"), "utf8").trim().split("\n").filter(Boolean); } catch { return []; }
  };
  const notices = [];
  const call = async () => {
    const r = await request("tools/call", { name: "navigation_go-to", arguments: { url: "about:blank" } });
    // Relay notices (spec v4 §1c mode announcement) are separate LEADING
    // text items; upstream's own result follows them untouched.
    const own = r.content.filter((c) => c.text.startsWith("[browser-mcp-relay]"));
    notices.push(own.map((c) => c.text));
    const rest = r.content.slice(own.length);
    return { isError: !!r.isError, text: rest[0].text, body: r.isError ? null : JSON.parse(rest[0].text) };
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
  return { child, dir, request, call, notices, killBrave, stop, upstreamPids, braveLaunches, stderr: () => stderr };
}

test("Brave relaunched on the SAME port → upstream child replaced; next forwarded call reaches the fresh child", T, async () => {
  const r = await startRelay();
  try {
    await r.request("tools/list", {});
    const first = await r.call();
    assert.strictEqual(first.isError, false, first.text);
    const [, p1] = r.upstreamPids(); // [0] = the placeholder child
    assert.strictEqual(first.body.pid, p1);

    await r.killBrave();
    const second = await r.call();

    assert.strictEqual(second.isError, false, `wedged after Brave relaunch: ${second.text}`);
    const launches = r.braveLaunches();
    assert.strictEqual(launches.length, 2, "Brave must have been relaunched exactly once");
    assert.strictEqual(launches[0].split(" ")[1], launches[1].split(" ")[1], "precondition: relaunch landed on the SAME port");
    const pids = r.upstreamPids();
    assert.strictEqual(pids.length, 3, "placeholder child + exactly one replacement per Brave");
    assert.notStrictEqual(second.body.pid, p1, "call must be answered by a NEW upstream child");
    assert.strictEqual(second.body.pid, pids[2]);
    assert.strictEqual(second.body.brave, "brave-2");
    await waitFor(() => !isAlive(p1), 3000, "old upstream child to die");
    assert.strictEqual(r.child.exitCode, null, "deliberate restart must not shut the relay down");
  } finally {
    await r.stop();
  }
});

test("§1b: the tools/list child carries the unreachable placeholder and the first Brave replaces it exactly once", T, async () => {
  const r = await startRelay();
  try {
    await r.request("tools/list", {});
    const [p0] = r.upstreamPids();
    const a = await r.call();
    const b = await r.call();
    assert.strictEqual(a.isError, false, a.text);
    assert.strictEqual(b.isError, false, b.text);
    const pids = r.upstreamPids();
    assert.strictEqual(pids.length, 2, "placeholder child + one child for this Brave, no more");
    assert.strictEqual(pids[0], p0);
    assert.strictEqual(a.body.pid, pids[1]);
    assert.strictEqual(b.body.pid, a.body.pid, "the child for this Brave is kept across calls");
    assert.match(a.body.cdp, /^ws:\/\/127\.0\.0\.1:10032\/devtools\/browser\//, "child is pinned to OUR Brave's ws endpoint");
    await waitFor(() => !isAlive(p0), 3000, "placeholder child to die");
    assert.match(r.stderr(), /CDP endpoint changed \(placeholder → ws:/);
  } finally {
    await r.stop();
  }
});

test("§1b/§1e: the pre-Brave child gets the unreachable ws placeholder, no chrome://inspect side effect, no messaging env", T, async () => {
  const r = await startRelay({ extraEnv: { CLAUDE_CODE_MESSAGING_TOKEN: "fake-token", CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/fake.sock" } });
  try {
    await r.request("tools/list", {});
    const res = await r.call();
    assert.strictEqual(res.isError, false, res.text);
    const envs = fs.readFileSync(path.join(r.dir, "upstream-env"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.strictEqual(envs.length, 2);
    assert.strictEqual(envs[0].endpoint, PLACEHOLDER, "gen-0 child: never a slot port, never empty (BDMCP would probe 9222/9229)");
    assert.match(envs[1].endpoint, /^ws:\/\/127\.0\.0\.1:10032\/devtools\/browser\/[0-9a-f-]{36}$/);
    for (const e of envs) {
      assert.strictEqual(e.openInspect, "false", "a failed attach must not open chrome://inspect in the user's Chrome");
      assert.deepStrictEqual(e.messagingKeys, [], "CLAUDE_CODE_MESSAGING_* must not reach the upstream child");
    }
  } finally {
    await r.stop();
  }
});

test("concurrent calls after Brave death share one relaunch and one upstream respawn", T, async () => {
  const r = await startRelay();
  try {
    await r.request("tools/list", {});
    const first = await r.call();
    await r.killBrave();
    const results = await Promise.all([r.call(), r.call(), r.call()]);
    for (const x of results) assert.strictEqual(x.isError, false, x.text);
    assert.strictEqual(r.braveLaunches().length, 2, "one relaunch, not one per call");
    const pids = r.upstreamPids();
    assert.strictEqual(pids.length, 3, "placeholder + one child per Brave: one respawn, not one per call");
    for (const x of results) assert.strictEqual(x.body.pid, pids[2]);
    assert.notStrictEqual(pids[2], first.body.pid);
  } finally {
    await r.stop();
  }
});

test("restart triggered by an OWN-tool call (no immediate respawn) is not treated as a fatal upstream exit", T, async () => {
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

test("attach to an existing Brave restarts upstream onto that Brave's VERIFIED ws endpoint", T, async () => {
  const ws = "ws://127.0.0.1:10040/devtools/browser/abcdefab-0000-0000-0000-000000000040";
  const r = await startRelay({ attachable: { pid: 1, port: 10040, wsEndpoint: ws } });
  try {
    await r.request("tools/list", {}); // spawns upstream on the placeholder
    const res = await r.call();
    assert.strictEqual(res.isError, false, res.text);
    assert.strictEqual(res.body.cdp, ws);
    assert.strictEqual(r.upstreamPids().length, 2);
  } finally {
    await r.stop();
  }
});

test("a fresh upstream whose FIRST call hits a dead Brave is replaced by the next relaunch, not adopted", T, async () => {
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
    const p2 = r.upstreamPids()[2];
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

test("after an idle reap, tools/list then a call reaches a live upstream on the relaunched Brave", T, async () => {
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

test("an upstream spawned by an own-tool AFTER Brave died mid-tool is replaced, not adopted, by the next relaunch", T, async () => {
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
    assert.strictEqual(pids.length, 3, `precondition: the own-tool must spawn child #3: ${JSON.stringify(prop)}`);
    const healed = await r.call();
    assert.strictEqual(healed.isError, false, `adopted a poisoned child: ${healed.text}`);
    assert.notStrictEqual(healed.body.pid, pids[2], "the child spawned with no live Brave must not be reused");
    assert.strictEqual(healed.body.brave, "brave-3");
  } finally {
    await r.stop();
  }
});

test("a tools/list in flight on the old child during a Brave relaunch is answered by the replacement", T, async () => {
  const r = await startRelay({ extraEnv: { MOCK_TOOLS_LIST_DELAY_MS: "800" } });
  try {
    await r.request("tools/list", {});
    const first = await r.call();
    assert.strictEqual(first.isError, false, first.text);
    await r.killBrave();
    const listing = r.request("tools/list", {}); // held 800 ms by child #1
    await new Promise((res) => setTimeout(res, 50));
    const call = await r.call(); // relaunch → restart kills child #1 mid-tools/list
    assert.strictEqual(call.isError, false, call.text);
    const tools = await listing;
    assert.ok(tools.tools.some((t) => t.name === "navigation_go-to"), JSON.stringify(tools));
    assert.ok(r.upstreamPids().length >= 2, "precondition: child #1 must have been replaced");
  } finally {
    await r.stop();
  }
});

test("shutdown with a tools/list in flight never spawns another upstream child", T, async () => {
  const r = await startRelay({ extraEnv: { MOCK_TOOLS_LIST_DELAY_MS: "800" } });
  try {
    const listing = r.request("tools/list", {}).catch((e) => e); // held 800 ms by child #1
    await waitFor(() => r.upstreamPids().length === 1, 3000, "child #1 to spawn");
    const exited = new Promise((res) => r.child.once("exit", res));
    r.child.stdin.end(); // client gone → relay shutdown closes child #1's client mid-tools/list
    await Promise.race([exited, new Promise((res) => setTimeout(res, 8000))]);
    await listing;
    assert.notStrictEqual(r.child.exitCode, null, "relay must have exited");
    // Count spawns from the relay's own log, written synchronously at spawn:
    // a child spawned during shutdown can be killed before it records its pid.
    const spawns = (r.stderr().match(/spawning upstream child/g) || []).length;
    assert.strictEqual(spawns, 1, `a new upstream child was spawned during shutdown:\n${r.stderr()}`);
    assert.strictEqual(r.upstreamPids().length, 1);
  } finally {
    await r.stop();
  }
});

test("§1c: the first tool result carries the mode as a separate LEADING text item, later ones do not", T, async () => {
  const r = await startRelay();
  try {
    await r.call();
    await r.call();
    assert.strictEqual(r.notices[0].length, 1, JSON.stringify(r.notices));
    assert.match(r.notices[0][0], /Browser profile: BASE profile/);
    assert.deepStrictEqual(r.notices[1], [], "announced once per mode change, not on every result");
  } finally {
    await r.stop();
  }
});

test("§1c: relay_status (needsBrave:false) answers without launching Brave", T, async () => {
  const r = await startRelay();
  try {
    const res = await r.request("tools/call", { name: "relay_status", arguments: {} });
    const body = JSON.parse(res.content[res.content.length - 1].text);
    assert.strictEqual(body.mode, "base");
    assert.strictEqual(body.braveAlive, false);
    assert.deepStrictEqual(r.braveLaunches(), [], "relay_status must not launch Brave");
    const list = await r.request("tools/list", {});
    assert.ok(list.tools.some((t) => t.name === "relay_status"), "relay_status is listed (no name collision)");
  } finally {
    await r.stop();
  }
});

test("BACKLOG:212 / amendment 4: a call landing during SIGTERM shutdown never launches a Brave", T, async () => {
  const r = await startRelay();
  try {
    await r.request("tools/list", {});
    const first = await r.call();
    assert.strictEqual(first.isError, false, first.text);
    fs.writeFileSync(path.join(r.dir, "launch-delay-ms"), "600");
    await r.killBrave(); // brave-1 dead; the next call relaunches (slowly)
    const pending = r.call().catch((e) => e);
    await waitFor(() => /HARNESS launch-started/.test(r.stderr()), 3000, "relaunch to start");
    const exited = new Promise((res) => r.child.once("exit", res));
    r.child.kill("SIGTERM"); // stdin stays open — the BACKLOG scenario
    // A call that arrives during shutdown must not start another launch.
    r.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 999, method: "tools/call", params: { name: "navigation_go-to", arguments: { url: "about:blank" } } }) + "\n");
    await Promise.race([exited, new Promise((res) => setTimeout(res, 8000))]);
    await pending;
    assert.notStrictEqual(r.child.exitCode, null, "relay must have exited");
    const launches = r.braveLaunches();
    assert.strictEqual(launches.length, 2, `exactly the in-flight relaunch, nothing after shutdown began:\n${launches.join("\n")}`);
    // The relaunched Brave (brave-2) resolved after shutdown began: it must
    // have been closed, not orphaned.
    assert.match(r.stderr(), /shutdown began during Brave launch — closing it/);
    assert.match(r.stderr(), /HARNESS brave-closed brave-2/);
  } finally {
    await r.stop();
  }
});

test("§1a/N6: shutdown closes Brave BEFORE releasing the pool claim", T, async () => {
  const r = await startRelay();
  try {
    const first = await r.call();
    assert.strictEqual(first.isError, false, first.text);
    const exited = new Promise((res) => r.child.once("exit", res));
    r.child.stdin.end();
    await Promise.race([exited, new Promise((res) => setTimeout(res, 8000))]);
    const err = r.stderr();
    const closed = err.indexOf("HARNESS brave-closed brave-1");
    const released = err.indexOf("HARNESS pool-released");
    assert.ok(closed !== -1 && released !== -1, err);
    assert.ok(closed < released, "Brave must be closed before the claim is released");
  } finally {
    await r.stop();
  }
});

test("amendment 4: a CLONE relay closes its Brave HARD at shutdown (the dir is deleted next); a base relay does not", T, async () => {
  for (const clone of [true, false]) {
    const r = await startRelay({ clone });
    try {
      const res = await r.call();
      assert.strictEqual(res.isError, false, res.text);
      const exited = new Promise((x) => r.child.once("exit", x));
      r.child.stdin.end();
      await Promise.race([exited, new Promise((x) => setTimeout(x, 8000))]);
      const hard = /HARNESS brave-closed brave-1 hard/.test(r.stderr());
      assert.strictEqual(hard, clone, `${clone ? "clone" : "base"}: hard close = ${hard}`);
      assert.ok(r.stderr().indexOf("brave-closed brave-1") < r.stderr().indexOf("HARNESS pool-released"));
    } finally {
      await r.stop();
    }
  }
});

test("§1d: the Meta guard is installed for EVERY Brave generation, attached ones included, on that Brave's endpoint", T, async () => {
  const ws = "ws://127.0.0.1:10040/devtools/browser/abcdefab-0000-0000-0000-000000000040";
  const r = await startRelay({ attachable: { pid: 1, port: 10040, wsEndpoint: ws } });
  try {
    await r.call(); // attach
    fs.rmSync(path.join(r.dir, "attachable"));
    await r.killBrave();
    await r.call(); // relaunch
    const installs = r.stderr().match(/HARNESS guard-installed \S+/g) || [];
    assert.strictEqual(installs.length, 2, installs.join("\n"));
    assert.strictEqual(installs[0], `HARNESS guard-installed ${ws}`, "attached generation guarded");
    assert.match(installs[1], /guard-installed ws:\/\/127\.0\.0\.1:10032\/devtools\/browser\/0{8}-0{4}-0{4}-0{4}-0{11}2$/, "relaunched generation guarded");
  } finally {
    await r.stop();
  }
});

test("desync guard (real relay process): a blank tabs_select refuses execute; a Brave relaunch respawns upstream and clears it", T, async () => {
  const r = await startRelay();
  const text = (res) => res.content.map((c) => c.text).join("\n");
  try {
    fs.writeFileSync(path.join(r.dir, "fake-pages"), JSON.stringify(["about:blank"]));
    await r.request("tools/list", {});
    const warm = await r.request("tools/call", { name: "content_get-as-text", arguments: {} });
    assert.ok(!warm.isError, text(warm));
    const sel = await r.request("tools/call", { name: "tabs_select", arguments: { index: 0 } });
    assert.match(text(sel), /UPSTREAM DESYNC/);
    const before = r.upstreamPids().length;
    const refused = await r.request("tools/call", { name: "execute", arguments: { code: "return 1" } });
    assert.strictEqual(refused.isError, true);
    assert.match(text(refused), /REFUSED execute/);
    const read = await r.request("tools/call", { name: "content_get-as-text", arguments: {} });
    assert.match(text(read), /UPSTREAM DESYNC/, "a read-only tool runs and warns");

    await r.killBrave();
    const after = await r.request("tools/call", { name: "execute", arguments: { code: "return 1" } });
    assert.ok(!after.isError, text(after));
    assert.doesNotMatch(text(after), /UPSTREAM DESYNC|REFUSED/);
    assert.ok(r.upstreamPids().length > before, "the relaunch respawned upstream");
  } finally {
    await r.stop();
  }
});
