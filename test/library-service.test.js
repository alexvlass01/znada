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

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const library = require('../src/library');
const playlist = require('../src/playlist');
const { pathKey } = require('../src/path-key');
const { createLibraryService } = require('../src/library-service');
const { makeTempDir } = require('./helpers/temp-dir');

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
  return { svc, state, marks };
}

function writeImage(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex'));
  return p;
}

(async () => {
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

  console.log(`PASS library-service: ${passed} checks`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
