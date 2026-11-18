// download_capture — wait for the next download triggered by user action and
// save it to disk. Bypasses the OS download dialog. Pair with interaction_click
// to: click button → wait for download → save to known path.
//
// Own download dir (2026-11-17, ask as-ops/ask-bnyrbp; backlog 2026-09-17
// item 1 and its 2026-11-16 recurrence). Each Playwright connection sends
// Browser.setDownloadBehavior with its own playwright-artifacts-* dir when it
// attaches (playwright-core crBrowser.js, CRBrowserContext._initialize), so the
// LAST client to attach decides where Chrome writes downloads — in the relay
// that is upstream, which connects over CDP after the relay's launch. The
// relay's download.saveAs then copied from its own, empty dir: ENOENT (or
// "canceled" once upstream disconnected). So, immediately before each click
// (upstream re-asserts its dir whenever it attaches again), this tool points
// the browser at a dir of its own (allowAndName names the file by the
// download's guid, eventsEnabled keeps Playwright's download events), waits for
// the download to finish, and copies <dir>/<guid> to the save path. The CDP
// session that set the behaviour stays attached until then: Chrome resets a
// session's download override when it detaches, which cancels a download in
// flight (measured 2026-11-17 on Chrome for Testing 1217: detach before the
// download finished -> "canceled"). After this tool returns, the browser's
// downloads are back in Chrome's default handling until something sets them
// again — as they already were after upstream disconnected. The own dir is
// made per call (mkdtemp, 0700) and removed when the call ends. If it cannot be
// set up, the tool falls back to Playwright's saveAs, as before.
//
// One call at a time: Browser.setDownloadBehavior is browser-wide, so with two
// calls in flight the last one's dir wins and the first one's detach cancels the
// other's download (review r1 M2, measured). Calls queue on a module-level
// chain. A queued call waits at most QUEUE_WAIT_MS (2 min) for its turn, or
// until its caller's abort signal fires (the handler's second argument,
// { signal }, passed by relay-server.js from the MCP SDK's request `extra`); then
// it is refused without clicking and its reservation is released (review r2
// M3). Every CDP step (setDownloadBehavior, cancel, detach, the download's path)
// is bounded by CDP_STEP_MS (10 s), and newCDPSession by NEW_SESSION_MS (30 s),
// so one hung CDP call can no longer hold the queue forever. If the own dir
// cannot be set up, a clickSelector call is refused BEFORE its click and its
// reservation released (review r3 M1): the saveAs fallback cannot work in the
// relay, so clicking would risk a charged download with no file; a call without
// clickSelector still falls back to saveAs. A clickSelector call whose savePath's
// directory cannot be created or written, or whose savePath is an existing
// directory, is refused before its click too (checked after the other pre-click
// refusals, so those create no directories — final review of 5ec97f6), and
// once the download has finished in the own dir, a failed copy to savePath (its
// parent became a file, a full disk) keeps the own dir and names the file in
// the error rather than deleting a possibly charged file (review of 140cf47,
// M1). timeoutMs that is null, negative or not a number is the 30 s default
// (L4). Before the session detaches, a download that
// began on it but was never captured (it began as the wait gave up) is
// cancelled (Browser.cancelDownload), so it cannot recreate the dir; one that
// begins after the detach is cancelled by Chrome (measured 2026-11-17, with and
// without a second client attached). The own dir is removed after the detach,
// and always again 1 s and 5 s later in case Chrome recreated it; a failed
// removal is logged and never changes the call's result (review r2 M1). The
// session is per tab but the dir is browser-wide: a download in ANOTHER tab
// during the call lands in the dir too (deleted with it, or cancelled later,
// recreating it). So each call first removes this process's earlier own dirs
// and any relay-download-* dir of this user idle for STALE_DIR_MS (24 h).
//
// Bounded wait: once a download has started, the tool cancels it after
// STALL_MS (2 min; the caller's stallMs, 1 s to 30 min) without progress, read
// from Chrome's Browser.downloadProgress events on the tool's own CDP session
// (measured 2026-11-17 on Chrome for Testing: they arrive there, receivedBytes
// rising) for the captured download's guid only, matched by url + suggested
// filename from Browser.downloadWillBegin (review r3 L3). A download that keeps
// progressing is not cancelled unless the caller passes maxDownloadMs, an
// overall limit from the download's start. With no progress events for it (no
// own session, or the events went elsewhere), a fixed bound applies:
// FALLBACK_FINISH_MS (10 min), or stallMs if longer.
//
// Repeat-click guard: on 2026-11-16 each retry of a failed download re-licensed
// a paid Adobe Stock asset. A clickSelector click on the same page (origin +
// path of its URL: another query string or fragment is the same page) + the
// same selector within REPEAT_CLICK_WINDOW_MS (10 min from the click attempt:
// longer than a retry loop, shorter than a deliberate second purchase usually
// takes) is refused unless the caller passes allowRepeatClick: true, which
// overrides that one key only. The click is RESERVED at call start, before any
// await, in one locked read-modify-write of <userCacheRoot>/.download-clicks.json
// (reap-hold.js withFileLock, the challenge-clicks pattern; a hash of the key,
// never the URL), so a concurrent call, a restarted relay, a /resume and
// another relay on the same machine all see it. When the call's turn comes,
// immediately before the click and with no await in between, the page's
// origin + path is checked against the reserved key (a page that moved is
// refused) and the reservation's time is rewritten to the click attempt under
// the lock, so the 10 minutes run from the click (review r2 M2). The
// reservation is kept once the click is attempted, whatever the click's outcome
// (a click Playwright dispatched can still time out waiting for the navigation
// it scheduled — review r1 H1); it is released only when the call ends before
// the click is attempted. An unreadable reservation file refuses every
// clickSelector call, allowRepeatClick included (fail closed); removing the file
// resets it and clears every relay's reservations. NOT covered: a different
// selector for the same button, and an interaction_click (or execute) followed
// by download_capture without clickSelector — the guard sees only its own
// clickSelector clicks.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { withActivePage } = require("./_active-page.js");
const { withFileLock } = require("../reap-hold.js");

