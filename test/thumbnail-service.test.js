'use strict';

const assert = require('assert');
const path = require('path');
const { createThumbnailService } = require('../src/thumbnail-service');

const empty = { url: '', width: 0, height: 0 };
const image = { mime: 'image/png', dataBase64: 'cG5n', width: 400, height: 200, encodedBytes: 3, windowsCache: 'hit' };
const file = name => path.resolve('fixtures', name + '.png');
const tick = () => new Promise(resolve => { setImmediate(resolve); });
const watchdog = setTimeout(() => { console.error('thumbnail service test stalled'); process.exit(1); }, 10000);
let passed = 0;
async function test(name, fn) {
  await fn(); passed++; console.log('  ok ' + name);
}
function setup(overrides = {}) {
  const calls = [], aspects = [], writes = [], events = [], spans = [];
  let saves = 0;
  const dependencies = {
    thumbnailHost: { thumbnail: async (...args) => { calls.push(args); return image; } },
    isAuthorizedMediaPath: () => true,
    queueLiveFolderAspect: (...args) => aspects.push(args),
    setAspect: (...args) => { writes.push(args); return true; },
    saveLibrarySoon: () => { saves++; },
    diagEvent: event => events.push(event),
    diagSpan: (...args) => { const span = { args }; spans.push(span); return result => { span.result = result; }; },
    ...overrides,
  };
  return { service: createThumbnailService(dependencies), calls, aspects, writes, events, spans, saves: () => saves };
}

