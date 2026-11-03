# browser-mcp-relay — Reference

The slim README at the root of the repo is for getting up and running. This file is the deep-dive: every tool, every env var, every mode, every optional feature.

## Contents

- [Tool catalog](#tool-catalog)
  - [First-party tools (20)](#first-party-tools-20)
  - [Forwarded upstream tools (51)](#forwarded-upstream-tools-51)
- [Worked examples](#worked-examples)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Modes](#modes)
- [How the pool dance actually works](#how-the-pool-dance-actually-works)
- [Optional features](#optional-features)
  - [Proxy whitelist](#proxy-whitelist)
  - [Credential vault + autofill](#credential-vault--autofill)
- [The secret-on-page lock (default relay)](#the-secret-on-page-lock-default-relay)
- [Cloudflare walls](#cloudflare-walls)
  - [The plain-flags relay (`browser-mcp-relay-plainflags`)](#the-plain-flags-relay-browser-mcp-relay-plainflags)
- [Stealth model](#stealth-model)
- [Inspector](#inspector)
- [Platform support](#platform-support)
- [Troubleshooting](#troubleshooting)
- [Diagnostic recipes](#diagnostic-recipes)
- [Limitations](#limitations)

---

## Tool catalog

**71 tools total = 20 first-party (built into this relay) + 51 forwarded from [`browser-devtools-mcp`](https://github.com/serkan-ozal/browser-devtools-mcp).**

Both layers are merged into a single `tools/list` response, so to your MCP client they all just look like "tools the relay provides."

### First-party tools (20)

#### 🔬 Performance & diagnostics

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `lighthouse_audit` | Lighthouse audit against a URL | `formFactor: "desktop"\|"mobile"` | Performance regression check on a deploy |
| `memory_take-heap-snapshot` | V8 heap snapshot via CDP | `outputPath` | Memory-leak hunt on a long-running SPA |

#### 📱 Device emulation

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `emulate_device` | UA / viewport / network throttling | `network.downloadKbps` | Verify a layout on Slow 3G |

#### 📑 Multi-tab control

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `tabs_list` | List open tabs by index + URL | — | "Where did I leave that page?" |
| `tabs_new` | Open a new tab | `url` | Spawn a side-panel comparison |
| `tabs_select` | Bring a tab to front | `index` | Switch to a specific tab before interacting |
| `tabs_close` | Close a tab by index | `index` | Tear down workflow tabs |

#### 📤 Forms, dialogs, files

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `dialog_handle` | Auto-handle the next JS dialog | `action: "accept"\|"dismiss"` | Click a button that triggers `confirm()` |
| `file_upload` | Set files on a file input | `files: [absPath]` | Upload a file without an OS picker |
| `form_fill` | Fill many fields in one round-trip | `fields: [{selector, value}]` | Bulk-fill a long signup form |

#### 🌐 Network capture

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `capture_xhr` | Record XHR/fetch responses | `urlFilter` (regex) | Reverse-engineer a site API while logged in |

#### 🧱 Cloudflare walls (added 2026-10-30)

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `challenge_detect` | Say whose Cloudflare wall this is and where to route it (never clicks, never reloads); logs it to the shared CF-WALL log (then do not append another). See [Cloudflare walls](#cloudflare-walls) | `lane` (required); `origin` + `stage: "pre"\|"outcome"` | A GHL form's Turnstile never passes → owner `highlevel`, route `in-page-turnstile` with the three ways on (plus `switchTo: "browser-mcp-relay-plainflags"` when eligible) |
| `challenge_click` | **Plain-flags relay only** (not in the default relay's list, not counted above). One CDP click on a visible Turnstile checkbox, found through the frame tree, at the measured point for its layout; reports `passed` from the token after the click; one per host per 10 min across every plain-flags relay. See [The plain-flags relay](#the-plain-flags-relay-browser-mcp-relay-plainflags) | `lane` | `challenge_detect` said `clickBudget: 1` |
| `cf_cookies_clear` | **Plain-flags relay only** (not counted above). After a failed try: every cookie of the site (or only the three Cloudflare names when its account is listed) plus the challenge host's partition. Names and counts, never values | `origin` (required) | A plain-flags try failed: clear, then the §4 human step |

#### 🍪 Session & cookies

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `cookies_export` | Export cookies as JSON | `urls` (filter) | Save an authed session for later |
| `cookies_import` | Import cookies into the context | `cookies` | Restore an authed session |

#### 💾 Downloads

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `download_capture` | Wait for a download, save to disk | `clickSelector` | Trigger + save a CSV export |

#### 🗄️ Storage (added in v0.3.0)

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `storage_get-local` | Read `localStorage` / `sessionStorage` keys | `store: "local"\|"session"` | Inspect OAuth tokens on Discord, Notion, Slack, etc. (auth often lives in localStorage, not cookies) |
| `storage_set-local` | Write keys into `localStorage` / `sessionStorage` | `entries: { key: value }` | Restore an authed session after fresh navigation |
| `storage_clear-local` | Clear local/session storage on the active origin | `keys` (optional filter) | Test fresh-user flows without resetting the whole profile |

#### 🔍 Data extraction

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `extract_structured` | CSS-selector-based extraction | `schema` | Scrape an authed page that public scrapers can't reach |

#### 🧭 Relay status

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `relay_status` | Which profile this session drives (BASE or a CLONE whose logins are deleted at session end), who holds the base, this Brave's CDP port. Never launches a browser. | — | Check before any sign-in |

> Source for each first-party tool lives at [`src/own-tools/<tool-name>.js`](../src/own-tools/).

---

### Forwarded upstream tools (51)

Provided by [`browser-devtools-mcp`](https://github.com/serkan-ozal/browser-devtools-mcp) — the relay forwards `tools/call` requests for these to the upstream child process verbatim. Brief summaries below; full schemas come straight from upstream and are visible to your MCP client via `tools/list`.

#### ♿ Accessibility (2)

| Tool | Purpose |
|---|---|
| `a11y_take-aria-snapshot` | ARIA tree snapshot with refs (`e1`, `e2`, …) for downstream targeting |
| `a11y_take-ax-tree-snapshot` | Chromium AX tree + bounding boxes / visibility / viewport diagnostics |

#### 📄 Content extraction & capture (6)

| Tool | Purpose |
|---|---|
| `content_get-as-html` | Get the page's HTML |
| `content_get-as-text` | Get the page's visible text |
| `content_save-as-pdf` | Save current page as a PDF |
| `content_take-screenshot` | Screenshot the page or a specific element |
| `content_start-recording` | Start video recording |
| `content_stop-recording` | Stop recording and save the video file |

#### 🐛 Live debugging probes (11)

| Tool | Purpose |
|---|---|
| `debug_status` | Status of the debug subsystem |
| `debug_resolve-source-location` | Resolve a source-map location |
| `debug_put-tracepoint` | Install a tracepoint at a source location |
| `debug_put-logpoint` | Install a logpoint (non-pausing console-style log) |
| `debug_put-exceptionpoint` | Install an exception breakpoint |
| `debug_add-watch` | Add a watch expression evaluated on each probe hit |
| `debug_list-probes` | List installed tracepoints / logpoints / watches |
| `debug_remove-probe` | Remove a probe by ID |
| `debug_clear-probes` | Bulk-remove probes by type |
| `debug_get-probe-snapshots` | Get captured snapshots from probes |
| `debug_clear-probe-snapshots` | Clear captured snapshots |

#### 🖱️ Page interaction (9)

| Tool | Purpose |
|---|---|
| `interaction_click` | Click an element (selector or ARIA ref) |
| `interaction_fill` | Fill an input |
| `interaction_select` | Select a dropdown option |
| `interaction_hover` | Hover an element |
| `interaction_drag` | Drag an element to a target |
| `interaction_press-key` | Press a keyboard key (with optional hold + repeat) |
| `interaction_scroll` | Scroll the viewport or a scrollable element |
| `interaction_resize-viewport` | Resize the page viewport (Playwright emulation) |
| `interaction_resize-window` | Resize the OS-level browser window via CDP |

#### 🧭 Navigation (3)

| Tool | Purpose |
|---|---|
| `navigation_go-to` | Navigate to a URL |
| `navigation_reload` | Reload the current page |
| `navigation_go-back-or-forward` | Browser history navigation |

#### 📈 Observability (6)

| Tool | Purpose |
|---|---|
| `o11y_get-console-messages` | Page console output |
| `o11y_get-http-requests` | Captured HTTP requests |
| `o11y_get-web-vitals` | LCP / INP / CLS / TTFB / FCP |
| `o11y_get-trace-context` | Current OpenTelemetry trace context |
| `o11y_set-trace-context` | Set / inject a trace context |
| `o11y_new-trace-id` | Mint a fresh trace ID |

#### ⚛️ React introspection (2)

| Tool | Purpose |
|---|---|
| `react_get-component-for-element` | Map a DOM element back to its React component via Fiber |
| `react_get-element-for-component` | Reverse — find the DOM element a component renders into |

#### 🔌 HTTP stubbing (4)

| Tool | Purpose |
|---|---|
| `stub_intercept-http-request` | Intercept matching outgoing requests |
| `stub_mock-http-response` | Mock responses for matching requests (picomatch glob) |
| `stub_list` | List currently installed stubs |
| `stub_clear` | Clear all stubs |

#### 🎬 Scenarios (6)

| Tool | Purpose |
|---|---|
| `scenario-add` | Save a reusable JS script that orchestrates other tools |
| `scenario-update` | Update a scenario's description / script |
| `scenario-delete` | Delete a scenario by name |
| `scenario-run` | Run a saved scenario by name |
| `scenario-list` | List all scenarios (project + global scope) |
| `scenario-search` | Search scenarios by query |

#### ⚡ Other (2)

| Tool | Purpose |
|---|---|
| `execute` | Batch-execute multiple tool calls in one request via custom JS — reduces round-trips |
| `sync_wait-for-network-idle` | Wait until in-flight requests ≤ N for `idleMs` |

---

## Worked examples

Each example shows the raw JSON-RPC `tools/call` request your MCP client would send. Most clients (Claude Code, Cursor) wrap this in a higher-level "use tool X" UX — these payloads are useful when you're debugging or building your own client.

### `lighthouse_audit` — measure performance after a deploy

```jsonc
// Request
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "lighthouse_audit",
    "arguments": {
      "url": "https://example.com",
      "formFactor": "desktop"
    }
  }
}
```

```jsonc
// Response (truncated)
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\n  \"url\": \"https://example.com\",\n  \"formFactor\": \"desktop\",\n  \"scores\": {\n    \"performance\": 0.99,\n    \"accessibility\": 0.92,\n    \"best-practices\": 1.0,\n    \"seo\": 0.91\n  }\n}"
    }]
  }
}
```

> Use it in CI to fail a deploy when Lighthouse drops below a threshold, or interactively when you want a one-line "is this page slow?" answer.

### `cookies_export` — save an authed session

```jsonc
// Request — capture only cookies that apply to amazon.com
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "cookies_export",
    "arguments": {
      "urls": ["https://www.amazon.com/"]
    }
  }
}
```

```jsonc
// Response (truncated)
{
  "result": {
    "content": [{
      "type": "text",
      "text": "[\n  { \"name\": \"session-id\", \"value\": \"<...>\", \"domain\": \".amazon.com\", \"path\": \"/\", \"httpOnly\": true, \"secure\": true, \"sameSite\": \"Lax\" },\n  { \"name\": \"ubid-main\", \"value\": \"<...>\", \"domain\": \".amazon.com\", ... }\n]"
    }]
  }
}
```

> Pair with `cookies_import` to restore the session later — useful for testing multi-step authed flows without re-logging in each run.

### `extract_structured` — scrape an authed page

```jsonc
// Request
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "tools/call",
  "params": {
    "name": "extract_structured",
    "arguments": {
      "navigateToUrl": "https://example.com/product/123",
      "waitForSelector": "#productTitle",
      "schema": {
        "title":  { "selector": "#productTitle" },
        "price":  { "selector": "#priceblock" },
        "images": { "selector": "img.thumb", "attribute": "src", "multiple": true }
      }
    }
  }
}
```

```jsonc
// Response
{
  "result": {
    "content": [{
      "type": "text",
      "text": "{\n  \"title\": \"Example Product\",\n  \"price\": \"$19.99\",\n  \"images\": [\"https://.../1.jpg\", \"https://.../2.jpg\"]\n}"
    }]
  }
}
```

> Use this when a page is behind a login or a captcha that public scrapers can't bypass — your relay's Brave is already authenticated.

---

## Architecture

```
                    stdio JSON-RPC
   MCP client ───────────────────▶  browser-mcp-relay
   (Claude Code,                    (this repo)
    Cursor, …)                              │
                                            ├── stdio JSON-RPC
                                            ▼
                                    browser-devtools-mcp
                                       (upstream child)
                                            │
                                            │ CDP
                                            ▼
                                       ┌─────────┐
                                       │  Brave  │   ◀── one per relay process
                                       │ (one    │       (lazy: launched on
                                       │  per    │        first tools/call)
                                       │  relay) │
                                       └─────────┘
                                            ▲
                                            │ CDP (Playwright connectOverCDP)
                                            │
                                       relay's own-tools
                                       (this repo, 20 tools)
```

**How it works:**

- 📥 The relay receives MCP messages on stdin from your client.
- 📋 `tools/list` → merges the upstream's catalog with the 20 own-tool definitions and returns one combined list.
- ⚙️ `tools/call` → either forwards to the upstream child (for the 51 forwarded tools) or runs an own-tool handler directly.
- 🔌 Both paths drive the same Brave instance. Brave is launched with `--remote-debugging-port=0`: the OS picks a free port, Brave writes it to `<profile>/DevToolsActivePort` with its browser uuid, and the relay proves `127.0.0.1:<port>/json/version` names that same uuid before anything uses it. The upstream child gets that exact endpoint (`BROWSER_CDP_ENDPOINT_URL=ws://127.0.0.1:<port>/devtools/browser/<uuid>`), so it can reach no other browser. External scripts read the port from `<profile>/.mcp-relay-status.json` (`cdpPort`) or `DevToolsActivePort`.
- 🪶 One Brave per relay process. Brave is launched **lazily on the first `tools/call`**, not at startup.
- 🚫 **Meta guard.** Relay browsers never open Instagram / Facebook / Messenger / Threads / Meta account pages (top-level documents only; pixels, SDK scripts and embeds still load). Three layers: URL arguments are refused before any browser work, a CDP `Fetch` guard on every page and popup answers blocked documents with a 403 page, and a watchdog catches service-worker-served pages. The block/allow lists are one constant at the top of `src/meta-guard.js`. There is no override.

**Shutdown lifecycle (since v0.3.2):** orphan Brave processes are reaped at three points — `claimSlot` (lock-acquire), `ensureBrave` (pre-launch, `F1-16`), and `closeBrave` (shutdown via Playwright `context.close`). The pre-launch reap closes the lazy-launch gap where a previous-session Brave can squat on a claimed-but-not-yet-launched user-data-dir.

---

## Configuration

All paths the relay needs are auto-detected by default. Override them with these env vars or by editing `local-config.json` (gitignored, written by `npm run setup`).

| Env var | Default | Purpose |
|---|---|---|
| `BROWSER_RELAY_BRAVE_PATH` | auto-detect | Absolute path to `brave` / `brave.exe`. Auto-detect probes Brave Stable / Beta / Nightly / Dev install paths on Win/Mac/Linux + the Windows registry (HKLM + HKCU, all 4 channels). |
| `BROWSER_RELAY_UPSTREAM_PATH` | `require.resolve("browser-devtools-mcp/dist/index.js")` | Path to the upstream `browser-devtools-mcp` entry. Override to point at a custom build. |
| `BROWSER_RELAY_BRAVE_PROFILE_DIR` | unset | Optional profile dir hint used by detection / cookie snapshot. |
| `BROWSER_RELAY_POOL_DIR` | unset (standalone) | Opt-in: absolute path to a Brave user-data-dir to claim. Standalone mode uses `<repo>/.browser-data` (or a per-user cache dir if the repo is read-only — `~/.cache/browser-mcp-relay/browser-data` on Linux, `~/Library/Caches/browser-mcp-relay/browser-data` on macOS, `%LOCALAPPDATA%\browser-mcp-relay\Cache\browser-data` on Windows). |
| `BROWSER_RELAY_POOL_SLOT` | unset | Cosmetic slot index for the launch banner and registry. It no longer selects a CDP port: Brave's port is OS-assigned (`--remote-debugging-port=0`) and published in `<profile>/.mcp-relay-status.json` as `cdpPort`. Pre-change relays used `9333 + slot - 1` (range 9333–9349). |
| `BROWSER_HEADLESS_ENABLE` | `false` | Set `true` to launch Brave headless. |
| `BROWSER_LOAD_EXTENSIONS` | unset | Path to an unpacked Chrome extension to load. |
| `BROWSER_MCP_ROLE` | unset | Role-based slot filter (only meaningful with the optional pool wrapper). |
| `BROWSER_RELAY_PROXY_URL` | unset | Optional HTTP proxy for Brave's outbound traffic. Useful with debug proxies (Charles, mitmproxy, powhttp). See [Proxy whitelist](#proxy-whitelist). |
| `BROWSER_RELAY_VAULT_FILES` | unset (autofill disabled) | Path-delimiter-separated paths to Brave/Chrome password CSV exports (`;` on Win, `:` on POSIX). Enables form-autofill on navigation. See [Credential vault](#credential-vault--autofill). |
| `BROWSER_RELAY_SNAPSHOT_INDEXEDDB` | `false` | Include IndexedDB in pool-mode profile snapshot (100+ MB typical). |
| `BROWSER_RELAY_INSPECTOR_PORT` | unset | When set, the relay boots the Inspector dashboard inline on this port and pipes its live MCP-traffic stream into the `/slot/N` Inspector pages. Without this, run the Inspector separately via `npm run inspector` (no live traffic). See [Inspector](#inspector). |
| `BROWSER_RELAY_INSPECTOR_BIND` | `127.0.0.1` | Bind address for the Inspector. Override only with care — the Inspector has no auth. |
| `BROWSER_RELAY_KEEP_TABS` | unset | Set `1` to let Brave restore its previous tab set on relaunch (the pre-2026-08 behaviour). By default the relay deletes `<profile>/Default/Sessions` before launching, so Brave starts with one tab — otherwise the tab set is restored on every relaunch and the idle reaper can never bound memory (measured: 18.4 GB / 88 tabs across 3 profiles). Logins are unaffected either way; cookies, localStorage and IndexedDB live in sibling files. **Note the tradeoff:** with restore off, an idle reap that fires while a human is driving the browser by hand loses their tabs rather than bringing them back — see `BROWSER_RELAY_IDLE_MINUTES`. |
| `BROWSER_RELAY_IDLE_MINUTES` | `45` | Minutes of MCP inactivity before the relay reaps Brave + the upstream child to reclaim RAM; `0` disables. **Idleness is measured in MCP tool calls plus one browser-activity signal:** before reaping, the relay runs `lsof -nP -w -iTCP@127.0.0.1:<cdpPort> -sTCP:ESTABLISHED -F pn` (3 s timeout), and an ESTABLISHED **client** connection to the Brave's CDP port (a socket whose remote end is `127.0.0.1:<cdpPort>`) from any process other than the relay or its upstream child — a script driving the browser over CDP — resets the idle clock and skips the reap. Brave's own sockets are the server ends of those connections, so the client-only test is what leaves them out. On macOS `/usr/sbin/lsof` is used when present, so a trimmed `PATH` does not disable the check. Only a connection open at that moment is seen; a script that connects and exits between checks is not. If `lsof` is missing, fails or times out, that check falls back to MCP-only idleness and reaps (logged once per relay). **Keep-alive file:** checked first (one `lstat`, before any `lsof`): `<claimed profile dir>/.mcp-relay-keepalive` (the base profile or this session's clone — the dir holding `.mcp-relay-status.json`). While it is a **regular file** (a symlink, directory or anything else is ignored) whose mtime is less than one idle window old, the reaper treats it as activity, dated at the touch: the idle clock is set to the file's mtime, not to the moment of the check, so one touch holds for one idle window after the touch. A helper that drives the Brave outside MCP should `touch` it each time it uses the browser; protection ends one idle window after the last touch, so it can never hold a Brave forever (an mtime more than 5 s in the future is ignored). **Reap log:** every hold and reap appends one JSON line to `<cache root>/reap-events.log` (`~/Library/Caches/browser-mcp-relay/reap-events.log` on macOS; mode 0600; rotated to `reap-events.log.1` past ~1 MB, one kept): `{ts, slug, pid, event, …}` with `event` one of `held` (plus `heldBy: [{pid, command}]` and `idleS`, written once per hold and again when the holder pid set changes), `released` (plus `reason`, `heldS`, `pids` — the hold ended: `no-clients`, `mcp-call`, `keepalive`, `lsof-failed`, `reaped` or `brave-gone`; a later hold, even by the same pids, writes a new `held`), `keepalive` (plus `keepaliveAgeS`, `idleS`), `lsof-failed` (plus `reason`, `idleS`) and `reaped` (plus `idleS`). `command` names the helper without its arguments: the executable's basename plus the script it runs as `parent/base` (`node lib/own-relay-port.mjs`, `node drive/index.js` — a bare relative script takes its working directory's name), `python3 -m <module>`, or a `.bin` shim / `npx` / `tsx` as the tool plus its script or package (`tsx scripts/drive.ts`, `npx firecrawl-mcp`). Option values (`--require X`, `-r X`, `--inspect=…`) are skipped, inline code (`-e`, `-p`, `-c`) is never logged, and nothing that is not a path or module name — URLs, query strings, `key=value`, bare words — ever is. Several relays share the file: rotation runs under a short lock on `reap-events.log.lock` and re-checks the size once it holds it, so concurrent relays never overwrite a full `.1`; a lock file that cannot be opened (mode 000, root-owned, a directory) does not stop rotation, and appends stop once the log is over ~2× the cap. While a CDP hold lasts, the status sidecar carries `reapHeldBy: {pids, since}`, written when the hold starts or changes and cleared (null) when it ends. A log write failure never affects reaping. A human clicking through a login by hand opens no CDP connection, so the clock still runs and their browser can be closed mid-flow. Do not lower this without a broader browser-activity signal. |
| `BROWSER_RELAY_PROFILE_MODE` | unset (default relay) | `plainflags` starts the separate plain-flags relay — see [The plain-flags relay](#the-plain-flags-relay-browser-mcp-relay-plainflags). **Read from the process environment only** (the MCP entry's `env`): a `local-config.json` key of this name is **ignored** and logged once, because every key there becomes an env value for every lane's relay. Any other non-empty value refuses to start. |
| `BROWSER_RELAY_PLAINFLAGS_REQUIRE_TYPED_ANSWER` | unset (off) | Plain-flags relay only, **process environment only**. `1` also requires each sign-in list entry's claude-ask answer to carry a `prompt_id` (written by the typed-words recorder, register A71). Turn it on in the plain-flags MCP entry's `env` once that recorder is installed; until then it would refuse every entry. |
| `BROWSER_RELAY_MAX_TABS` | `8` | Cap on tabs `tabs_new` will leave open; oldest are closed first. `0` disables. Note this bounds `tabs_new` only — pages created by upstream navigation, Lighthouse, or `target="_blank"` popups are not counted. |

**Precedence:** environment variable ▸ `local-config.json` ▸ auto-detect ▸ reasonable hard-coded defaults.

---

## Modes

### 🟢 Standalone (default)

One Brave per relay process. Profile stored at `<repo>/.browser-data` (or a per-user cache dir if the repo is read-only — see `BROWSER_RELAY_POOL_DIR` above for platform-specific paths). No cookie snapshot. Each `npm run setup` produces this configuration. **Recommended for first-time users.**

### 🔵 Pool (opt-in)

Set `BROWSER_RELAY_POOL_DIR` to an absolute path of a Brave user-data-dir to claim. Pool mode uses that single dir + the slot index from `BROWSER_RELAY_POOL_SLOT` for the launch banner. **Useful when running multiple relay processes against pre-warmed Brave profiles** — each relay claims a different dir, and each Brave gets its own OS-assigned CDP port (read it from `<dir>/.mcp-relay-status.json` → `cdpPort`).

---

## How the pool dance actually works

If you run multiple Cursor windows simultaneously, each spawns its own relay, each claims a pool slot, each launches its own Brave. Here's the full dance — useful for understanding what you're seeing in the Inspector and for debugging restart hangs.

### State per slot

Each pool dir has up to three pieces of state:

| File / process | Purpose |
|---|---|
| `<pool-dir>/.mcp-relay.flock` | The ownership lock (macOS): opened `O_EXLOCK\|O_NONBLOCK` and held for the relay's life; the kernel releases it when the relay dies. Never deleted. |
| `<pool-dir>/.mcp-wrapper-lock` | Compatibility record, compact JSON `{"v":2,"pid":…,"ppid":…,"startedAt":…,"pidStartEpoch":…,"sessionId":…,"host":…}`, written tmp-then-`link()` under the flock, mode `0o600`. Pre-change relays and scripts read `pid` / `startedAt` from it. |
| `<pool-dir>/.mcp-relay-status.json` | Status sidecar (`mode`, `cdpPort`, `bravePid`, `braveAlive`, `lastToolCallAt`, …), mode `0o600`. |
| `<pool-dir>/Default/...` | The actual Brave user-data — cookies, localStorage, history, etc. Read by every Brave attached to this dir. |
| Brave subtree | Main Brave process + 5–15 helper subprocesses (renderer / GPU / utility / crashpad), all with `--user-data-dir=<pool-dir>` in their command line. |

### Claim sequence (when a relay starts)

```
1. claimSlot() iterates pool dirs in order
2. For each candidate dir:
   a. mkdir -p <dir> (idempotent)
   b. If lock file exists:
      - Read lock JSON, isPidAlive(meta.pid)
      - If pid is dead → unlink stale lock, proceed
      - If pid is alive → skip this dir, try next
   c. fs.openSync(lockPath, "wx", 0o600) — atomic; if fails with EEXIST,
      another relay raced us; skip this dir, try next
   d. Write the lock contents + fdatasync
   e. reapOrphansFor(dir) — kills any Brave processes still pinned to
      this dir (which wouldn't have a parent — squatters from a previous
      session that closeBrave didn't cleanly tear down)
3. If we exhausted all dirs → throw "pool exhausted"
```

### First tool call (lazy launch)

The relay holds the lock but doesn't launch Brave at startup — only when the first `tools/call` arrives. At that point:

```
1. ensureBrave() runs
2. F1-16 (v0.3.2): pool.reapOrphansFor(dir) AGAIN — catches any orphan
   that appeared on this dir AFTER claim but BEFORE first tool call
   (lazy-launch gap; the bug that bit me on 2026-05-10)
3. launchBrave({ userDataDir: dir, ... }) with --remote-debugging-port=0,
   after deleting any stale <dir>/DevToolsActivePort
4. Brave subtree comes up; it writes <dir>/DevToolsActivePort
   ("<port>\n/devtools/browser/<uuid>")
5. The relay polls that file (3 s max), then requires
   127.0.0.1:<port>/json/version to name the same uuid — else it closes
   Brave and fails (a different browser answered on that port)
6. attachAutofill listens on framenavigated for vault credentials
7. Subsequent tool calls reuse the same Brave instance
```

### Shutdown sequence

```
On SIGTERM / SIGINT / upstream-child-exit:
  1. shutdownAsync() — memoized so concurrent triggers all await one chain
  2. upstreamClient.close() — graceful TCP/stdio close
  3. killUpstreamTree() — taskkill /F /T on the upstream BDMCP node
     (G0-3: walks the subtree on Win; only the parent on POSIX, where
     reparenting is graceful)
  4. closeBrave(bridge) + inspectorHandle.close() in PARALLEL with per-
     step timeouts (8s / 3s) — G0-7 + G1-2: prevents one wedged step
     from blocking the whole shutdown. A clone's Brave is closed hard.
  5. Release LAST: unlink our record (owner-checked), then close the flock
     fd (a clone's dir is removed while the fd is still held). Releasing
     first (the old W1-6 order) let a peer claim the base while our Brave
     was still closing; a second Ctrl-C can't strand the lock any more,
     because the kernel drops the flock when the relay dies.
  6. process.exit(128 + signal-num)
  Once shutdown starts, ensureBrave() refuses to launch, and a launch already
  in flight is closed as soon as it resolves.

On Windows TerminateProcess (force-quit Cursor, blue screen, power loss):
  - Only process.on("exit") fires → shutdownSync() runs
  - closeBrave(bridge).catch(() => {}) is fire-and-forget — Playwright's
    context.close is async; the process exits before it resolves
  - Brave is reparented to System; the next relay's claimSlot reaps it
```

### Why you might see N+1 relays vs N Cursor windows

Cursor's bundled `cursor-browser-devtools-mcp-vscode-0.6.3-universal` extension runs its OWN MCP — separate process tree, separate user-data-dir (`.browser-data-mcp`, no `-pool-N` suffix). Distinguish:

| Process | Identifier in `Get-CimInstance Win32_Process` |
|---|---|
| **Your relay** | `node ...\.claude\scripts\browser-mcp-relay\src\index.js` — uses `.browser-data-mcp-pool-N` dirs |
| **Cursor's bundled MCP** | `node ...\.cursor\extensions\serkan-ozal.browser-devtools-mcp-vscode-...\node_modules\browser-devtools-mcp\dist\index.js --cursor-mcp-server` — uses `.browser-data-mcp` (no `-pool-` suffix) |

Both can be alive simultaneously. The relay's safety net (claim-time + pre-launch reap) only protects YOUR relay's pool dirs — Cursor's bundled MCP has its own lifecycle. If you only ever see Brave processes pinned to `.browser-data-mcp` (no `-pool-`), that's the bundled extension, not your relay.

---

## Optional features

### Proxy whitelist

Set `BROWSER_RELAY_PROXY_URL=http://127.0.0.1:8888` (or wherever your debug proxy listens) to route the relay's Brave traffic through an HTTP proxy you control. Combined with the relay's per-context `ignoreHTTPSErrors`, this lets you inspect the relay's HTTP traffic via Charles, mitmproxy, powhttp, etc. without affecting your main browser. Your system proxy stays untouched — only this launched Brave opts in.

> ⚠️ **Security:** Only point this at HTTP proxies you control on **localhost**. Setting a proxy also makes the relay accept **any TLS cert** (so MITM debug proxies "just work"), which means a hostile or compromised remote proxy can transparently MITM all of the relay's traffic — including pages you're authenticated to. If you don't fully control the proxy, leave this unset.
>
> **Corrected 2026-08-25:** until then this sentence described an intent the code did not implement — `ignoreHTTPSErrors` was hardcoded `true`, so **every** relay browser accepted forged certs even with no proxy configured. Cert validation is now ON by default and the bypass is opt-in: setting `BROWSER_RELAY_PROXY_URL` enables it, or `BROWSER_RELAY_INSECURE_TLS=1` for a *transparent* corporate proxy with a private CA and no proxy URL (that one logs a warning on launch). `0`, `false` and empty read as OFF.

### Credential vault + autofill

The relay can auto-fill login forms when a saved credential matches the current page's hostname. **Off by default.** To enable:

1. Export passwords from Brave (or Chrome): `brave://settings/passwords` → "Export passwords" → save as CSV
2. Set `BROWSER_RELAY_VAULT_FILES=/absolute/path/to/passwords.csv` (path-delimiter-separated for multiple paths — `;` on Win, `:` on POSIX)
3. Restart the relay

The vault loads CSVs at startup, indexes by hostname + registrable domain, and fills the first empty username + password fields on each `framenavigated`. **It does not auto-submit** — you click submit yourself.

> ⚠️ **Security:** Passwords stay in memory only — never logged, never re-written. But anyone with read access to your relay process's memory could read them. Only point this at CSVs you trust. The vault is most useful when scraping authed sites that block Playwright's password manager (e.g. Brave 127+'s App-Bound Encryption).

---

## The secret-on-page lock (default relay)

Register A77; Trevor's ruling `as-ops/ask-a2ggu5` rev 2, *"Lock, except session-filled values"*. Upstream's `a11y_take-aria-snapshot` emits every text input's current value (`- textbox "Password": <typed value>`), `navigation_go-to` / `navigation_go-back-or-forward` return that snapshot by default, `content_get-as-html` can carry a React-mirrored value, and a screenshot after "show password" shows it — and Trevor often signs in inside a relay tab while a session waits. So the **default** relay (every lane) runs the plain-flags profile's lock (`src/plainflags-lock.js`, through `src/default-lock.js`), with two differences:

- **It locks on a filled secret field only** — the plain-flags rule 1 (text-entry types, secret heuristics, the show-password memory), and rule 3's fail-closed-per-tab (an unreadable frame on a tab where a secret field was seen; nothing cached between probes, fresh CDP sessions, `uniqueContextId`, isolated world). **No sign-in-URL rule:** rule 2 and rule 3's sign-in-frame clause are off here — a sign-in page with an empty form does not lock. An empty password field, or a checkbox / radio / button named `password`, never locks.
- **One refinement of rule 1, default relay only** (Trevor's rulings `as-ops/ask-75txd2` rev 2 and, for round 2, `as-ops/ask-gnpqzm` rev 2; plain-flags is unchanged): the `name` / `id` rule is plain-flags' **substring** rule (`pass` or `pwd` anywhere, or the word `otp`) **minus only the ruled false positives** — a token *starting* with `passeng` or `passport` (at the start, after a separator, or at a camelCase boundary) and any `bypass` or `compass` are cut out of the name first, and what is left is tested as usual. Both cuts are case-aware. (1) `passeng` / `passport` is cut only at a token start (the start, after a separator, or a camelCase boundary), so `userPassport` and `PASSENGER_NAME` are cut but `passPortal` (camelCase `pass Portal`) and `mypassport` are not (fix round 3). (2) `bypass` / `compass` is cut only in its three **natural casings** — all lower case, ALL CAPS, Capitalised — and **never when its `pass` runs on into a `w` or `W`** (`/(?:by|com)pass(?![wW])|(?:BY|COM)PASS(?![wW])|(?:By|Com)pass(?![wW])/`; fix round 3 for camelCase, round 4 for `bypassword`, round 5 — Trevor's ruling `as-ops/ask-am5h7p` rev 2 — for the other case of the `w`: `bypassWord`, `BYPASSwd`, `CompassWD`). So `loginByPass`, `byPass`, `comPass` (a camelCase `Pass`) and any other casing (`bYpAsS`) are never cut and lock, as in base; a `w` / `W` continuation locks too, including non-password words such as `bypassWarning` and `compassWidget` (fail closed, accepted). Checked against base `7491e5b` on 1,380 name / id forms, and in a generated test over every casing of `bypass` (64) and `compass` (128) × 10 suffixes × 4 prefixes (7,680 names): plain-flags equals base on every one; default mode never locks where base does not, and differs from base exactly where a ruled word appears in its natural form — `passeng…` / `passport…` at a token start (`passengers`, `passportal` included), or `bypass` / `compass` in a natural casing not followed by `w` / `W` (`compassion` included); `passportpassword` and `passengerpassword` lock, since the cut never reaches a following `pass`. So `passenger_name`, `passengers`, `PASSENGER_NAME`, `passport_no`, `userPassport`, `bypass`, `bypass_cache` and `compass` do not lock here; `password1`, `passwordconfirm`, `userpass`, `pwdhash`, `passwort`, `mot_de_passe`, `user_pass`, `newPassword`, `otp_code`, `passengerPassword`, `bypassPassword`, `loginByPassword`, `loginByPass`, `comPassword`, `passPortal` and `mypassport` (not a token start) still do. `type=password`, the `autocomplete` values, `-webkit-text-security`, the split-code and 2FA-code rules apply whatever the name. (Round 1 used whole-word matching instead; the round-1 review demonstrated it missed `password1` / `passwordconfirm` behind a show-password toggle, and it was replaced.) **No page-sent exception:** a round-1 rule that let a field still holding the page's own `value` (a settings page's saved password) through was **removed** in round 2 (Trevor: *"Drop it, log lock episodes"*) — any filled secret field locks, whoever filled it, except the session's own values below.
- **The exception — values the session filled itself:** a secret field whose current value **exactly** equals a value this relay process passed into a page with `interaction_fill` (`value`) or `form_fill` (each field's `value`), recorded from the tool's own arguments just before the call runs, does not lock — so a session can fill a fixture password and click submit. **Only values of 6 characters or more are recorded** (A77 fix round 1): a session that filled the digits 1–6 into split one-time-code boxes would otherwise have excepted Trevor's own code typed into the same boxes (demonstrated). So **a session filling split code boxes one digit at a time locks itself** (its own `form_fill` result is withheld) — as does any short session fill into a secret field. The relay keeps only a **salted SHA-256 digest** of each such value (random salt per process), the last **50**, each forgotten **30 min** after it was filled: in memory only, never logged, never in `relay_status`, never on disk. The probe gets the digests and the salt, hashes each filled secret field's value in its isolated world and returns only counts — no value leaves the page, and none is sent into one. A fill refused by the lock is not recorded. **Characters typed with `interaction_press-key` are not tracked — they lock** — and neither are values set by `execute`, a scenario, or the vault's autofill (`BROWSER_RELAY_VAULT_FILES`: a page the vault filled locks until the field is emptied — the lock is doing its job, since that value is Trevor's real password). A page that rewrites a filled value (uppercasing, a `maxlength` cut) no longer matches and locks.

While locked, every tool except `relay_status` and `tabs_list` is refused with *"Locked: a password or one-time code typed on this page (Trevor may be signing in). Tools resume when the field is empty, or holds only a value this session filled."* (plus the reason); a result — or a thrown error — produced while the lock came on is withheld, and a withheld screenshot's file (`filePath` / `screenshotFilePath` of `content_take-screenshot` and the navigation tools) is deleted. `LOCKED` / `UNLOCKED` are announced on the next tool result, and `relay_status` reports `lock` (`locked`, `reason`, `since`, counts, `sessionFilled` = how many filled secret fields hold a session value) after a fresh probe. **`dialog_handle` is not refused before the call** (round 2): a JavaScript dialog (`alert` / `confirm` / `prompt`) stalls its tab's probe, which then fails that tab closed if a secret field was seen there — so a session that met a dialog on a login page must still be able to handle it. Its **result** is still probed and withheld if the lock holds after it. `dialog_handle` handles the **next** dialog (call it before the action that opens one); note that every Playwright client connected to this Brave (the relay's, upstream's) closes a dialog nobody listens for at once, so a dialog stays open only while something holds it. While one is open the probe takes **~3.5 s** (reviewer's measurement: one 2.5 s frame timeout plus session detach), so each tool call costs about **7 s**.

**Lock-episode log** (round 2, log-only): every lock and every unlock appends one JSON line to `<cache root>/default-lock-episodes.log` (`~/Library/Caches/browser-mcp-relay/`; 0600, rotated to `.1` past ~1 MB, like `plainflags-navigations.log`): `{ts, slug, pid, event: "lock" | "unlock", reason: "filled" | "unreadable", kinds, tabs, host, durationMs}` — `kinds` = which rules made the filled fields secret (`type=password`, `autocomplete`, `name-rule`, `otp`, `text-security`, `remembered`; empty for `unreadable`), `tabs` = how many tabs caused it, `host` = the first such tab's host (no path, no query), `durationMs` on the unlock line only. A probe that takes **over 1 s** also appends `{ts, slug, pid, event: "slow-probe", ms, tabs, frames, unreadable}` — counts only, no host (fix round 3). **Never** a value, a field name or id, a URL, a path or a query (and no host on a slow-probe line). It exists to measure how often, why and for how long the default relay locks, and how often the probe is slow. Everything else in the default relay is unchanged: the tool list (`a11y_*`, `execute`, `cookies_export` stay — they read anything on purpose), arguments, launch flags, A76 body stripping, the Meta guard. **An accident guard, not a boundary.** Not covered: a `content_save-as-pdf` or a recording that spans the moment the lock comes on keeps its file (its result is withheld); the in-process Inspector's traffic feed (`BROWSER_RELAY_INSPECTOR_PORT`) shows each call's arguments, a fill's `value` included, as before; console messages and page text, as in plain-flags mode. **Dialog messages:** a page that empties the field and then shows the value in an `alert` / `confirm` / `prompt` hands it to `dialog_handle`'s result (page-authored text, the same class as page text). **A result can leave in the gap** between upstream capturing it and the after-call probe, if Trevor submits or clears the field in that gap (the probe then sees nothing to lock on — the same in plain-flags mode). **Values held earlier and read after the field clears** are not locked on: a debug probe's snapshots (`debug_get-probe-snapshots`), a GET form's query string in `o11y_get-http-requests` (or the URL itself), or a page's own state (React state, a store) read through `execute` or `react_*`.

**Latency** (measured 2026-10-31, headless Brave 156 under the test harness, one tab, a filled session value in the allow list, 15 probes each; `test/isolated-plainflags.test.js` "A77 latency"): one probe takes a median **~3 ms** on a page with no iframes, **~7–9 ms** with 5 same-site iframes and **~12–13 ms** with 5 cross-site (out-of-process) iframes (p90 ≤ 17 ms); a tool call runs two probes (before and after), so it adds roughly **6 / 16 / 26 ms**. Tabs are read in parallel. **A busy page costs more, password or not:** a cross-site iframe running long tasks (2.4 s each) made one probe take **1.4–7.1 s** with no password anywhere (final review of 6b61c6d, measured), so a tool call can take up to **~14 s**; three or four such iframes beside a typed password cost ~3.5 s per probe (measured here). The bounds are the 2.5 s frame timeout, the 10.5 s tab budget and the 11.5 s whole-probe backstop, so the worst case is about 23 s per call. The slow-probe log line (above) records every probe over 1 s. The timeouts (L4) and the origin + path tab memory (L5) are shared with the plain-flags lock (above).

---

## Cloudflare walls

When a page shows *"Verify you are human"*, *"Just a moment…"*, a Turnstile widget, a 429 or an Access login, **follow the `cf-challenge` skill** — it is the session-facing rulebook. The design behind it, with the evidence, is spec v8 (vault `04 - Recon/2026-10-29 Cloudflare Relay Challenge Recon/04 - Playbooks/Browser Work Behind Cloudflare — Spec v8`). **Rule zero: zero clicks on a challenge in the relay, no reloads, no retries** — one detection, one classification, one route. Logins are always typed by the user.

### Whose wall it is — first matching row wins (spec §2)

| # | Signal | `owner` | Route |
|---|---|---|---|
| 1 | `x-ghl-serve-region:` header, or CNAME `sites.ludicrous.cloud`, or A `162.159.140.166` | `highlevel` | §3.1 — HighLevel API first; widget-only cases go to a one-click human step |
| 2 | `powered-by: Shopify` or `shopify-complexity-score:`, or A `23.227.38.x`, or CNAME `shops.myshopify.com` | `shopify` | §3.2 — you tripped the rate limit: stop that store for 10 min, then pace |
| 3 | `302` to `*.cloudflareaccess.com` | `access` | §3.3 — a login, not a bot check |
| 4 | The test host `cf-test.automatedscalinghq.com` | `agency-test` | `expected` — log it, carry on; not counted |
| 5 | Registrable domain is one of the 8 agency zones (the skill's list) | `agency` | §3.3 — a zone config bug: fix or report, never work around |
| 6 | Host ends `.scale-265.workers.dev` | `workersdev` | `report` |
| 7 | Anything else with `cf-ray:` (or a Cloudflare challenge seen in the page) | `vendor` | §3.4 — the vendor's API, else a human step |
| — | none of the above | `none` | `none` — no wall |

Rows 1 and 4 sit above row 5 on purpose: `go.revivemyhair.com` and `aloeheath.com` are on agency nameservers but served by HighLevel, and the test host is meant to challenge. Nameservers never decide row 5.

### `challenge_detect`

Read-only except the lines it appends. `lane` is **required** in every shape — the relay has no lane of its own; pass your `claude-ask whoami` lane (letters, digits, `.` `_` `/` `-`). A call without one is refused before anything is read.

| Shape | Arguments | What it does | Appends |
|---|---|---|---|
| (i) classify | `{lane}` on the loaded page | Scans **every frame of the frame tree** in the browser (a GHL form's widget sits in the form's cross-origin iframe; the `challenges.cloudflare.com` frame itself is recognised by URL and never evaluated in), and reads the page's response headers with a separate `curl -sI` (the skill's step 1A; no query string sent) plus `dig` CNAME/A. Applies the table above | one detection line, **only when the page shows a wall** (below) |
| (ii) pre read | `{lane, origin, stage: "pre"}` **before** navigating; no page needed | Reads that origin's Cloudflare cookies from the jar with CDP `Storage.getCookies` (every partition) and remembers the state for that lane + origin for 10 minutes (memory only — a relay restart forgets it; expired entries are dropped on the next call) | nothing |
| (iii) outcome | `{lane, origin, stage: "outcome"}` after a plain-flags try (`origin` required; the active page must be on it) | Reads the page again (token filled / interstitial cleared → `passed`). **Plain-flags relay only** — refused in the default relay, which never tries (until 2026-10-30 it was refused everywhere: the profile was not built) | one outcome line with the cookie state from (ii) — `cfCookies=unknown` when there is no pre read for that lane + origin, or it is older than 10 min. A pre read is used once |

**What decides what.** The **kind** comes from the browser only: the page title (*"Just a moment…"*), the interstitial's `_cf_chl_opt`, the Turnstile markers in any frame, and the page's own navigation status (`429` → `ratelimit`). The curl read is another client — different TLS fingerprint, none of the browser's cookies — so it decides the **owner** only (rows 1, 2 and 7); its status, `cf-mitigated` and any `302` to Access are returned in `signals.curl` and never make a kind, an owner of `access` or a log line. `access` means the browser itself is on a `*.cloudflareaccess.com` login page. When the widget sits in a **child frame on another host**, that frame decides the owner (`ownerFrom: "frame <host>"`), and rows 5/6 are never read off the top host then — so a GHL form on an agency site is `highlevel`, not `agency`. HighLevel's widget domains (`leadconnectorhq.com`, `msgsndr.com`) are `highlevel` by name; any other widget-frame host (up to 3 per call) gets its own `dig` CNAME/A, and rows 1–2 are applied to that answer before the host lists — so a GHL form served from the location's white-label domain (CNAME `sites.ludicrous.cloud` / A `162.159.140.166`) is `highlevel` too. A HighLevel frame (by domain or DNS) wins whenever one holds the widget, wherever it sits in the frame order; otherwise markers in the top document mean the page itself decides, then the first marked child, then a challenge frame's parent. A child frame on the page's own host counts as the page.

**A wall** — and so a log line — is a Cloudflare owner (not `none`) plus, in the browser, an interstitial, a Turnstile without a token, or a 429; or the browser on an Access login. A Turnstile has passed only when **every** frame showing a widget holds a token input and all are filled: `turnstilePassed: true`, route `none`, nothing appended. One filled form beside an unsolved one is still a wall. A 429 off Cloudflare (owner `none`) is not logged.

Returns (shape i): `owner`, `row`, `ownerFrom`, `kind` (`interstitial` \| `turnstile` \| `ratelimit` \| `none`), `turnstilePassed`, `plainflagsEligible`, `reason` (`eligible` \| `not-built` \| `owner-route` \| `kind` \| `signin-not-listed`), `route`, `clickBudget`, `cfCookies`, `cookies`, `errorCodes`, `notes`, the raw `signals` (navigation status, curl's read, the skill's header list, DNS answers, the widget frame's host, each frame's marker counts, whether the page is a known account's login page) so a misclassification can be seen, and `log`. **`route`:** `none` when there is no wall, for every owner (Access aside: `§3.3`); `in-page-turnstile` for a Turnstile widget, with `guidance` — spec §2 step 2's three ways on: verify the page only (no submission needed), exercise the backend through the official API (for HighLevel after the §3.1 B0 GO), or the real widget path via the §4 one-click human step; otherwise the owner's route (a spec §3 section, `expected` for the test host, `report` for `workersdev`). **The sign-in list (both relays):** since phase 1c the default relay too reads `plainflags-signin.json` and the claude-ask store (`~/.claude-asks`) — read-only, re-checked at most every 30 s — to decide `reason: signin-not-listed`; an entry its ask does not grant is treated as not listed, so this can only make the classification stricter. **An eligible wall** (`plainflagsEligible: true`: owner `highlevel` or `vendor`, kind `interstitial` or `turnstile`, and the page is not the login page of a known account missing from the (verified) sign-in list). **In the default relay `route` stays exactly the route above** (unchanged from phase 1); the result only adds `switchTo: "browser-mcp-relay-plainflags"` and `plainflagsServer: "available-if-registered"` — a session that has that MCP server may repeat the step there, and one that does not takes `route` as before (the server needs Trevor's GO to register). **In the plain-flags relay** `route` is **`plainflags-try`** and `fallbackRoute` carries the route above. **`clickBudget`** is `1` only for `plainflags-try` while no plain-flags relay has spent a `challenge_click` on that host in the last 10 min (the shared count file), else `0`. (Review round 1, 2026-10-30, retracted the first 1c build's `route: "switch-to-plainflags-server"` in the default relay: it pointed sessions at a server they may not have.)

**A Turnstile has passed** (`turnstilePassed: true`) only when every marked frame's token inputs are all filled **and** every visible `challenges.cloudflare.com` frame hangs under a marked frame holding at least as many filled token inputs as it has visible challenge frames (phase-1 review finding F1, fixed 2026-10-30): a second widget whose input the scan cannot see (a closed shadow root, a frame that timed out) still shows its challenge frame, so it keeps the page a wall. Each frame in `signals.frames` carries `id` and `parentId` for this; a challenge frame also carries `visible` (its owner element has a box), and one with no box is left out.

**`errorCodes`** (`600010` = bot detection, benign; `110200` = sitekey/hostname mismatch, a real outage — report it) are a plain text match on each readable frame's body: they can false-match any page text containing those digits (a phone number), and a code rendered **inside the `challenges.cloudflare.com` frame is not read** (that frame is never evaluated in). Treat them as a hint; the Turnstile error itself is authoritative.

**`cfCookies`:** `none` = no `cf_clearance` / `__cf_bm` / `_cfuvid` for that site and no `challenges.cloudflare.com` cookie partitioned under it; `partitioned` = a `cf_clearance` with a CHIPS `partitionKey`, or a challenge-host cookie partitioned under the site; `present` = otherwise; `unknown` = not read. **Names, domain, path, flags and partition site only — never a cookie value**, and a Turnstile token only as its length. Response headers are limited to the skill's list (never `set-cookie`), `location` to its host.

~~**Not built yet (phase 1):** the separate plain-flags profile waits for a measurement (spec D22), so `plainflagsEligible` is always `false` with `reason: not-built` and `route` never says switch or try; `clickBudget` is `0`; shape (iii) is refused.~~ **Superseded 2026-10-30 (phase 1c):** the D22 measurement passed (vault `00 - Summary/Phase 1b Measurement (D22).md`: with the plain flags a GHL invisible-mode Turnstile issued a token on load in 3 of 3 loads; the default flags got none), so the profile is built — `reason: not-built` no longer occurs. The known-account list (`src/known-accounts.js` — every entry still *unconfirmed*, spec §10 #25) and the sign-in list loader (`src/plainflags-signin.js`) are now **enforced** in the plain-flags relay (below), which creates `plainflags-signin.json` empty on its first start.

### The plain-flags relay (`browser-mcp-relay-plainflags`)

Spec v8 §5.6 (D29: a **separate** profile — the default relay is unchanged; D20: any site; D21: a sign-in list of accounts, empty at start; D22: built because its measurement passed). A second MCP server that runs the same relay with `BROWSER_RELAY_PROFILE_MODE=plainflags`, for one thing: a session that met an eligible wall repeats that step here (`challenge_detect` adds `switchTo: "browser-mcp-relay-plainflags"`). **These are accident guards, not a security boundary** — the env, `plainflags-signin.json`, the claude-ask store `~/.claude-asks` that the sign-in list's ask check reads, and this code are all writable by any session (so a determined or prompt-injected session can add an entry **and** write an ask record that passes the check), and any local process (a session's Bash included) can drive this Brave directly over its debugging port (`<profile>/DevToolsActivePort`, `cdpPort` in `<profile>/.mcp-relay-status.json`), outside the tool list and the layer-1 checks; the layer-2 Fetch guards still see its navigations, not its cookie reads. Code enforces D21 only for the **known** accounts; a login on a site that list does not name is not refused, and the typed-secret checks read field attributes, so *never type a password* and *logins are Trevor's* remain skill rules.

**The lock — the primary protection** (review rounds 3–4; Trevor's rulings `as-ops/ask-u5qaev`, *"Lock while secret on page"*, and `as-ops/ask-ht5fsa`). Signing in is a primary use of this profile, and per-tool sealing kept missing upstream paths (a screenshot's `annotate`, a `javascript:` URL), so the protection is **default-deny keyed on the secret** (`src/plainflags-lock.js`). Before **every** tool call except `relay_status` and `tabs_list`, and again after it before its result leaves, one probe reads **every tab** of this Brave — every frame of each tab's frame tree, open shadow roots included — and the browser is **locked** while:
1. a **secret text-entry field holds a value**. Text-entry = a `<textarea>`, or an `<input>` of type text / password / email / tel / number / search / url (or none) — a checkbox, radio, hidden, submit, button, image, reset, file, range or color input never counts, whatever its name (its value is a fixed string, not typing; round 4 found a checked "remember password" box, an `otp_method` radio, a hidden `passengers` and a `password-submit` button all locking). Secret = `type=password`; `autocomplete` `current-password` / `new-password` / `one-time-code`; a `name` / `id` containing `pass` or `pwd` (a substring, fail closed: "passport" counts) or holding the **word** `otp` (names are split into words at `_`, `-`, other punctuation, camelCase and — review round 7 — acronym boundaries first, so `OTPCode` is `otp code`, `MFACode` is `mfa code`, and `TwoFACode` / `2FACode` are `2fa code`; `smsOtp` and `otp_code` count, `footprint` does not; review round 6); a computed `-webkit-text-security` other than `none`; or one box of a **split one-time code** (≥ 4 inputs in one container with `maxlength` ≤ 2 and `inputmode` numeric / a digit `pattern` / type tel or number, or an input right beside a `one-time-code` input); or a **single 2FA / verification code field**, judged on the **words** of its `name` and `id` (review round 6 — substrings made `barcode`, `footprint` and `state_code` secret): a word `mfa`, `2fa`, `totp`, `otp`, `passcode` or one starting `verif` with a numeric `inputmode` or `maxlength` ≤ 8 is secret whatever else the name says (`phoneVerificationCode`, `dialog-verification-code`, `mfa_code_area`); a word `pin` with a numeric `inputmode` is secret; a word `code` (or `smscode`, `authcode`, `logincode`, `accesscode`, `securitycode`, `emailcode`, `onetimecode`, `confirmcode`, `confirmationcode`, `signincode`) beside a word `sms`, `auth`, `2step`, `twostep`, `factor`, `login`, `signin`, `security` or `onetime`, with a numeric `inputmode` or `maxlength` ≤ 8, is secret (`sms_code_phone`); otherwise the bare word `code` is **not** secret when another word says zip / postal / postcode / promo / coupon / discount / referral / referrer / voucher / gift / country / area / phone / dial / currency / state / lang / language / product / sku / item / color / colour / region / province (`state_code`, `currency_code`), and is secret only with `maxlength` ≥ 4 and either a numeric `inputmode` or `maxlength` ≤ 8 (HighLevel's 2FA code); or **any element once seen as secret** in that document — a show-password toggle turns `type=password` into `type=text` with nothing else to recognise it by, so the probe remembers (a `WeakSet` in its isolated world; review round 5). Contenteditable is not probed (no value; its text is page text). The probe returns **counts only**, never a value;
2. a tab's URL is a known account's **sign-in page** — a path-scoped matcher (`www.canva.com/login`) or a dedicated sign-in host (`accounts.google.com`, `login.microsoftonline.com`, `login.live.com`, `appleid.apple.com`, `idmsa.apple.com`, `auth.hostinger.com`, `accounts.shopify.com`), listed or not. An **app host** — HighLevel's `app.gohighlevel.com` / `app.leadconnectorhq.com` / `app.myautomatedbiz.com`, `admin.shopify.com`, `hpanel.hostinger.com`, `dash.cloudflare.com` — is the signed-in app too, so its URL does **not** lock (round 4 found the whole dashboard locking); rule 1 covers its sign-in form once a password is typed. HighLevel's and Cloudflare's sign-in **paths** are not confirmed (spec §10 #25), so they have no URL rule;
3. **fail closed, per tab:** a frame of a tab could not be read (an error, a 2.5 s timeout) while a secret field was seen on **that** tab (now, or on its last probe of the same page), or while one of that tab's frames is on a sign-in page. A tab's memory is dropped when its **origin + path** changes or it closes — a `?step=` or `#hash` change on the same page keeps it (1c final review L5; it was the full URL) (round 4: a hung frame in one tab and an empty sign-in form in another no longer lock, and leaving clears it). **Timeouts (1c L4):** opening each CDP session is bounded by the same 2.5 s as every CDP call; tabs are read **in parallel**, and within a tab every frame target's session, `Runtime` and frame tree are had in parallel too (so N hung out-of-process frames cost one 2.5 s timeout, not N, and the main frame is read first); each tab is bounded at **10.5 s** (4 frame timeouts — the parallel setup's 3 plus the main frame's read — and a 0.5 s margin; it was 7.5 s until fix round 3, which left the main frame unread when every setup step answered just under its timeout) and the whole probe at 11.5 s. A timeout is *unreadable*, which fails closed only by this rule, so a hung frame can never hang the relay (or `relay_status`). **A tab that times out keeps every frame already read** (A77 fix round 1: the first version replaced the whole tab with one unreadable frame, so a password typed in the main frame beside 3 busy cross-site iframes did not lock — measured; it now locks in ~3.5 s, tested with 3 and 4 busy iframes in both modes).

**How it reads:** in the relay's own **isolated world** of each frame, addressed by its **`uniqueContextId`** (review round 6). **Nothing is cached between probes (review round 7, rule 0):** every probe opens **new** CDP sessions — one for each tab and one for each out-of-process frame — and detaches every one of them when it ends, so whether a frame is in-process or out-of-process, which target it lives in, and which context is the relay's world are all decided afresh, from events captured on that probe's own sessions. Nothing relay-side is reused: no session, no in-process flag, no context id. Round 6 cached "in-process" per Playwright frame, and Playwright keeps the **same** frame object when an iframe moves into or out of its own process (measured), so an about:blank or same-site iframe that later navigated cross-site to a password page stayed unread and a typed password did not lock; the real-Brave tests now run that move (from about:blank and from same-site), the reverse move, and a second process swap of an out-of-process frame with the very next probe locking, 10 times each. What does persist is **in the page**, not the relay: the relay's named world (one per document — a new session is told about it on `Runtime.enable` and `Page.createIsolatedWorld` hands back the same world, measured on Brave 156, so the probe's show-password memory survives from one probe to the next), and the lock's per-tab note *a password field was seen on this URL*, which can only ever ADD a lock (an unreadable frame on that same page fails closed) and is dropped when the tab's origin + path changes or the tab closes. The relay enables `Runtime` on each of its sessions (Playwright already enables it on its own sessions, so this adds nothing a page can detect), records each `Runtime.executionContextCreated` for a context named `__browser_mcp_relay_lock__` (its numeric id, `uniqueId`, `frameId` and type), and clears that record on `executionContextsCleared` / `executionContextDestroyed`. `Page.createIsolatedWorld` returns a numeric id; the world is accepted only when a recorded creation event for that id names **this frame** and type `isolated` — Chrome re-creates a named world in each new document by itself and `createIsolatedWorld` then returns that existing id with no new event (measured, Brave 156), so the id is looked up in the record rather than awaited. Every `Runtime.evaluate` then names the world's **`uniqueContextId`**, never the numeric id. A unique id is never reused, so a numeric id that Chrome hands to another context after a cross-process navigation cannot redirect the probe: the evaluate either reaches the relay's world or fails (`Cannot find context`), and the world is looked up again. A world that cannot be identified **twice** locks that tab (fail closed). Round 5 found the first version failing **open** — after a same-tab **cross-site** navigation Chrome reused the numeric context id for a child iframe's context and the probe read that frame (24 of 40 sequences); the round-5 fix stamped each world with a nonce and checked it before reading. **The stamp is removed entirely in round 6**: it was itself written by numeric id, so in that window the write could land in a reused context — the page's main world included. Nothing is evaluated by numeric id any more. The real-Brave tests run the cross-site sequence 12 times and a hostile child page (getters that record every touch) 40 times per run, and a fake-CDP test reproduces the remaining race — a process swap landing between `Page.createIsolatedWorld` and a `Runtime.evaluate` already on its way — and locks because the main frame was read; a mutant that evaluates by the numeric id fails it. **What page code can see:** in normal operation, nothing — the probe never runs in the page's main world, so no page getter, wrapper or override is ever called by it (measured: a wrapped `querySelectorAll` records no call; a page-world override of `HTMLInputElement.value` cannot hide a typed password). There is **no fallback path left** that evaluates by numeric id, so the stale-world route review round 5 described no longer exists; the remaining failure is a world that cannot be identified, and that fails closed. Every function the plain-flags relay evaluates in a page (the probe, the fill check's field probe, `challenge_click`'s token read, `challenge_detect`'s probe, the sign-in watchdog's read) runs in **strict mode**, so even a page function it does call (the fill check runs in the main world through Playwright) cannot reach it through `.caller` (tested). Unreadable frames are counted **frame by frame** (each Playwright frame matched to a frame some CDP session described; a frame no session described, or inside an out-of-process target whose tree never answered or whose own CDP session could not be opened — round 6: any `newCDPSession` failure other than Playwright's "does not have a separate CDP session" for an in-process frame — is unreadable, so a frame CDP describes before Playwright lists it cannot stand in for it), not by comparing counts. The world is an **isolated world** (CDP `Page.createIsolatedWorld` + `Runtime.evaluate` on the frame's own target session — an out-of-process frame through its own), never the page's main world: page code neither sees the probe (a wrapped `querySelectorAll` records no call — measured) nor can lie to it (a page-world override of `HTMLInputElement.value` cannot hide a typed password — measured). A frame on **`challenges.cloudflare.com`** (or inside one) is never touched — no session, no world — and counts as readable with no secret, like `challenge_detect`.

While locked every other tool is refused with *"Locked: a password or one-time code is on this page (Trevor may be signing in). Tools resume when the field is empty or the tab leaves the sign-in page."*; a result — or a thrown error — produced while the lock came on is withheld (a withheld screenshot's file is deleted). `LOCKED` / `UNLOCKED` are announced on the next tool result, and `relay_status` reports `lock` (`locked`, `reason`, `since`, counts) after a fresh probe. **Every tab, not the selected one**, because upstream's tools act on the tab upstream pinned and a sign-in can run in a popup — so `tabs_select`, `tabs_new` and `tabs_close` are not exempt (none of them leaves a whole-browser lock; two navigate upstream's tab; `tabs_close` could close the tab Trevor is typing in). The session waits and watches the sign-in with `tabs_list`; `tabs_list`, `tabs_select`, `tabs_new` and `tabs_close` here return each URL as **origin + path only** — no query, no fragment, no `user:password@` (`?code=`, `#access_token=`, magic-link and reset tokens). **Every other `http(s)` / `ws(s)` URL** in every plain-flags result, refusal and thrown error — inside prose too (the upstream-desync warning, a layer-1 refusal quoting the caller's URL, an upstream error) — is cut at its first `?` or `#` (review round 6; round 7: a bracket or backslash inside the URL no longer ends it early, so `…/a]?code=…` loses its query too, and closing brackets that followed the cut — the prose's own `)` — are put back). **In plain-flags mode, links read from page text, HTML, `o11y_*` results and `capture_xhr` lose their query strings, so following one may land on the wrong page;** read it in the default relay when the query matters. **Accepted residuals:** the show-password memory lives in the probe's isolated world, so it lasts for that document only and is lost if the world must be recreated (it could not be identified, or died) while the field is toggled to text; and the HTML blanker (below) decides on the attributes it sees, so a toggled field's `value` attribute is not blanked by name — but while that field holds a value the lock refuses `content_get-as-html` anyway; a secret field inside a **closed** shadow root is invisible to the probe (a known sign-in page still locks by URL); a code in a plain text field the page never marks is not a secret to it; an app host's sign-in form locks only once something is typed; **console messages** and a **one-time code shown as page text** (an email or SMS code on a page) are not locked on — *never read the console or the page text of a sign-in or code page* is a skill rule; a **JavaScript dialog** (`alert` / `confirm` / `prompt`) on a tab can stall that tab's probe until it is dismissed — `dialog_handle` is not exempt, so a dialog on a tab where a secret field was seen keeps the browser locked until Trevor dismisses it (no leak — review round 4 L10); and, as everywhere here, any local process can drive this Brave over its debugging port. The per-tool filters below stay as a second layer.

**The launch.** `--enable-automation` goes into Playwright's `ignoreDefaultArgs`, `--disable-blink-features=AutomationControlled` and `--no-proxy-server` into `args` (and `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`, in any case, are stripped from Brave's environment — no proxy reaches it from any source), `--remote-debugging-port=0` and the CDP identity proof stay (D23) — `navigator.webdriver` is `false` (measured, D22 and `test/isolated-plainflags.test.js`). No `viewport: null` / window-size change (D4: it changed nothing in the measurement). **Refused at start** (the relay exits, nothing claimed): any proxy (the resolved value — `BROWSER_RELAY_PROXY_URL`, a `local-config.json` key or the wrapper's `proxyUrl`), insecure TLS (`BROWSER_RELAY_INSECURE_TLS`), any extension (`BROWSER_LOAD_EXTENSIONS`: a password-manager extension could autofill).

**Its own folder, never seeded from a logged-in profile.** `launch-project-isolated.js` picks `~/Library/Caches/browser-mcp-relay/profiles-plainflags/<project-slug>/` (a separate root; **never written into `project-registry.json`**); a temp-path project gets an ephemeral dir under `session-clones-plainflags/`, and a second concurrent session an ephemeral clone there too (seeded from the plain-flags base only — `Local State`, cookies, local/session storage — and **never `Login Data*`**). The wrapper's `cookieSourceProfile` is forced to null. The relay **refuses to start** on a pool dir that is (or nests with) a registered project profile, the standalone `.browser-data` dir, a configured `cookieSourceProfile`, anything under the default `session-clones/`, or anywhere outside the two plain-flags roots (an unreadable registry also refuses); the **default** relay refuses a pool dir under either plain-flags root. **Password saving is off:** before every launch the relay writes `credentials_enable_service: false` and `profile.password_manager_enabled: false` into `Default/Preferences` and deletes `Default/Login Data*` in the dir it claimed. Vault autofill is off (no vault is loaded).

**Tool list — an allowlist, fail closed** (a new upstream tool stays hidden until named here; every other name is refused at call time with the reason): `relay_status`, `challenge_detect`, `challenge_click`, `cf_cookies_clear`, `tabs_list` / `tabs_new` / `tabs_select` / `tabs_close`, `navigation_go-to`, `navigation_go-back-or-forward`, `interaction_click` / `interaction_fill` / `interaction_hover` / `interaction_press-key` / `interaction_scroll` / `interaction_select`, `form_fill`, `sync_wait-for-network-idle`, `content_get-as-text`, `content_get-as-html`, `content_take-screenshot`, `o11y_get-http-requests`, `o11y_get-console-messages`, `capture_xhr`, `storage_clear-local`, `dialog_handle`. Not here: **`a11y_take-aria-snapshot` and every `a11y_*` tool** (review round 2: Playwright's ARIA snapshot gives an input its **value** as text — `- textbox "Password": <what was typed>` — for every input but checkbox / radio / file; `content_take-screenshot` and `content_get-as-text` cover seeing the page, and the latter reads text nodes only, never a field's value); `execute` and `scenario-*` (page/Playwright code reaches cookies, request headers and password fields), `debug_*`, `stub_*`, `emulate_device`, `navigation_reload` (rule zero), `cookies_import` / `storage_set-local` (no cross-profile state, D24), `cookies_export` / `storage_get-local` (tokens into the transcript). Debugging a page means the default relay. `navigation_go-to` and `navigation_go-back-or-forward` return an ARIA snapshot **by default** upstream, so here `includeSnapshot` is forced off (`includeSnapshot: true` is refused) and any `output` / `refs` is stripped from their results. **URLs:** every `url` / `navigateToUrl` argument (`navigation_go-to`, `tabs_new`, `capture_xhr`) must be `http:` / `https:` or exactly `about:blank` — `javascript:` (which runs page code, past the `execute` ban — demonstrated by the round-3 review), `data:`, `file:`, `blob:`, `chrome:` and `view-source:` are refused before anything reaches upstream. **Screenshots:** `annotate`, `annotateContent` and `annotateCursorInteractive` are refused, forced off and removed from the schema (`screenshotOptions.annotate…` on a navigation likewise), and any `annotations` are stripped from results — annotations name the page's elements, a typed value included (demonstrated). **Selectors:** the rule is *the check and the action resolve the selector identically* (review round 4 L9 — the earlier "CSS only" was wrong): every selector argument (`selector`, `sourceSelector`, `targetSelector`, `anchorSelector`, `form_fill`'s fields) accepts CSS, `xpath=`, `text=`, `id=`, `>>` chains and `internal:control=enter-frame`, which resolve the same way through `page.locator()` in the relay and in upstream; an aria-snapshot ref and a `getBy*(…)` expression are refused (upstream resolves those its own way), and so are the `role=` / `internal:role` / `internal:label` / `internal:testid` / `internal:attr` engines. **Error text:** everything from `Call log:` on is cut from every result string **and from an error thrown out of a call** — the client's message and the Inspector feed alike (Playwright quotes the element it acted on there, attributes and a mirrored value included). **Screenshot files** go to a relay-private directory in this profile (`<profile>/.relay-screenshots`, 0700) whatever `outputPath` asks (the argument is removed from the schema), and a withheld screenshot's file is deleted. Two paths stay open outside the lock and are skill rules: a **screenshot** shows whatever a field displays once no secret is in it any more, (round 6: URLs in results no longer carry a query string, so a **GET form's** fields no longer reach the transcript that way; a URL quoted without a scheme — `example.com/p?code=…` — is not recognised as one and is passed as is). Every tool result in this relay starts with a `[browser-mcp-relay] PLAIN-FLAGS profile …` line, and `relay_status` reports `profileMode`, the sign-in list and the guards.

**No typed secrets.** `interaction_fill`, `form_fill` and `interaction_select` take a **selector, never a ref or a locator expression** (CSS, plus the plain Playwright engines `xpath=`, `text=`, `id=` and `>>` chains, which `selectorProblem` allows — corrected 2026-11-03: this said "CSS selector only", which the round-4 L9 widening had made untrue; 1c final review L3) — an aria-snapshot ref (`@x`, `ref=x`, `e5`) or a Playwright locator expression (`getByRole(…)`, `getByLabel(…)`, …) is refused, because upstream resolves those its own way. The relay then inspects **the element the action will actually reach**, on the page it runs on — `interaction_*` on **upstream's own page** (an internal upstream call), `form_fill` on the relay's active page — with the same `page.locator(s).first()` resolution (frames and shadow roots followed) and **Playwright's own label retargeting** (`retarget(node, "follow-label")`, copied step for step: a `label[for=pw]`, a `<span>` inside a wrapping label or a nested label fills the label's `.control` — review round 1 found the first build checked the label itself and let the fill land on the password field). A fill is refused unless that element is an `<input>`, a `<textarea>` or contenteditable, and when it is `type=password`, has an `autocomplete` holding `current-password`, `new-password` or `one-time-code`, has a `name` or `id` containing `pass` or `pwd` or holding one of the words `otp`, `mfa`, `totp` or `2fa` (split as for the lock, acronyms first: `footprint`, `barcode` and `state_code` pass; `smsOtp`, `OTPCode`, `MFACode`, `TOTPCode`, `OTPInput` and `TwoFACode` do not — the HTML blanker uses the same words) or a computed `-webkit-text-security` other than `none` (a show-password toggle that turned the field into `type=text` — review round 2; the name rule also catches e.g. "passport", fail closed), or cannot be inspected; `interaction_select` must reach a `<select>`; `interaction_press-key`'s `selector` (which Playwright focuses as-is) must not be a secret field. `interaction_press-key` takes named keys only — `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, the four arrows, `Home`, `End`, `PageUp`, `PageDown` — no printable character, no `Space`, no modifier (no paste). Fill and press-key are refused while upstream's tab is not the selected one, and `allowPinnedPage` is not honoured for them here. The DOM can change between the check and the action (argued, not demonstrated).

**No headers, no bodies out.** `o11y_get-http-requests` refuses `includeRequestHeaders`, `includeResponseHeaders` and `includeResponseBody` (request headers can carry `Authorization` or the agency's `x-as-qa` header; response headers `Set-Cookie`; a body a session token — whether Playwright's header map carries `Cookie` / `Set-Cookie` at all is unmeasured, spec §10 #27, and the refusals ship either way). Request bodies are stripped relay-wide (A76 — a startup source patch of upstream plus a result filter), and this relay also strips `body`, `headers`, `requestHeaders`, `responseHeaders` and `responseBody` from every item **and from a nested `item.request` / `item.response`** (plus `postData`). `capture_xhr` runs with `includeBody: false` forced (`includeBody: true` is refused) and returns only an **allowlist** of response headers: `content-type`, `cf-mitigated`, `cf-ray`, `server`, and `location` reduced to its host. `content_get-as-html` returns the `value` attribute of every `<input type=password>`, every input whose `autocomplete` holds `current-password` / `new-password` / `one-time-code` and every input whose `name` / `id` matches the rule above blanked (`value=""`), found by a scanner, not a regex: comments and raw-text elements (`script`, `style`, `textarea`, `title`, …) are skipped whole, an `<input>`'s end is found by its attribute tokenizer (a quote opens a value only right after `=`), the first of a duplicated attribute wins and every `value` is blanked — so `placeholder="x type=text" type=password value=…` is caught; the result is re-scanned, and if any secret input still carries a value it is withheld. (While a field holds a typed value the lock refuses this tool anyway.) While a sign-in hands ask is open, check the tab with `tabs_list` only.

**The sign-in guard** (`src/plainflags-signin-guard.js`). The **known-account list** (`src/known-accounts.js`, edited only by a reviewed commit) names each account's login matchers (a host, or a host + path prefix, matched on the parsed, decoded, lower-cased path), cookie origins and session-cookie names. HighLevel's login hosts are `app.gohighlevel.com`, `app.leadconnectorhq.com` and the agency's white-label app host **`app.myautomatedbiz.com`** (named by Trevor 2026-10-30, ask `as-ops/ask-akpnud`). The **sign-in list** is `plainflags-signin.json` in the relay root (gitignored; `{"accounts": [{"name": "<account>", "askId": "<claude-ask id>"}]}`; created **empty**; missing or malformed → empty, every known account refused; re-read whenever it changes). **An entry counts only when its `askId` grants it** (`src/plainflags-ask-verify.js`, read-only): the record `~/.claude-asks/<project>/<short>.json` (or its `archive/`) must exist, match its id, be `answered`, `in_progress` or `done`, carry `risk: "credentials"` and a non-declining answer, and its title must name the account (and, with `BROWSER_RELAY_PLAINFLAGS_REQUIRE_TYPED_ANSWER=1`, its answer must carry a `prompt_id` from the A71 typed-words recorder — off until that recorder is live); otherwise the entry is **refused** — treated as not listed — and the refusal is announced. **This check is not a gate**: the ask store is writable by any session. It catches an entry added with no ask, a wrong id, a declined or waiting ask, or an ask for another account or risk. Every **addition**, removal and refusal is announced on the next tool result (the list in force at start is announced on the first one) and listed in `relay_status` (`signinList.accounts` = verified, `.refused`, `.recentChanges`). For a known account **not** on the list: (a) a `url` / `navigateToUrl` argument on its login matcher is refused before any browser work; (b) a top-level document or popup to it (typed, a link, a redirect, `window.open`) is answered with a 403 page naming the route — on its own CDP connection, the Meta guard's mechanism; (c) at every launch, before the first tool call, every cookie of its cookie origins (partitioned copies included) and all their storage (`Storage.clearDataForOrigin`, all types — service workers too) are deleted; (f) its session cookies are deleted on arrival — a `Set-Cookie` on a response **from one of its login or cookie-origin hosts** (or a subdomain; a request whose URL was not seen counts, fail closed) triggers a sweep, and the `Storage.getCookies` sweep also runs before and after every tool call (the only way a cookie set by another host, inside a cross-origin iframe or by a worker is seen); a sweep makes at most 3 passes; its storage is cleared, logged by account name; (g) an account taken **off** the list is cleared at once — after the browser is (re)armed, and marked done only once the clear succeeded (a failed clear refuses that call and is retried on the next); (h) a main frame that reaches its login matcher anyway (a service-worker-served navigation) is sent to `about:blank`. **Every shipped account is still *unconfirmed*** (spec §10 #25: no login page has been read for its exact cookie names), so each **fails closed**: **any** cookie that applies to one of its login hosts counts as its session cookie — except Cloudflare's own `cf_clearance` / `__cf_bm` / `_cfuvid` / `cf_chl_*`, which the on-arrival sweep keeps so a plain-flags try on a known account's public pages can hold its clearance. The cost: a known account's public pages (canva.com) lose their other cookies and storage on every tool call in this relay. An entry marked `confirmed: true` (after the §10 #25 read, by a reviewed commit) is matched by its named session cookies only. **Adding an account** is Trevor's GO by name (`--risk credentials`); removing one needs no GO.

**`challenge_click`** (`{lane}`) — the one click. It walks the frame tree to the `challenges.cloudflare.com` frame (inside a form's cross-origin iframe or a closed shadow root), scrolls each owner `<iframe>` into view from the innermost out, waits until the widget's box stops moving (a click sent at once after the scroll was measured landing on the top document's `<iframe>` element), and sends one CDP `mouseMoved` / `mousePressed` / `mouseReleased` through the top page at the **measured point for the widget's layout**, from the widget iframe's top-left — **normal (300×65): x 30, y = height / 2** (3/3 tokens) and **compact (150×140, picked when the box is taller than 100 px): exactly x 24, y 28** (4/4 tokens; the normal point and (22, 30) both failed there — the hit area is smaller than the drawn box). Measured 2026-10-30 on Cloudflare's test sitekey `3x00000000000000000000FF`, Brave 156, a fresh profile per load (vault `00 - Summary/Phase 1b Measurement (D22).md`). The fixture test measured exactly one click inside a nested cross-origin frame, `isTrusted: true`. After the click it watches the page's `cf-turnstile-response` inputs for up to 8 s and returns **`passed`** (`true` = every readable token input is filled, `false` = not, `null` = none readable) with `tokenBefore` / `tokenAfter` as **lengths only** and whether the challenge frame is still mounted — `clicked: true` only says input was sent. No challenge frame → refused, nothing sent (`widget: "absent"`); a frame under 4×4 px is an **invisible-mode** widget (the D22 GHL form: 1×1, token on load) → refused, nothing sent (`widget: "invisible"`): wait, then `challenge_detect`. **One per host per 10 min across every plain-flags relay**: the count is the file `profiles-plainflags/.challenge-clicks.json` under its own lock `.challenge-clicks.flock` (bounded wait, then refused), spent before the input is sent — a second session or a restart sees it.

**`cf_cookies_clear`** (`{origin}`) — after a failed try. On a site with **no** account on the sign-in list (every site at start) it deletes every cookie of the site's registrable domain (partitioned copies included) plus every `challenges.cloudflare.com` cookie partitioned under the site; on a site whose account **is** listed, only `cf_clearance`, `__cf_bm` and `_cfuvid` and the challenge partition (that those three suffice is inferred). `Network.deleteCookies` with each cookie's own `partitionKey` (measured removing partitioned cookies in Brave 156, spec §10 #24), then a re-read reports what remains. "Registrable domain" is the last two labels, or three under a common two-level suffix (`co.uk`, `com.au`, …) — no public-suffix list ships with the relay.

**Navigation log.** Every top-level navigation in this mode appends `{ts, slug, pid, event: "navigation", host}` (host only — no path, no query) to `<cache root>/plainflags-navigations.log` (0600, rotated past ~1 MB), so use without a wall shows up next to the CF-WALL log. The Meta guard runs unchanged (all three layers); the spec §5.4 secret header is not armed here.

**Registering it — Trevor's GO (global config; this build does not register it).** It is launched exactly like the default relay, plus one env var:

```
command: node
args:    ["/Users/trevor/Documents/browser-mcp-relay/launch-project-isolated.js"]
env:     BROWSER_RELAY_PROFILE_MODE=plainflags
```

Ready-to-paste MCP JSON (the `mcpServers` object of the Claude Code config, beside the existing `browser-mcp-relay` entry, or a project's `.mcp.json` for a project-scoped entry):

```json
"browser-mcp-relay-plainflags": {
  "type": "stdio",
  "command": "node",
  "args": ["/Users/trevor/Documents/browser-mcp-relay/launch-project-isolated.js"],
  "env": { "BROWSER_RELAY_PROFILE_MODE": "plainflags" }
}
```

Do not add `BROWSER_RELAY_PROXY_URL`, `BROWSER_RELAY_INSECURE_TLS` or `BROWSER_LOAD_EXTENSIONS` to it (the relay refuses to start), and do not add `BROWSER_RELAY_POOL_DIR` (the launcher sets it). **Pin the default entry too** (review round 1 item 9): add `"env": { "BROWSER_RELAY_PROFILE_MODE": "default" }` to the existing `browser-mcp-relay` entry, so a `BROWSER_RELAY_PROFILE_MODE=plainflags` left in a shell or a parent environment can never turn the everyday relay into the plain-flags one:

```json
"browser-mcp-relay": {
  "type": "stdio",
  "command": "node",
  "args": ["/Users/trevor/Documents/browser-mcp-relay/launch-project-isolated.js"],
  "env": { "BROWSER_RELAY_PROFILE_MODE": "default" }
}
```

(Keep any other keys that entry already has.) **Standing cost:** every Claude session that loads an MCP entry starts its relay, which idles at **~50 MB** (one relay node plus one upstream node, no Brave — the code comment in `src/index.js`, not re-measured), so a **global** entry across ~30 lanes is roughly **+1.5 GB** of idle RAM (inferred arithmetic). The alternative is a **project-scoped** entry (a `.mcp.json` in the project root, or `claude mcp add --scope project`) only in the lanes that meet walls. Brave itself starts only on the first tool call, and the idle reaper closes it after `BROWSER_RELAY_IDLE_MINUTES`.

#### The lazy stub (`plainflags-stub.py`)

Trevor's ruling `as-ops/ask-qenedy` rev 2 (*"Build the lazy stub, all repos"*): the plain-flags relay in **every** session, without its idle cost. Claude Code runs `plainflags-stub.py` (Python 3.9 stdlib, `/usr/bin/python3`) instead of the relay. The relay's code is unchanged; the stub only delays its start and passes lines through.

- **Before the first tool call** the stub answers the handshake itself — `initialize` (the client's protocol version echoed when the relay's MCP SDK supports it, else the SDK's latest; the relay's `serverInfo`, `instructions` and capabilities, with `tools.listChanged: true` added so the drift notice below is honoured), `notifications/initialized`, `ping` and `tools/list` — from **`plainflags-tools.json`**. No relay process exists yet.
- **Any other request** (the first `tools/call`, `resources/*`, …) starts the real relay: `node launch-project-isolated.js` beside the stub, with the session's cwd and env and `BROWSER_RELAY_PROFILE_MODE=plainflags` forced, in its own process group. The stub replays the client's exact `initialize` under its own id, sends `notifications/initialized`, then the requests that queued meanwhile, in order. From then on every line goes through unchanged both ways, the client's ids included; only the stub's own two requests (the replayed `initialize` and a `tools/list` check) carry stub ids, and their answers never reach the client. Relay notifications and stderr are passed through.
- **Drift at runtime:** that `tools/list` check compares the relay's list with the file; if they differ, the stub logs a warning, sends `notifications/tools/list_changed` and serves the relay's list from then on.
- **Failures:** a relay that exits (or refuses the replayed `initialize`) answers every in-flight and queued request with a JSON-RPC error (`-32000`, *the plain-flags relay exited (code N)*); the next request starts it again, **at most once per 30 s** (inside that window the request gets an error saying when to retry). A relay that does not answer the replayed `initialize` in **30 s** has its process group SIGKILLed and counts as a failure.
- **Exit:** on stdin EOF, SIGTERM, SIGHUP or SIGINT the stub closes the relay's stdin and SIGTERMs it (the relay's own shutdown closes its Brave), waits up to 10 s, then SIGKILLs the relay's process group and exits. If the stub itself is SIGKILLed, the relay sees its stdin close and shuts down on its own.
- **stderr** (`[plainflags-stub] …`) carries method names, integer ids, sizes and the relay's lifecycle — never a message body (tool arguments can hold typed text).

**Registration (covered by the same GO; not applied by this build):** replace the two local-scope `browser-mcp-relay-plainflags` entries with **one user-scope** entry — no `env` needed, the stub forces the mode:

```json
"browser-mcp-relay-plainflags": {
  "type": "stdio",
  "command": "/usr/bin/python3",
  "args": ["/Users/trevor/Documents/browser-mcp-relay/plainflags-stub.py"]
}
```

**RAM** (measured 2026-11-03, `ps -o rss` and `vmmap --summary`, the real `HOME`; a temp `HOME` alone doubles Python's start-up RSS, so measure with the real one): the stub idles at **~11 MB RSS** (10.9–11.5 MB; 7.4–8.1 MB physical footprint), of which a bare `/usr/bin/python3` with the same imports is ~9 MB. An idle relay is ~55 MB, so ~42 sessions go from ~2.3 GB to ~0.5 GB (arithmetic). A session that calls a plain-flags tool pays the relay (and Brave) from then on, as before. **First call:** 0.3–0.5 s from the request to the relay's answer for `relay_status` (relay start through the stub, no Brave) and 2.1–3.2 s for a first `navigation_go-to` (Brave launch included), 3 runs in the isolated harness with its headless test Brave.

**The file and its drift test:** `plainflags-tools.json` is generated — `node scripts/gen-plainflags-tools.js` starts the real relay in plain-flags mode under a temp `HOME` (the harness's own isolation and self-check, so run it from a copy, like the harness; no Brave starts) and writes its `initialize` answer (less the negotiated version), the SDK's supported versions and its `tools/list` answer; `--check` only compares. Upstream puts the relay's `os.tmpdir()` into two schema defaults; the file holds the token `${os.tmpdir()}` there and the stub puts back the session's own value, computed as Node does. `test/plainflags-stub-drift.test.js` (harness) fails when the committed file differs from the live relay, so a relay or upstream change cannot leave the stub stale; regenerate and commit. The stub's own tests (`test/plainflags-stub.test.js`) use a fake relay that the stub starts only from the system temp dir (`PLAINFLAGS_STUB_TEST_CHILD`, refused anywhere else), plus one end-to-end case through the real relay and a real test Brave.

### The CF-WALL log

One shared, append-only file for every lane — the cross-lane count that gates spec phase 2: `~/ObsidianVault/[AGENCY] Automated Scaling/Claude Important/04 - Recon/2026-10-29 Cloudflare Relay Challenge Recon/00 - Summary/CF-WALL Log.md` (override: `BROWSER_RELAY_CF_WALL_LOG`). Created with the skill's frontmatter if missing (written to a temp file and linked into place, so it never appears without its header; a failed write leaves no temp file); lines are only ever appended. A log path that is a **symlink to a missing file is refused** (`logged: false`) rather than created through. Values read from curl, dig and the page are bounded (20 headers of ≤200 chars, 20 DNS answers, hosts ≤253 chars). The route field of a detection line says what was seen and where it goes next:

```
YYYY-MM-DDTHH:MM:SSZ | <lane> | <host> | <owner> | <route taken>
2026-10-30T17:00:00Z | CRO-33 | go.example.com | highlevel | detected turnstile; next in-page-turnstile
2026-10-30T17:01:30Z | CRO-33 | ala-b2b.scale-265.workers.dev | access | detected access-login; next §3.3
2026-10-30T17:02:10Z | CRO-33 | www.example.com | vendor | plainflags: failed → handoff; cfCookies=none; clicks=0
```

**When `challenge_detect` logged, its result's `log.note` reads exactly *"This is the wall's CF-WALL line — do not append another. A subagent: tell your parent it is already written."*** — that line is the wall's line; do not also append one by hand. A repeat detection of the same lane + host + owner within 60 s appends nothing and returns `logged: false, duplicateOf: <timestamp>` (per relay process). Only when the result says `logged: false` (no wall detected, or the file could not be written — no vault on this machine) does a session write the line itself, per the skill. Host only — no path, no query. On an Access login page the host is the **protected app's**, taken from the login URL (`<team>.cloudflareaccess.com/cdn-cgi/access/login/<app host>`); when the URL does not name it, the line carries the Access host itself.

---

## Stealth model

**Retracted 2026-10-30 — `stealth_apply` is deleted** (spec v8 §5.3, decision D3, ruled by the user 2026-10-30: *"Delete it (Recommended)"*). Until then this section described an opt-in tool that injected JavaScript patches into every page (a `navigator.webdriver` getter, fake `navigator.plugins`, a `languages` override, a permissions fix, a synthesized `navigator.userAgentData`, `toString` disguises, AudioContext jitter, `window.chrome` stubs, 17 permission overrides and a WebGL vendor/renderer spoof) and claimed it covered *"the bottom ~85% of common fingerprint surface"*, verified only by source-pattern tests.

Why it went: its patches **contradicted the real browser** — 3 fake plugins where the relay's Brave reports 7 (**measured**, Cloudflare relay recon research A §2) and a WebGL renderer spoofed as "Apple M1" on an "Apple M1 Max" machine (**code**); a spoof that disagrees with the real value is itself a tell. Its `webdriver` hide was a JS getter that needed its own `toString` disguise, while the measured cause of Cloudflare walls here is the launch itself (`navigator.webdriver === true` from Playwright's `--enable-automation` plus `--remote-debugging-port=0`) and CDP attachment — spec §1. The one recorded "pass" with it (a Shopify checkbox) is confounded: the same lane saw the relay pass Shopify's managed challenge with no stealth on the next GET. It also broke `matchMedia` in a test. The code stays in git history (`git show e41224c:src/own-tools/stealth-apply.js`).

What remains: `emulate_device` is unchanged — its HTTP-side `Sec-CH-UA-*` via a synthesized `userAgentMetadata` (BACKLOG T2-A) lives there. For a Cloudflare wall, see [Cloudflare walls](#cloudflare-walls); the separate plain-flags profile that clears `webdriver` at launch (no JS patch) is spec §5.6 — built 2026-10-30 after its measurement passed (D22): [The plain-flags relay](#the-plain-flags-relay-browser-mcp-relay-plainflags).

### What it does NOT cover

The relay is honest about these limits — pretending otherwise misleads callers planning around what they think they have.

| Limit | Why | Workaround |
|---|---|---|
| **TLS / HTTP/2 fingerprint (JA3 / JA4)** | Server-side detection runs before any JS executes. Playwright's chromium has a recognizable TLS handshake. | Route through a TLS-mimicking proxy (`BROWSER_RELAY_PROXY_URL` + a tool like `tlspoof` or a real-Brave-attach pattern). |
| **`Function.prototype.toString` deep checks** | Sophisticated detectors examine the toString chain itself. ~~Tier 1's getter-level toString defense doesn't reach this.~~ (Tier 1 was `stealth_apply`, deleted 2026-10-30 — the relay now patches no JS at all, so there is nothing for this check to find.) | Tier 3 (deferred — see BACKLOG): rebrowser-patches at the chromium-binary level. |
| **`event.isTrusted` detection (press-and-hold, CAPTCHAs)** | ~~Synthetic events from CDP fundamentally have `isTrusted=false`. This is by browser design — there's no JS-level fix.~~ **Retracted 2026-10-30 — wrong for CDP input:** a CDP `Input.dispatchMouseEvent` click arrives with **`isTrusted=true`**, measured in plain Brave 156 and in the relay (Cloudflare relay recon, research A §2, "CDP click" column, 2026-10-29: move/press/release on a local probe page). Only events dispatched from page JS (`dispatchEvent`) are untrusted. `isTrusted` is not why challenges fail here — the relay's `navigator.webdriver === true` and CDP attachment are the measured tells (vault spec *Browser Work Behind Cloudflare — Spec v8* §1, §5.5). Whether a CDP click reaches the cross-origin Turnstile iframe as trusted is still unmeasured. | Don't try to auto-solve press-and-hold CAPTCHAs or click-loop a Cloudflare widget; for Cloudflare walls follow the `cf-challenge` skill (API first, then a one-click human step in the user's own browser). |
| **Behavioral fingerprinting** (mouse paths, typing rhythm, dwell time) | Uniform Bezier-zero clicks + uniform 0ms typing are non-human. | ~~Tier 2.5 (deferred — see BACKLOG): `humanlike_click` + `humanlike_type` tools.~~ **Not to be built** — spec v8 D26 recommends against (its ship gate is unmet, a plain-flags try clicks at most once, and CDP clicks are already `isTrusted=true`); open, see BACKLOG Tier 2.5. |

### Hard targets

For sites with sophisticated detection (Akamai, DataDome, advanced PerimeterX deployments), ~~`stealth_apply` is **insufficient** — it's a starting point, not a finish line.~~ (`stealth_apply` was deleted 2026-10-30 — see [Stealth model](#stealth-model); for Cloudflare walls, [Cloudflare walls](#cloudflare-walls).) What has been considered for hard targets:

- **Real-Brave-attach** (Tier 3, deferred — see BACKLOG): connect to a Brave instance the user is already running interactively, never spawn one. Eliminates the entire "Playwright launched it" fingerprint surface. Already used in the maintainer's Walmart sidecar.
- ~~**Residential proxies** (Bright Data, IPRoyal): TLS handshake from a residential IP gets a much higher trust score than data-center IPs. Set `BROWSER_RELAY_PROXY_URL`.~~ **Not pursued for this agency** (2026-10-30, spec v8 D28 — recommended exclude, open; ask the user before any): no use case — the walls met here are browser- and rate-based, which an exit IP does not change — and the proxy setting turns off TLS validation (below).
  > ⚠️ **Read the proxy-whitelist security note above before doing this.** Setting that variable also turns OFF TLS cert validation, so a third-party proxy can transparently MITM every authenticated session the relay drives. These two recommendations sit ~60 lines apart and directly contradict each other: the note says never point it at a proxy you don't control, and this line recommends exactly that. Treat third-party proxying as an explicit decision, not a config tweak.
  > Also note (measured 2026-08-25): a Cloudflare challenge that renders *"Verification successful"* is **not** a TLS/JA3 rejection — JA3 is evaluated before any JS runs. Confirm the block is actually TLS-layer before reaching for a proxy at all.
- **Warm session reuse** (`cookies_export` / `cookies_import` + the credential vault): a session with N days of authentic browsing history scores higher than a fresh login.

For the full deferred-work catalog (Tiers 2/3 + anti-patterns NOT to implement), see [`BACKLOG.md`](./BACKLOG.md).

---

## Inspector

A small web dashboard for peeking at the relay's runtime state — pool slot status (claimed / idle / orphan), cookie-source freshness, vault entry counts, tool counts, uptime, plus a per-slot **Inspector page** with live MCP-traffic streaming. **Off by default**, no auth, read-only.

![Inspector — Pool overview](./screenshots/01-pool-overview.png)

### Two modes

#### Standalone (no live traffic)

Start the Inspector separately. It still serves Pool / Tools / Activity / Settings / per-slot pages, but the **Activity feed on `/slot/N` will be empty** — there's no relay process to subscribe to.

```bash
npm run inspector
# Inspector running at http://127.0.0.1:9090
```

#### In-process (full live traffic)

Set `BROWSER_RELAY_INSPECTOR_PORT` in your MCP-client config (e.g. `~/.claude.json`) so the relay boots the Inspector inline. The Inspector then subscribes to the relay's traffic emitter and streams every `tools/call` request + response over a WebSocket to connected Inspector tabs.

```jsonc
// ~/.claude.json (excerpt)
{
  "mcpServers": {
    "browser-mcp-relay": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/src/index.js"],
      "env": {
        "BROWSER_RELAY_INSPECTOR_PORT": "9091"
      }
    }
  }
}
```

After the next MCP connect, open `http://localhost:9091/slot/1` to see the per-slot Inspector page. The Activity feed populates in real time as your AI client makes tool calls.

### Pages

| | |
|---|---|
| **Pool overview** (`/`) — slot grid (claimed / idle / orphan), cookie-source freshness card, vault summary. Orphan slots get a **Reap** button that clears the stale lock + kills any leftover Brave processes holding that user-data-dir. | ![Pool overview](./screenshots/01-pool-overview.png) |
| **Slot detail** (`/slot/N`) — per-slot live activity feed (request → response cards, last 100), click any event to see request JSON + response + timing in the Detail card. Empty in standalone mode; live in in-process mode. | ![Slot detail](./screenshots/02-slot-detail.png) |
| **Tools catalog** (`/tools`) — all 71 tools (20 first-party + 51 forwarded), filter + per-tool detail | ![Tools catalog](./screenshots/03-tools-catalog.png) |
| **Activity history** (`/activity`) — cross-slot ring buffer of the last ~200 MCP tool calls, with filter pills (All / Requests / Responses / Errors) and time-range picker (5m / 1h / 24h). Empty in standalone mode. | ![Activity history](./screenshots/04-activity-history.png) |
| **Settings** (`/settings`) — resolved config, env-var booleans, paste-ready `local-config.json` snippet | ![Settings](./screenshots/06-settings.png) |

The only mutating endpoint (`POST /api/slots/N/reap`) requires a same-origin Origin header (or no Origin — the curl path); cross-origin POSTs are rejected with 403.

> ⚠️ **Security:** The inspector binds to **`127.0.0.1` only by default** and has **no authentication**. Only the local user can reach it. Anyone with shell access to your machine — or any process running locally — can read pool state, vault file paths, and tool counts. The WebSocket streams every `tools/call` request + response; in-process mode means *anyone with localhost access can see what your AI is doing in real time*. **Treat the inspector port as if it had your bearer tokens on it** — `tools/call` arguments routinely contain auth tokens, URLs of authed sessions, the cookies your AI is sending, etc. Don't expose it via SSH tunnels, ngrok, or `BROWSER_RELAY_INSPECTOR_BIND=0.0.0.0` unless you know what you're doing. **Kill the server when you're done** (Ctrl+C). Defenses in place: localhost-only bind, Origin allowlist on the WS upgrade and on every mutating POST, `X-Frame-Options: DENY` + `frame-ancestors 'none'` (clickjacking gate), `Cache-Control: no-store` on every API response, path-traversal hard stop, 64 KB WS frame cap + 1 MB back-pressure cap.

---

## Platform support

| Platform | Status | Notes |
|---|---|---|
| 🪟 **Windows** | ✅ First-class | Tested daily. PowerShell + registry probes for Brave detection (HKLM + HKCU, all 4 channels). |
| 🍎 **macOS** | 🟡 Best-effort | Code paths are written portably (`process-shim.js`, `detect-browser.js`) but not yet maintainer-verified. Bug reports welcome. |
| 🐧 **Linux** | 🟡 Best-effort | Honors `XDG_CONFIG_HOME` for Brave profile detection + `XDG_CACHE_HOME` for the standalone-mode fallback dir. POSIX `kill -0` for liveness. Not yet maintainer-verified end-to-end. |

---

## Troubleshooting

### "Brave not found"

Auto-detect couldn't find Brave at any of the standard locations. Either:

- Install Brave from [brave.com](https://brave.com/), OR
- Set `BROWSER_RELAY_BRAVE_PATH=/absolute/path/to/brave` and re-run `npm run setup`

### "Cannot find module 'browser-devtools-mcp'"

The upstream MCP isn't installed. Run:

```bash
npm install
```

…or, if you want a custom upstream build, set `BROWSER_RELAY_UPSTREAM_PATH=/absolute/path/to/dist/index.js` and re-run setup.

### `o11y_get-http-requests` rejects responses with "ping" / "prefetch" resourceType

**Fixed in v0.3.6.** Upstream `browser-devtools-mcp`'s bundled `HttpResourceType` enum is missing `ping` / `prefetch` / `signedexchange` / `cspviolationreport` / `preflight` / `fedcm`. Playwright's `request.resourceType()` does return those (Amazon affiliate links fire `<a ping="...">` beacons → `resourceType="ping"` → upstream's zod schema rejects). The relay now patches the upstream bundle file at startup via `scripts/patch-bdmcp-bundle.js` (idempotent, on-disk, survives ESM/CJS module systems). Look for a stderr line `[mcp-relay] patched browser-devtools-mcp HttpResourceType enum...` on first relay startup after `npm install`. Filed as F1-20 — see `docs/BACKLOG.md` for the upstream-issue tracking.

### `o11y_get-http-requests` items have no request `body`

**By design (register A76, 2026-10-30).** Upstream returned every request's POST body with no flag, so a login typed in a relay tab (email and password in the form body) reached the transcript of the next session that read HTTP requests — directly, or through `execute` / `scenario-run`, whose `callTool(…, true)` returns the inner tool's raw output. Two layers:

1. **At the source:** `scripts/patch-bdmcp-request-body.js` patches the upstream bundle the relay actually spawns (`BROWSER_RELAY_UPSTREAM_PATH` included) before every upstream spawn, so `_toHttpRequest` never captures `postData()`. It is idempotent, writes atomically, and is a no-op if upstream's bundle shape changes. **Fail closed:** if the patch is not in effect for the upstream child currently running, the relay logs `WARNING A76 request-body patch NOT applied` and refuses `execute` and `scenario-run` (a script could return captured bodies); the status is re-read on every call, after any upstream respawn, so it clears at the next spawn where the patch applies. `test/patch-bdmcp-request-body.test.js` fails against the live bundle if the pattern breaks or a new `postData*()` call appears — re-check after any upstream upgrade.
2. **On the direct call:** `src/request-body-filter.js` strips `body` from each `o11y_get-http-requests` item, in both `structuredContent` and the JSON text block, before the result or the Inspector traffic feed sees it. A text block it cannot parse, or any non-text item, is replaced with a "withheld" notice.

Not covered (accepted, Trevor 2026-10-30, ask as-ops/ask-7hghph): a script in `execute` / `scenario-run` gets Playwright's `page`, so it can still read request bodies through Playwright itself (`page.requests()` keeps the last 100, each with `postData()`; or its own `page.on('request')` listener) and can read form fields directly — arbitrary scripts cannot be fenced completely (`page.context().pages()` escapes any wrapper). Also not covered: request headers when you pass `includeRequestHeaders`, response bodies (`includeResponseBody`, `capture_xhr`), and query strings in URLs.

### Smoke test fails: "tool count too low"

The relay started but returned fewer than 60 tools. Check the relay's stderr output for upstream-spawn errors, or the smoke script's stderr tail.

### "Tools appear in `tools/list` but `tools/call` hangs"

Brave didn't launch successfully. Common causes:

- **Another Brave instance is holding the user-data-dir lock** (orphan from a previous session). Since v0.3.2, the relay reaps these automatically before launch. If you're on an older version, check for `brave.exe` processes pinned to your relay's user-data-dir and `taskkill /F /T /PID <them>`.
- Missing display server (Linux headless without xvfb) — try `BROWSER_HEADLESS_ENABLE=true`.
- Insufficient permissions.

### Cursor or Claude Code hangs on close + reopen

Most cases: orphaned Brave from a previous session was squatting on a pool slot's user-data-dir. v0.3.2's `F1-16` pre-launch reap fixes this — the new relay reaps any squatter before launch. If you're seeing this on v0.3.2+, please file an issue with the output of:

```powershell
Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object {
  $_.CommandLine -match 'browser-data-mcp'
} | Select-Object ProcessId, ParentProcessId, CommandLine
```

### Multiple relays from one machine

Each relay process needs its own user-data-dir. Use pool mode (`BROWSER_RELAY_POOL_DIR=/path/to/dir`, different per process) or run each relay in its own checkout.

---

## Diagnostic recipes

Drop-in PowerShell snippets for poking around when something feels off. All of these are **read-only** — they observe state without modifying anything. None require the Inspector to be running.

### Find orphan Brave subtrees pinned to a relay pool dir

The classic "Cursor restart hangs" symptom. Run this in PowerShell BEFORE reopening Cursor — anything returned is an orphan that the next relay's pre-launch reap (F1-16) should clean up automatically on v0.3.2+. Older relays will hang on launch.

```powershell
Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object {
  $_.CommandLine -match 'browser-data-mcp' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue)
} | Select-Object ProcessId, ParentProcessId, @{
  N='Dir'; E={ if($_.CommandLine -match '--user-data-dir=("?)([^"]+?)\1'){$Matches[2]} }
}
```

Empty output = no orphans. Anything else = list of `(PID, dead-parent-PID, dir)` triples. Manual cleanup if needed: `taskkill /F /T /PID <orphan-main-pid>`.

### Inventory all Brave processes by pool dir

When you want to see which slots are actually in use vs. just lock-claimed.

```powershell
Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | ForEach-Object {
  $dir = if ($_.CommandLine -match '--user-data-dir=("?)([^"]+?)\1') { $Matches[2] } else { '<unknown>' }
  $type = if ($_.CommandLine -match '--type=(\w+)') { $Matches[1] } else { 'main' }
  [PSCustomObject]@{ PID = $_.ProcessId; PPID = $_.ParentProcessId; Type = $type; Dir = $dir }
} | Group-Object Dir | Select-Object Name, Count | Sort-Object Name
```

### Show the live state of every pool slot lock

Which pool slots have valid locks vs. stale ones. The relay self-heals stale locks at next claim, but it's useful to see them yourself.

```powershell
1..16 | ForEach-Object {
  $lock = "$env:USERPROFILE\.browser-data-mcp-pool-$_\.mcp-wrapper-lock"
  if (Test-Path $lock) {
    $meta = Get-Content $lock | ConvertFrom-Json
    $alive = $null -ne (Get-Process -Id $meta.pid -ErrorAction SilentlyContinue)
    [PSCustomObject]@{ Slot = $_; PID = $meta.pid; Alive = $alive; Held = $meta.startedAt }
  }
} | Format-Table -AutoSize
```

### Check whether a relay is actually responding

If `tools/call` is hanging, this confirms whether the relay's CDP endpoint is reachable. Replace the port with the relay's CDP port: `cdpPort` in `<profile>/.mcp-relay-status.json` (or line 1 of `<profile>/DevToolsActivePort`). Relays from before the port-0 change used `9333 + slot - 1`.

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:<port>/json/version" -UseBasicParsing | Select-Object StatusCode, @{
  N='Browser'; E={ ($_.Content | ConvertFrom-Json).Browser }
}
```

200 + a Brave version → CDP is healthy; relay is responsive. Connection refused → Brave isn't running. Hangs → Brave is wedged (renderer crash, etc.) — `taskkill /F /T /PID <main-brave-pid>` and restart Cursor.

### Confirm which Cursor MCP is which

When you see 12+ MCP-related node processes alive simultaneously and want to distinguish "your relay" from "Cursor's bundled extension":

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -match 'browser-mcp-relay|browser-devtools-mcp'
} | Select-Object ProcessId, ParentProcessId, @{
  N='Identity'; E={
    if ($_.CommandLine -match 'browser-mcp-relay') { 'YOUR relay' }
    elseif ($_.CommandLine -match 'cursor-mcp-server') { 'Cursor bundled' }
    else { '<unknown>' }
  }
} | Format-Table -AutoSize
```

### Tail the relay's stderr from the inspector log file

The relay writes diagnostic stderr lines (autofill events, CDP errors, shutdown traces). Cursor swallows them; the inspector's in-process mode captures them in memory but doesn't persist them. For long-running diagnosis, redirect the relay's stderr to a file by tweaking your MCP-client config:

```jsonc
// ~/.claude.json (excerpt) — adds stderr file capture
{
  "mcpServers": {
    "browser-mcp-relay": {
      "command": "node",
      "args": ["<absolute-path>/src/index.js"],
      "stderr": "<absolute-path>/relay-stderr.log"
    }
  }
}
```

Then `Get-Content $env:USERPROFILE/.claude/scripts/browser-mcp-relay/relay-stderr.log -Tail 50 -Wait` to follow it live.

---

## Limitations

- 📜 Upstream `browser-devtools-mcp` is licensed **Elastic-2.0** — permissive but **not OSI-approved-open-source**. See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) for the full breakdown.
- 🦁 Requires **Brave** installed locally. Other Chromium browsers may work via `BROWSER_RELAY_BRAVE_PATH` but are untested.
- 🍪 **Standalone mode does not snapshot cookies** from another profile — first run hits login walls. Cookie snapshot is a pool-mode feature.
- 🧍 **One Brave per relay process.** To run multiple Brave sessions in parallel, run multiple relays (each on its own slot / profile dir).
- 🔐 **3 low-severity transitive `cookie<0.7.0` advisories** via `lighthouse → @sentry/node`. Fix requires `lighthouse@13`, which is a breaking dep upgrade for our `^11.0.0` pin. Tracked; not exploitable in practice for a localhost-bound dev tool. Run `npm audit` to see them; `npm audit fix --force` would resolve at the cost of a major-version upgrade.
