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
const { pathKey } = require('../src/path-key');

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

const fixturePath = (name) => 'C:/photos/' + name + '.png';
const A = L.idFor(fixturePath('a'));
const B = L.idFor(fixturePath('b'));
const FOLDER_A_PATH = 'C:/photos/folder-a';
const FOLDER_A = L.idFor(FOLDER_A_PATH);

function item(name, extra = {}) {
  const itemPath = extra.path || fixturePath(name);
  return Object.assign({
    id: L.idFor(itemPath),
    type: 'image',
    path: itemPath,
    addedAt: 1000,
    favorite: false,
    tags: [],
    author: '',
    rev: 0,
  }, extra);
}

function tomb(name, extra = {}) {
  return Object.assign({
    removedAt: 2000,
    removalId: 'r-' + name,
    via: 'manual',
    item: item(name),
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
  const store = { library: { [A]: item('a', { rev: 3, tags: ['old'] }) }, trash: [] };
  const config = { library: { [A]: item('a', { rev: 7, tags: ['new'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library[A].tags, ['new'], 'the older record won because of which file it was in');
});

// The reason the old rule existed, and it has to keep working. A build without the
// dedicated store writes its pool back into config.json; those records are OLDER.
ok('откат на старую сборку не побеждает свежий store', () => {
  const store = { library: { [A]: item('a', { rev: 9, tags: ['current'] }) }, trash: [] };
  const config = { library: { [A]: item('a', { rev: 2, tags: ['stale'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library[A].tags, ['current'], 'a rolled-back build overwrote newer data');
});

ok('при равных ревизиях побеждает store — прежнее правило как tie-break', () => {
  const store = { library: { [A]: item('a', { rev: 4, tags: ['store'] }) }, trash: [] };
  const config = { library: { [A]: item('a', { rev: 4, tags: ['inline'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library[A].tags, ['store']);
});

ok('запись, которой нет в store, сохраняется, а не пропадает', () => {
  const store = { library: {}, trash: [] };
  const config = { library: { [B]: item('b', { rev: 1 }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.ok(merged.library[B], 'a record only the inline copy had was dropped');
});

// --- the scenario this whole task exists for ---------------------------------

ok('тег из аварийной сессии переживает возврат исправленного файла', () => {
  // The store was damaged, so the edit went inline and bumped the record's revision.
  const store = { library: { [A]: item('a', { rev: 5, tags: [] }) }, trash: [] };
  const config = { library: { [A]: item('a', { rev: 6, tags: ['sunset'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(
    merged.library[A].tags, ['sunset'],
    'the tag added while the file was unreadable was thrown away when the file came back',
  );
});

ok('удаление из аварийной сессии не воскресает', () => {
  // The photo is still in the store — it was deleted while the store could not be written.
  const store = { library: { [A]: item('a', { rev: 5 }) }, trash: [] };
  const config = { library: {}, trash: [tomb('a', { rev: 6 })] };

  const merged = S.mergePool(store, config);
  assert.ok(!merged.library[A], 'a photo deleted while the file was unreadable came back');
  assert.strictEqual(merged.trash.length, 1, 'the tombstone that keeps it deleted was dropped');
});

// The other direction: absence is not a deletion. Without tombstones the two are
// indistinguishable, which is how a returning store resurrects things.
ok('отсутствие записи само по себе удалением не считается', () => {
  const store = { library: { [A]: item('a', { rev: 5 }) }, trash: [] };
  const config = { library: {}, trash: [] };

  const merged = S.mergePool(store, config);
  assert.ok(merged.library[A], 'a record missing from one side was treated as deleted');
});

ok('фото, возвращённое ПОСЛЕ удаления, остаётся живым', () => {
  // Deleted at rev 6, then put back — restoring bumps the record past the tombstone.
  const store = { library: {}, trash: [tomb('a', { rev: 6 })] };
  const config = { library: { [A]: item('a', { rev: 7 }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.ok(merged.library[A], 'restoring a photo did not survive the merge');
  assert.strictEqual(merged.trash.length, 0, 'a restored photo kept its tombstone and would vanish again');
});

ok('очень старый store не отменяет свежих правок', () => {
  // The owner restored a backup from before the edits.
  const store = { library: { [A]: item('a', { rev: 1, tags: [] }) }, trash: [] };
  const config = { library: { [A]: item('a', { rev: 12, tags: ['kept'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library[A].tags, ['kept'], 'restoring an old backup wiped newer work');
});

// --- what the decision deliberately gives up ---------------------------------

// Recorded as a test so it is a KNOWN cost rather than a surprise: with one revision
// per record, two edits to the same photo from two sides do not combine.
ok('принятая цена: две правки одного фото не складываются', () => {
  const store = { library: { [A]: item('a', { rev: 8, favorite: true, tags: [] }) }, trash: [] };
  const config = { library: { [A]: item('a', { rev: 9, favorite: false, tags: ['sunset'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library[A].tags, ['sunset'], 'the newer record should win whole');
  assert.strictEqual(merged.library[A].favorite, false,
    'per-record revisions mean the star from the other side is lost — this is the accepted trade');
});

// --- old files, which have no revisions at all -------------------------------

ok('записи без ревизии читаются как нулевые и не ломают слияние', () => {
  const legacy = { id: A, type: 'image', path: fixturePath('a'), tags: [] };
  const store = { library: { [A]: legacy }, trash: [] };
  const config = { library: { [A]: item('a', { rev: 1, tags: ['newer'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library[A].tags, ['newer'],
    'a record from before revisions existed beat one that was actually edited later');
});

// --- BUG-024: a revision is only an argument if the record is real ------------
//
// Revisions decide WHICH side wins. They were being read off both sides before either
// side was checked for being a record at all, so `{ id, rev: 999 }` — no path, nothing
// else — beat a healthy record and then went to disk as the authoritative one. The
// photo's path, tags and star were gone, and nothing had failed.
//
// The tombstone side was worse. `newestTombstones` only asked for `item.id`, so a
// malformed tombstone with a big revision deleted a live record — and was then thrown
// out itself by boundedTrash, which does validate. Net result: the photo vanished from
// the pool AND from the trash, so it could not even be put back.

ok('характеризация: валидная более новая запись по-прежнему побеждает', () => {
  const store = { library: { [A]: item('a', { rev: 5, tags: ['store'] }) }, trash: [] };
  const config = { library: { [A]: item('a', { rev: 2, tags: ['inline'] }) }, trash: [] };
  assert.deepStrictEqual(S.mergePool(store, config).library[A].tags, ['store']);
});

ok('характеризация: при равной ревизии выигрывает store', () => {
  const store = { library: { [A]: item('a', { rev: 3, tags: ['store'] }) }, trash: [] };
  const config = { library: { [A]: item('a', { rev: 3, tags: ['inline'] }) }, trash: [] };
  assert.deepStrictEqual(S.mergePool(store, config).library[A].tags, ['store'],
    'the rollback protection that makes the store authoritative on a tie was lost');
});

ok('характеризация: валидная запись, которая есть ТОЛЬКО inline, сохраняется', () => {
  const store = { library: {}, trash: [] };
  const config = { library: { [A]: item('a', { rev: 1 }) }, trash: [] };
  assert.ok(S.mergePool(store, config).library[A],
    'an inline-only record from a rolled-back build was dropped');
});

ok('валидный inline-вклад отличается от отклонённых кандидатов', () => {
  // What authorises main to rewrite the canonical file is "something inline actually
  // contributed". Counting rejected candidates as a contribution makes a damaged
  // config.json trigger a rewrite of a perfectly healthy store.
  const real = S.mergePool({ library: {}, trash: [] }, { library: { [A]: item('a', { rev: 1 }) }, trash: [] });
  assert.strictEqual(real.inlineContributed, true, 'a real inline contribution was not reported');
});

ok('характеризация: более новый tombstone по-прежнему убирает живую запись', () => {
  const store = { library: { [A]: item('a', { rev: 1 }) }, trash: [] };
  const config = { library: {}, trash: [tomb('a', { rev: 4 })] };
  const merged = S.mergePool(store, config);
  assert.ok(!merged.library[A], 'a valid newer deletion stopped working');
  assert.strictEqual(merged.trash.length, 1);
});

ok('характеризация: при равной ревизии запись и её tombstone остаются вместе', () => {
  const store = { library: { [A]: item('a', { rev: 2 }) }, trash: [] };
  const config = { library: {}, trash: [tomb('a', { rev: 2 })] };
  const merged = S.mergePool(store, config);
  assert.ok(merged.library[A], 'the pair was decided by guesswork instead of left to the repair path');
  assert.strictEqual(merged.trash.length, 1);
});

ok('битая inline-запись с большей ревизией не побеждает здоровую', () => {
  const healthy = item('a', { rev: 3, tags: ['keep'] });
  const store = { library: { [A]: healthy }, trash: [] };
  // No path: not a record, whatever number it carries.
  const config = { library: { [A]: { id: A, rev: 999 } }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.strictEqual(merged.library[A].path, healthy.path, 'a record with no path won on revision alone');
  assert.deepStrictEqual(merged.library[A].tags, ['keep'], 'the healthy record lost its tags');
});

ok('запись под чужим id не побеждает здоровую большей ревизией', () => {
  const healthy = item('a', { rev: 3, tags: ['keep'] });
  const store = { library: { [A]: healthy }, trash: [] };
  // The map key is the pool identity. A record claiming another id cannot be the
  // newer version of `a`, even though it has a path and a larger revision.
  const impostor = item('b', { path: 'C:/photos/other.png', rev: 999 });
  const config = { library: { [A]: impostor }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.strictEqual(merged.library[A].id, A, 'a record under another identity won the merge');
  assert.strictEqual(merged.library[A].path, healthy.path, 'the healthy record lost its path');
  assert.deepStrictEqual(merged.library[A].tags, ['keep'], 'the healthy record lost its metadata');
});

ok('запись с id здорового фото, но путём другого, не побеждает по ревизии', () => {
  const healthy = L.makeItem('image', 'C:/photos/owned.png', { rev: 3, tags: ['keep'] });
  const id = healthy.id;
  const impostor = { ...healthy, path: 'C:/photos/other.png', rev: 999, tags: ['replace'] };

  const merged = S.mergePool(
    { library: { [id]: healthy }, trash: [] },
    { library: { [id]: impostor }, trash: [] },
  );
  assert.strictEqual(merged.library[id].path, healthy.path,
    'an id borrowed from another path displaced the owned photo');
  assert.ok(L.referencedFiles({ library: merged.library }).has(pathKey(healthy.path)),
    'the owned photo fell out of the destructive GC keep-set');
});

ok('запись без поддерживаемого type не снимает файл с GC keep-set', () => {
  const healthy = item('a', { rev: 3, tags: ['keep'] });
  const store = { library: { [A]: healthy }, trash: [] };
  // A non-empty path alone is not enough: referencedFiles intentionally protects only
  // image records, so accepting this candidate would make the real owned copy orphaned.
  const config = { library: { [A]: { id: A, path: 'C:/photos/other.bin', rev: 999 } }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.strictEqual(merged.library[A].path, healthy.path, 'a typeless record displaced the real photo');
  assert.ok(L.referencedFiles({ library: merged.library }).has(
    pathKey(healthy.path)),
  'the surviving photo fell out of the destructive GC keep-set');
});

ok('запись с неизвестным type не считается inline-вкладом', () => {
  const invalid = item('a', { type: 'video', rev: 999 });
  const merged = S.mergePool({ library: {}, trash: [] }, { library: { [A]: invalid }, trash: [] });
  assert.ok(!merged.library[A], 'an unsupported record kind entered the pool');
  assert.strictEqual(merged.inlineContributed, false,
    'an unsupported record kind authorised a canonical store rewrite');
});

ok('битая inline-запись не попадает в пул даже когда соперника нет', () => {
  const merged = S.mergePool({ library: {}, trash: [] }, { library: { [A]: { id: A, rev: 999 } }, trash: [] });
  assert.ok(!merged.library[A], 'a pathless record entered the pool and would be written back as real');
  assert.strictEqual(merged.inlineContributed, false,
    'rejected candidates were reported as an inline contribution, which authorises a rewrite');
});

ok('соседняя валидная inline-запись переносится, хотя рядом отклонённая', () => {
  const store = { library: { [A]: item('a', { rev: 3 }) }, trash: [] };
  const config = { library: { [A]: { id: A, rev: 999 }, [B]: item('b', { rev: 1 }) }, trash: [] };
  const merged = S.mergePool(store, config);
  assert.strictEqual(merged.library[A].rev, 3, 'the healthy canonical record was displaced');
  assert.ok(merged.library[B], 'a valid neighbour was thrown out because of the invalid one');
  assert.strictEqual(merged.inlineContributed, true);
});

ok('битый tombstone с большей ревизией не удаляет живую запись', () => {
  const store = { library: { [A]: item('a', { rev: 2 }) }, trash: [] };
  // item without a path — normalizeTrashEntry rejects it, so this deletion is not
  // something the app can have written, and it must not act as one either.
  const config = { library: {}, trash: [{ item: { id: A }, removedAt: 9000, rev: 999 }] };

  const merged = S.mergePool(store, config);
  assert.ok(merged.library[A], 'a malformed tombstone deleted a healthy record');
  assert.strictEqual(merged.trash.length, 0, 'a malformed tombstone was kept as a real one');
});

ok('tombstone без type не удаляет живую запись и не попадает в корзину', () => {
  const store = { library: { [A]: item('a', { rev: 2 }) }, trash: [] };
  const config = {
    library: {},
    trash: [{ item: { id: A, path: fixturePath('a') }, removedAt: 9000, rev: 999 }],
  };

  const merged = S.mergePool(store, config);
  assert.ok(merged.library[A], 'a typeless tombstone deleted a healthy record');
  assert.strictEqual(merged.trash.length, 0, 'a typeless tombstone survived as restorable data');
});

ok('tombstone с id живого фото, но чужим путём, не удаляет его', () => {
  const healthy = L.makeItem('image', 'C:/photos/owned.png', { rev: 2 });
  const id = healthy.id;
  const malformed = {
    item: { ...healthy, path: 'C:/photos/other.png' },
    removedAt: 9000,
    rev: 999,
  };

  const merged = S.mergePool(
    { library: { [id]: healthy }, trash: [] },
    { library: {}, trash: [malformed] },
  );
  assert.ok(merged.library[id], 'a tombstone borrowed another path identity and deleted the live record');
  assert.strictEqual(merged.trash.length, 0, 'the malformed tombstone survived as restorable data');
});

ok('валидные image и folder записи остаются допустимыми', () => {
  const image = item('a', { rev: 1 });
  const folder = item('folder-a', { type: 'folder', path: FOLDER_A_PATH, rev: 1 });
  const merged = S.mergePool(
    { library: {}, trash: [] },
    { library: { [A]: image, [FOLDER_A]: folder }, trash: [] },
  );
  assert.strictEqual(merged.library[A].type, 'image');
  assert.strictEqual(merged.library[FOLDER_A].type, 'folder');
});

ok('битый tombstone не вытесняет валидный', () => {
  const store = { library: {}, trash: [tomb('a', { rev: 4, removedAt: 2000 })] };
  const config = { library: {}, trash: [{ item: { id: A }, removedAt: 9000, rev: 999 }] };

  const merged = S.mergePool(store, config);
  assert.strictEqual(merged.trash.length, 1, 'the valid tombstone was displaced by a malformed one');
  assert.strictEqual(merged.trash[0].removedAt, 2000);
  assert.strictEqual(merged.trash[0].item.path, 'C:/photos/a.png',
    'the entry the user would restore from lost its photo');
});

ok('два tombstone с равной ревизией: побеждает более позднее удаление', () => {
  // boundedTrash already breaks a revision tie by removedAt. newestTombstones ran first
  // and kept whichever source came first, so the later deletion never reached it.
  const store = { library: {}, trash: [tomb('a', { rev: 2, removedAt: 1000, via: 'older' })] };
  const config = { library: {}, trash: [tomb('a', { rev: 2, removedAt: 5000, via: 'newer' })] };

  const merged = S.mergePool(store, config);
  assert.strictEqual(merged.trash.length, 1);
  assert.strictEqual(merged.trash[0].via, 'newer',
    'the earlier removal won a tie that removedAt already knows how to break');
});

ok('битая запись со стороны store тоже отклоняется', () => {
  // The store side reaches mergePool already filtered by normalizeStore on the real
  // startup path — but mergePool is a boundary of its own, and a rule that only one
  // side obeys is not a shared rule. Here the damaged entry is the CANONICAL one.
  const store = { library: { [A]: { id: A, rev: 9 } }, trash: [] };
  const config = { library: { [A]: item('a', { rev: 1, tags: ['inline'] }) }, trash: [] };

  const merged = S.mergePool(store, config);
  assert.deepStrictEqual(merged.library[A].tags, ['inline'],
    'a pathless canonical entry beat the only real record there was');

  const alone = S.mergePool(store, { library: {}, trash: [] });
  assert.ok(!alone.library[A], 'a pathless canonical entry entered the pool unopposed');
});

ok('нулевая ревизия у валидной записи по-прежнему допустима', () => {
  // The rule is about being a RECORD, not about carrying a number: pre-revision data
  // reads as rev 0 and must keep working.
  const legacy = { id: A, type: 'image', path: fixturePath('a'), tags: ['legacy'] };
  const merged = S.mergePool({ library: {}, trash: [] }, { library: { [A]: legacy }, trash: [] });
  assert.deepStrictEqual(merged.library[A].tags, ['legacy']);
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
