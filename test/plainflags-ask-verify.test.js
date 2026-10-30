// plainflags-ask-verify.test.js — a sign-in list entry counts only when its
// claude-ask record grants it (review round 1 item 6). Fixture records in a
// temp store; the real ~/.claude-asks is never read here.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAskVerifier } = require("../src/plainflags-ask-verify.js");

function store(records) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-asks-"));
  for (const r of records) {
    const [project, short] = r.id.split("/");
    const dir = r._archived ? path.join(root, project, "archive") : path.join(root, project);
    fs.mkdirSync(dir, { recursive: true });
    const { _archived, ...rec } = r;
    fs.writeFileSync(path.join(dir, `${short}.json`), typeof rec._raw === "string" ? rec._raw : JSON.stringify(rec));
  }
  return root;
}

const GOOD = {
  id: "as-ops/ask-abcdef", project: "as-ops", kind: "permission", risk: "credentials", state: "in_progress",
  title: "Allow sign-in to canva in the plain-flags relay",
  options: [{ key: "add", label: "Add it to the plain-flags sign-in list" }, { key: "later", label: "Not now", declines: true }],
  answer: { option: "add", words: "yes" },
};

test("a granting record (answered / in_progress / done, risk credentials, title names the account) → honoured; archived too", () => {
  const root = store([GOOD, { ...GOOD, id: "as-ops/ask-bbbbbb", state: "done", _archived: true }, { ...GOOD, id: "as-ops/ask-cccccc", state: "answered" }]);
  const v = createAskVerifier({ root });
  assert.deepStrictEqual(v.verify("canva", "as-ops/ask-abcdef"), { ok: true });
  assert.deepStrictEqual(v.verify("canva", "as-ops/ask-bbbbbb"), { ok: true });
  assert.deepStrictEqual(v.verify("canva", "as-ops/ask-cccccc"), { ok: true });
});

test("refused (fail closed): missing, malformed id, wrong state, wrong risk, no answer, a declining answer, a title not naming the account, an identity mismatch, unparseable", () => {
  const root = store([
    { ...GOOD, id: "as-ops/ask-wwwwww", state: "waiting" },
    { ...GOOD, id: "as-ops/ask-dddddd", state: "declined" },
    { ...GOOD, id: "as-ops/ask-rrrrrr", risk: "internal" },
    { ...GOOD, id: "as-ops/ask-nnnnnn", answer: undefined },
    { ...GOOD, id: "as-ops/ask-llllll", answer: { option: "later" } },
    { ...GOOD, id: "as-ops/ask-tttttt", title: "Allow sign-in to hostinger in the plain-flags relay" },
    { ...GOOD, id: "as-ops/ask-uuuuuu", title: "Allow sign-in to canvas-co in the plain-flags relay" },
    { ...GOOD, id: "as-ops/ask-iiiiii", project: "other" },
    { id: "as-ops/ask-ppppaa", _raw: "{not json" },
  ]);
  const v = createAskVerifier({ root });
  const cases = [
    ["as-ops/ask-zzzzzz", /no such ask record/],
    ["not-an-id", /not a claude-ask id/],
    ["", /not a claude-ask id/],
    ["as-ops/ask-wwwwww", /"waiting"/],
    ["as-ops/ask-dddddd", /"declined"/],
    ["as-ops/ask-rrrrrr", /risk "internal"/],
    ["as-ops/ask-nnnnnn", /no answer/],
    ["as-ops/ask-llllll", /declining option/],
    ["as-ops/ask-tttttt", /does not name "canva"/],
    ["as-ops/ask-uuuuuu", /does not name "canva"/],
    ["as-ops/ask-iiiiii", /identity/],
    ["as-ops/ask-ppppaa", /does not parse/],
  ];
  for (const [id, re] of cases) {
    const r = v.verify("canva", id);
    assert.strictEqual(r.ok, false, id);
    assert.match(r.reason, re, id);
  }
});

test("the default store is ~/.claude-asks (read-only; never written)", () => {
  assert.strictEqual(createAskVerifier().root, path.join(os.homedir(), ".claude-asks"));
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "plainflags-ask-verify.js"), "utf8");
  assert.ok(!/writeFile|rename|unlink|mkdir|rmSync|appendFile/.test(src.replace(/\/\/.*$/gm, "")), "no write calls in the verifier");
});

test("round 2 item 2: requireTypedAnswer (off by default) refuses an answer without a prompt_id; with one it passes", () => {
  const root = store([GOOD, { ...GOOD, id: "as-ops/ask-pppppp", answer: { option: "add", prompt_id: "prm-123" } }, { ...GOOD, id: "as-ops/ask-qqqqqq", answer: { option: "add", prompt_id: null } }]);
  assert.strictEqual(createAskVerifier({ root }).verify("canva", "as-ops/ask-abcdef").ok, true, "off by default");
  const strict = createAskVerifier({ root, requireTypedAnswer: true });
  assert.match(strict.verify("canva", "as-ops/ask-abcdef").reason, /prompt_id/);
  assert.match(strict.verify("canva", "as-ops/ask-qqqqqq").reason, /prompt_id/);
  assert.deepStrictEqual(strict.verify("canva", "as-ops/ask-pppppp"), { ok: true });
  const pf = require("../src/plainflags-mode.js");
  assert.strictEqual(pf.requireTypedAnswer({}), false);
  assert.strictEqual(pf.requireTypedAnswer({ BROWSER_RELAY_PLAINFLAGS_REQUIRE_TYPED_ANSWER: "1" }), true);
  assert.strictEqual(pf.requireTypedAnswer({ BROWSER_RELAY_PLAINFLAGS_REQUIRE_TYPED_ANSWER: "0" }), false);
});
