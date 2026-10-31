// default-lock.test.js — the DEFAULT relay's lock (register A77; ruling
// as-ops/ask-a2ggu5 rev 2, "Lock, except session-filled values"): the lock
// module in mode "default" and src/default-lock.js through a real
// RelayServer, against a fake page model whose reader runs the REAL in-page
// probe (secretProbe) on a minimal fake DOM — so the exception is exercised
// from the tool's args to the probe's hash check. The real-Brave version:
// test/isolated-default-lock.test.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createLock, createSessionFills, secretProbe, DEFAULT_LOCK_TEXT, LOCK_TEXT } = require("../src/plainflags-lock.js");
const { createDefaultLockPolicy, screenshotFiles } = require("../src/default-lock.js");
const { RelayServer } = require("../src/relay-server.js");
const requestBodyFilter = require("../src/request-body-filter.js");
const sync = require("../src/own-tools/_upstream-sync.js");

const PASSWORD = "Fixture-Pa55word-Zq9";
const TYPED = "Trevor-Typed-Secret-77";

// ── a fake DOM the real probe runs on ───────────────────────────────────────

function input(attrs, value = "") {
  const a = { ...attrs };
  return { tagName: "INPUT", type: (a.type || "text").toLowerCase(), value, maxLength: a.maxlength ? Number(a.maxlength) : -1,
    getAttribute: (k) => (k in a ? a[k] : null), previousElementSibling: null, nextElementSibling: null, shadowRoot: null, parentElement: { id: "root" } };
}
function docOf(els) { return { querySelectorAll: (sel) => (sel === "*" ? els.filter((e) => e.shadowRoot) : els.filter((e) => !e.host)) }; }
function runProbe(doc, allow) {
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, mem: globalThis.__relayLockSeen };
  globalThis.document = doc;
  globalThis.__relayLockSeen = undefined;
  globalThis.getComputedStyle = () => ({ webkitTextSecurity: "none", getPropertyValue: () => "none" });
  try { return secretProbe(allow); } finally { globalThis.document = saved.document; globalThis.getComputedStyle = saved.getComputedStyle; globalThis.__relayLockSeen = saved.mem; }
}

/** A browser of tabs, each a fake DOM; its reader runs the real probe with the lock's `allow`. */
function fakeBrowser() {
  const tabs = new Map(); // key → { url, els }
  const reads = [];
  return {
    tabs,
    reads,
    add(key, url, els) { tabs.set(key, { url, els }); return els; },
    readTabs: async (ctx, { allow } = {}) => {
      reads.push(allow);
      return { tabs: [...tabs].map(([key, t]) => ({ key, url: t.url, frames: [{ url: t.url, result: runProbe(docOf(t.els), allow) }] })) };
    },
  };
}

// ── the in-page hash ────────────────────────────────────────────────────────

test("A77: the probe's in-page SHA-256 equals Node's for ASCII, long (multi-block) and non-ASCII values — so an exact session value matches", () => {
  const salt = crypto.randomBytes(16).toString("hex");
  const values = ["a", "x".repeat(23), "y".repeat(24), "z".repeat(55 - 32), "w".repeat(64), "v".repeat(200), PASSWORD, "pässwörd-日本語-🔑", "\ud800lone"];
  for (const v of values) {
    const d = crypto.createHash("sha256").update(salt + v, "utf8").digest("hex");
    const el = input({ type: "password" }, v);
    assert.deepStrictEqual(runProbe(docOf([el]), { salt, digests: [d] }), { seen: 1, filled: 0, own: 1 }, JSON.stringify(v));
  }
});

test("A77 exception: a secret field holding EXACTLY a session-filled value is not counted as filled; a different, a longer and a shorter value are", () => {
  const fills = createSessionFills();
  fills.record(PASSWORD);
  const allow = fills.allow();
  assert.ok(!JSON.stringify(allow).includes(PASSWORD), "digests only");
  const count = (v) => runProbe(docOf([input({ type: "password" }, v)]), allow);
  assert.deepStrictEqual(count(PASSWORD), { seen: 1, filled: 0, own: 1 });
  assert.deepStrictEqual(count(TYPED), { seen: 1, filled: 1, own: 0 });
  assert.deepStrictEqual(count(PASSWORD + "x"), { seen: 1, filled: 1, own: 0 }, "a value that STARTS with the session's");
  assert.deepStrictEqual(count(PASSWORD.slice(0, 5)), { seen: 1, filled: 1, own: 0 }, "a prefix of the session's value");
  assert.deepStrictEqual(runProbe(docOf([input({ type: "password" }, PASSWORD)]), null), { seen: 1, filled: 1 }, "no allow (plain-flags): counted as before");
});

