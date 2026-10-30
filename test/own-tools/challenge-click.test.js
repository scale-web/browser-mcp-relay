// challenge-click.test.js — challenge_click (spec v8 §5.6 (8)) against fake
// pages: no widget / an invisible widget / a spent click send NO input; a
// visible widget gets exactly one moved-pressed-released sequence at the box
// plus the offset, and the host's click is spent BEFORE the input is sent.
// The real nested-frame, closed-shadow-root, isTrusted case:
// test/isolated-plainflags.test.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tool = require("../../src/own-tools/challenge-click.js");
const { createClickCounter } = require("../../src/challenge-clicks.js");
const { setActivePage, clearActivePage } = require("../../src/own-tools/_active-page.js");

function setup({ frames = [], box = { x: 100, y: 500, width: 300, height: 65 }, tokenAfterClick = 0 } = {}) {
  const sent = [];
  const token = { len: 0 };
  const main = { url: () => "https://go.example.com/form", parentFrame: () => null };
  const form = { url: () => "https://api.leadconnectorhq.com/widget/form/x", parentFrame: () => main, evaluate: async () => [token.len], frameElement: async () => ({ scrollIntoViewIfNeeded: async () => { sent.push("scroll-form"); }, boundingBox: async () => ({ x: 50, y: 400, width: 600, height: 400 }) }) };
  const chl = (b) => ({ url: () => "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x", parentFrame: () => form,
    frameElement: async () => ({ scrollIntoViewIfNeeded: async () => { sent.push("scroll-chl"); }, boundingBox: async () => b }) });
  const all = [main, ...(frames.length ? frames.map((f) => (f === "chl" ? chl(box) : f === "tiny" ? chl({ x: 0, y: 0, width: 1, height: 1 }) : f)) : []), form];
  const page = { url: () => "https://go.example.com/form", mainFrame: () => main, frames: () => all, isClosed: () => false, once() {} };
  const order = [];
  const context = {
    pages: () => [page],
    newCDPSession: async () => ({ send: async (m, p) => { order.push("input"); sent.push([m, p]); if (p.type === "mouseReleased") token.len = tokenAfterClick; }, detach: async () => {} }),
  };
  globalThis.__relayBridge = { context };
  clearActivePage();
  setActivePage(page);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cclick-"));
  const counter = createClickCounter({ root: dir });
  const spy = { claim: (h, l) => { order.push("claim"); return counter.claim(h, l); }, spent: counter.spent, count: counter.count };
  tool.configure({ counter: spy });
  tool._setDeps({ afterWaitMs: 300 });
  return { sent, order, counter };
}
const body = (r) => JSON.parse(r.content[0].text);
const inputs = (sent) => sent.filter((s) => Array.isArray(s) && s[0] === "Input.dispatchMouseEvent");

test.after(() => { globalThis.__relayBridge = null; tool.configure({}); });

test("no challenge frame mounted → refused, widget: absent, NO input sent, no click spent", async () => {
  const { sent, counter } = setup();
  const r = await tool.handler({ lane: "L" });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(body(r).widget, "absent");
  assert.deepStrictEqual(inputs(sent), []);
  assert.strictEqual(counter.spent("go.example.com"), false);
});

test("an INVISIBLE-mode widget (1×1, as measured on the GHL form) → refused, widget: invisible, no input, no click spent", async () => {
  const { sent, counter } = setup({ frames: ["tiny"] });
  const r = await tool.handler({ lane: "L" });
  assert.strictEqual(body(r).widget, "invisible");
  assert.deepStrictEqual(inputs(sent), []);
  assert.strictEqual(counter.spent("go.example.com"), false);
});

test("a visible widget in a nested frame → owners scrolled innermost-out, ONE moved/pressed/released sequence at box + offset; the click is spent FIRST", async () => {
  const { sent, order, counter } = setup({ frames: ["chl"] });
  const r = await tool.handler({ lane: "L" });
  assert.ok(!r.isError, r.content[0].text);
  const b = body(r);
  assert.deepStrictEqual([b.clicked, b.frameDepth], [true, 2]);
  assert.deepStrictEqual(sent.filter((s) => typeof s === "string"), ["scroll-chl", "scroll-form"]);
  const ev = inputs(sent).map(([, p]) => [p.type, p.x, p.y, p.button]);
  assert.deepStrictEqual(ev, [["mouseMoved", 130, 532.5, "none"], ["mousePressed", 130, 532.5, "left"], ["mouseReleased", 130, 532.5, "left"]]);
  assert.strictEqual(order[0], "claim", "spent before any input");
  assert.strictEqual(counter.spent("go.example.com"), true);
  // the second call for the host is refused — and sends nothing
  const before = inputs(sent).length;
  const r2 = await tool.handler({ lane: "L" });
  assert.strictEqual(r2.isError, true);
  assert.match(body(r2).refused, /last 10 min/);
  assert.strictEqual(inputs(sent).length, before);
});

test("without the shared count configured (never the case in the plain-flags relay) → refused, no input", async () => {
  const { sent } = setup({ frames: ["chl"] });
  tool.configure({});
  const r = await tool.handler({});
  assert.strictEqual(r.isError, true);
  assert.deepStrictEqual(inputs(sent), []);
});

test("round 1 item 5: the result says whether a token came — passed:false with the token lengths when none did; passed:true when one did", async () => {
  let { sent } = setup({ frames: ["chl"], tokenAfterClick: 0 });
  let b = body(await tool.handler({ lane: "L" }));
  assert.deepStrictEqual([b.clicked, b.passed, b.tokenBefore, b.tokenAfter], [true, false, [0], [0]]);
  assert.match(b.note, /No token after the click — do not click again/);
  assert.strictEqual(inputs(sent).length, 3);
  ({ sent } = setup({ frames: ["chl"], tokenAfterClick: 752 }));
  b = body(await tool.handler({ lane: "L" }));
  assert.deepStrictEqual([b.passed, b.tokenAfter], [true, [752]]);
  assert.ok(!JSON.stringify(b).includes("TOKEN"), "lengths only");
});

test("measured offsets (2026-10-30, Cloudflare test sitekey): normal 300×65 → (30, h/2); compact 150×140 → exactly (24, 28)", async () => {
  assert.deepStrictEqual(tool.clickPoint({ x: 0, y: 0, width: 300, height: 65 }), { layout: "normal", dx: 30, dy: 32.5 });
  assert.deepStrictEqual(tool.clickPoint({ x: 0, y: 0, width: 150, height: 140 }), { layout: "compact", dx: 24, dy: 28 });
  const { sent } = setup({ frames: ["chl"], box: { x: 100, y: 300, width: 150, height: 140 } });
  const b = body(await tool.handler({ lane: "L" }));
  assert.strictEqual(b.layout, "compact");
  assert.deepStrictEqual(inputs(sent).map(([, p]) => [p.x, p.y]), [[124, 328], [124, 328], [124, 328]]);
  assert.match(b.offset.source, /measured 2026-10-30/);
});
