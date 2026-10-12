// cdp-bridge.js — launches Brave for a slot via Playwright launchPersistentContext
// with --remote-debugging-port=0: the OS picks a free port, Brave reports it in
// <user-data-dir>/DevToolsActivePort, and the relay proves the 127.0.0.1
// listener is THIS Brave before anyone uses it (spec v4 §1b, cdp-identity.js).
// Playwright drives Brave over its own --remote-debugging-pipe; the TCP port is
// for the upstream child (via the exact ws endpoint), attach-first, the Meta
// guard and external scripts.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { applyLocalConfigToEnv } = require("./local-config.js");
const cdpIdentity = require("./cdp-identity.js");

// ── Test-only launch hook (spec v4 amendment 5) ─────────────────────────────
// BROWSER_RELAY_TEST_LAUNCH keeps Playwright's --use-mock-keychain (so a test
// Brave never touches the machine-global login keychain, which a fake HOME does
// not isolate) and appends a FIXED allowlist of harness args. It is refused —
// the relay throws and does not run — unless realpath(os.homedir()) is under
// realpath(os.tmpdir()) AND the profile dir is under that home: a leftover flag
// (local-config.json, a shell export) must fail loudly, never mock-key a real
// profile (Brave would then write cookies it can never decrypt again).
const TEST_LAUNCH_ARGS = Object.freeze(["--host-resolver-rules=MAP * 127.0.0.1"]);

function testLaunchRequested(env = applyLocalConfigToEnv(process.env)) {
  const v = env.BROWSER_RELAY_TEST_LAUNCH;
  return typeof v === "string" && v.length > 0;
}

function isUnderDir(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Throws unless the test hook may run here. `userDataDir` optional (the
 *  relay checks HOME first thing, and the claimed dir once it has one). */
function assertTestLaunchAllowed(userDataDir) {
  let home = null;
  try { home = fs.realpathSync(os.homedir()); } catch { /* unresolvable HOME is refused below */ }
  const tmp = fs.realpathSync(os.tmpdir());
  if (!home || !isUnderDir(home, tmp)) {
    throw new Error(`[mcp-relay] BROWSER_RELAY_TEST_LAUNCH is set but HOME (${home || os.homedir()}) is not under ${tmp} — refusing to run (unset it; it is for the isolated test harness only)`);
  }
  if (userDataDir !== undefined) {
    let real;
    try { real = fs.realpathSync(userDataDir); } catch (e) {
      throw new Error(`[mcp-relay] BROWSER_RELAY_TEST_LAUNCH: cannot resolve profile dir ${userDataDir}: ${e.message}`);
    }
    if (!isUnderDir(real, home)) {
      throw new Error(`[mcp-relay] BROWSER_RELAY_TEST_LAUNCH is set but the profile dir ${real} is not under the temp HOME ${home} — refusing to run`);
    }
  }
}

/** Env for processes the relay spawns: relay-internal knobs and the Claude
 *  Code messaging channel never reach Brave or the third-party upstream. */
function sanitizeChildEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("BROWSER_RELAY_")) continue;
    if (k.startsWith("CLAUDE_CODE_MESSAGING_")) continue;
    out[k] = v;
  }
  return out;
}

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
 * closeBrave on shutdown. Call with the profile's flock held, AFTER the
 * attach-first check and the pre-launch reap (this deletes DevToolsActivePort,
 * so a live orphan must have been attached or reaped first).
 *
 * @param {object} opts
 * @param {string} opts.userDataDir — pool slot dir (absolute)
 * @param {boolean} [opts.headless]
 * @param {string|null} [opts.extensionPath] — passed via --load-extension
 * @param {string} [opts.executablePath] — overrides bundled chromium
 * @param {string|null} [opts.proxyUrl] — when set, Brave inherits HTTP_PROXY /
 *   HTTPS_PROXY env so its outbound traffic routes through an HTTP proxy you
 *   control (e.g. a local debug proxy like Charles, mitmproxy, powhttp). The
 *   user's system proxy stays untouched — only this launched Brave opts in.
 * @returns {Promise<{ context, port: number, wsEndpoint: string, cdpConnectUrl: string }>}
 */
