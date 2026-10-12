// pool-shared.js — slot/lock/cookie helpers for the relay.
//
// Two modes:
//
//   1. STANDALONE (default) — the relay manages a single user-data-dir.
//      Resolution: if the repo dir is writable, use `<repo>/.browser-data`
//      (gitignored, matches the legacy behavior most users expect). If the
//      repo lives somewhere read-only (e.g. system-wide install at
//      /opt/browser-mcp-relay or a read-only npm global) we fall back to a
//      per-user cache dir: $XDG_CACHE_HOME/browser-mcp-relay/browser-data
//      (Linux) / ~/Library/Caches/browser-mcp-relay/browser-data (macOS) /
//      %LOCALAPPDATA%\browser-mcp-relay\Cache\browser-data (Windows). Atomic
//      wrapper-lock on the chosen dir prevents two relay processes from
//      corrupting one Brave profile. Cookie snapshot is skipped (no source
//      profile to snapshot from).
//
//   2. POOL (opt-in) — set both BROWSER_RELAY_POOL_DIR and BROWSER_RELAY_POOL_SLOT.
//      The relay claims that one specific dir. If the host also has an
//      optional wrap-browser-devtools-mcp.js wrapper sitting next to this repo,
//      its richer config (slotRoles, cookieSourceProfile, multiple poolDirs)
//      is used. Otherwise pool mode degrades to "use this single dir as
//      if it were standalone".
//
// All helpers here are pure JS — no required dependencies on the parent
// wrapper file. The wrapper require is wrapped in try/catch so a clean
// clone of the relay repo works without it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { detectBravePath, detectBraveProfileDir } = require("./detect-browser.js");
const processShim = require("./process-shim.js");
const { applyLocalConfigToEnv } = require("./local-config.js");
const profileLock = require("./profile-lock.js");
const cdpIdentity = require("./cdp-identity.js");

// ───────────────────────────── Constants ─────────────────────────────

const WRAPPER_LOCK = ".mcp-wrapper-lock";

// LEGACY CDP port range. Since spec v4 §1b this relay launches Brave with
// --remote-debugging-port=0 (an OS-assigned port, read back from
// <user-data-dir>/DevToolsActivePort), so it no longer maps slots to ports.
// 9333..9349 is where PRE-CHANGE relays put their Braves (slot N → 9333+N-1,
// plus the old F1-21 remap headroom) and what external scanners such as
// ghl-jwt.mjs still scan; kept for them and for docs.
const PORT_BASE = 9333;
const PORT_SCAN_END = 9349;

// SNAPSHOT_FILES: profile files snapshotted from the cookie source into the
// claimed pool slot. Local State carries the DPAPI-wrapped os_crypt key
// (without it nothing else decrypts). Cookies live at Default/Network/ on
// Brave 92+ (Default/ is the legacy fallback). Login Data + Login Data For
// Account are SQLite password stores using the same os_crypt key. WAL/SHM
// files copy alongside main DBs because Brave 92+ runs SQLite in WAL mode,
// so recent writes in the source profile live in -wal until checkpoint;
// copying main DB without -wal can produce a stale snapshot. -journal is
// the legacy rollback path. copyOne silently skips missing entries.
const SNAPSHOT_FILES = [
  "Local State",
  "Default/Network/Cookies",
  "Default/Network/Cookies-wal",
  "Default/Network/Cookies-shm",
  "Default/Network/Cookies-journal",
  "Default/Cookies",
  "Default/Cookies-wal",
  "Default/Cookies-shm",
  "Default/Cookies-journal",
  "Default/Login Data",
  "Default/Login Data-wal",
  "Default/Login Data-shm",
  "Default/Login Data-journal",
  "Default/Login Data For Account",
  "Default/Login Data For Account-journal",
];

// SNAPSHOT_DIRS: localStorage / sessionStorage. Many SPAs (Discord, Slack,
// Linear, Notion, Mercury) store auth tokens in localStorage rather than
// cookies — without these you can have all the cookies in the world and
// still hit a login wall. fs.cpSync recursive copy handles LevelDB sub-files
// (CURRENT, MANIFEST-NNNNNN, NNNNNN.ldb, NNNNNN.log, LOCK). IndexedDB is
// opt-in only — typically 100+ MB across 1000+ files. Set
// BROWSER_RELAY_SNAPSHOT_INDEXEDDB=true to include it.
const SNAPSHOT_DIRS = [
  "Default/Local Storage/leveldb",
  "Default/Session Storage",
];

// Backwards-compat alias — older code referenced COOKIE_FILES.
const COOKIE_FILES = SNAPSHOT_FILES;

// ───────────────────────── Optional wrapper bridge ───────────────────
//
// If a sibling-of-sibling pool wrapper exists, we reuse its richer config.
// This is the maintainer's local-development layout
// (`<parent>/wrap-browser-devtools-mcp.js`); most public users won't have
// this file, which is fine — pool mode is opt-in via BROWSER_RELAY_POOL_DIR
// and standalone mode is the default.

