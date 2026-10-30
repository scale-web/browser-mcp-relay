// challenge-classify.test.js — the pure half of challenge_detect (spec v8 §2, §5.2).
// Fixtures are header/DOM/DNS sets for each §2 owner row, in table order.

const test = require("node:test");
const assert = require("node:assert");
const c = require("../src/challenge-classify.js");

const NO_DNS = { cnames: [], as: [] };

function owner(host, { headers = {}, status = 200, dns = NO_DNS, kind = "none" } = {}) {
  return c.classifyOwner({ host, headers, status, dns, kind, pageHost: host }).owner;
}

// ── §2 rows, each one ───────────────────────────────────────────────────────

test("row 1: x-ghl-serve-region → highlevel", () => {
  assert.strictEqual(owner("go.thebnbempire.com", { headers: { "x-ghl-serve-region": "us-central1", "cf-ray": "x" } }), "highlevel");
});

test("row 1: CNAME sites.ludicrous.cloud → highlevel (dig trailing dot dropped)", () => {
  const dns = c.parseDig("sites.ludicrous.cloud.\n");
  assert.strictEqual(owner("bnbempirehq.com", { dns }), "highlevel");
});

test("row 1: A 162.159.140.166 → highlevel", () => {
  assert.strictEqual(owner("regrowconsultations.com", { dns: c.parseDig("162.159.140.166\n") }), "highlevel");
});

test("row 1 beats row 5: go.revivemyhair.com (agency zone, HighLevel-served) → highlevel, not agency", () => {
  const dns = c.parseDig("sites.ludicrous.cloud.\n162.159.140.166\n");
  assert.strictEqual(owner("go.revivemyhair.com", { headers: { "x-ghl-serve-region": "us", "cf-ray": "abc-DFW" }, dns }), "highlevel");
  // and the same host with no HighLevel signal at all would be the agency row
  assert.strictEqual(owner("go.revivemyhair.com"), "agency");
});

test("aloeheath.com (agency nameservers, NOT an agency zone) → highlevel", () => {
  assert.strictEqual(owner("aloeheath.com", { dns: c.parseDig("162.159.140.166\n"), headers: { "cf-ray": "y" } }), "highlevel");
  // without the HighLevel signal it is a vendor host, never agency (excluded on purpose)
  assert.strictEqual(owner("aloeheath.com", { headers: { "cf-ray": "y" } }), "vendor");
});

test("row 2: powered-by: Shopify → shopify", () => {
  assert.strictEqual(owner("alaunderscrubs.com", { headers: { "powered-by": "Shopify", "cf-ray": "z" } }), "shopify");
});

test("row 2: shopify-complexity-score → shopify", () => {
  assert.strictEqual(owner("tastygains.com", { headers: { "shopify-complexity-score": "0" } }), "shopify");
});

test("row 2: A 23.227.38.x → shopify", () => {
  assert.strictEqual(owner("aloestrips.com", { dns: c.parseDig("23.227.38.65\n") }), "shopify");
});

test("row 2: CNAME shops.myshopify.com → shopify", () => {
  assert.strictEqual(owner("shop.example.com", { dns: c.parseDig("shops.myshopify.com.\n23.227.38.32\n") }), "shopify");
});

test("row 3: curl's own 302 to Access is NOT the owner — a signed-in browser has the session curl lacks (r1 #1)", () => {
  const head = c.parseCurlHead("HTTP/2 302\r\nlocation: https://scale.cloudflareaccess.com/cdn-cgi/access/login/x?kid=abc&redirect_url=%2F\r\ncf-ray: 1\r\n");
  assert.strictEqual(head.headers.location, "scale.cloudflareaccess.com", "location is reduced to its host");
  assert.strictEqual(c.classifyOwner({ host: "ala-b2b.scale-265.workers.dev", pageHost: "ala-b2b.scale-265.workers.dev", headers: head.headers, status: head.status, dns: NO_DNS }).owner, "workersdev");
});

