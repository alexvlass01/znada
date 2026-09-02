'use strict';

const assert = require('assert');
const T = require('../src/tag-suggest');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  OK ' + name); passed++; };

ok('normalizeTagPrefix: spaces become booru underscores', T.normalizeTagPrefix(' Blue Hair ') === 'blue_hair');
ok('normalizeTagPrefix: negative marker is ignored for provider lookup', T.normalizeTagPrefix('-blue_h') === 'blue_h');
ok('normalizeTagPrefix: metatag punctuation is not forwarded', T.normalizeTagPrefix('rating:explicit') === 'ratingexplicit');

// ONL-014. The autocomplete endpoint of one named site, and its answer parser, used to
// live in this module and were tested here. They moved into that site's own file behind a
// declared capability; their checks moved with them, to test/gelbooru.test.js. What is
// left here is the search box itself, which belongs to no site.

const token = T.currentTokenRange('1girl blue_h', 12);
ok('currentTokenRange: finds the last typed tag', token.start === 6 && token.prefix === 'blue_h');
ok('currentTokenRange: ignores comma separators', T.currentTokenRange('1girl, blue_h', 13).start === 7);
ok('replaceCurrentToken: replaces only the current token', T.replaceCurrentToken('1girl blue_h', 12, 'blue_hair').value === '1girl blue_hair ');
ok('replaceCurrentToken: preserves negative tags', T.replaceCurrentToken('1girl -blue_h', 13, 'blue_hair').value === '1girl -blue_hair ');
ok('replaceCurrentToken: keeps following tags', T.replaceCurrentToken('1girl blue_h sky', 12, 'blue_hair').value === '1girl blue_hair sky');

console.log('\nAll ' + passed + ' tag-suggest tests passed.');
