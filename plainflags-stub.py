#!/usr/bin/python3
"""plainflags-stub.py — the plain-flags relay, started only when it is used.

Claude Code runs this in place of the plain-flags relay (docs/REFERENCE.md,
"The lazy stub"). Until a tool is called it answers the MCP handshake itself —
initialize, notifications/initialized, ping and tools/list — from
plainflags-tools.json, which scripts/gen-plainflags-tools.js writes from the
real relay and test/plainflags-stub-drift.test.js keeps equal to it. Methods the
relay does not implement (Claude Code's opening `server/discover`, resources/*,
prompts/*, …) get the relay's own recorded "Method not found" from the same file,
and nothing starts the relay before the client's initialize. The first other
request after it starts the real relay (launch-project-isolated.js beside this
file, BROWSER_RELAY_PROFILE_MODE=plainflags forced), replays the client's
initialize to it, and from then on every line is passed through unchanged, both
ways. Only the stub's own two requests (the replayed initialize, a tools/list
check) carry the stub's own ids, and their answers never reach the client.

stderr: method names, ids, sizes and the relay's lifecycle only — never a
message body (tool arguments can hold typed text). The relay writes to the
stub's stderr itself (inherited, not piped: a pipe to a SIGKILLed stub left the
relay and its Brave running).

Python 3.9 stdlib only (/usr/bin/python3 on macOS).
"""
import json
import os
import select
import signal
import sys
import time

HERE = os.path.dirname(os.path.realpath(__file__))
LAUNCHER = os.path.join(HERE, "launch-project-isolated.js")
TOOLS_FILE = os.path.join(HERE, "plainflags-tools.json")
TMPDIR_TOKEN = "${os.tmpdir()}"

# Tests only: a fake relay to start instead, and "init,restart,grace" seconds.
# Honoured only for a file under the temp dir the env names (TMPDIR), else the
# stub refuses to run — a guard against a leftover setting, not a boundary.
TEST_CHILD_ENV = "PLAINFLAGS_STUB_TEST_CHILD"
TEST_TIMINGS_ENV = "PLAINFLAGS_STUB_TEST_TIMINGS"

INIT_TIMEOUT_S = 30.0   # the relay must answer the replayed initialize in this
RESTART_EVERY_S = 30.0  # at most one start per this
EXIT_GRACE_S = 10.0     # after SIGTERM, before it and its process tree are SIGKILLed

INIT_ID = "plainflags-stub:initialize"
LIST_ID = "plainflags-stub:tools/list"
ERROR_CODE = -32000


def log(text):
    try:
        os.write(2, ("[plainflags-stub] %s\n" % text).encode())
    except OSError:
        pass


def show_id(i):
    """An integer id as is; any other id by its type only."""
    return str(i) if isinstance(i, int) and not isinstance(i, bool) else "<%s>" % type(i).__name__


def key(i):
    return json.dumps(i, sort_keys=True)


def parse(line):
    try:
        msg = json.loads(line)
    except ValueError:
        return None
    return msg if isinstance(msg, dict) else None


def node_tmpdir():
    """os.tmpdir() as Node computes it on POSIX."""
    p = os.environ.get("TMPDIR") or os.environ.get("TMP") or os.environ.get("TEMP") or "/tmp"
    return p[:-1] if len(p) > 1 and p.endswith("/") else p


def untokenize(v, tmp):
    if isinstance(v, str):
        return tmp if v == TMPDIR_TOKEN else v
    if isinstance(v, list):
        return [untokenize(x, tmp) for x in v]
    if isinstance(v, dict):
        return {k: untokenize(x, tmp) for k, x in v.items()}
    return v


