// session-clones.test.js — coverage for the 2026-07-06 reconnect fixes:
//   - boundary-aware --user-data-dir matching (prefix collisions)
//   - pid-start-time lock hardening (pid-reuse detection)
//   - tryClaimDir / claimSlot POOL_BUSY contract
//   - claimSlotWithRetry retry + ephemeral session-clone fallback
//   - gcSessionClones
//   - findAttachableBrave / extractDebugPort
//   - PORT_BASE / PORT_SCAN_END consts
//   - cdp-bridge attachBrave export + attach-aware attachWithCleanupOnError

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pool = require("../src/pool-shared.js");
const processShim = require("../src/process-shim.js");

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ───── port consts ─────

test("PORT_BASE / PORT_SCAN_END are exported and sane", () => {
  assert.strictEqual(pool.PORT_BASE, 9333);
  assert.ok(pool.PORT_SCAN_END > pool.PORT_BASE);
  assert.ok(pool.PORT_SCAN_END >= 9349, "range must cover 12 wrapper slots + headroom");
});

// ───── commandHasUserDataDir ─────

test("commandHasUserDataDir matches bare dir at end-of-line and before whitespace", () => {
  assert.ok(pool.commandHasUserDataDir("brave --user-data-dir=/a/b", "/a/b"));
  assert.ok(pool.commandHasUserDataDir("brave --user-data-dir=/a/b --type=utility", "/a/b"));
});

test("commandHasUserDataDir matches quoted dir", () => {
  assert.ok(pool.commandHasUserDataDir('brave.exe --user-data-dir="C:\\pool\\slot-1" --foo', "C:\\pool\\slot-1"));
});

test("commandHasUserDataDir does NOT match a path-prefix of another profile dir", () => {
  // The exact collision session clones would have hit with substring matching:
  // base dir "/profiles/as-ops" vs clone "/profiles/as-ops-sessions/p1".
  assert.strictEqual(
    pool.commandHasUserDataDir("brave --user-data-dir=/profiles/as-ops-sessions/p1", "/profiles/as-ops"),
    false,
  );
});

test("findBraveProcessesForDir is boundary-aware (prefix dir no longer matches)", () => {
  const stdout = [
    "111|brave --user-data-dir=/pool/slot-1 --type=renderer",
    "222|brave --user-data-dir=/pool/slot-1-clone --type=renderer",
    "333|other-process",
  ].join("\r\n");
  assert.deepStrictEqual(pool.findBraveProcessesForDir(stdout, "/pool/slot-1"), [111]);
  assert.deepStrictEqual(pool.findBraveProcessesForDir(stdout, "/pool/slot-1-clone"), [222]);
});

// ───── extractDebugPort ─────

test("extractDebugPort pulls the port, rejects 0 and absent", () => {
  assert.strictEqual(pool.extractDebugPort("brave --remote-debugging-port=9340 --x"), 9340);
  assert.strictEqual(pool.extractDebugPort("brave --remote-debugging-port=0"), null);
  assert.strictEqual(pool.extractDebugPort("brave --headless"), null);
  assert.strictEqual(pool.extractDebugPort(""), null);
  assert.strictEqual(pool.extractDebugPort(null), null);
});

// ───── getPidStartTime ─────

test("getPidStartTime returns a stable non-empty string for our own pid (POSIX)", (t) => {
  if (process.platform === "win32") return t.skip("POSIX-only assertion");
  const a = processShim.getPidStartTime(process.pid);
  const b = processShim.getPidStartTime(process.pid);
  assert.ok(typeof a === "string" && a.length > 0, `expected lstart string, got ${a}`);
  assert.strictEqual(a, b, "start time must be stable across calls");
});

test("getPidStartTime returns null for a dead/invalid pid", () => {
  assert.strictEqual(processShim.getPidStartTime(-1), null);
  assert.strictEqual(processShim.getPidStartTime(2 ** 30), null);
});

// ───── record predicate (was lockHeldByLiveProcess) ─────
// Spec v4 §1a replaced the pidStartTime string compare (local time in an
// unknown zone — H2's bug) with a TZ-free rule; these pin the new one. The
// full matrix lives in test/profile-lock.test.js.
const profileLock = require("../src/profile-lock.js");

function recordIn(dir, meta) {
  fs.writeFileSync(path.join(dir, ".mcp-wrapper-lock"), typeof meta === "string" ? meta : JSON.stringify(meta));
  return profileLock.readRecord(dir);
}

