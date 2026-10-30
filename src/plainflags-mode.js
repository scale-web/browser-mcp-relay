"use strict";

// plainflags-mode.js — the plain-flags launch profile (spec v8 §5.6, phase 1c;
// D29 a separate profile, D20 any site, D21 a sign-in allowlist, D22 measured
// 2026-10-30: PASS — vault 00 - Summary/Phase 1b Measurement (D22).md).
//
// The mode is chosen AT RELAY START by BROWSER_RELAY_PROFILE_MODE=plainflags in
// the PROCESS environment only — the env the `browser-mcp-relay-plainflags`
// MCP entry sets. Never through local-config.json (applyLocalConfigToEnv turns
// every key there into an env value for EVERY lane, so a key would flip every
// lane's relay into this mode); such a key is ignored and logged once. Never
// switchable by a tool call.
//
// The default relay is unchanged (D29): same flags, profiles, seeding and tools.
// The one addition to it: it refuses a pool dir under either plain-flags root.
//
// BOUNDARY HONESTY (spec §5.6, review r6 #10, round 2 item 2): everything here
// is an ACCIDENT GUARD, not a security boundary. The env, this file,
// plainflags-signin.json AND the claude-ask store (~/.claude-asks, which the
// sign-in list's askId check reads) are all writable by any session — a
// determined or prompt-injected session can add an entry and a record that
// passes the check. And any local process can drive this Brave directly over
// its debugging port (DevToolsActivePort / the sidecar's cdpPort), outside the
// tool list and the layer-1 checks.

/** BROWSER_RELAY_PLAINFLAGS_REQUIRE_TYPED_ANSWER=1 (process env only, like the
 *  mode): sign-in list entries also need the ask answer's prompt_id (the A71
 *  typed-words recorder). Off by default until that recorder is live. */
const REQUIRE_TYPED_ANSWER_ENV = "BROWSER_RELAY_PLAINFLAGS_REQUIRE_TYPED_ANSWER";
function requireTypedAnswer(env = process.env) {
  const v = env && env[REQUIRE_TYPED_ANSWER_ENV];
  return typeof v === "string" && v !== "" && v !== "0" && v !== "false";
}


const fs = require("node:fs");
const path = require("node:path");

const MODE_ENV = "BROWSER_RELAY_PROFILE_MODE";
const PLAINFLAGS = "plainflags";
const DEFAULT = "default";
const PROFILES_DIRNAME = "profiles-plainflags";
const CLONES_DIRNAME = "session-clones-plainflags";
const DEFAULT_PROFILES_DIRNAME = "profiles";
const DEFAULT_CLONES_DIRNAME = "session-clones";
const REGISTRY_NAME = "project-registry.json";

// The flag set (D23: --remote-debugging-port=0 stays). Measured 2026-10-30
// (D22): with these two changes navigator.webdriver is false and a GHL
// invisible-mode Turnstile issued a token on load, 3/3; the default flags got none.
const PLAINFLAGS_IGNORE_DEFAULT_ARGS = Object.freeze(["--enable-automation"]);
// --no-proxy-server (review round 1 item 8): no proxy reaches this Brave from
// any source, the system's included; HTTP(S)_PROXY / ALL_PROXY are also
// stripped from its environment (cdp-bridge.js).
const PLAINFLAGS_ARGS = Object.freeze(["--disable-blink-features=AutomationControlled", "--no-proxy-server"]);
const PROXY_ENV_RE = /^(https?|all)_proxy$/i;

function rawMode(env = process.env) {
  const v = env && env[MODE_ENV];
  return typeof v === "string" ? v.trim() : "";
}

/** "plainflags" or "default", from the PROCESS env only (never local-config). */
function profileMode(env = process.env) {
  return rawMode(env) === PLAINFLAGS ? PLAINFLAGS : DEFAULT;
}

/** A value that is neither unset, "default" nor "plainflags" is refused
 *  (a typo must not silently start the default relay where plain-flags was meant). */
function modeProblem(env = process.env) {
  const v = rawMode(env);
  if (v === "" || v === DEFAULT || v === PLAINFLAGS) return null;
  return `[mcp-relay] ${MODE_ENV}=${JSON.stringify(v)} is not "${PLAINFLAGS}" (or unset) — refusing to start`;
}

/** True when local-config.json carries the mode key (it is ignored). */
function localConfigHasModeKey(loadLocalConfig = require("./local-config.js").loadLocalConfig, opts = {}) {
  try { return Object.prototype.hasOwnProperty.call(loadLocalConfig(opts) || {}, MODE_ENV); } catch { return false; }
}

