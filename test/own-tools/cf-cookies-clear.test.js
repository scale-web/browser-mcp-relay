// cf-cookies-clear.test.js — cf_cookies_clear (spec v8 §5.6 (9)) against a
// fixture jar: a not-listed site loses EVERY cookie of its registrable domain
// (partitioned included) and the challenge host's partition under it; a listed
// site loses only the three Cloudflare names and that partition; other sites
// are untouched; no value is ever returned. Partitioned deletes in a real
// Brave (§10 #24): test/isolated-plainflags.test.js.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tool = require("../../src/own-tools/cf-cookies-clear.js");
const { createSigninLoader } = require("../../src/plainflags-signin.js");
const jarLib = require("../../src/cdp-cookies.js");

const V = "SECRET-VALUE-";
const pk = (site) => ({ topLevelSite: `https://${site}`, hasCrossSiteAncestor: false });
const JAR = () => [
  { name: "cf_clearance", value: V + 1, domain: ".canva.com", path: "/", partitionKey: pk("canva.com") },
  { name: "cf_clearance", value: V + 2, domain: ".canva.com", path: "/" },
  { name: "__cf_bm", value: V + 3, domain: ".canva.com", path: "/" },
  { name: "CS", value: V + 4, domain: "www.canva.com", path: "/" },
  { name: "__cf_bm", value: V + 5, domain: "challenges.cloudflare.com", path: "/", partitionKey: pk("canva.com") },
  { name: "__cf_bm", value: V + 6, domain: "challenges.cloudflare.com", path: "/", partitionKey: pk("other.example") },
  { name: "keep", value: V + 7, domain: ".other.example", path: "/" },
  { name: "evil", value: V + 8, domain: ".notcanva.com", path: "/" },
];

function setup(listed) {
  let jar = JAR();
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-cfclear-")), "plainflags-signin.json");
  fs.writeFileSync(p, JSON.stringify({ accounts: listed }));
  const deletes = [];
  tool._resetDeps();
  tool._setDeps({
    signin: createSigninLoader({ path: p, log: () => {} }),
    sendBrowser: () => async (m) => { assert.strictEqual(m, "Storage.getCookies"); return { cookies: jar.map((c) => ({ ...c })) }; },
    pageSession: async () => ({
      send: async (m, prm) => {
        assert.strictEqual(m, "Network.deleteCookies");
        deletes.push(prm);
        jar = jar.filter((c) => !(c.name === prm.name && c.domain === prm.domain && jarLib.partitionSite(c.partitionKey) === jarLib.partitionSite(prm.partitionKey)));
      },
      close: async () => {},
    }),
  });
  globalThis.__relayBridge = { context: {}, wsEndpoint: "ws://fixture" };
  return { getJar: () => jar, deletes };
}

test.after(() => { globalThis.__relayBridge = null; tool._resetDeps(); });

test("a site with NO listed account: every cookie of the registrable domain (partitioned too) + the challenge partition under it; others untouched", async () => {
  const { getJar, deletes } = setup([]);
  const r = await tool.handler({ origin: "https://www.canva.com" });
  assert.ok(!r.isError, r.content[0].text);
  const out = JSON.parse(r.content[0].text);
  assert.strictEqual(out.site, "canva.com");
  assert.match(out.scope, /^all/);
  assert.strictEqual(out.deleted, 5);
  assert.deepStrictEqual(getJar().map((c) => `${c.name}@${c.domain}`).sort(), ["__cf_bm@challenges.cloudflare.com", "evil@.notcanva.com", "keep@.other.example"]);
  assert.ok(deletes.some((d) => d.partitionKey && d.partitionKey.topLevelSite === "https://canva.com"), "partitioned copies are deleted WITH their key");
  assert.deepStrictEqual(out.remaining, []);
  assert.ok(!r.content[0].text.includes(V), "never a value");
});

test("a site whose account IS listed: only cf_clearance / __cf_bm / _cfuvid (partitioned or not) and the challenge partition — the session cookie survives", async () => {
  const { getJar } = setup([{ name: "canva", askId: "as-ops/ask-test" }]);
  const r = await tool.handler({ origin: "https://www.canva.com" });
  const out = JSON.parse(r.content[0].text);
  assert.match(out.scope, /cloudflare-only \(listed account: canva\)/);
  assert.strictEqual(out.deleted, 4);
  assert.deepStrictEqual(getJar().map((c) => c.name).sort(), ["CS", "__cf_bm", "evil", "keep"]);
  assert.ok(getJar().some((c) => c.name === "CS"), "the account's session survives");
});

test("refusals: no origin, a non-http origin, no sign-in loader configured", async () => {
  setup([]);
  assert.strictEqual((await tool.handler({})).isError, true);
  assert.strictEqual((await tool.handler({ origin: "file:///etc" })).isError, true);
  tool._resetDeps();
  assert.match((await tool.handler({ origin: "https://www.canva.com" })).content[0].text, /not configured/);
});

test("registrableDomain heuristic", () => {
  const rd = tool.registrableDomain;
  assert.strictEqual(rd("www.canva.com"), "canva.com");
  assert.strictEqual(rd("a.b.example.co.uk"), "example.co.uk");
  assert.strictEqual(rd("shop.example.com.au"), "example.com.au");
  assert.strictEqual(rd("canva.com"), "canva.com");
  assert.strictEqual(rd("127.0.0.1"), "127.0.0.1");
  assert.strictEqual(rd("go.revivemyhair.com."), "revivemyhair.com");
});
