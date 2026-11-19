// codesign-clone.test.js — Brave must launch with Chromium's MacAppCodeSignClone
// feature disabled (macOS). With it on, Brave makes a copy of the whole app under
// /private/var/folders/.../X/com.brave.Browser.code_sign_clone/ at every launch,
// left behind on kill and, as measured, on a clean close too (65 copies, 37 GB, by
// 2026-11-19; issues.chromium.org/379125944).
//
// Chromium honours only the LAST --disable-features on its command line, and
// Playwright passes its own list by default. So the feature must be MERGED into
// the one list the browser sees: these tests build the effective command line the
// way Playwright 1.59's browserType.js does — Playwright's real defaultArgs(),
// minus ignoreDefaultArgs — and assert on that, not on buildLaunchArgs' halves.
// No browser is launched.

const test = require("node:test");
const assert = require("node:assert");

delete process.env.BROWSER_RELAY_PROFILE_MODE;
const bridge = require("../src/cdp-bridge.js");
const { createPlaywright } = require("playwright-core/lib/server");

const pwChromium = createPlaywright({ sdkLanguage: "javascript" }).chromium;
const UDD = "/nonexistent/codesign-clone-test-udd"; // defaultArgs only formats it

/** The argv Playwright hands the browser for launchPersistentContext(UDD, {headless, args, ignoreDefaultArgs}). */
async function effectiveArgs({ headless, args, ignoreDefaultArgs }) {
  const all = await pwChromium.defaultArgs({ headless, args }, true, UDD);
  return all.filter((a) => ignoreDefaultArgs.indexOf(a) === -1);
}

const features = (flag) => flag.slice("--disable-features=".length).split(",").filter(Boolean);

/** Playwright's own default --disable-features list (no relay options at all). */
async function playwrightDefaultDisabled() {
  const d = (await pwChromium.defaultArgs({ headless: false, args: [] }, true, UDD)).filter((a) => a.startsWith("--disable-features="));
  assert.strictEqual(d.length, 1, "Playwright's defaults carry one --disable-features");
  return features(d[0]);
}

const CASES = [];
for (const mode of ["default", "plainflags"]) {
  for (const headless of [false, true]) {
    CASES.push({ mode, headless });
    CASES.push({ mode, headless, testLaunch: true });
  }
  CASES.push({ mode, headless: false, extensionPath: "/tmp/fake-ext" });
}

test("macOS: exactly one --disable-features reaches Brave, holding MacAppCodeSignClone AND every feature Playwright disables by default (default + plain-flags modes)", async () => {
  const pwDefaults = await playwrightDefaultDisabled();
  assert.ok(pwDefaults.length > 5, `Playwright's default list looks wrong: ${pwDefaults}`);
  for (const c of CASES) {
    const { args, ignoreDefaultArgs } = bridge.buildLaunchArgs({ ...c, platform: "darwin" });
    const argv = await effectiveArgs({ headless: c.headless, args, ignoreDefaultArgs });
    const df = argv.filter((a) => a.startsWith("--disable-features"));
    assert.strictEqual(df.length, 1, `${JSON.stringify(c)}: ${df.length} --disable-features: ${df.join(" | ")}`);
    const got = features(df[0]);
    assert.ok(got.includes("MacAppCodeSignClone"), `${JSON.stringify(c)}: MacAppCodeSignClone missing from ${df[0]}`);
    for (const f of pwDefaults) assert.ok(got.includes(f), `${JSON.stringify(c)}: Playwright's ${f} dropped from ${df[0]}`);
    assert.strictEqual(new Set(got).size, got.length, `${JSON.stringify(c)}: duplicate feature in ${df[0]}`);
    if (c.mode === "plainflags") {
      assert.ok(!argv.includes("--enable-automation"), "plain-flags still drops --enable-automation");
      assert.ok(argv.includes("--disable-blink-features=AutomationControlled"));
    }
  }
});

test("not macOS: the launch arguments are unchanged (Playwright's own --disable-features, nothing added)", async () => {
  for (const platform of ["win32", "linux"]) {
    const { args, ignoreDefaultArgs } = bridge.buildLaunchArgs({ headless: false, platform });
    assert.ok(!args.some((a) => a.startsWith("--disable-features")), `${platform}: args ${args}`);
    assert.ok(!ignoreDefaultArgs.some((a) => a.startsWith("--disable-features")), `${platform}: ignoreDefaultArgs ${ignoreDefaultArgs}`);
  }
});

test("the relay reads Playwright's default --disable-features from the installed playwright-core (an upgrade that moves it fails here, not silently)", async () => {
  const pw = await pwChromium.defaultArgs({ headless: false, args: [] }, true, UDD);
  assert.strictEqual(bridge.PLAYWRIGHT_DISABLE_FEATURES, pw.find((a) => a.startsWith("--disable-features=")));
});

test("Playwright's default list unreadable: nothing is added, so Playwright's own list still reaches Brave", async () => {
  const { args, ignoreDefaultArgs } = bridge.buildLaunchArgs({ headless: false, platform: "darwin", playwrightDisableFeatures: null });
  const argv = await effectiveArgs({ headless: false, args, ignoreDefaultArgs });
  const df = argv.filter((a) => a.startsWith("--disable-features"));
  assert.strictEqual(df.length, 1);
  assert.deepStrictEqual(features(df[0]), await playwrightDefaultDisabled());
});

// ── the swap as one helper (the test harness's own direct launches use it too) ──

