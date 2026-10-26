'use strict';
const assert = require('assert');
const rating = require('../src/content-rating');
const config = require('../src/config');
let checks = 0;
for (const [group, names] of Object.entries({
  sfw: ['general', 'safe', 'sfw', 'g'],
  sketchy: ['sensitive', 'questionable', 'suggestive', 'sketchy', 's', 'q'],
  nsfw: ['explicit', 'nsfw', 'e'],
  '': ['', 'unknown', 'unrated', null, undefined, true, 3, {}],
})) {
  for (const name of names) {
    assert.strictEqual(rating.normalize(name), group);
    assert.strictEqual(rating.hidden(name, { nsfw: true, sketchy: false }), group === 'nsfw');
    assert.strictEqual(rating.hidden(name, { nsfw: false, sketchy: true }), group === 'sketchy');
    assert.strictEqual(rating.hidden(name, {}), false);
    checks++;
  }
}
assert.strictEqual(rating.of({ rating: ' EXPLICIT ', purity: 'sfw' }), 'nsfw');
assert.strictEqual(rating.of({ rating: '', purity: 'sketchy' }), 'sketchy');
assert.deepStrictEqual(rating.patch({ purity: 'nsfw' }), { rating: 'explicit' });
assert.deepStrictEqual(rating.patch({ rating: 'suggestive' }), { rating: 'sensitive' });
assert.deepStrictEqual(rating.patch({ rating: 'questionable' }), { rating: 'questionable' });
assert.deepStrictEqual(rating.patch({}), {});
assert.deepStrictEqual(config.normalize({}).contentBlur, { nsfw: false, sketchy: false });
assert.deepStrictEqual(config.normalize({ contentBlur: { nsfw: true, sketchy: 'true' } }).contentBlur,
  { nsfw: true, sketchy: false });
console.log(`PASS content-rating: ${checks + 8} policy/default/normalization cases`);
