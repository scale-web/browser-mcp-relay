// challenge-detect.test.js — challenge_detect's three call shapes (spec v8 §5.2)
// against fixture pages, a fixture cookie jar and stubbed curl/dig. No browser,
// no network; every log write goes to a temp file and the real vault log is
// checked untouched at the end.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tool = require("../../src/own-tools/challenge-detect.js");
const { setActivePage, clearActivePage } = require("../../src/own-tools/_active-page.js");
const cfWallLog = require("../../src/cf-wall-log.js");
const { createSigninLoader } = require("../../src/plainflags-signin.js");

const realBefore = (() => { try { return fs.statSync(cfWallLog.DEFAULT_LOG).mtimeMs; } catch { return null; } })();
test.after(() => {
  let after = null;
  try { after = fs.statSync(cfWallLog.DEFAULT_LOG).mtimeMs; } catch { /* absent */ }
  assert.strictEqual(after, realBefore, "the real CF-WALL log must never be touched by tests");
});

const SECRET = "SECRET-COOKIE-VALUE-7f3a";
const TOKEN = "TURNSTILE-TOKEN-VALUE-9c1d";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A frame whose evaluate() returns `data` (the in-page probe's result shape). */
function frame(url, data = {}) {
  return {
    url: () => url,
    evaluate: async () => ({
      title: "", chlOpt: false, challengeIframes: 0, turnstileInputs: [], turnstileDivs: 0,
      challengePlatform: false, errorCodes: [], navStatus: 200, ...data,
    }),
  };
}

function page(url, { top = {}, children = [] } = {}) {
  const main = frame(url, top);
  for (const c of children) if (!c.parentFrame) c.parentFrame = () => main;
  const frames = [main, ...children];
  return { url: () => url, mainFrame: () => main, frames: () => frames, isClosed: () => false, once() {} };
}

const HEADS = {
  ghl: "HTTP/2 200\r\nx-ghl-serve-region: us-central1\r\ncf-ray: 1-DFW\r\nserver: cloudflare\r\nset-cookie: __cf_bm=" + SECRET + "\r\n",
  shopify: "HTTP/2 200\r\npowered-by: Shopify\r\nshopify-complexity-score: 0\r\ncf-ray: 2-DFW\r\n",
  shopify429: "HTTP/2 429\r\npowered-by: Shopify\r\ncf-ray: 2-DFW\r\n",
  interstitial: "HTTP/2 403\r\ncf-mitigated: challenge\r\ncf-ray: 3-DFW\r\nserver: cloudflare\r\n",
  plain: "HTTP/1.1 200 OK\r\nserver: nginx\r\n",
  vendor: "HTTP/2 200\r\ncf-ray: 4-DFW\r\nserver: cloudflare\r\n",
};

let tmp;
let calls;

function setup({ head = HEADS.plain, cname = "", a = "", jar = [], url, pageOpts, now, signin, digByHost } = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cfdetect-"));
  calls = { curl: [], dig: [], cookies: 0 };
  tool._resetDeps();
  tool._setDeps({
    curlHead: async (u) => { calls.curl.push(u); return head; },
    dig: async (type, host) => {
      calls.dig.push([type, host]);
      if (digByHost) return (digByHost[host] || {})[type] || "";
      return type === "CNAME" ? cname : a;
    },
    getCookies: async () => { calls.cookies++; return typeof jar === "function" ? jar() : jar; },
    logPath: () => path.join(tmp, "CF-WALL Log.md"),
    now: now || (() => new Date("2026-10-30T17:00:00Z")),
    signin: signin || createSigninLoader({ path: path.join(tmp, "plainflags-signin.json") }),
    outcomeEnabled: true, // the shape-(iii) tests exercise the outcome path; the default refuses it (test below)
  });
  const p = url ? page(url, pageOpts) : null;
  globalThis.__relayBridge = { context: { pages: () => (p ? [p] : []) }, wsEndpoint: "ws://fixture" };
  clearActivePage();
  if (p) setActivePage(p);
  return p;
}

function teardown() {
  tool._resetDeps();
  clearActivePage();
  globalThis.__relayBridge = undefined;
}

function logText() {
  try { return fs.readFileSync(path.join(tmp, "CF-WALL Log.md"), "utf8"); } catch { return null; }
}
function logLines() {
  const t = logText();
  return t ? t.split("\n").filter((l) => /^\d{4}-\d\d-\d\dT/.test(l)) : [];
}

async function call(args) {
  const r = await tool.handler(args);
  return { r, body: r.isError ? null : JSON.parse(r.content[0].text), raw: r.content[0].text };
}

test.afterEach(teardown);

// ── shape and refusals ──────────────────────────────────────────────────────

test("tool shape: name, lane required in the schema, no stealth wording", () => {
  assert.strictEqual(tool.name, "challenge_detect");
  assert.deepStrictEqual(tool.inputSchema.required, ["lane"]);
  assert.deepStrictEqual(tool.inputSchema.properties.stage.enum, ["pre", "outcome"]);
  assert.strictEqual(typeof tool.handler, "function");
});

test("lane required: every shape without a lane is refused before any read or append", async () => {
  setup({ url: "https://go.example.com/form", head: HEADS.ghl });
  for (const args of [{}, { lane: "" }, { lane: "   " }, { lane: 7 }, { lane: "a|b" }, { lane: "x\ny" },
    { origin: "https://go.example.com", stage: "pre" }, { origin: "https://go.example.com", stage: "outcome" }, undefined]) {
    const r = await tool.handler(args);
    assert.strictEqual(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, /lane/);
  }
  assert.deepStrictEqual(calls, { curl: [], dig: [], cookies: 0 }, "nothing was read");
  assert.strictEqual(logText(), null, "nothing was appended");
});

test("stage pre/outcome without an origin → refused; a bad stage → refused; origin without a stage → refused", async () => {
  setup({ url: "https://go.example.com/form" });
  for (const args of [{ lane: "L", stage: "outcome" }, { lane: "L", stage: "pre" }, { lane: "L", stage: "pre", origin: "ftp://x" },
    { lane: "L", stage: "later", origin: "https://x.example" }, { lane: "L", origin: "https://x.example" }]) {
    const r = await tool.handler(args);
    assert.strictEqual(r.isError, true, JSON.stringify(args));
  }
  assert.strictEqual(logText(), null);
});

test("bridge missing → isError", async () => {
  tool._resetDeps();
  globalThis.__relayBridge = undefined;
  const r = await tool.handler({ lane: "L" });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /bridge missing/);
});

