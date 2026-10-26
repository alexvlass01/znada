'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('../src/library');
const S = require('../src/library-store');
const config = require('../src/config');
const { makeTempDir } = require('./helpers/temp-dir');
const { createConfigStore } = require('../src/config-store');
const poolConsistency = require('../src/pool-consistency');

// BUG-060: use the real startup writer, not just config.load + an explicit save.
// A migration must not turn an unresolved live/trash tie into a restore event.
function boot(file) {
  let current;
  const store = createConfigStore({
    configPath: file, configMod: config, libraryStore: S, poolConsistency,
    normalizeOnlineSources: (sources) => sources,
    getConfig: () => current, setConfig: (next) => { current = next; },
    onLoaded: () => {}, broadcast: () => {}, notify: () => {},
    randomId: () => 'bug060',
  });
  try { store.load(); return current; } finally { store.dispose(); }
}

for (const [name, extra, liveRev, tombRev] of [
  ['legacy-zero', { favorite: true }, 0, 0],
  ['legacy-positive', { favorite: true }, 7, 7],
  ['not-favorite', { favorite: false }, 0, 0],
  ['already-dated', { favorite: true, favoritedAt: 42 }, 0, 0],
  ['newer-tombstone', { favorite: true }, 0, 1],
  ['newer-live', { favorite: true }, 2, 1],
]) {
  const root = makeTempDir('znada-star-conflict-');
  const file = path.join(root, 'config.json');
  const item = { ...L.makeItem('image', path.join(root, 'photo.jpg'), { addedAt: 100 }),
    ...extra, rev: liveRev, tags: ['live-only'] };
  const tomb = { item: { ...item, rev: 99, tags: ['only-in-trash'] },
    rev: tombRev, removedAt: 500,
    slots: [{ monitorId: '\\\\.\\DISPLAY1', theme: 'dark', index: 2, emptied: true }] };
  fs.writeFileSync(file, '{}');
  assert.ok(S.save({ [item.id]: item }, file, [tomb]));
  const expectedTrash = S.load(file).trash;
  const first = boot(file);
  const persisted = S.load(file);
  const disk = S.mergePool(persisted, {});
  const second = boot(file);
  const third = boot(file);
  for (const [phase, state] of [['second', second], ['first', first], ['third', third],
    ['disk', { library: disk.library, libraryTrash: disk.trash }]]) {
    const live = state.library[item.id];
    assert.strictEqual(!!live, liveRev >= tombRev, `${name}/${phase}: live winner`);
    assert.deepStrictEqual(state.libraryTrash, liveRev > tombRev ? [] : expectedTrash,
      `${name}/${phase}: preserve tombstone, exclusive tags and slots`);
    if (live) {
      assert.deepStrictEqual(live.tags, ['live-only']);
      assert.strictEqual(L.revOf(live), liveRev, `${name}/${phase}: migration is not an edit`);
      assert.strictEqual(live.favoritedAt, extra.favorite ? (extra.favoritedAt ?? 100) : undefined);
    }
  }
  assert.strictEqual(second._poolSource.normalizeAdded, false, `${name}: persisted migration`);
  assert.strictEqual(third._poolSource.normalizeAdded, false, `${name}: idempotent restart`);
  console.log(`  BUG-060 ${name}: startup/restart/disk PASS`);
}

const old = { ...L.makeItem('image', 'C:/photo.jpg', { addedAt: 100 }), favorite: true };
const pool = { [old.id]: old };
L.migrateFavoriteDates(pool);
assert.strictEqual(old.favoritedAt, 100);
assert.strictEqual(old.rev, 0);
L.migrateFavoriteDates(pool);
assert.strictEqual(old.rev, 0);
const stale = { ...old, rev: 0 };
delete stale.favoritedAt;
assert.strictEqual(S.mergePool({ library: pool, trash: [] },
  { library: { [old.id]: stale }, trash: [] }).library[old.id].favoritedAt, 100);
assert.strictEqual(L.toggleFavorite(pool, old.id, 200), false);
assert.strictEqual(old.favoritedAt, null);
assert.strictEqual(L.toggleFavorite(pool, old.id, 300), true);
assert.strictEqual(old.favoritedAt, 300);
assert.strictEqual(old.rev, 2);
assert.strictEqual(L.updateItem(pool, old.id, { author: 'User edit' }), true);
assert.strictEqual(old.rev, 3);
assert.strictEqual(L.updateItem(pool, old.id, { author: 'User edit' }), false);
assert.strictEqual(old.rev, 3);
assert.strictEqual(L.makeItem('image', 'C:/new.jpg', { favorite: true, addedAt: 50 }).favoritedAt, 50);
const dir = makeTempDir('znada-star-date-');
const file = path.join(dir, 'config.json');
fs.writeFileSync(file, JSON.stringify({ library: { [old.id]: stale } }));
const loaded = config.load(file);
assert.strictEqual(loaded.library[old.id].favoritedAt, 100);
assert.ok(loaded._poolSource.normalizeAdded, 'date-only migration must schedule pool persistence');
assert.ok(S.save(loaded.library, file, []));
const restarted = config.load(file);
assert.strictEqual(restarted.library[old.id].favoritedAt, 100);
assert.strictEqual(restarted.library[old.id].rev, loaded.library[old.id].rev);
assert.strictEqual(restarted._poolSource.normalizeAdded, false);
console.log('library favorite dates: migration, revision merge and re-star PASS');
