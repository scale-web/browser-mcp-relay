#!/usr/bin/env node
/**
 * browser-mcp-relay entrypoint.
 *
 * Lifecycle:
 *   1. Claim a pool slot via shared helpers (atomic lock, cookie snapshot).
 *   2. Spawn upstream `browser-devtools-mcp` as a child with piped stdio.
 *   3. Wrap that child in an UpstreamClient (JSON-RPC over stdio).
 *   4. Run a RelayServer that:
 *      - reads MCP messages from process.stdin (Cursor → relay)
 *      - dispatches: tools/list and tools/call use the relay logic;
 *        all other messages forward to upstream verbatim.
 *      - writes responses to process.stdout (relay → Cursor).
 *   5. On signal/exit, close upstream cleanly + release pool lock.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
// MCP SDK imports — the standard `@modelcontextprotocol/sdk/server/index.js`
// form resolves under CJS because the package's "exports" map points at
// dist/cjs/server/index.js for the require condition. Verified at
// task-A.5 import check.
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const pool = require("./pool-shared.js");
const { UpstreamClient } = require("./upstream-client.js");
const { RelayServer } = require("./relay-server.js");
const { launchBrave, attachBrave, closeBrave } = require("./cdp-bridge.js");
const { tools: ownTools } = require("./own-tools/index.js");
const { applyLocalConfigToEnv } = require("./local-config.js");
const { loadVaultFromEnv } = require("./vault.js");
const { attachAutofill } = require("./autofill-injector.js");

// Layer local-config.json under env so resolveBdmcpEntry / launch flags see
// it transparently. pool-shared.js applies the same overlay independently.
const RELAY_ENV = applyLocalConfigToEnv(process.env);

/**
 * V0-1/V0-2: ensure that if any post-launch step throws, the live Brave
 * context is closed before the error propagates. `launchBrave()` resolves
 * with a live BrowserContext that holds the user-data-dir lock; a throw
 * after that point (attachAutofill error, etc.) would leak the context
 * forever. Used by ensureBrave() in main(). Module-level + exported so
 * unit tests can drive the contract directly.
 */
async function attachWithCleanupOnError(launched, fn) {
  try {
    return await fn(launched);
  } catch (e) {
    // Attached handles (connectOverCDP): only disconnect — closing the
    // default context would tear down pages in a browser we didn't launch.
    try {
      if (launched.attached && launched.browser) await launched.browser.close();
      else await launched.context.close();
    } catch { /* best-effort */ }
    throw e;
  }
}

// Path to upstream `browser-devtools-mcp`. Resolution order:
//   1. BROWSER_RELAY_UPSTREAM_PATH env var (explicit override).
//   2. require.resolve("browser-devtools-mcp/dist/index.js") — works once the
//      package is installed as an npm dependency (the published-repo path).
//
// We resolve once at module load; if both fail we throw with an actionable
// message before any side effects fire.
function resolveBdmcpEntry() {
  const override = RELAY_ENV.BROWSER_RELAY_UPSTREAM_PATH;
  if (override && override.length > 0) {
    if (fs.existsSync(override)) return override;
    throw new Error(
      `[mcp-relay] BROWSER_RELAY_UPSTREAM_PATH="${override}" but no file at that path. Fix or unset.`,
    );
  }
  try {
    return require.resolve("browser-devtools-mcp/dist/index.js");
  } catch {
    throw new Error(
      `[mcp-relay] Could not locate browser-devtools-mcp upstream entry. ` +
      `Run \`npm install\` (so require.resolve finds it) or set ` +
      `BROWSER_RELAY_UPSTREAM_PATH=/abs/path/to/browser-devtools-mcp/dist/index.js.`,
    );
  }
}

