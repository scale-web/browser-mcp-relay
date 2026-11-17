// R1: upstream's pin can be moved to the relay's tab (scripts/patch-bdmcp-repin.js).
// Mirrors the A1 / A76 patcher tests, including the live-bundle check that makes
// an upstream upgrade which breaks a pattern fail `npm test`.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const patcher = require("../scripts/patch-bdmcp-repin.js");

// Every site, in the bundle's own spelling.
const SHAPE = "function createToolSessionContext(){}" +
  "class S{_attachPageListeners(page){let me=this;page.on(\"console\",msg=>{a()}),page.on(\"pageerror\",err=>{b()})," +
  "page.on(\"request\",async req=>{me.otelController.isOTELRequest(req)||(me._numOfInFlightRequests++,c())})," +
  "page.on(\"requestfinished\",async req=>{me.otelController.isOTELRequest(req)||(me._numOfInFlightRequests--,d())})," +
  "page.on(\"requestfailed\",async req=>{me.otelController.isOTELRequest(req)||(me._numOfInFlightRequests--,e())})}" +
  "executionContext(){return{page:this.page}}" +
  "async close(){this.options.dontCloseBrowserContext?(x(),await this.page.close({runBeforeUnload:!1}).catch(()=>{})):y()}}";

test("R1: patchSource rewrites every site, puts the helper at the TOP, and marks the file", () => {
  const out = patcher.patchSource(SHAPE);
  assert.ok(out, "expected a patched source");
  assert.ok(out.startsWith(`${patcher.MARKER}\n${patcher.HELPER_SOURCE}\n`), "helper first: A1's update rewrites the END of the file");
  for (const [, to] of patcher.SITES) assert.ok(out.includes(to), to);
  assert.ok(out.includes(`${patcher.SANDBOX_NAME}:(targetId)=>${patcher.HELPER_NAME}(this,targetId)`));
  assert.strictEqual((out.match(/if\(me\._page!==page\)return;/g) || []).length, 5, "every capture handler follows the pin");
  assert.ok(!out.includes("await this.page.close({runBeforeUnload:!1}).catch(()=>{})}"), "close() never closes an adopted page");
});

test("R1: patchSource is idempotent, all-or-nothing, and no-ops on a changed shape", () => {
  assert.strictEqual(patcher.patchSource(patcher.patchSource(SHAPE)), null);
  for (const [from] of patcher.SITES) {
    assert.strictEqual(patcher.patchSource(SHAPE.replace(from, "/*gone*/")), null, `missing: ${from}`);
    assert.strictEqual(patcher.patchSource(SHAPE + from), null, `twice: ${from}`);
  }
});

test("R1: applyPatch on a fixture distDir applies atomically, then reports already; a newer helper is left alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r1-patch-"));
  try {
    const file = path.join(dir, "core-TEST1234.js");
    fs.writeFileSync(file, SHAPE);
    fs.writeFileSync(path.join(dir, "core-OTHER999.js"), "unrelated");
    const logs = [];
    const r = patcher.applyPatch({ distDir: dir, log: (m) => logs.push(m) });
    assert.deepStrictEqual([r.patched, r.action], [true, "applied"]);
    assert.ok(fs.readFileSync(file, "utf8").startsWith(patcher.MARKER));
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["core-OTHER999.js", "core-TEST1234.js"], "no temp file left");
    assert.strictEqual(patcher.applyPatch({ distDir: dir, log: () => {} }).action, "already");
    // An older helper is replaced in place; the rest of the file is untouched.
    const patched = fs.readFileSync(file, "utf8");
    const older = patched.replace(patcher.MARKER, patcher.MARKER.replace(`v${patcher.HELPER_VERSION}`, "v0")).replace(patcher.HELPER_SOURCE, "async function __relayPinPage(){return 0}");
    fs.writeFileSync(file, older);
    assert.strictEqual(patcher.applyPatch({ distDir: dir, log: () => {} }).action, "updated");
    assert.strictEqual(fs.readFileSync(file, "utf8"), patched);
    const newer = patched.replace(patcher.MARKER, patcher.MARKER.replace(`v${patcher.HELPER_VERSION}`, "v99"));
    fs.writeFileSync(file, newer);
    assert.strictEqual(patcher.applyPatch({ distDir: dir, log: () => {} }).action, "newer");
    assert.strictEqual(fs.readFileSync(file, "utf8"), newer);
    // A changed shape: no write, a reason.
    fs.writeFileSync(file, "function createToolSessionContext(){} executionContext(){return{page:this.page,x:1}}");
    const no = patcher.applyPatch({ distDir: dir, log: () => {} });
    assert.strictEqual(no.patched, false);
    assert.match(no.reason, /shape changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R1: the INSTALLED upstream bundle has every site exactly once (or is already patched) — read only", () => {
  const file = patcher.findSessionFile();
  assert.ok(file, "upstream's session bundle was found");
  const content = fs.readFileSync(file, "utf8");
  if (patcher.MARKER_RE.test(content)) {
    for (const [, to] of patcher.SITES) assert.ok(content.includes(to), `patched site present: ${to}`);
    assert.ok(content.includes(`async function ${patcher.HELPER_NAME}(`));
  } else {
    assert.ok(patcher.patchSource(content), "an upstream upgrade changed a re-pin site: update scripts/patch-bdmcp-repin.js");
  }
  // The helper itself parses as a function in the bundle's module context.
  assert.doesNotThrow(() => new Function(`${patcher.HELPER_SOURCE}; return ${patcher.HELPER_NAME};`));
});

