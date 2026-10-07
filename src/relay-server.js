// relay-server.js — the MCP server that Cursor talks to. Forwards tools/call
// to upstream OR to our own-tool handlers based on the tool name. Merges
// upstream's tools/list with our own tool list.
//
// Two async dependencies (both injected by the entrypoint):
//   - getUpstream(): returns the upstream MCP client. Called by tools/list
//     AND tools/call. Cheap once cached. Spawning upstream is fast (~50MB
//     node process); upstream's tools/list returns its static catalog
//     without needing a browser.
//   - ensureBrave(): launches our Brave instance via Playwright. Slow
//     (~3-5s, ~250MB). Called ONLY by tools/call (own-tools need the
//     globalThis.__relayBridge handle; forwarded tools need Brave running
//     so upstream's lazy `chromium.connectOverCDP` succeeds when its tool
//     handler runs).
//
// Splitting these means tools/list (Cursor's first call at MCP connect)
// does NOT trigger Brave launch. Brave only spins up when something
// actually needs to drive a browser.
//
// W10: trafficEmitter — every handleToolsCall fires `request` and `response`
// events. The in-process Inspector subscribes to these for live traffic
// streaming. Standalone Inspector ignores it (no subscriber). The emitter
// also keeps a 200-event ring buffer so new WS subscribers can backfill
// without missing context.

const { EventEmitter } = require("node:events");

// Cap each emitted event's response body at this size (in JSON-stringified
// chars). capture_xhr / lighthouse_audit can return MB-scale responses;
// streaming those over WS to N subscribers + holding them in the 200-event
// ring buffer would balloon memory. The full body is still returned to the
// MCP client — this cap only affects what the Inspector sees.
const MAX_TRAFFIC_BODY_CHARS = 10_000;
// Ring-buffer capacity. 200 events ~= 2-3 minutes of normal use.
const TRAFFIC_RING_CAPACITY = 200;
const TRUNCATED_MARKER = "[truncated]";

/** Truncate a JSON-serializable value's stringified form to MAX chars. We
 *  serialize, slice, then return either the original (if short) or a string
 *  with the truncation marker. The Inspector renders this verbatim — no
 *  re-parse. */
function truncateForEmit(value, max = MAX_TRAFFIC_BODY_CHARS) {
  if (value == null) return value;
  let s;
  try { s = JSON.stringify(value); }
  catch { return { error: "[unserializable]" }; }
  if (s.length <= max) return value;
  return s.slice(0, max - TRUNCATED_MARKER.length) + TRUNCATED_MARKER;
}

class TrafficEmitter extends EventEmitter {
  constructor({ capacity = TRAFFIC_RING_CAPACITY } = {}) {
    super();
    // Lift the default listener cap so multiple WS subscribers don't trip
    // Node's "MaxListenersExceededWarning". 50 is plenty for an inspector
    // that only ever has one or two browser tabs open.
    this.setMaxListeners(50);
    this.capacity = capacity;
    this._ring = []; // ordered oldest → newest
    this._nextId = 1;
  }
  nextId() { return this._nextId++; }
  push(evt) {
    this._ring.push(evt);
    if (this._ring.length > this.capacity) {
      this._ring.splice(0, this._ring.length - this.capacity);
    }
  }
  getRecent() { return this._ring.slice(); }
}

class RelayServer {
  constructor({ getUpstream, ensureBrave, trafficEmitter } = {}) {
    if (typeof getUpstream !== "function") {
      throw new Error("RelayServer: constructor expects { getUpstream } async function");
    }
    if (ensureBrave != null && typeof ensureBrave !== "function") {
      throw new Error("RelayServer: ensureBrave, if provided, must be an async function");
    }
    this.getUpstream = getUpstream;
    this.ensureBrave = ensureBrave || null;
    this.ownTools = new Map(); // name → { name, description, inputSchema, handler }
    // Traffic emitter is always present so call sites don't need null-guards.
    // If the caller doesn't pass one, we make our own (no subscribers = no
    // visible behavior change).
    this.trafficEmitter = trafficEmitter || new TrafficEmitter();
  }

  registerOwnTool({ name, description, inputSchema, handler }) {
    if (this.ownTools.has(name)) {
      throw new Error(`relay: tool "${name}" already registered`);
    }
    if (typeof handler !== "function") {
      throw new Error(`relay: tool "${name}" handler must be a function`);
    }
    this.ownTools.set(name, { name, description, inputSchema, handler });
  }

