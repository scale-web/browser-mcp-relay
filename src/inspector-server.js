// inspector-server.js — reusable Inspector module.
//
// Two operating modes:
//   1. Standalone — launched via `npm run inspector` (scripts/inspector.js
//      is the thin entry). No live MCP traffic; Activity feed shows the
//      "no-emitter" message.
//   2. In-process — booted from src/index.js when
//      BROWSER_RELAY_INSPECTOR_PORT is set on the relay process. The relay
//      passes its trafficEmitter, so /ws/traffic streams real MCP traffic.
//
// Hard rules (carried over from W7-W9 inspector.js):
//   - Bind 127.0.0.1 by default; LAN exposure requires explicit bind override.
//   - GET-only on the HTTP side (no mutating endpoints — that's W11).
//   - WS endpoint /ws/traffic is read-only too: server pushes, client never
//     sends anything we trust beyond pong.
//   - Static files re-read from disk each request (no aggressive cache).
//   - User-facing UI never leaks absolute paths — see redactPath().
//   - Truncate large response bodies (~10KB cap) before emitting traffic
//     events (memory-safety on noisy capture_xhr / lighthouse_audit calls).
//
// Construction model: startInspector({ port, bind, getStatus, getTraffic,
// trafficEmitter, uiRoot }) returns { server, close, port, bind, wss }.
// Tests inject seams; the standalone entry just calls startInspector().

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const pool = require("./pool-shared.js");
const profileLock = require("./profile-lock.js");
const { loadVaultFromEnv } = require("./vault.js");
const { tools: ownTools } = require("./own-tools/index.js");
const { detectBraveProfileDir } = require("./detect-browser.js");
const forwardedCatalog = require("../scripts/inspector-forwarded-tools.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const PKG = require(path.join(REPO_ROOT, "package.json"));
const LOCAL_CONFIG_PATH = path.join(REPO_ROOT, "local-config.json");
const LOCAL_CONFIG_EXAMPLE = "local-config.example.json";

// Env vars whose set/unset state we surface on the Settings page. Booleans
// only — never the values themselves.
const TRACKED_ENV_VARS = [
  "BROWSER_RELAY_BRAVE_PATH",
  "BROWSER_RELAY_UPSTREAM_PATH",
  "BROWSER_RELAY_BRAVE_PROFILE_DIR",
  "BROWSER_RELAY_POOL_DIR",
  "BROWSER_RELAY_POOL_SLOT",
  "BROWSER_RELAY_PROXY_URL",
  "BROWSER_RELAY_VAULT_FILES",
  "BROWSER_RELAY_SNAPSHOT_INDEXEDDB",
  "BROWSER_HEADLESS_ENABLE",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Redact Windows / POSIX absolute paths to a basename. */
function redactPath(p) {
  if (!p) return p;
  return path.basename(p);
}

/** Redact any absolute-path-looking tokens inside a free-form string (e.g.
 *  an error.message that interpolates "/Users/foo/.cache" into the text).
 *  Conservative: only replaces tokens that look like absolute paths
 *  (starts with / or drive letter), and only when the path has at least
 *  one separator after the drive — single-segment paths and basenames are
 *  left alone so the result remains useful. */
function redactErrorPaths(text) {
  if (!text) return text;
  // Allow spaces inside segments (Win has "Program Files"); a path token
  // ends at a quote/comma/EOL or trailing whitespace before another token.
  // We match greedily up to (but not including) the basename, then capture
  // the basename, then replace the whole thing with "<...>/<basename>".
  // Concretely: drive-letter + slash + any number of segments containing
  // \w / spaces / dots / dashes ending in a slash, then a final segment.
  const winRe = /[A-Za-z]:[\\/](?:[\w .\-+]+[\\/])+([\w .\-+]+)/g;
  // V2-2: UNC paths (\\server\share\dir\file). Two leading backslashes are
  // significant on Windows; collapse the host + share + intermediate dirs
  // into <...> and keep the basename for context.
  const uncRe = /\\\\[\w.\-]+\\[\w.\-+ ]+(?:\\[\w .\-+]+)+\\([\w .\-+]+)/g;
  // POSIX absolute: a leading slash, at least one mid-segment with a
  // trailing slash, then a final segment. Anchored either at the start or
  // after a whitespace/punct boundary so we don't eat random `/` characters.
  const posixRe = /(^|(?<=[\s"'(,]))\/(?:[\w .\-+]+\/)+([\w .\-+]+)/g;
  // V2-2: POSIX single-segment absolute paths (`/etc`, `/var`, `/foo`) —
  // these don't have an intermediate dir but still leak the absolute prefix.
  // Anchor on word-boundary + leading slash + a single segment + edge.
  const posixSingleRe = /(^|(?<=[\s"'(,]))\/([\w.\-+]+)(?=$|[\s"'),:;])/g;
  return String(text)
    .replace(uncRe, (_m, base) => "<...>/" + base)
    .replace(winRe, (_m, base) => "<...>/" + base)
    .replace(posixRe, (_m, lead, base) => lead + "<...>/" + base)
    .replace(posixSingleRe, (_m, lead, base) => lead + "<...>/" + base);
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Build the /api/status payload. Pure-ish (everything stateful is injected
 *  via the seams object). */
function buildStatus(seams = {}) {
  const _loadConfig = seams._loadConfig || pool.loadConfig;
  const _findBraveProcessesForDir =
    seams._findBraveProcessesForDir || pool.findBraveProcessesForDir;
  const _listBraveProcessesRaw =
    seams._listBraveProcessesRaw || pool.listBraveProcessesRaw;
  const _isPidAlive = seams._isPidAlive || pool.isPidAlive;
  const _findCookiesFile = seams._findCookiesFile || pool.findCookiesFile;
  const _checkCookieAgeDays =
    seams._checkCookieAgeDays || pool.checkCookieAgeDays;
  const _loadVault = seams._loadVault || loadVaultFromEnv;
  const _readFile = seams._readFile || ((p) => fs.readFileSync(p, "utf8"));
  const _statFile = seams._statFile || ((p) => fs.statSync(p));
  const _existsFile = seams._existsFile || ((p) => fs.existsSync(p));
  const _now = seams._now || (() => Date.now());
  const _startedAt = seams._startedAt || moduleStartedAt;
  const _ownTools = seams._ownTools || ownTools;
  const _env = seams._env || process.env;
  // THE predicate (profile-lock.js, spec v4 §1a/N12): "held" when a live relay
  // holds the dir's flock or a live holder owns its record; "free" otherwise;
  // "absent" when the dir does not exist (then the record alone decides).
  const _probeDir = seams._probeDir || ((dir) => pool.probeDirState(dir));
  const _recordHeld = seams._recordHeld || ((meta, lockPath) => {
    try { return profileLock.recordHeld({ kind: "ok", meta, mtimeMs: _statFile(lockPath).mtimeMs }, { _isPidAlive }).held; }
    catch { return !!_isPidAlive(meta.pid); }
  });

  const cfg = _loadConfig();
  const braveProcessText = _listBraveProcessesRaw();

  const slots = (cfg.poolDirs || []).map((dir, idx) => {
    const lockPath = path.join(dir, ".mcp-wrapper-lock");
    let pid = null;
    let pidAlive = null;
    let lockHeldMs = null;
    let state = "idle";
    let lockExists = false;
    let recordIsHeld = false;

    try {
      lockExists = _existsFile(lockPath);
    } catch {
      lockExists = false;
    }

    if (lockExists) {
      try {
        const meta = JSON.parse(_readFile(lockPath));
        if (meta && Number.isFinite(meta.pid)) {
          pid = meta.pid;
          pidAlive = !!_isPidAlive(meta.pid);
          recordIsHeld = pidAlive && _recordHeld(meta, lockPath);
        }
        if (meta && meta.startedAt) {
          const started = Date.parse(meta.startedAt);
          if (Number.isFinite(started)) lockHeldMs = _now() - started;
        } else {
          try {
            const st = _statFile(lockPath);
            lockHeldMs = _now() - st.mtimeMs;
          } catch { /* unreadable */ }
        }
      } catch {
        pid = null;
        pidAlive = false;
      }
    }

    const bravePids = _findBraveProcessesForDir(braveProcessText, dir);
    const liveBravePids = bravePids.filter((p) => _isPidAlive(p));

    // "orphan" = the predicate says FREE while a record remains — never
    // pid-alive alone. A held flock is "claimed" whatever the record says.
    let probe = "absent";
    try { probe = _probeDir(dir); } catch { probe = "absent"; }
    if (probe === "held") {
      state = "claimed";
    } else if (lockExists) {
      state = probe === "free" || !recordIsHeld ? "orphan" : "claimed";
    } else {
      state = "idle";
    }

    let cookieAgeDays = null;
    try {
      const cookiesPath = _findCookiesFile(dir);
      if (cookiesPath) {
        cookieAgeDays = _checkCookieAgeDays(cookiesPath);
      }
    } catch { /* leave null */ }

    return {
      index: idx + 1,
      dir: redactPath(dir),
      role: (cfg.slotRoles || {})[dir] || "default",
      state,
      pid,
      pidAlive,
      lockHeldMs,
      cookieAgeDays,
      bravePids: liveBravePids,
    };
  });

  // Cookie source freshness for the configured `cookieSourceProfile`. Pool
  // mode snapshots that profile's cookies into every slot at launch; the
  // freshness pill is the one piece of "specialty MCP" telemetry that's
  // genuinely useful regardless of which MCP entry feeds the profile, so
  // we surface it on Pool overview directly rather than as a separate page.
  let cookieAgeDays = null;
  let cookieStatus = "unknown";
  try {
    if (cfg.cookieSourceProfile) {
      const cookiesPath = _findCookiesFile(cfg.cookieSourceProfile);
      if (cookiesPath) {
        cookieAgeDays = _checkCookieAgeDays(cookiesPath);
        if (cookieAgeDays != null) {
          cookieStatus =
            cookieAgeDays <= cfg.cookieFreshnessWarnDays ? "fresh" : "stale";
        }
      }
    }
  } catch { /* leave unknown */ }

  const cookieSource = {
    profile: cfg.cookieSourceProfile
      ? redactPath(cfg.cookieSourceProfile)
      : null,
    ageDays: cookieAgeDays,
    thresholdDays: cfg.cookieFreshnessWarnDays,
    status: cookieStatus,
  };

  let vaultBlock = {
    enabled: false,
    totalEntries: 0,
    uniqueHosts: 0,
    filesLoaded: [],
    filesSkipped: [],
  };
  try {
    const vault = _loadVault();
    const summary = vault.summary();
    vaultBlock = {
      enabled: !!_env.BROWSER_RELAY_VAULT_FILES,
      totalEntries: summary.totalEntries,
      uniqueHosts: summary.uniqueHosts,
      filesLoaded: (summary.filesLoaded || []).map((f) => ({
        path: redactPath(f.path),
        entries: f.entries,
      })),
      filesSkipped: (summary.filesSkipped || []).map((f) => ({
        path: redactPath(f.path),
        reason: f.reason,
      })),
    };
  } catch (e) {
    vaultBlock.error = e.message;
  }

  const ownCount = _ownTools.length;
  const forwardedCount = 51;
  const uptimeSeconds = Math.floor((_now() - _startedAt) / 1000);
  let mode = cfg.standalone ? "standalone" : "pool";

  return {
    config: {
      mode,
      poolDirs: (cfg.poolDirs || []).map(redactPath),
      slotRoles: Object.fromEntries(
        Object.entries(cfg.slotRoles || {}).map(([k, v]) => [redactPath(k), v]),
      ),
      cookieFreshnessWarnDays: cfg.cookieFreshnessWarnDays,
      bravePath: cfg.bravePath ? redactPath(cfg.bravePath) : null,
      // Redact paths inside the detect error too — error messages can include
      // the candidate locations we tried (e.g. "tried C:/Program Files/...").
      // Apply redactPath() per whitespace-separated token so basenames remain
      // legible while absolute paths drop their parent directories.
      braveDetectError: cfg.braveDetectError
        ? redactErrorPaths(cfg.braveDetectError.message || String(cfg.braveDetectError))
        : null,
    },
    slots,
    cookieSource,
    vault: vaultBlock,
    tools: {
      total: ownCount + forwardedCount,
      ownCount,
      forwardedCount,
      forwardedCountSource: "static-placeholder",
    },
    server: {
      uptimeSeconds,
      startedAt: new Date(_startedAt).toISOString(),
      version: PKG.version,
    },
  };
}

function buildSettings(seams = {}) {
  const _loadConfig = seams._loadConfig || pool.loadConfig;
  const _detectBraveProfileDir = seams._detectBraveProfileDir || detectBraveProfileDir;
  const _existsFile = seams._existsFile || ((p) => fs.existsSync(p));
  const _env = seams._env || process.env;

  const cfg = _loadConfig();

  let braveProfileDir = null;
  try {
    braveProfileDir = _detectBraveProfileDir({ env: _env });
  } catch { /* leave null */ }

  const envBooleans = {};
  for (const k of TRACKED_ENV_VARS) {
    envBooleans[k] = !!(_env[k] && _env[k].length > 0);
  }

  const localConfigExists = !!_existsFile(LOCAL_CONFIG_PATH);

  const localConfigSnippet = JSON.stringify(
    {
      BROWSER_RELAY_BRAVE_PATH: cfg.bravePath ? redactPath(cfg.bravePath) : "",
      BROWSER_RELAY_BRAVE_PROFILE_DIR: braveProfileDir
        ? redactPath(braveProfileDir)
        : "",
      BROWSER_RELAY_POOL_DIR: "",
      BROWSER_RELAY_POOL_SLOT: "",
      BROWSER_HEADLESS_ENABLE: "false",
      BROWSER_RELAY_PROXY_URL: "",
      BROWSER_RELAY_VAULT_FILES: "",
      BROWSER_RELAY_SNAPSHOT_INDEXEDDB: "false",
    },
    null,
    2,
  );

  return {
    config: {
      bravePath: cfg.bravePath ? redactPath(cfg.bravePath) : null,
      braveProfileDir: braveProfileDir ? redactPath(braveProfileDir) : null,
      poolDirs: (cfg.poolDirs || []).map(redactPath),
      slotRoles: Object.fromEntries(
        Object.entries(cfg.slotRoles || {}).map(([k, v]) => [redactPath(k), v]),
      ),
      cookieSourceProfile: cfg.cookieSourceProfile
        ? redactPath(cfg.cookieSourceProfile)
        : null,
      cookieFreshnessWarnDays: cfg.cookieFreshnessWarnDays,
      mode: cfg.standalone ? "standalone" : "pool",
    },
    env: envBooleans,
    localConfigExists,
    localConfigSnippet,
    localConfigExamplePath: LOCAL_CONFIG_EXAMPLE,
  };
}

const OWN_TOOL_META = {
  lighthouse_audit: { sourceFile: "lighthouse-audit.js", category: "performance" },
  "memory_take-heap-snapshot": { sourceFile: "memory-take-heap-snapshot.js", category: "performance" },
  emulate_device: { sourceFile: "emulate-device.js", category: "device" },
  tabs_list: { sourceFile: "tabs-list.js", category: "tabs" },
  tabs_new: { sourceFile: "tabs-new.js", category: "tabs" },
  tabs_select: { sourceFile: "tabs-select.js", category: "tabs" },
  tabs_close: { sourceFile: "tabs-close.js", category: "tabs" },
  dialog_handle: { sourceFile: "dialog-handle.js", category: "forms" },
  file_upload: { sourceFile: "file-upload.js", category: "forms" },
  form_fill: { sourceFile: "form-fill.js", category: "forms" },
  capture_xhr: { sourceFile: "capture-xhr.js", category: "network" },
  cookies_export: { sourceFile: "cookies-export.js", category: "session" },
  cookies_import: { sourceFile: "cookies-import.js", category: "session" },
  stealth_apply: { sourceFile: "stealth-apply.js", category: "session" },
  download_capture: { sourceFile: "download-capture.js", category: "downloads" },
  extract_structured: { sourceFile: "extract-structured.js", category: "data" },
  // Storage tools (added 2026-05-09) — auth tokens for modern OAuth-style apps
  // (Discord, Notion, Slack, Linear, Mercury…) live in localStorage rather
  // than HTTP cookies. These complement cookies_export.
  "storage_get-local": { sourceFile: "storage-get-local.js", category: "session" },
  "storage_set-local": { sourceFile: "storage-set-local.js", category: "session" },
  "storage_clear-local": { sourceFile: "storage-clear-local.js", category: "session" },
};

function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function inputSchemaPreview(inputSchema) {
  if (!inputSchema || !inputSchema.properties) return "";
  const keys = Object.keys(inputSchema.properties);
  if (!keys.length) return "";
  return keys.join(", ");
}

function buildToolsCatalog(seams = {}) {
  const _ownTools = seams._ownTools || ownTools;

  const own = _ownTools.map((t) => {
    const meta = OWN_TOOL_META[t.name] || {};
    return {
      name: t.name,
      description: truncate(t.description || "", 200),
      sourceFile: meta.sourceFile || `${t.name}.js`,
      category: meta.category || "data",
      inputSchemaPreview: inputSchemaPreview(t.inputSchema),
    };
  });

  const forwarded = forwardedCatalog.tools.map((t) => ({
    name: t.name,
    description: t.description,
    upstreamSource: forwardedCatalog.upstreamSource,
    category: t.category,
  }));

  return {
    total: own.length + forwarded.length,
    ownCount: own.length,
    forwardedCount: forwarded.length,
    own,
    forwarded,
  };
}

/** Build the per-slot detail payload for /api/slot/:n. Returns null if `n`
 *  is out of range, so the caller can 404 cleanly. The payload is the full
 *  slot entry from buildStatus + a `recentTraffic` array (last 200 events). */
function buildSlotDetail(n, seams = {}) {
  const status = buildStatus(seams);
  const slot = status.slots.find((s) => s.index === n);
  if (!slot) return null;

  const trafficBuffer = seams._trafficBuffer || [];
  // No PID-based filter today: the relay process is the only producer of
  // traffic, and it always corresponds to ONE slot at a time. If we ever
  // multiplex slots inside one relay we can extend the event shape.
  const recentTraffic = Array.isArray(trafficBuffer) ? trafficBuffer.slice(-200) : [];

  return { slot, recentTraffic, totalSlots: status.slots.length };
}

// Module-level start time so /api/status uptime stays stable across reqs.
let moduleStartedAt = Date.now();

const STATIC_MAP = {
  "/": "index.html",
  "/index.html": "index.html",
  "/settings": "index.html",
  "/tools": "index.html",
  "/activity": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
};

// Defense-in-depth headers applied to every response. The inspector never
// embeds in iframes or admits cross-origin reads, so these are blanket-set.
//
// V2-1: CSP tightened from `frame-ancestors 'none'`-only to a full directive
// list. `default-src 'self'` denies cross-origin script/img/etc by default;
// `script-src 'self' 'unsafe-inline'` keeps the inspector's inline init
// script working without opening up to remote eval; `connect-src 'self'`
// limits XHR/WS to same-origin (defense against compromised inline script).
// Forms blocked entirely (we have one POST endpoint reached via fetch).
const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** Apply the no-store cache header + the standard security headers in one
 *  call. Used for every JSON / HTML / static response so a slow client (or
 *  a curious browser) can't accidentally cache traffic data to disk. */
function writeJsonHead(res, status, extra = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...extra,
  };
  res.writeHead(status, headers);
}

function writeHtmlOrAssetHead(res, status, mime) {
  res.writeHead(status, {
    "Content-Type": mime,
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
  });
}

/** Origin allowlist matcher — shared with the WS upgrade path. Browsers
 *  always send Origin on cross-origin XHR + WS upgrade, so a missing
 *  Origin = trusted (curl, native ws-client). */
function makeOriginChecker(allowedOrigins) {
  const DEFAULT_ALLOWED = ["http://localhost", "http://127.0.0.1"];
  const list = (allowedOrigins && allowedOrigins.length) ? allowedOrigins : DEFAULT_ALLOWED;
  return function isOriginAllowed(originHeader) {
    if (!originHeader) return true;
    const probe = String(originHeader).replace(/\/$/, "");
    return list.some((prefix) => probe === prefix || probe.startsWith(prefix + ":"));
  };
}

/** Activity feed builder — cross-slot view of the same ring buffer that
 *  /api/slot/:n serves. Returns the last 200 events in arrival order
 *  (oldest → newest, matching the ring buffer's native order). */
function buildActivity(seams = {}) {
  const trafficBuffer = seams._trafficBuffer || [];
  const events = Array.isArray(trafficBuffer) ? trafficBuffer.slice(-200) : [];
  return {
    events,
    totalCaptured: events.length,
  };
}

/** Read a JSON request body up to a small cap. Inspector POST bodies are
 *  always tiny (none today carry payload); we still cap at 64 KB so a buggy
 *  client can't OOM us. */
function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

/** Build the request handler. */
function makeHandler({ uiRoot, seams = {}, getSlotDetail, allowedOrigins, mutators } = {}) {
  const isOriginAllowed = makeOriginChecker(allowedOrigins);
  const _mutators = mutators || {};

  return async function handler(req, res) {
    const method = req.method || "GET";

    // Parse URL. Use WHATWG URL parser (url.parse is deprecated). Bogus
    // requests with no req.url default to "/".
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || "/", "http://x");
    } catch {
      writeJsonHead(res, 400);
      res.end(JSON.stringify({ error: "bad request" }));
      return;
    }
    const pathname = parsedUrl.pathname || "/";

    // Path-traversal hard stop. Reject any pathname that contains "..", a
    // backslash, or a percent-encoded "..". The Node server normalizes most
    // of this for us, but defense-in-depth is cheap. /api/slot/N never
    // matches because N is integers-only.
    if (
      pathname.includes("..") ||
      pathname.includes("\\") ||
      /%2e/i.test(pathname)
    ) {
      writeJsonHead(res, 404);
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    // Origin gate for non-GET/HEAD. POST is the FIRST mutating method we
    // expose (W11).
    //
    // V1-6: previously this matched the WS path's "missing Origin = trusted"
    // semantics, which is correct for WS upgrade (curl / native ws clients
    // don't send Origin) but unsafe for POST. Cross-origin form POSTs from
    // a hostile webpage on `evil.com` SHOULD always include Origin per modern
    // browser policy, and a 403 stops them. But Origin can be stripped on
    // certain redirect paths or by older clients, and a missing-Origin = OK
    // policy lets that bypass slip through to the reap endpoint. Tighten:
    // for mutating methods, require Origin to be PRESENT and allowed. Local
    // CLI clients (curl, scripts) can still call the read-only GETs without
    // Origin; CSRF protection only matters for the mutating POSTs anyway.
    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers && req.headers.origin;
      if (!origin) {
        writeJsonHead(res, 403);
        res.end(JSON.stringify({ error: "missing origin header (required on mutating requests)" }));
        return;
      }
      if (!isOriginAllowed(origin)) {
        writeJsonHead(res, 403);
        res.end(JSON.stringify({ error: "forbidden origin" }));
        return;
      }
    }

    // ── Mutating routes (POST) ───────────────────────────────────────
    // Reap orphan slot N. /api/slots/:n/reap. Validates that the slot is
    // actually in `orphan` state before reaping (else 400) — we don't ever
    // tear down an actively-claimed slot from the inspector.
    const reapMatch = pathname.match(/^\/api\/slots\/(.+)\/reap$/);
    if (reapMatch) {
      if (method !== "POST") {
        writeJsonHead(res, 405);
        res.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }
      const raw = reapMatch[1];
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 1 || String(n) !== raw) {
        writeJsonHead(res, 404);
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      try {
        await readJsonBody(req).catch(() => ({})); // drain
        // Re-build slot detail to find the slot's actual dir + state.
        const detail = (getSlotDetail || buildSlotDetail)(n, seams);
        if (!detail) {
          writeJsonHead(res, 404);
          res.end(JSON.stringify({ error: "slot out of range" }));
          return;
        }
        if (detail.slot.state !== "orphan") {
          writeJsonHead(res, 400);
          res.end(JSON.stringify({
            ok: false,
            reaped: false,
            message: "slot is not orphan (state=" + detail.slot.state + ")",
          }));
          return;
        }
        // We need the absolute dir for reaping — buildSlotDetail returns the
        // basename. Pull it from the loaded config.
        const _loadConfig = seams._loadConfig || pool.loadConfig;
        const cfg = _loadConfig();
        const absDir = (cfg.poolDirs || [])[n - 1];
        if (!absDir) {
          writeJsonHead(res, 500);
          res.end(JSON.stringify({ ok: false, reaped: false, message: "slot dir unresolved" }));
          return;
        }
        // Reap only under the dir's flock and only when THE predicate says
        // free (pool.reapDirUnderFlock throws otherwise): Brave squatters,
        // then the stale record (owner-checked), then the flock is released.
        const reapFn = _mutators.reapSlot || ((dir) => pool.reapDirUnderFlock(dir));
        // G0-8 (2026-05-10): cap the reap operation at 10s. taskkill /F /T
        // is normally fast but a wedged kernel handle (rare; happens when
        // a target process is stuck in an uninterruptible kernel wait) can
        // make it block forever. Without this, the inspector's HTTP handler
        // hangs indefinitely on a Reap click — bad UX, and the inspector
        // backend's HTTP server can't drain.
        const REAP_TIMEOUT_MS = 10000;
        const reapPromise = Promise.resolve(reapFn(absDir, n));
        const killed = await Promise.race([
          reapPromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error("reap timed out after " + REAP_TIMEOUT_MS + "ms")), REAP_TIMEOUT_MS)),
        ]);
        writeJsonHead(res, 200);
        res.end(JSON.stringify({
          ok: true,
          reaped: true,
          message: "Reaped orphan slot " + n + " · " +
            (Number.isFinite(killed) ? killed + " brave proc" + (killed === 1 ? "" : "es") : "lock cleared"),
        }));
      } catch (e) {
        writeJsonHead(res, 500);
        res.end(JSON.stringify({ ok: false, reaped: false, message: "reap failed: " + e.message }));
      }
      return;
    }

    // ── Read-only methods only past this point ───────────────────────
    if (method !== "GET" && method !== "HEAD") {
      writeJsonHead(res, 405);
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    // Per-slot detail API: /api/slot/:n.
    const slotApiMatch = pathname.match(/^\/api\/slot\/(.+)$/);
    if (slotApiMatch) {
      const raw = slotApiMatch[1];
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 1 || String(n) !== raw) {
        writeJsonHead(res, 404);
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      try {
        const detail = (getSlotDetail || buildSlotDetail)(n, seams);
        if (!detail) {
          writeJsonHead(res, 404);
          res.end(JSON.stringify({ error: "slot out of range" }));
          return;
        }
        writeJsonHead(res, 200);
        res.end(JSON.stringify(detail, null, 2));
      } catch (e) {
        writeJsonHead(res, 500);
        res.end(JSON.stringify({ error: "build failed", detail: e.message }));
      }
      return;
    }

    // Inspector traffic export — returns the same shape as /api/activity but
    // with a Content-Disposition: attachment header so the browser surfaces
    // a "Save As..." dialog instead of rendering inline. Useful for filing
    // bug reports (paste the JSON into an issue) or for offline analysis of
    // a long-running session's tool-call traffic.
    if (pathname === "/api/activity/export") {
      try {
        const payload = buildActivity(seams);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = `mcp-relay-activity-${stamp}.json`;
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
        });
        res.end(JSON.stringify(payload, null, 2));
      } catch (e) {
        writeJsonHead(res, 500);
        res.end(JSON.stringify({ error: "build failed", detail: e.message }));
      }
      return;
    }

    const apiBuilders = {
      "/api/status": buildStatus,
      "/api/settings": buildSettings,
      "/api/tools": buildToolsCatalog,
      "/api/activity": buildActivity,
    };
    const apiBuilder = apiBuilders[pathname];
    if (apiBuilder) {
      try {
        const payload = apiBuilder(seams);
        writeJsonHead(res, 200);
        res.end(JSON.stringify(payload, null, 2));
      } catch (e) {
        writeJsonHead(res, 500);
        res.end(JSON.stringify({ error: "build failed", detail: e.message }));
      }
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return;
    }

    // Static file routing. /slot/:n is an SPA route — serve index.html.
    let fname = STATIC_MAP[pathname];
    if (!fname && /^\/slot\/\d+$/.test(pathname)) fname = "index.html";

    if (fname) {
      const file = path.join(uiRoot, fname);
      try {
        const buf = await fsp.readFile(file);
        const mime = MIME[path.extname(fname)] || "application/octet-stream";
        writeHtmlOrAssetHead(res, 200, mime);
        res.end(buf);
      } catch (e) {
        writeJsonHead(res, 500);
        res.end(JSON.stringify({ error: "static read failed", detail: e.message }));
      }
      return;
    }

    writeJsonHead(res, 404);
    res.end(JSON.stringify({ error: "not found" }));
  };
}

/** Wire up /ws/traffic. Behavior depends on whether trafficEmitter was
 *  provided:
 *   - If yes: send {type:"backfill",events:[...]} immediately, then stream
 *     {type:"request"|"response", ...} events as they fire on the emitter.
 *     Ping every 25s; close clients that don't pong within 10s.
 *   - If no (standalone): send {type:"no-emitter", message:"..."} and close.
 *     Frontend handles this by showing the "Inspector running standalone"
 *     empty state.
 *
 *  The buffer accessor is { getRecent(): array } so the WS server pulls a
 *  snapshot at connect-time, not at construct-time.
 */
function attachWebsocket(httpServer, { trafficEmitter, getRecent, allowedOrigins } = {}) {
  // Defense-in-depth: clients should never send anything beyond pong frames,
  // so cap incoming payloads small. Stops a malicious or buggy client from
  // tying up memory with arbitrarily large frames.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  // Cross-origin WS protection. Browsers do NOT enforce SOP for WebSockets,
  // so a tab on evil.com could open ws://127.0.0.1:9090/ws/traffic and
  // receive every captured tool call — even though our HTTP bind is
  // localhost-only. We accept connections only when the Origin header is
  // absent (curl, native MCP client, our own UI fetched from same origin)
  // or when it matches an allowlist. Default allowlist = localhost / 127.0.0.1.
  const isOriginAllowed = makeOriginChecker(allowedOrigins);

  // Back-pressure cap: if a slow/paused client lets the send buffer grow
  // past this, drop the connection rather than OOM the relay during a
  // capture_xhr burst or a parallel scrape.
  const MAX_BUFFERED_BYTES = 1_000_000;

  // Per-client liveness: send ping every 25s; if no pong by 10s after the
  // ping, terminate. Tracked via `isAlive` flag flipped on `pong`.
  const PING_INTERVAL_MS = 25_000;
  const PONG_TIMEOUT_MS = 10_000;

  function setupClient(ws) {
    ws.isAlive = true;
    let pongTimer = null;

    ws.on("pong", () => {
      ws.isAlive = true;
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    });

    const pingTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (!ws.isAlive) {
        try { ws.terminate(); } catch { /* noop */ }
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* noop */ }
      pongTimer = setTimeout(() => {
        if (!ws.isAlive) try { ws.terminate(); } catch { /* noop */ }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);

    ws.on("close", () => {
      clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
    });
    ws.on("error", () => {
      clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
    });
  }

  httpServer.on("upgrade", (req, socket, head) => {
    let parsedPath;
    try { parsedPath = new URL(req.url || "/", "http://x").pathname; }
    catch { socket.destroy(); return; }
    if (parsedPath !== "/ws/traffic") {
      socket.destroy();
      return;
    }
    // Origin allowlist check — prevents cross-origin WS hijack from a
    // hostile webpage. Browsers ALWAYS send Origin on WS upgrade, so a
    // missing Origin = non-browser client (curl, ws-client) which is fine.
    const origin = req.headers && req.headers.origin;
    if (!isOriginAllowed(origin)) {
      try {
        socket.write(
          "HTTP/1.1 403 Forbidden\r\n" +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n\r\n",
        );
      } catch { /* noop */ }
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      setupClient(ws);

      if (!trafficEmitter) {
        // Standalone mode: tell the client immediately and close. Don't keep
        // the connection alive — clients reconnect with backoff and would
        // get the same message back, so closing avoids a busy loop.
        try {
          ws.send(JSON.stringify({
            type: "no-emitter",
            message:
              "Live traffic requires in-process launch via BROWSER_RELAY_INSPECTOR_PORT on the relay",
          }));
        } catch { /* noop */ }
        try { ws.close(1000, "no emitter"); } catch { /* noop */ }
        return;
      }

      // In-process mode: backfill then stream.
      try {
        const events = (typeof getRecent === "function") ? getRecent() : [];
        ws.send(JSON.stringify({ type: "backfill", events: events || [] }));
      } catch { /* noop — client will see the live stream regardless */ }

      // Back-pressure guard: drop the client if its send buffer balloons.
      // A paused/slow tab during a capture_xhr burst would otherwise let
      // `ws` queue frames in memory unboundedly. Better to lose one viewer
      // than OOM the relay process.
      const sendOrTerminate = (payload) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          try { ws.terminate(); } catch { /* noop */ }
          return;
        }
        try { ws.send(payload); } catch { /* noop */ }
      };

      const onRequest = (evt) => {
        sendOrTerminate(JSON.stringify({ type: "request", ...evt }));
      };
      const onResponse = (evt) => {
        sendOrTerminate(JSON.stringify({ type: "response", ...evt }));
      };

      trafficEmitter.on("request", onRequest);
      trafficEmitter.on("response", onResponse);

      ws.on("close", () => {
        try { trafficEmitter.off("request", onRequest); } catch { /* noop */ }
        try { trafficEmitter.off("response", onResponse); } catch { /* noop */ }
      });
    });
  });

  return wss;
}

