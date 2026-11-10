// clone-refresh.test.js — a session clone older than the refresh limit is
// re-seeded from its base before a NEW Brave launches on it (2026-11-10: a
// clone seeded 3.8 days earlier lacked a GHL sign-in made in the base).
// Temp dirs and dummy files only; the process list is a fake `ps`.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pool = require("../src/pool-shared.js");

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const noBraves = () => ({ status: 0, stdout: "  PID COMMAND\n  1 /sbin/launchd\n" });

function put(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root, rel) => fs.existsSync(path.join(root, rel));

/** base = the project's profile now (its Brave may be live); clone = seeded
 *  long ago, then written by its own earlier Brave. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-clone-refresh-"));
  const base = path.join(root, "as-ops");
  const clone = path.join(root, "session-clones", "as-ops-p123-abc");
  put(base, "Local State", "base-state");
  put(base, "Default/Network/Cookies", "base-cookies");
  put(base, "Default/Network/Cookies-wal", "base-wal");
  put(base, "Default/Login Data", "base-logins");
  put(base, "Default/Local Storage/leveldb/000010.log", "base-ls-log");
  put(base, "Default/Local Storage/leveldb/CURRENT", "MANIFEST-000009");
  put(clone, "Local State", "old-state");
  put(clone, "Default/Network/Cookies", "old-cookies");
  put(clone, "Default/Network/Cookies-wal", "old-wal");
  put(clone, "Default/Network/Cookies-shm", "old-shm");
  put(clone, "Default/Login Data", "old-logins");
  put(clone, "Default/Login Data-wal", "old-logins-wal");
  put(clone, "Default/Local Storage/leveldb/000042.log", "old-ls-log");
  put(clone, "Default/Local Storage/leveldb/CURRENT", "MANIFEST-000041");
  put(clone, "Default/Preferences", "clone-prefs");
  return { root, base, clone };
}

function run(f, extra = {}) {
  const logs = [];
  const r = pool.refreshStaleClone({
    cloneDir: f.clone, baseDir: f.base, snapshotAt: NOW - 13 * H, maxAgeMs: 12 * H,
    _now: NOW, _platform: "darwin", _spawnSync: noBraves, log: (m) => logs.push(m), ...extra,
  });
  return { r, logs };
}

test("refreshStaleClone: a clone older than the limit is re-seeded from its base, stale sidecars and storage removed", () => {
  const f = fixture();
  try {
    const { r, logs } = run(f);
    assert.deepStrictEqual(r, { refreshed: true, reason: "refreshed", snapshotAt: NOW });
    assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "base-cookies");
    assert.strictEqual(read(f.clone, "Default/Network/Cookies-wal"), "base-wal");
    assert.strictEqual(read(f.clone, "Local State"), "base-state");
    assert.strictEqual(read(f.clone, "Default/Login Data"), "base-logins");
    assert.ok(!exists(f.clone, "Default/Network/Cookies-shm"), "an old -shm beside the new Cookies must go");
    assert.ok(!exists(f.clone, "Default/Login Data-wal"), "an old -wal the base does not supply must go (SQLite would replay it)");
    assert.deepStrictEqual(fs.readdirSync(path.join(f.clone, "Default/Local Storage/leveldb")).sort(), ["000010.log", "CURRENT"],
      "the storage dir must be the base's, not merged with the clone's old LevelDB files");
    assert.strictEqual(read(f.clone, "Default/Preferences"), "clone-prefs", "files outside the snapshot set stay");
    // The base is read, never written.
    assert.strictEqual(read(f.base, "Default/Network/Cookies"), "base-cookies");
    assert.deepStrictEqual(fs.readdirSync(path.join(f.base, "Default/Local Storage/leveldb")).sort(), ["000010.log", "CURRENT"]);
    assert.strictEqual(logs.length, 1, "one log line per refresh");
    assert.match(logs[0], /refreshed session clone as-ops-p123-abc from as-ops: snapshot age 13\.0h > limit 12\.0h; copied 4\/\d+ files \+ 1\/2 storage dirs, cleared 3 stale/);
    assert.ok(!/base-|old-|cookies"/.test(logs[0]), "no profile contents in the log");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("refreshStaleClone: a fresh clone, a disabled limit and a missing base leave the clone untouched", () => {
  const f = fixture();
  try {
    for (const [extra, reason] of [
      [{ snapshotAt: NOW - 11 * H }, "fresh"],
      [{ maxAgeMs: 0 }, "disabled"],
      [{ baseDir: path.join(f.root, "gone") }, "base missing"],
    ]) {
      const { r, logs } = run(f, extra);
      assert.deepStrictEqual([r.refreshed, r.reason], [false, reason]);
      assert.strictEqual(r.snapshotAt, extra.snapshotAt ?? NOW - 13 * H, "the snapshot time is kept");
      assert.strictEqual(logs.length, 0);
      assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "old-cookies");
      assert.ok(exists(f.clone, "Default/Login Data-wal"));
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("refreshStaleClone: never while a live Brave holds the clone, and not when the process list cannot be read", () => {
  const f = fixture();
  try {
    const live = () => ({ status: 0, stdout: `  PID COMMAND\n  500 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser --user-data-dir=${f.clone} --no-startup-window\n` });
    const failed = () => ({ status: 1, stdout: "", stderr: "" });
    for (const [spawn, reason] of [[live, "live Brave holds the clone"], [failed, "process list unavailable"]]) {
      const { r, logs } = run(f, { _spawnSync: spawn });
      assert.deepStrictEqual([r.refreshed, r.reason], [false, reason]);
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "old-cookies", "nothing may be written under a live Brave");
      assert.ok(exists(f.clone, "Default/Network/Cookies-shm"));
      assert.ok(exists(f.clone, "Default/Local Storage/leveldb/000042.log"));
    }
    // The BASE being live is the normal case (that is why a clone exists): refresh proceeds.
    const baseLive = () => ({ status: 0, stdout: `  PID COMMAND\n  501 brave --user-data-dir=${f.base} --type=browser\n` });
    assert.strictEqual(run(f, { _spawnSync: baseLive }).r.refreshed, true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("refreshStaleClone: a plain-flags clone never receives or loses Login Data", () => {
  const f = fixture();
  try {
    const { r } = run(f, { excludeLoginData: true });
    assert.strictEqual(r.refreshed, true);
    assert.strictEqual(read(f.clone, "Default/Login Data"), "old-logins", "Login Data is not copied in plain-flags mode");
    assert.ok(exists(f.clone, "Default/Login Data-wal"), "and its sidecars are not touched");
    assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "base-cookies");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("cloneRefreshMaxAgeMs: 12 h by default, overridable (local-config/env key), 0 disables, junk falls back", () => {
  assert.strictEqual(pool.CLONE_REFRESH_HOURS, 12);
  assert.strictEqual(pool.cloneRefreshMaxAgeMs({}), 12 * H);
  assert.strictEqual(pool.cloneRefreshMaxAgeMs({ BROWSER_RELAY_CLONE_REFRESH_HOURS: "" }), 12 * H);
  assert.strictEqual(pool.cloneRefreshMaxAgeMs({ BROWSER_RELAY_CLONE_REFRESH_HOURS: "2.5" }), 2.5 * H);
  assert.strictEqual(pool.cloneRefreshMaxAgeMs({ BROWSER_RELAY_CLONE_REFRESH_HOURS: "0" }), 0);
  assert.strictEqual(pool.cloneRefreshMaxAgeMs({ BROWSER_RELAY_CLONE_REFRESH_HOURS: "soon" }), 12 * H);
  assert.strictEqual(pool.cloneRefreshMaxAgeMs({ BROWSER_RELAY_CLONE_REFRESH_HOURS: "-1" }), 12 * H);
});

test("index.js passes the plain-flags mode and the IndexedDB setting to the clone refresh, as to the start snapshot", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
  const call = src.slice(src.indexOf("pool.refreshStaleClone({"), src.indexOf("cloneSnapshotAt = r.snapshotAt"));
  assert.match(call, /excludeLoginData:\s*plain,/);
  assert.match(call, /includeIndexedDB,/);
  assert.match(call, /maxAgeMs:\s*pool\.cloneRefreshMaxAgeMs\(RELAY_ENV\)/);
});
