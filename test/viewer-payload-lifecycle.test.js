'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../renderer/viewer.js'), 'utf8')
  .replace(/\binit\(\);\s*$/, '');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const timers = new Map();
  const listeners = new Map();
  const lifecycle = new Map();
  const images = [];
  const root = { appendChild() {}, addEventListener() {} };
  let timerId = 0;
  const context = vm.createContext({
    TextEncoder,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    document: {
      querySelector: (selector) => selector === '#viewerRoot' ? root : null,
      documentElement: {},
      createElement: () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {} }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    },
    window: {
      addEventListener(type, fn) { lifecycle.set(type, fn); },
      viewerApi: {
        fileUrl: async () => '',
        cardAssignTargets: async () => null,
        onPayload() {}, onFullscreenChanged() {}, onBackgroundChanged() {},
        close() {},
      },
    },
    ZnadaViewerPrefetch: require('../renderer/viewer-prefetch.js'),
    AssignRows: { build() {} },
    CardMenu: { placeAt: () => ({ left: 0, top: 0 }) },
    Image: class {
      constructor() { images.push(this); }
      removeAttribute() { this.src = ''; }
    },
  });
  const viewer = vm.runInContext(`${source}
    render = () => {};
    t = (key) => key;
    viewerEntryMoves = async () => false;
    initEvents();
    ({ setPayload, openViewerAssign, closeViewerPopup, prefetchIndex,
       retargetPrefetch, prefetchNeighbors, warm: WARM, prefetch: PREFETCH,
       step: (delta) => { step(delta); retargetPrefetch(VIEWER.index); },
       items: () => VIEWER.items, cache: IMG_CACHE, pending: PREFETCHING, cacheTier })`, context);
  return {
    ...viewer, context, images, lifecycle,
    flushTimers() {
      for (const [id, fn] of timers) { timers.delete(id); fn(); }
    },
    listenerCount: () => listeners.get('mousedown')?.size || 0,
    escape() {
      for (const fn of listeners.get('keydown')) fn({ key: 'Escape', preventDefault() {} });
    },
  };
}

const entry = (path) => ({ kind: 'path', key: path, path });

test('a late file URL from the replaced payload cannot warm or occupy the new index', async () => {
  const h = harness();
  const oldSource = deferred();
  const nextSource = deferred();
  h.context.window.viewerApi.fileUrl = (path) => path === 'old' ? oldSource.promise : nextSource.promise;
  h.setPayload({ items: [entry('old')] });
  const oldJob = h.prefetchIndex(0);
  await Promise.resolve();
  h.setPayload({ items: [entry('new')] });
  const nextJob = h.prefetchIndex(0);
  oldSource.resolve('file:///old');
  await oldJob;
  assert.equal(h.cache.has(0), false, 'old source entered the new cache');
  assert.equal(h.images.length, 0);
  assert.equal(h.pending.has(0), true, 'old completion removed the new job');
  nextSource.resolve('file:///new');
  await nextJob;
  assert.equal(h.cache.get(0).full, 'file:///new');
  assert.equal(h.pending.size, 0);
});

test('closing the actual assign popup before its timer fires leaves no document listener', async () => {
  const h = harness();
  h.setPayload({ items: [entry('local')] });
  await h.openViewerAssign(h.items()[0], {}, {});
  const baseline = h.listenerCount();
  h.closeViewerPopup();
  h.flushTimers();
  assert.equal(h.listenerCount(), baseline);
});

for (const [name, leave] of [
  ['replacement', (h) => h.setPayload({ items: [entry('new')] })],
  ['Escape close', (h) => h.escape()],
  ['page teardown', (h) => h.lifecycle.get('pagehide')()],
]) {
  test(`${name} detaches a warm image and clears popup and prefetch work`, async () => {
    const h = harness();
    const decoding = deferred();
    const started = deferred();
    h.context.Image.prototype.decode = () => { started.resolve(); return decoding.promise; };
    h.context.window.viewerApi.fileUrl = async () => 'file:///local';
    h.setPayload({ items: [entry('local')] });
    await h.openViewerAssign(h.items()[0], {}, {});
    h.flushTimers();
    assert.equal(h.listenerCount(), 1);
    await h.openViewerAssign(h.items()[0], {}, {});
    const job = h.prefetchIndex(0);
    await started.promise;
    leave(h);
    h.flushTimers();
    assert.equal(h.listenerCount(), 0);
    assert.equal(h.images[0].src, '');
    assert.equal(h.cache.size, 0);
    assert.equal(h.pending.size, 0);
    decoding.resolve();
    await job;
    assert.equal(h.pending.size, 0);
  });
}

