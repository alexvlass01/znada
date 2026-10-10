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

// BUG-048: autocomplete used to turn the site's real tag into a different, empty one.
const tag = 'beatrice_(re:zero)';
ok('a qualifier keeps its colon, including while it is being typed',
  T.normalizeTagPrefix(tag) === tag && T.normalizeTagPrefix('Beatrice_(re:') === 'beatrice_(re:');
ok('replacement preserves the provider spelling and the surrounding query',
  T.replaceCurrentToken('sky -beat tree', 9, tag).value === `sky -${tag} tree`);

const G = require('../src/gelbooru');
const D = require('../src/danbooru');
for (const [name, site, raw] of [
  ['Gelbooru', G, [{ value: tag, post_count: 2186, category: 4 }]],
  ['Danbooru', D, [{ value: tag, post_count: 100, category: 4 }]],
]) {
  const items = site.parseTagSuggestions(raw, { prefix: 'beatrice_(re:' });
  ok(`${name}: suggestion retains the exact tag`, items.length === 1 && items[0].name === tag);
  const url = new URL(site.buildSearchUrl({ q: items[0].name, purity: { sfw: true, sketchy: false, nsfw: false } }));
  ok(`${name}: the suggested tag reaches the encoded search request`, url.searchParams.get('tags').split(' ')[0] === tag);
  // LIB-014 stage 3: what the site is actually SENT, read back from the address it builds.
  const sent = (q) => new URL(site.buildSearchUrl({ q, purity: { sfw: true, sketchy: false, nsfw: false } }))
    .searchParams.get('tags').split(' ');
  ok(`${name}: negative and comma-separated tags still work`,
    JSON.stringify(sent(`-${tag}, blue hair`).slice(0, 2)) === JSON.stringify([`-${tag}`, 'blue_hair']));
  ok(`${name}: a third typed tag is sent, not dropped (BUG-051)`,
    JSON.stringify(sent('blue archive, 1girl, kept').slice(0, 3)) === JSON.stringify(['blue_archive', '1girl', 'kept']));
  for (const forbidden of ['rating:explicit', '-rating:general', '~rating:explicit', 'order:rank', 'width:1', 'foo_(bar):explicit', '(rating:explicit)', 'foo_((rating:explicit))']) {
    ok(`${name}: rejects search metatag ${forbidden}`,
      sent(`${forbidden} sky`)[0] === 'sky' && !sent(`${forbidden} sky`).includes(forbidden));
  }
}

// LIB-014 stage 3. One function turns the box's text into the tags every site is sent.
ok('siteTags: phrases become booru tags, nothing is cut',
  JSON.stringify(T.siteTags('Blue Archive, 1girl, kept, fourth')) === JSON.stringify(['blue_archive', '1girl', 'kept', 'fourth']));
ok('siteTags: search commands are refused, a qualifier with a colon is a name',
  JSON.stringify(T.siteTags('rating:explicit beatrice_(re:zero) order:rank -sky')) === JSON.stringify([tag, '-sky']));
ok('siteTags: the same words as splitTerms, spelled for the sites',
  ['', ' a ,, b ', 'x,y,z', 'a\tb\nc', 'long hair,  blue   eyes '].every((text) => JSON.stringify(T.siteTags(text))
    === JSON.stringify(T.splitTerms(text).map((w) => w.replace(/\s+/g, '_')).filter((w) => !T.hasMetatag(w)))));

// Run the same module as index.html does, then the real renderer functions. This catches
// a second sanitizer at the caret or a dropdown that disappears as soon as ':' is typed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ctx = { window: {}, INTERNET_TAG_SUGGEST_MIN_LEN: 3, Number, String, Math };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/tag-suggest.js'), 'utf8'), ctx);
ctx.TagSuggest = ctx.window.TagSuggest;
const renderer = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
function bind(name) {
  const match = renderer.match(new RegExp('function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}'));
  assert.ok(match, name);
  return vm.runInNewContext('(' + match[0] + ')', ctx);
}
const tokenAtCaret = bind('onlineTagToken');
const allowed = bind('onlineTagSuggestAllowed');
const prefix = 'sky beatrice_(re:';
const typed = tokenAtCaret({ value: prefix, selectionStart: prefix.length });
ok('renderer preserves the incomplete qualifier and keeps suggestions open',
  typed.prefix === 'beatrice_(re:' && allowed(typed));
ok('renderer still suppresses metatag suggestions',
  !allowed(tokenAtCaret({ value: 'rating:explicit', selectionStart: 15 })));
const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
ok('the shared search box module is loaded before the renderer',
  html.indexOf('../src/tag-suggest.js') >= 0 && html.indexOf('../src/tag-suggest.js') < html.indexOf('src="renderer.js"'));

console.log('\nAll ' + passed + ' tag-suggest tests passed.');
