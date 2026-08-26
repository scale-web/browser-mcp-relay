// cdp-bridge.js — launches Brave for a slot via Playwright launchPersistentContext
// with a remote-debugging-port that BOTH our relay AND upstream attach to via
// chromium.connectOverCDP. See docs/probe-cdp-access.js for the standalone
// probe used to verify this architecture.

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { applyLocalConfigToEnv } = require("./local-config.js");

/**
 * Delete the profile's session store so Brave starts with one tab instead of
 * restoring the whole accumulated set.
 *
 * WHY: Brave persists every open tab to <profile>/Default/Sessions and restores
 * them on each relaunch. That made the idle reaper a temporary dip rather than a
 * bound — reap frees the RAM, the next tool call relaunches, and all 20-40 tabs
 * come back at once. Measured 2026-08-21: 18.4 GB across 3 profiles, 88 tabs.
 *
 * WHY NOT Preferences: setting `session.restore_on_startup` (and
 * `profile.exit_type`) in Default/Preferences DOES NOT WORK — measured on a
 * throwaway profile with production launch opts. The pref read back intact after
 * launch (so Playwright is not clobbering it) and Brave restored the tabs anyway:
 * control 3 tabs, Preferences 6, delete 0. Do not "simplify" this back to a pref.
 *
 * SCOPE IS LOAD-BEARING — exactly `Default/Sessions`, nothing wider. That
 * directory holds only Session_* / Tabs_* files and is a SIBLING of Cookies,
 * Local Storage and IndexedDB, which is where every login actually lives (GHL =
 * cookies + IndexedDB firebaseLocalStorageDb; iClosed = localStorage, no auth
 * cookie at all). Widening this to the profile root, or globbing "Session*",
 * would cost client-account re-logins that may not be self-serve recoverable.
 *
 * Escape hatch: BROWSER_RELAY_KEEP_TABS=1 restores the old restore-on-relaunch
 * behaviour for anyone who wants it back.
 *
 * Must run BEFORE launchPersistentContext, while no Brave holds the profile.
 */
function clearSessionRestore(userDataDir, env = applyLocalConfigToEnv(process.env)) {
  // Default to the relay's RESOLVED env (process.env overlaid with
  // local-config.json), never bare process.env. This opt-out is the documented
  // mitigation for an idle reap catching a human mid-flow, and it is now written
  // into two operator runbooks — if someone sets it in local-config.json (the
  // obvious place, since every other relay knob lives there) it MUST work.
  // Reading process.env directly is precisely the bug the sibling commit fixes
  // for BROWSER_RELAY_MAX_TABS; it was reintroduced here in the same branch.
  const keep = env.BROWSER_RELAY_KEEP_TABS;
  if (keep && keep !== "0" && keep !== "false") return { cleared: false, reason: "BROWSER_RELAY_KEEP_TABS" };
  try {
    // Inside the try: a nullish userDataDir would otherwise throw
    // ERR_INVALID_ARG_TYPE out of a function whose contract is "never fails a launch".
    // Absolute-only: path.join("", "Default", "Sessions") is RELATIVE and would
    // resolve against process.cwd(), so an empty userDataDir from a hand-written
    // or corrupt wrapper config would delete <cwd>/Default/Sessions. tryClaimDir("")
    // succeeds, so this is reachable rather than theoretical.
    if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
      return { cleared: false, reason: `refusing non-absolute userDataDir: ${JSON.stringify(userDataDir)}` };
    }
    const dir = path.join(userDataDir, "Default", "Sessions");
    if (!fs.existsSync(dir)) return { cleared: false, reason: "absent" };
    fs.rmSync(dir, { recursive: true, force: true });
    return { cleared: true, reason: null };
  } catch (e) {
    // Never fail a launch over this — worst case is the old restore behaviour.
    return { cleared: false, reason: e.message };
  }
}

