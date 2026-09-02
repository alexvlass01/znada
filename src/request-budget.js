'use strict';

// How often Znada is allowed to ask an external catalogue a question.
//
// The metadata lookup is the first feature that can, by design, turn into MANY
// requests: one photo today, a whole folder later, everything-on-add after that. A
// library of a few thousand files hammering a free API is indistinguishable from a
// scraper, and the answer to a scraper is a ban — for every Znada user at once, since
// official builds share one set of credentials. So the budget is not a nicety bolted on
// when mass lookup arrives; it is the gate every single request goes through from the
// first slice, when there is only ever one.
//
// Three separate limits, because they fail differently:
//   * a token bucket bounds the SUSTAINED rate over a minute;
//   * a minimum gap bounds how tightly two requests may follow each other, so a burst
//     of user clicks cannot drain the bucket in one instant;
//   * a backoff blocks the host outright after it says no, doubling per consecutive
//     failure — a server answering 429 must not be asked again immediately, which is
//     precisely how a temporary throttle becomes a permanent block.
//
// Pure: the clock is passed in and every function returns a NEW state. That makes the
// interesting cases (bucket empty, 429 mid-burst, recovery) ordinary unit tests instead
// of tests that have to wait in real time.

// Tuned for what this actually is today: a person pressing a button, where one lookup
// can cost two requests (the post, then its tag kinds). The gap therefore has to be
// short enough to be invisible INSIDE one operation — a second of dead air in the
// middle of a single click reads as a broken feature — while the bucket is what
// actually bounds a burst of clicks and, later, a background sweep.
const DEFAULTS = Object.freeze({
  ratePerMinute: 30,
  burst: 8,
  minGapMs: 350,
  backoffBaseMs: 5000,
  // A refusal is answered with a much longer pause than a network hiccup: it is the
  // host explicitly telling us to stop.
  refusalBaseMs: 60000,
  backoffMaxMs: 15 * 60 * 1000,
});

function config(overrides) {
  const cfg = { ...DEFAULTS, ...(overrides || {}) };
  cfg.ratePerMinute = Math.max(1, Number(cfg.ratePerMinute) || DEFAULTS.ratePerMinute);
  cfg.burst = Math.max(1, Number(cfg.burst) || DEFAULTS.burst);
  cfg.minGapMs = Math.max(0, Number(cfg.minGapMs) || 0);
  return cfg;
}

function createState(now = 0, overrides) {
  const cfg = config(overrides);
  return {
    tokens: cfg.burst,
    refilledAt: Number(now) || 0,
    // null, not 0: a clock CAN read zero, and treating "never asked" as "asked at
    // time zero" made the very first pair of requests skip the minimum gap.
    lastRequestAt: null,
    failures: 0,
    blockedUntil: 0,
  };
}

function normalizeState(raw, now, overrides) {
  const cfg = config(overrides);
  if (!raw || typeof raw !== 'object') return createState(now, overrides);
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    tokens: Math.min(cfg.burst, Math.max(0, num(raw.tokens, cfg.burst))),
    refilledAt: Math.max(0, num(raw.refilledAt, now)),
    // `Number(null)` is 0, so the null sentinel has to be checked before coercing —
    // otherwise "never asked" silently becomes "asked at time zero" again.
    lastRequestAt: raw.lastRequestAt == null || !Number.isFinite(Number(raw.lastRequestAt))
      ? null
      : Number(raw.lastRequestAt),
    failures: Math.max(0, Math.floor(num(raw.failures, 0))),
    blockedUntil: Math.max(0, num(raw.blockedUntil, 0)),
  };
}

// Tokens accrue continuously rather than in per-minute steps, so a user who looks up
// one photo a minute is never told to wait just because a window boundary passed.
function refill(state, now, cfg) {
  const elapsed = Math.max(0, now - state.refilledAt);
  if (elapsed <= 0) return state;
  const gained = (elapsed / 60000) * cfg.ratePerMinute;
  if (gained <= 0) return state;
  return { ...state, tokens: Math.min(cfg.burst, state.tokens + gained), refilledAt: now };
}

// Whether one request may go out now. Never mutates: `state` in the result is what the
// caller must keep, and it only changes when the request is actually allowed.
function take(rawState, now, overrides) {
  const cfg = config(overrides);
  const at = Number(now) || 0;
  const state = refill(normalizeState(rawState, at, overrides), at, cfg);

  if (state.blockedUntil > at) {
    return { allowed: false, reason: 'backoff', retryAfterMs: state.blockedUntil - at, state };
  }
  const sinceLast = state.lastRequestAt == null ? Infinity : at - state.lastRequestAt;
  if (sinceLast < cfg.minGapMs) {
    return { allowed: false, reason: 'gap', retryAfterMs: cfg.minGapMs - sinceLast, state };
  }
  if (state.tokens < 1) {
    // How long until one whole token exists, not until the bucket is full.
    const needed = 1 - state.tokens;
    const waitMs = Math.ceil((needed / cfg.ratePerMinute) * 60000);
    return { allowed: false, reason: 'rate', retryAfterMs: waitMs, state };
  }
  return {
    allowed: true,
    reason: '',
    retryAfterMs: 0,
    state: { ...state, tokens: state.tokens - 1, lastRequestAt: at },
  };
}

function noteSuccess(rawState, now, overrides) {
  const at = Number(now) || 0;
  const state = normalizeState(rawState, at, overrides);
  return { ...state, failures: 0, blockedUntil: 0 };
}

// `kind`: 'refusal' for an explicit 429/403 from the host, anything else for a
// timeout or transport error. The distinction matters — a flaky network should not
// lock the feature out for a minute, and a refusal should not be retried in five
// seconds.
function noteFailure(rawState, now, kind, overrides) {
  const cfg = config(overrides);
  const at = Number(now) || 0;
  const state = normalizeState(rawState, at, overrides);
  const failures = state.failures + 1;
  const base = kind === 'refusal' ? cfg.refusalBaseMs : cfg.backoffBaseMs;
  const grown = base * Math.pow(2, Math.min(failures - 1, 10));
  const waitMs = Math.min(cfg.backoffMaxMs, grown);
  return { ...state, failures, blockedUntil: Math.max(state.blockedUntil, at + waitMs) };
}

// Classify a fetch outcome once, in one place, so every caller backs off the same way.
function failureKind(status, err) {
  const code = Number(status);
  if (code === 429 || code === 403 || code === 401) return 'refusal';
  if (err && (err.name === 'TimeoutError' || /timeout/i.test(String(err.message || '')))) return 'timeout';
  return 'network';
}

module.exports = {
  DEFAULTS,
  config,
  createState,
  normalizeState,
  take,
  noteSuccess,
  noteFailure,
  failureKind,
};
