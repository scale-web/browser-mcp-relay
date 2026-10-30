// cf-wall-log.test.js — the shared CF-WALL log writer (spec v8 §2; format and
// frontmatter from the cf-challenge skill). Every test writes to its own temp
// file; the real vault log is checked untouched at the end.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const log = require("../src/cf-wall-log.js");

const realBefore = (() => { try { return fs.statSync(log.DEFAULT_LOG).mtimeMs; } catch { return null; } })();
test.after(() => {
  let after = null;
  try { after = fs.statSync(log.DEFAULT_LOG).mtimeMs; } catch { /* absent */ }
  assert.strictEqual(after, realBefore, "the real CF-WALL log must never be touched by tests");
});

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-cfwall-")), "CF-WALL Log.md");
}

const NOW = new Date("2026-10-30T17:04:05.678Z");

test("default path is the vault recon log; BROWSER_RELAY_CF_WALL_LOG overrides it", () => {
  assert.ok(log.DEFAULT_LOG.endsWith(path.join("2026-10-29 Cloudflare Relay Challenge Recon", "00 - Summary", "CF-WALL Log.md")));
  assert.ok(log.DEFAULT_LOG.startsWith(path.join(os.homedir(), "ObsidianVault", "[AGENCY] Automated Scaling")));
  assert.strictEqual(log.logPath({ BROWSER_RELAY_CF_WALL_LOG: "/tmp/x.md" }), "/tmp/x.md");
  assert.strictEqual(log.logPath({ BROWSER_RELAY_CF_WALL_LOG: "  " }), log.DEFAULT_LOG);
});

test("line format: YYYY-MM-DDTHH:MM:SSZ | lane | host | owner | route", () => {
  assert.strictEqual(
    log.formatLine({ now: NOW, lane: "CRO-33", host: "go.example.com", owner: "highlevel", route: "challenge_detect: turnstile → §3.1" }),
    "2026-10-30T17:04:05Z | CRO-33 | go.example.com | highlevel | challenge_detect: turnstile → §3.1\n",
  );
});

test("a field cannot break the format: pipes and line breaks become spaces", () => {
  const l = log.formatLine({ now: NOW, lane: "a|b\nc", host: "h", owner: "o", route: "r\r\n| x" });
  assert.strictEqual(l.split("\n").length, 2);
  assert.strictEqual(l.split("|").length, 5);
});

test("missing log → created with the skill's frontmatter, then the line", () => {
  const p = tmpLog();
  const r = log.appendLine({ lane: "L1", host: "h.example", owner: "vendor", route: "x", now: NOW, path: p });
  assert.strictEqual(r.logged, true);
  const body = fs.readFileSync(p, "utf8");
  assert.strictEqual(body, log.header(NOW) + "2026-10-30T17:04:05Z | L1 | h.example | vendor | x\n");
  assert.ok(body.startsWith("---\ntitle: CF-WALL log\ntype: log\nvendor: Cloudflare\nrecon-job: 2026-10-29 Cloudflare Relay Challenge Recon\ncaptured: 2026-10-30\ntags: [recon, vendor/cloudflare, log]\n---\n"));
});

test("the header is byte-identical to the cf-challenge skill's printf", { skip: process.platform === "win32" }, () => {
  const p = tmpLog();
  // The skill's exact command (captured date pinned to NOW's day).
  const script = `printf '%s\\n' '---' 'title: CF-WALL log' 'type: log' 'vendor: Cloudflare' ` +
    `'recon-job: 2026-10-29 Cloudflare Relay Challenge Recon' "captured: 2026-10-30" 'tags: [recon, vendor/cloudflare, log]' '---' '' ` +
    `'> ⬅ Back to recon: [[../_README]]' '' '# CF-WALL log' '' ` +
    `'Append-only, one line per wall: \`YYYY-MM-DDTHH:MM:SSZ | <lane> | <host> | <owner> | <route taken>\`. \`agency-test\` lines are expected and not counted.' '' > "$1"`;
  execFileSync("/bin/sh", ["-c", script, "sh", p]);
  assert.strictEqual(log.header(NOW), fs.readFileSync(p, "utf8"));
});

test("append-only: earlier lines and the header are never rewritten", () => {
  const p = tmpLog();
  log.appendLine({ lane: "L1", host: "a.example", owner: "vendor", route: "one", now: NOW, path: p });
  const first = fs.readFileSync(p, "utf8");
  // someone (a person, another lane) edits the file by hand between appends
  fs.appendFileSync(p, "2026-10-29T00:00:00Z | HAND | b.example | shopify | shopify-pause\n");
  const middle = fs.readFileSync(p, "utf8");
  log.appendLine({ lane: "L2", host: "c.example", owner: "highlevel", route: "two", now: new Date("2026-10-30T18:00:00Z"), path: p });
  const after = fs.readFileSync(p, "utf8");
  assert.ok(after.startsWith(middle), "everything before the append is byte-identical");
  assert.ok(middle.startsWith(first));
  assert.strictEqual(after.slice(middle.length), "2026-10-30T18:00:00Z | L2 | c.example | highlevel | two\n");
  assert.strictEqual((after.match(/^---$/gm) || []).length, 2, "one frontmatter block only");
});

