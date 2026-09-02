'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonlWriter } = require('../diagnostics/core/writer');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  OK ' + name);
  passed++;
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'znada-diagnostics-writer-'));
}

function event(category, name = 'sample') {
  return {
    protocolVersion: 1,
    sessionId: 's1',
    sequence: 1,
    source: { role: 'test' },
    timestampMs: 0,
    kind: 'metric',
    category,
    name,
    attributes: {},
  };
}

(async () => {
  const dir = tmpDir();
  const writer = await new JsonlWriter({
    filePath: path.join(dir, 'events.jsonl'),
    flushIntervalMs: 0,
  }).start();
  writer.enqueue([event('a'), event('b')]);
  await writer.flush();
  const lines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  ok('flush writes queued events as JSONL', lines.length === 2 && JSON.parse(lines[0]).category === 'a');

  const bounded = await new JsonlWriter({
    filePath: path.join(tmpDir(), 'events.jsonl'),
    flushIntervalMs: 0,
    maxPendingBytes: 180,
    reservedPendingBytes: 2048,
  }).start();
  const normal = bounded.enqueue([event('normal'), event('normal')]);
  const reserved = bounded.enqueue(event('manual'), { reserved: true });
  ok('bounded queue drops ordinary overflow but accepts reserved manual mark',
    normal.accepted === 1 && normal.dropped === 1 && reserved.accepted === 1);

  const stopping = await new JsonlWriter({
    filePath: path.join(tmpDir(), 'events.jsonl'),
    flushIntervalMs: 0,
  }).start();
  stopping.enqueue(event('stop'));
  await stopping.stop();
  ok('stop flushes pending events', fs.existsSync(stopping.filePath) && fs.readFileSync(stopping.filePath, 'utf8').includes('"stop"'));

  let degradedReason = '';
  const brokenFs = {
    promises: {
      mkdir: async () => {},
      appendFile: async () => { throw new Error('disk failed'); },
    },
  };
  const broken = await new JsonlWriter({
    filePath: path.join(tmpDir(), 'events.jsonl'),
    fsModule: brokenFs,
    flushIntervalMs: 0,
    onDegraded: (reason) => { degradedReason = reason; },
  }).start();
  broken.enqueue(event('broken'));
  await broken.flush();
  ok('write error degrades writer without throwing', broken.getStats().degraded && degradedReason === 'write_error');

  let releaseDelayedWrite = null;
  const delayedFs = {
    promises: {
      mkdir: async () => {},
      appendFile: () => new Promise((resolve) => { releaseDelayedWrite = resolve; }),
    },
  };
  const delayed = await new JsonlWriter({
    filePath: path.join(tmpDir(), 'events.jsonl'),
    fsModule: delayedFs,
    flushIntervalMs: 0,
  }).start();
  delayed.enqueue(event('delayed'));
  const delayedFlush = delayed.flush();
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  ok('default writer stays active while a delayed append is still pending',
    delayed.getStats().active && !delayed.getStats().degraded);
  releaseDelayedWrite();
  await delayedFlush;
  ok('delayed append completes without degrading the recording',
    delayed.getStats().active && !delayed.getStats().degraded && delayed.getStats().flushes === 1);

  const slowFs = {
    promises: {
      mkdir: async () => {},
      appendFile: () => new Promise((resolve) => { setTimeout(resolve, 50); }),
    },
  };
  const slow = await new JsonlWriter({
    filePath: path.join(tmpDir(), 'events.jsonl'),
    fsModule: slowFs,
    flushIntervalMs: 0,
    flushTimeoutMs: 1,
  }).start();
  slow.enqueue(event('slow'));
  await slow.flush();
  ok('flush timeout degrades writer', slow.getStats().degraded && slow.getStats().degradedReason === 'flush_timeout');

  const capped = await new JsonlWriter({
    filePath: path.join(tmpDir(), 'events.jsonl'),
    flushIntervalMs: 0,
    maxFileBytes: 60,
  }).start();
  capped.enqueue(event('too-big'));
  ok('max file limit hard-stops writing', capped.getStats().degraded && capped.getStats().degradedReason === 'max_file_bytes');

  console.log('\nAll ' + passed + ' diagnostics writer tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
