'use strict';

// Pure events → SVG string. No JavaScript inside the SVG, deterministic output, and a
// bounded number of nodes even for a long session (buckets are widened past a column
// cap). Three stacked rows so the owner can SEE the shape of a session at a glance:
//   1. Smoothness  — worst renderer frame gap per time bucket (the stutter).
//   2. Actions     — where spans ran and where the user pressed "just lagged".
//   3. System      — worst main-process event-loop stall per bucket.
// A rising wall of red on rows 1/3 towards the right is the "worse over time" picture.

const DEFAULTS = {
  width: 900,
  rowHeight: 56,
  gutter: 96, // left label column
  maxColumns: 600, // cap bucket count → bounded SVG size
  capMs: 200, // frame/loop gap that fills a bar to full height
};

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function gapColor(ms) {
  if (!Number.isFinite(ms)) return '#3a3a3a';
  if (ms >= 100) return '#e01b24'; // red — bad stutter
  if (ms >= 50) return '#ff7800'; // orange — noticeable
  if (ms >= 20) return '#f5c211'; // amber — minor
  return '#33d17a'; // green — smooth
}

function sessionDurationMs(events, meta) {
  if (meta && Number.isFinite(meta.durationMs) && meta.durationMs > 0) return meta.durationMs;
  let max = 0;
  for (const e of events) {
    const end = (e.timestampMs || 0) + (e.durationMs || 0);
    if (end > max) max = end;
  }
  return Math.max(1000, max);
}

// Worst-per-bucket reducer for a metric extracted from matching events.
function bucketMax(events, bucketMs, nBuckets, match, valueOf) {
  const out = new Array(nBuckets).fill(null);
  for (const e of events) {
    if (!match(e)) continue;
    const idx = Math.min(nBuckets - 1, Math.floor((e.timestampMs || 0) / bucketMs));
    const v = valueOf(e);
    if (Number.isFinite(v) && (out[idx] === null || v > out[idx])) out[idx] = v;
  }
  return out;
}

function barsRow(values, { x0, y0, barW, rowHeight, capMs }) {
  let out = '';
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null) continue;
    const h = Math.max(1, Math.min(1, v / capMs) * rowHeight);
    const x = x0 + i * barW;
    out += `<rect x="${(x).toFixed(1)}" y="${(y0 + rowHeight - h).toFixed(1)}" width="${Math.max(0.5, barW - 0.3).toFixed(1)}" height="${h.toFixed(1)}" fill="${gapColor(v)}"/>`;
  }
  return out;
}

function buildTimelineSvg(events = [], meta = {}, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const list = Array.isArray(events) ? events : [];
  const durationMs = sessionDurationMs(list, meta);
  const bucketMs = Math.max(1000, Math.ceil(durationMs / opt.maxColumns / 1000) * 1000);
  const nBuckets = Math.max(1, Math.ceil(durationMs / bucketMs));
  const plotW = opt.width - opt.gutter;
  const barW = plotW / nBuckets;
  const rowGap = 26;
  const rows = [
    { key: 'smoothness', label: 'Плавность (frame gap)' },
    { key: 'actions', label: 'Действия (spans / mark)' },
    { key: 'system', label: 'Система (event-loop)' },
  ];
  const height = rows.length * (opt.rowHeight + rowGap) + 20;

  const smoothness = bucketMax(list, bucketMs, nBuckets,
    (e) => e.category === 'renderer' && e.name === 'frame-window',
    (e) => (e.attributes && e.attributes.maxMs));
  const system = bucketMax(list, bucketMs, nBuckets,
    (e) => e.category === 'main' && e.name === 'event-loop',
    (e) => (e.attributes && e.attributes.maxMs));

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${opt.width} ${height}" width="${opt.width}" height="${height}" font-family="system-ui,sans-serif" font-size="11">`;
  svg += `<rect x="0" y="0" width="${opt.width}" height="${height}" fill="#1b1b1b"/>`;

  rows.forEach((row, r) => {
    const y0 = r * (opt.rowHeight + rowGap) + 16;
    svg += `<text x="6" y="${(y0 + opt.rowHeight / 2).toFixed(1)}" fill="#cfcfcf">${esc(row.label)}</text>`;
    svg += `<rect x="${opt.gutter}" y="${y0}" width="${plotW.toFixed(1)}" height="${opt.rowHeight}" fill="#111"/>`;
    if (row.key === 'smoothness') {
      svg += barsRow(smoothness, { x0: opt.gutter, y0, barW, rowHeight: opt.rowHeight, capMs: opt.capMs });
    } else if (row.key === 'system') {
      svg += barsRow(system, { x0: opt.gutter, y0, barW, rowHeight: opt.rowHeight, capMs: opt.capMs });
    } else {
      // Actions: thin ticks for spans, a full-height cyan line for manual marks.
      for (const e of list) {
        if (e.kind !== 'span' && e.kind !== 'mark') continue;
        const idx = Math.min(nBuckets - 1, Math.floor((e.timestampMs || 0) / bucketMs));
        const x = opt.gutter + idx * barW + barW / 2;
        if (e.kind === 'mark') {
          svg += `<rect x="${(x - 1).toFixed(1)}" y="${y0}" width="2" height="${opt.rowHeight}" fill="#2ec7e0"/>`;
        } else {
          svg += `<rect x="${x.toFixed(1)}" y="${(y0 + opt.rowHeight - 8).toFixed(1)}" width="1" height="8" fill="#9aa0a6"/>`;
        }
      }
    }
  });

  svg += `<text x="${opt.gutter}" y="${(height - 4).toFixed(1)}" fill="#7a7a7a">0s</text>`;
  svg += `<text x="${(opt.width - 4).toFixed(1)}" y="${(height - 4).toFixed(1)}" fill="#7a7a7a" text-anchor="end">${Math.round(durationMs / 1000)}s · ${(bucketMs / 1000)}s/bucket</text>`;
  svg += '</svg>';
  return svg;
}

module.exports = {
  DEFAULTS,
  gapColor,
  buildTimelineSvg,
};
