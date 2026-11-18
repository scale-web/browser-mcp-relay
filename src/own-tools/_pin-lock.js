// _pin-lock.js — forwarded upstream calls vs. the re-pins of tabs_new /
// tabs_select (review r1 L2, 2026-11-17).
//
// relay-server takes a SHARED hold for a forwarded call, from its re-pin
// (pinUpstreamToActivePage), through the policy's check of upstream's page
// (plain-flags' field check before interaction_fill / select / press-key), to
// the end of the upstream call. tabs_new / tabs_select run EXCLUSIVE, taken
// when the call arrives (before the policy and ensureBrave steps), so a
// forwarded call sent after a tabs_* call waits for it. So the check and the
// call it allows act on one tab, and a pin never moves under a running call. A
// waiting exclusive goes before shared holds asked for after it (no starvation
// by a stream of calls). Not re-entrant: nothing that holds it may wait for it
// again.
//
// Bounded waits (review of 140cf47, L3): a hung upstream call holds its shared
// hold until upstream answers or its 180 s request timeout. An acquire with
// `waitMs` gives up after that long, and one with `signal` when it aborts; it
// rejects with an Error (code PIN_LOCK_TIMEOUT / PIN_LOCK_ABORTED) whose
// `holders` names what held the lock (and `sharedHeld` says whether a shared
// hold was among them), and leaves the queue as if it had never asked. A hold already granted is NOT released when its caller aborts: the
// upstream call keeps running in upstream (a cancel is not forwarded), and
// moving the pin under it could send the rest of it to another tab.

let readers = 0;
let writer = false;
const queue = []; // { exclusive, resolve }, FIFO
const holders = new Set(); // { label, since }

function grant() {
  while (queue.length > 0) {
    const next = queue[0];
    if (next.exclusive) {
      if (readers === 0 && !writer) { queue.shift(); writer = true; next.resolve(); }
      return;
    }
    if (writer) return;
    queue.shift();
    readers++;
    next.resolve();
  }
}

/** What holds the lock now: "name (running N s)", oldest first. */
function describeHolders(now = Date.now()) {
  return [...holders].map((h) => `${h.label} (running ${Math.round((now - h.since) / 1000)} s)`);
}

/** Whether a shared hold (a forwarded upstream call) is among the holders. */
function sharedHeld() {
  return [...holders].some((h) => !h.exclusive);
}

/** Resolves to release(); a second release() is a no-op. Rejects when `waitMs`
 *  passes or `signal` aborts before the hold is granted (see the header). */
function acquire(exclusive, { label = "(unnamed)", waitMs = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const entry = { exclusive, resolve: null };
    const onAbort = () => giveUp("PIN_LOCK_ABORTED", "the caller cancelled the request while it waited");
    const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); };
    function giveUp(code, why) {
      const i = queue.indexOf(entry);
      if (i < 0) return; // granted already
      const e = new Error(why);
      e.code = code;
      e.holders = describeHolders(); // what it waited for, before the grant below
      e.sharedHeld = sharedHeld();
      queue.splice(i, 1);
      done();
      grant(); // a removed exclusive may have held back shared holds behind it
      reject(e);
    }
    entry.resolve = () => {
      done();
      const h = { label, since: Date.now(), exclusive };
      holders.add(h);
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        holders.delete(h);
        if (exclusive) writer = false; else readers--;
        grant();
      });
    };
    if (signal && signal.aborted) {
      const e = new Error("the caller cancelled the request before it ran");
      e.code = "PIN_LOCK_ABORTED";
      e.holders = describeHolders();
      e.sharedHeld = sharedHeld();
      return reject(e);
    }
    queue.push(entry);
    if (Number.isFinite(waitMs)) timer = setTimeout(() => giveUp("PIN_LOCK_TIMEOUT", `waited ${waitMs} ms`), waitMs);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    grant();
  });
}

module.exports = {
  shared: (opts) => acquire(false, opts),
  exclusive: (opts) => acquire(true, opts),
  describeHolders,
};
