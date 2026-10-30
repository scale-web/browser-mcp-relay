// plainflags-policy.test.js — the plain-flags relay's tool surface and limits
// (spec v8 §5.6 (6)(a)(d)(g), (7), (10)) through the REAL RelayServer, with a
// fake upstream that records every call. No browser.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RelayServer } = require("../src/relay-server.js");
const { createPlainflagsPolicy, selectorProblem, secretFieldProblem, stripItems } = require("../src/plainflags-policy.js");
const { createSigninPolicy } = require("../src/plainflags-signin-guard.js");
const { createSigninLoader } = require("../src/plainflags-signin.js");
const pfMode = require("../src/plainflags-mode.js");
const sync = require("../src/own-tools/_upstream-sync.js");
const requestBodyFilter = require("../src/request-body-filter.js");
const { tools: ownTools, plainflagsTools } = require("../src/own-tools/index.js");
const forwarded = require("../scripts/inspector-forwarded-tools.js").tools;

const PASSWORD = "Fixture-Pa55word-Zq9";
const EMAIL = "zztest-fixture@example.invalid";

const ACCOUNTS = [
  { name: "fixturebank", loginMatchers: [{ host: "login.fixturebank.test" }], cookieOrigins: ["https://login.fixturebank.test"], sessionCookies: ["FBSESS"], federating: false, signsInVia: [] },
  { name: "fixturedesign", loginMatchers: [{ host: "www.fixturedesign.test", pathPrefixes: ["/login"] }], cookieOrigins: ["https://www.fixturedesign.test"], sessionCookies: [], federating: false, signsInVia: [] },
];

class FakeUpstream {
  constructor() { this.calls = []; this.field = {}; this.executeFails = false; }
  async request(method, params) {
    if (method === "tools/list") {
      const props = (n) => (n === "o11y_get-http-requests" ? { includeRequestHeaders: {}, includeResponseHeaders: {}, includeResponseBody: {}, limit: {} }
        : n.startsWith("navigation_") ? { url: {}, includeSnapshot: {}, snapshotOptions: {}, includeScreenshot: {} } : { selector: {} });
      return { tools: forwarded.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: props(t.name) } })) };
    }
    this.calls.push(params);
    if (params.name === "execute") {
      if (this.executeFails) return { isError: true, content: [{ type: "text", text: "boom" }] };
      const m = /page\.locator\(("(?:[^"\\]|\\.)*")\)/.exec(params.arguments.code);
      const sel = m ? JSON.parse(m[1]) : null;
      const info = this.field[sel];
      if (!info) return { content: [{ type: "text", text: JSON.stringify({ error: "Timeout 5000ms exceeded" }) }], structuredContent: { error: "Timeout 5000ms exceeded" } };
      return { content: [{ type: "text", text: JSON.stringify({ result: info }) }], structuredContent: { toolOutputs: [], logs: [], result: info } };
    }
    if (params.name === "upstream_throws") throw new Error(`upstream error: locator.fill: Timeout\nCall log:\n  - locator resolved to <input value="${PASSWORD}">`);
    if (params.name === "content_take-screenshot") {
      if (params.arguments.outputPath && params.arguments.outputPath.endsWith(".relay-screenshots")) {
        const f = path.join(params.arguments.outputPath, "shot-1.png");
        fs.writeFileSync(f, "PNG");
        const result = { filePath: f };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
      }
      const result = { filePath: "/tmp/s.png", annotations: [{ ref: "e1", number: 1, role: "textbox", name: PASSWORD, box: { x: 0, y: 0, width: 1, height: 1 } }] };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    }
    if (params.name === "interaction_click" && params.arguments.selector === "#x") {
      return { isError: true, content: [{ type: "text", text: `locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('#x')\n    - locator resolved to <input id="pw" value="${PASSWORD}"/>` }] };
    }
    if (params.name === "navigation_go-to" || params.name === "navigation_go-back-or-forward") {
      // upstream's default: an ARIA snapshot with every input's value as text
      const result = { url: "https://x.example/", status: 200, ok: true, output: `- textbox "Password": ${PASSWORD}`, refs: { e1: { role: "textbox", name: PASSWORD } } };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    }
    if (params.name === "o11y_get-http-requests") {
      const result = { requests: [{ url: "https://login.example/session", method: "POST", body: `email=${EMAIL}&password=${PASSWORD}`, headers: { cookie: `s=${PASSWORD}` }, responseHeaders: { "set-cookie": `t=${PASSWORD}` }, responseBody: PASSWORD, status: 200 }] };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
    }
    return { content: [{ type: "text", text: `forwarded ${params.name}` }] };
  }
}

let tmp;
function signinFile(accounts) {
  const p = path.join(tmp, "plainflags-signin.json");
  if (accounts === null) { try { fs.unlinkSync(p); } catch {} return p; }
  fs.writeFileSync(p, typeof accounts === "string" ? accounts : JSON.stringify({ accounts }));
  // a distinct mtime/size each write, so the loader sees the change
  const t = Date.now() / 1000 + Math.random();
  fs.utimesSync(p, t, t);
  return p;
}

const VERIFY_OK = () => ({ ok: true });
function makeRelay({ listed = [], guard = null, verifyAsk = VERIFY_OK, lockState = { locked: false }, screenshotDir } = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pfpolicy-"));
  const p = signinFile(listed);
  const loader = createSigninLoader({ path: p, log: () => {} });
  const signin = createSigninPolicy({ accounts: ACCOUNTS, loader, verifyAsk });
  const upstream = new FakeUpstream();
  const notices = [];
  const lock = { probes: 0, state: lockState, probe: async () => { lock.probes++; return typeof lock.state === "function" ? lock.state() : lock.state; }, status: () => lock.state };
  const policy = createPlainflagsPolicy({ signin, getGuard: () => guard, getUpstream: async () => upstream, notice: (t) => notices.push(t), lock,
    ...(screenshotDir ? { screenshotDir } : {}) });
  const counters = { ensureBrave: 0 };
  const relay = new RelayServer({ getUpstream: async () => upstream, ensureBrave: async () => { counters.ensureBrave++; }, policy });
  const own = {};
  for (const t of [...ownTools, ...plainflagsTools]) {
    // Own tools are registered with recording handlers: the policy, not the tool, is under test.
    own[t.name] = [];
    relay.registerOwnTool({ name: t.name, description: t.description, inputSchema: t.inputSchema, needsBrave: t.needsBrave, handler: async (args) => {
      own[t.name].push(args);
      if (t.name === "capture_xhr") {
        return { content: [{ type: "text", text: JSON.stringify({ count: 1, responses: [{ url: "https://x/api", status: 200, headers: { "content-type": "application/json", "set-cookie": `sid=${PASSWORD}` }, body: `{"token":"${PASSWORD}"}` }] }, null, 2) }] };
      }
      return { content: [{ type: "text", text: `own ${t.name}` }] };
    } });
  }
  return { relay, upstream, own, notices, counters, loader, signin, lock };
}

test.beforeEach(() => { sync.reset(); requestBodyFilter.setSourcePatchInEffect(true); });
test.after(() => { globalThis.__relayBridge = null; });

// ── tool list ───────────────────────────────────────────────────────────────

test("tools/list equals the spec's allowlist EXACTLY (fail closed for every other upstream/own tool)", async () => {
  const { relay } = makeRelay();
  const names = (await relay.handleToolsList()).tools.map((t) => t.name).sort();
  assert.deepStrictEqual(names, [...pfMode.TOOL_ALLOWLIST].sort());
});

