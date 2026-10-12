// Runs the REAL src/index.js main() — real RelayServer, real MCP stdio server,
// real spawnUpstream/getUpstream/ensureBrave/restart logic, real child
// processes — with only its external collaborators replaced:
//   - cdp-bridge.js   → a fake Brave (no browser is launched)
//   - pool-shared.js  → a claim in $HARNESS_DIR (no real profile, lock or reap)
//   - meta-guard.js   → layers 2/3 are no-ops (no CDP endpoint to attach to);
//                       layer 1 (checkToolArgs) stays real
//   - scripts/patch-bdmcp-bundle.js → no-op (never write node_modules)
// The upstream child is test/fixtures/mock-bdmcp-session.js via
// BROWSER_RELAY_UPSTREAM_PATH.
//
// SIGUSR2 simulates Brave dying (crash / user quit): the fake context emits
// "close" exactly as Playwright does, and $HARNESS_DIR/brave-alive changes.
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const SRC = path.resolve(__dirname, "..", "..", "src");
const SCRIPTS = path.resolve(__dirname, "..", "..", "scripts");
const dir = process.env.HARNESS_DIR;
const log = (m) => process.stderr.write(`HARNESS ${m}\n`);

function stubModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports };
}

let braveSeq = 0;
let current = null;
// Every fake launch gets the SAME port (the "relaunch on the same port" case)
// but its own browser uuid — exactly like a real port-0 relaunch that
// happens to be handed the same number.
const FAKE_PORT = 10032;
function fakeBrave(port, attached, wsEndpoint) {
  const id = `brave-${++braveSeq}`;
  wsEndpoint = wsEndpoint || `ws://127.0.0.1:${port}/devtools/browser/00000000-0000-0000-0000-${String(braveSeq).padStart(12, "0")}`;
  fs.writeFileSync(path.join(dir, "brave-alive"), id);
  fs.appendFileSync(path.join(dir, "brave-launches"), `${id} port=${port} attached=${attached}\n`);
  const browser = new EventEmitter();
  const context = new EventEmitter();
  context.browser = () => browser;
  context.close = async () => { context.emit("close"); };
  context.pages = () => [];
  const handle = { context, cdpConnectUrl: `http://127.0.0.1:${port}`, port, wsEndpoint, id };
  if (attached) Object.assign(handle, { attached: true, browser });
  current = handle;
  // $HARNESS_DIR/die-on-launch = N: Brave launch N dies right after
  // ensureBrave() returns it — before the forwarded call reaches upstream —
  // and Playwright's close event lands only later.
  let dieOn = null;
  try { dieOn = Number(fs.readFileSync(path.join(dir, "die-on-launch"), "utf8")); } catch {}
  if (dieOn === braveSeq) {
    setImmediate(() => fs.writeFileSync(path.join(dir, "brave-alive"), "dead"));
    setTimeout(() => { context.emit("close"); log(`brave-died-late ${id}`); }, 400);
  }
  return handle;
}

const launchDelay = () => { try { return Number(fs.readFileSync(path.join(dir, "launch-delay-ms"), "utf8")); } catch { return 0; } };
stubModule(path.join(SRC, "cdp-bridge.js"), {
  launchBrave: async () => {
    const ms = launchDelay();
    if (ms) { log(`launch-started`); await new Promise((r) => setTimeout(r, ms)); }
    return fakeBrave(FAKE_PORT, false);
  },
  attachBrave: async ({ port, wsEndpoint }) => fakeBrave(port, true, wsEndpoint),
  closeBrave: async (h) => { if (h) { log(`brave-closed ${h.id}`); h.context.emit("close"); } },
  closeBraveHard: async (h) => { if (h) { log(`brave-closed ${h.id} hard`); h.context.emit("close"); } },
  testLaunchRequested: () => false,
  assertTestLaunchAllowed: () => {},
});

const realMetaGuard = require(path.join(SRC, "meta-guard.js"));
stubModule(path.join(SRC, "meta-guard.js"), {
  ...realMetaGuard,
  installMetaGuard: async ({ wsEndpoint }) => {
    log(`guard-installed ${wsEndpoint}`);
    return { alive: () => true, close: () => {}, recentlyBlocked: () => false };
  },
  installWatchdog: () => {},
});

stubModule(path.join(SRC, "pool-shared.js"), {
  CONFIG: {
    poolDirs: [], standalone: true, cookieSourceProfile: null,
    cookieFreshnessWarnDays: 999, bravePath: "/fake/brave", proxyUrl: null,
  },
  PORT_BASE: 9333,
  PORT_SCAN_END: 9349,
  SNAPSHOT_FILES: [],
  // $HARNESS_DIR/clone-mode makes the claim an ephemeral session clone.
  claimSlotWithRetry: async () => (fs.existsSync(path.join(dir, "clone-mode"))
    ? { dir: path.join(dir, "clone"), lock: null, role: "default", release: () => {},
      cleanup: () => { log("pool-released"); }, ephemeral: true, baseDir: path.join(dir, "profile") }
    : { dir: path.join(dir, "profile"), lock: null, role: "default",
      release: () => { log("pool-released"); }, ephemeral: false, baseDir: null }),
  gcSessionClones: () => 0,
  findBraveMainPid: () => null,
  sessionClonesRoot: () => path.join(dir, "clones"),
  cloneBelongsTo: () => false,
  // $HARNESS_DIR/attachable = {"pid":1,"port":N,"wsEndpoint":"ws://…"} makes
  // ensureBrave take the attach path.
  findAttachableBrave: async () => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, "attachable"), "utf8")); } catch { return null; }
  },
  reapOrphansFor: () => 0,
  findCookiesFile: () => null,
  checkCookieAgeDays: () => null,
  snapshotCookiesFrom: () => 0,
  snapshotDirsFrom: () => ({ copied: 0, total: 0, bytes: 0, elapsedMs: 0 }),
});

stubModule(path.join(SCRIPTS, "patch-bdmcp-bundle.js"), { applyPatch: () => ({ patched: true }) });

function killCurrentBrave() {
  const h = current;
  fs.writeFileSync(path.join(dir, "brave-alive"), "dead");
  if (h) h.context.emit("close");
  log(`brave-killed ${h ? h.id : "none"}`);
}
process.on("SIGUSR2", killCurrentBrave);

// Test-only own-tool with the shape of tabs_new / tabs_select: it passes
// ensureBrave(), does browser work during which Brave dies, THEN reaches the
// upstream via globalThis.__relayUpstream — so the upstream child is spawned
// while no Brave is live and its first call hits the dead one.
const ownIndex = require(path.join(SRC, "own-tools", "index.js"));
const { propagateActivePageToUpstream } = require(path.join(SRC, "own-tools", "_propagate-active-page.js"));
ownIndex.tools.push({
  name: "harness_die_then_propagate",
  description: "test only",
  inputSchema: { type: "object" },
  handler: async () => {
    killCurrentBrave();
    await new Promise((r) => setTimeout(r, 20));
    const res = await propagateActivePageToUpstream("data:text/html,propagate");
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  },
});

require(path.join(SRC, "index.js")).main().catch((e) => {
  log(`main failed: ${e.stack}`);
  process.exit(1);
});