let upstreamWrapper = null;
try {
  // The wrapper file is a sibling-of-sibling of this module
  // (`<parent>/wrap-browser-devtools-mcp.js`). Try to load it; if missing,
  // leave wrapper null and operate standalone.
  const wrapperPath = path.resolve(__dirname, "..", "..", "wrap-browser-devtools-mcp.js");
  if (fs.existsSync(wrapperPath)) {
    upstreamWrapper = require(wrapperPath);
  }
} catch (e) {
  // Defensive: any require failure (syntax, transitive) is silently treated
  // as "wrapper unavailable". Standalone mode keeps working.
  upstreamWrapper = null;
}

// ───────────────────────────── Config ────────────────────────────────

/**
 * Compute the standalone-mode default user-data-dir.
 *
 * Behavior (F1-9): legacy `<repo>/.browser-data` when the repo dir is
 * writable; per-user cache dir otherwise. Writability is probed via
 * fs.accessSync(repoRoot, W_OK) — synchronous, no probe file written.
 * Errors during fallback path resolution all degrade to the legacy
 * path so a misconfigured env never produces "no path at all".
 *
 * Pure (no side effects). Idempotent — safe to call repeatedly.
 *
 * Per-user cache dir resolution:
 *   - linux:   $XDG_CACHE_HOME/browser-mcp-relay/browser-data
 *              (falls back to ~/.cache when XDG_CACHE_HOME is unset/empty)
 *   - darwin:  ~/Library/Caches/browser-mcp-relay/browser-data
 *   - win32:   %LOCALAPPDATA%\browser-mcp-relay\Cache\browser-data
 *
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} absolute path to the standalone user-data-dir
 */
function defaultStandaloneDir(repoRoot, env) {
  const legacy = path.join(repoRoot, ".browser-data");
  // Writability check: prefer fs.accessSync (POSIX W_OK / Win cursory perm
  // bit) over a write-probe so we don't litter the repo with sentinel
  // files at module-load. fs.accessSync's win32 contract is loose
  // (effectively just "exists"), so the legacy path on Windows is taken
  // whenever repoRoot exists — that matches user expectation (npm install
  // into AppData puts repoRoot under user-writable LOCALAPPDATA anyway).
  let writable = false;
  try {
    fs.accessSync(repoRoot, fs.constants.W_OK);
    writable = true;
  } catch { /* not writable */ }
  if (writable) return legacy;

  try {
    return path.join(userCacheRoot(env), "browser-data");
  } catch {
    return legacy;
  }
}

/** Per-user cache root for relay-owned data (standalone browser-data
 *  fallback, session-clone profiles). XDG-ish on Linux, ~/Library/Caches on
 *  macOS, %LOCALAPPDATA%\Cache on Windows. */
function userCacheRoot(env = process.env) {
  const platform = process.platform;
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "browser-mcp-relay", "Cache");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "browser-mcp-relay");
  }
  const xdg = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0
    ? env.XDG_CACHE_HOME
    : path.join(os.homedir(), ".cache");
  return path.join(xdg, "browser-mcp-relay");
}

/**
 * Build the relay's runtime config. Resolution order:
 *
 *   - bravePath: BROWSER_RELAY_BRAVE_PATH > wrapper.CONFIG.bravePath > detectBravePath()
 *     (V1-2: wrapper now wins over auto-detect when present, since auto-detect
 *     might find a stale Brave at the standard path even when the wrapper has
 *     an explicit override.)
 *   - proxyUrl:  BROWSER_RELAY_PROXY_URL > wrapper.CONFIG.proxyUrl > null
 *     (V1-1: wrapper.proxyUrl is now bridged so the relay's launched Brave
 *     inherits the same per-process proxy whitelist that wrapper-spawned
 *     BDMCP gets. Previously the field was wrapper-only.)
 *   - poolDirs:  BROWSER_RELAY_POOL_DIR (single-element array, opt-in)
 *                > wrapper.CONFIG.poolDirs (when the optional wrapper is present)
 *                > [<repo>/.browser-data] (standalone default)
 *   - cookieSourceProfile: wrapper.CONFIG.cookieSourceProfile if present, else null
 *   - cookieFreshnessWarnDays: wrapper.CONFIG or 7
 *   - slotRoles: wrapper.CONFIG or {}
 *
 * Mutating the returned object is safe — each call returns a fresh
 * object; nothing else in the module reads from it.
 */
