// plainflags-mode.test.js — spec v8 §5.6 (phase 1c): the mode switch, the flag
// set, the launch refusals, the folder refusals, password saving off and the
// clone seeding — and, first, that the DEFAULT relay is unchanged.
// No browser is launched: Playwright's chromium is stubbed where launchBrave runs.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");

delete process.env.BROWSER_RELAY_PROFILE_MODE; // this file decides the mode per test
const pf = require("../src/plainflags-mode.js");
const pool = require("../src/pool-shared.js");
const bridge = require("../src/cdp-bridge.js");
const { applyLocalConfigToEnv, loadLocalConfig } = require("../src/local-config.js");

const REPO = path.resolve(__dirname, "..");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ── the default relay is unchanged ──────────────────────────────────────────

/** The file at `main` (the branch this build forks from). null without git. */
function atMain(rel) {
  for (const ref of ["main", "6485db5"]) {
    const r = spawnSync("git", ["show", `${ref}:${rel}`], { cwd: REPO, encoding: "utf8" });
    if (r.status === 0) return r.stdout;
  }
  return null;
}

/**
 * Load a cdp-bridge.js SOURCE with playwright-core's chromium stubbed: its
 * launchPersistentContext records the options and throws, so no Brave starts.
 */
function loadBridgeWithStub(source, filename) {
  const captured = [];
  const stub = { chromium: { launchPersistentContext: async (dir, opts) => { captured.push(opts); throw new Error("STUB-NO-LAUNCH"); } } };
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.join(REPO, "src"));
  const realRequire = m.require.bind(m);
  m.require = (id) => {
    if (id === "playwright-core") return stub;
    if (id.startsWith("./")) return require(path.join(REPO, "src", id));
    return realRequire(id);
  };
  m._compile(source, filename);
  return { mod: m.exports, captured };
}

const LAUNCH_CASES = [
  { headless: false },
  { headless: true },
  { headless: false, extensionPath: "/tmp/fake-ext" },
  { headless: true, proxyUrl: "http://127.0.0.1:9" },
];

test("default mode: launchBrave's options are IDENTICAL to main's (args, ignoreDefaultArgs, TLS, headless) — differential, chromium stubbed", async (t) => {
  const mainSrc = atMain("src/cdp-bridge.js");
  if (!mainSrc) return t.skip("no git / no main ref");
  const curSrc = fs.readFileSync(path.join(REPO, "src", "cdp-bridge.js"), "utf8");
  const main = loadBridgeWithStub(mainSrc, path.join(REPO, "src", "cdp-bridge.main.js"));
  const cur = loadBridgeWithStub(curSrc, path.join(REPO, "src", "cdp-bridge.cur.js"));
  delete process.env.BROWSER_RELAY_TEST_LAUNCH;
  delete process.env.BROWSER_RELAY_INSECURE_TLS;
  for (const c of LAUNCH_CASES) {
    const dirA = tmp("pf-diff-a-");
    const dirB = tmp("pf-diff-b-");
    await assert.rejects(main.mod.launchBrave({ userDataDir: dirA, ...c }), /STUB-NO-LAUNCH/);
    await assert.rejects(cur.mod.launchBrave({ userDataDir: dirB, ...c }), /STUB-NO-LAUNCH/); // no profileMode = default
    const a = main.captured.pop();
    const b = cur.captured.pop();
    for (const k of ["args", "ignoreDefaultArgs", "ignoreHTTPSErrors", "headless", "handleSIGINT", "handleSIGTERM"]) {
      assert.deepStrictEqual(b[k], a[k], `${JSON.stringify(c)} ${k}`);
    }
    assert.ok(!fs.existsSync(path.join(dirB, "Default", "Preferences")), "the default mode writes no Preferences");
  }
});

