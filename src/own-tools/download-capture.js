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
// chain; nothing is refused for that. The own dir is removed after the session
// detaches, and once more a second later in case Chrome recreated it.
//
// Bounded wait: once a download has started, the tool waits at most
// DOWNLOAD_FINISH_MS (10 min) for it to finish; then it cancels it, detaches and
// removes its dir, and says so — a stalled download no longer holds the CDP
// session and the dir forever.
//
// Repeat-click guard: on 2026-11-16 each retry of a failed download re-licensed
// a paid Adobe Stock asset. A clickSelector click on the same page (origin +
// path of its URL when the call starts: another query string or fragment is the
// same page) + the same selector within REPEAT_CLICK_WINDOW_MS (10 min: longer
// than a retry loop, shorter than a deliberate second purchase usually takes) is
// refused unless the caller passes allowRepeatClick: true. The click is
// RESERVED at call start, before any await, in one locked read-modify-write of
// <userCacheRoot>/.download-clicks.json (reap-hold.js withFileLock, the
// challenge-clicks pattern; a hash of the key, never the URL), so a concurrent
// call, a restarted relay, a /resume and another relay on the same machine all
// see it. The reservation is kept once the click is attempted, whatever the
// click's outcome (a click Playwright dispatched can still time out waiting
// for the navigation it scheduled — review r1 H1); it is released only when
// the call ends before the click is attempted. An unreadable reservation file
// refuses (fail closed). NOT covered: a different selector for the same
// button, and an interaction_click (or execute) followed by download_capture
// without clickSelector — the guard sees only its own clickSelector clicks.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { withActivePage } = require("./_active-page.js");
const { withFileLock } = require("../reap-hold.js");

const REPEAT_CLICK_WINDOW_MS = 10 * 60 * 1000;
let DOWNLOAD_FINISH_MS = 10 * 60 * 1000;
const STATE_FILE = ".download-clicks.json";
const STATE_LOCK = ".download-clicks.flock";
const CHARGE_WARNING = "The server may already have served (or charged for) this file: check whether it "
  + "was delivered or billed before clicking again, and do not retry blindly. A repeat click on this page + "
  + "selector is refused for 10 min unless you pass allowRepeatClick: true.";

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
 *  change them, and they are written back when it returns true. Returns fn's
 *  result, or { error } (lock busy or unopenable, file unreadable: fail closed). */
function withReservations(fn, { resetUnreadable = false } = {}) {
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
      if (e.code !== "ENOENT" && !resetUnreadable) { out = { error: `reservation file ${file} is unreadable (${e.message}); remove it to reset` }; return; }
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

/** Reserve the click for `key`, synchronously: { at } or { prevAt } or { error }. */
function reserveClick(key, allowRepeat) {
  return withReservations((entries, now) => {
    const prev = entries[key];
    if (prev && !allowRepeat) return { write: false, result: { prevAt: Number(prev.at) } };
    entries[key] = { at: now, pid: process.pid };
    return { write: true, result: { at: now } };
  }, { resetUnreadable: allowRepeat });
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

// One download_capture at a time (see the header): a queue, never a refusal.
let chain = Promise.resolve();
function serialized(fn) {
  const run = chain.then(fn);
  chain = run.then(() => {}, () => {});
  return run;
}

/** Point the browser's downloads at `dir` (the last setDownloadBehavior wins).
 *  Returns the CDP session: detaching it resets the override (see the header). */
async function pointDownloadsAt(page, dir) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: dir, eventsEnabled: true });
  } catch (e) {
    session.detach().catch(() => { /* page closing */ });
    throw e;
  }
  return session;
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
    "A second clickSelector click on the same page + selector within 10 min is refused " +
    "(a retry can re-buy a paid download) unless allowRepeatClick is true.",
  inputSchema: {
    type: "object",
    properties: {
      clickSelector: {
        type: "string",
        description: "Optional: click this selector to trigger the download.",
      },
      savePath: {
        type: "string",
        description: "Optional output file path. Default: OS temp dir + suggested filename.",
      },
      timeoutMs: {
        type: "integer",
        default: 30000,
        description: "Max wait for download to start.",
      },
      allowRepeatClick: {
        type: "boolean",
        default: false,
        description: "Click clickSelector even though it was clicked on this page in the last 10 min. Only after checking the first click's download was not delivered or billed.",
      },
    },
  },
  handler: async ({ clickSelector, savePath, timeoutMs = 30000, allowRepeatClick = false }) => withActivePage(({ page }) => {
    // Reserve the click NOW, before any await (see the header).
    let reservation = null;
    if (clickSelector) {
      const key = clickKeyOf(page.url(), clickSelector);
      const r = reserveClick(key, allowRepeatClick === true);
      if (r.error) {
        return { content: [{ type: "text", text: `download_capture REFUSED: ${r.error}. A click could not be checked against recent clicks, so it was not made.` }], isError: true };
      }
      if (r.prevAt !== undefined) {
        return {
          content: [{
            type: "text",
            text: `download_capture REFUSED: ${JSON.stringify(clickSelector)} on this page was clicked ${Math.max(0, Math.round((Date.now() - r.prevAt) / 1000))}s ago. `
              + "A repeat click may download the file again, and the server may already have served or charged for it "
              + "(a paid asset is licensed per click). Check whether the first download was delivered or billed; "
              + "to click again anyway, pass allowRepeatClick: true.",
          }],
          isError: true,
        };
      }
      reservation = { key, at: r.at };
    }
    const st = { clickAttempted: false, download: null, finished: false };
    return serialized(async () => {
      try {
        return await setUpAndCapture({ page, clickSelector, savePath, timeoutMs, st });
      } finally {
        if (reservation && !st.clickAttempted) releaseClick(reservation.key, reservation.at);
      }
    });
  }),
  // F1-14: exported as a test seam.
  sanitizeDownloadFilename,
  REPEAT_CLICK_WINDOW_MS,
  /** Test seam: the reservations' dir (null = the relay's cache root). */
  _setStateDir(dir) { stateDirOverride = dir; },
  /** Test seam: the finish bound (null = 10 min). */
  _setDownloadFinishMs(ms) { DOWNLOAD_FINISH_MS = ms == null ? 10 * 60 * 1000 : ms; },
};