function loadConfig({ env = process.env, repoRoot = path.resolve(__dirname, "..") } = {}) {
  const wrapperConfig = upstreamWrapper && upstreamWrapper.CONFIG ? upstreamWrapper.CONFIG : null;

  // Layer local-config.json under env vars. Real env values win; otherwise
  // the file's value (if any) is used. Auto-detection still runs underneath.
  env = applyLocalConfigToEnv(env);

  // Brave path resolution order (V1-2):
  //   1. BROWSER_RELAY_BRAVE_PATH (env override)  — explicit, always wins
  //   2. wrapper.CONFIG.bravePath                 — when the optional wrapper
  //                                                 declares one, trust it
  //                                                 over auto-detect because
  //                                                 the user explicitly set it
  //   3. detectBravePath() auto-detect            — standard install paths,
  //                                                 then registry/which probes
  //
  // braveDetectError captures any auto-detect failure so launch-time error
  // messages can include the original detection context.
  //
  // V1-2 follow-up: step 1 now validates the env path with fs.statSync
  // directly (not via detectBravePath, which would itself fall through to
  // auto-detect when the env path doesn't exist). That way a bad env path
  // truly falls through to step 2 (wrapper), not step 3 (auto-detect),
  // matching what the doc claims.
  let bravePath = null;
  let braveDetectError = null;
  // Step 1: explicit env override — only succeeds when file exists.
  if (env.BROWSER_RELAY_BRAVE_PATH && env.BROWSER_RELAY_BRAVE_PATH.length > 0) {
    const envPath = env.BROWSER_RELAY_BRAVE_PATH;
    try {
      if (fs.statSync(envPath).isFile()) {
        bravePath = envPath;
      } else {
        braveDetectError = new Error(
          `[browser-mcp-relay] BROWSER_RELAY_BRAVE_PATH="${envPath}" is not a file. Falling through to wrapper / auto-detect.`,
        );
      }
    } catch (statErr) {
      braveDetectError = new Error(
        `[browser-mcp-relay] BROWSER_RELAY_BRAVE_PATH="${envPath}" but stat failed: ${statErr.message}. Falling through to wrapper / auto-detect.`,
      );
    }
  }
  // Step 2: wrapper hint (only if step 1 didn't produce a value).
  if (!bravePath && wrapperConfig && typeof wrapperConfig.bravePath === "string" && wrapperConfig.bravePath.length > 0) {
    try {
      if (fs.statSync(wrapperConfig.bravePath).isFile()) {
        bravePath = wrapperConfig.bravePath;
      }
    } catch { /* file missing or stat failed — fall through to auto-detect */ }
  }
  // Step 3: auto-detect (only if neither step 1 nor step 2 produced a value).
  if (!bravePath) {
    try {
      bravePath = detectBravePath({ env });
    } catch (detectErr) {
      // Defer error: many tests just want CONFIG.poolDirs and shouldn't crash
      // because Brave isn't installed in CI. Store null + capture the error
      // so launch-path code can fold its message into a richer error.
      braveDetectError = braveDetectError || detectErr;
      bravePath = null;
    }
  }

  // Pool dirs: env > wrapper > standalone default
  let poolDirs;
  let slotRoles = {};
  let cookieSourceProfile = null;
  let cookieFreshnessWarnDays = 7;
  let staleAfterMs = 5 * 60 * 1000;

  if (env.BROWSER_RELAY_POOL_DIR) {
    poolDirs = [env.BROWSER_RELAY_POOL_DIR];
    if (wrapperConfig) {
      // Inherit cookie source + freshness if wrapper exists.
      cookieSourceProfile = wrapperConfig.cookieSourceProfile || null;
      cookieFreshnessWarnDays = wrapperConfig.cookieFreshnessWarnDays || 7;
      staleAfterMs = wrapperConfig.staleAfterMs || staleAfterMs;
    }
  } else if (wrapperConfig && Array.isArray(wrapperConfig.poolDirs) && wrapperConfig.poolDirs.length > 0) {
    poolDirs = wrapperConfig.poolDirs.slice();
    slotRoles = wrapperConfig.slotRoles || {};
    cookieSourceProfile = wrapperConfig.cookieSourceProfile || null;
    cookieFreshnessWarnDays = wrapperConfig.cookieFreshnessWarnDays || 7;
    staleAfterMs = wrapperConfig.staleAfterMs || staleAfterMs;
  } else {
    // Standalone default. F1-9 (2026-05-10): prefer `<repo>/.browser-data`
    // (legacy) when the repo is writable; fall back to a per-user cache
    // dir for system-wide / read-only install paths (npm -g into a root-
    // owned prefix, /opt/<dir>, etc.). The per-user cache path is XDG-ish
    // on Linux, ~/Library/Caches on macOS, %LOCALAPPDATA%\Cache on Win.
    poolDirs = [defaultStandaloneDir(repoRoot, env)];
  }

  // V1-1: proxyUrl resolution. The wrapper's browser-mcp-config.json may
  // declare a proxy that wrapper-spawned BDMCP routes through; bridge it
  // into the relay's CONFIG so index.js can pass it to launchBrave too.
  // Env override (BROWSER_RELAY_PROXY_URL) still wins.
  let proxyUrl = null;
  if (env.BROWSER_RELAY_PROXY_URL && env.BROWSER_RELAY_PROXY_URL.length > 0) {
    proxyUrl = env.BROWSER_RELAY_PROXY_URL;
  } else if (wrapperConfig && typeof wrapperConfig.proxyUrl === "string" && wrapperConfig.proxyUrl.length > 0) {
    proxyUrl = wrapperConfig.proxyUrl;
  }

  return {
    bravePath,
    braveDetectError,
    proxyUrl,
    poolDirs,
    slotRoles,
    cookieSourceProfile,
    cookieFreshnessWarnDays,
    staleAfterMs,
    standalone: !env.BROWSER_RELAY_POOL_DIR && !wrapperConfig,
  };
}

const CONFIG = loadConfig();

// ───────────────────────── Process introspection ─────────────────────
// Cross-platform via `./process-shim.js`. Win uses PowerShell; Mac/Linux use
// plain `ps`. The brave-process needle differs by platform: Windows command
// lines contain `brave.exe` literally, Mac/Linux contain `brave` (no .exe).

