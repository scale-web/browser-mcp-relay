// cdp-identity.test.js — spec v4 §1b / F9 and amendments 6, 8, 9: which
// browser is on a CDP port is PROVEN, never guessed. The decoy cases put a
// different process on the port the check dials and assert it is rejected;
// each has a positive control so the rejection is not vacuous.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");
const id = require("../src/cdp-identity.js");
const pool = require("../src/pool-shared.js");
const { isolated, SKIP_MSG, homeTmp, nodeChild, killAndWait, REPO } = require("./helpers/isolation.js");

const ISO = { skip: !isolated() ? SKIP_MSG : (process.platform !== "darwin" ? "lsof address filter is checked on darwin" : false), timeout: 30000 };
const UUID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const UUID_B = "bbbbbbbb-1111-2222-3333-444444444444";

// ── pure ─────────────────────────────────────────────────────────────────

test("parseDevToolsActivePort: full file parses; partial or malformed reads are 'not yet'", () => {
  assert.deepStrictEqual(id.parseDevToolsActivePort(`9444\n/devtools/browser/${UUID_A}`), { port: 9444, browserPath: `/devtools/browser/${UUID_A}` });
  assert.deepStrictEqual(id.parseDevToolsActivePort(`9444\r\n/devtools/browser/${UUID_A}\n`), { port: 9444, browserPath: `/devtools/browser/${UUID_A}` });
  assert.strictEqual(id.parseDevToolsActivePort("9444\n"), null, "first line only (non-atomic write)");
  assert.strictEqual(id.parseDevToolsActivePort("9444\n/devtools/browser/aaaa"), null, "truncated uuid");
  assert.strictEqual(id.parseDevToolsActivePort(`0\n/devtools/browser/${UUID_A}`), null, "port 0");
  assert.strictEqual(id.parseDevToolsActivePort(`70000\n/devtools/browser/${UUID_A}`), null, "port > 65535");
  assert.strictEqual(id.parseDevToolsActivePort(""), null);
});

test("debugPortArg sees 0; extractDebugPort keeps returning null for 0", () => {
  assert.strictEqual(id.debugPortArg("brave --remote-debugging-port=0 --x"), 0);
  assert.strictEqual(id.debugPortArg("brave --remote-debugging-port=9341"), 9341);
  assert.strictEqual(id.debugPortArg("brave --type=renderer"), null);
  assert.strictEqual(pool.extractDebugPort("brave --remote-debugging-port=0"), null);
});

test("waitForDevToolsActivePort: a partial file is 'not yet' until the deadline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtap-"));
  try {
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "9444\n");
    setTimeout(() => fs.writeFileSync(path.join(dir, "DevToolsActivePort"), `9444\n/devtools/browser/${UUID_A}`), 150);
    const got = await id.waitForDevToolsActivePort(dir, { timeoutMs: 2000 });
    assert.strictEqual(got.port, 9444);
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "9444\n");
    await assert.rejects(id.waitForDevToolsActivePort(dir, { timeoutMs: 200 }), /did not appear/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("requireAbsoluteDir refuses a relative user-data-dir", () => {
  assert.throws(() => id.removeDevToolsActivePort("rel/dir"), /non-absolute/);
});

// ── decoys on real sockets ──────────────────────────────────────────────

/** An HTTP + ws CDP stand-in in THIS process. Records every request and ws
 *  connection so a test can assert the decoy was never dialled further. */
function decoyServer(host, port, uuid) {
  const WebSocket = require("ws");
  const hits = { http: 0, ws: 0 };
  const server = http.createServer((req, res) => {
    hits.http++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ Browser: "Decoy/1", webSocketDebuggerUrl: `ws://${host === "::1" ? "[::1]" : host}:${server.address().port}/devtools/browser/${uuid}` }));
  });
  const wss = new WebSocket.Server({ server });
  wss.on("connection", (ws) => { hits.ws++; ws.on("message", () => {}); });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ port: server.address().port, hits, close: () => new Promise((r) => { wss.close(); server.close(r); }) }));
  });
}

/** A child process whose command line looks like a Brave main process on
 *  `dir`, optionally serving CDP on host:port (http + ws; Browser.close is
 *  recorded to <dir>/closed). */
