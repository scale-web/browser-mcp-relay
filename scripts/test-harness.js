#!/usr/bin/env node
// scripts/test-harness.js — run the test suite where it cannot touch real state.
//
//   node scripts/test-harness.js                 self-check, then the whole suite
//   node scripts/test-harness.js --self-check    self-check only
//   node scripts/test-harness.js -- <args>       extra args for `node --test`
//
// Why: the relay keeps machine-wide state under the REAL home (the project
// registry, per-project profiles, session clones) and pool-shared.js loads
// `<repo-parent>/wrap-browser-devtools-mcp.js`, which hardcodes the legacy
// pool root. A test relay started with the real HOME, or from a checkout whose
// parent holds that wrapper, claims, sweeps and GCs live profiles.
//
// What it enforces (spec §Tests + v4 amendment 5):
//   1. HOME is a fresh mkdtemp dir; the run refuses unless the child's
//      os.homedir() resolves under it (and under os.tmpdir()).
//   2. Every loadConfig().poolDirs, userCacheRoot() and sessionClonesRoot()
//      resolves under that temp HOME; no wrapper was loaded; no
//      local-config.json overlays the run.
//   3. A before/after snapshot of the REAL cache root and the REAL legacy
//      pool root (listings, inodes and mtimes only — never file contents).
//      Any difference fails the run.
//   4. Any Brave still running on a user-data-dir under the temp HOME at the
//      end is a leak: it is killed (it is ours by construction) and fails the run.
//   5. The temp HOME is deleted at the end.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
// The real home comes from the passwd entry, never $HOME — so a harness that
// is itself started under a fake HOME still guards the real one.
const REAL_HOME = os.userInfo().homedir;
const REAL_CACHE_ROOT = path.join(REAL_HOME, "Library", "Caches", "browser-mcp-relay");
const REAL_LEGACY_POOL = path.join(REAL_HOME, "Library", "Application Support", "BraveSoftware", "Brave-Browser-Relay-Pool");
const LOCK_NAMES = [".mcp-wrapper-lock", ".mcp-relay.flock", ".mcp-relay-status.json"];

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function lstatSig(p) {
  try {
    const st = fs.lstatSync(p);
    return { ino: st.ino, mtimeMs: st.mtimeMs, size: st.isFile() ? st.size : null };
  } catch (e) {
    return e.code === "ENOENT" ? "absent" : `error:${e.code}`;
  }
}

function listNames(dir) {
  try { return fs.readdirSync(dir).sort(); } catch (e) { return e.code === "ENOENT" ? null : [`<error:${e.code}>`]; }
}

/** Listings, inodes and mtimes only. Profile and clone dir mtimes are NOT
 *  recorded (live Braves write into them constantly); their names and inodes
 *  are, and so are the lock/flock/status files a leaky test relay would
 *  create or replace. */
function snapshot() {
  const s = {};
  const put = (k, v) => { s[k] = JSON.stringify(v); };
  put(REAL_CACHE_ROOT, lstatSig(REAL_CACHE_ROOT));
  for (const name of listNames(REAL_CACHE_ROOT) || []) {
    const p = path.join(REAL_CACHE_ROOT, name);
    const sig = lstatSig(p);
    // Directory mtimes of profiles/ and session-clones/ change when a live
    // session creates a clone; record the dir's inode, and its children below.
    put(p, typeof sig === "object" && sig.size === null ? { ino: sig.ino } : sig);
  }
  for (const sub of ["profiles", "session-clones"]) {
    const root = path.join(REAL_CACHE_ROOT, sub);
    for (const name of listNames(root) || []) {
      const d = path.join(root, name);
      const sig = lstatSig(d);
      put(d, typeof sig === "object" ? { ino: sig.ino } : sig);
      if (sub === "profiles") {
        for (const lock of LOCK_NAMES) put(path.join(d, lock), lstatSig(path.join(d, lock)));
      }
    }
  }
  put(REAL_LEGACY_POOL, lstatSig(REAL_LEGACY_POOL));
  for (const name of listNames(REAL_LEGACY_POOL) || []) {
    const d = path.join(REAL_LEGACY_POOL, name);
    const sig = lstatSig(d);
    put(d, typeof sig === "object" && sig.size === null ? { ino: sig.ino } : sig);
    for (const lock of LOCK_NAMES) put(path.join(d, lock), lstatSig(path.join(d, lock)));
  }
  return s;
}

function diffSnapshots(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] !== b[k]) out.push(`${k}: ${a[k] ?? "<not listed>"} -> ${b[k] ?? "<not listed>"}`);
  }
  return out.sort();
}

function makeTempHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-home-")));
  if (!isUnder(home, fs.realpathSync(os.tmpdir()))) throw new Error(`temp HOME ${home} is not under os.tmpdir()`);
  return home;
}

/** The env every test process inherits. Relay knobs from the operator's
 *  shell are dropped so a stray BROWSER_RELAY_POOL_DIR cannot point a test at
 *  a real profile. */
function harnessEnv(home) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("BROWSER_") || k.startsWith("CLAUDE_CODE_MESSAGING_") || k === "XDG_CACHE_HOME") continue;
    env[k] = v;
  }
  env.HOME = home;
  env.BROWSER_RELAY_TEST_HARNESS_HOME = home;
  // Default pool dir for anything that loads pool-shared.js without its own
  // override; the standalone default would be <repo>/.browser-data.
  env.BROWSER_RELAY_POOL_DIR = path.join(home, "default-pool-dir");
  return env;
}

