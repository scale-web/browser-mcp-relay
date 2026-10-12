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
 * - The slot is a LABEL (banner + registry) only. It no longer selects a CDP
 *   port: since spec v4 §1b the relay launches Brave with
 *   --remote-debugging-port=0 and reads the OS-assigned port back from
 *   <profile>/DevToolsActivePort (also published as `cdpPort` in
 *   <profile>/.mcp-relay-status.json). Pre-change relays still put their
 *   Braves on 9333..9349 (slot N → 9333+N-1).
 *   The 13th+ project wraps onto an existing slot label (logged as a warning).
 * - Registry: ~/Library/Caches/browser-mcp-relay/project-registry.json —
 *   written tmp+rename, and never after a failed parse (a mid-write read used
 *   to come back as {} and the write-back wiped every entry).
 * - Profiles: ~/Library/Caches/browser-mcp-relay/profiles/<project-slug>/
 * - Temp-path projects (a session started in /tmp, /private/var/folders, a
 *   Claude scratchpad) are NOT registered: they get a fresh ephemeral profile
 *   under session-clones/, removed at exit.
 * - Effect is per relay launch (next session per project). A project's first
 *   launch under this wrapper starts a FRESH Brave profile → one-time re-login.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RELAY_ENTRY = path.join(__dirname, "src", "index.js");
// 12 slot labels (pre-change relays mapped them to ports 9333..9344).
const MAX_SLOTS = 12;

const proj = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const slug = (path.basename(proj).replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()) || "default";

const cacheRoot = path.join(os.homedir(), "Library", "Caches", "browser-mcp-relay");
const profilesRoot = path.join(cacheRoot, "profiles");
const regPath = path.join(cacheRoot, "project-registry.json");

// The test hook is refused BEFORE this wrapper writes anything (Phase 1 review:
// with a real HOME it registered the project and created its profile dir, and
// only then did the relay refuse).
{
  const { testLaunchRequested, assertTestLaunchAllowed } = require(path.join(__dirname, "src", "cdp-bridge.js"));
  if (testLaunchRequested()) {
    try { assertTestLaunchAllowed(); } catch (e) { process.stderr.write(`${e.message}\n`); process.exit(1); }
  }
}

/** {} when there is no registry yet; null when it exists but did not parse —
 *  the caller must then NOT write it back. */
function readRegistry() {
  let text;
  try { text = fs.readFileSync(regPath, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return {};
    return null;
  }
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
function writeRegistry(reg) {
  try {
    fs.mkdirSync(cacheRoot, { recursive: true });
    const tmp = `${regPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, regPath);
  } catch (e) {
    process.stderr.write(`[relay-wrapper] WARN could not persist registry: ${e.message}\n`);
  }
}

/** A project rooted in a temp dir (a session started in /tmp, a scratchpad,
 *  a test's mkdtemp) — never registered, never given a persistent profile.
 *  Anything inside the home dir is a real project. */
function isTempProject(p) {
  const real = (q) => { try { return fs.realpathSync(q); } catch { return q; } };
  const r = real(p) + path.sep;
  if (r.startsWith(real(os.homedir()) + path.sep)) return false;
  const roots = ["/private/tmp/", "/tmp/", "/private/var/folders/", "/var/folders/", real(os.tmpdir()) + path.sep];
  return roots.some((root) => r.startsWith(root));
}

let slot;
let dir;
if (isTempProject(proj)) {
  // Unregistered ephemeral profile, named like a session clone so a crashed
  // relay's leftover is GC'd like one; the relay removes it at exit.
  dir = path.join(cacheRoot, "session-clones", `${slug}-p${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.BROWSER_RELAY_EPHEMERAL_POOL_DIR = "1";
  process.stderr.write(`[relay-wrapper] project=${slug} is a temp path — ephemeral unregistered profile dir=${dir}\n`);
} else {
  const reg = readRegistry();
  if (reg === null) {
    process.stderr.write(`[relay-wrapper] WARN ${regPath} did not parse — not writing it back; using the profile dir by slug\n`);
    slot = 1;
    dir = path.join(profilesRoot, slug);
  } else {
    if (!reg[proj]) {
      const used = new Set(Object.values(reg).map((r) => r.slot));
      let s = 1;
      while (used.has(s) && s <= MAX_SLOTS) s++;
      let wrapped = false;
      if (s > MAX_SLOTS) { s = (Object.keys(reg).length % MAX_SLOTS) + 1; wrapped = true; }
      reg[proj] = { slot: s, slug, dir: path.join(profilesRoot, slug), assignedAt: new Date().toISOString() };
      if (wrapped) process.stderr.write(`[relay-wrapper] WARN >${MAX_SLOTS} projects — slot label ${s} reused for ${slug}\n`);
      writeRegistry(reg);
    }
    ({ slot, dir } = reg[proj]);
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  process.env.BROWSER_RELAY_POOL_SLOT = String(slot);
}

process.env.BROWSER_RELAY_POOL_DIR = dir;
// port=auto: Brave's CDP port is OS-assigned; the relay prints it on its
// "Brave ready (port=…)" line and writes it to <dir>/.mcp-relay-status.json.
process.stderr.write(`[relay-wrapper] project=${slug} slot=${slot ?? "-"} port=auto dir=${dir}\n`);

// env is set; invoke the real relay (it reads these on load)
require(RELAY_ENTRY).main().catch((e) => {
  process.stderr.write(`[relay-wrapper] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