/**
 * Launch Brave for the slot. Returns a handle the caller passes back to
 * closeBrave on shutdown.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir — pool slot dir
 * @param {number} opts.port — unique per slot, exposes CDP HTTP endpoint
 * @param {boolean} [opts.headless]
 * @param {string|null} [opts.extensionPath] — passed via --load-extension
 * @param {string} [opts.executablePath] — overrides bundled chromium
 * @param {string|null} [opts.proxyUrl] — when set, Brave inherits HTTP_PROXY /
 *   HTTPS_PROXY env so its outbound traffic routes through an HTTP proxy you
 *   control (e.g. a local debug proxy like Charles, mitmproxy, powhttp). The
 *   user's system proxy stays untouched — only this launched Brave opts in.
 * @returns {Promise<{ context: import('playwright-core').BrowserContext, cdpConnectUrl: string }>}
 */
async function launchBrave({
  userDataDir,
  port,
  headless = false,
  extensionPath = null,
  executablePath,
  proxyUrl = null,
}) {
  const args = [`--remote-debugging-port=${port}`];
  // Strip Playwright's default `--use-mock-keychain`. That flag tells Chromium
  // to bypass the OS keychain (DPAPI on Windows, Keychain on macOS, libsecret
  // on Linux), which prevents Brave from unwrapping `Local State.os_crypt
  // .encrypted_key` and decrypting the v10 encrypted_value blobs in Cookies /
  // Login Data SQLite. Result: cookies and DPAPI-protected password rows
  // copied from the snapshot source decrypt as garbage.
  //
  // Caveat: Brave 127+ App-Bound Encryption (ABE) wraps a separate
  // `app_bound_encrypted_key` validated by an elevated COM service that
  // checks the calling exe identity. Removing mock-keychain restores the
  // OS keychain fallback path, so v10 rows decrypt; v20 (ABE-only) rows may
  // still fail under Playwright-launched Brave.
  const ignoreDefaultArgs = ["--use-mock-keychain"];
  if (extensionPath) {
    args.push(`--load-extension=${extensionPath}`);
    args.push(`--disable-extensions-except=${extensionPath}`);
    ignoreDefaultArgs.push("--disable-extensions");
  }
  // TLS-cert acceptance is opt-in: a configured proxy implies a MITM cert,
  // and BROWSER_RELAY_INSECURE_TLS is the explicit override for a transparent
  // corporate proxy. Anything else gets normal certificate validation.
  const insecureTlsEnv = process.env.BROWSER_RELAY_INSECURE_TLS;
  const insecureTlsForced = Boolean(insecureTlsEnv) && insecureTlsEnv !== "0" && insecureTlsEnv !== "false";
  const allowInsecureTls = Boolean(proxyUrl) || insecureTlsForced;
  if (insecureTlsForced && !proxyUrl) {
    process.stderr.write(
      "[mcp-relay] BROWSER_RELAY_INSECURE_TLS set with no proxy — this Brave accepts ANY TLS cert; only do this on a network you trust\n",
    );
  }

  const launchOpts = {
    headless,
    args,
    ignoreDefaultArgs,
    // Accept any TLS cert — ONLY when the operator has opted in. Needed when
    // Brave is routed through a debug proxy (see proxyUrl below) that presents
    // its own MITM cert, or behind a corporate proxy with a private CA:
    // Chromium's cert verifier under Playwright doesn't reliably honor
    // user-installed roots, so navigation through a MITM cert can throw
    // ERR_CERT_AUTHORITY_INVALID even with the CA trusted at the OS level.
    //
    // 2026-08-25: this was previously `true` UNCONDITIONALLY, which meant every
    // relay browser silently accepted forged certificates even with no proxy
    // configured — while docs/REFERENCE.md claimed the relay "accepts any TLS
    // cert WHEN A PROXY IS SET". The code now matches that documented contract.
    // It matters because these contexts drive authenticated sessions; on a
    // hostile network an always-on bypass is a standing silent-MITM exposure.
    //
    // Escape hatch for a transparent corporate proxy (no proxyUrl set but a
    // private CA in play): BROWSER_RELAY_INSECURE_TLS=1.
    //
    // Scoped to this BrowserContext only — does not affect the user's main
    // browser. Preferred over `--ignore-certificate-errors` because that flag
    // requires `--test-type=webdriver`, which suppresses Brave's password-
    // manager UI.
    ignoreHTTPSErrors: allowInsecureTls,
    handleSIGINT: false,
    handleSIGTERM: false,
  };
  if (executablePath) launchOpts.executablePath = executablePath;

  // W0-7 (2026-05-09): unconditionally strip BROWSER_RELAY_* env vars from
  // the env passed to Brave. Previously the strip only happened when proxyUrl
  // was set — when proxyUrl was unset, no `env` was set on launchOpts at all,
  // so Playwright defaulted to passing process.env wholesale to Chromium.
  // BROWSER_RELAY_INSPECTOR_PORT, BROWSER_RELAY_VAULT_FILES, BROWSER_RELAY_*
  // are relay-internal and shouldn't be visible to Brave (which would try
  // to interpret them on a chrome:// extension page that loads Node-aware
  // code, etc.). Always sanitize.
  const sanitizedEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("BROWSER_RELAY_")) continue; // relay-internal
    sanitizedEnv[k] = v;
  }

  // Per-process proxy whitelist: when proxyUrl is set, Brave inherits
  // HTTP_PROXY / HTTPS_PROXY env so outbound traffic routes through the
  // configured HTTP proxy. The user's system proxy stays off — only this
  // launched Brave opts in.
  if (proxyUrl) {
    sanitizedEnv.HTTP_PROXY = proxyUrl;
    sanitizedEnv.HTTPS_PROXY = proxyUrl;
    process.stderr.write(
      `[mcp-relay] proxy whitelist ACTIVE — Brave traffic routes through ${proxyUrl}\n`,
    );
  }
  launchOpts.env = sanitizedEnv;

  // Start clean: drop the restored tab set (see clearSessionRestore above).
  const sessionClear = clearSessionRestore(userDataDir);
  if (sessionClear.cleared) {
    process.stderr.write("[mcp-relay] cleared session restore — Brave starts with a fresh tab set\n");
  } else if (sessionClear.reason === "BROWSER_RELAY_KEEP_TABS") {
    process.stderr.write("[mcp-relay] BROWSER_RELAY_KEEP_TABS set — restoring previous tabs (RAM grows across relaunches)\n");
  } else if (sessionClear.reason && sessionClear.reason !== "absent") {
    // Never silent. The point of this change is a RAM bound; if the delete starts
    // failing, the whole tab set comes back with no other signal that it did.
    process.stderr.write(`[mcp-relay] could NOT clear session restore (${sessionClear.reason}) — Brave will restore its previous tabs\n`);
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchOpts);

  // Wait for the CDP HTTP endpoint to respond before returning. Upstream's
  // connectOverCDP will hit /json/version, so we want it ready first.
  //
  // V0-3: launchPersistentContext returned a LIVE context that holds a file
  // lock on userDataDir. If waitForCdpReady throws (timeout, unreachable CDP),
  // the context would leak forever — the lock blocks any other relay from
  // claiming this slot until the user reboots / kills brave.exe by hand. So
  // we close the context on any waitForCdpReady failure before re-throwing.
  // attachWithCleanupOnError in index.js only wraps post-launch steps, so
  // this cleanup must live here.
  try {
    await waitForCdpReady(port, 10000);
  } catch (e) {
    try { await context.close(); }
    catch (closeErr) {
      process.stderr.write(
        `[mcp-relay] cdp-bridge: context.close() failed during waitForCdpReady cleanup: ${closeErr.message}\n`,
      );
    }
    throw e;
  }

  return {
    context,
    cdpConnectUrl: `http://127.0.0.1:${port}`,
  };
}