/** Boundary-aware `--user-data-dir=<dir>` matcher. A bare substring check
 *  would make dir "/profiles/as-ops" match a process running on
 *  "/profiles/as-ops-sessions/123" (prefix collision) — with session-clone
 *  dirs in play, that would let reapOrphansFor(baseDir) kill a clone's
 *  Brave. The bare form only matches when the dir is followed by
 *  end-of-line, whitespace, or a closing quote. */
function commandHasUserDataDir(cmd, dir) {
  if (!cmd || !dir) return false;
  if (cmd.includes(`--user-data-dir="${dir}"`)) return true;
  const bare = `--user-data-dir=${dir}`;
  let idx = 0;
  while ((idx = cmd.indexOf(bare, idx)) !== -1) {
    const after = cmd[idx + bare.length];
    if (after === undefined || after === " " || after === "\t" || after === '"') return true;
    idx += bare.length;
  }
  return false;
}

/** Pure parser. Given the stdout of the brave-process probe (one
 *  `<PID>|<command-line>` line per process) and a profile dir, return the
 *  PIDs of brave processes whose command line includes `--user-data-dir=<dir>`
 *  either unquoted or with `"..."` around dir (boundary-aware — a dir that is
 *  a path-prefix of another profile dir does not match it).
 *
 *  Kept as the canonical Windows-shape parser for backwards compat with
 *  external callers and for unit tests. Internally we use the structured
 *  output of `processShim.listProcessesByCommand`. */
function findBraveProcessesForDir(stdoutText, dir) {
  const pids = [];
  for (const line of (stdoutText || "").split(/\r?\n/)) {
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    const cmd = line.slice(sep + 1);
    if (!commandHasUserDataDir(cmd, dir)) continue;
    const pid = parseInt(line.slice(0, sep), 10);
    if (Number.isFinite(pid)) pids.push(pid);
  }
  return pids;
}

/** Brave-needle for the current platform — needs to differ because Win
 *  command lines include `brave.exe` literally while Mac/Linux just say
 *  `brave`. Exposed for testing. */
function braveNeedle(platform) {
  return platform === "win32" ? "brave.exe" : "brave";
}

/** Snapshot all Brave processes. Returns one `PID|CommandLine` line per
 *  process, joined by `\r\n`. Empty string on failure or no matches.
 *
 *  Cross-platform via processShim. Backwards compat: still returns the
 *  pipe-formatted text shape so existing callers and tests work unchanged. */
function listBraveProcessesRaw(opts = {}) {
  const platform = opts._platform || process.platform;
  const procs = processShim.listProcessesByCommand(braveNeedle(platform), opts);
  return procs.map((p) => `${p.pid}|${p.command}`).join("\r\n");
}

/** Find orphan Brave PIDs holding `dir` as their user-data-dir (parent +
 *  any child helpers Brave spawned) and kill them. On Windows we use
 *  `taskkill /F /T` to take the whole tree; on POSIX we send SIGTERM, then
 *  SIGKILL after a brief grace period.
 *
 *  Best-effort; logs failures to stderr; returns the count of processes
 *  we successfully signaled. Caller must already hold the wrapper lock
 *  for `dir`. */
function reapOrphansFor(dir, opts = {}) {
  const platform = opts._platform || process.platform;
  const spawn = opts._spawnSync || spawnSync;
  const procs = processShim.listProcessesByCommand(braveNeedle(platform), opts);
  const matched = procs.filter((p) => commandHasUserDataDir(p.command, dir));

  let killed = 0;
  for (const { pid } of matched) {
    if (platform === "win32") {
      // G1-4 (2026-05-10): cap taskkill at 10s. Normally fast (<200ms) but
      // a wedged kernel handle (target stuck in uninterruptible kernel wait)
      // can make it block forever. Without this cap, claimSlot's pre-claim
      // reap could hang the entire relay startup.
      const result = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        windowsHide: true,
        timeout: 10000,
      });
      if (result && result.status === 0) {
        killed++;
        process.stderr.write(`[mcp-relay] reaped orphan brave.exe pid=${pid} holding ${dir}\n`);
      } else {
        const err = (result && (result.stderr || result.error)) || "non-zero exit";
        process.stderr.write(`[mcp-relay] taskkill pid=${pid} failed: ${err}\n`);
      }
    } else {
      // POSIX: SIGTERM, then immediate SIGKILL if still alive.
      const kill = opts._processKill || ((p, s) => process.kill(p, s));
      try {
        kill(pid, "SIGTERM");
        killed++;
        process.stderr.write(`[mcp-relay] reaped orphan brave pid=${pid} holding ${dir} (SIGTERM)\n`);
      } catch (e) {
        process.stderr.write(`[mcp-relay] kill SIGTERM pid=${pid} failed: ${e.message}\n`);
        continue;
      }
      // Synchronous SIGKILL escalation with no sleep — claimSlot is on the hot
      // path and we can't block. SIGTERM is async at the kernel level, so this
      // check usually still sees the process alive and double-signals. Fine for
      // orphan reaping (we want them dead either way); not a graceful shutdown.
      try {
        if (processShim.isPidAlive(pid, opts)) {
          kill(pid, "SIGKILL");
        }
      } catch {
        // Best-effort: if the process is already gone, that's fine.
      }
    }
  }
  return killed;
}

