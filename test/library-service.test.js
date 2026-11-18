'use strict';

// CODE-001 2.2a. Direct tests for src/library-service.js on fake dependencies:
// - the lock runs one change at a time and survives a failing one;
// - the single funnel into the pool clears the removed-marks and the trash row, moves the
//   record's revision past the tombstone and counts a revival even when the pool did not grow;
// - "in use" includes photos served from an assigned folder and excludes removed ones;
// - one record leaves the pool together with its slot references;
// - config is read at every call, never captured (R4 of the stage 2.2 spec).
// The same behaviour through the real main.js is proved by the harness suites
// (library-orchestration, library-invariants, pool-consistency, …).
//
// CODE-001 2.2b. Two of these rules had no harness suite behind them — breaking either left
// every one green, and only this file noticed (found during 2.2a). The last two scenarios
// below run them through the REAL main.js on a real folder on disk. They live here rather
// than in a file of their own because `npm test` is one Windows command line, and it is at
// its length limit.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const library = require('../src/library');
const playlist = require('../src/playlist');
const { pathKey } = require('../src/path-key');
const { createLibraryService } = require('../src/library-service');
const { makeTempDir } = require('./helpers/temp-dir');
const H = require('./helpers/main-harness');

let passed = 0;
async function test(name, fn) {
  const root = makeTempDir('znada-library-service-');
  try {
    await fn(root);
    passed += 1;
    console.log('  ok ' + name);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Through the real main.js. Its console noise (no monitors in tests, and so on) is kept
// out of the output unless the scenario fails.
async function harnessTest(name, fn) {
  const dir = H.makeTempProfile('core-gaps');
  const captured = [];
  const real = { log: console.log, error: console.error };
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  try {
    await fn(dir);
  } catch (err) {
    console.log = real.log; console.error = real.error;
    if (captured.length) console.log(captured.slice(-15).join('\n'));
    throw err;
  } finally {
    console.log = real.log; console.error = real.error;
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  passed += 1;
  console.log('  ok ' + name);
}

// A watched folder with two photos, assigned to a monitor as a folder. Neither photo has
// a record of its own: the slideshow finds them by reading the folder.
async function harnessSetup(dir) {
  const root = path.join(dir, 'photos');
  const sea = H.writeImage(path.join(root, 'sea.png'));
  const hill = H.writeImage(path.join(root, 'hill.png'));
  const rootId = library.idFor(root);
  H.writeJson(path.join(dir, 'config.json'), {
    autoSwitch: false, style: 'fill',
    monitors: { M1: { light: { itemIds: [rootId] }, dark: { itemIds: [] } } },
  });
  H.writeJson(path.join(dir, 'config.library.json'), {
    version: 1, trash: [], library: {
      [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] },
    },
  });
  const m = H.loadMain(dir);
  m.__test.loadConfig();
  await m.invoke('library-refresh');
  return { m, sea, hill };
}

function hiddenOnDisk(dir, relativePath) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'folder-state.json'), 'utf8'));
  const files = Object.values(index.folders).flatMap((f) => Object.values(f.files));
  const entry = files.find((f) => f.relativePath === relativePath);
  assert.ok(entry, `precondition: ${relativePath} is in the index on disk`);
  return entry.hidden === true;
}

const tick = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });

function emptyConfig() {
  return { library: {}, libraryTrash: [], monitors: {}, lightWallpaper: '', darkWallpaper: '' };
}