test("default mode: own tools/list is IDENTICAL to main's (challenge_click / cf_cookies_clear are not in it)", (t) => {
  const mainIdx = atMain("src/own-tools/index.js");
  if (!mainIdx) return t.skip("no git / no main ref");
  const requires = (src) => [...src.slice(src.indexOf("const tools = ["), src.indexOf("];", src.indexOf("const tools = ["))).matchAll(/require\("\.\/([^"]+)"\)/g)].map((m) => m[1]);
  const curIdx = fs.readFileSync(path.join(REPO, "src", "own-tools", "index.js"), "utf8");
  assert.deepStrictEqual(requires(curIdx), requires(mainIdx));
  const { tools, plainflagsTools } = require("../src/own-tools/index.js");
  const names = tools.map((x) => x.name);
  assert.ok(!names.includes("challenge_click") && !names.includes("cf_cookies_clear"));
  assert.deepStrictEqual(plainflagsTools.map((x) => x.name), ["challenge_click", "cf_cookies_clear"]);
});

test("default mode: buildLaunchArgs adds nothing; plain-flags appends exactly the D23 flag set, port 0 kept", () => {
  const d = bridge.buildLaunchArgs({ headless: false, platform: "darwin" });
  assert.deepStrictEqual(d.args, ["--remote-debugging-port=0", "--no-startup-window"]);
  assert.deepStrictEqual(d.ignoreDefaultArgs, ["--use-mock-keychain", "about:blank"]);
  const p = bridge.buildLaunchArgs({ headless: false, platform: "darwin", mode: "plainflags" });
  assert.deepStrictEqual(p.args, ["--remote-debugging-port=0", "--no-startup-window", "--disable-blink-features=AutomationControlled", "--no-proxy-server"]);
  assert.deepStrictEqual(p.ignoreDefaultArgs, ["--use-mock-keychain", "about:blank", "--enable-automation"]);
  const t1 = bridge.buildLaunchArgs({ headless: true, testLaunch: true, mode: "plainflags" });
  assert.deepStrictEqual(t1.ignoreDefaultArgs, ["--enable-automation"], "the test hook keeps the mock keychain; the flag still goes");
  assert.ok(t1.args.includes("--remote-debugging-port=0"));
});

test("plain-flags launchBrave: flags reach Playwright, Preferences written, Login Data* deleted BEFORE the launch (chromium stubbed)", async () => {
  const cur = loadBridgeWithStub(fs.readFileSync(path.join(REPO, "src", "cdp-bridge.js"), "utf8"), path.join(REPO, "src", "cdp-bridge.cur2.js"));
  const dir = tmp("pf-launch-");
  fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
  for (const f of ["Login Data", "Login Data-journal", "Login Data For Account", "Cookies"]) fs.writeFileSync(path.join(dir, "Default", f), "x");
  await assert.rejects(cur.mod.launchBrave({ userDataDir: dir, headless: true, profileMode: "plainflags" }), /STUB-NO-LAUNCH/);
  const o = cur.captured.pop();
  assert.ok(o.ignoreDefaultArgs.includes("--enable-automation"));
  assert.ok(o.args.includes("--disable-blink-features=AutomationControlled"));
  assert.ok(o.args.includes("--remote-debugging-port=0"));
  assert.strictEqual(o.ignoreHTTPSErrors, false);
  const prefs = JSON.parse(fs.readFileSync(path.join(dir, "Default", "Preferences"), "utf8"));
  assert.strictEqual(prefs.credentials_enable_service, false);
  assert.strictEqual(prefs.profile.password_manager_enabled, false);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, "Default")).filter((n) => n.startsWith("Login Data")), []);
  assert.ok(fs.existsSync(path.join(dir, "Default", "Cookies")), "only Login Data* goes");
});

// ── mode: process env only (§5.6 (13), review r7 #10) ───────────────────────

test("mode: read from the process env only — a local-config.json key does NOT flip it (it would reach every lane's env)", () => {
  const dir = tmp("pf-lc-");
  const lc = path.join(dir, "local-config.json");
  fs.writeFileSync(lc, JSON.stringify({ BROWSER_RELAY_PROFILE_MODE: "plainflags" }));
  // The trap, demonstrated: the layered env DOES carry the key.
  const merged = applyLocalConfigToEnv({}, { path: lc, refresh: true });
  assert.strictEqual(merged.BROWSER_RELAY_PROFILE_MODE, "plainflags");
  // … and nothing that decides the mode reads it.
  assert.strictEqual(pf.profileMode(process.env), "default");
  const cfg = pool.loadConfig({ env: {}, _localConfigPath: lc, _wrapperConfig: null });
  assert.strictEqual(cfg.profileMode, "default");
  assert.ok(pool.sessionClonesRoot(merged).endsWith(`${path.sep}session-clones`), "the clone root stays the default one");
  assert.strictEqual(pf.localConfigHasModeKey(loadLocalConfig, { path: lc, refresh: true }), true, "the key is seen, to be logged");
  assert.match(pf.LOCAL_CONFIG_IGNORED, /IGNORED/);
});