test("A77 session fills: the last 50 only, each forgotten 30 min after it was filled; a re-fill refreshes it; empty values are not recorded", () => {
  let t = 0;
  const fills = createSessionFills({ now: () => t });
  assert.strictEqual(fills.allow(), null);
  fills.record("");
  fills.record(undefined);
  assert.strictEqual(fills.size(), 0);
  fills.record("first");
  for (let i = 0; i < 49; i++) fills.record(`v${i}`);
  assert.strictEqual(fills.size(), 50);
  const has = (v) => { const a = fills.allow(); return !!a && a.digests.includes(crypto.createHash("sha256").update(a.salt + v, "utf8").digest("hex")); };
  assert.ok(has("first"));
  fills.record("v50"); // the 51st
  assert.ok(!has("first"), "past 50, the oldest is forgotten");
  assert.ok(has("v0") && has("v50"));
  t = 29 * 60 * 1000;
  fills.record("v0"); // refreshed
  t = 30 * 60 * 1000;
  assert.ok(!has("v1"), "30 min after it was filled: forgotten");
  assert.ok(has("v0"), "re-filled at 29 min: still remembered");
  t = 59 * 60 * 1000 + 1;
  assert.strictEqual(fills.allow(), null, "all forgotten");
});

// ── the lock in default mode ────────────────────────────────────────────────

function defaultLock(b, extra = {}) {
  const notices = [];
  const logs = [];
  const fills = createSessionFills(extra.fills || {});
  const lock = createLock({ getContext: () => ({}), accounts: extra.accounts, mode: "default", sessionFills: fills, readTabs: b.readTabs, notice: (n) => notices.push(n), log: (m) => logs.push(m) });
  return { lock, fills, notices, logs };
}

test("A77 default lock: a typed password locks, a session-filled one does not, past 30 min it does; the value never reaches status, notices or logs", async () => {
  let t = 0;
  const b = fakeBrowser();
  const [pw] = b.add("A", "https://bank.example/login", [input({ type: "password", id: "pw" })]);
  const { lock, fills, notices, logs } = defaultLock(b, { fills: { now: () => t } });
  assert.strictEqual((await lock.probe()).locked, false, "an empty field");
  fills.record(PASSWORD);
  pw.value = PASSWORD; // the session's fill
  const st = await lock.probe();
  assert.deepStrictEqual([st.locked, st.sessionFilled, st.filled], [false, 1, 0]);
  pw.value = TYPED; // Trevor types over it
  const st2 = await lock.probe();
  assert.strictEqual(st2.locked, true);
  assert.match(st2.reason, /this session did not fill/);
  pw.value = PASSWORD;
  assert.strictEqual((await lock.probe()).locked, false);
  t = 30 * 60 * 1000;
  assert.strictEqual((await lock.probe()).locked, true, "the session's value is forgotten after 30 min");
  pw.value = "";
  assert.strictEqual((await lock.probe()).locked, false, "clearing unlocks");
  const everything = JSON.stringify([notices, logs, lock.status(), st, st2]);
  for (const v of [PASSWORD, TYPED]) assert.ok(!everything.includes(v), `${v} leaked: ${everything}`);
  assert.ok(notices.some((n) => /^\[browser-mcp-relay\] LOCKED — /.test(n)) && notices.some((n) => /UNLOCKED — no typed password/.test(n)), notices.join(" | "));
  assert.strictEqual(lock.LOCK_TEXT, DEFAULT_LOCK_TEXT);
});