/** Construct + start the inspector. Returns a promise that resolves once
 *  the HTTP server is listening. Caller can `await close()` for clean
 *  teardown (closes the WS server too). */
function startInspector(opts = {}) {
  const port = opts.port == null ? 9090 : opts.port;
  const bind = opts.bind || "127.0.0.1";
  const uiRoot = opts.uiRoot || path.join(__dirname, "..", "scripts", "inspector-ui");
  const seams = opts.seams || {};
  // Traffic ring buffer: optional; if the caller has its own buffer we pull
  // from it via getRecent. Otherwise, fall back to the trafficEmitter's
  // buffer if it has one (RelayServer's emitter exposes getRecentTraffic).
  let getRecent = opts.getRecent;
  if (!getRecent && opts.trafficEmitter && typeof opts.trafficEmitter.getRecent === "function") {
    getRecent = () => opts.trafficEmitter.getRecent();
  }

  // Expose the in-memory buffer to /api/slot/:n via the seams object so the
  // slot detail endpoint can include `recentTraffic` without re-implementing
  // ring-buffer access.
  const enrichedSeams = { ...seams };
  if (!enrichedSeams._trafficBuffer && getRecent) {
    Object.defineProperty(enrichedSeams, "_trafficBuffer", {
      get: getRecent,
      enumerable: true,
    });
  }

  moduleStartedAt = Date.now();
  const handler = makeHandler({
    uiRoot,
    seams: enrichedSeams,
    allowedOrigins: opts.allowedOrigins,
    mutators: opts.mutators,
  });
  const server = http.createServer(handler);

  // G0-6 (2026-05-10): cap idle keep-alive sockets so they don't accumulate
  // over hours of inspector-tab idleness. Default Node keepAliveTimeout is
  // 5s but defaults change between versions; pin them. requestTimeout caps
  // a stuck request mid-body so a misbehaving client can't hold the server
  // open indefinitely.
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;

  const wss = attachWebsocket(server, {
    trafficEmitter: opts.trafficEmitter || null,
    getRecent,
    allowedOrigins: opts.allowedOrigins,
  });

  return new Promise((resolve, reject) => {
    // EADDRINUSE friendly path. Most users hit this when a previous relay
    // run is still holding 9090. Print a one-line hint instead of spewing
    // a stack trace + suggesting the env-var override + reject the promise
    // so the caller can `process.exit(1)` cleanly.
    const onError = (err) => {
      if (err && err.code === "EADDRINUSE") {
        process.stderr.write(
          `[inspector] Port ${port} already in use. ` +
          `Set BROWSER_RELAY_INSPECTOR_PORT=9091 (or another free port) and try again.\n`,
        );
      }
      reject(err);
    };
    server.once("error", onError);

    server.listen(port, bind, () => {
      server.removeListener("error", onError);
      const addr = server.address();
      const actualPort = addr ? addr.port : port;
      const actualBind = addr ? addr.address : bind;
      resolve({
        server,
        wss,
        port: actualPort,
        bind: actualBind,
        close: () => new Promise((r) => {
          // Terminate any live WS clients first — wss.close() alone won't
          // return until all connected sockets close, which can hang in
          // tests where the client process never gracefully closes.
          try {
            for (const client of wss.clients) {
              try { client.terminate(); } catch { /* noop */ }
            }
          } catch { /* noop */ }
          try { wss.close(); } catch { /* noop */ }
          // G0-5 (2026-05-10): force-close idle keep-alive HTTP sockets so
          // server.close() resolves promptly. Without this, an idle
          // inspector tab with a keep-alive TCP socket would block close()
          // for up to keepAliveTimeout (5s) per stuck connection. Node 18.2+
          // exposes server.closeAllConnections (idle + active). Fall through
          // gracefully on older Node.
          if (typeof server.closeAllConnections === "function") {
            try { server.closeAllConnections(); } catch { /* noop */ }
          }
          server.close(() => r());
        }),
      });
    });
  });
}

