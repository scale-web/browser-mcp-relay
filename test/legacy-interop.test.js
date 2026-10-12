// legacy-interop.test.js — new relays beside pre-change relays (spec v4 §1a,
// amendment 5). The old code comes from `git archive ecb7b6c` into a temp dir
// under the temp HOME (whose parent has no wrapper); never a stash/checkout of
// a live checkout. Records and locks ONLY: no Brave is ever launched from old
// code (it would drop the mock keychain and read the real login keychain).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const lock = require("../src/profile-lock.js");
const pool = require("../src/pool-shared.js");
const { isolated, SKIP_MSG, homeTmp, nodeChild, claimHolder, sleeper, killAndWait, REPO } = require("./helpers/isolation.js");

const ISO = { skip: !isolated() ? SKIP_MSG : (process.platform !== "darwin" ? "darwin flock" : false), timeout: 30000 };
const OLD_REV = "ecb7b6c";

let oldRoot = null;
function oldCode() {
  if (oldRoot) return oldRoot;
  // A pre-extracted `git archive ecb7b6c` (used when the suite runs from a
  // copy without .git, e.g. the mutation runner).
  if (process.env.RELAY_OLD_CODE_DIR) return (oldRoot = process.env.RELAY_OLD_CODE_DIR);
  const dest = homeTmp("old-relay-");
  const archive = spawnSync("git", ["-C", REPO, "archive", OLD_REV, "src"], { maxBuffer: 64 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  const untar = spawnSync("tar", ["-x", "-C", dest], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
  assert.ok(!fs.existsSync(path.join(path.dirname(dest), "wrap-browser-devtools-mcp.js")), "old code's parent must hold no wrapper");
  oldRoot = dest;
  return dest;
}

function oldClaimHolder(dir) {
  return nodeChild(`
    const pool = require(${JSON.stringify(path.join(oldCode(), "src", "pool-shared.js"))});
    const c = pool.tryClaimDir(${JSON.stringify(dir)});
    console.log(c ? "CLAIMED " + process.pid : "BUSY");
    setInterval(() => {}, 1000);
  `);
}

function backdate(p, ms = 120_000) {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(p, t, t);
}

test("a pre-change relay sees a NEW relay's v2 record as held (and leaves it alone)", ISO, async () => {
  const dir = homeTmp("interop-a-");
  const neu = claimHolder(dir);
  try {
    await neu.waitLine(/^CLAIMED/);
    const before = fs.statSync(path.join(dir, lock.RECORD_NAME)).ino;
    const old = oldClaimHolder(dir);
    assert.match(await old.waitLine(/^(CLAIMED|BUSY)/), /^BUSY/);
    await killAndWait(old.child);
    assert.strictEqual(fs.statSync(path.join(dir, lock.RECORD_NAME)).ino, before, "the new relay's record survived");
  } finally {
    await killAndWait(neu.child);
  }
});

test("a new relay sees a live PRE-CHANGE holder as busy, and claims the dir once it is gone", ISO, async () => {
  const dir = homeTmp("interop-b-");
  const old = oldClaimHolder(dir);
  try {
    await old.waitLine(/^CLAIMED/);
    assert.strictEqual(lock.claimDir(dir, { _log: () => {} }), null, "live legacy record → busy");
    const f = lock.openFlock(dir);
    assert.ok(f, "…and the flock was not kept");
    lock.closeFlock(f);
  } finally {
    await killAndWait(old.child);
  }
  const c = lock.claimDir(dir);
  assert.ok(c, "dead legacy holder → free");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, lock.RECORD_NAME), "utf8")).v, 2);
  c.release();
});

test("old GC deletes a LIVE legacy clone under a TZ shift (the H2 bug); the new GC keeps it", ISO, async () => {
  const s = sleeper();
  try {
    await new Promise((r) => setTimeout(r, 1100));
    const tokyo = spawnSync("ps", ["-p", String(s.pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, TZ: "Asia/Tokyo", LC_ALL: "C" } }).stdout.trim();
    const mk = (root) => {
      const d = path.join(root, `proj-p${s.pid}-tz1234`);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, lock.RECORD_NAME), JSON.stringify({ pid: s.pid, startedAt: new Date().toISOString(), pidStartTime: tokyo, host: os.hostname(), relay: true }));
      backdate(d);
      return d;
    };
    const oldRootDir = homeTmp("interop-gc-old-");
    const newRootDir = homeTmp("interop-gc-new-");
    const dOld = mk(oldRootDir);
    const dNew = mk(newRootDir);
    const oldPool = require(path.join(oldCode(), "src", "pool-shared.js"));
    assert.strictEqual(oldPool.gcSessionClones({ root: oldRootDir }), 1, "precondition: the old rule calls this live holder recycled");
    assert.ok(!fs.existsSync(dOld));
    assert.strictEqual(pool.gcSessionClones({ root: newRootDir, project: "proj" }), 0);
    assert.ok(fs.existsSync(dNew), "the new predicate keeps the live legacy clone");
  } finally {
    await killAndWait(s);
  }
});
