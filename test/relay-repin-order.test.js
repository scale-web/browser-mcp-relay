// Review r1 L2: a forwarded call re-pins upstream to the selected tab BEFORE the
// policy checks upstream's page (plain-flags' field check of interaction_fill /
// select / press-key), and a tabs_select cannot move the pin between that check
// and the call it allows — forwarded calls hold the pin shared, tabs_new /
// tabs_select take it exclusive (src/own-tools/_pin-lock.js).
const test = require("node:test");
const assert = require("node:assert");
const { RelayServer } = require("../src/relay-server.js");
const tabsSelect = require("../src/own-tools/tabs-select.js");
const quiet = require("../src/own-tools/_quiet-focus.js");
const { setActivePage, clearActivePage } = require("../src/own-tools/_active-page.js");
const { fakeUpstream, fakeTab, fakeContext } = require("./fixtures/fake-upstream-page.js");
const pinLock = require("../src/own-tools/_pin-lock.js");
require("../src/request-body-filter.js").setSourcePatchInEffect(true);

const T = { timeout: 10000 }; // a leaked hold fails here instead of hanging the suite

function setup(t, { gate = null } = {}) {
  const a = fakeTab("https://a.example/");
  const b = fakeTab("https://b.example/form");
  clearActivePage();
  globalThis.__relayBridge = { context: fakeContext([a, b]) };
  // A restarted upstream: on its own fresh blank (no target id the relay knows).
  const up = fakeUpstream({ url: "about:blank" });
  const restore = up.install();
  const origFront = quiet.braveIsFront;
  quiet.braveIsFront = async () => false;
  const events = [];
  // Upstream's interaction_fill: records the tab it acts on when it starts and when it ends.
  const client = {
    request: async (method, params) => {
      if (params && params.name === "interaction_fill") {
        events.push(`fill-start:${up.targetId}`);
        if (gate) await gate;
        events.push(`fill-end:${up.targetId}`);
      }
      return up.client.request(method, params);
    },
  };
  const checked = [];
  const policy = {
    filterToolsList: (x) => x,
    async beforeCall(name, args, ctx) {
      if (args && args.refuseMe) return { refusal: { isError: true, content: [{ type: "text", text: "refused" }] } };
      await ctx.ensureBrave();
      if (name === "interaction_fill") checked.push(up.targetId); // what plain-flags' field check reads
      return { args };
    },
    async afterCall(name, response) { return response; },
  };
  const relay = new RelayServer({ getUpstream: async () => client, ensureBrave: async () => {}, policy });
  relay.registerOwnTool(tabsSelect);
  t.after(() => { restore(); quiet.braveIsFront = origFront; clearActivePage(); globalThis.__relayBridge = undefined; });
  return { a, b, up, relay, events, checked };
}

test("forwarded call: upstream is re-pinned to the selected tab before the policy checks upstream's page", T, async (t) => {
  const { b, up, relay, events, checked } = setup(t);
  setActivePage(b); // selected before upstream restarted
  const r = await relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: "#q", value: "x" } });
  assert.notStrictEqual(r.isError, true, JSON.stringify(r));
  assert.deepStrictEqual(checked, [b.tid], "the check read the selected tab, not upstream's fresh blank");
  assert.deepStrictEqual(events, [`fill-start:${b.tid}`, `fill-end:${b.tid}`]);
  assert.strictEqual(up.pins().length, 1, "one pin: the second look finds upstream already there");
  const refused = await relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: "#q", value: "x", refuseMe: true } });
  assert.strictEqual(refused.isError, true);
  (await pinLock.exclusive())(); // every shared hold was released, the refused call's too
});

test("forwarded call: a parallel tabs_select waits for it, so the check and the fill run on one tab", T, async (t) => {
  let open;
  const gate = new Promise((r) => { open = r; });
  const { a, b, up, relay, events, checked } = setup(t, { gate });
  setActivePage(b);
  const fill = relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: "#q", value: "x" } });
  for (const end = Date.now() + 5000; !events.length && Date.now() < end;) await new Promise((r) => setTimeout(r, 5));
  assert.ok(events.length, "the fill reached upstream");
  const select = relay.handleToolsCall({ name: "tabs_select", arguments: { index: 0 } }); // a
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(up.targetId, b.tid, "the pin did not move while the fill ran");
  open();
  const [rf, rs] = await Promise.all([fill, select]);
  assert.notStrictEqual(rf.isError, true, JSON.stringify(rf));
  assert.notStrictEqual(rs.isError, true, JSON.stringify(rs));
  assert.deepStrictEqual(checked, [b.tid]);
  assert.deepStrictEqual(events, [`fill-start:${b.tid}`, `fill-end:${b.tid}`], "checked on B, filled on B");
  assert.strictEqual(up.targetId, a.tid, "then tabs_select pinned A");
});

test("pin lock: shared holds run together; an exclusive waits for them and goes before later shared ones", T, async () => {
  const lock = pinLock;
  const order = [];
  const r1 = await lock.shared();
  const r2 = await lock.shared();
  const w = lock.exclusive().then((rel) => { order.push("exclusive"); return rel; });
  const r3p = lock.shared().then((rel) => { order.push("late shared"); return rel; });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(order, [], "the exclusive waits for both shared holds; the late shared waits behind it");
  r1(); r2(); r2(); // a second release is a no-op
  const wr = await w;
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(order, ["exclusive"]);
  wr();
  (await r3p)();
  assert.deepStrictEqual(order, ["exclusive", "late shared"]);
  (await lock.exclusive())(); // nothing left held
  // A second release of a shared hold does not release someone else's.
  const s1 = await lock.shared();
  s1(); s1();
  const s2 = await lock.shared();
  let got = false;
  const ex = lock.exclusive().then((rel) => { got = true; return rel; });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(got, false, "the exclusive still waits for s2");
  s2();
  (await ex)();
});