test("row 3: a page already on the Access login host → access", () => {
  assert.strictEqual(c.classifyOwner({ host: "scale.cloudflareaccess.com", pageHost: "scale.cloudflareaccess.com", headers: {}, dns: NO_DNS }).owner, "access");
});

test("row 3 needs the 302: a 200 whose location names Access is not row 3", () => {
  assert.strictEqual(owner("x.example.com", { status: 200, headers: { location: "a.cloudflareaccess.com" } }), "none");
});

test("row 4 beats row 5: the test host → agency-test, route expected", () => {
  assert.strictEqual(owner("cf-test.automatedscalinghq.com", { headers: { "cf-mitigated": "challenge", "cf-ray": "q" }, kind: "interstitial" }), "agency-test");
  assert.strictEqual(c.OWNER_ROUTE["agency-test"], "expected");
});

test("row 5: each of the 8 agency zones (apex and subdomain) → agency", () => {
  assert.strictEqual(c.AGENCY_ZONES.length, 8);
  for (const z of c.AGENCY_ZONES) {
    assert.strictEqual(owner(z, { headers: { "cf-ray": "r" } }), "agency", z);
    assert.strictEqual(owner("www." + z), "agency", "www." + z);
  }
  // a look-alike is not the zone
  assert.strictEqual(owner("notrevivemyhair.com", { headers: { "cf-ray": "r" } }), "vendor");
  assert.strictEqual(owner("revivemyhair.com.evil.example", { headers: { "cf-ray": "r" } }), "vendor");
});

test("row 6: *.scale-265.workers.dev → workersdev, route report", () => {
  assert.strictEqual(owner("ala-b2b.scale-265.workers.dev", { headers: { "cf-ray": "w" }, kind: "interstitial" }), "workersdev");
  assert.strictEqual(c.OWNER_ROUTE.workersdev, "report");
  // another account's workers.dev is a vendor host
  assert.strictEqual(owner("x.someone-else.workers.dev", { headers: { "cf-ray": "w" } }), "vendor");
});

test("row 7: anything else with cf-ray → vendor", () => {
  assert.strictEqual(owner("www.canva.com", { headers: { "cf-ray": "abc", server: "cloudflare" } }), "vendor");
});

test("row 7: a Turnstile widget seen in the page with no cf-ray (header read failed) → vendor", () => {
  assert.strictEqual(owner("forms.example.org", { kind: "turnstile" }), "vendor");
});

test("negative: a plain 200 with no Cloudflare signal → owner none, kind none", () => {
  const head = c.parseCurlHead("HTTP/1.1 200 OK\r\nserver: nginx\r\ncontent-type: text/html\r\n");
  assert.strictEqual(c.classifyOwner({ host: "example.org", headers: head.headers, status: head.status, dns: c.parseDig("93.184.215.14\n") }).owner, "none");
  assert.strictEqual(c.classifyKind({ frames: [{ isTop: true, title: "Example Domain" }], status: 200, headers: head.headers }), "none");
});

test("first match wins: HighLevel + Shopify signals together → highlevel (row 1 is above row 2)", () => {
  assert.strictEqual(owner("x.example.com", { headers: { "x-ghl-serve-region": "us", "powered-by": "Shopify" } }), "highlevel");
});

test("owner names are exactly the cf-challenge skill's", () => {
  assert.deepStrictEqual([...c.OWNERS], ["highlevel", "shopify", "access", "agency-test", "agency", "workersdev", "vendor", "none"]);
});

// ── kind ────────────────────────────────────────────────────────────────────

test("kind: browser evidence only — curl's cf-mitigated / 403 / 429 never make a kind (r1 #1)", () => {
  const frames = [{ isTop: true, title: "Welcome" }];
  assert.strictEqual(c.classifyKind({ frames, headers: { "cf-mitigated": "challenge" }, status: 403 }), "none");
  assert.strictEqual(c.classifyKind({ frames, status: 429 }), "none");
  assert.strictEqual(c.classifyKind({ frames: [{ isTop: true, chlOpt: true }] }), "interstitial");
});