test("mode: exact 'plainflags' only; a typo refuses to start", () => {
  assert.strictEqual(pf.profileMode({ BROWSER_RELAY_PROFILE_MODE: "plainflags" }), "plainflags");
  assert.strictEqual(pf.profileMode({ BROWSER_RELAY_PROFILE_MODE: "plain-flags" }), "default");
  assert.match(pf.modeProblem({ BROWSER_RELAY_PROFILE_MODE: "plain-flags" }), /refusing to start/);
  assert.strictEqual(pf.modeProblem({}), null);
  assert.strictEqual(pf.modeProblem({ BROWSER_RELAY_PROFILE_MODE: "default" }), null);
});

test("launcher: a bad mode value exits before anything is written", () => {
  const home = tmp("pf-home-bad-");
  const r = spawnSync(process.execPath, [path.join(REPO, "launch-project-isolated.js")], {
    env: { PATH: process.env.PATH, HOME: home, BROWSER_RELAY_PROFILE_MODE: "plainflag", CLAUDE_PROJECT_DIR: path.join(home, "p") },
    encoding: "utf8", timeout: 20000,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /refusing to start/);
  assert.ok(!fs.existsSync(path.join(home, "Library")), "nothing created under HOME");
});

// ── launch refusals: the RESOLVED values (§5.6 (13), r8 #6) ─────────────────

test("launch refusal: a proxy from EACH source (env, local-config.json, wrapper proxyUrl), insecure TLS, an extension", () => {
  const dir = tmp("pf-proxy-");
  const lc = path.join(dir, "local-config.json");
  const resolve = ({ env = {}, localConfig = null, wrapper = null, processEnv = {} }) => {
    if (localConfig) fs.writeFileSync(lc, JSON.stringify(localConfig)); else fs.writeFileSync(lc, "{}");
    const config = pool.loadConfig({ env, _localConfigPath: lc, _wrapperConfig: wrapper, mode: "plainflags" });
    const relayEnv = applyLocalConfigToEnv(env, { path: lc, refresh: true });
    return pf.launchRefusal(pf.resolvedLaunchInputs({ relayEnv, config, processEnv }));
  };
  assert.strictEqual(resolve({}), null, "no proxy, no TLS override, no extension → allowed");
  assert.match(resolve({ env: { BROWSER_RELAY_PROXY_URL: "http://127.0.0.1:8080" } }), /proxy/);
  assert.match(resolve({ localConfig: { BROWSER_RELAY_PROXY_URL: "http://127.0.0.1:8080" } }), /proxy/);
  assert.match(resolve({ wrapper: { proxyUrl: "http://127.0.0.1:8080" } }), /proxy/);
  assert.match(resolve({ processEnv: { BROWSER_RELAY_INSECURE_TLS: "1" } }), /insecure TLS/);
  assert.match(resolve({ localConfig: { BROWSER_RELAY_INSECURE_TLS: "1" } }), /insecure TLS/);
  assert.match(resolve({ env: { BROWSER_LOAD_EXTENSIONS: "/x/ext" } }), /extension/);
  assert.match(resolve({ localConfig: { BROWSER_LOAD_EXTENSIONS: "/x/ext" } }), /extension/);
});

test("launch refusal inside launchBrave too: no Preferences written, no launch attempted", async () => {
  const cur = loadBridgeWithStub(fs.readFileSync(path.join(REPO, "src", "cdp-bridge.js"), "utf8"), path.join(REPO, "src", "cdp-bridge.cur3.js"));
  for (const extra of [{ proxyUrl: "http://127.0.0.1:9" }, { extensionPath: "/x/ext" }]) {
    const dir = tmp("pf-refuse-");
    await assert.rejects(cur.mod.launchBrave({ userDataDir: dir, headless: true, profileMode: "plainflags", ...extra }), /plain-flags mode refuses to launch/);
    assert.strictEqual(cur.captured.length, 0, "Playwright never called");
    assert.ok(!fs.existsSync(path.join(dir, "Default")));
  }
  process.env.BROWSER_RELAY_INSECURE_TLS = "1";
  try {
    await assert.rejects(cur.mod.launchBrave({ userDataDir: tmp("pf-refuse-"), headless: true, profileMode: "plainflags" }), /insecure TLS/);
  } finally { delete process.env.BROWSER_RELAY_INSECURE_TLS; }
  assert.strictEqual(cur.captured.length, 0);
});

// ── folders (§5.6 (4), review r7 #9) ────────────────────────────────────────

test("folder refusal: plain-flags drives only its own roots; default never drives them", () => {
  const cacheRoot = tmp("pf-cache-");
  const R = pf.roots(cacheRoot);
  const registered = path.join(R.defaultProfiles, "as-ops");
  const cookieSrc = path.join(cacheRoot, "cookie-source");
  const standalone = path.join(cacheRoot, "browser-data");
  for (const d of [R.plainflagsProfiles, R.plainflagsClones, R.defaultClones, registered, cookieSrc, standalone]) fs.mkdirSync(d, { recursive: true });
  const base = { mode: "plainflags", cacheRoot, registry: { dirs: [registered] }, standaloneDirs: [standalone], cookieSourceProfile: cookieSrc };
  const refuse = (dir, extra = {}) => pf.folderRefusal({ ...base, dir, ...extra });
  assert.strictEqual(refuse(path.join(R.plainflagsProfiles, "as-ops")), null);
  assert.strictEqual(refuse(path.join(R.plainflagsClones, "as-ops-p1-abc")), null);
  assert.match(refuse(registered), /registered project profile/);
  assert.match(refuse(cookieSrc), /cookieSourceProfile/);
  assert.match(refuse(standalone), /standalone/);
  assert.match(refuse(path.join(R.defaultClones, "as-ops-p1-abc")), /default session-clones/);
  assert.match(refuse(path.join(cacheRoot, "elsewhere")), /outside both plain-flags roots/);
  assert.match(refuse(R.plainflagsProfiles), /outside/, "the root itself is not a profile");
  assert.match(refuse(path.join(R.plainflagsProfiles, "x"), { registry: { error: "bad json" } }), /registry/, "an unreadable registry fails closed");
  // a registry entry pointing INTO the plain-flags root is still refused
  assert.match(refuse(path.join(R.plainflagsProfiles, "y"), { registry: { dirs: [path.join(R.plainflagsProfiles, "y")] } }), /registered/);
  // default mode
  const dflt = (dir) => pf.folderRefusal({ dir, mode: "default", cacheRoot });
  assert.strictEqual(dflt(registered), null);
  assert.strictEqual(dflt(path.join(R.defaultClones, "as-ops-p1-abc")), null);
  assert.match(dflt(path.join(R.plainflagsProfiles, "as-ops")), /plain-flags profile dir/);
  assert.match(dflt(path.join(R.plainflagsClones, "as-ops-p1-abc")), /plain-flags profile dir/);
});

test("registryDirs: every entry's dir; missing → none; unparseable → error", () => {
  const d = tmp("pf-reg-");
  const p = path.join(d, "project-registry.json");
  assert.deepStrictEqual(pf.registryDirs(p), { dirs: [] });
  fs.writeFileSync(p, JSON.stringify({ "/a": { dir: "/x/profiles/a" }, "/b": { slot: 2 } }));
  assert.deepStrictEqual(pf.registryDirs(p), { dirs: ["/x/profiles/a"] });
  fs.writeFileSync(p, "{");
  assert.ok(pf.registryDirs(p).error);
});

test("clone root: plain-flags clones under session-clones-plainflags/, default under session-clones/ (r7 #9)", () => {
  const env = { ...process.env };
  assert.ok(pool.sessionClonesRoot(env, "default").endsWith(`${path.sep}session-clones`));
  assert.ok(pool.sessionClonesRoot(env, "plainflags").endsWith(`${path.sep}session-clones-plainflags`));
  assert.ok(pool.plainflagsProfilesRoot(env).endsWith(`${path.sep}profiles-plainflags`));
  const root = tmp("pf-clones-");
  const c = pool.createSessionCloneDir("/x/profiles-plainflags/as-ops", { root });
  assert.match(path.basename(c), /^as-ops-p\d+-[a-z0-9]+$/);
});

test("plain-flags config: cookieSourceProfile forced to null (kept aside as configuredCookieSourceProfile); default keeps it", () => {
  const wrapper = { cookieSourceProfile: "/x/logged-in", poolDirs: ["/x/a"] };
  const p = pool.loadConfig({ env: { BROWSER_RELAY_POOL_DIR: "/x/pf" }, _wrapperConfig: wrapper, mode: "plainflags" });
  assert.strictEqual(p.cookieSourceProfile, null);
  assert.strictEqual(p.configuredCookieSourceProfile, "/x/logged-in");
  const d = pool.loadConfig({ env: { BROWSER_RELAY_POOL_DIR: "/x/pf" }, _wrapperConfig: wrapper, mode: "default" });
  assert.strictEqual(d.cookieSourceProfile, "/x/logged-in", "old consumer: default seeding unchanged");
});

// ── password saving off + Login Data (§5.6 (4), r7 #7, r8 #3) ───────────────

test("preparePlainflagsProfile: both prefs written, other prefs kept; every Login Data* file deleted, nothing else", () => {
  const dir = tmp("pf-prep-");
  const def = path.join(dir, "Default");
  fs.mkdirSync(def, { recursive: true });
  fs.writeFileSync(path.join(def, "Preferences"), JSON.stringify({ keep: 1, profile: { name: "x", password_manager_enabled: true }, credentials_enable_service: true }));
  for (const f of ["Login Data", "Login Data-wal", "Login Data-shm", "Login Data-journal", "Login Data For Account", "Login Data For Account-journal", "Cookies", "Web Data"]) fs.writeFileSync(path.join(def, f), "x");
  const r = pf.preparePlainflagsProfile(dir);
  assert.strictEqual(r.deleted.length, 6);
  const prefs = JSON.parse(fs.readFileSync(path.join(def, "Preferences"), "utf8"));
  assert.deepStrictEqual([prefs.keep, prefs.profile.name, prefs.profile.password_manager_enabled, prefs.credentials_enable_service], [1, "x", false, false]);
  assert.deepStrictEqual(fs.readdirSync(def).sort(), ["Cookies", "Preferences", "Web Data"]);
  // malformed Preferences: rewritten with the two prefs
  fs.writeFileSync(path.join(def, "Preferences"), "{not json");
  pf.preparePlainflagsProfile(dir);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(def, "Preferences"), "utf8")).credentials_enable_service, false);
  assert.throws(() => pf.preparePlainflagsProfile("relative/dir"), /non-absolute/);
});

