#!/usr/bin/env node
/**
 * browser-mcp-relay entrypoint.
 *
 * Lifecycle:
 *   1. Claim a pool slot via shared helpers (kernel flock + v2 record, cookie snapshot).
 *   2. Spawn upstream `browser-devtools-mcp` as a child with piped stdio.
 *   3. Wrap that child in an UpstreamClient (JSON-RPC over stdio).
 *   4. Run a RelayServer that:
 *      - reads MCP messages from process.stdin (Cursor → relay)
 *      - dispatches: tools/list and tools/call use the relay logic;
 *        all other messages forward to upstream verbatim.
 *      - writes responses to process.stdout (relay → Cursor).
 *   5. On signal/exit, close upstream cleanly, close Brave, THEN release the
 *      pool lock (record, then flock) — a peer can't claim a dying Brave.
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
const {
  launchBrave, attachBrave, closeBrave, closeBraveHard, testLaunchRequested, assertTestLaunchAllowed,
} = require("./cdp-bridge.js");
const { UNREACHABLE_WS_ENDPOINT } = require("./cdp-identity.js");
const profileLock = require("./profile-lock.js");
const { installMetaGuard, installWatchdog } = require("./meta-guard.js");
const { StatusSidecar, buildRelayStatus, modeAnnouncement, readSidecar, SIDECAR_NAME } = require("./status-sidecar.js");
const { tools: ownTools } = require("./own-tools/index.js");
const { reset: resetUpstreamSync } = require("./own-tools/_upstream-sync.js");
const { applyLocalConfigToEnv } = require("./local-config.js");
const { loadVaultFromEnv } = require("./vault.js");
const { attachAutofill } = require("./autofill-injector.js");
const { listExternalCdpClients } = require("./cdp-clients.js");
const { freshKeepaliveAgeMs, ReapLog, REAP_LOG_NAME, KEEPALIVE_NAME } = require("./reap-hold.js");
// Spec v8 §5.6 (phase 1c): the plain-flags launch profile.
const plainflagsMode = require("./plainflags-mode.js");
const { createSigninLoader, SIGNIN_FILE } = require("./plainflags-signin.js");
const { KNOWN_ACCOUNTS } = require("./known-accounts.js");
const { createSigninPolicy, installSigninGuard, installSigninWatchdog } = require("./plainflags-signin-guard.js");
const { createAskVerifier } = require("./plainflags-ask-verify.js");
const { createPlainflagsPolicy } = require("./plainflags-policy.js");
const { createLock } = require("./plainflags-lock.js");
const { createDefaultLockPolicy } = require("./default-lock.js");
const { createClickCounter } = require("./challenge-clicks.js");
const { plainflagsTools } = require("./own-tools/index.js");
const challengeDetect = require("./own-tools/challenge-detect.js");
const challengeClick = require("./own-tools/challenge-click.js");
const cfCookiesClear = require("./own-tools/cf-cookies-clear.js");

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

// MCP `instructions` sent at connect (spec v4 §1c). No BASE/CLONE claim here:
// the text is not reliably re-sent after a reconnect, so the live answer is
// relay_status, and every mode change is announced in a tool result.
const RELAY_INSTRUCTIONS =
  "Browser profile status: call relay_status; every mode change is announced in the tool result.";
const RELAY_INSTRUCTIONS_PLAINFLAGS =
  "PLAIN-FLAGS relay: a separate, unseeded browser profile for Cloudflare walls (cf-challenge skill) — a fixed tool list, " +
  "no saved logins, known accounts' logins refused unless on the sign-in list. Call relay_status for details.";

async function main() {
  // Test-only launch hook (spec v4 amendment 5): refuse to RUN — not just to
  // launch — unless HOME is a temp dir. A leftover flag fails loudly.
  if (testLaunchRequested(RELAY_ENV)) assertTestLaunchAllowed();

  // Spec v8 §5.6: the profile mode — from the PROCESS env only (the MCP entry's
  // env), never local-config.json (a key there is ignored and logged once).
  {
    const problem = plainflagsMode.modeProblem(process.env);
    if (problem) throw new Error(problem);
  }
  const profileMode = plainflagsMode.profileMode(process.env);
  const plain = profileMode === plainflagsMode.PLAINFLAGS;
  if (plainflagsMode.localConfigHasModeKey()) process.stderr.write(`${plainflagsMode.LOCAL_CONFIG_IGNORED}\n`);
  if (pool.CONFIG.profileMode !== undefined && pool.CONFIG.profileMode !== profileMode) {
    throw new Error(`[mcp-relay] profile mode mismatch (pool-shared ${pool.CONFIG.profileMode}, relay ${profileMode}) — refusing`);
  }
  // Isolated-harness fixture (known accounts, sign-in file); null otherwise.
  const pfFixture = plainflagsMode.testFixture(process.env);
  const launchInputs = plainflagsMode.resolvedLaunchInputs({ relayEnv: RELAY_ENV, config: pool.CONFIG, processEnv: process.env });
  const cacheRoot = pool.userCacheRoot();
  // §5.6 (4): the plain-flags mode drives only its own unseeded dirs; the
  // default mode never drives one of them.
  const folderCheck = (d) => plainflagsMode.folderRefusal({
    dir: d,
    mode: profileMode,
    cacheRoot,
    registry: plain ? plainflagsMode.registryDirs(path.join(cacheRoot, plainflagsMode.REGISTRY_NAME)) : { dirs: [] },
    standaloneDirs: [path.join(path.resolve(__dirname, ".."), ".browser-data"), path.join(cacheRoot, "browser-data")],
    cookieSourceProfile: pool.CONFIG.configuredCookieSourceProfile,
  });
  for (const d of pool.CONFIG.poolDirs) {
    const why = folderCheck(d);
    if (why) throw new Error(why);
  }
  if (plain) {
    // §5.6 (13): no proxy (any source), no insecure TLS, no extension.
    const why = plainflagsMode.launchRefusal(launchInputs);
    if (why) throw new Error(why);
  }

  // 1. Claim slot — with retry (absorbs the reconnect race where the
  //    previous relay is mid-shutdown) and session-clone fallback (a second
  //    concurrent session in the same project gets its own ephemeral
  //    profile seeded from the base instead of dying with "pool exhausted").
  const claim = await pool.claimSlotWithRetry();
  const { dir, lock, role, release: releasePool, ephemeral, baseDir } = claim;
  {
    const why = folderCheck(dir);
    if (why) {
      try { releasePool(); } catch {}
      if (claim.cleanup) { try { claim.cleanup(); } catch {} }
      throw new Error(why);
    }
  }
  if (testLaunchRequested(RELAY_ENV)) {
    try { assertTestLaunchAllowed(dir); } catch (e) {
      try { releasePool(); } catch {}
      if (claim.cleanup) { try { claim.cleanup(); } catch {} }
      throw e;
    }
  }
  const mode = ephemeral ? (baseDir ? "clone" : "ephemeral") : "base";
  const project = path.basename(baseDir || dir);
  // Start sweep, this project only (spec v4 §1a): dead clones of this
  // project's base. The clone path already swept inside claimSlotWithRetry.
  if (!ephemeral) {
    try { pool.gcSessionClones({ project }); } catch { /* best-effort */ }
  }
  // Slot index — a LABEL only (banner, registry) since spec v4 §1b: Brave
  // gets an OS-assigned port, so the slot no longer selects one.
  // Order of preference: explicit BROWSER_RELAY_POOL_SLOT env override
  // (parsed as a positive integer), otherwise the position of the claimed
  // dir in CONFIG.poolDirs (1-based). Ephemeral clones label themselves with
  // the BASE dir's slot.
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
    `[mcp-relay] slot=${slotIdx}/${totalSlots} role=${role} pid=${process.pid} cookieAge=${ageStr} dir=${dir} mode=${pool.CONFIG.standalone ? "standalone" : "pool"}${ephemeral ? (baseDir ? " (ephemeral session clone)" : " (ephemeral temp-project profile)") : ""}\n`,
  );

  // 2. Profile snapshot from source (skipped in standalone mode — sourceProfile is null).
  const includeIndexedDB = RELAY_ENV.BROWSER_RELAY_SNAPSHOT_INDEXEDDB === "true";
  // A clone's snapshot time: ensureBrave re-seeds the clone from its base
  // before launching a new Brave on it once this is older than the limit
  // (pool-shared refreshStaleClone; the relay can outlive many Braves).
  let cloneSnapshotAt = Date.now();
  if (src && fs.existsSync(src)) {
    if (!ephemeral && ageDays !== null && ageDays > pool.CONFIG.cookieFreshnessWarnDays) {
      process.stderr.write(
        `[mcp-relay] WARNING: cookie source ${path.basename(src)} is ${ageDays.toFixed(1)} days old (threshold ${pool.CONFIG.cookieFreshnessWarnDays}d). Refresh by launching the dedicated cookie-source MCP and logging into the sites you need.\n`,
      );
    }
    // Plain-flags: a clone seeds only from the plain-flags base, never its
    // Login Data* (§5.6 (4), review r8 #3); a regular claim has no source.
    const copied = pool.snapshotCookiesFrom(src, dir, { excludeLoginData: plain });
    process.stderr.write(`[mcp-relay] snapshotted ${copied}/${pool.SNAPSHOT_FILES.length} profile files from ${path.basename(src)}\n`);

    // Directory snapshots (Local Storage, Session Storage, optional IndexedDB).
    // Many SPAs store auth tokens in localStorage rather than cookies, so this
    // is what makes Discord/Slack/Linear/Notion/Mercury sessions work.
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
  // Plain-flags (§5.6 (6)(e)): vault autofill is OFF — no vault is loaded.
  const vault = plain ? null : loadVaultFromEnv();
  const vsum = vault ? vault.summary() : { totalEntries: 0 };
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
  // The CURRENT Brave's verified CDP port and exact ws endpoint
  // (ws://127.0.0.1:<port>/devtools/browser/<uuid>); null while no Brave.
  let port = null;
  let wsEndpoint = null;

  // -- Upstream lifecycle (spawned on first tools/list or tools/call) --
  let upstreamChild = null;
  let upstreamClient = null;
  let upstreamSpawnPromise = null;
  // The CDP endpoint baked into the CURRENT upstream child's env at spawn
  // time. tools/list spawns upstream before Brave exists (with the
  // unreachable placeholder), so the first Brave always replaces that child;
  // see restartUpstreamIfStale().
  let upstreamEndpoint = null;
  // Brave generation: bumped every time ensureBrave() installs a NEW Brave
  // handle (launch or attach). upstreamBraveGeneration is the value when the
  // current upstream child was spawned. BDMCP caches its browser context +
  // page for the life of the child and never rebuilds them, so a child that
  // may have attached to an older Brave is wedged on "Target page, context
  // or browser has been closed" even when the new Brave reuses the same
  // port (field report 2026-10-06). With an OS-assigned port and a per-browser
  // ws endpoint, the endpoint check alone catches a relaunch; the generation
  // is kept as the second, independent signal.
  let braveGeneration = 0;
  let upstreamBraveGeneration = null;
  // Set first thing by shutdownAsync/shutdownSync. getUpstream() refuses to
  // spawn once it is set, so nothing — e.g. relay-server's tools/list retry —
  // can start a new upstream child during shutdown — e.g. a call that lands
  // while shutdown awaits closeBrave(), relaunches Brave and so restarts the
  // upstream. A plain flag kept with the upstream state, so this guard does
  // not depend on where shutdownPromise happens to be declared.
  let relayShuttingDown = false;

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
    // Patch the bundle we actually spawn (an override path included, through
    // any symlink — Node loads the real file), not whatever require.resolve
    // finds (A76 re-reviews r1 #1, r2 #4).
    const bdmcpDist = path.dirname(fs.realpathSync(path.resolve(bdmcpEntry)));
    try {
      const { applyPatch } = require("../scripts/patch-bdmcp-bundle.js");
      const result = applyPatch({ distDir: bdmcpDist });
      if (!result.patched) {
        process.stderr.write(`[mcp-relay] F1-20 patch skipped: ${result.reason} (o11y_get-http-requests may reject ping/prefetch/etc resourceTypes)\n`);
      }
    } catch (e) {
      process.stderr.write(`[mcp-relay] F1-20 patch threw (continuing): ${e.message}\n`);
    }
    // A76 (2026-10-30): stop upstream capturing request bodies (typed logins).
    // Fail closed: while the patch is not in effect, the relay refuses
    // execute / scenario-run (src/request-body-filter.js); the direct
    // o11y_get-http-requests call stays covered by the result filter.
    let a76Applied = false;
    try {
      const { applyPatch } = require("../scripts/patch-bdmcp-request-body.js");
      const result = applyPatch({ distDir: bdmcpDist });
      a76Applied = !!result.patched;
      if (!result.patched) {
        process.stderr.write(`[mcp-relay] WARNING A76 request-body patch NOT applied: ${result.reason} — execute and scenario-run are refused until it is\n`);
      }
    } catch (e) {
      process.stderr.write(`[mcp-relay] WARNING A76 request-body patch threw: ${e.message} — execute and scenario-run are refused until it applies\n`);
    }
    require("./request-body-filter.js").setSourcePatchInEffect(a76Applied);
    // A1 (2026-11-10): upstream's own session page (its first tool call, and
    // its re-creation after that page is closed) opens in the background, as
    // the relay's tabs do (src/own-tools/_quiet-focus.js). Without it,
    // Playwright's newPage() activates Brave and macOS switches the user out
    // of their Space. Not applied → that page activates Brave, nothing else.
    try {
      const { applyPatch } = require("../scripts/patch-bdmcp-quiet-page.js");
      const result = applyPatch({ distDir: bdmcpDist });
      if (!result.patched) {
        process.stderr.write(`[mcp-relay] A1 quiet-page patch skipped: ${result.reason} (upstream's session page may activate Brave)\n`);
      }
    } catch (e) {
      process.stderr.write(`[mcp-relay] A1 quiet-page patch threw (continuing): ${e.message}\n`);
    }
    process.stderr.write(`[mcp-relay] spawning upstream child (no Brave yet, entry=${bdmcpEntry})...\n`);
    // CDP env points at the exact ws endpoint of OUR Brave (pinned to its
    // uuid, so it can reach no other browser). Before any Brave exists it is
    // a well-formed endpoint that cannot connect — never an empty value
    // (BDMCP would probe 9222/9229 or launch its own browser) and never a
    // slot port (a peer's Brave). Upstream attaches lazily, on its first
    // tool call, so ensureBrave() replaces a placeholder child first.
    const upstreamEnv = {};
    for (const [k, v] of Object.entries(RELAY_ENV)) {
      if (k.startsWith("CLAUDE_CODE_MESSAGING_")) continue; // spec v4 §1e
      upstreamEnv[k] = v;
    }
    delete upstreamEnv.BROWSER_PERSISTENT_USER_DATA_DIR;
    // A76: upstream prefixes tool names with this; the relay's name-based
    // guards (meta-guard, sync, the request-body filter) need them unprefixed.
    delete upstreamEnv.TOOL_NAME_PREFIX;
    delete upstreamEnv.BROWSER_PERSISTENT_ENABLE;
    // BDMCP reads `BROWSER_CDP_ENDPOINT_URL` from process.env and assigns it
    // internally to its exported constant `BROWSER_CDP_CONNECT_URL`. The
    // env var must use the *_ENDPOINT_URL name; the *_CONNECT_URL constant
    // is never read from env, so setting it would silently send BDMCP into
    // its standalone-launch path (spawning a fresh temp-profile Brave next
    // to the relay's launched Brave). Don't set ENDPOINT_EXPLICIT — BDMCP
    // derives it internally from `!!_BROWSER_CDP_ENDPOINT`.
    const endpointForChild = wsEndpoint || UNREACHABLE_WS_ENDPOINT;
    upstreamEnv.BROWSER_CDP_ENDPOINT_URL = endpointForChild;
    // On a failed attach BDMCP otherwise runs `open -a "Google Chrome"
    // chrome://inspect/...` in the user's own Chrome.
    upstreamEnv.BROWSER_CDP_OPEN_INSPECT = "false";

    const child = spawn(process.execPath, [bdmcpEntry, "--cursor-mcp-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: upstreamEnv,
    });
    upstreamChild = child;
    upstreamEndpoint = endpointForChild;
    // Recorded as-is even when no Brave is live right now (after an idle
    // reap, or a tools/list that lands mid-relaunch): the next Brave then
    // replaces this child although it never attached — one wasted spawn,
    // deliberately. Treating such a child as generation 0 (adoptable) is
    // NOT safe: if Brave dies between ensureBrave() and this spawn, the
    // child's first call fails and BDMCP caches that failure forever, so
    // adopting it would bring the wedge back. The forwarded path cannot hit
    // that (ensureBrave() and the spawn are microtask-adjacent); the own-tool
    // path can — tabs_new / tabs_select do browser work first and then reach
    // upstream via own-tools/_propagate-active-page.js → __relayUpstream.
    // test/upstream-restart.test.js pins it.
    upstreamBraveGeneration = braveGeneration;
    child.on("exit", async (code, signal) => {
      // Deliberate restart (restartUpstreamIfStale replaced/cleared
      // upstreamChild before killing this one): not fatal, don't shut down.
      if (upstreamChild !== child) {
        process.stderr.write(`[mcp-relay] old upstream child exited after deliberate restart code=${code} signal=${signal}\n`);
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
    // A new child pins a fresh page: no desync to report, no page the relay owns.
    resetUpstreamSync();
    return upstreamClient;
  }

  /**
   * Kill + forget the upstream child when it is stale for the Brave that
   * ensureBrave() just installed: the ws endpoint it was spawned with is not
   * this Brave's (the placeholder, a previous Brave's uuid, an attach), or it
   * was spawned for an earlier Brave generation (BDMCP caches its browser
   * context for the child's life). The next getUpstream() respawns it lazily
   * with the correct BROWSER_CDP_ENDPOINT_URL. Synchronous: state is cleared
   * BEFORE the kill so the child's exit handler recognizes a deliberate restart.
   */
  function restartUpstreamIfStale() {
    if (!upstreamChild) return;
    const endpointChanged = upstreamEndpoint !== wsEndpoint;
    const braveReplaced = upstreamBraveGeneration !== braveGeneration;
    if (!endpointChanged && !braveReplaced) return;
    process.stderr.write(
      endpointChanged
        ? `[mcp-relay] CDP endpoint changed (${upstreamEndpoint === UNREACHABLE_WS_ENDPOINT ? "placeholder" : upstreamEndpoint} → ${wsEndpoint}); restarting upstream child so forwarded tools target OUR Brave\n`
        : `[mcp-relay] Brave relaunched/reattached (generation ${upstreamBraveGeneration} → ${braveGeneration}); restarting upstream child so it drops its dead browser context\n`,
    );
    const oldChild = upstreamChild;
    const oldClient = upstreamClient;
    upstreamChild = null;
    upstreamClient = null;
    upstreamSpawnPromise = null;
    upstreamEndpoint = null;
    try { if (oldClient) oldClient.close(); } catch { /* best-effort */ }
    killUpstreamTree(oldChild);
  }

  async function getUpstream() {
    if (upstreamClient) return upstreamClient;
    if (relayShuttingDown) throw new Error("relay shutting down");
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
  let guardReinstallPromise = null;
  // Meta-guard and mode notices for the next tool result (RelayServer prefixes
  // them as separate leading text items).
  const pendingNotices = [];
  let announcedMode = null;
  const takeNotices = () => {
    const out = [];
    // Plain-flags: the mode on every tool result (spec v8 §5.6).
    if (plain) out.push(plainflagsMode.MODE_LINE);
    if (announcedMode !== mode) {
      out.push(modeAnnouncement(mode, project));
      announcedMode = mode;
    }
    out.push(...pendingNotices.splice(0));
    return out;
  };
  const noteBlocked = (host) => {
    const text = `[browser-mcp-relay] BLOCKED a Meta page (${host}) in this browser. Relay browsers never open Instagram/Facebook/Meta pages — use the Instagram/Meta Graph API, or the account owner's phone.`;
    if (!pendingNotices.includes(text)) pendingNotices.push(text);
  };
  const pushNotice = (text) => { if (!pendingNotices.includes(text)) pendingNotices.push(text); };
  const noteSigninBlocked = (host, account) => pushNotice(
    `[browser-mcp-relay] BLOCKED a login page (${host}) in the plain-flags browser${account ? `: "${account}" is not on the sign-in list` : ""}. A known account's login is refused here until Trevor names it (plainflags-signin.json, his GO); use its API or the default relay.`,
  );

  // -- Plain-flags sign-in list, guard policy and shared click count (§5.6) --
  let signinLoader = null;
  let signinPolicy = null;
  let clickCounter = null;
  if (plain) {
    const signinFile = (pfFixture && pfFixture.signinFile) || SIGNIN_FILE;
    if (!(pfFixture && pfFixture.signinFile)) {
      plainflagsMode.ensureSigninFile(signinFile, (m) => process.stderr.write(`[mcp-relay] ${m}\n`));
    }
    signinLoader = createSigninLoader({ path: signinFile });
    // An entry counts only when its claude-ask record grants it (read-only).
    const asks = createAskVerifier({
      ...((pfFixture && pfFixture.asksDir) ? { root: pfFixture.asksDir } : {}),
      requireTypedAnswer: plainflagsMode.requireTypedAnswer(process.env),
    });
    signinPolicy = createSigninPolicy({ accounts: (pfFixture && pfFixture.accounts) || KNOWN_ACCOUNTS, loader: signinLoader, verifyAsk: asks.verify });
    clickCounter = createClickCounter({ root: pool.plainflagsProfilesRoot() });
    challengeClick.configure({ counter: clickCounter });
    cfCookiesClear.configure({ signin: signinLoader, accounts: signinPolicy.accounts, listedNames: () => signinPolicy.names() });
    process.stderr.write(`[mcp-relay] PLAIN-FLAGS mode: sign-in list ${signinFile} (${signinPolicy.names().size} account(s) listed and verified); known accounts: ${signinPolicy.accounts.map((a) => a.name).join(", ")}\n`);
  }
  // The default relay classifies with the same VERIFIED list (no guard there).
  const classifyList = signinPolicy || createSigninPolicy({ loader: createSigninLoader(), verifyAsk: createAskVerifier({ requireTypedAnswer: plainflagsMode.requireTypedAnswer(process.env) }).verify });
  challengeDetect.configure({ mode: profileMode, signin: signinLoader, clicks: clickCounter, listedNames: () => classifyList.names() });
  // §5.6 (14): each top-level navigation in this mode, host + time only.
  const navLog = plain ? new ReapLog({ file: path.join(cacheRoot, "plainflags-navigations.log"), slug: project }) : null;
  function installNavigationLog(context) {
    const seen = new WeakSet();
    const watch = (page) => {
      if (seen.has(page)) return;
      seen.add(page);
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        let host;
        try {
          const u = new URL(frame.url());
          if (u.protocol !== "http:" && u.protocol !== "https:") return;
          host = u.hostname.toLowerCase();
        } catch { return; }
        navLog.write("navigation", { host });
      });
    };
    for (const pg of context.pages()) watch(pg);
    context.on("page", watch);
  }

  // Status sidecar (spec v4 §1c) — cdpPort/bravePid for external consumers.
  const sidecar = new StatusSidecar({ dir, mode, onTick: () => checkRecordConflict() });

  /** Spec v4 amendment 3: a live legacy record in a dir we hold is a
   *  double-claim by a pre-change relay. Log it and surface it; never
   *  overwrite it (overwriting makes both relays believe they own the dir). */
  function checkRecordConflict() {
    if (relayShuttingDown || !claim.meta) return;
    let rec;
    try { rec = profileLock.readRecord(dir); } catch { return; }
    if (rec.kind !== "ok" || rec.meta.pid === process.pid) return;
    if (!profileLock.recordHeld(rec).held) return;
    const conflict = `pid ${rec.meta.pid} (${Number.isFinite(rec.meta.v) ? `v${rec.meta.v}` : "pre-change relay"}) also claims ${dir}`;
    if (sidecar.data.conflict !== conflict) {
      process.stderr.write(`[mcp-relay] CONFLICT: ${conflict} — not overwriting its record\n`);
      sidecar.update({ conflict }, { force: true });
    }
  }

  async function armMetaGuard(l) {
    const guard = await installMetaGuard({
      wsEndpoint: l.wsEndpoint,
      log: (m) => process.stderr.write(`[mcp-relay] ${m}\n`),
      onBlocked: noteBlocked,
    });
    l.metaGuard = guard;
    return guard;
  }

  async function armSigninGuard(l) {
    const guard = await installSigninGuard({
      wsEndpoint: l.wsEndpoint,
      policy: signinPolicy,
      log: (m) => process.stderr.write(`[mcp-relay] ${m}\n`),
      onBlocked: noteSigninBlocked,
    });
    l.signinGuard = guard;
    return guard;
  }
  let signinReinstallPromise = null;

  async function ensureBrave() {
    // BACKLOG "A Brave relaunched during a SIGTERM shutdown is never closed"
    // (spec v4 amendment 4): no launch or attach once shutdown has begun.
    if (relayShuttingDown) throw new Error("relay shutting down — not launching Brave");
    if (bridge) {
      // The guard's own CDP session died (Brave is still up): re-arm it before
      // anything else runs in this browser. Fail closed if it cannot be.
      if (bridge.metaGuard && !bridge.metaGuard.alive()) {
        const b = bridge;
        if (!guardReinstallPromise) {
          process.stderr.write(`[mcp-relay] Meta guard session lost — re-arming\n`);
          guardReinstallPromise = armMetaGuard(b).finally(() => { guardReinstallPromise = null; });
        }
        await guardReinstallPromise;
      }
      if (plain && bridge.signinGuard && !bridge.signinGuard.alive()) {
        const b = bridge;
        if (!signinReinstallPromise) {
          process.stderr.write(`[mcp-relay] plain-flags sign-in guard session lost — re-arming\n`);
          signinReinstallPromise = armSigninGuard(b).finally(() => { signinReinstallPromise = null; });
        }
        await signinReinstallPromise;
      }
      return bridge;
    }
    if (!braveLaunchPromise) {
      braveLaunchPromise = (async () => {
        // ATTACH-FIRST (2026-07-06): if a live Brave already holds OUR
        // profile dir with a PROVEN CDP endpoint (previous relay died
        // uncleanly, or an attached-mode relay disconnected on shutdown),
        // connect to it instead of reaping it. findAttachableBrave proves
        // identity (DevToolsActivePort uuid, or for a legacy fixed-port Brave
        // an address-specific lsof) — F9: never a bare port probe.
        let launched = null;
        let attachedPid = null;
        try {
          const attachable = await pool.findAttachableBrave(dir);
          if (attachable) {
            process.stderr.write(
              `[mcp-relay] live Brave pid=${attachable.pid} already owns ${dir} (CDP port ${attachable.port}${attachable.legacy ? ", legacy fixed port" : ""}) — attaching, tabs preserved\n`,
            );
            launched = await attachBrave({ wsEndpoint: attachable.wsEndpoint, port: attachable.port });
            attachedPid = attachable.pid;
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
        process.stderr.write(`[mcp-relay] launching Brave (port=auto, exe=${bravePath})...\n`);
        // F1-16 (2026-05-10): pre-launch reap of any orphan Brave squatting
        // on our user-data-dir. Since the attach-first probe above came up
        // empty, anything still holding the dir is pipe-only or unprovable —
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
        // A clone seeded long ago lacks sign-ins made in the base since then
        // (2026-11-10: 3.8 days, a GHL sign-in wall). No Brave of ours runs on
        // it here; refreshStaleClone re-checks that and fails closed.
        // Best-effort: on any failure this Brave launches on the clone as is.
        if (mode === "clone") {
          try {
            const r = pool.refreshStaleClone({
              cloneDir: dir,
              baseDir,
              snapshotAt: cloneSnapshotAt,
              maxAgeMs: pool.cloneRefreshMaxAgeMs(RELAY_ENV),
              excludeLoginData: plain,
              includeIndexedDB,
            });
            cloneSnapshotAt = r.snapshotAt;
          } catch (e) {
            process.stderr.write(`[mcp-relay] session clone refresh failed (launching on the clone as is): ${e.message}\n`);
          }
        }
        const extensionPath = launchInputs.extensionPath;
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
          headless: RELAY_ENV.BROWSER_HEADLESS_ENABLE === "true",
          extensionPath,
          executablePath: bravePath,
          proxyUrl: launchInputs.proxyUrl,
          profileMode,
        });
        }
        // Shutdown began while we were launching/attaching: this Brave would
        // never be closed (shutdown captured `bridge` before it existed).
        // Close it here — a launched one is closed, an attached one only
        // disconnected — and refuse.
        if (relayShuttingDown) {
          process.stderr.write(`[mcp-relay] shutdown began during Brave ${launched.attached ? "attach" : "launch"} — closing it\n`);
          if (launched.attached) await closeBrave(launched);
          else if (claim.cleanup) await closeBraveHard(launched);
          else await closeBrave(launched);
          throw new Error("relay shutting down — Brave closed");
        }
        return await attachWithCleanupOnError(launched, async (l) => {
          process.stderr.write(`[mcp-relay] Brave ready (port=${l.port}, ws=${l.wsEndpoint}${l.attached ? ", attached to existing" : ""})\n`);
          // Attach autofill listeners to the launched context. Pages BDMCP
          // creates via CDP attach share this context, so the framenavigated
          // event fires for them too — autofill works for both relay-driven
          // and BDMCP-driven navigations. No-op when the vault is empty.
          if (vault) attachAutofill(l.context, vault, (msg) => process.stderr.write(msg + "\n"));
          // Meta guard, layers 2 + 3 — for EVERY Brave generation, attached
          // ones included. Fail closed: no guard, no browser.
          const guard = await armMetaGuard(l);
          installWatchdog(l.context, {
            recentlyBlocked: (url) => !!(l.metaGuard && l.metaGuard.recentlyBlocked(url)),
            onBlocked: noteBlocked,
            log: (m) => process.stderr.write(`[mcp-relay] ${m}\n`),
          });
          void guard;
          if (plain) {
            // Sign-in guard layer 2 + the watchdog (§5.6 (6)(b), (h)); then (c)
            // before the first tool call: every not-listed known account's
            // cookies and storage are cleared. Fail closed: a throw closes
            // this Brave (attachWithCleanupOnError).
            const sg = await armSigninGuard(l);
            installSigninWatchdog(l.context, {
              policy: signinPolicy,
              recentlyBlocked: (url) => !!(l.signinGuard && l.signinGuard.recentlyBlocked(url)),
              onBlocked: (host) => noteSigninBlocked(host, null),
              log: (m) => process.stderr.write(`[mcp-relay] ${m}\n`),
            });
            const cleared = await sg.clearAccounts(signinPolicy.notListed(), "launch");
            const failed = cleared.filter((c) => c.errors.length > 0);
            if (failed.length > 0) throw new Error(`[mcp-relay] plain-flags launch clear failed for ${failed.map((c) => c.account).join(", ")}: ${failed.flatMap((c) => c.errors).join("; ")}`);
            installNavigationLog(l.context);
          }
          // Make the bridge available to own-tool handlers via globalThis.
          // Shape: { context, cdpConnectUrl, port, wsEndpoint, bravePid } — tool
          // handlers (lighthouse_audit: port; tabs_*: bravePid, to raise a tab
          // only when THIS Brave is the front app) read globalThis.__relayBridge.
          const bravePid = attachedPid || pool.findBraveMainPid(dir);
          globalThis.__relayBridge = { ...l, port: l.port, bravePid };
          bridge = l;
          port = l.port;
          wsEndpoint = l.wsEndpoint;
          braveGeneration++;
          sidecar.update({
            braveAlive: true,
            cdpPort: l.port,
            bravePid,
          }, { force: true });
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
            forgetBrave(l);
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
          // The endpoint the upstream child was spawned with is the
          // placeholder (first Brave), a previous Brave's, or an attach
          // target's: restart it so forwarded tools reach OUR live Brave.
          restartUpstreamIfStale();
          return bridge;
        });
      })().catch((e) => {
        braveLaunchPromise = null; // allow retry on next call
        throw e;
      });
    }
    return await braveLaunchPromise;
  }

  /** Drop every reference to Brave handle `l` (it is closing or dead). */
  function forgetBrave(l) {
    if (bridge === l) {
      bridge = null;
      braveLaunchPromise = null;
      port = null;
      wsEndpoint = null;
      endReapHold("brave-gone");
    }
    if (globalThis.__relayBridge && globalThis.__relayBridge.context === l.context) {
      globalThis.__relayBridge = null;
    }
    if (l.metaGuard) { try { l.metaGuard.close(); } catch {} }
    if (l.signinGuard) { try { l.signinGuard.close(); } catch {} }
    sidecar.update({ braveAlive: false, cdpPort: null, bravePid: null }, { force: true });
  }

  // -- Idle reaper (2026-07-16) --------------------------------------------
  // Brave (200MB–2.5GB) and the upstream child (~40-90MB) previously lived
  // for the FULL life of the host window — a session browsed once and its
  // Brave sat resident for days. Real-world cost observed: ~8GB across 8
  // idle Braves. The reaper closes both after BROWSER_RELAY_IDLE_MINUTES
  // (default 45, fractional ok, 0/unparseable-negative disables) with no
  // tool call. Both relaunch lazily on the next call: profiles persist on
  // disk so logins survive; only stale tabs are lost. closeBraveHard is
  // used (not closeBrave) so ATTACHED Braves are actually terminated —
  // reclaiming RAM is the whole point here, unlike shutdown where the
  // disconnect-only semantics preserve tabs for the next session.
  //
  // Browser-activity signal (2026-10-12, register A51 D1): sessions also drive
  // their Brave DIRECTLY over its CDP port from shell scripts (a websocket to
  // 127.0.0.1:<cdpPort>), which no MCP call reveals — the reaper killed Braves
  // mid-script 3x on 2026-10-12. So when a tick WOULD reap, it first lists the
  // ESTABLISHED client sockets to 127.0.0.1:<this Brave's cdpPort>
  // (src/cdp-clients.js, one lsof, 3 s timeout). Only CLIENT ends count — a
  // socket whose remote end is the CDP port — which is what keeps Brave's own
  // (server-end) sockets out. Any client socket owned by a process other than
  // the relay or the upstream child counts as activity: activity is bumped and
  // nothing is reaped. (Brave's main pid is excluded too, as a second guard
  // that changes nothing while Brave holds only server ends.) Only a connection
  // OPEN at the tick is seen — a script that connects and exits between ticks
  // leaves no trace. If lsof fails or times out (missing on Windows, a broken
  // PATH, a stalled system), that tick falls back to the pre-2026-10-12
  // MCP-only rule and reaps, logged once per relay: never reaping would
  // silently remove the RAM bound for the life of the relay wherever lsof is
  // unusable, while a reap that ends one script is the old, known cost.
  //
  // Keep-alive file (2026-10-12, A51 follow-up): checked FIRST, before the
  // lsof, because it is one lstat. `<claimed profile dir>/.mcp-relay-keepalive`
  // (base or session clone — this claim's `dir`) that is a REGULAR file
  // (lstat: symlinks and anything else are ignored) with an mtime less than
  // one idle window old counts as activity: helpers `touch` it each time they
  // use the Brave, so protection ends one idle window after the last touch and
  // can never hold a Brave forever (an mtime > 5 s in the future is ignored).
  // This covers what the lsof cannot: a script that connects and exits
  // between ticks.
  //
  // Every hold and reap is recorded for measurement in
  // <userCacheRoot>/reap-events.log (src/reap-hold.js: one JSON line per
  // event — held once per hold and on a holder-pid change, keepalive,
  // lsof-failed, reaped; 0600; rotated past ~1 MB). The sidecar carries
  // reapHeldBy {pids, since} while a CDP hold lasts. A hold ENDS — "released",
  // reapHeldBy cleared — when a check finds no clients, an MCP request
  // arrives, a keep-alive takes over, lsof fails, a reap runs or the Brave
  // goes away; the next hold, even by the same pids, logs a new "held". A
  // fresh keep-alive sets the idle clock to its mtime (never later than now),
  // not to the check time, so one touch holds for one window after the touch.
  // No log or sidecar failure ever changes a reap decision.
  let lastActivityAt = Date.now();
  // In-flight request counter: the reaper must never fire while a call is
  // running, even one that outlives the idle threshold (a lighthouse run
  // with a small custom BROWSER_RELAY_IDLE_MINUTES would otherwise get its
  // Brave killed mid-flight).
  let inFlightRequests = 0;
  function bumpActivity() { lastActivityAt = Date.now(); }

  let reapLogFile = null;
  try { reapLogFile = path.join(pool.userCacheRoot(), REAP_LOG_NAME); } catch { /* no log */ }
  const reapLog = new ReapLog({ file: reapLogFile, slug: project });
  // Own tools log measurement events to the same file (tabs_new, A55 MED-3).
  globalThis.__relayEventLog = (event, fields) => reapLog.write(event, fields);
  const idleSeconds = () => Math.round((Date.now() - lastActivityAt) / 1000);
  // Hold end, for any reason, is logged ("released", with heldS) and clears
  // the sidecar's reapHeldBy. Hold start/end are rare, so both are written to
  // the sidecar at once rather than on its next periodic write.
  function endReapHold(reason) {
    if (reapLog.release(reason)) sidecar.update({ reapHeldBy: null }, { force: true });
  }

  let cdpClientCheckFailureLogged = false;
  /** True when the reap must be skipped: a fresh keep-alive file, or a foreign
   *  process holding an ESTABLISHED CDP connection to the current Brave (both
   *  bump activity). False when neither, or the CDP check failed. */
  async function reapHeld(idleMs) {
    const idleS = idleSeconds();
    const kaAge = freshKeepaliveAgeMs(dir, idleMs);
    if (kaAge !== null) {
      // The activity is the TOUCH, not this check: one idle window after the
      // last touch, never more (resetting to now would hold up to ~2 windows).
      const now = Date.now();
      lastActivityAt = Math.max(lastActivityAt, Math.min(now - kaAge, now));
      endReapHold("keepalive");
      reapLog.write("keepalive", { keepaliveAgeS: Math.round(kaAge / 1000), idleS });
      process.stderr.write(`[mcp-relay] idle reaper: ${KEEPALIVE_NAME} touched ${Math.round(kaAge / 1000)}s ago — Brave kept, idle clock reset\n`);
      return true;
    }
    if (!bridge || !port) { endReapHold("brave-gone"); return false; }
    const excludePids = [process.pid, upstreamChild && upstreamChild.pid, sidecar.data.bravePid];
    const r = await listExternalCdpClients({ port, excludePids, timeoutMs: 3000 });
    if (!r.ok) {
      if (!cdpClientCheckFailureLogged) {
        cdpClientCheckFailureLogged = true;
        process.stderr.write(`[mcp-relay] idle reaper: external-CDP-client check unavailable (${r.reason}); falling back to MCP-only idleness for such ticks (logged once)\n`);
      }
      reapLog.write("lsof-failed", { reason: r.reason, idleS });
      endReapHold("lsof-failed");
      return false;
    }
    if (r.clients.length === 0) { endReapHold("no-clients"); return false; }
    bumpActivity();
    const pids = [...new Set(r.clients.map((c) => c.pid))];
    const h = await reapLog.held(pids, idleS);
    if (h.changed) sidecar.update({ reapHeldBy: { pids: h.pids, since: h.since } }, { force: true });
    process.stderr.write(`[mcp-relay] idle reaper: external CDP client(s) on 127.0.0.1:${port} (pid ${pids.join(",")}) — Brave kept, idle clock reset\n`);
    return true;
  }

  function idleReapUpstream() {
    if (!upstreamChild) return;
    // Same deliberate-kill pattern as restartUpstreamIfStale: clear
    // state BEFORE the kill so the child's exit handler sees a replacement,
    // not a fatal upstream death.
    const oldChild = upstreamChild;
    const oldClient = upstreamClient;
    upstreamChild = null;
    upstreamClient = null;
    upstreamSpawnPromise = null;
    upstreamEndpoint = null;
    try { if (oldClient) oldClient.close(); } catch { /* best-effort */ }
    killUpstreamTree(oldChild);
  }

  async function idleReapBrave() {
    if (!bridge) return;
    const b = bridge;
    forgetBrave(b);
    await closeBraveHard(b);
  }

  const idleMinutesRaw = RELAY_ENV.BROWSER_RELAY_IDLE_MINUTES;
  const idleMinutes = (idleMinutesRaw === undefined || idleMinutesRaw === "")
    ? 45
    : parseFloat(idleMinutesRaw);
  if (Number.isFinite(idleMinutes) && idleMinutes > 0) {
    const idleMs = idleMinutes * 60_000;
    // One check at a time: a slow lsof must not stack ticks (or lsofs).
    let reapCheckRunning = false;
    const tick = setInterval(async () => {
      if (reapCheckRunning) return;
      if (inFlightRequests > 0) return;
      if (Date.now() - lastActivityAt < idleMs) return;
      if (!bridge && !upstreamChild) return;
      reapCheckRunning = true;
      try {
        if (await reapHeld(idleMs)) return;
      } catch (e) {
        process.stderr.write(`[mcp-relay] idle reaper: hold check threw: ${e.message}\n`);
      } finally {
        reapCheckRunning = false;
      }
      // A call may have started or finished while lsof ran.
      if (inFlightRequests > 0) return;
      if (Date.now() - lastActivityAt < idleMs) return;
      if (!bridge && !upstreamChild) return;
      endReapHold("reaped"); // defensive: every path that lets a reap through has already released
      reapLog.write("reaped", { idleS: idleSeconds() });
      process.stderr.write(
        `[mcp-relay] idle ${idleMinutes}min — reaping Brave + upstream to reclaim RAM (both relaunch on next tool call; logins persist)\n`,
      );
      // Upstream FIRST: if it happened to exit on its own while we awaited
      // the Brave close, its exit handler would still see itself as the
      // current child and treat that as a fatal upstream death (full relay
      // shutdown). Clearing upstream state before the await closes that
      // window.
      try { idleReapUpstream(); } catch (e) {
        process.stderr.write(`[mcp-relay] idle upstream reap failed: ${e.message}\n`);
      }
      try {
        // Cap like shutdown does (G0-7): a wedged renderer can hang
        // context.close() forever; state is already nulled, so on timeout
        // the pre-launch reap or attach-invalidate path cleans up later.
        const r = await withTimeout(idleReapBrave(), 8000, "idleReapBrave");
        if (r.status === "timeout") {
          process.stderr.write(`[mcp-relay] idle Brave reap timed out — orphan will be reaped pre-launch\n`);
        }
      } catch (e) {
        process.stderr.write(`[mcp-relay] idle Brave reap failed: ${e.message}\n`);
      }
    }, Math.min(60_000, idleMs));
    // unref: the reaper must never be what keeps the relay process alive.
    tick.unref();
    process.stderr.write(`[mcp-relay] idle reaper armed (${idleMinutes}min)\n`);
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

  // relay_status's payload (own-tools/relay-status.js). Reads records and
  // sidecars only — never launches Brave or claims anything.
  globalThis.__relayStatus = async () => (checkRecordConflict(), await refreshLock(), withPlainflagsStatus(buildRelayStatus({
    self: {
      sessionId: sidecar.data.sessionId,
      braveAlive: !!bridge,
      cdpPort: port,
      bravePid: sidecar.data.bravePid,
      conflict: sidecar.data.conflict || null,
    },
    dir,
    baseDir,
    mode,
    clonesRoot: pool.sessionClonesRoot(),
    cloneBelongsTo: pool.cloneBelongsTo,
    metaGuard: bridge ? (bridge.metaGuard && bridge.metaGuard.alive() ? "active" : "down (re-armed on the next browser call)") : "not installed yet (no Brave)",
  })));
  /** relay_status re-probes the lock when a Brave is up (it never launches one; the probe is bounded — L4). */
  async function refreshLock() {
    // `policy` is declared below; relay_status only runs after it exists.
    if (!bridge || !policy) return;
    try { await policy.lock.probe(); } catch { /* status shows the last state */ }
  }
  /** Plain-flags fields on relay_status; the default relay adds only its lock (A77). */
  function withPlainflagsStatus(st) {
    if (!plain) return { ...st, lock: policy ? policy.lock.status() : null };
    const sl = signinPolicy.status();
    return {
      ...st,
      profileMode: "plainflags",
      // `accounts` = listed AND verified against its claude-ask record; `refused` = entries that were not.
      signinList: { file: signinLoader.path, accounts: sl.listed, refused: sl.refused, problem: sl.problem, recentChanges: sl.recentChanges },
      signinGuard: bridge ? (bridge.signinGuard && bridge.signinGuard.alive() ? "active" : "down (re-armed on the next browser call)") : "not installed yet (no Brave)",
      toolList: plainflagsMode.TOOL_ALLOWLIST,
      lock: policy ? policy.lock.status() : null,
      note: "Accident guards, not a security boundary: any local process can drive this Brave over its debugging port.",
    };
  }
  sidecar.start();

  // 4. Run MCP server (NO Brave, NO upstream yet — both spawn lazily).
  const policy = plain
    ? createPlainflagsPolicy({
      signin: signinPolicy,
      getGuard: () => (bridge && bridge.signinGuard) || null,
      getUpstream,
      notice: pushNotice,
      log: (m) => process.stderr.write(`[mcp-relay] ${m}\n`),
      // Review round 4 L7: screenshots go to a relay-private dir in this profile.
      screenshotDir: path.join(dir, ".relay-screenshots"),
      // Review round 3 A: the lock over every tab of THIS relay's Brave.
      lock: createLock({
        getContext: () => (bridge ? bridge.context : null),
        accounts: signinPolicy.accounts,
        notice: pushNotice,
        log: (m) => process.stderr.write(`[mcp-relay] ${m}\n`),
      }),
    })
    // A77: the default relay's lock (a filled secret field; values this relay filled are excepted).
    : createDefaultLockPolicy({
      getContext: () => (bridge ? bridge.context : null),
      notice: pushNotice,
      log: (m) => process.stderr.write(`[mcp-relay] ${m}\n`),
      // Fix round 2 (ruling as-ops/ask-gnpqzm): one line per lock / unlock (0600, rotated past ~1 MB).
      episode: (() => {
        const episodeLog = new ReapLog({ file: path.join(cacheRoot, "default-lock-episodes.log"), slug: project });
        return ({ event, ...fields }) => episodeLog.write(event, fields);
      })(),
    });
  const relay = new RelayServer({ getUpstream, ensureBrave, takeNotices, policy });
  // Register Phase C own-tools. Each entry in ownTools is
  // { name, description, inputSchema, handler }. challenge_click and
  // cf_cookies_clear exist only in the plain-flags relay (§5.6 (8), (9)).
  const registered = plain ? [...ownTools, ...plainflagsTools] : ownTools;
  for (const tool of registered) {
    relay.registerOwnTool(tool);
  }
  if (registered.length > 0) {
    process.stderr.write(`[mcp-relay] registered ${registered.length} own-tools: ${registered.map(t => t.name).join(", ")}\n`);
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
    { capabilities: { tools: {} }, instructions: plain ? RELAY_INSTRUCTIONS_PLAINFLAGS : RELAY_INSTRUCTIONS },
  );
  // bumpActivity on entry AND exit of every request so a long-running call
  // (lighthouse can take minutes) never has the reaper fire mid-flight or
  // immediately after it returns.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    bumpActivity();
    endReapHold("mcp-call");
    inFlightRequests++;
    try { return await relay.handleToolsList(); } finally { inFlightRequests--; bumpActivity(); }
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    bumpActivity();
    endReapHold("mcp-call");
    sidecar.update({ lastToolCallAt: new Date().toISOString() });
    inFlightRequests++;
    try { return await relay.handleToolsCall(req.params); } finally { inFlightRequests--; bumpActivity(); }
  });

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

  /** Release the claim. Base: owner-checked record unlink, THEN the flock fd.
   *  Clone / temp profile: rm -rf the dir while still holding the fd, then
   *  close it (pool-shared ownedDirCleanup). */
  function releaseClaim() {
    try { sidecar.remove(); } catch {}
    try { releasePool(); } catch {}
    if (claim.cleanup) { try { claim.cleanup(); } catch { /* GC will get it */ } }
  }

  function shutdownSync() {
    // Only path here is process.on("exit") — no async, no awaits. Brave's
    // close is fired and forgotten; the kernel releases the flock on exit
    // anyway, so the record is all there is to tidy (spec v4 amendment 4:
    // on this path the release can precede Brave's exit).
    if (shutdownDone) return;
    shutdownDone = true;
    relayShuttingDown = true;
    if (upstreamClient) { try { upstreamClient.close(); } catch {} }
    killUpstreamTree();
    if (bridge) { (claim.cleanup ? closeBraveHard(bridge) : closeBrave(bridge)).catch(() => {}); }
    if (inspectorHandle) { inspectorHandle.close().catch(() => {}); }
    releaseClaim();
  }

  function shutdownAsync() {
    if (shutdownPromise) return shutdownPromise;
    relayShuttingDown = true;
    shutdownPromise = (async () => {
      // Spec v4 §1a (r2 N6): close Brave FIRST, release LAST. The old order
      // (W1-6: release first "so a second Ctrl-C leaves the slot reclaimable")
      // let a peer claim the base while our Brave was still closing and then
      // attach to it or SIGKILL it. The kernel now releases the flock if we
      // die mid-shutdown, so W1-6's reason is gone.
      if (upstreamClient) { try { upstreamClient.close(); } catch {} }
      // G0-3: kill the upstream tree, not just the parent PID.
      killUpstreamTree();
      // A launch/attach already in flight finishes first; ensureBrave's
      // post-launch check then closes that Brave (relayShuttingDown is set).
      if (braveLaunchPromise) {
        await withTimeout(braveLaunchPromise, 8000, "in-flight Brave launch");
      }
      // G1-2: run Brave-close and inspector-close in PARALLEL with per-step
      // timeouts. Sequential await previously meant a hung Brave (30s) +
      // hung inspector (5s) = 35s shutdown wall time.
      // Clones close HARD (an attached clone Brave would otherwise survive
      // and have its dir rm -rf'd under it); a base's attached Brave is only
      // disconnected, deliberately, so the next relay inherits its tabs.
      const tasks = [];
      if (bridge) {
        const b = bridge;
        tasks.push(withTimeout(claim.cleanup ? closeBraveHard(b) : closeBrave(b), 8000, "closeBrave"));
        if (b.metaGuard) { try { b.metaGuard.close(); } catch {} }
        if (b.signinGuard) { try { b.signinGuard.close(); } catch {} }
      }
      if (inspectorHandle) tasks.push(withTimeout(inspectorHandle.close(), 3000, "inspector"));
      const results = await Promise.all(tasks);
      for (const r of results) {
        if (r.status === "timeout") {
          process.stderr.write(`[mcp-relay] shutdown ${r.label} timed out — proceeding\n`);
        }
      }
      // Now that Brave is closed (or timed out): release. For a clone this
      // removes the dir — before closeBrave it would race Brave recreating
      // files inside it.
      releaseClaim();
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
  // (2026-07-16) Exit when the MCP client goes away without a signal. The
  // stdio pipe closing (host window killed, client crashed, extension host
  // reloaded) is the only notification we get in that case — without this,
  // the relay lingers as a zombie holding its lock, upstream child, and
  // possibly a multi-hundred-MB Brave (the pre-2026-06 "16 orphans across
  // 3 sessions" failure mode). The SDK transport's 'data' listeners keep
  // stdin in flowing mode, so 'end'/'close' reliably fire on pipe close.
  const onStdioGone = async (why) => {
    process.stderr.write(`[mcp-relay] stdin ${why} — MCP client gone, shutting down\n`);
    try { await shutdownAsync(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.stdin.on("end", () => onStdioGone("ended"));
  process.stdin.on("close", () => onStdioGone("closed"));

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
