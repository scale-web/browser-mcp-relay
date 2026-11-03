// plainflags-stub-drift.test.js — plainflags-tools.json (what plainflags-stub.py
// answers the handshake with before the relay starts) must equal what the REAL
// plain-flags relay answers now, so a relay change cannot leave the stub stale.
// Harness only (it starts the real relay and its upstream; no Brave).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const { isolated, SKIP_MSG } = require("./helpers/isolation.js");
const { captureLive, comparable, TOOLS_FILE } = require("./helpers/plainflags-live.js");

test("plainflags-tools.json equals the live plain-flags relay's initialize + tools/list", { skip: !isolated() ? SKIP_MSG : false, timeout: 120000 }, async () => {
  const live = await captureLive();
  const file = JSON.parse(fs.readFileSync(TOOLS_FILE, "utf8"));
  assert.deepStrictEqual(comparable(file), live,
    "plainflags-tools.json is stale — regenerate it with `node scripts/gen-plainflags-tools.js` (from a copy, as the harness runs) and commit it");
});
