'use strict';

const assert = require('assert');
const { createTaskQueue } = require('../src/task-queue');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const run = createTaskQueue(2);
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 6 }, (_, index) => run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await wait(10);
    active -= 1;
    return index;
  }));
  const result = await Promise.all(tasks);
  assert.deepStrictEqual(result, [0, 1, 2, 3, 4, 5]);
  assert.strictEqual(maxActive, 2);

  const single = createTaskQueue(0);
  let order = '';
  await Promise.all([
    single(async () => { await wait(5); order += 'a'; }),
    single(async () => { order += 'b'; }),
  ]);
  assert.strictEqual(order, 'ab');

  // A newly visible virtual window may outrank stale queued thumbnail work, while
  // jobs with equal priority remain FIFO. The active job is never interrupted.
  const prioritized = createTaskQueue(1);
  let releaseBlocker;
  const blocker = prioritized(() => new Promise((resolve) => { releaseBlocker = resolve; }));
  const priorityOrder = [];
  const lowA = prioritized(async () => { priorityOrder.push('low-a'); }, { priority: 1 });
  const highA = prioritized(async () => { priorityOrder.push('high-a'); }, { priority: 5 });
  const highB = prioritized(async () => { priorityOrder.push('high-b'); }, { priority: 5 });
  const lowB = prioritized(async () => { priorityOrder.push('low-b'); }, { priority: 1 });
  await Promise.resolve(); // let the active blocker enter its task body
  releaseBlocker();
  await Promise.all([blocker, lowA, highA, highB, lowB]);
  assert.deepStrictEqual(priorityOrder, ['high-a', 'high-b', 'low-a', 'low-b']);

  // Hooks: timing/counters are reported, results and errors pass through untouched.
  let fakeNow = 1000;
  const calls = { enqueue: [], start: [], settle: [] };
  const hooked = createTaskQueue(1, {
    now: () => fakeNow,
    onEnqueue: (info) => calls.enqueue.push(info),
    onStart: (info) => calls.start.push(info),
    onSettle: (info) => calls.settle.push(info),
  });
  const first = hooked(async () => {
    fakeNow += 40; // simulated run duration of the first job
    return 'ok-value';
  });
  const second = hooked(async () => { throw new Error('boom'); });
  assert.strictEqual(await first, 'ok-value');
  await assert.rejects(second, /boom/);
  assert.strictEqual(calls.enqueue.length, 2);
  assert.strictEqual(calls.start.length, 2);
  assert.strictEqual(calls.settle.length, 2);
  // Second job waited in the queue while the first one ran for 40ms.
  assert.strictEqual(calls.start[0].waitMs, 0);
  assert.strictEqual(calls.settle[0].ok, true);
  assert.strictEqual(calls.settle[0].runMs, 40);
  assert.strictEqual(calls.settle[0].startedAt, 1000);
  assert.strictEqual(calls.start[1].waitMs, 40);
  assert.strictEqual(calls.settle[1].ok, false);
  assert.ok(calls.enqueue[1].pending >= 1, 'second enqueue sees a pending job');

  // Hooks preserve completion order and concurrency accounting.
  const hookedPair = createTaskQueue(2, { onStart: () => {}, onSettle: () => {} });
  let hookedActive = 0;
  let hookedMax = 0;
  const hookedResults = await Promise.all(Array.from({ length: 5 }, (_, index) => hookedPair(async () => {
    hookedActive += 1;
    hookedMax = Math.max(hookedMax, hookedActive);
    await wait(5);
    hookedActive -= 1;
    return index;
  })));
  assert.deepStrictEqual(hookedResults, [0, 1, 2, 3, 4]);
  assert.strictEqual(hookedMax, 2);

  // Throwing hooks must never break the queue or swallow results.
  const explosive = createTaskQueue(1, {
    onEnqueue: () => { throw new Error('hook-enqueue'); },
    onStart: () => { throw new Error('hook-start'); },
    onSettle: () => { throw new Error('hook-settle'); },
  });
  assert.strictEqual(await explosive(async () => 7), 7);
  await assert.rejects(explosive(async () => { throw new Error('job-error'); }), /job-error/);

  console.log('task-queue.test.js ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