/** Runs in a CHILD with the harness env, so it sees exactly what a test sees. */
function selfCheck(env) {
  const probe = `
    const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
    const pool = require(${JSON.stringify(path.join(REPO, "src", "pool-shared.js"))});
    const lc = require(${JSON.stringify(path.join(REPO, "src", "local-config.js"))});
    process.stdout.write(JSON.stringify({
      homedir: fs.realpathSync(os.homedir()),
      tmpdir: fs.realpathSync(os.tmpdir()),
      poolDirs: pool.loadConfig().poolDirs,
      cacheRoot: pool.userCacheRoot(),
      clonesRoot: pool.sessionClonesRoot(),
      hasPoolWrapper: pool.hasPoolWrapper,
      localConfig: fs.existsSync(lc.getLocalConfigPath()),
    }));`;
  const r = spawnSync(process.execPath, ["-e", probe], { env, encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`self-check probe failed: ${r.stderr}`);
  const got = JSON.parse(r.stdout);
  const home = env.HOME;
  const problems = [];
  if (got.homedir !== home) problems.push(`os.homedir() is ${got.homedir}, not the temp HOME ${home}`);
  if (!isUnder(got.homedir, got.tmpdir)) problems.push(`os.homedir() ${got.homedir} is not under os.tmpdir() ${got.tmpdir}`);
  if (isUnder(got.homedir, REAL_HOME) || got.homedir === REAL_HOME) problems.push("os.homedir() is the real home");
  for (const d of got.poolDirs) if (!isUnder(path.resolve(d), home)) problems.push(`poolDir ${d} is not under the temp HOME`);
  for (const k of ["cacheRoot", "clonesRoot"]) if (!isUnder(got[k], home)) problems.push(`${k} ${got[k]} is not under the temp HOME`);
  if (got.hasPoolWrapper) problems.push("pool-shared.js loaded <repo-parent>/wrap-browser-devtools-mcp.js (it hardcodes the real legacy pool)");
  if (got.localConfig) problems.push("local-config.json exists in this checkout and would overlay the run");
  return { ok: problems.length === 0, problems, got };
}

function findTestFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findTestFiles(full));
    else if (e.isFile() && e.name.endsWith(".test.js")) out.push(full);
  }
  return out.sort();
}

/** Braves on a user-data-dir under our temp HOME are ours by construction. */
function reapLeakedBraves(home) {
  const r = spawnSync("ps", ["-eo", "pid,command", "-ww"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const leaked = [];
  for (const line of (r.stdout || "").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || !/brave/i.test(m[2])) continue;
    if (!m[2].includes(`--user-data-dir=${home}`)) continue;
    leaked.push(+m[1]);
  }
  for (const pid of leaked) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  return leaked;
}

async function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const extra = sep === -1 ? [] : argv.slice(sep + 1);
  const selfCheckOnly = own.includes("--self-check");

  const home = makeTempHome();
  const env = harnessEnv(home);
  let exitCode = 0;
  try {
    const sc = selfCheck(env);
    if (!sc.ok) {
      process.stderr.write(`[test-harness] REFUSING TO RUN — isolation self-check failed:\n  - ${sc.problems.join("\n  - ")}\n`);
      exitCode = 2;
      return;
    }
    process.stderr.write(`[test-harness] self-check OK: HOME=${home}, poolDirs/cacheRoot/clonesRoot under it, no wrapper, no local-config\n`);
    if (selfCheckOnly) return;

    const before = snapshot();
    const files = extra.some((a) => a.endsWith(".test.js")) ? [] : findTestFiles(path.join(REPO, "test"));
    const child = spawn(process.execPath, ["--test", ...extra, ...files], { cwd: REPO, env, stdio: "inherit" });
    const code = await new Promise((resolve) => child.on("exit", (c, sig) => resolve(sig ? 1 : c)));
    if (code !== 0) exitCode = code || 1;

    const leaked = reapLeakedBraves(home);
    if (leaked.length) {
      process.stderr.write(`[test-harness] FAIL: ${leaked.length} test Brave process(es) still running at the end (killed): ${leaked.join(", ")}\n`);
      exitCode = exitCode || 3;
    }
    const after = snapshot();
    const diff = diffSnapshots(before, after);
    if (diff.length) {
      process.stderr.write(`[test-harness] FAIL: real state changed during the run (${diff.length}):\n  ${diff.join("\n  ")}\n`);
      exitCode = exitCode || 4;
    } else {
      process.stderr.write(`[test-harness] real-state snapshot unchanged (${Object.keys(before).length} entries: ${REAL_CACHE_ROOT}, ${REAL_LEGACY_POOL})\n`);
    }
  } finally {
    reapLeakedBraves(home);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {
      process.stderr.write(`[test-harness] could not remove temp HOME ${home}: ${e.message}\n`);
      exitCode = exitCode || 5;
    }
  }
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`[test-harness] ${e.stack}\n`); process.exit(1); });
}

module.exports = { snapshot, diffSnapshots, selfCheck, harnessEnv, makeTempHome, isUnder, REAL_CACHE_ROOT, REAL_LEGACY_POOL };