/** Synchronous variant for tests that prefer the unstarted server (back
 *  compat with the W7-W9 createInspector shape). */
function createInspector(seamsOrOpts = {}) {
  // Two calling shapes:
  //   - Old W7-W9: createInspector(seams) — seams has _loadConfig etc.
  //   - New W10:  createInspector({ uiRoot, seams, trafficEmitter, getRecent })
  // We disambiguate by looking for the seam properties.
  const looksLikeOptsBag =
    seamsOrOpts && (
      Object.prototype.hasOwnProperty.call(seamsOrOpts, "uiRoot") ||
      Object.prototype.hasOwnProperty.call(seamsOrOpts, "seams") ||
      Object.prototype.hasOwnProperty.call(seamsOrOpts, "trafficEmitter") ||
      Object.prototype.hasOwnProperty.call(seamsOrOpts, "getRecent")
    );
  const opts = looksLikeOptsBag
    ? seamsOrOpts
    : { seams: seamsOrOpts };
  const uiRoot = opts.uiRoot || path.join(__dirname, "..", "scripts", "inspector-ui");
  const seams = opts.seams || {};

  let getRecent = opts.getRecent;
  if (!getRecent && opts.trafficEmitter && typeof opts.trafficEmitter.getRecent === "function") {
    getRecent = () => opts.trafficEmitter.getRecent();
  }

  const enrichedSeams = { ...seams };
  if (!enrichedSeams._trafficBuffer && getRecent) {
    Object.defineProperty(enrichedSeams, "_trafficBuffer", {
      get: getRecent,
      enumerable: true,
    });
  }

  const handler = makeHandler({
    uiRoot,
    seams: enrichedSeams,
    allowedOrigins: opts.allowedOrigins,
    mutators: opts.mutators,
  });
  const server = http.createServer(handler);
  const wss = attachWebsocket(server, {
    trafficEmitter: opts.trafficEmitter || null,
    getRecent,
    allowedOrigins: opts.allowedOrigins,
  });
  // Stash the wss on the server so test teardown can close it cleanly.
  server.__wss = wss;
  return server;
}

function defaultPort(env = process.env) {
  const raw = env.BROWSER_RELAY_INSPECTOR_PORT;
  if (!raw) return 9090;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return 9090;
  return n;
}

function defaultBind(env = process.env) {
  const raw = env.BROWSER_RELAY_INSPECTOR_BIND;
  if (!raw) return "127.0.0.1";
  return raw;
}

module.exports = {
  startInspector,
  createInspector,
  attachWebsocket,
  buildStatus,
  buildSettings,
  buildToolsCatalog,
  buildSlotDetail,
  buildActivity,
  makeHandler,
  defaultPort,
  defaultBind,
  redactPath,
  redactErrorPaths,
  formatDuration,
  truncate,
  inputSchemaPreview,
  TRACKED_ENV_VARS,
  OWN_TOOL_META,
};