  async handleToolsList() {
    // tools/list does NOT need Brave. Upstream's catalog is static (registered
    // at upstream startup), and own-tool definitions are static. We only need
    // upstream spawned to ask it for its catalog — that's it.
    let upstreamResponse;
    try {
      upstreamResponse = await (await this.getUpstream()).request("tools/list", {});
    } catch (e) {
      // A Brave relaunch restarts the upstream child (index.js
      // restartUpstreamIfStale) and closes its client, which rejects a
      // tools/list still in flight with "client closed". tools/list is
      // idempotent and needs no Brave, so ask the replacement child once.
      // During shutdown the closed client stays installed, so this retry
      // fails fast instead of spawning a new child.
      if (!e || e.message !== "client closed") throw e;
      upstreamResponse = await (await this.getUpstream()).request("tools/list", {});
    }
    const upstreamTools = upstreamResponse.tools || [];
    const ownTools = Array.from(this.ownTools.values()).map(({ name, description, inputSchema }) => ({
      name, description, inputSchema,
    }));
    for (const ours of ownTools) {
      if (upstreamTools.some((u) => u.name === ours.name)) {
        throw new Error(
          `relay: tool name collision — upstream and relay both expose "${ours.name}". Rename the relay tool or remove the upstream one.`,
        );
      }
    }
    return { tools: [...upstreamTools, ...ownTools] };
  }

  async handleToolsCall({ name, arguments: args }) {
    const own = this.ownTools.get(name);
    const isOwn = !!own;
    const id = this.trafficEmitter.nextId();
    const startTime = Date.now();
    const startHr = process.hrtime.bigint();

    // Emit `request` BEFORE forwarding/handling. Inspector buffers this so
    // the activity feed can show "in-flight" until the response lands.
    const requestEvent = {
      id,
      time: new Date(startTime).toISOString(),
      method: "tools/call",
      name,
      args: truncateForEmit(args || {}),
      source: isOwn ? "own" : "upstream",
    };
    this.trafficEmitter.push(requestEvent);
    // emit() throws back to the caller if a listener throws — wrap in
    // try/catch so a busted Inspector subscriber can't take out a tool call.
    try { this.trafficEmitter.emit("request", requestEvent); }
    catch (emitErr) {
      // V1-5: don't drop subscriber errors silently — a broken Inspector
      // subscriber is a real bug we want to see in stderr, not invisible.
      try {
        process.stderr.write(`[mcp-relay] traffic-emitter "request" subscriber threw: ${emitErr.stack || emitErr.message}\n`);
      } catch { /* stderr itself is gone — give up */ }
    }

    let status = "ok";
    let response;
    try {
      if (isOwn) {
        // Own-tool handlers read globalThis.__relayBridge. ensureBrave
        // populates that. Always call it before invoking the handler.
        if (this.ensureBrave) await this.ensureBrave();
        try {
          response = await own.handler(args || {});
        } catch (e) {
          response = {
            content: [{ type: "text", text: `[mcp-relay] tool "${name}" failed: ${e.message}` }],
            isError: true,
          };
        }
      } else {
        // Forwarded — upstream lazily attaches via CDP. Brave must be up first.
        if (this.ensureBrave) await this.ensureBrave();
        const upstream = await this.getUpstream();
        response = await upstream.request("tools/call", { name, arguments: args });
      }
      if (response && response.isError) status = "error";
    } catch (e) {
      // Forwarded-path failures bubble up as caller errors. Record + rethrow.
      status = "error";
      const durationMs = Number(process.hrtime.bigint() - startHr) / 1_000_000;
      const responseEvent = {
        id,
        time: new Date().toISOString(),
        status,
        durationMs,
        response: truncateForEmit({ error: e.message }),
      };
      this.trafficEmitter.push(responseEvent);
      try { this.trafficEmitter.emit("response", responseEvent); }
    catch (emitErr) {
      // V1-5: surface subscriber errors instead of swallowing.
      try {
        process.stderr.write(`[mcp-relay] traffic-emitter "response" subscriber threw: ${emitErr.stack || emitErr.message}\n`);
      } catch { /* stderr itself is gone */ }
    }
      throw e;
    }

    const durationMs = Number(process.hrtime.bigint() - startHr) / 1_000_000;
    const responseEvent = {
      id,
      time: new Date().toISOString(),
      status,
      durationMs,
      response: truncateForEmit(response),
    };
    this.trafficEmitter.push(responseEvent);
    try { this.trafficEmitter.emit("response", responseEvent); }
    catch (emitErr) {
      // V1-5: surface subscriber errors instead of swallowing.
      try {
        process.stderr.write(`[mcp-relay] traffic-emitter "response" subscriber threw: ${emitErr.stack || emitErr.message}\n`);
      } catch { /* stderr itself is gone */ }
    }

    return response;
  }
}

module.exports = { RelayServer, TrafficEmitter, truncateForEmit, MAX_TRAFFIC_BODY_CHARS, TRAFFIC_RING_CAPACITY };
