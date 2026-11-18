'use strict';

// BUG-065. Some GIFs in the viewer never finished loading, and opening them again did
// not help. Measured 2026-11-07: Gelbooru post 1945703, a 23 MB GIF, was cut at
// 22.97 MB after exactly 30 s. The stream proxy from PERF-008 had one 30 s deadline on
// the WHOLE transfer (`AbortSignal.timeout` on fetch also covers reading the body), so a
// big file that was still arriving was cut, the window got an error for the original,
// and the viewer stayed on the small thumbnail. Every attempt hit the same wall.
//
// The rule now: a limit on silence, not on duration. This file drives the REAL handler
// main.js registers (test/helpers/main-harness) with a fake upstream that honours the
// abort signal the way `fetch` does, and short limits set through `__test`:
//   - a slow transfer that keeps moving and lasts many times both limits arrives whole,
//     and its original is kept for "Add" (PERF-010);
//   - a transfer that goes quiet is cut within the limit, ends with an ERROR (never as a
//     complete, cut picture), the upstream read is aborted, and nothing is kept;
//   - a site that never answers gets 504 within the answer limit.
//
// Run: node test/media-proxy-stall-main.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const mediaProxy = require('../src/media-proxy');

const realFetch = globalThis.fetch;
let passed = 0;
const failures = [];
let running = '';
let finished = false;

process.on('exit', () => {
  if (finished) return;
  console.log('\nStopped before the end, inside: ' + (running || '(setup)'));
  process.exitCode = 1;
});

const LIMIT_MS = 150;
const CHUNK = 4096;

const mediaUrl = (tier, url) =>
  `znada-media://media/?t=${tier}&p=danbooru&u=${encodeURIComponent(url)}`;

const headers = {
  get(name) {
    return String(name).toLowerCase() === 'content-type' ? 'image/gif' : null;
  },
};

// An upstream shaped the way `fetch` shapes one: the signal it was given aborts both the
// wait for an answer and every read of the body. `gapMs(i)` is the pause before chunk i;
// Infinity means the site goes quiet for good. `answerMs` delays the answer itself.
function upstream({ chunks, gapMs, answerMs = 0 }) {
  const state = { produced: 0, aborted: false, calls: 0 };
  globalThis.fetch = async (_url, init) => {
    state.calls += 1;
    const signal = init && init.signal;
    const waitOrAbort = (ms) => new Promise((resolve, reject) => {
      const fail = () => { state.aborted = true; reject(signal.reason || new Error('aborted')); };
      if (signal && signal.aborted) { fail(); return; }
      const t = Number.isFinite(ms) ? setTimeout(resolve, ms) : null;
      if (signal) signal.addEventListener('abort', () => { if (t) clearTimeout(t); fail(); }, { once: true });
    });
    if (answerMs) await waitOrAbort(answerMs);
    const body = new ReadableStream({
      async pull(controller) {
        if (state.produced >= chunks) { controller.close(); return; }
        await waitOrAbort(gapMs(state.produced));
        state.produced += 1;
        controller.enqueue(new Uint8Array(CHUNK).fill(state.produced & 0xff));
      },
    }, { highWaterMark: 0 });
    return { ok: true, status: 200, headers, body };
  };
  return state;
}

async function drain(res) {
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch (err) {
      return { received, error: err };
    }
    if (step.done) return { received, error: null };
    received += step.value.byteLength;
  }
}

async function check(name, fn) {
  running = name;
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n    ' + (err && err.message));
  } finally {
    globalThis.fetch = realFetch;
  }
}