test("clone seeding: plain-flags never copies Login Data* (r8 #3); the default copy is unchanged (old consumer)", () => {
  const src = tmp("pf-src-");
  fs.mkdirSync(path.join(src, "Default", "Network"), { recursive: true });
  for (const f of ["Local State", "Default/Network/Cookies", "Default/Login Data", "Default/Login Data-journal", "Default/Login Data For Account"]) fs.writeFileSync(path.join(src, f), "x");
  const a = tmp("pf-dst-a-");
  pool.snapshotCookiesFrom(src, a, { excludeLoginData: true });
  assert.ok(fs.existsSync(path.join(a, "Default", "Network", "Cookies")));
  assert.ok(fs.existsSync(path.join(a, "Local State")));
  assert.deepStrictEqual(fs.readdirSync(path.join(a, "Default")).filter((n) => n.startsWith("Login Data")), []);
  const b = tmp("pf-dst-b-");
  assert.strictEqual(pool.snapshotCookiesFrom(src, b), 5);
  assert.ok(fs.existsSync(path.join(b, "Default", "Login Data")), "default seeding still copies Login Data");
});

// ── tool allowlist (§5.6 (7)) ───────────────────────────────────────────────

test("TOOL_ALLOWLIST is exactly the spec's list", () => {
  assert.deepStrictEqual([...pf.TOOL_ALLOWLIST].sort(), [
    "relay_status", "challenge_detect", "challenge_click", "cf_cookies_clear", "tabs_list", "tabs_new", "tabs_select", "tabs_close",
    "navigation_go-to", "navigation_go-back-or-forward", "interaction_click", "interaction_fill", "interaction_hover",
    "interaction_press-key", "interaction_scroll", "interaction_select", "form_fill", "sync_wait-for-network-idle",
    "content_get-as-text", "content_get-as-html", "content_take-screenshot",
    "o11y_get-http-requests", "o11y_get-console-messages", "capture_xhr", "storage_clear-local", "dialog_handle",
  ].sort());
});

