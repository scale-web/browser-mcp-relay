// plainflags-lock-reader.test.js — the lock's CDP isolated-world READER
// (src/plainflags-lock.js createCdpReader) against a FAKE CDP that does what
// Chrome did in review rounds 5–6: after a cross-process navigation it hands a
// NUMERIC execution-context id to a different frame's context — even a main
// world where page code runs. The reader addresses its world by
// `uniqueContextId` (never reused), learned from Runtime.executionContextCreated.
// The same reader against a real Brave: test/isolated-plainflags.test.js.

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createCdpReader, createLock } = require("../src/plainflags-lock.js");

const WORLD = "__browser_mcp_relay_lock__";

function fakeBrowser() {
  const counts = new Map(); // frameId → {seen, filled} as the probe would count in that frame
  let process = 1;
  let nextId = 1;
  let uniq = 0;
  const contexts = new Map(); // numeric id → { uniqueId, frameId, name, world } — numeric ids restart per process
  const byUnique = new Map(); // uniqueId → context (never reused)
  const sessions = [];
  const log = [];
  const frame = (id, url, parent = null) => ({ _id: id, url: () => url, parentFrame: () => parent });
  const main = frame("MAIN", "https://b.example/login");
  const frames = [main];
  const page = { url: () => main.url(), isClosed: () => false, mainFrame: () => main, frames: () => frames };
  const oopif = new Map(); // Playwright frame → { hangTree?, newSessionError? }

  const deliver = (s, ev, p) => s.emit(ev, p);
  function makeContext(frameId, name, world) {
    const c = { id: nextId++, uniqueId: `u-${process}-${++uniq}`, frameId, name, world };
    contexts.set(c.id, c);
    byUnique.set(c.uniqueId, c);
    for (const s of sessions) if (s.runtimeEnabled) announce(s, c);
    return c;
  }
  const announce = (s, c) => deliver(s, "Runtime.executionContextCreated", { context: { id: c.id, name: c.name, uniqueId: c.uniqueId, auxData: { frameId: c.frameId, type: c.world } } });
  const hangEval = new Set(); // frame ids whose evaluate never answers (A77 fix 1)
  let beforeEvaluate = null; // test hook: runs just before a Runtime.evaluate is executed
  function session(owner, getTree) {
    const s = new EventEmitter();
    s.runtimeEnabled = false;
    s.detached = false;
    sessions.push(s);
    s.send = async (method, params = {}) => {
      if (s.detached) throw new Error("Target page, context or browser has been closed");
      log.push(method + (params.uniqueContextId ? `(${params.uniqueContextId})` : params.contextId ? `[${params.contextId}]` : ""));
      if (method === "Runtime.enable") { s.runtimeEnabled = true; for (const c of contexts.values()) if (!c.dead) announce(s, c); return {}; } // Chrome replays existing contexts
      if (method === "Page.getFrameTree") { if (owner.hangTree) return new Promise(() => {}); return { frameTree: getTree() }; }
      if (method === "Page.createIsolatedWorld") return { executionContextId: makeContext(params.frameId, params.worldName, "isolated").id };
      if (method === "Runtime.evaluate") {
        if (beforeEvaluate) { const f = beforeEvaluate; beforeEvaluate = null; f(); }
        let c;
        if (params.uniqueContextId !== undefined) c = byUnique.get(params.uniqueContextId);
        else c = contexts.get(params.contextId);
        if (!c || c.dead) throw new Error("Cannot find context with specified id");
        if (hangEval.has(c.frameId)) return new Promise(() => {}); // a busy renderer never answers
        return { result: { type: "object", value: counts.get(c.frameId) || { seen: 0, filled: 0 } } };
      }
      throw new Error(`unexpected ${method}`);
    };
    s.detach = async () => { s.detached = true; s.runtimeEnabled = false; };
    return s;
  }
  const phantoms = []; // frames CDP describes that Playwright has not listed yet (an attach race)
  const undescribed = new Set(); // Playwright frames no CDP frame tree describes (1c L2)
  const mainTree = () => ({ frame: { id: "MAIN", url: main.url() }, childFrames: [...frames.filter((f) => f !== main && !oopif.has(f) && !undescribed.has(f)).map((f) => ({ frame: { id: f._id, url: f.url() } })), ...phantoms.map((p) => ({ frame: p }))] });
  const ctx = {
    pages: () => [page],
    async newCDPSession(target) {
      if (target === page) return session({}, mainTree);
      const o = oopif.get(target);
      if (!o) throw new Error("This frame does not have a separate CDP session, it is a part of the parent frame's session");
      if (o.newSessionError) throw new Error(o.newSessionError);
      return session(o, () => ({ frame: { id: target._id, url: target.url() } }));
    },
  };
  return {
    ctx, page, main, frames, counts, contexts, log, oopif, phantoms, sessions, undescribed, hangEval,
    onNextEvaluate(f) { beforeEvaluate = f; },
    addFrame(id, url, opts = {}) { const f = frame(id, url, main); frames.push(f); if (opts.oopif) oopif.set(f, opts); return f; },
    /** A cross-process navigation: contexts die, NUMERIC ids restart, the page's own new contexts take the low ids. */
    crossProcessNavigate(newContexts) {
      for (const c of contexts.values()) c.dead = true;
      contexts.clear();
      process++;
      nextId = 1;
      for (const s of sessions) if (s.runtimeEnabled) deliver(s, "Runtime.executionContextsCleared", {});
      for (const [frameId, world] of newContexts) makeContext(frameId, "", world);
    },
  };
}

