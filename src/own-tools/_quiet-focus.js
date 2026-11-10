// _quiet-focus.js — keep the relay's Brave from taking the user's screen
// (2026-10-29). Measured on macOS (Playwright 1.59, Brave): context.newPage()
// and page.bringToFront() both ACTIVATE Brave, which pulls a user working in a
// full-screen app out of their Space. goto, click, fill, typing, evaluate and
// screenshots on an unselected tab do not, and under Playwright's flags an
// unselected tab stays live (visibilityState "visible", rAF ~120/s, focus
// emulated) — so raising a tab is cosmetic for automation.
//
// So new tabs open in the BACKGROUND (CDP Target.createTarget
// {background:true}), and a tab is raised only when THIS relay's Brave is
// already the frontmost app (the user is looking at it; nothing to steal).
// Matched by pid: the user's own Brave and other relays' Braves share its
// bundle id (review 2026-10-29).
// Pages upstream creates itself with its own Playwright (its session page and
// that page's re-creation) were not covered here; since 2026-11-10 (A1)
// scripts/patch-bdmcp-quiet-page.js routes them through the same
// background createTarget.

const { execFile } = require("node:child_process");
const { _cdpCall } = require("../cdp-bridge.js");

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, out) => resolve(err ? null : String(out)));
  });
}

/** pid of the app whose ASN is `asn` in `lsappinfo list` output, else null.
 *  Matches an entry's HEAD line only: `parentASN=... ASN:...` lines inside other
 *  entries name the same ASNs. Pure. */
function pidOfAsn(asn, list) {
  if (!asn || !list) return null;
  for (const entry of list.split(/\n(?=\s*\d+\) ")/)) {
    const head = entry.split("\n").find((l) => l.trim()) || "";
    if (!head.includes(` ${asn}`)) continue;
    const m = entry.match(/^\s*pid = (\d+)\b/m);
    return m ? Number(m[1]) : null;
  }
  return null;
}

/** True when the Brave with main pid `bravePid` is the frontmost app. Off
 *  macOS: true (the steal is a macOS Spaces problem; behave as before).
 *  Unknown pid or front app: false (do not raise). */
async function braveIsFront(bravePid) {
  if (process.platform !== "darwin") return true;
  if (!Number.isInteger(bravePid)) return false;
  const asn = ((await module.exports._run("lsappinfo", ["front"])) || "").trim();
  return pidOfAsn(asn, await module.exports._run("lsappinfo", ["list"])) === bravePid;
}

/** bringToFront only when this Brave is already in front. Returns whether it raised. */
async function raiseIfFront(page, bravePid) {
  if (!(await module.exports.braveIsFront(bravePid))) return false;
  await page.bringToFront();
  return true;
}

const targetIds = new WeakMap();
async function targetIdOf(context, page) {
  if (targetIds.has(page)) return targetIds.get(page);
  const session = await context.newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    targetIds.set(page, targetInfo.targetId);
    return targetInfo.targetId;
  } finally {
    session.detach().catch(() => { /* page closing */ });
  }
}

/** The context's Page for CDP `targetId`, waiting for Playwright to attach it. */
async function pageForTarget(context, targetId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      try { if ((await targetIdOf(context, p)) === targetId) return p; } catch { /* closing */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** A new about:blank tab that does not activate Brave (macOS, with a CDP
 *  endpoint); otherwise, or if that fails, context.newPage(). */
async function newQuietPage(bridge, { timeoutMs = 10000 } = {}) {
  const context = bridge.context;
  if (process.platform !== "darwin" || typeof bridge.wsEndpoint !== "string") return context.newPage();
  let targetId = null;
  try {
    ({ targetId } = await module.exports._cdpCall(bridge.wsEndpoint, "Target.createTarget", { url: "about:blank", background: true }));
    const page = await pageForTarget(context, targetId, timeoutMs);
    if (page) return page;
    throw new Error(`no page for target ${targetId} within ${timeoutMs}ms`);
  } catch (e) {
    if (targetId) {
      await module.exports._cdpCall(bridge.wsEndpoint, "Target.closeTarget", { targetId }).catch(() => {});
    }
    process.stderr.write(`[mcp-relay] background tab failed (${e.message}) — opening a normal tab\n`);
    return context.newPage();
  }
}

module.exports = { braveIsFront, raiseIfFront, newQuietPage, _pidOfAsn: pidOfAsn, _cdpCall, _run: run };
