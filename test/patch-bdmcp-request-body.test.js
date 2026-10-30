// A76: upstream must never capture request bodies. Mirrors the F1-20 patcher
// tests, including the live-bundle check that makes an upstream upgrade which
// breaks the pattern fail `npm test`.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const patcher = require("../scripts/patch-bdmcp-request-body.js");

const SHAPE = 'async _toHttpRequest(req,seq){let res=await req.response();return{url:req.url(),method:req.method(),headers:req.headers(),body:req.postData()||void 0,resourceType:"x"}}';

test("A76: patchSource removes the request-body capture and marks the file", () => {
  const out = patcher.patchSource(SHAPE);
  assert.ok(out, "expected a patched source");
  assert.ok(!/postData\(\)/.test(out), "postData() must be gone");
  assert.ok(out.includes(`body:void 0${patcher.MARKER}`));
  assert.ok(out.includes("headers:req.headers()"), "other fields untouched");
});

test("A76: patchSource is idempotent and no-ops on a changed shape or on more than one match", () => {
  assert.strictEqual(patcher.patchSource(patcher.patchSource(SHAPE)), null);
  assert.strictEqual(patcher.patchSource("body:req.postBody()"), null);
  assert.strictEqual(patcher.patchSource(SHAPE + SHAPE), null);
});

test("A76: applyPatch on a fixture distDir applies, then reports already", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a76-patch-"));
  try {
    const file = path.join(dir, "core-TEST1234.js");
    fs.writeFileSync(file, SHAPE);
    fs.writeFileSync(path.join(dir, "core-OTHER999.js"), "unrelated");
    const logs = [];
    const r1 = patcher.applyPatch({ distDir: dir, log: (m) => logs.push(m) });
    assert.deepStrictEqual([r1.patched, r1.action, r1.file], [true, "applied", file]);
    assert.ok(!fs.readFileSync(file, "utf8").includes("postData()"));
    assert.strictEqual(logs.length, 1);
    const r2 = patcher.applyPatch({ distDir: dir, log: (m) => logs.push(m) });
    assert.deepStrictEqual([r2.patched, r2.action], [true, "already"]);
    assert.strictEqual(fs.readFileSync(path.join(dir, "core-OTHER999.js"), "utf8"), "unrelated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A76: applyPatch soft-fails on a missing dir and on a changed shape", () => {
  assert.strictEqual(patcher.applyPatch({ distDir: "/__no_such_dir__/dist" }).patched, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a76-patch-"));
  try {
    fs.writeFileSync(path.join(dir, "core-TEST1234.js"), "async _toHttpRequest(r){return{body:r.data}}");
    const r = patcher.applyPatch({ distDir: dir, log: () => {} });
    assert.strictEqual(r.patched, false);
    assert.ok(/shape changed/.test(r.reason));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A76: the live upstream bundle no longer captures request bodies after applyPatch", () => {
  const r = patcher.applyPatch({ log: () => {} });
  assert.strictEqual(r.patched, true, `patch not in effect: ${r.reason}`);
  const src = fs.readFileSync(r.file, "utf8");
  assert.ok(src.includes(patcher.MARKER));
  assert.strictEqual((src.match(patcher.MATCH_CAPTURE) || []).length, 0, "a postData() capture is still present");
  // An upgrade that adds a capture under another name must fail here, not pass
  // silently: the only postData*( call left anywhere in dist/ is the
  // postDataBuffer( telemetry forwarder (it never reaches a tool result).
  const dist = path.dirname(r.file);
  const sites = [];
  for (const f of fs.readdirSync(dist)) {
    if (!f.endsWith(".js")) continue;
    for (const m of fs.readFileSync(path.join(dist, f), "utf8").matchAll(/postData\w*\(/g)) sites.push(`${f}:${m[0]}`);
  }
  assert.deepStrictEqual(sites.map((s) => s.split(":")[1]), ["postDataBuffer("], `unexpected postData call sites: ${sites.join(", ")}`);
});

test("A76: applyPatch writes atomically (no temp file left behind) and follows distDir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a76-patch-"));
  try {
    fs.writeFileSync(path.join(dir, "core-TEST1234.js"), SHAPE);
    const renames = [];
    const realRename = fs.renameSync;
    fs.renameSync = (a, b) => { renames.push(path.basename(b)); return realRename(a, b); };
    let r;
    try { r = patcher.applyPatch({ distDir: dir, log: () => {} }); } finally { fs.renameSync = realRename; }
    assert.strictEqual(r.action, "applied");
    assert.deepStrictEqual(renames, ["core-TEST1234.js"], "the patched file must be renamed into place, not written in place");
    assert.deepStrictEqual(fs.readdirSync(dir), ["core-TEST1234.js"], "temp file must be renamed into place");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
