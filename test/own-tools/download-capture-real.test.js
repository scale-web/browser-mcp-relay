// download-capture-real.test.js — download_capture with a SECOND Playwright
// client attached (diagnosed 2026-11-17, ask as-ops/ask-bnyrbp; backlog
// 2026-09-17 item 1 and its 2026-11-16 recurrence).
//
// Each Playwright connection sends Browser.setDownloadBehavior with its own
// playwright-artifacts-* dir when it attaches, so the last client wins — in the
// relay that is always upstream (connectOverCDP after the relay's launch). The
// relay's download.saveAs then copied from its own empty dir: ENOENT. Now
// download_capture points the browser at a download dir of its own right
// before the click and copies the file from there.
//
// Real Chromium (Chrome for Testing from Playwright's cache; skipped when
// absent): the relay's persistent context, a second client over CDP, a local
// server. Assertions read the saved file and the server's hit count.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const tool = require("../../src/own-tools/download-capture.js");
const { setActivePage, clearActivePage } = require("../../src/own-tools/_active-page.js");

let chromium = null;
try { ({ chromium } = require("playwright")); if (!fs.existsSync(chromium.executablePath())) chromium = null; } catch { chromium = null; }
const REAL = { timeout: 60000, skip: chromium ? false : "Chrome for Testing not installed" };

