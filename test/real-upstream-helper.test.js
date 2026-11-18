// test/helpers/real-upstream.js — the UNPATCHED copy must be unpatched even when
// the installed bundle already carries R1 (in the isolated harness an earlier
// relay start patches the archive's bundle on disk). 2026-11-17: the helper's
// check matched the helper's own "__relayPin: …" error texts, threw after
// Chromium started, and the harness hung.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const repin = require("../scripts/patch-bdmcp-repin.js");
const { patchedCopy } = require("./helpers/real-upstream.js");

const ENTRY = `,${repin.SANDBOX_NAME}:(targetId)=>${repin.HELPER_NAME}(this,targetId)`;

test("real-upstream helper: from a source bundle that already carries R1, the unpatched copy has no __relayPin in execute's sandbox and still parses; the patched copy keeps it", () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "r1-src-"));
  try {
    const realPkg = fs.realpathSync(path.dirname(require.resolve("browser-devtools-mcp/package.json")));
    const pkg = path.join(src, "node_modules", "browser-devtools-mcp");
    fs.cpSync(realPkg, pkg, { recursive: true });
    const r = repin.applyPatch({ distDir: path.join(pkg, "dist"), log: () => {} });
    assert.strictEqual(r.patched, true);
    assert.ok(fs.readFileSync(r.file, "utf8").includes(ENTRY), "the source carries R1");

    const un = patchedCopy({ patched: false, pkgDir: pkg });
    const unFile = repin.findSessionFile({ distDir: path.dirname(un.entry) });
    const unText = fs.readFileSync(unFile, "utf8");
    assert.ok(!unText.includes(ENTRY), "no __relayPin in the sandbox");
    assert.ok(unText.includes("executionContext(){return{page:this.page}}"));
    const check = path.join(src, "check.mjs");
    fs.writeFileSync(check, unText);
    assert.strictEqual(spawnSync(process.execPath, ["--check", check]).status, 0, "the unpatched copy parses");

    const pa = patchedCopy({ patched: true, pkgDir: pkg });
    assert.ok(fs.readFileSync(repin.findSessionFile({ distDir: path.dirname(pa.entry) }), "utf8").includes(ENTRY));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
  }
});