const LOCAL_CONFIG_IGNORED =
  `[mcp-relay] local-config.json sets ${MODE_ENV} — IGNORED: the profile mode is read from the process environment only ` +
  `(the MCP entry's env); a local-config key would flip every lane's relay`;

// ── folders (§5.6 (4)) ──────────────────────────────────────────────────────

/** realpath of `p`, or — when `p` does not exist yet — of its nearest existing
 *  ancestor with the rest appended (so /var/… and /private/var/… compare equal). */
function real(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch { /* not there yet */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = up;
  }
}

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function samePathOrNested(a, b) {
  return a === b || isUnder(a, b) || isUnder(b, a);
}

function roots(cacheRoot) {
  return {
    plainflagsProfiles: path.join(cacheRoot, PROFILES_DIRNAME),
    plainflagsClones: path.join(cacheRoot, CLONES_DIRNAME),
    defaultProfiles: path.join(cacheRoot, DEFAULT_PROFILES_DIRNAME),
    defaultClones: path.join(cacheRoot, DEFAULT_CLONES_DIRNAME),
    registry: path.join(cacheRoot, REGISTRY_NAME),
  };
}

/**
 * Every registered project profile dir. { dirs } or { error } (the file exists
 * but cannot be read or parsed — the plain-flags mode then fails closed).
 */
function registryDirs(registryPath, _fs = fs) {
  let text;
  try { text = _fs.readFileSync(registryPath, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return { dirs: [] };
    return { error: `${registryPath}: ${e.message}` };
  }
  let reg;
  try { reg = JSON.parse(text); } catch (e) { return { error: `${registryPath} does not parse: ${e.message}` }; }
  if (!reg || typeof reg !== "object" || Array.isArray(reg)) return { error: `${registryPath} is not an object` };
  const dirs = [];
  for (const v of Object.values(reg)) if (v && typeof v.dir === "string" && v.dir) dirs.push(v.dir);
  return { dirs };
}

/**
 * Why `dir` must not be this mode's pool dir, or null.
 *   plain-flags: refused when it is (or nests with) a registered project profile,
 *     the standalone .browser-data dir, a configured cookieSourceProfile, or is
 *     under the default session-clones/ root, or anywhere outside the two
 *     plain-flags roots.
 *   default: refused when it is under either plain-flags root.
 */
function folderRefusal({ dir, mode, cacheRoot, registry = { dirs: [] }, standaloneDirs = [], cookieSourceProfile = null }) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) return `[mcp-relay] pool dir ${JSON.stringify(dir)} is not absolute`;
  const r = roots(cacheRoot);
  const d = real(dir);
  const pfProfiles = real(r.plainflagsProfiles);
  const pfClones = real(r.plainflagsClones);
  if (mode !== PLAINFLAGS) {
    if (samePathOrNested(d, pfProfiles) || samePathOrNested(d, pfClones)) {
      return `[mcp-relay] refusing: ${dir} is a plain-flags profile dir (under ${r.plainflagsProfiles} or ${r.plainflagsClones}); the default relay never drives one`;
    }
    return null;
  }
  const why = (what) => `[mcp-relay] plain-flags mode refuses to launch: the pool dir ${dir} ${what}. This mode drives only an unseeded dir under ${r.plainflagsProfiles} (or a temp clone under ${r.plainflagsClones}), picked by launch-project-isolated.js`;
  if (registry.error) return why(`cannot be checked against the project registry (${registry.error})`);
  for (const reg of registry.dirs) if (samePathOrNested(d, real(reg))) return why(`is a registered project profile (${reg})`);
  for (const s of standaloneDirs) if (s && samePathOrNested(d, real(s))) return why(`is the standalone profile (${s})`);
  if (cookieSourceProfile && samePathOrNested(d, real(cookieSourceProfile))) return why(`is the configured cookieSourceProfile`);
  if (samePathOrNested(d, real(r.defaultClones))) return why(`is under the default session-clones root`);
  if (!isUnder(d, pfProfiles) && !isUnder(d, pfClones)) return why(`is outside both plain-flags roots`);
  return null;
}

// ── launch refusals (§5.6 (13), review r8 #6) ───────────────────────────────

