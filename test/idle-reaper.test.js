// idle-reaper.test.js — coverage for the 2026-07-16 RAM-footprint fixes:
//   - closeBraveHard (real termination, incl. attached handles via CDP)
//   - idle reaper wiring in index.js (env knob, unref'd timer, activity bumps)
//   - stdin-close shutdown (no zombie relays when the MCP client dies)

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const INDEX_SRC = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");

// ───── closeBraveHard ─────

test("cdp-bridge exports closeBraveHard", () => {
  const bridge = require("../src/cdp-bridge.js");
  assert.strictEqual(typeof bridge.closeBraveHard, "function");
});

test("closeBraveHard terminates ATTACHED browsers via CDP Browser.close", async () => {
  const { closeBraveHard } = require("../src/cdp-bridge.js");
  const sent = [];
  let contextClosed = 0;
  await closeBraveHard({
    attached: true,
    browser: {
      newBrowserCDPSession: async () => ({ send: async (m) => { sent.push(m); } }),
      close: async () => { throw new Error("should not fall back when CDP works"); },
    },
    context: { close: async () => { contextClosed++; } },
  });
  assert.deepStrictEqual(sent, ["Browser.close"], "must send CDP Browser.close");
  assert.strictEqual(contextClosed, 0);
});

test("closeBraveHard falls back to disconnect when the CDP session fails", async () => {
  const { closeBraveHard } = require("../src/cdp-bridge.js");
  let disconnected = 0;
  await closeBraveHard({
    attached: true,
    browser: {
      newBrowserCDPSession: async () => { throw new Error("no cdp"); },
      close: async () => { disconnected++; },
    },
    context: { close: async () => {} },
  });
  assert.strictEqual(disconnected, 1);
});

test("closeBraveHard closes LAUNCHED browsers via context.close", async () => {
  const { closeBraveHard } = require("../src/cdp-bridge.js");
  let contextClosed = 0;
  await closeBraveHard({ context: { close: async () => { contextClosed++; } } });
  assert.strictEqual(contextClosed, 1);
});

test("closeBraveHard never throws (null handle, throwing close)", async () => {
  const { closeBraveHard } = require("../src/cdp-bridge.js");
  await closeBraveHard(null);
  await closeBraveHard({ context: { close: async () => { throw new Error("boom"); } } });
});

// ───── idle reaper wiring (source-slice, matching the repo's style) ─────

test("index.js arms an idle reaper from BROWSER_RELAY_IDLE_MINUTES with a 45min default", () => {
  assert.ok(/BROWSER_RELAY_IDLE_MINUTES/.test(INDEX_SRC));
  assert.ok(/\?\s*45\s*$/m.test(INDEX_SRC) || /:\s*45\b/.test(INDEX_SRC), "default must be 45 minutes");
  assert.ok(/tick\.unref\(\)/.test(INDEX_SRC), "reaper interval must be unref'd");
});

test("idle reaper uses closeBraveHard (attached Braves must actually die)", () => {
  assert.ok(/idleReapBrave[\s\S]{0,400}closeBraveHard\(/.test(INDEX_SRC));
});

test("idle upstream reap clears state BEFORE killing (deliberate-restart pattern)", () => {
  const fn = INDEX_SRC.slice(INDEX_SRC.indexOf("function idleReapUpstream"), INDEX_SRC.indexOf("async function idleReapBrave"));
  const clearIdx = fn.indexOf("upstreamChild = null");
  const killIdx = fn.indexOf("killUpstreamTree(oldChild)");
  assert.ok(clearIdx !== -1 && killIdx !== -1 && clearIdx < killIdx,
    "state must be cleared before the kill so the exit handler sees a deliberate restart");
});

test("both MCP request handlers bump activity on entry and exit", () => {
  const matches = INDEX_SRC.match(/bumpActivity\(\)/g) || [];
  assert.ok(matches.length >= 4, `expected ≥4 bumpActivity() call sites (2 handlers × entry+exit), got ${matches.length}`);
});

// ───── stdin-close shutdown ─────

test("index.js shuts down when stdin ends or closes (no zombie relays)", () => {
  assert.ok(/process\.stdin\.on\("end"/.test(INDEX_SRC), "must handle stdin end");
  assert.ok(/process\.stdin\.on\("close"/.test(INDEX_SRC), "must handle stdin close");
  assert.ok(/onStdioGone[\s\S]{0,300}shutdownAsync\(\)/.test(INDEX_SRC), "stdio-gone path must run full shutdown");
});
