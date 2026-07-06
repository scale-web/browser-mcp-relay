#!/usr/bin/env node
/**
 * launch-project-isolated.js — per-project Brave profile wrapper for browser-mcp-relay.
 *
 * Problem it solves: the relay defaults to STANDALONE mode (one shared
 * `.browser-data` profile), so every project's Claude session drives the SAME
 * Brave window — tabs from different projects pile together.
 *
 * What this does: derives a STABLE {slot, dir} per project from CLAUDE_PROJECT_DIR
 * (fallback: cwd), persisted in a registry, and sets BROWSER_RELAY_POOL_DIR +
 * BROWSER_RELAY_POOL_SLOT before launching the relay. Result: each project gets
 * its own isolated Brave profile (own tabs + own logins/cookies), automatically,
 * with zero per-project config. New projects self-register on first launch.
 *
 * Wire-up: point the global MCP registration at this file instead of src/index.js:
 *   "browser-mcp-relay": { "command": "node",
 *     "args": ["/Users/trevor/Documents/browser-mcp-relay/launch-project-isolated.js"] }
 *
 * Notes:
 * - Slots 1..12 → CDP ports 9333..9344 (within the 9333..9349 range that
 *   pool-shared.js PORT_BASE..PORT_SCAN_END defines and ghl-jwt.mjs scans;
 *   9345..9349 stay free as remap/session-clone headroom).
 *   The 13th+ project wraps onto an existing slot (logged as a warning).
 * - Registry: ~/Library/Caches/browser-mcp-relay/project-registry.json
 * - Profiles: ~/Library/Caches/browser-mcp-relay/profiles/<project-slug>/
 * - Effect is per relay launch (next session per project). A project's first
 *   launch under this wrapper starts a FRESH Brave profile → one-time re-login.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RELAY_ENTRY = path.join(__dirname, "src", "index.js");
// 12 slots → ports 9333..9344. Stays inside pool-shared.js's
// PORT_BASE..PORT_SCAN_END (9333..9349) with 5 ports of headroom for the
// relay's port-collision remap and ephemeral session clones.
const MAX_SLOTS = 12;

const proj = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const slug = (path.basename(proj).replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()) || "default";

const cacheRoot = path.join(os.homedir(), "Library", "Caches", "browser-mcp-relay");
const profilesRoot = path.join(cacheRoot, "profiles");
const regPath = path.join(cacheRoot, "project-registry.json");

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(regPath, "utf8")); } catch { return {}; }
}
function writeRegistry(reg) {
  try {
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  } catch (e) {
    process.stderr.write(`[relay-wrapper] WARN could not persist registry: ${e.message}\n`);
  }
}

const reg = readRegistry();
if (!reg[proj]) {
  const used = new Set(Object.values(reg).map((r) => r.slot));
  let slot = 1;
  while (used.has(slot) && slot <= MAX_SLOTS) slot++;
  let wrapped = false;
  if (slot > MAX_SLOTS) { slot = (Object.keys(reg).length % MAX_SLOTS) + 1; wrapped = true; }
  reg[proj] = { slot, slug, dir: path.join(profilesRoot, slug), assignedAt: new Date().toISOString() };
  if (wrapped) process.stderr.write(`[relay-wrapper] WARN >${MAX_SLOTS} projects — slot ${slot} reused for ${slug} (shares Brave/port)\n`);
  writeRegistry(reg);
}

const { slot, dir } = reg[proj];
try { fs.mkdirSync(dir, { recursive: true }); } catch {}

process.env.BROWSER_RELAY_POOL_DIR = dir;
process.env.BROWSER_RELAY_POOL_SLOT = String(slot);
process.stderr.write(`[relay-wrapper] project=${slug} slot=${slot} port=${9333 + slot - 1} dir=${dir}\n`);

// env is set; invoke the real relay (it reads these on load)
require(RELAY_ENTRY).main().catch((e) => {
  process.stderr.write(`[relay-wrapper] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
