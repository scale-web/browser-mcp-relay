// reaper-relay.js — shared by the idle-reaper tests: a 127.0.0.1 listener that
// stands in for Brave's CDP port, a child process holding a client socket to
// it, and the real index.js main() under test/fixtures/relay-harness.js.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HARNESS = path.join(__dirname, "..", "fixtures", "relay-harness.js");
const MOCK_BDMCP = path.join(__dirname, "..", "fixtures", "mock-bdmcp-session.js");

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

async function startRelay({ idleMinutes, files = {}, extraEnv = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reaper-cdp-"));
  // The harness's claimed profile dir (status sidecar, keep-alive file).
  fs.mkdirSync(path.join(dir, "profile"));
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
  /** Simulate Brave dying (harness SIGUSR2); resolves once acknowledged. */
  const killBrave = async () => {
    const before = count(/HARNESS brave-killed/g);
    child.kill("SIGUSR2");
    await waitFor(() => count(/HARNESS brave-killed/g) > before, 3000, "brave kill ack");
  };
  return { child, dir, profileDir: path.join(dir, "profile"), request, call, stop, count, killBrave, stderr: () => stderr };
}

module.exports = { isAlive, waitFor, listener, cdpClientChild, startRelay };
