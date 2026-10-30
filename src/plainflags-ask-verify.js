// plainflags-ask-verify.js — an entry on the plain-flags sign-in list counts
// only when its `askId` names a real claude-ask record that grants it (review
// round 1 item 6; spec v8 §5.6 (6): adding an account is Trevor's GO by name,
// `--risk credentials`). READ-ONLY: this module never writes the ask store.
//
// The store (~/.claude/scripts/claude-ask.py, read 2026-10-30): records live in
// <root>/<project>/<short>.json (moved to <project>/archive/<short>.json when
// archived), root = ~/.claude-asks; an id is "<project>/ask-xxxxxx"
// (`^([a-z0-9][a-z0-9._-]{0,63})/(ask-[a-z2-7]{6})$`); a record carries `id`,
// `project`, `title`, `risk`, `state` (waiting | answered | in_progress |
// done | declined | withdrawn | forwarded), `options[{key, declines}]` and
// `answer{option, …}`.
//
// An entry is honoured only when the record exists, its id and project match
// its path, its state is answered / in_progress / done, its risk is
// "credentials", it carries an answer whose option is not a declining one, and
// its title names the account. Anything else (missing, unreadable, malformed)
// refuses the entry — fail closed.
//
// NOT A GATE (review round 2 item 2): the ask store is writable by any session
// (it is how sessions record asks), so a determined or prompt-injected session
// can write a record that passes every check here. What the check DOES catch:
// an entry added with no ask at all, a wrong or mistyped id, a declined /
// withdrawn / waiting ask, an ask about another account or of another risk.
// `requireTypedAnswer` (off by default) additionally requires the answer's
// `prompt_id` — set by the typed-words recorder (register A71) once installed,
// which ties the answer to a prompt Trevor typed; turn it on then.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ID_RE = /^([a-z0-9][a-z0-9._-]{0,63})\/(ask-[a-z2-7]{6})$/;
const GRANTED_STATES = new Set(["answered", "in_progress", "done"]);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * @param {object} [o]
 * @param {string} [o.root]  the ask store (test seam; default ~/.claude-asks)
 */
function createAskVerifier({ root = path.join(os.homedir(), ".claude-asks"), requireTypedAnswer = false, _fs = fs } = {}) {
  function readRecord(project, short) {
    for (const p of [path.join(root, project, `${short}.json`), path.join(root, project, "archive", `${short}.json`)]) {
      let text;
      try { text = _fs.readFileSync(p, "utf8"); } catch (e) { if (e.code === "ENOENT") continue; return { error: `cannot read the ask record (${e.code || e.message})` }; }
      try { return { record: JSON.parse(text) }; } catch { return { error: "the ask record does not parse" }; }
    }
    return { error: "no such ask record" };
  }

  /** { ok: true } or { ok: false, reason } for the entry (name, askId). */
  function verify(name, askId) {
    const m = ID_RE.exec(String(askId || ""));
    if (!m) return { ok: false, reason: `askId ${JSON.stringify(askId)} is not a claude-ask id (<project>/ask-xxxxxx)` };
    const [, project, short] = m;
    const { record: r, error } = readRecord(project, short);
    if (error) return { ok: false, reason: `${askId}: ${error}` };
    if (!r || typeof r !== "object" || r.id !== askId || r.project !== project) return { ok: false, reason: `${askId}: the record's identity does not match its path` };
    if (!GRANTED_STATES.has(r.state)) return { ok: false, reason: `${askId} is ${JSON.stringify(r.state)}, not answered / in_progress / done` };
    if (r.risk !== "credentials") return { ok: false, reason: `${askId} has risk ${JSON.stringify(r.risk)}, not "credentials"` };
    const ans = r.answer;
    if (!ans || typeof ans !== "object" || typeof ans.option !== "string") return { ok: false, reason: `${askId} carries no answer` };
    const opt = Array.isArray(r.options) ? r.options.find((o) => o && o.key === ans.option) : null;
    if (opt && opt.declines) return { ok: false, reason: `${askId} was answered with a declining option (${ans.option})` };
    if (requireTypedAnswer && !(typeof ans.prompt_id === "string" && ans.prompt_id.trim() !== "")) {
      return { ok: false, reason: `${askId}'s answer carries no prompt_id (requireTypedAnswer is on: the answer must come from a prompt Trevor typed)` };
    }
    if (typeof r.title !== "string" || !new RegExp(`(^|[^a-z0-9])${escapeRe(String(name).toLowerCase())}([^a-z0-9]|$)`).test(r.title.toLowerCase())) {
      return { ok: false, reason: `${askId}'s title does not name "${name}"` };
    }
    return { ok: true };
  }

  return { verify, root, requireTypedAnswer };
}

module.exports = { createAskVerifier, ID_RE, GRANTED_STATES };
