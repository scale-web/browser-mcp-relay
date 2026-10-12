// prune-registry.test.js — the one-time prune (spec v4 §1e) against a fake
// cache root under the harness's temp HOME. Never against real data.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isolated, SKIP_MSG, homeTmp, claimHolder, killAndWait, REPO } = require("./helpers/isolation.js");

const ISO = { skip: !isolated() ? SKIP_MSG : (process.platform !== "darwin" ? "darwin" : false), timeout: 60000 };

function listing(root) {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      out[path.relative(root, p)] = `${st.ino}:${st.mtimeMs}`;
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

function fixture() {
  // Its own home (test files run in parallel; never the shared cache root).
  const home = homeTmp("prune-home-");
  const cacheRoot = path.join(home, "Library", "Caches", "browser-mcp-relay");
  const profiles = path.join(cacheRoot, "profiles");
  const tmpA = path.join(os.tmpdir(), "tlt-abc"); // temp-path project keys (never created)
  const tmpB = "/private/tmp/claude-501/scratchpad";
  const real = path.join(home, "Documents", "real-project");
  const mk = (slug, { cookies = false } = {}) => {
    const d = path.join(profiles, slug);
    fs.mkdirSync(path.join(d, "Default", "Network"), { recursive: true });
    if (cookies) fs.writeFileSync(path.join(d, "Default", "Network", "Cookies"), "fake");
    return d;
  };
  const dirs = {
    tempOnly: mk("tlt-abc"),
    tempWithCookies: mk("scratchpad", { cookies: true }),
    realProj: mk("real-project", { cookies: true }),
    noKey: mk("orphan-no-key"),
    tempBusy: mk("busy-temp"),
  };
  const reg = {
    [tmpA]: { slot: 1, slug: "tlt-abc", dir: dirs.tempOnly },
    [tmpB]: { slot: 2, slug: "scratchpad", dir: dirs.tempWithCookies },
    [real]: { slot: 3, slug: "real-project", dir: dirs.realProj },
    [path.join(os.tmpdir(), "busy-temp")]: { slot: 4, slug: "busy-temp", dir: dirs.tempBusy },
  };
  fs.writeFileSync(path.join(cacheRoot, "project-registry.json"), JSON.stringify(reg, null, 2));
  return { home, cacheRoot, dirs, reg, tmpA, tmpB, real };
}

function run(f, args = []) {
  return spawnSync(process.execPath, [path.join(REPO, "scripts", "prune-registry.js"), ...args], { encoding: "utf8", env: { ...process.env, HOME: f.home } });
}

test("prune-registry: the default is a DRY RUN — nothing on disk changes", ISO, () => {
  const f = fixture();
  const before = listing(f.cacheRoot);
  const r = run(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY RUN/);
  assert.deepStrictEqual(listing(f.cacheRoot), before);
});

test("prune-registry --apply: backs up, drops temp keys, removes only temp-only cookieless dirs, under each dir's flock", ISO, async () => {
  const f = fixture();
  const holder = claimHolder(f.dirs.tempBusy); // a live relay holds this one
  try {
    await holder.waitLine(/^CLAIMED/);
    const r = run(f, ["--apply"]);
    assert.strictEqual(r.status, 0, r.stderr);
    const reg = JSON.parse(fs.readFileSync(path.join(f.cacheRoot, "project-registry.json"), "utf8"));
    assert.deepStrictEqual(Object.keys(reg), [f.real], "only the real project's key remains");
    const backups = fs.readdirSync(f.cacheRoot).filter((n) => n.startsWith("project-registry.json.bak-"));
    assert.strictEqual(backups.length, 1);
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.cacheRoot, backups[0]), "utf8"))).length, 4, "the backup is the full original");
    assert.ok(!fs.existsSync(f.dirs.tempOnly), "temp-only, no cookies → removed");
    assert.ok(fs.existsSync(f.dirs.tempWithCookies), "has cookies → kept, listed for a human");
    assert.ok(fs.existsSync(f.dirs.realProj));
    assert.ok(fs.existsSync(f.dirs.noKey), "no key maps to it → kept, listed for a human");
    assert.ok(fs.existsSync(f.dirs.tempBusy), "held by a live relay → skipped");
    assert.match(r.stdout, /skipped busy/);
    assert.match(r.stdout, /holds cookies/);
    assert.match(r.stdout, /no registry key maps to it/);
  } finally {
    await killAndWait(holder.child);
  }
});
