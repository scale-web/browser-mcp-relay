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
const metaGuard = require("./meta-guard.js");
const sync = require("./own-tools/_upstream-sync.js");

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
  constructor({ getUpstream, ensureBrave, trafficEmitter, takeNotices } = {}) {
    if (typeof getUpstream !== "function") {
      throw new Error("RelayServer: constructor expects { getUpstream } async function");
    }
    if (ensureBrave != null && typeof ensureBrave !== "function") {
      throw new Error("RelayServer: ensureBrave, if provided, must be an async function");
    }
    this.getUpstream = getUpstream;
    this.ensureBrave = ensureBrave || null;
    // takeNotices(): string[] — texts to put in front of the next tool result
    // as separate leading `text` items (mode changes, Meta-guard blocks). Only
    // consumed when a result is actually returned, so a thrown call never
    // swallows one.
    this.takeNotices = typeof takeNotices === "function" ? takeNotices : () => [];
    this.ownTools = new Map(); // name → { name, description, inputSchema, handler, needsBrave }
    // Traffic emitter is always present so call sites don't need null-guards.
    // If the caller doesn't pass one, we make our own (no subscribers = no
    // visible behavior change).
    this.trafficEmitter = trafficEmitter || new TrafficEmitter();
  }

  registerOwnTool({ name, description, inputSchema, handler, needsBrave = true }) {
    if (this.ownTools.has(name)) {
      throw new Error(`relay: tool "${name}" already registered`);
    }
    if (typeof handler !== "function") {
      throw new Error(`relay: tool "${name}" handler must be a function`);
    }
    this.ownTools.set(name, { name, description, inputSchema, handler, needsBrave: needsBrave !== false });
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
      // During shutdown getUpstream() refuses to spawn (index.js
      // relayShuttingDown), so this retry fails fast instead of starting a
      // child. Only "client closed" is retried: a timeout, a spawn failure or
      // "upstream closed" (the child died) must surface, not double.
      if (!e || e.message !== "client closed") throw e;
      upstreamResponse = await (await this.getUpstream()).request("tools/list", {});
    }
    // Guarded upstream tools (_upstream-sync.js rule B) take the relay-only
    // opt-in; advertise it so a caller can find it. The relay strips it before
    // forwarding.
    const upstreamTools = (upstreamResponse.tools || []).map((t) => {
      if (!sync.isGuarded(t.name)) return t;
      const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object" };
      return {
        ...t,
        inputSchema: {
          ...schema,
          properties: {
            ...(schema.properties || {}),
            [sync.OPT_IN]: {
              type: "boolean",
              description: "Relay-only. Run even though tabs_select / tabs_new could not point upstream's tab at the selected one (the relay then refuses this tool and says why). Acts on upstream's tab, not the selected one.",
            },
          },
        },
      };
    });
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
      // Meta guard layer 1 (spec v4 §1d): refuse Meta URLs and Meta cookies
      // before any browser work — the agent gets the route, not a 403 page.
      const blocked = metaGuard.checkToolArgs(name, args);
      if (blocked) {
        response = blocked;
      } else if (isOwn) {
        // Own-tool handlers read globalThis.__relayBridge. ensureBrave
        // populates that — except for tools that never touch the browser
        // (needsBrave: false, e.g. relay_status), which must not launch one.
        if (this.ensureBrave && own.needsBrave) await this.ensureBrave();
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
        // Rule B (_upstream-sync.js): while upstream's tab is not the selected
        // one, a tool that changes the page is refused unless opted in.
        // Checked after ensureBrave()/getUpstream(): a Brave relaunch respawns
        // upstream, which pins a fresh page and clears the old desync.
        const { args: fwdArgs, optIn } = sync.stripOptIn(args);
        const guarded = sync.isGuarded(name);
        if (this.ensureBrave) await this.ensureBrave();
        const upstream = await this.getUpstream();
        if (guarded && sync.isDesynced() && !optIn) {
          response = sync.refusal(name);
        } else {
          const before = guarded ? await sync.readUpstreamUrl() : null;
          const t0 = Date.now();
          response = await upstream.request("tools/call", { name, arguments: fwdArgs });
          if (guarded) await sync.afterGuardedCall({ before, name, optIn, ms: Date.now() - t0 });
          // Rule A: every upstream result says so while upstream's tab is not
          // the selected one.
          const warn = sync.warning();
          if (warn && response && Array.isArray(response.content)) {
            response = { ...response, content: [{ type: "text", text: warn }, ...response.content] };
          }
        }
      }
      if (response && response.isError) status = "error";
      const notices = response && Array.isArray(response.content) ? this.takeNotices() : [];
      if (notices.length > 0) {
        response = { ...response, content: [...notices.map((text) => ({ type: "text", text })), ...response.content] };
      }
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