test("a non-web active page (about:blank) → isError, nothing appended", async () => {
  setup({ url: "about:blank" });
  const r = await tool.handler({ lane: "L" });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(logText(), null);
});

// ── shape (i): classify the loaded page ─────────────────────────────────────

test("(i) go.revivemyhair.com Turnstile in the form's cross-origin iframe → highlevel/turnstile, one line appended", async () => {
  let challengeEvals = 0;
  setup({
    url: "https://go.revivemyhair.com/consult?utm=abc&token=QUERYSECRET",
    head: HEADS.ghl, cname: "sites.ludicrous.cloud.\n", a: "sites.ludicrous.cloud.\n162.159.140.166\n",
    pageOpts: {
      top: { title: "Free consult" },
      children: [
        frame("https://api.leadconnectorhq.com/widget/form/abc", { turnstileInputs: [0], errorCodes: ["600010"] }),
        { url: () => "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/x",
          evaluate: async () => { challengeEvals++; throw new Error("must never evaluate inside the challenge frame"); } },
      ],
    },
  });
  const { body, raw } = await call({ lane: "CRO-33" });
  assert.strictEqual(body.owner, "highlevel");
  assert.strictEqual(body.row, 1);
  assert.strictEqual(body.ownerFrom, "frame api.leadconnectorhq.com");
  assert.strictEqual(body.kind, "turnstile");
  // Phase 1c, default relay: route unchanged from phase 1; the plain-flags server only suggested (round 1 item 4).
  assert.deepStrictEqual([body.plainflagsEligible, body.reason, body.route, body.clickBudget, body.switchTo, body.plainflagsServer],
    [true, "eligible", "in-page-turnstile", 0, "browser-mcp-relay-plainflags", "available-if-registered"]);
  assert.ok(!body.notes.some((n) => /repeat this step/i.test(n)), "no note telling the session to use a server it may not have");
  assert.strictEqual(body.guidance.length, 3, "the §2 in-page branch: page-verify / backend via API / human step");
  assert.deepStrictEqual(body.errorCodes, ["600010"]);
  assert.ok(body.signals.frames.some((f) => f.challengeFrame && f.host === "challenges.cloudflare.com"));
  assert.strictEqual(challengeEvals, 0, "the detector never evaluates inside the challenge iframe");
  assert.ok(body.signals.frames.some((f) => f.host === "api.leadconnectorhq.com" && f.turnstileInputs[0] === 0));
  // curl read the page without its query; dig asked CNAME and A for the host
  assert.deepStrictEqual(calls.curl, ["https://go.revivemyhair.com/consult"]);
  assert.deepStrictEqual(calls.dig.map((d) => d.join(" ")).sort(), ["A go.revivemyhair.com", "CNAME go.revivemyhair.com"]);
  assert.ok(!raw.includes("QUERYSECRET") && !raw.includes(SECRET), "no query string, no set-cookie value");
  assert.deepStrictEqual(logLines(), ["2026-10-30T17:00:00Z | CRO-33 | go.revivemyhair.com | highlevel | detected turnstile; next in-page-turnstile"]);
  assert.strictEqual(body.log.note, "This is the wall's CF-WALL line — do not append another. A subagent: tell your parent it is already written.");
  assert.ok(logText().startsWith("---\ntitle: CF-WALL log\n"), "created with the skill's frontmatter");
});

test("(i) aloeheath.com → highlevel (not agency, not vendor)", async () => {
  setup({ url: "https://aloeheath.com/", head: HEADS.vendor, a: "162.159.140.166\n", pageOpts: { top: { turnstileDivs: 1, turnstileInputs: [0] } } });
  const { body } = await call({ lane: "ALOE-1" });
  assert.strictEqual(body.owner, "highlevel");
});

test("(i) the test host → agency-test, route expected, logged", async () => {
  setup({ url: "https://cf-test.automatedscalinghq.com/", head: HEADS.interstitial, pageOpts: { top: { title: "Just a moment...", chlOpt: true, navStatus: 403 } } });
  const { body } = await call({ lane: "CSO-44" });
  assert.deepStrictEqual([body.owner, body.kind, body.route], ["agency-test", "interstitial", "expected"]);
  assert.deepStrictEqual(logLines(), ["2026-10-30T17:00:00Z | CSO-44 | cf-test.automatedscalinghq.com | agency-test | detected interstitial; next expected"]);
});

