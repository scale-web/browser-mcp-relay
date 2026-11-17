// _pin-lock.js — forwarded upstream calls vs. the re-pins of tabs_new /
// tabs_select (review r1 L2, 2026-11-17).
//
// relay-server takes a SHARED hold for a forwarded call, from its re-pin
// (pinUpstreamToActivePage), through the policy's check of upstream's page
// (plain-flags' field check before interaction_fill / select / press-key), to
// the end of the upstream call. tabs_new / tabs_select run EXCLUSIVE. So the
// check and the call it allows act on one tab, and a pin never moves under a
// running call. A waiting exclusive goes before shared holds asked for after it
// (no starvation by a stream of calls). Not re-entrant: nothing that holds it
// may wait for it again.

let readers = 0;
let writer = false;
const queue = []; // { exclusive, resolve }, FIFO

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

/** Resolves to release(); a second release() is a no-op. */
function acquire(exclusive) {
  return new Promise((resolve) => { queue.push({ exclusive, resolve }); grant(); }).then(() => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (exclusive) writer = false; else readers--;
      grant();
    };
  });
}

module.exports = { shared: () => acquire(false), exclusive: () => acquire(true) };
