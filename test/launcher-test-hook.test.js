// launcher-test-hook.test.js — the wrapper refuses the test hook BEFORE it
// writes the registry or creates a profile dir (Phase 1 review finding 5).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isolated, SKIP_MSG, REPO } = require("./helpers/isolation.js");

const ISO = { skip: !isolated() ? SKIP_MSG : (process.platform !== "darwin" ? "darwin" : false), timeout: 30000 };

test("launcher: BROWSER_RELAY_TEST_LAUNCH with a HOME outside the temp dir is refused before anything is written", ISO, () => {
  // /private/tmp is not under os.tmpdir() (/var/folders/…) on macOS, so this is a
  // "non-temp HOME" the test hook must refuse, yet still a throwaway dir.
  const home = fs.mkdtempSync("/private/tmp/relay-nontemp-home-");
  try {
    assert.ok(!fs.realpathSync(home).startsWith(fs.realpathSync(os.tmpdir()) + path.sep), "precondition: HOME is outside os.tmpdir()");
    const proj = path.join(home, "Documents", "proj");
    fs.mkdirSync(proj, { recursive: true });
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("BROWSER_") && !k.startsWith("CLAUDE_CODE_MESSAGING_")) env[k] = v;
    Object.assign(env, { HOME: home, CLAUDE_PROJECT_DIR: proj, BROWSER_RELAY_TEST_LAUNCH: "1" });
    const r = spawnSync(process.execPath, [path.join(REPO, "launch-project-isolated.js")], { env, input: "", encoding: "utf8", timeout: 20000 });
    assert.notStrictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /refusing to run/);
    const cache = path.join(home, "Library", "Caches", "browser-mcp-relay");
    assert.ok(!fs.existsSync(path.join(cache, "project-registry.json")), "no registry written");
    assert.ok(!fs.existsSync(path.join(cache, "profiles")), "no profile dir created");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