test("R1: the patched class — close() never closes an adopted page; capture handlers act only for the pinned page; listeners attach once", () => {
  const src = patcher.patchSource(SHAPE).replace(patcher.MARKER, "");
  const fns = "let calls=[];const a=()=>calls.push('console'),b=()=>calls.push('pageerror'),c=()=>calls.push('request'),d=()=>calls.push('finished'),e=()=>calls.push('failed'),x=()=>{},y=()=>{};";
  const S = new Function(`${fns}${src}; return { S, calls };`)();
  const mkPage = () => { const on = {}; return { on: (ev, fn) => { (on[ev] ||= []).push(fn); }, fire: (ev) => (on[ev] || []).forEach((f) => f({})), on_: on, closed: 0, close() { this.closed++; return Promise.resolve(); } }; };
  const ctx = new S.S();
  ctx.otelController = { isOTELRequest: () => false };
  const p1 = mkPage(); const p2 = mkPage();
  ctx._page = p1;
  ctx._attachPageListeners(p1);
  ctx._attachPageListeners(p1);
  assert.strictEqual(p1.on_.console.length, 1, "attached once per page");
  ctx._attachPageListeners(p2);
  p2.fire("console");
  assert.deepStrictEqual(S.calls, [], "a page that is not pinned records nothing");
  p1.fire("console"); p1.fire("request");
  assert.deepStrictEqual(S.calls, ["console", "request"]);
  ctx.options = { dontCloseBrowserContext: true };
  ctx.page = undefined;
  Object.defineProperty(ctx, "page", { get() { return this._page; } });
  ctx.__relayAdopted = new WeakSet([p1]);
  return ctx.close().then(async () => {
    assert.strictEqual(p1.closed, 0, "an adopted (relay's or user's) page is never closed by the session");
    ctx._page = p2;
    await ctx.close();
    assert.strictEqual(p2.closed, 1, "the session's own page still is");
  });
});

test("R1: in-flight requests are counted per page whatever the pin; a re-pin takes the target's count; never negative", async () => {
  const src = patcher.patchSource(SHAPE).replace(patcher.MARKER, "");
  const fns = "const c=()=>{},d=()=>{},e=()=>{},a=()=>{},b=()=>{},x=()=>{},y=()=>{};";
  const { S, pin } = new Function(`${fns}${src}; return { S, pin: ${patcher.HELPER_NAME} };`)();
  const mkPage = (tid) => {
    const on = {};
    return { tid, on: (ev, fn) => { (on[ev] ||= []).push(fn); }, fire: (ev, req) => (on[ev] || []).forEach((f) => f(req)), url: () => `https://x.example/${tid}`, isClosed: () => false };
  };
  const p1 = mkPage("T1"); const p2 = mkPage("T2");
  const ctx = new S();
  ctx.otelController = { isOTELRequest: (r) => !!r.otel };
  ctx.browserContext = { pages: () => [p1, p2], newCDPSession: async (p) => ({ send: async () => ({ targetInfo: { targetId: p.tid } }), detach: async () => {} }) };
  ctx._numOfInFlightRequests = 0;
  ctx._page = p1;
  ctx._attachPageListeners(p1);
  await pin(ctx, "T2"); // B's listeners are attached once it has been pinned
  await pin(ctx, "T1");
  const [r1, r2, r3, otel, early] = [{}, {}, {}, { otel: true }, {}];
  p2.fire("request", r1); p2.fire("request", r2); p2.fire("request", r3); p2.fire("request", otel);
  assert.strictEqual(ctx._numOfInFlightRequests, 0, "B's requests do not move A's count");
  p2.fire("requestfinished", early); // started before B's listeners existed: never counted
  await pin(ctx, "T2");
  assert.strictEqual(ctx._numOfInFlightRequests, 3, "pinned to B: B's 3 counted requests are in flight (OTEL's is not one)");
  p2.fire("requestfinished", otel);
  assert.strictEqual(ctx._numOfInFlightRequests, 3, "an OTEL request's end moves nothing");
  assert.ok(ctx._lastNetworkActivityTimestamp > 0, "…and B's last activity time comes with them");
  p2.fire("requestfinished", r1); p2.fire("requestfailed", r2);
  assert.strictEqual(ctx._numOfInFlightRequests, 1);
  p2.fire("requestfinished", r3); p2.fire("requestfinished", r3); p2.fire("requestfailed", r1);
  assert.strictEqual(ctx._numOfInFlightRequests, 0, "never below zero: an end decrements only once, and only a counted start");
  p1.fire("request", {});
  await pin(ctx, "T1");
  assert.strictEqual(ctx._numOfInFlightRequests, 1, "A's own request, started while B was pinned, is A's when A is pinned again");
});
