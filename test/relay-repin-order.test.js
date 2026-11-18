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

const T = { timeout: 10000 };
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: still pending after ${ms} ms`)), ms))]); // a leaked hold fails here instead of hanging the suite

function setup(t, { gate = null, throwFill = false, ensureBrave = async () => {}, pinWaitMs } = {}) {
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
        if (throwFill) throw new Error("upstream fill failed");
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
  const relay = new RelayServer({ getUpstream: async () => client, ensureBrave, policy, ...(pinWaitMs ? { pinWaitMs } : {}) });
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

// ───── review of 140cf47 (2026-11-17), L3 and L5 ─────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The lock is free: an exclusive is granted at once (a leaked hold rejects in 500 ms). */
async function lockIsFree() {
  (await pinLock.exclusive({ label: "test", waitMs: 500 }))();
}

test("L5: a forwarded call that throws still releases its pin hold", T, async (t) => {
  const { b, relay } = setup(t, { throwFill: true });
  setActivePage(b);
  await assert.rejects(relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: "#q", value: "x" } }), /upstream fill failed/);
  await lockIsFree();
});

test("L3: a tabs_select behind a hung forwarded call is refused after the bound, naming that call; the pin does not move", T, async (t) => {
  let open;
  const gate = new Promise((r) => { open = r; });
  const { b, up, relay, events } = setup(t, { gate, pinWaitMs: 300 });
  setActivePage(b);
  const fill = relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: "#q", value: "x" } });
  for (const end = Date.now() + 5000; !events.length && Date.now() < end;) await sleep(5);
  const t0 = Date.now();
  const rs = await relay.handleToolsCall({ name: "tabs_select", arguments: { index: 0 } });
  assert.ok(Date.now() - t0 < 3000, `refused at the bound (${Date.now() - t0} ms)`);
  assert.strictEqual(rs.isError, true, JSON.stringify(rs));
  const msg = rs.content.map((c) => c.text).join("\n");
  assert.match(msg, /REFUSED/);
  assert.match(msg, /interaction_fill \(running \d+ s\)/, msg);
  assert.strictEqual(up.targetId, b.tid, "the pin did not move");
  // Upstream calls are not held back by the refused tabs_select.
  const later = relay.handleToolsCall({ name: "content_get-as-text", arguments: {} });
  assert.notStrictEqual((await within(later, 2000, "a later forwarded call")).isError, true);
  open();
  await fill;
  const ok = await relay.handleToolsCall({ name: "tabs_select", arguments: { index: 0 } });
  assert.notStrictEqual(ok.isError, true, JSON.stringify(ok));
  await lockIsFree();
});

test("L3: tabs_select takes the pin when it arrives — a forwarded call sent during its ensureBrave waits and acts on the selected tab", T, async (t) => {
  let openBrave;
  const braveGate = new Promise((r) => { openBrave = r; });
  let slow = false;
  let entered = 0;
  const { a, b, relay, events, checked } = setup(t, { ensureBrave: async () => { if (slow) { entered++; await braveGate; } } });
  setActivePage(b);
  slow = true;
  const select = relay.handleToolsCall({ name: "tabs_select", arguments: { index: 0 } }); // a
  for (const end = Date.now() + 5000; !entered && Date.now() < end;) await sleep(5);
  assert.ok(entered, "tabs_select is in its ensureBrave step");
  slow = false;
  const fill = relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: "#q", value: "x" } });
  await sleep(50);
  assert.deepStrictEqual(events, [], "the fill waits for the tabs_select sent before it");
  openBrave();
  const [rs, rf] = await Promise.all([select, fill]);
  assert.notStrictEqual(rs.isError, true, JSON.stringify(rs));
  assert.notStrictEqual(rf.isError, true, JSON.stringify(rf));
  assert.deepStrictEqual(checked, [a.tid], "checked on the tab selected first");
  assert.deepStrictEqual(events, [`fill-start:${a.tid}`, `fill-end:${a.tid}`]);
  await lockIsFree();
});

test("L3: a forwarded call whose caller aborts while it waits for the pin is dropped — it never reaches upstream", T, async (t) => {
  const { b, relay, events } = setup(t);
  setActivePage(b);
  const held = await pinLock.exclusive({ label: "tabs_new" }); // a tabs_* call running
  const ac = new AbortController();
  const fill = relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: "#q", value: "x" } }, { signal: ac.signal });
  await sleep(30);
  ac.abort();
  const r = await within(fill, 2000, "the aborted call");
  assert.strictEqual(r.isError, true, JSON.stringify(r));
  assert.match(r.content.map((c) => c.text).join("\n"), /cancel/);
  held();
  await sleep(50);
  assert.deepStrictEqual(events, [], "the dropped call never ran");
  await lockIsFree();
});

test("pin lock: a timed-out exclusive leaves the queue — shared holds queued behind it are granted", T, async () => {
  const s1 = await pinLock.shared({ label: "interaction_click" });
  const ex = pinLock.exclusive({ label: "tabs_new", waitMs: 100 });
  let late = false;
  const s2p = pinLock.shared({ label: "execute" }).then((rel) => { late = true; return rel; });
  await sleep(20);
  assert.strictEqual(late, false, "the later shared waits behind the exclusive");
  const e = await ex.then(() => null, (err) => err);
  assert.ok(e, "the exclusive gave up");
  assert.strictEqual(e.code, "PIN_LOCK_TIMEOUT");
  assert.deepStrictEqual(e.holders.map((h) => h.replace(/\d+ s/, "N s")), ["interaction_click (running N s)"]);
  (await within(s2p, 1000, "the shared behind the timed-out exclusive"))();
  s1();
  await lockIsFree();
});

// ───── final review of 5ec97f6 (2026-11-17), LOWs 1 and 3 ─────

test("5ec97f6 L1: a tabs_select refused behind another tabs_* call names running calls, without the forwarded-call 180 s note", T, async (t) => {
  const { b, up, relay } = setup(t, { pinWaitMs: 300 });
  setActivePage(b);
  const pinned = up.targetId;
  const held = await pinLock.exclusive({ label: "tabs_new" }); // another tabs_* call running
  t.after(() => held());
  const rs = await relay.handleToolsCall({ name: "tabs_select", arguments: { index: 0 } });
  held();
  assert.strictEqual(rs.isError, true, JSON.stringify(rs));
  const msg = rs.content.map((c) => c.text).join("\n");
  assert.match(msg, /REFUSED/);
  assert.match(msg, /running call\(s\)/, msg);
  assert.match(msg, /tabs_new \(running \d+ s\)/, msg);
  assert.doesNotMatch(msg, /upstream call/, msg);
  assert.doesNotMatch(msg, /180 s/, msg);
  assert.strictEqual(up.targetId, pinned, "the pin did not move");
  await lockIsFree();
});

test("5ec97f6 L1: behind a forwarded call, the refusal keeps the 180 s / cancel note", T, async (t) => {
  const { b, relay } = setup(t, { pinWaitMs: 300 });
  setActivePage(b);
  const held = await pinLock.shared({ label: "interaction_click" }); // a forwarded call running
  t.after(() => held());
  const rs = await relay.handleToolsCall({ name: "tabs_select", arguments: { index: 0 } });
  held();
  const msg = rs.content.map((c) => c.text).join("\n");
  assert.strictEqual(rs.isError, true, msg);
  assert.match(msg, /running call\(s\)/, msg);
  assert.match(msg, /interaction_click \(running \d+ s\)/, msg);
  assert.match(msg, /180 s/, msg);
  assert.match(msg, /cancel/, msg);
  await lockIsFree();
});

test("5ec97f6 L3: a tabs_select whose caller aborts while it waits for the pin is dropped — the pin does not move", T, async (t) => {
  const { b, up, relay } = setup(t);
  setActivePage(b);
  const pinned = up.targetId;
  const held = await pinLock.shared({ label: "interaction_click" });
  t.after(() => held());
  const ac = new AbortController();
  const select = relay.handleToolsCall({ name: "tabs_select", arguments: { index: 0 } }, { signal: ac.signal });
  await sleep(30);
  ac.abort();
  await sleep(30);
  held(); // the running call ends; a waiter still queued would now be granted
  const r = await within(select, 2000, "the aborted tabs_select");
  assert.strictEqual(r.isError, true, JSON.stringify(r));
  const msg = r.content.map((c) => c.text).join("\n");
  assert.match(msg, /cancel/, msg);
  assert.doesNotMatch(msg, /not sent to upstream/, msg);
  assert.strictEqual(up.targetId, pinned, "the cancelled tabs_select never moved the pin");
  await lockIsFree();
});