/** Inside the queue: the download wait, the own dir and its session, then capture(). */
async function setUpAndCapture({ page, clickSelector, savePath, timeoutMs, st }) {
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
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-download-"));
    session = await pointDownloadsAt(page, dir);
  } catch (e) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
    process.stderr.write(`[mcp-relay] download_capture: own download dir not set (${e.message}) — falling back to saveAs\n`);
  }
  try {
    return await capture({ page, clickSelector, savePath, timeoutMs, downloadPromise, closePromise, onClose, dir, st });
  } finally {
    // A download that did not finish is cancelled first, so nothing writes into the dir after it goes.
    if (st.download && !st.finished) await st.download.cancel().catch(() => { /* gone */ });
    if (session) await session.detach().catch(() => { /* page closed */ });
    if (dir) {
      const d = dir;
      fs.rmSync(d, { recursive: true, force: true });
      // Chrome can recreate the dir for a write already under way: once more, later.
      setTimeout(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }, 1000).unref();
    }
  }
}

/** The click, the wait and the copy; the caller owns `dir` and its CDP session. */
async function capture({ page, clickSelector, savePath, timeoutMs, downloadPromise, closePromise, onClose, dir, st }) {
  if (clickSelector) {
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
  const suggested = sanitizeDownloadFilename(rawSuggested);
  const dst = savePath || path.join(os.tmpdir(), `download-${Date.now()}-${suggested}`);
  let own = null; // <own dir>/<guid>: where Chrome wrote it when our dir won
  try {
    // Waits for the download to finish — at most DOWNLOAD_FINISH_MS.
    let timer;
    const failure = await Promise.race([
      download.failure(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the download did not finish in ${Math.round(DOWNLOAD_FINISH_MS / 1000)} s; cancelled`)), DOWNLOAD_FINISH_MS); }),
    ]).finally(() => clearTimeout(timer));
    st.finished = true;
    if (failure) throw new Error(`download failed: ${failure}`);
    if (dir) {
      try {
        const p = path.join(dir, path.basename(await download.path()));
        if (fs.existsSync(p)) own = p;
      } catch { /* no local path: saveAs below */ }
    }
    // Ensure parent dir exists when caller passed a custom savePath. The
    // default path uses os.tmpdir() which always exists, so this only
    // matters for explicit savePath values.
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (own) fs.copyFileSync(own, dst);
    else await download.saveAs(dst);
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
