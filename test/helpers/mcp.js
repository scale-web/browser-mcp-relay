// test/helpers/mcp.js — spawn a REAL relay (launch-project-isolated.js or
// src/index.js) under the harness's temp HOME and speak MCP to it over stdio.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { REPO, isolated } = require("./isolation.js");

const MOCK_BDMCP = path.join(REPO, "test", "fixtures", "mock-bdmcp-session.js");

/**
 * @param {object} o
 * @param {"launcher"|"index"} [o.entry="launcher"]
 * @param {object} [o.env] — merged over the harness env (BROWSER_* from the
 *   operator's shell were already dropped by the harness)
 * @param {boolean} [o.realUpstream=false] — use the real browser-devtools-mcp
 */
async function startRelay({ entry = "launcher", env = {}, realUpstream = false, harnessDir } = {}) {
  if (!isolated()) throw new Error("startRelay outside the harness");
  const file = entry === "launcher" ? path.join(REPO, "launch-project-isolated.js") : path.join(REPO, "src", "index.js");
  const fullEnv = { ...process.env, BROWSER_RELAY_IDLE_MINUTES: "0", ...env };
  if (!realUpstream) {
    fullEnv.BROWSER_RELAY_UPSTREAM_PATH = MOCK_BDMCP;
    fullEnv.HARNESS_DIR = harnessDir || fs.mkdtempSync(path.join(require("node:os").homedir(), "mock-upstream-"));
  }
  if (entry === "launcher") delete fullEnv.BROWSER_RELAY_POOL_DIR; // the launcher sets it
  const child = spawn(process.execPath, [file], { cwd: REPO, env: fullEnv, stdio: ["pipe", "pipe", "pipe"] });
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
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    }
  });
  const exited = new Promise((r) => child.once("exit", (code, sig) => {
    for (const [, p] of pending) p.reject(new Error(`relay exited code=${code} signal=${sig}\n${stderr}`));
    pending.clear();
    r({ code, sig });
  }));
  let nextId = 1;
  const request = (method, params, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}\n${stderr.slice(-2000)}`)); }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const call = async (name, args = {}, timeoutMs) => {
    const r = await request("tools/call", { name, arguments: args }, timeoutMs);
    const notices = r.content.filter((c) => c.type === "text" && c.text.startsWith("[browser-mcp-relay]")).map((c) => c.text);
    const rest = r.content.slice(notices.length);
    return { ...r, notices, rest, text: rest.map((c) => c.text || "").join("\n") };
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
  };
  return { child, init, request, call, stop, exited, stderr: () => stderr };
}

module.exports = { startRelay, MOCK_BDMCP };