test("kind: title 'Just a moment…' → interstitial", () => {
  assert.strictEqual(c.classifyKind({ frames: [{ isTop: true, title: "Just a moment..." }] }), "interstitial");
});

test("kind: Turnstile markers only in a cross-origin CHILD frame → turnstile", () => {
  const frames = [
    { isTop: true, host: "go.example.com", title: "Book now", turnstileInputs: [], challengeIframes: 0 },
    { isTop: false, host: "api.leadconnectorhq.com", turnstileInputs: [0], challengeIframes: 0 },
  ];
  assert.strictEqual(c.classifyKind({ frames }), "turnstile");
});

test("kind: a challenges.cloudflare.com frame alone → turnstile", () => {
  assert.strictEqual(c.classifyKind({ frames: [{ isTop: true }, { host: "challenges.cloudflare.com", challengeFrame: true }] }), "turnstile");
});

test("kind: the page's own 429 → ratelimit; the challenge-platform script alone is not a wall", () => {
  assert.strictEqual(c.classifyKind({ frames: [{ isTop: true }], navStatus: 429 }), "ratelimit");
  assert.strictEqual(c.classifyKind({ frames: [{ isTop: true, challengePlatform: true }], navStatus: 200 }), "none");
});

test("parseCurlHead keeps only the skill's header list — never set-cookie", () => {
  const h = c.parseCurlHead("HTTP/2 403\r\nset-cookie: __cf_bm=SECRETVALUE; path=/\r\ncf-mitigated: challenge\r\ncf-ray: 8a-DFW\r\nx-shopify-stage: production\r\n");
  assert.strictEqual(h.status, 403);
  assert.deepStrictEqual(Object.keys(h.headers).sort(), ["cf-mitigated", "cf-ray", "x-shopify-stage"]);
  assert.ok(!JSON.stringify(h).includes("SECRETVALUE"));
});

// ── plainflagsEligible / route ──────────────────────────────────────────────

test("phase 1c: PLAINFLAGS_BUILT is on; the not-built branch (built: false) still gives not-built for EVERY owner and kind", () => {
  assert.strictEqual(c.PLAINFLAGS_BUILT, true, "phase 1c builds the plain-flags profile (D22 passed 2026-10-30)");
  for (const o of c.OWNERS) {
    for (const k of c.KINDS) {
      const r = c.decideRoute({ owner: o, kind: k, url: "https://x.example.com/", built: false });
      assert.strictEqual(r.plainflagsEligible, false, `${o}/${k}`);
      assert.strictEqual(r.reason, "not-built", `${o}/${k}`);
      assert.ok(!/switch|plainflags-try/.test(r.route), `${o}/${k} → ${r.route}`);
      assert.strictEqual(r.clickBudget, 0);
      assert.strictEqual(r.route, c.baseRoute(o, k));
    }
  }
});

test("mode built: HighLevel turnstile → default relay keeps the BASE route + switchTo (round 1 item 4) / plainflags-try (plain-flags)", () => {
  const d = c.decideRoute({ owner: "highlevel", kind: "turnstile", url: "https://go.example.com/form", built: true, mode: "default" });
  assert.deepStrictEqual([d.plainflagsEligible, d.reason, d.route, d.clickBudget, d.switchTo, d.plainflagsServer],
    [true, "eligible", "in-page-turnstile", 0, "browser-mcp-relay-plainflags", "available-if-registered"]);
  assert.ok(!("fallbackRoute" in d));
  const p = c.decideRoute({ owner: "highlevel", kind: "turnstile", url: "https://go.example.com/form", built: true, mode: "plainflags", clickSpent: false });
  assert.deepStrictEqual([p.plainflagsEligible, p.route, p.clickBudget], [true, "plainflags-try", 1]);
  // no click count wired (the default) → no click budget
  const q = c.decideRoute({ owner: "highlevel", kind: "turnstile", url: "https://go.example.com/form", built: true, mode: "plainflags" });
  assert.strictEqual(q.clickBudget, 0);
});

