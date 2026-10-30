const test = require("node:test");
const assert = require("node:assert");
const { filterToolResult, refuseUnpatched, setSourcePatchInEffect, TOOL, WITHHELD } = require("../src/request-body-filter.js");
const { RelayServer } = require("../src/relay-server.js");

// Fixture: what upstream returns for o11y_get-http-requests after a login POST
// (structuredContent + the same object as a JSON text block).
const SECRET = "hunter2-fixture-password";
function loginResult() {
  const result = {
    requests: [
      {
        url: "https://login.example.test/session",
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `email=zztest%40example.test&password=${SECRET}`,
        resourceType: "document",
        response: { status: 302, statusText: "Found" },
        ok: true,
      },
      { url: "https://login.example.test/app.js", method: "GET", resourceType: "script", ok: true },
    ],
  };
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

test("filterToolResult strips request bodies from structuredContent and the text block", () => {
  const out = filterToolResult(TOOL, loginResult());
  assert.ok(!JSON.stringify(out).includes(SECRET), "the password must not survive anywhere in the result");
  assert.strictEqual(out.structuredContent.requests[0].body, undefined);
  const text = JSON.parse(out.content[0].text);
  assert.strictEqual(text.requests[0].body, undefined);
  // Everything else is kept.
  assert.strictEqual(text.requests.length, 2);
  assert.strictEqual(text.requests[0].url, "https://login.example.test/session");
  assert.strictEqual(text.requests[0].method, "POST");
  assert.deepStrictEqual(text.requests[0].headers, { "content-type": "application/x-www-form-urlencoded" });
  assert.strictEqual(text.requests[0].response.status, 302);
  assert.strictEqual(out.structuredContent.requests[1].url, "https://login.example.test/app.js");
});

test("filterToolResult withholds a text block it cannot parse (fail closed)", () => {
  const out = filterToolResult(TOOL, { content: [{ type: "text", text: `not json ${SECRET}` }] });
  assert.strictEqual(out.content[0].text, WITHHELD);
  assert.ok(!JSON.stringify(out).includes(SECRET));
});

test("filterToolResult withholds parsed JSON without a requests array, and drops odd structuredContent", () => {
  const out = filterToolResult(TOOL, {
    content: [{ type: "text", text: JSON.stringify({ items: [{ body: SECRET }] }) }],
    structuredContent: { items: [{ body: SECRET }] },
  });
  assert.strictEqual(out.content[0].text, WITHHELD);
  assert.strictEqual(out.structuredContent, undefined);
  assert.ok(!JSON.stringify(out).includes(SECRET));
});

test("filterToolResult withholds any non-text content item (fail closed)", () => {
  const out = filterToolResult(TOOL, { content: [{ type: "resource", resource: { text: SECRET } }, { type: "image", data: "eA==" }] });
  assert.deepStrictEqual(out.content.map((c) => c.text), [WITHHELD, WITHHELD]);
  assert.ok(!JSON.stringify(out).includes(SECRET));
});

test("filterToolResult leaves other tools and error results untouched", () => {
  const other = { content: [{ type: "text", text: `body ${SECRET}` }] };
  assert.strictEqual(filterToolResult("capture_xhr", other), other);
  const err = { content: [{ type: "text", text: "upstream failed" }], isError: true };
  assert.strictEqual(filterToolResult(TOOL, err), err);
});

test("filterToolResult does not mutate the upstream response object", () => {
  const original = loginResult();
  filterToolResult(TOOL, original);
  assert.ok(original.structuredContent.requests[0].body.includes(SECRET));
});

// End to end through the relay: the body reaches neither the caller nor the
// Inspector's traffic feed. Removing the filter call in relay-server.js must
// fail this test.
class LoginUpstream {
  async request(method, params) {
    if (method === "tools/list") return { tools: [{ name: TOOL, description: "x", inputSchema: { type: "object" } }] };
    if (method === "tools/call" && params.name === TOOL) return loginResult();
    if (method === "tools/call") return { content: [{ type: "text", text: `forwarded ${params.name}` }] };
    throw new Error(`unexpected method ${method}`);
  }
  close() {}
}

test("RelayServer: o11y_get-http-requests through the relay carries no request body, in the result or the traffic feed", async () => {
  const relay = new RelayServer({ getUpstream: async () => new LoginUpstream() });
  const events = [];
  relay.trafficEmitter.on("response", (e) => events.push(e));
  const result = await relay.handleToolsCall({ name: TOOL, arguments: {} });
  assert.ok(!JSON.stringify(result).includes(SECRET), "result leaked the request body");
  assert.ok(events.length >= 1);
  assert.ok(!JSON.stringify(events).includes(SECRET), "traffic feed leaked the request body");
  assert.ok(result.content.some((c) => c.type === "text" && c.text.includes("https://login.example.test/session")));
});

// Fail closed: without the source patch, execute / scenario-run (which can
// return o11y_get-http-requests' raw output from a script) are refused.
test("refuseUnpatched: execute and scenario-run are refused until the source patch is in effect", async () => {
  setSourcePatchInEffect(false);
  for (const name of ["execute", "scenario-run"]) {
    const r = refuseUnpatched(name);
    assert.ok(r && r.isError, `${name} must be refused`);
    assert.match(r.content[0].text, /A76 request-body patch is not in effect/);
  }
  assert.strictEqual(refuseUnpatched(TOOL), null, "the direct call is covered by the result filter");
  assert.strictEqual(refuseUnpatched("navigation_go-to"), null);
  setSourcePatchInEffect(true);
  assert.strictEqual(refuseUnpatched("execute"), null);
  assert.strictEqual(refuseUnpatched("scenario-run"), null);
  setSourcePatchInEffect(false);
});

test("RelayServer refuses a forwarded execute while the patch is not in effect, and forwards it once it is", async () => {
  let forwarded = 0;
  const upstream = {
    async request(method, params) {
      if (method === "tools/call") { forwarded++; return { content: [{ type: "text", text: `forwarded ${params.name}` }] }; }
      return { tools: [] };
    },
    close() {},
  };
  const relay = new RelayServer({ getUpstream: async () => upstream });
  setSourcePatchInEffect(false);
  const refused = await relay.handleToolsCall({ name: "execute", arguments: { code: "return 1" } });
  assert.strictEqual(refused.isError, true);
  assert.strictEqual(forwarded, 0, "a refused call must never reach upstream");
  setSourcePatchInEffect(true);
  const ok = await relay.handleToolsCall({ name: "execute", arguments: { code: "return 1" } });
  assert.strictEqual(ok.content[0].text, "forwarded execute");
  assert.strictEqual(forwarded, 1);
  setSourcePatchInEffect(false);
});
