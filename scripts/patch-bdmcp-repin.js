// scripts/patch-bdmcp-repin.js — re-pin upstream to the relay's tab
// (2026-11-17, ask as-ops/ask-5ojuum rev 3: "Re-pin upstream to relay tab").
//
// Upstream browser-devtools-mcp runs every tool against ONE Playwright page,
// BrowserToolSessionContext._page, made by its first tool call and never
// switched. The relay used to keep it in step by NAVIGATING that page to the
// relay's URL, which loaded every session's first URL in two tabs and could
// navigate a working page away. This patch lets the relay MOVE upstream's pin
// to the relay's own tab instead, by CDP target id, so both act on one tab.
//
// Channel: upstream's `execute` sandbox. BrowserToolSessionContext.
// executionContext() returns what `execute` code sees ({page}); the patch adds
// __relayPin(targetId), which calls __relayPinPage(session, targetId). The
// relay calls it as `execute` with `return await __relayPin("<id>")`, exactly
// as it already reads upstream's URL (_upstream-sync.js). No new MCP tool, so
// nothing is added to the tools/list the model sees. (A hidden tool would need
// registering in upstream's tool list AND filtering out of the relay's.)
// Model code in `execute` can call __relayPin too; it gives nothing `execute`
// does not already have (page.context().pages() reaches every tab).
//
// State tied to _page, measured in the 0.6.12 dist, and what a re-pin does:
//   _page                      → the target page
//   page listeners (console, pageerror, request, requestfinished,
//     requestfailed → consoleMessages / httpRequests / in-flight count)
//                              → attached once per page (WeakSet); each
//                                handler records only while its page is the
//                                pinned one, so capture follows the pin and
//                                earlier entries stay in the buffers
//   _numOfInFlightRequests, _lastNetworkActivityTimestamp → reset (as
//                                ensureSessionPageOpen does on a new page)
//   _refMap (ARIA snapshot refs) → reset (refs name the old page's elements)
//   _screenRecorder            → stopped if recording (as ensureSessionPageOpen does)
//   debug_* store (V8Api bound to the page it was first enabled on, keyed by
//     browserContext)          → NOT moved: probes stay on that page (as they
//                                already did after upstream re-created its page)
//   stub_* routes, OTEL        → browserContext-wide: unaffected
//   close() in CDP-attach mode closes this.page → patched to skip a page the
//                                session adopted (never close the relay's or
//                                a user's tab); stdio mode never calls it
// The session's OWN page (made by its first call or by ensureSessionPageOpen)
// is closed when a re-pin leaves it while it is still about:blank: it is the
// transient tab upstream opens when it starts, never one anybody used.
//
// Same rules as the other patch scripts: on-disk, applied at every relay
// startup before upstream spawns, idempotent, atomic, all-or-nothing (every
// site or none), a no-op with a loud stderr line if the bundle shape changes.
// test/patch-bdmcp-repin.test.js checks the live bundle shape, so an upgrade
// that breaks a pattern fails `npm test`.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HELPER_VERSION = 1;
const MARKER = `/*R1: upstream re-pinned to the relay's tab v${HELPER_VERSION}*/`;
const MARKER_RE = /\/\*R1: upstream re-pinned to the relay's tab(?: v(\d+))?\*\//;
const HELPER_NAME = "__relayPinPage";
const SANDBOX_NAME = "__relayPin";

// [pattern, replacement] — each must match EXACTLY once.
const SITES = [
  ["executionContext(){return{page:this.page}}",
    `executionContext(){return{page:this.page,${SANDBOX_NAME}:(targetId)=>${HELPER_NAME}(this,targetId)}}`],
  ["_attachPageListeners(page){let me=this;",
    "_attachPageListeners(page){let me=this;if((me.__relayListened||=new WeakSet).has(page))return;me.__relayListened.add(page);"],
  ['page.on("console",msg=>{', 'page.on("console",msg=>{if(me._page!==page)return;'],
  ['page.on("pageerror",err=>{', 'page.on("pageerror",err=>{if(me._page!==page)return;'],
  ['page.on("request",async req=>{', 'page.on("request",async req=>{if(me._page!==page)return;'],
  ['page.on("requestfinished",async req=>{', 'page.on("requestfinished",async req=>{if(me._page!==page)return;'],
  ['page.on("requestfailed",async req=>{', 'page.on("requestfailed",async req=>{if(me._page!==page)return;'],
  ["await this.page.close({runBeforeUnload:!1}).catch(()=>{})",
    "await(this.__relayAdopted&&this.__relayAdopted.has(this.page)?Promise.resolve():this.page.close({runBeforeUnload:!1}).catch(()=>{}))"],
];