test("mode built: a Shopify 429 and a Shopify managed challenge → neither, owner-route", () => {
  for (const kind of ["ratelimit", "interstitial"]) {
    const r = c.decideRoute({ owner: "shopify", kind, url: "https://alaunderscrubs.com/cart", built: true, mode: "plainflags", clickSpent: false });
    assert.deepStrictEqual([r.plainflagsEligible, r.reason, r.route], [false, "owner-route", "§3.2"], kind);
  }
});

test("mode built: agency, agency-test, workersdev, access → owner-route", () => {
  for (const o of ["agency", "agency-test", "workersdev", "access"]) {
    assert.strictEqual(c.decideRoute({ owner: o, kind: "interstitial", url: "https://x/", built: true }).reason, "owner-route", o);
  }
});

test("mode built: vendor with no wall → kind", () => {
  assert.strictEqual(c.decideRoute({ owner: "vendor", kind: "none", url: "https://x.example/", built: true }).reason, "kind");
});

test("mode built: known-account login not on the sign-in list → signin-not-listed (host matcher and host+path matcher)", () => {
  const host = c.decideRoute({ owner: "vendor", kind: "interstitial", url: "https://auth.hostinger.com/login", built: true });
  assert.deepStrictEqual([host.plainflagsEligible, host.reason, host.signinAccount], [false, "signin-not-listed", "hostinger"]);
  const pathM = c.decideRoute({ owner: "vendor", kind: "interstitial", url: "https://www.canva.com/login/?redirect=x", built: true });
  assert.deepStrictEqual([pathM.plainflagsEligible, pathM.reason], [false, "signin-not-listed"]);
  // the same host's public path is not refused
  const pub = c.decideRoute({ owner: "vendor", kind: "interstitial", url: "https://www.canva.com/templates/", built: true });
  assert.deepStrictEqual([pub.plainflagsEligible, pub.reason], [true, "eligible"]);
  // listed → eligible
  const listed = c.decideRoute({ owner: "vendor", kind: "interstitial", url: "https://www.canva.com/login", built: true, signinNames: new Set(["canva"]) });
  assert.deepStrictEqual([listed.plainflagsEligible, listed.reason], [true, "eligible"]);
  const listedHost = c.decideRoute({ owner: "vendor", kind: "interstitial", url: "https://auth.hostinger.com/", built: true, signinNames: new Set(["hostinger"]) });
  assert.strictEqual(listedHost.plainflagsEligible, true);
});

// ── cfCookies ───────────────────────────────────────────────────────────────

const ORIGIN = "https://www.canva.com";

test("cfCookies: empty jar → none", () => {
  assert.strictEqual(c.cfCookieState(ORIGIN, []).cfCookies, "none");
});

test("cfCookies: another site's cf_clearance and a non-CF cookie → none", () => {
  const jar = [
    { name: "cf_clearance", value: "V1", domain: ".shopify.com", path: "/" },
    { name: "session", value: "V2", domain: ".canva.com", path: "/" },
  ];
  assert.strictEqual(c.cfCookieState(ORIGIN, jar).cfCookies, "none");
});

test("cfCookies: an unpartitioned __cf_bm for the site → present", () => {
  assert.strictEqual(c.cfCookieState(ORIGIN, [{ name: "__cf_bm", value: "V", domain: ".canva.com", path: "/" }]).cfCookies, "present");
});

test("cfCookies: a cf_clearance with a CHIPS partitionKey (object form) → partitioned", () => {
  const jar = [{ name: "cf_clearance", value: "V", domain: ".canva.com", path: "/", partitionKey: { topLevelSite: "https://canva.com", hasCrossSiteAncestor: false } }];
  const r = c.cfCookieState(ORIGIN, jar);
  assert.strictEqual(r.cfCookies, "partitioned");
  assert.strictEqual(r.cookies[0].partitionKey, "https://canva.com");
});

