// test/helpers/isolation.js — guards and process helpers for tests that spawn
// processes, take real flocks or launch a real (test) Brave.
//
// Those tests run ONLY under scripts/test-harness.js (npm run test:isolated),
// which sets HOME to a fresh temp dir and snapshots the real state. Outside it
// they skip: isolated() is false.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO = path.resolve(__dirname, "..", "..");

function realOrNull(p) { try { return fs.realpathSync(p); } catch { return null; } }

/** True only under the harness: HOME is the harness's temp dir, under tmpdir. */
function isolated() {
  const marker = process.env.BROWSER_RELAY_TEST_HARNESS_HOME;
  const home = realOrNull(os.homedir());
  const tmp = realOrNull(os.tmpdir());
  if (!marker || !home || !tmp) return false;
  return home === realOrNull(marker) && home.startsWith(tmp + path.sep);
}

const SKIP_MSG = "needs the isolated harness (npm run test:isolated)";

/** A fresh dir under the temp HOME (never the real home). */
function homeTmp(prefix) {
  if (!isolated()) throw new Error("homeTmp outside the harness");
  return fs.mkdtempSync(path.join(os.homedir(), prefix));
}

/** Run `code` in a child node process with this test's env; resolves to
 *  { child, lines, waitLine(re) }. stdout lines are collected. */
function nodeChild(code, { env = {}, args = [] } = {}) {
  const child = spawn(process.execPath, ["-e", code, ...(args.length ? ["--", ...args] : [])], {
    cwd: REPO, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  let buf = "";
  let err = "";
  const waiters = [];
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      lines.push(line);
      for (const w of waiters.slice()) if (w.re.test(line)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(line); }
    }
  });
  child.stderr.on("data", (c) => { err += c; });
  const waitLine = (re, ms = 10000) => new Promise((resolve, reject) => {
    const hit = lines.find((l) => re.test(l));
    if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${re} (stdout: ${lines.join(" | ")}; stderr: ${err.slice(-500)})`)), ms);
    waiters.push({ re, resolve: (l) => { clearTimeout(t); resolve(l); } });
  });
  const exited = new Promise((r) => child.once("exit", (code, sig) => r({ code, sig })));
  return { child, lines, waitLine, exited, stderr: () => err };
}

/** A child that claims `dir` through profile-lock.claimDir and holds it until
 *  killed. Prints CLAIMED or BUSY. */
function claimHolder(dir) {
  return nodeChild(`
    const lock = require(${JSON.stringify(path.join(REPO, "src", "profile-lock.js"))});
    const c = lock.claimDir(${JSON.stringify(dir)});
    console.log(c ? "CLAIMED " + process.pid : "BUSY");
    setInterval(() => {}, 1000);
  `);
}

/** A child that holds ONLY the flock of `dir` (no record) for `ms`, then exits. */
function flockHolder(dir, ms) {
  return nodeChild(`
    const lock = require(${JSON.stringify(path.join(REPO, "src", "profile-lock.js"))});
    const h = lock.openFlock(${JSON.stringify(dir)});
    console.log(h ? "HELD" : "EAGAIN");
    setTimeout(() => process.exit(0), ${ms});
  `);
}

/** A live process to stand in for a pre-change relay (`sleep`). */
function sleeper(seconds = 30) {
  const child = spawn("sleep", [String(seconds)], { stdio: "ignore" });
  return child;
}

async function killAndWait(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((r) => child.once("exit", r));
  try { child.kill("SIGKILL"); } catch { /* gone */ }
  await done;
}

module.exports = { REPO, isolated, SKIP_MSG, homeTmp, nodeChild, claimHolder, flockHolder, sleeper, killAndWait };
