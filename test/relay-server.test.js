const test = require("node:test");
const assert = require("node:assert");
const { RelayServer, TrafficEmitter, truncateForEmit, MAX_TRAFFIC_BODY_CHARS, TRAFFIC_RING_CAPACITY } = require("../src/relay-server.js");

class FakeUpstream {
  async request(method, params) {
    if (method === "tools/list") {
      return { tools: [
        { name: "navigation_go-to", description: "navigate", inputSchema: { type: "object" } },
      ] };
    }
    if (method === "tools/call") {
      return { content: [{ type: "text", text: `forwarded ${params.name}` }] };
    }
    throw new Error(`unexpected method ${method}`);
  }
  close() {}
}

// Default makeRelay: relay with upstream getter only (no Brave). Used by tests
// that don't care about the Brave-launch path.
function makeRelay(upstream = new FakeUpstream()) {
  return new RelayServer({ getUpstream: async () => upstream });
}

// makeRelayWithBrave: tracks how many times each lifecycle function fires.
function makeRelayWithBrave(upstream = new FakeUpstream()) {
  const counters = { getUpstream: 0, ensureBrave: 0 };
  const relay = new RelayServer({
    getUpstream: async () => { counters.getUpstream++; return upstream; },
    ensureBrave: async () => { counters.ensureBrave++; },
  });
  return { relay, counters };
}

test("RelayServer.handleToolsList returns upstream tools when no own-tools registered", async () => {
  const relay = makeRelay();
  const result = await relay.handleToolsList();
  assert.strictEqual(result.tools.length, 1);
  assert.strictEqual(result.tools[0].name, "navigation_go-to");
});

test("RelayServer.handleToolsList merges own tools after upstream tools", async () => {
  const relay = makeRelay();
  relay.registerOwnTool({
    name: "lighthouse_audit",
    description: "run lighthouse",
    inputSchema: { type: "object" },
    handler: async () => ({ content: [{ type: "text", text: "fake audit" }] }),
  });
  const result = await relay.handleToolsList();
  assert.strictEqual(result.tools.length, 2);
  assert.deepStrictEqual(result.tools.map((t) => t.name), ["navigation_go-to", "lighthouse_audit"]);
});

test("RelayServer.handleToolsCall forwards unknown tool to upstream", async () => {
  const relay = makeRelay();
  const result = await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "about:blank" } });
  assert.strictEqual(result.content[0].text, "forwarded navigation_go-to");
});

test("RelayServer.handleToolsCall routes own-tool to its handler", async () => {
  const relay = makeRelay();
  let calledWith = null;
  relay.registerOwnTool({
    name: "lighthouse_audit",
    description: "run lighthouse",
    inputSchema: { type: "object" },
    handler: async (args) => { calledWith = args; return { content: [{ type: "text", text: "ok" }] }; },
  });
  await relay.handleToolsCall({ name: "lighthouse_audit", arguments: { url: "https://example.com" } });
  assert.deepStrictEqual(calledWith, { url: "https://example.com" });
});

test("RelayServer.handleToolsCall returns isError=true when own-tool handler throws", async () => {
  const relay = makeRelay();
  relay.registerOwnTool({
    name: "broken_tool",
    description: "throws",
    inputSchema: { type: "object" },
    handler: async () => { throw new Error("intentional failure"); },
  });
  const result = await relay.handleToolsCall({ name: "broken_tool", arguments: {} });
  assert.strictEqual(result.isError, true);
  assert.ok(result.content[0].text.includes("intentional failure"));
});

test("RelayServer.registerOwnTool throws on duplicate name", () => {
  const relay = makeRelay();
  relay.registerOwnTool({ name: "x", description: "", inputSchema: {}, handler: async () => ({}) });
  assert.throws(
    () => relay.registerOwnTool({ name: "x", description: "", inputSchema: {}, handler: async () => ({}) }),
    /already registered/i,
  );
});

test("RelayServer.registerOwnTool throws when handler is not a function", () => {
  const relay = makeRelay();
  assert.throws(
    () => relay.registerOwnTool({ name: "x", description: "", inputSchema: {}, handler: "not a function" }),
    /must be a function/i,
  );
});

test("RelayServer.handleToolsList throws on collision between upstream and own tool", async () => {
  const relay = makeRelay();
  relay.registerOwnTool({
    name: "navigation_go-to",
    description: "shadow",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "ours" }] }),
  });
  await assert.rejects(
    relay.handleToolsList(),
    /collision/i,
  );
});