def ps_table():
    """{pid: (ppid, start time)} for every process — read only."""
    import subprocess
    try:
        out = subprocess.run(["/bin/ps", "-axo", "pid=,ppid=,lstart="], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, universal_newlines=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    rows = {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            rows[int(parts[0])] = (int(parts[1]), parts[2].strip())
    return rows


def descendants(root, rows):
    kids = {}
    for pid, (ppid, _) in rows.items():
        kids.setdefault(ppid, []).append(pid)
    out, todo = [], [root]
    while todo:
        for c in kids.get(todo.pop(), []):
            out.append(c)
            todo.append(c)
    return out


def kill_targets(relay, rows, remembered):
    """The relay's live descendants, plus remembered ones ({pid: start time})
    now orphaned: same start time (not a reused pid) and a parent that is pid 1
    or the relay's tree. Never the relay itself, pid 1 or the stub."""
    live = set(descendants(relay, rows))
    known = set(remembered) | live | {relay}
    left = {c for c, start in remembered.items()
            if c in rows and rows[c][1] == start and (rows[c][0] == 1 or rows[c][0] in known)}
    return (live | left) - {relay, 1, os.getpid()}


def load_tools_file():
    try:
        with open(TOOLS_FILE, "rb") as f:
            s = json.load(f)
        protocol, server, tools = s["protocol"], s["initialize"], s["toolsList"]
        if not (isinstance(protocol["supported"], list) and protocol["latest"] and isinstance(tools["tools"], list)):
            raise ValueError("shape")
        # Only "Method not found" replies are served: stateless, the relay's answer whatever its state.
        not_found = {m: r["error"] for m, r in s["otherMethods"].items()
                     if isinstance(r, dict) and isinstance(r.get("error"), dict) and r["error"].get("code") == -32601}
    except (OSError, ValueError, KeyError, TypeError) as e:
        log("%s is unreadable (%s) — cannot answer the handshake; regenerate it (scripts/gen-plainflags-tools.js)"
            % (TOOLS_FILE, type(e).__name__))
        sys.exit(2)
    return protocol, server, untokenize(tools, node_tmpdir()), not_found


def test_overrides():
    """(child script, timings) — the real launcher and 30/30/10 s unless a test asks."""
    script = os.environ.get(TEST_CHILD_ENV)
    if not script:
        return LAUNCHER, (INIT_TIMEOUT_S, RESTART_EVERY_S, EXIT_GRACE_S)
    import tempfile
    real = os.path.realpath(script)
    if not real.startswith(os.path.realpath(tempfile.gettempdir()) + os.sep) or not os.path.isfile(real):
        log("%s is set but is not a file under the temp dir — refusing to run" % TEST_CHILD_ENV)
        sys.exit(2)
    timings = (INIT_TIMEOUT_S, RESTART_EVERY_S, EXIT_GRACE_S)
    if os.environ.get(TEST_TIMINGS_ENV):
        timings = tuple(float(x) for x in os.environ[TEST_TIMINGS_ENV].split(","))
    return real, timings


class Stub:
    def __init__(self):
        self.protocol, self.server, self.tools, self.not_found = load_tools_file()
        self.script, (self.init_timeout, self.restart_every, self.exit_grace) = test_overrides()
        self.client_init = None  # params of the client's initialize, replayed to the relay
        self.proc = None
        self.state = "idle"      # idle | starting | ready | failed
        self.why = None          # the last failure, for error replies
        self.last_start = None
        self.started_at = None
        self.queue = []          # (line, msg) that arrived while the relay was starting
        self.inflight = {}       # key(id) -> id: requests the relay has not answered
        self.deadline = None     # replayed-initialize timeout, or the exit grace
        self.stopping = False
        self.stdin_open = True
        self.bufs = {}
        self.signalled = None
        self.tree = {}           # the relay's descendants when last seen: {pid: start time}
        self.tree_at = 0.0

    # ── output ────────────────────────────────────────────────────────────────

    def write(self, fd, data):
        while data:
            n = os.write(fd, data)
            data = data[n:]

    def to_client(self, line):
        try:
            self.write(1, line + b"\n")
        except OSError:
            self.begin_stop("stdout closed")

    def to_client_msg(self, msg):
        self.to_client(json.dumps(msg, separators=(",", ":")).encode())

    def to_child(self, line):
        try:
            self.write(self.proc.stdin.fileno(), line + b"\n")
        except (OSError, ValueError):
            pass  # the relay is gone: its stdout's EOF reports that

    def to_child_msg(self, msg):
        self.to_child(json.dumps(msg, separators=(",", ":")).encode())

    def reply_error(self, i, text):
        log("error reply id=%s" % show_id(i))
        self.to_client_msg({"jsonrpc": "2.0", "id": i, "error": {"code": ERROR_CODE, "message": "[plainflags-stub] " + text}})

    # ── from the client ───────────────────────────────────────────────────────

    def from_client(self, line):
        msg = parse(line)
        method = msg.get("method") if msg and isinstance(msg.get("method"), str) else None  # logged: a name only
        is_request = method is not None and "id" in msg
        if method in ("initialize", "notifications/initialized") or (
                method in ("ping", "tools/list") and self.state != "ready"):
            return self.answer(msg, method) if is_request else None
        if is_request and method in self.not_found and self.state != "ready":
            log("%s id=%s answered by the stub (the relay's Method not found)" % (method, show_id(msg["id"])))
            return self.to_client_msg({"jsonrpc": "2.0", "id": msg["id"], "error": self.not_found[method]})
        if self.state == "ready":
            return self.forward(line, msg)
        if self.state == "starting":
            self.queue.append((line, msg))
            return None
        if not is_request:
            log("dropped %s (%d bytes): no relay running" % (method or "a non-request line", len(line)))
            return None
        if self.client_init is None:
            # Never start the relay on a made-up initialize: before the client's own, refuse.
            log("%s id=%s before initialize — refused, the relay is not started" % (method, show_id(msg["id"])))
            return self.to_client_msg({"jsonrpc": "2.0", "id": msg["id"], "error": {
                "code": -32600, "message": "[plainflags-stub] %s before initialize: the plain-flags relay starts only "
                                           "after the client's initialize" % method}})
        if self.state == "failed" and time.monotonic() - self.last_start < self.restart_every:
            left = self.restart_every - (time.monotonic() - self.last_start)
            return self.reply_error(msg["id"], "%s; it is started again at most once per %d s — retry in %d s."
                                    % (self.why, self.restart_every, left + 1))
        log("%s id=%s (%d bytes) — starting the plain-flags relay" % (method, show_id(msg["id"]), len(line)))
        self.queue.append((line, msg))
        self.start()
        return None

    def answer(self, msg, method):
        if method == "initialize":
            params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
            self.client_init = params
            asked = params.get("protocolVersion")
            version = asked if asked in self.protocol["supported"] else self.protocol["latest"]
            caps = dict(self.server.get("capabilities") or {})
            # The relay advertises tools: {}; listChanged lets the client honour
            # the stub's notification when the relay's list differs from the file.
            caps["tools"] = dict(caps.get("tools") or {}, listChanged=True)
            result = dict({"protocolVersion": version}, **dict(self.server, capabilities=caps))
        elif method == "tools/list":
            result = self.tools
        else:  # ping
            result = {}
        self.to_client_msg({"jsonrpc": "2.0", "id": msg["id"], "result": result})

    def forward(self, line, msg):
        if msg and isinstance(msg.get("method"), str) and "id" in msg:
            self.inflight[key(msg["id"])] = msg["id"]
        elif msg and msg.get("method") == "notifications/cancelled" and isinstance(msg.get("params"), dict):
            self.inflight.pop(key(msg["params"].get("requestId")), None)
        self.to_child(line)

    # ── the relay ─────────────────────────────────────────────────────────────

    def start(self):
        import subprocess
        self.last_start = self.started_at = time.monotonic()
        env = dict(os.environ, BROWSER_RELAY_PROFILE_MODE="plainflags")
        try:
            self.proc = subprocess.Popen(
                ["node", self.script], stdin=subprocess.PIPE, stdout=subprocess.PIPE,  # stderr: the stub's own
                env=env, bufsize=0)  # the caller's process group, as a direct launch: a group kill takes it too
        except OSError as e:
            self.proc = None
            return self.fail("could not be started (%s)" % (e.strerror or type(e).__name__))
        self.state = "starting"
        self.tree, self.tree_at = {}, 0.0
        self.deadline = time.monotonic() + self.init_timeout
        log("relay pid=%d starting" % self.proc.pid)
        self.to_child_msg({"jsonrpc": "2.0", "id": INIT_ID, "method": "initialize", "params": self.client_init})
        return None

    def from_child(self, line):
        if time.monotonic() - self.tree_at >= 5.0:
            self.note_tree()
        msg = parse(line)
        if msg and "method" not in msg and "id" in msg:
            if msg["id"] == INIT_ID:
                return self.on_relay_init(msg)
            if msg["id"] == LIST_ID:
                return self.on_relay_list(msg)
            self.inflight.pop(key(msg["id"]), None)
        self.to_client(line)
        return None

    def on_relay_init(self, msg):
        if self.state != "starting":
            return
        if "result" not in msg:
            return self.end_relay("refused the replayed initialize")
        self.state, self.deadline = "ready", None
        self.note_tree()
        log("relay pid=%d ready in %d ms" % (self.proc.pid, (time.monotonic() - self.started_at) * 1000))
        self.to_child_msg({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.to_child_msg({"jsonrpc": "2.0", "id": LIST_ID, "method": "tools/list", "params": {}})
        queued, self.queue = self.queue, []
        for line, m in queued:
            self.forward(line, m)

    def on_relay_list(self, msg):
        result = msg.get("result")
        if not isinstance(result, dict):
            return log("WARN the relay's tools/list failed — still serving plainflags-tools.json's list")
        if result != self.tools:
            log("WARN the relay's tools/list differs from plainflags-tools.json (%d vs %d tools) — serving the "
                "relay's and sending notifications/tools/list_changed; regenerate the file"
                % (len(result.get("tools") or []), len(self.tools.get("tools") or [])))
            self.tools = result
            self.to_client_msg({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
        return None

    def note_tree(self):
        """Remember the relay's descendants (upstream, Brave, …): once the relay
        exits they are reparented to pid 1 and no walk from it finds them."""
        rows = ps_table()
        self.tree = {c: rows[c][1] for c in descendants(self.proc.pid, rows)}
        self.tree_at = time.monotonic()

    def kill_tree(self):
        """SIGKILL the relay (not reaped yet, so its pid is still ours) and every
        process that is — or was, and is now orphaned — its descendant. A
        remembered pid counts only with the same start time, and only while its
        parent is pid 1 or the relay's tree: never anything that was not the relay's."""
        p = self.proc
        for pid in [p.pid] + sorted(kill_targets(p.pid, ps_table(), self.tree)):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass

    def end_relay(self, why=None):
        """The relay is gone or must go: SIGKILL it and its process tree, reap
        it, and answer everything that waited on it with an error."""
        p = self.proc
        self.kill_tree()
        code = p.wait()
        for f in (p.stdout, p.stdin):
            try:
                f.close()
            except OSError:
                pass
        self.bufs.clear()
        self.proc, self.deadline = None, None
        if why is None:
            why = "exited (code %d)" % code if code >= 0 else "was killed (signal %d)" % -code
        self.why, self.state = "the plain-flags relay " + why, "failed"
        log("relay pid=%d %s" % (p.pid, why))
        waiting = list(self.inflight.values()) + [m["id"] for _, m in self.queue
                                                 if m and isinstance(m.get("method"), str) and "id" in m]
        self.inflight, self.queue = {}, []
        for i in waiting:
            self.reply_error(i, "%s — this request did not complete. The next request starts it again "
                                "(at most once per %d s)." % (self.why, self.restart_every))

    def fail(self, why):
        self.why, self.state = "the plain-flags relay " + why, "failed"
        log(self.why)
        queued, self.queue = self.queue, []
        for _, m in queued:
            if m and isinstance(m.get("method"), str) and "id" in m:
                self.reply_error(m["id"], "%s. The next request tries again (at most once per %d s)."
                                 % (self.why, self.restart_every))

    # ── lifecycle ─────────────────────────────────────────────────────────────

    def begin_stop(self, why):
        if self.stopping:
            return
        self.stopping = True
        log("%s — stopping" % why)
        if self.proc is None:
            return
        self.note_tree()  # while the tree is intact
        try:
            self.proc.stdin.close()  # the relay shuts itself down on stdin EOF…
        except OSError:
            pass
        try:
            os.kill(self.proc.pid, signal.SIGTERM)  # …and on SIGTERM; not reaped yet, so the pid is still ours
        except OSError:
            pass
        self.deadline = time.monotonic() + self.exit_grace

    def on_deadline(self):
        if self.stopping:
            log("relay pid=%d still running %d s after SIGTERM — killing its process tree"
                % (self.proc.pid, self.exit_grace))
            self.end_relay("was stopped")
        else:
            self.end_relay("did not answer initialize within %d s — its process tree was killed" % self.init_timeout)

    def on_signal(self, signum, _frame):
        self.signalled = signum

    def lines(self, fd, data):
        parts = self.bufs.setdefault(fd, [])
        out = []
        while True:
            i = data.find(b"\n")
            if i < 0:
                break
            parts.append(data[:i])
            out.append(b"".join(parts))
            parts.clear()
            data = data[i + 1:]
        if data:
            parts.append(data)
        return [x for x in out if x.strip()]

    def run(self):
        wake_r, wake_w = os.pipe()
        os.set_blocking(wake_r, False)
        os.set_blocking(wake_w, False)
        signal.set_wakeup_fd(wake_w)
        for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(s, self.on_signal)
        while not (self.stopping and self.proc is None):
            fds = [wake_r]
            if self.stdin_open and not self.stopping:
                fds.append(0)
            if self.proc is not None:
                fds.append(self.proc.stdout.fileno())
            timeout = None if self.deadline is None else max(0.0, self.deadline - time.monotonic())
            readable = select.select(fds, [], [], timeout)[0]
            relay = self.proc
            for fd in readable:
                if self.proc is not relay:
                    break  # the relay ended or was replaced: its fds (numbers may be reused) are re-selected
                if fd == wake_r:
                    try:
                        os.read(wake_r, 512)
                    except OSError:
                        pass
                    continue
                data = os.read(fd, 1 << 20)
                if fd == 0:
                    if not data:
                        self.stdin_open = False
                        self.begin_stop("stdin closed")
                    for line in self.lines(0, data):
                        self.from_client(line)
                elif not data:  # the relay's stdout: EOF = it exited
                    self.end_relay()
                else:
                    for line in self.lines(fd, data):
                        self.from_child(line)
                        if self.proc is None:
                            break
            if self.signalled is not None:
                self.begin_stop(signal.Signals(self.signalled).name)
                self.signalled = None
            if self.deadline is not None and time.monotonic() >= self.deadline and self.proc is not None:
                self.on_deadline()
        log("exit")


if __name__ == "__main__":
    Stub().run()