test('a delayed assign target result cannot open a popup in another gallery', async () => {
  const h = harness();
  const targets = deferred();
  h.context.window.viewerApi.cardAssignTargets = () => targets.promise;
  h.setPayload({ items: [entry('old')] });
  const opening = h.openViewerAssign(h.items()[0], {}, {});
  h.setPayload({ items: [entry('new')] });
  targets.resolve(null);
  await opening;
  h.flushTimers();
  assert.equal(h.listenerCount(), 0);
});

test('two individually cacheable sources cannot exceed the total encoded byte budget', () => {
  const h = harness();
  h.setPayload({ items: [entry('a'), entry('b')] });
  const src = 'data:image/png;base64,' + 'A'.repeat(18 * 1024 * 1024);
  h.cacheTier(0, 'sample', src);
  h.cacheTier(1, 'full', src + 'B');
  const bytes = [...h.cache.values()].reduce((total, { sample = '', full = '' }) =>
    total + Buffer.byteLength(sample) + Buffer.byteLength(full), 0);
  assert.equal(h.cache.has(1), true);
  assert.ok(bytes <= 32 * 1024 * 1024, `retained ${bytes} encoded bytes`);
  h.cacheTier(1, 'sample', src);
  assert.equal(h.cache.get(1).sample, src, 'both tiers at a single index share the budget');
  assert.equal(h.cache.get(1).full, undefined);
  h.cacheTier(1, 'full', 'A'.repeat(33 * 1024 * 1024));
  assert.equal(h.cache.get(1).full, undefined, 'a source larger than the entire budget is skipped');
});

/* --------------------------------------------------------------- PERF-011 ---- */

const settle = () => new Promise((done) => { setImmediate(done); });

function prefetchHarness(count) {
  const h = harness();
  const decodes = [];
  h.context.Image.prototype.decode = function decode() {
    const d = deferred();
    decodes.push({ img: this, d });
    return d.promise;
  };
  h.context.window.viewerApi.fileUrl = async (path) => `file:///${path}`;
  h.setPayload({ items: Array.from({ length: count }, (_, i) => entry(`p${i}`)) });
  // Finish the decode of the frame at `index` with a size, then let the queue move.
  h.finish = async (index, width = 1920, height = 1080) => {
    const job = decodes.find(({ img }) => img.src === `file:///p${index}` && !img.done);
    assert.ok(job, `no decode in flight for ${index}`);
    job.img.done = true;
    job.img.naturalWidth = width;
    job.img.naturalHeight = height;
    job.d.resolve();
    await settle();
  };
  h.decodes = decodes;
  h.pendingKeys = () => [...h.pending.keys()].sort((a, b) => a - b);
  return h;
}

test('PERF-011: nothing new starts until the current photo has a frame', async () => {
  const h = prefetchHarness(20);
  h.retargetPrefetch(0);
  await settle();
  assert.equal(h.pending.size, 0);
  h.prefetchNeighbors(0);
  await settle();
  assert.deepEqual(h.pendingKeys(), [1, 19], 'first ahead and first behind, two at a time');
});

test('PERF-011: the queue refills ahead in order and keeps prepared frames decoded', async () => {
  const h = prefetchHarness(20);
  h.retargetPrefetch(0);
  h.prefetchNeighbors(0);
  await settle();
  await h.finish(1);
  assert.deepEqual(h.pendingKeys(), [2, 19]);
  assert.equal(h.warm.has(1), true);
  assert.equal(h.warm.get(1).img.src, 'file:///p1', 'a prepared frame must stay attached');
  for (const index of [19, 2, 3, 18, 4]) await h.finish(index);
  assert.deepEqual([...h.warm.keys()].sort((a, b) => a - b), [1, 2, 3, 4, 18, 19]);
  assert.equal(h.pending.size, 0, 'nothing beyond the window is fetched');
});