test("RelayServer constructor throws if getUpstream is not a function", () => {
  assert.throws(
    () => new RelayServer(),
    /getUpstream/,
  );
  assert.throws(
    () => new RelayServer({}),
    /getUpstream/,
  );
  assert.throws(
    () => new RelayServer({ getUpstream: "not a function" }),
    /getUpstream/,
  );
});

test("RelayServer constructor throws if ensureBrave is provided but not a function", () => {
  assert.throws(
    () => new RelayServer({ getUpstream: async () => {}, ensureBrave: "not a function" }),
    /ensureBrave/,
  );
});

test("RelayServer.handleToolsList does NOT call ensureBrave (cheap path)", async () => {
  const { relay, counters } = makeRelayWithBrave();
  await relay.handleToolsList();
  assert.strictEqual(counters.getUpstream, 1, "getUpstream should be called for tools/list");
  assert.strictEqual(counters.ensureBrave, 0, "ensureBrave must NOT fire on tools/list — that's the whole point of splitting");
});

test("RelayServer.handleToolsCall calls ensureBrave for own-tools", async () => {
  const { relay, counters } = makeRelayWithBrave();
  relay.registerOwnTool({
    name: "ours",
    description: "",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
  await relay.handleToolsCall({ name: "ours", arguments: {} });
  assert.strictEqual(counters.ensureBrave, 1, "ensureBrave should fire before own-tool handler");
});

test("RelayServer.handleToolsCall calls ensureBrave for forwarded tools", async () => {
  const { relay, counters } = makeRelayWithBrave();
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "about:blank" } });
  assert.strictEqual(counters.ensureBrave, 1, "ensureBrave should fire before forwarding to upstream");
  assert.strictEqual(counters.getUpstream, 1);
});

test("RelayServer works without ensureBrave (Brave-less mode for testing)", async () => {
  // Backwards-compat: if entrypoint passes only getUpstream, relay still works.
  // ensureBrave is just skipped on tools/call.
  const relay = new RelayServer({ getUpstream: async () => new FakeUpstream() });
  const result = await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  assert.strictEqual(result.content[0].text, "forwarded navigation_go-to");
});

test("RelayServer.handleToolsCall calls ensureBrave on EVERY invocation (no internal dedup — that's the entrypoint's job)", async () => {
  // Contract: RelayServer doesn't cache or dedup ensureBrave calls. The
  // entrypoint's promise-cached wrapper handles dedup. If a future refactor
  // ever moves dedup INTO RelayServer, this test breaks loudly so we don't
  // accidentally double-up dedup logic (or worse, lose it on the entrypoint
  // side).
  const { relay, counters } = makeRelayWithBrave();
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  assert.strictEqual(counters.ensureBrave, 3, "ensureBrave fires once per handleToolsCall — caller dedups, not RelayServer");
});

test("RelayServer.handleToolsCall calls ensureBrave BEFORE own-tool handler (ordering matters)", async () => {
  // Own-tool handlers read globalThis.__relayBridge, which is populated INSIDE
  // ensureBrave. If a future refactor moves ensureBrave to fire after the
  // handler, own-tools would see an empty bridge. Pin the ordering.
  const order = [];
  const relay = new RelayServer({
    getUpstream: async () => new FakeUpstream(),
    ensureBrave: async () => { order.push("ensureBrave"); },
  });
  relay.registerOwnTool({
    name: "ours",
    description: "",
    inputSchema: {},
    handler: async () => { order.push("handler"); return { content: [{ type: "text", text: "ok" }] }; },
  });
  await relay.handleToolsCall({ name: "ours", arguments: {} });
  assert.deepStrictEqual(order, ["ensureBrave", "handler"], "ensureBrave must complete before own-tool handler runs");
});

