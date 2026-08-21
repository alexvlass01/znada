'use strict';

// DATA-005: which side of a merge is newer, and how a deletion survives one.
//
// Written BEFORE the implementation, because the plan asks for it that way and
// because these scenarios ARE the contract. Owner decisions of 2026-08-21:
//   * one revision per record, not per field;
//   * tombstones live as long as the trash entry they belong to.
//
// The old rule was "the dedicated store wins by id". It is not arbitrary — it is what
// protects against a rollback to a build that knows nothing about the store file and
// writes its pool back into config.json. But the SAME rule then throws away edits made
// while the store was damaged, because it cannot tell the two situations apart: pool
// records carry no clock at all. addedAt is when the photo arrived, not when it was
// last touched.
//
// Run: node test/library-merge-revision.test.js

const assert = require('assert');
const S = require('../src/library-store');
const L = require('../src/library');

let passed = 0;
const failures = [];

function ok(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
    passed++;
  } catch (err) {
    console.log('  FAIL ' + name);
    failures.push({ name, err });
  }
}

function item(id, extra = {}) {
  return Object.assign({
    id,
    type: 'image',
    path: 'C:/photos/' + id + '.png',
    addedAt: 1000,
    favorite: false,
    tags: [],
    author: '',
    rev: 0,
  }, extra);
}

function tomb(id, extra = {}) {
  return Object.assign({
    removedAt: 2000,
    removalId: 'r-' + id,
    via: 'manual',
    item: item(id),
    rev: 1,
  }, extra);
}

console.log('\nDATA-005: чья версия новее и переживает ли удаление слияние\n');

// --- the revision itself -----------------------------------------------------

ok('новая запись начинается с нулевой ревизии', () => {
  const made = L.makeItem('image', 'C:/photos/a.png');
  assert.strictEqual(made.rev, 0, 'a record with no revision cannot be compared with anything');
});

ok('каждая правка поднимает ревизию записи', () => {
  const lib = {};
  const id = L.addPath(lib, 'image', 'C:/photos/a.png');
  const start = lib[id].rev;

  L.addTag(lib, id, 'sunset');
  assert.ok(lib[id].rev > start, 'adding a tag left the record looking untouched');

  const afterTag = lib[id].rev;
  L.toggleFavorite(lib, id);
  assert.ok(lib[id].rev > afterTag, 'starring a photo left the record looking untouched');

  const afterStar = lib[id].rev;
  L.removeTag(lib, id, 'sunset');
  assert.ok(lib[id].rev > afterStar, 'removing a tag left the record looking untouched');
});

// The fields main.js writes directly when a photo arrives from the internet. They used
// to be assigned straight onto the record, which is exactly the kind of place a
// "remember to bump the counter" rule gets missed — and a missed bump is a silent loss
// of whatever the other side holds.
ok('правка полей в обход модуля тоже поднимает ревизию', () => {
  const lib = {};
  const id = L.addPath(lib, 'image', 'C:/photos/a.png');
  const start = lib[id].rev;

  const changed = L.updateItem(lib, id, { source: 'znada:42', author: 'someone' });
  assert.strictEqual(changed, true, 'a real change reported nothing changed');
  assert.ok(lib[id].rev > start, 'a field written outside the module left no trace');
  assert.strictEqual(lib[id].source, 'znada:42');
  assert.strictEqual(lib[id].author, 'someone');
});

ok('правка, которая ничего не меняет, ревизию не двигает', () => {
  const lib = {};
  const id = L.addPath(lib, 'image', 'C:/photos/a.png');
  L.updateItem(lib, id, { author: 'someone' });
  const settled = lib[id].rev;

  const changed = L.updateItem(lib, id, { author: 'someone' });
  assert.strictEqual(changed, false, 'writing the same value reported a change');
  assert.strictEqual(lib[id].rev, settled, 'a no-op edit made the record look newer than it is');
});

// --- the merge ---------------------------------------------------------------

