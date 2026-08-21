'use strict';

// The coalescer guards two things that pull in opposite directions: an interactive
// change must still reach the renderer immediately, and a machine-driven burst must
// not.

const assert = require('assert');
const { createLeadingCoalescer } = require('../src/coalesce');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

// Controllable clock + timer so no test waits on wall-clock time.
function harness(minIntervalMs = 120) {
  const calls = [];
  let clock = 1000;
  let queued = null;
  const c = createLeadingCoalescer({
    run: () => calls.push(clock),
    minIntervalMs,
    now: () => clock,
    setTimer: (fn, ms) => { queued = { fn, at: clock + ms }; return 1; },
    clearTimer: () => { queued = null; },
  });
  return {
    c, calls,
    tick(ms) {
      clock += ms;
      if (queued && clock >= queued.at) { const { fn } = queued; queued = null; fn(); }
    },
    hasTimer: () => queued !== null,
  };
}

{
  const h = harness();
  h.c.request();
  ok('a single change runs immediately — interactive timing is unchanged', h.calls.length === 1);
}

{
  const h = harness();
  h.c.request();
  ok('first of a burst runs at once', h.calls.length === 1);
  for (let i = 0; i < 500; i++) h.c.request();
  ok('the following 500 do not each run', h.calls.length === 1 && h.c.isPending());
  h.tick(120);
  ok('the whole burst collapses into ONE trailing run', h.calls.length === 2);
  ok('and nothing is left scheduled', !h.c.isPending());
}

{
  const h = harness();
  h.c.request();
  h.tick(500);              // long gap — well past the window
  h.c.request();
  ok('a change after a quiet period runs immediately again', h.calls.length === 2 && !h.c.isPending());
}

{
  const h = harness();
  h.c.request();
  h.c.request();
  ok('trailing run is scheduled, not yet fired', h.calls.length === 1 && h.c.isPending());
  h.tick(60);
  ok('...and does not fire early', h.calls.length === 1);
  h.tick(60);
  ok('...but does fire once the window elapses', h.calls.length === 2);
}

{
  const h = harness();
  h.c.request();
  h.c.request();
  ok('flush runs the outstanding request now', h.c.flush() === true && h.calls.length === 2);
  ok('flush with nothing outstanding does nothing', h.c.flush() === false && h.calls.length === 2);
}

{
  const h = harness();
  h.c.request();
  h.c.request();
  h.c.dispose();
  h.tick(500);
  ok('dispose drops the pending run', h.calls.length === 1 && !h.hasTimer());
}

{
  const h = harness();
  h.c.request();
  for (let i = 0; i < 9; i++) h.c.request();
  h.tick(120);
  const s = h.c.stats();
  ok('stats report what was collapsed', s.runs === 2 && s.suppressed === 9);
}

{
  let threw = false;
  try { createLeadingCoalescer({}); } catch { threw = true; }
  ok('a missing run() is rejected loudly rather than silently doing nothing', threw);
}

console.log(`\nAll ${passed} coalesce tests passed.`);