test("(i) a *.scale-265.workers.dev interstitial → workersdev/report", async () => {
  setup({ url: "https://ala-b2b.scale-265.workers.dev/x", head: HEADS.interstitial, pageOpts: { top: { title: "Just a moment..." } } });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.kind, body.route], ["workersdev", "interstitial", "report"]);
  assert.strictEqual(logLines().length, 1);
});

test("(i) an agency-zone interstitial → agency, §3.3 (config bug)", async () => {
  setup({ url: "https://www.walletreminder.com/", head: HEADS.interstitial, pageOpts: { top: { title: "Just a moment..." } } });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.route, body.reason], ["agency", "§3.3", "owner-route"]);
});

test("(i) a Shopify store with no wall → shopify/none, nothing appended", async () => {
  setup({ url: "https://alaunderscrubs.com/products/x", head: HEADS.shopify, a: "23.227.38.65\n" });
  const { body } = await call({ lane: "ALAUN-2" });
  assert.deepStrictEqual([body.owner, body.kind, body.route], ["shopify", "none", "none"], "no wall → route none, never the owner's rate-limit route (r1 #4)");
  assert.strictEqual(body.log.logged, false);
  assert.strictEqual(logText(), null);
});

test("(i) a Shopify 429 → shopify/ratelimit, logged", async () => {
  setup({ url: "https://alaunderscrubs.com/cart", head: HEADS.shopify429, pageOpts: { top: { navStatus: 429 } } });
  const { body } = await call({ lane: "ALAUN-2" });
  assert.deepStrictEqual([body.owner, body.kind, body.reason], ["shopify", "ratelimit", "owner-route"]);
  assert.strictEqual(logLines().length, 1);
});

test("(i) a plain 200 → none/none, nothing appended", async () => {
  setup({ url: "https://example.org/", head: HEADS.plain, a: "93.184.215.14\n" });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.kind, body.route, body.plainflagsEligible], ["none", "none", "none", false]);
  assert.strictEqual(logText(), null);
});

test("(i) curl/dig failing → still classified from host lists and page markers, failure reported", async () => {
  setup({ url: "https://www.canva.com/", pageOpts: { top: { title: "Just a moment..." } } });
  tool._setDeps({ curlHead: async () => { throw new Error("curl: (6) Could not resolve host"); }, dig: async () => { throw new Error("dig missing"); } });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.kind], ["vendor", "interstitial"]);
  assert.match(body.signals.errors.curl, /resolve/);
  assert.ok(body.notes.some((n) => /Header read failed/.test(n)));
});

test("(i) a frame that cannot be read is reported, not fatal", async () => {
  setup({ url: "https://go.example.com/", head: HEADS.vendor, pageOpts: {
    children: [{ url: () => "https://x.example/f", evaluate: async () => { throw new Error("Execution context was destroyed"); } }],
  } });
  const { body } = await call({ lane: "L" });
  assert.ok(body.signals.frames.some((f) => f.unreadable));
});

test("(i) a known account's login page is flagged in the raw signals", async () => {
  setup({ url: "https://www.canva.com/login", head: HEADS.interstitial, pageOpts: { top: { title: "Just a moment..." } } });
  const { body } = await call({ lane: "L" });
  assert.strictEqual(body.signals.loginPageOf, "canva");
  assert.deepStrictEqual([body.reason, body.plainflagsEligible], ["signin-not-listed", false], "a known account's login is never eligible while not listed");
});

test("(i) runs the REAL in-page probe: markers counted, token reported by length only", async () => {
  // Execute the probe function the tool passes to frame.evaluate() against a tiny fake DOM.
  const fakeDoc = {
    title: "Book",
    body: { innerText: "Error: 110200" },
    querySelectorAll: (sel) => {
      if (sel === 'input[name="cf-turnstile-response"]') return [{ value: TOKEN }, { value: "abc" }];
      if (sel === 'iframe[src*="challenges.cloudflare.com"]') return [{}];
      if (sel === ".cf-turnstile") return [{}];
      return [];
    },
  };
  const realFrame = {
    url: () => "https://go.example.com/",
    evaluate: async (fn) => {
      const saved = { document: globalThis.document, window: globalThis.window, performance: globalThis.performance };
      globalThis.document = fakeDoc;
      globalThis.window = {};
      globalThis.performance = { getEntriesByType: () => [{ responseStatus: 200 }] };
      try { return fn(); } finally { Object.assign(globalThis, saved); }
    },
  };
  const p = { url: () => "https://go.example.com/", mainFrame: () => realFrame, frames: () => [realFrame], isClosed: () => false, once() {} };
  setup({ head: HEADS.ghl });
  globalThis.__relayBridge = { context: { pages: () => [p] } };
  setActivePage(p);
  const { body, raw } = await call({ lane: "L" });
  assert.strictEqual(body.kind, "turnstile");
  const top = body.signals.frames[0];
  assert.deepStrictEqual(top.turnstileInputs, [TOKEN.length, 3]);
  assert.deepStrictEqual(body.errorCodes, ["110200"]);
  assert.ok(body.notes.some((n) => /110200/.test(n)));
  assert.ok(!raw.includes(TOKEN), "a Turnstile token never appears, only its length");
  // a filled token: the Turnstile has passed — reported, not logged (r1 #7)
  assert.deepStrictEqual([body.turnstilePassed, body.route, body.log.logged], [true, "none", false]);
  assert.strictEqual(logText(), null);
});