/**
 * Attach to an ALREADY-RUNNING Brave via its CDP HTTP endpoint instead of
 * launching a new one. Used when a previous relay died uncleanly and left
 * its Brave orphaned on our profile dir — attaching preserves the user's
 * open tabs; the old reap-and-relaunch path destroyed them.
 *
 * The returned handle is shaped like launchBrave's ({ context,
 * cdpConnectUrl }) plus { attached: true, browser } so closeBrave and the
 * entrypoint's bridge-invalidation listeners can tell the two apart.
 *
 * @param {object} opts
 * @param {number} opts.port — the running Brave's --remote-debugging-port
 * @param {number} [opts.timeoutMs=5000]
 */
async function attachBrave({ port, timeoutMs = 5000 }) {
  const cdpConnectUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.connectOverCDP(cdpConnectUrl, { timeout: timeoutMs });
  // A persistent-context Brave always exposes its default context. A brand-
  // new context here would NOT see the profile's cookies/tabs, so only fall
  // back to creating one if contexts() is somehow empty.
  const context = browser.contexts()[0] || (await browser.newContext());
  return { context, cdpConnectUrl, attached: true, browser };
}

/**
 * HARD close — actually terminates the Brave process, including for
 * attached handles (where plain closeBrave only disconnects). Used by the
 * idle reaper, whose whole point is reclaiming the browser's RAM: an
 * idle-for-an-hour Brave's tabs are stale, its profile persists on disk,
 * and the next tool call relaunches it with logins intact.
 *
 * For attached browsers, Playwright's browser.close() only severs the CDP
 * connection — the real kill is the CDP `Browser.close` command sent over
 * a browser-level session. Falls back to disconnect if that fails.
 * Best-effort — never throws.
 */
