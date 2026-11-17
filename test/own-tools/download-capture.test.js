const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/download-capture.js");

test("download_capture has required tool shape", () => {
  assert.strictEqual(tool.name, "download_capture");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
});

test("download_capture returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({});
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|initialized|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// T0-9: short-circuit on page close — without this, download wait on a
// closed page hangs until full timeoutMs (default 30s).
// ──────────────────────────────────────────────────────────────────

test("T0-9: download_capture short-circuits when page closes before download", async () => {
  const prev = globalThis.__relayBridge;
  let registeredCloseHandler = null;
  // Fake page where waitForEvent("download") never resolves; close fires.
  const fakePage = {
    waitForEvent: (event, opts) => new Promise(() => {
      // never resolves (simulates "no download forthcoming")
    }),
    once: (event, fn) => {
      if (event === "close") registeredCloseHandler = fn;
    },
    off: () => {},
  };
  globalThis.__relayBridge = { context: { pages: () => [fakePage] } };
  try {
    // Long timeoutMs to prove the close path is what triggers fast resolution.
    const promise = tool.handler({ timeoutMs: 30000 });
    setTimeout(() => {
      if (registeredCloseHandler) registeredCloseHandler();
    }, 10);
    const result = await Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("hung > 1s after close")), 1000)),
    ]);
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /page closed before download started/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ───── F1-14: sanitizeDownloadFilename ─────

test("F1-14: sanitizeDownloadFilename defangs Linux path traversal", () => {
  const out = tool.sanitizeDownloadFilename("../../etc/passwd");
  assert.ok(!out.includes("/"), `must not contain path separators (got ${out})`);
  assert.ok(!out.startsWith(".."), `must not start with .. (got ${out})`);
  assert.ok(!out.startsWith("."), `must not start with . (got ${out})`);
});

test("F1-14: sanitizeDownloadFilename defangs Windows path traversal", () => {
  const out = tool.sanitizeDownloadFilename("..\\..\\windows\\system32\\foo.exe");
  assert.ok(!out.includes("\\"), `must not contain backslashes (got ${out})`);
  assert.ok(!out.includes("/"), `must not contain forward slashes (got ${out})`);
  assert.ok(!out.startsWith("."), `must not start with . (got ${out})`);
});

test("F1-14: sanitizeDownloadFilename strips control chars", () => {
  // Build the test input from char codes so the source file stays plain
  // ASCII (literal U+0000 / U+001F bytes would tip git's binary heuristic).
  const NUL = String.fromCharCode(0x00);
  const US = String.fromCharCode(0x1f);
  const DEL = String.fromCharCode(0x7f);
  const out = tool.sanitizeDownloadFilename("foo" + NUL + "bar" + US + "baz" + DEL + "trailing");
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x1f\x7f]/.test(out), `must not contain control chars (got ${JSON.stringify(out)})`);
});

test("F1-14: sanitizeDownloadFilename defangs colon (Windows ADS / drive letter)", () => {
  const out = tool.sanitizeDownloadFilename("C:\\evil.exe");
  assert.ok(!out.includes(":"), `must not contain colon (got ${out})`);
});

test("F1-14: sanitizeDownloadFilename caps length to 200 chars", () => {
  const out = tool.sanitizeDownloadFilename("x".repeat(500));
  assert.strictEqual(out.length, 200);
});

test("F1-14: sanitizeDownloadFilename returns 'file.bin' for empty / null / all-dots", () => {
  assert.strictEqual(tool.sanitizeDownloadFilename(""), "file.bin");
  assert.strictEqual(tool.sanitizeDownloadFilename(null), "file.bin");
  assert.strictEqual(tool.sanitizeDownloadFilename(undefined), "file.bin");
  assert.strictEqual(tool.sanitizeDownloadFilename("...."), "file.bin");
});

test("F1-14: sanitizeDownloadFilename leaves a normal filename mostly untouched", () => {
  assert.strictEqual(tool.sanitizeDownloadFilename("report.pdf"), "report.pdf");
  assert.strictEqual(tool.sanitizeDownloadFilename("invoice-2025-Q1.csv"), "invoice-2025-Q1.csv");
});

