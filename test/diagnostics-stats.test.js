'use strict';

const assert = require('assert');
const { summarize, percentile, growthRatio, sum } = require('../diagnostics/core/stats');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  OK ' + name); passed++; };

const empty = summarize([]);
ok('empty input yields null stats, not zeros',
  empty.count === 0 && empty.max === null && empty.p95 === null && empty.mean === null);

const s = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
ok('summarize computes count/min/max/mean', s.count === 10 && s.min === 10 && s.max === 100 && s.mean === 55);
ok('percentiles are interpolated', s.p50 === 55 && s.p95 > 90 && s.p95 <= 100);

ok('single value percentile is that value', percentile([42], 95) === 42);
ok('non-numbers are filtered out', summarize([1, 'x', null, 3, NaN, 5]).count === 3);
ok('sum ignores non-numbers', sum([1, 2, 'x', 3, null]) === 6);

ok('growthRatio detects growth over the session', growthRatio(100, 250) === 2.5);
ok('growthRatio of stable metric is ~1', growthRatio(200, 200) === 1);
ok('growthRatio with missing side is null, not a fake trend',
  growthRatio(undefined, 100) === null && growthRatio(0, 5) === null);
ok('growthRatio 0→0 is 1', growthRatio(0, 0) === 1);

console.log('\nAll ' + passed + ' diagnostics stats tests passed.');