function fakeBrave(dir, { arg, listenHost, listenPort, uuid }) {
  const script = path.join(path.dirname(dir), "fake-brave-main.js");
  fs.writeFileSync(script, `
    const http = require("node:http"), fs = require("node:fs");
    const WebSocket = require(${JSON.stringify(path.join(REPO, "node_modules", "ws"))});
    const host = process.env.FB_HOST, port = Number(process.env.FB_PORT || 0), uuid = process.env.FB_UUID;
    if (!host) { console.log("READY"); setInterval(() => {}, 1000); return; }
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://" + (host === "::1" ? "[::1]" : host) + ":" + server.address().port + "/devtools/browser/" + uuid }));
    });
    new WebSocket.Server({ server }).on("connection", (ws) => ws.on("message", (m) => {
      if (JSON.parse(m).method === "Browser.close") { fs.writeFileSync(${JSON.stringify(path.join(dir, "closed"))}, "1"); ws.close(); }
    }));
    server.listen(port, host, () => console.log("READY " + server.address().port));
  `);
  return nodeChild(`require(${JSON.stringify(script)})`, {
    args: [`--user-data-dir=${dir}`, `--remote-debugging-port=${arg}`],
    env: { FB_HOST: listenHost || "", FB_PORT: String(listenPort || 0), FB_UUID: uuid || UUID_A },
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

test("attach-first (port 0): DevToolsActivePort naming a decoy with a DIFFERENT uuid is rejected; the right uuid is accepted", ISO, async () => {
  const dir = path.join(homeTmp("uuid-decoy-"), "profile");
  fs.mkdirSync(dir);
  const fb = fakeBrave(dir, { arg: 0 });
  await fb.waitLine(/^READY/);
  const decoy = await decoyServer("127.0.0.1", 0, UUID_B);
  try {
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), `${decoy.port}\n/devtools/browser/${UUID_A}`);
    assert.strictEqual(await pool.findAttachableBrave(dir), null, "a listener naming another browser's uuid is not ours");
    // Positive control: the same setup with the matching uuid IS attachable.
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), `${decoy.port}\n/devtools/browser/${UUID_B}`);
    const ok = await pool.findAttachableBrave(dir);
    assert.ok(ok, "control: matching uuid must attach");
    assert.strictEqual(ok.pid, fb.child.pid);
    assert.strictEqual(ok.wsEndpoint, `ws://127.0.0.1:${decoy.port}/devtools/browser/${UUID_B}`);
  } finally {
    await decoy.close();
    await killAndWait(fb.child);
  }
});

test("attach-first (legacy port N, the F9 orientation): the process on OUR dir listens on [::1]:N, a DIFFERENT process holds 127.0.0.1:N → rejected", ISO, async () => {
  const dir = path.join(homeTmp("f9-decoy-"), "profile");
  fs.mkdirSync(dir);
  // Bind the decoy first (a peer lane's Brave on 127.0.0.1:N) …
  const decoy = await decoyServer("127.0.0.1", 0, UUID_B);
  // … then the Brave on our dir, which "fell back" to [::1]:N.
  const fb = fakeBrave(dir, { arg: decoy.port, listenHost: "::1", listenPort: decoy.port });
  try {
    assert.match(await fb.waitLine(/^READY/), new RegExp(`READY ${decoy.port}$`), "precondition: both listen on the same port number");
    assert.strictEqual(await pool.findAttachableBrave(dir), null, "must not attach to the peer's Brave");
    assert.strictEqual(decoy.hits.ws, 0);
    // doctor --reap-orphans must not send Browser.close to the peer either.
    const { closeViaCdp } = require("../scripts/doctor.js");
    const procs = require("../src/process-shim.js").listProcessesByCommand("brave").filter((p) => p.pid === fb.child.pid);
    assert.strictEqual(procs.length, 1);
    assert.strictEqual(await closeViaCdp(procs[0], dir), false);
    assert.strictEqual(decoy.hits.ws, 0, "no CDP connection was opened to the peer's browser");
  } finally {
    await decoy.close();
    await killAndWait(fb.child);
  }
});

test("attach-first (legacy port N), control: the process on our dir itself listens on 127.0.0.1:N → attachable; doctor closes it over CDP", ISO, async () => {
  const dir = path.join(homeTmp("legacy-ok-"), "profile");
  fs.mkdirSync(dir);
  const port = await freePort();
  const fb = fakeBrave(dir, { arg: port, listenHost: "127.0.0.1", listenPort: port, uuid: UUID_A });
  try {
    await fb.waitLine(/^READY/);
    const ok = await pool.findAttachableBrave(dir);
    assert.ok(ok);
    assert.deepStrictEqual(ok, { pid: fb.child.pid, port, wsEndpoint: `ws://127.0.0.1:${port}/devtools/browser/${UUID_A}`, legacy: true });
    const { closeViaCdp } = require("../scripts/doctor.js");
    const proc = require("../src/process-shim.js").listProcessesByCommand("brave").find((p) => p.pid === fb.child.pid);
    assert.strictEqual(await closeViaCdp(proc, dir), true);
    assert.ok(fs.existsSync(path.join(dir, "closed")), "Browser.close reached the RIGHT browser");
  } finally {
    await killAndWait(fb.child);
  }
});