test("cfCookies: a cf_clearance with a string partitionKey (older CDP) → partitioned", () => {
  assert.strictEqual(c.cfCookieState(ORIGIN, [{ name: "cf_clearance", value: "V", domain: "www.canva.com", partitionKey: "https://canva.com" }]).cfCookies, "partitioned");
});

test("cfCookies: a challenge-host cookie partitioned under the site → partitioned; under another site → ignored", () => {
  const under = [{ name: "__cf_bm", value: "V", domain: "challenges.cloudflare.com", partitionKey: { topLevelSite: "https://canva.com" } }];
  assert.strictEqual(c.cfCookieState(ORIGIN, under).cfCookies, "partitioned");
  const other = [{ name: "__cf_bm", value: "V", domain: "challenges.cloudflare.com", partitionKey: { topLevelSite: "https://example.org" } }];
  assert.strictEqual(c.cfCookieState(ORIGIN, other).cfCookies, "none");
  const unpart = [{ name: "__cf_bm", value: "V", domain: ".challenges.cloudflare.com" }];
  assert.strictEqual(c.cfCookieState(ORIGIN, unpart).cfCookies, "none");
});

test("never values: describeCookie output has no value field and no value text", () => {
  const jar = [
    { name: "cf_clearance", value: "TOPSECRET-CLEARANCE", domain: ".canva.com", path: "/", httpOnly: true, secure: true, sameSite: "None", partitionKey: { topLevelSite: "https://canva.com" }, size: 99, priority: "Medium" },
    { name: "_cfuvid", value: "TOPSECRET-UVID", domain: ".canva.com", path: "/" },
  ];
  const r = c.cfCookieState(ORIGIN, jar);
  const s = JSON.stringify(r);
  assert.ok(!s.includes("TOPSECRET"), s);
  for (const k of r.cookies) {
    assert.deepStrictEqual(Object.keys(k).sort(), ["domain", "httpOnly", "name", "partitionKey", "path", "sameSite", "secure", "session"]);
  }
});

// ── outcome ─────────────────────────────────────────────────────────────────

test("tryOutcome: filled token → passed; empty token or interstitial → failed; nothing left → passed", () => {
  assert.strictEqual(c.tryOutcome("turnstile", [{ turnstileInputs: [612] }]), "passed");
  assert.strictEqual(c.tryOutcome("turnstile", [{ turnstileInputs: [0] }, { turnstileInputs: [612] }]), "failed", "one unsolved widget left");
  assert.strictEqual(c.tryOutcome("turnstile", [{ turnstileInputs: [0] }]), "failed");
  assert.strictEqual(c.tryOutcome("interstitial", []), "failed");
  assert.strictEqual(c.tryOutcome("none", []), "passed");
});

// ── review r1 fixes ─────────────────────────────────────────────────────────

test("baseRoute: no wall → none for every owner except Access (r1 #4); Turnstile → the in-page branch (r1 #2)", () => {
  for (const o of c.OWNERS) assert.strictEqual(c.baseRoute(o, "none"), o === "access" ? "§3.3" : "none", o);
  assert.strictEqual(c.baseRoute("shopify", "ratelimit"), "§3.2");
  assert.strictEqual(c.baseRoute("agency", "interstitial"), "§3.3");
  assert.strictEqual(c.baseRoute("agency", "turnstile"), "in-page-turnstile");
  assert.strictEqual(c.baseRoute("highlevel", "turnstile"), "in-page-turnstile");
  assert.strictEqual(c.baseRoute("agency-test", "turnstile"), "expected");
  assert.strictEqual(c.baseRoute("none", "ratelimit"), "none");
});

test("turnstileGuidance: the three ways on (page-verify / backend via API / human step)", () => {
  const g = c.turnstileGuidance("highlevel");
  assert.strictEqual(g.length, 3);
  assert.match(g[0], /no submission needed/);
  assert.match(g[1], /API/);
  assert.match(g[2], /human step/);
  assert.strictEqual(c.turnstileGuidance("vendor").length, 3);
});

