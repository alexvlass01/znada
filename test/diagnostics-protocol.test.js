'use strict';

const assert = require('assert');
const { createProtocol, normalizeEvent, sanitizeAttributes } = require('../diagnostics/core/protocol');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  OK ' + name);
  passed++;
};

const protocol = createProtocol({
  sessionId: 's1',
  source: { role: 'main', pid: 123 },
  timeOriginMs: 1000,
  now: () => 1100,
});
const a = protocol.normalize({ kind: 'span', category: 'library', name: 'render', timestampMs: 1100 });
const b = protocol.normalize({ kind: 'span', category: 'library', name: 'layout', timestampMs: 1100 });
ok('events receive increasing sequence even with same timestamp', a.sequence === 1 && b.sequence === 2);
ok('timestamps are normalized relative to session start', a.timestampMs === 100);
ok('default source is applied', a.source.role === 'main' && a.source.pid === 123);

const counters = { invalidEvents: 0, invalidAttributes: 0, oversizedAttributes: 0, droppedAttributes: 0 };
const invalid = normalizeEvent({ kind: '', category: 'x', name: 'y' }, {
  sessionId: 's1',
  sequence: 1,
  source: { role: 'main' },
  timeOriginMs: 0,
  nowMs: 0,
  counters,
});
ok('invalid event is rejected and counted', invalid === null && counters.invalidEvents === 1);

const attrs = sanitizeAttributes({
  queueDepth: 2,
  inserted: 3,
  moved: 1,
  removed: 2,
  unknown: 'x',
  reason: 'ok',
  label: 'x'.repeat(1001),
  active: true,
  unavailable: null,
  bytes: { bad: true },
}, counters);
ok('attribute whitelist keeps only allowed keys', attrs.queueDepth === 2
  && attrs.inserted === 3 && attrs.moved === 1 && attrs.removed === 2
  && attrs.reason === 'ok' && attrs.unknown === undefined);
ok('unavailable/null is preserved instead of becoming zero', Object.prototype.hasOwnProperty.call(attrs, 'unavailable') && attrs.unavailable === null);
ok('invalid and oversized attributes are counted', counters.droppedAttributes >= 1 && counters.invalidAttributes >= 1 && counters.oversizedAttributes >= 1);

const thumbnailAttrs = sanitizeAttributes({
  pid: 456,
  id: 17,
  op: 'thumbnail',
  size: 320,
  totalMs: 42,
  durationMs: 39,
  encodedBytes: 12345,
  mime: 'image/jpeg',
  windowsCache: 'hit',
  lowQuality: false,
  retry: 1,
  protocolVersion: 1,
  helperVersion: '1.0.0',
  errorCode: 'extract_timeout',
});
ok('thumbnail helper diagnostics keep performance metadata',
  thumbnailAttrs.pid === 456
  && thumbnailAttrs.totalMs === 42
  && thumbnailAttrs.durationMs === 39
  && thumbnailAttrs.encodedBytes === 12345
  && thumbnailAttrs.windowsCache === 'hit'
  && thumbnailAttrs.helperVersion === '1.0.0'
  && thumbnailAttrs.errorCode === 'extract_timeout');

const valueEvent = protocol.normalize({
  kind: 'metric',
  category: 'fps',
  name: 'sample',
  value: null,
});
ok('null value is accepted as unavailable', Object.prototype.hasOwnProperty.call(valueEvent, 'value') && valueEvent.value === null);

console.log('\nAll ' + passed + ' diagnostics protocol tests passed.');
