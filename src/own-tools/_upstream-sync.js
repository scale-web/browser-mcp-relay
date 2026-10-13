// _upstream-sync.js — does upstream's pinned page show what the relay's
// active page shows? Shared by tabs_new / tabs_select (which set it) and
// relay-server.js (which warns and guards on it).
//
// Why: upstream (browser-devtools-mcp) runs every tool, `execute` included,
// against ONE page it pinned at its first tool call (see
// _propagate-active-page.js). The relay's own tools follow tabs_select /
// tabs_new; upstream's follow only what propagation navigates it to. When
// propagation does not happen, `execute`'s `page.goto` navigates whatever
// upstream pinned — on 2026-10-13 that was a tab the user had just signed
// into (ALA-CRO's report; kit staging 2026-10-13-relay-active-page).
//
// Three rules live here:
//   A  while desynced, every upstream tool result carries a warning (warning()).
//   B  while desynced, upstream tools that change the page (isGuarded()) are
//      refused unless the caller passes `allowPinnedPage: true` (refusal()).
//   C  propagation never navigates upstream's pinned page away from a page the
//      relay did not put there (mayNavigate()). "Put there" = the pinned page
//      showed about:blank, or the URL the relay last left it on (relayUrl).
//      relayUrl moves only after the relay's own navigation, after a
//      navigation_* the caller chose, or after a short interaction_* on a page
//      the relay owned (afterGuardedCall()). Never after execute /
//      scenario-run: one can wait for a person to sign in in that tab and
//      return the moment they finish, so neither its result nor its duration
//      says who put the page there (review r2). A user who navigates or signs in inside that
//      tab changes its URL, so the relay stops owning it. A caller that knows
//      the tab is its own reclaims it with allowPinnedPage on tabs_select /
//      tabs_new.
//
// Every upstream read is best-effort and never throws.

const OPT_IN = "allowPinnedPage";
const GUARDED_NAMES = new Set(["execute", "scenario-run"]);
const GUARDED_PREFIXES = ["navigation_", "interaction_"];
const READ_TIMEOUT_MS = 5000;
// An interaction_* (a click, a fill) longer than this may have spanned a
// person acting in that tab, so its result is not the relay's.
const OWN_WINDOW_MS = 10000;

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

/** The URL upstream's pinned page shows: { url } or { error }. */
async function readUpstreamUrl() {
  const getUpstream = globalThis.__relayUpstream;
  if (typeof getUpstream !== "function") return { error: "__relayUpstream not exposed" };
  try {
    const upstream = await getUpstream();
    const res = await upstream.request("tools/call", {
      name: "execute",
      arguments: { code: "return page.url();", timeoutMs: READ_TIMEOUT_MS },
    });
    const text = res && Array.isArray(res.content)
      ? res.content.filter((c) => c && c.type === "text").map((c) => c.text).join(" ").trim()
      : "";
    if (!res || res.isError) return { error: text || "execute returned isError" };
    let out = res.structuredContent;
    if (!out || typeof out !== "object") {
      try { out = JSON.parse(text); } catch { out = null; }
    }
    if (out && typeof out.error === "string" && out.error) return { error: out.error };
    if (!out || typeof out.result !== "string") return { error: "execute returned no URL" };
    return { url: out.result };
  } catch (e) {
    return { error: e.message };
  }
}

/** C: may propagation navigate a pinned page that shows `current`? */
function mayNavigate(current) {
  return current === "about:blank" || (relayUrl !== null && current === relayUrl);
}

function markSynced(url) {
  desync = null;
  if (url) relayUrl = url;
}

/** `protectedPage`: upstream's tab shows a page the relay did not put there (rule C). */
function markDesynced(activeUrl, upstreamUrl, reason, protectedPage = false) {
  desync = { activeUrl: activeUrl || "(empty)", upstreamUrl: upstreamUrl || null, reason, protectedPage };
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
  const reclaim = `If you put that page there yourself (execute, a click, a redirect), repeat tabs_select / tabs_new with ${OPT_IN}: true to reclaim the tab; `
    + `if the user may be using it, ask them first.`;
  return `[mcp-relay] UPSTREAM DESYNC: the selected tab (${desync.activeUrl}) is NOT the tab upstream tools act on${where}; `
    + `${desync.reason}. Screenshots, snapshots and content_* read upstream's tab. `
    + `execute, scenario-run, navigation_* and interaction_* are refused until a tabs_select / tabs_new syncs; `
    + (desync.protectedPage
      // Upstream re-pins only when its page closes, so no tabs_* call can move it.
      ? `Upstream tools stay on that tab while it is open. ${reclaim}`
      : `To act on a URL, open it with tabs_new({url}); or pass ${OPT_IN}: true to act on upstream's tab anyway.`);
}

/** B: the result returned instead of forwarding a guarded tool while desynced. */
function refusal(name) {
  return {
    content: [{ type: "text", text: `[mcp-relay] REFUSED ${name}: it would act on upstream's tab, not the selected one. ${warning()}` }],
    isError: true,
  };
}

/**
 * After a guarded upstream call `name` that took `ms`: the relay drove the
 * pinned page, so its new URL is the relay's, when
 *   - the call was a navigation_* (the caller chose where it went) and the
 *     page was the relay's before it (`before`, from readUpstreamUrl()) or the
 *     caller opted in; or
 *   - the call was an interaction_*, the page was the relay's before it, and
 *     it took at most OWN_WINDOW_MS.
 * execute / scenario-run never claim (see the header). Otherwise ownership
 * stays put; a caller whose own execute moved the tab reclaims it with
 * allowPinnedPage on tabs_select / tabs_new.
 */
async function afterGuardedCall({ before, name, optIn = false, ms = 0 } = {}) {
  const wasOwned = before && typeof before.url === "string" && mayNavigate(before.url);
  const navigation = typeof name === "string" && name.startsWith("navigation_");
  const interaction = typeof name === "string" && name.startsWith("interaction_");
  if (!(navigation && (wasOwned || optIn)) && !(interaction && wasOwned && ms <= OWN_WINDOW_MS)) return;
  const after = await readUpstreamUrl();
  if (typeof after.url === "string") relayUrl = after.url;
}

/** A caller reclaimed the pinned tab (allowPinnedPage on tabs_*): its page is the relay's. */
function claim(url) {
  if (url) relayUrl = url;
}

/** A new upstream child pins a fresh page: forget everything. Also a test seam. */
function reset() {
  desync = null;
  relayUrl = null;
}

module.exports = {
  OPT_IN, OWN_WINDOW_MS, isGuarded, stripOptIn, readUpstreamUrl, mayNavigate, markSynced, markDesynced,
  isDesynced, state, warning, refusal, afterGuardedCall, claim, reset,
};