// ── never values ────────────────────────────────────────────────────────────

const JAR = [
  { name: "cf_clearance", value: SECRET, domain: ".canva.com", path: "/", secure: true, httpOnly: true, sameSite: "None", partitionKey: { topLevelSite: "https://canva.com", hasCrossSiteAncestor: false } },
  { name: "__cf_bm", value: SECRET + "-bm", domain: ".canva.com", path: "/" },
  { name: "__cf_bm", value: SECRET + "-chl", domain: "challenges.cloudflare.com", path: "/", partitionKey: { topLevelSite: "https://canva.com" } },
  { name: "CAZ", value: SECRET + "-session", domain: ".canva.com", path: "/" },
];

test("never values: no cookie value reaches any result (pre, detect, outcome) or the log", async () => {
  setup({ url: "https://www.canva.com/", head: HEADS.interstitial, jar: JAR, pageOpts: { top: { title: "Just a moment..." } } });
  const outs = [];
  outs.push((await call({ lane: "L", origin: "https://www.canva.com", stage: "pre" })).raw);
  outs.push((await call({ lane: "L" })).raw);
  outs.push((await call({ lane: "L", origin: "https://www.canva.com", stage: "outcome" })).raw);
  for (const o of outs) assert.ok(!o.includes(SECRET), o);
  assert.ok(!logText().includes(SECRET));
  const pre = JSON.parse(outs[0]);
  assert.deepStrictEqual(pre.cookies.map((c) => c.name).sort(), ["__cf_bm", "__cf_bm", "cf_clearance"], "only Cloudflare names; the site's session cookie is not listed");
  for (const c of pre.cookies) assert.ok(!("value" in c));
});

// ── shape (ii): the pre read ────────────────────────────────────────────────

test("(ii) pre with NO page open on that origin: a partitioned cf_clearance → partitioned; appends nothing", async () => {
  setup({ jar: [JAR[0]] }); // no pages at all
  const { body } = await call({ lane: "L", origin: "https://www.canva.com/some/path?q=1", stage: "pre" });
  assert.deepStrictEqual([body.stage, body.origin, body.cfCookies], ["pre", "https://www.canva.com", "partitioned"]);
  assert.strictEqual(body.log.logged, false);
  assert.strictEqual(logText(), null);
  assert.strictEqual(calls.curl.length + calls.dig.length, 0, "a pre read makes no header or DNS read");
});

test("(ii) pre: a challenge-host cookie partitioned under the site → partitioned; empty jar → none; unpartitioned → present", async () => {
  setup({ jar: [JAR[2]] });
  assert.strictEqual((await call({ lane: "L", origin: "https://www.canva.com", stage: "pre" })).body.cfCookies, "partitioned");
  setup({ jar: [] });
  assert.strictEqual((await call({ lane: "L", origin: "https://www.canva.com", stage: "pre" })).body.cfCookies, "none");
  setup({ jar: [JAR[1]] });
  assert.strictEqual((await call({ lane: "L", origin: "https://www.canva.com", stage: "pre" })).body.cfCookies, "present");
});

test("(ii) pre: a failed jar read → isError, nothing remembered", async () => {
  setup({});
  tool._setDeps({ getCookies: async () => { throw new Error("CDP closed"); } });
  const r = await tool.handler({ lane: "L", origin: "https://x.example", stage: "pre" });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(tool._preReads.size, 0);
});

// ── shape (iii): the outcome line ───────────────────────────────────────────

test("(iii) pre → load → outcome: exactly one outcome line, carrying the state read BEFORE the load", async () => {
  // Empty jar before the load; after the interstitial passes the jar holds a
  // fresh clearance. The line must say none (the pre state), not present.
  let loaded = false;
  setup({ url: "https://www.canva.com/", head: HEADS.vendor, jar: () => (loaded ? [JAR[1]] : []) });
  await call({ lane: "L", origin: "https://www.canva.com", stage: "pre" });
  loaded = true; // the try's load happens here; the page now shows no wall
  const { body } = await call({ lane: "L", origin: "https://www.canva.com", stage: "outcome" });
  assert.deepStrictEqual([body.outcome, body.cfCookiesAtStart, body.cfCookiesNow, body.clicks], ["passed", "none", "present", 0]);
  assert.deepStrictEqual(logLines(), ["2026-10-30T17:00:00Z | L | www.canva.com | vendor | plainflags: passed; cfCookies=none; clicks=0"]);
});

test("(iii) a failed try → `plainflags: failed → handoff`", async () => {
  setup({ url: "https://www.canva.com/", head: HEADS.interstitial, jar: [JAR[0]], pageOpts: { top: { title: "Just a moment..." } } });
  await call({ lane: "L", origin: "https://www.canva.com", stage: "pre" });
  const { body } = await call({ lane: "L", origin: "https://www.canva.com", stage: "outcome" });
  assert.strictEqual(body.outcome, "failed");
  assert.deepStrictEqual(logLines(), ["2026-10-30T17:00:00Z | L | www.canva.com | vendor | plainflags: failed → handoff; cfCookies=partitioned; clicks=0"]);
});

