'use strict';

const assert = require('assert');
const { createRendererProbe } = require('../diagnostics/renderer/probe');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  OK ' + name);
  passed++;
};

// Deterministic harness: manual clocks, manual rAF, manual timers, fake document/window.
function makeHarness({ withObserver = true, visibility = 'visible' } = {}) {
  const h = {
    wall: 1_000_000,
    perf: 0,
    batches: [],
    rafQueue: [],
    timers: new Map(),
    timerId: 1,
    docListeners: {},
    winListeners: {},
    visibility,
    observerInstances: [],
  };
  const doc = {
    get visibilityState() { return h.visibility; },
    addEventListener: (name, fn) => { h.docListeners[name] = fn; },
    removeEventListener: (name) => { delete h.docListeners[name]; },
  };
  const win = {
    addEventListener: (name, fn) => { h.winListeners[name] = fn; },
    removeEventListener: (name) => { delete h.winListeners[name]; },
  };
  function FakeObserver(cb) {
    this.cb = cb;
    this.observed = null;
    h.observerInstances.push(this);
  }
  FakeObserver.prototype.observe = function observe(opts) { this.observed = opts; };
  FakeObserver.prototype.disconnect = function disconnect() { this.observed = null; };
  FakeObserver.supportedEntryTypes = ['longtask', 'paint'];

  const probe = createRendererProbe({
    role: 'renderer-main',
    send: (events) => h.batches.push(events),
    now: () => h.wall,
    perfNow: () => h.perf,
    raf: (fn) => { h.rafQueue.push(fn); return h.rafQueue.length; },
    caf: () => {},
    doc,
    win,
    PerfObserver: withObserver ? FakeObserver : null,
    heapUsed: () => 50 * 1024 * 1024,
    countNodes: () => 4200,
    countCards: () => 128,
    batchMs: 400,
    longFrameMs: 50,
    sampleMs: 2000,
    setTimeoutFn: (fn, ms) => { const id = h.timerId++; h.timers.set(id, { fn, ms }); return id; },
    clearTimeoutFn: (id) => { h.timers.delete(id); },
  });

  // Drive one rAF callback with a given monotonic delta since the previous frame.
  h.frame = (deltaMs) => {
    h.perf += deltaMs;
    const fn = h.rafQueue.shift();
    if (fn) fn();
  };
  // Fire the timer whose interval matches ms (batch=400, sample=2000).
  h.fireTimer = (ms) => {
    for (const [id, timer] of h.timers) {
      if (timer.ms === ms) { h.timers.delete(id); timer.fn(); return true; }
    }
    return false;
  };
  h.probe = probe;
  h.allEvents = () => h.batches.flat();
  return h;
}

