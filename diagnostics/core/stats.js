'use strict';

// Small pure statistics helpers for the report. Empty input yields null fields
// (unavailable) rather than 0, so an absent metric never reads as a real zero.

function toFiniteNumbers(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((v) => typeof v === 'number' && Number.isFinite(v));
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const weight = rank - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function round2(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

// { count, min, max, mean, p50, p95, p99 } — all null when there is no data.
function summarize(values) {
  const nums = toFiniteNumbers(values);
  if (!nums.length) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  return {
    count: sorted.length,
    min: round2(sorted[0]),
    max: round2(sorted[sorted.length - 1]),
    mean: round2(sum / sorted.length),
    p50: round2(percentile(sorted, 50)),
    p95: round2(percentile(sorted, 95)),
    p99: round2(percentile(sorted, 99)),
  };
}

function sum(values) {
  return toFiniteNumbers(values).reduce((acc, n) => acc + n, 0);
}

// Ratio of last-window to first-window, guarding divide-by-zero. > 1 means the metric
// grew over the session (the "worse over time" signature). null when either side is
// missing so callers can say "not enough data" instead of inventing a trend.
function growthRatio(firstValue, lastValue) {
  if (!Number.isFinite(firstValue) || !Number.isFinite(lastValue)) return null;
  if (firstValue === 0) return lastValue === 0 ? 1 : null;
  return round2(lastValue / firstValue);
}

module.exports = {
  toFiniteNumbers,
  summarize,
  percentile,
  sum,
  growthRatio,
  round2,
};