async function closeBraveHard(handle) {
  if (!handle) return;
  if (handle.attached && handle.browser) {
    try {
      const cdp = await handle.browser.newBrowserCDPSession();
      await cdp.send("Browser.close");
      return;
    } catch (e) {
      process.stderr.write(`[mcp-relay] CDP Browser.close failed (${e.message}); disconnecting only\n`);
    }
    try { await handle.browser.close(); } catch { /* already gone */ }
    return;
  }
  try {
    await handle.context.close();
  } catch (e) {
    process.stderr.write(`[mcp-relay] cdp-bridge hard close failed: ${e.message}\n`);
  }
}

/**
 * Graceful close. Best-effort — never throws. The caller's relay shutdown
 * handler invokes this even on signal-driven exits, so it must be quiet.
 *
 * Attached handles (from attachBrave) are DISCONNECTED, not closed: we
 * didn't launch that Brave, and killing the user's window on relay exit is
 * the exact behavior the attach path exists to avoid. Playwright's
 * browser.close() on a connectOverCDP browser only severs the connection;
 * the browser process keeps running and the next relay re-attaches to it.
 */
async function closeBrave(handle) {
  if (!handle) return;
  try {
    if (handle.attached && handle.browser) {
      await handle.browser.close();
      return;
    }
    await handle.context.close();
  } catch (e) {
    process.stderr.write(`[mcp-relay] cdp-bridge close failed: ${e.message}\n`);
  }
}

/**
 * Poll /json/version (the standard CDP discovery endpoint) until it returns
 * 200, or timeout. Throws on timeout. Used after launchPersistentContext to
 * confirm the CDP endpoint is reachable before letting upstream try to attach.
 */
async function waitForCdpReady(port, timeoutMs) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (resp.ok) return;
      lastErr = new Error(`status ${resp.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `[mcp-relay] CDP endpoint http://127.0.0.1:${port}/json/version not ready after ${timeoutMs}ms: ${lastErr?.message || "unknown"}`,
  );
}

module.exports = { launchBrave, attachBrave, closeBrave, closeBraveHard, waitForCdpReady, _clearSessionRestore: clearSessionRestore };
