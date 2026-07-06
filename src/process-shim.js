// process-shim.js — cross-platform process inspection.
//
// Two operations, three platforms:
//
//   listProcessesByCommand(needle)
//     Returns [{pid, command}] for every running process whose command line
//     contains `needle`. On Win this shells out to PowerShell's
//     Get-CimInstance Win32_Process (which gives us the full command line);
//     on Mac/Linux we use plain `ps -eo pid,command`.
//
//   isPidAlive(pid)
//     Returns true iff a process with that pid is currently running.
//     Win uses `tasklist /fi "PID eq N"`; Mac/Linux uses POSIX `process.kill(pid, 0)`
//     (kernel signal-zero — does no work, just returns ESRCH if dead).
//     EPERM (alive but not ours) is treated as alive.
//
// All public functions accept an optional `_spawnSync` test seam; tests pass
// a fake to avoid hitting the real OS. `_platform` similarly defaults to
// `process.platform` but can be overridden.

const { spawnSync } = require("node:child_process");

/**
 * List running processes whose command line contains `needle`.
 *
 * @param {string} needle — substring to match against the command line.
 * @param {object} [opts]
 * @param {NodeJS.Platform} [opts._platform=process.platform]
 * @param {typeof spawnSync} [opts._spawnSync=spawnSync] — test seam
 * @returns {Array<{pid: number, command: string}>}
 */
function listProcessesByCommand(needle, opts = {}) {
  if (!needle || typeof needle !== "string") return [];
  const platform = opts._platform || process.platform;
  const spawn = opts._spawnSync || spawnSync;

  if (platform === "win32") {
    return listProcessesWin(needle, spawn);
  }
  // Mac/Linux/everything-POSIX-ish.
  return listProcessesPosix(needle, spawn);
}

/** Windows: PowerShell Get-CimInstance Win32_Process for the full command line.
 *
 *  We inject the needle into the script string after escaping any single
 *  quotes (PowerShell single-quoted literal — no expansion, no special chars
 *  except `'`). PowerShell's `-Command` parser does NOT pass extra args after
 *  the script string as named parameters to a `param()` block, so the
 *  inject-and-escape approach is the reliable cross-version path. */
