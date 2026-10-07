# browser-mcp-relay — Backlog

Open work, ranked by real-world leverage. Items are deferred not because they're unimportant but because they're either (a) not the highest-leverage thing to ship right now, (b) require an architectural pivot, or (c) need real-world signal we don't have yet.

This file is the canonical source for "what's known but not yet shipped." Items that get shipped move from here to a release note + a `feedback_*.md` memory entry.

## Contents

- [Stealth — Tier 2 (opinionated)](#stealth--tier-2-opinionated)
- [Stealth — Tier 3 (architectural)](#stealth--tier-3-architectural)
- [Stealth — Tier 4 (anti-patterns)](#stealth--tier-4-anti-patterns)
- [Field reports — not yet reproduced](#field-reports--not-yet-reproduced)
- [Tooling / DX](#tooling--dx)
- [Documentation](#documentation)
- [Distribution](#distribution)
- [Real-world signal first](#real-world-signal-first)

---

## Upstream issues to file

### F1-20 (workaround SHIPPED v0.3.6, upstream fix still pending)

**Bug:** `browser-devtools-mcp`'s bundled `HttpResourceType` enum is missing `ping`, `prefetch`, `signedexchange`, `cspviolationreport`, `preflight`, `fedcm`. Playwright's `request.resourceType()` returns these for real-world page traffic (Amazon's `<a ping="...">` beacons, `<link rel="prefetch">`, etc.). Upstream's zod validation rejects → `o11y_get-http-requests` returns an error instead of the request data.

**Workaround in relay:** `scripts/patch-bdmcp-bundle.js` patches the upstream bundle on disk at relay startup (idempotent, runs at every spawn — re-applies after `npm install` overwrites the file). See `src/index.js:spawnUpstream` for the call site.

**TODO:** file an upstream issue at https://github.com/serkan-ozal/browser-devtools-mcp/issues. The fix is one line: extend the `HttpResourceType` enum to include the 6 missing values. Once shipped + bumped in our `package.json` dep range, we can delete `scripts/patch-bdmcp-bundle.js` and its tests.

## Stealth — Tier 2 (SHIPPED in v0.3.5 — 2026-05-10)

The four stealth-fingerprint patches in Tier 2 shipped together. The fifth Tier 2 item (humanlike interaction tools) was different scope and ship-gated separately as Tier 2.5 below.

| Patch | Ship | Status |
|---|---|---|
| HTTP-side `Sec-CH-UA-*` via `userAgentMetadata` (T2-A) | v0.3.5 | ✅ shipped |
| Chrome runtime expansion — `loadTimes` / `csi` / `app` (T2-B) | v0.3.5 | ✅ shipped |
| Full permissions overrides — 17 permission types (T2-C) | v0.3.5 | ✅ shipped |
| WebGL renderer + vendor override — UA-aware (T2-D) | v0.3.5 | ✅ shipped |

See `src/own-tools/stealth-apply.js` + `src/own-tools/emulate-device.js` (T2-A's `synthesizeUserAgentMetadata`) for the implementations.

## Stealth — Tier 2.5 (deferred with explicit ship gate)

### `humanlike_click` + `humanlike_type` tools

**What:** New first-party tools with humanlike interaction timing — Bezier-curve mouse paths with realistic dwell, gaussian-distributed keystroke delays, occasional typo + correction patterns.

**Why deferred:** "How human is human enough" is itself an arms race. Worth a focused session against a specific site that's flagging current `interaction_click` / `interaction_fill`. Without that signal, we'd be optimizing against an imagined adversary, AND uniform-Bezier-curve clicks are themselves detectable — the patch only works if it matches the target's specific tolerance window.

**Ship gate (must be met before implementation):**
1. A specific target site is flagging the relay via behavioral analysis (verifiable: scrape with `interaction_click` → site flags us → capture detection JS via `capture_xhr` → identify the timing-side check).
2. Capture the target's tolerance window — what kinds of timing distributions does IT consider human? (Some sites accept anything > 50 ms between keystrokes; others require gaussian distributions; PerimeterX deployments measure full-trajectory entropy.)
3. Design the humanizer to match THAT target's tolerance, not "humanlike in general."

**Effort:** ~200 LOC + a configurable tolerance profile system. Probably 1 focused session.

**Bypass:** If you just need a specific site to work and you've identified the friction, you can manually call `interaction_click` with a custom delay loop in JS via `execute` — that's already possible without new tools.

---

## Stealth — Tier 3 (architectural)

Big lifts. Different scope from JS patches.

### Real-Brave-attach mode (CloakBrowser pattern)

**What:** A new mode where the relay does NOT launch its own Brave via `launchPersistentContext`. Instead it connects via `chromium.connectOverCDP` to a Brave the user is already running interactively. Eliminates the entire "Playwright launched it" fingerprint surface.

**Why this is the real win:** No JS-side patches can defeat detection of CDP-injected runtime artifacts. Detached-CDP-attach (where Brave was started by the user with `--remote-debugging-port=N` themselves) avoids those artifacts entirely.

**STATUS CORRECTED 2026-08-25 — the CDP plumbing is NOT deferred; it already ships.**

`attachBrave()` (`src/cdp-bridge.js:215`) already performs exactly the `chromium.connectOverCDP`
described above, returns a handle shaped like `launchBrave`'s plus `{attached:true, browser}`, and is
**in production use** at `src/index.js:320` for orphan recovery ("live Brave pid=N already owns DIR —
attaching, tabs preserved"). `closeBrave` / `closeBraveHard` are already attach-aware, and
`src/pool-shared.js:777` already parses `--remote-debugging-port=N` off a command line, so port
discovery exists too. Anyone reading the old text below would have rebuilt working code.

**⚠️ THE ACTUAL BLOCKER — the idle reaper will kill a user-owned browser.**

`closeBraveHard` (`src/cdp-bridge.js:237`) deliberately *terminates* attached browsers: when
`handle.attached && handle.browser` it opens a browser CDP session and sends `Browser.close`
(`:239-243`). Plain `closeBrave` only disconnects, so the hard path exists precisely to send a real
kill. The idle reaper calls `closeBraveHard` (`src/index.js:519`) after
`BROWSER_RELAY_IDLE_MINUTES` — **default 45** — with no tool call.

**So pointing an attach mode at a Brave the user is actively using means the relay kills their real
browser out from under them.** Any attach-to-user-Brave work MUST exempt user-owned browsers from
BOTH the idle reaper and shutdown cleanup. That exemption — not the CDP connection — is where the
design effort goes. Note the existing orphan-recovery attach at `index.js:320` is *relay-owned* and
therefore correctly reapable; the distinction the code needs is **ownership**, not attachment.

**Remaining real work:**
- An ownership flag on the handle (`userOwned`) that both reaper and shutdown honour
- A mode/flag to opt into attaching to a user-launched Brave, with port discovery (already available)
- Docs on the trade-off (no auto-launch, no auto-cleanup) and on what the relay will NOT clean up

**Prior-art citation REMOVED — it was unverifiable.** The previous text cited
`~/Documents/GitHub/Washed-Command-Center/washed-web-app-v2-test/walmart_search.py` as proof the
pattern works. **That path does not exist**, and no `walmart_search.py` exists anywhere under
`~/Documents` or `~/GitHub` (checked 2026-08-25). Treat "pattern is proven" as unsupported; the
working prior art is this repo's own `attachBrave`.

**Ship gate:** unchanged in spirit — a case where Tier 1+2 stealth is provably insufficient AND
attach provides relief. **Capture the detection signal first:** a hard block with a RayID can be IP
reputation rather than TLS/JA3 fingerprinting, and attach mode does nothing for the former.

**Effort:** the old "~200 LOC" assumed building the CDP layer. The connection is done; the ownership
/ reaper-exemption work plus docs is the remaining cost.

### `rebrowser-patches` integration

**What:** Patch the chromium binary at startup to remove the most-detectable runtime artifacts that JS-side patches CAN'T reach (CDP runtime symbols on `window`, the iframe `contentWindow` Proxy trap that exposes attached debuggers).

**Why deferred:** Wrong audience. browser-mcp-relay is for friends running on their own Brave install — we can't ship a patched chromium. Doing so would also fork the upstream, breaking the "no fork" architectural property the README highlights.

**Ship gate:** Probably never for this project. If a friend genuinely needs binary-patched chromium, they're outside the scope where browser-mcp-relay is the right tool. Point them at `rebrowser-patches` directly.

---

## Stealth — Tier 4 (anti-patterns)

These are tempting but counterproductive. Documented here so we don't accidentally implement them later.

### `puppeteer-extra-stealth` integration

**Don't.** The library packs 25+ evasions, but:

- Most overlap with Brave Shields' built-in anti-fingerprinting → creates **new** inconsistencies (patches fighting patches)
- The "puppeteer-stealth fingerprint" itself is signature-detected by sophisticated vendors now (the stealth library has its own tells in how it mutates objects)
- Adds a heavy dep with regular churn

If we want broader coverage, copy specific evasions selectively into our stealth-apply.js, vetted against Brave's behavior.

### Canvas randomization

**Don't.** Brave Shields already randomizes canvas output per-session. Adding our own randomization on top creates fingerprint inconsistencies that score WORSE than either alone.

### Battery API spoofing

**Don't.** The Battery API is deprecated in Chromium and isn't actually used by major anti-bot vendors anymore (they moved to it being a low-weight signal years ago). Ship effort would catch a ~5% case at best.

### Font enumeration spoofing

**Don't.** High effort, marginal gain. Real fingerprint diversity comes from the OS-installed fonts; spoofing them creates a "perfectly-uniform fingerprint" tell.

### `event.isTrusted` faking

**Impossible.** Synthetic events from CDP fundamentally have `isTrusted=false`. Any patch that tries to fake this gets caught the moment it's proxy-detected. **Press-and-hold CAPTCHAs and similar will detect us regardless** — this is by browser design. The only solution is real hardware events (out of scope) or routing the user through them manually.

Per the LightningATC dossier (`recon_lightningatc_session_2026_05_10_pickup.md`): *"never auto-solve captchas/press-and-hold (`event.isTrusted=false` = instant flag)."* This is a known wall.

---

## Field reports — not yet reproduced

Real-use defects reported by a session that hit them. Recorded as reported; the relay has not reproduced them yet, so every
cause below is a hypothesis until it has.

### `download_capture`: `saveAs` ENOENT, and the wrong page after a new tab (reported 2026-09-17)

Hit on an ephemeral clone session (`launch-project-isolated.js`). The reporter worked around all four.

1. **`saveAs` fails with ENOENT.** With `clickSelector`, the download started, then
   `download.saveAs: ENOENT … copyfile …/T/playwright-artifacts-<A>/<guid> -> <savePath>` — while a file with the SAME guid
   existed under a different `playwright-artifacts-<B>/`. *Hypothesis:* two Playwright CDP clients on one browser (the
   relay's own-tools connection and the upstream server's) each set Chrome's download directory, the last one wins, and
   `saveAs` (`src/own-tools/download-capture.js:147`) then copies from the other client's empty artifacts dir.
   *Workaround:* take the guid from the error, find it under `$TMPDIR/playwright-artifacts-*/`, copy it out before that
   process exits.
2. **`download_capture` acts on a different page than `execute`.** After a login flow opened the app in a new tab,
   `execute`'s `page` was the new tab, but `download_capture` clicked the relay's tracked active page (the old
   `about:blank`) and timed out — the tool runs through `withActivePage` (`download-capture.js:79`), which in this case
   still pointed at the old tab (not yet checked against `_propagate-active-page.js`). *Workaround:* `tabs_select` the
   new tab first.
3. **`tabs_select`'s refocus re-rendered a React SPA** and dropped a `data-*` attribute that had been injected via
   `execute`, so a second locator timed out. Probably page behaviour rather than a relay defect. *Workaround:* an XPath
   `clickSelector` that resolves at click time.
4. **`callTool('download_capture')` inside `execute` returns "Tool not found"**; it works only as a top-level tool.
   *Hypothesis:* `execute`'s `callTool` sees the upstream server's tools, not the relay's own-tools.

**When picked up:** reproduce 1 with two CDP clients attached to one clone before changing anything; then decide whether
`download_capture` should own the download directory for its trigger, and whether a page-opened tab should move the
tracked active page.

---

### Re-attaching to a still-alive Brave restarts the upstream child (accepted, 2026-10-07)

Since the upstream-restart fix, every new Brave handle bumps a generation and replaces the upstream child, because
browser-devtools-mcp caches its browser context forever. That includes the rare case where an ATTACHED Brave's CDP
connection drops but the browser is still alive and `findAttachableBrave` re-attaches to it. Cost per event: one
upstream respawn, one orphan tab left by the old child's page, and a forwarded call in flight on the old child
rejected with "client closed". Launched Brave is driven over a pipe, so only attach mode can hit this. Accepted as far
better than the wedge it replaced; not reproduced live.

**When picked up:** identify the browser by the GUID in `/json/version`'s `webSocketDebuggerUrl` and skip the restart
when it is unchanged — and keep `test/upstream-restart.test.js` green, especially the poisoned-fresh-child case.

---

## Tooling / DX

Lower-priority items not specifically about stealth.

### macOS + Linux CI matrix

**What:** Extend `.github/workflows/clean-clone.yml` to a 3-OS matrix (`windows-latest`, `macos-latest`, `ubuntu-latest`).

**Why deferred:** README says Mac/Linux are "best-effort, not maintainer-verified." Code is portable but no end-to-end Mac/Linux testing has happened. Adding CI without first verifying locally produces noise — every Mac/Linux test that fails is "unknown — could be code, could be runner."

**Ship gate:** First a real Mac/Linux pass on the maintainer's hands. Then enable CI to keep it green going forward.

### Inspector "Activity" page virtual scrolling

**What:** The activity feed is currently capped at 200 events (ring buffer). For long-running sessions, you can't review history past that cap. Virtual scrolling + persisting events to disk would lift the cap.

**Why deferred:** 200-event window covers ~2-3 minutes of normal MCP traffic. Most use cases don't need more.

**Ship gate:** Someone asks for it. Until then, the export-to-JSON endpoint (added in PR #8) covers offline analysis.

### Auto-update version-check stderr line

**What:** On relay start, fetch the latest tag from npm registry / GitHub releases and stderr-log if the local version is behind.

**Why deferred:** Adds a network dependency for a localhost tool. Privacy-first. The friend onboarding doc tells people how to upgrade; that's enough.

**Ship gate:** Probably never. Document upgrade in REFERENCE.md instead.

### `lighthouse@13` upgrade

**What:** Currently pinned at `lighthouse@^11.0.0` due to dep churn. v13 fixes the 3 low-severity transitive `cookie<0.7.0` advisories.

**Why deferred:** Breaking dep upgrade. Localhost-bound dev tool, so the advisories aren't exploitable in practice. Tracked but not blocking.

**Ship gate:** When lighthouse@13's API differences are minor enough to be a 1-day adapter, OR when the cookie<0.7.0 advisories become actually exploitable.

---

## Documentation

### Reference architecture diagram

**What:** A hand-drawn (or PIL-generated) architecture diagram showing the multi-layer flow: MCP client → relay node → upstream BDMCP child → Brave subtree → CDP back to relay's own-tools.

**Why deferred:** The ASCII diagram in REFERENCE.md does the job. A polished SVG is nice-to-have but isn't blocking comprehension.

### Per-tool worked examples

**What:** REFERENCE.md has 3 worked examples (`lighthouse_audit`, `cookies_export`, `extract_structured`). Could expand to ~10-15 covering the full first-party catalog.

**Why deferred:** The current 3 cover the most common patterns. Adding more is busywork unless they unlock specific use cases.

### Friend-onboarding video

**What:** 2-minute screen recording of `git clone → npm install → npm run setup → relay attached to Cursor → first tool call works`.

**Why deferred:** Costs ~30 minutes to record well. README simplification + clean-clone CI mostly covers the same ground.

**Ship gate:** Friend onboarding starts hitting issues that are easier to show than describe.

---

## Distribution

### npm package publish

**What:** Publish `browser-mcp-relay` to npm so friends can `npx browser-mcp-relay setup` instead of `git clone`.

**Why deferred:** Git-clone is the dominant install pattern for this audience. npm-publishing means owning a public package name + semver discipline at a higher cost than tag-based releases.

**Ship gate:** A friend wants to install but doesn't have git. Until then, the README's clone instructions are fine.

### Single-binary distribution

**What:** Bundle the relay as a single executable via `pkg` or `bun build --compile`.

**Why deferred:** Adds a build step, breaks the "just a Node script" simplicity. Worth it only if friends without Node want to use this — and that audience is probably better served by a hosted tool, not a binary.

---

## Real-world signal first

The honest meta-thing: **most items in this backlog should not be shipped without real-world signal first.** A week of friends actually using v0.3.3+ generates more useful priority data than any planning session.

Specific signal to watch for:

- **Inspector traffic logs** — which of the 70 tools are actually called? If 50 of them have zero invocations after 2 weeks, the right move is deprecation, not more polish.
- **Issue reports** — what breaks for friends? The `windows-only CI + clean-clone smoke` setup catches install-time regressions; only friends running real workflows surface in-flight bugs.
- **Performance** — does relay startup feel slow? Does Brave-launch latency matter? `npm run smoke` reports timing; a week of real use generates the distribution.
- **Stealth wins/losses** — are friends scraping sites that flag them? Concrete failure cases are 100x more useful for prioritizing Tier 2/3 stealth work than speculative planning.

The treadmill of "ship more features" feels productive but masks the higher-leverage move: **let it soak, gather signal, prioritize from data.**
