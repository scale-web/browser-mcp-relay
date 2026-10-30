// patch-bdmcp-bundle.test.js — F1-20 (2026-05-10).
//
// Unit tests for the upstream BDMCP enum patcher. Tests pure helpers
// (shouldPatch / patchSource / buildAdditions / findBundledCoreFile)
// + the applyPatch action via a tmpdir-backed seam.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const patcher = require("../scripts/patch-bdmcp-bundle.js");

test("F1-20: MISSING_RESOURCE_TYPES covers the canonical Playwright values absent from upstream", () => {
  const expected = ["ping", "prefetch", "signedexchange", "cspviolationreport", "preflight", "fedcm"];
  for (const t of expected) {
    assert.ok(patcher.MISSING_RESOURCE_TYPES.includes(t),
      `MISSING_RESOURCE_TYPES must include "${t}"`);
  }
});

test("F1-20: shouldPatch matches upstream's bundled core-*.js path on POSIX + Windows", () => {
  assert.ok(patcher.shouldPatch(
    "/home/x/proj/node_modules/browser-devtools-mcp/dist/core-SUMP4OYR.js"));
  assert.ok(patcher.shouldPatch(
    "C:\\Users\\u\\proj\\node_modules\\browser-devtools-mcp\\dist\\core-SUMP4OYR.js"));
  assert.ok(patcher.shouldPatch(
    "C:/Users/u/proj/node_modules/browser-devtools-mcp/dist/core-XYZ123.js"));
});

test("F1-20: shouldPatch does NOT match unrelated files", () => {
  assert.strictEqual(patcher.shouldPatch(
    "/home/x/node_modules/browser-devtools-mcp/dist/index.js"), false,
    "index.js is not the bundled core file");
  assert.strictEqual(patcher.shouldPatch(
    "/home/x/node_modules/browser-devtools-mcp/dist/cli/main.js"), false,
    "cli/* is a different bundle");
  assert.strictEqual(patcher.shouldPatch(
    "/home/x/node_modules/some-other-pkg/dist/core-XXX.js"), false);
  assert.strictEqual(patcher.shouldPatch(undefined), false);
  assert.strictEqual(patcher.shouldPatch(null), false);
  assert.strictEqual(patcher.shouldPatch(""), false);
});

test("F1-20: patchSource adds all 6 missing resource types", () => {
  const fixture =
    `(function(HttpResourceType2){HttpResourceType2.DOCUMENT="document",` +
    `HttpResourceType2.OTHER="other"})(HttpResourceType||{})`;
  const out = patcher.patchSource(fixture);
  assert.ok(out, "patchSource must return a patched string");
  for (const t of patcher.MISSING_RESOURCE_TYPES) {
    const upper = t.toUpperCase();
    assert.ok(
      new RegExp(`HttpResourceType2\\.${upper}\\s*=\\s*"${t}"`).test(out),
      `must include HttpResourceType2.${upper}="${t}"`);
  }
  assert.ok(/HttpResourceType2\.OTHER\s*=\s*"other"/.test(out),
    "OTHER entry must remain");
  assert.ok(/\(HttpResourceType\|\|\{\}\)/.test(out),
    "IIFE close must remain");
});

test("F1-20: patchSource is idempotent (returns null on already-patched content)", () => {
  const alreadyPatched =
    `HttpResourceType2.OTHER="other",HttpResourceType2.PING="ping",HttpResourceType2.PREFETCH="prefetch"`;
  assert.strictEqual(patcher.patchSource(alreadyPatched), null,
    "already-patched content must return null");
});

test("F1-20: patchSource returns null when match is missing (safe no-op)", () => {
  assert.strictEqual(patcher.patchSource(`var x = 1;`), null);
  assert.strictEqual(patcher.patchSource(``), null);
  assert.strictEqual(patcher.patchSource(null), null);
  assert.strictEqual(patcher.patchSource(undefined), null);
});

test("F1-20: buildAdditions produces correct comma-prefixed enum entries", () => {
  const out = patcher.buildAdditions("HttpResourceType2");
  assert.ok(out.startsWith(","), "must start with comma");
  assert.ok(!out.endsWith(","), "must NOT end with trailing comma");
  for (const t of patcher.MISSING_RESOURCE_TYPES) {
    assert.ok(out.includes(`HttpResourceType2.${t.toUpperCase()}="${t}"`));
  }
});

test("F1-20: findBundledCoreFile locates the real upstream bundle", () => {
  const file = patcher.findBundledCoreFile();
  if (!file) return; // upstream not installed in this env — skip
  assert.ok(/core-[A-Za-z0-9]+\.js$/.test(file),
    "must be a core-*.js file");
  const content = fs.readFileSync(file, "utf8");
  assert.ok(content.includes("HttpResourceType"),
    "located file must contain HttpResourceType");
});

