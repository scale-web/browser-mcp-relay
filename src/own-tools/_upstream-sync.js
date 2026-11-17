// _upstream-sync.js — is upstream's pinned page the relay's active page?
// Shared by tabs_new / tabs_select and _propagate-active-page.js (which pin it)
// and relay-server.js (which re-pins before each upstream call, and warns and
// guards on a failed pin).
//
// Why: upstream (browser-devtools-mcp) runs every tool, `execute` included,
// against ONE page it pins at its first tool call. Since 2026-11-17 (ask
// as-ops/ask-5ojuum rev 3) the relay MOVES that pin to its own active page, by
// CDP target id (scripts/patch-bdmcp-repin.js, pinUpstream()), instead of
// navigating upstream's page to the same URL — so both act on one tab, and no
// page is navigated to "follow". On 2026-10-13 the old navigation let
// `execute`'s `page.goto` land on a tab the user had just signed into
// (ALA-CRO's report); a pin moves nothing on any page.
//
// Three rules live here:
//   A  while desynced (a pin failed), every upstream tool result carries a
//      warning (warning()).
//   B  while desynced, upstream tools that change the page (isGuarded()) are
//      refused unless the caller passes `allowPinnedPage: true` (refusal()).
//   C  tabs_new never reuses (navigates) or prunes the pinned tab while it
//      shows a page the relay did not put there (mayNavigate()). "Put there" =
//      about:blank, or the URL the relay last left the pinned tab on
//      (relayUrl). relayUrl moves when tabs_new / tabs_select pin a tab
//      (claim), or after a navigation_go-to / navigation_reload the caller
//      chose (afterGuardedCall()); go-back / go-forward land on a history entry
//      the user may have put there (review r3). Never after execute /
//      scenario-run / interaction_*: each can wait while a person signs in in
//      that tab and return the moment they finish, so neither its result nor
//      its duration says who put the page there (reviews r2, r3). The re-pin
//      relay-server does before each call claims nothing.
//
// Every upstream read is best-effort and never throws.

const OPT_IN = "allowPinnedPage";
const GUARDED_NAMES = new Set(["execute", "scenario-run"]);
const GUARDED_PREFIXES = ["navigation_", "interaction_"];
const READ_TIMEOUT_MS = 5000;
// The probe readUpstreamUrl runs in upstream's `execute`: the pinned page's URL
// and its CDP target id (2026-11-17). The id lets tabs_new tell upstream's tab
// apart from another tab showing the same URL (two about:blank tabs, say); a
// failed id read still returns the URL (targetId null).
const URL_PROBE = "const url = page.url(); let targetId = null; "
  + "try { const s = await page.context().newCDPSession(page); "
  + "try { targetId = (await s.send('Target.getTargetInfo')).targetInfo.targetId; } "
  + "finally { s.detach().catch(() => {}); } } catch { /* the URL alone */ } "
  + "return { url, targetId };";
const PIN_TIMEOUT_MS = 8000;

let desync = null; // null = synced or unknown; else { activeUrl, upstreamUrl, reason }
let relayUrl = null;

function isGuarded(name) {
  return typeof name === "string" && (GUARDED_NAMES.has(name) || GUARDED_PREFIXES.some((p) => name.startsWith(p)));
}

/** { args, optIn }: the caller's args without the relay-only opt-in key. */
function stripOptIn(args) {
  if (!args || typeof args !== "object" || !(OPT_IN in args)) return { args, optIn: false };
  const { [OPT_IN]: v, ...rest } = args;
  return { args: rest, optIn: v === true };
}

/** Run `code` in upstream's `execute`: { result } or { error }. Never throws. */
async function runInUpstream(code, timeoutMs) {
  const getUpstream = globalThis.__relayUpstream;
  if (typeof getUpstream !== "function") return { error: "__relayUpstream not exposed" };
  try {
    const upstream = await getUpstream();
    const res = await upstream.request("tools/call", { name: "execute", arguments: { code, timeoutMs } });
    const text = res && Array.isArray(res.content)
      ? res.content.filter((c) => c && c.type === "text").map((c) => c.text).join(" ").trim()
      : "";
    if (!res || res.isError) return { error: text || "execute returned isError" };
    let out = res.structuredContent;
    if (!out || typeof out !== "object") {
      try { out = JSON.parse(text); } catch { out = null; }
    }
    if (out && typeof out.error === "string" && out.error) return { error: out.error };
    return { result: out ? out.result : undefined };
  } catch (e) {
    return { error: e.message };
  }
}

