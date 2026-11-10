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
  // The base changed after the clone's last seed (NOW - 13 h) unless a test says otherwise.
  setBaseCookieTimes(base, NOW - 1 * H, NOW - 1 * H);
  return { root, base, clone };
}

/** mtimes (ms) of the base's Cookies DB and its -wal. */
function setBaseCookieTimes(base, mainMs, walMs) {
  fs.utimesSync(path.join(base, "Default/Network/Cookies"), mainMs / 1000, mainMs / 1000);
  if (walMs !== null) fs.utimesSync(path.join(base, "Default/Network/Cookies-wal"), walMs / 1000, walMs / 1000);
}

/** Run `fn` with fs[name] replaced by `fake(real, ...args)`. */
async function withFs(name, fake, fn) {
  const real = fs[name];
  fs[name] = (...args) => fake(real, ...args);
  try { return await fn(); } finally { fs[name] = real; }
}

/** Run `fn` with fs.copyFileSync replaced by `fake(real, src, dst)`. */
async function withCopy(fake, fn) {
  const real = fs.copyFileSync;
  fs.copyFileSync = (s, d, ...rest) => fake(real, s, d, ...rest);
  try { return await fn(); } finally { fs.copyFileSync = real; }
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
    assert.match(logs[0], /refreshed session clone as-ops-p123-abc from as-ops: snapshot age 13\.0h > limit 12\.0h; copied 4\/\d+ files \+ 1\/2 storage dirs, cleared 4 stale/);
    assert.ok(!/base-|old-|cookies"/.test(logs[0]), "no profile contents in the log");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("refreshStaleClone: skips (keeping the snapshot time) when the base's cookie DB has not changed since the seed; a newer -wal alone counts", () => {
  const f = fixture();
  try {
    setBaseCookieTimes(f.base, NOW - 14 * H, NOW - 14 * H);
    const { r, logs } = run(f);
    assert.deepStrictEqual(r, { refreshed: false, reason: "base not newer", snapshotAt: NOW - 13 * H });
    assert.strictEqual(logs.length, 0);
    assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "old-cookies", "a sign-in made in the clone must survive");
    assert.ok(exists(f.clone, "Default/Network/Cookies-shm"));
    assert.ok(exists(f.clone, "Default/Local Storage/leveldb/000042.log"));
    // Exactly at the seed time is not newer either.
    setBaseCookieTimes(f.base, NOW - 13 * H, NOW - 13 * H);
    assert.strictEqual(run(f).r.reason, "base not newer");
    // The main DB unchanged but its -wal written since: the base changed.
    setBaseCookieTimes(f.base, NOW - 14 * H, NOW - 2 * H);
    const r2 = run(f).r;
    assert.deepStrictEqual([r2.refreshed, r2.snapshotAt], [true, NOW]);
    assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "base-cookies");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("refreshStaleClone: a base -wal that vanishes between the check and the copy leaves no stale -wal in the clone", async () => {
  const f = fixture();
  try {
    const baseWal = path.join(f.base, "Default/Network/Cookies-wal");
    const { r } = await withCopy((real, s, d) => {
      if (s === baseWal) { fs.unlinkSync(baseWal); const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return real(s, d);
    }, () => run(f));
    assert.deepStrictEqual([r.refreshed, r.snapshotAt], [true, NOW], "the main DB copied, so this is a refresh");
    assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "base-cookies");
    assert.ok(!exists(f.clone, "Default/Network/Cookies-wal"), "the clone's OLD -wal must not survive beside the new DB");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("refreshStaleClone: a replaced DB that fails to copy is INCOMPLETE — left old but consistent, and the seed time still advances", async () => {
  const f = fixture();
  try {
    const baseCookies = path.join(f.base, "Default/Network/Cookies");
    const { r, logs } = await withCopy((real, s, d) => {
      if (s === baseCookies) { const e = new Error("EIO"); e.code = "EIO"; throw e; }
      return real(s, d);
    }, () => run(f));
    assert.deepStrictEqual(r, { refreshed: false, reason: "incomplete", snapshotAt: NOW });
    assert.match(logs.join(""), /INCOMPLETE: 1 DB\(s\) and 0 storage dir\(s\) failed to copy \(Cookies\)/);
    assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "old-cookies");
    assert.ok(!exists(f.clone, "Default/Network/Cookies-wal"), "no -wal (old or the base's) beside the old DB");
    assert.ok(!exists(f.clone, "Default/Network/Cookies-shm"));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("refreshStaleClone: a copy failure that persists does not re-seed the clone at the next launch (a sign-in made in it in between survives)", async () => {
  const f = fixture();
  try {
    const baseLogins = path.join(f.base, "Default/Login Data");
    const failLogins = (real, s, d) => {
      if (s === baseLogins) { const e = new Error("EACCES"); e.code = "EACCES"; throw e; }
      return real(s, d);
    };
    const first = await withCopy(failLogins, () => run(f));
    assert.deepStrictEqual([first.r.reason, first.r.snapshotAt], ["incomplete", NOW]);
    assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "base-cookies", "what did copy, copied");
    // A sign-in made in the clone's Brave; the base changes too; an hour later Brave relaunches.
    put(f.clone, "Default/Network/Cookies", "clone-signin");
    setBaseCookieTimes(f.base, NOW + 0.5 * H, NOW + 0.5 * H);
    const second = await withCopy(failLogins, () => run(f, { snapshotAt: first.r.snapshotAt, _now: NOW + 1 * H }));
    assert.deepStrictEqual([second.r.refreshed, second.r.reason], [false, "fresh"]);
    assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "clone-signin", "the clone's sign-in must survive");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("refreshStaleClone: a storage dir that fails to copy is INCOMPLETE, not a refresh, and follows the same rule", async () => {
  const f = fixture();
  try {
    const baseLs = path.join(f.base, "Default/Local Storage/leveldb");
    const { r, logs } = await withFs("cpSync", (real, s, d, o) => {
      if (s === baseLs) { const e = new Error("ENOSPC"); e.code = "ENOSPC"; throw e; }
      return real(s, d, o);
    }, () => run(f));
    assert.deepStrictEqual(r, { refreshed: false, reason: "incomplete", snapshotAt: NOW });
    assert.match(logs.join(""), /INCOMPLETE: 0 DB\(s\) and 1 storage dir\(s\) failed to copy \(leveldb\)/);
    assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "base-cookies", "the DBs did copy");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("refreshStaleClone: a CLOSED base (no -wal) counts its main cookie DB's time: newer refreshes, older skips", () => {
  const f = fixture();
  try {
    fs.unlinkSync(path.join(f.base, "Default/Network/Cookies-wal"));
    setBaseCookieTimes(f.base, NOW - 14 * H, null);
    assert.strictEqual(run(f).r.reason, "base not newer");
    setBaseCookieTimes(f.base, NOW - 1 * H, null);
    const { r } = run(f);
    assert.deepStrictEqual([r.refreshed, r.snapshotAt], [true, NOW]);
    assert.strictEqual(read(f.clone, "Default/Network/Cookies"), "base-cookies");
    assert.ok(!exists(f.clone, "Default/Network/Cookies-wal"), "the clone's old -wal must not outlive a base that has none");
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
