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

#### 🍪 Session & cookies

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `cookies_export` | Export cookies as JSON | `urls` (filter) | Save an authed session for later |
| `cookies_import` | Import cookies into the context | `cookies` | Restore an authed session |
| `stealth_apply` | Anti-detection patches (Tier 1) | `languages` | Defeat trivial bot checks + the bottom 70% of fingerprint surface |

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
| `BROWSER_RELAY_IDLE_MINUTES` | `45` | Minutes of MCP inactivity before the relay reaps Brave + the upstream child to reclaim RAM; `0` disables. **Idleness is measured in MCP tool calls plus one browser-activity signal:** before reaping, the relay runs `lsof -nP -w -iTCP@127.0.0.1:<cdpPort> -sTCP:ESTABLISHED -F pn` (3 s timeout), and an ESTABLISHED **client** connection to the Brave's CDP port (a socket whose remote end is `127.0.0.1:<cdpPort>`) from any process other than the relay or its upstream child — a script driving the browser over CDP — resets the idle clock and skips the reap. Brave's own sockets are the server ends of those connections, so the client-only test is what leaves them out. On macOS `/usr/sbin/lsof` is used when present, so a trimmed `PATH` does not disable the check. Only a connection open at that moment is seen; a script that connects and exits between checks is not. If `lsof` is missing, fails or times out, that check falls back to MCP-only idleness and reaps (logged once per relay). **Keep-alive file:** checked first (one `lstat`, before any `lsof`): `<claimed profile dir>/.mcp-relay-keepalive` (the base profile or this session's clone — the dir holding `.mcp-relay-status.json`). While it is a **regular file** (a symlink, directory or anything else is ignored) whose mtime is less than one idle window old, the reaper treats it as activity. A helper that drives the Brave outside MCP should `touch` it each time it uses the browser; protection ends one idle window after the last touch, so it can never hold a Brave forever (an mtime more than 5 s in the future is ignored). **Reap log:** every hold and reap appends one JSON line to `<cache root>/reap-events.log` (`~/Library/Caches/browser-mcp-relay/reap-events.log` on macOS; mode 0600; rotated to `reap-events.log.1` past ~1 MB, one kept): `{ts, slug, pid, event, idleS}` with `event` one of `held` (plus `heldBy: [{pid, command}]`, written once per hold and again when the holder pid set changes), `keepalive` (plus `keepaliveAgeS`), `lsof-failed` (plus `reason`) and `reaped`. While a CDP hold lasts, the status sidecar carries `reapHeldBy: {pids, since}` (null otherwise) on its normal write. A log write failure never affects reaping. A human clicking through a login by hand opens no CDP connection, so the clock still runs and their browser can be closed mid-flow. Do not lower this without a broader browser-activity signal. |
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

## Stealth model

`stealth_apply` is an opt-in tool that injects anti-detection JavaScript patches into every page load in the active context. **Off by default** — call the tool once per session to enable. The relay's intent is to be honest about what stealth covers and where the limits are, since pretending to defeat detection you don't is worse than not trying.

### Tier 1+2 — what's covered (v0.3.5)

**Tier 1** (v0.3.4):

| Patch | What it defeats |
|---|---|
| `navigator.webdriver = undefined` | Trivial `if (navigator.webdriver)` checks |
| `navigator.plugins` faked | Bot detection that flags empty plugins arrays |
| `navigator.languages` override | Mismatched-language flagging |
| `navigator.permissions.query` notifications fix | The `Notification.permission === 'denied'` headless tell |
| `navigator.userAgentData` synthesized from current UA | Sec-CH-UA-* JS-side fingerprinting; tracks `emulate_device`'s UA override |
| `toString()` defense on patched getters | `Object.getOwnPropertyDescriptor(navigator, 'webdriver').get.toString()` returns native-looking output |
| AudioContext `getChannelData` stabilization | Audio-fingerprint hash detection on PerimeterX et al.; per-session deterministic jitter (≤ 1e-7), not random per-call |

**Tier 2** (v0.3.5 — added 2026-05-10):

| Patch | What it defeats |
|---|---|
| **HTTP-side `Sec-CH-UA-*` headers via `userAgentMetadata`** | The Tier-1 JS-side `userAgentData` paired with HTTP-side `Sec-CH-UA-*` mismatch detection. `emulate_device` now passes a synthesized `userAgentMetadata` to CDP's `Network.setUserAgentOverride`. |
| **`window.chrome` runtime expansion** | Probes for `chrome.loadTimes()` / `chrome.csi()` / `chrome.app` namespace. Real Chrome ships all three; Tier 1's bare `runtime: {}` was a tell. Now populates plausible-shape stubs. |
| **Full permissions overrides** | Probes for `geolocation` / `clipboard-read` / `clipboard-write` / `camera` / `microphone` / `midi` / `push` / etc. Tier 1 only covered notifications; Tier 2 extends to the canonical 17 permission types with realistic states. |
| **WebGL renderer + vendor override** | `getParameter(UNMASKED_VENDOR_WEBGL)` / `getParameter(UNMASKED_RENDERER_WEBGL)` returning Playwright signature strings. UA-aware GPU strings on both `WebGLRenderingContext` and `WebGL2RenderingContext`. |

This covers trivial bot checks + the bottom ~85% of common fingerprint surface. **Verified by source-pattern tests** (`test/own-tools/stealth-apply.test.js` T1-A/B/C + T2-B/C/D, plus `test/own-tools/emulate-device.test.js` T2-A).

### What it does NOT cover

The relay is honest about these limits — pretending otherwise misleads callers planning around what they think they have.

| Limit | Why | Workaround |
|---|---|---|
| **TLS / HTTP/2 fingerprint (JA3 / JA4)** | Server-side detection runs before any JS executes. Playwright's chromium has a recognizable TLS handshake. | Route through a TLS-mimicking proxy (`BROWSER_RELAY_PROXY_URL` + a tool like `tlspoof` or a real-Brave-attach pattern). |
| **`Function.prototype.toString` deep checks** | Sophisticated detectors examine the toString chain itself. Tier 1's getter-level toString defense doesn't reach this. | Tier 3 (deferred — see BACKLOG): rebrowser-patches at the chromium-binary level. |
| **`event.isTrusted` detection (press-and-hold, CAPTCHAs)** | Synthetic events from CDP fundamentally have `isTrusted=false`. This is by browser design — there's no JS-level fix. | Don't try to auto-solve press-and-hold CAPTCHAs; route the user through them manually. |
| **Behavioral fingerprinting** (mouse paths, typing rhythm, dwell time) | Uniform Bezier-zero clicks + uniform 0ms typing are non-human. | Tier 2.5 (deferred — see BACKLOG): `humanlike_click` + `humanlike_type` tools. Has an explicit ship gate (capture the detection signal first; design the humanizer to match the target's tolerance window). |

### Hard targets

For sites with sophisticated detection (Akamai, DataDome, advanced PerimeterX deployments), `stealth_apply` is **insufficient** — it's a starting point, not a finish line. Real wins for hard targets are:

- **Real-Brave-attach** (Tier 3, deferred — see BACKLOG): connect to a Brave instance the user is already running interactively, never spawn one. Eliminates the entire "Playwright launched it" fingerprint surface. Already used in the maintainer's Walmart sidecar.
- **Residential proxies** (Bright Data, IPRoyal): TLS handshake from a residential IP gets a much higher trust score than data-center IPs. Set `BROWSER_RELAY_PROXY_URL`.
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