test("A77 default lock: NO sign-in-URL rule — a known account's sign-in page (top or frame) does not lock by URL; an empty password field or a checkbox named password never locks", async () => {
  const ACCOUNTS = [{ name: "fixturebank", loginMatchers: [{ host: "login.fixturebank.test", signInPage: true }], cookieOrigins: [], sessionCookies: [] }];
  const b = fakeBrowser();
  b.add("A", "https://login.fixturebank.test/signin", [input({ type: "password" }), input({ type: "checkbox", name: "remember_password" }, "on")]);
  const { lock } = defaultLock(b, { accounts: ACCOUNTS });
  assert.strictEqual((await lock.probe()).locked, false);
  // the plain-flags lock on the same browser still locks by URL (rule 2 unchanged)
  const plain = createLock({ getContext: () => ({}), accounts: ACCOUNTS, readTabs: b.readTabs });
  assert.strictEqual((await plain.probe()).locked, true);
  // rule 3's sign-in-FRAME clause is a URL rule too: off in default mode
  const frames = { tabs: [{ key: "F", url: "https://f.example/", frames: [{ url: "https://f.example/", result: { seen: 0, filled: 0 } }, { url: "https://login.fixturebank.test/embed", result: null }] }] };
  const d = createLock({ getContext: () => ({}), accounts: ACCOUNTS, mode: "default", readTabs: async () => frames });
  assert.strictEqual((await d.probe()).locked, false);
  const p = createLock({ getContext: () => ({}), accounts: ACCOUNTS, readTabs: async () => frames });
  assert.strictEqual((await p.probe()).locked, true, "plain-flags: an unreadable frame beside a sign-in frame still locks");
});

test("A77 plain-flags unchanged: its text, its PLAIN-FLAGS notices, no exception even when handed session fills, no sessionFilled field", async () => {
  const b = fakeBrowser();
  b.add("A", "https://x.example/", [input({ type: "password" }, PASSWORD)]);
  const fills = createSessionFills();
  fills.record(PASSWORD);
  const notices = [];
  const plain = createLock({ getContext: () => ({}), accounts: [], readTabs: b.readTabs, sessionFills: fills, notice: (n) => notices.push(n) });
  const st = await plain.probe();
  assert.strictEqual(st.locked, true);
  assert.strictEqual(st.reason, "a password / one-time-code field on a tab holds a value");
  assert.ok(!("sessionFilled" in st));
  assert.deepStrictEqual(b.reads, [null], "the plain-flags reader gets no allow list");
  assert.strictEqual(plain.LOCK_TEXT, LOCK_TEXT);
  assert.match(notices[0], /^\[browser-mcp-relay\] PLAIN-FLAGS: LOCKED — /);
});

test("A77 fail closed per tab (rule 3) in default mode: an unreadable frame on a tab where a secret field was seen locks; on another tab it does not", async () => {
  let tabs = [{ key: "A", url: "https://a.example/f", frames: [{ url: "https://a.example/f", result: { seen: 1, filled: 0 } }] }];
  const lock = createLock({ getContext: () => ({}), accounts: [], mode: "default", readTabs: async () => ({ tabs }) });
  await lock.probe();
  tabs = [{ key: "A", url: "https://a.example/f", frames: [{ url: "https://a.example/f", result: { seen: 0, filled: 0 } }, { url: "https://pay.example/", result: null }] }];
  assert.strictEqual((await lock.probe()).locked, true);
  tabs = [{ key: "B", url: "https://b.example/", frames: [{ url: "https://b.example/", result: { seen: 0, filled: 0 } }, { url: "https://pay.example/", result: null }] }];
  assert.strictEqual((await lock.probe()).locked, false);
});

// ── L5 (both modes) ─────────────────────────────────────────────────────────

test("1c L5: the per-tab memory is keyed on origin + path — a ?step= or #hash change on the same page keeps it (an unreadable frame there still fails closed); a new path drops it", async () => {
  for (const mode of ["plainflags", "default"]) {
    let tabs = [{ key: "C", url: "https://c.example/form?step=1", frames: [{ url: "https://c.example/form?step=1", result: { seen: 1, filled: 0 } }] }];
    const lock = createLock({ getContext: () => ({}), accounts: [], mode, readTabs: async () => ({ tabs }) });
    await lock.probe();
    const unreadableAt = (url) => [{ key: "C", url, frames: [{ url, result: { seen: 0, filled: 0 } }, { url: "https://pay.example/frame", result: null }] }];
    tabs = unreadableAt("https://c.example/form?step=2#otp");
    assert.strictEqual((await lock.probe()).locked, true, `${mode}: same origin + path`);
    tabs = unreadableAt("https://c.example/next");
    assert.strictEqual((await lock.probe()).locked, false, `${mode}: a new path`);
  }
});

