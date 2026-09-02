'use strict';

// ONL-014b. Where each site got to, as pure bookkeeping.
//
// The properties that matter are the three states and the difference between them:
// "never asked" must not be confused with "finished", or a site is either restarted from
// the beginning every time or dropped before it was ever asked. Everything else here is
// about not trusting a token that came back over IPC.

const assert = require('assert');
const R = require('../src/online-resume');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

// --- what a bookmark belongs to ---------------------------------------------

const base = { q: 'sky', sort: 'date_added', browse: false, purity: { sfw: true, sketchy: false, nsfw: false } };

ok('the same question produces the same signature',
  R.signatureOf(base) === R.signatureOf({ ...base }));
ok('a different word is a different question',
  R.signatureOf(base) !== R.signatureOf({ ...base, q: 'sea' }));
ok('and so are a different ordering, a different rating, and the front page',
  R.signatureOf(base) !== R.signatureOf({ ...base, sort: 'toplist' })
  && R.signatureOf(base) !== R.signatureOf({ ...base, purity: { sfw: true, sketchy: true, nsfw: false } })
  && R.signatureOf(base) !== R.signatureOf({ ...base, browse: true }));
ok('the word is compared the way people type it, not character by character',
  R.signatureOf({ ...base, q: ' Sky ' }) === R.signatureOf(base));

// --- one site, one ordering --------------------------------------------------

ok('a site is bookmarked per ordering, because the front page asks for two at once',
  R.slotKey('wallhaven', 'date_added') !== R.slotKey('wallhaven', 'toplist'));
ok('and a site with no name has no slot at all', R.slotKey('', 'date_added') === '');

// --- the three states --------------------------------------------------------

{
  const sig = R.signatureOf(base);
  const token = R.emptyToken(sig);
  const key = R.slotKey('wallhaven', 'date_added');

  ok('a site nobody has asked yet has no position, which is not the same as none left',
    R.positionOf(token, key) === undefined && R.isFinished(token, key) === false);

  R.record(token, key, 1, { next: 2 });
  ok('after answering it carries on from where it said', R.positionOf(token, key) === 2);
  ok('and there is something to hand back', R.forReply(token) !== null && !R.isEmpty(token));

  R.record(token, key, 2, { done: true });
  ok('a site that says it is finished is finished, not merely unknown',
    R.positionOf(token, key) === null && R.isFinished(token, key) === true);
  ok('and with nobody left there is nothing to hand back',
    R.isEmpty(token) && R.forReply(token) === null);
}

// A failure keeps the place. This is the hole the whole change is about: a page lost to
// one bad second used to be lost for good, because the shared number moved on without it.
{
  const token = R.emptyToken('s');
  const key = R.slotKey('wallhaven', 'date_added');

  R.record(token, key, 3, { failed: true });
  ok('a site that failed keeps the very piece it failed on', R.positionOf(token, key) === 3);
  ok('and is still worth asking again', !R.isEmpty(token));

  R.record(token, key, 3, { failed: true });
  ok('but a site that keeps failing is eventually left alone',
    R.isFinished(token, key) && R.isEmpty(token));
}

ok('a site that recovers has its failures forgiven, not merely paused', (() => {
  const token = R.emptyToken('s');
  const key = R.slotKey('a', 'date_added');
  R.record(token, key, 1, { failed: true });
  R.record(token, key, 1, { next: 2 });
  R.record(token, key, 2, { failed: true });
  // Without forgiveness this second failure would be the second strike and finish it.
  return !R.isFinished(token, key) && R.positionOf(token, key) === 2;
})());

