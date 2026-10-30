// challenge_detect — classify a Cloudflare wall and route it (spec v8 §5.2,
// phase 1). Read-only except the lines it appends to the shared CF-WALL log.
//
// Three call shapes:
//   (i)   { lane }                          on a loaded page: classify it (the §2
//         table, first match wins) and append ONE detection line when a wall is
//         seen. Reads the page's response headers (`curl -sI`, as the
//         cf-challenge skill's step 1A does), `dig` CNAME/A, and DOM markers in
//         EVERY frame of the frame tree (a GHL form's Turnstile sits inside the
//         form's own cross-origin iframe).
//   (ii)  { lane, origin, stage: "pre" }    BEFORE navigating, no page needed: reads
//         that origin's Cloudflare cookies from the jar with CDP Storage.getCookies
//         (every partition) and remembers the state for that lane + origin for
//         10 min. Appends nothing.
//   (iii) { lane, origin, stage: "outcome" } after a plain-flags try: reads the
//         page again and appends the OUTCOME line, with the cookie state
//         remembered from (ii) — `unknown` when there is no pre read for that
//         lane + origin, it is older than 10 min, or a relay restart lost it.
//
// `lane` is required: the relay has no lane of its own (status-sidecar `lane:
// null`); it comes from the session's `claude-ask whoami`.
//
// NEVER VALUES: cookies are reported by name, domain, path, flags and
// partition site only; Turnstile tokens by length only; response headers from
// a fixed list (no set-cookie), `location` as a host.
//
// Phase 1c (spec v8 §5.6): the plain-flags profile exists. In the DEFAULT relay
// `route` stays the base route (phase-1 behaviour) and an eligible wall only
// adds `switchTo: "browser-mcp-relay-plainflags"` / `plainflagsServer:
// "available-if-registered"` (clickBudget 0, shape (iii) refused — the default
// relay never tries); in the plain-flags relay it routes `plainflags-try`, clickBudget 1 only while no plain-flags relay has
// spent the host's click in the last 10 min (the shared count file,
// src/challenge-clicks.js). index.js wires the mode with configure().

"use strict";

const { execFile } = require("node:child_process");
const { getActivePage } = require("./_active-page.js");
const classify = require("../challenge-classify.js");
const cfWallLog = require("../cf-wall-log.js");
const { matchLoginUrl } = require("../known-accounts.js");
const { createSigninLoader } = require("../plainflags-signin.js");

const PRE_TTL_MS = 10 * 60 * 1000;
const FRAME_TIMEOUT_MS = 3000;
// The skill's step-1A user agent, so the header read matches what a session
// running the skill by hand sees.
const CURL_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const LANE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(String(stdout || ""));
    });
  });
}

// -q first (ignore ~/.curlrc), -g (no [a-b] / {x,y} globbing of the page path).
function curlArgs(url) {
  return ["-q", "-g", "-sI", "-A", CURL_UA, "--max-time", "10", url];
}

const DEFAULT_DEPS = {
  curlHead: (url) => run("curl", curlArgs(url), 12000),
  dig: (type, host) => run("dig", ["+short", "+time=3", "+tries=1", type, host], 8000),
  getCookies: async (bridge) => {
    if (!bridge || !bridge.wsEndpoint) throw new Error("no browser CDP endpoint");
    // Lazy: cdp-bridge pulls in Playwright; only a real call needs it.
    const { _cdpCall } = require("../cdp-bridge.js");
    const r = await _cdpCall(bridge.wsEndpoint, "Storage.getCookies", {});
    return Array.isArray(r.cookies) ? r.cookies : [];
  },
  // The default relay never clicks: no budget, no count (configure() wires the
  // shared count file in the plain-flags relay).
  clickCount: () => 0,
  clickSpent: () => true,
  now: () => new Date(),
  logPath: () => cfWallLog.logPath(),
  signin: createSigninLoader(),
  built: classify.PLAINFLAGS_BUILT,
  // Shape (iii) records the outcome of a plain-flags try, which only the
  // plain-flags relay makes: refused in the default relay (a stray call would
  // put a misleading line in the shared CF-WALL log).
  outcomeEnabled: false,
  mode: "default",
  frameTimeoutMs: FRAME_TIMEOUT_MS,
};

