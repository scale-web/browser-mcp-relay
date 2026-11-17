// test/helpers/real-upstream.js — the REAL browser-devtools-mcp, re-pin patch
// applied, as an MCP stdio child attached to a test browser over CDP.
//
// The package is COPIED to a temp node_modules (its dependencies symlinked
// next to it) and patched there, so a test never writes the installed bundle —
// which every relay on the machine may be loading.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { UpstreamClient } = require("../../src/upstream-client.js");
const repin = require("../../scripts/patch-bdmcp-repin.js");

let shared = null; // one patched copy per test process

function patchedCopy() {
  if (shared) return shared;
  const pkg = path.dirname(require.resolve("browser-devtools-mcp/package.json"));
  const realPkg = fs.realpathSync(pkg);
  const srcModules = path.dirname(realPkg);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bdmcp-"));
  const nm = path.join(root, "node_modules");
  fs.mkdirSync(nm);
  for (const name of fs.readdirSync(srcModules)) {
    if (name === "browser-devtools-mcp") continue;
    fs.symlinkSync(path.join(srcModules, name), path.join(nm, name));
  }
  fs.cpSync(realPkg, path.join(nm, "browser-devtools-mcp"), { recursive: true });
  const dist = path.join(nm, "browser-devtools-mcp", "dist");
  const r = repin.applyPatch({ distDir: dist, log: () => {} });
  if (!r.patched) throw new Error(`re-pin patch did not apply to the copy: ${r.reason}`);
  process.once("exit", () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  shared = { root, entry: path.join(dist, "index.js") };
  return shared;
}

/** Spawn patched upstream on `wsEndpoint`: { client, stderr(), stop() }. */
function startRealUpstream(wsEndpoint) {
  const { entry } = patchedCopy();
  const child = spawn(process.execPath, [entry, "--cursor-mcp-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      BROWSER_CDP_ENDPOINT_URL: wsEndpoint,
      BROWSER_CDP_OPEN_INSPECT: "false",
      TELEMETRY_ENABLE: "false",
    },
  });
  let err = "";
  child.stderr.on("data", (c) => { err += c; });
  const client = new UpstreamClient(child.stdout, child.stdin);
  return {
    client,
    stderr: () => err,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 3000).unref();
    }),
  };
}

module.exports = { startRealUpstream, patchedCopy };
