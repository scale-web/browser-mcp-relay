// Runs the REAL src/index.js main() — real RelayServer, real MCP stdio server,
// real spawnUpstream/getUpstream/ensureBrave/restart logic, real child
// processes — with only its external collaborators replaced:
//   - cdp-bridge.js   → a fake Brave (no browser is launched)
//   - pool-shared.js  → a claim in $HARNESS_DIR (no real profile, lock or reap)
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
function fakeBrave(port, attached) {
  const id = `brave-${++braveSeq}`;
  fs.writeFileSync(path.join(dir, "brave-alive"), id);
  fs.appendFileSync(path.join(dir, "brave-launches"), `${id} port=${port} attached=${attached}\n`);
  const browser = new EventEmitter();
  const context = new EventEmitter();
  context.browser = () => browser;
  context.close = async () => { context.emit("close"); };
  context.pages = () => [];
  const handle = { context, cdpConnectUrl: `http://127.0.0.1:${port}`, id };
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

stubModule(path.join(SRC, "cdp-bridge.js"), {
  launchBrave: async ({ port }) => fakeBrave(port, false),
  attachBrave: async ({ port }) => fakeBrave(port, true),
  closeBrave: async (h) => { if (h) h.context.emit("close"); },
  closeBraveHard: async (h) => { if (h) h.context.emit("close"); },
  waitForCdpReady: async () => {},
});

stubModule(path.join(SRC, "pool-shared.js"), {
  CONFIG: {
    poolDirs: [], standalone: true, cookieSourceProfile: null,
    cookieFreshnessWarnDays: 999, bravePath: "/fake/brave", proxyUrl: null,
  },
  PORT_BASE: 9333,
  PORT_SCAN_END: 9349,
  SNAPSHOT_FILES: [],
  claimSlotWithRetry: async () => ({
    dir: path.join(dir, "profile"), lock: null, role: "default",
    release: () => {}, ephemeral: false, baseDir: null,
  }),
  // $HARNESS_DIR/attachable = {"pid":1,"port":N} makes ensureBrave take the
  // attach path (e.g. port differs from the one upstream was spawned with).
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

process.on("SIGUSR2", () => {
  const h = current;
  fs.writeFileSync(path.join(dir, "brave-alive"), "dead");
  if (h) h.context.emit("close");
  log(`brave-killed ${h ? h.id : "none"}`);
});

require(path.join(SRC, "index.js")).main().catch((e) => {
  log(`main failed: ${e.stack}`);
  process.exit(1);
});
