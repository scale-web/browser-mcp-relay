#!/usr/bin/env node
// scripts/doctor.js — report (and optionally reclaim) the RAM footprint of
// browser-mcp-relay across every session on this machine.
//
//   node scripts/doctor.js                 report only
//   node scripts/doctor.js --close-braves  close ALL relay-owned Braves
//                                          (graceful CDP Browser.close, kill
//                                          fallback). Profiles persist on
//                                          disk — logins survive; open tabs
//                                          are lost.
//
//     ** DO NOT RUN THIS WHILE ANY LANE IS MID-WORK. ** Corrected 2026-08-22:
//     this used to claim "every live session relaunches its Brave on the next
//     tool call". That is only HALF true, and the half that is false is the
//     expensive one. `invalidateBridge` (src/index.js:442) nulls `bridge`, so
//     the relay's OWN tools (tabs_*) do relaunch and self-heal — but it never
//     touches `upstreamChild`, and upstream (browser-devtools-mcp) holds a
//     SEPARATE connectOverCDP connection. Upstream is respawned only by
//     restartUpstreamIfPortChanged() or the idle reaper; the relaunched Brave
//     reuses the same pool slot and therefore the same port, so the port never
//     changes and upstream is never restarted. Result: page tools stay dead
//     against a closed endpoint, unbounded, while tabs_* keep answering — so
//     the session looks healthy and you debug the wrong layer.
//
//     Recovery without a code change: wait for the idle reaper (45 min
//     default), or reconnect the relay. Safe when every lane is idle.
//   node scripts/doctor.js --reap-orphans  close only ORPHANED relay Braves
//                                          (root Brave whose parent relay is
//                                          gone, ppid=1) + zombie relays.
//
// Only touches Braves running on relay-owned profile dirs
// (~/Library/Caches/browser-mcp-relay/profiles|session-clones, legacy
// Brave-Browser-Relay-Pool, repo .browser-data). Never the user's main Brave.

const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const processShim = require("../src/process-shim.js");
const cdpIdentity = require("../src/cdp-identity.js");

const RELAY_DIR_MARKERS = [
  path.join(os.homedir(), "Library", "Caches", "browser-mcp-relay"),
  path.join(os.homedir(), "Library", "Application Support", "BraveSoftware", "Brave-Browser-Relay-Pool"),
  path.resolve(__dirname, "..", ".browser-data"),
];

function ps() {
  const out = execFileSync("ps", ["-eo", "pid,ppid,rss,command", "-ww"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  const rows = [];
  for (const line of out.split("\n").slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], rssMb: +m[3] / 1024, command: m[4] });
  }
  return rows;
}

function userDataDir(cmd) {
  // ps output is unquoted and relay paths contain spaces ("Application
  // Support") — parse to the next flag boundary, not the next space.
  const m = /--user-data-dir=("([^"]+)"|(.+?))(?=\s+--|$)/.exec(cmd);
  return m ? (m[2] || m[3]) : null;
}

function isRelayDir(dir) {
  return !!dir && RELAY_DIR_MARKERS.some((marker) => dir.startsWith(marker));
}

/** Graceful Browser.close — only to an endpoint PROVEN to be this Brave
 *  (spec v4 amendment 8, the attach-first identity checks): a port-0 Brave's
 *  DevToolsActivePort uuid must match /json/version; a legacy fixed-port
 *  Brave must itself listen on 127.0.0.1:<port>. Before this, a Brave that
 *  had fallen back to [::1] (F9) made --reap-orphans send Browser.close to
 *  ANOTHER lane's live Brave on 127.0.0.1:<port>. Unprovable → false, and
 *  the caller falls back to SIGTERM on the right pid. */
async function closeViaCdp(proc, dir, opts = {}) {
  try {
    const ep = await cdpIdentity.resolveBraveEndpoint(proc, dir, { timeoutMs: 1500, ...opts });
    if (!ep) return false;
    const webSocketDebuggerUrl = ep.wsEndpoint;
    const { WebSocket } = require("ws");
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketDebuggerUrl);
      const timer = setTimeout(() => { socket.terminate(); reject(new Error("ws timeout")); }, 3000);
      socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })));
      socket.on("close", () => { clearTimeout(timer); resolve(); });
      socket.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    return true;
  } catch { return false; }
}

async function main() {
  const mode = process.argv.includes("--close-braves") ? "close-braves"
    : process.argv.includes("--reap-orphans") ? "reap-orphans"
    : "report";

  const rows = ps();
  const braves = rows.filter((r) => /brave/i.test(r.command) && isRelayDir(userDataDir(r.command)));
  const relays = rows.filter((r) => /browser-mcp-relay\/(src\/index\.js|launch-project-isolated\.js)/.test(r.command));
  const upstreams = rows.filter((r) => /browser-devtools-mcp\/dist\/index\.js/.test(r.command));

  // Group Brave helpers under their profile dir; the ROOT process of each
  // group is the one whose command carries --remote-debugging-port (main
  // browser process) or, failing that, the lowest pid.
  const groups = new Map();
  for (const b of braves) {
    const dir = userDataDir(b.command);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(b);
  }

  console.log(`relay processes: ${relays.length} (${relays.reduce((s, r) => s + r.rssMb, 0).toFixed(0)} MB)`);
  console.log(`upstream children: ${upstreams.length} (${upstreams.reduce((s, r) => s + r.rssMb, 0).toFixed(0)} MB)`);
  console.log(`relay-owned Braves: ${groups.size} instance(s), ${braves.reduce((s, r) => s + r.rssMb, 0).toFixed(0)} MB total\n`);

  let closed = 0;
  for (const [dir, procs] of groups) {
    const total = procs.reduce((s, r) => s + r.rssMb, 0);
    const root = procs.find((p) => /--remote-debugging-port=/.test(p.command)) ||
      procs.reduce((a, b) => (a.pid < b.pid ? a : b));
    const orphan = root.ppid === 1;
    console.log(`  ${total.toFixed(0).padStart(5)} MB  ${procs.length} procs  ${orphan ? "ORPHAN  " : "        "}${dir}`);

    const shouldClose = mode === "close-braves" || (mode === "reap-orphans" && orphan);
    if (!shouldClose) continue;
    const graceful = await closeViaCdp(root, dir);
    if (!graceful) {
      try { process.kill(root.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    closed++;
    console.log(`         → closed (${graceful ? "CDP Browser.close" : "SIGTERM root pid " + root.pid})`);
  }

  if (mode === "reap-orphans") {
    // Zombie relays: wrapper/relay processes reparented to launchd (their
    // MCP client died without closing stdio — pre-2026-07-16 builds).
    for (const r of relays.filter((x) => x.ppid === 1)) {
      try { process.kill(r.pid, "SIGTERM"); console.log(`  zombie relay pid ${r.pid} → SIGTERM`); } catch { /* gone */ }
    }
  }

  if (mode !== "report") {
    console.log(`\n${closed} Brave instance(s) closed. Profiles persist — sessions relaunch on next tool call.`);
  } else {
    console.log(`\nrun with --close-braves to reclaim Brave RAM, or --reap-orphans for orphans only.`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error("doctor failed:", e.message); process.exit(1); });
}

module.exports = { closeViaCdp, userDataDir };