(() => {
  // --- Frame-gap aggregation ---
  const h = makeHarness();
  h.probe.start();
  ok('start schedules a rAF frame and a batch timer', h.rafQueue.length === 1 && [...h.timers.values()].some((t) => t.ms === 400));

  // First frame sets the baseline (no gap yet), then a run of good frames + one stutter.
  h.frame(0);   // baseline
  h.frame(16);  // good
  h.frame(17);  // good
  h.frame(120); // stutter (> 50ms long-frame threshold)
  h.frame(16);  // good
  h.fireTimer(400); // batch flush → frame-window sample
  const frameWindow = h.allEvents().find((e) => e.name === 'frame-window');
  ok('frame-window aggregates gaps without per-frame IPC', frameWindow &&
    frameWindow.kind === 'sample' &&
    frameWindow.attributes.count === 4 &&
    frameWindow.attributes.maxMs === 120 &&
    frameWindow.attributes.longFrames === 1);
  ok('nominal interval is the smallest gap, not an assumed 60Hz', frameWindow.attributes.nominalMs === 16);
  ok('frame events carry the renderer role', frameWindow.source.role === 'renderer-main');

  // --- Hidden window must not become a fake multi-second stall ---
  h.batches.length = 0;
  h.visibility = 'hidden';
  if (h.docListeners.visibilitychange) h.docListeners.visibilitychange();
  h.frame(5000); // 5s hidden; a frame tick arriving while hidden must be ignored
  h.visibility = 'visible';
  if (h.docListeners.visibilitychange) h.docListeners.visibilitychange();
  h.frame(0);  // first visible frame after unhide = new baseline
  h.frame(16); // good frame
  h.fireTimer(400);
  const events = h.allEvents();
  const vis = events.find((e) => e.name === 'visibility');
  ok('unhide records a hidden interval, not a giant frame gap', vis && vis.attributes.hiddenMs === 5000);
  const fw2 = events.find((e) => e.name === 'frame-window');
  ok('no 5s stall leaks into the frame window after unhide', fw2 && fw2.attributes.maxMs <= 16);

  // --- Explicit span ---
  h.batches.length = 0;
  const end = h.probe.startSpan('library', 'full-render', { count: 900 });
  h.perf += 42;
  h.wall += 42;
  end({ status: 'ok' });
  h.fireTimer(400);
  const span = h.allEvents().find((e) => e.kind === 'span' && e.name === 'full-render');
  ok('startSpan records duration and merged attributes', span &&
    span.durationMs === 42 && span.attributes.count === 900 && span.attributes.status === 'ok');

  // --- Resource sample ---
  h.batches.length = 0;
  h.fireTimer(2000);
  h.fireTimer(400);
  const res = h.allEvents().find((e) => e.name === 'resources');
  ok('resource sample reports heap/nodes/cards', res &&
    res.attributes.heapMB === 50 && res.attributes.nodes === 4200 && res.attributes.cards === 128);

  // --- Long task via observer ---
  h.batches.length = 0;
  const obs = h.observerInstances[0];
  ok('observer subscribed to longtask entries', obs && obs.observed && obs.observed.entryTypes.includes('longtask'));
  obs.cb({ getEntries: () => [{ duration: 83.4 }, { duration: 210 }] });
  h.fireTimer(400);
  const longTasks = h.allEvents().filter((e) => e.name === 'long-task' && e.durationMs);
  ok('long tasks are recorded with duration', longTasks.length === 2 &&
    longTasks.some((e) => e.durationMs === 210));

  // --- Errors record only the class name ---
  h.batches.length = 0;
  if (h.winListeners.error) h.winListeners.error({ error: new TypeError('secret path C:/Users/alex') });
  if (h.winListeners.unhandledrejection) h.winListeners.unhandledrejection({ reason: new RangeError('leak') });
  h.fireTimer(400);
  const errText = JSON.stringify(h.allEvents());
  ok('window error records class only, no message text',
    /"reason":"TypeError"/.test(errText) && /"reason":"RangeError"/.test(errText) && !/secret path/.test(errText));

  // --- Stop flushes and silences further events ---
  h.batches.length = 0;
  h.frame(16);
  h.frame(16);
  h.probe.stop();
  ok('stop flushes the pending frame window', h.allEvents().some((e) => e.name === 'frame-window'));
  ok('stop is reflected in isRunning', h.probe.isRunning() === false);
  h.batches.length = 0;
  h.probe.startSpan('x', 'y')();
  if (h.winListeners.error) { /* listeners removed on stop */ }
  ok('no events are produced after stop', h.allEvents().length === 0);

  // --- Long task unavailable when the observer is missing ---
  const h2 = makeHarness({ withObserver: false });
  h2.probe.start();
  h2.fireTimer(400);
  const unavailable = h2.allEvents().find((e) => e.name === 'long-task');
  ok('missing PerformanceObserver is flagged unavailable, not silent',
    unavailable && unavailable.attributes.unavailable === true);
  h2.probe.stop();

  console.log('\nAll ' + passed + ' diagnostics renderer-probe tests passed.');
})();
