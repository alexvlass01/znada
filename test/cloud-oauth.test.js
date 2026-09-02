'use strict';

// Plain Node test: `node test/cloud-oauth.test.js`. Covers the pure OAuth/PKCE
// helpers used by the Google sign-in flow (C4) — no Electron, no network.

const assert = require('assert');
const crypto = require('crypto');
const O = require('../src/cloud/oauth');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

// generatePkce: shapes + challenge derivation
{
  const { verifier, challenge } = O.generatePkce();
  ok('generatePkce: verifier matches pkce pattern', O.PKCE_RE.test(verifier) && verifier.length === 43);
  ok('generatePkce: challenge matches pkce pattern', O.PKCE_RE.test(challenge) && challenge.length === 43);
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  ok('generatePkce: challenge = base64url(sha256(verifier))', challenge === expected);
}
ok('generatePkce: deterministic with injected randomness', (() => {
  const fixed = Buffer.alloc(32, 7);
  const a = O.generatePkce(() => fixed);
  const b = O.generatePkce(() => fixed);
  return a.verifier === b.verifier && a.challenge === b.challenge;
})());
ok('generatePkce: different random → different verifier', (() => {
  const a = O.generatePkce(() => Buffer.alloc(32, 1));
  const b = O.generatePkce(() => Buffer.alloc(32, 2));
  return a.verifier !== b.verifier && a.challenge !== b.challenge;
})());

// isValidPkce
ok('isValidPkce: accepts a real verifier', O.isValidPkce(O.generatePkce().verifier));
ok('isValidPkce: rejects too short', !O.isValidPkce('abc'));
ok('isValidPkce: rejects bad chars', !O.isValidPkce('a'.repeat(20) + '!' + 'b'.repeat(22)));
ok('isValidPkce: rejects non-string', !O.isValidPkce(null) && !O.isValidPkce(undefined));

// parseLoopbackCode
ok('parseLoopbackCode: extracts code from path+query', O.parseLoopbackCode('/?code=ABC123') === 'ABC123');
ok('parseLoopbackCode: extracts from full URL', O.parseLoopbackCode('http://127.0.0.1:5123/?code=XYZ&state=1') === 'XYZ');
ok('parseLoopbackCode: null when no code', O.parseLoopbackCode('/?foo=bar') === null);
ok('parseLoopbackCode: null on junk', O.parseLoopbackCode(undefined) === null && O.parseLoopbackCode('') === null);

// parseLoopbackRequest (SEC-002 slice 3): what counts as the browser coming back.
//
// A loopback listener is reachable by every program on the machine, and a page in any
// browser can be made to fetch http://127.0.0.1:<port>/. The old rule was "does the URL
// carry a code" and nothing else.
{
  const STATE = 'znada-state-0123456789';
  const req = (over = {}) => Object.assign({
    method: 'GET',
    url: `/?code=ABC123&state=${STATE}`,
    headers: { host: '127.0.0.1:5123' },
  }, over);
  const at = { port: 5123, state: STATE };

  ok('loopback: the real redirect is accepted',
    O.parseLoopbackRequest(req(), at).ok === true
    && O.parseLoopbackRequest(req(), at).code === 'ABC123');

  ok('loopback: IPv6 loopback is our address too',
    O.parseLoopbackRequest(req({ headers: { host: '[::1]:5123' } }), at).ok === true);

  ok('loopback: anything but GET is refused',
    ['POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'].every(
      (method) => O.parseLoopbackRequest(req({ method }), at).reason === 'method'));

  ok('loopback: a request naming a hostname is refused, not resolved',
    O.parseLoopbackRequest(req({ headers: { host: 'evil.test:5123' } }), at).reason === 'host'
    && O.parseLoopbackRequest(req({ headers: { host: 'localhost:5123' } }), at).reason === 'host');

  ok('loopback: our address but a different port is refused',
    O.parseLoopbackRequest(req({ headers: { host: '127.0.0.1:9999' } }), at).reason === 'port');

  ok('loopback: no Host at all is refused',
    O.parseLoopbackRequest(req({ headers: {} }), at).reason === 'host');

  ok('loopback: a request with no code is refused',
    O.parseLoopbackRequest(req({ url: `/?error=access_denied&state=${STATE}` }), at).reason === 'code');

  // SEC-002 slice 3, second half. The backend now echoes a value we sent at the start,
  // and that is what ties an answer to the sign-in the user began. PKCE does not: the
  // challenge is visible in the system browser's address bar, so somebody who reads it
  // can start their own flow with the same challenge, sign in as themselves and hand us
  // that code. The exchange would succeed and the user would be signed in to a stranger's
  // account. RFC 8252 section 8.9.
  ok('loopback: a redirect carrying somebody else\'s state is refused',
    O.parseLoopbackRequest(req({ url: '/?code=ABC123&state=someone-elses-value' }), at).reason === 'state');

  ok('loopback: a redirect with no state at all is refused, not waved through',
    O.parseLoopbackRequest(req({ url: '/?code=ABC123' }), at).reason === 'state');

  // Exact, not "close enough": same length with one character changed, and the same
  // value in different case. (A trailing space cannot be tested here and does not need to
  // be - the URL parser strips it before anything sees it.)
  ok('loopback: a near-miss is still a miss',
    O.parseLoopbackRequest(req({ url: `/?code=ABC123&state=${STATE.toUpperCase()}` }), at).reason === 'state'
    && O.parseLoopbackRequest(req({ url: `/?code=ABC123&state=${STATE.slice(0, -1)}X` }), at).reason === 'state'
    && O.parseLoopbackRequest(req({ url: `/?code=ABC123&state=${STATE.slice(0, -1)}` }), at).reason === 'state');

  ok('loopback: a listener with no state of its own accepts nothing',
    O.parseLoopbackRequest(req(), { port: 5123 }).reason === 'noState'
    && O.parseLoopbackRequest(req(), { port: 5123, state: 'short' }).reason === 'noState');
}

// state: shape, uniqueness, and an exact comparison
{
  const a = O.generateState();
  ok('generateState: matches what the backend accepts', O.STATE_RE.test(a) && a.length === 43);
  ok('generateState: a different one every time', O.generateState() !== O.generateState());
  ok('generateState: deterministic with injected randomness',
    O.generateState(() => Buffer.alloc(32, 3)) === O.generateState(() => Buffer.alloc(32, 3)));

  ok('isValidState: eight characters is the floor the backend set',
    !O.isValidState('a'.repeat(7)) && O.isValidState('a'.repeat(8)));
  ok('isValidState: and 128 is the ceiling',
    O.isValidState('a'.repeat(128)) && !O.isValidState('a'.repeat(129)));
  ok('isValidState: only the alphabet the backend accepts',
    !O.isValidState('has space') && !O.isValidState('has+plus') && O.isValidState('dash-and_underscore'));
  ok('isValidState: nothing at all is not a state',
    !O.isValidState('') && !O.isValidState(null) && !O.isValidState(undefined));

  ok('sameState: equal strings match', O.sameState(a, a));
  ok('sameState: a prefix does not', !O.sameState(a, a.slice(0, -1)));
  ok('sameState: a different value does not', !O.sameState(a, O.generateState()));
  ok('sameState: empty or missing never matches',
    !O.sameState('', '') && !O.sameState(a, null) && !O.sameState(null, a));

  ok('loopback: junk is refused rather than thrown',
    O.parseLoopbackRequest(null, { port: 5123, state: a }).ok === false
    && O.parseLoopbackRequest({ method: 'GET', url: '/?code=X', headers: {} }, {}).ok === false);
}

console.log('\nAll ' + passed + ' cloud-oauth tests passed.');
