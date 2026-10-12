// cdp-identity.js — which browser is listening on a CDP port? Prove it, never guess.
//
// Spec v4 §1b (F9). Field case: a second Brave launched with a fixed
// --remote-debugging-port found 127.0.0.1:<port> taken, silently fell back to
// [::1]:<port>, and every relay check that dialled 127.0.0.1:<port> reached
// ANOTHER lane's Brave. Two identity proofs replace "it answered /json/version":
//
//   Port-0 Braves (launched by this relay): Brave writes
//   <user-data-dir>/DevToolsActivePort = "<port>\n/devtools/browser/<uuid>".
//   Only one Brave can hold a user-data-dir, so when 127.0.0.1:<port>/json/version
//   reports a webSocketDebuggerUrl whose path is that exact uuid, the 127.0.0.1
//   listener IS the Brave on our dir.
//
//   Legacy fixed-port Braves (launched by pre-change relays; no file): the
//   process whose command line holds our dir must itself LISTEN on
//   127.0.0.1:<port> — `lsof -a -p <pid> -iTCP@127.0.0.1:<port>`. The
//   address-blind `lsof -iTCP:<port>` also lists a [::1] listener, which is the
//   F9 victim itself.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEVTOOLS_ACTIVE_PORT = "DevToolsActivePort";
const FILE_RE = /^(\d{1,5})\r?\n(\/devtools\/browser\/[0-9a-f-]{36})\s*$/;
// A well-formed endpoint that can never connect: port 1 on loopback, a nil
// uuid. Seeds the upstream child spawned before any Brave exists, so it can
// never fall into BDMCP's 9222/9229 probe or its standalone launch (an empty
// endpoint is "not explicit" there), and never reaches a peer's Brave.
const UNREACHABLE_WS_ENDPOINT = "ws://127.0.0.1:1/devtools/browser/00000000-0000-0000-0000-000000000000";

function requireAbsoluteDir(dir) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw new Error(`[mcp-relay] refusing non-absolute user-data-dir: ${JSON.stringify(dir)}`);
  }
}

/** Parse the file's text. A partial read (Chromium writes it non-atomically)
 *  does not match and returns null — "not yet", never an error. */
function parseDevToolsActivePort(text) {
  const m = FILE_RE.exec(String(text ?? ""));
  if (!m) return null;
  const port = parseInt(m[1], 10);
  if (!(port >= 1 && port <= 65535)) return null;
  return { port, browserPath: m[2] };
}

function devToolsActivePortPath(userDataDir) {
  requireAbsoluteDir(userDataDir);
  return path.join(userDataDir, DEVTOOLS_ACTIVE_PORT);
}

function readDevToolsActivePort(userDataDir) {
  try {
    return parseDevToolsActivePort(fs.readFileSync(devToolsActivePortPath(userDataDir), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Delete a leftover file (Chromium never removes it — not on close, not on a
 *  crash). Called with the profile flock held, after the pre-launch reap and
 *  the attach-first check, immediately before launch. */
function removeDevToolsActivePort(userDataDir) {
  fs.rmSync(devToolsActivePortPath(userDataDir), { force: true });
}

async function waitForDevToolsActivePort(userDataDir, { timeoutMs = 3000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const parsed = readDevToolsActivePort(userDataDir);
    if (parsed) return parsed;
    if (Date.now() >= deadline) {
      throw new Error(`[mcp-relay] ${DEVTOOLS_ACTIVE_PORT} did not appear (complete) in ${userDataDir} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function fetchJsonVersion(port, { timeoutMs = 1000, _fetch } = {}) {
  try {
    const resp = await (_fetch || fetch)(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** The ws endpoint for `port` iff 127.0.0.1:<port> is the browser whose uuid
 *  path is `browserPath`; otherwise null. */
async function verifyPortIdentity(port, browserPath, opts = {}) {
  const v = await fetchJsonVersion(port, opts);
  if (!v || typeof v.webSocketDebuggerUrl !== "string") return null;
  let got;
  try { got = new URL(v.webSocketDebuggerUrl).pathname; } catch { return null; }
  if (got !== browserPath) return null;
  return `ws://127.0.0.1:${port}${browserPath}`;
}

/** Does `pid` itself listen on 127.0.0.1:<port>? Address-specific on purpose. */
function listensOnLoopbackV4(pid, port, opts = {}) {
  if (opts._listensOnLoopbackV4) return opts._listensOnLoopbackV4(pid, port);
  const r = (opts._spawnSync || spawnSync)(
    "lsof", ["-nP", "-a", "-p", String(pid), `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8", timeout: 5000 },
  );
  if (!r || r.error) return false;
  const pids = String(r.stdout || "").split(/\s+/).filter(Boolean);
  return pids.length === 1 && pids[0] === String(pid);
}

/** `--remote-debugging-port=N` from a command line, INCLUDING 0; null when absent. */
function debugPortArg(cmd) {
  const m = /--remote-debugging-port=(\d+)/.exec(cmd || "");
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Identify the CDP endpoint of a live Brave main process `{ pid, command }`
 * running on `userDataDir`. Returns { port, wsEndpoint, legacy } or null when
 * its identity cannot be proven (→ not attachable; reap + launch instead).
 */
async function resolveBraveEndpoint({ pid, command }, userDataDir, opts = {}) {
  const arg = debugPortArg(command);
  if (arg === 0) {
    const file = readDevToolsActivePort(userDataDir);
    if (!file) return null;
    const wsEndpoint = await verifyPortIdentity(file.port, file.browserPath, opts);
    return wsEndpoint ? { port: file.port, wsEndpoint, legacy: false } : null;
  }
  if (arg > 0 && arg <= 65535) {
    if (!listensOnLoopbackV4(pid, arg, opts)) return null;
    const v = await fetchJsonVersion(arg, opts);
    if (!v || typeof v.webSocketDebuggerUrl !== "string") return null;
    let p;
    try { p = new URL(v.webSocketDebuggerUrl).pathname; } catch { return null; }
    if (!/^\/devtools\/browser\/[0-9a-f-]{36}$/.test(p)) return null;
    return { port: arg, wsEndpoint: `ws://127.0.0.1:${arg}${p}`, legacy: true };
  }
  return null;
}

module.exports = {
  DEVTOOLS_ACTIVE_PORT,
  UNREACHABLE_WS_ENDPOINT,
  parseDevToolsActivePort,
  readDevToolsActivePort,
  removeDevToolsActivePort,
  waitForDevToolsActivePort,
  fetchJsonVersion,
  verifyPortIdentity,
  listensOnLoopbackV4,
  debugPortArg,
  resolveBraveEndpoint,
  requireAbsoluteDir,
};
