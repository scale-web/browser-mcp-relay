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

const shared = {}; // one copy per test process and kind (patched / unpatched)

/** `pkgDir`: the package to copy (default: the installed one) — a test seam. */
function patchedCopy({ patched = true, pkgDir = null } = {}) {
  const kind = `${patched ? "patched" : "unpatched"}:${pkgDir || ""}`;
  if (shared[kind]) return shared[kind];
  const pkg = pkgDir || path.dirname(require.resolve("browser-devtools-mcp/package.json"));
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
  // unpatched: what a relay runs when an upstream upgrade changed the bundle shape (R1 not applied).
  if (patched) {
    const r = repin.applyPatch({ distDir: dist, log: () => {} });
    if (!r.patched) throw new Error(`re-pin patch did not apply to the copy: ${r.reason}`);
  } else {
    // The installed bundle may already carry R1 (a relay started from this
    // checkout patches it on disk): take __relayPin out of execute's sandbox,
    // which is all the relay can see of a missing patch.
    const file = repin.findSessionFile({ distDir: dist });
    const content = fs.readFileSync(file, "utf8");
    const entry = `,${repin.SANDBOX_NAME}:(targetId)=>${repin.HELPER_NAME}(this,targetId)`;
    const out = content.replace(entry, "");
    // The sandbox ENTRY, not the bare name: the helper's own error texts say "__relayPin: …".
    if (out.includes(entry) || !out.includes("executionContext(){return{page:this.page}}")) {
      throw new Error("could not take __relayPin out of the unpatched copy's execute sandbox");
    }
    fs.writeFileSync(file, out);
  }
  process.once("exit", () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  shared[kind] = { root, entry: path.join(dist, "index.js") };
  return shared[kind];
}

/** Spawn upstream (patched unless `patched: false`) on `wsEndpoint`: { client, stderr(), stop() }. */
function startRealUpstream(wsEndpoint, { patched = true } = {}) {
  const { entry } = patchedCopy({ patched });
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
