'use strict';

// The two rules the library has to keep, written as tests instead of as review comments:
//
//   1. A photo is either in the library or removed from it. Never both.
//   2. A file may only be deleted from disk when nothing is using it.
//
// Four rounds of review found that both rules were enforced by hand-written checks
// scattered across every place that can make a photo active — and every round found
// another place that had been missed. These tests come from the FOURTH review's own
// repros, written before the fixes, so the starting point is visible rather than
// described. They exercise the real main process through test/helpers/main-harness.js.
//
// Run: node test/library-invariants.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const folderState = require('../src/folder-state');
const library = require('../src/library');
const { pathKey, isUnderPath } = require('../src/path-key');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const dir = H.makeTempProfile('inv');
  const captured = [];
  const real = { log: console.log, error: console.error };
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  try {
    await fn(dir);
    console.log = real.log; console.error = real.error;
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log = real.log; console.error = real.error;
    failures.push({ name, err, captured });
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
  } finally {
    console.log = real.log; console.error = real.error;
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const cfgFile = (dir) => path.join(dir, 'config.json');
const storeFile = (dir) => path.join(dir, 'config.library.json');
const baseConfig = (extra = {}) => ({ autoSwitch: true, style: 'fill', monitors: {}, ...extra });

function indexFolder(root, files) {
  return folderState.reconcileFolder(folderState.emptyState(), {
    folderId: library.idFor(root),
    rootPath: root,
    status: 'complete',
    entries: files.map((p) => ({ path: p, modifiedAt: 1000 })),
  }).state;
}

// "Is anything broken right now": every id a slot points at must exist in the pool, and
// every active image record must point at a file that is on disk. Asserted after the
// scenarios below, because that is what the user actually experiences.
function assertConsistent(cfg, note) {
  for (const [monitorId, monitor] of Object.entries(cfg.monitors || {})) {
    for (const theme of ['light', 'dark']) {
      for (const id of ((monitor[theme] && monitor[theme].itemIds) || [])) {
        assert.ok(cfg.library[id], `${note}: slot ${monitorId}/${theme} points at a missing record ${id}`);
      }
    }
  }
  for (const item of Object.values(cfg.library || {})) {
    if (!item || item.type !== 'image' || !item.path) continue;
    assert.ok(fs.existsSync(item.path), `${note}: the library has a record for a file that is gone (${item.path})`);
  }
}

console.log('\nlibrary invariants (fourth review repros)\n');

(async () => {
  // ---- P1.1 — a damaged library file must never be replaced with an empty one ----
  await test('a damaged library file is not overwritten when nothing is assigned to a monitor', async (dir) => {
    // The pool is deliberately independent of placement: a photo can be in the library
    // and on no monitor at all. Deciding "is the library really empty" by looking at
    // monitors therefore answers the wrong question.
    H.writeJson(cfgFile(dir), baseConfig());
    fs.writeFileSync(storeFile(dir), '{ this is not json', 'utf8');

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    assert.ok(m.__test.isUnsafeToWrite(), 'a damaged library with no fallback must block writes');
    const onDisk = fs.readFileSync(storeFile(dir), 'utf8');
    assert.ok(!onDisk.includes('"library"'), 'the damaged file was replaced by an empty library');
  });

  // ---- Deleting files is switched off until its guard is proved ----
  await test('deleting from disk is off: the handler refuses and touches nothing', async (dir) => {
    const root = path.join(dir, 'photos');
    const photo = H.writeImage(path.join(root, 'a.png'));
    const rootId = library.idFor(root);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [photo]));
    await m.invoke('library-remove-many', [{ path: photo, id: '', type: 'image' }]);

    // Removed, so the old guard would have allowed this.
    const res = await m.invoke('library-delete-forever', [photo]);
    assert.strictEqual(res.error, 'disabled', `expected a refusal, got ${JSON.stringify(res)}`);
    assert.strictEqual(res.deleted, 0, 'nothing may be deleted while the feature is off');
    assert.ok(fs.existsSync(photo), 'the file was touched anyway');
    assert.strictEqual(m.calls.trashed.length, 0, 'the recycle bin was called while the feature is off');
    // ...and no dialog was shown, so it refuses before asking the user anything.
    assert.strictEqual(m.calls.dialogs.length, 0, 'a confirmation dialog was shown for a disabled action');

    const flags = await m.invoke('feature-flags');
    assert.strictEqual(flags.physicalDelete, false, 'the renderer must be told the same thing');
  });

  // ---- P1.3 — "in use" must mean what the slideshow actually plays ----
  await test('a photo served through an assigned folder cannot be deleted from disk', async (dir) => {
    const root = path.join(dir, 'photos');
    const served = H.writeImage(path.join(root, 'served.png'));
    const rootId = library.idFor(root);
    H.writeJson(cfgFile(dir), baseConfig({ monitors: { M1: { light: { itemIds: [rootId] }, dark: { itemIds: [] } } } }));
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    // The folder index does not know this file yet — a fresh drop into a watched folder
    // looks exactly like this. The playlist still serves it, because a folder is expanded
    // by reading the disk.
    // Deleting files is switched OFF for users until its guard is proved (see
    // physicalDeleteEnabled in main.js). The guard itself must still be exercised, or
    // these tests would pass by doing nothing and the day it is switched back on nobody
    // would know whether it still holds.
    m.__test.setPhysicalDeleteEnabled(true);
    m.__test.setLiveFolderState(indexFolder(root, []));
    assert.ok(
      m.__test.resolvePlaylist('M1', 'light').some((p) => pathKey(p) === pathKey(served)),
      'precondition: the photo is in the playlist',
    );

    // A stale trash entry naming it — the state an older build could leave behind.
    m.__test.getConfig().libraryTrash = [{
      item: { id: library.idFor(served), type: 'image', path: served, addedAt: 1, favorite: false, tags: [] },
      removedAt: 5,
    }];

    const res = await m.invoke('library-delete-forever', [served]);
    assert.ok(fs.existsSync(served), `a photo the slideshow is playing was deleted (deleted=${res.deleted})`);
  });

  // ---- P1.6 — removing a folder must take everything under it ----
  await test('removing a folder also removes the subfolders under it, not only photos', async (dir) => {
    const root = path.join(dir, 'photos');
    const child = path.join(root, 'child');
    const img = H.writeImage(path.join(child, 'a.png'));
    const rootId = library.idFor(root);
    const childId = library.idFor(child);
    H.writeJson(cfgFile(dir), baseConfig({ monitors: { M1: { light: { itemIds: [rootId, childId] }, dark: { itemIds: [] } } } }));
    H.writeJson(storeFile(dir), {
      version: 1,
      library: {
        [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] },
        [childId]: { id: childId, type: 'folder', path: child, addedAt: 2, favorite: false, tags: [] },
      },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [img]));

    await m.invoke('library-remove-many', [{ path: root, id: rootId, type: 'folder' }]);
    const cfg = m.__test.getConfig();
    assert.ok(!cfg.library[childId], 'the subfolder is still in the library');
    assert.ok(!cfg.monitors.M1.light.itemIds.includes(childId), 'the subfolder is still assigned to a monitor');
    assert.deepStrictEqual(m.__test.resolvePlaylist('M1', 'light'), [], 'its photos are still being played');
  });

  // ---- P1.2 — activation and deletion must not overlap ----
  await test('a photo added while a deletion is running never ends up pointing at a deleted file', async (dir) => {
    const root = path.join(dir, 'photos');
    const doomed = H.writeImage(path.join(root, 'doomed.png'));
    const rootId = library.idFor(root);
    H.writeJson(cfgFile(dir), baseConfig({ monitors: { M1: { light: { itemIds: [] }, dark: { itemIds: [] } } } }));
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    let handle = null;
    let concurrent = null;
    const m = H.loadMain(dir, {
      // A REAL activation handler, fired while the delete loop is between awaits. Not
      // awaited here: awaiting it inside the loop would simply wait for the deletion to
      // finish, which is not what a concurrent IPC does.
      onTrash: async (target) => {
        if (!target.endsWith('doomed.png')) return;
        concurrent = handle.invoke('add-slot-paths', 'M1', 'light', [doomed]).catch(() => null);
        await new Promise((r) => setImmediate(r));
      },
    });
    // Deleting files is switched OFF for users until its guard is proved (see
    // physicalDeleteEnabled in main.js). The guard itself must still be exercised, or
    // these tests would pass by doing nothing and the day it is switched back on nobody
    // would know whether it still holds.
    m.__test.setPhysicalDeleteEnabled(true);
    handle = m;
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [doomed]));
    await m.invoke('library-remove-many', [{ path: doomed, id: '', type: 'image' }]);

    await m.invoke('library-delete-forever', [doomed]);
    if (concurrent) await concurrent;
    assertConsistent(m.__test.getConfig(), 'after a concurrent add during deletion');
  });

  // ---- P1.5 — putting a folder back must not undo a separate decision ----
  await test('putting a folder back does not resurrect a photo the user removed on its own', async (dir) => {
    const root = path.join(dir, 'photos');
    const sub = path.join(root, 'sub');
    const loner = H.writeImage(path.join(sub, 'loner.png'));
    const other = H.writeImage(path.join(sub, 'other.png'));
    const rootId = library.idFor(root);
    const lonerId = library.idFor(loner);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: {
        [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] },
        [lonerId]: { id: lonerId, type: 'image', path: loner, addedAt: 2, favorite: true, tags: ['mine'] },
      },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [loner, other]));

    // Two separate decisions: this one photo goes, and later the whole subfolder goes.
    await m.invoke('library-remove-many', [{ path: loner, id: lonerId, type: 'image' }]);
    await m.invoke('library-remove-many', [{ path: sub, id: '', type: 'folder' }]);
    // Putting the subfolder back says nothing about the photo removed before it.
    await m.invoke('library-restore', [sub]);

    const cfg = m.__test.getConfig();
    const hidden = (await m.invoke('library-hidden-list')).images || [];
    const stillRemoved = hidden.some((im) => pathKey(im.path) === pathKey(loner));
    const inPool = !!cfg.library[lonerId];
    assert.ok(
      !(inPool && stillRemoved),
      'the photo is in the library AND in the trash at the same time',
    );
    assert.ok(stillRemoved || !inPool, 'the separately removed photo came back on its own');
  });

  // ---- P1.7 — a removal that is reported as done must be undoable ----
  await test('removing a big folder does not silently lose the tags of the photos over the limit', async (dir) => {
    const root = path.join(dir, 'photos');
    const pool = {};
    const rootId = library.idFor(root);
    pool[rootId] = { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] };
    const files = [];
    for (let i = 0; i < 520; i++) {
      const p = H.writeImage(path.join(root, `p${i}.png`));
      files.push(p);
      const id = library.idFor(p);
      pool[id] = { id, type: 'image', path: p, addedAt: 2 + i, favorite: true, tags: [`t${i}`] };
    }
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), { version: 1, library: pool, trash: [] });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, files));

    await m.invoke('library-remove-many', [{ path: root, id: rootId, type: 'folder' }]);
    await m.invoke('library-restore', [root]);

    const cfg = m.__test.getConfig();
    const back = files.filter((p) => cfg.library[library.idFor(p)]).length;
    assert.strictEqual(back, files.length, `${files.length - back} photos lost their star and tags for good`);
  });

  // ---- P2.1 — two overlapping watched folders are still one photo ----
  await test('a photo reachable through two watched folders gets one card in the trash', async (dir) => {
    const outer = path.join(dir, 'photos');
    const inner = path.join(outer, 'inner');
    const shared = H.writeImage(path.join(inner, 'shared.png'));
    const outerId = library.idFor(outer);
    const innerId = library.idFor(inner);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: {
        [outerId]: { id: outerId, type: 'folder', path: outer, addedAt: 1, favorite: false, tags: [] },
        [innerId]: { id: innerId, type: 'folder', path: inner, addedAt: 2, favorite: false, tags: [] },
      },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    // Indexed under BOTH roots, which is what overlapping watched folders produce.
    let state = folderState.reconcileFolder(folderState.emptyState(), {
      folderId: outerId, rootPath: outer, status: 'complete', entries: [{ path: shared, modifiedAt: 1 }],
    }).state;
    state = folderState.reconcileFolder(state, {
      folderId: innerId, rootPath: inner, status: 'complete', entries: [{ path: shared, modifiedAt: 1 }],
    }).state;
    m.__test.setLiveFolderState(state);

    await m.invoke('library-remove-many', [{ path: shared, id: '', type: 'image' }]);
    const listed = (await m.invoke('library-hidden-list')).images || [];
    const cards = listed.filter((im) => pathKey(im.path) === pathKey(shared)).length;
    assert.strictEqual(cards, 1, `one photo produced ${cards} cards in the trash`);
  });

  // ---- P2.2 — the folder card must agree with what opening the folder shows ----
  await test('a folder card stops counting a photo that was removed from inside it', async (dir) => {
    const root = path.join(dir, 'photos');
    const keep = H.writeImage(path.join(root, 'keep.png'));
    const gone = H.writeImage(path.join(root, 'gone.png'));
    const rootId = library.idFor(root);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [keep, gone]));
    assert.strictEqual((await m.invoke('folder-info', root)).count, 2, 'precondition: both counted');

    await m.invoke('library-remove-many', [{ path: gone, id: '', type: 'image' }]);
    const info = await m.invoke('folder-info', root);
    assert.strictEqual(info.count, 1, 'the folder card still counts the removed photo');
    assert.ok(!info.previews.some((p) => pathKey(p) === pathKey(gone)), 'the removed photo is still previewed');
  });

  // ---- P2.5 — a slot is a setting, not the library ----
  await test('taking a photo off a monitor does not rewrite the whole library', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'x.png'));
    const id = library.idFor(photo);
    H.writeJson(cfgFile(dir), baseConfig({ monitors: { M1: { light: { itemIds: [id] }, dark: { itemIds: [] } } } }));
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [id]: { id, type: 'image', path: photo, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.flushLibraryWriter();
    assert.strictEqual(m.__test.poolWritePending(), false, 'precondition: nothing pending');

    await m.invoke('remove-slot-item', 'M1', 'light', 0);
    assert.strictEqual(m.__test.poolWritePending(), false, 'removing from a slot rewrote the pool');

    await m.invoke('clear-slot', 'M1', 'light');
    assert.strictEqual(m.__test.poolWritePending(), false, 'clearing a slot rewrote the pool');
  });

  // ---- P2.6 — counts are cards, not bookkeeping rows ----
  await test('undoing the removal of one photo says one, not two', async (dir) => {
    // The photo has BOTH a library record and a file in a watched folder — one card on
    // screen, two rows in main's bookkeeping. Adding those rows up is what said "2".
    const root = path.join(dir, 'photos');
    const only = H.writeImage(path.join(root, 'only.png'));
    const rootId = library.idFor(root);
    const onlyId = library.idFor(only);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: {
        [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] },
        [onlyId]: { id: onlyId, type: 'image', path: only, addedAt: 2, favorite: true, tags: ['t'] },
      },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [only]));

    const removal = await m.invoke('library-remove-many', [{ path: only, id: onlyId, type: 'image' }]);
    assert.strictEqual(removal.affected, 1, `removal reported ${removal.affected} for one photo`);
    const undone = await m.invoke('library-undo-remove');
    assert.strictEqual(undone.restored, 1, `undo reported ${undone.restored} for one photo`);
  });

  // ---- P1.4 / P2.7 — one key, including the spellings Windows itself produces ----
  await test('the canonical key covers the extended-length and UNC spellings Windows uses', () => {
    const b = String.fromCharCode(92);
    assert.strictEqual(
      pathKey(`C:${b}x${b}a.png`), pathKey(`${b}${b}?${b}C:${b}x${b}a.png`),
      'the \\\\?\\ form of a path must be the same file',
    );
    assert.strictEqual(
      pathKey(`${b}${b}srv${b}share${b}a.png`), pathKey(`${b}${b}?${b}UNC${b}srv${b}share${b}a.png`),
      'the \\\\?\\UNC\\ form of a network path must be the same file',
    );
    assert.strictEqual(isUnderPath('C:/x/a.jpg', 'C:/'), true, 'everything is under the drive root');
    assert.strictEqual(isUnderPath(`${b}${b}srv${b}share${b}a.jpg`, `${b}${b}srv${b}share`), true,
      'a file is under its own network share');
  });

  console.log(`\n${failures.length ? `${failures.length} FAILED, ` : ''}${passed} invariant tests passed.\n`);
  if (failures.length) {
    for (const f of failures) {
      console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.message}`);
    }
    process.exit(1);
  }
})();