ok('побеждает большая ревизия, а не сторона', () => {
  const store = { library: { a: item('a', { rev: 3, tags: ['old'] }) }, trash: [] };
  const config = { library: { a: item('a', { rev: 7, tags: ['new'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library.a.tags, ['new'], 'the older record won because of which file it was in');
});

// The reason the old rule existed, and it has to keep working. A build without the
// dedicated store writes its pool back into config.json; those records are OLDER.
ok('откат на старую сборку не побеждает свежий store', () => {
  const store = { library: { a: item('a', { rev: 9, tags: ['current'] }) }, trash: [] };
  const config = { library: { a: item('a', { rev: 2, tags: ['stale'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library.a.tags, ['current'], 'a rolled-back build overwrote newer data');
});

ok('при равных ревизиях побеждает store — прежнее правило как tie-break', () => {
  const store = { library: { a: item('a', { rev: 4, tags: ['store'] }) }, trash: [] };
  const config = { library: { a: item('a', { rev: 4, tags: ['inline'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library.a.tags, ['store']);
});

ok('запись, которой нет в store, сохраняется, а не пропадает', () => {
  const store = { library: {}, trash: [] };
  const config = { library: { b: item('b', { rev: 1 }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.ok(merged.library.b, 'a record only the inline copy had was dropped');
});

// --- the scenario this whole task exists for ---------------------------------

ok('тег из аварийной сессии переживает возврат исправленного файла', () => {
  // The store was damaged, so the edit went inline and bumped the record's revision.
  const store = { library: { a: item('a', { rev: 5, tags: [] }) }, trash: [] };
  const config = { library: { a: item('a', { rev: 6, tags: ['sunset'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(
    merged.library.a.tags, ['sunset'],
    'the tag added while the file was unreadable was thrown away when the file came back',
  );
});

ok('удаление из аварийной сессии не воскресает', () => {
  // The photo is still in the store — it was deleted while the store could not be written.
  const store = { library: { a: item('a', { rev: 5 }) }, trash: [] };
  const config = { library: {}, trash: [tomb('a', { rev: 6 })] };

  const merged = S.mergePool(store, config);
  assert.ok(!merged.library.a, 'a photo deleted while the file was unreadable came back');
  assert.strictEqual(merged.trash.length, 1, 'the tombstone that keeps it deleted was dropped');
});

// The other direction: absence is not a deletion. Without tombstones the two are
// indistinguishable, which is how a returning store resurrects things.
ok('отсутствие записи само по себе удалением не считается', () => {
  const store = { library: { a: item('a', { rev: 5 }) }, trash: [] };
  const config = { library: {}, trash: [] };

  const merged = S.mergePool(store, config);
  assert.ok(merged.library.a, 'a record missing from one side was treated as deleted');
});

ok('фото, возвращённое ПОСЛЕ удаления, остаётся живым', () => {
  // Deleted at rev 6, then put back — restoring bumps the record past the tombstone.
  const store = { library: {}, trash: [tomb('a', { rev: 6 })] };
  const config = { library: { a: item('a', { rev: 7 }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.ok(merged.library.a, 'restoring a photo did not survive the merge');
  assert.strictEqual(merged.trash.length, 0, 'a restored photo kept its tombstone and would vanish again');
});

ok('очень старый store не отменяет свежих правок', () => {
  // The owner restored a backup from before the edits.
  const store = { library: { a: item('a', { rev: 1, tags: [] }) }, trash: [] };
  const config = { library: { a: item('a', { rev: 12, tags: ['kept'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library.a.tags, ['kept'], 'restoring an old backup wiped newer work');
});

// --- what the decision deliberately gives up ---------------------------------

// Recorded as a test so it is a KNOWN cost rather than a surprise: with one revision
// per record, two edits to the same photo from two sides do not combine.
ok('принятая цена: две правки одного фото не складываются', () => {
  const store = { library: { a: item('a', { rev: 8, favorite: true, tags: [] }) }, trash: [] };
  const config = { library: { a: item('a', { rev: 9, favorite: false, tags: ['sunset'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library.a.tags, ['sunset'], 'the newer record should win whole');
  assert.strictEqual(merged.library.a.favorite, false,
    'per-record revisions mean the star from the other side is lost — this is the accepted trade');
});

// --- old files, which have no revisions at all -------------------------------

ok('записи без ревизии читаются как нулевые и не ломают слияние', () => {
  const legacy = { id: 'a', type: 'image', path: 'C:/photos/a.png', tags: [] };
  const store = { library: { a: legacy }, trash: [] };
  const config = { library: { a: item('a', { rev: 1, tags: ['newer'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library.a.tags, ['newer'],
    'a record from before revisions existed beat one that was actually edited later');
});

if (failures.length) {
  console.log('\n' + failures.length + ' FAILED, ' + passed + ' passed\n');
  for (const f of failures) {
    console.log('FAILED: ' + f.name);
    console.log(String(f.err && f.err.stack ? f.err.stack : f.err));
  }
  process.exit(1);
}
console.log('\nAll ' + passed + ' merge-revision tests passed.');
