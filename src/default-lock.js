// default-lock.js — the DEFAULT relay's secret-on-page lock (register A77;
// Trevor's ruling as-ops/ask-a2ggu5 rev 2, "Lock, except session-filled
// values"). The plain-flags lock (src/plainflags-lock.js) run with
// `mode: "default"`: it locks on a FILLED SECRET FIELD only (no sign-in-URL
// rule), and a field holding exactly a value this relay process filled itself
// (interaction_fill / form_fill args, recorded just before the call runs) does
// not lock. Characters typed with interaction_press-key are not recorded (they
// lock).
//
// RelayServer runs it as the default relay's `policy`: the tool list and every
// argument pass unchanged; before every call but relay_status / tabs_list the
// lock is probed (locked → refused), and again after it (locked → the result,
// or a thrown error, is withheld and a screenshot file it names is deleted).
// Everything else in the default relay is untouched (tool list, launch flags,
// A76 body stripping, the Meta guard, the vault). An ACCIDENT GUARD, not a
// boundary: `execute`, `cookies_export` and any local CDP client still read
// anything, on purpose.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createLock, createSessionFills, EXEMPT } = require("./plainflags-lock.js");

// Upstream tools that write a screenshot file and name it in their result.
const SHOT_TOOLS = new Set(["content_take-screenshot", "navigation_go-to", "navigation_go-back-or-forward", "navigation_reload"]);
const SHOT_KEYS = new Set(["filePath", "screenshotFilePath"]);

/** Absolute .png / .jpeg paths a screenshot result names (structuredContent and its JSON text). */
function screenshotFiles(response) {
  const out = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 8) return;
    for (const [k, x] of Object.entries(v)) {
      if (SHOT_KEYS.has(k) && typeof x === "string") out.add(x);
      else walk(x, depth + 1);
    }
  };
  if (response && typeof response === "object") {
    walk(response.structuredContent, 0);
    for (const c of Array.isArray(response.content) ? response.content : []) {
      if (c && c.type === "text" && typeof c.text === "string") { try { walk(JSON.parse(c.text), 0); } catch { /* prose */ } }
    }
  }
  return [...out].filter((f) => path.isAbsolute(f) && /\.(png|jpe?g)$/i.test(f));
}

function deleteScreenshots(name, response) {
  if (!SHOT_TOOLS.has(name)) return;
  for (const f of screenshotFiles(response)) {
    try { if (fs.lstatSync(f).isFile()) fs.rmSync(f, { force: true }); } catch { /* gone */ }
  }
}

/**
 * @param {object} o
 * @param {() => (object|null)} o.getContext  the relay's Playwright BrowserContext (null while no Brave)
 * @param {(text: string) => void} [o.notice]  LOCKED / UNLOCKED, on the next tool result
 * @param {(m: string) => void} [o.log]
 * @param {object} [o.lock]  test seam (default: createLock in default mode)
 * @param {object} [o.sessionFills]  test seam (default: createSessionFills())
 */
function createDefaultLockPolicy({ getContext, notice = () => {}, log = () => {}, lock = null, sessionFills = null, frameTimeoutMs } = {}) {
  const fills = sessionFills || createSessionFills();
  const theLock = lock || createLock({ getContext, notice, log, mode: "default", sessionFills: fills, ...(frameTimeoutMs ? { frameTimeoutMs } : {}) });
  const text = theLock.LOCK_TEXT;
  const locked = (reason, tail = "") => ({ isError: true, content: [{ type: "text", text: `[mcp-relay] ${text} (${reason})${tail}` }] });
  const probeOrFail = async () => { try { return await theLock.probe(); } catch { return { locked: true, reason: "the lock probe failed — fail closed" }; } };

  return {
    lock: theLock,
    filterToolsList: (tools) => tools,

    async beforeCall(name, args) {
      if (EXEMPT.includes(name)) return { args };
      let st;
      try { st = await theLock.probe(); } catch (e) { return { refusal: locked(`the lock probe failed: ${e.message} — fail closed`) }; }
      if (st.locked) return { refusal: locked(st.reason) };
      // The exception: what this call will put into the page (its own args), recorded just before it runs.
      const a = args && typeof args === "object" ? args : {};
      if (name === "interaction_fill") fills.record(a.value);
      if (name === "form_fill" && Array.isArray(a.fields)) for (const f of a.fields) if (f && typeof f === "object") fills.record(f.value);
      return { args };
    },

    async afterCall(name, response) {
      if (EXEMPT.includes(name)) return response;
      const st = await probeOrFail();
      if (!st.locked) return response;
      deleteScreenshots(name, response);
      return locked(st.reason, " — the result of this call was withheld: the lock came on while it ran.");
    },

    async filterThrown(name, err) {
      if (EXEMPT.includes(name)) return err;
      const st = await probeOrFail();
      if (!st.locked) return err;
      const out = new Error(`[mcp-relay] ${text} (${st.reason}) — this call's error was withheld: the lock came on while it ran.`);
      if (err && err.code !== undefined) out.code = err.code;
      return out;
    },
  };
}

module.exports = { createDefaultLockPolicy, screenshotFiles, SHOT_TOOLS };