// The retry counter travels through the window together with an opaque marker. Without
// that counter a dead cursor site would get a first strike on every click forever.
{
  const key = R.slotKey('cursor-site', 'date_added');
  let token = R.emptyToken('cursor-retry');
  R.record(token, key, 1, { next: 'opaque-next' });
  R.record(token, key, 'opaque-next', { failed: true });
  token = R.parse(JSON.parse(JSON.stringify(R.forReply(token))), 'cursor-retry');
  ok('a marker and its first failure survive the IPC round trip together',
    R.positionOf(token, key) === 'opaque-next' && token.slots[key].fails === 1);
  R.record(token, key, 'opaque-next', { failed: true });
  ok('the restored failure count still stops a cursor site after the second refusal',
    R.isFinished(token, key) && R.forReply(token) === null);
}

// --- what a site's answer says about carrying on -----------------------------

ok('a site that says it has more is asked for the next piece',
  R.nextFrom({ meta: { hasMore: true } }, 4) === 5);
ok('a site whose last page is still ahead is too',
  R.nextFrom({ meta: { lastPage: 5 } }, 4) === 5);
ok('a site that has reached its last page is finished',
  R.nextFrom({ meta: { lastPage: 4 } }, 4) === null);
ok('and a site that said nothing at all is treated as finished, not as endless',
  R.nextFrom({}, 2) === null && R.nextFrom(null, 2) === null);

// ONL-014c. A site that pages by its own marker outranks the page-number reading: it is
// the only one that knows what carrying on means for it.
ok('a marker is carried through untouched',
  R.nextFrom({ meta: { nextCursor: 'abc' } }, 1) === 'abc');
ok('an empty marker means that was the last of it, even alongside “there is more”',
  R.nextFrom({ meta: { nextCursor: null, hasMore: true, lastPage: 9 } }, 1) === null);
ok('and a site that states a marker is never read as counting pages',
  R.nextFrom({ meta: { nextCursor: 'abc', lastPage: 9 } }, 4) === 'abc');

// --- a token arriving over IPC is input, not memory --------------------------

{
  const sig = R.signatureOf(base);
  const token = R.record(R.emptyToken(sig), R.slotKey('a', 'date_added'), 1, { next: 7 });
  const reply = R.forReply(token);

  ok('a token handed straight back is followed',
    R.positionOf(R.parse(reply, sig), R.slotKey('a', 'date_added')) === 7);
  ok('a token from a different question is discarded rather than repaired',
    R.isEmpty(R.parse(reply, R.signatureOf({ ...base, q: 'other' }))));
  ok('and so is anything that is not a token at all',
    R.isEmpty(R.parse(null, sig))
    && R.isEmpty(R.parse('nonsense', sig))
    && R.isEmpty(R.parse([1, 2], sig))
    && R.isEmpty(R.parse({ sig, slots: 'not an object' }, sig)));

  // Individual slots are checked too: one bad entry must not be able to send a site to a
  // page that does not exist, and must not take the good entries down with it.
  const mixed = R.parse({
    sig,
    slots: {
      good: { at: 3, fails: 0 },
      // ONL-014c. A site that hands back its own opaque marker bookmarks a STRING.
      marker: { at: 'eyJvIjoxfQ', fails: 0 },
      negative: { at: -5, fails: 0 },
      nonsense: { at: { page: 2 }, fails: 0 },
      overlong: { at: 'x'.repeat(R.MAX_MARKER_LENGTH + 1), fails: 0 },
      broken: 42,
      finished: { at: null, fails: 0 },
    },
  }, sig);
  ok('a damaged slot is dropped while the sound ones survive',
    R.positionOf(mixed, 'good') === 3
    && R.positionOf(mixed, 'marker') === 'eyJvIjoxfQ'
    && R.positionOf(mixed, 'negative') === undefined
    && R.positionOf(mixed, 'nonsense') === undefined
    && R.positionOf(mixed, 'broken') === undefined);
  // A marker is handed straight back to a site, so it is bounded like any other input.
  ok('and an unbounded marker is not a bookmark at all',
    R.positionOf(mixed, 'overlong') === undefined);
  ok('and "finished" survives being written down and read back',
    R.isFinished(mixed, 'finished'));
}

console.log(`\nAll ${passed} online-resume tests passed.`);
