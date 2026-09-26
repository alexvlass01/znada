'use strict';

// PERF-010. The store of originals main already has, and the join of adds in flight.
// Clock and timers are fakes, so expiry and waiting are tested without real time.
//
// Run: node test/original-store.test.js

const assert = require('assert');
const { createOriginalStore, createInFlight, DEFAULTS } = require('../src/original-store');

let passed = 0;
const failures = [];
async function ok(name, fn) {
  try { await fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (e) { failures.push({ name, e }); console.log('  ✗ ' + name + '\n    ' + (e && e.message)); }
}

function fakeTime() {
  let t = 1000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      t += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= t && timers.has(id)) { timers.delete(id); timer.fn(); }
      }
    },
    pending: () => timers.size,
  };
}

const bytes = (n, fill = 1) => Buffer.alloc(n, fill);
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

console.log('\nPERF-010: originals main already has\n');

(async () => {
  await ok('the defaults are small: a shortcut for "open, then add", not a cache of everything', () => {
    assert.strictEqual(DEFAULTS.maxEntries, 3);
    assert.strictEqual(DEFAULTS.maxBytes, 64 * 1024 * 1024);
    assert.strictEqual(DEFAULTS.ttlMs, 10 * 60 * 1000);
  });

  await ok('a finished original comes back with its bytes and type', async () => {
    const time = fakeTime();
    const store = createOriginalStore(time);
    store.begin('https://img.example/a.jpg').finish(bytes(10), 'image/jpeg');
    const got = await store.get('https://img.example/a.jpg');
    assert.ok(got && got.bytes.equals(bytes(10)));
    assert.strictEqual(got.contentType, 'image/jpeg');
  });

  await ok('the address is compared trimmed, the way the proxy builds it', async () => {
    const store = createOriginalStore(fakeTime());
    store.begin(' https://img.example/a.jpg ').finish(bytes(4), 'image/jpeg');
    assert.ok(await store.get('https://img.example/a.jpg'));
  });

  await ok('an address nobody fetched is not there', async () => {
    const store = createOriginalStore(fakeTime());
    assert.strictEqual(await store.get('https://img.example/none.jpg', { waitMs: 50 }), null);
    assert.strictEqual(await store.get(''), null);
  });

  await ok('a download in flight is joined: the waiter gets it when it finishes', async () => {
    const time = fakeTime();
    const store = createOriginalStore(time);
    const handle = store.begin('https://img.example/b.png');
    const waiting = store.get('https://img.example/b.png', { waitMs: 30000 });
    await tick();
    handle.finish(bytes(7, 2), 'image/png');
    const got = await waiting;
    assert.ok(got && got.bytes.equals(bytes(7, 2)));
    assert.strictEqual(store.stats().pending, 0);
  });

  await ok('without a wait, a download in flight is not waited for', async () => {
    const store = createOriginalStore(fakeTime());
    store.begin('https://img.example/c.jpg');
    assert.strictEqual(await store.get('https://img.example/c.jpg'), null);
  });

  await ok('a download that broke or was cut off gives the waiter nothing, and nothing is kept', async () => {
    const store = createOriginalStore(fakeTime());
    const handle = store.begin('https://img.example/d.jpg');
    const waiting = store.get('https://img.example/d.jpg', { waitMs: 30000 });
    handle.fail();
    assert.strictEqual(await waiting, null);
    handle.finish(bytes(5), 'image/jpeg'); // settled already: ignored
    assert.strictEqual(await store.get('https://img.example/d.jpg'), null);
    assert.deepStrictEqual(store.stats(), { entries: 0, bytes: 0, pending: 0 });
  });

  await ok('a waiter gives up after its wait and the caller fetches for itself', async () => {
    const time = fakeTime();
    const store = createOriginalStore(time);
    store.begin('https://img.example/slow.jpg');
    const waiting = store.get('https://img.example/slow.jpg', { waitMs: 30000 });
    await tick();
    time.advance(30000);
    assert.strictEqual(await waiting, null);
  });

  await ok('empty bytes, a non-buffer or no content type are never kept', async () => {
    const store = createOriginalStore(fakeTime());
    store.begin('https://img.example/e1.jpg').finish(Buffer.alloc(0), 'image/jpeg');
    store.begin('https://img.example/e2.jpg').finish('not bytes', 'image/jpeg');
    store.begin('https://img.example/e3.jpg').finish(bytes(3), '');
    for (const name of ['e1', 'e2', 'e3']) {
      assert.strictEqual(await store.get(`https://img.example/${name}.jpg`), null, name);
    }
    assert.strictEqual(store.stats().entries, 0);
  });

  await ok('past the count limit the least recently used original goes first', async () => {
    const store = createOriginalStore({ ...fakeTime(), maxEntries: 2 });
    store.begin('u:a').finish(bytes(1), 'image/jpeg');
    store.begin('u:b').finish(bytes(1), 'image/jpeg');
    assert.ok(await store.get('u:a')); // a is now the most recent
    store.begin('u:c').finish(bytes(1), 'image/jpeg');
    assert.ok(await store.get('u:a'));
    assert.strictEqual(await store.get('u:b'), null);
    assert.ok(await store.get('u:c'));
  });

  await ok('past the byte limit the oldest originals go; one bigger than the limit is not kept', async () => {
    const store = createOriginalStore({ ...fakeTime(), maxEntries: 10, maxBytes: 100 });
    store.begin('u:a').finish(bytes(60), 'image/jpeg');
    store.begin('u:b').finish(bytes(60), 'image/jpeg');
    assert.strictEqual(await store.get('u:a'), null);
    assert.ok(await store.get('u:b'));
    assert.strictEqual(store.stats().bytes, 60);
    const big = store.begin('u:big');
    const waiting = store.get('u:big', { waitMs: 1000 });
    big.finish(bytes(150), 'image/jpeg');
    assert.ok(await waiting, 'the waiter still gets a complete original that is too big to keep');
    assert.strictEqual(await store.get('u:big'), null);
    assert.ok(await store.get('u:b'), 'a refused big one does not push the others out');
  });

  await ok('the same address finished again replaces the old bytes without double counting', async () => {
    const store = createOriginalStore(fakeTime());
    store.begin('u:a').finish(bytes(10), 'image/jpeg');
    store.begin('u:a').finish(bytes(20), 'image/png');
    const got = await store.get('u:a');
    assert.strictEqual(got.bytes.length, 20);
    assert.strictEqual(got.contentType, 'image/png');
    assert.strictEqual(store.stats().bytes, 20);
  });

  await ok('originals expire, and the memory is given back without anyone asking', async () => {
    const time = fakeTime();
    const store = createOriginalStore({ ...time, ttlMs: 1000 });
    store.begin('u:a').finish(bytes(10), 'image/jpeg');
    time.advance(999);
    assert.ok(await store.get('u:a'));
    time.advance(1);
    assert.deepStrictEqual(store.stats(), { entries: 0, bytes: 0, pending: 0 }, 'swept by its own timer');
    assert.strictEqual(time.pending(), 0, 'no timer left behind once empty');
    assert.strictEqual(await store.get('u:a'), null);
  });

  await ok('clear drops everything kept', async () => {
    const store = createOriginalStore(fakeTime());
    store.begin('u:a').finish(bytes(10), 'image/jpeg');
    store.clear();
    assert.strictEqual(await store.get('u:a'), null);
    assert.strictEqual(store.stats().bytes, 0);
  });

  await ok('two adds of one picture at once share one run and one result', async () => {
    const flight = createInFlight();
    let calls = 0;
    let release;
    const fn = () => { calls += 1; return new Promise((resolve) => { release = resolve; }); };
    const first = flight.run('internet:u', fn);
    const second = flight.run('internet:u', fn);
    await tick();
    assert.strictEqual(calls, 1);
    release('stored');
    assert.deepStrictEqual(await Promise.all([first, second]), ['stored', 'stored']);
    assert.strictEqual(flight.size(), 0, 'forgotten once settled');
    await flight.run('internet:u', async () => { calls += 1; });
    assert.strictEqual(calls, 2, 'a later add runs again');
  });

  await ok('a failed run fails both callers and is not remembered', async () => {
    const flight = createInFlight();
    let calls = 0;
    const fn = async () => { calls += 1; throw new Error('HTTP 503'); };
    const results = await Promise.allSettled([flight.run('k', fn), flight.run('k', fn)]);
    assert.deepStrictEqual(results.map((r) => r.status), ['rejected', 'rejected']);
    assert.strictEqual(calls, 1);
    assert.strictEqual(flight.size(), 0);
  });

  await ok('different pictures and an empty key are never joined', async () => {
    const flight = createInFlight();
    let calls = 0;
    const fn = async () => { calls += 1; };
    await Promise.all([flight.run('a', fn), flight.run('b', fn), flight.run('', fn), flight.run('', fn)]);
    assert.strictEqual(calls, 4);
  });

  if (failures.length) {
    console.log('\n' + failures.length + ' test(s) failed.');
    for (const f of failures) console.log('\n--- ' + f.name + ' ---\n' + (f.e && f.e.stack));
    process.exit(1);
  }
  console.log(`\nOriginal store PASS: ${passed} checks`);
})();
