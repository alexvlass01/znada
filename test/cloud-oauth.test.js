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

console.log('\nAll ' + passed + ' cloud-oauth tests passed.');