test("tools/list schemas: no header/body flags on o11y_get-http-requests, no includeBody on capture_xhr, no opt-in on fill / press-key", async () => {
  const { relay } = makeRelay();
  const by = Object.fromEntries((await relay.handleToolsList()).tools.map((t) => [t.name, t]));
  for (const f of pfMode.TOOL_ALLOWLIST) assert.ok(by[f], f);
  assert.deepStrictEqual(Object.keys(by["o11y_get-http-requests"].inputSchema.properties), ["limit"]);
  assert.ok(!("includeBody" in by.capture_xhr.inputSchema.properties));
  assert.ok(!(sync.OPT_IN in by.interaction_fill.inputSchema.properties));
  assert.ok(!(sync.OPT_IN in by["interaction_press-key"].inputSchema.properties));
  assert.ok(sync.OPT_IN in by.interaction_click.inputSchema.properties, "other guarded tools keep it");
});

test("the DEFAULT relay (no policy) lists every upstream and own tool — execute, cookies_export … included", async () => {
  const upstream = new FakeUpstream();
  const relay = new RelayServer({ getUpstream: async () => upstream });
  for (const t of ownTools) relay.registerOwnTool(t);
  const names = (await relay.handleToolsList()).tools.map((t) => t.name);
  assert.strictEqual(names.length, forwarded.length + ownTools.length);
  for (const n of ["execute", "cookies_export", "storage_get-local", "emulate_device", "navigation_reload"]) assert.ok(names.includes(n), n);
  assert.ok(!names.includes("challenge_click") && !names.includes("cf_cookies_clear"));
});

test("unlisted tools are REFUSED at call time with the route text — nothing forwarded, no Brave launched", async () => {
  const { relay, upstream, own, counters } = makeRelay();
  for (const n of ["execute", "scenario-run", "cookies_import", "cookies_export", "storage_get-local", "storage_set-local",
    "stub_mock-http-response", "emulate_device", "navigation_reload", "debug_put-logpoint", "lighthouse_audit", "stealth_apply"]) {
    const r = await relay.handleToolsCall({ name: n, arguments: {} });
    assert.strictEqual(r.isError, true, n);
    assert.match(r.content[0].text, /REFUSED \(plain-flags relay\).*Use the default browser-mcp-relay/, n);
  }
  assert.match((await relay.handleToolsCall({ name: "execute", arguments: { code: "return 1" } })).content[0].text, /context\.cookies\(\)/);
  assert.match((await relay.handleToolsCall({ name: "navigation_reload", arguments: {} })).content[0].text, /rule zero/);
  assert.strictEqual(upstream.calls.length, 0);
  assert.deepStrictEqual(own.cookies_export, []);
  assert.strictEqual(counters.ensureBrave, 0);
});

// ── headers and bodies (§5.6 (10), review r7 #1, r8 #1) ─────────────────────

test("o11y_get-http-requests: each header/body flag refused; the result carries no body, no headers, and the password NOWHERE", async () => {
  const { relay, upstream } = makeRelay();
  for (const f of ["includeRequestHeaders", "includeResponseHeaders", "includeResponseBody"]) {
    const r = await relay.handleToolsCall({ name: "o11y_get-http-requests", arguments: { [f]: true } });
    assert.strictEqual(r.isError, true, f);
    assert.match(r.content[0].text, /no request headers, response headers or response bodies/);
  }
  assert.strictEqual(upstream.calls.length, 0);
  const r = await relay.handleToolsCall({ name: "o11y_get-http-requests", arguments: {} });
  assert.ok(!r.isError);
  const all = JSON.stringify(r);
  assert.ok(!all.includes(PASSWORD), "the fixture password appears nowhere in the serialized result");
  assert.ok(!all.includes(EMAIL));
  for (const item of r.structuredContent.requests) for (const k of ["body", "headers", "responseHeaders", "responseBody"]) assert.ok(!(k in item), k);
  const text = JSON.parse(r.content.find((c) => c.text.startsWith("{")).text);
  assert.ok(!("body" in text.requests[0]));
});

test("the policy's own strip (without A76's filter) removes body and headers — each layer holds alone (r8 #1)", async () => {
  const result = { requests: [{ url: "u", body: PASSWORD, headers: { a: PASSWORD } }] };
  const { relay } = makeRelay();
  const out = await relay.policy.afterCall("o11y_get-http-requests", { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
  assert.ok(!JSON.stringify(out).includes(PASSWORD));
  assert.strictEqual(stripItems({ nope: 1 }), null);
  const withheld = await relay.policy.afterCall("o11y_get-http-requests", { content: [{ type: "text", text: "not json " + PASSWORD }] });
  assert.ok(!JSON.stringify(withheld).includes(PASSWORD), "unparseable → withheld, fail closed");
});

test("capture_xhr: includeBody:true refused; by default includeBody:false is forced and no body / set-cookie leaves", async () => {
  const { relay, own } = makeRelay();
  const no = await relay.handleToolsCall({ name: "capture_xhr", arguments: { includeBody: true } });
  assert.strictEqual(no.isError, true);
  assert.deepStrictEqual(own.capture_xhr, []);
  const r = await relay.handleToolsCall({ name: "capture_xhr", arguments: { durationMs: 100 } });
  assert.strictEqual(own.capture_xhr[0].includeBody, false);
  assert.ok(!JSON.stringify(r).includes(PASSWORD));
  const body = JSON.parse(r.content.find((c) => c.text.startsWith("{")).text);
  assert.ok(!("body" in body.responses[0]));
  assert.deepStrictEqual(Object.keys(body.responses[0].headers), ["content-type"]);
});

// ── typed secrets (§5.6 (6)(d), review r7 #2, r8 #2) ────────────────────────

test("selectorProblem: refs and locator expressions refused (upstream's parseRef / locator-expression syntax); CSS passes", () => {
  for (const s of ["e5", " e12 ", "@e1", "@anything", "ref=e3", "REF=e3", "getByRole('textbox', { name: 'Password' })", "getByLabel(\"Password\")", "getByTestId('pw')"]) {
    assert.ok(selectorProblem(s), s);
  }
  for (const s of ["#email", "input[name=first]", "form >> input", "e5x", "iframe >> internal:control=enter-frame >> input"]) {
    assert.strictEqual(selectorProblem(s), null, s);
  }
});

test("secretFieldProblem: password type (attribute or property), current-/new-password, one-time-code; ordinary fields pass", () => {
  assert.ok(secretFieldProblem({ tag: "input", type: "password" }));
  assert.ok(secretFieldProblem({ tag: "input", type: "text", prop: "password" }));
  assert.ok(secretFieldProblem({ tag: "input", type: "text", ac: "current-password" }), "a toggled show-password field");
  assert.ok(secretFieldProblem({ tag: "input", type: "text", ac: "section-login username new-password" }));
  assert.ok(secretFieldProblem({ tag: "input", type: "text", ac: "one-time-code" }));
  assert.ok(secretFieldProblem(null), "not inspectable → refused");
  assert.strictEqual(secretFieldProblem({ tag: "input", type: "email", prop: "email", ac: "email" }), null);
  assert.strictEqual(secretFieldProblem({ tag: "textarea", prop: "textarea" }), null);
  assert.strictEqual(secretFieldProblem({ tag: "div", editable: true }), null, "contenteditable");
  assert.match(secretFieldProblem({ tag: "button" }), /not a text field/, "a fill must land on a text field");
  assert.match(secretFieldProblem({ tag: "input", type: "text" }, "select"), /not a <select>/);
  assert.strictEqual(secretFieldProblem({ tag: "select" }, "select"), null);
  assert.ok(secretFieldProblem({ tag: "input", type: "password" }, "focus"), "press-key's focus target");
  assert.strictEqual(secretFieldProblem({ tag: "button" }, "focus"), null);
});

test("interaction_fill: refs/locators refused before upstream; secret fields refused via UPSTREAM's own page; ordinary fields forwarded", async () => {
  const { relay, upstream } = makeRelay();
  upstream.field = {
    "#pw": { tag: "input", type: "password", prop: "password", ac: "" },
    "#shown": { tag: "input", type: "text", prop: "text", ac: "current-password" },
    "#otp": { tag: "input", type: "text", prop: "text", ac: "one-time-code" },
    "#first": { tag: "input", type: "text", prop: "text", ac: "given-name" },
  };
  for (const sel of ["e5", "@e2", "getByRole('textbox')"]) {
    const r = await relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: sel, value: "x" } });
    assert.strictEqual(r.isError, true, sel);
    assert.match(r.content[0].text, /resolves the same way upstream does/);
  }
  assert.strictEqual(upstream.calls.length, 0, "no upstream call for a ref or a locator");
  for (const sel of ["#pw", "#shown", "#otp", "#missing"]) {
    const r = await relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: sel, value: PASSWORD } });
    assert.strictEqual(r.isError, true, sel);
    assert.match(r.content[0].text, /REFUSED/);
  }
  assert.ok(!upstream.calls.some((c) => c.name === "interaction_fill"), "no fill reached upstream");
  assert.ok(upstream.calls.every((c) => c.name === "execute" && !JSON.stringify(c).includes(PASSWORD)), "the value is never sent to the check");
  const ok = await relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: "#first", value: "Zed" } });
  assert.ok(!ok.isError, ok.content.map((c) => c.text).join());
  assert.deepStrictEqual(upstream.calls.filter((c) => c.name === "interaction_fill").map((c) => c.arguments), [{ selector: "#first", value: "Zed" }]);
  upstream.executeFails = true;
  assert.strictEqual((await relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: "#first", value: "Zed" } })).isError, true, "an unverifiable field is refused");
});

