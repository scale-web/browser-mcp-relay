// cdp-clients.js — is anything OTHER than the relay driving our Brave over its
// CDP port right now?
//
// The idle reaper (index.js) measures idleness in MCP calls. Sessions also
// drive their Brave directly from shell scripts over a websocket to
// 127.0.0.1:<cdpPort> (ghl-aloe's helpers, for example); that traffic never
// reaches the relay, so the reaper killed Braves mid-script (3x on 2026-10-12).
// Before reaping, the relay asks lsof for the ESTABLISHED TCP sockets on that
// address and treats any CLIENT socket owned by a foreign process as activity.
//
//   lsof -nP -w -iTCP@127.0.0.1:<port> -sTCP:ESTABLISHED -F pn
//
// prints, per process, `p<pid>` then one `f<fd>` + `n<local>-><remote>` pair
// per socket. The address filter matches EITHER end, so Brave's accepted
// (server) sockets appear too, as `127.0.0.1:<port>->127.0.0.1:<ephemeral>`;
// only sockets whose REMOTE end is 127.0.0.1:<port> are clients. IPv4 only on
// purpose: Brave's CDP listener is bound to 127.0.0.1 (see cdp-identity.js).
//
// What keeps Brave's OWN sockets out is that client-socket test: Brave holds
// only the server ends. Excluding its pid as well changes nothing today and is
// kept only as a second guard.
//
// On darwin lsof lives in /usr/sbin, which a relay started with a trimmed PATH
// (/usr/bin:/bin) does not search; the absolute path is used when it exists.

const fs = require("node:fs");
const { execFile } = require("node:child_process");

/** The lsof to run: /usr/sbin/lsof on darwin when present, else PATH lookup. */
function lsofCommand({ platform = process.platform, exists = fs.existsSync } = {}) {
  return platform === "darwin" && exists("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
}

/** Client sockets to 127.0.0.1:<port> in lsof `-F pn` output: [{ pid, local, remote }]. */
function parseLsofClients(stdout, port) {
  const want = `127.0.0.1:${port}`;
  const out = [];
  let pid = null;
  for (const line of String(stdout || "").split("\n")) {
    if (line.startsWith("p")) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (line.startsWith("n") && pid !== null) {
      const [local, remote, extra] = line.slice(1).split("->");
      if (extra === undefined && remote === want) out.push({ pid, local, remote });
    }
  }
  return out;
}

/** parseLsofClients minus sockets owned by `excludePids` (the relay and its
 *  upstream child; Brave's pid too, though its sockets are server ends that
 *  parseLsofClients already drops). */
function externalClients(stdout, port, excludePids = []) {
  const skip = new Set(excludePids.filter((p) => Number.isInteger(p)));
  return parseLsofClients(stdout, port).filter((c) => !skip.has(c.pid));
}

/**
 * Foreign CDP clients of 127.0.0.1:<port>. Never throws, never outlives
 * `timeoutMs` (+1 s hard cap if the child never reports back).
 * Resolves { ok: true, clients } or { ok: false, reason }.
 */
function listExternalCdpClients({ port, excludePids = [], timeoutMs = 3000, _execFile = execFile, _lsofPath = null } = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve({ ok: false, reason: `no valid CDP port (${port})` });
      return;
    }
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      resolve(r);
    };
    const cap = setTimeout(() => finish({ ok: false, reason: `lsof did not return within ${timeoutMs + 1000}ms` }), timeoutMs + 1000);
    if (typeof cap.unref === "function") cap.unref();
    try {
      _execFile(
        _lsofPath || lsofCommand(),
        ["-nP", "-w", `-iTCP@127.0.0.1:${port}`, "-sTCP:ESTABLISHED", "-F", "pn"],
        { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) {
            finish({ ok: true, clients: externalClients(stdout, port, excludePids) });
          } else if (err.code === 1 && !String(stdout || "").trim() && !String(stderr || "").trim()) {
            // lsof exits 1 with no output when nothing matches: no sockets at all.
            finish({ ok: true, clients: [] });
          } else if (err.killed || err.signal) {
            finish({ ok: false, reason: `lsof timed out after ${timeoutMs}ms` });
          } else {
            const detail = String(stderr || "").trim().split("\n")[0];
            finish({ ok: false, reason: `lsof failed (${err.code}${detail ? `: ${detail}` : ""})` });
          }
        },
      );
    } catch (e) {
      finish({ ok: false, reason: `lsof could not be started (${e.message})` });
    }
  });
}

module.exports = { lsofCommand, parseLsofClients, externalClients, listExternalCdpClients };
