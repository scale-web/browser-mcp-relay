// relay-process.test.js — REAL relay processes (launch-project-isolated.js →
// src/index.js) under the harness's temp HOME, with the mock upstream and NO
// Brave: spec v4 §1a (claims, release), §1c (instructions, relay_status, the
// sidecar, the mode prefix), §1e (registry, temp projects) and amendment 5
// (the test-hook gate refuses to run). Assertions are on files, inodes and
// flocks, not on log text.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const lock = require("../src/profile-lock.js");
const { isolated, SKIP_MSG, homeTmp, sleeper, killAndWait, REPO } = require("./helpers/isolation.js");
const { startRelay } = require("./helpers/mcp.js");

const ISO = { skip: !isolated() ? SKIP_MSG : (process.platform !== "darwin" ? "darwin" : false), timeout: 60000 };

// Each test gets its OWN home under the harness's temp HOME: test files run in
// parallel, and the cache root / registry must not be shared between them.
let HOME = null;
const freshHome = () => { HOME = homeTmp("home-"); return HOME; };
const cacheRoot = () => path.join(HOME, "Library", "Caches", "browser-mcp-relay");
const regPath = () => path.join(cacheRoot(), "project-registry.json");
const slugOf = (p) => path.basename(p).replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
const profileOf = (p) => path.join(cacheRoot(), "profiles", slugOf(p));
const relay = (env) => startRelay({ env: { HOME, ...env } });
const statusOf = async (r) => JSON.parse((await r.call("relay_status")).text);
function braveOnDir(dir) {
  const out = spawnSync("ps", ["-eo", "pid,command", "-ww"], { encoding: "utf8" }).stdout;
  return out.split("\n").filter((l) => /brave/i.test(l) && l.includes(`--user-data-dir=${dir}`));
}

test("MCP instructions at connect: short, point to relay_status, claim no BASE/CLONE", ISO, async () => {
  freshHome();
  const proj = path.join(HOME, "proj-instr");
  const r = await relay({ CLAUDE_PROJECT_DIR: proj });
  try {
    const text = r.init.instructions;
    assert.ok(typeof text === "string" && text.length > 0 && text.length <= 2048, `length ${text && text.length}`);
    assert.match(text, /relay_status/);
    assert.doesNotMatch(text, /\bBASE\b|\bCLONE\b/, "nothing is claimed-as-known at connect");
  } finally {
    await r.stop();
  }
});

test("two relays, one project: the first holds the BASE, the second runs on a CLONE; relay_status says so without launching Brave", ISO, async () => {
  freshHome();
  const proj = path.join(HOME, "proj-two");
  const base = profileOf(proj);
  const a = await relay({ CLAUDE_PROJECT_DIR: proj, CLAUDE_CODE_SESSION_ID: "sess-A" });
  let b;
  try {
    const sa = await statusOf(a);
    assert.strictEqual(sa.mode, "base");
    assert.strictEqual(sa.dir, base);
    // A's record + flock + sidecar are on disk.
    const rec = JSON.parse(fs.readFileSync(path.join(base, lock.RECORD_NAME), "utf8"));
    assert.strictEqual(rec.pid, a.child.pid);
    assert.strictEqual(rec.v, 2);
    assert.strictEqual(rec.sessionId, "sess-A");
    assert.strictEqual(lock.openFlock(base), null, "A holds the base flock");
    const side = JSON.parse(fs.readFileSync(path.join(base, ".mcp-relay-status.json"), "utf8"));
    assert.deepStrictEqual(Object.keys(side).sort(), ["braveAlive", "bravePid", "cdpPort", "lane", "lastToolCallAt", "mode", "pid", "ppid", "sessionId", "v"].sort());
    assert.strictEqual(side.mode, "base");
    assert.strictEqual(side.pid, a.child.pid);
    assert.strictEqual(fs.statSync(path.join(base, ".mcp-relay-status.json")).mode & 0o777, 0o600);

    b = await relay({ CLAUDE_PROJECT_DIR: proj, CLAUDE_CODE_SESSION_ID: "sess-B" });
    const res = await b.call("relay_status");
    assert.match(res.notices[0] || "", /Browser profile: CLONE of/, "the first tool result announces the mode");
    const sb = JSON.parse(res.text);
    assert.strictEqual(sb.mode, "clone");
    assert.ok(sb.dir.startsWith(path.join(cacheRoot(), "session-clones") + path.sep));
    assert.strictEqual(sb.base.holder.pid, a.child.pid);
    assert.strictEqual(sb.base.holder.sessionId, "sess-A");
    assert.strictEqual(sb.base.holder.format, "v2");
    assert.strictEqual(sb.base.holder.alive, true);
    assert.match(sb.howToGetBase, /deleted/);
    assert.ok(sb.clonesInThisProject.some((c) => c.self && c.ownerPid === b.child.pid));
    const again = await b.call("relay_status");
    assert.deepStrictEqual(again.notices, [], "announced once, not on every result");
    assert.deepStrictEqual(braveOnDir(base), [], "relay_status launched no Brave");
    assert.deepStrictEqual(braveOnDir(sb.dir), []);

    await b.stop();
    assert.ok(!fs.existsSync(sb.dir), "the clone dir is removed at exit");
  } finally {
    if (b) await b.stop();
    await a.stop();
  }
  assert.ok(!fs.existsSync(path.join(base, lock.RECORD_NAME)), "A's record removed at exit");
  assert.ok(!fs.existsSync(path.join(base, ".mcp-relay-status.json")), "A's sidecar removed at exit");
  const f = lock.openFlock(base);
  assert.ok(f, "base flock released");
  lock.closeFlock(f);
});

