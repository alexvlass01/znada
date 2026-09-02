'use strict';

// Who gets asked, whether they get asked at all, and what an answer is allowed to
// change on the user's photo.
//
// Two properties are load-bearing and get the most attention below:
//   * the journal is keyed by the FINGERPRINT, so the same bytes are one question no
//     matter how many copies of the file exist or how many times the button is pressed;
//   * a merge never overwrites something the user could have written himself.

const assert = require('assert');
const lookup = require('../src/metadata-lookup');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

const T0 = 1_700_000_000_000;
const WITH_KEY = { credentials: { gelbooru: true } };
const NO_KEY = { credentials: {} };
const post = {
  postId: '42',
  page: 'https://gelbooru.com/index.php?page=post&s=view&id=42',
  md5: 'a'.repeat(32),
  author: 'tenchi mayo',
  rating: 'general',
  tags: [{ name: 'Sky', type: 'general' }, { name: 'tenchi_mayo', type: 'artist' }, 'tree'],
};

// --- who ------------------------------------------------------------------
ok('with credentials the paid catalogue is asked first',
  lookup.providersFor('md5', WITH_KEY).join() === 'gelbooru,danbooru');
ok('without credentials the public one still answers',
  lookup.providersFor('md5', NO_KEY).join() === 'danbooru');
ok('a fingerprint kind nobody indexes has no providers',
  lookup.providersFor('phash', WITH_KEY).length === 0);

// --- the journal key ------------------------------------------------------
ok('the journal is keyed by the fingerprint, not by the photo',
  lookup.journalKey('md5', '  ABC  ') === 'md5:abc');
ok('two kinds cannot collide on one key',
  lookup.journalKey('md5', 'abc') !== lookup.journalKey('phash', 'abc'));
ok('an empty fingerprint has no key', !lookup.journalKey('md5', '') && !lookup.journalKey('', 'abc'));

// --- whether -------------------------------------------------------------
let entry = lookup.emptyEntry();
ok('a fingerprint nobody has asked about is asked about', lookup.shouldAsk(entry, 'gelbooru', T0).ask);

entry = lookup.recordOutcome(entry, 'gelbooru', { status: 'absent' }, T0);
ok('a miss is not re-asked the next minute', !lookup.shouldAsk(entry, 'gelbooru', T0 + 60000).ask);
ok('and the reason says why, so the interface need not guess',
  lookup.shouldAsk(entry, 'gelbooru', T0 + 60000).reason === 'absentRecently');
ok('a miss IS re-asked after long enough — catalogues gain posts',
  lookup.shouldAsk(entry, 'gelbooru', T0 + lookup.RETRY.absentMs + 1).ask);
ok('a miss for one provider does not silence the other', lookup.shouldAsk(entry, 'danbooru', T0).ask);

const errored = lookup.recordOutcome(lookup.emptyEntry(), 'danbooru', { status: 'error' }, T0);
ok('an unreachable host rests briefly, not for a month',
  !lookup.shouldAsk(errored, 'danbooru', T0 + 60000).ask
  && lookup.shouldAsk(errored, 'danbooru', T0 + lookup.RETRY.errorMs + 1).ask);

entry = lookup.recordOutcome(entry, 'danbooru', { status: 'found', result: post }, T0);
ok('a found result stops every provider being asked again',
  !lookup.shouldAsk(entry, 'gelbooru', T0 + lookup.RETRY.absentMs * 2).ask
  && lookup.pendingProviders(entry, 'md5', T0 + lookup.RETRY.absentMs * 2, WITH_KEY).length === 0);
ok('an unknown provider is never asked', !lookup.shouldAsk(entry, 'nowhere', T0).ask);
ok('pendingProviders skips one that answered and keeps one that has not',
  lookup.pendingProviders(
    lookup.recordOutcome(lookup.emptyEntry(), 'gelbooru', { status: 'absent' }, T0),
    'md5', T0, WITH_KEY,
  ).join() === 'danbooru');

// --- the answer -----------------------------------------------------------
const stored = lookup.normalizeEntry(entry).result;
ok('the stored result is stamped with the provider that gave it', stored.provider === 'danbooru');
ok('tags are folded, deduplicated and keep their kind',
  stored.tags[0].name === 'sky' && stored.tags[0].type === 'general'
  && stored.tags[1].type === 'artist' && stored.tags[2].name === 'tree' && !stored.tags[2].type);
ok('an invented tag kind is dropped rather than stored',
  !lookup.makeResult('danbooru', { postId: '1', tags: [{ name: 'x', type: 'nonsense' }] }).tags[0].type);
ok('an invented rating is dropped rather than shown',
  lookup.makeResult('danbooru', { postId: '1', rating: 'spicy' }).rating === '');
ok('a result without a post id is not a result',
  lookup.makeResult('danbooru', { tags: ['a'] }) === null && lookup.makeResult('nowhere', { postId: '1' }) === null);
ok('the tag list is bounded',
  lookup.makeResult('danbooru', {
    postId: '1',
    tags: Array.from({ length: lookup.MAX_TAGS + 50 }, (_, i) => 'tag' + i),
  }).tags.length === lookup.MAX_TAGS);

// --- what it means for the photo -----------------------------------------
const blank = lookup.planFor({ tags: [] }, stored);
ok('an empty record takes the author, the source and the rating',
  blank.patch.author === 'tenchi mayo' && blank.patch.source === post.page && blank.patch.rating === 'general');
ok('and every tag the post had', blank.tags.join() === 'sky,tenchi_mayo,tree');

const typed = lookup.planFor({ author: 'Someone I typed', source: 'https://my.own/page', tags: ['sky'] }, stored);
ok('a record the user filled in keeps HIS author and source',
  !('author' in typed.patch) && !('source' in typed.patch));
ok('and says which fields it deliberately left alone', typed.skipped.join() === 'author,source');
ok('while tags stay additive and skip the one already there', typed.tags.join() === 'tenchi_mayo,tree');
ok('a rating already equal to the answer is not rewritten',
  !('rating' in lookup.planFor({ rating: 'general', tags: [] }, stored).patch));
ok('nothing to apply is recognised as nothing',
  lookup.planIsEmpty(lookup.planFor({ author: 'x', source: 'y', rating: 'general', tags: ['sky', 'tenchi_mayo', 'tree'] }, stored))
  && lookup.planIsEmpty(lookup.planFor({ tags: [] }, null))
  && !lookup.planIsEmpty(blank));

// --- damaged journals -----------------------------------------------------
ok('a damaged journal entry is treated as "never asked", not as an answer',
  lookup.shouldAsk({ providers: { gelbooru: { status: 'found' } } }, 'gelbooru', T0).ask
  && lookup.shouldAsk({ providers: { gelbooru: { at: T0, status: 'lies' } } }, 'gelbooru', T0).ask
  && lookup.shouldAsk('nonsense', 'gelbooru', T0).ask
  && lookup.normalizeEntry({ result: { provider: 'nowhere', postId: '1' } }).result === null);
ok('an outcome without a usable result never counts as found',
  lookup.recordOutcome(lookup.emptyEntry(), 'gelbooru', { status: 'found' }, T0).result === null);

console.log(`\nAll ${passed} metadata-lookup tests passed.`);