const BODY = Buffer.alloc(12345, 7);
const BODY_A = Buffer.alloc(11111, 1);
const BODY_B = Buffer.alloc(22222, 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ownDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("relay-download-"));

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-out-"));
  const hits = { file: 0, a: 0, b: 0, slow: 0 };
  const stalled = [];
  const attach = (res, body, name) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"`, "content-length": body.length });
    res.end(body);
  };
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    if (req.url.startsWith("/fileA")) {
      hits.a++;
      setTimeout(() => attach(res, BODY_A, "a.bin"), 400); // overlaps a concurrent call
    } else if (req.url.startsWith("/fileB")) {
      hits.b++;
      setTimeout(() => attach(res, BODY_B, "b.bin"), 400);
    } else if (req.url.startsWith("/stall")) {
      hits.stall = (hits.stall || 0) + 1; // starts, then never finishes
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=\"stall.bin\"", "content-length": 1000000 });
      res.write(Buffer.alloc(1000, 3));
      stalled.push(res);
    } else if (req.url.startsWith("/slow")) {
      hits.slow++; // a server that answers in 3 s: the click itself times out
      setTimeout(() => attach(res, BODY, "slow.bin"), 3000);
    } else if (req.url.startsWith("/file")) {
      hits.file++;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=\"asset.bin\"", "content-length": BODY.length });
      res.end(BODY);
    } else if (req.url.startsWith("/redir")) {
      // Another origin, as a presigned S3 URL is.
      res.writeHead(302, { location: `http://localhost:${port}/file` });
      res.end();
    } else {
      res.setHeader("content-type", "text/html");
      res.end(`<a id=direct href="/file">direct</a> <a id=redirected href="/redir">redirected</a> `
        + `<a id=a href="/fileA">a</a> <a id=b href="/fileB">b</a> <a id=slow href="/slow">slow</a> <a id=stall href="/stall">stall</a>`);
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  // As the relay launches Brave: a persistent context (pipe) with a CDP port.
  const context = await chromium.launchPersistentContext(dir, {
    headless: true, args: ["--remote-debugging-port=0"], handleSIGINT: false, handleSIGTERM: false,
  });
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  assert.ok(port, "DevToolsActivePort was written");
  const page = context.pages()[0] || (await context.newPage());
  // Upstream attaches AFTER the relay's launch, so its download dir wins.
  const upstream = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  globalThis.__relayBridge = { context };
  clearActivePage();
  setActivePage(page);
  // The repeat-click reservations live in a file; never the real cache root here.
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-state-"));
  tool._setStateDir(state);
  t.after(async () => {
    tool._setStateDir(null);
    fs.rmSync(state, { recursive: true, force: true });
    globalThis.__relayBridge = undefined;
    clearActivePage();
    await upstream.close().catch(() => {});
    await context.close().catch(() => {});
    for (const r of stalled) r.destroy();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { page, upstream, base, out, hits, port, state };
}

const text = (res) => res.content.map((c) => c.text).join("\n");

for (const [name, selector] of [["a direct attachment", "#direct"], ["a 302 to another origin", "#redirected"]]) {
  test(`download_capture with a second client attached: ${name} is saved whole`, REAL, async (t) => {
    const { page, base, out, hits } = await setup(t);
    await page.goto(`${base}/?case=${encodeURIComponent(selector)}`);
    const savePath = path.join(out, "saved.bin");
    const res = await tool.handler({ clickSelector: selector, savePath, timeoutMs: 15000 });
    assert.notStrictEqual(res.isError, true, text(res));
    assert.ok(fs.existsSync(savePath), "the file is saved");
    assert.strictEqual(fs.statSync(savePath).size, BODY.length);
    assert.strictEqual(JSON.parse(text(res)).savedTo, savePath);
    assert.strictEqual(hits.file, 1);
  });
}

test("download_capture: a repeat click on the same page + selector is refused without allowRepeatClick, allowed with it", REAL, async (t) => {
  const { page, base, out, hits } = await setup(t);
  await page.goto(`${base}/?case=repeat`);
  const first = await tool.handler({ clickSelector: "#direct", savePath: path.join(out, "a.bin"), timeoutMs: 15000 });
  assert.notStrictEqual(first.isError, true, text(first));

  const again = await tool.handler({ clickSelector: "#direct", savePath: path.join(out, "b.bin"), timeoutMs: 15000 });
  assert.strictEqual(again.isError, true);
  assert.match(text(again), /allowRepeatClick/);
  assert.match(text(again), /charged|served/);
  assert.strictEqual(fs.existsSync(path.join(out, "b.bin")), false);
  assert.strictEqual(hits.file, 1, "the refused repeat never reached the server");

  // Another selector on the same page is not a repeat.
  const other = await tool.handler({ clickSelector: "#redirected", savePath: path.join(out, "c.bin"), timeoutMs: 15000 });
  assert.notStrictEqual(other.isError, true, text(other));
  assert.strictEqual(hits.file, 2);

  const optIn = await tool.handler({ clickSelector: "#direct", savePath: path.join(out, "d.bin"), timeoutMs: 15000, allowRepeatClick: true });
  assert.notStrictEqual(optIn.isError, true, text(optIn));
  assert.strictEqual(fs.statSync(path.join(out, "d.bin")).size, BODY.length);
  assert.strictEqual(hits.file, 3);
});

test("download_capture: upstream attaching again between calls (it re-asserts its own dir) does not break the next capture", REAL, async (t) => {
  const { page, upstream, base, out, hits, port } = await setup(t);
  await page.goto(`${base}/?case=reattach`);
  const first = await tool.handler({ clickSelector: "#direct", savePath: path.join(out, "1.bin"), timeoutMs: 15000 });
  assert.notStrictEqual(first.isError, true, text(first));
  // A restarted upstream child: a new connection sends its own setDownloadBehavior.
  await upstream.close().catch(() => {});
  const again = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  t.after(() => again.close().catch(() => {}));
  const second = await tool.handler({ clickSelector: "#redirected", savePath: path.join(out, "2.bin"), timeoutMs: 15000 });
  assert.notStrictEqual(second.isError, true, text(second));
  assert.strictEqual(fs.statSync(path.join(out, "2.bin")).size, BODY.length);
  assert.strictEqual(hits.file, 2);
});

// ───── review round 1 (2026-11-17) ─────

test("R1-1: a click Playwright dispatched that then timed out (server answers in 3 s) still blocks a retry; the error warns", REAL, async (t) => {
  const { page, base, out, hits } = await setup(t);
  await page.goto(`${base}/`);
  const first = await tool.handler({ clickSelector: "#slow", savePath: path.join(out, "s1.bin"), timeoutMs: 1000 });
  assert.strictEqual(first.isError, true);
  assert.match(text(first), /served \(or charged for\)/);
  await sleep(300);
  assert.strictEqual(hits.slow, 1, "the click reached the server");
  const retry = await tool.handler({ clickSelector: "#slow", savePath: path.join(out, "s2.bin"), timeoutMs: 1000 });
  assert.strictEqual(retry.isError, true);
  assert.match(text(retry), /REFUSED/);
  await sleep(300);
  assert.strictEqual(hits.slow, 1, "the retry never reached the server");
});

test("R1-2: two concurrent download_capture calls each save their own file whole, and leave no own dir behind", REAL, async (t) => {
  const { page, base, out, hits } = await setup(t);
  await page.goto(`${base}/`);
  const before = new Set(ownDirs());
  const [ra, rb] = await Promise.all([
    tool.handler({ clickSelector: "#a", savePath: path.join(out, "a.bin"), timeoutMs: 15000 }),
    tool.handler({ clickSelector: "#b", savePath: path.join(out, "b.bin"), timeoutMs: 15000 }),
  ]);
  assert.notStrictEqual(ra.isError, true, text(ra));
  assert.notStrictEqual(rb.isError, true, text(rb));
  assert.strictEqual(fs.statSync(path.join(out, "a.bin")).size, BODY_A.length);
  assert.strictEqual(fs.statSync(path.join(out, "b.bin")).size, BODY_B.length);
  assert.deepStrictEqual([hits.a, hits.b], [1, 1]);
  await sleep(1500); // Chrome must not recreate a removed dir
  assert.deepStrictEqual(ownDirs().filter((n) => !before.has(n)), [], "no relay-download-* dir left");
});

test("R1-3: two concurrent calls on the same page + selector: exactly one clicks", REAL, async (t) => {
  const { page, base, out, hits } = await setup(t);
  await page.goto(`${base}/`);
  const rs = await Promise.all([
    tool.handler({ clickSelector: "#direct", savePath: path.join(out, "x.bin"), timeoutMs: 15000 }),
    tool.handler({ clickSelector: "#direct", savePath: path.join(out, "y.bin"), timeoutMs: 15000 }),
  ]);
  assert.strictEqual(rs.filter((r) => r.isError !== true).length, 1, rs.map(text).join(" | "));
  assert.match(rs.map(text).join("\n"), /REFUSED/);
  assert.strictEqual(hits.file, 1, "one click reached the server");
  const saved = ["x.bin", "y.bin"].filter((n) => fs.existsSync(path.join(out, n)));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(fs.statSync(path.join(out, saved[0])).size, BODY.length);
});

test("R1-3: the key is origin + path (another query is the same page), and it survives a restart in another process", REAL, async (t) => {
  const { page, base, out, hits, state } = await setup(t);
  await page.goto(`${base}/?item=1`);
  const first = await tool.handler({ clickSelector: "#direct", savePath: path.join(out, "1.bin"), timeoutMs: 15000 });
  assert.notStrictEqual(first.isError, true, text(first));
  await page.goto(`${base}/?item=1&utm=x#top`);
  const again = await tool.handler({ clickSelector: "#direct", savePath: path.join(out, "2.bin"), timeoutMs: 15000 });
  assert.strictEqual(again.isError, true);
  assert.match(text(again), /REFUSED/);
  assert.strictEqual(hits.file, 1);

  // A restarted relay (or another relay on this Brave): a fresh process, same state dir.
  const { spawnSync } = require("node:child_process");
  const code = `
    const tool = require(${JSON.stringify(path.resolve(__dirname, "../../src/own-tools/download-capture.js"))});
    const { setActivePage } = require(${JSON.stringify(path.resolve(__dirname, "../../src/own-tools/_active-page.js"))});
    tool._setStateDir(${JSON.stringify(state)});
    const page = { url: () => ${JSON.stringify(`${base}/?item=2`)}, isClosed: () => false, once() {}, off() {},
      waitForEvent: () => new Promise(() => {}), click: async () => { console.log("CLICKED"); } };
    globalThis.__relayBridge = { context: { pages: () => [page] } };
    setActivePage(page);
    tool.handler({ clickSelector: "#direct", timeoutMs: 500 }).then((r) => { console.log(JSON.stringify(r)); process.exit(0); });
  `;
  const child = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 20000 });
  assert.doesNotMatch(child.stdout, /CLICKED/, child.stdout + child.stderr);
  assert.match(child.stdout, /REFUSED/, child.stdout + child.stderr);
  assert.strictEqual(hits.file, 1);
});

test("R1-5: a download that starts and never finishes is given up after the bound, cancelled, and leaves no own dir", REAL, async (t) => {
  const { page, base, out } = await setup(t);
  tool._setDownloadFinishMs(1500);
  t.after(() => tool._setDownloadFinishMs(null));
  await page.goto(`${base}/`);
  const before = new Set(ownDirs());
  const t0 = Date.now();
  const res = await tool.handler({ clickSelector: "#stall", savePath: path.join(out, "stall.bin"), timeoutMs: 15000 });
  assert.strictEqual(res.isError, true);
  assert.match(text(res), /did not finish/);
  assert.match(text(res), /served \(or charged for\)/);
  assert.ok(Date.now() - t0 < 10000, "returned at the bound, not never");
  assert.strictEqual(fs.existsSync(path.join(out, "stall.bin")), false);
  await sleep(1500);
  assert.deepStrictEqual(ownDirs().filter((n) => !before.has(n)), [], "no relay-download-* dir left");
});
