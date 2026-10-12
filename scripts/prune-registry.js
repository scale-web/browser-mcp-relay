#!/usr/bin/env node
// scripts/prune-registry.js — one-time cleanup of the per-project registry
// (spec v4 §1e). DRY RUN by default: it prints what it would do and changes
// nothing. A human runs it with --apply.
//
//   node scripts/prune-registry.js            dry run (default)
//   node scripts/prune-registry.js --apply    back up the registry, then prune
//
// What it prunes:
//   - registry keys whose project path is a temp path (sessions started in
//     /tmp, /private/var/folders, a Claude scratchpad, a test's mkdtemp);
//   - a profiles/<slug> dir ONLY if every registry key that maps to it is a
//     temp path AND it has no Default/Network/Cookies — and only after taking
//     that dir's flock with THE predicate (profile-lock.classifyDir): a dir a
//     live relay (new or pre-change) holds is skipped.
// Everything else that looks prunable (a profile with cookies, a profile no
// key maps to, a busy dir) is LISTED for a human decision, never touched.
// The registry is rewritten tmp+rename after a timestamped backup.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const profileLock = require("../src/profile-lock.js");

function isTempPath(p, home = os.homedir()) {
  const real = (q) => { try { return fs.realpathSync(q); } catch { return q; } };
  const r = real(p) + path.sep;
  if (r.startsWith(real(home) + path.sep)) return false;
  const roots = ["/private/tmp/", "/tmp/", "/private/var/folders/", "/var/folders/", real(os.tmpdir()) + path.sep];
  return roots.some((root) => r.startsWith(root));
}

function plan({ cacheRoot }) {
  const regPath = path.join(cacheRoot, "project-registry.json");
  const profilesRoot = path.join(cacheRoot, "profiles");
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8")); // a parse failure aborts the run
  const keysBySlugDir = new Map();
  for (const [proj, entry] of Object.entries(reg)) {
    const d = entry && entry.dir ? entry.dir : null;
    if (!d) continue;
    if (!keysBySlugDir.has(d)) keysBySlugDir.set(d, []);
    keysBySlugDir.get(d).push(proj);
  }
  const tempKeys = Object.keys(reg).filter((k) => isTempPath(k));
  const dirsToPrune = [];
  const forHuman = [];
  let profileDirs = [];
  try { profileDirs = fs.readdirSync(profilesRoot).map((n) => path.join(profilesRoot, n)); } catch { /* none */ }
  for (const d of profileDirs) {
    const keys = keysBySlugDir.get(d) || [];
    const hasCookies = fs.existsSync(path.join(d, "Default", "Network", "Cookies"));
    if (keys.length === 0) { forHuman.push({ dir: d, why: "no registry key maps to it" }); continue; }
    if (!keys.every((k) => isTempPath(k))) continue; // a real project uses it
    if (hasCookies) { forHuman.push({ dir: d, why: "only temp-path keys map to it, but it holds cookies" }); continue; }
    dirsToPrune.push(d);
  }
  return { regPath, reg, tempKeys, dirsToPrune, forHuman };
}

function apply(p, { now = new Date() } = {}) {
  const backup = `${p.regPath}.bak-${now.toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(p.regPath, backup);
  const removedDirs = [];
  const busy = [];
  for (const d of p.dirsToPrune) {
    const c = profileLock.classifyDir(d);
    if (!c.free) { busy.push({ dir: d, why: c.reason }); continue; }
    try {
      fs.rmSync(d, { recursive: true, force: true }); // under its flock
      removedDirs.push(d);
    } finally {
      profileLock.closeFlock(c.flock);
    }
  }
  const next = { ...p.reg };
  for (const k of p.tempKeys) delete next[k];
  const tmp = `${p.regPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, p.regPath);
  return { backup, removedDirs, busy, removedKeys: p.tempKeys.length };
}

function main() {
  const doApply = process.argv.includes("--apply");
  const cacheRoot = path.join(os.homedir(), "Library", "Caches", "browser-mcp-relay");
  const p = plan({ cacheRoot });
  console.log(`registry: ${p.regPath} (${Object.keys(p.reg).length} keys)`);
  console.log(`temp-path keys to remove: ${p.tempKeys.length}`);
  for (const k of p.tempKeys) console.log(`  - ${k}`);
  console.log(`profile dirs to remove (only temp keys, no cookies): ${p.dirsToPrune.length}`);
  for (const d of p.dirsToPrune) console.log(`  - ${d}`);
  console.log(`for a human decision (not touched): ${p.forHuman.length}`);
  for (const f of p.forHuman) console.log(`  ? ${f.dir} — ${f.why}`);
  if (!doApply) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply to prune.");
    return;
  }
  const r = apply(p);
  console.log(`\nbacked up registry to ${r.backup}`);
  console.log(`removed ${r.removedKeys} key(s), ${r.removedDirs.length} dir(s)`);
  for (const b of r.busy) console.log(`  skipped busy ${b.dir} — ${b.why}`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`prune-registry failed (nothing more was changed): ${e.message}`); process.exit(1); }
}

module.exports = { isTempPath, plan, apply };
