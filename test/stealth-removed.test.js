// stealth-removed.test.js — spec v8 §5.3 (D3, ruled): `stealth_apply` is deleted.
// Its patches contradicted real browser values; the history stays in git.
// `emulate_device` is untouched and still registered.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { RelayServer } = require("../src/relay-server.js");
const { tools: ownTools } = require("../src/own-tools/index.js");
const forwarded = require("../scripts/inspector-forwarded-tools.js").tools;
const { OWN_TOOL_META } = require("../src/inspector-server.js");

class CatalogUpstream {
  async request(method, params) {
    if (method === "tools/list") return { tools: forwarded.map((t) => ({ name: t.name, description: "", inputSchema: { type: "object" } })) };
    if (method === "tools/call") return { isError: true, content: [{ type: "text", text: `upstream: unknown tool ${params.name}` }] };
    throw new Error(method);
  }
}

test("stealth_apply is absent from the relay's tools/list; challenge_detect and emulate_device are present", async () => {
  const relay = new RelayServer({ getUpstream: async () => new CatalogUpstream() });
  for (const t of ownTools) relay.registerOwnTool(t);
  const names = (await relay.handleToolsList()).tools.map((t) => t.name);
  assert.ok(!names.includes("stealth_apply"), "stealth_apply must not be offered");
  assert.ok(!names.some((n) => /stealth/i.test(n)));
  assert.ok(names.includes("challenge_detect"));
  assert.ok(names.includes("emulate_device"));
});

test("a stealth_apply call is not handled by the relay (no own handler; upstream has none either)", async () => {
  const relay = new RelayServer({ getUpstream: async () => new CatalogUpstream() });
  for (const t of ownTools) relay.registerOwnTool(t);
  assert.strictEqual(relay.ownTools.has("stealth_apply"), false);
  const r = await relay.handleToolsCall({ name: "stealth_apply", arguments: {} });
  assert.strictEqual(r.isError, true);
});

test("the stealth module and its inspector entry are gone", () => {
  assert.strictEqual(fs.existsSync(path.join(__dirname, "..", "src", "own-tools", "stealth-apply.js")), false);
  assert.ok(!("stealth_apply" in OWN_TOOL_META));
  assert.deepStrictEqual(OWN_TOOL_META.challenge_detect, { sourceFile: "challenge-detect.js", category: "network" });
});