test("record predicate: dead pid → not held; unparseable → held only while younger than 10 s", () => {
  const dir = tmpdir("relay-lock-");
  assert.strictEqual(profileLock.recordHeld(recordIn(dir, { pid: 2 ** 30 })).held, false);
  const rec = recordIn(dir, "{not json");
  assert.strictEqual(profileLock.recordHeld(rec).held, true, "young unparseable → a writer may be mid-write");
  assert.strictEqual(profileLock.recordHeld(rec, { _now: Date.now() + 11_000 }).held, false);
});

test("record predicate: live legacy holder → held; a legacy record older than its pid's start → recycled", () => {
  const dir = tmpdir("relay-lock-");
  const startedAt = new Date().toISOString(); // this process started before now
  assert.strictEqual(profileLock.recordHeld(recordIn(dir, { pid: process.pid, startedAt })).held, true);
  const before = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  assert.strictEqual(profileLock.recordHeld(recordIn(dir, { pid: process.pid, startedAt: before })).held, false,
    "a record written a year before this pid started belongs to a dead owner whose pid was recycled");
});

test("record predicate: a legacy pidStartTime from ANOTHER time zone no longer reads as recycled", (t) => {
  if (process.platform === "win32") return t.skip("relies on POSIX lstart probe");
  const dir = tmpdir("relay-lock-");
  // The H2 case: pidStartTime written in a different TZ never equals ps's
  // current-TZ string. The old rule called this live holder "recycled".
  const rec = recordIn(dir, { pid: process.pid, startedAt: new Date().toISOString(), pidStartTime: "Thu Jan  1 00:00:00 1970" });
  assert.strictEqual(profileLock.recordHeld(rec).held, true);
});

// ───── tryClaimDir ─────

test("tryClaimDir claims a fresh dir, blocks a second claim, release frees it", () => {
  const dir = path.join(tmpdir("relay-claim-"), "slot");
  const first = pool.tryClaimDir(dir);
  assert.ok(first, "first claim must succeed");
  assert.strictEqual(first.dir, dir);
  const meta = JSON.parse(fs.readFileSync(first.lock.path, "utf8"));
  assert.strictEqual(meta.pid, process.pid);
  assert.strictEqual(meta.v, 2, "v2 record (spec v4 §1a)");
  assert.ok(Number.isFinite(meta.pidStartEpoch), "record carries pidStartEpoch for pid-reuse detection");
  assert.ok(!("pidStartTime" in meta), "no pidStartTime: its local-time string was the TZ bug");

  assert.strictEqual(pool.tryClaimDir(dir), null, "second claim must return null while lock held");

  first.release();
  const again = pool.tryClaimDir(dir);
  assert.ok(again, "claim after release must succeed");
  again.release();
});

test("tryClaimDir clears a stale (dead-pid) lock and claims", () => {
  const dir = path.join(tmpdir("relay-claim-"), "slot");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".mcp-wrapper-lock"), JSON.stringify({ pid: 2 ** 30 }));
  const claimed = pool.tryClaimDir(dir);
  assert.ok(claimed, "stale lock must be cleared and dir claimed");
  claimed.release();
});

// ───── claimSlotWithRetry ─────

function poolBusyError() {
  const e = new Error("pool exhausted");
  e.code = "POOL_BUSY";
  return e;
}

test("claimSlotWithRetry retries POOL_BUSY then returns the successful claim", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await pool.claimSlotWithRetry({
    retries: 5,
    delayMs: 7,
    _sleep: async (ms) => { sleeps.push(ms); },
    _claimSlot: () => {
      calls++;
      if (calls < 3) throw poolBusyError();
      return { dir: "/fake/slot", lock: { fd: -1, path: "/fake/slot/.lock" }, role: "default", release: () => {} };
    },
  });
  assert.strictEqual(result.dir, "/fake/slot");
  assert.strictEqual(result.ephemeral, false);
  assert.strictEqual(result.baseDir, null);
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(sleeps, [7, 7], "one sleep before each retry attempt");
});

test("claimSlotWithRetry does NOT retry non-POOL_BUSY errors", async () => {
  let calls = 0;
  await assert.rejects(
    pool.claimSlotWithRetry({
      retries: 5,
      _sleep: async () => {},
      _claimSlot: () => { calls++; throw new Error("config problem"); },
    }),
    /config problem/,
  );
  assert.strictEqual(calls, 1);
});

