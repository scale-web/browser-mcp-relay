// scripts/patch-bdmcp-bundle.js — F1-20 (2026-05-10).
//
// Patches upstream browser-devtools-mcp's HttpResourceType enum on disk
// to add Playwright-returned values that upstream's bundle is missing.
//
// Why on-disk patching, not Module._compile / --require / loader hooks:
//   Upstream's dist/ is ESM (`import { ... } from "./core-*.js"`). The
//   classic require-hook approach (Module.prototype._compile) only fires
//   for CommonJS require() — never for ESM import. ESM has its own
//   loader-hook system (module.register / experimental-loader) but
//   wiring that across the spawned-child boundary is fragile.
//
//   Patching the bundle file on disk in the relay's CJS startup before
//   we spawn upstream is straightforward + reliable + survives both
//   ESM and CJS imports of the affected file.
//
// Why this is safe:
//   1. Idempotent — detects existing patch + skips
//   2. Bails on shape change — if upstream's bundler output mutates
//      beyond our regex's tolerance, we no-op rather than corrupt
//      the file
//   3. Logs a single stderr line on first patch + on every skip-because-
//      already-patched call (so the relay's diagnostic output makes
//      it obvious whether the patch is in effect)
//
// Why a postinstall hook isn't enough on its own:
//   `npm install` would re-vendor the unpatched bundle. Calling this at
//   every relay startup catches that case without depending on lifecycle
//   scripts (which can be skipped with `--ignore-scripts`).

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MISSING_RESOURCE_TYPES = [
  "ping",
  "prefetch",
  "signedexchange",
  "cspviolationreport",
  "preflight",
  "fedcm",
];

const MATCH_OTHER_ENTRY = /(HttpResourceType\d?\.OTHER\s*=\s*"other")/;

function buildAdditions(prefixToken) {
  return MISSING_RESOURCE_TYPES
    .map((v) => `,${prefixToken}.${v.toUpperCase()}="${v}"`)
    .join("");
}

function shouldPatch(filename) {
  if (!filename) return false;
  const norm = filename.replace(/\\/g, "/");
  return norm.includes("/node_modules/browser-devtools-mcp/dist/")
    && /\/core-[A-Za-z0-9]+\.js$/.test(norm);
}

function patchSource(content) {
  if (typeof content !== "string") return null;
  if (content.includes('HttpResourceType2.PING="ping"')) return null;
  const m = MATCH_OTHER_ENTRY.exec(content);
  if (!m) return null;
  const prefixToken = m[1].split(".")[0];
  const additions = buildAdditions(prefixToken);
  return content.replace(MATCH_OTHER_ENTRY, m[1] + additions);
}

/**
 * Find the bundled core-*.js file inside upstream's installed dist/.
 * Returns the absolute path to the file containing HttpResourceType, or
 * null if no candidate was found.
 *
 * Pure (no I/O side effects beyond fs.readdirSync + fs.readFileSync).
 *
 * @param {object} [opts]
 * @param {string} [opts.distDir] — override the search root
 * @returns {string | null}
 */
function findBundledCoreFile(opts = {}) {
  const distDir = opts.distDir || path.resolve(
    require.resolve("browser-devtools-mcp/dist/index.js"),
    "..",
  );
  let entries;
  try {
    entries = fs.readdirSync(distDir);
  } catch {
    return null;
  }
  for (const fname of entries) {
    if (!/^core-[A-Za-z0-9]+\.js$/.test(fname)) continue;
    const full = path.join(distDir, fname);
    let content;
    try { content = fs.readFileSync(full, "utf8"); }
    catch { continue; }
    if (content.includes('HttpResourceType')) return full;
  }
  return null;
}

/**
 * Apply the patch to upstream's bundled core file.
 *
 * Returns one of:
 *   { patched: true,  file, action: "applied" }     — patch was applied
 *   { patched: true,  file, action: "already" }     — already patched
 *   { patched: false, reason }                      — couldn't patch; safe no-op
 *
 * @param {object} [opts]
 * @param {string} [opts.distDir] — override the search root (test seam)
 * @param {(msg:string)=>void} [opts.log] — stderr writer (test seam)
 */
function applyPatch(opts = {}) {
  const log = opts.log || ((msg) => { try { process.stderr.write(msg); } catch {} });
  const file = findBundledCoreFile(opts);
  if (!file) return { patched: false, reason: "no upstream bundled core-*.js found" };
  let content;
  try { content = fs.readFileSync(file, "utf8"); }
  catch (e) { return { patched: false, reason: `read failed: ${e.message}` }; }
  if (content.includes('HttpResourceType2.PING="ping"')) {
    return { patched: true, file, action: "already" };
  }
  const out = patchSource(content);
  if (!out) {
    return { patched: false, reason: "regex match failed (upstream bundler shape changed?)" };
  }
  // Atomic (A76 re-review r2 #5): this file is also patched by
  // scripts/patch-bdmcp-request-body.js; a plain truncate-and-write from one
  // relay could undo another relay's A76 rename, or be imported half-written.
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.f120-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, out, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { patched: false, reason: `write failed: ${e.message}` };
  }
  log(
    `[mcp-relay] patched browser-devtools-mcp HttpResourceType enum at ` +
    `${path.basename(file)}: added ${MISSING_RESOURCE_TYPES.join(", ")} ` +
    `(o11y_get-http-requests now accepts these from Playwright)\n`,
  );
  return { patched: true, file, action: "applied" };
}

module.exports = {
  MISSING_RESOURCE_TYPES,
  MATCH_OTHER_ENTRY,
  buildAdditions,
  shouldPatch,
  patchSource,
  findBundledCoreFile,
  applyPatch,
};

// Run as a CLI when invoked directly (e.g. `npm run patch-bdmcp` or
// `node scripts/patch-bdmcp-bundle.js`). Useful for npm postinstall
// hooks + manual re-application after upstream upgrades.
if (require.main === module) {
  const result = applyPatch();
  if (!result.patched) {
    process.stderr.write(`[mcp-relay] patch-bdmcp: ${result.reason}\n`);
    process.exit(0); // soft fail — never block the relay's startup
  }
  if (result.action === "already") {
    process.stderr.write(`[mcp-relay] patch-bdmcp: already applied (${path.basename(result.file)})\n`);
  }
  process.exit(0);
}