test("ensureSigninFile: created EMPTY once, never overwritten", () => {
  const d = tmp("pf-signin-");
  const p = path.join(d, "plainflags-signin.json");
  assert.strictEqual(pf.ensureSigninFile(p), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(p, "utf8")), { accounts: [] });
  fs.writeFileSync(p, JSON.stringify({ accounts: [{ name: "canva", askId: "as-ops/ask-x" }] }));
  assert.strictEqual(pf.ensureSigninFile(p), false);
  assert.strictEqual(JSON.parse(fs.readFileSync(p, "utf8")).accounts.length, 1);
  assert.strictEqual((fs.statSync(path.join(d, "plainflags-signin.json")).mode & 0o777).toString(8), "600");
});

test("plainflags-signin.json is gitignored (it names Trevor's accounts)", () => {
  assert.match(fs.readFileSync(path.join(REPO, ".gitignore"), "utf8"), /^plainflags-signin\.json$/m);
});

test("test fixture seam: refused without the test launch hook", () => {
  assert.strictEqual(pf.testFixture({}), null);
  assert.throws(() => pf.testFixture({ BROWSER_RELAY_TEST_PLAINFLAGS_FIXTURE: "/x.json" }), /without BROWSER_RELAY_TEST_LAUNCH/);
  // with the hook but a real (non-temp) HOME → refused by the hook's own check
  if (!fs.realpathSync(os.homedir()).startsWith(fs.realpathSync(os.tmpdir()))) {
    assert.throws(() => pf.testFixture({ BROWSER_RELAY_TEST_PLAINFLAGS_FIXTURE: "/x.json", BROWSER_RELAY_TEST_LAUNCH: "1" }), /HOME/);
  }
});

