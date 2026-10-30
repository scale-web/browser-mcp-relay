// plainflags-lock.test.js — the plain-flags lock (review rounds 3 A and 4).
// The DECISION against a fake reader (tabs → frames → counts); the in-page
// probe (secretProbe) against a minimal fake DOM. The real isolated-world
// reader in a real Brave: test/isolated-plainflags.test.js.

const test = require("node:test");
const assert = require("node:assert");
const { createLock, secretProbe, EXEMPT, LOCK_TEXT } = require("../src/plainflags-lock.js");

const ACCOUNTS = [
  { name: "fixturebank", loginMatchers: [{ host: "login.fixturebank.test", signInPage: true }], cookieOrigins: [], sessionCookies: [] },
  { name: "fixtureapp", loginMatchers: [{ host: "app.fixtureapp.test" }], cookieOrigins: [], sessionCookies: [] },
  { name: "fixturedesign", loginMatchers: [{ host: "www.fixturedesign.test", pathPrefixes: ["/login"] }], cookieOrigins: [], sessionCookies: [] },
];
const EMPTY = { seen: 0, filled: 0 };
const tab = (key, url, ...frames) => ({ key, url, frames: [{ url, result: frames[0] === undefined ? EMPTY : frames[0] }, ...frames.slice(1)] });

function lockWith(getTabs) {
  const notices = [];
  const l = createLock({ getContext: () => ({}), accounts: ACCOUNTS, notice: (t) => notices.push(t), readTabs: async () => ({ tabs: getTabs() }) });
  return { l, notices };
}

test("exempt list and text are exactly as ruled", () => {
  assert.deepStrictEqual([...EXEMPT], ["relay_status", "tabs_list"]);
  assert.strictEqual(LOCK_TEXT, "Locked: a password or one-time code is on this page (Trevor may be signing in). Tools resume when the field is empty or the tab leaves the sign-in page.");
});

test("a FILLED secret field on ANY tab locks; an empty one does not; clearing it unlocks — announced once each way", async () => {
  let tabs = [tab("A", "https://a.example/"), tab("B", "https://b.example/", { seen: 1, filled: 0 })];
  const { l, notices } = lockWith(() => tabs);
  assert.strictEqual((await l.probe()).locked, false, "an empty password field is not a secret yet");
  tabs = [tab("A", "https://a.example/"), tab("B", "https://b.example/form", EMPTY, { url: "https://pay.example/frame", result: { seen: 1, filled: 1 } })];
  assert.deepStrictEqual([(await l.probe()).locked, l.status().filled], [true, 1], "in a child frame of ANOTHER tab too");
  await l.probe();
  assert.strictEqual(notices.filter((n) => /LOCKED/.test(n)).length, 1, "announced once");
  tabs = [tab("B", "https://b.example/form", { seen: 1, filled: 0 })];
  assert.strictEqual((await l.probe()).locked, false);
  assert.match(notices.at(-1), /UNLOCKED/);
});

test("round 4 M2: the URL rule locks only a SIGN-IN page (a dedicated sign-in host or a path matcher), never an app host's dashboard", async () => {
  for (const [url, want] of [
    ["https://login.fixturebank.test/signin?next=1", true], // dedicated sign-in host
    ["https://www.fixturedesign.test/login", true], // path-scoped matcher
    ["https://www.fixturedesign.test/", false],
    ["https://app.fixtureapp.test/v2/location/x/dashboard", false], // app host
  ]) {
    const { l } = lockWith(() => [tab("A", url)]);
    assert.strictEqual((await l.probe()).locked, want, url);
  }
  // the shipped list: HighLevel's dashboard does not lock; Google's sign-in host does; HighLevel's sign-in PATH is not confirmed (§10 #25) — no URL rule there
  const shipped = (url) => createLock({ getContext: () => ({}), readTabs: async () => ({ tabs: [tab("A", url)] }) });
  assert.strictEqual((await shipped("https://app.gohighlevel.com/v2/location/abc/dashboard").probe()).locked, false);
  assert.strictEqual((await shipped("https://app.myautomatedbiz.com/").probe()).locked, false);
  assert.strictEqual((await shipped("https://admin.shopify.com/store/x").probe()).locked, false);
  assert.strictEqual((await shipped("https://dash.cloudflare.com/abc").probe()).locked, false);
  assert.strictEqual((await shipped("https://accounts.google.com/v3/signin").probe()).locked, true);
  assert.strictEqual((await shipped("https://www.canva.com/login").probe()).locked, true);
  assert.strictEqual((await shipped("https://auth.hostinger.com/login").probe()).locked, true);
});