(async () => {
  await test('invalid and unauthorized paths never reach helper, queue or counter', async () => {
    const s = setup({ isAuthorizedMediaPath: () => false });
    for (const p of [null, {}, '', 'relative.png', file('bad') + '\0', file('denied')]) {
      assert.deepStrictEqual(await s.service.thumbnailData(p, 320, 200), empty);
    }
    assert.strictEqual(s.service.attempts(), 0);
    assert.deepStrictEqual([s.calls, s.events, s.aspects], [[], [], []]);
  });
  await test('helper encoding, PNG data URL, scalar width and quality are preserved', async () => {
    const s = setup();
    assert.deepStrictEqual(await s.service.thumbnailData(file('a'), 321.6, 201.4), { url: 'data:image/png;base64,cG5n', width: 400, height: 200 });
    assert.deepStrictEqual(s.calls, [[file('a'), 322, 82]]);
    assert.deepStrictEqual(s.aspects, [[file('a'), 2]]);
    assert.strictEqual(s.service.attempts(), 1);
    assert.deepStrictEqual(s.spans[0], { args: ['thumbnail', 'helper-roundtrip', { width: 322, height: 201 }], result: { status: 'ok', bytes: 3, width: 400, height: 200, windowsCache: 'hit' } });
    const event = s.events[0];
    assert.strictEqual(event.name, 'thumbnail-task'); assert.strictEqual(event.category, 'task-queue');
    assert.strictEqual(event.attributes.status, 'ok');
    assert.ok(event.attributes.active <= 2 && event.durationMs >= 0 && event.attributes.waitMs >= 0);
  });
  await test('sizes clamp and non-finite inputs default; height does not split cache key', async () => {
    const s = setup();
    await s.service.thumbnailData(file('min'), -1, 99999);
    await s.service.thumbnailData(file('max'), 99999, -1);
    await s.service.thumbnailData(file('default'), NaN, Infinity);
    await s.service.thumbnailData(file('default'), 320, 17);
    assert.deepStrictEqual(s.calls.map(x => x[1]), [16, 1024, 320]);
    assert.deepStrictEqual(s.spans.map(x => x.args[2]), [{ width: 16, height: 1024 }, { width: 1024, height: 16 }, { width: 320, height: 200 }]);
    assert.strictEqual(s.service.attempts(), 4);
  });
  await test('authority is checked again before returning cached or pending bytes', async () => {
    let allowed = true, release;
    const s = setup({ isAuthorizedMediaPath: () => allowed });
    await s.service.thumbnailData(file('a'), 320, 200);
    allowed = false;
    assert.deepStrictEqual(await s.service.thumbnailData(file('a'), 320, 200), empty);
    assert.strictEqual(s.service.attempts(), 1);
    const pending = setup({ isAuthorizedMediaPath: () => allowed, thumbnailHost: { thumbnail: () => new Promise(resolve => { release = resolve; }) } });
    allowed = true; const first = pending.service.thumbnailData(file('b'), 320, 200); await tick(); allowed = false;
    assert.deepStrictEqual(await pending.service.thumbnailData(file('b'), 320, 200), empty);
    release(image); await first;
    assert.strictEqual(pending.service.attempts(), 1);
  });
  await test('same scalar width shares pending work; other width gets its own request', async () => {
    const releases = [], calls = [];
    const s = setup({ thumbnailHost: { thumbnail: (...args) => { calls.push(args); return new Promise(resolve => { releases.push(resolve); }); } } });
    const jobs = [s.service.thumbnailData(file('a'), 320, 100), s.service.thumbnailData(file('a'), 320, 900), s.service.thumbnailData(file('a'), 640, 200)];
    await tick(); assert.strictEqual(calls.length, 2);
    releases.forEach(resolve => resolve(image));
    await tick();
    assert.strictEqual(calls.length, 2, 'duplicate must not enqueue a delayed third request');
    assert.deepStrictEqual(await Promise.all(jobs), Array(3).fill({ url: 'data:image/png;base64,cG5n', width: 400, height: 200 }));
  });
  await test('queue runs at most two tasks and forwards virtual-window priority', async () => {
    const calls = [], releases = [];
    const s = setup({ thumbnailHost: { thumbnail: p => { calls.push(p); return new Promise(resolve => { releases.push(resolve); }); } } });
    const jobs = ['a', 'b', 'low', 'high', 'last'].map((name, i) => s.service.thumbnailData(file(name), 320, 200, i === 3 ? 10 : 0));
    await tick(); assert.deepStrictEqual(calls, [file('a'), file('b')]);
    releases[0](image); await tick(); assert.deepStrictEqual(calls, [file('a'), file('b'), file('high')]);
    releases[1](image); await tick(); assert.strictEqual(calls[3], file('low'));
    releases[2](image); await tick(); assert.strictEqual(calls[4], file('last'));
    releases[3](image); releases[4](image); await Promise.all(jobs);
  });
  await test('LRU holds 800 entries, reads refresh recency and hits backfill folder aspects', async () => {
    const s = setup();
    for (let i = 0; i < 800; i++) await s.service.thumbnailData(file(String(i)), 320, 200);
    await s.service.thumbnailData(file('0'), 320, 200);
    await s.service.thumbnailData(file('800'), 320, 200);
    await s.service.thumbnailData(file('0'), 320, 200);
    assert.strictEqual(s.calls.length, 801);
    await s.service.thumbnailData(file('1'), 320, 200);
    assert.strictEqual(s.calls.length, 802);
    assert.strictEqual(s.aspects.length, 804);
  });
  await test('instances do not share caches, pending requests or counters', async () => {
    const a = setup(), b = setup();
    await a.service.thumbnailData(file('a'), 320, 200);
    assert.strictEqual(b.service.attempts(), 0);
    await b.service.thumbnailData(file('a'), 320, 200);
    assert.strictEqual(a.calls.length, 1); assert.strictEqual(b.calls.length, 1);
  });
  await test('retriable helper failure is not cached; pending is cleared and next call recovers', async () => {
    let count = 0;
    const s = setup({ thumbnailHost: { thumbnail: async () => { if (++count === 1) throw Object.assign(new Error('busy'), { retriable: true, code: 'busy' }); return image; } } });
    assert.deepStrictEqual(await s.service.thumbnailData(file('a'), 320, 200), empty);
    assert.strictEqual((await s.service.thumbnailData(file('a'), 320, 200)).width, 400);
    assert.strictEqual(count, 2);
    assert.deepStrictEqual(s.spans[0].result, { status: 'error', errorCode: 'busy' });
  });
  await test('permanent failures and malformed/empty results remain cached placeholders', async () => {
    for (const reply of [null, {}, { ...image, dataBase64: '' }, { ...image, width: 0 }, { ...image, height: -1 }, new Error('bad')]) {
      let calls = 0;
      const s = setup({ thumbnailHost: { thumbnail: async () => { calls++; if (reply instanceof Error) throw reply; return reply; } } });
      assert.deepStrictEqual(await s.service.thumbnailData(file('a'), 320, 200), empty);
      assert.deepStrictEqual(await s.service.thumbnailData(file('a'), 320, 200), empty);
      assert.strictEqual(calls, 1); assert.deepStrictEqual(s.aspects, []);
    }
  });
  await test('non-PNG payload uses the existing JPEG fallback', async () => {
    const s = setup({ thumbnailHost: { thumbnail: async () => ({ ...image, mime: 'image/jpeg' }) } });
    assert.strictEqual((await s.service.thumbnailData(file('a'), 320, 200)).url, 'data:image/jpeg;base64,cG5n');
  });
  await test('aspect batches preserve input order, cap at 100 and save once without broadcast', async () => {
    const s = setup();
    const entries = Array.from({ length: 105 }, (_, i) => ({ id: String(i), path: file(String(i)) }));
    assert.deepStrictEqual(await s.service.aspects(entries, 320, 200), entries.slice(0,100).map(x => ({ path: x.path, aspect: 2 })));
    assert.strictEqual(s.calls.length, 100); assert.strictEqual(s.writes.length, 100); assert.strictEqual(s.saves(), 1);
    assert.deepStrictEqual(s.writes[42], ['42', file('42'), 2]);
  });
  await test('aspect batch has six workers feeding the two-task queue', async () => {
    const calls = [], releases = [];
    const s = setup({ thumbnailHost: { thumbnail: p => {
      calls.push(p);
      return new Promise(resolve => { releases.push(resolve); });
    } } });
    const entries = Array.from({ length: 8 }, (_, i) => ({ path: file('batch-' + i) }));
    const batch = s.service.aspects(entries, 320, 200);
    await tick();
    assert.strictEqual(calls.length, 2, 'batch fills both helper slots before a result is ready');
    releases[0](image);
    await tick();
    assert.strictEqual(s.events[0].attributes.pending, 4, 'six workers enqueue two active and four pending jobs');
    assert.strictEqual(calls.length, 3, 'a waiting batch job immediately fills the freed slot');
    for (let i = 1; i < entries.length; i++) {
      releases[i](image);
      await tick();
      assert.strictEqual(calls.length, Math.min(entries.length, i + 3), 'queue stays fed until the input ends');
    }
    assert.deepStrictEqual(await batch, entries.map(entry => ({ path: entry.path, aspect: 2 })));
  });
  await test('aspect batch skips invalid paths, absent ids and unchanged records; empty input is inert', async () => {
    const s = setup({ setAspect: () => false });
    assert.deepStrictEqual(await s.service.aspects(null, 320, 200), []);
    assert.deepStrictEqual(await s.service.aspects([], 320, 200), []);
    assert.deepStrictEqual(await s.service.aspects([null, { id: 'x', path: false }, { path: file('a') }, { id: 'b', path: file('b') }], 320, 200), [
      { path: '', aspect: 0 }, { path: '', aspect: 0 }, { path: file('a'), aspect: 2 }, { path: file('b'), aspect: 2 },
    ]);
    assert.strictEqual(s.saves(), 0);
  });
  console.log(`thumbnail-service.test.js: ${passed} passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { clearTimeout(watchdog); });
