// challenge-clicks.test.js — the shared challenge_click count (spec v8 §5.6
// (8), review r7 #8, r8 #4): one click per host per 10 min across every
// plain-flags relay — a second process and a restart included.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { createClickCounter, FILE_NAME, LOCK_NAME, WINDOW_MS } = require("../src/challenge-clicks.js");

const SRC = path.resolve(__dirname, "..", "src", "challenge-clicks.js");
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-clicks-"));

function claimInChild(dir, host) {
  const code = `const { createClickCounter } = require(${JSON.stringify(SRC)});
    process.stdout.write(JSON.stringify(createClickCounter({ root: ${JSON.stringify(dir)} }).claim(${JSON.stringify(host)}, "CHILD")));`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 20000 });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("one click per host: the first is spent, the second refused; another host has its own", () => {
  const dir = root();
  const c = createClickCounter({ root: dir });
  assert.strictEqual(c.spent("go.example.com"), false);
  assert.strictEqual(c.claim("go.example.com", "L").ok, true);
  assert.strictEqual(c.spent("GO.example.com."), true, "host normalised");
  assert.strictEqual(c.count("go.example.com"), 1);
  const second = c.claim("go.example.com", "L");
  assert.deepStrictEqual([second.ok, /last 10 min/.test(second.reason)], [false, true]);
  assert.strictEqual(c.claim("www.other.example", "L").ok, true);
  assert.strictEqual((fs.statSync(path.join(dir, FILE_NAME)).mode & 0o777).toString(8), "600");
  assert.ok(!fs.readFileSync(path.join(dir, FILE_NAME), "utf8").includes("value"), "host → time (+ lane) only");
});

test("r7 #8: a second plain-flags relay PROCESS and a relay RESTART see the spent click (the count is a file, not memory)", () => {
  const dir = root();
  assert.strictEqual(createClickCounter({ root: dir }).claim("go.example.com", "A").ok, true);
  const child = claimInChild(dir, "go.example.com");
  assert.strictEqual(child.ok, false, "a second process is refused");
  const restarted = createClickCounter({ root: dir }); // a new relay: no memory of the first
  assert.strictEqual(restarted.claim("go.example.com", "A").ok, false, "a restart is refused");
  assert.strictEqual(claimInChild(dir, "fresh.example.com").ok, true, "the child claims a fresh host");
  assert.strictEqual(restarted.spent("fresh.example.com"), true, "… and this process sees it");
});

test("after 10 min the host's click is available again; old entries are pruned", () => {
  const dir = root();
  let now = 1_000_000;
  const c = createClickCounter({ root: dir, now: () => now });
  assert.strictEqual(c.claim("a.example").ok, true);
  now += WINDOW_MS - 1;
  assert.strictEqual(c.claim("a.example").ok, false);
  now += 2;
  assert.strictEqual(c.spent("a.example"), false);
  assert.strictEqual(c.claim("b.example").ok, true);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), "utf8"))), ["b.example"]);
});

test("fail closed: an unreadable count file refuses (and reads as spent)", () => {
  const dir = root();
  fs.writeFileSync(path.join(dir, FILE_NAME), "{not json");
  const c = createClickCounter({ root: dir });
  const r = c.claim("a.example");
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unreadable/);
  assert.strictEqual(c.spent("a.example"), true);
});

test("r8 #4: its OWN lock file (not the slot's .mcp-relay.flock); contended past the bounded wait → refused", { skip: process.platform !== "darwin" ? "kernel lock is darwin-only" : false }, async () => {
  const dir = root();
  const holder = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const fd = fs.openSync(${JSON.stringify(path.join(dir, LOCK_NAME))}, fs.constants.O_CREAT | fs.constants.O_RDWR | 0x20 | fs.constants.O_NONBLOCK, 0o600);
    process.stdout.write("HELD\\n");
    setTimeout(() => process.exit(0), 4000);`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => holder.stdout.once("data", r));
  try {
    const c = createClickCounter({ root: dir, waitMs: 200 });
    const r = c.claim("a.example");
    assert.deepStrictEqual([r.ok, /busy/.test(r.reason)], [false, true]);
    assert.ok(!fs.existsSync(path.join(dir, FILE_NAME)), "nothing written");
    assert.ok(!fs.existsSync(path.join(dir, ".mcp-relay.flock")));
  } finally { holder.kill("SIGKILL"); }
});
