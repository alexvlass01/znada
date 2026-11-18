'use strict';

// PERF-007. A stalled read must reject and release the stream. A finished read
// must not destroy the stream before listeners registered ahead of ours run.

const assert = require('assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { hashFileMd5, HASH_TIMEOUT, ABORT_ERR } = require('../src/metadata-hash');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

function fakeStream() {
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.destroy = () => {
    stream.destroyed = true;
    stream.emit('close');
  };
  return stream;
}

(async () => {
  {
    const stream = fakeStream();
    const ac = new AbortController();
    const pending = hashFileMd5('stalled', {
      createReadStream: () => stream,
      signal: ac.signal,
      timeoutMs: 0,
      setTimer() { throw new Error('no timer'); },
      clearTimer() {},
    });
    ac.abort();
    await assert.rejects(pending, (err) => err && err.code === ABORT_ERR);
    ok('abort destroys the stalled stream and rejects without a digest', stream.destroyed === true);
  }

  {
    const stream = fakeStream();
    let timerFn = null;
    let cleared = false;
    const pending = hashFileMd5('slow', {
      createReadStream: () => stream,
      timeoutMs: 50,
      setTimer(fn) { timerFn = fn; return { unref() {} }; },
      clearTimer() { cleared = true; },
    });
    assert.strictEqual(typeof timerFn, 'function');
    timerFn();
    await assert.rejects(pending, (err) => err && err.code === HASH_TIMEOUT);
    ok('the hash deadline destroys the stream and clears its timer', stream.destroyed === true && cleared === true);
  }

  {
    const bytes = Buffer.from('wallpaper-bytes');
    const stream = fakeStream();
    let cleared = false;
    let endFirst = false;
    stream.on('end', () => { endFirst = true; });
    const pending = hashFileMd5('ok', {
      createReadStream: () => stream,
      timeoutMs: 5000,
      setTimer() { return { unref() {} }; },
      clearTimer() { cleared = true; },
    });
    stream.emit('data', bytes);
    stream.emit('end');
    const digest = await pending;
    ok('a finished read keeps the digest, clears the timer, and leaves the earlier end listener alone',
      digest === crypto.createHash('md5').update(bytes).digest('hex')
      && cleared === true
      && endFirst === true
      && stream.destroyed === false);
  }

  {
    // Замечание независимой проверки PR #334: ошибку чтения проверял только сам код, тест её не трогал,
    // поэтому потерянный дескриптор при сбое диска прошёл бы мимо.
    const stream = fakeStream();
    const pending = hashFileMd5('broken', {
      createReadStream: () => stream,
      timeoutMs: 5000,
      setTimer() { return { unref() {} }; },
      clearTimer() {},
    });
    const boom = Object.assign(new Error('disk read failed'), { code: 'EIO' });
    stream.emit('error', boom);
    await assert.rejects(pending, (err) => err === boom);
    ok('a read error releases the stream handle', stream.destroyed === true);
  }

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
