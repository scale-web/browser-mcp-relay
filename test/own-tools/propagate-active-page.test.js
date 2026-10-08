const test = require("node:test");
const assert = require("node:assert");
const { propagateActivePageToUpstream } = require("../../src/own-tools/_propagate-active-page.js");

test("propagateActivePageToUpstream: empty url skips", async () => {
  const r = await propagateActivePageToUpstream("");
  assert.strictEqual(r.propagated, false);
  assert.match(r.reason, /empty|about:blank/);
});

test("propagateActivePageToUpstream: null url skips", async () => {
  const r = await propagateActivePageToUpstream(null);
  assert.strictEqual(r.propagated, false);
});

test("propagateActivePageToUpstream: about:blank skips", async () => {
  const r = await propagateActivePageToUpstream("about:blank");
  assert.strictEqual(r.propagated, false);
  assert.match(r.reason, /about:blank/);
});

test("propagateActivePageToUpstream: missing __relayUpstream skips", async () => {
  const prev = globalThis.__relayUpstream;
  globalThis.__relayUpstream = undefined;
  try {
    const r = await propagateActivePageToUpstream("https://example.com/");
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /__relayUpstream/);
  } finally {
    globalThis.__relayUpstream = prev;
  }
});

test("propagateActivePageToUpstream: forwards to upstream navigation_go-to", async () => {
  const prev = globalThis.__relayUpstream;
  let calledWith = null;
  globalThis.__relayUpstream = async () => ({
    request: async (method, params) => {
      calledWith = { method, params };
      return {};
    },
  });
  try {
    const r = await propagateActivePageToUpstream("https://example.com/");
    assert.strictEqual(r.propagated, true);
    assert.strictEqual(calledWith.method, "tools/call");
    assert.strictEqual(calledWith.params.name, "navigation_go-to");
    assert.strictEqual(calledWith.params.arguments.url, "https://example.com/");
    assert.strictEqual(calledWith.params.arguments.includeSnapshot, false);
    assert.strictEqual(calledWith.params.arguments.includeScreenshot, false);
  } finally {
    globalThis.__relayUpstream = prev;
  }
});

test("propagateActivePageToUpstream: upstream error returned as failure, not thrown", async () => {
  const prev = globalThis.__relayUpstream;
  globalThis.__relayUpstream = async () => ({
    request: async () => { throw new Error("kaboom"); },
  });
  try {
    const r = await propagateActivePageToUpstream("https://example.com/");
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /kaboom/);
  } finally {
    globalThis.__relayUpstream = prev;
  }
});

test("propagateActivePageToUpstream: upstream isError result reported as failure, not success", async () => {
  // browser-devtools-mcp reports tool failures as a normal result with
  // isError: true, not as a thrown JSON-RPC error.
  const prev = globalThis.__relayUpstream;
  globalThis.__relayUpstream = async () => ({
    request: async () => ({
      content: [{ type: "text", text: "Target page, context or browser has been closed" }],
      isError: true,
    }),
  });
  try {
    const r = await propagateActivePageToUpstream("https://example.com/");
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /has been closed/);
  } finally {
    globalThis.__relayUpstream = prev;
  }
});

test("propagateActivePageToUpstream: isError with no text still reported as failure", async () => {
  const prev = globalThis.__relayUpstream;
  globalThis.__relayUpstream = async () => ({ request: async () => ({ isError: true }) });
  try {
    const r = await propagateActivePageToUpstream("https://example.com/");
    assert.strictEqual(r.propagated, false);
    assert.match(r.reason, /returned isError/);
  } finally {
    globalThis.__relayUpstream = prev;
  }
});
