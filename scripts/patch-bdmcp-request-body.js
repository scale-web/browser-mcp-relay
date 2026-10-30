// scripts/patch-bdmcp-request-body.js — register A76 (2026-10-30).
//
// Patches upstream browser-devtools-mcp so it never captures request bodies.
// Upstream's `_toHttpRequest` stores `body: req.postData()` for every request,
// and `o11y_get-http-requests` returns it with no flag — so a login typed in a
// relay tab (email + password in the form body) reached the transcript of any
// session that read HTTP requests, directly or through `execute` /
// `scenario-run` (whose `callTool(..., true)` returns the inner tool's raw
// output, beyond the reach of the relay's result filter). Removing the capture
// at the source covers every path and upstream's in-memory buffer too.
// `src/request-body-filter.js` stays as a second layer on the direct call.
//
// Same approach and safety rules as scripts/patch-bdmcp-bundle.js (F1-20):
// on-disk, applied at every relay startup before upstream spawns, idempotent,
// and a no-op (with a loud stderr line) if upstream's bundle shape changes.
// test/patch-bdmcp-request-body.test.js checks the live bundle, so an upgrade
// that breaks the pattern fails `npm test`.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MARKER = "/*A76: request body never captured*/";
const MATCH_CAPTURE = /body:\w+\.postData\(\)\|\|void 0/g;

function patchSource(content) {
  if (typeof content !== "string") return null;
  if (content.includes(MARKER)) return null;
  const hits = content.match(MATCH_CAPTURE);
  if (!hits || hits.length !== 1) return null;
  return content.replace(MATCH_CAPTURE, `body:void 0${MARKER}`);
}

function findCaptureFile(opts = {}) {
  const distDir = opts.distDir || path.resolve(
    require.resolve("browser-devtools-mcp/dist/index.js"),
    "..",
  );
  let entries;
  try { entries = fs.readdirSync(distDir); } catch { return null; }
  for (const fname of entries) {
    if (!/^core-[A-Za-z0-9]+\.js$/.test(fname)) continue;
    const full = path.join(distDir, fname);
    let content;
    try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (content.includes("_toHttpRequest")) return full;
  }
  return null;
}

/**
 * Returns { patched: true, file, action: "applied" | "already" } or
 * { patched: false, reason } (safe no-op; the caller logs it loudly).
 */
function applyPatch(opts = {}) {
  const log = opts.log || ((msg) => { try { process.stderr.write(msg); } catch {} });
  const file = findCaptureFile(opts);
  if (!file) return { patched: false, reason: "no upstream core-*.js with _toHttpRequest found" };
  let content;
  try { content = fs.readFileSync(file, "utf8"); }
  catch (e) { return { patched: false, reason: `read failed: ${e.message}` }; }
  if (content.includes(MARKER)) return { patched: true, file, action: "already" };
  const out = patchSource(content);
  if (!out) return { patched: false, reason: "capture pattern not found exactly once (upstream bundler shape changed?)" };
  // Atomic: a relay starting at the same moment must never import a
  // half-written bundle (temp file in the same dir, then rename).
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.a76-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, out, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { patched: false, reason: `write failed: ${e.message}` };
  }
  log(`[mcp-relay] patched browser-devtools-mcp at ${path.basename(file)}: request bodies are no longer captured (A76)\n`);
  return { patched: true, file, action: "applied" };
}

module.exports = { MARKER, MATCH_CAPTURE, patchSource, findCaptureFile, applyPatch };

if (require.main === module) {
  const result = applyPatch();
  if (!result.patched) process.stderr.write(`[mcp-relay] patch-bdmcp-request-body: ${result.reason}\n`);
  else if (result.action === "already") process.stderr.write(`[mcp-relay] patch-bdmcp-request-body: already applied (${path.basename(result.file)})\n`);
  process.exit(0);
}