test('PERF-011: moving on cancels work outside the new window and drops far frames', async () => {
  const h = prefetchHarness(20);
  h.retargetPrefetch(0);
  h.prefetchNeighbors(0);
  await settle();
  await h.finish(1);
  const far = h.decodes.find(({ img }) => img.src === 'file:///p19').img;
  h.step(1); h.step(1); h.step(1); // now at 3, window 4,2,5,6,1,7
  assert.equal(h.prefetch.direction, 1);
  assert.equal(h.pending.has(19), false, 'a request behind the window kept running');
  assert.equal(far.src, '', 'the cancelled request was not detached');
  assert.equal(h.pending.has(2), true, 'a request still inside the window was cancelled');
  assert.equal(h.warm.has(1), true, 'the photo just seen was thrown away');
  h.step(1); h.step(1); h.step(1); h.step(1); // at 7: 1 is out
  assert.equal(h.warm.has(1), false);
});

test('PERF-011: turning back prepares the other side first', async () => {
  const h = prefetchHarness(20);
  h.step(-1); // at 19
  h.prefetchNeighbors(19);
  await settle();
  assert.equal(h.prefetch.direction, -1);
  assert.deepEqual(h.pendingKeys(), [0, 18]);
  await h.finish(0);
  assert.deepEqual(h.pendingKeys(), [17, 18], 'second step back must come before second ahead');
});

test('PERF-011: turning back prepares a frame that left the window', async () => {
  const h = prefetchHarness(20);
  h.retargetPrefetch(0);
  h.prefetchNeighbors(0);
  await settle();
  await h.finish(1);
  assert.equal(h.warm.has(1), true);

  for (let index = 0; index < 4; index++) h.step(1);
  assert.equal(h.warm.has(1), false);

  h.step(-1); // at 3, with photo 1 two steps ahead in the new direction
  h.prefetchNeighbors(3);
  await settle();
  await h.finish(2);
  assert.equal(h.pending.has(1), true, 'the evicted photo must be queued again');
  await h.finish(1);
  assert.equal(h.warm.has(1), true);
});

test('PERF-011: a frame too big to hold is not decoded again and again', async () => {
  const h = prefetchHarness(20);
  h.retargetPrefetch(0);
  h.prefetchNeighbors(0);
  await settle();
  await h.finish(1, 14204, 10652);
  assert.equal(h.warm.has(1), false);
  for (const index of [19, 2, 3, 18, 4]) await h.finish(index);
  h.prefetchNeighbors(0);
  await settle();
  assert.equal(h.decodes.filter(({ img }) => img.naturalWidth === 14204).length, 1);
  assert.equal(h.decodes.some(({ img }) => img.src === 'file:///p1' && !img.done), false, 'decoded again');
  assert.equal(h.pending.size, 0);
});

test('PERF-011: a new gallery detaches every prepared frame', async () => {
  const h = prefetchHarness(5);
  h.retargetPrefetch(0);
  h.prefetchNeighbors(0);
  await settle();
  await h.finish(1);
  const held = h.warm.get(1).img;
  h.setPayload({ items: [entry('other')] });
  assert.equal(h.warm.size, 0);
  assert.equal(held.src, '');
});

test('PERF-011: a finished neighbour does not start new work while the new photo has no frame', async () => {
  const h = prefetchHarness(20);
  h.retargetPrefetch(0);
  h.prefetchNeighbors(0);
  await settle();
  h.step(1); // at 1, still loading: 19 stays in flight, nothing new may start
  await h.finish(19);
  assert.deepEqual(h.pendingKeys(), [1], 'the queue moved ahead of the photo on screen');
  h.prefetchNeighbors(1);
  await settle();
  assert.deepEqual(h.pendingKeys(), [1, 2], 'the frame now on screen keeps its slot; next ahead takes the other');
});
