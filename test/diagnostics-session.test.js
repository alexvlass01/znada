'use strict';

const assert = require('assert');
const { DiagnosticsSession } = require('../diagnostics/core/session');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  OK ' + name);
  passed++;
};

const session = new DiagnosticsSession({ source: { role: 'main', pid: 1 }, now: () => 1000 });
const first = session.start({ sessionId: 's1', nowMs: 1000 });
const again = session.start({ sessionId: 'ignored', nowMs: 2000 });
ok('start is idempotent while recording', first.sessionId === 's1' && again.sessionId === 's1' && first.generation === again.generation);

const batch = session.recordBatch([
  { kind: 'span', category: 'library', name: 'render', timestampMs: 1200 },
  { kind: 'metric', category: 'fps', name: 'frame-gap', value: 17, timestampMs: 1210 },
], { generation: first.generation, nowMs: 1210 });
ok('recordBatch accepts events for current generation', batch.length === 2 && batch[0].sequence === 1 && batch[1].sequence === 2);

const mark = session.mark('scroll lag', { generation: first.generation, nowMs: 4500 });
ok('manual mark records a 3 second lookback window',
  mark.category === 'manual' && mark.attributes.windowStartMs === 500 && mark.attributes.windowEndMs === 3500);

session.stop({ nowMs: 5000 });
const late = session.recordBatch([{ kind: 'span', category: 'late', name: 'ignored' }], { generation: first.generation, nowMs: 5100 });
ok('late batches after stop are ignored and counted', late.length === 0 && session.snapshot().lateBatches === 1);

session.complete();
ok('complete moves stopping session to complete', session.snapshot().state === 'complete');

const second = session.start({ sessionId: 's2', nowMs: 7000 });
const event = session.record({ kind: 'span', category: 'library', name: 'render', timestampMs: 7100 }, { generation: second.generation, nowMs: 7100 });
ok('new start gets a new generation and resets sequence', second.sessionId === 's2' && second.generation > first.generation && event.sequence === 1);

session.degrade('write_error');
ok('degrade records reason', session.snapshot().state === 'degraded' && session.snapshot().degradedReason === 'write_error');

console.log('\nAll ' + passed + ' diagnostics session tests passed.');