/** PID liveness check. Delegates to processShim for cross-platform handling
 *  (Win uses `tasklist`; Mac/Linux use POSIX `process.kill(pid, 0)`). */
function isPidAlive(pid, opts) {
  return processShim.isPidAlive(pid, opts);
}

// ───────────────────────── Cookie helpers ────────────────────────────

/** Return days since `absPath` was last modified (fractional). Returns
 *  null on any stat failure (missing file, permission denied, etc.).
 *  Caller treats null as "unknown" — NOT as "recent". */
function checkCookieAgeDays(absPath) {
  try {
    const stat = fs.statSync(absPath);
    return (Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000);
  } catch {
    return null;
  }
}

/** Return the path to the canonical cookie SQLite store inside a
 *  Chromium profile dir, preferring the modern Brave/Chrome 92+
 *  path (Default/Network/Cookies) and falling back to the legacy
 *  path (Default/Cookies). Returns null if neither exists.
 *
 *  When called with no `profileDir`, falls back to {@link detectBraveProfileDir}
 *  for the host's default Brave install. This makes `findCookiesFile()` a
 *  one-call helper for cookie-export tools that just want "give me the user's
 *  Brave cookies on whatever OS they're on". */
function findCookiesFile(profileDir) {
  let dir = profileDir;
  if (!dir) {
    dir = detectBraveProfileDir();
  }
  if (!dir) return null;
  const modern = path.join(dir, "Default", "Network", "Cookies");
  if (fs.existsSync(modern)) return modern;
  const legacy = path.join(dir, "Default", "Cookies");
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/** Pure helper. When `requestedRole` is falsy returns a fresh copy of
 *  all pool dirs (role-less mode). Otherwise returns only dirs whose
 *  entry in `cfg.slotRoles` matches the requested role. Returns []
 *  when role is requested but no slot is configured for it. */
function pickDirCandidates(cfg, requestedRole) {
  if (!requestedRole) return cfg.poolDirs.slice();
  return cfg.poolDirs.filter((d) => (cfg.slotRoles || {})[d] === requestedRole);
}

// ───────────────────────── Slot claim ────────────────────────────────

/**
 * Try to claim ONE dir under the kernel flock + v2 record protocol
 * (profile-lock.js, spec v4 §1a). Returns null when the dir is busy (a live
 * relay holds its flock, or a live pre-change relay holds its record);
 * otherwise { dir, lock: { fd, path, flockPath }, flock, meta, release }.
 * release() unlinks our record (owner-checked) and THEN closes the flock fd.
 *
 * NOTE (2026-07-06): claim does not reap orphan Brave processes. An orphan
 * Brave holding this dir is an ATTACH candidate — index.js ensureBrave probes
 * it via findAttachableBrave() and only reaps when it can't attach.
 */
function tryClaimDir(dir, opts = {}) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  const claim = profileLock.claimDir(dir, opts);
  if (!claim) return null;
  return {
    dir,
    lock: { fd: claim.flock.fd, path: path.join(dir, WRAPPER_LOCK), flockPath: claim.flock.path },
    flock: claim.flock,
    meta: claim.meta,
    release: claim.release,
  };
}

/**
 * Claim a pool slot for the relay — single synchronous pass over the
 * candidate dirs. Kept for backwards compat; the entrypoint uses
 * claimSlotWithRetry() which layers retry + session-clone fallback on top.
 *
 * Throws an Error with code "POOL_BUSY" when every candidate dir is locked
 * by a live process (retryable); other errors are config problems (not
 * retryable).
 *
 * @returns {{ dir: string, lock: { fd: number, path: string }, role: string, release: () => void }}
 */
function claimSlot() {
  const requestedRole = process.env.BROWSER_MCP_ROLE || undefined;
  const candidates = pickDirCandidates(CONFIG, requestedRole);
  if (candidates.length === 0) {
    throw new Error(
      `[mcp-relay] no pool dirs configured for role="${requestedRole}". ` +
      `In standalone mode, this should never happen — check pool-shared.js.`,
    );
  }

  for (const dir of candidates) {
    const claimed = tryClaimDir(dir);
    if (!claimed) continue;
    const role = (CONFIG.slotRoles || {})[dir] || "default";
    return { ...claimed, role };
  }

  const err = new Error(
    `[mcp-relay] pool exhausted for role="${requestedRole || "any"}" — ` +
    `all of ${candidates.join(", ")} are in use.`,
  );
  err.code = "POOL_BUSY";
  throw err;
}

// ───────────────────── Session clones (overflow) ─────────────────────
//
// When every candidate dir is locked by a LIVE relay (a second Claude
// session in the same project, most commonly), the relay no longer dies
// with "pool exhausted". It falls back to an EPHEMERAL session clone:
// a fresh profile dir seeded from the busy base profile via the existing
// snapshot machinery (cookies, Local State, Login Data, localStorage,
// sessionStorage) so logins carry over. Each concurrent session gets its
// own Brave window with its own tabs; clones are GC'd when their owning
// relay dies.
//
// Clones live under <userCacheRoot>/session-clones/<base>-p<pid>-<nonce>,
// a DIFFERENT parent dir from any base profile, so no clone path is ever
// a path-prefix relative of a base dir (see commandHasUserDataDir).