test("widgetFrameHost: markers only in a child frame → that frame's host; in the top document → null", () => {
  const top = { isTop: true, host: "www.revivemyhair.com", turnstileInputs: [] };
  assert.strictEqual(c.widgetFrameHost([top, { host: "api.leadconnectorhq.com", turnstileInputs: [0] }]), "api.leadconnectorhq.com");
  assert.strictEqual(c.widgetFrameHost([{ ...top, turnstileInputs: [0] }, { host: "forms.vendor.example", turnstileInputs: [0] }]), null, "top marked, non-GHL child → the page");
  assert.strictEqual(c.widgetFrameHost([{ ...top, turnstileInputs: [0] }, { host: "api.leadconnectorhq.com", turnstileInputs: [0] }]), "api.leadconnectorhq.com", "r2 #2: a GHL frame wins even when the top is marked");
  // only the challenge frame is visible: its parent decides
  assert.strictEqual(c.widgetFrameHost([top, { host: "challenges.cloudflare.com", challengeFrame: true, parentHost: "api.leadconnectorhq.com" }]), "api.leadconnectorhq.com");
  assert.strictEqual(c.widgetFrameHost([top, { host: "challenges.cloudflare.com", challengeFrame: true, parentHost: "www.revivemyhair.com" }]), null);
});

test("owner from the widget's frame: a GHL form on an agency site → highlevel, never agency (r1 #2)", () => {
  const r = c.classifyOwner({ host: "www.revivemyhair.com", pageHost: "www.revivemyhair.com", headers: { "cf-ray": "x" }, kind: "turnstile", widgetHost: "api.leadconnectorhq.com" });
  assert.deepStrictEqual([r.owner, r.from], ["highlevel", "frame api.leadconnectorhq.com"]);
  // on a site off Cloudflare as well
  assert.strictEqual(c.classifyOwner({ host: "client.example", kind: "turnstile", widgetHost: "link.msgsndr.com" }).owner, "highlevel");
  // another vendor's widget frame on an agency site: rows 5/6 are not read off the top host
  assert.strictEqual(c.classifyOwner({ host: "www.revivemyhair.com", kind: "turnstile", widgetHost: "forms.vendor.example" }).owner, "vendor");
  assert.strictEqual(c.classifyOwner({ host: "x.scale-265.workers.dev", kind: "turnstile", widgetHost: "forms.vendor.example" }).owner, "vendor");
});

test("isGhlWidgetHost: HighLevel's own domains only", () => {
  for (const h of ["api.leadconnectorhq.com", "widgets.leadconnectorhq.com", "link.msgsndr.com", "app.msgsndr.com"]) assert.ok(c.isGhlWidgetHost(h), h);
  for (const h of ["leadconnectorhq.com.evil.example", "notmsgsndr.com", "link.revivemyhair.com"]) assert.ok(!c.isGhlWidgetHost(h), h);
});

test("turnstilePassed: a filled token → passed; none or all empty → not", () => {
  assert.strictEqual(c.turnstilePassed([{ turnstileInputs: [512] }, { turnstileInputs: [9, 40] }]), true);
  assert.strictEqual(c.turnstilePassed([{ turnstileInputs: [0] }, { turnstileInputs: [512] }]), false, "r2 #3: every marked frame must be filled");
  assert.strictEqual(c.turnstilePassed([{ turnstileInputs: [512] }, { turnstileDivs: 1, turnstileInputs: [] }]), false, "a marked frame with no input is not proof of a pass");
  assert.strictEqual(c.turnstilePassed([{ turnstileInputs: [0] }]), false);
  assert.strictEqual(c.turnstilePassed([{ challengeFrame: true }]), false);
});