test("round 6 item 1 (fake CDP): the NUMERIC id our world had is reused by a child frame's MAIN world after a cross-process navigation — the probe still reads only the relay's own world in the main frame, by uniqueContextId, and locks", async () => {
  const b = fakeBrowser();
  b.addFrame("CHILD", "https://b.example/f");
  const lock = createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 500 }) });
  assert.strictEqual((await lock.probe()).locked, false);
  const mainWorld = [...b.contexts.values()].find((c) => c.frameId === "MAIN" && c.world === "isolated");
  // after the navigation the child's MAIN world (page code runs there) gets the numeric id our world had
  b.crossProcessNavigate(Array.from({ length: mainWorld.id }, (_, i) => (i === mainWorld.id - 1 ? ["CHILD", "default"] : ["OTHER", "default"])));
  assert.strictEqual(b.contexts.get(mainWorld.id).frameId, "CHILD");
  b.counts.set("MAIN", { seen: 1, filled: 1 });
  b.counts.set("CHILD", { seen: 0, filled: 0 }); // what a hostile child would report
  const st = await lock.probe();
  assert.strictEqual(st.locked, true, JSON.stringify(st));
  assert.strictEqual(st.unreadable, 0);
  assert.ok(b.log.filter((l) => l.startsWith("Runtime.evaluate")).every((l) => /\(u-/.test(l)), `every evaluate by uniqueContextId: ${b.log.join(" ")}`);
});

test("round 6 item 2 (fake CDP): there is no stamp write at all — nothing is evaluated by numeric id, so no write can land in a reused context", async () => {
  const b = fakeBrowser();
  const lock = createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 500 }) });
  await lock.probe();
  b.crossProcessNavigate([["MAIN", "default"]]);
  await lock.probe();
  assert.ok(!b.log.some((l) => /^Runtime\.evaluate\[/.test(l)), b.log.join(" "));
});

