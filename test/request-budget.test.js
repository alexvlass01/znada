'use strict';

// How much traffic Znada may send an external catalogue.
//
// This is the module that stands between "one user looks up a photo" and "the shared
// credentials in every official build get blocked". The clock is injected, so the cases
// that matter — a burst, a 429, recovery — are checked instantly instead of in real
// time, which is the only reason they get checked at all.

const assert = require('assert');
const budget = require('../src/request-budget');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

const T0 = 1_700_000_000_000;

// --- the minimum gap ------------------------------------------------------
let state = budget.createState(T0);
let gate = budget.take(state, T0);
ok('the first request goes out', gate.allowed);
state = gate.state;

gate = budget.take(state, T0 + 100);
ok('a second request 100 ms later is held back', !gate.allowed && gate.reason === 'gap');
ok('and it says exactly how long to wait',
  gate.retryAfterMs === budget.DEFAULTS.minGapMs - 100 && gate.retryAfterMs > 0);
// One lookup can cost two requests (the post, then its tag kinds). A gap long enough to
// be felt INSIDE a single click would read to the user as the feature hanging.
ok('the gap is short enough to be invisible within one operation', budget.DEFAULTS.minGapMs <= 500);
// Not "unchanged": the returned state has also accrued the tokens that time earned.
// What must never happen is a refusal charging for a request that never went out.
ok('a refused request is not charged for', gate.state.tokens >= state.tokens);

gate = budget.take(state, T0 + budget.DEFAULTS.minGapMs);
ok('once the gap has passed the request goes out', gate.allowed);

// A clock that legitimately reads zero must not be mistaken for "already asked at zero";
// that mistake let the first two requests skip the gap entirely.
const atZero = budget.createState(0);
const firstAtZero = budget.take(atZero, 0);
ok('a zero clock still allows a first request', firstAtZero.allowed);
ok('and the one right after it is still gapped', !budget.take(firstAtZero.state, 10).allowed);

// --- the sustained rate ---------------------------------------------------
state = budget.createState(T0);
let now = T0;
let sent = 0;
for (let i = 0; i < 40; i++) {
  now += budget.DEFAULTS.minGapMs;
  const step = budget.take(state, now);
  if (step.allowed) { state = step.state; sent += 1; }
}
const minutes = (now - T0) / 60000;
ok('the sustained rate is bounded even when every gap is respected',
  sent <= Math.ceil(budget.DEFAULTS.ratePerMinute * minutes) + budget.DEFAULTS.burst);
ok('and the limiter says the rate is why', budget.take(state, now).reason === 'rate');

// --- refusals and backoff -------------------------------------------------
let refused = budget.noteFailure(budget.createState(T0), T0, 'refusal');
const afterRefusal = budget.take(refused, T0 + 1000);
ok('after a refusal nothing goes out at all', !afterRefusal.allowed && afterRefusal.reason === 'backoff');
ok('a refusal pauses for much longer than a network hiccup',
  afterRefusal.retryAfterMs > budget.take(budget.noteFailure(budget.createState(T0), T0, 'timeout'), T0 + 1000).retryAfterMs);

const firstWait = budget.take(refused, T0 + 1).retryAfterMs;
refused = budget.noteFailure(refused, T0, 'refusal');
ok('consecutive refusals back off further', budget.take(refused, T0 + 1).retryAfterMs > firstWait);

let escalated = budget.createState(T0);
for (let i = 0; i < 40; i++) escalated = budget.noteFailure(escalated, T0, 'refusal');
ok('the backoff is capped rather than growing without bound',
  budget.take(escalated, T0 + 1).retryAfterMs <= budget.DEFAULTS.backoffMaxMs);

ok('a success clears the backoff',
  budget.take(budget.noteSuccess(refused, T0 + 10), T0 + 10).allowed);

// A pause already promised must not be shortened by a later, milder failure.
const long = budget.noteFailure(budget.createState(T0), T0, 'refusal');
const thenShort = budget.noteFailure(long, T0 + 10, 'timeout');
ok('a later small failure never shortens an existing pause', thenShort.blockedUntil >= long.blockedUntil);

// --- classification -------------------------------------------------------
ok('429, 403 and 401 are refusals, not hiccups',
  budget.failureKind(429) === 'refusal' && budget.failureKind(403) === 'refusal' && budget.failureKind(401) === 'refusal');
ok('a server error is an ordinary failure', budget.failureKind(500) === 'network');
ok('an abort is recognised as a timeout',
  budget.failureKind(0, { name: 'TimeoutError' }) === 'timeout'
  && budget.failureKind(0, new Error('request timeout')) === 'timeout');

// --- damaged state --------------------------------------------------------
ok('rubbish state heals into a usable one rather than throwing',
  budget.take(null, T0).allowed
  && budget.take({ tokens: 'many', blockedUntil: 'never' }, T0).allowed
  && budget.take({ tokens: 999999 }, T0).state.tokens <= budget.DEFAULTS.burst);

console.log(`\nAll ${passed} request-budget tests passed.`);