const REPEAT_CLICK_WINDOW_MS = 10 * 60 * 1000;
// newSession: measured 0.3-7.7 ms on 2026-11-17 at load average ~29; 30 s is
// for a machine far slower than that, since giving up now refuses the click.
const DEFAULTS = { stall: 2 * 60 * 1000, cdpStep: 10 * 1000, newSession: 30 * 1000, queueWait: 2 * 60 * 1000 };
let FALLBACK_FINISH_MS = 10 * 60 * 1000;
// timeoutMs (the click, and the wait for the download to start) is capped, so
// an own dir waiting for a download never sits idle long enough (STALE_DIR_MS)
// for another relay's sweep to take it (review r4 L2).
const TIMEOUT_MAX_MS = 60 * 60 * 1000;
const STALL_MIN_MS = 1000;
const STALL_MAX_MS = 30 * 60 * 1000;
const STALE_DIR_MS = 24 * 60 * 60 * 1000;
let STALL_MS = DEFAULTS.stall;
let CDP_STEP_MS = DEFAULTS.cdpStep;
let NEW_SESSION_MS = DEFAULTS.newSession;
let QUEUE_WAIT_MS = DEFAULTS.queueWait;
const STATE_FILE = ".download-clicks.json";
const STATE_LOCK = ".download-clicks.flock";
const CHARGE_WARNING = "The server may already have served (or charged for) this file: check whether it "
  + "was delivered or billed before clicking again, and do not retry blindly. A repeat click on this page + "
  + "selector is refused for 10 min from the click unless you pass allowRepeatClick: true.";

let stateDirOverride = null;
/** Where the reservations live: the relay's cache root (shared by every relay
 *  of this user). pool-shared is required lazily: it loads the pool wrapper. */
function stateDir() {
  return stateDirOverride || require("../pool-shared.js").userCacheRoot();
}

/** The reservation key: a hash of origin + path of `pageUrl` and the selector. */
function clickKeyOf(pageUrl, selector) {
  let page = String(pageUrl);
  try { const u = new URL(page); page = u.origin + u.pathname; } catch { /* not a URL: as is */ }
  return crypto.createHash("sha256").update(`${page}\n${selector}`).digest("hex");
}

/** Run `fn(entries)` on the live reservations under the file's lock; `fn` may
 *  change them, and they are written back when it returns { write: true }.
 *  Returns fn's result, or { error } (lock busy or unopenable, file unreadable
 *  or unwritable: fail closed). An unreadable file is never overwritten. */
function withReservations(fn) {
  const root = stateDir();
  try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
  const file = path.join(root, STATE_FILE);
  let out = { error: `reservation file ${file} could not be read or written` };
  const ran = withFileLock(path.join(root, STATE_LOCK), () => {
    let entries = {};
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      entries = v;
    } catch (e) {
      if (e.code !== "ENOENT") {
        out = { error: `reservation file ${file} is unreadable (${e.message}); removing it resets it, which also clears every other relay's reservations` };
        return;
      }
    }
    const now = Date.now();
    for (const [k, v] of Object.entries(entries)) {
      const at = v && Number(v.at);
      if (!(Number.isFinite(at) && now - at < REPEAT_CLICK_WINDOW_MS && at <= now + 5000)) delete entries[k];
    }
    const r = fn(entries, now);
    if (r.write) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    out = r.result;
  }, { waitMs: 2000 });
  if (ran === "busy") return { error: "reservation file lock busy after 2000 ms" };
  if (ran === "error") return { error: "reservation file lock cannot be opened" };
  return out;
}