test("RelayServer.handleToolsCall calls ensureBrave BEFORE forwarding to upstream", async () => {
  // Upstream's tool handlers will lazily try chromium.connectOverCDP when their
  // first browser tool runs. Brave must be up first. ensureBrave must complete
  // before the forwarded tool/call is sent.
  const order = [];
  const upstream = {
    async request(method, params) {
      order.push(`upstream.${method}`);
      if (method === "tools/list") return { tools: [{ name: "navigation_go-to", description: "", inputSchema: {} }] };
      return { content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };
  const relay = new RelayServer({
    getUpstream: async () => upstream,
    ensureBrave: async () => { order.push("ensureBrave"); },
  });
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  assert.deepStrictEqual(order, ["ensureBrave", "upstream.tools/call"], "ensureBrave must complete before forwarding");
});

// ─── W10: trafficEmitter tests ─────────────────────────────────────────

test("RelayServer exposes a trafficEmitter by default", () => {
  const relay = makeRelay();
  assert.ok(relay.trafficEmitter, "trafficEmitter must always exist");
  assert.strictEqual(typeof relay.trafficEmitter.on, "function");
  assert.strictEqual(typeof relay.trafficEmitter.getRecent, "function");
});

test("RelayServer.handleToolsCall emits request + response events for forwarded tool", async () => {
  const relay = makeRelay();
  const events = [];
  relay.trafficEmitter.on("request", (e) => events.push({ kind: "request", ...e }));
  relay.trafficEmitter.on("response", (e) => events.push({ kind: "response", ...e }));
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "about:blank" } });
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].kind, "request");
  assert.strictEqual(events[0].name, "navigation_go-to");
  assert.strictEqual(events[0].source, "upstream");
  assert.strictEqual(events[1].kind, "response");
  assert.strictEqual(events[1].id, events[0].id, "request and response share id");
  assert.strictEqual(events[1].status, "ok");
  assert.strictEqual(typeof events[1].durationMs, "number");
});

test("RelayServer.handleToolsCall emits source=own for own-tool", async () => {
  const relay = makeRelay();
  const events = [];
  relay.trafficEmitter.on("request", (e) => events.push(e));
  relay.registerOwnTool({
    name: "ours",
    description: "",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
  await relay.handleToolsCall({ name: "ours", arguments: { x: 1 } });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].source, "own");
});

test("RelayServer.handleToolsCall emits status=error when own-tool returns isError", async () => {
  const relay = makeRelay();
  const events = [];
  relay.trafficEmitter.on("response", (e) => events.push(e));
  relay.registerOwnTool({
    name: "broken",
    description: "",
    inputSchema: {},
    handler: async () => { throw new Error("kaboom"); },
  });
  await relay.handleToolsCall({ name: "broken", arguments: {} });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].status, "error");
});

test("RelayServer.handleToolsCall pushes events into the ring buffer", async () => {
  const relay = makeRelay();
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  const recent = relay.trafficEmitter.getRecent();
  assert.strictEqual(recent.length, 2);
  assert.strictEqual(recent[0].name, "navigation_go-to");
  assert.strictEqual(recent[1].status, "ok");
  assert.strictEqual(recent[1].id, recent[0].id);
});

test("RelayServer trafficEmitter ring buffer caps at TRAFFIC_RING_CAPACITY", async () => {
  const ee = new TrafficEmitter();
  // Push 250 fake events directly. Ring should hold only the last 200.
  for (let i = 0; i < 250; i++) ee.push({ id: i, foo: "bar" });
  const recent = ee.getRecent();
  assert.strictEqual(recent.length, TRAFFIC_RING_CAPACITY);
  assert.strictEqual(recent[0].id, 50, "oldest event should be id=50 after 250 pushes with cap 200");
  assert.strictEqual(recent[recent.length - 1].id, 249);
});

test("truncateForEmit: returns value unchanged when under cap", () => {
  const small = { name: "x", payload: "hello" };
  assert.deepStrictEqual(truncateForEmit(small), small);
});

test("truncateForEmit: returns truncated string with marker for oversize values", () => {
  const big = { huge: "x".repeat(MAX_TRAFFIC_BODY_CHARS + 1000) };
  const out = truncateForEmit(big);
  assert.strictEqual(typeof out, "string");
  assert.ok(out.endsWith("[truncated]"));
  assert.ok(out.length <= MAX_TRAFFIC_BODY_CHARS, "truncated output must be ≤ MAX_TRAFFIC_BODY_CHARS");
});

