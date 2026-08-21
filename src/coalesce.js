'use strict';

// Leading-edge coalescer: run now, then at most once per interval.
//
// Built for broadcastConfig(). A single user action must still reach the renderer
// immediately — the Library grid has a documented dependency on the broadcast
// arriving before the IPC reply, and delaying it would change that ordering. What
// must NOT reach the renderer 121 000 times is a machine-driven burst (auto-tagging
// a folder), where each broadcast structured-clones the whole pool.
//
// So: the first call runs synchronously, and everything arriving inside the window
// collapses into one trailing run. Interactive paths keep today's timing because
// they are never inside a burst; bursts pay once per interval instead of per edit.
//
// Timers and the clock are injected so this is testable without wall-clock waits.

function createLeadingCoalescer({
  run,
  minIntervalMs = 120,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => Date.now(),
} = {}) {
  if (typeof run !== 'function') throw new TypeError('createLeadingCoalescer needs a run() function');
  let lastRunAt = -Infinity;
  let timer = null;
  let runs = 0;
  let suppressed = 0;

  function fire() {
    timer = null;
    lastRunAt = now();
    runs++;
    run();
  }

  return {
    request() {
      if (timer) { suppressed++; return false; }   // a trailing run already covers this
      const since = now() - lastRunAt;
      if (since >= minIntervalMs) { fire(); return true; }
      suppressed++;
      timer = setTimer(fire, minIntervalMs - since);
      return false;
    },
    // Run any outstanding request right away (shutdown, or before something that
    // must observe the latest state).
    flush() {
      if (!timer) return false;
      clearTimer(timer);
      fire();
      return true;
    },
    isPending() { return timer !== null; },
    stats() { return { runs, suppressed }; },
    dispose() { if (timer) clearTimer(timer); timer = null; },
  };
}

module.exports = { createLeadingCoalescer };