test("F1-14: sanitizeDownloadFilename coerces non-string input safely", () => {
  // Number coerces to its decimal string — safe.
  assert.strictEqual(tool.sanitizeDownloadFilename(123), "123");
  // Object coerces to "[object Object]" via Object.prototype.toString —
  // contains no path separators, control chars, or colons, so it survives
  // sanitization unchanged. Acceptable: caller passing an object is a bug
  // on their end, but we don't crash.
  const objOut = tool.sanitizeDownloadFilename({});
  assert.ok(!objOut.includes("/") && !objOut.includes("\\") && !objOut.includes(":"),
    `object coercion must not contain path separators (got ${objOut})`);
});

// ───── review round 2 (2026-11-17): reservations, queue, CDP time limits ─────
// Fake pages (no browser): a click counter, a URL that can change, CDP calls
// that can hang. Reservations live in a per-test temp dir, never the cache root.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { setActivePage, clearActivePage } = require("../../src/own-tools/_active-page.js");

const TOOL_PATH = path.resolve(__dirname, "../../src/own-tools/download-capture.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});
const textOf = (r) => r.content.map((c) => c.text).join("\n");
/** The reservation key as the module computes it: sha256 of origin + path, newline, selector. */
const keyOf = (url, sel) => { const u = new URL(url); return crypto.createHash("sha256").update(`${u.origin}${u.pathname}\n${sel}`).digest("hex"); };

function stateFor(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-state-"));
  tool._setStateDir(state);
  t.after(() => { tool._setStateDir(null); fs.rmSync(state, { recursive: true, force: true }); });
  return { state, file: path.join(state, ".download-clicks.json") };
}

/** A fake page: `opts.click` / `opts.waitForEvent` / `opts.cdp` shape its behaviour. */
function fakePage(t, opts = {}) {
  const page = {
    clicks: 0,
    href: opts.url || "https://shop.example.test/item",
    url() { return this.href; },
    isClosed: () => false,
    once() {}, off() {},
    waitForEvent: opts.waitForEvent || ((_ev, o) => sleep((o && o.timeout) || 100).then(() => { throw new Error("Timeout exceeded"); })),
    click: async () => { page.clicks++; if (opts.click) await opts.click(); },
    context: () => ({ newCDPSession: opts.newCDPSession || (async () => opts.session || { send: async () => {}, detach: async () => {}, on() {}, off() {} }) }),
  };
  globalThis.__relayBridge = { context: { pages: () => [page] } };
  clearActivePage();
  setActivePage(page);
  t.after(() => { globalThis.__relayBridge = undefined; clearActivePage(); });
  return page;
}

/** Resolve with `p`, or reject after `ms` — a hang becomes a test failure, not a stuck run. */
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: still pending after ${ms} ms`)), ms))]);

test("R2-5a: two processes reserving the same keys at once — every key is won exactly once (the file lock)", { timeout: 60000 }, async (t) => {
  const { state, file } = stateFor(t);
  const N = 150;
  const startAt = Date.now() + 1500;
  const code = `
    const tool = require(${JSON.stringify(TOOL_PATH)});
    tool._setStateDir(${JSON.stringify(state)});
    while (Date.now() < ${startAt}) {} // both children start together
    const won = [];
    for (let i = 0; i < ${N}; i++) { const r = tool._reserveClick("k" + i, false); if (r.error) { console.log("ERR " + r.error); process.exit(2); } if (r.at !== undefined) won.push(i); }
    console.log(JSON.stringify(won));
  `;
  const run = () => new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { out += d; });
    c.on("close", (rc) => resolve({ rc, out, pid: c.pid }));
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.strictEqual(a.rc, 0, a.out);
  assert.strictEqual(b.rc, 0, b.out);
  const wa = JSON.parse(a.out), wb = JSON.parse(b.out);
  assert.strictEqual(wa.length + wb.length, N, `each key won exactly once (a ${wa.length}, b ${wb.length})`);
  assert.deepStrictEqual([...wa, ...wb].sort((x, y) => x - y), [...Array(N).keys()]);
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(Object.keys(entries).length, N, "every reservation is in the file");
  for (const i of wa) assert.strictEqual(entries["k" + i].pid, a.pid);
  for (const i of wb) assert.strictEqual(entries["k" + i].pid, b.pid);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test("R2-5b: an expired or future-dated reservation is pruned; a live one is kept", (t) => {
  const { file } = stateFor(t);
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({
    old: { at: now - tool.REPEAT_CLICK_WINDOW_MS - 1000, pid: 1 },
    future: { at: now + 60000, pid: 1 },
    live: { at: now - 1000, pid: 1 },
  }), { mode: 0o600 });
  const r = tool._reserveClick("old", false);
  assert.ok(r.at >= now, `the expired key is reserved again (${JSON.stringify(r)})`);
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(Object.keys(entries).sort(), ["live", "old"]);
  assert.strictEqual(entries.old.pid, process.pid);
  assert.strictEqual(entries.live.at, now - 1000, "the live entry is untouched");
  assert.strictEqual(tool._reserveClick("live", false).prevAt, now - 1000, "the live one still refuses");
});

test("R2-5c: allowRepeatClick never wipes an unreadable reservation file — it refuses, and the file is untouched", { timeout: 20000 }, async (t) => {
  const { file } = stateFor(t);
  fs.writeFileSync(file, "{not json", { mode: 0o600 });
  const page = fakePage(t);
  const r = await tool.handler({ clickSelector: "#buy", timeoutMs: 200, allowRepeatClick: true });
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /REFUSED/);
  assert.match(textOf(r), /unreadable/);
  assert.strictEqual(page.clicks, 0);
  assert.strictEqual(fs.readFileSync(file, "utf8"), "{not json", "other relays' reservations are not cleared");
});

test("R2-5c: allowRepeatClick overrides only its own key", { timeout: 20000 }, async (t) => {
  const { file } = stateFor(t);
  const page = fakePage(t);
  const k = keyOf(page.href, "#buy");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ [k]: { at: now - 5000, pid: 1 }, other: { at: now - 5000, pid: 2 } }), { mode: 0o600 });
  await tool.handler({ clickSelector: "#buy", timeoutMs: 200, allowRepeatClick: true });
  assert.strictEqual(page.clicks, 1);
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepStrictEqual(entries.other, { at: now - 5000, pid: 2 });
  assert.strictEqual(entries[k].pid, process.pid);
});

test("R2-5d: a refusal names who made the earlier click — this relay or another", { timeout: 20000 }, async (t) => {
  const { file } = stateFor(t);
  const page = fakePage(t);
  const k = keyOf(page.href, "#buy");
  fs.writeFileSync(file, JSON.stringify({ [k]: { at: Date.now() - 3000, pid: process.pid + 100000 } }), { mode: 0o600 });
  const other = await tool.handler({ clickSelector: "#buy", timeoutMs: 200 });
  assert.match(textOf(other), /REFUSED/);
  assert.doesNotMatch(textOf(other), /on this page was clicked/);
  assert.match(textOf(other), /another relay/);
  fs.writeFileSync(file, JSON.stringify({ [k]: { at: Date.now() - 3000, pid: process.pid } }), { mode: 0o600 });
  const mine = await tool.handler({ clickSelector: "#buy", timeoutMs: 200 });
  assert.match(textOf(mine), /this relay/);
  assert.strictEqual(page.clicks, 0);
});

// Each CDP step on its own: a hang there must not hold the queue.
for (const step of ["newCDPSession", "send", "detach", "cancel"]) {
  test(`R2-3a: a hung CDP ${step} is given up after the step limit, and the next call still runs`, { timeout: 20000 }, async (t) => {
    stateFor(t);
    tool._setCdpStepMs(200);
    tool._setStallMs(300);
    t.after(() => { tool._setCdpStepMs(null); tool._setStallMs(null); });
    const session = {
      send: step === "send" ? never : async () => {},
      detach: step === "detach" ? never : async () => {},
      // One progress event, then none: the stall limit applies (see finishOrGiveUp).
      on(ev, fn) { if (ev === "Browser.downloadProgress") fn({ guid: "g", receivedBytes: 1, state: "inProgress" }); },
      off() {},
    };
    const download = {
      suggestedFilename: () => "x.bin", url: () => "https://x.test/x.bin",
      failure: never, cancel: step === "cancel" ? never : async () => {},
      path: async () => "/nonexistent", saveAs: async () => {},
    };
    const page = fakePage(t, {
      newCDPSession: step === "newCDPSession" ? never : async () => session,
      waitForEvent: () => (step === "cancel" ? Promise.resolve(download) : sleep(100).then(() => { throw new Error("Timeout"); })),
    });
    const first = await within(tool.handler({ timeoutMs: 100 }), 5000, "the first call");
    assert.strictEqual(first.isError, true);
    const second = await within(tool.handler({ clickSelector: "#next", timeoutMs: 100 }), 5000, "the call queued behind it");
    assert.strictEqual(second.isError, true);
    assert.strictEqual(page.clicks, 1, "the second call got its turn and clicked");
  });
}

test("R2-3b: a queued call past its wait limit is refused without clicking, and its reservation is released", { timeout: 20000 }, async (t) => {
  const { file } = stateFor(t);
  tool._setQueueWaitMs(300);
  t.after(() => tool._setQueueWaitMs(null));
  // The first call holds the queue for 1.5 s (no download comes).
  const page = fakePage(t, { waitForEvent: () => sleep(1500).then(() => { throw new Error("Timeout 1500ms exceeded"); }) });
  const first = tool.handler({ timeoutMs: 1500 });
  const t0 = Date.now();
  const queued = await within(tool.handler({ clickSelector: "#late", timeoutMs: 1500 }), 1200, "the queued call");
  assert.ok(Date.now() - t0 < 1000, "refused at its wait limit, not after the first call");
  assert.strictEqual(queued.isError, true);
  assert.match(textOf(queued), /REFUSED/);
  assert.match(textOf(queued), /not clicked/);
  await first;
  await sleep(300);
  assert.strictEqual(page.clicks, 0, "it never clicks later");
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  assert.strictEqual(entries[keyOf(page.href, "#late")], undefined, "its reservation is released");
});

test("R2-3c: a queued call whose caller aborted is dropped without clicking", { timeout: 20000 }, async (t) => {
  const { file } = stateFor(t);
  const page = fakePage(t, { waitForEvent: () => sleep(1000).then(() => { throw new Error("Timeout 1000ms exceeded"); }) });
  const first = tool.handler({ timeoutMs: 1000 });
  const ac = new AbortController();
  const queued = tool.handler({ clickSelector: "#gone", timeoutMs: 1000 }, { signal: ac.signal });
  await sleep(100);
  ac.abort();
  const r = await within(queued, 500, "the aborted call");
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /not clicked/);
  await first;
  await sleep(300);
  assert.strictEqual(page.clicks, 0);
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  assert.strictEqual(entries[keyOf(page.href, "#gone")], undefined);
});

test("R2-3d: when a queued call's turn comes, a page that moved to another origin + path is refused, not clicked", { timeout: 20000 }, async (t) => {
  const { file } = stateFor(t);
  const page = fakePage(t, { waitForEvent: () => sleep(600).then(() => { throw new Error("Timeout 600ms exceeded"); }) });
  const first = tool.handler({ timeoutMs: 600 });
  const queued = tool.handler({ clickSelector: "#buy", timeoutMs: 600 });
  const reservedKey = keyOf(page.href, "#buy");
  await sleep(100);
  page.href = "https://shop.example.test/other-item";
  const r = await within(queued, 5000, "the queued call");
  await first;
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /REFUSED/);
  assert.match(textOf(r), /changed/);
  assert.strictEqual(page.clicks, 0);
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  assert.strictEqual(entries[reservedKey], undefined, "the unused reservation is released");
});

test("R2-3d: another query string on the same page is not a change", { timeout: 20000 }, async (t) => {
  stateFor(t);
  const page = fakePage(t, { waitForEvent: () => sleep(300).then(() => { throw new Error("Timeout"); }) });
  const first = tool.handler({ timeoutMs: 300 });
  const queued = tool.handler({ clickSelector: "#buy", timeoutMs: 300 });
  page.href = "https://shop.example.test/item?utm=x#top";
  await first;
  await within(queued, 5000, "the queued call");
  assert.strictEqual(page.clicks, 1);
});

test("R2-2: at its turn, a queued call whose reservation another relay replaced (allowRepeatClick there) is refused", { timeout: 20000 }, async (t) => {
  const { file } = stateFor(t);
  const page = fakePage(t, { waitForEvent: () => sleep(600).then(() => { throw new Error("Timeout 600ms exceeded"); }) });
  const first = tool.handler({ timeoutMs: 600 });
  const queued = tool.handler({ clickSelector: "#buy", timeoutMs: 600 });
  const k = keyOf(page.href, "#buy");
  await sleep(100);
  const theirs = { at: Date.now(), pid: process.pid + 100000 };
  fs.writeFileSync(file, JSON.stringify({ [k]: theirs }), { mode: 0o600 });
  const r = await within(queued, 5000, "the queued call");
  await first;
  assert.match(textOf(r), /REFUSED/);
  assert.match(textOf(r), /another relay/);
  assert.strictEqual(page.clicks, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8"))[k], theirs, "their reservation is left as it was");
});

test("R2-4: with no progress events at all, the stall limit does not cancel a download (the fixed fallback bound applies)", { timeout: 20000 }, async (t) => {
  stateFor(t);
  tool._setStallMs(200);
  t.after(() => tool._setStallMs(null));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const download = {
    suggestedFilename: () => "x.bin", url: () => "https://x.test/x.bin",
    failure: () => sleep(800).then(() => null), cancel: async () => {},
    path: async () => "/nonexistent", saveAs: async (dst) => fs.writeFileSync(dst, Buffer.alloc(321)),
  };
  fakePage(t, { waitForEvent: () => Promise.resolve(download) }); // the default session reports no progress
  const savePath = path.join(out, "x.bin");
  const r = await within(tool.handler({ savePath, timeoutMs: 1000 }), 5000, "the call");
  assert.notStrictEqual(r.isError, true, textOf(r));
  assert.strictEqual(fs.statSync(savePath).size, 321);
});

test("R2-1: a download that began on the tool's session but was never captured is cancelled before the session detaches", { timeout: 20000 }, async (t) => {
  stateFor(t);
  const calls = [];
  const handlers = {};
  const session = {
    send: async (m, p) => { calls.push([m, p && p.guid]); },
    detach: async () => { calls.push(["detach"]); },
    on(ev, fn) { handlers[ev] = fn; },
    off() {},
  };
  const page = fakePage(t, {
    session,
    // The click is dispatched, a download begins on the session, then the wait gives up.
    click: async () => { setTimeout(() => handlers["Browser.downloadWillBegin"] && handlers["Browser.downloadWillBegin"]({ guid: "late-1" }), 50); },
    waitForEvent: () => sleep(300).then(() => { throw new Error("Timeout 300ms exceeded"); }),
  });
  const r = await within(tool.handler({ clickSelector: "#buy", timeoutMs: 300 }), 5000, "the call");
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /served \(or charged for\)/);
  assert.strictEqual(page.clicks, 1);
  const cancel = calls.findIndex(([m, g]) => m === "Browser.cancelDownload" && g === "late-1");
  assert.ok(cancel >= 0, `cancelDownload sent (${JSON.stringify(calls)})`);
  assert.ok(cancel < calls.findIndex(([m]) => m === "detach"), "before the detach");
});
