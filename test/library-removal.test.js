'use strict';

// CODE-001 2.2b. Direct tests for src/library-removal.js on fake dependencies, one per
// promise the removal line makes to the user:
// - removal keeps a snapshot for Undo, including places on the monitors, and Undo puts
//   back exactly what it took, where it was;
// - a photo carried along by folders remembers the NEAREST removed folder (`via`);
// - entries pushed out of the bounded trash are counted in the answer;
// - Undo with somebody else's token refuses;
// - restoring a folder brings back only what went with THAT folder, and a later restore
//   puts records back on their monitors;
// - deleting into the Recycle Bin is refused while switched off, and each target is
//   re-checked inside the lock right before it goes;
// - the answer after an await carries the config object current at that moment.
// The pool core is the real src/library-service.js; the removed-marks, saving, the
// wallpaper and Electron are fakes. The same behaviour through the real main.js is proved
// by the harness suites (library-orchestration, library-invariants,
// folder-removal-provenance, trash-eviction-notice, …).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const library = require('../src/library');
const libraryStore = require('../src/library-store');
const playlist = require('../src/playlist');
const { pathKey } = require('../src/path-key');
const { createLibraryService } = require('../src/library-service');
const { createLibraryRemoval } = require('../src/library-removal');
const { makeTempDir } = require('./helpers/temp-dir');

