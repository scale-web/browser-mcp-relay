// A1: upstream's session page (and its re-creation) must open in the
// background, never through Playwright's activating newPage(). Mirrors the A76
// patcher tests, including the live-bundle check that makes an upstream
// upgrade which breaks the pattern fail `npm test`, and runs the PATCHED
// newPage() taken from the live bundle against a fake browser context.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const patcher = require("../scripts/patch-bdmcp-quiet-page.js");

const SHAPE =
  "async function newPage(browserContext,pageOptions={}){return await browserContext.newPage()}" +
  "class S{async ensureSessionPageOpen(){this._page=await this.browserContext.newPage(),this._attachPageListeners(this._page)}}";

/** Raw activating newPage() calls, the helper's own fallback excluded. */
function rawNewPageCalls(src) {
  const i = src.indexOf(patcher.MARKER);
  const body = i === -1 ? src : src.slice(0, i);
  return (body.match(/\.newPage\(/g) || []).length;
}

test("A1: patchSource routes both session-page call sites through the helper and marks the file", () => {
  const out = patcher.patchSource(SHAPE);
  assert.ok(out, "expected a patched source");
  assert.strictEqual(rawNewPageCalls(out), 0, "no activating newPage() may remain at either call site");
  assert.ok(out.includes(`async function newPage(browserContext,pageOptions={}){return await ${patcher.HELPER_NAME}(browserContext)}`));
  assert.ok(out.includes(`this._page=await ${patcher.HELPER_NAME}(this.browserContext),this._attachPageListeners`));
  assert.ok(out.includes(patcher.MARKER) && out.includes(`async function ${patcher.HELPER_NAME}(`));
});

test("A1: patchSource is idempotent, all-or-nothing, and no-ops on a changed shape", () => {
  assert.strictEqual(patcher.patchSource(patcher.patchSource(SHAPE)), null);
  const [fnOnly, ensureOnly] = [SHAPE.split("class S")[0], "class S" + SHAPE.split("class S")[1]];
  assert.strictEqual(patcher.patchSource(fnOnly), null, "one site without the other must not be patched");
  assert.strictEqual(patcher.patchSource(ensureOnly), null);
  assert.strictEqual(patcher.patchSource(SHAPE + SHAPE), null, "more than one match must not be patched");
  assert.strictEqual(patcher.patchSource("async function newPage(c){return c.newPage({})}"), null);
});

test("A1: applyPatch on a fixture distDir applies atomically, then reports already", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a1-patch-"));
  try {
    const file = path.join(dir, "core-TEST1234.js");
    fs.writeFileSync(file, `function createToolSessionContext(){}${SHAPE}`);
    fs.writeFileSync(path.join(dir, "core-OTHER999.js"), "unrelated");
    const logs = [];
    const renames = [];
    const realRename = fs.renameSync;
    fs.renameSync = (a, b) => { renames.push(path.basename(b)); return realRename(a, b); };
    let r1;
    try { r1 = patcher.applyPatch({ distDir: dir, log: (m) => logs.push(m) }); } finally { fs.renameSync = realRename; }
    assert.deepStrictEqual([r1.patched, r1.action, r1.file], [true, "applied", file]);
    assert.deepStrictEqual(renames, ["core-TEST1234.js"], "the patched file must be renamed into place");
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["core-OTHER999.js", "core-TEST1234.js"], "no temp file left behind");
    assert.strictEqual(rawNewPageCalls(fs.readFileSync(file, "utf8")), 0);
    assert.strictEqual(logs.length, 1);
    const r2 = patcher.applyPatch({ distDir: dir, log: (m) => logs.push(m) });
    assert.deepStrictEqual([r2.patched, r2.action], [true, "already"]);
    assert.strictEqual(fs.readFileSync(path.join(dir, "core-OTHER999.js"), "utf8"), "unrelated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A1: applyPatch replaces a LOWER-version helper (and only the helper), never an equal or HIGHER one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a1-patch-"));
  try {
    const file = path.join(dir, "core-TEST1234.js");
    const current = patcher.patchSource(`function createToolSessionContext(){}${SHAPE}`);
    const head = current.slice(0, current.indexOf(patcher.MARKER));
    const oldHelper = `async function ${patcher.HELPER_NAME}(c){return c.newPage()}`;
    const v = patcher.HELPER_VERSION;
    // Lower: the first build's unversioned marker (v1), and an explicit v(N-1).
    for (const oldMarker of ["/*A1: session page opened in the background*/", `/*A1: session page opened in the background v${v - 1}*/`]) {
      fs.writeFileSync(file, `${head}${oldMarker}\n${oldHelper}\n`);
      const r = patcher.applyPatch({ distDir: dir, log: () => {} });
      assert.deepStrictEqual([r.patched, r.action], [true, "updated"], oldMarker);
      assert.strictEqual(fs.readFileSync(file, "utf8"), current, "the bundle must carry exactly the current helper");
      assert.strictEqual(patcher.applyPatch({ distDir: dir, log: () => {} }).action, "already");
    }
    // Higher: a newer relay patched it; this (older) script must not write it back.
    const newer = `${head}/*A1: session page opened in the background v${v + 1}*/\nasync function ${patcher.HELPER_NAME}(c){return "newer"}\n`;
    fs.writeFileSync(file, newer);
    const r = patcher.applyPatch({ distDir: dir, log: () => {} });
    assert.deepStrictEqual([r.patched, r.action, r.version], [true, "newer", v + 1]);
    assert.strictEqual(fs.readFileSync(file, "utf8"), newer, "a newer helper must be left as it is");
    // Equal version with different text: left alone too (a version bump is what replaces).
    const same = `${head}${patcher.MARKER}\n${oldHelper}\n`;
    fs.writeFileSync(file, same);
    assert.strictEqual(patcher.applyPatch({ distDir: dir, log: () => {} }).action, "already");
    assert.strictEqual(fs.readFileSync(file, "utf8"), same);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A1: applyPatch soft-fails on a missing dir and on a changed shape", () => {
  assert.strictEqual(patcher.applyPatch({ distDir: "/__no_such_dir__/dist" }).patched, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a1-patch-"));
  try {
    fs.writeFileSync(path.join(dir, "core-TEST1234.js"), "function createToolSessionContext(){return ctx.newPage()}");
    const r = patcher.applyPatch({ distDir: dir, log: () => {} });
    assert.strictEqual(r.patched, false);
    assert.ok(/shape changed/.test(r.reason));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── behaviour of the helper, against a fake Playwright context ──

function fakeContext({ createFails = false, attach = true, pagesBefore = 1, bystander = false } = {}) {
  const calls = { newPage: 0, createTarget: [], closeTarget: [], detached: 0 };
  let seq = 0;
  const mkPage = (targetId) => ({ targetId, closed: false, isClosed() { return this.closed; } });
  const pages = [];
  for (let i = 0; i < pagesBefore; i++) pages.push(mkPage(`old-${i}`));
  const browserSession = {
    async send(method, params) {
      if (method === "Target.createTarget") {
        calls.createTarget.push(params);
        if (createFails) throw new Error("createTarget refused");
        const targetId = `T${++seq}`;
        // A tab another client opened at the same moment lands first.
        if (bystander) pages.push(mkPage("someone-elses"));
        if (attach) setTimeout(() => pages.push(mkPage(targetId)), 20);
        return { targetId };
      }
      if (method === "Target.closeTarget") { calls.closeTarget.push(params.targetId); return {}; }
      throw new Error(`unexpected ${method}`);
    },
    async detach() { calls.detached++; },
  };
  const context = Object.assign(new EventEmitter(), {
    pages: () => pages.slice(),
    browser: () => ({ newBrowserCDPSession: async () => browserSession }),
    newCDPSession: async (page) => ({
      async send(method) {
        assert.strictEqual(method, "Target.getTargetInfo");
        return { targetInfo: { targetId: page.targetId } };
      },
      async detach() {},
    }),
    async newPage() { calls.newPage++; const p = mkPage("activating"); pages.push(p); return p; },
  });
  return { context, calls, pages };
}

/** The helper plus the PATCHED newPage() from `src`, compiled together with a
 *  fake `process` (platform + stderr). */
function compilePatched(src, platform = "darwin") {
  const fnMatch = src.match(/async function newPage\(\w+,\w+=\{\}\)\{return await __relayQuietNewPage\(\w+\)\}/);
  assert.ok(fnMatch, "patched newPage() not found");
  const i = src.indexOf(patcher.MARKER);
  assert.ok(i !== -1, "helper marker not found");
  const helper = src.slice(i + patcher.MARKER.length);
  const stderr = [];
  const fakeProcess = { platform, stderr: { write: (m) => stderr.push(m) } };
  const newPage = new Function("process", `${helper}\n${fnMatch[0]}\nreturn newPage;`)(fakeProcess);
  return { newPage, stderr };
}

function liveBundle() {
  const r = patcher.applyPatch({ log: () => {} });
  assert.strictEqual(r.patched, true, `patch not in effect: ${r.reason}`);
  return { file: r.file, src: fs.readFileSync(r.file, "utf8") };
}

for (const [label, source] of [["a fresh patch", () => patcher.patchSource(SHAPE)], ["the live bundle", () => liveBundle().src]]) {
  test(`A1: ${label}'s patched newPage() opens the tab with background:true and never calls newPage()`, async () => {
    const { newPage } = compilePatched(source());
    const { context, calls } = fakeContext({ bystander: true });
    const page = await newPage(context, {});
    assert.deepStrictEqual(calls.createTarget, [{ url: "about:blank", background: true }]);
    assert.strictEqual(calls.newPage, 0, "the activating browserContext.newPage() must not run");
    assert.strictEqual(page.targetId, "T1", "must return the page for ITS target, not a bystander tab");
    assert.deepStrictEqual(calls.closeTarget, []);
  });
}

test("A1: the live bundle carries exactly this script's helper", () => {
  const { src } = liveBundle();
  assert.strictEqual(src.slice(src.indexOf(patcher.MARKER)), `${patcher.MARKER}\n${patcher.HELPER_SOURCE}\n`);
});

test("A1: the helper falls back to newPage() off macOS, when createTarget fails, and when the page never attaches (closing that target)", async () => {
  const src = liveBundle().src;
  {
    const { newPage } = compilePatched(src, "linux");
    const { context, calls } = fakeContext();
    await newPage(context, {});
    assert.deepStrictEqual([calls.createTarget.length, calls.newPage], [0, 1]);
  }
  {
    const { newPage, stderr } = compilePatched(src);
    const { context, calls } = fakeContext({ createFails: true });
    const p = await newPage(context, {});
    assert.deepStrictEqual([calls.newPage, calls.closeTarget.length, p.targetId], [1, 0, "activating"]);
    assert.match(stderr.join(""), /background session page failed \(createTarget refused\)/);
  }
  {
    // The helper itself, so the attach timeout can be short.
    const helper = new Function("process", `${patcher.HELPER_SOURCE}\nreturn ${patcher.HELPER_NAME};`)({ platform: "darwin", stderr: { write() {} } });
    const { context, calls } = fakeContext({ attach: false });
    const p = await helper(context, 200);
    assert.deepStrictEqual(calls.closeTarget, ["T1"], "an orphan background target must be closed");
    assert.deepStrictEqual([calls.newPage, p.targetId], [1, "activating"]);
    assert.ok(calls.detached >= 1, "the browser CDP session must be detached");
  }
});

test("A1: the live upstream bundle has no activating newPage() left at either session-page site after applyPatch", () => {
  const { file, src } = liveBundle();
  assert.ok(src.includes(patcher.MARKER));
  assert.strictEqual((src.match(patcher.MATCH_NEW_PAGE_FN) || []).length, 0, "createToolSessionContext's newPage() is unpatched");
  assert.strictEqual((src.match(patcher.MATCH_ENSURE_PAGE) || []).length, 0, "ensureSessionPageOpen's newPage() is unpatched");
  assert.ok(src.includes(`this._page=await ${patcher.HELPER_NAME}(this.browserContext)`));
  // An upgrade that adds another page-opening call must fail here, not pass
  // silently: outside the helper's own fallback, no .newPage( anywhere in dist/.
  const dist = path.dirname(file);
  const sites = [];
  for (const f of fs.readdirSync(dist)) {
    if (!f.endsWith(".js")) continue;
    const n = rawNewPageCalls(fs.readFileSync(path.join(dist, f), "utf8"));
    if (n) sites.push(`${f}:${n}`);
  }
  assert.deepStrictEqual(sites, [], `unexpected activating newPage() call sites: ${sites.join(", ")}`);
});

test("A1: index.js applies the quiet-page patch to the bundle it spawns, before spawning", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
  const fnStart = src.indexOf("async function spawnUpstream()");
  const patchIdx = src.indexOf('require("../scripts/patch-bdmcp-quiet-page.js")', fnStart);
  const spawnIdx = src.indexOf("spawning upstream child", fnStart);
  assert.ok(fnStart !== -1 && patchIdx !== -1, "spawnUpstream must require the A1 patch");
  assert.ok(patchIdx < spawnIdx, "the patch must run before the spawn");
  assert.match(src.slice(patchIdx, spawnIdx), /applyPatch\(\{\s*distDir:\s*bdmcpDist\s*\}\)/);
});