let deps = { ...DEFAULT_DEPS };
const preReads = new Map(); // `${lane}\n${origin}` → { cfCookies, at }

/** Drop pre reads past their 10 min, so the map cannot grow without bound. */
function evictExpired() {
  const now = deps.now().getTime();
  for (const [k, v] of preReads) if (now - v.at > PRE_TTL_MS) preReads.delete(k);
}

function text(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function fail(msg) {
  return { content: [{ type: "text", text: `challenge_detect: ${msg}` }], isError: true };
}

function normOrigin(o) {
  if (typeof o !== "string" || o.trim() === "") return null;
  let u;
  try { u = new URL(o.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.origin;
}

function digSafe(host) {
  return /^[a-z0-9.-]+$/i.test(host) && !host.startsWith("-");
}

const MAX_FRAMES = 50; // frames reported per scan
const MAX_ITEMS = 20; // per-frame array cap (the probe runs in page JS: never trust its sizes)
const KNOWN_CODES = ["600010", "110200"];
const MAX_WIDGET_DIGS = 3; // widget-frame hosts given their own DNS read per call
const DUP_WINDOW_MS = 60 * 1000;

const count = (n) => Math.max(0, Math.min(1e6, Math.floor(Number(n) || 0)));

/** One frame → marker counts (never values). Bounded by `timeoutMs`. */
async function scanFrame(f, main, timeoutMs) {
  let host = "";
  try { host = new URL(f.url()).hostname.toLowerCase().slice(0, classify.MAX_HOST_LEN); } catch { /* about:blank, srcdoc */ }
  const entry = { host, isTop: f === main, challengeFrame: host === classify.CHALLENGE_HOST };
  if (entry.challengeFrame) {
    // Recognised by its URL and never evaluated in: the detector adds nothing
    // inside the widget it is judging. Its parent says where the widget sits.
    try { const p = f.parentFrame && f.parentFrame(); entry.parentHost = p ? new URL(p.url()).hostname.toLowerCase().slice(0, classify.MAX_HOST_LEN) : null; } catch { entry.parentHost = null; }
    // F1 (phase 1c): whether the frame has a box at all, from its owner element
    // in the parent (never from inside it). Unknown → left unset (counts as visible).
    let timer;
    try {
      if (typeof f.frameElement === "function") {
        const read = (async () => { const el = await f.frameElement(); const b = el ? await el.boundingBox() : null; return b; })();
        const box = await Promise.race([read, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timeout")), timeoutMs); })]);
        entry.visible = !!(box && box.width > 0 && box.height > 0);
      }
    } catch { /* unknown */ } finally { clearTimeout(timer); }
    return entry;
  }
  let timer;
  try {
    const probe = f.evaluate(() => {
      "use strict";
      const q = (s) => { try { return Array.from(document.querySelectorAll(s)); } catch { return []; } };
      const body = document.body ? String(document.body.innerText || "").slice(0, 200000) : "";
      let navStatus = null;
      try {
        const n = performance.getEntriesByType("navigation")[0];
        if (n && typeof n.responseStatus === "number" && n.responseStatus > 0) navStatus = n.responseStatus;
      } catch { /* older engine */ }
      return {
        title: String(document.title || "").slice(0, 200),
        chlOpt: typeof window._cf_chl_opt !== "undefined",
        challengeIframes: q('iframe[src*="challenges.cloudflare.com"]').length,
        turnstileInputs: q('input[name="cf-turnstile-response"]').map((i) => String(i.value || "").length),
        turnstileDivs: q(".cf-turnstile").length,
        challengePlatform: q('script[src*="/cdn-cgi/challenge-platform/"]').length > 0,
        errorCodes: ["600010", "110200"].filter((c) => body.includes(c)),
        navStatus,
      };
    });
    const r = await Promise.race([
      probe,
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("frame scan timed out")), timeoutMs); }),
    ]);
    const o = r && typeof r === "object" ? r : {};
    Object.assign(entry, {
      chlOpt: o.chlOpt === true,
      challengeIframes: count(o.challengeIframes),
      turnstileInputs: Array.isArray(o.turnstileInputs) ? o.turnstileInputs.slice(0, MAX_ITEMS).map(count) : [],
      turnstileDivs: count(o.turnstileDivs),
      challengePlatform: o.challengePlatform === true,
      errorCodes: Array.isArray(o.errorCodes) ? KNOWN_CODES.filter((c) => o.errorCodes.slice(0, MAX_ITEMS).map(String).includes(c)) : [],
    });
    if (entry.isTop) {
      entry.title = String(o.title == null ? "" : o.title).slice(0, 200);
      const ns = Number(o.navStatus);
      entry.navStatus = Number.isInteger(ns) && ns >= 100 && ns <= 599 ? ns : null;
    }
  } catch (e) {
    entry.unreadable = String((e && e.message) || e).slice(0, 120);
  } finally {
    clearTimeout(timer);
  }
  return entry;
}

/** Every frame of the page's frame tree, concurrently, each with its own
 *  timeout. Each entry carries `id` (its index) and `parentId` (its parent's
 *  index, null when the parent is not in the scan) — F1's parent check. */
async function scanFrames(page) {
  const main = page.mainFrame();
  const frames = page.frames().slice(0, MAX_FRAMES);
  const entries = await Promise.all(frames.map((f) => scanFrame(f, main, deps.frameTimeoutMs)));
  entries.forEach((e, i) => {
    e.id = i;
    let p = null;
    try { p = frames[i] !== main && typeof frames[i].parentFrame === "function" ? frames[i].parentFrame() : null; } catch { /* detached */ }
    const pi = p ? frames.indexOf(p) : -1;
    e.parentId = pi >= 0 ? pi : null;
  });
  return entries;
}

/** Everything shape (i) and (iii) decide on, for the active page. */
async function gather(page, bridge) {
  const u = new URL(page.url());
  const host = u.hostname.toLowerCase();
  const target = u.origin + u.pathname; // no query or hash: they can carry tokens
  const settle = (p) => p.then((v) => ({ v }), (e) => ({ e: String((e && e.message) || e).slice(0, 160) }));
  const canDig = digSafe(host);
  const [curl, cname, a, frames, jar] = await Promise.all([
    settle(deps.curlHead(target)),
    canDig ? settle(deps.dig("CNAME", host)) : Promise.resolve({ e: "not a DNS name" }),
    canDig ? settle(deps.dig("A", host)) : Promise.resolve({ e: "not a DNS name" }),
    scanFrames(page),
    settle(deps.getCookies(bridge)),
  ]);
  const head = curl.v !== undefined ? classify.parseCurlHead(curl.v) : { status: null, headers: {} };
  const c1 = cname.v !== undefined ? classify.parseDig(cname.v) : { cnames: [], as: [] };
  const a1 = a.v !== undefined ? classify.parseDig(a.v) : { cnames: [], as: [] };
  const dns = {
    cnames: [...new Set([...c1.cnames, ...a1.cnames])].slice(0, classify.MAX_ANSWERS),
    as: [...new Set([...c1.as, ...a1.as])].slice(0, classify.MAX_ANSWERS),
  };
  const top = frames.find((f) => f.isTop) || {};
  const navStatus = top.navStatus ?? null;
  // Kind: browser evidence only. curl decides the owner, never the kind.
  const kind = classify.classifyKind({ frames, navStatus });
  const passed = kind === "turnstile" && classify.turnstilePassed(frames);
  // A widget frame on another, non-HighLevel-domain host gets its own DNS read:
  // a GHL form served from the location's white-label domain is HighLevel by
  // its CNAME/A, not by the host lists (review r2 #1).
  const dnsByHost = {};
  if (kind === "turnstile") {
    const toDig = classify.widgetCandidates(frames).filter((h) => !classify.isGhlWidgetHost(h) && digSafe(h)).slice(0, MAX_WIDGET_DIGS);
    await Promise.all(toDig.map(async (h) => {
      const [wc, wa] = await Promise.all([settle(deps.dig("CNAME", h)), settle(deps.dig("A", h))]);
      const x = wc.v !== undefined ? classify.parseDig(wc.v) : { cnames: [], as: [] };
      const y = wa.v !== undefined ? classify.parseDig(wa.v) : { cnames: [], as: [] };
      dnsByHost[h] = {
        cnames: [...new Set([...x.cnames, ...y.cnames])].slice(0, classify.MAX_ANSWERS),
        as: [...new Set([...x.as, ...y.as])].slice(0, classify.MAX_ANSWERS),
      };
    }));
  }
  const widgetHost = kind === "turnstile" ? classify.widgetFrameHost(frames, dnsByHost) : null;
  const own = classify.classifyOwner({ host, headers: head.headers, dns, kind, pageHost: host, widgetHost, widgetDns: widgetHost ? dnsByHost[widgetHost] : null });
  const cookies = jar.v !== undefined ? classify.cfCookieState(u.origin, jar.v) : { cfCookies: "unknown", cookies: [] };
  const errorCodes = [...new Set(frames.flatMap((f) => f.errorCodes || []))];
  const login = matchLoginUrl(u.href);
  return {
    url: target, origin: u.origin, host, owner: own.owner, row: own.row, ownerFrom: own.from || "page",
    kind, passed, cookies, errorCodes,
    signals: {
      navStatus,
      // curl's own read (another client: other TLS fingerprint, no cookies) —
      // context for the owner, never the kind.
      curl: {
        status: head.status,
        cfMitigated: head.headers["cf-mitigated"] || null,
        accessRedirect: head.status === 302 && String(head.headers.location || "").endsWith(".cloudflareaccess.com"),
      },
      headers: head.headers,
      dns,
      widgetFrameHost: widgetHost,
      widgetDns: dnsByHost,
      frames,
      loginPageOf: login ? login.account.name : null,
      errors: Object.fromEntries(Object.entries({ curl: curl.e, dig: cname.e || a.e, cookies: jar.e }).filter(([, v]) => v)),
    },
  };
}

function notesFor(g) {
  const notes = [];
  if (g.errorCodes.includes("600010")) notes.push("600010 = Turnstile bot detection (expected, benign).");
  if (g.errorCodes.includes("110200")) notes.push("110200 = sitekey/hostname mismatch — a real outage: report it.");
  if (g.passed) notes.push("The Turnstile on this page already holds a token: it has passed — not a wall, nothing appended.");
  if (g.signals.errors.curl) notes.push("Header read failed; the owner rests on DNS, the host lists and the page markers only.");
  if (g.signals.curl.cfMitigated && g.kind === "none") notes.push("curl was challenged but this page is not: curl is another client (no cookies, other TLS) — the page decides.");
  return notes;
}


const LOGGED_NOTE = "This is the wall's CF-WALL line — do not append another. A subagent: tell your parent it is already written.";
// lane + host + owner → { ts, at } of the last detection line this relay wrote
// (review r2 #8): a repeat call on the same wall within 60 s appends nothing.
const recentLines = new Map();

async function detect(lane, bridge) {
  const page = getActivePage(bridge.context);
  if (!page) return fail("no pages open");
  let proto = "";
  try { proto = new URL(page.url()).protocol; } catch { /* about:blank */ }
  if (proto !== "http:" && proto !== "https:") return fail(`the active page is not a web page (${page.url() || "blank"})`);
  const g = await gather(page, bridge);
  // A passed Turnstile is not a wall: route and eligibility treat it as none.
  const kindForRoute = g.passed ? "none" : g.kind;
  const r = classify.decideRoute({
    owner: g.owner, kind: kindForRoute, url: page.url(), built: deps.built, mode: deps.mode,
    signinNames: typeof deps.listedNames === "function" ? deps.listedNames() : deps.signin.load().names, clickSpent: deps.clickSpent(g.host),
  });
  // A wall: a Cloudflare owner, and a challenge or rate limit seen in the page —
  // or the browser sitting on an Access login.
  const wall = g.owner !== "none" && (kindForRoute !== "none" || g.owner === "access");
  // On the Access login page, the line names the protected app when the URL does.
  const logHost = g.owner === "access" ? (classify.accessAppHost(page.url()) || g.host) : g.host;
  const detected = g.owner === "access" && kindForRoute === "none" ? "access-login" : kindForRoute;
  let log = { logged: false, reason: "no wall detected — nothing appended (if you do see a wall, write the line by hand per cf-challenge)" };
  if (wall) {
    const now = deps.now();
    for (const [k, v] of recentLines) if (now.getTime() - v.at >= DUP_WINDOW_MS) recentLines.delete(k);
    const key = `${lane}\n${logHost}\n${g.owner}`;
    const prev = recentLines.get(key);
    if (prev) {
      log = { logged: false, duplicateOf: prev.ts, note: `Already logged at ${prev.ts} for this lane, host and owner — the same wall: do not append another.` };
    } else {
      log = cfWallLog.appendLine({
        lane, host: logHost, owner: g.owner, route: `detected ${detected}; next ${r.route}`,
        now, path: deps.logPath(),
      });
      if (log.logged) recentLines.set(key, { ts: cfWallLog.isoSeconds(now), at: now.getTime() });
      log = log.logged ? { ...log, note: LOGGED_NOTE } : { ...log, note: "Not appended — write the line by hand per cf-challenge." };
    }
  }
  const out = {
    lane, host: g.host, url: g.url, owner: g.owner, row: g.row, ownerFrom: g.ownerFrom, kind: g.kind, turnstilePassed: g.passed,
    plainflagsEligible: r.plainflagsEligible, reason: r.reason, route: r.route, clickBudget: r.clickBudget,
  };
  if (r.fallbackRoute) out.fallbackRoute = r.fallbackRoute;
  if (r.switchTo) { out.switchTo = r.switchTo; out.plainflagsServer = r.plainflagsServer; }
  if (r.route === "in-page-turnstile" || r.fallbackRoute === "in-page-turnstile") out.guidance = classify.turnstileGuidance(g.owner);
  if (logHost !== g.host) out.protectedHost = logHost;
  const notes = notesFor(g);
  return text({
    ...out,
    cfCookies: g.cookies.cfCookies, cookies: g.cookies.cookies,
    errorCodes: g.errorCodes, notes, signals: g.signals, log,
  });
}

async function pre(lane, origin, bridge) {
  let jar;
  try { jar = await deps.getCookies(bridge); } catch (e) { return fail(`cookie read failed: ${(e && e.message) || e}`); }
  const st = classify.cfCookieState(origin, jar);
  preReads.set(`${lane}\n${origin}`, { cfCookies: st.cfCookies, at: deps.now().getTime() });
  return text({
    lane, origin, stage: "pre", cfCookies: st.cfCookies, cookies: st.cookies,
    rememberedForMinutes: PRE_TTL_MS / 60000, log: { logged: false, reason: "a pre read appends nothing" },
  });
}

async function outcome(lane, origin, bridge) {
  const page = getActivePage(bridge.context);
  if (!page) return fail("no pages open");
  let pageOrigin = null;
  try { pageOrigin = new URL(page.url()).origin; } catch { /* about:blank */ }
  if (pageOrigin !== origin) {
    return fail(`the active page (${pageOrigin || page.url() || "blank"}) is not on ${origin} — select the try's tab first; nothing appended`);
  }
  const key = `${lane}\n${origin}`;
  const remembered = preReads.get(key);
  preReads.delete(key); // one pre read → one outcome line
  const fresh = remembered && deps.now().getTime() - remembered.at <= PRE_TTL_MS;
  const startState = fresh ? remembered.cfCookies : "unknown";
  const g = await gather(page, bridge);
  const result = classify.tryOutcome(g.kind, g.signals.frames);
  const clicks = Number(deps.clickCount(lane, origin)) || 0;
  const route = `${result === "passed" ? "plainflags: passed" : "plainflags: failed → handoff"}; cfCookies=${startState}; clicks=${clicks}`;
  const log = cfWallLog.appendLine({ lane, host: g.host, owner: g.owner, route, now: deps.now(), path: deps.logPath() });
  const tokenLengths = g.signals.frames.flatMap((f) => f.turnstileInputs || []);
  return text({
    lane, origin, stage: "outcome", outcome: result, cfCookiesAtStart: startState, clicks,
    owner: g.owner, kind: g.kind, interstitial: g.kind === "interstitial", tokenLengths,
    cfCookiesNow: g.cookies.cfCookies, signals: g.signals, log,
  });
}

module.exports = {
  name: "challenge_detect",
  description:
    "Classify a Cloudflare wall (\"Just a moment…\", a Turnstile widget, a 429, an Access login) and say whose it is " +
    "and where to route it — the cf-challenge skill's table, first match wins. Never clicks, never reloads. " +
    "`lane` is REQUIRED (your `claude-ask whoami` lane). Shapes: {lane} on the loaded page → owner " +
    "(highlevel|shopify|access|agency-test|agency|workersdev|vendor|none), kind, route, raw signals, and one line " +
    "appended to the shared CF-WALL log when the page shows a wall (then do not append another by hand); {lane, origin, stage:\"pre\"} before navigating → that " +
    "origin's Cloudflare cookie state (names only), remembered 10 min, nothing appended; {lane, origin, " +
    "stage:\"outcome\"} after a plain-flags try (plain-flags relay only) → appends the outcome line. An eligible wall " +
    "(HighLevel or vendor; interstitial or Turnstile; not a known account's login) keeps its route here and adds " +
    "switchTo: browser-mcp-relay-plainflags (if this session has that server); in that relay it routes plainflags-try.",
  inputSchema: {
    type: "object",
    properties: {
      lane: { type: "string", description: "Required. Your lane from `claude-ask whoami` (letters, digits, . _ / -)." },
      origin: { type: "string", description: "For stage pre/outcome: the site's origin, e.g. https://go.example.com." },
      stage: { type: "string", enum: ["pre", "outcome"], description: "Omit to classify the loaded page." },
    },
    required: ["lane"],
    additionalProperties: false,
  },
  handler: async (args = {}) => {
    const a = args && typeof args === "object" ? args : {};
    if (typeof a.lane !== "string" || !LANE_RE.test(a.lane.trim())) {
      return fail("`lane` is required — pass your lane from `claude-ask whoami` (letters, digits, . _ / -; the relay has no lane of its own). Nothing was read or appended.");
    }
    const lane = a.lane.trim();
    evictExpired();
    if (a.stage !== undefined && a.stage !== "pre" && a.stage !== "outcome") {
      return fail(`stage must be "pre" or "outcome", or omitted (got ${JSON.stringify(a.stage)})`);
    }
    let origin = null;
    if (a.stage !== undefined) {
      origin = normOrigin(a.origin);
      if (!origin) return fail(`stage "${a.stage}" needs \`origin\` — an http(s) origin such as https://go.example.com. Nothing was read or appended.`);
    } else if (a.origin !== undefined) {
      return fail("`origin` is only for stage \"pre\" or \"outcome\"; omit it to classify the loaded page");
    }
    const bridge = globalThis.__relayBridge;
    if (!bridge) return fail("bridge missing");
    if (a.stage === "pre") return pre(lane, origin, bridge);
    if (a.stage === "outcome") {
      if (!deps.outcomeEnabled) {
        return fail("stage \"outcome\" records a plain-flags try, which only the plain-flags relay (browser-mcp-relay-plainflags) makes — this relay never tries. Nothing was read or appended.");
      }
      return outcome(lane, origin, bridge);
    }
    return detect(lane, bridge);
  },
  /** Production wiring (src/index.js): the relay's profile mode, its sign-in
   *  list loader and, in the plain-flags relay, the shared click count. */
  configure({ mode = "default", signin = null, clicks = null, listedNames = null } = {}) {
    const plain = mode === "plainflags";
    deps = {
      ...deps,
      listedNames: listedNames || null,
      mode: plain ? "plainflags" : "default",
      outcomeEnabled: plain,
      ...(signin ? { signin } : {}),
      clickSpent: plain && clicks ? (host) => clicks.spent(host) : () => true,
      clickCount: plain && clicks ? (_lane, origin) => { try { return clicks.count(new URL(origin).hostname); } catch { return 0; } } : () => 0,
    };
  },
  // Test seams.
  _setDeps(over) { deps = { ...deps, ...over }; },
  _resetDeps() { deps = { ...DEFAULT_DEPS }; preReads.clear(); recentLines.clear(); },
  _preReads: preReads,
  _curlArgs: curlArgs,
  PRE_TTL_MS,
};