test("r8 #2: interaction_fill and press-key refused while DESYNCED, even with allowPinnedPage: true (the opt-in is stripped)", async () => {
  const { relay, upstream } = makeRelay();
  upstream.field = { "#first": { tag: "input", type: "text", prop: "text", ac: "" } };
  sync.markDesynced("https://a.example/", "https://b.example/", "test desync");
  for (const [name, args] of [["interaction_fill", { selector: "#first", value: "Zed" }], ["interaction_press-key", { key: "Enter" }]]) {
    for (const optIn of [false, true]) {
      const r = await relay.handleToolsCall({ name, arguments: optIn ? { ...args, [sync.OPT_IN]: true } : args });
      assert.strictEqual(r.isError, true, `${name} optIn=${optIn}`);
      assert.match(r.content[0].text, /not honoured here/);
    }
  }
  assert.ok(!upstream.calls.some((c) => c.name === "interaction_fill" || c.name === "interaction_press-key"));
  // other guarded tools keep rule B's opt-in
  const click = await relay.handleToolsCall({ name: "interaction_click", arguments: { selector: "#b", [sync.OPT_IN]: true } });
  assert.ok(!click.isError);
});

test("interaction_press-key: named keys only — a, Space, Meta+V, Shift+Tab refused; Enter, Tab forwarded", async () => {
  const { relay, upstream } = makeRelay();
  for (const key of ["a", "A", "Space", " ", "Meta+V", "Control+v", "Shift+Tab", "1", "enter"]) {
    const r = await relay.handleToolsCall({ name: "interaction_press-key", arguments: { key } });
    assert.strictEqual(r.isError, true, key);
  }
  assert.strictEqual((await relay.handleToolsCall({ name: "interaction_press-key", arguments: { key: "Enter", selector: "e5" } })).isError, true, "a ref selector is refused here too");
  assert.strictEqual(upstream.calls.length, 0);
  for (const key of ["Enter", "Tab", "Escape", "ArrowDown"]) assert.ok(!(await relay.handleToolsCall({ name: "interaction_press-key", arguments: { key } })).isError, key);
  assert.deepStrictEqual(upstream.calls.map((c) => c.arguments.key), ["Enter", "Tab", "Escape", "ArrowDown"]);
});

test("form_fill: each field inspected on the relay's page — a password / current-password field refuses the WHOLE call; text fields fill", async () => {
  const { relay, own } = makeRelay();
  const info = { "#pw": { tag: "input", type: "password", prop: "password", ac: "" }, "iframe >> internal:control=enter-frame >> #pw": { tag: "input", type: "password", prop: "password", ac: "" }, "#shown": { tag: "input", type: "text", prop: "text", ac: "current-password" }, "#first": { tag: "input", type: "text", prop: "text", ac: "" } };
  const page = { isClosed: () => false, locator: (sel) => ({ first: () => ({ evaluate: async () => { if (!info[sel]) throw new Error("timeout"); return info[sel]; } }) }) };
  globalThis.__relayBridge = { context: { pages: () => [page] } };
  require("../src/own-tools/_active-page.js").setActivePage(page);
  for (const sel of ["#pw", "iframe >> internal:control=enter-frame >> #pw", "#shown", "#nope", "e5"]) {
    const r = await relay.handleToolsCall({ name: "form_fill", arguments: { fields: [{ selector: "#first", value: "Zed" }, { selector: sel, value: PASSWORD }] } });
    assert.strictEqual(r.isError, true, sel);
  }
  assert.deepStrictEqual(own.form_fill, [], "nothing was filled");
  const ok = await relay.handleToolsCall({ name: "form_fill", arguments: { fields: [{ selector: "#first", value: "Zed" }] } });
  assert.ok(!ok.isError);
  assert.strictEqual(own.form_fill.length, 1);
});

// ── sign-in guard layer 1 + live list (§5.6 (6)(a), (g)) ────────────────────