test("(iii) a Turnstile with a filled token → passed; empty → failed (token length only)", async () => {
  setup({ url: "https://go.example.com/f", head: HEADS.ghl, pageOpts: { children: [frame("https://api.leadconnectorhq.com/w", { turnstileInputs: [740] })] } });
  assert.strictEqual((await call({ lane: "L", origin: "https://go.example.com", stage: "outcome" })).body.outcome, "passed");
  setup({ url: "https://go.example.com/f", head: HEADS.ghl, pageOpts: { children: [frame("https://api.leadconnectorhq.com/w", { turnstileInputs: [0] })] } });
  assert.strictEqual((await call({ lane: "L", origin: "https://go.example.com", stage: "outcome" })).body.outcome, "failed");
});

test("(iii) outcome with no pre read → cfCookies=unknown", async () => {
  setup({ url: "https://www.canva.com/", head: HEADS.vendor, jar: [JAR[0]] });
  const { body } = await call({ lane: "L", origin: "https://www.canva.com", stage: "outcome" });
  assert.strictEqual(body.cfCookiesAtStart, "unknown");
  assert.match(logLines()[0], /; cfCookies=unknown; clicks=0$/);
});

test("(iii) a pre read older than 10 min → unknown; at exactly 10 min → still fresh", async () => {
  let t = Date.parse("2026-10-30T17:00:00Z");
  const now = () => new Date(t);
  setup({ url: "https://www.canva.com/", head: HEADS.vendor, jar: [], now });
  await call({ lane: "L", origin: "https://www.canva.com", stage: "pre" });
  t += tool.PRE_TTL_MS + 1;
  assert.strictEqual((await call({ lane: "L", origin: "https://www.canva.com", stage: "outcome" })).body.cfCookiesAtStart, "unknown");
  setup({ url: "https://www.canva.com/", head: HEADS.vendor, jar: [], now });
  await call({ lane: "L", origin: "https://www.canva.com", stage: "pre" });
  t += tool.PRE_TTL_MS;
  assert.strictEqual((await call({ lane: "L", origin: "https://www.canva.com", stage: "outcome" })).body.cfCookiesAtStart, "none");
});

test("(iii) a pre read is per lane AND origin, and is used once", async () => {
  setup({ url: "https://www.canva.com/", head: HEADS.vendor, jar: [] });
  await call({ lane: "OTHER", origin: "https://www.canva.com", stage: "pre" });
  await call({ lane: "L", origin: "https://other.example", stage: "pre" });
  assert.strictEqual((await call({ lane: "L", origin: "https://www.canva.com", stage: "outcome" })).body.cfCookiesAtStart, "unknown");
  await call({ lane: "L", origin: "https://www.canva.com", stage: "pre" });
  assert.strictEqual((await call({ lane: "L", origin: "https://www.canva.com", stage: "outcome" })).body.cfCookiesAtStart, "none");
  assert.strictEqual((await call({ lane: "L", origin: "https://www.canva.com", stage: "outcome" })).body.cfCookiesAtStart, "unknown", "consumed");
});

test("(iii) outcome on a page that is not on that origin → refused, nothing appended", async () => {
  setup({ url: "https://www.canva.com/", head: HEADS.vendor });
  const r = await tool.handler({ lane: "L", origin: "https://go.example.com", stage: "outcome" });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(logText(), null);
});

test("lines carry the passed lane and are appended, never rewritten", async () => {
  setup({ url: "https://www.canva.com/", head: HEADS.interstitial, pageOpts: { top: { title: "Just a moment..." } } });
  await call({ lane: "LANE-A" });
  const first = logText();
  await call({ lane: "LANE-B" });
  const second = logText();
  assert.ok(second.startsWith(first));
  assert.deepStrictEqual(logLines().map((l) => l.split(" | ")[1]), ["LANE-A", "LANE-B"]);
});

// ── the plain-flags switch, with the build constant on (the 1c path) ────────

test("built mode (seam): HighLevel → base route + switchTo in default mode; sign-in list respected", async () => {
  setup({ url: "https://go.example.com/f", head: HEADS.ghl, pageOpts: { top: { turnstileInputs: [0] } } });
  tool._setDeps({ built: true });
  let { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.plainflagsEligible, body.reason, body.route, body.switchTo], [true, "eligible", "in-page-turnstile", "browser-mcp-relay-plainflags"]);
  setup({ url: "https://auth.hostinger.com/login", head: HEADS.interstitial, pageOpts: { top: { title: "Just a moment..." } } });
  tool._setDeps({ built: true });
  ({ body } = await call({ lane: "L" }));
  assert.deepStrictEqual([body.plainflagsEligible, body.reason], [false, "signin-not-listed"]);
  // listed through the real loader → eligible
  fs.writeFileSync(path.join(tmp, "plainflags-signin.json"), JSON.stringify({ accounts: [{ name: "hostinger", askId: "as-ops/ask-z" }] }));
  ({ body } = await call({ lane: "L" }));
  assert.deepStrictEqual([body.plainflagsEligible, body.reason], [true, "eligible"]);
});

test("(iii) outcome is refused in the DEFAULT relay (configure mode default, as index.js wires it) — nothing read or appended", async () => {
  setup({ url: "https://www.canva.com/", head: HEADS.vendor, jar: [JAR[0]] });
  tool.configure({ mode: "default" });
  const r = await tool.handler({ lane: "L", origin: "https://www.canva.com", stage: "outcome" });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /only the plain-flags relay/);
  assert.strictEqual(calls.cookies, 0, "nothing was read");
  assert.strictEqual(logText(), null, "nothing was appended");
  teardown();
});

