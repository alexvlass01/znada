'use strict';

// LIB-030. What counts as the same file twice, and which copies the user has not been
// told about yet.
//
// The costly mistakes run in both directions. Calling two different pictures copies would
// send the user to remove a photo they wanted; announcing the same copies on every start
// turns a helpful notice into nagging, which the owner explicitly did not want.

const assert = require('assert');
const dup = require('../src/duplicate-files');
const { pathKey } = require('../src/path-key');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

const file = (p, size, extra = {}) => ({ path: p, size, ...extra });
const entry = (p, size, hash) => ({ key: pathKey(p), path: p, size, hash });

// --- what is worth fingerprinting -------------------------------------------
{
  const list = dup.candidates([
    file('C:\\a\\one.jpg', 100),
    file('C:\\a\\two.jpg', 100),
    file('C:\\a\\lonely.jpg', 555),
    file('C:\\a\\clip.mp4', 900, { video: true }),
    file('C:\\b\\clip.mp4', 900, { video: true }),
    file('C:\\a\\big.png', 700),
    file('C:\\b\\big.png', 700),
  ]);
  const names = list.map((c) => c.path);
  ok('a file whose size nobody else has is never read', !names.includes('C:\\a\\lonely.jpg'));
  ok('every file that shares its size is a candidate', names.length === 6);
  ok('pictures come before videos, larger pictures first',
    names.slice(0, 4).join('|') === 'C:\\a\\big.png|C:\\b\\big.png|C:\\a\\one.jpg|C:\\a\\two.jpg'
    && list[4].video && list[5].video);
}
{
  const list = dup.candidates([
    file('C:\\a\\x.jpg', 100),
    file('c:/a/x.jpg', 100),
    file('C:\\a\\empty.jpg', 0),
    file('C:\\a\\empty2.jpg', 0),
    file('C:\\a\\nosize.jpg'),
    null,
    { size: 5 },
  ]);
  ok('the same file spelled twice is one file, not a pair of copies', list.length === 0);
}

// --- grouping -----------------------------------------------------------------
{
  const groups = dup.groupsOf([
    entry('C:\\a\\1.jpg', 100, 'AA'),
    entry('C:\\b\\1.jpg', 100, 'aa'),
    entry('C:\\a\\2.jpg', 100, 'bb'),
    entry('C:\\a\\big.jpg', 900, 'cc'),
    entry('C:\\b\\big.jpg', 900, 'cc'),
    entry('C:\\c\\big.jpg', 900, 'cc'),
    entry('C:\\x\\nohash.jpg', 100, ''),
  ]);
  ok('same bytes make a group; a different picture of the same size does not',
    groups.length === 2 && !groups.some((g) => g.files.some((f) => f.path === 'C:\\a\\2.jpg')));
  ok('a fingerprint spelled in capitals is the same fingerprint', groups.some((g) => g.hash === 'aa' && g.files.length === 2));
  ok('the largest group comes first', groups[0].hash === 'cc' && groups[0].files.length === 3);
  ok('the same file reported twice is counted once',
    dup.groupsOf([entry('C:\\a\\1.jpg', 1, 'h'), entry('c:/a/1.jpg', 1, 'h')]).length === 0);
  ok('copies are counted beyond the first of each group', dup.extraCopies(groups) === 3);
}

// --- groups as the library stands now ------------------------------------------
{
  const groups = dup.groupsOf([
    entry('C:\\a\\1.jpg', 1, 'h'), entry('C:\\b\\1.jpg', 1, 'h'),
    entry('C:\\a\\2.jpg', 2, 'k'), entry('C:\\b\\2.jpg', 2, 'k'), entry('C:\\c\\2.jpg', 2, 'k'),
  ]);
  const present = new Set([pathKey('C:\\a\\1.jpg'), pathKey('C:\\a\\2.jpg'), pathKey('C:\\c\\2.jpg')]);
  const live = dup.presentGroups(groups, present);
  ok('a pair loses its group the moment one copy leaves the library',
    live.length === 1 && live[0].hash === 'k' && live[0].files.length === 2);
  ok('nothing present means nothing to show', dup.presentGroups(groups, new Set()).length === 0);
}

// --- what is new to the user ------------------------------------------------------
{
  const pair = dup.groupsOf([entry('C:\\a\\1.jpg', 1, 'h'), entry('C:\\b\\1.jpg', 1, 'h')]);
  ok('a pair nobody was told about is one new copy, not two', dup.freshCopies(pair, {}) === 1);
  const told = dup.announce(pair, {});
  ok('after the notice the same pair is not new any more', dup.freshCopies(pair, told) === 0);

  const triple = dup.groupsOf([
    entry('C:\\a\\1.jpg', 1, 'h'), entry('C:\\b\\1.jpg', 1, 'h'), entry('C:\\c\\1.jpg', 1, 'h'),
  ]);
  ok('a third file joining an announced pair is one new copy', dup.freshCopies(triple, told) === 1);

  const changed = dup.groupsOf([entry('C:\\a\\1.jpg', 1, 'z'), entry('C:\\b\\1.jpg', 1, 'z')]);
  ok('the same names holding different bytes are new copies', dup.freshCopies(changed, told) === 1);

  const kept = dup.announce([], told);
  ok('a copy that left the library stays announced, so putting it back is not news',
    dup.freshCopies(pair, kept) === 0);

  const many = {};
  for (let i = 0; i < dup.ANNOUNCED_LIMIT + 10; i++) many['k' + i] = 'h';
  const bounded = dup.announce(pair, many);
  ok('the memory of announcements is bounded and keeps the newest',
    Object.keys(bounded).length === dup.ANNOUNCED_LIMIT && bounded[pathKey('C:\\a\\1.jpg')] === 'h');

  // The oldest remembered copy found again counts as the newest news: the bound must not
  // drop it, or the next check would announce it once more (review of PR #290).
  const full = {};
  for (let i = 0; i < dup.ANNOUNCED_LIMIT; i++) full['k' + i] = 'h';
  const again = dup.announce([{ hash: 'h', size: 1, files: [{ key: 'k0', path: 'C:\\k0.jpg' }, { key: 'fresh', path: 'C:\\fresh.jpg' }] }], full);
  ok('an old copy announced again moves to the newest and survives the bound',
    Object.keys(again).length === dup.ANNOUNCED_LIMIT && again.k0 === 'h' && again.fresh === 'h' && again.k1 === undefined);
}

// --- the stored shape ---------------------------------------------------------
{
  ok('nothing stored is an empty state', JSON.stringify(dup.normalizeState(null)) === JSON.stringify(dup.emptyState()));
  ok('garbage is an empty state', dup.normalizeState([1, 2]).groups.length === 0 && dup.normalizeState('x').checkedAt === 0);
  const stored = dup.normalizeState({
    checkedAt: 5,
    groups: [
      { hash: 'h', size: 1, files: [{ path: 'C:\\a\\1.jpg' }, { path: 'C:\\b\\1.jpg' }] },
      { hash: 'q', size: 1, files: [{ path: 'C:\\a\\only.jpg' }] },
      { hash: 'w', files: 'nope' },
    ],
    announced: { [pathKey('C:\\a\\1.jpg')]: 'H', bad: 7 },
  });
  ok('a stored group survives a round trip; a group of one does not',
    stored.checkedAt === 5 && stored.groups.length === 1 && stored.groups[0].files.length === 2);
  ok('stored announcements keep only readable entries',
    Object.keys(stored.announced).length === 1 && stored.announced[pathKey('C:\\a\\1.jpg')] === 'h');
}

console.log(`\nAll ${passed} duplicate-files tests passed.`);