test("layer 1: a not-listed login host (and host+path) refused before any browser work; the public path and a listed account go through", async () => {
  const { relay, upstream, counters } = makeRelay();
  for (const url of ["https://login.fixturebank.test/", "https://LOGIN.fixturebank.test./x", "https://www.fixturedesign.test/login", "https://www.fixturedesign.test//Login/", "https://www.fixturedesign.test/%6Cogin"]) {
    const r = await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url } });
    assert.strictEqual(r.isError, true, url);
    assert.match(r.content[0].text, /sign-in guard/);
  }
  const tn = await relay.handleToolsCall({ name: "tabs_new", arguments: { url: "https://login.fixturebank.test/" } });
  assert.strictEqual(tn.isError, true, "tabs_new's url too");
  assert.strictEqual(upstream.calls.length, 0);
  assert.strictEqual(counters.ensureBrave, 0, "no browser work");
  assert.ok(!(await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://www.fixturedesign.test/" } })).isError);
  assert.ok(!(await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://www.fixturedesign.test/loginx" } })).isError);
  signinFile([{ name: "fixturebank", askId: "as-ops/ask-test" }]);
  assert.ok(!(await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://login.fixturebank.test/" } })).isError, "listed → loads");
});

test("layer 1: a missing or malformed sign-in file reads as EMPTY (every known account refused)", async () => {
  const { relay } = makeRelay({ listed: [{ name: "fixturebank", askId: "a" }] });
  signinFile("{not json");
  assert.strictEqual((await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://login.fixturebank.test/" } })).isError, true);
  signinFile(null);
  assert.strictEqual((await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://login.fixturebank.test/" } })).isError, true);
});

test("Meta guard layer 1 is active in plain-flags mode (before the policy)", async () => {
  const { relay, upstream } = makeRelay();
  const r = await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://www.facebook.com/" } });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /Meta property/);
  assert.strictEqual(upstream.calls.length, 0);
});

test("(g) an account taken OFF the list is cleared on the next call (with a Brave up); the sweep runs before and after", async () => {
  const cleared = [];
  let sweeps = 0;
  const guard = { clearAccounts: async (accts, why) => { cleared.push([accts.map((a) => a.name), why]); return []; }, sweep: async () => { sweeps++; return sweeps === 3 ? ["fixturebank"] : []; } };
  const { relay, notices } = makeRelay({ listed: [{ name: "fixturebank", askId: "a" }], guard });
  await relay.handleToolsCall({ name: "tabs_list", arguments: {} });
  assert.deepStrictEqual(cleared, []);
  signinFile([]);
  await relay.handleToolsCall({ name: "tabs_list", arguments: {} });
  assert.deepStrictEqual(cleared, [[["fixturebank"], "taken off the sign-in list"]]);
  assert.ok(notices.some((n) => /taken off the sign-in list/.test(n)));
  assert.strictEqual(sweeps, 4, "before + after each call");
  assert.ok(notices.some((n) => /deleted the session cookie\(s\) of fixturebank on arrival/.test(n)));
});

test("a failing sweep refuses the call (fail closed)", async () => {
  const guard = { clearAccounts: async () => [], sweep: async () => { throw new Error("cdp gone"); } };
  const { relay, upstream } = makeRelay({ guard });
  const r = await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://x.example/" } });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /sweep failed/);
  assert.strictEqual(upstream.calls.length, 0);
});

// ── round 1 item 1: Playwright's label retargeting ──────────────────────────
// The probe also runs in a real browser: test/isolated-plainflags.test.js.

/** A minimal element model with matches / closest / control / isContentEditable. */
function el(tag, attrs = {}, parent = null) {
  const e = { nodeType: 1, tagName: tag.toUpperCase(), attrs, parentElement: parent, isContentEditable: false, control: null,
    getAttribute: (k) => (k in attrs ? attrs[k] : null), get type() { return tag === "input" ? (attrs.type || "text") : tag === "textarea" ? "textarea" : ""; } };
  e.matches = (s) => s.split(",").map((x) => x.trim()).some((one) => {
    const m = /^([a-z]*)(?:\[role=([a-z]+)\])?$/.exec(one);
    if (!m || !(m[1] || m[2])) return false;
    if (m[1] && m[1] !== tag) return false;
    if (m[2] && attrs.role !== m[2]) return false;
    return true;
  });
  e.closest = (s) => { for (let x = e; x; x = x.parentElement) if (x.matches(s)) return x; return null; };
  return e;
}

test("round 1 item 1: fieldProbe follows Playwright's retarget — label[for], a span inside a wrapping label, a nested label → the password control; focus does not retarget", () => {
  const { fieldProbe } = require("../src/plainflags-policy.js");
  const pw = el("input", { type: "password" });
  const labelFor = el("label", { for: "pw" }); labelFor.control = pw;
  const outer = el("label"); outer.control = pw;
  const span = el("span", {}, outer);
  const inner = el("label", {}, outer); inner.control = pw;
  const deepSpan = el("span", {}, inner);
  for (const [what, node] of [["label[for]", labelFor], ["span in a wrapping label", span], ["nested label", deepSpan]]) {
    const info = fieldProbe(node, "fill");
    assert.strictEqual(info.type, "password", what);
    assert.strictEqual(info.retargeted, true, what);
    assert.match(secretFieldProblem(info, "fill"), /reaches a password field/, what);
  }
  assert.strictEqual(fieldProbe(labelFor, "focus").tag, "label", "focus acts on the node itself");
  const btn = el("button", {}, outer);
  assert.strictEqual(fieldProbe(btn, "fill").tag, "button", "a button inside a label is not retargeted (Playwright's rule)");
  const inBtn = el("span", {}, btn);
  assert.strictEqual(fieldProbe(inBtn, "fill").tag, "button", "a span inside a button inside a label: Playwright acts on the button, not the label's control");
  const roleCb = el("div", { role: "checkbox" }, outer);
  assert.strictEqual(fieldProbe(el("span", {}, roleCb), "fill").tag, "div", "the [role=checkbox] step comes first");
  const textLabel = el("label"); textLabel.control = el("input", { type: "text" });
  assert.strictEqual(secretFieldProblem(fieldProbe(textLabel, "fill"), "fill"), null, "a label for an ordinary field is fine");
});

test("round 1 item 1: interaction_fill / select / press-key-with-selector inspect the RETARGETED element on upstream's page", async () => {
  const { relay, upstream } = makeRelay();
  upstream.field = {
    "label[for=pw]": { tag: "input", type: "password", prop: "password", ac: "", retargeted: true },
    "#sel": { tag: "select", type: "", prop: "select-one", ac: "" },
    "#notsel": { tag: "input", type: "text", prop: "text", ac: "" },
    "#pwfocus": { tag: "input", type: "password", prop: "password", ac: "" },
    "#btn": { tag: "button", type: "", prop: "submit", ac: "" },
  };
  const f = await relay.handleToolsCall({ name: "interaction_fill", arguments: { selector: "label[for=pw]", value: PASSWORD } });
  assert.strictEqual(f.isError, true);
  assert.match(f.content[0].text, /reaches a password field/);
  assert.ok(upstream.calls.some((c) => c.name === "execute" && /"fill"/.test(c.arguments.code)), "the probe runs in fill mode");
  assert.ok(!(await relay.handleToolsCall({ name: "interaction_select", arguments: { selector: "#sel", value: "a" } })).isError);
  assert.strictEqual((await relay.handleToolsCall({ name: "interaction_select", arguments: { selector: "#notsel", value: "a" } })).isError, true);
  const execsBefore = upstream.calls.filter((c) => c.name === "execute").length;
  const ref = await relay.handleToolsCall({ name: "interaction_select", arguments: { selector: "e3", value: "a" } });
  assert.strictEqual(ref.isError, true, "a ref for select too");
  assert.match(ref.content[0].text, /resolves the same way upstream does/);
  assert.strictEqual(upstream.calls.filter((c) => c.name === "execute").length, execsBefore, "refused before any upstream call");
  assert.strictEqual((await relay.handleToolsCall({ name: "interaction_press-key", arguments: { key: "Enter", selector: "#pwfocus" } })).isError, true);
  assert.ok(!(await relay.handleToolsCall({ name: "interaction_press-key", arguments: { key: "Enter", selector: "#btn" } })).isError);
  assert.ok(!upstream.calls.some((c) => c.name === "interaction_fill"));
});

// ── round 1 items 7 and 10 ──────────────────────────────────────────────────

test("round 1 item 7: nested request/response headers and bodies are stripped from every o11y item", async () => {
  const { relay } = makeRelay();
  const result = { requests: [{ url: "u", request: { headers: { cookie: PASSWORD }, postData: PASSWORD, method: "POST" }, response: { status: 200, headers: { "set-cookie": PASSWORD }, body: PASSWORD } }] };
  const out = await relay.policy.afterCall("o11y_get-http-requests", { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
  assert.ok(!JSON.stringify(out).includes(PASSWORD));
  assert.deepStrictEqual(out.structuredContent.requests[0].response, { status: 200 });
  assert.deepStrictEqual(out.structuredContent.requests[0].request, { method: "POST" });
});

test("round 1 item 10: content_get-as-html blanks the value attribute of password / current-password / new-password / one-time-code inputs only", async () => {
  const { relay } = makeRelay();
  const html = `<form><input type="password" value="${PASSWORD}"><input TYPE=password value='${PASSWORD}2' id=a>` +
    `<input type="text" autocomplete="current-password" value="${PASSWORD}3"><input autocomplete="one-time-code" value=${PASSWORD}4>` +
    `<input name="first" value="Zed"><input type="text" autocomplete="username" value="zz@example.invalid"></form>`;
  const out = await relay.policy.afterCall("content_get-as-html", { content: [{ type: "text", text: JSON.stringify({ output: html }) }], structuredContent: { output: html } });
  assert.ok(!JSON.stringify(out).includes(PASSWORD));
  assert.match(out.structuredContent.output, /value="Zed"/);
  assert.match(out.structuredContent.output, /value="zz@example\.invalid"/);
  const raw = await relay.policy.afterCall("content_get-as-html", { content: [{ type: "text", text: html }] });
  assert.ok(!raw.content[0].text.includes(PASSWORD), "a plain-text HTML result too");
  assert.match(raw.content[0].text, /value="Zed"/);
});

// ── round 1 items 2 and 6: list changes ─────────────────────────────────────

test("round 1 item 6: an ADDITION is announced on the next tool result; an entry its ask does not grant is REFUSED, announced, and stays refused at layer 1", async () => {
  const verify = (name, askId) => (askId === "good/ask-aaaaaa" ? { ok: true } : { ok: false, reason: "no such ask record" });
  const { relay, notices, signin } = makeRelay({ verifyAsk: verify });
  await relay.handleToolsCall({ name: "tabs_list", arguments: {} });
  assert.deepStrictEqual(notices, []);
  signinFile([{ name: "fixturebank", askId: "good/ask-aaaaaa" }, { name: "fixturedesign", askId: "bad/ask-bbbbbb" }]);
  await relay.handleToolsCall({ name: "tabs_list", arguments: {} });
  assert.ok(notices.some((n) => /"fixturebank" is ON the sign-in list/.test(n)), notices.join("\n"));
  assert.ok(notices.some((n) => /"fixturedesign" REFUSED \(no such ask record\)/.test(n)), notices.join("\n"));
  const n = notices.length;
  await relay.handleToolsCall({ name: "tabs_list", arguments: {} });
  assert.strictEqual(notices.length, n, "announced once");
  assert.ok(!(await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://login.fixturebank.test/" } })).isError);
  assert.strictEqual((await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://www.fixturedesign.test/login" } })).isError, true, "a refused entry is not listed");
  const st = signin.status();
  assert.deepStrictEqual(st.listed, ["fixturebank"]);
  assert.strictEqual(st.refused[0].name, "fixturedesign");
  assert.ok(st.recentChanges.some((c) => c.change === "added" && c.account === "fixturebank"));
});

test("round 1 item 2: a removal whose clear FAILS stays pending — the call is refused, and the next call retries and clears it", async () => {
  let fail = true;
  const cleared = [];
  const guard = { alive: () => true, sweep: async () => [], clearAccounts: async (accts) => {
    if (fail) return accts.map((a) => ({ account: a.name, cookies: 0, errors: ["Network.deleteCookies: target closed"] }));
    cleared.push(accts.map((a) => a.name));
    return accts.map((a) => ({ account: a.name, cookies: 1, errors: [] }));
  } };
  const { relay, notices } = makeRelay({ listed: [{ name: "fixturebank", askId: "a" }], guard });
  await relay.handleToolsCall({ name: "tabs_list", arguments: {} });
  signinFile([]);
  const r1 = await relay.handleToolsCall({ name: "tabs_list", arguments: {} });
  assert.strictEqual(r1.isError, true);
  assert.match(r1.content[0].text, /could not be applied/);
  fail = false;
  const r2 = await relay.handleToolsCall({ name: "tabs_list", arguments: {} });
  assert.ok(!r2.isError);
  assert.deepStrictEqual(cleared, [["fixturebank"]], "retried and cleared on the next call");
  assert.ok(notices.some((t) => /taken off the sign-in list/.test(t)));
});

test("round 1 item 2: the change is applied AFTER ensureBrave (which re-arms a dead guard)", async () => {
  const order = [];
  let guard = { alive: () => false, sweep: async () => [], clearAccounts: async () => { order.push("dead-clear"); return []; } };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pfpolicy-"));
  const p = signinFile([{ name: "fixturebank", askId: "a" }]);
  const signin = createSigninPolicy({ accounts: ACCOUNTS, loader: createSigninLoader({ path: p, log: () => {} }), verifyAsk: VERIFY_OK });
  const policy = createPlainflagsPolicy({ signin, getGuard: () => guard, getUpstream: async () => new FakeUpstream() });
  await policy.beforeCall("tabs_list", {}, { ensureBrave: async () => {} });
  signinFile([]);
  const pre = await policy.beforeCall("tabs_list", {}, { ensureBrave: async () => {
    order.push("ensureBrave");
    guard = { alive: () => true, sweep: async () => [], clearAccounts: async (a) => { order.push("clear"); return a.map((x) => ({ account: x.name, cookies: 0, errors: [] })); } };
  } });
  assert.ok(!pre.refusal, pre.refusal && pre.refusal.content[0].text);
  assert.deepStrictEqual(order, ["ensureBrave", "clear"]);
});

// ── round 2 ─────────────────────────────────────────────────────────────────

test("round 2 item 1: no a11y_* tool here (an ARIA snapshot carries typed values) — not listed, refused by name", async () => {
  const { relay, upstream } = makeRelay();
  const names = (await relay.handleToolsList()).tools.map((t) => t.name);
  assert.ok(!names.some((n) => n.startsWith("a11y_")), names.join());
  for (const n of ["a11y_take-aria-snapshot", "a11y_take-ax-tree-snapshot"]) {
    const r = await relay.handleToolsCall({ name: n, arguments: {} });
    assert.strictEqual(r.isError, true, n);
    assert.match(r.content[0].text, /typed value/, n);
  }
  assert.strictEqual(upstream.calls.length, 0);
});

test("round 2 item 1: navigation tools never return the ARIA snapshot — includeSnapshot forced off, true refused, output/refs stripped, schema without it", async () => {
  const { relay, upstream } = makeRelay();
  const by = Object.fromEntries((await relay.handleToolsList()).tools.map((t) => [t.name, t]));
  for (const n of ["navigation_go-to", "navigation_go-back-or-forward"]) {
    assert.ok(!("includeSnapshot" in by[n].inputSchema.properties) && !("snapshotOptions" in by[n].inputSchema.properties), n);
    const no = await relay.handleToolsCall({ name: n, arguments: { url: "https://x.example/", includeSnapshot: true } });
    assert.strictEqual(no.isError, true, n);
    const r = await relay.handleToolsCall({ name: n, arguments: { url: "https://x.example/" } });
    assert.ok(!r.isError, n);
    assert.strictEqual(upstream.calls.at(-1).arguments.includeSnapshot, false, `${n}: forced off`);
    assert.ok(!JSON.stringify(r).includes(PASSWORD), `${n}: no snapshot text in the result`);
    assert.strictEqual(r.structuredContent.url, "https://x.example/", "the rest of the result stays");
  }
});

test("round 2 item 4: a show-password field is still refused — name/id /pass|pwd|otp|passcode/i, or -webkit-text-security not none", () => {
  for (const info of [
    { tag: "input", type: "text", name: "user_pwd" }, { tag: "input", type: "text", id: "Password-Field" },
    { tag: "input", type: "text", name: "otp_code" }, { tag: "input", type: "text", id: "passcode" },
    { tag: "input", type: "text", textSecurity: "disc" }, { tag: "input", type: "text", textSecurity: "circle" },
  ]) assert.ok(secretFieldProblem(info, "fill"), JSON.stringify(info));
  assert.strictEqual(secretFieldProblem({ tag: "input", type: "text", name: "first", id: "first", textSecurity: "none" }, "fill"), null);
  const { fieldProbe } = require("../src/plainflags-policy.js");
  const f = fieldProbe({ nodeType: 1, tagName: "INPUT", type: "text", isContentEditable: false, getAttribute: (k) => ({ name: "pwd", id: "x" })[k] ?? null,
    matches: () => true, closest: () => null }, "fill");
  assert.deepStrictEqual([f.name, f.id], ["pwd", "x"], "the probe reports name and id");
});

test("round 2 item 5: the HTML filter tokenizes attributes — a quoted 'type=text' inside another attribute does not hide type=password", () => {
  const { blankSecretValues } = require("../src/plainflags-policy.js");
  const out = blankSecretValues(`<input placeholder="x type=text" type=password value=${PASSWORD}><input type="text" placeholder="a>b" value="Zed">` +
    `<input type=password value="a b" value=${PASSWORD}2><input name="user_pwd" value='${PASSWORD}3'><input type="text" type="password" value="keep">` +
    `<input placeholder="1 > 0" type=password value=${PASSWORD}4>`);
  assert.ok(!out.includes(PASSWORD), out);
  assert.match(out, /placeholder="a>b" value="Zed"/, "a quoted > does not end the tag; an ordinary field keeps its value");
  assert.match(out, /type="text" type="password" value="keep"/, "the FIRST type attribute wins, as in an HTML parser");
});

// ── round 3 ─────────────────────────────────────────────────────────────────

const LOCKED = { locked: true, reason: "a password / one-time-code field on a tab holds a value" };

test("round 3 A: while LOCKED every tool but relay_status / tabs_list is refused — screenshot (+annotate), get-as-text, get-as-html, navigation, console, http-requests, capture_xhr, clicks, fills, own tools — nothing reaches upstream", async () => {
  const { relay, upstream, own } = makeRelay({ lockState: LOCKED });
  const calls = [
    ["content_take-screenshot", {}], ["content_get-as-text", {}], ["content_get-as-html", {}], ["navigation_go-to", { url: "https://x.example/" }],
    ["navigation_go-back-or-forward", { direction: "back" }], ["o11y_get-console-messages", {}], ["o11y_get-http-requests", {}], ["capture_xhr", {}],
    ["interaction_click", { selector: "#b" }], ["interaction_fill", { selector: "#first", value: "x" }], ["form_fill", { fields: [{ selector: "#a", value: "b" }] }],
    ["tabs_new", { url: "https://x.example/" }], ["tabs_select", { index: 0 }], ["tabs_close", { index: 0 }], ["challenge_detect", { lane: "L" }],
    ["cf_cookies_clear", { origin: "https://x.example" }], ["challenge_click", {}], ["sync_wait-for-network-idle", {}], ["dialog_handle", {}], ["storage_clear-local", {}],
  ];
  for (const [n, args] of calls) {
    const r = await relay.handleToolsCall({ name: n, arguments: args });
    assert.strictEqual(r.isError, true, n);
    assert.match(r.content[0].text, /^\[mcp-relay\] Locked: a password or one-time code is on this page \(Trevor may be signing in\)\. Tools resume when the field is empty or the tab leaves the sign-in page\./, n);
  }
  assert.strictEqual(upstream.calls.length, 0, "nothing reached upstream");
  for (const n of ["tabs_new", "tabs_select", "tabs_close", "challenge_detect", "form_fill"]) assert.deepStrictEqual(own[n], [], n);
  for (const n of ["relay_status", "tabs_list"]) assert.ok(!(await relay.handleToolsCall({ name: n, arguments: {} })).isError, `${n} is exempt`);
  assert.deepStrictEqual([own.relay_status.length, own.tabs_list.length], [1, 1]);
});

test("round 3 A: unlock → tools resume; a lock that comes on DURING a call withholds that call's result", async () => {
  let locked = false;
  const { relay, upstream } = makeRelay({ lockState: () => (locked ? LOCKED : { locked: false }) });
  assert.ok(!(await relay.handleToolsCall({ name: "content_get-as-text", arguments: {} })).isError);
  locked = true;
  assert.strictEqual((await relay.handleToolsCall({ name: "content_get-as-text", arguments: {} })).isError, true);
  locked = false;
  assert.ok(!(await relay.handleToolsCall({ name: "content_get-as-text", arguments: {} })).isError, "resumes once clear");
  // the probe before says clear, the probe after says locked
  let n = 0;
  const r2 = makeRelay({ lockState: () => (n++ === 0 ? { locked: false } : LOCKED) });
  const r = await r2.relay.handleToolsCall({ name: "o11y_get-http-requests", arguments: {} });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /withheld: the lock came on while it ran/);
  assert.ok(!JSON.stringify(r).includes(PASSWORD));
  assert.strictEqual(r2.upstream.calls.length, 1, "it ran; only its result was withheld");
  void upstream;
});

test("round 3 A: a failing lock probe refuses (fail closed); the probe runs AFTER ensureBrave and the static checks", async () => {
  const { relay, lock, counters } = makeRelay();
  lock.probe = async () => { throw new Error("cdp gone"); };
  const r = await relay.handleToolsCall({ name: "content_get-as-text", arguments: {} });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /fail closed/);
  assert.strictEqual(counters.ensureBrave, 1);
  lock.probes = 0;
  lock.probe = async () => { lock.probes++; return { locked: false }; };
  await relay.handleToolsCall({ name: "execute", arguments: {} });
  assert.strictEqual(lock.probes, 0, "a statically refused call does no browser work");
});

test("round 3 B: only http(s) and about:blank — javascript:, data:, file:, blob:, chrome:, view-source: refused BEFORE upstream, on every URL argument", async () => {
  const { relay, upstream, own } = makeRelay();
  const bad = ["javascript:alert(document.querySelector('input').value)", " JavaScript:1", "data:text/html,<script>1</script>", "file:///etc/hosts", "blob:https://x.example/1", "chrome://settings", "view-source:https://x.example/", "about:srcdoc", "ws://x.example/", "relative/path"];
  for (const u of bad) {
    for (const [n, k] of [["navigation_go-to", "url"], ["tabs_new", "url"], ["capture_xhr", "navigateToUrl"]]) {
      const r = await relay.handleToolsCall({ name: n, arguments: { [k]: u } });
      assert.strictEqual(r.isError, true, `${n} ${u}`);
    }
  }
  assert.strictEqual(upstream.calls.length, 0);
  assert.deepStrictEqual([own.tabs_new.length, own.capture_xhr.length], [0, 0]);
  for (const u of ["https://x.example/", "http://x.example:8080/p?q=1", "about:blank"]) {
    assert.ok(!(await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: u } })).isError, u);
  }
});

test("round 3 C: screenshot annotations refused / forced off / stripped; navigation screenshotOptions.annotate refused; role/label/test-id locators refused on every selector argument", async () => {
  const { relay, upstream } = makeRelay();
  const by = Object.fromEntries((await relay.handleToolsList()).tools.map((t) => [t.name, t]));
  for (const k of ["annotate", "annotateContent", "annotateCursorInteractive"]) {
    assert.ok(!(k in (by["content_take-screenshot"].inputSchema.properties || {})), k);
    assert.strictEqual((await relay.handleToolsCall({ name: "content_take-screenshot", arguments: { [k]: true } })).isError, true, k);
  }
  const shot = await relay.handleToolsCall({ name: "content_take-screenshot", arguments: {} });
  assert.deepStrictEqual([upstream.calls.at(-1).arguments.annotate, upstream.calls.at(-1).arguments.annotateContent, upstream.calls.at(-1).arguments.annotateCursorInteractive], [false, false, false]);
  assert.ok(!JSON.stringify(shot).includes(PASSWORD), "annotations stripped from the result");
  assert.strictEqual(shot.structuredContent.filePath, "/tmp/s.png");
  assert.strictEqual((await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://x.example/", includeScreenshot: true, screenshotOptions: { annotate: true } } })).isError, true);
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://x.example/", includeScreenshot: true, screenshotOptions: { name: "a" } } });
  assert.strictEqual(upstream.calls.at(-1).arguments.screenshotOptions.annotate, false);
  const n0 = upstream.calls.length;
  for (const [n, k, v] of [["interaction_click", "selector", "role=textbox[name=Password]"], ["interaction_hover", "selector", "#a >> internal:role=button"],
    ["content_get-as-text", "selector", "internal:label=\"Password\""], ["content_take-screenshot", "selector", "e3"], ["interaction_scroll", "selector", "getByRole('main')"],
    ["interaction_click", "selector", "internal:testid=[data-testid=\"pw\"s]"]]) {
    const r = await relay.handleToolsCall({ name: n, arguments: { [k]: v } });
    assert.strictEqual(r.isError, true, `${n} ${v}`);
  }
  assert.strictEqual(upstream.calls.length, n0);
});

test("round 3 D: capture_xhr keeps only content-type / cf-mitigated / cf-ray / server / location (as a host)", () => {
  const { stripCapture } = require("../src/plainflags-policy.js");
  const out = stripCapture({ responses: [{ url: "u", headers: { "Content-Type": "text/html", "cf-ray": "1-DFW", server: "cloudflare", "cf-mitigated": "challenge",
    location: `https://login.example/cb?token=${PASSWORD}`, "x-auth-token": PASSWORD, "set-cookie": PASSWORD, authorization: PASSWORD } }] });
  assert.deepStrictEqual(out.responses[0].headers, { "content-type": "text/html", "cf-ray": "1-DFW", server: "cloudflare", "cf-mitigated": "challenge", location: "login.example" });
});

test("round 3 E: everything from \"Call log:\" on is cut from every upstream text item", async () => {
  const { relay } = makeRelay();
  const r = await relay.handleToolsCall({ name: "interaction_click", arguments: { selector: "#x" } });
  assert.strictEqual(r.isError, true);
  assert.ok(!JSON.stringify(r).includes(PASSWORD));
  assert.match(r.content.at(-1).text, /Timeout 10000ms exceeded\.\n\[call log removed by the plain-flags relay\]$/);
});

test("round 3 F: the HTML scanner — comments and raw-text elements skipped, a quote opens only after '=', a surviving secret value withholds", () => {
  const { blankSecretValues, hasSecretValue } = require("../src/plainflags-policy.js");
  const html = `<!-- <input type=password value=C1> --><script>var s = '<input type="password" value="S1">';</script>` +
    `<input title=it's type=password value=${PASSWORD}><input name="first" value="Zed"><textarea><input type=password value=T1></textarea>` +
    `<input data-x="a'b" type="password" value='${PASSWORD}2'><INPUT TYPE=PASSWORD VALUE=${PASSWORD}3>`;
  const out = blankSecretValues(html);
  assert.ok(!out.includes(PASSWORD), out);
  assert.match(out, /value="Zed"/);
  assert.ok(out.includes("value=C1") && out.includes('value="S1"') && out.includes("value=T1"), "comments / script / textarea content is not an element — left as text");
  assert.strictEqual(hasSecretValue(out), false);
  assert.strictEqual(hasSecretValue(`<input type=password value=x>`), true);
});

test("round 3 F: the re-scan withholds the result when the blanker misses a secret value (the backstop on its own)", () => {
  const { filterHtmlResult } = require("../src/plainflags-policy.js");
  const r = filterHtmlResult({ content: [{ type: "text", text: `<input type=password value=${PASSWORD}>` }] }, (t) => t /* a blanker that misses everything */);
  assert.strictEqual(r.isError, true);
  assert.ok(!JSON.stringify(r).includes(PASSWORD));
  assert.match(r.content[0].text, /withheld/);
});

test("round 3 F: content_get-as-html never returns a secret value — blanked, or (if the blanker ever misses) withheld by the re-scan", async () => {
  const { relay } = makeRelay();
  const r = await relay.policy.afterCall("content_get-as-html", { content: [{ type: "text", text: `<p>x</p><input type=password value=${PASSWORD}>` }] });
  assert.ok(!JSON.stringify(r).includes(PASSWORD));
  assert.ok(r.isError || /value=""/.test(r.content[0].text));
});

// ── round 4 ─────────────────────────────────────────────────────────────────

test("round 4 M5: tabs_list (lock-exempt) returns each URL as origin + path — no query, no fragment (codes, tokens, magic links)", async () => {
  const { relay } = makeRelay({ lockState: LOCKED });
  // drive the filter with tabs_list's real result shape
  const out = await relay.policy.afterCall("tabs_list", { content: [{ type: "text", text: JSON.stringify({ count: 2, pages: [
    { index: 0, url: `https://app.example.com/oauth/callback?code=${PASSWORD}&state=x#frag`, title: "Callback" },
    { index: 1, url: `https://login.example.com/reset#access_token=${PASSWORD}`, title: "Reset" },
  ] }) }] });
  const body = JSON.parse(out.content[0].text);
  assert.deepStrictEqual(body.pages.map((p) => p.url), ["https://app.example.com/oauth/callback", "https://login.example.com/reset"]);
  assert.ok(!JSON.stringify(out).includes(PASSWORD));
  assert.ok(!out.isError, "exempt: never withheld by the lock");
});

test("round 4 L7: screenshots go to the relay-private dir whatever outputPath was asked; a withheld result deletes its file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pfshots-"));
  const shots = path.join(dir, ".relay-screenshots");
  let locked = false;
  let n = 0;
  const { relay, upstream } = makeRelay({ screenshotDir: shots, lockState: () => (locked && n++ > 0 ? LOCKED : { locked: false }) });
  const by = Object.fromEntries((await relay.handleToolsList()).tools.map((t) => [t.name, t]));
  assert.ok(!("outputPath" in (by["content_take-screenshot"].inputSchema.properties || {})));
  const ok = await relay.handleToolsCall({ name: "content_take-screenshot", arguments: { outputPath: "/Users/someone/Desktop" } });
  assert.ok(!ok.isError);
  assert.strictEqual(upstream.calls.at(-1).arguments.outputPath, shots, "forced");
  assert.ok(fs.existsSync(path.join(shots, "shot-1.png")));
  assert.strictEqual((fs.statSync(shots).mode & 0o777).toString(8), "700");
  // the lock comes on DURING the call: the result is withheld and its file deleted
  locked = true; n = 0;
  const w = await relay.handleToolsCall({ name: "content_take-screenshot", arguments: {} });
  assert.strictEqual(w.isError, true);
  assert.ok(!fs.existsSync(path.join(shots, "shot-1.png")), "the withheld screenshot's file is gone");
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://x.example/", includeScreenshot: true } });
});

test("round 4 L8: an error THROWN from upstream has its call log cut — for the client and the Inspector feed — and is withheld if the lock came on", async () => {
  const { relay } = makeRelay();
  // let the call reach upstream: upstream_throws is not an allowlisted name, so drive the forward path through a listed one
  relay.getUpstream = async () => ({ request: async () => { throw new Error(`upstream error: locator.fill: Timeout\nCall log:\n  - locator resolved to <input value="${PASSWORD}">`); } });
  const feed = [];
  relay.trafficEmitter.on("response", (e) => feed.push(e));
  await assert.rejects(relay.handleToolsCall({ name: "interaction_click", arguments: { selector: "#a" } }), (e) => {
    assert.ok(!e.message.includes(PASSWORD), e.message);
    assert.match(e.message, /call log removed by the plain-flags relay/);
    return true;
  });
  assert.ok(!JSON.stringify(feed).includes(PASSWORD), "the Inspector feed never sees it");
  let n = 0;
  const l = makeRelay({ lockState: () => (n++ === 0 ? { locked: false } : LOCKED) });
  l.relay.getUpstream = relay.getUpstream;
  await assert.rejects(l.relay.handleToolsCall({ name: "content_get-as-text", arguments: {} }), /this call's error was withheld: the lock came on/);
});

test("round 5 item 5: tabs_select and tabs_new results report URLs as origin + path too", async () => {
  const { relay } = makeRelay();
  for (const n of ["tabs_select", "tabs_new"]) {
    const out = await relay.policy.afterCall(n, { content: [{ type: "text", text: JSON.stringify({ selected: { index: 1, url: `https://x.example/cb?code=${PASSWORD}#t=${PASSWORD}` }, upstreamUrl: `https://x.example/cb?code=${PASSWORD}` }) }] });
    assert.ok(!JSON.stringify(out).includes(PASSWORD), n);
    assert.match(out.content[0].text, /"https:\/\/x\.example\/cb"/, n);
  }
});

test("round 6 item 4: ?code=SECRETCODE123 never survives — tabs_close / tabs_select results, an upstream result carrying the desync warning, a layer-1 refusal, a thrown error", async () => {
  const S = "SECRETCODE123";
  const { relay, upstream } = makeRelay();
  for (const n of ["tabs_close", "tabs_select"]) {
    const out = await relay.policy.afterCall(n, { content: [{ type: "text", text: JSON.stringify({ closed: { index: 0, url: `https://x.example/cb?code=${S}` }, note: `now on https://y.example/p?code=${S}#frag` }) }] });
    assert.ok(!JSON.stringify(out).includes(S), n);
    assert.match(out.content[0].text, /https:\/\/x\.example\/cb"/, n);
    // tab URLs are reduced to origin + path: userinfo goes too (the prose scrub alone keeps it)
    const cred = await relay.policy.afterCall(n, { content: [{ type: "text", text: JSON.stringify({ url: `https://u:pw-${S}@x.example/cb` }) }] });
    assert.ok(!JSON.stringify(cred).includes(S), `${n}: ${JSON.stringify(cred)}`);
  }
  // an upstream result that the relay prefixed with the desync warning (Rule A)
  sync.markDesynced(`https://a.example/cb?code=${S}`, `https://b.example/p?code=${S}`, "test");
  const r = await relay.handleToolsCall({ name: "content_get-as-text", arguments: {} });
  assert.match(JSON.stringify(r), /UPSTREAM DESYNC/);
  assert.ok(!JSON.stringify(r).includes(S), JSON.stringify(r).slice(0, 300));
  sync.reset();
  // a layer-1 refusal quoting the caller's URL
  const l1 = await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: `https://login.fixturebank.test/x?code=${S}` } });
  assert.strictEqual(l1.isError, true);
  assert.ok(!JSON.stringify(l1).includes(S));
  // a thrown upstream error
  relay.getUpstream = async () => ({ request: async () => { throw new Error(`upstream error: navigation to https://x.example/?code=${S} failed`); } });
  await assert.rejects(relay.handleToolsCall({ name: "content_get-as-text", arguments: {} }), (e) => !e.message.includes(S) && /https:\/\/x\.example\//.test(e.message));
  void upstream;
});

test("round 6 item 3: the fill check and the HTML blanker use WORDS for otp — 'footprint' is not secret, 'smsOtp' is", () => {
  const { secretName, blankSecretValues } = require("../src/plainflags-policy.js");
  assert.strictEqual(secretName("footprint"), false);
  assert.strictEqual(secretName("smsOtp"), true);
  assert.strictEqual(secretName("otp_code"), true);
  assert.strictEqual(secretName("passport_no"), true, "pass… stays a substring (fail closed)");
  assert.strictEqual(secretFieldProblem({ tag: "input", type: "text", name: "footprint" }, "fill"), null);
  assert.match(blankSecretValues(`<input name="footprint" value="kept">`), /value="kept"/);
});

test("round 6 item 1: every function the plain-flags relay evaluates in a page runs in strict mode — a sloppy page function cannot reach it through .caller", () => {
  const { fieldProbe } = require("../src/plainflags-policy.js");
  const { secretProbe } = require("../src/plainflags-lock.js");
  // A page's own (sloppy) function, called by the evaluated code: V8 hides a strict caller (null).
  const pageFn = () => { const f = new Function("return function m() { m.seen = m.caller; return []; }")(); f.seen = "unset"; return f; };
  // Rebuilt from SOURCE TEXT in a sloppy scope — what a browser receives (the module's own strictness does not travel).
  const asPage = (fn, ...names) => new Function(...names, `return (${fn.toString()});`);
  const matches = pageFn();
  try { asPage(fieldProbe)()({ nodeType: 1, matches, isContentEditable: false, parentElement: null }, "fill"); } catch { /* the stub element is incomplete; the call above was recorded first */ }
  assert.strictEqual(matches.seen, null, "fieldProbe exposed to .caller");
  const qsa = pageFn();
  try { asPage(secretProbe, "document", "globalThis")({ querySelectorAll: qsa }, {})(); } catch { /* as above */ }
  assert.strictEqual(qsa.seen, null, "secretProbe exposed to .caller");
  // Inline callbacks (challenge_click token read, challenge_detect probe, the meta-guard read): each starts with the directive.
  const fs = require("node:fs");
  const path = require("node:path");
  for (const f of ["src/own-tools/challenge-click.js", "src/own-tools/challenge-detect.js", "src/meta-guard.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const sites = src.match(/\.evaluate\(\s*(?:\([^)]*\)|\w+)\s*=>[\s\S]{0,40}/g) || [];
    assert.ok(sites.length > 0, f);
    for (const s of sites) assert.match(s, /=>\s*\{\s*"use strict";/, `${f}: ${s}`);
  }
});

test("round 7 item 2: acronym names in the fill check and the HTML blanker — OTPCode, MFACode, TOTPCode, OTPInput, TwoFACode are secret; footprint, barcode, state_code are not", () => {
  const { blankSecretValues } = require("../src/plainflags-policy.js");
  for (const n of ["OTPCode", "MFACode", "TOTPCode", "OTPInput", "TwoFACode"]) {
    assert.match(String(secretFieldProblem({ tag: "input", type: "text", name: n }, "fill")), /password \/ code/, n);
    assert.match(String(secretFieldProblem({ tag: "input", type: "text", id: n }, "fill")), /password \/ code/, `id ${n}`);
    assert.doesNotMatch(blankSecretValues(`<input name="${n}" value="123456">`), /123456/, n);
  }
  for (const n of ["footprint", "barcode", "state_code"]) {
    assert.strictEqual(secretFieldProblem({ tag: "input", type: "text", name: n }, "fill"), null, n);
    assert.match(blankSecretValues(`<input name="${n}" value="kept">`), /value="kept"/, n);
  }
});

test("round 7 item 3: scrubUrls — a bracket or backslash no longer ends a URL early; ws(s) URLs count; closing brackets of the prose come back", () => {
  const { scrubUrls } = require("../src/plainflags-policy.js");
  const S = "SECRETCODE123";
  const cases = [
    [`see https://x.example/(b)c?code=${S} now`, "see https://x.example/(b)c now"],
    [`x https://x.example/a]?code=${S} y`, "x https://x.example/a] y"],
    [`x https://x.example/a}?k=v${S} y`, "x https://x.example/a} y"],
    [`socket wss://ws.example/s?token=${S}`, "socket wss://ws.example/s"],
    [`socket ws://ws.example/s#t=${S}`, "socket ws://ws.example/s"],
    [`(https://x.example/p?code=${S})`, "(https://x.example/p)"],
    [`[link](https://x.example/p#access_token=${S})`, "[link](https://x.example/p)"],
  ];
  for (const [inp, want] of cases) assert.strictEqual(scrubUrls(inp), want, inp);
});
