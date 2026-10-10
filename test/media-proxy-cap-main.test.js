'use strict';

// QA-013. The stream proxy from PERF-008 hands a picture to the window while it is still
// arriving, so the size cap cannot wait for "after the download": it has to be enforced
// on every chunk, because `content-length` may be missing or may lie. The rule itself is
// the pure `overLimit` (test/media-proxy.test.js), but that test cannot see whether the
// handler still asks it inside the stream. This file drives the REAL handler that main.js
// registers and a fake upstream that sends more than it promised.
//
// For each tier with its own cap (`thumb` 2 MB, `full` 30 MB):
//   - a lying `content-length` and a missing one: not one byte above the cap reaches the
//     window, the stream ends with an error, and the upstream read is cancelled early;
//   - an honest `content-length` above the cap: 413 before the body is read at all;
//   - a body of exactly the cap: passes whole, so the cases above cannot pass merely
//     because everything fails.
//
// Run: node test/media-proxy-cap-main.test.js

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

// A stream nobody closes leaves Node with nothing to do, and Node then exits with code 0
// in the middle of the run. Without this, a hang here would look like a pass.
process.on('exit', () => {
  if (finished) return;
  console.log('\nStopped before the end, inside: ' + (running || '(setup)'));
  process.exitCode = 1;
});

// Deliberately not a divisor of either cap: the chunk that crosses the cap is then only
// partly "allowed", and passing any of it would be a byte too many.
const CHUNK = 100000;

const mediaUrl = (tier, url) =>
  `znada-media://media/?t=${tier}&p=danbooru&u=${encodeURIComponent(url)}`;

// An upstream shaped the way `fetch` shapes one. It produces bytes only when read
// (`highWaterMark: 0`), so `produced` says how far the handler actually read, and it
// records whether the handler gave up on it.
function upstream({ total, contentLength }) {
  const state = { produced: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      if (state.produced >= total) {
        controller.close();
        return;
      }
      const size = Math.min(CHUNK, total - state.produced);
      state.produced += size;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  const headers = {
    get(name) {
      const key = String(name).toLowerCase();
      if (key === 'content-type') return 'image/jpeg';
      if (key === 'content-length') return contentLength == null ? null : String(contentLength);
      return null;
    },
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, headers, body });
  return state;
}

// Read what the window would read, the way it would read it: chunk by chunk, until the
// stream ends or fails.
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

const TIERS = [
  { tier: 'thumb', cap: mediaProxy.THUMB_MAX_BYTES, url: 'https://cdn.donmai.us/preview/aa/bb/aabbcc' },
  { tier: 'full', cap: mediaProxy.FULL_MAX_BYTES, url: 'https://cdn.donmai.us/original/aa/bb/aabbcc' },
];

(async () => {
  const dir = H.makeTempProfile('media-proxy-cap');
  try {
    H.writeJson(path.join(dir, 'config.json'), { autoSwitch: true, style: 'fill', monitors: {} });
    const main = H.loadMain(dir);
    main.__test.loadConfig();
    main.__test.registerMediaProxy();
    const handle = main.protocol.handlers.get(mediaProxy.SCHEME);
    assert.ok(handle, 'main must register a handler for its own media scheme');

    for (const { tier, cap, url } of TIERS) {
      assert.strictEqual(mediaProxy.limitFor(tier), cap, `${tier}: the cap this file assumes`);

      // Both ways the header can fail to protect: it promises little, or says nothing.
      // Either way the header check lets the answer through, and only the check inside
      // the stream stands between the window and the rest of the file.
      for (const [label, contentLength] of [['content-length lies (100 bytes)', 100], ['no content-length', null]]) {
        await check(`${tier}: ${label} — nothing above the cap reaches the window`, async () => {
          const total = cap + 5 * CHUNK;
          const sent = upstream({ total, contentLength });
          const res = await handle({ url: mediaUrl(tier, `${url}-${contentLength}.jpg`) });
          assert.strictEqual(res.status, 200, 'the header gives no reason to refuse, so the stream starts');
          const { received, error } = await drain(res);
          assert.ok(received <= cap,
            `${received} bytes reached the window, the cap is ${cap}: ${received - cap} too many`);
          assert.ok(error, 'the stream must end with an error, not as a complete (cut) picture');
          assert.match(String(error && error.message), /too large/);
          // Streaming still delivers what fits: the refusal is at the cap, not up front.
          // At most the chunk the handler read ahead is dropped together with the error.
          assert.ok(received > cap - 2 * CHUNK,
            `only ${received} of ${cap} allowed bytes arrived before the cut`);
          assert.strictEqual(sent.cancelled, true, 'the upstream read must be cancelled, not left hanging');
          assert.ok(sent.produced < total,
            `the handler kept reading after the cap: ${sent.produced} of ${total} bytes pulled`);
        });
      }

      await check(`${tier}: an honest content-length above the cap is refused before the body is read`, async () => {
        const sent = upstream({ total: cap + 1, contentLength: cap + 1 });
        const res = await handle({ url: mediaUrl(tier, `${url}-honest.jpg`) });
        assert.strictEqual(res.status, 413);
        assert.strictEqual(sent.produced, 0, 'not a byte of the body may be read after the header said too large');
      });

      await check(`${tier}: exactly the cap passes whole`, async () => {
        const sent = upstream({ total: cap, contentLength: cap });
        const res = await handle({ url: mediaUrl(tier, `${url}-exact.jpg`) });
        assert.strictEqual(res.status, 200);
        const { received, error } = await drain(res);
        assert.strictEqual(error, null, `the cap itself is allowed, but the stream failed: ${error && error.message}`);
        assert.strictEqual(received, cap);
        assert.strictEqual(sent.cancelled, false);
      });
    }
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
