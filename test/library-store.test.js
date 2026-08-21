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

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-store-'));
let dirSeq = 0;
const freshDir = () => {
  const d = path.join(root, `p${dirSeq++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const item = (id, extra = {}) => ({ id, type: 'image', path: `C:/pics/${id}.png`, addedAt: 1, favorite: false, tags: [], author: '', ...extra });

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
  const lib = { a: item('a', { tags: ['x', 'y'], favorite: true }), b: item('b') };
  ok('save reports success', S.save(lib, cfgPath) === true);
  const back = S.load(cfgPath);
  ok('load round-trips the pool', back.existed && Object.keys(back.library).length === 2
    && back.library.a.tags.join(',') === 'x,y' && back.library.a.favorite === true);
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
    good: item('good'),
    noPath: { id: 'noPath', type: 'image' },
    notObject: 'nope',
    nullish: null,
  } });
  ok('normalize keeps usable entries and drops malformed ones',
    Object.keys(norm.library).length === 1 && !!norm.library.good);
}

ok('normalize survives garbage input', Object.keys(S.normalizeStore(null).library).length === 0
  && Object.keys(S.normalizeStore([1, 2]).library).length === 0);

// --- merge with an inline pool (older build rolled back and wrote its own) ---

{
  const merged = S.mergeLibraries(
    { shared: item('shared', { tags: ['from-store'] }), onlyStore: item('onlyStore') },
    { shared: item('shared', { tags: ['from-config'] }), onlyConfig: item('onlyConfig') },
  );
  ok('store wins for ids present in both', merged.shared.tags[0] === 'from-store');
  ok('ids present only in the inline copy are kept, not lost',
    !!merged.onlyConfig && !!merged.onlyStore && Object.keys(merged).length === 3);
}

// --- migration from a pre-split config --------------------------------------

{
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    style: 'fit',
    library: { id1: item('id1', { tags: ['keepme'], favorite: true }) },
    monitors: { MON: { light: { itemIds: ['id1'] }, dark: { itemIds: [] } } },
  }));
  const loaded = C.load(cfgPath);
  ok('a config written before the split still yields its pool',
    Object.keys(loaded.library).length === 1 && loaded.library.id1.tags[0] === 'keepme');

  C.save(loaded, cfgPath);
  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok('after saving, config.json no longer carries the pool', onDisk.library === undefined);
  ok('...and the settings are still there', onDisk.style === 'fit');
  ok('...and the pool moved to its own file',
    Object.keys(S.load(cfgPath).library).length === 1);

  const reloaded = C.load(cfgPath);
  ok('reload rebuilds the same pool with its metadata intact',
    reloaded.library.id1.favorite === true && reloaded.library.id1.tags[0] === 'keepme'
    && reloaded.monitors.MON.light.itemIds[0] === 'id1');
}

// --- skipLibrary leaves the pool file alone ---------------------------------

{
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  const cfg = C.freshDefaults();
  cfg.library = { a: item('a') };
  C.save(cfg, cfgPath);
  cfg.library.b = item('b');
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

const L = require('../src/library');
const trashEntry = (id, extra = {}) => ({ item: item(id, extra), removedAt: 1000 + Number(id.replace(/\D/g, '') || 0), file: '' });

{
  const dir = freshDir();
  const cfgPath = path.join(dir, 'config.json');
  const cfg = C.freshDefaults();
  cfg.library = { keep: item('keep') };
  cfg.libraryTrash = [trashEntry('gone1', { tags: ['keepme'], favorite: true })];
  C.save(cfg, cfgPath);

  const back = C.load(cfgPath);
  ok('a removed photo survives a restart with its tags and favourite',
    back.libraryTrash.length === 1 && back.libraryTrash[0].item.tags[0] === 'keepme'
    && back.libraryTrash[0].item.favorite === true);
  ok('...and is not mixed back into the pool', Object.keys(back.library).join() === 'keep');

  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok('the settings file carries neither the pool nor the trash',
    onDisk.library === undefined && onDisk.libraryTrash === undefined);
}

{
  // Whatever sits in the trash must not be swept away by the wallpaper GC, or the
  // "put back" button would point at a file that is no longer there.
  const keep = L.referencedFiles({
    library: { a: item('a') },
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
  ok('...keeps the newest removal', overflow.trash.some((e) => e.item.id === 'newest'));
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
  const norm = S.normalizeStore({ version: 1, library: {}, trash: [
    null, 'nope', { item: { id: 'noPath' } }, { item: { path: 'C:/x.png' } }, trashEntry('ok1'),
  ] });
  ok('malformed trash entries are dropped without losing the good one',
    norm.trash.length === 1 && norm.trash[0].item.id === 'ok1');
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
    library: { id1: item('id1', { tags: ['precious'], favorite: true }) },
    monitors: { MON: { light: { itemIds: ['id1'] }, dark: { itemIds: [] } } },
  }));
  const loaded = C.load(cfgPath);

  // Make the store unwritable by putting a DIRECTORY where its file belongs.
  fs.mkdirSync(S.storePathFor(cfgPath), { recursive: true });
  const savedWhileBlocked = C.save(loaded, cfgPath);
  ok('a failed pool write is reported, not swallowed', savedWhileBlocked === false);

  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok('...and config.json KEEPS the inline pool, so nothing is lost',
    !!onDisk.library && !!onDisk.library.id1 && onDisk.library.id1.tags[0] === 'precious');
  ok('...settings are still saved', onDisk.style === 'fit');

  // Clear the obstruction: the next save completes the migration.
  fs.rmSync(S.storePathFor(cfgPath), { recursive: true, force: true });
  ok('the retry completes the migration', C.save(loaded, cfgPath) === true);
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok('...and only then does config.json let the pool go', after.library === undefined);
  ok('...with the record intact in its own file',
    S.load(cfgPath).library.id1.tags[0] === 'precious');
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
  let fire = null;
  const w = S.createWriter({
    configPath: 'C:/p/config.json',
    saveFn: (lib) => { seen.push(Object.keys(lib).length); if (failNext) { failNext = false; return false; } return true; },
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => { fire = null; },
  });
  w.markDirty({ a: 1, b: 2 });
  fire();
  ok('a failed write keeps the pool pending', seen.length === 1 && w.isPending());
  ok('...and schedules its own retry', typeof fire === 'function');
  fire();
  ok('...which writes the same data and clears it', seen.length === 2 && seen[1] === 2 && !w.isPending());
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

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nAll ${passed} library-store tests passed.`);