function listProcessesWin(needle, spawn) {
  const escaped = String(needle).replace(/'/g, "''");
  const psScript =
    `Get-CimInstance Win32_Process | ` +
    `Where-Object { $_.CommandLine -and ($_.CommandLine -like '*${escaped}*') } | ` +
    `ForEach-Object { ''+$_.ProcessId+'|'+$_.CommandLine }`;
  const result = spawn(
    "powershell",
    ["-NoProfile", "-Command", psScript],
    {
      encoding: "utf8",
      windowsHide: true,
      // G1-3 (2026-05-10): cap stdout buffer at 16MB. Default Node 1MB
      // can truncate on systems with 100+ Brave helper processes (each
      // command line ~500-2000 chars), making findBraveProcessesForDir
      // miss entries → reaper no-ops → ghost Brave persists.
      maxBuffer: 16 * 1024 * 1024,
      // G1-3: cap PowerShell at 15s. spawnSync without timeout could hang
      // on a wedged kernel handle; without this, claimSlot's pre-claim
      // probe and the inspector's status poll would both hang the entire
      // relay.
      timeout: 15000,
    },
  );
  if (!result || result.status !== 0) {
    const stderr = result && result.stderr ? String(result.stderr).trim() : "";
    if (stderr) {
      process.stderr.write(`[mcp-relay] PowerShell process probe failed: ${stderr}\n`);
    }
    return [];
  }
  return parsePidPipeOutput(result.stdout || "");
}

/** Mac/Linux: `ps -eo pid,command` and filter rows containing needle.
 *  Filter is case-insensitive to match PowerShell's `-like` semantics on
 *  Windows (and to handle macOS where the binary is "Brave Browser" with
 *  capital B but callers may pass lowercase "brave"). */
function listProcessesPosix(needle, spawn) {
  // F0-7 (2026-05-10): pass `-ww` to disable command-column truncation on
  // BSD/macOS ps. Default truncates to ~80 chars per line — Brave on macOS
  // launches helpers with command lines well over 80 chars (paths inside
  // `Brave Browser.app` bundle are long), so the `--user-data-dir=` token
  // gets cut off → findBraveProcessesForDir misses helpers → reapOrphansFor
  // only kills the parent → helpers respawn → ghost processes.
  // Linux GNU ps also accepts -ww as a no-op (it doesn't truncate by default).
  //
  // F0-7: also force LC_ALL=C so the header line is "PID COMMAND" in ASCII
  // regardless of locale — line.startsWith("PID ") then works reliably on
  // non-English systems (where French/German/Russian/etc. would otherwise
  // produce a translated header that the skip would miss; harmless because
  // the line wouldn't match the digit regex anyway, but cleaner).
  const result = spawn("ps", ["-eo", "pid,command", "-ww"], {
    encoding: "utf8",
    // G1-3: same caps as Windows path — see listProcessesWin.
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (!result || result.status !== 0) {
    const stderr = result && result.stderr ? String(result.stderr).trim() : "";
    if (stderr) {
      process.stderr.write(`[mcp-relay] ps process probe failed: ${stderr}\n`);
    }
    return [];
  }
  const out = [];
  const needleLower = needle.toLowerCase();
  // ps output:  "  PID COMMAND" header, then "  1234 /path/to/cmd args..."
  for (const rawLine of (result.stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("PID ")) continue;
    if (!line.toLowerCase().includes(needleLower)) continue;
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const command = m[2];
    if (!Number.isFinite(pid)) continue;
    // Skip the parent ps invocation itself (defensive — ps shouldn't include
    // itself in -e listings on most platforms, but the listing for the spawn
    // shell can be present).
    if (command.startsWith("ps ") || command === "ps") continue;
    out.push({ pid, command });
  }
  return out;
}

/** Parse PowerShell `<pid>|<cmd>` lines into {pid, command} objects. */
function parsePidPipeOutput(stdoutText) {
  const out = [];
  for (const line of (stdoutText || "").split(/\r?\n/)) {
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    const pid = parseInt(line.slice(0, sep), 10);
    if (!Number.isFinite(pid)) continue;
    const command = line.slice(sep + 1);
    out.push({ pid, command });
  }
  return out;
}

/**
 * Is `pid` currently a live process?
 *
 * @param {number} pid
 * @param {object} [opts]
 * @param {NodeJS.Platform} [opts._platform=process.platform]
 * @param {typeof spawnSync} [opts._spawnSync=spawnSync] — test seam (Win only)
 * @param {(p: number, sig: number) => void} [opts._processKill] — test seam (POSIX)
 * @returns {boolean}
 */
function isPidAlive(pid, opts = {}) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const platform = opts._platform || process.platform;

  if (platform === "win32") {
    const spawn = opts._spawnSync || spawnSync;
    const result = spawn(
      "tasklist",
      ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"],
      // F1-11: short timeout + caps. Pre-fix, a wedged tasklist would
      // hang the relay's slot-claim path indefinitely.
      { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    // F1-11 (2026-05-10): fail-safe = "assume alive" when tasklist itself
    // fails (timeout, signaled, missing on PATH, error stdout). Same
    // rationale as the POSIX branch — stealing a live slot crashes Brave;
    // waiting for the stale-lock TTL costs 5 minutes.
    if (!result) return true;
    if (result.error) return true; // ENOENT / ETIMEDOUT etc.
    if (typeof result.signal === "string" && result.signal) return true;
    if (result.status !== 0) {
      // tasklist exits 0 even when no match (it prints INFO: line); a
      // non-zero status means a real failure. Fail safe.
      return true;
    }
    const stdout = result.stdout || "";
    // F1-11 reviewer V1 (2026-05-10): empty stdout from a status-0 tasklist
    // means *neither* the no-match INFO line nor a CSV row was emitted —
    // genuinely ambiguous output. Fail safe (alive) rather than treating
    // the silent path as "definitively dead." Same blast-radius logic as
    // the rest of F1-11.
    if (stdout.length === 0) return true;
    // tasklist prints `INFO: No tasks are running...` to stdout when nothing
    // matches; a real match has the pid quoted as a CSV cell.
    return stdout.includes(`,"${pid}",`);
  }

  // POSIX: signal 0 does no work. Throws ESRCH if dead, EPERM if alive but
  // owned by another user (still alive).
  //
  // F1-11 (2026-05-10): treat unknown errno (ENOSYS, EINVAL, EFAULT, EBUSY,
  // any future addition) as ALIVE rather than dead. Rationale: the
  // consequence of a false-dead is "we steal the slot from an actually-
  // running Brave + crash it"; the consequence of a false-alive is "we
  // wait an extra 5 minutes for the stale-lock TTL". The asymmetric blast
  // radius makes "fail safe = assume alive" the correct default for any
  // errno we haven't explicitly classified. Only ESRCH (definitively
  // "no such process") returns false. Errors with no `code` field also
  // get the safe-side treatment.
  const kill = opts._processKill || ((p, s) => process.kill(p, s));
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    if (!e) return true; // unparseable — fail safe
    if (e.code === "ESRCH") return false; // canonical "dead"
    return true; // EPERM, ENOSYS, EINVAL, anything else — treat as alive
  }
}

/**
 * Best-effort process start-time probe, used to defeat PID reuse in lock
 * staleness checks: the same pid with a different start time is a recycled
 * pid, not the lock's original owner.
 *
 * Returns an opaque string that is stable for the lifetime of the process
 * (POSIX: `ps -p PID -o lstart=`; Win: Win32_Process.CreationDate), or null
 * when the probe fails or the process is gone. Callers must treat null as
 * "unknown" — never as evidence of death or of a mismatch.
 *
 * @param {number} pid
 * @param {object} [opts]
 * @param {NodeJS.Platform} [opts._platform=process.platform]
 * @param {typeof spawnSync} [opts._spawnSync=spawnSync] — test seam
 * @returns {string|null}
 */
// Own-pid start-time cache (see getPidStartTime). undefined = not probed yet.
let ownStartTimeCache;
function cacheOwnStartTime(pid, opts, value) {
  if (pid === process.pid && !opts._spawnSync && value !== null) {
    ownStartTimeCache = value;
  }
  return value;
}

function getPidStartTime(pid, opts = {}) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const platform = opts._platform || process.platform;
  const spawn = opts._spawnSync || spawnSync;

  // Our own start time never changes — cache it so every lock write doesn't
  // pay a subprocess spawn (PowerShell on Windows is 1-2s). Other pids are
  // NEVER cached: a recycled pid must produce a fresh (different) answer.
  if (pid === process.pid && !opts._spawnSync && ownStartTimeCache !== undefined) {
    return ownStartTimeCache;
  }

  if (platform === "win32") {
    const psScript =
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${Math.floor(pid)}').CreationDate.ToFileTimeUtc()`;
    const result = spawn(
      "powershell",
      ["-NoProfile", "-Command", psScript],
      { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    if (!result || result.error || result.status !== 0) return null;
    const out = String(result.stdout || "").trim();
    return cacheOwnStartTime(pid, opts, out.length > 0 ? out : null);
  }

  // POSIX: lstart is the full, second-resolution start timestamp — stable
  // across calls for the same process, unlike etime (which is a countdown).
  const result = spawn("ps", ["-p", String(Math.floor(pid)), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (!result || result.error || result.status !== 0) return null;
  const out = String(result.stdout || "").trim();
  return cacheOwnStartTime(pid, opts, out.length > 0 ? out : null);
}

module.exports = {
  listProcessesByCommand,
  isPidAlive,
  getPidStartTime,
  // Exposed for unit tests of the parser.
  parsePidPipeOutput,
};
