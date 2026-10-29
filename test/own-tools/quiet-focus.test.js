const test = require("node:test");
const assert = require("node:assert");
const quiet = require("../../src/own-tools/_quiet-focus.js");

// Real `lsappinfo list` shape (macOS 14): entry head line, then indented keys.
const LIST = [
  ' 1) "loginwindow" ASN:0x0-2002: ',
  '    bundleID="com.apple.loginwindow"',
  '    bundle path="/System/Library/CoreServices/loginwindow.app"',
  ' 2) "Brave Browser" ASN:0x0-200200: ',
  '    bundleID="com.brave.Browser"',
  ' 3) "Google Chrome" ASN:0x0-20020: ',
  '    bundleID="com.google.Chrome"',
  "",
].join("\n");

test("bundleOfAsn: finds the entry by its exact ASN (not a prefix of a longer one)", () => {
  assert.strictEqual(quiet._bundleOfAsn("ASN:0x0-20020:", LIST), "com.google.Chrome");
  assert.strictEqual(quiet._bundleOfAsn("ASN:0x0-200200:", LIST), "com.brave.Browser");
  assert.strictEqual(quiet._bundleOfAsn("ASN:0x0-2002:", LIST), "com.apple.loginwindow");
  assert.strictEqual(quiet._bundleOfAsn("ASN:0x0-9:", LIST), null);
  assert.strictEqual(quiet._bundleOfAsn("", LIST), null);
  assert.strictEqual(quiet._bundleOfAsn("ASN:0x0-2002:", null), null);
});

function withPlatform(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...desc, value });
  return Promise.resolve().then(fn).finally(() => Object.defineProperty(process, "platform", desc));
}

test("braveIsFront: off macOS it is true (behave as before)", async () => {
  await withPlatform("linux", async () => assert.strictEqual(await quiet.braveIsFront(), true));
});

test("braveIsFront: true only when the front app is a Brave; unknown is false", async () => {
  const orig = quiet._run;
  const answer = (front) => async (cmd, args) => (args[0] === "front" ? front : LIST);
  try {
    await withPlatform("darwin", async () => {
      quiet._run = answer("ASN:0x0-200200:\n");
      assert.strictEqual(await quiet.braveIsFront(), true);
      quiet._run = answer("ASN:0x0-20020:\n");
      assert.strictEqual(await quiet.braveIsFront(), false);
      quiet._run = async () => null; // lsappinfo failed
      assert.strictEqual(await quiet.braveIsFront(), false);
    });
  } finally { quiet._run = orig; }
});

function stubFront(value) {
  const orig = quiet.braveIsFront;
  quiet.braveIsFront = async () => value;
  return () => { quiet.braveIsFront = orig; };
}

test("raiseIfFront: raises only when Brave is already in front", async () => {
  let calls = 0;
  const page = { async bringToFront() { calls++; } };
  let restore = stubFront(false);
  try { assert.strictEqual(await quiet.raiseIfFront(page), false); } finally { restore(); }
  assert.strictEqual(calls, 0);
  restore = stubFront(true);
  try { assert.strictEqual(await quiet.raiseIfFront(page), true); } finally { restore(); }
  assert.strictEqual(calls, 1);
});

// A fake context whose pages answer Target.getTargetInfo with their targetId.
function fakeContext(pages) {
  let newPageCalls = 0;
  return {
    pages: () => pages,
    newPage: async () => { newPageCalls++; const p = fakePage("NEWPAGE"); pages.push(p); return p; },
    newCDPSession: async (p) => ({ send: async () => ({ targetInfo: { targetId: p.targetId } }), detach: async () => {} }),
    get newPageCalls() { return newPageCalls; },
  };
}
function fakePage(targetId) { return { targetId, isClosed: () => false }; }

function stubCdp(impl) {
  const orig = quiet._cdpCall;
  const calls = [];
  quiet._cdpCall = async (ws, method, params) => { calls.push({ ws, method, params }); return impl(method, params); };
  return { calls, restore: () => { quiet._cdpCall = orig; } };
}

test("newQuietPage: opens a BACKGROUND tab over CDP and returns its Page (no newPage)", async () => {
  await withPlatform("darwin", async () => {
    const pages = [fakePage("OLD")];
    const ctx = fakeContext(pages);
    const cdp = stubCdp((method) => {
      if (method === "Target.createTarget") { setTimeout(() => pages.push(fakePage("T1")), 30); return { targetId: "T1" }; }
      return {};
    });
    try {
      const p = await quiet.newQuietPage({ context: ctx, wsEndpoint: "ws://127.0.0.1:1/devtools/browser/x" });
      assert.strictEqual(p.targetId, "T1");
      assert.strictEqual(ctx.newPageCalls, 0);
      assert.deepStrictEqual(cdp.calls[0], {
        ws: "ws://127.0.0.1:1/devtools/browser/x",
        method: "Target.createTarget",
        params: { url: "about:blank", background: true },
      });
    } finally { cdp.restore(); }
  });
});

test("newQuietPage: if the page never shows up, closes that target and falls back to newPage", async () => {
  await withPlatform("darwin", async () => {
    const ctx = fakeContext([fakePage("OLD")]);
    const cdp = stubCdp((method) => (method === "Target.createTarget" ? { targetId: "GHOST" } : {}));
    try {
      const p = await quiet.newQuietPage({ context: ctx, wsEndpoint: "ws://127.0.0.1:1/x" }, { timeoutMs: 200 });
      assert.strictEqual(p.targetId, "NEWPAGE");
      assert.strictEqual(ctx.newPageCalls, 1);
      assert.deepStrictEqual(cdp.calls[1], { ws: "ws://127.0.0.1:1/x", method: "Target.closeTarget", params: { targetId: "GHOST" } });
    } finally { cdp.restore(); }
  });
});

test("newQuietPage: a failed createTarget falls back to newPage (nothing to close)", async () => {
  await withPlatform("darwin", async () => {
    const ctx = fakeContext([]);
    const cdp = stubCdp(() => { throw new Error("boom"); });
    try {
      const p = await quiet.newQuietPage({ context: ctx, wsEndpoint: "ws://127.0.0.1:1/x" });
      assert.strictEqual(p.targetId, "NEWPAGE");
      assert.strictEqual(cdp.calls.length, 1);
    } finally { cdp.restore(); }
  });
});

test("newQuietPage: no CDP endpoint, or off macOS → plain newPage", async () => {
  const cdp = stubCdp(() => { throw new Error("must not be called"); });
  try {
    await withPlatform("darwin", async () => {
      const ctx = fakeContext([]);
      await quiet.newQuietPage({ context: ctx });
      assert.strictEqual(ctx.newPageCalls, 1);
    });
    await withPlatform("linux", async () => {
      const ctx = fakeContext([]);
      await quiet.newQuietPage({ context: ctx, wsEndpoint: "ws://127.0.0.1:1/x" });
      assert.strictEqual(ctx.newPageCalls, 1);
    });
    assert.strictEqual(cdp.calls.length, 0);
  } finally { cdp.restore(); }
});
