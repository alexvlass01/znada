'use strict';

const assert = require('assert');
const { buildSummary, renderSummaryHtml, renderHumanText } = require('../diagnostics/core/report');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  OK ' + name); passed++; };

// A 30s session that gets worse over time: smooth + light early, stuttery + heavy late.
// This is the "the longer it's open, the more it lags" shape we most want the report to name.
const events = [];
function frame(ts, maxMs, longFrames) {
  events.push({ kind: 'sample', category: 'renderer', name: 'frame-window', timestampMs: ts, attributes: { maxMs, longFrames }, source: { role: 'renderer-main' } });
}
function resources(ts, heapMB, nodes, cards) {
  events.push({ kind: 'sample', category: 'renderer', name: 'resources', timestampMs: ts, attributes: { heapMB, nodes, cards }, source: { role: 'renderer-main' } });
}
function proc(ts, memoryMB) {
  events.push({ kind: 'sample', category: 'process', name: 'process', timestampMs: ts, attributes: { role: 'renderer-main', pid: 5, memoryMB }, source: { role: 'main' } });
}
// early third (0-10s): smooth ~16ms, low resources
for (let t = 500; t < 10000; t += 1000) { frame(t, 16 + (t % 3), 0); }
resources(500, 90, 3000, 60); proc(500, 120);
// late third (20-30s): big stalls ~180ms, grown resources
for (let t = 20000; t < 30000; t += 1000) { frame(t, 170 + (t % 20), 3); }
resources(29500, 240, 12000, 900); proc(29500, 360);
// a manual mark near a late stall + a couple of spans + a long task
events.push({ kind: 'mark', category: 'manual', name: 'user-mark', timestampMs: 25000, attributes: { label: 'lag', windowStartMs: 22000, windowEndMs: 25000 }, source: { role: 'renderer-main' } });
events.push({ kind: 'span', category: 'renderer', name: 'lazy-chunk', timestampMs: 24000, durationMs: 55, source: { role: 'renderer-main' } });
events.push({ kind: 'span', category: 'library', name: 'folder-entries', timestampMs: 1000, durationMs: 12, source: { role: 'main' } });
events.push({ kind: 'sample', category: 'renderer', name: 'long-task', timestampMs: 24000, durationMs: 210, attributes: { maxMs: 210 }, source: { role: 'renderer-main' } });

const meta = { sessionId: 's-test', startedAtMs: 1000, stoppedAtMs: 31000, state: 'complete', startedAtIso: '2026-07-09T18:00:00.000Z' };
const summary = buildSummary(events, meta);

ok('detects degradation over time', summary.smoothness.degradedOverTime === true);
ok('smoothness growth ratio is large', summary.smoothness.growth >= 5);
ok('early window is smooth, late window is stuttery',
  summary.smoothness.early.meanMaxMs < 30 && summary.smoothness.late.meanMaxMs > 150);
ok('flags the resources that grew', summary.resourcesGrew.includes('heapMB') && summary.resourcesGrew.includes('nodes') && summary.resourcesGrew.includes('cards'));
ok('renderer memory growth is captured', summary.resources.rendererMemMB.first === 120 && summary.resources.rendererMemMB.last === 360);
ok('long tasks are summarized', summary.longTasks.count === 1 && summary.longTasks.max === 210);
ok('spans are grouped and sorted by max', summary.spans[0].name === 'renderer/lazy-chunk' && summary.spans[0].max === 55);
ok('manual mark reports the worst nearby frame', summary.marks.length === 1 && summary.marks[0].worstFrameNearbyMs >= 150);

const hasLeakHypothesis = summary.hypotheses.some((h) => /накопление|утечк/i.test(h));
ok('names a leak/accumulation hypothesis (not as a fact)', hasLeakHypothesis);
ok('correlation links smoothness drop with resource growth',
  summary.correlations.some((c) => /ОДНОВРЕМЕННО|одновременно/.test(c)));

const html = renderSummaryHtml(summary, events, meta);
// Self-contained = no external resource loads. The SVG xmlns URI is a namespace, not a
// fetch, so we check for actual load vectors instead of any "http".
ok('html is self-contained with no external requests', html.startsWith('<!doctype html>') &&
  !/<script/i.test(html) && !/\b(?:src|href)\s*=\s*["']https?:/i.test(html) &&
  !/@import/i.test(html) && !/url\(\s*https?:/i.test(html));
ok('html shows the degradation verdict', html.includes('ухудшалась к концу'));
ok('html embeds the timeline svg', html.includes('<svg') && html.includes('Плавность'));

// Privacy: a path accidentally left in an attribute would show up in HTML — make sure
// our synthetic events carry none, and that escaping is applied to strings.
ok('html has no raw windows path', !/[A-Z]:\\\\Users/.test(html));

const text = renderHumanText(summary);
ok('human text lists facts and hypotheses', text.includes('ЧТО ВИДНО') && text.includes('ГИПОТЕЗЫ'));

// Empty / hidden-window session: no frame data → says so, no invented trend.
const emptySummary = buildSummary([], { sessionId: 'e', startedAtMs: 0, stoppedAtMs: 5000 });
ok('empty session does not invent a degradation', emptySummary.smoothness.degradedOverTime === false &&
  emptySummary.hypotheses.some((h) => /не измерена|не видно/i.test(h)));

console.log('\nAll ' + passed + ' diagnostics report tests passed.');
