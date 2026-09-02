'use strict';

// Tests for the photo-pool store: where it lands, what survives a corrupt file,
// how it merges with a config written by an older build, and that the batched
// writer actually coalesces a burst of edits without losing the last one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../src/library-store');
const C = require('../src/config');
const L = require('../src/library');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-store-'));
let dirSeq = 0;
const freshDir = () => {
  const d = path.join(root, `p${dirSeq++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const fixturePath = (name) => `C:/pics/${name}.png`;
const fixtureId = (name) => L.idFor(fixturePath(name));
const item = (name, extra = {}) => {
  const itemPath = extra.path || fixturePath(name);
  return { id: L.idFor(itemPath), type: 'image', path: itemPath, addedAt: 1, favorite: false, tags: [], author: '', ...extra };
};
const keyedLibrary = (...items) => Object.fromEntries(items.map((entry) => [entry.id, entry]));

// --- where the file lands ---------------------------------------------------

ok('store is named after its config, not a fixed name',
  path.basename(S.storePathFor('C:/profile/config.json')) === 'config.library.json');

ok('two configs in one directory get separate stores',
  S.storePathFor('C:/p/config.json') !== S.storePathFor('C:/p/backup.json'));

ok('a path without .json still yields a store',
  path.basename(S.storePathFor('C:/p/settings')) === 'settings.library.json');

// --- round trip -------------------------------------------------------------

{
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  const lib = keyedLibrary(item('a', { tags: ['x', 'y'], favorite: true }), item('b'));
  ok('save reports success', S.save(lib, cfgPath) === true);
  const back = S.load(cfgPath);
  ok('load round-trips the pool', back.existed && Object.keys(back.library).length === 2
    && back.library[fixtureId('a')].tags.join(',') === 'x,y'
    && back.library[fixtureId('a')].favorite === true);
}

{
  const dir = freshDir();
  const res = S.load(path.join(dir, 'config.json'));
  ok('missing store is not an error, just "no store yet"',
    res.existed === false && res.broken === false && Object.keys(res.library).length === 0);
}

// --- a corrupt pool must be preserved, never silently dropped ---------------

{
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(S.storePathFor(cfgPath), '{ this is not json');
  const res = S.load(cfgPath);
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  ok('corrupt store is backed up rather than overwritten',
    res.broken === true && res.existed === true && backups.length === 1);
}

// --- entries that cannot be trusted are dropped, the rest survive ------------

{
  const norm = S.normalizeStore({ version: 1, library: {
    [fixtureId('good')]: item('good'),
    [fixtureId('noPath')]: { id: fixtureId('noPath'), type: 'image' },
    notObject: 'nope',
    nullish: null,
  } });
  ok('normalize keeps usable entries and drops malformed ones',
    Object.keys(norm.library).length === 1 && !!norm.library[fixtureId('good')]);
}

ok('normalize survives garbage input', Object.keys(S.normalizeStore(null).library).length === 0
  && Object.keys(S.normalizeStore([1, 2]).library).length === 0);

// --- merge with an inline pool (older build rolled back and wrote its own) ---

{
  const merged = S.mergeLibraries(
    keyedLibrary(item('shared', { tags: ['from-store'] }), item('onlyStore')),
    keyedLibrary(item('shared', { tags: ['from-config'] }), item('onlyConfig')),
  );
  ok('store wins for ids present in both', merged[fixtureId('shared')].tags[0] === 'from-store');
  ok('ids present only in the inline copy are kept, not lost',
    !!merged[fixtureId('onlyConfig')] && !!merged[fixtureId('onlyStore')]
    && Object.keys(merged).length === 3);
}

// --- migration from a pre-split config --------------------------------------

{
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    style: 'fit',
    library: keyedLibrary(item('id1', { tags: ['keepme'], favorite: true })),
    monitors: { MON: { light: { itemIds: [fixtureId('id1')] }, dark: { itemIds: [] } } },
  }));
  const loaded = C.load(cfgPath);
  ok('a config written before the split still yields its pool',
    Object.keys(loaded.library).length === 1
    && loaded.library[fixtureId('id1')].tags[0] === 'keepme');

  C.save(loaded, cfgPath);
  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok('after saving, config.json no longer carries the pool', onDisk.library === undefined);
  ok('...and the settings are still there', onDisk.style === 'fit');
  ok('...and the pool moved to its own file',
    Object.keys(S.load(cfgPath).library).length === 1);

  const reloaded = C.load(cfgPath);
  ok('reload rebuilds the same pool with its metadata intact',
    reloaded.library[fixtureId('id1')].favorite === true
    && reloaded.library[fixtureId('id1')].tags[0] === 'keepme'
    && reloaded.monitors.MON.light.itemIds[0] === fixtureId('id1'));
}

// --- skipLibrary leaves the pool file alone ---------------------------------

{
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  const cfg = C.freshDefaults();
  cfg.library = keyedLibrary(item('a'));
  C.save(cfg, cfgPath);
  cfg.library[fixtureId('b')] = item('b');
  C.save(cfg, cfgPath, { skipLibrary: true });
  ok('skipLibrary writes settings without touching the pool file',
    Object.keys(S.load(cfgPath).library).length === 1);
  C.save(cfg, cfgPath);
  ok('a normal save then persists the pool',
    Object.keys(S.load(cfgPath).library).length === 2);
}

// --- the batched writer ------------------------------------------------------

{
  const writes = [];
  let fire = null;
  const w = S.createWriter({
    configPath: 'C:/p/config.json',
    saveFn: (lib) => { writes.push(Object.keys(lib).length); return true; },
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => { fire = null; },
  });

  w.markDirty({ a: 1 });
  w.markDirty({ a: 1, b: 2 });
  w.markDirty({ a: 1, b: 2, c: 3 });
  ok('a burst of edits schedules no write yet', writes.length === 0 && w.isPending());
  fire();
  ok('the burst collapses into ONE write carrying the latest pool',
    writes.length === 1 && writes[0] === 3 && !w.isPending());

  w.markDirty({ a: 1 });
  w.flush();
  ok('flush writes immediately (the quit path)', writes.length === 2 && !w.isPending());

  w.flush();
  ok('flushing with nothing pending writes nothing', writes.length === 2);

  w.markDirty({ a: 1 });
  w.dispose();
  ok('dispose drops the pending timer without writing', writes.length === 2);
}

{
  // A failing pool write must report failure rather than throw into a settings save.
  const w = S.createWriter({
    configPath: 'C:/p/config.json',
    saveFn: () => false,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  w.markDirty({ a: 1 });
  ok('a failed write is reported, not thrown', w.flush() === false);
}

// --- the library trash (LIB-006) --------------------------------------------
//
// A photo Lumina copied for itself has no original anywhere else, so removing it
// has to be as reversible as removing one that lives in a watched folder.

const trashEntry = (id, extra = {}) => ({ item: item(id, extra), removedAt: 1000 + Number(id.replace(/\D/g, '') || 0), file: '' });

{
  // DATA-005: exercise the same boundaries as the app. A deletion is normalized
  // by pushEntry, normalized again on save, parsed/normalized on load, and only
  // then compared with an older record returning from the other file. Testing
  // mergePool with a hand-written tombstone misses every persistence boundary
  // where its top-level revision can be dropped.
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  const stale = item('deleted', { rev: 5 });
  const pushed = S.pushEntry([], {
    item: stale,
    removedAt: 2000,
    rev: 6,
  });

  ok('a pushed tombstone keeps its top-level revision',
    pushed.trash.length === 1 && pushed.trash[0].rev === 6);
  ok('a tombstone can be saved after the deletion',
    S.save({}, cfgPath, pushed.trash) === true);

  const reloaded = S.load(cfgPath);
  const merged = S.mergePool(reloaded, {
    library: keyedLibrary(stale),
    trash: [],
  });
  ok('push -> save/load -> merge cannot resurrect a stale record',
    reloaded.trash[0].rev === 6
    && !merged.library[stale.id]
    && merged.trash.length === 1
    && merged.trash[0].rev === 6);

  const numericText = S.normalizeTrashEntry({ item: stale, removedAt: 2000, rev: '7' });
  const malformed = S.normalizeTrashEntry({ item: stale, removedAt: 2000, rev: -3 });
  ok('tombstone revisions are normalized without retaining malformed values',
    numericText.rev === 7 && !Object.prototype.hasOwnProperty.call(malformed, 'rev'));
}

{
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  const cfg = C.freshDefaults();
  cfg.library = keyedLibrary(item('keep'));
  cfg.libraryTrash = [trashEntry('gone1', { tags: ['keepme'], favorite: true })];
  C.save(cfg, cfgPath);

  const back = C.load(cfgPath);
  ok('a removed photo survives a restart with its tags and favourite',
    back.libraryTrash.length === 1 && back.libraryTrash[0].item.tags[0] === 'keepme'
    && back.libraryTrash[0].item.favorite === true);
  ok('...and is not mixed back into the pool',
    Object.keys(back.library).join() === fixtureId('keep'));

  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok('the settings file carries neither the pool nor the trash',
    onDisk.library === undefined && onDisk.libraryTrash === undefined);
}

{
  // Whatever sits in the trash must not be swept away by the wallpaper GC, or the
  // "put back" button would point at a file that is no longer there.
  const keep = L.referencedFiles({
    library: keyedLibrary(item('a')),
    libraryTrash: [trashEntry('b')],
    lightWallpaper: '', darkWallpaper: '',
  });
  ok('GC keeps files that are only referenced by the trash',
    keep.has(L.pathKey(item('b').path)));
  ok('...as well as the ones still in the library',
    keep.has(L.pathKey(item('a').path)));
}

{
  const many = Array.from({ length: S.TRASH_LIMIT + 25 }, (_, i) => trashEntry(`x${i}`));
  const norm = S.normalizeStore({ version: 1, library: {}, trash: many });
  ok('the trash is capped so the file cannot grow without limit', norm.trash.length === S.TRASH_LIMIT);
  ok('the newest removals are the ones kept',
    norm.trash[0].removedAt > norm.trash[norm.trash.length - 1].removedAt);
}

{
  // The trash is also what holds the wallpaper collector off these files. If the list
  // in memory were longer than the one that survives a restart, the oldest entry would
  // silently stop being protected and its file would be swept away with no record left
  // to restore it from. So it is bounded on the way IN, and what it evicted is said out
  // loud rather than discovered later.
  let list = [];
  for (let i = 0; i < S.TRASH_LIMIT; i++) list = S.pushEntry(list, trashEntry(`f${i}`)).trash;
  ok('adding up to the cap evicts nothing', list.length === S.TRASH_LIMIT);

  const overflow = S.pushEntry(list, trashEntry('newest', { }));
  ok('one more stays at the cap', overflow.trash.length === S.TRASH_LIMIT);
  ok('...keeps the newest removal',
    overflow.trash.some((e) => e.item.id === fixtureId('newest')));
  ok('...and reports exactly what it pushed out', overflow.evicted.length === 1);

  const keepAfterRestart = L.referencedFiles({ library: {}, libraryTrash: S.normalizeStore({ version: 1, library: {}, trash: overflow.trash }).trash });
  const keepNow = L.referencedFiles({ library: {}, libraryTrash: overflow.trash });
  ok('what the user sees protected is what stays protected after a restart',
    keepNow.size === keepAfterRestart.size);
  ok('the evicted photo is the one that is no longer protected',
    !keepNow.has(path.normalize(overflow.evicted[0].item.path).toLowerCase()));
}

{
  const res = S.pushEntry([trashEntry('a')], null);
  ok('a malformed addition leaves the list valid and evicts nothing',
    res.trash.length === 1 && res.evicted.length === 0);
}

{
  const dup = S.normalizeStore({ version: 1, library: {}, trash: [
    { item: item('same', { tags: ['old'] }), removedAt: 100 },
    { item: item('same', { tags: ['new'] }), removedAt: 900 },
  ] });
  ok('a photo removed twice keeps one entry, the newest',
    dup.trash.length === 1 && dup.trash[0].item.tags[0] === 'new');
}

{
  const clockMovedBack = S.normalizeStore({ version: 1, library: {}, trash: [
    { item: item('clock', { rev: 5, tags: ['older-revision'] }), removedAt: 9000, rev: 6 },
    { item: item('clock', { rev: 7, tags: ['newer-revision'] }), removedAt: 1000, rev: 8 },
  ] });
  ok('a higher tombstone revision wins even when the wall clock moved backwards',
    clockMovedBack.trash.length === 1
    && clockMovedBack.trash[0].rev === 8
    && clockMovedBack.trash[0].item.tags[0] === 'newer-revision');
}

{
  const legacyTie = S.normalizeStore({ version: 1, library: {}, trash: [
    { item: item('legacy-tie', { tags: ['older-time'] }), removedAt: 100 },
    { item: item('legacy-tie', { tags: ['newer-time'] }), removedAt: 900 },
  ] });
  ok('equal or legacy revisions still use removedAt as their tie-break',
    legacyTie.trash.length === 1
    && legacyTie.trash[0].item.tags[0] === 'newer-time');
}

{
  const norm = S.normalizeStore({ version: 1, library: {}, trash: [
    null, 'nope', { item: { id: fixtureId('noPath') } },
    { item: { path: 'C:/x.png' } }, trashEntry('ok1'),
  ] });
  ok('malformed trash entries are dropped without losing the good one',
    norm.trash.length === 1 && norm.trash[0].item.id === fixtureId('ok1'));
}

{
  // A store whose library is unusable must still surrender the trash: those photos
  // exist nowhere else.
  const norm = S.normalizeStore({ version: 1, library: 'broken', trash: [trashEntry('survivor')] });
  ok('a broken pool does not take the trash down with it',
    Object.keys(norm.library).length === 0 && norm.trash.length === 1);
}

{
  const writes = [];
  let fire = null;
  const w = S.createWriter({
    configPath: 'C:/p/config.json',
    saveFn: (lib, _p, trash) => { writes.push({ lib: Object.keys(lib).length, trash: trash.length }); return true; },
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => { fire = null; },
  });
  w.markDirty({ a: 1 }, [trashEntry('t1')]);
  fire();
  ok('the batched writer carries the trash alongside the pool',
    writes.length === 1 && writes[0].lib === 1 && writes[0].trash === 1);
}

// --- what happens when the disk says no (DATA-004) --------------------------
//
// These run the real code against a real filesystem with the failure injected, not
// against a mock of it. Every one of them is a way the library could have been lost.

{
  // The migration writes the pool to its own file and then stops carrying it inline.
  // If that write fails, dropping the inline copy leaves it in NEITHER place.
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    style: 'fit',
    library: keyedLibrary(item('id1', { tags: ['precious'], favorite: true })),
    monitors: { MON: { light: { itemIds: [fixtureId('id1')] }, dark: { itemIds: [] } } },
  }));
  const loaded = C.load(cfgPath);

  // Make the store unwritable by putting a DIRECTORY where its file belongs.
  fs.mkdirSync(S.storePathFor(cfgPath), { recursive: true });
  const savedWhileBlocked = C.save(loaded, cfgPath);
  ok('a failed pool write is reported, not swallowed', savedWhileBlocked === false);

  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok('...and config.json KEEPS the inline pool, so nothing is lost',
    !!onDisk.library && !!onDisk.library[fixtureId('id1')]
    && onDisk.library[fixtureId('id1')].tags[0] === 'precious');
  ok('...settings are still saved', onDisk.style === 'fit');

  // Clear the obstruction: the next save completes the migration.
  fs.rmSync(S.storePathFor(cfgPath), { recursive: true, force: true });
  ok('the retry completes the migration', C.save(loaded, cfgPath) === true);
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok('...and only then does config.json let the pool go', after.library === undefined);
  ok('...with the record intact in its own file',
    S.load(cfgPath).library[fixtureId('id1')].tags[0] === 'precious');
}

{
  // A store that cannot be READ says nothing about its contents. Treating that like
  // "no store yet" would start the app empty and then write that emptiness over it.
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  fs.mkdirSync(S.storePathFor(cfgPath), { recursive: true });   // EISDIR on read
  const res = S.load(cfgPath);
  ok('an unreadable store is reported as unreadable, not as missing',
    res.unreadable === true && res.existed === true && res.broken === false);
  fs.rmSync(S.storePathFor(cfgPath), { recursive: true, force: true });
}

{
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  const res = S.load(cfgPath);
  ok('a genuinely missing store is still just "not written yet"',
    res.existed === false && res.unreadable === false);
}

{
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(S.storePathFor(cfgPath), '{ broken');
  const res = S.load(cfgPath);
  ok('a corrupt store stays a separate, recoverable case',
    res.broken === true && res.unreadable === false);
}

{
  // A transient write failure must not throw the newest pool away: without the
  // pending version there is no retry and the quit-time flush has nothing to save.
  let failNext = true;
  const seen = [];
  let failureHooks = 0;
  let fire = null;
  const w = S.createWriter({
    configPath: 'C:/p/config.json',
    saveFn: (lib) => { seen.push(Object.keys(lib).length); if (failNext) { failNext = false; return false; } return true; },
    onWriteFailure: () => { failureHooks++; },
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => { fire = null; },
  });
  w.markDirty({ a: 1, b: 2 });
  fire();
  ok('a failed write keeps the pool pending', seen.length === 1 && w.isPending() && failureHooks === 1);
  ok('...and schedules its own retry', typeof fire === 'function');
  fire();
  ok('...which writes the same data and clears it',
    seen.length === 2 && seen[1] === 2 && !w.isPending() && failureHooks === 1);
}

{
  let fire = null;
  const w = S.createWriter({
    configPath: 'C:/p/config.json',
    saveFn: () => false,
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => { fire = null; },
  });
  w.markDirty({ a: 1 });
  // Drive it far past the retry budget: the writer must stop scheduling new attempts.
  for (let i = 0; i < 10; i++) { if (!fire) break; const f = fire; fire = null; f(); }
  ok('retries stop rather than spinning forever', fire === null);
  ok('...after a bounded number of attempts', w.writeCount() <= 5);
  ok('...and the data is still pending for the quit-time flush', w.isPending());
}

// A record filed under the wrong key is filed WRONG, not broken.
//
// The identity check that arrived with the 1.7.3 remediation refused such a record
// outright, and refusing means the next save rewrites the file without it — the user's
// tags, star, author and source gone, with nothing said. The danger it was guarding
// against is real (a record sitting under another path's id can win revision arbitration
// and take the real owner's place in the GC keep-set), but re-filing removes that danger
// too, because under its own derived id it cannot stand in for anything.
{
  const photo = 'C:/photos/kept.png';
  const owned = L.idFor(photo);
  const misfiled = {
    'some-old-key': {
      id: 'some-old-key', type: 'image', path: photo,
      tags: ['keep', 'me'], favorite: true, author: 'someone', rev: 3,
    },
  };

  const merged = S.mergePool({ version: 1, library: misfiled, trash: [] }, {});
  const kept = merged.library[owned];
  ok('a record filed under the wrong key is kept, not thrown away', !!kept);
  ok('...under the id its own path derives', Object.keys(merged.library).join() === owned);
  ok('...with everything the user put on it', !!kept
    && kept.tags.join() === 'keep,me' && kept.favorite === true && kept.author === 'someone');
  ok('...and its id corrected, so it can no longer stand in for another path',
    !!kept && kept.id === owned);

  // The same record ALSO present correctly: the newer revision must win, and there must
  // be one record afterwards rather than two of the same photo.
  const both = S.mergePool(
    { version: 1, library: misfiled, trash: [] },
    { library: { [owned]: { id: owned, type: 'image', path: photo, tags: [], rev: 9 } } },
  );
  ok('a corrected duplicate does not become a second copy of the same photo',
    Object.keys(both.library).length === 1);
  ok('...and the newer revision is the one kept', both.library[owned].rev === 9);

  // A record with nothing to re-file BY is still refused: there is no path to derive an
  // id from, so there is no honest place to put it.
  const junk = S.mergePool({
    version: 1,
    library: { x: { id: 'x', type: 'image', path: '', tags: [] } },
    trash: [],
  }, {});
  ok('a record with no path is still refused', Object.keys(junk.library).length === 0);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nAll ${passed} library-store tests passed.`);
