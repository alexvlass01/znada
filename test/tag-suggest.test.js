'use strict';

const assert = require('assert');
const T = require('../src/tag-suggest');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  OK ' + name); passed++; };

ok('normalizeTagPrefix: spaces become booru underscores', T.normalizeTagPrefix(' Blue Hair ') === 'blue_hair');
ok('normalizeTagPrefix: negative marker is ignored for provider lookup', T.normalizeTagPrefix('-blue_h') === 'blue_h');
ok('normalizeTagPrefix: metatag punctuation is not forwarded', T.normalizeTagPrefix('rating:explicit') === 'ratingexplicit');

const url = T.buildGelbooruTagSuggestUrl({ q: 'blue hai', limit: 50, userId: '42', apiKey: 'secret' });
const parsedUrl = new URL(url);
ok('buildGelbooruTagSuggestUrl: anonymous autocomplete endpoint', parsedUrl.origin + parsedUrl.pathname === T.GELBOORU_TAG_API && parsedUrl.searchParams.get('page') === 'autocomplete2');
ok('buildGelbooruTagSuggestUrl: uses anonymous tag term', parsedUrl.searchParams.get('term') === 'blue_hai' && parsedUrl.searchParams.get('type') === 'tag' && !parsedUrl.searchParams.has('user_id') && !parsedUrl.searchParams.has('api_key'));
ok('buildGelbooruTagSuggestUrl: clamps limit', parsedUrl.searchParams.get('limit') === String(T.MAX_LIMIT));

const response = {
  tag: [
    { name: 'blue_hair', count: '450000', type: '0' },
    { name: 'blue_hair_ribbon', count: '1200', type: '0' },
    { name: 'blue_archive', count: '90000', type: '3' },
    { name: 'red_hair', count: '1000000', type: '0' },
    { name: 'blue_hair', count: '1', type: '0' },
  ],
};
const suggestions = T.parseGelbooruTagSuggestions(response, { prefix: 'blue_h', limit: 5 });
ok('parseGelbooruTagSuggestions: filters by prefix and dedups', suggestions.length === 2 && suggestions[0].name === 'blue_hair');
ok('parseGelbooruTagSuggestions: count and category are normalized', suggestions[0].count === 450000 && suggestions[0].category === 'general');
ok('parseGelbooruTagSuggestions: handles single-object response', T.parseGelbooruTagSuggestions({ tag: { name: 'sky', count: 5 } }, { prefix: 'sky' }).length === 1);
ok('parseGelbooruTagSuggestions: handles autocomplete2 response', (() => {
  const items = T.parseGelbooruTagSuggestions([
    { value: 'blue_hair', post_count: '1302060', category: 'tag' },
    { value: 'blue_hair　brown_hair', post_count: '8078', category: 'tag' },
    { value: 'blue_archive', post_count: '90000', category: 'copyright' },
  ], { prefix: 'blue_h', limit: 5 });
  return items.length === 1 && items[0].name === 'blue_hair' && items[0].count === 1302060;
})());

const token = T.currentTokenRange('1girl blue_h', 12);
ok('currentTokenRange: finds the last typed tag', token.start === 6 && token.prefix === 'blue_h');
ok('currentTokenRange: ignores comma separators', T.currentTokenRange('1girl, blue_h', 13).start === 7);
ok('replaceCurrentToken: replaces only the current token', T.replaceCurrentToken('1girl blue_h', 12, 'blue_hair').value === '1girl blue_hair ');
ok('replaceCurrentToken: preserves negative tags', T.replaceCurrentToken('1girl -blue_h', 13, 'blue_hair').value === '1girl -blue_hair ');
ok('replaceCurrentToken: keeps following tags', T.replaceCurrentToken('1girl blue_h sky', 12, 'blue_hair').value === '1girl blue_hair sky');

console.log('\nAll ' + passed + ' tag-suggest tests passed.');
