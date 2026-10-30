// known-accounts.test.js — the known-account list + the plainflags-signin.json
// loader that ship with challenge_detect (spec v8 §5.2 / §5.6 (6)). Pure: no
// enforcement exists until phase 1c.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ka = require("../src/known-accounts.js");
const { createSigninLoader, SIGNIN_FILE } = require("../src/plainflags-signin.js");
const { loadLocalConfig } = require("../src/local-config.js");

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), "relay-signin-")); }

// ── the list ────────────────────────────────────────────────────────────────

test("known accounts: the spec's seed set, every entry well-formed and marked unconfirmed", () => {
  const names = ka.KNOWN_ACCOUNTS.map((a) => a.name);
  assert.deepStrictEqual(names, ["highlevel", "canva", "hostinger", "shopify", "cloudflare", "google", "microsoft", "apple"]);
  for (const a of ka.KNOWN_ACCOUNTS) {
    assert.ok(a.loginMatchers.length > 0, a.name);
    assert.ok(Array.isArray(a.cookieOrigins) && a.cookieOrigins.every((o) => new URL(o).origin === o), a.name);
    assert.ok(Array.isArray(a.sessionCookies) && Array.isArray(a.signsInVia), a.name);
    assert.strictEqual(typeof a.federating, "boolean", a.name);
    assert.strictEqual(a.confirmed, false, `${a.name}: §10 #25 read not done — must stay unconfirmed`);
    assert.ok(Object.isFrozen(a), a.name);
  }
  assert.deepStrictEqual(ka.KNOWN_ACCOUNTS.filter((a) => a.federating).map((a) => a.name), ["google", "microsoft", "apple"]);
  assert.ok(Object.isFrozen(ka.KNOWN_ACCOUNTS));
});

test("matchLoginUrl: host matchers", () => {
  assert.strictEqual(ka.matchLoginUrl("https://app.gohighlevel.com/").account.name, "highlevel");
  assert.strictEqual(ka.matchLoginUrl("https://app.leadconnectorhq.com/v2/location/x").account.name, "highlevel");
  assert.strictEqual(ka.matchLoginUrl("https://accounts.google.com/v3/signin/identifier?x=1").account.name, "google");
  assert.strictEqual(ka.matchLoginUrl("https://AUTH.Hostinger.com./login").account.name, "hostinger", "case + trailing dot");
  // a GHL funnel host and the form-widget host are NOT the app login
  assert.strictEqual(ka.matchLoginUrl("https://go.revivemyhair.com/book"), null);
  assert.strictEqual(ka.matchLoginUrl("https://api.leadconnectorhq.com/widget/form/x"), null);
  assert.strictEqual(ka.matchLoginUrl("https://evil-accounts.google.com.example/"), null);
});

test("matchLoginUrl: host + path matcher (Canva) — login refused, public pages not; normalised path (r8 #7)", () => {
  for (const u of ["https://www.canva.com/login", "https://www.canva.com/login/", "https://www.canva.com/LOGIN?x=1",
    "https://www.canva.com//login", "https://www.canva.com/%6Cogin", "https://www.canva.com/login/sso"]) {
    assert.ok(ka.matchLoginUrl(u), u);
  }
  for (const u of ["https://www.canva.com/", "https://www.canva.com/templates/", "https://www.canva.com/loginx",
    "https://www.canva.com/design/login-ideas", "https://canva.com/login"]) {
    assert.strictEqual(ka.matchLoginUrl(u), null, u);
  }
  assert.strictEqual(ka.matchLoginUrl("not a url"), null);
  assert.strictEqual(ka.matchLoginUrl("about:blank"), null);
});

// ── the sign-in loader ──────────────────────────────────────────────────────

test("loader: default path is plainflags-signin.json in the relay root, and phase 1 ships no such file", () => {
  assert.strictEqual(SIGNIN_FILE, path.resolve(__dirname, "..", "plainflags-signin.json"));
  assert.strictEqual(fs.existsSync(SIGNIN_FILE), false, "the file is created (empty) by the 1c build, not phase 1");
});

test("loader: missing file → empty, not logged", () => {
  const logs = [];
  const l = createSigninLoader({ path: path.join(tmpdir(), "plainflags-signin.json"), log: (m) => logs.push(m) });
  const s = l.load();
  assert.strictEqual(s.source, "missing");
  assert.strictEqual(s.names.size, 0);
  assert.deepStrictEqual(logs, []);
});