test("accessAppHost: the protected app from the Access login URL, else null (r1 #13)", () => {
  assert.strictEqual(c.accessAppHost("https://scale.cloudflareaccess.com/cdn-cgi/access/login/ala-b2b.scale-265.workers.dev?kid=a&redirect_url=%2F"), "ala-b2b.scale-265.workers.dev");
  assert.strictEqual(c.accessAppHost("https://scale.cloudflareaccess.com/"), null);
  assert.strictEqual(c.accessAppHost("https://scale.cloudflareaccess.com/cdn-cgi/access/login/not a host"), null);
  assert.strictEqual(c.accessAppHost("https://evil.example/cdn-cgi/access/login/x.example"), null);
});

// ── review r2 fixes ─────────────────────────────────────────────────────────

const GHL_DNS = { cnames: ["sites.ludicrous.cloud"], as: ["162.159.140.166"] };

test("r2 #1: a widget frame on a white-label host is HighLevel by its own DNS, not agency by the host list", () => {
  const r = c.classifyOwner({ host: "www.revivemyhair.com", kind: "turnstile", widgetHost: "go.revivemyhair.com", widgetDns: GHL_DNS });
  assert.deepStrictEqual([r.owner, r.row, r.from], ["highlevel", 1, "frame go.revivemyhair.com"]);
  assert.strictEqual(c.classifyOwner({ host: "www.revivemyhair.com", kind: "turnstile", widgetHost: "go.revivemyhair.com", widgetDns: { cnames: [], as: ["162.159.140.166"] } }).owner, "highlevel");
  assert.strictEqual(c.classifyOwner({ host: "x.example", kind: "turnstile", widgetHost: "shop.example", widgetDns: { cnames: ["shops.myshopify.com"], as: [] } }).owner, "shopify");
  assert.strictEqual(c.classifyOwner({ host: "x.example", kind: "turnstile", widgetHost: "shop.example", widgetDns: { cnames: [], as: ["23.227.38.1"] } }).owner, "shopify");
  // no DNS answer: the host lists still apply to the frame's own host
  assert.strictEqual(c.classifyOwner({ host: "www.revivemyhair.com", kind: "turnstile", widgetHost: "go.revivemyhair.com" }).owner, "agency");
});

test("r2 #2: frame order does not decide — a GHL (domain or DNS) frame with markers wins", () => {
  const top = { isTop: true, host: "www.walletreminder.com", turnstileInputs: [0] };
  assert.strictEqual(c.widgetFrameHost([top, { host: "api.leadconnectorhq.com", turnstileInputs: [0] }]), "api.leadconnectorhq.com");
  const sameFirst = [{ isTop: true, host: "www.walletreminder.com" }, { host: "www.walletreminder.com", turnstileInputs: [0] }, { host: "api.leadconnectorhq.com", turnstileInputs: [0] }];
  assert.strictEqual(c.widgetFrameHost(sameFirst), "api.leadconnectorhq.com");
  const vendorFirst = [{ isTop: true, host: "a.example" }, { host: "forms.vendor.example", turnstileInputs: [0] }, { host: "go.revivemyhair.com", turnstileInputs: [0] }];
  assert.strictEqual(c.widgetFrameHost(vendorFirst), "forms.vendor.example", "without DNS: first marked child");
  assert.strictEqual(c.widgetFrameHost(vendorFirst, { "go.revivemyhair.com": GHL_DNS }), "go.revivemyhair.com", "with DNS: the HighLevel frame");
});

test("r2 #7: a same-host marked child classifies as the page itself", () => {
  const frames = [{ isTop: true, host: "go.revivemyhair.com" }, { host: "go.revivemyhair.com", turnstileInputs: [0] }];
  assert.strictEqual(c.widgetFrameHost(frames), null);
  assert.deepStrictEqual(c.widgetCandidates(frames), []);
});