let passed = 0;
async function test(name, fn) {
  const root = makeTempDir('znada-library-removal-');
  try {
    await fn(root);
    passed += 1;
    console.log('  ok ' + name);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeImage(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  return file;
}

// The removed-marks port as main.js implements it, in memory: photo keys and folder keys.
// `changed`/`matched`/`updated` report what actually flipped, like src/folder-state.js.
function fakeMarks() {
  const files = new Map();
  const dirs = new Map();
  const calls = { persist: 0 };
  function flip(map, paths, hidden) {
    const matched = [];
    for (const p of paths) {
      const key = pathKey(p);
      if (hidden ? !map.has(key) : map.has(key)) {
        if (hidden) map.set(key, p); else map.delete(key);
        matched.push(p);
      }
    }
    return { changed: matched.length > 0, matched, updated: matched.length };
  }
  return {
    files, dirs, calls,
    setHidden: (paths, hidden) => flip(files, paths, hidden),
    setHiddenDir: (paths, hidden) => flip(dirs, paths, hidden),
    persistNow: () => { calls.persist++; },
    hiddenPaths: () => new Set(files.keys()),
    listHiddenImages: () => [...files.values()].map((p) => ({ folderId: 'F', path: p, hidden: true })),
    listHiddenDirs: () => [...dirs.values()].map((p) => ({ folderId: 'F', path: p })),
  };
}

function setup(overrides = {}) {
  const state = {
    config: { library: {}, libraryTrash: [], monitors: {}, lightWallpaper: '', darkWallpaper: '' },
    saves: 0, broadcasts: 0, gcs: 0, trays: 0, applies: 0, stale: [], forgotten: [], synced: 0, refreshed: [],
    positions: [], asked: [], trashed: [], errors: [],
    physicalDelete: false, answer: true, rootReady: true, ownDir: '', trashDir: '',
    onApply: null, onTrash: null,
  };
  const marks = fakeMarks();
  const pool = createLibraryService({
    library, playlist, pathKey,
    getConfig: () => state.config,
    slotFor: (monitorId, theme) => {
      const m = state.config.monitors[monitorId];
      return (m && m[theme]) || { itemIds: [] };
    },
    marks,
    liveFolders: { forget: () => {}, sync: () => {} },
    storeSlideshowPosition: () => {},
    log: { error: () => {} },
  });
  let n = 0;
  const removal = createLibraryRemoval({
    library,
    libraryStore,
    pathKey,
    getConfig: () => state.config,
    pool,
    marks,
    liveFolders: {
      forget: (ids) => state.forgotten.push(...ids),
      sync: () => { state.synced++; },
      refresh: (ids) => state.refreshed.push(...ids),
      notifyViewStale: (reason) => state.stale.push(reason),
    },
    wallpaper: {
      apply: async () => { state.applies++; if (state.onApply) await state.onApply(); },
      storeSlideshowPosition: (monitorId, theme, position) => state.positions.push({ monitorId, theme, position }),
      gc: () => { state.gcs++; },
    },
    save: () => { state.saves++; },
    broadcast: () => { state.broadcasts++; },
    refreshTray: () => { state.trays++; },
    ownCopies: {
      isOwnCopy: (p) => !!state.ownDir && path.dirname(p) === state.ownDir,
      rootReady: () => state.rootReady,
      trashDir: () => state.trashDir,
    },
    physicalDeleteEnabled: () => state.physicalDelete,
    askDeleteForever: async (targets) => { state.asked.push(targets); return state.answer; },
    trashItem: async (p) => { if (state.onTrash) await state.onTrash(p); state.trashed.push(p); },
    fs,
    now: () => 1000 + (n++),
    randomHex: () => 'abcd1234',
    log: { log: () => {}, error: (...args) => state.errors.push(args) },
    ...overrides,
  });
  return { removal, pool, state, marks };
}

const rec = (p, type = 'image', extra = {}) => ({
  id: library.idFor(p), type, path: p, addedAt: 1, favorite: false, tags: [], ...extra,
});

(async () => {
  await test('rename batch keeps pair order, one removed snapshot and marks-save-tray order without relocking', async (tmp) => {
    const events = [];
    const { removal, state, marks, pool } = setup({ save: () => events.push('save'), refreshTray: () => events.push('tray') });
    const hiddenFrom = path.join(tmp, 'removed.png'), hiddenTo = path.join(tmp, 'removed-new.png');
    let trash = [{ item: rec(hiddenFrom), removedAt: 1 }];
    Object.defineProperty(state.config, 'libraryTrash', { get: () => trash, set: value => { trash = value; events.push('removed'); } });
    const snapshot = new Set([pathKey(hiddenTo)]);
    marks.hiddenPaths = () => { events.push('snapshot'); return snapshot; };
    marks.persistNow = () => events.push('marks');
    let activeCalls = 0;
    pool.followActiveMove = (from, to, removedPaths) => {
      assert.strictEqual(removedPaths, snapshot);
      assert.ok(removedPaths.has(pathKey(hiddenTo)));
      events.push('active:' + path.basename(from));
      return ++activeCalls === 1;
    };
    pool.withLock = () => { throw new Error('rename must not reacquire the lock'); };
    const count = removal.followMovedFiles([
      null, { from: 42, to: 'invalid' },
      { from: 'first.png', to: 'first-new.png' },
      { from: hiddenFrom, to: hiddenTo, hidden: true },
      { from: 'last.png', to: 'last-new.png' },
    ]);
    assert.strictEqual(count, 2);
    assert.deepStrictEqual(events, ['snapshot', 'active:first.png', 'removed', 'active:last.png', 'marks', 'save', 'tray']);
    assert.strictEqual(trash[0].item.path, hiddenTo);
    events.length = 0;
    assert.strictEqual(removal.followMovedFiles([{ from: 'none.png', to: 'none-new.png' }]), 0);
    assert.deepStrictEqual(events, ['snapshot', 'active:none.png']);
    events.length = 0;
    assert.strictEqual(removal.followMovedFiles(null), 0);
    assert.deepStrictEqual(events, ['snapshot']);
  });

  await test('rename is a synchronous command; pending Undo is never exposed', async (tmp) => {
    const { removal, state, marks } = setup();
    assert.strictEqual('lastRemoval' in removal, false);
    const from = writeImage(path.join(tmp, 'before.png'));
    const to = path.join(tmp, 'after.png');
    const item = rec(from, 'image', { tags: ['kept'] });
    state.config.library[item.id] = item;
    state.config.monitors.M1 = { light: { itemIds: [item.id] }, dark: { itemIds: [] } };
    const removed = await removal.removeMany([{ id: item.id, path: from }]);
    // Whole-object replacement is supported; the command must read the current config.
    state.config = JSON.parse(JSON.stringify(state.config));
    fs.renameSync(from, to);
    marks.setHidden([from], false);
    marks.setHidden([to], true);
    assert.strictEqual(removal.followRemovedMove(from, to), true);
    assert.strictEqual(removal.undoPending(), true);
    assert.strictEqual((await removal.undo(removed.undo.token)).restored, 1);
    assert.deepStrictEqual(state.config.library[library.idFor(to)].tags, ['kept']);
    assert.deepStrictEqual(state.config.monitors.M1.light.itemIds, [library.idFor(to)]);
    assert.ok(!state.config.library[item.id]);
    assert.strictEqual(removal.undoPending(), false);
  });

  await test('removal keeps a snapshot for Undo, and Undo puts records back in their places', async (tmp) => {
    const { removal, state } = setup();
    const a = writeImage(path.join(tmp, 'a.png'));
    const b = writeImage(path.join(tmp, 'b.png'));
    const c = writeImage(path.join(tmp, 'c.png'));
    for (const p of [a, b, c]) state.config.library[library.idFor(p)] = rec(p, 'image', { favorite: p === b, tags: ['x'] });
    const [ia, ib, ic] = [a, b, c].map((p) => library.idFor(p));
    state.config.monitors = { M1: { light: { itemIds: [ia, ib, ic] }, dark: { itemIds: [ib] } } };

    const res = await removal.removeMany([{ id: ib, path: b }]);
    assert.strictEqual(res.error, null);
    assert.strictEqual(res.affected, 1);
    assert.strictEqual(res.removed, 1);
    assert.ok(res.undo && res.undo.token, 'the toast gets a token');
    assert.ok(!state.config.library[ib], 'record left the pool');
    assert.deepStrictEqual(state.config.monitors.M1.light.itemIds, [ia, ic]);
    assert.deepStrictEqual(state.config.monitors.M1.dark.itemIds, []);
    assert.strictEqual(state.config.monitors.M1.dark.legacyFallbackDisabled, true, 'emptied slot is marked deliberately empty');
    const entry = state.config.libraryTrash.find((e) => e.item.id === ib);
    assert.ok(entry && entry.item.favorite === true, 'the trash keeps the whole record');
    assert.deepStrictEqual(entry.slots.map((s) => `${s.monitorId}/${s.theme}@${s.index}:${s.emptied}`).sort(),
      ['M1/dark@0:true', 'M1/light@1:false']);
    assert.strictEqual(removal.undoPending(), true);
    assert.deepStrictEqual([state.saves, state.gcs, state.trays, state.applies], [1, 1, 1, 1]);

    // Something the user assigned after the removal must survive the Undo.
    state.config.monitors.M1.light.itemIds.push('later');
    const undone = await removal.undo(res.undo.token);
    assert.strictEqual(undone.error, null);
    assert.strictEqual(undone.restored, 1);
    assert.ok(state.config.library[ib] && state.config.library[ib].favorite === true);
    assert.deepStrictEqual(state.config.monitors.M1.light.itemIds, [ia, ib, ic, 'later']);
    assert.deepStrictEqual(state.config.monitors.M1.dark.itemIds, [ib]);
    assert.ok(!state.config.monitors.M1.dark.legacyFallbackDisabled, 'the marker set by the removal is lifted');
    assert.ok(!state.config.libraryTrash.some((e) => e.item.id === ib), 'the trash row is gone');
    assert.strictEqual(removal.undoPending(), false);
  });

  await test('Undo immediately requests a scan of the restored watched folder', async (tmp) => {
    const { removal, state, marks } = setup();
    const folder = path.join(tmp, 'watched');
    const photo = writeImage(path.join(folder, 'photo.png'));
    const folderId = library.idFor(folder);
    const photoId = library.idFor(photo);
    state.config.library[folderId] = rec(folder, 'folder');
    state.config.library[photoId] = rec(photo);

    const removed = await removal.removeMany([{ id: folderId, path: folder, type: 'folder' }]);
    assert.strictEqual(removed.error, null);
    assert.ok(!state.config.library[folderId]);
    assert.ok(!state.config.library[photoId]);
    assert.strictEqual(marks.dirs.size, 1);
    assert.deepStrictEqual(state.refreshed, [], 'removal must not scan the hidden folder');

    const undone = await removal.undo(removed.undo.token);
    assert.strictEqual(undone.error, null);
    assert.ok(state.config.library[folderId], 'the folder record is back');
    assert.ok(state.config.library[photoId], 'its photo record is back');
    assert.strictEqual(marks.dirs.size, 0, 'the folder is visible again');
    assert.deepStrictEqual(state.refreshed, [folderId], 'Undo requests a scan without waiting for a watcher event');
  });

  await test('Undo with somebody else\'s token refuses and keeps the pending removal', async (tmp) => {
    const { removal, state } = setup();
    const a = writeImage(path.join(tmp, 'a.png'));
    state.config.library[library.idFor(a)] = rec(a);
    const res = await removal.removeMany([{ id: library.idFor(a), path: a }]);
    const stale = await removal.undo('not-this-one');
    assert.strictEqual(stale.error, 'stale_undo');
    assert.strictEqual(stale.restored, 0);
    assert.ok(!state.config.library[library.idFor(a)], 'nothing came back');
    assert.strictEqual(removal.undoPending(), true);
    assert.strictEqual((await removal.undo(res.undo.token)).restored, 1);
    assert.strictEqual((await removal.undo(res.undo.token)).error, 'nothing_to_undo');
  });

  await test('a photo carried along remembers the NEAREST removed folder, and only that folder brings it back', async (tmp) => {
    const { removal, state, marks } = setup();
    const outer = path.join(tmp, 'outer');
    const inner = path.join(outer, 'inner');
    const deep = writeImage(path.join(inner, 'deep.png'));
    const shallow = writeImage(path.join(outer, 'shallow.png'));
    for (const r of [rec(outer, 'folder'), rec(inner, 'folder'), rec(deep), rec(shallow)]) state.config.library[r.id] = r;

    const res = await removal.removeMany([
      { id: library.idFor(outer), path: outer, type: 'folder' },
      { id: library.idFor(inner), path: inner, type: 'folder' },
    ]);
    assert.strictEqual(res.removed, 4, 'both folders and both photos inside left the pool');
    const via = (p) => state.config.libraryTrash.find((e) => pathKey(e.item.path) === pathKey(p)).via;
    assert.strictEqual(via(deep), pathKey(inner), 'via is the nearest removed folder, not the outer one');
    assert.strictEqual(via(shallow), pathKey(outer));
    assert.ok(!via(inner), 'a folder the user named has no via');
    assert.deepStrictEqual(state.forgotten.sort(), [library.idFor(outer), library.idFor(inner)].sort());
    assert.strictEqual(marks.dirs.size, 2);

    // Restoring the inner folder brings back the inner folder and the photo that went with
    // it — not the outer folder's photo.
    const back = await removal.restore([inner]);
    assert.strictEqual(back.restored, 1);
    assert.ok(state.config.library[library.idFor(deep)], 'the photo that went with the inner folder is back');
    assert.ok(!state.config.library[library.idFor(shallow)], 'the outer folder\'s photo stayed removed');
    assert.ok(!state.config.library[library.idFor(outer)]);
    assert.deepStrictEqual(state.refreshed, [library.idFor(inner)], 'the restored folder is scanned');
  });

  await test('restoring a parent folder does not undo a subfolder removed separately earlier', async (tmp) => {
    const { removal, state } = setup();
    const parent = path.join(tmp, 'parent');
    const sub = path.join(parent, 'sub');
    const inSub = writeImage(path.join(sub, 'x.png'));
    for (const r of [rec(parent, 'folder'), rec(sub, 'folder'), rec(inSub)]) state.config.library[r.id] = r;

    await removal.removeMany([{ id: library.idFor(sub), path: sub, type: 'folder' }]);
    await removal.removeMany([{ id: library.idFor(parent), path: parent, type: 'folder' }]);
    await removal.restore([parent]);
    assert.ok(state.config.library[library.idFor(parent)], 'the parent is back');
    assert.ok(!state.config.library[library.idFor(sub)], 'the separately removed subfolder stays removed');
    assert.ok(!state.config.library[library.idFor(inSub)], 'and so does its photo');
  });

  await test('a restore after a restart puts the record back on its monitor', async (tmp) => {
    const { removal, state } = setup();
    const a = writeImage(path.join(tmp, 'a.png'));
    const ia = library.idFor(a);
    state.config.library[ia] = rec(a);
    state.config.monitors = { M1: { light: { itemIds: [ia] }, dark: { itemIds: [] } } };
    await removal.removeMany([{ id: ia, path: a }]);
    assert.strictEqual(state.config.monitors.M1.light.legacyFallbackDisabled, true);

    // A restart forgets the pending Undo; the trash keeps the places.
    const fresh = setup();
    fresh.state.config = state.config;
    const res = await fresh.removal.restore([a]);
    assert.strictEqual(res.restored, 1);
    assert.deepStrictEqual(state.config.monitors.M1.light.itemIds, [ia]);
    assert.ok(!state.config.monitors.M1.light.legacyFallbackDisabled);
    assert.strictEqual(fresh.state.saves, 1);
  });

  await test('a record whose file is gone from a mounted disk is not restored; an unplugged disk does not count as gone', async (tmp) => {
    const { removal, state } = setup();
    const gone = path.join(tmp, 'gone.png');
    const offline = 'Q:\\nowhere\\disk.png';
    state.config.libraryTrash = [
      { item: rec(gone), rev: 2, removedAt: 1, via: '' },
      { item: rec(offline), rev: 2, removedAt: 1, via: '' },
    ];
    if (fs.existsSync('Q:\\')) return;  // this machine happens to have the drive: nothing to prove here
    const res = await removal.restore([gone, offline]);
    assert.strictEqual(res.restored, 1);
    assert.ok(!state.config.library[library.idFor(gone)], 'a record pointing at a deleted file came back');
    assert.ok(state.config.library[library.idFor(offline)], 'a record on an unplugged disk stayed stuck in the trash');
    assert.strictEqual(state.broadcasts, 0, 'something was restored, so it is saved, not only broadcast');
  });

  await test('entries pushed out of the bounded trash are counted in the answer', async (tmp) => {
    const { removal, state } = setup({
      libraryStore: { pushEntry: (trash, entry) => ({ trash: [entry], evicted: trash.slice() }) },
    });
    const a = writeImage(path.join(tmp, 'a.png'));
    const b = writeImage(path.join(tmp, 'b.png'));
    state.config.library[library.idFor(a)] = rec(a);
    state.config.library[library.idFor(b)] = rec(b);
    state.config.libraryTrash = [{ item: rec(path.join(tmp, 'old.png')), rev: 1, removedAt: 0 }];
    const res = await removal.removeMany([{ id: library.idFor(a), path: a }, { id: library.idFor(b), path: b }]);
    assert.strictEqual(res.evicted, 2);
  });

  await test('the "Removed" list shows one card per photo and folder, and nothing under a removed folder twice', async (tmp) => {
    const { removal, state, marks } = setup();
    const dir = path.join(tmp, 'gone-dir');
    const loose = path.join(tmp, 'loose.png');
    marks.setHidden([loose], true);
    marks.setHiddenDir([dir], true);
    state.config.libraryTrash = [
      { item: rec(loose), removedAt: 3 },                                  // same photo as the mark
      { item: rec(path.join(dir, 'inside.png')), removedAt: 3 },           // represented by the folder card
      { item: rec(path.join(tmp, 'own.png'), 'image', { aspect: 1.5 }), removedAt: 4 },
      { item: rec(path.join(tmp, 'kept-folder'), 'folder'), removedAt: 5 },
    ];
    const { images } = removal.hiddenList();
    assert.deepStrictEqual(images.map((im) => `${path.basename(im.path)}:${im.type || 'image'}`), [
      'loose.png:image', 'gone-dir:folder', 'own.png:image', 'kept-folder:folder',
    ]);
    assert.strictEqual(images[2].aspect, 1.5);
  });

  await test('another window\'s removal tells the main window; the main window\'s own does not', async (tmp) => {
    const { removal, state } = setup();
    const a = path.join(tmp, 'a.png');
    const b = path.join(tmp, 'b.png');
    await removal.removeMany([{ id: '', path: a }], { senderIsMain: () => true });
    assert.deepStrictEqual(state.stale, []);
    await removal.removeMany([{ id: '', path: b }], { senderIsMain: () => false });
    assert.deepStrictEqual(state.stale, ['remove']);
  });

  await test('Undo writes the folder index once per kind of mark it lifted', async (tmp) => {
    const { removal, marks } = setup();
    const dir = path.join(tmp, 'sub');
    const photo = path.join(tmp, 'p.png');
    const res = await removal.removeMany([{ id: '', path: photo }, { id: '', path: dir, type: 'folder' }]);
    assert.strictEqual(marks.calls.persist, 2, 'removal writes the index for each kind');
    await removal.undo(res.undo.token);
    assert.strictEqual(marks.calls.persist, 4);
    assert.strictEqual(marks.files.size + marks.dirs.size, 0);
  });

  await test('deleting into the Recycle Bin is refused while switched off, before anything is asked', async (tmp) => {
    const { removal, state } = setup();
    const a = writeImage(path.join(tmp, 'a.png'));
    state.config.libraryTrash = [{ item: rec(a), removedAt: 1 }];
    const res = await removal.deleteForever([a]);
    assert.strictEqual(res.error, 'disabled');
    assert.deepStrictEqual([state.asked.length, state.trashed.length], [0, 0]);
    assert.ok(fs.existsSync(a));
  });

  await test('each file is re-checked inside the lock right before it goes to the Recycle Bin', async (tmp) => {
    const { removal, state, pool } = setup();
    state.physicalDelete = true;
    const a = writeImage(path.join(tmp, 'a.png'));
    const b = writeImage(path.join(tmp, 'b.png'));
    const c = writeImage(path.join(tmp, 'c.png'));
    state.config.libraryTrash = [a, b, c].map((p) => ({ item: rec(p), removedAt: 1 }));
    // b becomes active while a is being deleted — the state between two deletions.
    state.onTrash = async (p) => {
      if (pathKey(p) === pathKey(a)) state.config.library[library.idFor(b)] = rec(b);
    };
    const res = await removal.deleteForever([a, b, c, path.join(tmp, 'never-removed.png')]);
    assert.deepStrictEqual(state.asked.map((t) => t.map((p) => path.basename(p))), [['a.png', 'b.png', 'c.png']],
      'only already-removed files are offered');
    assert.deepStrictEqual(state.trashed.map((p) => path.basename(p)), ['a.png', 'c.png']);
    assert.deepStrictEqual([res.deleted, res.skipped, res.failed], [2, 1, 0]);
    assert.deepStrictEqual(state.config.libraryTrash.map((e) => path.basename(e.item.path)), ['b.png'],
      'only what actually left is forgotten');
    assert.strictEqual(state.saves, 1);
    assert.ok(pool.inUsePaths().has(pathKey(b)));
  });

  await test('a cancelled dialog or an unreachable folder deletes nothing', async (tmp) => {
    const { removal, state } = setup();
    state.physicalDelete = true;
    const a = writeImage(path.join(tmp, 'a.png'));
    state.config.libraryTrash = [{ item: rec(a), removedAt: 1 }];
    state.answer = false;
    assert.strictEqual((await removal.deleteForever([a])).cancelled, true);
    state.rootReady = false;
    assert.strictEqual((await removal.deleteForever([a])).error, 'media_root_unavailable');
    assert.deepStrictEqual(state.trashed, []);
  });

  await test('the answer after an await carries the config object current at that moment', async (tmp) => {
    const { removal, state } = setup();
    const a = writeImage(path.join(tmp, 'a.png'));
    state.config.library[library.idFor(a)] = rec(a);
    // set-config replaces the whole object while the handler waits for the wallpaper.
    const swapTo = () => { state.config = { ...state.config, swapped: true }; };
    state.onApply = swapTo;
    const removed = await removal.removeMany([{ id: library.idFor(a), path: a }]);
    assert.strictEqual(removed.config.swapped, true, 'removal answered with the replaced object');
    const undone = await removal.undo(removed.undo.token);
    assert.strictEqual(undone.config, state.config, 'undo answered with the replaced object');
    state.onApply = null;
    await removal.removeMany([{ id: library.idFor(a), path: a }]);
    state.onApply = swapTo;
    const restored = await removal.restore([a]);
    assert.strictEqual(restored.config, state.config, 'restore answered with the replaced object');
  });

  await test('Znada\'s own copy swept into .trash comes back with its record; a copy that cannot keeps the entry', async (tmp) => {
    const { removal, state } = setup();
    state.ownDir = path.join(tmp, 'wallpapers');
    state.trashDir = path.join(state.ownDir, '.trash');
    const own = path.join(state.ownDir, 'abc-light.png');
    writeImage(path.join(state.trashDir, 'abc-light.png'));
    const lost = path.join(state.ownDir, 'lost-light.png');
    state.config.library[library.idFor(own)] = rec(own);
    state.config.library[library.idFor(lost)] = rec(lost);
    const res = await removal.removeMany([{ id: library.idFor(own), path: own }, { id: library.idFor(lost), path: lost }]);
    const undone = await removal.undo(res.undo.token);
    assert.strictEqual(undone.failed, 1);
    assert.ok(fs.existsSync(own), 'the copy was brought back from .trash');
    assert.ok(state.config.library[library.idFor(own)]);
    assert.ok(!state.config.library[library.idFor(lost)], 'a record pointing at nothing came back');
    assert.ok(state.config.libraryTrash.some((e) => e.item.id === library.idFor(lost)), 'the only way back was dropped');
    assert.strictEqual(removal.undoPending(), true, 'what failed can be retried');
  });

  // 1.9.0 gate, stage 03 finding A: Undo checked a lost target only for photos, so a
  // watched folder whose directory was deleted came back as an empty record and the toast
  // said "restored: 1". Restore from "Removed" always refused; now both agree.
  await test('Undo keeps a watched folder whose directory is gone in the trash, like Restore', async (tmp) => {
    const { removal, state, marks } = setup();
    const folder = path.join(tmp, 'watched');
    const photo = writeImage(path.join(folder, 'photo.png'));
    const folderId = library.idFor(folder);
    state.config.library[folderId] = rec(folder, 'folder');
    state.config.monitors.M1 = { light: { itemIds: [folderId] }, dark: { itemIds: [] } };

    const removed = await removal.removeMany([{ id: folderId, path: folder, type: 'folder' }]);
    assert.strictEqual(removed.error, null);
    fs.rmSync(folder, { recursive: true, force: true });

    const failed = await removal.undo(removed.undo.token);
    assert.strictEqual(failed.restored, 0, `Undo claimed ${failed.restored} restored for a deleted folder`);
    assert.strictEqual(failed.failed, 1);
    assert.ok(!state.config.library[folderId], 'an empty folder record came back into the pool');
    assert.deepStrictEqual(state.config.monitors.M1.light.itemIds, [], 'the lost folder came back onto the monitor');
    assert.ok(state.config.libraryTrash.some((e) => e.item.id === folderId), 'the only way back was dropped');
    assert.strictEqual(marks.dirs.size, 1, "the lost folder's removed-mark was lifted");
    assert.deepStrictEqual(state.refreshed, [], 'a folder that did not come back was scanned');
    assert.strictEqual(removal.undoPending(), true, 'what failed can be retried');

    // The same folder seen through Restore: it refuses too.
    await removal.restore([folder]);
    assert.ok(!state.config.library[folderId], 'Restore brought the deleted folder back');

    // The directory comes back: the retry now succeeds.
    writeImage(photo);
    marks.setHiddenDir([folder], true);
    const retried = await removal.undo(removed.undo.token);
    assert.strictEqual(retried.failed, 0);
    assert.ok(state.config.library[folderId], 'the folder did not come back once its directory returned');
    assert.deepStrictEqual(state.config.monitors.M1.light.itemIds, [folderId]);
    assert.strictEqual(marks.dirs.size, 0, "the retry did not lift the folder's mark");
    assert.deepStrictEqual(state.refreshed, [folderId]);
  });

  await test('Undo still brings back a folder on an unplugged disk (cannot be proven gone)', async () => {
    if (fs.existsSync('Q:\\')) return;  // this machine happens to have the drive: nothing to prove here
    const { removal, state } = setup();
    const folder = 'Q:\\nowhere\\folder';
    const folderId = library.idFor(folder);
    state.config.library[folderId] = rec(folder, 'folder');
    const removed = await removal.removeMany([{ id: folderId, path: folder, type: 'folder' }]);
    const undone = await removal.undo(removed.undo.token);
    assert.strictEqual(undone.failed, 0);
    assert.ok(state.config.library[folderId], 'a folder on an unplugged disk stayed stuck in the trash');
  });

  // 1.9.0 gate, stage 02 finding F11: the partial-Undo bookkeeping from BUG-078 had no test
  // that fails when it is broken — which marks are lifted, what stays to retry, and whether
  // a slot emptied by the removal keeps its "deliberately empty" marker.
  await test('a partial Undo lifts only the marks of what came back and keeps the rest for the retry', async (tmp) => {
    const { removal, state, marks } = setup();
    const kept = writeImage(path.join(tmp, 'kept.png'));
    const lost = writeImage(path.join(tmp, 'lost.png'));
    const [ik, il] = [kept, lost].map((p) => library.idFor(p));
    state.config.library[ik] = rec(kept);
    state.config.library[il] = rec(lost);
    // The lost photo is the only one on M1/dark, so the removal empties that slot.
    state.config.monitors.M1 = { light: { itemIds: [ik, il] }, dark: { itemIds: [il] } };

    const removed = await removal.removeMany([{ id: ik, path: kept }, { id: il, path: lost }]);
    assert.strictEqual(marks.files.size, 2, 'both photos are marked removed');
    assert.strictEqual(state.config.monitors.M1.dark.legacyFallbackDisabled, true);
    fs.rmSync(lost);

    const partial = await removal.undo(removed.undo.token);
    assert.strictEqual(partial.restored, 1);
    assert.strictEqual(partial.failed, 1);
    assert.ok(!marks.files.has(pathKey(kept)), 'the restored photo is still marked removed');
    assert.ok(marks.files.has(pathKey(lost)), 'the photo that did not come back lost its removed-mark');
    assert.deepStrictEqual(state.config.monitors.M1.dark.itemIds, []);
    assert.strictEqual(state.config.monitors.M1.dark.legacyFallbackDisabled, true,
      'a slot that got nothing back lost its "deliberately empty" marker');

    writeImage(lost);
    const retried = await removal.undo(removed.undo.token);
    assert.strictEqual(retried.restored, 1);
    assert.strictEqual(retried.failed, 0);
    assert.ok(!marks.files.has(pathKey(lost)), "the retry did not lift the returned photo's mark");
    assert.deepStrictEqual(state.config.monitors.M1.dark.itemIds, [il]);
    assert.ok(!state.config.monitors.M1.dark.legacyFallbackDisabled, 'the marker set by the removal stayed after the retry');
    assert.deepStrictEqual(state.config.monitors.M1.light.itemIds, [ik, il]);
  });

  console.log(`PASS library-removal: ${passed} checks`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