test("round 6 item 1 (fake CDP): no executionContextCreated event identifies the world (twice) → that tab fails closed", async () => {
  const b = fakeBrowser();
  const lock = createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 400 }) });
  // events for the relay's worlds never arrive
  const orig = b.ctx.newCDPSession;
  b.ctx.newCDPSession = async (t) => { const s = await orig(t); const emit = s.emit.bind(s); s.emit = (ev, p) => (ev === "Runtime.executionContextCreated" && p.context.auxData.type === "isolated" ? false : emit(ev, p)); return s; };
  const st = await lock.probe();
  assert.strictEqual(st.locked, true);
  assert.match(st.reason, /verified isolated world/);
});

test("round 5 item 3 (fake CDP): unreadable frames are found by FRAME — an out-of-process child whose tree never answers is unreadable", async () => {
  const b = fakeBrowser();
  b.addFrame("OOPIF", "https://pay.example/frame", { oopif: true, hangTree: true });
  b.counts.set("MAIN", { seen: 1, filled: 0 });
  const lock = createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 300 }) });
  const st = await lock.probe();
  assert.ok(st.unreadable >= 1, JSON.stringify(st));
  assert.strictEqual(st.locked, true);
});

test("round 6 item 5 (fake CDP): an out-of-process frame whose newCDPSession FAILS (not the in-process case) is unreadable; an in-process frame is not", async () => {
  const b = fakeBrowser();
  b.addFrame("INPROC", "https://b.example/inner");
  b.addFrame("BROKEN", "https://pay.example/frame", { oopif: true, newSessionError: "Target closed" });
  b.counts.set("MAIN", { seen: 1, filled: 0 });
  const lock = createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 300 }) });
  const st = await lock.probe();
  assert.strictEqual(st.unreadable, 1, JSON.stringify(st));
  assert.strictEqual(st.locked, true, "a secret field on that tab + an unreadable frame");
});

test("round 6 item 5 (fake CDP): a frame CDP describes but Playwright has not listed yet (an attach race) cannot stand in for the out-of-process frame whose newCDPSession failed", async () => {
  const b = fakeBrowser();
  b.addFrame("BROKEN", "https://pay.example/frame", { oopif: true, newSessionError: "Target closed" });
  b.phantoms.push({ id: "PHANTOM", url: "https://pay.example/frame" });
  b.counts.set("MAIN", { seen: 1, filled: 0 });
  const lock = createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 300 }) });
  const st = await lock.probe();
  assert.strictEqual(st.unreadable, 1, JSON.stringify(st));
  assert.strictEqual(st.locked, true);
});

test("round 6 item 1 (fake CDP): Page.createIsolatedWorld answering with the id of the relay's world in ANOTHER frame is not accepted — the frame is never read through the other frame's world; the tab fails closed", async () => {
  const b = fakeBrowser();
  b.addFrame("CHILD", "https://b.example/f");
  b.counts.set("MAIN", { seen: 0, filled: 0 });
  b.counts.set("CHILD", { seen: 1, filled: 1 });
  const orig = b.ctx.newCDPSession;
  b.ctx.newCDPSession = async (t) => {
    const s = await orig(t);
    const send = s.send;
    s.send = async (m, p = {}) => {
      if (m === "Page.createIsolatedWorld" && p.frameId === "CHILD") {
        const other = [...b.contexts.values()].find((c) => c.frameId === "MAIN" && c.world === "isolated");
        if (other) return { executionContextId: other.id };
      }
      return send(m, p);
    };
    return s;
  };
  const st = await createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 400 }) }).probe();
  assert.strictEqual(st.locked, true, JSON.stringify(st));
  assert.match(st.reason, /verified isolated world/);
});