test("claimSlotWithRetry falls back to an ephemeral session clone when pool stays busy", async () => {
  const root = tmpdir("relay-clones-");
  const result = await pool.claimSlotWithRetry({
    retries: 2,
    delayMs: 1,
    root,
    _sleep: async () => {},
    _claimSlot: () => { throw poolBusyError(); },
  });
  try {
    assert.strictEqual(result.ephemeral, true);
    assert.ok(result.baseDir, "clone must record its base dir");
    assert.ok(result.dir.startsWith(root + path.sep), `clone dir must live under the clones root (got ${result.dir})`);
    assert.ok(result.dir.includes(`-p${process.pid}-`), "clone dir must be keyed by owner pid");
    assert.ok(fs.existsSync(path.join(result.dir, ".mcp-wrapper-lock")), "clone must be locked");
    // Clone dir must never be a path-prefix relative of the base dir.
    assert.ok(!result.dir.startsWith(result.baseDir), "clone must not nest under the base profile");
    assert.strictEqual(typeof result.cleanup, "function", "ephemeral claim must expose cleanup()");
  } finally {
    result.release();
  }
  // release() is a NO-OP for ephemeral claims: the lock must survive until
  // cleanup() (post-closeBrave) so a sibling's GC never sees a lockless dir
  // while this clone's Brave is still closing.
  assert.ok(fs.existsSync(path.join(result.dir, ".mcp-wrapper-lock")), "release() must NOT free an ephemeral lock");
  assert.ok(fs.existsSync(result.dir), "release() must NOT remove the clone dir");
  result.cleanup();
  assert.ok(!fs.existsSync(result.dir), "cleanup() must release the lock and remove the clone dir");
});

test("claimSlotWithRetry with allowClone=false rethrows POOL_BUSY after retries", async () => {
  await assert.rejects(
    pool.claimSlotWithRetry({
      retries: 1,
      allowClone: false,
      _sleep: async () => {},
      _claimSlot: () => { throw poolBusyError(); },
    }),
    (e) => e.code === "POOL_BUSY",
  );
});

// ───── gcSessionClones ─────

function backdate(dir, ms = 120_000) {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(dir, t, t);
}

test("gcSessionClones removes dead-owner clones, keeps live ones and young lockless ones", () => {
  const root = tmpdir("relay-gc-");

  // Spec v4 §1a: EVERY clone younger than the grace is skipped (its age is
  // read before its flock is opened), so the dead and live ones are aged.
  const dead = path.join(root, "proj-p999999-aaa");
  fs.mkdirSync(dead, { recursive: true });
  fs.writeFileSync(path.join(dead, ".mcp-wrapper-lock"), JSON.stringify({ pid: 2 ** 30 }));
  backdate(dead);

  const live = path.join(root, "proj-p1-bbb");
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, ".mcp-wrapper-lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  backdate(live);

  const young = path.join(root, "proj-p2-ccc"); // no lock yet — mid-creation
  fs.mkdirSync(young, { recursive: true });

  const removed = pool.gcSessionClones({ root, graceMs: 60_000 });
  assert.strictEqual(removed, 1);
  assert.ok(!fs.existsSync(dead), "dead-owner clone must be removed");
  assert.ok(fs.existsSync(live), "live-owner clone must survive");
  assert.ok(fs.existsSync(young), "young lockless dir must survive the grace period");

  // With grace 0, the lockless dir is treated as leftover junk.
  backdate(young, 1000);
  const removed2 = pool.gcSessionClones({ root, graceMs: 0 });
  assert.strictEqual(removed2, 1);
  assert.ok(!fs.existsSync(young));
  assert.ok(fs.existsSync(live), "live clone must still survive");
});

test("gcSessionClones keeps a dead-lock clone while a live Brave still holds it", () => {
  const root = tmpdir("relay-gc-");
  const dir = path.join(root, "proj-p888888-ddd");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".mcp-wrapper-lock"), JSON.stringify({ pid: 2 ** 30 })); // owner dead
  backdate(dir);
  const removed = pool.gcSessionClones({
    root,
    _platform: "darwin",
    _spawnSync: () => ({ status: 0, stdout: `  PID COMMAND\n  500 brave --user-data-dir=${dir} --type=browser\n` }),
  });
  assert.strictEqual(removed, 0, "live-Brave dir must be kept even with a dead lock owner");
  assert.ok(fs.existsSync(dir));
});

test("gcSessionClones returns 0 when the clones root doesn't exist", () => {
  assert.strictEqual(pool.gcSessionClones({ root: "/definitely/not/a/real/root" }), 0);
});

// ───── findAttachableBrave ─────

function fakePs(lines) {
  // POSIX `ps -eo pid,command -ww` shape.
  return () => ({ status: 0, stdout: "  PID COMMAND\n" + lines.join("\n") + "\n" });
}

