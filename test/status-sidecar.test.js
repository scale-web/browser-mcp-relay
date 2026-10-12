// status-sidecar.test.js — spec v4 §1c: the sidecar's write discipline and
// relay_status's view of a base holder.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StatusSidecar, describeHolder, modeAnnouncement, SIDECAR_NAME } = require("../src/status-sidecar.js");

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-")); }

test("sidecar: activity is written at most once per interval; state changes are written immediately; 0600, tmp+rename", () => {
  const dir = tmp();
  let now = 1_000_000;
  const s = new StatusSidecar({ dir, mode: "base", _now: () => now });
  try {
    s.flush(); // initial write (start() without the timer)
    s.dirty = true; s.flush();
    const p = path.join(dir, SIDECAR_NAME);
    const ino0 = fs.statSync(p).ino;
    assert.strictEqual(fs.statSync(p).mode & 0o777, 0o600);
    now += 10_000;
    s.update({ lastToolCallAt: "t1" });
    assert.strictEqual(JSON.parse(fs.readFileSync(p, "utf8")).lastToolCallAt, null, "throttled: not written within the minute");
    s.update({ cdpPort: 4242, braveAlive: true }, { force: true });
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(d.cdpPort, 4242, "a Brave state change is written at once");
    assert.strictEqual(d.lastToolCallAt, "t1", "and carries the pending activity");
    assert.notStrictEqual(fs.statSync(p).ino, ino0, "replaced by rename, never truncated in place");
    now += 61_000;
    s.update({ lastToolCallAt: "t2" });
    assert.strictEqual(JSON.parse(fs.readFileSync(p, "utf8")).lastToolCallAt, "t2", "written once the minute has passed");
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
  } finally {
    s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("relay_status holder view: a legacy holder's activity is 'unknown (pre-change relay)'; a v2 holder's comes from its sidecar", () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, ".mcp-wrapper-lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const legacy = describeHolder(dir);
    assert.strictEqual(legacy.format, "legacy (pre-change relay)");
    assert.strictEqual(legacy.lastToolCallAt, "unknown (pre-change relay)");
    assert.strictEqual(legacy.alive, true);
    const lock = require("../src/profile-lock.js");
    fs.writeFileSync(path.join(dir, ".mcp-wrapper-lock"), JSON.stringify({ v: 2, pid: process.pid, pidStartEpoch: lock.procStartEpoch(process.pid), startedAt: "x", sessionId: "S" }));
    fs.writeFileSync(path.join(dir, SIDECAR_NAME), JSON.stringify({ pid: process.pid, lastToolCallAt: "2026-10-12T00:00:00Z", braveAlive: true }));
    const v2 = describeHolder(dir);
    assert.strictEqual(v2.format, "v2");
    assert.strictEqual(v2.lastToolCallAt, "2026-10-12T00:00:00Z");
    assert.strictEqual(v2.sessionId, "S");
    fs.writeFileSync(path.join(dir, SIDECAR_NAME), JSON.stringify({ pid: 1, lastToolCallAt: "stale" }));
    assert.strictEqual(describeHolder(dir).lastToolCallAt, null, "a sidecar left by another pid is ignored");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mode announcements name the mode in the first 80 chars", () => {
  for (const m of ["base", "clone", "ephemeral"]) {
    const t = modeAnnouncement(m, "some-very-long-project-slug-name-for-testing");
    assert.match(t.slice(0, 80), /BASE|CLONE|TEMPORARY/);
  }
});