test("round 4 M3: fail closed PER TAB — an unreadable frame locks only the tab where a secret field was seen; leaving or closing that tab clears it", async () => {
  // the reviewer's case: tab A has a hanging iframe, tab B an EMPTY sign-in form
  let tabs = [tab("A", "https://a.example/", EMPTY, { url: "https://ads.example/x", result: null }), tab("B", "https://b.example/login-form", { seen: 1, filled: 0 })];
  const { l } = lockWith(() => tabs);
  assert.strictEqual((await l.probe()).locked, false, "A's unreadable frame is not near any secret");
  tabs = [tabs[0], tab("B", "https://b.example/done")];
  assert.strictEqual((await l.probe()).locked, false, "B left to a no-field page: still unlocked (was sticky browser-wide before)");
  // the SAME tab: a secret field seen, then a frame of it becomes unreadable → locked
  tabs = [tab("C", "https://c.example/form", { seen: 1, filled: 0 })];
  await l.probe();
  tabs = [tab("C", "https://c.example/form", EMPTY, { url: "https://pay.example/frame", result: null })];
  assert.strictEqual((await l.probe()).locked, true, "remembered on the same page of the same tab");
  // the tab navigates → its memory goes
  tabs = [tab("C", "https://c.example/next", EMPTY, { url: "https://pay.example/frame", result: null })];
  assert.strictEqual((await l.probe()).locked, false, "a new page: no memory");
  // a tab closes → its memory goes (a new tab with the same URL starts clean)
  tabs = [tab("D", "https://d.example/f", { seen: 1, filled: 0 })];
  await l.probe();
  tabs = [];
  await l.probe();
  tabs = [tab("E", "https://d.example/f", EMPTY, { url: "https://x.example/", result: null })];
  assert.strictEqual((await l.probe()).locked, false);
  // an unreadable frame on a tab that has a sign-in FRAME locks
  tabs = [tab("F", "https://f.example/", EMPTY, { url: "https://login.fixturebank.test/embed", result: null })];
  assert.strictEqual((await l.probe()).locked, true);
});

test("no Brave → nothing to lock; a reader failure locks only while a tab had a secret field", async () => {
  assert.strictEqual((await createLock({ getContext: () => null, accounts: ACCOUNTS, readTabs: async () => ({ tabs: [] }) }).probe()).locked, false);
  let fail = false;
  const l = createLock({ getContext: () => ({}), accounts: ACCOUNTS, readTabs: async () => { if (fail) throw new Error("gone"); return { tabs: [tab("A", "https://a.example/", { seen: 1, filled: 0 })] }; } });
  await l.probe();
  fail = true;
  assert.strictEqual((await l.probe()).locked, true);
  const l2 = createLock({ getContext: () => ({}), accounts: ACCOUNTS, readTabs: async () => { throw new Error("gone"); } });
  assert.strictEqual((await l2.probe()).locked, false);
});

// ── the probe itself, on a minimal fake DOM ─────────────────────────────────

function fakeDom(specs) {
  const parentOf = new Map();
  const els = [];
  const containers = new Map();
  for (const sp of specs) {
    const attrs = { ...(sp.attrs || {}) };
    const tag = sp.tag || "INPUT";
    const typeProp = tag === "TEXTAREA" ? "textarea" : (attrs.type || "text").toLowerCase();
    const el = { tagName: tag, type: typeProp, value: sp.value || "", maxLength: attrs.maxlength ? Number(attrs.maxlength) : -1,
      getAttribute: (k) => (k in attrs ? attrs[k] : null), previousElementSibling: null, nextElementSibling: null, shadowRoot: null };
    const c = sp.parent || "root";
    if (!containers.has(c)) containers.set(c, { id: c, parentElement: null });
    el.parentElement = containers.get(c);
    els.push(el);
    parentOf.set(el, c);
  }
  for (let i = 0; i < els.length; i++) {
    const same = els.filter((e) => e.parentElement === els[i].parentElement);
    const j = same.indexOf(els[i]);
    els[i].previousElementSibling = same[j - 1] || null;
    els[i].nextElementSibling = same[j + 1] || null;
  }
  return { querySelectorAll: (sel) => (sel === "*" ? [] : els) };
}
function runProbe(specs) {
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = fakeDom(specs);
  globalThis.getComputedStyle = () => ({ webkitTextSecurity: "none", getPropertyValue: () => "none" });
  try { return secretProbe(); } finally { Object.assign(globalThis, saved); }
}

