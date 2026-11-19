// codesign-clone.test.js — Brave must launch with Chromium's MacAppCodeSignClone
// feature disabled (macOS). With it on, every launch copies the whole browser app
// under /private/var/folders/.../X/com.brave.Browser.code_sign_clone/, and a Brave
// that is killed rather than quit leaves that copy behind (65 copies, 37 GB, by
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
