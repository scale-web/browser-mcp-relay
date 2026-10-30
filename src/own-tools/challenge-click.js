// challenge_click — the ONE click on a visible Turnstile checkbox (spec v8
// §5.6 (8), review r6 #1, r7 #5, r7 #8). Registered ONLY in the plain-flags
// relay; the default relay's rule is zero clicks.
//
// Why a relay tool and not `execute`: allowing `execute` for one click would
// hand back everything the plain-flags tool list refuses; one narrow tool is a
// call the relay can count.
//
// Locating the widget: the challenge iframe need not be in the top document —
// a GHL form is itself a cross-origin iframe, and the Turnstile frame may sit
// in a (closed) shadow root. So the tool walks Playwright's frame tree (it
// tracks out-of-process frames through its own auto-attach), takes the frame
// whose URL is on challenges.cloudflare.com, gets each owner <iframe> element
// (frame.frameElement(): CDP DOM.getFrameOwner, which answers whatever shadow
// root holds it), scrolls each owner into view from the innermost out, reads
// the innermost owner's box in TOP-PAGE coordinates (Playwright sums the
// ancestor frames' offsets), and sends ONE CDP Input.dispatchMouseEvent
// sequence (moved, pressed, released) through the top page's session — the
// browser routes it to the out-of-process iframe by hit-testing.
//
// No widget, no click: no challenge frame mounted → refused, no input sent
// (`widget: "absent"`). A challenge frame whose box is under 4×4 px is an
// INVISIBLE-mode widget (the D22 measurement's GHL form: a 1×1 frame that
// issued its token on load) → refused, no input (`widget: "invisible"`).
//
// One per host per 10 min across every plain-flags relay: the shared count file
// (src/challenge-clicks.js), spent BEFORE the input is sent.
//
// The click offset inside the widget box — MEASURED 2026-10-30 on Cloudflare's
// test sitekey 3x00000000000000000000FF (Brave 156, a fresh profile per load;
// vault 00 - Summary/Phase 1b Measurement (D22).md), from the widget iframe's
// top-left:
//   normal  (300×65):  x 30, y = height / 2  → 3/3 token
//   compact (150×140): x 24, y 28            → 4/4 token  (the normal point
//       failed there, and (22, 30) failed 0/2: the hit area is smaller than
//       the drawn box, so exactly (24, 28)).
// The layout is picked by the box height (> 100 px = compact).

"use strict";

const { getActivePage } = require("./_active-page.js");

const CHALLENGE_HOST = "challenges.cloudflare.com";
const MIN_VISIBLE_PX = 4;
const CLICK_OFFSET_X = 30; // normal layout; y = height / 2
const COMPACT_OFFSET = Object.freeze({ x: 24, y: 28 });
const STEP_TIMEOUT_MS = 3000;
// After scrolling, the browser's hit-test data lags the new layout: a click
// sent at once was measured (isolated test, 2026-10-30) landing on the top
// document's <iframe> element instead of inside the frame. So the box is read
// until two reads SETTLE_MS apart agree, and the press follows the move by MOVE_GAP_MS.
const SETTLE_MS = 120;
const SETTLE_TRIES = 12;
const MOVE_GAP_MS = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// After the click: how long to watch for the token (review round 1 item 5).
const AFTER_WAIT_MS = 8000;
const AFTER_POLL_MS = 400;
const COMPACT_HEIGHT_PX = 100;
/** The measured point inside the widget box for its layout. */
function clickPoint(box) {
  if (box.height > COMPACT_HEIGHT_PX) return { layout: "compact", dx: COMPACT_OFFSET.x, dy: COMPACT_OFFSET.y };
  return { layout: "normal", dx: Math.min(CLICK_OFFSET_X, box.width / 2), dy: box.height / 2 };
}
let deps = { counter: null, afterWaitMs: AFTER_WAIT_MS };

/** Token LENGTHS (never values) of every cf-turnstile-response input in the
 *  page's readable frames; the challenge frame itself is never evaluated in. */
async function readTokenLengths(page) {
  const lens = [];
  for (const f of page.frames()) {
    if (hostOf(f.url()) === CHALLENGE_HOST) continue;
    try {
      const r = await withTimeout(f.evaluate(() => { "use strict"; return Array.from(document.querySelectorAll('input[name="cf-turnstile-response"]')).map((i) => String(i.value || "").length); }), 1500, "token read");
      if (Array.isArray(r)) for (const n of r.slice(0, 20)) lens.push(Math.max(0, Math.min(1e6, Math.floor(Number(n) || 0))));
    } catch { /* detached / unreadable */ }
  }
  return lens;
}
const passedFrom = (lens) => (lens.length === 0 ? null : lens.every((n) => n > 0));

function hostOf(u) {
  try { return new URL(String(u)).hostname.toLowerCase().replace(/\.+$/, ""); } catch { return ""; }
}

function result(obj, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); })]).finally(() => clearTimeout(t));
}

/** The owner <iframe> elements from `frame` up to (not including) the main frame, innermost first. */
async function ownerChain(frame, main) {
  const owners = [];
  for (let f = frame; f && f !== main; f = f.parentFrame()) {
    owners.push(await withTimeout(f.frameElement(), STEP_TIMEOUT_MS, "frameElement"));
  }
  return owners;
}

const ROUTE = "Go to the §4 one-click human step (cf-challenge skill) — never click again, never reload.";

