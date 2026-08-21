'use strict';

// Executable regression tests for main.js ORCHESTRATION — the order it mutates the
// pool, the slots and the folder index in, what it writes afterwards, and what it
// re-checks before touching a file on disk.
//
// Every test here fails on the code as it was before this pass. That is the point:
// four reviews in a row rejected fixes whose "proof" was a source-string check, which
// can only show that a line exists — not that it runs at the right moment, or that the
// user's tags are still there after a restart. These drive the real handlers over a
// real temporary profile and assert on the resulting files.
//
// Run: node test/library-orchestration.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const configMod = require('../src/config');
const folderState = require('../src/folder-state');
const library = require('../src/library');

let passed = 0;
const failures = [];

// main.js reports the degraded paths these tests deliberately create (unreadable store,
// corrupt store, an apply that cannot run without a child process). That output is the
// code working as intended, so it is captured and only shown when a test fails.
async function test(name, fn) {
  const dir = H.makeTempProfile('orch');
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

function baseConfig(extra = {}) {
  return { autoSwitch: true, style: 'fill', monitors: {}, ...extra };
}

// A folder index with `files` already discovered under `root`, as a live watched folder.
function indexFolder(root, files) {
  const res = folderState.reconcileFolder(folderState.emptyState(), {
    folderId: library.idFor(root),
    rootPath: root,
    status: 'complete',
    entries: files.map((p) => ({ path: p, modifiedAt: 1000 })),
  });
  return res.state;
}

console.log('\nmain.js orchestration\n');

(async () => {
  // ---- DATA-004: the pool must survive a store that cannot be written -------

  await test('an unreadable store keeps tags in config.json instead of losing them on restart', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'a.png'));
    const id = library.idFor(photo);
    H.writeJson(cfgFile(dir), baseConfig({
      library: { [id]: { id, type: 'image', path: photo, addedAt: 1, favorite: false, tags: ['old'] } },
    }));
    // A directory where the store file should be: readable() fails with EISDIR, which is
    // "says nothing about the contents" — exactly the case that must not be written over.
    fs.mkdirSync(storeFile(dir));

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    assert.ok(m.__test.isUnsafeToWrite(), 'the store should be flagged unusable');

    await m.invoke('library-add-tag', id, 'new');
    assert.deepStrictEqual(m.__test.getConfig().library[id].tags, ['old', 'new'], 'tag applied in memory');

    // What the user would see after restarting.
    const reloaded = configMod.load(cfgFile(dir));
    assert.deepStrictEqual(
      reloaded.library[id].tags, ['old', 'new'],
      'the tag was confirmed on screen but did not survive a restart',
    );
  });

  await test('a favourite set while the store is unusable also survives a restart', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'b.png'));
    const id = library.idFor(photo);
    H.writeJson(cfgFile(dir), baseConfig({
      library: { [id]: { id, type: 'image', path: photo, addedAt: 1, favorite: false, tags: [] } },
    }));
    fs.mkdirSync(storeFile(dir));

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    await m.invoke('library-toggle-favorite', id);

    const reloaded = configMod.load(cfgFile(dir));
    assert.strictEqual(reloaded.library[id].favorite, true, 'the star did not survive a restart');
  });

  await test('a corrupt store is not replaced by an empty pool while slots still reference it', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'c.png'));
    const id = library.idFor(photo);
    // No inline copy to fall back on, and a slot that still points at the id.
    H.writeJson(cfgFile(dir), baseConfig({
      monitors: { MON1: { light: { itemIds: [id] }, dark: { itemIds: [] } } },
    }));
    fs.writeFileSync(storeFile(dir), '{ this is not json', 'utf8');

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    assert.ok(m.__test.isUnsafeToWrite(), 'a corrupt store with no fallback must block writes');

    const onDisk = fs.readFileSync(storeFile(dir), 'utf8');
    assert.ok(!onDisk.startsWith('{\n  "version"'), 'the corrupt store was overwritten with an empty pool');
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assert.ok(backups.length >= 1, 'a backup of the corrupt store should exist');
    assert.deepStrictEqual(
      m.__test.getConfig().monitors.MON1.light.itemIds, [id],
      'the slot reference must be left intact so the pool can be restored',
    );
    void photo;
  });

  await test('settings-only changes do not schedule a full rewrite of the pool', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'd.png'));
    const id = library.idFor(photo);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [id]: { id, type: 'image', path: photo, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.flushLibraryWriter();
    assert.strictEqual(m.__test.poolWritePending(), false, 'nothing should be pending after a flush');

    await m.invoke('set-config', { style: 'fit' });
    assert.strictEqual(
      m.__test.poolWritePending(), false,
      'changing a setting scheduled a write of the whole pool',
    );

    // ...and the opposite direction still holds: a pool edit MUST schedule one.
    await m.invoke('library-toggle-favorite', id);
    assert.strictEqual(m.__test.poolWritePending(), true, 'a pool edit must be written');
  });

  // ---- BUG-012: removing a folder removes what is inside it -----------------

  await test('removing a folder also removes the photos inside it that have their own record', async (dir) => {
    const root = path.join(dir, 'photos');
    const inside = H.writeImage(path.join(root, 'sub', 'x.png'));
    const rootId = library.idFor(root);
    const insideId = library.idFor(inside);
    H.writeJson(cfgFile(dir), baseConfig({
      monitors: { MON1: { light: { itemIds: [rootId, insideId] }, dark: { itemIds: [] } } },
    }));
    H.writeJson(storeFile(dir), {
      version: 1,
      library: {
        [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] },
        [insideId]: { id: insideId, type: 'image', path: inside, addedAt: 2, favorite: true, tags: ['keep'] },
      },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [inside]));

    await m.invoke('library-remove-many', [{ path: root, id: rootId, type: 'folder' }]);

    const cfg = m.__test.getConfig();
    assert.ok(!cfg.library[insideId], 'the photo inside the removed folder is still in the pool');
    assert.ok(
      !cfg.monitors.MON1.light.itemIds.includes(insideId),
      'the photo inside the removed folder is still assigned to a monitor',
    );
    assert.deepStrictEqual(
      m.__test.resolvePlaylist('MON1', 'light'), [],
      'the removed folder\'s photo is still being served as wallpaper',
    );
  });

  await test('undo puts a removed folder\'s own-record photos back, in their slots', async (dir) => {
    const root = path.join(dir, 'photos');
    const inside = H.writeImage(path.join(root, 'sub', 'x.png'));
    const rootId = library.idFor(root);
    const insideId = library.idFor(inside);
    H.writeJson(cfgFile(dir), baseConfig({
      monitors: { MON1: { light: { itemIds: [rootId, insideId] }, dark: { itemIds: [] } } },
    }));
    H.writeJson(storeFile(dir), {
      version: 1,
      library: {
        [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] },
        [insideId]: { id: insideId, type: 'image', path: inside, addedAt: 2, favorite: true, tags: ['keep'] },
      },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [inside]));

    await m.invoke('library-remove-many', [{ path: root, id: rootId, type: 'folder' }]);
    await m.invoke('library-undo-remove');

    const cfg = m.__test.getConfig();
    assert.ok(cfg.library[insideId], 'undo did not bring the inner photo back');
    assert.deepStrictEqual(cfg.library[insideId].tags, ['keep'], 'undo lost the photo\'s tags');
    assert.ok(
      cfg.monitors.MON1.light.itemIds.includes(insideId),
      'undo did not put the inner photo back in its slot',
    );
  });

  await test('putting a removed folder back returns the stars and tags of the photos in it', async (dir) => {
    // Not the same as Undo: this is the trash, used minutes or days later. Removing the
    // folder correctly takes the inner photo's record with it — so the record has to be
    // kept somewhere, or the folder comes back full of photos that silently lost their
    // stars and tags.
    const root = path.join(dir, 'photos');
    const inside = H.writeImage(path.join(root, 'sub', 'star.png'));
    const rootId = library.idFor(root);
    const insideId = library.idFor(inside);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: {
        [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] },
        [insideId]: { id: insideId, type: 'image', path: inside, addedAt: 2, favorite: true, tags: ['keeper'] },
      },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [inside]));

    const removedFolder = path.join(root, 'sub');
    await m.invoke('library-remove-many', [{ path: removedFolder, id: '', type: 'folder' }]);
    assert.ok(!m.__test.getConfig().library[insideId], 'precondition: the record was taken away');

    // The trash must not show one card per photo inside a removed folder — the folder
    // is one decision and gets one card.
    const listed = await m.invoke('library-hidden-list');
    assert.strictEqual(
      listed.images.filter((im) => im.type !== 'folder').length, 0,
      'a removed folder should not also list its photos as separate cards',
    );

    await m.invoke('library-restore', [removedFolder]);
    const back = m.__test.getConfig().library[insideId];
    assert.ok(back, 'restoring the folder did not bring the photo\'s record back');
    assert.strictEqual(back.favorite, true, 'the star was lost');
    assert.deepStrictEqual(back.tags, ['keeper'], 'the tags were lost');
  });

  await test('removing a folder clears a legacy fallback pointing inside it', async (dir) => {
    const root = path.join(dir, 'photos');
    const inside = H.writeImage(path.join(root, 'y.png'));
    const rootId = library.idFor(root);
    H.writeJson(cfgFile(dir), baseConfig({ lightWallpaper: inside }));
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [inside]));

    await m.invoke('library-remove-many', [{ path: root, id: rootId, type: 'folder' }]);
    assert.strictEqual(
      m.__test.getConfig().lightWallpaper, '',
      'the pre-library fallback still points at a photo inside the removed folder',
    );
  });

  // ---- BUG-011: active and removed can never be true at the same time -------

  await test('assigning a photo that is stuck in the trash repairs it, and the repair is saved', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'stale.png'));
    const id = library.idFor(photo);
    const item = { id, type: 'image', path: photo, addedAt: 1, favorite: false, tags: [] };
    H.writeJson(cfgFile(dir), baseConfig({ monitors: { MON1: { light: { itemIds: [] }, dark: { itemIds: [] } } } }));
    // The broken state an older build could leave behind: in the pool AND in the trash.
    H.writeJson(storeFile(dir), { version: 1, library: { [id]: item }, trash: [{ item, removedAt: 5 }] });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    assert.strictEqual(m.__test.getConfig().libraryTrash.length, 1, 'precondition: a stale trash entry');

    await m.invoke('library-assign', id, 'MON1', 'light');
    assert.strictEqual(
      m.__test.getConfig().libraryTrash.length, 0,
      'assigning an existing record left it in the trash — active and removed at once',
    );

    m.__test.flushLibraryWriter();
    const reloaded = configMod.load(cfgFile(dir));
    assert.strictEqual(reloaded.libraryTrash.length, 0, 'the repair did not reach the disk');
  });

  await test('re-adding a photo that is already in the pool clears its trash entry for good', async (dir) => {
    const source = H.writeImage(path.join(dir, 'incoming', 'again.png'));
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [] });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    // Import once. Lumina copies the file and the pool record points at ITS copy, whose
    // name is derived from the contents — so importing the same file again lands on the
    // same record instead of creating a second one.
    await m.invoke('library-add-paths', [source]);
    const item = Object.values(m.__test.getConfig().library)[0];
    assert.ok(item, 'precondition: the photo was imported');

    // The broken state, ON DISK: still in the pool, but also sitting in the trash. It
    // has to come from the file, or the test would prove nothing about persistence.
    m.__test.flushLibraryWriter();
    const store = JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));
    store.trash = [{ item: JSON.parse(JSON.stringify(item)), removedAt: 5 }];
    fs.writeFileSync(storeFile(dir), JSON.stringify(store, null, 2), 'utf8');
    m.__test.loadConfig();
    assert.strictEqual(m.__test.getConfig().libraryTrash.length, 1, 'precondition: stale entry loaded');

    // Adding it again grows the pool by nothing — which is exactly why the repair used
    // to be applied in memory and never written down.
    await m.invoke('library-add-paths', [source]);
    assert.strictEqual(m.__test.getConfig().libraryTrash.length, 0, 'trash entry not cleared in memory');

    m.__test.flushLibraryWriter();
    const reloaded = configMod.load(cfgFile(dir));
    assert.strictEqual(reloaded.libraryTrash.length, 0, 'the photo came back out of the trash after a restart');
  });

  // ---- LIB-007: deleting from disk is guarded at the moment it happens ------

  await test('a photo restored while the confirmation dialog is open is not deleted', async (dir) => {
    const root = path.join(dir, 'photos');
    const keep = H.writeImage(path.join(root, 'keep.png'));
    const drop = H.writeImage(path.join(root, 'drop.png'));
    const rootId = library.idFor(root);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    let handle = null;
    const m = H.loadMain(dir, {
      // While the user reads the dialog, they (or a download) put one of them back.
      onDialog: async () => {
        await handle.invoke('library-restore', [keep]);
        return 0; // confirm
      },
    });
    // Deleting files is switched OFF for users until its guard is proved (see
    // physicalDeleteEnabled in main.js). The guard itself must still be exercised, or
    // these tests would pass by doing nothing and the day it is switched back on nobody
    // would know whether it still holds.
    m.__test.setPhysicalDeleteEnabled(true);
    handle = m;
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [keep, drop]));
    await m.invoke('library-remove-many', [
      { path: keep, id: '', type: 'image' },
      { path: drop, id: '', type: 'image' },
    ]);

    const res = await m.invoke('library-delete-forever', [keep, drop]);
    assert.strictEqual(res.deleted, 1, `expected exactly one deletion, got ${res.deleted}`);
    assert.ok(fs.existsSync(keep), 'a photo put back while the dialog was open was deleted anyway');
    assert.ok(!fs.existsSync(drop), 'the photo that stayed removed should be gone');
  });

  await test('a photo that becomes active between two deletions is not deleted', async (dir) => {
    const root = path.join(dir, 'photos');
    const first = H.writeImage(path.join(root, '1.png'));
    const second = H.writeImage(path.join(root, '2.png'));
    const rootId = library.idFor(root);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    let handle = null;
    const m = H.loadMain(dir, {
      // Between the two `trashItem` awaits, something makes the second one active
      // again. Mutating config directly is the honest simulation: any code path that
      // did this while the loop was mid-flight would have the same effect.
      onTrash: async (target) => {
        if (!target.endsWith('1.png')) return;
        const cfg = handle.__test.getConfig();
        const id = library.idFor(second);
        cfg.library[id] = { id, type: 'image', path: second, addedAt: 9, favorite: false, tags: [] };
      },
    });
    // Deleting files is switched OFF for users until its guard is proved (see
    // physicalDeleteEnabled in main.js). The guard itself must still be exercised, or
    // these tests would pass by doing nothing and the day it is switched back on nobody
    // would know whether it still holds.
    m.__test.setPhysicalDeleteEnabled(true);
    handle = m;
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [first, second]));
    await m.invoke('library-remove-many', [
      { path: first, id: '', type: 'image' },
      { path: second, id: '', type: 'image' },
    ]);

    await m.invoke('library-delete-forever', [first, second]);
    assert.ok(!fs.existsSync(first), 'the first photo should have been deleted');
    assert.ok(fs.existsSync(second), 'a photo that became active mid-loop was deleted anyway');
  });

  await test('the delete guard recognises the same file spelled with the other separator', async (dir) => {
    const root = path.join(dir, 'photos');
    const photo = H.writeImage(path.join(root, 'sep.png'));
    const rootId = library.idFor(root);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    const m = H.loadMain(dir);
    // Deleting files is switched OFF for users until its guard is proved (see
    // physicalDeleteEnabled in main.js). The guard itself must still be exercised, or
    // these tests would pass by doing nothing and the day it is switched back on nobody
    // would know whether it still holds.
    m.__test.setPhysicalDeleteEnabled(true);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [photo]));
    await m.invoke('library-remove-many', [{ path: photo, id: '', type: 'image' }]);

    const flipped = photo.split(path.sep).join('/');
    const res = await m.invoke('library-delete-forever', [flipped]);
    assert.strictEqual(res.error, null, `the same file with '/' was rejected: ${res.error}`);
    assert.strictEqual(res.deleted, 1, 'the file should have been deleted');
  });

  // ---- Undo reports what actually happened ---------------------------------

  await test('undo reports only what came back, and stays available for what did not', async (dir) => {
    // An own copy whose file is gone: the record cannot be restored, and saying it was
    // would be a lie the user only discovers when the wallpaper fails to apply.
    const own = path.join(dir, 'wallpapers', 'own.png');
    H.writeImage(own);
    const id = library.idFor(own);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [id]: { id, type: 'image', path: own, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    await m.invoke('library-remove-many', [{ path: own, id, type: 'image' }]);
    fs.rmSync(own, { force: true });   // and it is not in wallpapers/.trash either

    const res = await m.invoke('library-undo-remove');
    assert.strictEqual(res.restored, 0, `undo claimed ${res.restored} restored with nothing to restore`);
    assert.strictEqual(res.failed, 1, 'undo should report the failure');
    assert.strictEqual(
      m.__test.getConfig().libraryTrash.length, 1,
      'the recovery entry is the only way back and must be kept',
    );
    assert.ok(m.__test.lastRemovalPending(), 'undo should stay available to retry');
  });

  await test('undo does not restore a legacy fallback whose file is gone', async (dir) => {
    const own = path.join(dir, 'wallpapers', 'legacy.png');
    H.writeImage(own);
    const id = library.idFor(own);
    H.writeJson(cfgFile(dir), baseConfig({ lightWallpaper: own }));
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [id]: { id, type: 'image', path: own, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    await m.invoke('library-remove-many', [{ path: own, id, type: 'image' }]);
    assert.strictEqual(m.__test.getConfig().lightWallpaper, '', 'removal should clear the fallback');
    fs.rmSync(own, { force: true });

    await m.invoke('library-undo-remove');
    assert.strictEqual(
      m.__test.getConfig().lightWallpaper, '',
      'undo pointed the desktop at a file that no longer exists',
    );
  });

  // ---- The removed set and the playlist must agree on what a path is -------

  await test('a removed folder photo stops being served as wallpaper', async (dir) => {
    const root = path.join(dir, 'photos');
    const a = H.writeImage(path.join(root, 'a.png'));
    const b = H.writeImage(path.join(root, 'b.png'));
    const rootId = library.idFor(root);
    H.writeJson(cfgFile(dir), baseConfig({
      monitors: { MON1: { light: { itemIds: [rootId] }, dark: { itemIds: [] } } },
    }));
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(root, [a, b]));
    assert.strictEqual(m.__test.resolvePlaylist('MON1', 'light').length, 2, 'precondition: both photos play');

    await m.invoke('library-remove-many', [{ path: a, id: '', type: 'image' }]);
    const list = m.__test.resolvePlaylist('MON1', 'light');
    assert.strictEqual(list.length, 1, 'the removed photo is still in the playlist');
    assert.ok(list[0].endsWith('b.png'), 'the wrong photo was excluded');
  });

  console.log(`\n${failures.length ? `${failures.length} FAILED, ` : ''}${passed} orchestration tests passed.\n`);
  if (failures.length) {
    for (const f of failures) {
      console.error(`\nFAILED: ${f.name}\n${f.err && f.err.stack}`);
      if (f.captured.length) console.error(`  main.js said:\n    ${f.captured.join('\n    ')}`);
    }
    process.exit(1);
  }
})();