test("loader: reads the nested file — which loadLocalConfig() reads as {} (do not wire it back)", () => {
  const p = path.join(tmpdir(), "plainflags-signin.json");
  fs.writeFileSync(p, JSON.stringify({ accounts: [{ name: "canva", askId: "as-ops/ask-abc123" }] }));
  const s = createSigninLoader({ path: p }).load();
  assert.strictEqual(s.source, "file");
  assert.deepStrictEqual([...s.names], ["canva"]);
  assert.deepStrictEqual(s.accounts, [{ name: "canva", askId: "as-ops/ask-abc123" }]);
  // the trap the spec records: the string-only local-config loader drops it
  assert.deepStrictEqual(loadLocalConfig({ path: p, refresh: true }), {});
});

test("loader: malformed JSON or no accounts array → empty (fail closed), logged ONCE per file state", () => {
  const p = path.join(tmpdir(), "plainflags-signin.json");
  const logs = [];
  const l = createSigninLoader({ path: p, log: (m) => logs.push(m) });
  fs.writeFileSync(p, "{ not json");
  assert.strictEqual(l.load().source, "malformed");
  assert.strictEqual(l.load().names.size, 0);
  assert.strictEqual(l.load().source, "malformed");
  assert.strictEqual(logs.length, 1, logs.join("\n"));
  fs.writeFileSync(p, JSON.stringify({ accounts: "canva" }) + "  ");
  assert.strictEqual(l.load().source, "malformed");
  assert.strictEqual(logs.length, 2);
  fs.writeFileSync(p, JSON.stringify([{ name: "canva", askId: "x" }]));
  assert.strictEqual(l.load().names.size, 0);
});

test("loader: a good list that then turns malformed reads as EMPTY, never the old list", () => {
  const p = path.join(tmpdir(), "plainflags-signin.json");
  const l = createSigninLoader({ path: p, log: () => {} });
  fs.writeFileSync(p, JSON.stringify({ accounts: [{ name: "canva", askId: "as-ops/ask-3" }] }));
  assert.deepStrictEqual([...l.load().names], ["canva"]);
  fs.writeFileSync(p, '{"accounts": [{"name": "canva", "askId": "as-ops/ask-3"}'); // truncated mid-write
  const s = l.load();
  assert.strictEqual(s.source, "malformed");
  assert.strictEqual(s.names.size, 0);
});

test("loader: an entry without a name and askId is dropped; the rest load", () => {
  const p = path.join(tmpdir(), "plainflags-signin.json");
  const logs = [];
  fs.writeFileSync(p, JSON.stringify({ accounts: [{ name: "canva" }, { askId: "x" }, null, { name: " ", askId: "y" }, { name: "hostinger", askId: "as-ops/ask-1" }] }));
  const s = createSigninLoader({ path: p, log: (m) => logs.push(m) }).load();
  assert.deepStrictEqual([...s.names], ["hostinger"]);
  assert.strictEqual(logs.length, 1);
});

test("loader: re-reads when the file changes (addition applies on the next load); same snapshot while unchanged", () => {
  const p = path.join(tmpdir(), "plainflags-signin.json");
  fs.writeFileSync(p, JSON.stringify({ accounts: [] }));
  const l = createSigninLoader({ path: p });
  const a = l.load();
  assert.strictEqual(a.names.size, 0);
  assert.strictEqual(l.load(), a, "unchanged file → same snapshot object");
  fs.writeFileSync(p, JSON.stringify({ accounts: [{ name: "canva", askId: "as-ops/ask-2" }] }));
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(p, future, future);
  const b = l.load();
  assert.notStrictEqual(b, a);
  assert.deepStrictEqual([...b.names], ["canva"]);
  // removal
  fs.writeFileSync(p, JSON.stringify({ accounts: [] }));
  const later = new Date(Date.now() + 10000);
  fs.utimesSync(p, later, later);
  assert.strictEqual(l.load().names.size, 0);
  // deletion → empty again
  fs.unlinkSync(p);
  assert.strictEqual(l.load().source, "missing");
});

test("loader: does not re-read while stat is unchanged (mtime-keyed, not read on every call)", () => {
  let reads = 0;
  const st = { mtimeMs: 1, size: 10, ino: 5 };
  const fsImpl = {
    statSync: () => st,
    readFileSync: () => { reads++; return JSON.stringify({ accounts: [{ name: "canva", askId: "a" }] }); },
  };
  const l = createSigninLoader({ path: "/x/plainflags-signin.json", fsImpl });
  l.load(); l.load(); l.load();
  assert.strictEqual(reads, 1);
  st.mtimeMs = 2;
  l.load();
  assert.strictEqual(reads, 2);
});
