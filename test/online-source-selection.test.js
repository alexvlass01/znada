'use strict';

const assert = require('assert/strict');
const O = require('../src/online');

// Characterize the already-working byte identity before changing the search policy.
const same = 'a'.repeat(32);
assert.equal(O.interleave([
  [{ provider: 'one', id: '1', md5: same }],
  [{ provider: 'two', id: '2', md5: same.toUpperCase() }],
]).length, 1);
assert.equal(O.interleave([
  [{ provider: 'one', id: '1' }],
  [{ provider: 'one', id: '1' }],
]).length, 1);

// ONL-005: one source post can contain several DIFFERENT images. Only MD5 proves
// cross-provider identity; sharing its page must not silently discard another image.
assert.equal(O.interleave([
  [{ provider: 'one', id: '1', md5: 'a'.repeat(32), source: 'https://example.org/post/1' }],
  [{ provider: 'two', id: '2', md5: 'b'.repeat(32), source: 'https://example.org/post/1' }],
]).length, 2, 'different files sharing an author post must both remain visible');

const S = require('../src/online-sources');
const defs = [
  { id: 'one', capabilities: { browse: true } },
  { id: 'two', capabilities: { browse: true } },
  { id: 'cloud', sourceKey: 'lumina', capabilities: { browse: true } },
  { id: 'retired', status: 'retired', capabilities: { browse: true } },
  { id: 'lookup', capabilities: { browse: false } },
];
const legacy = S.normalize({ lumina: false, internet: true }, defs);
assert.deepEqual(legacy, { lumina: false, internet: true, providers: { one: true, two: true } });
assert.deepEqual(S.normalize(legacy, defs), legacy, 'migration is idempotent');
assert.deepEqual(S.normalize({ lumina: true, internet: false }, defs),
  { lumina: true, internet: false, providers: { one: false, two: false } });
assert.equal(S.enabled(legacy, defs[0]), true);
assert.equal(S.enabled(legacy, defs[2]), false);
const single = S.patch({ providers: { two: false } }, legacy, defs);
assert.deepEqual(single.providers, { one: true, two: false });
assert.equal(S.patch({ providers: { one: false } }, single, defs), null, 'cannot switch off last source');
assert.equal(S.patch({ providers: { unknown: true } }, single, defs), null);
assert.equal(S.patch({ providers: { retired: true } }, single, defs), null);
assert.equal(S.patch({ providers: { one: 'yes' } }, single, defs), null);
assert.equal(S.patch({ providers: [] }, single, defs), null);
assert.equal(S.patch({ extra: true }, single, defs), null);
assert.equal(S.patch(JSON.parse('{"providers":{"__proto__":true}}'), single, defs), null);
assert.deepEqual(S.patch({ lumina: true, internet: false }, single, defs),
  { lumina: true, internet: false, providers: { one: false, two: false } });
assert.equal(S.enabled(single, defs[1]), false);
assert.equal(S.enabled(single, { id: 'new', capabilities: { browse: true } }), false,
  'a newly added provider is not silently opted in');
assert.notEqual(S.signature(single), S.signature(legacy));
assert.equal(S.signature(legacy), S.signature({ ...legacy, providers: { two: true, one: true } }));
assert.deepEqual(S.normalize({ lumina: false, internet: false, providers: { one: false, two: false } }, defs),
  { lumina: false, internet: true, providers: { one: true, two: false } },
  'repair an invalid all-off disk setting with only the first known source');
assert.deepEqual(legacy.providers, { one: true, two: true }, 'patches never mutate inputs');
console.log('PASS: MD5-only identity and registry-driven source selection');