test("an existing log is never re-headed, even with no frontmatter of its own", () => {
  const p = tmpLog();
  fs.writeFileSync(p, "legacy line\n");
  log.appendLine({ lane: "L", host: "h", owner: "o", route: "r", now: NOW, path: p });
  assert.strictEqual(fs.readFileSync(p, "utf8"), "legacy line\n2026-10-30T17:04:05Z | L | h | o | r\n");
});

test("an unwritable path → logged: false with the error, no throw", () => {
  const r = log.appendLine({ lane: "L", host: "h", owner: "o", route: "r", now: NOW, path: path.join(os.tmpdir(), "no-such-dir-" + process.pid, "x", "log.md") });
  assert.strictEqual(r.logged, false);
  assert.match(r.error, /ENOENT/);
});

test("r1 #10: create race — the log appears between the check and the link → left alone, line appended, no temp file left", () => {
  const p = tmpLog();
  const fsImpl = {
    ...fs,
    lstatSync: (f) => {
      if (f === p && !fs.existsSync(p)) {
        fs.writeFileSync(p, "OTHER RELAY'S HEADER\n"); // lost the race: it appears right after our check
        const e = new Error("ENOENT"); e.code = "ENOENT"; throw e;
      }
      return fs.lstatSync(f);
    },
  };
  const r = log.appendLine({ lane: "L", host: "h", owner: "o", route: "r", now: NOW, path: p, fsImpl });
  assert.strictEqual(r.logged, true);
  assert.strictEqual(fs.readFileSync(p, "utf8"), "OTHER RELAY'S HEADER\n2026-10-30T17:04:05Z | L | h | o | r\n");
  assert.deepStrictEqual(fs.readdirSync(path.dirname(p)), ["CF-WALL Log.md"]);
});

test("r1 #10: a created log is never visible without its whole header (header linked in, not written in place)", () => {
  const p = tmpLog();
  const seen = [];
  const fsImpl = {
    ...fs,
    writeFileSync: (f, data, opts) => { assert.notStrictEqual(f, p, "the header is never written to the log path itself"); return fs.writeFileSync(f, data, opts); },
    linkSync: (a, b) => { fs.linkSync(a, b); seen.push(fs.readFileSync(b, "utf8")); },
  };
  log.appendLine({ lane: "L", host: "h", owner: "o", route: "r", now: NOW, path: p, fsImpl });
  assert.deepStrictEqual(seen, [log.header(NOW)], "the moment the log exists it holds the full header");
  assert.deepStrictEqual(fs.readdirSync(path.dirname(p)), ["CF-WALL Log.md"]);
});

test("r2 #6: a temp-file write that fails half-way leaves no .tmp behind and appends nothing", () => {
  const p = tmpLog();
  const fsImpl = { ...fs, writeFileSync: (f, data, opts) => { fs.writeFileSync(f, String(data).slice(0, 10), opts); throw new Error("ENOSPC: no space left"); } };
  const r = log.appendLine({ lane: "L", host: "h", owner: "o", route: "r", now: NOW, path: p, fsImpl });
  assert.strictEqual(r.logged, false);
  assert.match(r.error, /ENOSPC/);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(p)), []);
});

test("r2 #6: a log path that is a dangling symlink is REFUSED — the target is not created headerless", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cfwall-"));
  const p = path.join(dir, "CF-WALL Log.md");
  const target = path.join(dir, "elsewhere.md");
  fs.symlinkSync(target, p);
  const r = log.appendLine({ lane: "L", host: "h", owner: "o", route: "r", now: NOW, path: p });
  assert.strictEqual(r.logged, false);
  assert.match(r.error, /symlink to a missing file/);
  assert.strictEqual(fs.existsSync(target), false);
  assert.deepStrictEqual(fs.readdirSync(dir), ["CF-WALL Log.md"]);
  // a symlink to an existing log is followed normally
  fs.writeFileSync(target, "existing\n");
  assert.strictEqual(log.appendLine({ lane: "L", host: "h", owner: "o", route: "r", now: NOW, path: p }).logged, true);
  assert.strictEqual(fs.readFileSync(target, "utf8"), "existing\n2026-10-30T17:04:05Z | L | h | o | r\n");
});
