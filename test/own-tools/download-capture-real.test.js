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

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "relay-dl-out-"));
  const hits = { file: 0 };
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    if (req.url.startsWith("/file")) {
      hits.file++;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=\"asset.bin\"", "content-length": BODY.length });
      res.end(BODY);
    } else if (req.url.startsWith("/redir")) {
      // Another origin, as a presigned S3 URL is.
      res.writeHead(302, { location: `http://localhost:${port}/file` });
      res.end();
    } else {
      res.setHeader("content-type", "text/html");
      res.end(`<a id=direct href="/file">direct</a> <a id=redirected href="/redir">redirected</a>`);
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
  t.after(async () => {
    globalThis.__relayBridge = undefined;
    clearActivePage();
    await upstream.close().catch(() => {});
    await context.close().catch(() => {});
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { page, upstream, base, out, hits, port };
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