test("round 6 item 1 (fake CDP, behaviour): a process swap lands BETWEEN Page.createIsolatedWorld and Runtime.evaluate (the evaluate is already on its way) — the world's NUMERIC id now names a child frame's main world — the probe never reads that context and the tab locks", async () => {
  const b = fakeBrowser();
  b.addFrame("CHILD", "https://b.example/f");
  b.counts.set("MAIN", { seen: 1, filled: 1 });
  b.counts.set("CHILD", { seen: 0, filled: 0 }); // what a hostile child would report
  const lock = createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 500 }) });
  b.onNextEvaluate(() => {
    const ours = [...b.contexts.values()].find((c) => c.frameId === "MAIN" && c.world === "isolated");
    b.crossProcessNavigate(Array.from({ length: ours.id }, (_, i) => (i === ours.id - 1 ? ["CHILD", "default"] : ["OTHER", "default"])));
    assert.strictEqual(b.contexts.get(ours.id).frameId, "CHILD");
  });
  const st = await lock.probe();
  assert.strictEqual(st.locked, true, JSON.stringify(st));
  assert.strictEqual(st.reason, "a password / one-time-code field on a tab holds a value", "locked because MAIN was READ (not merely unreadable)");
});

test("round 7 item 1 (fake CDP): the SAME Playwright Frame object moves into its own process (newCDPSession starts succeeding) after a probe — the next probe reads it there and a typed password locks; the reverse move too", async () => {
  const b = fakeBrowser();
  const fr = b.addFrame("IFR", "about:blank");
  const lock = createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 300 }) });
  assert.strictEqual((await lock.probe()).locked, false, "in-process, nothing secret");
  b.oopif.set(fr, {}); // the same Frame object is now out-of-process
  b.counts.set("IFR", { seen: 1, filled: 1 });
  const st = await lock.probe();
  assert.strictEqual(st.locked, true, JSON.stringify(st));
  assert.strictEqual(st.unreadable, 0);
  b.oopif.delete(fr); // and back in-process
  b.counts.set("IFR", { seen: 1, filled: 0 });
  assert.deepStrictEqual([(await lock.probe()).locked, (await lock.probe()).unreadable], [false, 0]);
  b.counts.set("IFR", { seen: 1, filled: 1 });
  assert.strictEqual((await lock.probe()).locked, true);
});

test("round 7 rule 0 (fake CDP): every probe opens its own sessions and detaches all of them — none survives into the next probe", async () => {
  const b = fakeBrowser();
  b.addFrame("OOP", "https://pay.example/frame", { oopif: true });
  const lock = createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 300 }) });
  await lock.probe();
  const first = b.sessions.slice();
  assert.strictEqual(first.length, 2);
  assert.ok(first.every((s) => s.detached), "all detached after the probe");
  const worldsBefore = b.log.filter((l) => l === "Page.createIsolatedWorld").length;
  await lock.probe();
  assert.strictEqual(b.sessions.length, 4, "the second probe opened new ones");
  assert.ok(b.sessions.every((s) => s.detached));
  assert.strictEqual(b.log.filter((l) => l === "Page.createIsolatedWorld").length - worldsBefore, 2, "the world of each frame (MAIN, OOP) is resolved again");
});

// ── 1c final review L2 / L4 ─────────────────────────────────────────────────

test("1c L2 (fake CDP): a frame Playwright lists that NO CDP session describes is unreadable — beside a seen secret field, its tab fails closed", async () => {
  const b = fakeBrowser();
  const ghost = b.addFrame("GHOST", "https://b.example/ghost");
  b.undescribed.add(ghost);
  b.counts.set("MAIN", { seen: 1, filled: 0 });
  const st = await createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 300 }) }).probe();
  assert.strictEqual(st.unreadable, 1, JSON.stringify(st));
  assert.strictEqual(st.locked, true);
  b.undescribed.delete(ghost);
  const ok = await createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 300 }) }).probe();
  assert.deepStrictEqual([ok.unreadable, ok.locked], [0, false], "described again: readable, nothing filled");
});