test("RelayServer.handleToolsCall truncates oversized response in emit", async () => {
  // Upstream returns a huge response; relay should still return it intact to
  // the caller, but the emitted event payload must be truncated.
  const huge = "z".repeat(MAX_TRAFFIC_BODY_CHARS + 5000);
  const upstream = {
    async request(method) {
      if (method === "tools/list") return { tools: [{ name: "big_tool", description: "", inputSchema: {} }] };
      return { content: [{ type: "text", text: huge }] };
    },
    close() {},
  };
  const relay = new RelayServer({ getUpstream: async () => upstream });
  const events = [];
  relay.trafficEmitter.on("response", (e) => events.push(e));
  const callerSawResponse = await relay.handleToolsCall({ name: "big_tool", arguments: {} });
  // Caller still gets the full response.
  assert.strictEqual(callerSawResponse.content[0].text.length, huge.length);
  // Inspector sees the truncated marker.
  assert.strictEqual(events.length, 1);
  assert.strictEqual(typeof events[0].response, "string");
  assert.ok(events[0].response.endsWith("[truncated]"));
});

test("RelayServer accepts an injected trafficEmitter", async () => {
  const ee = new TrafficEmitter();
  const relay = new RelayServer({
    getUpstream: async () => ({
      async request(method) {
        if (method === "tools/list") return { tools: [{ name: "t", description: "", inputSchema: {} }] };
        return { content: [{ type: "text", text: "ok" }] };
      },
      close() {},
    }),
    trafficEmitter: ee,
  });
  assert.strictEqual(relay.trafficEmitter, ee);
  await relay.handleToolsCall({ name: "t", arguments: {} });
  assert.strictEqual(ee.getRecent().length, 2);
});

test("RelayServer.handleToolsCall ids increment across calls", async () => {
  const relay = makeRelay();
  const ids = [];
  relay.trafficEmitter.on("request", (e) => ids.push(e.id));
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  assert.strictEqual(ids.length, 3);
  assert.ok(ids[1] > ids[0]);
  assert.ok(ids[2] > ids[1]);
});

// ─── W11: subscriber-throws-mid-emit safety ──────────────────────────

test("RelayServer.handleToolsCall: a throwing subscriber must not bubble out", async () => {
  // A buggy/disconnected Inspector subscriber should NOT take out a tool
  // call. The relay catches emit() throws on both the request and response
  // emit paths.
  const relay = makeRelay();
  relay.trafficEmitter.on("request", () => { throw new Error("subscriber boom (request)"); });
  relay.trafficEmitter.on("response", () => { throw new Error("subscriber boom (response)"); });

  const result = await relay.handleToolsCall({
    name: "navigation_go-to",
    arguments: { url: "about:blank" },
  });
  // Caller should see the upstream's normal response, NOT the subscriber error.
  assert.strictEqual(result.content[0].text, "forwarded navigation_go-to");
});

test("RelayServer.handleToolsCall: throwing subscriber on error path also doesn't bubble", async () => {
  // Forwarded tool path that throws — the catch block emits a response
  // event with the error, then rethrows. A throwing subscriber on THAT
  // emit must not mask the original error.
  const upstream = {
    async request(method) {
      if (method === "tools/list") return { tools: [{ name: "x", description: "", inputSchema: {} }] };
      throw new Error("upstream-down");
    },
    close() {},
  };
  const relay = new RelayServer({ getUpstream: async () => upstream });
  relay.trafficEmitter.on("response", () => { throw new Error("subscriber boom"); });
  await assert.rejects(
    () => relay.handleToolsCall({ name: "x", arguments: {} }),
    /upstream-down/,
  );
});

test("RelayServer.handleToolsList retries ONCE on \"client closed\" (upstream restarted mid-list)", async () => {
  let calls = 0;
  const closed = { request: async () => { throw new Error("client closed"); } };
  const relay = new RelayServer({ getUpstream: async () => (++calls === 1 ? closed : new FakeUpstream()) });
  const result = await relay.handleToolsList();
  assert.strictEqual(calls, 2);
  assert.strictEqual(result.tools[0].name, "navigation_go-to");
});

test("RelayServer.handleToolsList does NOT retry other upstream errors", async () => {
  for (const msg of ["upstream closed", "upstream request timed out after 180000ms: tools/list", "spawn failed"]) {
    let calls = 0;
    const relay = new RelayServer({
      getUpstream: async () => { calls++; return { request: async () => { throw new Error(msg); } }; },
    });
    await assert.rejects(relay.handleToolsList(), new RegExp(msg.slice(0, 15)));
    assert.strictEqual(calls, 1, `retried on "${msg}"`);
  }
});
