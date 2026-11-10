// test-harness.test.js — a refused isolated run must not exit 0 (it did:
// the self-check refusal returned before `process.exitCode` was set, so
// `npm run test:isolated && …` read a refusal as green).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");

test("test-harness: a failed isolation self-check exits non-zero (2), and a passing one exits 0", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-refusal-"));
  try {
    // A copy of the harness and src/ in a parent dir with no pool wrapper;
    // node_modules is a symlink, read only.
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "scripts", "test-harness.js"), path.join(repo, "scripts", "test-harness.js"));
    fs.cpSync(path.join(REPO, "src"), path.join(repo, "src"), { recursive: true });
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(repo, "node_modules"));
    const run = () => spawnSync(process.execPath, [path.join(repo, "scripts", "test-harness.js"), "--self-check"], {
      cwd: repo, encoding: "utf8", timeout: 60000,
    });

    const ok = run();
    assert.strictEqual(ok.status, 0, `clean copy should pass the self-check:\n${ok.stderr}`);
    assert.match(ok.stderr, /self-check OK/);

    // A local-config.json in the checkout is one of the refusal conditions.
    fs.writeFileSync(path.join(repo, "local-config.json"), "{}");
    const refused = run();
    assert.match(refused.stderr, /REFUSING TO RUN/);
    assert.strictEqual(refused.status, 2, "a refusal must not read as a green run");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