/** Reserve the click for `key`, synchronously: { at } or { prevAt, prevPid } or
 *  { error }. allowRepeat overrides this key only. */
function reserveClick(key, allowRepeat) {
  return withReservations((entries, now) => {
    const prev = entries[key];
    if (prev && !allowRepeat) return { write: false, result: { prevAt: Number(prev.at), prevPid: prev.pid } };
    entries[key] = { at: now, pid: process.pid };
    return { write: true, result: { at: now } };
  });
}

/** At the click attempt: rewrite OUR reservation's time to now, so the window
 *  runs from the click. Another call's reservation in its place (ours expired
 *  and was taken, or an allowRepeatClick call replaced it) refuses, unless
 *  allowRepeat. Returns { at } or { prevAt, prevPid } or { error }. */
function confirmClick(reservation, allowRepeat) {
  return withReservations((entries, now) => {
    const e = entries[reservation.key];
    const ours = e && Number(e.at) === reservation.at && e.pid === process.pid;
    if (e && !ours && !allowRepeat) return { write: false, result: { prevAt: Number(e.at), prevPid: e.pid } };
    entries[reservation.key] = { at: now, pid: process.pid };
    return { write: true, result: { at: now } };
  });
}

/** Undo OUR reservation (the call ended before the click was attempted). */
function releaseClick(key, at) {
  withReservations((entries) => {
    const e = entries[key];
    if (!e || Number(e.at) !== at || e.pid !== process.pid) return { write: false, result: null };
    delete entries[key];
    return { write: true, result: null };
  });
}

/** `fn()`'s promise, or a rejection after `ms` (the step is abandoned, not
 *  undone). A synchronous throw from `fn` is a rejection too. */
function bounded(fn, ms, what) {
  let timer;
  return Promise.race([
    new Promise((resolve) => resolve(fn())),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// One download_capture at a time (see the header). A waiting call gives up
// after QUEUE_WAIT_MS or when `signal` aborts: it then resolves { gaveUp }, and
// its fn never runs. A call that has started is never abandoned (its own steps
// are bounded).
let chain = Promise.resolve();
function serialized(fn, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let state = "waiting"; // -> "running" | "gave-up"
    let timer = null;
    const onAbort = () => giveUp("aborted");
    const settle = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); };
    function giveUp(why) {
      if (state !== "waiting") return;
      state = "gave-up";
      settle();
      resolve({ gaveUp: why });
    }
    timer = setTimeout(() => giveUp("wait"), QUEUE_WAIT_MS);
    if (signal) {
      if (signal.aborted) giveUp("aborted");
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const run = chain.then(() => {
      if (state !== "waiting") return undefined;
      state = "running";
      settle();
      return fn();
    });
    chain = run.then(() => {}, () => {});
    run.then((v) => { if (state === "running") resolve(v); }, (e) => { if (state === "running") reject(e); });
  });
}

/** Point the browser's downloads at `dir` (the last setDownloadBehavior wins).
 *  Returns the CDP session: detaching it resets the override (see the header).
 *  Each step is bounded; a session that arrives after its bound is detached. */
async function pointDownloadsAt(page, dir) {
  let pending = null;
  let session;
  try {
    session = await bounded(() => (pending = page.context().newCDPSession(page)), NEW_SESSION_MS, "newCDPSession");
  } catch (e) {
    if (pending) Promise.resolve(pending).then((s) => { bounded(() => s.detach(), CDP_STEP_MS, "detach").catch(() => {}); }, () => {});
    throw e;
  }
  try {
    await bounded(() => session.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true }), CDP_STEP_MS, "Browser.setDownloadBehavior");
  } catch (e) {
    bounded(() => session.detach(), CDP_STEP_MS, "detach").catch(() => { /* page closing */ });
    throw e;
  }
  return session;
}

// The own dirs this process made (newest last). Calls run one at a time, so at
// a call's start none of them is in use: each is removed again then, which
// catches one Chrome recreated after its call ended (review r3 L2).
const madeDirs = [];