// The removed-marks port as main.js implements it, kept in memory: a set of photo keys and
// a set of folder keys. setHidden reports `changed` only when it actually flipped something.
function fakeMarks() {
  const files = new Set();
  const dirs = new Set();
  const calls = { persist: 0 };
  function flip(set, paths, hidden) {
    const matched = [];
    for (const p of paths) {
      const key = pathKey(p);
      if (hidden ? !set.has(key) : set.has(key)) {
        if (hidden) set.add(key); else set.delete(key);
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
    hiddenPaths: () => new Set(files),
  };
}

function makeService(overrides = {}) {
  const state = { config: emptyConfig(), positions: [], forgotten: [], synced: 0, errors: [] };
  const marks = overrides.marks || fakeMarks();
  const svc = createLibraryService({
    library,
    playlist,
    pathKey,
    getConfig: () => state.config,
    slotFor: (monitorId, theme) => {
      const m = state.config.monitors && state.config.monitors[monitorId];
      const slot = m && m[theme];
      return slot && Array.isArray(slot.itemIds) ? slot : { itemIds: [] };
    },
    marks,
    liveFolders: { forget: (id) => state.forgotten.push(id), sync: () => { state.synced++; } },
    storeSlideshowPosition: (monitorId, theme, position) => state.positions.push({ monitorId, theme, position }),
    log: { error: (...args) => state.errors.push(args) },
    ...overrides,
  });
  assert.strictEqual(Object.hasOwn(svc, 'ensureSlot'), false, 'mutable slot repair stays private');
  return { svc, state, marks };
}

function writeImage(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex'));
  return p;
}

(async () => {
  await test('assignment commands own the funnel and report pool changes synchronously on the current config', async (tmp) => {
    const { svc, state, marks } = makeService();
    const a = path.join(tmp, 'a.png'), b = path.join(tmp, 'b.png');
    const aId = library.idFor(a), bId = library.idFor(b);
    let bypasses = 0;
    const options = { allowCreate: true, addToPool: () => { bypasses++; return ''; } };
    const first = svc.assignRecord({ path: a }, 'M1', 'anything', options);
    assert.strictEqual(typeof first.then, 'undefined', 'command must not take the lock again or await');
    assert.strictEqual(first.result.ok, true);
    assert.strictEqual(first.poolTouched, true);
    assert.deepStrictEqual(state.config.monitors.M1.light.itemIds, [aId]);
    assert.strictEqual(svc.assignRecord({ id: aId }, 'M1', 'dark').poolTouched, false);

    const previous = state.config;
    state.config = emptyConfig();
    const batch = svc.assignRecords([{ record: { path: b }, options }], 'M2', 'dark');
    assert.strictEqual(typeof batch.then, 'undefined');
    assert.strictEqual(batch.result.ok, true);
    assert.strictEqual(batch.poolTouched, true);
    assert.ok(state.config.library[bId]);
    assert.strictEqual(previous.library[bId], undefined, 'command captured a stale config');
    assert.deepStrictEqual(state.config.monitors.M2.dark.itemIds, [bId]);
    assert.strictEqual(svc.assignRecords([{ record: { id: bId } }], 'M2', 'dark').poolTouched, false);

    marks.files.add(pathKey(b));
    state.config.libraryTrash.push({ item: { ...state.config.library[bId] }, rev: 200, removedAt: 1 });
    const revived = svc.assignRecords([{ record: { id: bId } }], 'M2', 'dark');
    assert.strictEqual(revived.poolTouched, true, 'existing record repair still touches pool storage');
    assert.ok(state.config.library[bId].rev > 200);
    assert.ok(!marks.files.has(pathKey(b)));
    assert.deepStrictEqual(state.config.libraryTrash, []);
    assert.strictEqual(bypasses, 0, 'caller replaced the pool owner funnel');
    assert.strictEqual(options.addToPool(), '', 'command mutated caller options');
    assert.strictEqual(bypasses, 1);
  });

  await test('the lock runs changes one at a time, in order, and a failure does not break it', async () => {
    const { svc } = makeService();
    const order = [];
    const first = svc.withLock(async () => { order.push('first:start'); await tick(20); order.push('first:end'); return 1; });
    const second = svc.withLock(async () => { order.push('second:start'); throw new Error('boom'); });
    const third = svc.withLock(() => { order.push('third'); return 3; });
    assert.strictEqual(await first, 1);
    await assert.rejects(second, /boom/);
    assert.strictEqual(await third, 3);
    assert.deepStrictEqual(order, ['first:start', 'first:end', 'second:start', 'third']);
  });

  await test('settled() waits for everything queued so far and never rejects', async () => {
    const { svc } = makeService();
    let done = false;
    svc.withLock(async () => { await tick(15); done = true; });
    svc.withLock(async () => { throw new Error('ignored'); }).catch(() => {});
    await svc.settled();
    assert.strictEqual(done, true);
  });

  await test('adding a removed photo back clears its marks and trash row and counts as a revival', async (tmp) => {
    const { svc, state, marks } = makeService();
    const photo = path.join(tmp, 'a.jpg');
    const oldId = library.addPath(state.config.library, 'image', photo);
    const removed = library.getItem(state.config.library, oldId);
    removed.rev = 7;
    delete state.config.library[oldId];
    state.config.libraryTrash.push({ item: { ...removed }, rev: 9, removedAt: 1 });
    marks.files.add(pathKey(photo));

    const before = svc.revivals();
    const id = svc.addToPool('image', photo);
    assert.strictEqual(id, oldId);
    assert.ok(!marks.files.has(pathKey(photo)), 'removed-mark cleared');
    assert.strictEqual(marks.calls.persist, 1, 'marks written at once');
    assert.deepStrictEqual(state.config.libraryTrash, [], 'trash row dropped');
    assert.ok(library.revOf(state.config.library[id]) > 9, 'revision moved past the tombstone');
    assert.strictEqual(svc.revivals(), before + 1);
  });

  await test('re-adding a photo already in the pool but still marked removed is a revival', async (tmp) => {
    const { svc, state, marks } = makeService();
    const photo = path.join(tmp, 'b.jpg');
    svc.addToPool('image', photo);
    assert.strictEqual(svc.revivals(), 0, 'a fresh photo is not a revival');
    assert.strictEqual(marks.calls.persist, 0, 'nothing to clear, nothing written');
    marks.files.add(pathKey(photo));
    const size = Object.keys(state.config.library).length;
    svc.addToPool('image', photo);
    assert.strictEqual(Object.keys(state.config.library).length, size, 'the pool did not grow');
    assert.strictEqual(svc.revivals(), 1, 'yet the repair must be saved');
  });

  // BUG-067: the import save decision reads this counter, never the pool size.
  await test('poolChanges counts created records and repairs, not size or clean re-adds', async (tmp) => {
    const { svc, state, marks } = makeService();
    const a = path.join(tmp, 'a.jpg');
    const b = path.join(tmp, 'b.jpg');
    svc.addToPool('image', a);
    assert.strictEqual(svc.poolChanges(), 1, 'a created record is a change');
    svc.addToPool('image', a);
    assert.strictEqual(svc.poolChanges(), 1, 'a clean re-add is not');
    delete state.config.library[library.idFor(a)]; // pruning elsewhere shrinks the pool
    svc.addToPool('image', b);
    assert.strictEqual(Object.keys(state.config.library).length, 1, 'net growth is zero');
    assert.strictEqual(svc.poolChanges(), 2, 'yet b was created and must be saved');
    marks.files.add(pathKey(b));
    svc.addToPool('image', b);
    assert.strictEqual(svc.poolChanges(), 3, 'a revival is a change too');
    assert.strictEqual(svc.addToPool('image', ''), null);
    assert.strictEqual(svc.poolChanges(), 3, 'a refused path changes nothing');
  });

  await test('a removed folder mark is cleared through the folder port', async (tmp) => {
    const { svc, marks } = makeService();
    const dir = path.join(tmp, 'sub');
    marks.dirs.add(pathKey(dir));
    assert.strictEqual(svc.clearRemovedState(dir), true);
    assert.ok(!marks.dirs.has(pathKey(dir)));
    assert.strictEqual(svc.clearRemovedState([]), false);
    assert.strictEqual(svc.clearRemovedState([null, '']), false);
  });

  await test('markRecordRevived matches a trash row by id or by canonical path', async (tmp) => {
    const { svc, state } = makeService();
    const photo = path.join(tmp, 'c.jpg');
    state.config.libraryTrash.push({ item: { id: 'other', path: photo.replace(/\\/g, '/') }, rev: 4 });
    const item = { id: 'x', path: photo, rev: 1 };
    assert.strictEqual(svc.markRecordRevived(item), true);
    assert.strictEqual(item.rev, 5);
    assert.strictEqual(svc.markRecordRevived({ id: 'y', path: path.join(tmp, 'none.jpg') }), false);
    assert.strictEqual(svc.markRecordRevived(null), false);
  });

  await test('"in use" includes photos served from an assigned folder and excludes removed ones', async (tmp) => {
    const { svc, state, marks } = makeService();
    const folder = path.join(tmp, 'watched');
    const shown = writeImage(folder, 'shown.jpg');
    const removed = writeImage(folder, 'removed.jpg');
    const single = path.join(tmp, 'single.jpg');
    const legacy = path.join(tmp, 'legacy.jpg');
    const folderId = svc.addToPool('folder', folder);
    svc.addToPool('image', single);
    state.config.lightWallpaper = legacy;
    state.config.monitors = { m1: { light: { itemIds: [folderId] }, dark: { itemIds: [] } } };
    marks.files.add(pathKey(removed));

    const inUse = svc.inUsePaths();
    assert.ok(inUse.has(pathKey(shown)), 'photo inside the assigned folder is in use');
    assert.ok(!inUse.has(pathKey(removed)), 'a removed photo is not in use');
    assert.ok(inUse.has(pathKey(single)), 'pool photo');
    assert.ok(inUse.has(pathKey(legacy)), 'legacy fallback');
  });

  await test('a slot that cannot be expanded is logged and pool photos stay in use', async (tmp) => {
    const failing = { resolveSlot: () => { throw new Error('disk gone'); } };
    const { svc, state } = makeService({ playlist: failing });
    const single = path.join(tmp, 'kept.jpg');
    svc.addToPool('image', single);
    state.config.monitors = { m1: { light: { itemIds: [] } } };
    const inUse = svc.inUsePaths();
    assert.ok(inUse.has(pathKey(single)));
    assert.strictEqual(state.errors.length, 2, 'both themes reported');
  });

  await test('removing a record drops it from every slot and forgets a watched folder', async (tmp) => {
    const { svc, state } = makeService();
    const folderId = svc.addToPool('folder', path.join(tmp, 'f'));
    const photoId = svc.addToPool('image', path.join(tmp, 'p.jpg'));
    state.config.monitors = {
      m1: { light: { itemIds: [folderId] }, dark: { itemIds: [folderId, photoId] } },
    };
    assert.strictEqual(svc.removeRecord(folderId), true);
    assert.ok(!state.config.library[folderId]);
    assert.deepStrictEqual(state.config.monitors.m1.light.itemIds, []);
    assert.deepStrictEqual(state.config.monitors.m1.dark.itemIds, [photoId]);
    assert.deepStrictEqual(state.positions, [{ monitorId: 'm1', theme: 'light', position: { index: 0, path: '' } }]);
    assert.deepStrictEqual(state.forgotten, [folderId]);
    assert.strictEqual(state.synced, 1);
    assert.strictEqual(svc.removeRecord(folderId), false, 'a second removal is a no-op');
    assert.strictEqual(svc.removeRecord(photoId), true);
    assert.strictEqual(state.synced, 1, 'a photo does not touch folder watchers');
  });

  await test('dropFromTrash removes only the row with that id', async () => {
    const { svc, state } = makeService();
    state.config.libraryTrash = [{ item: { id: 'a' } }, { item: { id: 'b' } }];
    assert.strictEqual(svc.dropFromTrash('a'), true);
    assert.deepStrictEqual(state.config.libraryTrash, [{ item: { id: 'b' } }]);
    assert.strictEqual(svc.dropFromTrash('a'), false);
    assert.strictEqual(svc.dropFromTrash(''), false);
  });

  await test('config is read at every call, so a replaced object is the one written', async (tmp) => {
    const { svc, state } = makeService();
    const first = state.config;
    // set-config replaces the whole object while a library change awaits under the lock.
    const id = await svc.withLock(async () => {
      await tick(5);
      return svc.addToPool('image', path.join(tmp, 'late.jpg'));
    });
    assert.ok(first.library[id]);
    state.config = emptyConfig();
    const pending = svc.withLock(async () => {
      await tick(5);
      return svc.addToPool('image', path.join(tmp, 'after-swap.jpg'));
    });
    const swapped = emptyConfig();
    state.config = swapped;
    const newId = await pending;
    assert.ok(swapped.library[newId], 'written into the current object');
    assert.ok(!first.library[newId], 'not into the one that was replaced');
    assert.ok(svc.inUsePaths().has(pathKey(path.join(tmp, 'after-swap.jpg'))));
  });

  // "Delete from disk" is checked against "in use", so a removed photo counted as in use
  // refuses a delete the user asked for.
  await harnessTest('main.js: a photo removed from an assigned folder is not "in use", so it can be deleted', async (dir) => {
    const { m, sea, hill } = await harnessSetup(dir);
    assert.ok(
      m.__test.resolvePlaylist('M1', 'light').some((p) => pathKey(p) === pathKey(sea)),
      'precondition: the photo plays through the assigned folder',
    );
    const removed = await m.invoke('library-remove-many', [{ id: '', path: sea, type: 'image' }]);
    assert.strictEqual(removed.affected, 1, `precondition: the photo was removed (${JSON.stringify(removed)})`);

    // The guard is exercised with the feature switched on, as every guard test does; the
    // default for users stays off.
    m.__test.setPhysicalDeleteEnabled(true);
    const res = await m.invoke('library-delete-forever', [sea]);
    assert.strictEqual(res.error, null, `the removed photo was treated as in use: ${JSON.stringify(res)}`);
    assert.strictEqual(res.deleted, 1, 'the removed photo was not deleted');
    assert.deepStrictEqual(m.calls.trashed.map(pathKey), [pathKey(sea)], 'the recycle bin got something else');
    // The other photo in the same folder is still playing and must stay untouchable.
    m.__test.getConfig().libraryTrash.push({
      item: { id: library.idFor(hill), type: 'image', path: hill, addedAt: 1, favorite: false, tags: [] },
      removedAt: 5,
    });
    const still = await m.invoke('library-delete-forever', [hill]);
    assert.strictEqual(still.deleted, 0, 'a photo the slideshow is playing was deleted');
    assert.ok(fs.existsSync(hill));
  });

  // The removed mark lives in the folder index. Left to the five-second debounce, a crash in
  // that window would hide the photo again on the next start although it is active.
  await harnessTest('main.js: bringing a removed photo back writes the folder index at once', async (dir) => {
    const { m, sea } = await harnessSetup(dir);
    await m.invoke('library-remove-many', [{ id: '', path: sea, type: 'image' }]);
    assert.ok(hiddenOnDisk(dir, 'sea.png'), 'precondition: the removed mark is on disk');

    // Making a record for the photo is a way back into the library (a star, a tag or an
    // assignment does this). It goes through the one funnel into the pool.
    const res = await m.invoke('library-materialize', sea, 'image');
    assert.ok(res.id, `precondition: the photo got a record (${JSON.stringify(res && res.id)})`);
    assert.ok(!m.__test.hiddenPathSet().has(pathKey(sea)), 'precondition: the mark is gone in memory');

    // No timer flush and no restart: what is on disk right now is what a crash would leave.
    assert.ok(!hiddenOnDisk(dir, 'sea.png'), 'the index on disk still says the active photo is removed');
  });

  console.log(`PASS library-service: ${passed} checks`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
