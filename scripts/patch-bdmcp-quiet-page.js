// scripts/patch-bdmcp-quiet-page.js — register A1 (2026-11-10).
//
// Patches upstream browser-devtools-mcp so the page it opens for its tool
// session never activates Brave. Upstream's first tool call runs
// createToolSessionContext → newPage(browserContext) → browserContext.newPage(),
// and BrowserToolSessionContext.ensureSessionPageOpen does
// `this.browserContext.newPage()` again whenever that page was closed.
// Playwright's newPage() sends CDP Target.createTarget WITHOUT background:true;
// Chromium then shows and activates a window, and macOS switches the user's
// display to the Desktop Space that window lives in (measured 2026-11-10 from
// the macOS logs: triggers were upstream `execute` and the relay's
// tabs_new → propagateActivePageToUpstream → navigation_go-to).
//
// Both call sites are routed through one helper appended to the bundle,
// __relayQuietNewPage, which does what src/own-tools/_quiet-focus.js
// newQuietPage does for the relay's own tabs: on macOS it opens the tab with
// CDP Target.createTarget {url: "about:blank", background: true} (no
// newWindow, same as the relay) over a browser-level CDP session, then returns
// the Playwright Page for that target. Anywhere else, or if that fails, it
// falls back to browserContext.newPage() (logged), exactly as the relay does.
//
// Same approach and safety rules as scripts/patch-bdmcp-request-body.js (A76):
// on-disk, applied at every relay startup before upstream spawns, idempotent,
// atomic, all-or-nothing (both call sites or neither), and a no-op with a
// loud stderr line if upstream's bundle shape changes.
// test/patch-bdmcp-quiet-page.test.js checks the live bundle, so an upgrade
// that breaks the pattern fails `npm test`.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// The helper's version. Bump it whenever HELPER_SOURCE changes: a bundle
// patched with a LOWER version gets the new helper; an equal or HIGHER one is
// left alone, so a relay still running an older copy of this script never
// writes the shared bundle back to its older helper. (The first build's
// marker had no version: it reads as v1.)
const HELPER_VERSION = 2;
const MARKER = `/*A1: session page opened in the background v${HELPER_VERSION}*/`;
const MARKER_RE = /\/\*A1: session page opened in the background(?: v(\d+))?\*\//;
const HELPER_NAME = "__relayQuietNewPage";

// createToolSessionContext's page: `async function newPage(browserContext,pageOptions={}){return await browserContext.newPage()}`
const MATCH_NEW_PAGE_FN = /async function newPage\((\w+),(\w+)=\{\}\)\{return await \1\.newPage\(\)\}/g;
// ensureSessionPageOpen's re-created page.
const MATCH_ENSURE_PAGE = /this\._page=await this\.browserContext\.newPage\(\)/g;

// Plain ES2020 so it runs in upstream's ESM bundle unchanged. A top-level
// function declaration, so both call sites see it wherever they are nested.
const HELPER_SOURCE = `async function ${HELPER_NAME}(browserContext,timeoutMs=10000){` +
  `let browser=null;try{browser=browserContext.browser()}catch{}` +
  `if(process.platform!=="darwin"||!browser||typeof browser.newBrowserCDPSession!=="function")return await browserContext.newPage();` +
  `let session=null,targetId=null;` +
  `let before=new Set(browserContext.pages()),checked=new Set();` +
  `try{` +
    `session=await browser.newBrowserCDPSession();` +
    `({targetId}=await session.send("Target.createTarget",{url:"about:blank",background:true}));` +
    `let deadline=Date.now()+timeoutMs;` +
    `while(Date.now()<deadline){` +
      `for(let p of browserContext.pages()){` +
        `if(before.has(p)||checked.has(p)||p.isClosed())continue;` +
        `let s=null;` +
        `try{s=await browserContext.newCDPSession(p);let r=await s.send("Target.getTargetInfo");checked.add(p);if(r&&r.targetInfo&&r.targetInfo.targetId===targetId)return p}` +
        `catch{}finally{if(s)s.detach().catch(()=>{})}` +
      `}` +
      `await new Promise(r=>setTimeout(r,50))` +
    `}` +
    "throw new Error(`no page for target ${targetId} within ${timeoutMs}ms`)" +
  `}catch(e){` +
    `if(targetId&&session)await session.send("Target.closeTarget",{targetId}).catch(()=>{});` +
    "try{process.stderr.write(`[bdmcp] background session page failed (${e&&e.message}); opening a normal tab\\n`)}catch{}" +
    `return await browserContext.newPage()` +
  `}finally{if(session)session.detach().catch(()=>{})}` +
`}`;

function patchSource(content) {
  if (typeof content !== "string") return null;
  if (MARKER_RE.test(content)) return null;
  const fnHits = content.match(MATCH_NEW_PAGE_FN);
  const ensureHits = content.match(MATCH_ENSURE_PAGE);
  if (!fnHits || fnHits.length !== 1 || !ensureHits || ensureHits.length !== 1) return null;
  const out = content
    .replace(MATCH_NEW_PAGE_FN, (_m, ctx, opts) => `async function newPage(${ctx},${opts}={}){return await ${HELPER_NAME}(${ctx})}`)
    .replace(MATCH_ENSURE_PAGE, `this._page=await ${HELPER_NAME}(this.browserContext)`);
  return `${out}\n${MARKER}\n${HELPER_SOURCE}\n`;
}

function findSessionFile(opts = {}) {
  const distDir = opts.distDir || path.resolve(
    require.resolve("browser-devtools-mcp/dist/index.js"),
    "..",
  );
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
    // Patched before. The helper is everything after the marker; the call
    // sites already point at it by name. Replace it only with a NEWER version.
    const version = found[1] ? Number(found[1]) : 1;
    if (version > HELPER_VERSION) return { patched: true, file, action: "newer", version };
    if (version === HELPER_VERSION) return { patched: true, file, action: "already" };
    out = `${content.slice(0, found.index)}${MARKER}\n${HELPER_SOURCE}\n`;
    action = "updated";
  } else {
    out = patchSource(content);
    if (!out) return { patched: false, reason: "session-page call sites not found exactly once each (upstream bundler shape changed?)" };
  }
  // Atomic: a relay starting at the same moment must never import a
  // half-written bundle (temp file in the same dir, then rename).
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.a1-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, out, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { patched: false, reason: `write failed: ${e.message}` };
  }
  log(`[mcp-relay] patched browser-devtools-mcp at ${path.basename(file)}: upstream's session page opens in the background (A1${action === "updated" ? ", helper updated" : ""})\n`);
  return { patched: true, file, action };
}

module.exports = { HELPER_VERSION, MARKER, MARKER_RE, HELPER_NAME, HELPER_SOURCE, MATCH_NEW_PAGE_FN, MATCH_ENSURE_PAGE, patchSource, findSessionFile, applyPatch };

if (require.main === module) {
  const result = applyPatch();
  if (!result.patched) process.stderr.write(`[mcp-relay] patch-bdmcp-quiet-page: ${result.reason}\n`);
  else if (result.action === "already") process.stderr.write(`[mcp-relay] patch-bdmcp-quiet-page: already applied (${path.basename(result.file)})\n`);
  process.exit(0);
}