// ── L1 (both modes: the probe is shared) ────────────────────────────────────

test("1c L1: a filled password inside an OPEN shadow root (nested two deep) is found and locks; an empty one is seen but does not", () => {
  const pw = input({ type: "password" }, PASSWORD);
  const inner = { querySelectorAll: (sel) => (sel === "*" ? [] : [pw]) };
  const innerHost = { tagName: "X-INNER", shadowRoot: inner, host: true };
  const outer = { querySelectorAll: (sel) => (sel === "*" ? [innerHost] : []) };
  const outerHost = { tagName: "X-LOGIN", shadowRoot: outer, host: true };
  const doc = { querySelectorAll: (sel) => (sel === "*" ? [outerHost] : []) };
  assert.deepStrictEqual(runProbe(doc, null), { seen: 1, filled: 1 });
  pw.value = "";
  assert.deepStrictEqual(runProbe(doc, null), { seen: 1, filled: 0 });
});

// ── the policy through a real RelayServer ───────────────────────────────────

class FakeUpstream {
  constructor(b) { this.b = b; this.calls = []; this.onCall = null; this.shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dflock-shots-")); this.n = 0; }
  async request(method, params) {
    if (method === "tools/list") return { tools: ["interaction_fill", "interaction_click", "a11y_take-aria-snapshot", "content_take-screenshot", "navigation_go-to"].map((name) => ({ name, inputSchema: { type: "object" } })) };
    this.calls.push(params);
    if (this.onCall) await this.onCall(params);
    const [pw] = this.b.tabs.get("A").els;
    if (params.name === "interaction_fill") { pw.value = params.arguments.value; return { content: [{ type: "text", text: "{}" }] }; }
    if (params.name === "a11y_take-aria-snapshot") return { content: [{ type: "text", text: `- textbox "Password": ${pw.value}` }] };
    if (params.name === "content_take-screenshot") {
      const filePath = path.join(this.shotDir, `screenshot-${++this.n}.png`);
      fs.writeFileSync(filePath, "png");
      const r = { filePath, _artifacts: [{ type: "IMAGE", filePath, mimeType: "image/png" }] };
      return { content: [{ type: "text", text: JSON.stringify(r) }, { type: "image", data: "AAAA", mimeType: "image/png" }], structuredContent: r };
    }
    return { content: [{ type: "text", text: `forwarded ${params.name}` }] };
  }
}

function makeRelay() {
  const b = fakeBrowser();
  b.add("A", "https://bank.example/login", [input({ type: "password", id: "pw" })]);
  const notices = [];
  const logs = [];
  // the policy's lock in default mode, reading the fake browser
  const fills = createSessionFills();
  const lock = createLock({ getContext: () => ({}), mode: "default", sessionFills: fills, readTabs: b.readTabs, notice: (n) => notices.push(n), log: (m) => logs.push(m) });
  const p = createDefaultLockPolicy({ lock, sessionFills: fills });
  const upstream = new FakeUpstream(b);
  const relay = new RelayServer({ getUpstream: async () => upstream, ensureBrave: async () => {}, policy: p, takeNotices: () => notices.splice(0) });
  const formFilled = [];
  relay.registerOwnTool({ name: "form_fill", description: "", inputSchema: { type: "object" }, handler: async (a) => { for (const f of a.fields) { formFilled.push(f.selector); b.tabs.get("A").els[0].value = f.value; } return { content: [{ type: "text", text: "filled" }] }; } });
  relay.registerOwnTool({ name: "relay_status", description: "", inputSchema: { type: "object" }, needsBrave: false, handler: async () => ({ content: [{ type: "text", text: JSON.stringify({ lock: lock.status() }) }] }) });
  relay.registerOwnTool({ name: "tabs_list", description: "", inputSchema: { type: "object" }, handler: async () => ({ content: [{ type: "text", text: "tabs" }] }) });
  return { relay, upstream, b, notices, logs, lock, fills, pw: b.tabs.get("A").els[0] };
}

test.beforeEach(() => { sync.reset(); requestBodyFilter.setSourcePatchInEffect(true); });

test("A77 policy: the tool list passes unchanged (no allowlist, no schema edits) and args are forwarded as given", async () => {
  const { relay, upstream } = makeRelay();
  const names = (await relay.handleToolsList()).tools.map((t) => t.name);
  assert.deepStrictEqual(names, ["interaction_fill", "interaction_click", "a11y_take-aria-snapshot", "content_take-screenshot", "navigation_go-to", "form_fill", "relay_status", "tabs_list"]);
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://x.example/?q=1", includeSnapshot: true } });
  assert.deepStrictEqual(upstream.calls.at(-1).arguments, { url: "https://x.example/?q=1", includeSnapshot: true });
});

test("A77 policy: Trevor's typed password refuses every tool but relay_status / tabs_list; a session interaction_fill of a password then a click works; the snapshot after shows only the session's own value", async () => {
  const { relay, upstream, pw, notices } = makeRelay();
  const out = [];
  const call = async (name, args = {}) => { const r = await relay.handleToolsCall({ name, arguments: args }); out.push(JSON.stringify(r)); return r; };
  // the session fills a fixture password and submits: never locked
  assert.ok(!(await call("interaction_fill", { selector: "#pw", value: PASSWORD })).isError);
  assert.strictEqual(pw.value, PASSWORD);
  assert.ok(!(await call("interaction_click", { selector: "#go" })).isError, "submit after the session's own fill");
  const snap = await call("a11y_take-aria-snapshot");
  assert.ok(!snap.isError && snap.content.at(-1).text.includes(PASSWORD), "the session's own value (it typed it)");
  // Trevor types
  pw.value = TYPED;
  for (const n of ["a11y_take-aria-snapshot", "navigation_go-to", "content_take-screenshot", "interaction_click", "form_fill", "interaction_fill"]) {
    const r = await call(n, n === "form_fill" ? { fields: [{ selector: "#u", value: "x" }] } : n === "interaction_fill" ? { selector: "#u", value: TYPED } : {});
    assert.strictEqual(r.isError, true, n);
    assert.ok(r.content.some((c) => c.text.startsWith(`[mcp-relay] ${DEFAULT_LOCK_TEXT} (`)), n);
  }
  assert.strictEqual(pw.value, TYPED, "the refused fill did not run");
  assert.ok(!upstream.calls.some((c) => c.name === "interaction_fill" && c.arguments.value === TYPED));
  assert.ok(!(await call("tabs_list")).isError);
  const st = await call("relay_status");
  assert.ok(!st.isError && JSON.parse(st.content.at(-1).text).lock.locked === true);
  // a fill refused while locked was NOT recorded: Trevor's value stays locked
  assert.strictEqual((await call("content_take-screenshot")).isError, true);
  pw.value = "";
  assert.ok(!(await call("a11y_take-aria-snapshot")).isError, "clearing unlocks");
  assert.ok(out.join("\n").includes("LOCKED") && out.join("\n").includes("UNLOCKED"), "announced");
  assert.ok(!out.join("\n").includes(TYPED), "Trevor's value never appears in any result");
  assert.strictEqual(notices.length, 0, "every notice was delivered on a result");
});

test("A77 policy: form_fill values are excepted too; interaction_press-key characters are not (they lock)", async () => {
  const { relay, pw } = makeRelay();
  assert.ok(!(await relay.handleToolsCall({ name: "form_fill", arguments: { fields: [{ selector: "#pw", value: PASSWORD }] } })).isError);
  assert.strictEqual(pw.value, PASSWORD);
  assert.ok(!(await relay.handleToolsCall({ name: "a11y_take-aria-snapshot", arguments: {} })).isError);
  // press-key: the forwarded call types into the field; nothing is recorded
  const upstream = await relay.getUpstream();
  upstream.onCall = async (p) => { if (p.name === "interaction_press-key") pw.value = PASSWORD + "!"; };
  pw.value = "";
  const r = await relay.handleToolsCall({ name: "interaction_press-key", arguments: { key: "!" } });
  assert.strictEqual(r.isError, true, "its result is withheld: the lock came on while it ran");
  assert.match(r.content.map((c) => c.text).join(" "), /withheld: the lock came on while it ran/);
});

test("A77 policy: a lock that comes on DURING a call withholds its result and deletes the screenshot file it names; a thrown error is withheld too", async () => {
  const { relay, upstream, pw } = makeRelay();
  upstream.onCall = async () => { pw.value = TYPED; };
  const r = await relay.handleToolsCall({ name: "content_take-screenshot", arguments: {} });
  assert.strictEqual(r.isError, true);
  assert.ok(!r.content.some((c) => c.type === "image"));
  assert.ok(!fs.existsSync(path.join(upstream.shotDir, "screenshot-1.png")), "the withheld screenshot's file is deleted");
  pw.value = "";
  upstream.onCall = null;
  const ok = await relay.handleToolsCall({ name: "content_take-screenshot", arguments: {} });
  assert.ok(!ok.isError);
  assert.ok(fs.existsSync(path.join(upstream.shotDir, "screenshot-2.png")), "an unlocked screenshot is kept");
  upstream.onCall = async () => { pw.value = TYPED; throw Object.assign(new Error(`locator.fill: <input value="${TYPED}">`), { code: -32000 }); };
  await assert.rejects(relay.handleToolsCall({ name: "interaction_click", arguments: { selector: "#x" } }), (e) => {
    assert.ok(!e.message.includes(TYPED), e.message);
    assert.match(e.message, /this call's error was withheld/);
    assert.strictEqual(e.code, -32000);
    return true;
  });
  pw.value = "";
  upstream.onCall = async () => { throw new Error("plain upstream error"); };
  await assert.rejects(relay.handleToolsCall({ name: "interaction_click", arguments: { selector: "#x" } }), /plain upstream error/);
});

test("A77 policy: screenshotFiles names only absolute .png / .jpeg paths from filePath / screenshotFilePath", () => {
  const r = { structuredContent: { filePath: "/tmp/a.png", nested: { screenshotFilePath: "/tmp/b.jpeg" }, other: "/tmp/c.png" }, content: [{ type: "text", text: JSON.stringify({ filePath: "rel.png", screenshotFilePath: "/etc/passwd" }) }] };
  assert.deepStrictEqual(screenshotFiles(r).sort(), ["/tmp/a.png", "/tmp/b.jpeg"]);
});

// ── L4 (both modes) ─────────────────────────────────────────────────────────

test("1c L4: a reader that never answers cannot hang the probe (or relay_status) — it ends at probeTimeoutMs, unreadable, and fails closed only where a secret field was seen", async () => {
  let hang = false;
  const tabs = [{ key: "A", url: "https://a.example/", frames: [{ url: "https://a.example/", result: { seen: 1, filled: 0 } }] }];
  for (const mode of ["plainflags", "default"]) {
    const lock = createLock({ getContext: () => ({}), accounts: [], mode, probeTimeoutMs: 300, readTabs: async () => (hang ? new Promise(() => {}) : { tabs }) });
    const fresh = createLock({ getContext: () => ({}), accounts: [], mode, probeTimeoutMs: 300, readTabs: async () => new Promise(() => {}) });
    hang = false;
    await lock.probe();
    hang = true;
    const t0 = Date.now();
    const st = await Promise.race([lock.probe(), new Promise((r) => setTimeout(() => r("HUNG"), 3000))]);
    assert.notStrictEqual(st, "HUNG", `${mode}: the probe hung`);
    assert.ok(Date.now() - t0 < 1500, `${mode}: ${Date.now() - t0} ms`);
    assert.strictEqual(st.locked, true, `${mode}: a secret field was seen → fail closed`);
    const st2 = await Promise.race([fresh.probe(), new Promise((r) => setTimeout(() => r("HUNG"), 3000))]);
    assert.notStrictEqual(st2, "HUNG");
    assert.strictEqual(st2.locked, false, `${mode}: nothing seen → not locked`);
  }
});