/** At a call's start: remove this process's earlier own dirs, and any other
 *  relay-download-* dir of this user whose newest entry is older than
 *  STALE_DIR_MS (its relay is gone). Never throws. */
function sweepOwnDirs() {
  for (const d of madeDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* next call */ }
    if (fs.existsSync(d)) madeDirs.push(d);
  }
  const tmp = os.tmpdir();
  let names = [];
  try { names = fs.readdirSync(tmp).filter((n) => n.startsWith("relay-download-")); } catch { return; }
  const now = Date.now();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const n of names) {
    const d = path.join(tmp, n);
    try {
      const st = fs.lstatSync(d);
      // Another user's dir is never touched. Not tested: a test cannot make a
      // dir owned by another uid without root (accepted, review r4).
      if (!st.isDirectory() || (uid !== null && st.uid !== uid)) continue;
      let newest = st.mtimeMs;
      for (const e of fs.readdirSync(d)) newest = Math.max(newest, fs.lstatSync(path.join(d, e)).mtimeMs);
      if (now - newest > STALE_DIR_MS) fs.rmSync(d, { recursive: true, force: true });
    } catch { /* raced or unreadable: leave it */ }
  }
}

/** Remove an own dir; a failure (Chrome still writing: ENOTEMPTY) is logged and
 *  never thrown. Always again 1 s and 5 s later. */
function removeOwnDir(d) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch (e) {
    process.stderr.write(`[mcp-relay] download_capture: own dir ${d} not removed yet (${e.code || e.message}); retrying in 1 s\n`);
  }
  for (const ms of [1000, 5000]) {
    setTimeout(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* left: $TMPDIR/relay-download-* */ } }, ms).unref();
  }
}

/** The repeat-click refusal: who made the earlier click, and how long ago. */
function repeatRefusal(clickSelector, prevAt, prevPid) {
  const who = prevPid === process.pid
    ? "by this relay"
    : `by another relay on this machine (another session or browser profile${Number.isInteger(prevPid) ? `, pid ${prevPid}` : ""})`;
  return refused(`a click on ${JSON.stringify(clickSelector)} at this page's address (origin + path) was reserved or made ${who} `
    + `${Math.max(0, Math.round((Date.now() - prevAt) / 1000))}s ago. `
    + "A repeat click may download the file again, and the server may already have served or charged for it "
    + "(a paid asset is licensed per click). Check whether the first download was delivered or billed; "
    + "to click again anyway, pass allowRepeatClick: true.");
}

function refused(why) {
  return { content: [{ type: "text", text: `download_capture REFUSED: ${why}` }], isError: true };
}

// F1-14 (2026-05-10): control-char range built from char codes so the source
// file stays plain ASCII. Embedding literal U+0000..U+001F bytes into a regex
// literal in the file makes git classify the file as binary (per its
// is-binary heuristic), which breaks code-review diff rendering.
const CONTROL_CHAR_RANGE = (() => {
  let s = "";
  for (let i = 0; i <= 0x1f; i++) s += String.fromCharCode(i);
  s += String.fromCharCode(0x7f);
  return s;
})();
const CONTROL_CHAR_RE = new RegExp("[" + CONTROL_CHAR_RANGE.replace(/[\\^\]-]/g, "\\$&") + "]", "g");

/**
 * Sanitize a server-supplied download filename so it can be safely concatenated
 * into a path inside os.tmpdir() without enabling path traversal.
 *
 * Pure helper — exported for tests.
 *
 * Steps (in order):
 *   1. Coerce to string.
 *   2. Strip any leading/trailing whitespace.
 *   3. Replace ALL forward slashes + backslashes with `_` (so a Linux-shaped
 *      "../foo" sent to a Windows host doesn't sneak past path.basename, which
 *      on win32 only splits on backslash).
 *   4. Replace control chars (U+0000..U+001F + U+007F) with `_`.
 *   5. Strip any leading "." prefix to defang `..`/`...etc`/hidden file names.
 *   6. Replace any colon (Windows ADS / drive-letter shenanigans) with `_`.
 *   7. Take path.basename ONE more time to belt-and-brace.
 *   8. If the result is empty (was just slashes / dots), substitute "file.bin".
 *   9. Cap at 200 chars to avoid OS NAME_MAX issues.
 */