// ── review r1 fixes ─────────────────────────────────────────────────────────

test("r1 #1: a normal page while curl is challenged → kind none, nothing appended; curl's read is in signals", async () => {
  setup({ url: "https://www.canva.com/", head: HEADS.interstitial, pageOpts: { top: { title: "Canva", navStatus: 200 } } });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.kind, body.route], ["vendor", "none", "none"]);
  assert.deepStrictEqual(body.signals.curl, { status: 403, cfMitigated: "challenge", accessRedirect: false });
  assert.ok(body.notes.some((n) => /curl was challenged/.test(n)));
  assert.strictEqual(logText(), null);
});

test("r1 #1: a signed-in page while curl gets a 302 to Access → not access, nothing appended", async () => {
  setup({ url: "https://ala-b2b.scale-265.workers.dev/app", head: "HTTP/2 302\r\nlocation: https://scale.cloudflareaccess.com/cdn-cgi/access/login/ala-b2b.scale-265.workers.dev\r\ncf-ray: 9\r\n" });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.kind, body.route], ["workersdev", "none", "none"]);
  assert.strictEqual(body.signals.curl.accessRedirect, true);
  assert.strictEqual(logText(), null);
});

test("r1 #1/#13: the browser on the Access login page → access, logged under the protected app's host", async () => {
  setup({ url: "https://scale.cloudflareaccess.com/cdn-cgi/access/login/ala-b2b.scale-265.workers.dev?kid=k&redirect_url=%2Fx", head: HEADS.vendor });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.kind, body.route, body.protectedHost], ["access", "none", "§3.3", "ala-b2b.scale-265.workers.dev"]);
  assert.deepStrictEqual(logLines(), ["2026-10-30T17:00:00Z | L | ala-b2b.scale-265.workers.dev | access | detected access-login; next §3.3"]);
  // no app named in the URL → the Access host itself
  setup({ url: "https://scale.cloudflareaccess.com/", head: HEADS.vendor });
  await call({ lane: "L" });
  assert.match(logLines()[0], /\| scale\.cloudflareaccess\.com \| access \|/);
});

test("r1 #2: a GHL form frame on an agency site → highlevel, never agency (no false phase-2 gate)", async () => {
  setup({ url: "https://www.revivemyhair.com/consult", head: HEADS.vendor, pageOpts: {
    top: { title: "Consult" },
    children: [frame("https://api.leadconnectorhq.com/widget/form/abc", { turnstileInputs: [0] })],
  } });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.ownerFrom, body.route, body.switchTo], ["highlevel", "frame api.leadconnectorhq.com", "in-page-turnstile", "browser-mcp-relay-plainflags"]);
  assert.match(logLines()[0], /\| www\.revivemyhair\.com \| highlevel \| detected turnstile; next in-page-turnstile$/);
  assert.ok(!logText().includes("| agency |"));
});

test("r1 #2: a GHL form frame on a client site off Cloudflare → highlevel (not vendor)", async () => {
  setup({ url: "https://client.example/book", head: HEADS.plain, pageOpts: {
    children: [frame("https://link.msgsndr.com/widget/booking/x", { turnstileDivs: 1 })],
  } });
  assert.strictEqual((await call({ lane: "L" })).body.owner, "highlevel");
});

test("r1 #2: only the challenge frame is visible (widget in a closed shadow root) → its parent frame decides", async () => {
  setup({ url: "https://www.walletreminder.com/", head: HEADS.vendor });
  const top = frame("https://www.walletreminder.com/", { title: "Wallet" });
  const form = frame("https://api.leadconnectorhq.com/widget/form/abc", {});
  const chl = { url: () => "https://challenges.cloudflare.com/x", parentFrame: () => form, evaluate: async () => { throw new Error("never"); } };
  const p = { url: () => "https://www.walletreminder.com/", mainFrame: () => top, frames: () => [top, form, chl], isClosed: () => false, once() {} };
  globalThis.__relayBridge.context = { pages: () => [p] };
  setActivePage(p);
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.kind, body.owner, body.signals.widgetFrameHost], ["turnstile", "highlevel", "api.leadconnectorhq.com"]);
});

test("r1 #2: a Turnstile in the top document of an agency site keeps the agency owner, in-page route", async () => {
  setup({ url: "https://www.walletreminder.com/contact", head: HEADS.vendor, pageOpts: { top: { turnstileInputs: [0] } } });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.route], ["agency", "in-page-turnstile"]);
});

test("r1 #6: a 429 off Cloudflare (owner none) → nothing appended", async () => {
  setup({ url: "https://api.example.org/x", head: "HTTP/1.1 429 Too Many Requests\r\nserver: nginx\r\n", pageOpts: { top: { navStatus: 429 } } });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.kind, body.route, body.log.logged], ["none", "ratelimit", "none", false]);
  assert.strictEqual(logText(), null);
});

test("r1 #8: curl runs with -q first and -g (no globbing of [a-b] in the path)", () => {
  const args = tool._curlArgs("https://x.example/a[1-9]/{b,c}");
  assert.strictEqual(args[0], "-q");
  assert.ok(args.includes("-g"));
  assert.strictEqual(args[args.length - 1], "https://x.example/a[1-9]/{b,c}");
});