test("1c L4 (fake CDP): a newCDPSession that HANGS is bounded by the frame timeout (not the tab's) — that frame is unreadable, the tab fails closed, and a session that arrives late is detached", async () => {
  const b = fakeBrowser();
  const slow = b.addFrame("SLOW", "https://pay.example/frame", { oopif: true });
  b.counts.set("MAIN", { seen: 1, filled: 0 });
  const orig = b.ctx.newCDPSession;
  let late = null;
  b.ctx.newCDPSession = async (t) => {
    if (t !== slow) return orig(t);
    await new Promise((r) => setTimeout(r, 1500));
    late = await orig(t);
    return late;
  };
  const lock = createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 200, tabTimeoutMs: 20000 }) });
  const t0 = Date.now();
  const st = await lock.probe();
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `bounded by the 200 ms frame timeout, took ${ms} ms`);
  assert.deepStrictEqual([st.unreadable, st.locked], [1, true], JSON.stringify(st));
  await new Promise((r) => setTimeout(r, 1700));
  assert.ok(late && late.detached, "the late session was detached, never used");
});

test("1c L4 (fake CDP): each TAB is bounded and tabs are read in parallel — three tabs whose frames each time out end together at the tab timeout; a filled password on a fourth tab still locks", async () => {
  const bs = [fakeBrowser(), fakeBrowser(), fakeBrowser(), fakeBrowser()];
  for (const b of bs.slice(0, 3)) for (let i = 0; i < 6; i++) b.addFrame(`H${i}`, `https://ads${i}.example/`, { oopif: true, hangTree: true });
  bs[3].counts.set("MAIN", { seen: 1, filled: 1 });
  const owner = (t) => bs.find((b) => b.page === t || b.frames.includes(t));
  const ctx = { pages: () => bs.map((b) => b.page), newCDPSession: (t) => owner(t).ctx.newCDPSession(t) };
  const lock = createLock({ getContext: () => ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 300, tabTimeoutMs: 500 }) });
  const t0 = Date.now();
  const st = await lock.probe();
  const ms = Date.now() - t0;
  // unbounded and sequential: 3 tabs × 6 frames × 300 ms ≈ 5.4 s
  assert.ok(ms < 1200, `took ${ms} ms`);
  assert.strictEqual(st.locked, true, JSON.stringify(st));
  assert.strictEqual(st.reason, "a password / one-time-code field on a tab holds a value");
  assert.ok(st.unreadable >= 3, JSON.stringify(st));
});

test("A77 fix 1 (fake CDP): the main frame holds a typed password and 3 child frames hang — in-process (their evaluate never answers) or out-of-process (their tree never answers) — the tab times out but keeps the main frame's read: LOCKED, in both modes, within the tab timeout", async () => {
  for (const kind of ["in-process", "out-of-process"]) {
    for (const mode of ["plainflags", "default"]) {
      const b = fakeBrowser();
      for (let i = 0; i < 3; i++) {
        b.addFrame(`B${i}`, `https://busy${i}.example/`, kind === "out-of-process" ? { oopif: true, hangTree: true } : {});
        if (kind === "in-process") b.hangEval.add(`B${i}`);
      }
      b.counts.set("MAIN", { seen: 1, filled: 1 });
      // tab timeout 500 ms < 3 × 300 ms: frames read one after another would not all fit
      const lock = createLock({ getContext: () => b.ctx, accounts: [], mode, readTabs: createCdpReader({ frameTimeoutMs: 300, tabTimeoutMs: 500 }) });
      const t0 = Date.now();
      const st = await lock.probe();
      const ms = Date.now() - t0;
      assert.strictEqual(st.locked, true, `${kind} ${mode}: ${JSON.stringify(st)}`);
      assert.strictEqual(st.filled, 1, `${kind} ${mode}: the main frame's read was kept`);
      assert.ok(st.unreadable >= 1, `${kind} ${mode}: ${JSON.stringify(st)}`);
      assert.ok(ms < 1500, `${kind} ${mode}: bounded, ${ms} ms`);
    }
  }
});

