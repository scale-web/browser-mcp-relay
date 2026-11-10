#!/usr/bin/env node
// scripts/manual-test-quiet-page.js — live proof for A1 (2026-11-10).
//
// Runs ONE relay from this checkout on a fresh, empty, ephemeral profile (a
// temp-path project: launch-project-isolated.js gives it an unregistered dir
// under session-clones/, removed at exit; no logins, no real profile), then
// drives the two upstream paths that used to activate Brave:
//
//   1. tabs_new https://example.org  → the relay's background tab, then
//      propagateActivePageToUpstream → upstream's FIRST tool call →
//      createToolSessionContext → newPage() (patched site 1)
//   2. navigation_go-to https://example.com (upstream's session page)
//   3. tabs_close of upstream's page, then navigation_go-to https://example.net
//      → ensureSessionPageOpen re-creates the page (patched site 2)
//
// Each step prints its local time, to line up with a `log stream` capture.
// Sit in a full-screen app before the countdown ends and stay there until
// DONE. Success: no Dock "switching to space" line during the run.
//
// Usage: node scripts/manual-test-quiet-page.js [--countdown 20]
// Requires Brave installed. Not part of the unit suite (it launches Brave).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const LAUNCHER = path.join(REPO_ROOT, "launch-project-isolated.js");
const i = process.argv.indexOf("--countdown");
const COUNTDOWN_S = i !== -1 ? Number(process.argv[i + 1]) : 20;
const STEP_TIMEOUT_MS = 90_000;

const stamp = () => new Date().toLocaleTimeString("en-US", { hour12: false });
const say = (m) => process.stdout.write(`[${stamp()}] ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // A temp project dir → an ephemeral, unregistered, unseeded profile.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "a1-quiet-page-"));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("BROWSER_") && !k.startsWith("CLAUDE_CODE_MESSAGING_")) env[k] = v;
  }
  env.CLAUDE_PROJECT_DIR = project;
  const relayLog = path.join(project, "relay-stderr.log");
  const errOut = fs.openSync(relayLog, "a");
  const child = spawn(process.execPath, [LAUNCHER], { cwd: project, env, stdio: ["pipe", "pipe", errOut] });
  say(`relay pid ${child.pid} (stderr → ${relayLog})`);

  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    }
  });
  child.on("exit", (code, sig) => {
    for (const [, p] of pending) p.reject(new Error(`relay exited code=${code} signal=${sig}`));
    pending.clear();
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, STEP_TIMEOUT_MS);
    pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const r = await request("tools/call", { name, arguments: args });
    const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    say(`${name} → ${r.isError ? "ERROR " : ""}${text.replace(/\s+/g, " ").slice(0, 160)}`);
    return { r, text };
  };

  let failed = false;
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "a1-proof", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    await request("tools/list", {});
    for (let s = COUNTDOWN_S; s > 0; s -= 5) { say(`switch to your full-screen app now — starting in ${s}s`); await sleep(Math.min(5, s) * 1000); }

    say("STEP 1 tabs_new https://example.org (Brave launch + upstream's first session page)");
    await call("tabs_new", { url: "https://example.org" });
    await sleep(5000);
    say("STEP 2 navigation_go-to https://example.com (upstream's session page)");
    await call("navigation_go-to", { url: "https://example.com", includeSnapshot: false, includeScreenshot: false });
    await sleep(5000);
    say("STEP 3 close upstream's page, then navigation_go-to https://example.net (page re-created)");
    const { r: listed } = await call("tabs_list", {});
    let pages = [];
    for (const c of listed.content || []) {
      if (c.type !== "text" || !c.text.trim().startsWith("{")) continue; // skip relay notices
      try { pages = JSON.parse(c.text).pages || []; } catch { /* shape printed above */ }
    }
    const idx = Array.isArray(pages) ? pages.findIndex((p) => p && typeof p.url === "string" && p.url.startsWith("https://example.com")) : -1;
    if (idx === -1) {
      say("could not find upstream's example.com tab in tabs_list — step 3 skipped (steps 1–2 still count)");
    } else {
      await call("tabs_close", { index: idx });
      await sleep(2000);
      await call("navigation_go-to", { url: "https://example.net", includeSnapshot: false, includeScreenshot: false });
    }
    await sleep(5000);
    await call("relay_status", {});
  } catch (e) {
    failed = true;
    say(`FAILED: ${e.message}`);
  } finally {
    say("shutting the relay down (it closes its Brave and removes the ephemeral profile)");
    const exited = new Promise((r) => child.once("exit", r));
    child.stdin.end();
    await Promise.race([exited, sleep(15000)]);
    if (child.exitCode === null && child.signalCode === null) { say(`relay ${child.pid} still running — SIGTERM`); child.kill("SIGTERM"); }
    say(`DONE${failed ? " (with a failure — see above and the relay log)" : ""}. Relay log: ${relayLog}`);
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
