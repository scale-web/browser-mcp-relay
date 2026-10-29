#!/usr/bin/env node
// scripts/run-tests.js — cross-shell test runner.
//
// `node --test test/*.test.js test/**/*.test.js` works in bash but FAILS on
// Windows + PowerShell because pwsh doesn't expand globs (it passes the
// literal string `test/*.test.js` to node, which then can't find it). The
// CI runner uses pwsh, which broke `npm test` on Windows even though it
// worked in git-bash locally.
//
// This script does the glob expansion in JS — finds every `*.test.js` file
// under `test/` recursively, then spawns `node --test <files...>` with the
// expanded list. Cross-shell, no extra deps.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TEST_DIR = path.resolve(__dirname, "..", "test");

function findTestFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      out.push(full);
    }
  }
  return out;
}

const files = findTestFiles(TEST_DIR);
if (files.length === 0) {
  console.error(`[run-tests] no *.test.js files found under ${TEST_DIR}`);
  process.exit(1);
}

// Forward any extra CLI args (e.g. `--test-reporter spec`) through.
const extraArgs = process.argv.slice(2);
// POSIX: own process group, so the watchdog can kill the per-file test
// processes too (node --test runs each file in a child); the terminal's signals
// no longer reach that group, so they are forwarded below. Windows has no
// process groups for kill(): keep the plain child there, as before.
const GROUP = process.platform !== "win32";
const child = spawn(process.execPath, ["--test", ...extraArgs, ...files], {
  stdio: "inherit",
  detached: GROUP,
  // Match the user's terminal — no color stripping etc.
});

// A test that starves its event loop cannot fail by its own timeout (those are
// timers too), so a hang would stall the run forever: kill it and fail instead.
const SIGNAL_NUMS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGQUIT: 3 };
const kill = (sig) => {
  try { if (GROUP) process.kill(-child.pid, sig); else child.kill(sig); } catch { /* already gone */ }
};
const watchdog = setTimeout(() => {
  console.error("[run-tests] no result after 10 minutes — a test is hung; killing the run");
  kill("SIGKILL");
}, 10 * 60 * 1000);
let forwarded = null; // a signal the user sent: exit as if it had killed us
if (GROUP) {
  for (const sig of Object.keys(SIGNAL_NUMS)) process.on(sig, () => { forwarded = sig; kill(sig); });
}

child.on("exit", (code, signal) => {
  clearTimeout(watchdog);
  const sig = forwarded || signal;
  if (sig) {
    // Re-raise the signal as POSIX-style exit code.
    const sigNum = SIGNAL_NUMS[sig];
    process.exit(sigNum ? 128 + sigNum : 1);
  }
  process.exit(code ?? 0);
});
child.on("error", (e) => {
  console.error("[run-tests] failed to spawn node --test:", e.message);
  process.exit(1);
});
