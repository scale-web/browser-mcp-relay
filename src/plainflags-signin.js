// plainflags-signin.js — loader for the plain-flags sign-in allowlist (spec v8
// §5.6 (6), D21). Ships with challenge_detect (§5.2, phase 1); 1c's sign-in
// guard reuses it unchanged.
//
// The file: `plainflags-signin.json` in the relay root, gitignored, created
// EMPTY by the 1c build (it does not exist in phase 1 — a missing file reads as
// empty, which is the phase-1 state):
//   {"accounts": [{"name": "<known account>", "askId": "<claude-ask id>"}]}
//
// Its own loader, not loadLocalConfig(): that one keeps string values only and
// returns {} for this nested shape (src/local-config.js, `typeof v !== "string"`
// — the same trap spec §5.4 records for trusted-zones.json). A test pins that.
//
// Fail closed: missing or malformed → empty list (every known account refused
// in 1c), logged once per file state. An entry without a non-empty `name` and
// `askId` string is dropped (logged once). Re-read whenever the file's
// mtime/size/inode changes (review r7 #12), checked on every load() call; the
// returned snapshot object is replaced only on a re-read, so a caller can
// compare snapshots by identity to see a change.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SIGNIN_FILE = path.join(path.resolve(__dirname, ".."), "plainflags-signin.json");

function emptySnapshot(source, problem) {
  return Object.freeze({ source, problem: problem || null, accounts: Object.freeze([]), names: Object.freeze(new Set()) });
}

/**
 * @param {object} [opts]
 * @param {string} [opts.path]  file path (test seam; default: relay root)
 * @param {(msg: string) => void} [opts.log]
 * @param {object} [opts.fsImpl] test seam ({ statSync, readFileSync })
 */
function createSigninLoader({ path: filePath = SIGNIN_FILE, log = (m) => process.stderr.write(`[mcp-relay] ${m}\n`), fsImpl = fs } = {}) {
  let key; // stat fingerprint of the snapshot below ("missing" when absent)
  let snapshot = null;
  let lastLogged = null;

  function logOnce(stateKey, msg) {
    if (lastLogged === stateKey) return;
    lastLogged = stateKey;
    try { log(msg); } catch { /* logging must never break a load */ }
  }

  function load() {
    let st = null;
    try { st = fsImpl.statSync(filePath); } catch { /* missing */ }
    const k = st ? `${st.mtimeMs}:${st.size}:${st.ino}` : "missing";
    if (snapshot && k === key) return snapshot;
    key = k;
    if (!st) {
      snapshot = emptySnapshot("missing");
      return snapshot;
    }
    let parsed;
    try {
      parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    } catch (e) {
      logOnce(k, `plainflags sign-in list ${filePath} unreadable (${e.message}) — read as EMPTY (every known account refused)`);
      snapshot = emptySnapshot("malformed", e.message);
      return snapshot;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.accounts)) {
      logOnce(k, `plainflags sign-in list ${filePath} has no "accounts" array — read as EMPTY (every known account refused)`);
      snapshot = emptySnapshot("malformed", 'no "accounts" array');
      return snapshot;
    }
    const accounts = [];
    let dropped = 0;
    for (const e of parsed.accounts) {
      const ok = e && typeof e === "object" && typeof e.name === "string" && e.name.trim() !== "" &&
        typeof e.askId === "string" && e.askId.trim() !== "";
      if (!ok) { dropped++; continue; }
      accounts.push(Object.freeze({ name: e.name.trim(), askId: e.askId.trim() }));
    }
    if (dropped > 0) {
      logOnce(k, `plainflags sign-in list ${filePath}: ${dropped} entr${dropped === 1 ? "y" : "ies"} without a name and askId ignored`);
    }
    snapshot = Object.freeze({
      source: "file",
      problem: dropped > 0 ? `${dropped} invalid entr${dropped === 1 ? "y" : "ies"} ignored` : null,
      accounts: Object.freeze(accounts),
      names: Object.freeze(new Set(accounts.map((a) => a.name))),
    });
    return snapshot;
  }

  return { load, path: filePath };
}

module.exports = { createSigninLoader, SIGNIN_FILE };