test("round 4 M1: only TEXT-ENTRY controls count — a checked remember-password box, an otp_method radio, a hidden 'passengers', a 'password-submit' button and a prefilled passport_no do NOT lock; a typed password does", () => {
  const falsePositives = [
    { attrs: { type: "checkbox", name: "remember_password" }, value: "on" },
    { attrs: { type: "radio", name: "otp_method" }, value: "sms" },
    { attrs: { type: "hidden", name: "passengers" }, value: "2" },
    { attrs: { type: "submit", id: "password-submit" }, value: "Sign in" },
    { attrs: { type: "button", id: "show-password" }, value: "Show" },
    { attrs: { type: "image", name: "pwd-img" }, value: "x" },
    { attrs: { type: "reset", name: "pass-reset" }, value: "Reset" },
    { attrs: { type: "file", name: "passport_scan" }, value: "C:\\fakepath\\x.png" },
    { attrs: { type: "range", name: "passes" }, value: "5" },
    { attrs: { type: "color", name: "pass_color" }, value: "#000000" },
  ];
  for (const fp of falsePositives) assert.strictEqual(runProbe([fp]).filled, 0, JSON.stringify(fp.attrs));
  // the name rule still applies to text-entry controls (fail closed: "passport_no" is text-entry)
  assert.strictEqual(runProbe([{ attrs: { type: "password", id: "pw" }, value: "Hunter2" }]).filled, 1);
  assert.strictEqual(runProbe([{ attrs: { name: "user_pwd" }, value: "x" }]).filled, 1, "an input with no type is text-entry");
  assert.strictEqual(runProbe([{ tag: "TEXTAREA", attrs: { name: "otp" }, value: "123456" }]).filled, 1);
  assert.strictEqual(runProbe([{ attrs: { type: "text", name: "first" }, value: "Zed" }]).filled, 0);
});

test("round 4 L6: a split one-time code — six digit boxes (maxlength 1, inputmode numeric) lock; the box next to a one-time-code input locks; four ordinary maxlength-2 fields without a digit hint do not", () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ attrs: { type: "text", maxlength: "1", inputmode: "numeric", id: `d${i}` }, value: i === 0 ? "4" : "", parent: "otp" }));
  assert.deepStrictEqual(runProbe(six), { seen: 6, filled: 1 });
  const patterned = Array.from({ length: 4 }, () => ({ attrs: { type: "text", maxlength: "2", pattern: "[0-9]*" }, value: "12", parent: "g" }));
  assert.strictEqual(runProbe(patterned).filled, 4);
  const neighbour = [{ attrs: { type: "text", autocomplete: "one-time-code" }, value: "" }, { attrs: { type: "text", name: "code2" }, value: "77" }];
  assert.strictEqual(runProbe(neighbour).filled, 1, "the box beside a one-time-code input");
  const plain = Array.from({ length: 4 }, () => ({ attrs: { type: "text", maxlength: "2", name: "state" }, value: "CA", parent: "addr" }));
  assert.strictEqual(runProbe(plain).filled, 0);
  const three = Array.from({ length: 3 }, () => ({ attrs: { type: "text", maxlength: "1", inputmode: "numeric" }, value: "1", parent: "x" }));
  assert.strictEqual(runProbe(three).filled, 0, "fewer than 4 boxes is not a split code");
});

test("round 4 M3: a CLOSED tab's memory is gone — a later read failure does not lock on a tab that no longer exists", async () => {
  let tabs = [tab("A", "https://a.example/f", { seen: 1, filled: 0 })];
  let fail = false;
  const l = createLock({ getContext: () => ({}), accounts: ACCOUNTS, readTabs: async () => { if (fail) throw new Error("gone"); return { tabs }; } });
  await l.probe();
  tabs = [tab("B", "https://b.example/")]; // tab A closed
  await l.probe();
  fail = true;
  assert.strictEqual((await l.probe()).locked, false);
});

// ── round 5 ─────────────────────────────────────────────────────────────────

test("round 5 item 1: a frame whose probe world could not be verified (stale) locks its tab outright", async () => {
  const { l } = lockWith(() => [{ key: "A", url: "https://a.example/", frames: [{ url: "https://a.example/", result: null, stale: true }] }]);
  const st = await l.probe();
  assert.strictEqual(st.locked, true);
  assert.match(st.reason, /verified isolated world/);
});

test("round 5 item 2: an element once seen as secret stays secret — a show-password toggle (password → text) still counts", () => {
  const el = { tagName: "INPUT", type: "password", value: "Hunter2", maxLength: -1, getAttribute: (k) => ({ type: "password" })[k] ?? null,
    previousElementSibling: null, nextElementSibling: null, shadowRoot: null, parentElement: { id: "f" } };
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, mem: globalThis.__relayLockSeen };
  globalThis.document = { querySelectorAll: (sel) => (sel === "*" ? [] : [el]) };
  globalThis.getComputedStyle = () => ({ webkitTextSecurity: "none", getPropertyValue: () => "none" });
  try {
    assert.deepStrictEqual(secretProbe(), { seen: 1, filled: 1 });
    el.type = "text"; el.getAttribute = () => null; // the eye was clicked
    assert.deepStrictEqual(secretProbe(), { seen: 1, filled: 1 }, "remembered");
  } finally { Object.assign(globalThis, { document: saved.document, getComputedStyle: saved.getComputedStyle }); globalThis.__relayLockSeen = saved.mem; }
});

