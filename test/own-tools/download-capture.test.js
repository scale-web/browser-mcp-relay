const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/download-capture.js");

// This file's own $TMPDIR: download_capture makes (and sweeps) relay-download-*
// dirs there, and must never touch another process's.
{
  const nfs = require("node:fs"), nos = require("node:os"), npath = require("node:path");
  const mine = nfs.mkdtempSync(npath.join(nos.tmpdir(), "relay-dl-unit-tmp-"));
  process.env.TMPDIR = mine;
  process.on("exit", () => { try { nfs.rmSync(mine, { recursive: true, force: true }); } catch { /* gone */ } });
}

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
    const { file: f } = stateFor(t);
    tool._setCdpStepMs(200);
    tool._setNewSessionMs(200);
    tool._setStallMs(300);
    t.after(() => { tool._setCdpStepMs(null); tool._setNewSessionMs(null); tool._setStallMs(null); });
    const session = {
      send: step === "send" ? never : async () => {},
      detach: step === "detach" ? never : async () => {},
      // The captured download began on the session, then its progress stops at
      // 1 byte: the stall limit applies (see finishOrGiveUp).
      on(ev, fn) {
        if (ev === "Browser.downloadWillBegin") fn({ guid: "g", url: "https://x.test/x.bin", suggestedFilename: "x.bin" });
        if (ev === "Browser.downloadProgress") { this.iv = setInterval(() => fn({ guid: "g", receivedBytes: 1, state: "inProgress" }), 50); this.iv.unref(); }
      },
      off() { clearInterval(this.iv); },
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
    if (step === "newCDPSession" || step === "send") {
      // Its own dir cannot be set up either: refused before the click (review r3 M1).
      assert.match(textOf(second), /REFUSED/);
      assert.match(textOf(second), /not clicked/);
      assert.strictEqual(page.clicks, 0, "the second call got its turn and did not click");
      const entries = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
      assert.strictEqual(entries[keyOf(page.href, "#next")], undefined, "its reservation is released");
    } else {
      assert.strictEqual(page.clicks, 1, "the second call got its turn and clicked");
    }
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
  assert.match(textOf(r), /reserved or made/, "it may not have clicked yet (review r3 L5)");
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

// ───── review round 3 (2026-11-17) ─────

for (const how of ["rejects", "throws"]) {
  test(`R3-1: a clickSelector call whose own dir cannot be set up (CDP ${how}) is refused before the click`, { timeout: 20000 }, async (t) => {
    const { file } = stateFor(t);
    const page = fakePage(t, {
      newCDPSession: how === "rejects" ? async () => { throw new Error("Target closed"); } : () => { throw new Error("no CDP"); },
    });
    const r = await within(tool.handler({ clickSelector: "#buy", timeoutMs: 300 }), 5000, "the call");
    assert.strictEqual(r.isError, true);
    assert.match(textOf(r), /REFUSED/);
    assert.match(textOf(r), /not clicked/);
    assert.strictEqual(page.clicks, 0);
    const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    assert.strictEqual(entries[keyOf(page.href, "#buy")], undefined, "its reservation is released");
    // Without clickSelector the saveAs fallback is still used (nothing is clicked).
    const plain = await within(tool.handler({ timeoutMs: 100 }), 5000, "the plain call");
    assert.match(textOf(plain), /no download in 100ms/);
  });
}

test("R3-2: each call sweeps this process's earlier own dirs (a late download recreated one) and others' dirs idle > 24 h", { timeout: 20000 }, async (t) => {
  stateFor(t);
  const tmp = os.tmpdir();
  const paths = [];
  const session = { send: async (m, p) => { if (p && p.downloadPath) paths.push(p.downloadPath); }, detach: async () => {}, on() {}, off() {} };
  fakePage(t, { session });
  await within(tool.handler({ timeoutMs: 100 }), 5000, "call 1");
  assert.strictEqual(paths.length, 1);
  assert.strictEqual(fs.existsSync(paths[0]), false, "call 1 removed its dir");
  // Chrome recreates it with a 0-byte file (an other-tab download cancelled after the call).
  fs.mkdirSync(paths[0], { mode: 0o700 });
  fs.writeFileSync(path.join(paths[0], "guid.crdownload"), "");
  // Another relay's dir, idle 25 h (its relay died) — and one in use now.
  const old = fs.mkdtempSync(path.join(tmp, "relay-download-"));
  fs.writeFileSync(path.join(old, "x"), "1");
  const then = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(path.join(old, "x"), then, then);
  fs.utimesSync(old, then, then);
  const fresh = fs.mkdtempSync(path.join(tmp, "relay-download-"));
  fs.writeFileSync(path.join(fresh, "y"), "2");
  // An old dir with a fresh file inside: a long download still writing. Kept.
  const busy = fs.mkdtempSync(path.join(tmp, "relay-download-"));
  fs.writeFileSync(path.join(busy, "z.crdownload"), "3");
  fs.utimesSync(busy, then, then);
  await within(tool.handler({ timeoutMs: 100 }), 5000, "call 2");
  assert.strictEqual(fs.existsSync(paths[0]), false, "this process's earlier dir is swept");
  assert.strictEqual(fs.existsSync(old), false, "a dir idle > 24 h is swept");
  assert.strictEqual(fs.statSync(path.join(fresh, "y")).size, 1, "another relay's live dir is kept");
  assert.strictEqual(fs.statSync(path.join(busy, "z.crdownload")).size, 1, "a dir with a fresh file is kept");
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.rmSync(busy, { recursive: true, force: true });
});

test("R3-1: newCDPSession has its own, longer limit than the other CDP steps", { timeout: 20000 }, async (t) => {
  stateFor(t);
  tool._setCdpStepMs(200);
  tool._setNewSessionMs(2000);
  t.after(() => { tool._setCdpStepMs(null); tool._setNewSessionMs(null); });
  const page = fakePage(t, { newCDPSession: () => sleep(600).then(() => ({ send: async () => {}, detach: async () => {}, on() {}, off() {} })) });
  const r = await within(tool.handler({ clickSelector: "#buy", timeoutMs: 200 }), 5000, "the call");
  assert.doesNotMatch(textOf(r), /REFUSED/);
  assert.strictEqual(page.clicks, 1, "a slow (600 ms) session is waited for");
});

// ───── review round 4 (2026-11-17) ─────

/** A session on which the captured download (guid "g") began, with progress
 *  stuck at 1 byte (or no progress events at all), recording the dir it set. */
function stuckSession({ events = true } = {}) {
  const s = {
    dirs: [],
    send: async (m, p) => { if (p && p.downloadPath) s.dirs.push(p.downloadPath); },
    detach: async () => {},
    on(ev, fn) {
      if (!events) return;
      if (ev === "Browser.downloadWillBegin") fn({ guid: "g", url: "https://x.test/x.bin", suggestedFilename: "x.bin" });
      if (ev === "Browser.downloadProgress") { s.iv = setInterval(() => fn({ guid: "g", receivedBytes: 1, state: "inProgress" }), 50); s.iv.unref(); }
    },
    off() { clearInterval(s.iv); },
  };
  return s;
}
function fakeDownload(over = {}) {
  return {
    suggestedFilename: () => "x.bin", url: () => "https://x.test/x.bin",
    failure: () => sleep(600).then(() => null), cancel: async () => {},
    path: async () => "/nonexistent", saveAs: async () => { throw new Error("ENOENT: copyfile (upstream's dir won)"); },
    ...over,
  };
}

for (const bad of [0, -5]) {
  test(`R4-1: stallMs ${bad} is clamped to 1 s — a stuck download is not cancelled at once`, { timeout: 20000 }, async (t) => {
    stateFor(t);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-out-"));
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const session = stuckSession();
    // Finishes at 600 ms: inside the clamped 1 s limit. saveAs writes the file here.
    fakePage(t, { session, waitForEvent: () => Promise.resolve(fakeDownload({ saveAs: async (dst) => fs.writeFileSync(dst, Buffer.alloc(55)) })) });
    const r = await within(tool.handler({ savePath: path.join(out, "x.bin"), timeoutMs: 1000, stallMs: bad }), 5000, "the call");
    assert.notStrictEqual(r.isError, true, textOf(r));
    assert.strictEqual(fs.statSync(path.join(out, "x.bin")).size, 55);
  });
}

test("R4-1: with no progress events and stallMs above the fallback limit, the limit is stallMs", { timeout: 20000 }, async (t) => {
  stateFor(t);
  tool._setFallbackFinishMs(300);
  t.after(() => tool._setFallbackFinishMs(null));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  fakePage(t, { session: stuckSession({ events: false }), waitForEvent: () => Promise.resolve(fakeDownload({ failure: () => sleep(700).then(() => null), saveAs: async (dst) => fs.writeFileSync(dst, Buffer.alloc(66)) })) });
  const ok = await within(tool.handler({ savePath: path.join(out, "a.bin"), timeoutMs: 1000, stallMs: 1500 }), 5000, "the call");
  assert.notStrictEqual(ok.isError, true, `not cancelled at the 300 ms fallback: ${textOf(ok)}`);
  assert.strictEqual(fs.statSync(path.join(out, "a.bin")).size, 66);
  // ...and it does apply: a download that never finishes is cancelled at stallMs.
  fakePage(t, { session: stuckSession({ events: false }), waitForEvent: () => Promise.resolve(fakeDownload({ failure: never })) });
  const t0 = Date.now();
  const stuck = await within(tool.handler({ savePath: path.join(out, "b.bin"), timeoutMs: 1000, stallMs: 1500 }), 5000, "the stuck call");
  assert.match(textOf(stuck), /no progress reported/);
  assert.ok(Date.now() - t0 >= 1400, `cancelled at stallMs, not before (${Date.now() - t0} ms)`);
});

test("R4-2: timeoutMs is capped at 1 h (a longer wait could outlive the 24 h stale-dir sweep)", { timeout: 20000 }, async (t) => {
  stateFor(t);
  const seen = [];
  fakePage(t, {
    waitForEvent: (_ev, o) => { seen.push(["wait", o.timeout]); return sleep(50).then(() => { throw new Error("Timeout"); }); },
    click: async () => {},
  });
  const page = globalThis.__relayBridge.context.pages()[0];
  const origClick = page.click;
  page.click = async (sel, o) => { seen.push(["click", o.timeout]); return origClick(sel, o); };
  await within(tool.handler({ clickSelector: "#buy", timeoutMs: 1e12 }), 5000, "the call");
  assert.deepStrictEqual(seen, [["wait", 3600000], ["click", 3600000]]);
});

test("R4-3: if download.path() hangs, the finished file is copied from <own dir>/<guid>", { timeout: 20000 }, async (t) => {
  stateFor(t);
  tool._setCdpStepMs(200);
  t.after(() => tool._setCdpStepMs(null));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const session = stuckSession();
  // Chrome finished writing <dir>/g; path() never answers; saveAs is the broken fallback.
  const download = fakeDownload({ failure: async () => { await sleep(100); fs.writeFileSync(path.join(session.dirs[0], "g"), Buffer.alloc(4321)); return null; }, path: never });
  fakePage(t, { session, waitForEvent: () => Promise.resolve(download) });
  const savePath = path.join(out, "x.bin");
  const r = await within(tool.handler({ savePath, timeoutMs: 1000 }), 5000, "the call");
  assert.notStrictEqual(r.isError, true, textOf(r));
  assert.strictEqual(fs.statSync(savePath).size, 4321);
});

test("R4-3: with no file found and saveAs failing, the own dir is kept (not swept by the next call) and its path reported", { timeout: 20000 }, async (t) => {
  stateFor(t);
  tool._setCdpStepMs(200);
  t.after(() => tool._setCdpStepMs(null));
  const session = stuckSession({ events: false }); // no guid known
  const download = fakeDownload({ failure: async () => { await sleep(100); fs.writeFileSync(path.join(session.dirs[0], "unknown-guid"), Buffer.alloc(777)); return null; }, path: never });
  fakePage(t, { session, waitForEvent: () => Promise.resolve(download) });
  const r = await within(tool.handler({ timeoutMs: 1000 }), 5000, "the call");
  const dir = session.dirs[0];
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.strictEqual(r.isError, true);
  assert.ok(textOf(r).includes(dir), `the kept dir is named: ${textOf(r)}`);
  assert.match(textOf(r), /served \(or charged for\)/);
  await sleep(1200); // past the 1 s removal retry
  // The next call's sweep of this process's earlier dirs leaves it alone.
  fakePage(t, { session: stuckSession({ events: false }) });
  await within(tool.handler({ timeoutMs: 100 }), 5000, "the next call");
  assert.strictEqual(fs.statSync(path.join(dir, "unknown-guid")).size, 777, "the charged file is still there");
});

// ───── review of 140cf47 (2026-11-17) ─────

for (const [bad, want] of [[null, 30000], [-5, 30000], [Number.NaN, 30000], ["abc", 30000], [0, 3600000], [1234, 1234]]) {
  test(`L4: timeoutMs ${String(bad)} waits ${want} ms (only a finite value >= 0 is used; 0 means the cap)`, { timeout: 20000 }, async (t) => {
    stateFor(t);
    const seen = [];
    fakePage(t, { waitForEvent: (_ev, o) => { seen.push(o.timeout); return sleep(20).then(() => { throw new Error("Timeout"); }); } });
    await within(tool.handler({ timeoutMs: bad }), 5000, "the call");
    assert.deepStrictEqual(seen, [want]);
  });
}

// ───── final review of 5ec97f6 (2026-11-17), LOWs 2 and 4 ─────

test("5ec97f6 L2: a clickSelector call whose savePath is an existing directory is refused before the click; the reservation is released", { timeout: 20000 }, async (t) => {
  const { file } = stateFor(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const page = fakePage(t, { waitForEvent: () => sleep(200).then(() => { throw new Error("Timeout 200ms exceeded"); }) });
  const r = await within(tool.handler({ clickSelector: "#buy", savePath: out, timeoutMs: 200 }), 5000, "the call");
  assert.strictEqual(r.isError, true, textOf(r));
  assert.match(textOf(r), /REFUSED/);
  assert.match(textOf(r), /not clicked/);
  assert.match(textOf(r), /directory/);
  assert.ok(textOf(r).includes(out), `names the path: ${textOf(r)}`);
  assert.strictEqual(page.clicks, 0, "never clicked");
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  assert.strictEqual(entries[keyOf(page.href, "#buy")], undefined, "the unused reservation is released");
  assert.deepStrictEqual(fs.readdirSync(out), [], "the directory is left as it was");
});

test("5ec97f6 L4: a queued call refused because the page moved creates no directories under its savePath", { timeout: 20000 }, async (t) => {
  stateFor(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-out-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const page = fakePage(t, { waitForEvent: () => sleep(600).then(() => { throw new Error("Timeout 600ms exceeded"); }) });
  const first = tool.handler({ timeoutMs: 600 });
  const queued = tool.handler({ clickSelector: "#buy", savePath: path.join(out, "new", "deeper", "x.bin"), timeoutMs: 600 });
  await sleep(100);
  page.href = "https://shop.example.test/other-item";
  const r = await within(queued, 5000, "the queued call");
  await first;
  assert.match(textOf(r), /REFUSED/);
  assert.match(textOf(r), /changed/);
  assert.strictEqual(page.clicks, 0);
  assert.deepStrictEqual(fs.readdirSync(out), [], "no empty directories left in the chosen path");
});