function sanitizeDownloadFilename(raw) {
  let s = String(raw == null ? "" : raw).trim();
  s = s.replace(/[/\\]/g, "_");
  s = s.replace(CONTROL_CHAR_RE, "_");
  s = s.replace(/^\.+/, "");
  s = s.replace(/:/g, "_");
  s = path.basename(s);
  if (s.length === 0) s = "file.bin";
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

module.exports = {
  name: "download_capture",
  description:
    "Wait for the next download event in the active page and save the file to " +
    "disk. Returns the saved file path. Call AFTER triggering the action that " +
    "starts the download (or use clickSelector to trigger inside this tool). " +
    "Default save location is OS temp dir with the suggested filename. " +
    "A second clickSelector click on the same page + selector within 10 min of the first is refused " +
    "(a retry can re-buy a paid download) unless allowRepeatClick is true. A started download is " +
    "cancelled after 2 min without progress (stallMs), or at maxDownloadMs if given.",
  inputSchema: {
    type: "object",
    properties: {
      clickSelector: {
        type: "string",
        description: "Optional: click this selector to trigger the download.",
      },
      savePath: {
        type: "string",
        description: "Optional output file path. Default: OS temp dir + suggested filename. With clickSelector, a directory that cannot be created or written, or a savePath that is an existing directory, is refused before the click.",
      },
      timeoutMs: {
        type: "integer",
        default: 30000,
        description: "Max wait for the click and for the download to start (capped at 3600000, 1 h; 0 means the cap).",
      },
      allowRepeatClick: {
        type: "boolean",
        default: false,
        description: "Click clickSelector even though it was clicked on this page in the last 10 min. Only after checking the first click's download was not delivered or billed.",
      },
      maxDownloadMs: {
        type: "integer",
        description: "Optional overall limit for a started download, from its start. Without it, a download is cancelled after stallMs without progress (or after 10 min if Chrome reports no progress for it).",
      },
      stallMs: {
        type: "integer",
        description: "Optional: cancel a started download after this long without progress (default 120000; 1000 to 1800000).",
      },
    },
  },
  handler: async ({ clickSelector, savePath, timeoutMs = 30000, allowRepeatClick = false, maxDownloadMs, stallMs }, extra) => withActivePage(({ page }) => {
    const signal = extra && extra.signal;
    const allowRepeat = allowRepeatClick === true;
    // Reserve the click NOW, before any await (see the header).
    let reservation = null;
    if (clickSelector) {
      const key = clickKeyOf(page.url(), clickSelector);
      const r = reserveClick(key, allowRepeat);
      if (r.error) return refused(`${r.error}. A click could not be checked against recent clicks, so it was not made.`);
      if (r.prevAt !== undefined) return repeatRefusal(clickSelector, r.prevAt, r.prevPid);
      reservation = { key, at: r.at };
    }
    const st = { clickAttempted: false, download: null, finished: false };
    const maxMs = Number.isFinite(maxDownloadMs) && maxDownloadMs > 0 ? maxDownloadMs : null;
    const stall = Number.isFinite(stallMs) ? Math.min(STALL_MAX_MS, Math.max(STALL_MIN_MS, stallMs)) : STALL_MS;
    // Only a finite timeoutMs >= 0 is used (0 = the cap); null, negative or
    // not a number is the 30 s default, never the 1 h cap (review of 140cf47, L4).
    const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 30000;
    const waitMs = timeout > 0 ? Math.min(TIMEOUT_MAX_MS, timeout) : TIMEOUT_MAX_MS;
    return serialized(
      () => setUpAndCapture({ page, clickSelector, savePath, timeoutMs: waitMs, limits: { maxDownloadMs: maxMs, stallMs: stall }, st, reservation, allowRepeat, signal }),
      { signal },
    ).then((r) => {
      if (!r || !r.gaveUp) return r;
      return refused(r.gaveUp === "aborted"
        ? "the caller cancelled the request while it waited for its turn — not clicked, nothing captured."
        : `waited ${Math.round(QUEUE_WAIT_MS / 1000)} s behind another download_capture call — not clicked, nothing captured. Calling again is not a repeat click.`);
    }).finally(() => {
      if (reservation && !st.clickAttempted) releaseClick(reservation.key, reservation.at);
    });
  }),
  // F1-14: exported as a test seam.
  sanitizeDownloadFilename,
  REPEAT_CLICK_WINDOW_MS,
  /** Test seam: the reservations' dir (null = the relay's cache root). */
  _setStateDir(dir) { stateDirOverride = dir; },
  /** Test seams (null = the default). */
  _setStallMs(ms) { STALL_MS = ms == null ? DEFAULTS.stall : ms; },
  _setCdpStepMs(ms) { CDP_STEP_MS = ms == null ? DEFAULTS.cdpStep : ms; },
  _setFallbackFinishMs(ms) { FALLBACK_FINISH_MS = ms == null ? 10 * 60 * 1000 : ms; },
  _setNewSessionMs(ms) { NEW_SESSION_MS = ms == null ? DEFAULTS.newSession : ms; },
  _setQueueWaitMs(ms) { QUEUE_WAIT_MS = ms == null ? DEFAULTS.queueWait : ms; },
  _reserveClick: reserveClick,
};

/** Inside the queue: the download wait, the own dir and its session, then capture(). */
async function setUpAndCapture({ page, clickSelector, savePath, timeoutMs, limits, st, reservation, allowRepeat, signal }) {
  if (typeof page.isClosed === "function" && page.isClosed()) {
    return { content: [{ type: "text", text: "download_capture: the page closed before this call's turn" }], isError: true };
  }
  // Promise-race pattern: setup the download wait BEFORE triggering, to avoid
  // missing fast downloads. Marked handled: an early return (a click failure)
  // leaves it to time out on its own, which must not be an unhandledRejection.
  const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
  downloadPromise.catch(() => {});

  // T0-9: race the download wait against the page's `close` event. Without
  // this, calling tabs_close on the page mid-download (or having the page
  // crash) leaves waitForEvent pending until the full timeoutMs (default 30s).
  // The close-promise rejects with a clean message so the user gets actionable
  // feedback instead of a generic timeout.
  //
  // G0-1 (2026-05-10): hoist `onClose` outside the Promise constructor so it
  // can be `page.off()`'d on the SUCCESS path. Previously the close listener
  // was only removed when it fired (rejection path) — every successful
  // download leaked one `close` listener until the page actually closed,
  // tripping MaxListenersExceededWarning after ~10 sequential downloads.
  let onClose;
  const closePromise = new Promise((_, reject) => {
    onClose = () => reject(new Error("page closed before download started"));
    page.once("close", onClose);
  });
  closePromise.catch(() => {});

  // Own download dir, set immediately before the click (see the header).
  let dir = null;
  let session = null;
  sweepOwnDirs();
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-download-"));
    madeDirs.push(dir);
    if (madeDirs.length > 50) madeDirs.shift();
    session = await pointDownloadsAt(page, dir);
  } catch (e) {
    if (dir) removeOwnDir(dir);
    dir = null;
    if (clickSelector) {
      // The saveAs fallback cannot work in the relay (upstream's download dir
      // wins): clicking now could be a charged download with no file. Refuse
      // before the click; the reservation is released (review r3 M1).
      if (onClose) page.off("close", onClose);
      return refused(`its own download directory could not be set up (${e.message}) — not clicked, nothing captured. `
        + "Without it the file would be saved where this relay cannot read it. Calling again is not a repeat click.");
    }
    process.stderr.write(`[mcp-relay] download_capture: own download dir not set (${e.message}) — falling back to saveAs\n`);
  }
  // Progress of the CAPTURED download only, from Chrome's events on our own
  // session (see the header); it is matched by url + suggested filename
  // (review r3 L3: another download in the tab must not keep it alive).
  const progress = { guid: null, want: null, seen: false, last: Date.now(), bytes: -1 };
  const begins = []; // downloadWillBegin events, in order
  const begun = new Set(); // guids of downloads that began on our session
  const ended = new Set(); // ...and of those that completed or were cancelled
  const onWillBegin = (e) => {
    if (!e || !e.guid) return;
    begun.add(e.guid);
    begins.push(e);
    if (progress.want && !progress.guid && e.url === progress.want.url && e.suggestedFilename === progress.want.name) progress.guid = e.guid;
  };
  progress.match = (url, name) => {
    progress.want = { url, name };
    const b = begins.find((e) => e.url === url && e.suggestedFilename === name);
    if (b) progress.guid = b.guid;
  };
  const onProgress = (e) => {
    if (e && e.guid && e.state !== "inProgress") ended.add(e.guid);
    if (!e || !progress.guid || e.guid !== progress.guid) return;
    progress.seen = true;
    const got = Number(e.receivedBytes) || 0;
    if (got > progress.bytes || e.state !== "inProgress") {
      progress.bytes = got;
      progress.last = Date.now();
    }
  };
  if (session && typeof session.on === "function") {
    session.on("Browser.downloadProgress", onProgress);
    session.on("Browser.downloadWillBegin", onWillBegin);
  }
  try {
    return await capture({ page, clickSelector, savePath, timeoutMs, limits, downloadPromise, closePromise, onClose, dir, st, reservation, allowRepeat, signal, progress });
  } finally {
    // A download that did not finish is cancelled first, so nothing writes into the dir after it goes.
    // Each step is bounded, and none of them can change the result.
    if (st.download && !st.finished) await bounded(() => st.download.cancel(), CDP_STEP_MS, "download.cancel").catch(() => { /* gone or hung */ });
    if (session) {
      // A download that began on our session but was never captured (it began
      // as the wait gave up) would write into the dir after it is removed and
      // recreate it: cancel it before detaching.
      for (const guid of begun) {
        if (!ended.has(guid)) await bounded(() => session.send("Browser.cancelDownload", { guid }), CDP_STEP_MS, "Browser.cancelDownload").catch(() => { /* finished or gone */ });
      }
      if (typeof session.off === "function") {
        session.off("Browser.downloadProgress", onProgress);
        session.off("Browser.downloadWillBegin", onWillBegin);
      }
      await bounded(() => session.detach(), CDP_STEP_MS, "detach").catch(() => { /* page closed or hung */ });
    }
    if (dir && st.keepDir) {
      // It may hold a finished, charged file nobody could copy: kept, and out
      // of the next call's sweep; the 24 h idle sweep still removes it later.
      const i = madeDirs.indexOf(dir);
      if (i >= 0) madeDirs.splice(i, 1);
    } else if (dir) {
      removeOwnDir(dir);
    }
  }
}