const SESSION_CLONES_DIRNAME = "session-clones";

function sessionClonesRoot(env = process.env) {
  return path.join(userCacheRoot(env), SESSION_CLONES_DIRNAME);
}

/** Create a unique clone dir for this process. The pid keys GC (dir is
 *  reclaimable once the pid dies); the nonce disambiguates pid reuse. Clone
 *  names are never re-claimed, which is what makes `rm -rf` of a clone dir —
 *  flock file included — safe. */
function createSessionCloneDir(baseDir, opts = {}) {
  const root = opts.root || sessionClonesRoot();
  const nonce = Math.random().toString(36).slice(2, 8);
  const dir = path.join(root, `${path.basename(baseDir)}-p${process.pid}-${nonce}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does clone dir name `name` belong to project `project` (a base dir's
 *  basename)? Exact `<project>-p<pid>-<nonce>`, so project "as-ops" never
 *  matches a clone of "as-ops-pages". */
function cloneBelongsTo(name, project) {
  return new RegExp(`^${escapeRegExp(project)}-p\\d+-[a-z0-9]+$`).test(name);
}

/**
 * Remove session-clone dirs whose owner is gone, using THE predicate
 * (profile-lock.classifyDir). A clone is removable iff
 *   - its dir mtime, read BEFORE its flock is opened, is older than `graceMs`
 *     (a just-created clone is never touched — opening its flock first would
 *     make the owner's own claim fail with EAGAIN), and
 *   - the predicate says free (flock acquired, record not held), and
 *   - no live Brave holds it (one `ps` per sweep, not per dir).
 * The dir is removed WHILE its flock is held, then the fd is closed.
 * `opts.project` limits the sweep to one project's clones (spec: sweep this
 * project only). Best-effort: any per-dir failure is logged and skipped.
 *
 * @returns {number} count of clone dirs removed
 */
function gcSessionClones(opts = {}) {
  const root = opts.root || sessionClonesRoot();
  const graceMs = opts.graceMs ?? 60_000;
  const now = opts._now ?? Date.now();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0; // root doesn't exist yet — nothing to GC
  }
  let braves = null; // listed at most once per sweep, and only if needed
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (opts.project && !cloneBelongsTo(entry.name, opts.project)) continue;
    const dir = path.join(root, entry.name);
    let flock = null;
    try {
      // Age first — before anything is opened or created inside the dir.
      const age = now - fs.statSync(dir).mtimeMs;
      if (age < graceMs) continue;
      const c = profileLock.classifyDir(dir, opts);
      if (!c.free) continue;
      flock = c.flock;
      if (braves === null) {
        const platform = opts._platform || process.platform;
        braves = processShim.listProcessesByCommand(braveNeedle(platform), opts);
      }
      // Never rm a dir a live Brave is still using, whatever the record says.
      if (braves.some((p) => commandHasUserDataDir(p.command, dir))) {
        process.stderr.write(`[mcp-relay] session-clone GC kept ${dir}: live Brave still holds it\n`);
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
      process.stderr.write(`[mcp-relay] GC'd dead session clone ${dir}\n`);
    } catch (e) {
      process.stderr.write(`[mcp-relay] session-clone GC skipped ${dir}: ${e.message}\n`);
    } finally {
      profileLock.closeFlock(flock);
    }
  }
  return removed;
}

/** Claim our own freshly-created clone. GC never opens a clone's flock in its
 *  first 60 s, but an inspector or prune probe could hold it for an instant:
 *  retry for ~1 s before giving up. */
async function claimFreshClone(cloneDir, opts = {}) {
  const sleep = opts._sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < 20; i++) {
    const claimed = tryClaimDir(cloneDir, opts);
    if (claimed) return claimed;
    await sleep(50);
  }
  return null;
}

/**
 * Claim a slot with retry, falling back to an ephemeral session clone.
 *
 *   1. Try claimSlot(). On POOL_BUSY, retry every `delayMs` up to `retries`
 *      times — this absorbs the reconnect race where the previous relay is
 *      mid-shutdown and releases its lock within a second or two.
 *   2. Still busy: GC this project's dead clones, create a fresh clone dir
 *      next to (not inside) the base profile, claim it, and return it flagged
 *      { ephemeral: true, baseDir } so the entrypoint can seed it from the
 *      base profile's cookies/storage.
 *
 * A temp-path project (BROWSER_RELAY_EPHEMERAL_POOL_DIR=1, set by
 * launch-project-isolated.js) claims its single fresh dir and is ephemeral
 * with no base: nothing to seed from, removed at exit.
 *
 * Non-POOL_BUSY errors (config problems) are never retried.
 *
 * @param {object} [opts]
 * @param {number} [opts.retries=6]
 * @param {number} [opts.delayMs=500]
 * @param {boolean} [opts.allowClone=true]
 * @param {(ms: number) => Promise<void>} [opts._sleep] — test seam
 * @returns {Promise<{ dir, lock, role, release, cleanup?, ephemeral: boolean, baseDir: string|null }>}
 */
