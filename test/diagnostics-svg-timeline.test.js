'use strict';

const assert = require('assert');
const { buildTimelineSvg, gapColor } = require('../diagnostics/core/svg-timeline');
const { toChromeTrace } = require('../diagnostics/core/trace-export');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  OK ' + name); passed++; };

// A session that degrades over time: smooth early, big stalls late.
const events = [
  { kind: 'sample', category: 'renderer', name: 'frame-window', timestampMs: 500, attributes: { maxMs: 16 }, source: { role: 'renderer-main' } },
  { kind: 'sample', category: 'renderer', name: 'frame-window', timestampMs: 9500, attributes: { maxMs: 180 }, source: { role: 'renderer-main' } },
  { kind: 'sample', category: 'main', name: 'event-loop', timestampMs: 9500, attributes: { maxMs: 120 }, source: { role: 'main' } },
  { kind: 'span', category: 'renderer', name: 'lazy-chunk', timestampMs: 3000, durationMs: 40, source: { role: 'renderer-main' } },
  { kind: 'mark', category: 'manual', name: 'user-mark', timestampMs: 9200, attributes: { label: 'lag' }, source: { role: 'renderer-main' } },
];

const svg = buildTimelineSvg(events, { durationMs: 10000 });
ok('svg is a self-contained element with a viewBox', svg.startsWith('<svg') && svg.includes('viewBox=') && svg.endsWith('</svg>'));
ok('svg has no scripts', !/<script/i.test(svg));
ok('svg renders all three row labels', svg.includes('Плавность') && svg.includes('Действия') && svg.includes('Система'));
ok('a big late stall is drawn in red', svg.includes('#e01b24'));
ok('a smooth early bucket is drawn in green', svg.includes('#33d17a'));
ok('manual mark is drawn in the marks colour', svg.includes('#2ec7e0'));
ok('duration + bucket footer is present', svg.includes('10s') && svg.includes('s/bucket'));

// Determinism: same input → identical string (golden/snapshot property).
ok('svg output is deterministic', buildTimelineSvg(events, { durationMs: 10000 }) === svg);

// Long session stays bounded (buckets widen past the column cap).
const many = Array.from({ length: 5000 }, (_, i) => ({
  kind: 'sample', category: 'renderer', name: 'frame-window', timestampMs: i * 1000, attributes: { maxMs: 30 }, source: { role: 'renderer-main' },
}));
const bigSvg = buildTimelineSvg(many, { durationMs: 5000 * 1000 });
const rectCount = (bigSvg.match(/<rect/g) || []).length;
ok('long session keeps the node count bounded', rectCount < 2000);

ok('gapColor scales green→amber→orange→red', gapColor(5) === '#33d17a' && gapColor(30) === '#f5c211' && gapColor(60) === '#ff7800' && gapColor(150) === '#e01b24');

// --- Chrome trace export ---
const trace = toChromeTrace(events, { sessionId: 's-1', app: { name: 'Lumina' } });
ok('trace has traceEvents and ms display unit', Array.isArray(trace.traceEvents) && trace.displayTimeUnit === 'ms');
const span = trace.traceEvents.find((t) => t.ph === 'X' && t.name === 'lazy-chunk');
ok('span becomes a complete X event in microseconds', span && span.ts === 3000000 && span.dur === 40000);
const mark = trace.traceEvents.find((t) => t.ph === 'i' && t.name === 'user-mark');
ok('manual mark becomes an instant event', !!mark);
const counters = trace.traceEvents.filter((t) => t.ph === 'C' && t.name === 'frame-window');
ok('frame samples become counters with their headline values',
  counters.some((c) => c.args.value === 16) && counters.some((c) => c.args.value === 180));
ok('roles are laid out on named threads', trace.traceEvents.some((t) => t.ph === 'M' && t.args.name === 'renderer-main'));
ok('trace serializes to JSON', typeof JSON.stringify(trace) === 'string');

console.log('\nAll ' + passed + ' diagnostics svg/trace tests passed.');