test("r2 #4: header values, header count and DNS answers are capped", () => {
  const many = Array.from({ length: 30 }, (_, i) => `x-shopify-h${i}: v`).join("\r\n");
  const h = c.parseCurlHead(`HTTP/2 200\r\nserver: ${"s".repeat(5000)}\r\n${many}\r\n`);
  assert.strictEqual(Object.keys(h.headers).length, c.MAX_HEADERS);
  assert.strictEqual(h.headers.server.length, c.MAX_HEADER_VALUE);
  const d = c.parseDig(Array.from({ length: 50 }, (_, i) => `10.0.0.${i}\nhost${i}.example.`).join("\n") + "\n" + "a".repeat(300) + ".example.");
  assert.strictEqual(d.as.length, c.MAX_ANSWERS);
  assert.strictEqual(d.cnames.length, c.MAX_ANSWERS);
  assert.ok(d.cnames.every((x) => x.length <= c.MAX_HOST_LEN));
});

test("r2 #5: an Access app host over 253 chars or with a label over 63 → null", () => {
  const base = "https://t.cloudflareaccess.com/cdn-cgi/access/login/";
  assert.strictEqual(c.accessAppHost(base + "a".repeat(63) + ".example"), "a".repeat(63) + ".example");
  assert.strictEqual(c.accessAppHost(base + "a".repeat(64) + ".example"), null);
  const long = Array.from({ length: 5 }, () => "b".repeat(50)).join(".") + ".example"; // 263 chars
  assert.ok(long.length > 253);
  assert.strictEqual(c.accessAppHost(base + long), null);
});

test("r2 #2: only a challenge frame visible, its parent a non-GHL frame → that parent (not the agency top host)", () => {
  const frames = [{ isTop: true, host: "www.walletreminder.com" }, { host: "forms.vendor.example" }, { host: "challenges.cloudflare.com", challengeFrame: true, parentHost: "forms.vendor.example" }];
  assert.strictEqual(c.widgetFrameHost(frames), "forms.vendor.example");
  assert.strictEqual(c.classifyOwner({ host: "www.walletreminder.com", kind: "turnstile", widgetHost: c.widgetFrameHost(frames) }).owner, "vendor");
});

test("r2 #4: a DNS answer longer than 253 chars is dropped", () => {
  const d = c.parseDig("a".repeat(300) + ".example.\n" + "ok.example.\n");
  assert.deepStrictEqual(d.cnames, ["ok.example"]);
});

// ── F1 (phase-1 accepted MEDIUM, fixed in 1c) ───────────────────────────────

test("F1: a visible challenge frame needs a marked, FILLED parent with enough filled tokens — a hidden second widget is a wall", () => {
  const top = { id: 0, isTop: true, host: "go.example.com" };
  const form = (inputs) => ({ id: 1, parentId: 0, host: "api.leadconnectorhq.com", turnstileInputs: inputs });
  const chl = (id, parentId = 1, extra = {}) => ({ id, parentId, challengeFrame: true, host: "challenges.cloudflare.com", ...extra });
  assert.strictEqual(c.turnstilePassed([top, form([700]), chl(2)]), true, "one widget, filled (the invisible-mode GHL case)");
  assert.strictEqual(c.turnstilePassed([top, form([700]), chl(2), chl(3)]), false, "two challenge frames under one filled token: the second widget's input is hidden (closed shadow root)");
  assert.strictEqual(c.turnstilePassed([top, form([700, 650]), chl(2), chl(3)]), true);
  assert.strictEqual(c.turnstilePassed([top, form([700]), { id: 3, parentId: 0, host: "x.example" }, chl(4, 3)]), false, "parent frame has no markers (its widget timed out / is hidden)");
  assert.strictEqual(c.turnstilePassed([top, form([700]), chl(2, null)]), false, "parent not in the scan → fail closed");
  assert.strictEqual(c.turnstilePassed([top, form([700]), { id: 2, challengeFrame: true, host: "challenges.cloudflare.com" }]), false, "no parentId at all → fail closed");
  assert.strictEqual(c.turnstilePassed([top, form([700]), chl(2), chl(3, 1, { visible: false })]), true, "a challenge frame with no box is left out");
  assert.strictEqual(c.tryOutcome("turnstile", [top, form([700]), chl(2), chl(3)]), "failed", "the outcome line uses the same rule");
});