(async () => {
  const dir = H.makeTempProfile('media-proxy-stall');
  try {
    H.writeJson(path.join(dir, 'config.json'), { autoSwitch: true, style: 'fill', monitors: {} });
    const main = H.loadMain(dir);
    main.__test.loadConfig();
    assert.strictEqual(typeof main.__test.setMediaProxyTimeouts, 'function',
      'main must let a test shorten the proxy limits; there is no other way to test them without waiting 30 s');
    main.__test.setMediaProxyTimeouts({ answerMs: LIMIT_MS, stallMs: LIMIT_MS });
    main.__test.registerMediaProxy();
    const handle = main.protocol.handlers.get(mediaProxy.SCHEME);
    assert.ok(handle, 'main must register a handler for its own media scheme');
    const store = main.__test.recentOriginals;

    for (const tier of ['full', 'thumb']) {
      await check(`${tier}: a slow transfer that keeps moving arrives whole, however long it takes`, async () => {
        // 24 pieces 60 ms apart: about 1.4 s, nine times either limit, and no gap near one.
        const chunks = 24;
        const url = `https://cdn.donmai.us/original/aa/bb/slow-${tier}.gif`;
        const sent = upstream({ chunks, gapMs: () => 60 });
        const started = Date.now();
        const res = await handle({ url: mediaUrl(tier, url) });
        assert.strictEqual(res.status, 200);
        const { received, error } = await drain(res);
        const took = Date.now() - started;
        assert.strictEqual(error, null, `cut after ${took} ms and ${received} bytes: ${error && error.message}`);
        assert.strictEqual(received, chunks * CHUNK);
        assert.ok(took > 4 * LIMIT_MS, `the transfer must outlast the limits to prove anything (${took} ms)`);
        assert.strictEqual(sent.aborted, false);
        if (tier === 'full') {
          const kept = await store.get(url, { waitMs: 0 });
          assert.ok(kept && kept.bytes.length === chunks * CHUNK, 'the complete original must be kept for "Add"');
        }
      });

      await check(`${tier}: a transfer that goes quiet is cut with an error and nothing is kept`, async () => {
        const url = `https://cdn.donmai.us/original/aa/bb/stall-${tier}.gif`;
        const sent = upstream({ chunks: 10, gapMs: (i) => (i < 3 ? 10 : Infinity) });
        const res = await handle({ url: mediaUrl(tier, url) });
        assert.strictEqual(res.status, 200);
        const started = Date.now();
        const { received, error } = await drain(res);
        const took = Date.now() - started;
        assert.ok(error, 'a cut transfer must end with an error, not as a complete (cut) picture');
        assert.strictEqual(received, 3 * CHUNK);
        assert.strictEqual(sent.aborted, true, 'the upstream read must be aborted, not left hanging');
        assert.ok(took < LIMIT_MS + 1000, `the stall must be noticed near the limit, took ${took} ms`);
        const kept = await store.get(url, { waitMs: 0 });
        assert.strictEqual(kept, null, 'a cut original must not be kept as if complete');
      });
    }

    await check('a window that waits between reads is not taken for a silent site', async () => {
      // Review of PR #312: the timer must be cleared when a piece arrives. Otherwise the
      // time the WINDOW takes to ask for the next piece counts as the site's silence,
      // and a picture is cut while the site keeps sending. Here the site is instant and
      // the reader pauses for twice the limit between reads.
      const chunks = 6;
      const url = 'https://cdn.donmai.us/original/aa/bb/slow-reader.gif';
      const sent = upstream({ chunks, gapMs: () => 0 });
      const res = await handle({ url: mediaUrl('full', url) });
      assert.strictEqual(res.status, 200);
      const reader = res.body.getReader();
      let received = 0;
      let error = null;
      for (;;) {
        let step;
        try {
          step = await reader.read();
        } catch (err) {
          error = err;
          break;
        }
        if (step.done) break;
        received += step.value.byteLength;
        await new Promise((done) => { setTimeout(done, 2 * LIMIT_MS); });
      }
      assert.strictEqual(error, null, `cut after ${received} bytes: ${error && error.message}`);
      assert.strictEqual(received, chunks * CHUNK);
      assert.strictEqual(sent.aborted, false, 'nothing may abort a site that answered every read at once');
      const kept = await store.get(url, { waitMs: 0 });
      assert.ok(kept && kept.bytes.length === chunks * CHUNK, 'the complete original must be kept');
    });

    await check('a site that never answers gets 504 within the answer limit', async () => {
      const sent = upstream({ chunks: 1, gapMs: () => 0, answerMs: Infinity });
      const started = Date.now();
      const res = await handle({ url: mediaUrl('full', 'https://cdn.donmai.us/original/aa/bb/silent.gif') });
      assert.strictEqual(res.status, 504);
      assert.strictEqual(sent.aborted, true);
      assert.ok(Date.now() - started < LIMIT_MS + 1000);
    });

    await check('an answer that comes late but inside the limit is not cut by the time it took', async () => {
      // The answer limit must stop when the answer arrives: waiting 100 ms of a 150 ms
      // limit, then 20 pieces 60 ms apart, must not be cut at 150 ms total.
      upstream({ chunks: 20, gapMs: () => 60, answerMs: 100 });
      const res = await handle({ url: mediaUrl('full', 'https://cdn.donmai.us/original/aa/bb/late.gif') });
      assert.strictEqual(res.status, 200);
      const { received, error } = await drain(res);
      assert.strictEqual(error, null, `cut: ${error && error.message}`);
      assert.strictEqual(received, 20 * CHUNK);
    });
  } finally {
    globalThis.fetch = realFetch;
    try { H.unloadMain(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  finished = true;
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const { name, err } of failures) console.log(`\n✗ ${name}\n${err && err.stack}`);
    process.exitCode = 1;
  }
})().catch((err) => {
  finished = true;
  console.error(err);
  process.exitCode = 1;
});
