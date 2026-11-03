// fake-plainflags-relay.js — stands in for launch-project-isolated.js in
// test/plainflags-stub.test.js. The test copies it under the system temp dir
// (plainflags-stub.py starts a test child only from there) and drives it by env:
//   FAKE_DIR     received.jsonl (every line it read), pids (one line per start:
//                "<pid> <grandchild pid>"), info-<pid>.json (cwd, profile mode)
//   FAKE_MODE    comma list: no-init (never answers initialize), init-error,
//                ignore-term (ignores SIGTERM and stdin EOF)
//   FAKE_STATIC  plainflags-tools.json — its toolsList is served by default
//   FAKE_TOOLS   a toolsList JSON to serve instead (the drift case)
// Tools: echo {delayMs} → {id, args} as the relay saw them, after a
// notifications/message; crash → exit 3; listchanged → a list_changed first.
// It starts a grandchild in its own process group, as the real relay starts
// its upstream child, so a kill of only this pid leaves that one behind.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const dir = process.env.FAKE_DIR;
const modes = new Set((process.env.FAKE_MODE || "").split(",").filter(Boolean));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.appendFileSync(path.join(dir, "pids"), `${process.pid} ${grandchild.pid}\n`);
fs.writeFileSync(path.join(dir, `info-${process.pid}.json`), JSON.stringify({ cwd: process.cwd(), profileMode: process.env.BROWSER_RELAY_PROFILE_MODE }));
process.stderr.write(`fake-relay: started pid=${process.pid}\n`);

function toolsList() {
  if (process.env.FAKE_TOOLS) return JSON.parse(fs.readFileSync(process.env.FAKE_TOOLS, "utf8"));
  const text = JSON.stringify(JSON.parse(fs.readFileSync(process.env.FAKE_STATIC, "utf8")).toolsList);
  return JSON.parse(text.split(JSON.stringify("${os.tmpdir()}")).join(JSON.stringify(os.tmpdir())));
}

function handle(msg) {
  if (msg.method === "initialize") {
    if (modes.has("no-init")) return;
    if (modes.has("init-error")) return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "no" } });
    return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: toolsList() });
  if (msg.method === "ping") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method === "tools/call") {
    const { name, arguments: args = {} } = msg.params || {};
    if (name === "crash") process.exit(3);
    if (name === "listchanged") send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "fake-note" } });
    const reply = () => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ id: msg.id, args }) }] } });
    return args.delayMs ? setTimeout(reply, args.delayMs) : reply();
  }
  if (msg.id !== undefined && msg.method) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    fs.appendFileSync(path.join(dir, "received.jsonl"), line + "\n");
    let msg = null;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
if (modes.has("ignore-term")) {
  process.on("SIGTERM", () => {});
  process.stdin.on("end", () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdin.on("end", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(143));
}
