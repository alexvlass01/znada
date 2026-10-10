'use strict';

// TRG-004: src/latest-intent.js on its own, with fake timers. What the real main.js does
// with it is tested in test/theme-schedule-intent.test.js.
//
// Run: node test/latest-intent.test.js

const assert = require('assert');
const { createLatestIntent } = require('../src/latest-intent');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
  }
}

function fakeTimers() {
  let seq = 0;
  const live = new Map();
  const cleared = [];
  return {
    setTimer: (fn, ms) => {
      const handle = { id: ++seq, fn, ms };
      live.set(handle.id, handle);
      return handle;
    },
    clearTimer: (handle) => {
      if (handle && live.delete(handle.id)) cleared.push(handle.id);
    },
    fire(handle) {
      if (!live.has(handle.id)) throw new Error(`timer ${handle.id} is not armed`);
      live.delete(handle.id);
      handle.fn();
    },
    live: () => live.size,
    handles: () => [...live.values()],
    cleared,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const turns = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => { setImmediate(r); }); };

function make(clock = 1000) {
  const timers = fakeTimers();
  const intent = createLatestIntent({ setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: () => clock });
  return { timers, intent };
}

console.log('\nlatest-intent\n');

(async () => {
  await test('the current intent arms one timer; firing it leaves none behind', async () => {
    const { timers, intent } = make();
    const token = intent.begin();
    let fired = 0;
    assert.strictEqual(intent.arm(token, () => { fired++; }, 60000), true);
    assert.strictEqual(timers.live(), 1);
    assert.deepStrictEqual(intent.state().liveTimers, 1);
    assert.strictEqual(intent.state().dueAt, 1000 + 60000);
    timers.fire(timers.handles()[0]);
    assert.strictEqual(fired, 1);
    assert.strictEqual(intent.state().liveTimers, 0, 'the fired timer is no longer held');
    assert.strictEqual(intent.state().dueAt, 0);
  });

  await test('a new intent drops the armed timer at once', async () => {
    const { timers, intent } = make();
    intent.arm(intent.begin(), () => {}, 60000);
    const armed = timers.handles()[0];
    intent.begin();
    assert.strictEqual(timers.live(), 0, 'the previous intent\'s timer must not survive');
    assert.deepStrictEqual(timers.cleared, [armed.id]);
  });

  await test('a stale intent arms nothing and leaves the current timer alone', async () => {
    const { timers, intent } = make();
    const stale = intent.begin();
    const current = intent.begin();
    intent.arm(current, () => {}, 60000);
    const armed = timers.handles()[0];
    assert.strictEqual(intent.arm(stale, () => {}, 60000), false);
    assert.strictEqual(timers.live(), 1);
    assert.strictEqual(timers.handles()[0], armed, 'the current handle must not be replaced');
    assert.deepStrictEqual(timers.cleared, []);
  });

  await test('arming twice for the same intent keeps one timer', async () => {
    const { timers, intent } = make();
    const token = intent.begin();
    intent.arm(token, () => {}, 60000);
    intent.arm(token, () => {}, 3600000);
    assert.strictEqual(timers.live(), 1);
    assert.strictEqual(timers.handles()[0].ms, 3600000);
  });

  await test('cancel: nothing is current, nothing is armed, arming is refused', async () => {
    const { timers, intent } = make();
    const token = intent.begin();
    intent.arm(token, () => {}, 60000);
    intent.cancel();
    assert.strictEqual(intent.isCurrent(token), false);
    assert.strictEqual(timers.live(), 0);
    assert.strictEqual(intent.arm(token, () => {}, 60000), false);
    assert.strictEqual(timers.live(), 0);
  });

  await test('dispose: no later intent is ever current', async () => {
    const { timers, intent } = make();
    intent.arm(intent.begin(), () => {}, 60000);
    intent.dispose();
    const later = intent.begin();
    assert.strictEqual(intent.isCurrent(later), false);
    assert.strictEqual(intent.arm(later, () => {}, 60000), false);
    assert.strictEqual(timers.live(), 0);
    assert.strictEqual(intent.state().disposed, true);
  });

  await test('a stale intent does not start its side effect', async () => {
    const { intent } = make();
    const stale = intent.begin();
    intent.begin();
    let started = 0;
    const result = await intent.dispatch(stale, () => { started++; });
    assert.deepStrictEqual(result, { started: false });
    assert.strictEqual(started, 0);
  });

  await test('a newer run waits for a side effect already under way, then decides', async () => {
    const { intent } = make();
    const order = [];
    const first = deferred();
    const a = intent.begin();
    const runA = intent.dispatch(a, () => { order.push('A start'); return first.promise; });
    await turns();
    assert.strictEqual(intent.busy(), true);

    const b = intent.begin();
    const runB = intent.dispatch(b, () => { order.push('B start'); return 'B'; });
    await turns();
    assert.deepStrictEqual(order, ['A start'], 'B must not start while A is still running');

    first.resolve('A');
    const resultA = await runA;
    assert.deepStrictEqual(resultA, { started: true, value: 'A' }, 'a started effect runs to its end');
    assert.strictEqual(intent.isCurrent(a), false, 'A is stale after it, so it must not commit');
    const resultB = await runB;
    assert.deepStrictEqual(resultB, { started: true, value: 'B' });
    assert.deepStrictEqual(order, ['A start', 'B start']);
    assert.strictEqual(intent.busy(), false);
  });

  await test('of several waiting runs only the latest starts', async () => {
    const { intent } = make();
    const first = deferred();
    const a = intent.begin();
    const runA = intent.dispatch(a, () => first.promise);
    const started = [];
    const b = intent.begin();
    const runB = intent.dispatch(b, () => { started.push('B'); });
    const c = intent.begin();
    const runC = intent.dispatch(c, () => { started.push('C'); });
    first.resolve();
    await runA;
    assert.deepStrictEqual(await runB, { started: false });
    assert.deepStrictEqual(await runC, { started: true, value: undefined });
    assert.deepStrictEqual(started, ['C']);
  });

  await test('settle says whether the intent survived the wait', async () => {
    const { intent } = make();
    const first = deferred();
    const a = intent.begin();
    const runA = intent.dispatch(a, () => first.promise);
    const b = intent.begin();
    const waitB = intent.settle(b);
    intent.begin(); // superseded while waiting
    first.resolve();
    await runA;
    assert.strictEqual(await waitB, false);
  });

  await test('a failing side effect reaches its caller and frees the scheduler', async () => {
    const { intent } = make();
    const token = intent.begin();
    await assert.rejects(intent.dispatch(token, () => { throw new Error('powershell failed'); }), /powershell failed/);
    assert.strictEqual(intent.busy(), false);
    const next = intent.begin();
    assert.deepStrictEqual(await intent.dispatch(next, () => 'ok'), { started: true, value: 'ok' });
  });

  await test('a newer run is not blocked by an older effect that failed', async () => {
    const { intent } = make();
    const first = deferred();
    const a = intent.begin();
    const runA = intent.dispatch(a, () => first.promise);
    const b = intent.begin();
    const runB = intent.dispatch(b, () => 'B');
    first.reject(new Error('COM apply failed'));
    await assert.rejects(runA, /COM apply failed/);
    assert.deepStrictEqual(await runB, { started: true, value: 'B' });
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`\n--- ${f.name}\n${f.err && f.err.stack}`);
    process.exit(1);
  }
})();