async function claimSlotWithRetry(opts = {}) {
  const retries = opts.retries ?? 6;
  const delayMs = opts.delayMs ?? 500;
  const allowClone = opts.allowClone ?? true;
  const sleep = opts._sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const claimOnce = opts._claimSlot || claimSlot;
  const env = opts._env || applyLocalConfigToEnv(process.env);

  if (!opts._claimSlot && env.BROWSER_RELAY_EPHEMERAL_POOL_DIR === "1") {
    const dir = CONFIG.poolDirs[0];
    const claimed = await claimFreshClone(dir, opts);
    if (!claimed) throw new Error(`[mcp-relay] could not claim the fresh ephemeral dir ${dir}`);
    return { ...claimed, role: "default", release: () => {}, cleanup: ownedDirCleanup(dir, claimed), ephemeral: true, baseDir: null };
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    try {
      return { ...claimOnce(), ephemeral: false, baseDir: null };
    } catch (e) {
      if (e.code !== "POOL_BUSY") throw e;
      lastErr = e;
      if (attempt === 0) {
        process.stderr.write(
          `[mcp-relay] all pool dirs busy — retrying up to ${retries}× every ${delayMs}ms before cloning\n`,
        );
      }
    }
  }

  if (!allowClone) throw lastErr;

  // Fall back to an ephemeral session clone of the first candidate dir.
  const requestedRole = process.env.BROWSER_MCP_ROLE || undefined;
  const baseDir = pickDirCandidates(CONFIG, requestedRole)[0];
  try { gcSessionClones({ ...opts, project: path.basename(baseDir) }); } catch { /* best-effort */ }
  const cloneDir = createSessionCloneDir(baseDir, opts);
  const claimed = await claimFreshClone(cloneDir, opts);
  if (!claimed) {
    // Our own unique dir stayed busy for ~1 s — should be impossible.
    throw lastErr;
  }
  process.stderr.write(
    `[mcp-relay] base profile busy (live relay holds it) — using ephemeral session clone ${cloneDir} seeded from ${baseDir}\n`,
  );
  const role = (CONFIG.slotRoles || {})[baseDir] || "default";
  // Ephemeral lifecycle differs from a regular slot: release() is a NO-OP —
  // no other relay ever reclaims a clone dir, and releasing early would let a
  // sibling's GC take the dir while this clone's Brave is still closing. The
  // flock is held until cleanup(), which runs AFTER Brave is closed.
  return { ...claimed, role, release: () => {}, cleanup: ownedDirCleanup(cloneDir, claimed), ephemeral: true, baseDir };
}

/** Spec N4: the owner removes its clone WHILE still holding the flock fd, then
 *  closes it. Unclean deaths are covered by GC on a later start. */
function ownedDirCleanup(dir, claimed) {
  let done = false;
  return function cleanup() {
    if (done) return;
    done = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* GC will get it */ }
    profileLock.closeFlock(claimed.flock);
  };
}

// ───────────────────── Attach-to-existing Brave ──────────────────────

/** Extract a NONZERO `--remote-debugging-port=N` from a command line; null
 *  when absent or 0. Use cdpIdentity.debugPortArg to see 0. */
