'use strict';

// PERF-007. The metadata queue is capped, coalesced, and every job has a deadline.
// A function that never settles must not keep the next job waiting past that deadline.

const assert = require('assert');
const { createMetadataWorkQueue, raceSignal, DEFAULT_MAX_PENDING } = require('../src/metadata-work-queue');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

function manualClock() {
  const timers = [];
  return {
    timers,
    setTimer(fn) {
      const timer = { fn, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { if (timer) timer.cleared = true; },
    fire() {
      for (const timer of timers.slice()) {
        if (!timer.cleared && !timer.fired) {
          timer.fired = true;
          timer.fn();
        }
      }
    },
  };
}

function hang() {
  return new Promise(() => {});
}

(async () => {
  {
    const clock = manualClock();
    const queue = createMetadataWorkQueue({
      maxPending: 2,
      timeoutMs: 1000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    let second = false;
    const first = queue.enqueue('stalled', () => hang(), {
      onTimeout: () => ({ status: 'error', reason: 'timeout' }),
    });
    const next = queue.enqueue('next', async () => { second = true; return 'done'; });
    assert.strictEqual(second, false);
    assert.strictEqual(queue.activeCount(), 1);
    assert.strictEqual(queue.pendingCount(), 1);
    clock.fire();
    assert.deepStrictEqual(await first, { status: 'error', reason: 'timeout' });
    assert.strictEqual(await next, 'done');
    ok('a stalled job does not block the next one past the deadline', second === true && queue.activeCount() === 0);
  }

  {
    const clock = manualClock();
    const queue = createMetadataWorkQueue({
      maxPending: DEFAULT_MAX_PENDING,
      timeoutMs: 60000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    let busy = 0;
    for (let i = 0; i < 100000; i++) {
      queue.enqueue('job-' + i, () => hang(), {
        busy: () => { busy += 1; return { status: 'busy', reason: 'queue' }; },
      });
    }
    ok('100k unique jobs stay inside the pending cap',
      queue.pendingCount() === DEFAULT_MAX_PENDING
      && queue.activeCount() === 1
      && busy === 100000 - 1 - DEFAULT_MAX_PENDING);
  }

  {
    const clock = manualClock();
    const queue = createMetadataWorkQueue({
      maxPending: 4,
      timeoutMs: 60000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let runs = 0;
    const calls = [];
    for (let i = 0; i < 100; i++) {
      calls.push(queue.enqueue('same', async () => { runs += 1; await gate; return 'one'; }));
    }
    assert.strictEqual(runs, 1);
    assert.strictEqual(queue.pendingCount(), 0);
    assert.strictEqual(queue.activeCount(), 1);
    release();
    const values = await Promise.all(calls);
    ok('the same key shares one run', runs === 1 && values.every((value) => value === 'one'));
  }

  {
    const clock = manualClock();
    const queue = createMetadataWorkQueue({
      maxPending: 2,
      timeoutMs: 60000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const busyReply = () => ({ status: 'busy', reason: 'queue' });
    queue.enqueue('active', () => hang(), { priority: 1, busy: busyReply });
    const low = queue.enqueue('low', () => hang(), { priority: 1, busy: busyReply });
    queue.enqueue('mid', () => hang(), { priority: 1, busy: busyReply });
    const same = queue.enqueue('same-priority', () => hang(), { priority: 1, busy: busyReply });
    assert.deepStrictEqual(await same, { status: 'busy', reason: 'queue' });
    assert.strictEqual(queue.pendingCount(), 2);
    const high = queue.enqueue('high', () => hang(), { priority: 5, busy: busyReply });
    assert.deepStrictEqual(await low, { status: 'busy', reason: 'queue' });
    assert.strictEqual(queue.pendingCount(), 2);
    let settled = false;
    high.then(() => { settled = true; });
    await Promise.resolve();
    ok('a higher priority takes the slot of the lowest pending job, equal priority does not',
      settled === false && queue.activeCount() === 1);
  }

  {
    const ac = new AbortController();
    const pending = raceSignal(new Promise((resolve, reject) => {
      ac.signal.addEventListener('abort', () => {
        setTimeout(() => reject(new Error('late')), 0);
      });
    }), ac.signal);
    ac.abort();
    await assert.rejects(pending, (err) => err && err.code === 'ABORT_ERR');
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    ok('a raced promise that rejects after abort is not unhandled', true);
  }

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