test("round 5 item 4: a single 2FA / verification code field (numeric or maxlength ≤ 8) is secret; a ZIP / promo code is not", () => {
  const yes = [
    { attrs: { type: "text", name: "code", inputmode: "numeric", maxlength: "6" }, value: "123456" }, // a bare "code" needs maxlength ≥ 4 (round 6)
    { attrs: { type: "text", id: "mfa-input", maxlength: "6" }, value: "123456" },
    { attrs: { type: "tel", name: "twoFactorCode", maxlength: "6" }, value: "123456" }, // HighLevel-style 2FA
    { attrs: { type: "text", name: "totp" , maxlength: "8" }, value: "12345678" },
    { attrs: { type: "text", id: "verification", inputmode: "numeric" }, value: "1234" },
    { attrs: { type: "text", name: "2fa_token", maxlength: "6" }, value: "123456" },
  ];
  for (const y of yes) assert.strictEqual(runProbe([y]).filled, 1, JSON.stringify(y.attrs));
  const no = [
    { attrs: { type: "text", name: "zipcode", maxlength: "5", inputmode: "numeric" }, value: "90210" },
    { attrs: { type: "text", name: "postal_code", maxlength: "7" }, value: "K1A 0B1" },
    { attrs: { type: "text", name: "promo_code", maxlength: "8" }, value: "SAVE10" },
    { attrs: { type: "text", name: "country_code", maxlength: "3" }, value: "+1" },
    { attrs: { type: "text", name: "code" }, value: "a long free-text code without limits" }, // no numeric hint, no maxlength
  ];
  for (const n of no) assert.strictEqual(runProbe([n]).filled, 0, JSON.stringify(n.attrs));
});

test("round 6 item 3: words, not substrings — the reviewer's cases", () => {
  const secret = [
    { name: "phoneVerificationCode" }, { name: "sms_code_phone", maxlength: "6" }, { id: "dialog-verification-code", maxlength: "6" },
    { name: "mfa_code_area", maxlength: "6" }, { name: "otp", maxlength: "6" }, { id: "smsOtp", maxlength: "6" }, { name: "pin", inputmode: "numeric" },
    { name: "totpToken", maxlength: "6" }, { name: "auth_code", maxlength: "6" }, { name: "code", maxlength: "4" },
  ];
  for (const a of secret) {
    const attrs = { type: "text", inputmode: a.inputmode || (a.maxlength ? undefined : "numeric"), ...a };
    for (const k of Object.keys(attrs)) if (attrs[k] === undefined) delete attrs[k];
    assert.strictEqual(runProbe([{ attrs, value: "123456" }]).filled, 1, JSON.stringify(attrs));
  }
  const notSecret = [
    { name: "state_code", maxlength: "2" }, { name: "currency_code", maxlength: "3" }, { name: "currency_code", maxlength: "6" },
    { name: "barcode", maxlength: "6", inputmode: "numeric" }, { name: "footprint", maxlength: "8" }, { name: "zip_code", maxlength: "5", inputmode: "numeric" },
    { name: "promo_code", maxlength: "8" }, { name: "code", maxlength: "3" }, { name: "code" }, { name: "pin_color" }, { name: "spinner", inputmode: "numeric" },
  ];
  for (const a of notSecret) assert.strictEqual(runProbe([{ attrs: { type: "text", ...a }, value: "12" }]).filled, 0, JSON.stringify(a));
});

test("round 7 item 2: acronym names split first — OTPCode, MFACode, TOTPCode, OTPInput, TwoFACode (and 2FACode) are secret; footprint, barcode, state_code unchanged", () => {
  for (const name of ["OTPCode", "MFACode", "TOTPCode", "OTPInput", "TwoFACode", "2FACode"]) {
    assert.strictEqual(runProbe([{ attrs: { type: "text", name, maxlength: "6" }, value: "123456" }]).filled, 1, name);
    assert.strictEqual(runProbe([{ attrs: { type: "text", id: name, inputmode: "numeric" }, value: "123456" }]).filled, 1, `id ${name}`);
  }
  for (const a of [{ name: "footprint", maxlength: "8" }, { name: "barcode", maxlength: "6", inputmode: "numeric" }, { name: "state_code", maxlength: "2" }, { name: "FootPrint", maxlength: "8" }]) {
    assert.strictEqual(runProbe([{ attrs: { type: "text", ...a }, value: "12" }]).filled, 0, JSON.stringify(a));
  }
});