/** Keyed on the RESOLVED values the launch would use, never on one env var. */
function launchRefusal({ proxyUrl = null, allowInsecureTls = false, extensionPath = null } = {}) {
  const head = "[mcp-relay] plain-flags mode refuses to launch:";
  if (proxyUrl) return `${head} a proxy is configured (resolved proxy from BROWSER_RELAY_PROXY_URL, local-config.json or the wrapper's proxyUrl) — D28: no proxy in this profile`;
  if (allowInsecureTls) return `${head} insecure TLS is on (BROWSER_RELAY_INSECURE_TLS) — this profile always validates certificates`;
  if (extensionPath) return `${head} an extension path is set (BROWSER_LOAD_EXTENSIONS) — a password-manager extension could autofill a login here`;
  return null;
}

/**
 * The proxy, extension and TLS values a launch would use — one resolution for
 * the startup refusal and the launch itself. `relayEnv` is the process env
 * with local-config.json layered under it; `config` is pool-shared's CONFIG
 * (its proxyUrl already includes the wrapper's).
 */
function resolvedLaunchInputs({ relayEnv = {}, config = {}, processEnv = process.env } = {}) {
  const proxyUrl = relayEnv.BROWSER_RELAY_PROXY_URL || config.proxyUrl || null;
  const extensionPath = relayEnv.BROWSER_LOAD_EXTENSIONS || null;
  const flag = (v) => Boolean(v) && v !== "0" && v !== "false";
  const allowInsecureTls = Boolean(proxyUrl) || flag(processEnv.BROWSER_RELAY_INSECURE_TLS) || flag(relayEnv.BROWSER_RELAY_INSECURE_TLS);
  return { proxyUrl, extensionPath, allowInsecureTls };
}

// ── password saving off (§5.6 (4), review r7 #7, r8 #3) ─────────────────────

/**
 * Before EVERY launch, in the dir this relay claimed (never a base another
 * relay holds): write the two password-manager prefs into Default/Preferences,
 * and delete Default/Login Data* — a Preferences write is not proof (the relay
 * measured Brave ignoring one, cdp-bridge.js clearSessionRestore), the delete is.
 * Call with no Brave on `userDataDir`.
 */
