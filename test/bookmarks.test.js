'use strict';
const assert = require('assert');
const B = require('../src/bookmarks');
const C = require('../src/cloud/contracts.cjs');
const large = '99999999999999999999';
assert.strictEqual(B.keyFor('gelbooru', large), `gelbooru:${large}`);
assert.notStrictEqual(B.keyFor('gelbooru', '12'), B.keyFor('danbooru', '12'));
for (const id of [12, '012', '0', '1e4', '9'.repeat(21)]) {
  assert.strictEqual(B.keyFor('gelbooru', id), null);
}
assert.strictEqual(B.keyFor('wallhaven', '94x38z'), 'wallhaven:94x38z');
assert.strictEqual(B.keyFor('wallhaven', '94X38Z'), null);
assert.strictEqual(B.keyFor('pixiv', '12'), null);
assert.strictEqual(B.keyFor('toString', '12'), null);
assert.strictEqual(B.keyFor('znada', '01J00000000000000000000000'), 'znada:01J00000000000000000000000');
const item = { source: 'wallhaven', post_id: '94x38z', favorited_at: 10,
  state: 'active', metadata: { title: 'A', user_tags: ['own'], source_rating: 'explicit' } };
const copy = B.record(item);
copy.metadata.user_tags.push('other');
assert.deepStrictEqual(item.metadata.user_tags, ['own']);
assert.strictEqual(B.record({ ...item, favorited_at: NaN }), null);
assert.strictEqual(B.record({ ...item, unexpected: true }), null);
assert.strictEqual(B.record({ ...item, metadata: { width: 10 } }), null);
assert.strictEqual(B.record({ ...item, metadata: { user_tags: ['x', 'x'] } }), null);
const catalog = { ...item, source: 'znada', post_id: '01J00000000000000000000000' };
assert.deepStrictEqual(B.operationMetadata(catalog), { user_tags: ['own'] });
assert.deepStrictEqual(B.operationMetadata({ ...catalog, metadata: { title: 'Server title' } }), {});
assert.ok(C.BookmarkOperation.safeParse({ source: catalog.source, post_id: catalog.post_id,
  type: 'add', operation_id: '12345678-1234-4234-8234-123456789012', expected_revision: 0,
  metadata: B.operationMetadata(catalog) }).success);
assert.deepStrictEqual(['sfw', 'sketchy', 'nsfw', 'unknown'].map(B.wallhavenRating),
  ['general', 'suggestive', 'explicit', null]);
assert.strictEqual(B.wallhavenRating('toString'), null);
assert.notStrictEqual(B.partitionKey(null), B.partitionKey('anonymous'));
assert.notStrictEqual(B.partitionKey('__proto__'), B.partitionKey(null));
assert.throws(() => B.partitionKey(undefined));
assert.throws(() => B.partitionKey(''));
assert.deepStrictEqual(B.list({ a: item, b: { ...item, post_id: 'abc', state: 'removed' },
  c: { ...item, post_id: 'def', state: 'unavailable', favorited_at: 20 } })
  .map((value) => value.post_id), ['def', '94x38z']);
assert.deepStrictEqual(B.list({ known: item, future: { ...item, source: 'pixiv' },
  invalid: null }).map((value) => value.post_id), ['94x38z']);
assert.deepStrictEqual(B.list(null), []);
console.log('bookmarks: identity, validation, metadata boundary and partitions PASS');
