const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { _clearSessionRestore: clearSessionRestore } = require("../src/cdp-bridge.js");

// Builds a profile shaped like a real one: the tab store alongside every
// directory that actually holds credentials.
function makeProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-restore-test-"));
  const def = path.join(dir, "Default");
  const sessions = path.join(def, "Sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, "Session_13431824758570907"), "tabstate");
  fs.writeFileSync(path.join(sessions, "Tabs_13431824363500049"), "tabstate");

  // AUTH — must survive. GHL lives in cookies + IndexedDB firebaseLocalStorageDb;
  // iClosed lives in localStorage with no auth cookie at all.
  fs.writeFileSync(path.join(def, "Cookies"), "COOKIE-SENTINEL");
  fs.writeFileSync(path.join(def, "Login Data"), "LOGIN-SENTINEL");
  fs.writeFileSync(path.join(def, "Web Data"), "WEBDATA-SENTINEL");
  fs.mkdirSync(path.join(def, "Local Storage"), { recursive: true });
  fs.writeFileSync(path.join(def, "Local Storage", "leveldb"), "LOCALSTORAGE-SENTINEL");
  fs.mkdirSync(path.join(def, "IndexedDB", "https_app.gohighlevel.com_0.indexeddb.leveldb"), { recursive: true });
  fs.writeFileSync(
    path.join(def, "IndexedDB", "https_app.gohighlevel.com_0.indexeddb.leveldb", "CURRENT"),
    "FIREBASE-AUTH-SENTINEL",
  );
  fs.mkdirSync(path.join(def, "Session Storage"), { recursive: true });
  fs.writeFileSync(path.join(def, "Session Storage", "leveldb"), "SESSIONSTORAGE-SENTINEL");
  return { dir, def, sessions };
}

// Every credential-bearing path, with the exact bytes we expect back.
const AUTH_SENTINELS = [
  ["Cookies", "COOKIE-SENTINEL"],
  ["Login Data", "LOGIN-SENTINEL"],
  ["Web Data", "WEBDATA-SENTINEL"],
  [path.join("Local Storage", "leveldb"), "LOCALSTORAGE-SENTINEL"],
  [path.join("IndexedDB", "https_app.gohighlevel.com_0.indexeddb.leveldb", "CURRENT"), "FIREBASE-AUTH-SENTINEL"],
  [path.join("Session Storage", "leveldb"), "SESSIONSTORAGE-SENTINEL"],
];

function assertAuthIntact(def, label) {
  for (const [rel, expected] of AUTH_SENTINELS) {
    const p = path.join(def, rel);
    assert.ok(fs.existsSync(p), `${label}: auth path destroyed: ${rel}`);
    assert.strictEqual(fs.readFileSync(p, "utf8"), expected, `${label}: auth content altered: ${rel}`);
  }
}

test("clearSessionRestore: removes the tab store", () => {
  const { dir, sessions } = makeProfile();
  try {
    const r = clearSessionRestore(dir, {});
    assert.strictEqual(r.cleared, true);
    assert.strictEqual(fs.existsSync(sessions), false, "Sessions/ should be gone");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// THE LOAD-BEARING TEST. The fix is a recursive delete inside a profile that
// holds live client logins. GHL auth = cookies + IndexedDB; iClosed = localStorage.
// Widening the scope (profile root, or a "Session*" glob that catches
// "Session Storage") costs re-logins that may not be self-serve recoverable.
// If someone broadens the delete, this fails.
test("clearSessionRestore: destroys ONLY the tab store — every auth path survives byte-for-byte", () => {
  const { dir, def, sessions } = makeProfile();
  try {
    clearSessionRestore(dir, {});
    assert.strictEqual(fs.existsSync(sessions), false);
    assertAuthIntact(def, "after clear");
    // "Session Storage" is a distinct credential-bearing dir whose name shares a
    // prefix with "Sessions" — the exact thing a careless glob would swallow.
    assert.ok(fs.existsSync(path.join(def, "Session Storage")), "Session Storage must NOT be treated as the tab store");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clearSessionRestore: BROWSER_RELAY_KEEP_TABS=1 opts out and touches nothing", () => {
  const { dir, def, sessions } = makeProfile();
  try {
    const r = clearSessionRestore(dir, { BROWSER_RELAY_KEEP_TABS: "1" });
    assert.strictEqual(r.cleared, false);
    assert.strictEqual(r.reason, "BROWSER_RELAY_KEEP_TABS");
    assert.ok(fs.existsSync(sessions), "opt-out must preserve the tab store");
    assert.strictEqual(fs.readdirSync(sessions).length, 2);
    assertAuthIntact(def, "opt-out");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clearSessionRestore: KEEP_TABS=0 / 'false' are NOT opt-outs", () => {
  for (const v of ["0", "false"]) {
    const { dir, sessions } = makeProfile();
    try {
      assert.strictEqual(clearSessionRestore(dir, { BROWSER_RELAY_KEEP_TABS: v }).cleared, true, `KEEP_TABS=${v}`);
      assert.strictEqual(fs.existsSync(sessions), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("clearSessionRestore: a profile with no Sessions/ is a no-op, not an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-restore-empty-"));
  fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
  try {
    const r = clearSessionRestore(dir, {});
    assert.strictEqual(r.cleared, false);
    assert.strictEqual(r.reason, "absent");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A launch must never fail because cleanup failed — worst case is the old
// restore behaviour, which is what we had before this change.
test("clearSessionRestore: an unremovable store degrades to the old behaviour, never throws", () => {
  const { dir, def } = makeProfile();
  try {
    const orig = fs.rmSync;
    fs.rmSync = () => { throw new Error("EPERM: simulated"); };
    let r;
    try {
      r = clearSessionRestore(dir, {});
    } finally {
      fs.rmSync = orig;
    }
    assert.strictEqual(r.cleared, false);
    assert.match(r.reason, /EPERM/);
    assertAuthIntact(def, "after failure");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