module.exports = {
  name: "challenge_click",
  description:
    "PLAIN-FLAGS RELAY ONLY. One click on the visible Cloudflare Turnstile checkbox of the active page — found through the " +
    "frame tree (inside a form's cross-origin iframe or a shadow root), scrolled into view, clicked once with a CDP mouse " +
    "sequence. ONE per host per 10 min across every plain-flags relay; a second is refused. No challenge frame → refused, " +
    "nothing sent (widget: absent); an invisible-mode widget → refused (its token arrives on load: wait, then " +
    "challenge_detect). Call it only when challenge_detect says clickBudget: 1.",
  inputSchema: {
    type: "object",
    properties: {
      lane: { type: "string", description: "Your lane from `claude-ask whoami` (recorded with the click)." },
    },
    additionalProperties: false,
  },
  handler: async (args = {}) => {
    const lane = args && typeof args.lane === "string" ? args.lane.trim().slice(0, 80) : null;
    const bridge = globalThis.__relayBridge;
    if (!bridge) return result({ clicked: false, error: "bridge missing" }, true);
    const page = getActivePage(bridge.context);
    if (!page) return result({ clicked: false, error: "no pages open" }, true);
    const host = hostOf(page.url());
    if (!host) return result({ clicked: false, error: `the active page is not a web page (${page.url() || "blank"})` }, true);
    const main = page.mainFrame();
    const challengeFrames = page.frames().filter((f) => f !== main && hostOf(f.url()) === CHALLENGE_HOST);
    if (challengeFrames.length === 0) {
      return result({ clicked: false, widget: "absent", host, note: `No ${CHALLENGE_HOST} frame is mounted on this page — nothing was sent. ${ROUTE}` }, true);
    }
    let target = null;
    let sawInvisible = false;
    const problems = [];
    for (const f of challengeFrames) {
      try {
        const owners = await ownerChain(f, main);
        for (const el of owners) {
          await withTimeout(el.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS }), STEP_TIMEOUT_MS + 500, "scrollIntoView").catch(() => {});
        }
        let box = await withTimeout(owners[0].boundingBox(), STEP_TIMEOUT_MS, "boundingBox");
        for (let i = 0; i < SETTLE_TRIES && box; i++) {
          await sleep(SETTLE_MS);
          const next = await withTimeout(owners[0].boundingBox(), STEP_TIMEOUT_MS, "boundingBox");
          const same = next && ["x", "y", "width", "height"].every((k) => Math.abs(next[k] - box[k]) < 0.5);
          box = next;
          if (same) break;
        }
        if (!box || box.width < MIN_VISIBLE_PX || box.height < MIN_VISIBLE_PX) { sawInvisible = true; continue; }
        target = { box, depth: owners.length };
        break;
      } catch (e) {
        problems.push(String((e && e.message) || e).slice(0, 120));
      }
    }
    if (!target) {
      if (sawInvisible) {
        return result({
          clicked: false, widget: "invisible", host,
          note: "The Turnstile frame is invisible-mode (under 4×4 px): there is no checkbox to click, and its token arrives on load. Nothing was sent. Wait a few seconds and run challenge_detect again.",
        }, true);
      }
      return result({ clicked: false, widget: "unlocatable", host, problems, note: `The challenge frame's box could not be read — nothing was sent. ${ROUTE}` }, true);
    }
    if (!deps.counter) return result({ clicked: false, host, error: "the shared click count is not configured (plain-flags relay only) — refused" }, true);
    const spend = deps.counter.claim(host, lane);
    if (!spend.ok) {
      return result({ clicked: false, host, refused: spend.reason, ...(spend.at ? { lastClickAt: new Date(spend.at).toISOString() } : {}), note: ROUTE }, true);
    }
    const { box } = target;
    const tokenBefore = await readTokenLengths(page);
    const pt = clickPoint(box);
    const x = box.x + pt.dx;
    const y = box.y + pt.dy;
    let cdp;
    try {
      cdp = await bridge.context.newCDPSession(page);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      await sleep(MOVE_GAP_MS);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    } catch (e) {
      return result({ clicked: "unknown", host, error: `the click sequence failed part-way: ${e.message} — the host's click is spent. ${ROUTE}` }, true);
    } finally {
      if (cdp) { try { await cdp.detach(); } catch { /* gone */ } }
    }
    // Honest outcome (review round 1 item 5): "clicked" says only that input was
    // sent — `passed` says whether a token came.
    let tokenAfter = await readTokenLengths(page);
    const deadline = Date.now() + (Number(deps.afterWaitMs) || 0);
    while (passedFrom(tokenAfter) !== true && Date.now() < deadline) {
      await sleep(AFTER_POLL_MS);
      tokenAfter = await readTokenLengths(page);
    }
    const passed = passedFrom(tokenAfter);
    const stillMounted = page.frames().some((f) => f !== main && hostOf(f.url()) === CHALLENGE_HOST);
    const r = (n) => Math.round(n * 10) / 10;
    return result({
      clicked: true, passed, tokenBefore, tokenAfter, challengeFrameAfter: stillMounted ? "mounted" : "gone",
      host, frameDepth: target.depth,
      widgetBox: { x: r(box.x), y: r(box.y), width: r(box.width), height: r(box.height) },
      point: { x: r(x), y: r(y) },
      layout: pt.layout,
      offset: { x: r(pt.dx), y: r(pt.dy), source: "measured 2026-10-30, Cloudflare test sitekey (normal 3/3, compact 4/4)" },
      note: passed === true
        ? "A token is present after the click. This host's click for the next 10 min is spent. Run challenge_detect {lane, origin, stage:\"outcome\"}."
        : `${passed === false ? "No token after the click" : "No readable token input on this page (the widget's input may sit in a closed shadow root)"} — do not click again. Run challenge_detect {lane, origin, stage:"outcome"}, then ${ROUTE}`,
    });
  },
  configure({ counter } = {}) { deps = { ...deps, counter: counter || null }; },
  _setDeps(over) { deps = { ...deps, ...over }; },
  CLICK_OFFSET_X,
  COMPACT_OFFSET,
  clickPoint,
  MIN_VISIBLE_PX,
};