/** Resolves when the download finishes (its failure string, or null); rejects
 *  when it stalls, passes maxDownloadMs, or (no progress events) the fallback bound. */
function finishOrGiveUp(download, progress, { maxDownloadMs, stallMs }) {
  const fallbackMs = Math.max(FALLBACK_FINISH_MS, stallMs);
  const started = Date.now();
  progress.last = started; // the start is progress
  let timer;
  const watchdog = new Promise((_, reject) => {
    const tick = () => {
      const now = Date.now();
      if (maxDownloadMs && now - started >= maxDownloadMs) {
        return reject(new Error(`the download did not finish within maxDownloadMs (${maxDownloadMs} ms); cancelled`));
      }
      if (progress.seen && now - progress.last >= stallMs) {
        return reject(new Error(`the download did not finish: no progress for ${Math.round(stallMs / 1000)} s; cancelled`));
      }
      if (!progress.seen && now - started >= fallbackMs) {
        return reject(new Error(`the download did not finish in ${Math.round(fallbackMs / 1000)} s (no progress reported); cancelled`));
      }
      timer = setTimeout(tick, 200);
    };
    timer = setTimeout(tick, 200);
  });
  return Promise.race([download.failure(), watchdog]).finally(() => clearTimeout(timer));
}

/** Why `savePath` cannot take the file (synchronous; creates its parent), or null. */
function savePathProblem(savePath) {
  let st = null;
  try { st = fs.statSync(savePath, { throwIfNoEntry: false }); } catch { /* checked below via its parent */ }
  if (st && st.isDirectory()) return `savePath ${savePath} is an existing directory, not a file path`;
  const parent = path.dirname(savePath);
  try {
    fs.mkdirSync(parent, { recursive: true });
    fs.accessSync(parent, fs.constants.W_OK);
  } catch (e) {
    return `savePath's directory ${parent} cannot be created or written (${e.code || e.message})`;
  }
  return null;
}