function extractDebugPort(cmd) {
  const port = cdpIdentity.debugPortArg(cmd);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/**
 * Find a live Brave already holding `dir` whose CDP endpoint is PROVEN to be
 * that Brave (cdp-identity.js) — the attach candidate a new relay connects to
 * instead of reaping. Returns { pid, port, wsEndpoint, legacy } or null.
 *
 *   --remote-debugging-port=0  → DevToolsActivePort + uuid identity check
 *   --remote-debugging-port=N  → the pid itself must listen on 127.0.0.1:N
 *                                (lsof, address-specific), ws url from /json/version
 *   no port (pipe-only)        → not attachable → caller reaps + relaunches
 *
 * @param {string} dir
 * @param {object} [opts] — seams: _platform, _spawnSync (ps), _fetch,
 *   _listensOnLoopbackV4, probeTimeoutMs
 */
async function findAttachableBrave(dir, opts = {}) {
  const platform = opts._platform || process.platform;
  const timeoutMs = opts.probeTimeoutMs ?? 1000;
  const procs = processShim.listProcessesByCommand(braveNeedle(platform), opts);
  const mains = procs.filter((p) => commandHasUserDataDir(p.command, dir) && cdpIdentity.debugPortArg(p.command) !== null);
  for (const p of mains) {
    try {
      const ep = await cdpIdentity.resolveBraveEndpoint(p, dir, { ...opts, timeoutMs });
      if (ep) return { pid: p.pid, ...ep };
    } catch { /* not provable — not attachable via this process */ }
  }
  return null;
}

/** pid of the live Brave MAIN process running on `dir`, or null. */
function findBraveMainPid(dir, opts = {}) {
  const platform = opts._platform || process.platform;
  const procs = processShim.listProcessesByCommand(braveNeedle(platform), opts);
  const main = procs.find((p) => commandHasUserDataDir(p.command, dir) && cdpIdentity.debugPortArg(p.command) !== null);
  return main ? main.pid : null;
}

// ───────────────── Inspector: state probe + Reap under the flock ─────────────

/** "held" | "free" | "absent" for an inspector row, by THE predicate. Never
 *  keeps the flock. "absent" = no such dir. */
function probeDirState(dir, opts = {}) {
  if (!fs.existsSync(dir)) return "absent";
  const c = profileLock.classifyDir(dir, opts);
  if (!c.free) return "held";
  profileLock.closeFlock(c.flock);
  return "free";
}

/** The inspector's Reap: only when the predicate says free, and only under the
 *  flock — reap Brave squatters, remove the stale record (owner-checked),
 *  then release. Throws when the dir is held. */
function reapDirUnderFlock(dir, opts = {}) {
  const c = profileLock.classifyDir(dir, opts);
  if (!c.free) throw new Error(`not reaping ${dir}: ${c.reason}`);
  try {
    const killed = (opts._reapOrphansFor || reapOrphansFor)(dir, opts);
    profileLock.removeStaleRecord(dir, c.record);
    return killed;
  } finally {
    profileLock.closeFlock(c.flock);
  }
}

// ───────────────────────── Profile snapshot ──────────────────────────

/**
 * Snapshot profile files (cookies + Local State + password DBs) from
 * cookieSourceProfile (if configured & present) into the slot dir. No-op in
 * standalone mode (sourceProfile is null). Returns the count of files copied
 * — caller can log it.
 */
function snapshotCookiesFrom(srcProfile, dstProfile) {
  if (!srcProfile || !fs.existsSync(srcProfile)) return 0;
  let copied = 0;
  for (const rel of SNAPSHOT_FILES) {
    const s = path.join(srcProfile, rel);
    const d = path.join(dstProfile, rel);
    try {
      if (fs.existsSync(s)) {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
        // F1-4 (2026-05-10): tighten permissions on copied secrets. These
        // files contain DPAPI-wrapped cookie keys, encrypted password DBs,
        // and SQLite stores with auth tokens — should be 0o600 (owner-only)
        // on multi-user POSIX systems. Windows ignores chmod.
        if (process.platform !== "win32") {
          try { fs.chmodSync(d, 0o600); } catch { /* best-effort */ }
        }
        copied++;
      }
    } catch (e) {
      process.stderr.write(`[mcp-relay] snapshot copy ${rel} failed: ${e.code || e.message}\n`);
    }
  }
  return copied;
}

/**
 * Snapshot profile directories (localStorage / sessionStorage / optional
 * IndexedDB) from cookieSourceProfile into the slot dir. fs.cpSync handles
 * LevelDB sub-files including LOCK; force:true overwrites any prior snapshot.
 *
 * @param {string} srcProfile
 * @param {string} dstProfile
 * @param {object} [opts]
 * @param {boolean} [opts.includeIndexedDB] — when true, also snapshot
 *   Default/IndexedDB. Off by default (typically 100+ MB).
 * @returns {{ copied: number, total: number, bytes: number, elapsedMs: number }}
 */
function snapshotDirsFrom(srcProfile, dstProfile, { includeIndexedDB = false } = {}) {
  if (!srcProfile || !fs.existsSync(srcProfile)) {
    return { copied: 0, total: 0, bytes: 0, elapsedMs: 0 };
  }
  const dirs = SNAPSHOT_DIRS.slice();
  if (includeIndexedDB) dirs.push("Default/IndexedDB");
  let copied = 0;
  let bytes = 0;
  const t0 = Date.now();
  for (const rel of dirs) {
    const s = path.join(srcProfile, rel);
    const d = path.join(dstProfile, rel);
    try {
      if (fs.existsSync(s)) {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.cpSync(s, d, { recursive: true, force: true });
        copied++;
        // Best-effort byte counter for the launch banner. Walks dest after copy.
        try {
          const stack = [d];
          while (stack.length) {
            const p = stack.pop();
            const stat = fs.statSync(p);
            if (stat.isDirectory()) {
              for (const e of fs.readdirSync(p)) stack.push(path.join(p, e));
            } else bytes += stat.size;
          }
        } catch {}
      }
    } catch (e) {
      process.stderr.write(`[mcp-relay] snapshot dir ${rel} failed: ${e.code || e.message}\n`);
    }
  }
  return { copied, total: dirs.length, bytes, elapsedMs: Date.now() - t0 };
}

module.exports = {
  CONFIG,
  COOKIE_FILES,
  SNAPSHOT_FILES,
  SNAPSHOT_DIRS,
  PORT_BASE,
  PORT_SCAN_END,
  loadConfig,
  claimSlot,
  claimSlotWithRetry,
  tryClaimDir,
  sessionClonesRoot,
  createSessionCloneDir,
  cloneBelongsTo,
  gcSessionClones,
  claimFreshClone,
  findAttachableBrave,
  findBraveMainPid,
  extractDebugPort,
  probeDirState,
  reapDirUnderFlock,
  commandHasUserDataDir,
  findBraveProcessesForDir,
  listBraveProcessesRaw,
  reapOrphansFor,
  isPidAlive,
  braveNeedle,
  checkCookieAgeDays,
  findCookiesFile,
  pickDirCandidates,
  snapshotCookiesFrom,
  snapshotDirsFrom,
  userCacheRoot,
  /** F1-9: exported for tests of the standalone-default fallback path. */
  defaultStandaloneDir,
  /** Test seam: whether the optional pool wrapper was found at require time. */
  hasPoolWrapper: upstreamWrapper !== null,
};