function preparePlainflagsProfile(userDataDir, _fs = fs) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    throw new Error(`[mcp-relay] plain-flags profile prep: refusing non-absolute dir ${JSON.stringify(userDataDir)}`);
  }
  const def = path.join(userDataDir, "Default");
  _fs.mkdirSync(def, { recursive: true });
  const prefsPath = path.join(def, "Preferences");
  let prefs = {};
  try {
    const parsed = JSON.parse(_fs.readFileSync(prefsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prefs = parsed;
  } catch { /* missing or unreadable: start from {} — Brave fills in the rest */ }
  prefs.credentials_enable_service = false;
  if (!prefs.profile || typeof prefs.profile !== "object" || Array.isArray(prefs.profile)) prefs.profile = {};
  prefs.profile.password_manager_enabled = false;
  const tmp = `${prefsPath}.${process.pid}.tmp`;
  _fs.writeFileSync(tmp, JSON.stringify(prefs), { mode: 0o600 });
  _fs.renameSync(tmp, prefsPath);
  const deleted = [];
  for (const name of _fs.readdirSync(def)) {
    if (!name.startsWith("Login Data")) continue;
    _fs.rmSync(path.join(def, name), { force: true, recursive: true });
    deleted.push(name);
  }
  return { prefsPath, deleted };
}

/** True for a SNAPSHOT_FILES entry this mode never copies into a clone. */
function isLoginDataPath(rel) {
  return path.basename(rel).startsWith("Login Data");
}

// ── tool surface (§5.6 (7)) — an allowlist, fail closed ─────────────────────

const TOOL_ALLOWLIST = Object.freeze([
  "relay_status", "challenge_detect", "challenge_click", "cf_cookies_clear",
  "tabs_list", "tabs_new", "tabs_select", "tabs_close",
  "navigation_go-to", "navigation_go-back-or-forward",
  "interaction_click", "interaction_fill", "interaction_hover", "interaction_press-key", "interaction_scroll", "interaction_select",
  "form_fill", "sync_wait-for-network-idle",
  // No a11y_* tool (review round 2 item 1): Playwright's ARIA snapshot sets an
  // input's VALUE as its text (`- textbox "Password": <typed value>`) for every
  // input but checkbox / radio / file — a typed password or code would come
  // back verbatim. Screenshots and content_get-as-text cover seeing the page.
  "content_get-as-text", "content_get-as-html", "content_take-screenshot",
  "o11y_get-http-requests", "o11y_get-console-messages", "capture_xhr",
  "storage_clear-local", "dialog_handle",
]);

// Why a tool is not here (the route text of each refusal).
const REFUSED_WHY = Object.freeze({
  execute: "arbitrary page/Playwright code reaches context.cookies()/addCookies(), request headers and password fields — it would undo every rule of this profile in one call",
  "scenario-": "scripted steps run like execute",
  debug_: "probe expressions run in the page",
  stub_: "a mocked response can set any cookie on any host",
  emulate_device: "it re-adds the emulation tells this profile exists to drop",
  navigation_reload: "rule zero: no reloads on a wall",
  cookies_import: "no cross-profile state (D24): it would undo the unseeded start and the sign-in allowlist",
  "storage_set-local": "no cross-profile state (D24)",
  cookies_export: "it moves an account's tokens or a clearance into the transcript",
  "storage_get-local": "it moves an account's tokens into the transcript",
  stealth_apply: "deleted (D3)",
  a11y_: "an ARIA / accessibility snapshot carries every input's typed value (a password or one-time code verbatim) — use content_take-screenshot or content_get-as-text",
});

function refusedWhy(name) {
  if (REFUSED_WHY[name]) return REFUSED_WHY[name];
  for (const [k, v] of Object.entries(REFUSED_WHY)) if ((k.endsWith("_") || k.endsWith("-")) && name.startsWith(k)) return v;
  return "this profile offers a fixed tool list (fail closed: a tool not on it is hidden and refused)";
}

// interaction_press-key: named keys only, no modifier combination (§5.6 (6)(d)).
const PRESS_KEYS = Object.freeze([
  "Enter", "Tab", "Escape", "Backspace", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
]);

// ── test seam (never honoured outside the isolated harness) ────────────────

const FIXTURE_ENV = "BROWSER_RELAY_TEST_PLAINFLAGS_FIXTURE";

/**
 * A fixture known-account list, sign-in file and claude-ask store for the
 * isolated tests: `{ "accounts": [...], "signinFile": "<path>", "asksDir": "<path>" }`. Honoured only when the test
 * launch hook is on AND its temp-HOME check passes (cdp-bridge
 * assertTestLaunchAllowed); otherwise setting it refuses the relay.
 */
function testFixture(env = process.env) {
  const p = env && env[FIXTURE_ENV];
  if (!p) return null;
  const { testLaunchRequested, assertTestLaunchAllowed } = require("./cdp-bridge.js");
  if (!testLaunchRequested(env)) throw new Error(`[mcp-relay] ${FIXTURE_ENV} is set without BROWSER_RELAY_TEST_LAUNCH — refusing to run`);
  assertTestLaunchAllowed();
  const fx = JSON.parse(fs.readFileSync(p, "utf8"));
  return {
    accounts: Array.isArray(fx.accounts) ? fx.accounts : null,
    signinFile: typeof fx.signinFile === "string" ? fx.signinFile : null,
    asksDir: typeof fx.asksDir === "string" ? fx.asksDir : null,
  };
}

/** Create the sign-in allowlist file EMPTY when it is missing (never overwrite). */
function ensureSigninFile(filePath, log = () => {}) {
  try {
    const fd = fs.openSync(filePath, "wx", 0o600);
    try { fs.writeSync(fd, JSON.stringify({ accounts: [] }, null, 2) + "\n"); } finally { fs.closeSync(fd); }
    log(`created the plain-flags sign-in list ${filePath} — EMPTY (every known account's login refused until Trevor names one)`);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") log(`could not create ${filePath}: ${e.message} — read as empty`);
    return false;
  }
}

const MODE_LINE =
  "[browser-mcp-relay] PLAIN-FLAGS profile — a separate, unseeded browser (webdriver cleared); no saved logins; " +
  "a fixed tool list; known accounts' logins refused unless on plainflags-signin.json. Call relay_status for details.";

module.exports = {
  MODE_ENV, PLAINFLAGS, DEFAULT, PROFILES_DIRNAME, CLONES_DIRNAME, REGISTRY_NAME,
  PLAINFLAGS_ARGS, PLAINFLAGS_IGNORE_DEFAULT_ARGS, PROXY_ENV_RE,
  profileMode, modeProblem, localConfigHasModeKey, LOCAL_CONFIG_IGNORED, REQUIRE_TYPED_ANSWER_ENV, requireTypedAnswer,
  roots, registryDirs, folderRefusal, launchRefusal, resolvedLaunchInputs, preparePlainflagsProfile, isLoginDataPath,
  TOOL_ALLOWLIST, refusedWhy, PRESS_KEYS,
  FIXTURE_ENV, testFixture, ensureSigninFile, MODE_LINE,
  _isUnder: isUnder,
};
