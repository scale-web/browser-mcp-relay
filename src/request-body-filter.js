// request-body-filter.js — strips request bodies from o11y_get-http-requests
// results (register A76, 2026-10-30).
//
// Upstream (browser-devtools-mcp 0.6.12) stores every request's POST body
// (`_toHttpRequest`: `body: req.postData()`) and maps `body: req.body` into
// each returned item with no flag — only request headers and the response
// body are opt-in. So a login typed in any relay tab (email + password in the
// form body) reached the transcript of the next session that read HTTP
// requests. No session needs form bodies; drop them.
//
// Upstream returns the result twice: `structuredContent` and a text block
// holding JSON.stringify(result, null, 2). Both are stripped. Fail closed: a
// text block that does not parse as the expected JSON is withheld, not passed.

const TOOL = "o11y_get-http-requests";

const WITHHELD =
  "[mcp-relay] o11y_get-http-requests output withheld: the relay could not strip request bodies " +
  "from it (they can hold typed logins). Request headers and response fields are unaffected by this filter.";

function stripRequests(obj) {
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.requests)) return null;
  return {
    ...obj,
    requests: obj.requests.map((req) => {
      if (!req || typeof req !== "object") return req;
      const { body, ...rest } = req;
      return rest;
    }),
  };
}

function filterToolResult(name, response) {
  if (name !== TOOL || !response || typeof response !== "object") return response;
  if (response.isError) return response;
  const out = { ...response };
  if (out.structuredContent !== undefined) {
    const stripped = stripRequests(out.structuredContent);
    if (stripped) out.structuredContent = stripped;
    else delete out.structuredContent;
  }
  if (Array.isArray(out.content)) {
    out.content = out.content.map((item) => {
      if (!item || item.type !== "text") return { type: "text", text: WITHHELD };
      let parsed;
      try { parsed = JSON.parse(item.text); } catch { return { type: "text", text: WITHHELD }; }
      const stripped = stripRequests(parsed);
      if (!stripped) return { type: "text", text: WITHHELD };
      return { ...item, text: JSON.stringify(stripped, null, 2) };
    });
  }
  return out;
}

// Whether scripts/patch-bdmcp-request-body.js is in effect for the upstream
// bundle this relay spawns. Starts false (fail closed); src/index.js sets it
// after each patch attempt, before upstream spawns.
let sourcePatchInEffect = false;
const SCRIPT_TOOLS = new Set(["execute", "scenario-run"]);

function setSourcePatchInEffect(ok) { sourcePatchInEffect = !!ok; }

// execute / scenario-run can call o11y_get-http-requests from inside a script
// and return its raw output, which filterToolResult never sees. Without the
// source patch, refuse them.
function refuseUnpatched(name) {
  if (sourcePatchInEffect || !SCRIPT_TOOLS.has(name)) return null;
  return {
    content: [{
      type: "text",
      text: `[mcp-relay] "${name}" refused: the A76 request-body patch is not in effect for this relay's upstream bundle, ` +
        "so a script could return captured request bodies (typed logins). Check the relay's stderr for the " +
        "\"WARNING A76\" line; restart the relay once the patch applies.",
    }],
    isError: true,
  };
}

module.exports = { filterToolResult, refuseUnpatched, setSourcePatchInEffect, TOOL, WITHHELD, SCRIPT_TOOLS };