/** The URL upstream's pinned page shows: { url, targetId } (targetId null when
 *  unknown) or { error }. */
async function readUpstreamUrl() {
  const { result: r, error } = await runInUpstream(URL_PROBE, READ_TIMEOUT_MS);
  if (error) return { error };
  // A bare string: an upstream (or test double) that answers the URL alone.
  const url = typeof r === "string" ? r : (r && typeof r.url === "string" ? r.url : null);
  if (url === null) return { error: "execute returned no URL" };
  const targetId = r && typeof r.targetId === "string" && r.targetId ? r.targetId : null;
  return { url, targetId };
}

/** Move upstream's pin to CDP target `targetId` (scripts/patch-bdmcp-repin.js):
 *  { url, targetId, changed, closedOwnBlank } or { error }. Never throws. */
async function pinUpstream(targetId) {
  const { result: r, error } = await runInUpstream(`return await __relayPin(${JSON.stringify(targetId)});`, PIN_TIMEOUT_MS);
  if (error) {
    return { error: /__relayPin is not defined/.test(error) ? "upstream is not patched for re-pinning (scripts/patch-bdmcp-repin.js did not apply)" : error };
  }
  if (!r || typeof r !== "object" || r.targetId !== targetId) return { error: "upstream's re-pin returned no page" };
  return { url: r.url, targetId: r.targetId, changed: !!r.changed, closedOwnBlank: !!r.closedOwnBlank };
}

/** C: may tabs_new reuse (navigate) or prune a pinned tab that shows `current`? */
function mayNavigate(current) {
  return current === "about:blank" || (relayUrl !== null && current === relayUrl);
}

function markSynced(url) {
  desync = null;
  if (url) relayUrl = url;
}

function markDesynced(activeUrl, upstreamUrl, reason) {
  desync = { activeUrl: activeUrl || "(empty)", upstreamUrl: upstreamUrl || null, reason };
}

function isDesynced() {
  return desync !== null;
}

function state() {
  return { desynced: desync !== null, ...(desync || {}), relayUrl };
}

/** A: the text put in front of every upstream tool result while desynced. */
function warning() {
  if (!desync) return null;
  const where = desync.upstreamUrl ? ` (it shows ${desync.upstreamUrl})` : "";
  return `[mcp-relay] UPSTREAM DESYNC: the selected tab (${desync.activeUrl}) is NOT the tab upstream tools act on${where}; `
    + `${desync.reason}. Screenshots, snapshots and content_* read upstream's tab. `
    + `execute, scenario-run, navigation_* and interaction_* are refused until a tabs_select / tabs_new syncs. `
    + `Select the tab again with tabs_select({index}); or pass ${OPT_IN}: true to act on upstream's tab anyway.`;
}

/** B: the result returned instead of forwarding a guarded tool while desynced. */
function refusal(name) {
  return {
    content: [{ type: "text", text: `[mcp-relay] REFUSED ${name}: it would act on upstream's tab, not the selected one. ${warning()}` }],
    isError: true,
  };
}

/**
 * After a guarded upstream call `name`: its new URL is the relay's when it was
 * a navigation_go-to (the caller chose where it went) and the pinned page was
 * the relay's before it (`before`, from readUpstreamUrl()) or the caller opted
 * in; or a navigation_reload of a page that was already the relay's. Nothing
 * else claims (see the header); a caller whose own execute or click moved the
 * tab reclaims it with allowPinnedPage on tabs_select / tabs_new.
 */
async function afterGuardedCall({ before, name, optIn = false } = {}) {
  const wasOwned = before && typeof before.url === "string" && mayNavigate(before.url);
  // A reload keeps the URL already there, so opting in to one reload is not choosing the page [review r4].
  const claims = (name === "navigation_go-to" && (wasOwned || optIn)) || (name === "navigation_reload" && wasOwned);
  if (!claims) return;
  const after = await readUpstreamUrl();
  if (typeof after.url === "string") relayUrl = after.url;
}

/** tabs_new / tabs_select pinned a tab: its page is the relay's. */
function claim(url) {
  if (url) relayUrl = url;
}

/** A new upstream child pins a fresh page: forget everything. Also a test seam. */
function reset() {
  desync = null;
  relayUrl = null;
}

module.exports = {
  OPT_IN, URL_PROBE, isGuarded, stripOptIn, readUpstreamUrl, pinUpstream, mayNavigate, markSynced, markDesynced,
  isDesynced, state, warning, refusal, afterGuardedCall, claim, reset,
};