async function launchBrave({
  userDataDir,
  headless = false,
  extensionPath = null,
  executablePath,
  proxyUrl = null,
}) {
  cdpIdentity.requireAbsoluteDir(userDataDir);
  const testLaunch = testLaunchRequested();
  if (testLaunch) assertTestLaunchAllowed(userDataDir);
  // Port 0: never a fixed port. Two Braves can no longer be handed the same
  // number, so neither can fall back to [::1] and be mistaken for the other.
  // No --remote-debugging-address: Brave binds 127.0.0.1.
  const args = ["--remote-debugging-port=0"];
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
  //
  // The test hook KEEPS the mock keychain (see TEST_LAUNCH_ARGS above).
  const ignoreDefaultArgs = testLaunch ? [] : ["--use-mock-keychain"];
  if (testLaunch) args.push(...TEST_LAUNCH_ARGS);
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
  // Spec v4 §1e: CLAUDE_CODE_MESSAGING_* (the session's peer-messaging socket
  // and token) is stripped too.
  const sanitizedEnv = sanitizeChildEnv(process.env);

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

  // A leftover file from an earlier port-0 Brave (Chromium never deletes it)
  // would hand us a dead port — or one a different Brave has since taken.
  cdpIdentity.removeDevToolsActivePort(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, launchOpts);

  // Read the port back and PROVE the 127.0.0.1 listener is this Brave: its
  // /json/version must name the uuid Brave wrote into OUR profile dir. Fail
  // closed — close the context (it holds the user-data-dir lock) and throw.
  try {
    const file = await cdpIdentity.waitForDevToolsActivePort(userDataDir, { timeoutMs: 3000 });
    const wsEndpoint = await cdpIdentity.verifyPortIdentity(file.port, file.browserPath, { timeoutMs: 1000 });
    if (!wsEndpoint) {
      throw new Error(`[mcp-relay] CDP identity check failed: 127.0.0.1:${file.port}/json/version does not name ${file.browserPath} from ${userDataDir}/DevToolsActivePort`);
    }
    return {
      context,
      port: file.port,
      wsEndpoint,
      cdpConnectUrl: `http://127.0.0.1:${file.port}`,
    };
  } catch (e) {
    try { await context.close(); }
    catch (closeErr) {
      process.stderr.write(
        `[mcp-relay] cdp-bridge: context.close() failed during CDP identity cleanup: ${closeErr.message}\n`,
      );
    }
    throw e;
  }
}

/**
 * Attach to an ALREADY-RUNNING Brave instead of launching a new one. Used when
 * a previous relay died uncleanly and left its Brave orphaned on our profile
 * dir — attaching preserves the user's open tabs.
 *
 * Takes the VERIFIED ws endpoint from findAttachableBrave (cdp-identity.js),
 * never a bare port: re-resolving over HTTP would reopen the F9 hole.
 *
 * The returned handle is shaped like launchBrave's plus { attached: true,
 * browser } so closeBrave and the entrypoint's bridge-invalidation listeners
 * can tell the two apart.
 *
 * @param {object} opts
 * @param {string} opts.wsEndpoint — ws://127.0.0.1:<port>/devtools/browser/<uuid>
 * @param {number} opts.port
 * @param {number} [opts.timeoutMs=5000]
 */
async function attachBrave({ wsEndpoint, port, timeoutMs = 5000 }) {
  if (typeof wsEndpoint !== "string" || !wsEndpoint.startsWith("ws://127.0.0.1:")) {
    throw new Error(`[mcp-relay] attachBrave needs a verified ws://127.0.0.1 endpoint, got ${JSON.stringify(wsEndpoint)}`);
  }
  const browser = await chromium.connectOverCDP(wsEndpoint, { timeout: timeoutMs });
  // A persistent-context Brave always exposes its default context. A brand-
  // new context here would NOT see the profile's cookies/tabs, so only fall
  // back to creating one if contexts() is somehow empty.
  const context = browser.contexts()[0] || (await browser.newContext());
  return { context, port, wsEndpoint, cdpConnectUrl: `http://127.0.0.1:${port}`, attached: true, browser };
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

module.exports = {
  launchBrave,
  attachBrave,
  closeBrave,
  closeBraveHard,
  sanitizeChildEnv,
  testLaunchRequested,
  assertTestLaunchAllowed,
  TEST_LAUNCH_ARGS,
  _clearSessionRestore: clearSessionRestore,
};