test("round 1 item 8: plain-flags launch adds --no-proxy-server and strips HTTP_PROXY / HTTPS_PROXY / ALL_PROXY (any case) from Brave's env; default keeps them", async () => {
  const cur = loadBridgeWithStub(fs.readFileSync(path.join(REPO, "src", "cdp-bridge.js"), "utf8"), path.join(REPO, "src", "cdp-bridge.cur4.js"));
  const keys = { HTTP_PROXY: "http://a:1", https_proxy: "http://b:2", All_Proxy: "socks5://c:3", Http_Proxy: "http://d:4", NO_PROXY: "x" };
  Object.assign(process.env, keys);
  try {
    await assert.rejects(cur.mod.launchBrave({ userDataDir: tmp("pf-np-"), headless: true, profileMode: "plainflags" }), /STUB-NO-LAUNCH/);
    const p = cur.captured.pop();
    assert.ok(p.args.includes("--no-proxy-server"));
    for (const k of ["HTTP_PROXY", "https_proxy", "All_Proxy", "Http_Proxy"]) assert.ok(!(k in p.env), k);
    assert.strictEqual(p.env.NO_PROXY, "x", "only the proxy variables go");
    await assert.rejects(cur.mod.launchBrave({ userDataDir: tmp("pf-np-d-"), headless: true }), /STUB-NO-LAUNCH/);
    const d = cur.captured.pop();
    assert.ok(!d.args.includes("--no-proxy-server"), "default unchanged");
    assert.strictEqual(d.env.HTTP_PROXY, "http://a:1", "default unchanged");
  } finally { for (const k of Object.keys(keys)) delete process.env[k]; }
});