test("findAttachableBrave: a legacy fixed-port Brave that itself listens on 127.0.0.1:N is attachable via its ws url", async () => {
  const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const result = await pool.findAttachableBrave("/pool/slot-1", {
    _platform: "darwin",
    _spawnSync: fakePs([
      "  100 /Applications/Brave.app/brave --user-data-dir=/pool/slot-1 --remote-debugging-port=9341 --flag",
    ]),
    _listensOnLoopbackV4: (pid, port) => pid === 100 && port === 9341,
    _fetch: async (url) => {
      assert.ok(url.includes("127.0.0.1:9341/json/version"));
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: `ws://127.0.0.1:9341/devtools/browser/${uuid}` }) };
    },
  });
  assert.deepStrictEqual(result, { pid: 100, port: 9341, wsEndpoint: `ws://127.0.0.1:9341/devtools/browser/${uuid}`, legacy: true });
});

test("findAttachableBrave: a legacy Brave that does NOT itself listen on 127.0.0.1:N is not attachable (F9)", async () => {
  const result = await pool.findAttachableBrave("/pool/slot-1", {
    _platform: "darwin",
    _spawnSync: fakePs(["  100 brave --user-data-dir=/pool/slot-1 --remote-debugging-port=9341"]),
    _listensOnLoopbackV4: () => false, // e.g. it fell back to [::1]:9341
    _fetch: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/browser/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }) }),
  });
  assert.strictEqual(result, null);
});

test("findAttachableBrave ignores pipe-only Braves (no debug port) and other dirs", async () => {
  const result = await pool.findAttachableBrave("/pool/slot-1", {
    _platform: "darwin",
    _spawnSync: fakePs([
      "  100 brave --user-data-dir=/pool/slot-1 --type=renderer",           // no port
      "  101 brave --user-data-dir=/pool/slot-2 --remote-debugging-port=9342", // wrong dir
      "  102 brave --user-data-dir=/pool/slot-1-x --remote-debugging-port=9343", // prefix trap
    ]),
    _listensOnLoopbackV4: () => true,
    _fetch: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9342/devtools/browser/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }) }),
  });
  assert.strictEqual(result, null);
});

test("findAttachableBrave returns null when the CDP probe fails", async () => {
  const result = await pool.findAttachableBrave("/pool/slot-1", {
    _platform: "darwin",
    _spawnSync: fakePs([
      "  100 brave --user-data-dir=/pool/slot-1 --remote-debugging-port=9341",
    ]),
    _listensOnLoopbackV4: () => true,
    _fetch: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.strictEqual(result, null);
});

// ───── cdp-bridge attach exports + attach-aware cleanup ─────

test("cdp-bridge exports attachBrave", () => {
  const bridge = require("../src/cdp-bridge.js");
  assert.strictEqual(typeof bridge.attachBrave, "function");
});

test("closeBrave disconnects (browser.close) for attached handles, keeps context untouched", async () => {
  const { closeBrave } = require("../src/cdp-bridge.js");
  let browserClosed = 0;
  let contextClosed = 0;
  await closeBrave({
    attached: true,
    browser: { close: async () => { browserClosed++; } },
    context: { close: async () => { contextClosed++; } },
  });
  assert.strictEqual(browserClosed, 1);
  assert.strictEqual(contextClosed, 0, "attached close must NOT close the context (kills user pages)");
});

test("attachWithCleanupOnError uses browser.close for attached handles on the error path", async () => {
  const { attachWithCleanupOnError } = require("../src/index.js");
  let browserClosed = 0;
  let contextClosed = 0;
  const launched = {
    attached: true,
    browser: { close: async () => { browserClosed++; } },
    context: { close: async () => { contextClosed++; } },
  };
  await assert.rejects(
    attachWithCleanupOnError(launched, async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.strictEqual(browserClosed, 1);
  assert.strictEqual(contextClosed, 0);
});

// ───── index.js wiring (source-slice, matching the repo's F1-16 style) ─────

test("ensureBrave probes findAttachableBrave BEFORE the reap+launch path", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
  const attachIdx = src.indexOf("pool.findAttachableBrave(dir)");
  const reapIdx = src.indexOf("pool.reapOrphansFor(dir)");
  assert.ok(attachIdx !== -1, "ensureBrave must call pool.findAttachableBrave(dir)");
  assert.ok(reapIdx !== -1, "ensureBrave must still reap non-attachable squatters");
  assert.ok(attachIdx < reapIdx, "attach probe must run before the reap");
});

test("index.js restarts upstream when the CDP endpoint changes after spawn (or Brave is replaced)", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
  assert.ok(/function\s+restartUpstreamIfStale\s*\(/.test(src));
  assert.ok(/restartUpstreamIfStale\(\);/.test(src), "ensureBrave must invoke the restart check");
  assert.ok(/upstreamEndpoint\s*=\s*endpointForChild/.test(src), "spawnUpstream must record the endpoint it was spawned with");
});

test("index.js claims via claimSlotWithRetry (retry + clone fallback), not bare claimSlot", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
  assert.ok(/await\s+pool\.claimSlotWithRetry\(\)/.test(src));
});