test("r1 #9: the page probe's output is bounded on the Node side", async () => {
  setup({ url: "https://go.example.com/", head: HEADS.vendor, pageOpts: { top: {
    title: "Just a moment".padEnd(10000, "x"),
    turnstileInputs: Array.from({ length: 5000 }, () => 3),
    errorCodes: ["999999", "600010", "<script>", "110200", ...Array(5000).fill("600010")],
    challengeIframes: -5, turnstileDivs: "lots", navStatus: "200; drop table",
  } } });
  const { body } = await call({ lane: "L" });
  const top = body.signals.frames[0];
  assert.strictEqual(top.title.length, 200);
  assert.strictEqual(top.turnstileInputs.length, 20);
  assert.deepStrictEqual(top.errorCodes, ["600010", "110200"]);
  assert.deepStrictEqual([top.challengeIframes, top.turnstileDivs, top.navStatus], [0, 0, null]);
});

test("r1 #11a: the PRODUCTION default refuses stage outcome (no dep overrides)", async () => {
  tool._resetDeps();
  globalThis.__relayBridge = { context: { pages: () => [] } };
  const r = await tool.handler({ lane: "L", origin: "https://www.canva.com", stage: "outcome" });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /only the plain-flags relay/);
});

test("r1 #11b: a host dig would read as an option (-x.example) never reaches dig", async () => {
  setup({ url: "https://-x.example/", head: HEADS.plain });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual(calls.dig, []);
  assert.match(body.signals.errors.dig, /not a DNS name/);
});

test("r1 #11c: hung frames time out, concurrently (10 hung frames ≪ 10 × the timeout)", { timeout: 5000 }, async () => {
  const hung = Array.from({ length: 10 }, (_, i) => ({ url: () => `https://f${i}.example/`, evaluate: () => new Promise(() => {}) }));
  setup({ url: "https://go.example.com/", head: HEADS.vendor, pageOpts: { children: hung } });
  tool._setDeps({ frameTimeoutMs: 150 });
  const t0 = Date.now();
  const { body } = await call({ lane: "L" });
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.strictEqual(body.signals.frames.filter((f) => /timed out/.test(f.unreadable || "")).length, 10);
});

test("r1 #13: expired pre reads are evicted on the next call", async () => {
  let t = Date.parse("2026-10-30T17:00:00Z");
  setup({ jar: [], now: () => new Date(t) });
  await call({ lane: "A", origin: "https://a.example", stage: "pre" });
  assert.strictEqual(tool._preReads.size, 1);
  t += tool.PRE_TTL_MS + 1;
  await call({ lane: "B", origin: "https://b.example", stage: "pre" });
  assert.deepStrictEqual([...tool._preReads.keys()], ["B\nhttps://b.example"]);
});

test("r1 #1: curl gets a 429 while the page loaded fine → kind none, nothing appended", async () => {
  setup({ url: "https://alaunderscrubs.com/cart", head: HEADS.shopify429, pageOpts: { top: { navStatus: 200 } } });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.kind, body.route, body.signals.curl.status], ["shopify", "none", "none", 429]);
  assert.strictEqual(logText(), null);
});

// ── review r2 fixes ─────────────────────────────────────────────────────────

test("r2 #1 (probe A): a GHL form served from the white-label domain on an agency site → highlevel, not agency", async () => {
  setup({
    url: "https://www.revivemyhair.com/consult", head: HEADS.vendor,
    digByHost: { "go.revivemyhair.com": { CNAME: "sites.ludicrous.cloud.\n", A: "sites.ludicrous.cloud.\n162.159.140.166\n" } },
    pageOpts: { top: { title: "Consult" }, children: [frame("https://go.revivemyhair.com/widget/form/abc", { turnstileInputs: [0] })] },
  });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.ownerFrom, body.signals.widgetFrameHost], ["highlevel", "frame go.revivemyhair.com", "go.revivemyhair.com"]);
  assert.ok(calls.dig.some(([t, h]) => t === "CNAME" && h === "go.revivemyhair.com"));
  assert.match(logLines()[0], /\| www\.revivemyhair\.com \| highlevel \|/);
  assert.ok(!logText().includes("| agency |"));
});

test("r2 #1: the widget-frame DNS read is skipped for HighLevel domains and unsafe hosts", async () => {
  setup({ url: "https://www.example.com/", head: HEADS.vendor, pageOpts: { children: [
    frame("https://api.leadconnectorhq.com/w", { turnstileInputs: [0] }),
    frame("https://-x.example/w", { turnstileInputs: [0] }),
  ] } });
  await call({ lane: "L" });
  assert.deepStrictEqual(calls.dig.map(([, h]) => h).sort(), ["www.example.com", "www.example.com"]);
});

test("r2 #7: go.revivemyhair.com with a same-host marked child → highlevel by the page's headers (no DNS answer)", async () => {
  setup({ url: "https://go.revivemyhair.com/f", head: HEADS.ghl, digByHost: {}, pageOpts: {
    children: [frame("https://go.revivemyhair.com/widget/form/abc", { turnstileInputs: [0] })],
  } });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.owner, body.ownerFrom], ["highlevel", "page"]);
  assert.strictEqual(calls.dig.length, 2, "only the page host is dug");
});

