// Stand-in for browser-devtools-mcp that reproduces the one behaviour the
// Brave-relaunch bug depends on: BDMCP builds its tool-session context (browser
// context + page) on the FIRST tools/call and caches it for the life of the
// process (dist/index.js `toolSessionContext ||= ...`, never invalidated). If
// the Brave it attached to dies, every later call fails with Playwright's
// "Target page, context or browser has been closed" — even after a new Brave
// comes up on the same port.
//
// "Which Brave is alive" is the text in $HARNESS_DIR/brave-alive, written by
// relay-harness.js's fake launchBrave. On first tools/call this child latches
// that value; afterwards, if the file no longer matches, it answers like a
// wedged BDMCP. Every spawn appends its pid to $HARNESS_DIR/upstream-pids.
const fs = require("node:fs");
const path = require("node:path");

const dir = process.env.HARNESS_DIR;
fs.appendFileSync(path.join(dir, "upstream-pids"), `${process.pid}\n`);
const readAlive = () => {
  try { return fs.readFileSync(path.join(dir, "brave-alive"), "utf8"); } catch { return "none"; }
};

let attachedTo = null;
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    let result;
    if (msg.method === "tools/list" && process.env.MOCK_TOOLS_LIST_DELAY_MS) {
      // Answer later, out of order — lets a test keep a tools/list in flight.
      const reply = { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "navigation_go-to", description: "mock", inputSchema: { type: "object" } }] } };
      setTimeout(() => process.stdout.write(JSON.stringify(reply) + "\n"), Number(process.env.MOCK_TOOLS_LIST_DELAY_MS));
      continue;
    } else if (msg.method === "tools/list") {
      result = { tools: [{ name: "navigation_go-to", description: "mock", inputSchema: { type: "object" } }] };
    } else if (msg.method === "tools/call") {
      if (attachedTo === null) attachedTo = readAlive();
      // A first call that found Brave dead poisons the child for good — BDMCP
      // caches the failed session (rejected promise) for the process's life.
      if (attachedTo === "dead" || attachedTo !== readAlive()) {
        result = {
          content: [{ type: "text", text: "Error: browserContext.newPage: Target page, context or browser has been closed" }],
          isError: true,
        };
      } else {
        result = { content: [{ type: "text", text: JSON.stringify({
          pid: process.pid, brave: attachedTo, cdp: process.env.BROWSER_CDP_ENDPOINT_URL,
        }) }] };
      }
    } else {
      result = {};
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  }
});
process.stdin.on("end", () => process.exit(0));
