// test/helpers/plainflags-live.js — what the REAL plain-flags relay answers to
// `initialize` and `tools/list`, in the shape of plainflags-tools.json (the
// file plainflags-stub.py answers the handshake from). Used by
// scripts/gen-plainflags-tools.js (writes the file) and
// test/plainflags-stub-drift.test.js (fails when the file is stale).
//
// Harness only (temp HOME). No Brave starts: neither request needs one — the
// relay asks only its upstream child for the catalog.

const fs = require("node:fs");
const path = require("node:path");
const types = require("@modelcontextprotocol/sdk/types.js");
const { REPO, homeTmp } = require("./isolation.js");
const { startRelay } = require("./mcp.js");

const TOOLS_FILE = path.join(REPO, "plainflags-tools.json");
// Upstream puts the relay's os.tmpdir() into two schema defaults (screenshot
// outputPath). The file holds this token instead — the stub puts back its own
// env's value, computed as Node does — so the file is the same on every machine.
const TMPDIR_TOKEN = "${os.tmpdir()}";

function tokenizeTmpdir(v, tmp) {
  if (typeof v === "string") return v === tmp ? TMPDIR_TOKEN : v;
  if (Array.isArray(v)) return v.map((x) => tokenizeTmpdir(x, tmp));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tokenizeTmpdir(x, tmp)]));
  return v;
}

/** The parts of the file that must equal the live relay (everything but the note). */
function comparable(file) {
  return { protocol: file.protocol, initialize: file.initialize, toolsList: file.toolsList };
}

async function captureLive() {
  const home = homeTmp("pf-tools-");
  // The sign-in list and the ask store under the temp HOME (never the repo's
  // plainflags-signin.json); the known accounts stay the real list.
  const signin = path.join(home, "plainflags-signin.json");
  fs.writeFileSync(signin, JSON.stringify({ accounts: [] }));
  const fixture = path.join(home, "fixture.json");
  fs.writeFileSync(fixture, JSON.stringify({ signinFile: signin, asksDir: path.join(home, "no-asks") }));
  const r = await startRelay({
    env: {
      HOME: home,
      CLAUDE_PROJECT_DIR: path.join(home, "proj-pf-tools"),
      BROWSER_RELAY_TEST_LAUNCH: "1",
      BROWSER_HEADLESS_ENABLE: "true",
      TELEMETRY_ENABLE: "false",
      BROWSER_RELAY_PROFILE_MODE: "plainflags",
      BROWSER_RELAY_TEST_PLAINFLAGS_FIXTURE: fixture,
    },
    realUpstream: true,
  });
  try {
    const toolsList = await r.request("tools/list", {}, 60000);
    const { protocolVersion, ...initialize } = r.init; // negotiated per client: the stub does that itself
    return {
      // The relay's MCP SDK: an offered version it supports is echoed, any other gets `latest`.
      protocol: { latest: types.LATEST_PROTOCOL_VERSION, supported: [...types.SUPPORTED_PROTOCOL_VERSIONS] },
      initialize,
      // The relay inherits this process's TMPDIR, so its os.tmpdir() is ours.
      toolsList: tokenizeTmpdir(toolsList, require("node:os").tmpdir()),
    };
  } finally {
    await r.stop();
  }
}

module.exports = { captureLive, comparable, TOOLS_FILE, TMPDIR_TOKEN };