test("A77 fix 1 (fake CDP): the main frame's secret field is EMPTY but SEEN and the tab times out on hung children — the rest fails closed (locked); with no secret anywhere it does not", async () => {
  const b = fakeBrowser();
  for (let i = 0; i < 3; i++) { b.addFrame(`B${i}`, `https://busy${i}.example/`); b.hangEval.add(`B${i}`); }
  b.counts.set("MAIN", { seen: 1, filled: 0 });
  const st = await createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 300, tabTimeoutMs: 500 }) }).probe();
  assert.strictEqual(st.locked, true, JSON.stringify(st));
  b.counts.set("MAIN", { seen: 0, filled: 0 });
  const st2 = await createLock({ getContext: () => b.ctx, accounts: [], readTabs: createCdpReader({ frameTimeoutMs: 300, tabTimeoutMs: 500 }) }).probe();
  assert.strictEqual(st2.locked, false, JSON.stringify(st2));
});

/** A fake browser whose main frame answers every step (new session, Runtime.enable, frame tree, the read) after `stepMs`. */
function slowMainBrowser(stepMs) {
  const slow = (ms) => new Promise((r) => setTimeout(r, ms));
  const b = fakeBrowser();
  b.counts.set("MAIN", { seen: 1, filled: 1 });
  const orig = b.ctx.newCDPSession;
  b.ctx.newCDPSession = async (t) => {
    await slow(stepMs);
    const s = await orig(t);
    const send = s.send;
    s.send = async (m, p) => { if (m === "Runtime.enable" || m === "Page.getFrameTree" || m === "Runtime.evaluate") await slow(stepMs); return send(m, p); };
    return s;
  };
  return b;
}

test("A77 rounds 3–4 (fake CDP): the main frame answers each setup step (new session, Runtime.enable, frame tree) and its read at T − 20 ms, T = 1 s — about 3.9 s, which only a tab budget of 4 frame timeouts (+ margin) covers: LOCKED, both modes (3 T and 3 T + 0.5 s do not)", async () => {
  const T = 1000;
  await Promise.all(["plainflags", "default"].map(async (mode) => {
    const b = slowMainBrowser(T - 20);
    const st = await createLock({ getContext: () => b.ctx, accounts: [], mode, readTabs: createCdpReader({ frameTimeoutMs: T }) }).probe();
    assert.deepStrictEqual([st.locked, st.filled], [true, 1], `${mode}: ${JSON.stringify(st)}`);
  }));
});

test("A77 round 4 (fake CDP): with the DEFAULT whole-probe backstop (createLock's own reader, no override), every main-frame step at T − 10 ms still locks — the backstop sits above the tab budget", async () => {
  const T = 1000;
  await Promise.all(["plainflags", "default"].map(async (mode) => {
    const b = slowMainBrowser(T - 10);
    const st = await createLock({ getContext: () => b.ctx, accounts: [], mode, frameTimeoutMs: T }).probe();
    assert.deepStrictEqual([st.locked, st.filled], [true, 1], `${mode}: ${JSON.stringify(st)}`);
  }));
});

test("A77 round 4 (fake CDP): a tab that runs OVER its budget (main frame read at once, 7 in-process children whose read hangs) keeps the main frame's filled password under the DEFAULT backstop — the backstop must fire after the tab budget, not with it", async () => {
  await Promise.all(["plainflags", "default"].map(async (mode) => {
    const b = fakeBrowser();
    for (let i = 0; i < 7; i++) { b.addFrame(`H${i}`, `https://hang${i}.example/`); b.hangEval.add(`H${i}`); }
    b.counts.set("MAIN", { seen: 1, filled: 1 });
    // T = 300 ms: tab budget 1.7 s < 7 × 300 ms of hung reads
    const st = await createLock({ getContext: () => b.ctx, accounts: [], mode, frameTimeoutMs: 300 }).probe();
    assert.deepStrictEqual([st.locked, st.filled], [true, 1], `${mode}: ${JSON.stringify(st)}`);
  }));
});
