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
// Repeat-click guard: on 2026-11-16 each retry of a failed download re-licensed
// a paid Adobe Stock asset. A second clickSelector click on the same page URL +
// selector within REPEAT_CLICK_WINDOW_MS (10 min: longer than a retry loop,
// shorter than a deliberate second purchase usually takes) is refused unless
// the caller passes allowRepeatClick: true. A click that timed out before it
// was dispatched (Playwright TimeoutError) does not count.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { withActivePage } = require("./_active-page.js");

const REPEAT_CLICK_WINDOW_MS = 10 * 60 * 1000;
const recentClicks = new Map(); // `${pageUrl}\n${selector}` -> ms of the last click
const CHARGE_WARNING = "The server may already have served (or charged for) this file: check whether it "
  + "was delivered or billed before clicking again, and do not retry blindly. A repeat click on this page + "
  + "selector is refused for 10 min unless you pass allowRepeatClick: true.";

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
  handler: async ({ clickSelector, savePath, timeoutMs = 30000, allowRepeatClick = false }) => withActivePage(async ({ page }) => {
    let clickKey = null;
    if (clickSelector) {
      const now = Date.now();
      for (const [k, at] of recentClicks) if (now - at >= REPEAT_CLICK_WINDOW_MS) recentClicks.delete(k);
      clickKey = `${page.url()}\n${clickSelector}`;
      const last = recentClicks.get(clickKey);
      if (last !== undefined && allowRepeatClick !== true) {
        return {
          content: [{
            type: "text",
            text: `download_capture REFUSED: ${JSON.stringify(clickSelector)} on this page was clicked ${Math.round((now - last) / 1000)}s ago. `
              + "A repeat click may download the file again, and the server may already have served or charged for it "
              + "(a paid asset is licensed per click). Check whether the first download was delivered or billed; "
              + "to click again anyway, pass allowRepeatClick: true.",
          }],
          isError: true,
        };
      }
    }

    // Promise-race pattern: setup the download wait BEFORE triggering, to avoid
    // missing fast downloads.
    const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });

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
      return await capture({ page, clickSelector, clickKey, savePath, timeoutMs, downloadPromise, closePromise, onClose, dir });
    } finally {
      if (session) await session.detach().catch(() => { /* page closed */ });
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  }),
  // F1-14: exported as a test seam.
  sanitizeDownloadFilename,
  REPEAT_CLICK_WINDOW_MS,
};

/** The click, the wait and the copy; the caller owns `dir` and its CDP session. */
async function capture({ page, clickSelector, clickKey, savePath, timeoutMs, downloadPromise, closePromise, onClose, dir }) {
  if (clickSelector) {
    try {
      await page.click(clickSelector, { timeout: timeoutMs });
      recentClicks.set(clickKey, Date.now());
    } catch (e) {
      // A timeout means it was never clicked; anything else may have clicked.
      const mayHaveClicked = !(e && e.name === "TimeoutError");
      if (mayHaveClicked) recentClicks.set(clickKey, Date.now());
      // Cleanup before early-return.
      if (onClose) page.off("close", onClose);
      return { content: [{ type: "text", text: `click failed: ${e.message}${mayHaveClicked ? ` ${CHARGE_WARNING}` : ""}` }], isError: true };
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
    const failure = await download.failure(); // waits for the download to finish
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