/** The click, the wait and the copy; the caller owns `dir` and its CDP session. */
async function capture({ page, clickSelector, savePath, timeoutMs, limits, downloadPromise, closePromise, onClose, dir, st, reservation, allowRepeat, signal, progress }) {
  if (clickSelector) {
    // At the click, with no await from here to page.click (see the header).
    let refusal = null;
    if (signal && signal.aborted) {
      refusal = refused("the caller cancelled the request before its turn — not clicked, nothing captured.");
    } else if (reservation && clickKeyOf(page.url(), clickSelector) !== reservation.key) {
      refusal = refused("the page's address (origin + path) changed while this call waited for its turn — not clicked. "
        + "Go back to the page and call again if that click is still wanted; it is not a repeat click.");
    } else if (reservation) {
      const c = confirmClick(reservation, allowRepeat);
      if (c.error) refusal = refused(`${c.error}. A click could not be checked against recent clicks, so it was not made.`);
      else if (c.prevAt !== undefined) refusal = repeatRefusal(clickSelector, c.prevAt, c.prevPid);
      else reservation.at = c.at;
    }
    // The destination is checked before the click (review of 140cf47, M1): a
    // click whose file cannot be written risks a charged download with nowhere
    // to put it. Last, so a call refused for another reason makes no
    // directories in the caller's path (final review of 5ec97f6, L4); a
    // savePath that is an existing directory is refused too (L2). Synchronous,
    // so still no await before page.click.
    const destProblem = !refusal && savePath ? savePathProblem(savePath) : null;
    if (destProblem) {
      refusal = refused(`${destProblem} — not clicked, nothing captured. Pass a file path in a writable directory; calling again is not a repeat click.`);
    }
    if (refusal) {
      if (onClose) page.off("close", onClose);
      return refusal;
    }
    st.clickAttempted = true; // from here on the reservation stands, whatever happens
    try {
      await page.click(clickSelector, { timeout: timeoutMs });
    } catch (e) {
      // Cleanup before early-return. A click Playwright dispatched can still
      // time out waiting for the navigation it scheduled (review r1 H1).
      if (onClose) page.off("close", onClose);
      return { content: [{ type: "text", text: `click failed: ${e.message} ${CHARGE_WARNING}` }], isError: true };
    }
  }

  let download;
  try {
    download = await Promise.race([downloadPromise, closePromise]);
  } catch (e) {
    const isPageClosed = /page closed/i.test(e.message);
    // If we're here because of a NON-close error (timeout, etc.), the
    // close listener is still attached and needs removal. If we're here
    // because of close, the listener already fired (page.once auto-cleans).
    if (!isPageClosed && onClose) page.off("close", onClose);
    return {
      content: [{
        type: "text",
        text: (isPageClosed
          ? `download_capture: ${e.message}`
          : `no download in ${timeoutMs}ms: ${e.message}`) + (clickSelector ? ` ${CHARGE_WARNING}` : ""),
      }],
      isError: true,
    };
  }
  st.download = download;
  // G0-1: success path — remove the close listener now that the download
  // has fired. Otherwise it accumulates per call until the page closes.
  if (onClose) page.off("close", onClose);

  // F1-14 (2026-05-10): sanitize the server-suggested filename. The
  // download's HTTP Content-Disposition header is fully attacker-controlled —
  // a malicious server could send `../../../etc/passwd` or `\..\..\windows\
  // system32\foo` and our default-path concat would write outside os.tmpdir().
  // sanitizeDownloadFilename strips any directory components on either
  // separator + control chars + leading dots + colons.
  const rawSuggested = download.suggestedFilename() || "file.bin";
  progress.match(download.url(), download.suggestedFilename());
  const suggested = sanitizeDownloadFilename(rawSuggested);
  const dst = savePath || path.join(os.tmpdir(), `download-${Date.now()}-${suggested}`);
  let own = null; // <own dir>/<guid>: where Chrome wrote it when our dir won
  try {
    // Waits for the download to finish: until it stalls or passes maxDownloadMs.
    const failure = await finishOrGiveUp(download, progress, limits);
    st.finished = true;
    if (failure) throw new Error(`download failed: ${failure}`);
    if (dir) {
      // Chrome names the file by its guid (allowAndName): when the captured
      // download's guid is known, no CDP call is needed (review r4 L3).
      const byGuid = progress.guid ? path.join(dir, path.basename(String(progress.guid))) : null;
      if (byGuid && fs.existsSync(byGuid)) {
        own = byGuid;
      } else {
        try {
          const p = path.join(dir, path.basename(await bounded(() => download.path(), CDP_STEP_MS, "download.path")));
          if (fs.existsSync(p)) own = p;
        } catch { /* no local path: saveAs below */ }
      }
    }
    try {
      // Ensure parent dir exists when caller passed a custom savePath. The
      // default path uses os.tmpdir() which always exists, so this only
      // matters for explicit savePath values.
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (own) fs.copyFileSync(own, dst);
      else await bounded(() => download.saveAs(dst), FALLBACK_FINISH_MS, "download.saveAs");
    } catch (e) {
      // Never delete what may be the charged file: keep the dir, name it. A
      // failed mkdir or copy (savePath's parent became a file, read-only, a
      // full disk) keeps it too (review of 140cf47, M1).
      if (own) {
        st.keepDir = true;
        throw new Error(`${e.message}. The finished download is kept at ${own} (in ${dir}; copy it from there — it is removed once idle for 24 h)`);
      }
      let held = [];
      try { held = dir ? fs.readdirSync(dir) : []; } catch { /* gone */ }
      if (held.length > 0) {
        st.keepDir = true;
        throw new Error(`${e.message}. The finished download may be in ${dir} (kept; copy it from there — it is removed once idle for 24 h)`);
      }
      throw e;
    }
  } catch (e) {
    return {
      content: [{ type: "text", text: `saveAs failed: ${e.message} ${CHARGE_WARNING}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ savedTo: dst, suggestedFilename: suggested, url: download.url() }, null, 2),
    }],
  };
}