test("codesignCloneSwap: macOS → one merged entry for args + Playwright's own for ignoreDefaultArgs; elsewhere or unreadable → nothing", () => {
  const PWDF = bridge.PLAYWRIGHT_DISABLE_FEATURES;
  assert.deepStrictEqual(bridge.codesignCloneSwap({ platform: "darwin" }), { args: [`${PWDF},MacAppCodeSignClone`], ignoreDefaultArgs: [PWDF] });
  assert.deepStrictEqual(bridge.codesignCloneSwap({ platform: "linux" }), { args: [], ignoreDefaultArgs: [] });
  assert.deepStrictEqual(bridge.codesignCloneSwap({ platform: "darwin", playwrightDisableFeatures: null }), { args: [], ignoreDefaultArgs: [] });
  const already = "--disable-features=A,MacAppCodeSignClone";
  assert.deepStrictEqual(bridge.codesignCloneSwap({ platform: "darwin", playwrightDisableFeatures: already }).args, [already], "no duplicate");
  const b = bridge.buildLaunchArgs({ headless: true, platform: "darwin" });
  assert.ok(b.args.includes(`${PWDF},MacAppCodeSignClone`) && b.ignoreDefaultArgs.includes(PWDF), "buildLaunchArgs carries the same swap");
});

test("the four direct test launches spread codesignCloneSwap() (they would otherwise leave a copy on every harness kill)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  let n = 0;
  for (const f of ["isolated-brave.test.js", "isolated-relay-e2e.test.js"]) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    for (const m of src.matchAll(/chromium\.launchPersistentContext\(([\s\S]*?)\n  \}\);/g)) {
      n++;
      assert.match(m[1], /\.\.\.SWAP\.args/, `${f}: a direct launch without the swap in args`);
      assert.match(m[1], /ignoreDefaultArgs: SWAP\.ignoreDefaultArgs/, `${f}: a direct launch without the swap in ignoreDefaultArgs`);
    }
  }
  assert.strictEqual(n, 4, "four direct launches");
});

// ── the warning when Playwright's list cannot be read (stubbed launch) ────────

const fsx = require("node:fs");
const osx = require("node:os");
const pathx = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");
const REPO = pathx.resolve(__dirname, "..");

/** cdp-bridge.js SOURCE loaded with chromium stubbed (records options, never launches);
 *  `unreadable` makes Playwright's chromiumSwitches.js fail to load. */
function loadStubbed(source, filename, { unreadable }) {
  const captured = [];
  const stub = { chromium: { launchPersistentContext: async (dir, opts) => { captured.push(opts); throw new Error("STUB-NO-LAUNCH"); } } };
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(pathx.join(REPO, "src"));
  const realRequire = m.require.bind(m);
  m.require = (id) => {
    if (id === "playwright-core") return stub;
    if (unreadable && id.endsWith("chromiumSwitches.js")) throw new Error("TEST: moved by an upgrade");
    if (id.startsWith("./")) return require(pathx.join(REPO, "src", id));
    return realRequire(id);
  };
  m._compile(source, filename);
  return { mod: m.exports, captured };
}

async function launchCapturingStderr(mod, opts) {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };
  try {
    await assert.rejects(mod.launchBrave(opts), /STUB-NO-LAUNCH/);
  } finally {
    process.stderr.write = orig;
  }
  return lines.join("");
}

test("Playwright's list unreadable (stubbed launch): one warning line, and the launch options are IDENTICAL to main's", { skip: process.platform !== "darwin" ? "darwin" : false }, async (t) => {
  const r = spawnSync("git", ["show", "main:src/cdp-bridge.js"], { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) return t.skip("no git / no main ref");
  const curSrc = fsx.readFileSync(pathx.join(REPO, "src", "cdp-bridge.js"), "utf8");
  const cur = loadStubbed(curSrc, pathx.join(REPO, "src", "cdp-bridge.unreadable.js"), { unreadable: true });
  const main = loadStubbed(r.stdout, pathx.join(REPO, "src", "cdp-bridge.main3.js"), { unreadable: false });
  const ok = loadStubbed(curSrc, pathx.join(REPO, "src", "cdp-bridge.readable.js"), { unreadable: false });
  assert.strictEqual(cur.mod.PLAYWRIGHT_DISABLE_FEATURES, null, "precondition: the list is unreadable");
  delete process.env.BROWSER_RELAY_TEST_LAUNCH;
  delete process.env.BROWSER_RELAY_INSECURE_TLS;
  for (const headless of [true, false]) {
    const dirs = [0, 1, 2].map(() => fsx.mkdtempSync(pathx.join(osx.tmpdir(), "csclone-warn-")));
    const errCur = await launchCapturingStderr(cur.mod, { userDataDir: dirs[0], headless });
    await launchCapturingStderr(main.mod, { userDataDir: dirs[1], headless });
    const errOk = await launchCapturingStderr(ok.mod, { userDataDir: dirs[2], headless });
    const warn = /could not read Playwright's default --disable-features — MacAppCodeSignClone stays on/g;
    assert.strictEqual((errCur.match(warn) || []).length, 1, `headless=${headless}: one warning line, got: ${errCur}`);
    assert.strictEqual((errOk.match(warn) || []).length, 0, "no warning when the list is read");
    const a = main.captured.pop();
    const b = cur.captured.pop();
    for (const k of ["args", "ignoreDefaultArgs", "ignoreHTTPSErrors", "headless", "handleSIGINT", "handleSIGTERM"]) {
      assert.deepStrictEqual(b[k], a[k], `headless=${headless} ${k}`);
    }
    for (const d of dirs) fsx.rmSync(d, { recursive: true, force: true });
  }
});