// Plain ES2020, a top-level function declaration (upstream's ESM bundle).
const HELPER_SOURCE = `async function ${HELPER_NAME}(ctx,targetId,timeoutMs=5000){` +
  `if(typeof targetId!=="string"||!targetId)throw new Error("__relayPin: a CDP target id is required");` +
  `if(ctx.closed)throw new Error("__relayPin: the session is closed");` +
  `if(ctx._ensurePagePromise)await ctx._ensurePagePromise.catch(()=>{});` +
  `let bc=ctx.browserContext,ids=(ctx.__relayIds||=new WeakMap),found=null,deadline=Date.now()+timeoutMs;` +
  `for(;;){` +
    `for(let p of bc.pages()){` +
      `if(p.isClosed())continue;` +
      `let id=ids.get(p);` +
      `if(id===undefined){let s=null;try{s=await bc.newCDPSession(p);id=(await s.send("Target.getTargetInfo")).targetInfo.targetId;ids.set(p,id)}catch{}finally{if(s)s.detach().catch(()=>{})}}` +
      `if(id===targetId){found=p;break}` +
    `}` +
    `if(found||Date.now()>=deadline)break;` +
    `await new Promise(r=>setTimeout(r,50))` +
  `}` +
  "if(!found)throw new Error(`__relayPin: no page for target ${targetId} in upstream's browser context`);" +
  `let old=ctx._page,closedOwnBlank=!1,adopted=(ctx.__relayAdopted||=new WeakSet);` +
  `adopted.add(found);` +
  `if(old!==found){` +
    `try{if(ctx._screenRecorder&&ctx._screenRecorder.isRecording())await ctx._screenRecorder.stop()}catch{}` +
    `ctx._refMap={};ctx._numOfInFlightRequests=0;ctx._lastNetworkActivityTimestamp=0;` +
    `ctx._page=found;ctx._attachPageListeners(found);` +
    `if(old&&!old.isClosed()&&!adopted.has(old)&&old.url()==="about:blank"){await old.close({runBeforeUnload:!1}).catch(()=>{});closedOwnBlank=!0}` +
  `}` +
  `return{targetId,url:found.url(),changed:old!==found,closedOwnBlank}` +
`}`;

function countOf(content, needle) {
  let n = 0;
  for (let i = content.indexOf(needle); i !== -1; i = content.indexOf(needle, i + needle.length)) n++;
  return n;
}

function patchSource(content) {
  if (typeof content !== "string") return null;
  if (MARKER_RE.test(content)) return null;
  for (const [from] of SITES) if (countOf(content, from) !== 1) return null;
  let out = content;
  for (const [from, to] of SITES) out = out.replace(from, () => to);
  // At the TOP: patch-bdmcp-quiet-page.js replaces everything after ITS marker
  // (at the end of the file) when it updates its helper.
  return `${MARKER}\n${HELPER_SOURCE}\n${out}`;
}

function findSessionFile(opts = {}) {
  const distDir = opts.distDir || path.resolve(require.resolve("browser-devtools-mcp/dist/index.js"), "..");
  let entries;
  try { entries = fs.readdirSync(distDir); } catch { return null; }
  for (const fname of entries) {
    if (!/^core-[A-Za-z0-9]+\.js$/.test(fname)) continue;
    const full = path.join(distDir, fname);
    let content;
    try { content = fs.readFileSync(full, "utf8"); } catch { continue; }
    if (content.includes("createToolSessionContext")) return full;
  }
  return null;
}

/**
 * Returns { patched: true, file, action: "applied" | "updated" | "already" | "newer" } or
 * { patched: false, reason } (safe no-op; the caller logs it loudly).
 */
function applyPatch(opts = {}) {
  const log = opts.log || ((msg) => { try { process.stderr.write(msg); } catch {} });
  const file = findSessionFile(opts);
  if (!file) return { patched: false, reason: "no upstream core-*.js with createToolSessionContext found" };
  let content;
  try { content = fs.readFileSync(file, "utf8"); }
  catch (e) { return { patched: false, reason: `read failed: ${e.message}` }; }
  let out;
  let action = "applied";
  const found = MARKER_RE.exec(content);
  if (found) {
    const version = found[1] ? Number(found[1]) : 1;
    if (version > HELPER_VERSION) return { patched: true, file, action: "newer", version };
    if (version === HELPER_VERSION) return { patched: true, file, action: "already" };
    // The helper is the one line after the marker.
    const afterMarker = found.index + found[0].length + 1;
    const lineEnd = content.indexOf("\n", afterMarker);
    if (content[afterMarker - 1] !== "\n" || lineEnd === -1) return { patched: false, reason: "re-pin marker found but its helper line is not" };
    out = `${content.slice(0, found.index)}${MARKER}\n${HELPER_SOURCE}${content.slice(lineEnd)}`;
    action = "updated";
  } else {
    out = patchSource(content);
    if (!out) return { patched: false, reason: "re-pin sites not found exactly once each (upstream bundler shape changed?)" };
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.r1-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, out, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { patched: false, reason: `write failed: ${e.message}` };
  }
  log(`[mcp-relay] patched browser-devtools-mcp at ${path.basename(file)}: upstream can be re-pinned to the relay's tab (R1${action === "updated" ? ", helper updated" : ""})\n`);
  return { patched: true, file, action };
}

module.exports = { HELPER_VERSION, MARKER, MARKER_RE, HELPER_NAME, SANDBOX_NAME, HELPER_SOURCE, SITES, patchSource, findSessionFile, applyPatch };

if (require.main === module) {
  const result = applyPatch();
  if (!result.patched) process.stderr.write(`[mcp-relay] patch-bdmcp-repin: ${result.reason}\n`);
  else if (result.action === "already") process.stderr.write(`[mcp-relay] patch-bdmcp-repin: already applied (${path.basename(result.file)})\n`);
  process.exit(0);
}