test("amendment 3: a live legacy record appearing in a dir we hold is reported as a conflict, never overwritten", ISO, async () => {
  freshHome();
  const proj = path.join(HOME, "proj-conflict");
  const base = profileOf(proj);
  const a = await relay({ CLAUDE_PROJECT_DIR: proj });
  const s = sleeper();
  try {
    await statusOf(a);
    await new Promise((res) => setTimeout(res, 1100));
    const legacy = JSON.stringify({ pid: s.pid, startedAt: new Date().toISOString(), host: os.hostname(), relay: true });
    fs.writeFileSync(path.join(base, lock.RECORD_NAME), legacy); // a pre-change relay's double claim
    const st = await statusOf(a);
    assert.match(st.conflict || "", new RegExp(`pid ${s.pid}`));
    assert.strictEqual(fs.readFileSync(path.join(base, lock.RECORD_NAME), "utf8"), legacy, "the legacy record is left as it is");
    const side = JSON.parse(fs.readFileSync(path.join(base, ".mcp-relay-status.json"), "utf8"));
    assert.match(side.conflict, new RegExp(`pid ${s.pid}`));
  } finally {
    await killAndWait(s);
    await a.stop();
  }
});

test("registry: a new project is written tmp+rename (new inode), keeping the others", ISO, async () => {
  freshHome();
  const p1 = path.join(HOME, "proj-reg1");
  const p2 = path.join(HOME, "proj-reg2");
  let r = await relay({ CLAUDE_PROJECT_DIR: p1 });
  await r.stop();
  const ino1 = fs.statSync(regPath()).ino;
  r = await relay({ CLAUDE_PROJECT_DIR: p2 });
  await r.stop();
  const reg = JSON.parse(fs.readFileSync(regPath(), "utf8"));
  assert.ok(reg[p1] && reg[p2], "both projects registered");
  assert.notStrictEqual(fs.statSync(regPath()).ino, ino1, "rewritten by rename, not truncated in place");
  assert.deepStrictEqual(fs.readdirSync(cacheRoot()).filter((n) => n.endsWith(".tmp")), []);
});

test("registry: an unparseable registry is never written back (no wipe); the relay still runs on profiles/<slug>", ISO, async () => {
  freshHome();
  const p = path.join(HOME, "proj-corrupt");
  fs.mkdirSync(cacheRoot(), { recursive: true });
  fs.writeFileSync(regPath(), '{"half-written": {"slot": 1,');
  const before = { text: fs.readFileSync(regPath(), "utf8"), ino: fs.statSync(regPath()).ino };
  const r = await relay({ CLAUDE_PROJECT_DIR: p });
  try {
    assert.strictEqual((await statusOf(r)).dir, profileOf(p));
  } finally {
    await r.stop();
  }
  assert.strictEqual(fs.readFileSync(regPath(), "utf8"), before.text);
  assert.strictEqual(fs.statSync(regPath()).ino, before.ino);
  fs.rmSync(regPath());
});

test("temp-path project: no registry entry, no profiles/<slug>; an ephemeral profile removed at exit", ISO, async () => {
  freshHome();
  const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "claude-scratch-proj-")); // outside HOME
  const regBefore = fs.existsSync(regPath()) ? fs.readFileSync(regPath(), "utf8") : null;
  const r = await relay({ CLAUDE_PROJECT_DIR: tmpProj });
  let dir;
  try {
    const st = await statusOf(r);
    assert.strictEqual(st.mode, "ephemeral");
    dir = st.dir;
    assert.ok(dir.startsWith(path.join(cacheRoot(), "session-clones") + path.sep), dir);
    assert.ok(fs.existsSync(dir));
  } finally {
    await r.stop();
    fs.rmSync(tmpProj, { recursive: true, force: true });
  }
  assert.ok(!fs.existsSync(dir), "ephemeral profile removed at exit");
  assert.ok(!fs.existsSync(profileOf(tmpProj)), "no profiles/<slug> for a temp project");
  const regAfter = fs.existsSync(regPath()) ? fs.readFileSync(regPath(), "utf8") : null;
  assert.strictEqual(regAfter, regBefore, "registry untouched");
});

test("amendment 5: BROWSER_RELAY_TEST_LAUNCH with a non-temp HOME makes the relay THROW at start — nothing is claimed", ISO, async () => {
  const pool = homeTmp("gate-pool-");
  const child = spawn(process.execPath, [path.join(REPO, "src", "index.js")], {
    env: { ...process.env, HOME: "/nonexistent-relay-test-home", BROWSER_RELAY_TEST_LAUNCH: "1", BROWSER_RELAY_POOL_DIR: pool, BROWSER_RELAY_IDLE_MINUTES: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (c) => { err += c; });
  const exit = await Promise.race([
    new Promise((r) => child.once("exit", (code) => r(code))),
    new Promise((r) => setTimeout(() => r("still-running"), 10000)),
  ]);
  if (exit === "still-running") { child.kill("SIGKILL"); }
  assert.notStrictEqual(exit, "still-running", "the relay must not run");
  assert.notStrictEqual(exit, 0);
  assert.match(err, /BROWSER_RELAY_TEST_LAUNCH/);
  assert.deepStrictEqual(fs.readdirSync(pool), [], "no record, flock or sidecar was created");
});

test("amendment 5: the test hook refuses a profile dir outside the temp HOME", ISO, () => {
  const { assertTestLaunchAllowed } = require("../src/cdp-bridge.js");
  assert.doesNotThrow(() => assertTestLaunchAllowed(homeTmp("gate-ok-")));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gate-outside-"));
  try {
    assert.throws(() => assertTestLaunchAllowed(outside), /not under the temp HOME/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