test("r2 #3: one filled form beside an unsolved one is still a wall", async () => {
  setup({ url: "https://go.example.com/", head: HEADS.ghl, pageOpts: { top: { turnstileInputs: [400] },
    children: [frame("https://api.leadconnectorhq.com/w", { turnstileInputs: [0] })] } });
  const { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.turnstilePassed, body.log.logged], [false, true]);
});

test("r2 #4: a frame host is capped", async () => {
  const long = Array.from({ length: 6 }, () => "c".repeat(60)).join(".") + ".example";
  setup({ url: "https://go.example.com/", head: HEADS.vendor, pageOpts: { children: [frame(`https://${long}/`, {})] } });
  const { body } = await call({ lane: "L" });
  assert.ok(body.signals.frames.every((f) => f.host.length <= 253));
});

test("r2 #5: an Access login URL naming an over-long host → the line carries the Access host", async () => {
  setup({ url: "https://scale.cloudflareaccess.com/cdn-cgi/access/login/" + "a".repeat(64) + ".example", head: HEADS.vendor });
  await call({ lane: "L" });
  assert.match(logLines()[0], /\| scale\.cloudflareaccess\.com \| access \|/);
});

test("r2 #8: the same lane + host + owner within 60 s appends nothing; after 60 s, or another lane, it does", async () => {
  let t = Date.parse("2026-10-30T17:00:00Z");
  setup({ url: "https://www.canva.com/", head: HEADS.interstitial, now: () => new Date(t), pageOpts: { top: { title: "Just a moment..." } } });
  const first = (await call({ lane: "L" })).body.log;
  assert.strictEqual(first.logged, true);
  t += 59 * 1000;
  const dup = (await call({ lane: "L" })).body.log;
  assert.deepStrictEqual([dup.logged, dup.duplicateOf], [false, "2026-10-30T17:00:00Z"]);
  assert.match(dup.note, /do not append another/);
  assert.strictEqual((await call({ lane: "OTHER" })).body.log.logged, true);
  t += 1000; // 60 s after the first
  assert.strictEqual((await call({ lane: "L" })).body.log.logged, true);
  assert.strictEqual(logLines().length, 3);
});

// ── F1 through the scan: ids / parentId from the frame tree ─────────────────

test("F1 (scan): frames carry id/parentId; a filled form with TWO challenge frames (one widget's input hidden) is a wall, logged", async () => {
  const top = frame("https://go.example.com/book", { title: "Book" });
  const form = frame("https://api.leadconnectorhq.com/widget/form/x", { turnstileInputs: [TOKEN.length] });
  form.parentFrame = () => top;
  const chl = (vis) => ({ url: () => "https://challenges.cloudflare.com/x", parentFrame: () => form, evaluate: async () => { throw new Error("never"); },
    frameElement: async () => ({ boundingBox: async () => (vis ? { x: 0, y: 0, width: 300, height: 65 } : null) }) });
  const pg = (children) => ({ url: () => "https://go.example.com/book", mainFrame: () => top, frames: () => [top, form, ...children], isClosed: () => false, once() {} });
  setup({ head: HEADS.ghl });
  globalThis.__relayBridge = { context: { pages: () => [pg([chl(true)])] } };
  setActivePage(pg([chl(true)]));
  let { body } = await call({ lane: "L" });
  assert.strictEqual(body.turnstilePassed, true, "one widget, filled");
  assert.deepStrictEqual(body.signals.frames.map((f) => [f.id, f.parentId]), [[0, null], [1, 0], [2, 1]]);
  assert.strictEqual(body.signals.frames[2].visible, true);
  const p2 = pg([chl(true), chl(true)]);
  globalThis.__relayBridge = { context: { pages: () => [p2] } };
  setActivePage(p2);
  ({ body } = await call({ lane: "L" }));
  assert.strictEqual(body.turnstilePassed, false, "F1: the second widget is not proven solved");
  assert.strictEqual(body.log.logged, true);
  const p3 = pg([chl(true), chl(false)]);
  globalThis.__relayBridge = { context: { pages: () => [p3] } };
  setActivePage(p3);
  ({ body } = await call({ lane: "L2" }));
  assert.strictEqual(body.turnstilePassed, true, "a challenge frame with no box does not count");
});

test("configure(): plain-flags mode → plainflags-try with clickBudget from the shared count; default → switch, budget 0, outcome refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cfdetect-clicks-"));
  const { createClickCounter } = require("../../src/challenge-clicks.js");
  const clicks = createClickCounter({ root: dir });
  setup({ url: "https://www.canva.com/", head: HEADS.interstitial, pageOpts: { top: { title: "Just a moment..." } } });
  tool.configure({ mode: "plainflags", signin: createSigninLoader({ path: path.join(tmp, "plainflags-signin.json") }), clicks });
  let { body } = await call({ lane: "L" });
  assert.deepStrictEqual([body.route, body.clickBudget, body.fallbackRoute], ["plainflags-try", 1, "§3.4"]);
  clicks.claim("www.canva.com", "L");
  ({ body } = await call({ lane: "L2" }));
  assert.strictEqual(body.clickBudget, 0, "spent by any plain-flags relay → no budget");
  tool.configure({ mode: "default" });
  ({ body } = await call({ lane: "L3" }));
  assert.deepStrictEqual([body.route, body.clickBudget, body.switchTo], ["§3.4", 0, "browser-mcp-relay-plainflags"]);
  const r = await tool.handler({ lane: "L", origin: "https://www.canva.com", stage: "outcome" });
  assert.strictEqual(r.isError, true);
});