async function main() {
  // 1. Claim slot — with retry (absorbs the reconnect race where the
  //    previous relay is mid-shutdown) and session-clone fallback (a second
  //    concurrent session in the same project gets its own ephemeral
  //    profile seeded from the base instead of dying with "pool exhausted").
  const claim = await pool.claimSlotWithRetry();
  const { dir, lock, role, release: releasePool, ephemeral, baseDir } = claim;
  // Slot index for the launch banner (and for the CDP port calc below).
  // Order of preference: explicit BROWSER_RELAY_POOL_SLOT env override
  // (parsed as a positive integer), otherwise the position of the claimed
  // dir in CONFIG.poolDirs (1-based). The override exists so users running
  // in pool mode can pin a specific port even if their dir-list ordering
  // changes between runs.
  // Ephemeral clones derive their slot from the BASE dir (the clone dir is
  // never in poolDirs — indexOf would give slot 0 → port PORT_BASE-1,
  // outside the scan range). Same-slot port collision with the base's Brave
  // is then resolved by the F1-21 remap in ensureBrave.
  const slotSourceDir = ephemeral && baseDir ? baseDir : dir;
  const computedSlotIdx = Math.max(1, pool.CONFIG.poolDirs.indexOf(slotSourceDir) + 1);
  const slotOverrideRaw = RELAY_ENV.BROWSER_RELAY_POOL_SLOT;
  const slotOverride = slotOverrideRaw ? parseInt(slotOverrideRaw, 10) : NaN;
  const slotIdx = (Number.isFinite(slotOverride) && slotOverride > 0)
    ? slotOverride
    : computedSlotIdx;
  const totalSlots = pool.CONFIG.poolDirs.length;
  // Snapshot source: ephemeral clones seed from their busy BASE profile
  // (the project's own logins — fresher than any wrapper-configured cookie
  // source); regular claims use the configured cookieSourceProfile.
  const src = ephemeral ? baseDir : pool.CONFIG.cookieSourceProfile;
  const cookiesPath = src ? pool.findCookiesFile(src) : null;
  const ageDays = cookiesPath ? pool.checkCookieAgeDays(cookiesPath) : null;
  const ageStr = ageDays === null ? "?" : `${ageDays.toFixed(1)}d`;
  process.stderr.write(
    `[mcp-relay] slot=${slotIdx}/${totalSlots} role=${role} pid=${process.pid} cookieAge=${ageStr} dir=${dir} mode=${pool.CONFIG.standalone ? "standalone" : "pool"}${ephemeral ? " (ephemeral session clone)" : ""}\n`,
  );

  // 2. Profile snapshot from source (skipped in standalone mode — sourceProfile is null).
  if (src && fs.existsSync(src)) {
    if (!ephemeral && ageDays !== null && ageDays > pool.CONFIG.cookieFreshnessWarnDays) {
      process.stderr.write(
        `[mcp-relay] WARNING: cookie source ${path.basename(src)} is ${ageDays.toFixed(1)} days old (threshold ${pool.CONFIG.cookieFreshnessWarnDays}d). Refresh by launching the dedicated cookie-source MCP and logging into the sites you need.\n`,
      );
    }
    const copied = pool.snapshotCookiesFrom(src, dir);
    process.stderr.write(`[mcp-relay] snapshotted ${copied}/${pool.SNAPSHOT_FILES.length} profile files from ${path.basename(src)}\n`);

    // Directory snapshots (Local Storage, Session Storage, optional IndexedDB).
    // Many SPAs store auth tokens in localStorage rather than cookies, so this
    // is what makes Discord/Slack/Linear/Notion/Mercury sessions work.
    const includeIndexedDB = RELAY_ENV.BROWSER_RELAY_SNAPSHOT_INDEXEDDB === "true";
    const dirRes = pool.snapshotDirsFrom(src, dir, { includeIndexedDB });
    if (dirRes.total > 0) {
      process.stderr.write(
        `[mcp-relay] snapshotted ${dirRes.copied}/${dirRes.total} storage dirs ` +
        `(${(dirRes.bytes / 1024 / 1024).toFixed(1)}MB) in ${dirRes.elapsedMs}ms from ${path.basename(src)}\n`,
      );
    }
  } else if (src) {
    process.stderr.write(`[mcp-relay] cookie source ${src} missing — fresh login wall expected\n`);
  }
  // (In standalone mode, no cookie source is configured. The relay's
  // .browser-data dir is its own session — first-run will hit login walls.)

  // 2c. Load credential vault. OFF by default; opt in via BROWSER_RELAY_VAULT_FILES.
  // Empty vault → autofill is a no-op. Logged with counts only, never values.
  // Only emits a stderr line when at least one entry loaded, to keep startup
  // quiet for the common (vault-disabled) case.
  const vault = loadVaultFromEnv();
  const vsum = vault.summary();
  if (vsum.totalEntries > 0) {
    process.stderr.write(
      `[mcp-relay] vault: ${vsum.totalEntries} entries across ${vsum.uniqueHosts} hosts; ` +
      `files=[${vsum.filesLoaded.map((f) => `${path.basename(f.path)}:${f.entries}`).join(", ")}]\n`,
    );
  }

  // 3. SPLIT lazy init: upstream and Brave init separately.
  //    - tools/list (Cursor calls this immediately at MCP connect) only needs
  //      upstream spawned. Upstream's tools/list returns its static catalog
  //      without any browser involvement.
  //    - tools/call needs BOTH upstream AND Brave (own-tools read
  //      globalThis.__relayBridge; forwarded tools have upstream try to
  //      attach via CDP, which requires Brave running).
  //    This split eliminates idle-Brave: a session that connects but never
  //    calls a tool stays at ~50MB total (1 relay node + 1 upstream node,
  //    no Brave).
  let port = pool.PORT_BASE + slotIdx - 1; // may be remapped below if taken / attached

  // -- Upstream lifecycle (spawned on first tools/list or tools/call) --
  let upstreamChild = null;
  let upstreamClient = null;
  let upstreamSpawnPromise = null;
  // The CDP port baked into the CURRENT upstream child's env at spawn time.
  // tools/list spawns upstream before Brave exists, so when ensureBrave
  // later attaches/remaps to a different port, the upstream child must be
  // restarted — otherwise forwarded tools connectOverCDP to whatever Brave
  // owns the ORIGINAL port (another project's browser). See
  // restartUpstreamIfPortChanged().
  let upstreamPort = null;

  async function spawnUpstream() {
    const bdmcpEntry = resolveBdmcpEntry();
    // F1-20 (2026-05-10): patch upstream's bundled HttpResourceType enum
    // before spawn. Upstream's enum is missing ping/prefetch/signedexchange/
    // cspviolationreport/preflight/fedcm — Playwright returns those (Amazon
    // affiliate links fire <a ping="..."> beacons → resourceType="ping" →
    // upstream's zod schema rejects → o11y_get-http-requests fails).
    //
    // We can't use Module._compile / --require because upstream is ESM and
    // those hooks are CJS-only. Patching the bundle on disk is reliable
    // across both module systems. Idempotent + safe — bails on bundler
    // shape changes rather than corrupting the file.
    try {
      const { applyPatch } = require("../scripts/patch-bdmcp-bundle.js");
      const result = applyPatch();
      if (!result.patched) {
        process.stderr.write(`[mcp-relay] F1-20 patch skipped: ${result.reason} (o11y_get-http-requests may reject ping/prefetch/etc resourceTypes)\n`);
      }
    } catch (e) {
      process.stderr.write(`[mcp-relay] F1-20 patch threw (continuing): ${e.message}\n`);
    }
    process.stderr.write(`[mcp-relay] spawning upstream child (no Brave yet, entry=${bdmcpEntry})...\n`);
    // CDP env points at the port we'll launch Brave on. Upstream is lazy
    // about its CDP attach (only runs in newBrowserContext on first tool
    // execution), so it's safe to set this before Brave is up.
    const upstreamEnv = { ...RELAY_ENV };
    delete upstreamEnv.BROWSER_PERSISTENT_USER_DATA_DIR;
    delete upstreamEnv.BROWSER_PERSISTENT_ENABLE;
    // BDMCP reads `BROWSER_CDP_ENDPOINT_URL` from process.env and assigns it
    // internally to its exported constant `BROWSER_CDP_CONNECT_URL`. The
    // env var must use the *_ENDPOINT_URL name; the *_CONNECT_URL constant
    // is never read from env, so setting it would silently send BDMCP into
    // its standalone-launch path (spawning a fresh temp-profile Brave next
    // to the relay's launched Brave). Don't set ENDPOINT_EXPLICIT — BDMCP
    // derives it internally from `!!_BROWSER_CDP_ENDPOINT`.
    upstreamEnv.BROWSER_CDP_ENDPOINT_URL = `http://127.0.0.1:${port}`;

    const child = spawn(process.execPath, [bdmcpEntry, "--cursor-mcp-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: upstreamEnv,
    });
    upstreamChild = child;
    upstreamPort = port;
    child.on("exit", async (code, signal) => {
      // Deliberate restart (restartUpstreamIfPortChanged replaced/cleared
      // upstreamChild before killing this one): not fatal, don't shut down.
      if (upstreamChild !== child) {
        process.stderr.write(`[mcp-relay] old upstream child exited after port-change restart code=${code} signal=${signal}\n`);
        return;
      }
      process.stderr.write(`[mcp-relay] upstream child exited code=${code} signal=${signal}\n`);
      try { await shutdownAsync(); } catch { /* shutdown is best-effort */ }
      // W0-8: previously `process.kill(process.pid, signal)` re-raised the
      // signal that just killed the child — on POSIX this re-enters the
      // SIGINT/SIGTERM handler (potential recursion), and on Windows
      // `process.kill` with a signal name is a no-op so the relay would
      // never exit at all. Use a numeric exit code derived from the signal
      // (POSIX convention: 128 + signal number) when available, else the
      // child's exit code, else 1.
      const SIGNAL_NUMS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 };
      const sigNum = signal && SIGNAL_NUMS[signal];
      process.exit(sigNum ? 128 + sigNum : (code ?? 1));
    });

    upstreamClient = new UpstreamClient(child.stdout, child.stdin);
    return upstreamClient;
  }

  /**
   * Kill + forget the upstream child when the CDP port it was spawned with
   * no longer matches the port Brave actually runs on (F1-21 remap landed
   * after upstream spawn, or ensureBrave attached to an existing Brave).
   * The next getUpstream() respawns it lazily with the correct
   * BROWSER_CDP_ENDPOINT_URL. Synchronous: state is cleared BEFORE the kill
   * so the child's exit handler recognizes a deliberate restart.
   */
  function restartUpstreamIfPortChanged() {
    if (!upstreamChild || upstreamPort === port) return;
    process.stderr.write(
      `[mcp-relay] CDP port changed ${upstreamPort} → ${port} after Brave attach/remap; restarting upstream child so forwarded tools target OUR Brave\n`,
    );
    const oldChild = upstreamChild;
    const oldClient = upstreamClient;
    upstreamChild = null;
    upstreamClient = null;
    upstreamSpawnPromise = null;
    upstreamPort = null;
    try { if (oldClient) oldClient.close(); } catch { /* best-effort */ }
    killUpstreamTree(oldChild);
  }

  async function getUpstream() {
    if (upstreamClient) return upstreamClient;
    if (!upstreamSpawnPromise) {
      // W1-5: wrap spawnUpstream in Promise.resolve().then so a synchronous
      // throw from spawnUpstream() (e.g. resolveBdmcpEntry throwing because
      // the upstream module isn't installed) is captured by the .catch
      // below. Without this, the assignment line itself throws, the
      // .catch never registers, and upstreamSpawnPromise stays as the
      // never-set undefined — every retry hits the same race window.
      upstreamSpawnPromise = Promise.resolve().then(spawnUpstream).catch((e) => {
        upstreamSpawnPromise = null; // allow retry
        throw e;
      });
    }
    return await upstreamSpawnPromise;
  }

  // -- Brave lifecycle (launched ONLY on first tools/call, NOT on tools/list) --
  let bridge = null;
  let braveLaunchPromise = null;

  async function ensureBrave() {
    if (bridge) return bridge;
    if (!braveLaunchPromise) {
      braveLaunchPromise = (async () => {
        // ATTACH-FIRST (2026-07-06): if a live Brave already holds OUR
        // profile dir with a reachable CDP endpoint (previous relay died
        // uncleanly, or an attached-mode relay disconnected on shutdown),
        // connect to it instead of reaping it. The old reap-and-relaunch
        // path destroyed the user's open tabs on every unclean reconnect.
        let launched = null;
        try {
          const attachable = await pool.findAttachableBrave(dir);
          if (attachable) {
            process.stderr.write(
              `[mcp-relay] live Brave pid=${attachable.pid} already owns ${dir} (CDP port ${attachable.port}) — attaching, tabs preserved\n`,
            );
            launched = await attachBrave({ port: attachable.port });
            port = attachable.port;
          }
        } catch (e) {
          process.stderr.write(`[mcp-relay] attach to existing Brave failed (${e.message}); falling back to reap + launch\n`);
          launched = null;
        }

        if (!launched) {
        // Resolve bravePath now, not at module load — auto-detect, env override,
        // or wrapper hint. Throws a clear error if Brave isn't installed.
        let bravePath = pool.CONFIG.bravePath;
        if (!bravePath) {
          try {
            bravePath = require("./detect-browser.js").detectBravePath({ env: RELAY_ENV });
          } catch (e) {
            // Fold the original detection failure context into the launch error.
            const original = pool.CONFIG.braveDetectError;
            if (original && original !== e) {
              e.message += `\n\nOriginal detection error at config-load time:\n${original.message}`;
            }
            throw e;
          }
        }
        // F1-21 (2026-06-29): port-collision guard. The slot→port map
        // (PORT_BASE+slot-1) is shared by BOTH legacy pool relays AND the
        // per-project isolated-profile wrapper (which sets
        // BROWSER_RELAY_POOL_SLOT). Two relays assigned the same slot number —
        // e.g. a legacy pool slot-1 Brave and an isolated profile mapped to
        // slot 1 — race for the same CDP port. The loser's Brave launches
        // pipe-only (no HTTP CDP endpoint), so anything that discovers Brave by
        // scanning the PORT_BASE..PORT_SCAN_END HTTP ports (ghl-jwt.mjs JWT
        // capture, tab enumeration) attaches to the WRONG Brave. Our own
        // user-data-dir differs from the squatter's, so launchPersistentContext
        // itself succeeds — the collision is silent. Probe our assigned port; if
        // another Brave already owns it, walk to the first FREE port in the
        // scan range. ghl-jwt scans the whole range and picks by JWT-location
        // match, own-tools read globalThis.__relayBridge.port, and
        // restartUpstreamIfPortChanged() re-points the upstream child, so any
        // free in-range port works for every consumer. Ephemeral session
        // clones inherit their base slot's port and rely on this remap to
        // land on a free one.
        const cdpBound = async (p) => {
          try {
            const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(400) });
            return r.ok;
          } catch { return false; }
        };
        if (await cdpBound(port)) {
          let freePort = null;
          for (let p = pool.PORT_BASE; p <= pool.PORT_SCAN_END; p++) {
            if (p === port) continue;
            if (!(await cdpBound(p))) { freePort = p; break; }
          }
          if (freePort) {
            process.stderr.write(`[mcp-relay] CDP port ${port} already owned by another relay; remapping this session to free port ${freePort}\n`);
            port = freePort;
          } else {
            process.stderr.write(`[mcp-relay] WARN CDP port ${port} taken and no free port in ${pool.PORT_BASE}..${pool.PORT_SCAN_END}; launch may be pipe-only\n`);
          }
        }
        process.stderr.write(`[mcp-relay] launching Brave (port=${port}, exe=${bravePath})...\n`);
        // F1-16 (2026-05-10): pre-launch reap of any orphan Brave squatting
        // on our user-data-dir. Since the attach-first probe above came up
        // empty, anything still holding the dir is pipe-only / CDP-dead —
        // not attachable, and its SingletonLock would fail our launch with
        // "user data dir already in use". Reap it.
        // The reap is idempotent and cheap (one tasklist + targeted
        // taskkill /F /T per matching PID, capped at 10s in pool-shared).
        // Best-effort — failure here doesn't block the launch attempt; we
        // let Playwright surface the original "user data dir in use" error
        // so the user sees a real diagnostic, not a silent reap failure.
        try {
          const reaped = pool.reapOrphansFor(dir);
          if (reaped > 0) {
            process.stderr.write(`[mcp-relay] pre-launch reap removed ${reaped} squatter(s) on ${dir}\n`);
          }
        } catch (reapErr) {
          process.stderr.write(`[mcp-relay] pre-launch reap failed (continuing): ${reapErr.message}\n`);
        }
        const extensionPath = RELAY_ENV.BROWSER_LOAD_EXTENSIONS || null;
        // V0-1/V0-2: launchBrave resolves with a live Brave subprocess +
        // open BrowserContext. If anything between here and the bridge
        // assignment throws (attachAutofill exception, an exception in the
        // logging code itself), the live context would leak with its
        // user-data-dir lock held forever. attachWithCleanupOnError closes
        // the context on any throw before rethrowing.
        // V1-1: proxyUrl resolution prefers env override, then bridges through
        // pool.CONFIG.proxyUrl (which itself reads from wrapper's
        // browser-mcp-config.json when the wrapper bridge is active). This
        // closes the gap where wrapper-spawned BDMCP routed through the
        // configured proxy but the relay's launched Brave didn't.
        launched = await launchBrave({
          userDataDir: dir,
          port,
          headless: RELAY_ENV.BROWSER_HEADLESS_ENABLE === "true",
          extensionPath,
          executablePath: bravePath,
          proxyUrl: RELAY_ENV.BROWSER_RELAY_PROXY_URL || pool.CONFIG.proxyUrl || null,
        });
        }
        return await attachWithCleanupOnError(launched, async (l) => {
          process.stderr.write(`[mcp-relay] Brave ready (cdpConnectUrl=${l.cdpConnectUrl}${l.attached ? ", attached to existing" : ""})\n`);
          // Attach autofill listeners to the launched context. Pages BDMCP
          // creates via CDP attach share this context, so the framenavigated
          // event fires for them too — autofill works for both relay-driven
          // and BDMCP-driven navigations. No-op when the vault is empty.
          attachAutofill(l.context, vault, (msg) => process.stderr.write(msg + "\n"));
          // Make the bridge available to own-tool handlers via globalThis.
          // Shape: { context, cdpConnectUrl, port } — Phase C tool handlers
          // read globalThis.__relayBridge to drive CDP operations.
          globalThis.__relayBridge = { ...l, port };
          bridge = l;
          // V1-5 (2026-06-01): invalidate the cached `bridge` when the
          // underlying Brave context/process dies. Without this listener, a
          // crashed/force-quit Brave leaves `bridge` pointing at a dead
          // Playwright BrowserContext. Every subsequent tool call then fails
          // with "browserContext.newPage: Target page, context or browser
          // has been closed" — a wedge that only recovers via full relay
          // restart. With this listener: next ensureBrave() call sees
          // bridge=null + braveLaunchPromise=null → relaunches Brave fresh
          // and the relay self-heals.
          const invalidateBridge = (reason) => {
            if (bridge !== l) return; // already moved on (e.g. external close)
            process.stderr.write(
              `[mcp-relay] Brave context invalidated (${reason}); next ensureBrave() will relaunch\n`,
            );
            bridge = null;
            braveLaunchPromise = null;
            if (globalThis.__relayBridge && globalThis.__relayBridge.context === l.context) {
              globalThis.__relayBridge = null;
            }
          };
          l.context.on("close", () => invalidateBridge("context closed"));
          try {
            // `browser()` may be null on some persistent-context launches; guard.
            const br = l.context.browser && l.context.browser();
            if (br && typeof br.on === "function") {
              br.on("disconnected", () => invalidateBridge("browser disconnected"));
            }
          } catch (e) {
            process.stderr.write(`[mcp-relay] could not attach browser.disconnected listener: ${e.message}\n`);
          }
          // The port Brave actually landed on may differ from the port the
          // upstream child was spawned with (F1-21 remap, attach). Restart
          // upstream if so — forwarded tools must target OUR Brave.
          restartUpstreamIfPortChanged();
          return bridge;
        });
      })().catch((e) => {
        braveLaunchPromise = null; // allow retry on next call
        throw e;
      });
    }
    return await braveLaunchPromise;
  }

  // Expose getUpstream to own-tool handlers via globalThis. The tabs_new /
  // tabs_select handlers use this to call upstream's `navigation_go-to` so
  // upstream's tracked `_page` follows our intended active tab. Upstream's
  // session captures one specific Playwright Page reference at CDP-attach
  // time and never re-evaluates it from CDP `Target.*` events; calls like
  // `bringToFront` or creating new Playwright pages do NOT update that
  // reference. The only externally observable lever is to navigate
  // upstream's existing page via its own forwarded tools.
  globalThis.__relayUpstream = getUpstream;

  // 4. Run MCP server (NO Brave, NO upstream yet — both spawn lazily).
  const relay = new RelayServer({ getUpstream, ensureBrave });
  // Register Phase C own-tools. Each entry in ownTools is
  // { name, description, inputSchema, handler }.
  for (const tool of ownTools) {
    relay.registerOwnTool(tool);
  }
  if (ownTools.length > 0) {
    process.stderr.write(`[mcp-relay] registered ${ownTools.length} own-tools: ${ownTools.map(t => t.name).join(", ")}\n`);
  }

  // 4b. Optional in-process Inspector. When BROWSER_RELAY_INSPECTOR_PORT is
  // set on the relay process, we boot the Inspector in this same Node
  // process and wire its WebSocket to the relay's trafficEmitter — so the
  // /slot/N Inspector page sees real MCP traffic as it happens. Standalone
  // `npm run inspector` runs separately and never gets here.
  let inspectorHandle = null;
  const inspectorPortRaw = RELAY_ENV.BROWSER_RELAY_INSPECTOR_PORT;
  if (inspectorPortRaw) {
    const parsed = parseInt(inspectorPortRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
      process.stderr.write(`[mcp-relay] WARNING: BROWSER_RELAY_INSPECTOR_PORT="${inspectorPortRaw}" is not a valid port; skipping in-process inspector\n`);
    } else {
      try {
        const { startInspector } = require("./inspector-server.js");
        const inspectorBind = RELAY_ENV.BROWSER_RELAY_INSPECTOR_BIND || "127.0.0.1";
        if (inspectorBind !== "127.0.0.1" && inspectorBind !== "localhost") {
          process.stderr.write(
            `[mcp-relay] WARNING: inspector binding to ${inspectorBind} (not 127.0.0.1). ` +
            `No auth — anyone reaching this address can read pool state.\n`,
          );
        }
        inspectorHandle = await startInspector({
          port: parsed,
          bind: inspectorBind,
          uiRoot: path.resolve(__dirname, "..", "scripts", "inspector-ui"),
          trafficEmitter: relay.trafficEmitter,
        });
        process.stderr.write(
          `[mcp-relay] inspector running at http://${inspectorBind}:${inspectorHandle.port}\n`,
        );
      } catch (e) {
        process.stderr.write(`[mcp-relay] inspector failed to start: ${e.stack || e.message}\n`);
      }
    }
  }

  const server = new Server(
    { name: "browser-mcp-relay", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => relay.handleToolsList());
  server.setRequestHandler(CallToolRequestSchema, async (req) => relay.handleToolsCall(req.params));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 5. Lifecycle. Two paths:
  //    - shutdownSync: for process.on("exit"), which doesn't allow async work.
  //      Best-effort sync cleanup. closeBrave is fire-and-forget (Playwright's
  //      context.close is async; we lose the await here. Brave subprocesses
  //      may briefly orphan on abrupt exit — acceptable last-ditch path.)
  //    - shutdownAsync: for SIGINT/SIGTERM/upstream-child-exit, where we have
  //      a chance to await Brave teardown before process.exit.
  //
  // V0-4: shutdownAsync is now memoized into `shutdownPromise`. The previous
  // implementation used a `shutdownStarted` flag — but a flag only prevents
  // re-running the body, it doesn't make concurrent callers wait for the
  // first caller's await chain. Result: signal handler and upstream-exit
  // handler could BOTH fire simultaneously; the second caller would early-
  // return from the flag check and immediately `process.exit`, cutting the
  // first caller's `await closeBrave()` short. Brave subprocesses orphaned.
  //
  // Single in-flight promise → all callers await the same chain → exit
  // happens only after the chain settles.
  let shutdownPromise = null;
  let shutdownDone = false;

  // G0-3 (2026-05-10): cross-platform process-tree kill for the upstream
  // child. Bare `child.kill()` on Windows only TerminateProcess's the node
  // PID — its spawned BDMCP-launched children (Brave subtree if BDMCP fell
  // back to standalone-launch) become reparented orphans. taskkill /F /T
  // walks the tree.
  function killUpstreamTree(child = upstreamChild) {
    if (!child || !child.pid) return;
    if (process.platform === "win32") {
      try {
        require("node:child_process").execSync(
          `taskkill /F /T /PID ${child.pid}`,
          { stdio: "ignore", windowsHide: true, timeout: 5000 },
        );
      } catch { /* best-effort */ }
    } else {
      try { child.kill("SIGTERM"); } catch {}
    }
  }

  // G0-7 / G1-2: race awaitable shutdown steps against a per-step timeout
  // and run them in parallel. closeBrave can hang on a wedged renderer;
  // inspectorHandle.close can hang on idle keep-alive sockets. Without
  // timeouts a single slow component blocks the whole shutdown.
  function withTimeout(promise, ms, label) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ status: "timeout", label }), ms);
      promise
        .then(() => { clearTimeout(t); resolve({ status: "ok", label }); })
        .catch((e) => { clearTimeout(t); resolve({ status: "error", label, error: e }); });
    });
  }

  function shutdownSync() {
    // Only path here is process.on("exit") — no async, no awaits.
    if (shutdownDone) return;
    shutdownDone = true;
    try { releasePool(); } catch {}
    if (upstreamClient) { try { upstreamClient.close(); } catch {} }
    killUpstreamTree();
    if (bridge) { closeBrave(bridge).catch(() => {}); }
    if (inspectorHandle) { inspectorHandle.close().catch(() => {}); }
    // Ephemeral clone dir removal is best-effort here (Brave may still be
    // mid-close and recreate files); gcSessionClones reclaims leftovers.
    if (claim.cleanup) { try { claim.cleanup(); } catch {} }
  }

  function shutdownAsync() {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      // W1-6: release the pool lock FIRST so a second Ctrl-C (which
      // process.exit's mid-await) leaves the slot reclaimable by the next
      // relay.
      try { releasePool(); } catch {}
      if (upstreamClient) { try { upstreamClient.close(); } catch {} }
      // G0-3: kill the upstream tree, not just the parent PID.
      killUpstreamTree();
      // G1-2: run Brave-close and inspector-close in PARALLEL with per-step
      // timeouts. Sequential await previously meant a hung Brave (30s) +
      // hung inspector (5s) = 35s shutdown wall time.
      const tasks = [];
      if (bridge) tasks.push(withTimeout(closeBrave(bridge), 8000, "closeBrave"));
      if (inspectorHandle) tasks.push(withTimeout(inspectorHandle.close(), 3000, "inspector"));
      const results = await Promise.all(tasks);
      for (const r of results) {
        if (r.status === "timeout") {
          process.stderr.write(`[mcp-relay] shutdown ${r.label} timed out — proceeding\n`);
        }
      }
      // Now that Brave is closed (or timed out), remove the ephemeral clone
      // dir. Doing this before closeBrave would race Brave recreating files
      // inside the dir, leaving a half-deleted husk for GC to find.
      if (claim.cleanup) { try { claim.cleanup(); } catch { /* GC will get it */ } }
      shutdownDone = true;
    })();
    return shutdownPromise;
  }

  // G0-4 (2026-05-10): catch otherwise-uncaught throws so the relay can
  // still run shutdown (release lock, close Brave, terminate upstream tree)
  // before exiting. Without these, an unhandled rejection from any async
  // path (autofill listener, inspector WS handler, capture-xhr body fetch)
  // crashes the relay and orphans Brave + lock.
  process.on("uncaughtException", async (e) => {
    process.stderr.write(`[mcp-relay] uncaughtException: ${e?.stack || e}\n`);
    try { await shutdownAsync(); } catch {}
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    // Don't shut down on unhandled rejection — it's often non-fatal (a
    // background Promise like a body fetch that nobody awaited). Log loudly
    // so it shows up in inspector stderr and can be debugged.
    process.stderr.write(`[mcp-relay] unhandledRejection: ${(reason && reason.stack) || reason}\n`);
  });

  // Stash on the closure so the upstream-exit handler in spawnUpstream() can
  // await the same promise. (It captures `shutdownAsync` lexically already,
  // so this works without explicit hoisting — keep this comment as a marker.)
  process.on("exit", shutdownSync);
  process.on("SIGINT", async () => {
    try { await shutdownAsync(); } catch {}
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    try { await shutdownAsync(); } catch {}
    process.exit(143);
  });
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[mcp-relay] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { main, attachWithCleanupOnError };