test("F1-20: applyPatch on a fixture distDir applies + becomes idempotent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f1-20-"));
  try {
    // Create a fake `dist/` with one core file mimicking upstream's shape.
    const distDir = path.join(tmp, "dist");
    fs.mkdirSync(distDir);
    const coreFile = path.join(distDir, "core-FAKEBUNDLE.js");
    const fixture =
      `var HttpResourceType=(function(HttpResourceType2){` +
      `HttpResourceType2.DOCUMENT="document",` +
      `HttpResourceType2.OTHER="other"` +
      `})(HttpResourceType||{});`;
    fs.writeFileSync(coreFile, fixture);

    const logs = [];
    const log = (msg) => logs.push(msg);

    // First call: applies.
    const r1 = patcher.applyPatch({ distDir, log });
    assert.strictEqual(r1.patched, true, "first call must report patched=true");
    assert.strictEqual(r1.action, "applied", "first call action=applied");
    assert.strictEqual(r1.file, coreFile);
    assert.ok(logs.length === 1, "applied path must log once");

    // File on disk must now contain all 6 new entries.
    const after1 = fs.readFileSync(coreFile, "utf8");
    for (const t of patcher.MISSING_RESOURCE_TYPES) {
      assert.ok(after1.includes(`"${t}"`),
        `after first patch, file must contain "${t}"`);
    }

    // Second call: idempotent — already-patched signal.
    logs.length = 0;
    const r2 = patcher.applyPatch({ distDir, log });
    assert.strictEqual(r2.patched, true);
    assert.strictEqual(r2.action, "already",
      "second call must report action=already");
    assert.strictEqual(logs.length, 0, "already-patched path must NOT re-log");

    // File content unchanged after the second call.
    const after2 = fs.readFileSync(coreFile, "utf8");
    assert.strictEqual(after1, after2, "file must be byte-identical");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F1-20: applyPatch writes atomically — no temp file is left in dist/", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f1-20-"));
  try {
    const distDir = path.join(tmp, "dist");
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, "core-FAKEBUNDLE.js"),
      `var HttpResourceType=(function(HttpResourceType2){HttpResourceType2.OTHER="other"})(HttpResourceType||{});`);
    const renames = [];
    const realRename = fs.renameSync;
    fs.renameSync = (a, b) => { renames.push([path.basename(a), path.basename(b)]); return realRename(a, b); };
    let r;
    try { r = patcher.applyPatch({ distDir, log: () => {} }); } finally { fs.renameSync = realRename; }
    assert.strictEqual(r.action, "applied");
    assert.strictEqual(renames.length, 1, "the patched file must be renamed into place, not written in place");
    assert.strictEqual(renames[0][1], "core-FAKEBUNDLE.js");
    assert.deepStrictEqual(fs.readdirSync(distDir), ["core-FAKEBUNDLE.js"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F1-20: applyPatch on missing distDir returns soft failure (no throw)", () => {
  const r = patcher.applyPatch({ distDir: "/__definitely__not__existing__/dist" });
  assert.strictEqual(r.patched, false);
  assert.ok(/no upstream bundled core/.test(r.reason));
});

test("F1-20: applyPatch on a fixture with mutated bundler shape no-ops safely", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f1-20-shape-"));
  try {
    const distDir = path.join(tmp, "dist");
    fs.mkdirSync(distDir);
    const coreFile = path.join(distDir, "core-WEIRDSHAPE.js");
    // Mutated: 4-digit suffix won't match HttpResourceType[\d]?
    const fixture = `HttpResourceType9999.OTHER="other";var HttpResourceType=1;`;
    fs.writeFileSync(coreFile, fixture);

    const r = patcher.applyPatch({ distDir });
    assert.strictEqual(r.patched, false);
    assert.ok(/regex match failed/.test(r.reason),
      "shape change must produce regex-failure reason, not corrupt file");
    // File must be unchanged.
    assert.strictEqual(fs.readFileSync(coreFile, "utf8"), fixture);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F1-20: applyPatch on real upstream bundle produces a working patched file", () => {
  // Live integration: find the real bundle, apply, verify the file now
  // contains all 6 entries. Idempotent — re-running this test harmlessly
  // confirms the already-applied path.
  const file = patcher.findBundledCoreFile();
  if (!file) return; // not installed
  const r = patcher.applyPatch({ log: () => {} });
  assert.strictEqual(r.patched, true);
  assert.ok(r.action === "applied" || r.action === "already");
  const content = fs.readFileSync(file, "utf8");
  for (const t of patcher.MISSING_RESOURCE_TYPES) {
    assert.ok(content.includes(`"${t}"`),
      `live bundle must contain "${t}" after applyPatch`);
  }
});
