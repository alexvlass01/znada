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

  // ---- DATA-005: recovery order must remain true when writes/restores fail ---

  await test('a failed pool-first flush keeps an inline copy before settings name the record', async (dir) => {
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [] });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'flush-failed.png'));
    const id = m.__test.addToPool('image', photo, {});
    m.__test.getConfig().monitors = {
      MON1: { light: { itemIds: [id] }, dark: { itemIds: [] } },
    };

    // Block only the atomic pool rename path. config.json remains writable, so this
    // reproduces the dangerous half-success rather than a generic full-disk failure.
    fs.mkdirSync(`${storeFile(dir)}.tmp`);
    m.__test.saveConfig();

    const settings = JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8'));
    const store = JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));
    assert.ok(!store.library[id], 'precondition: the pool write unexpectedly succeeded');
    assert.ok(settings.library && settings.library[id],
      'settings named an in-memory-only record without carrying its inline fallback');
    assert.ok(m.__test.poolWritePending(), 'the failed pool write was not retained for retry');
    assert.ok(m.__test.isUnsafeToWrite(), 'a runtime write failure did not enter fail-closed mode');

    // Pool-only edits happen after the ordered settings write too. Once the store has
    // failed, they must update the inline copy rather than trusting a pending retry.
    await m.invoke('library-add-tag', id, 'after-failure');
    const afterTag = JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8'));
    assert.deepStrictEqual(afterTag.library[id].tags, ['after-failure'],
      'a later pool-only edit was lost after the runtime store failure');

    // Freeze the failed-write state like a crash, then restart while the store is still
    // blocked. The inline copy must keep both the record and its placement alive.
    H.unloadMain();
    const restarted = H.loadMain(dir);
    restarted.__test.loadConfig();
    assert.ok(restarted.__test.getConfig().library[id], 'the record vanished after the failed flush');
    assert.deepStrictEqual(restarted.__test.getConfig().monitors.MON1.light.itemIds, [id],
      'startup repair discarded the user\'s assignment after the failed flush');
    assert.strictEqual(
      restarted.__test.eventLogEntries().filter((entry) => entry.channel === 'pool-consistency').length,
      0,
      'a safely inlined record was still reported as dangling',
    );
  });

  await test('a failed startup pool migration stays inline across a settings-only save and restart', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'startup-write-failed.png'));
    const id = library.idFor(photo);
    H.writeJson(cfgFile(dir), baseConfig({
      library: {
        [id]: { id, type: 'image', path: photo, addedAt: 1, favorite: true, tags: ['inline-only'], rev: 3 },
      },
    }));
    // The store itself is missing/readable-as-missing, but its atomic tmp path is
    // blocked. loadConfig therefore reaches the migration write and fails there,
    // rather than taking the already-covered unreadable-store branch.
    fs.mkdirSync(`${storeFile(dir)}.tmp`);

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    assert.ok(m.__test.isUnsafeToWrite(), 'a failed startup store write did not enter fail-closed mode');

    await m.invoke('set-config', { style: 'fit' });
    const afterSetting = JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8'));
    assert.ok(afterSetting.library && afterSetting.library[id],
      'a settings-only save stripped the only copy after startup store failure');

    // Let the next start create the store normally. The old implementation had
    // already removed the inline row above, so this restart came back empty.
    H.unloadMain();
    fs.rmSync(`${storeFile(dir)}.tmp`, { recursive: true, force: true });
    const restarted = H.loadMain(dir);
    restarted.__test.loadConfig();
    assert.deepStrictEqual(restarted.__test.getConfig().library[id].tags, ['inline-only'],
      'the inline-only record did not survive recovery after the startup write failure');
    const stored = JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));
    assert.ok(stored.library[id], 'the recovered record never reached the dedicated store');
  });

  await test('derived size metadata advances the record revision and beats the returning store', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'size-revision.png'));
    const id = library.idFor(photo);
    const oldItem = {
      id, type: 'image', path: photo, addedAt: 1, favorite: false, tags: [], rev: 4,
    };
    H.writeJson(cfgFile(dir), baseConfig({ library: { [id]: oldItem } }));
    fs.mkdirSync(storeFile(dir)); // degraded session keeps the revision-aware edit inline

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    await m.invoke('library-ensure-sizes');
    const measured = m.__test.getConfig().library[id];
    assert.ok(measured.size > 0, 'the real size handler did not persist measured metadata');
    assert.strictEqual(measured.rev, 5, 'measuring size did not advance the whole-record revision');

    H.unloadMain();
    fs.rmSync(storeFile(dir), { recursive: true, force: true });
    H.writeJson(storeFile(dir), { version: 1, library: { [id]: oldItem }, trash: [] });
    const restarted = H.loadMain(dir);
    restarted.__test.loadConfig();
    assert.ok(restarted.__test.getConfig().library[id].size > 0,
      'the returning stale store discarded derived metadata with an unadvanced revision');
  });

  // Owner QA 2026-08-30. Removing a photo in the fullscreen viewer left it on screen in
  // the Library grid behind, until the user switched rails and came back. A photo that
  // only lives inside a watched folder is removed by HIDING its path — the pool never
  // changes — and the grid rebuilds itself off a signature of the pool. So nothing told
  // it. No window exists in these tests, which is why this reads the decision main made
  // rather than the send it makes with it; the send is one line shared with the
  // live-folder broadcast.
  await test('a hide made in another window tells the main window its grid is stale', async (dir) => {
    const watched = path.join(dir, 'watched');
    const inside = H.writeImage(path.join(watched, 'inside.png'));
    const pooled = H.writeImage(path.join(dir, 'wallpapers', 'pooled.png'));
    const watchedId = library.idFor(watched);
    const pooledId = library.idFor(pooled);
    H.writeJson(cfgFile(dir), baseConfig({}));
    H.writeJson(storeFile(dir), {
      version: 1,
      library: {
        [watchedId]: { id: watchedId, type: 'folder', path: watched, addedAt: 1, favorite: false, tags: [] },
        [pooledId]: { id: pooledId, type: 'image', path: pooled, addedAt: 1, favorite: false, tags: [] },
      },
      trash: [],
    });
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    // The folder has to be INDEXED, or hiding a photo inside it is a no-op and this case
    // would pass by measuring nothing. The precondition below is what catches that.
    m.__test.setLiveFolderState(indexFolder(watched, [inside]));

    const before = m.__test.libraryViewStale().count;
    const hide = await m.invokeAs('viewer', 'library-remove-many', [{ id: '', path: inside, type: 'image' }]);
    assert.strictEqual(hide.hidden, 1, 'precondition: the photo was not actually hidden');
    assert.strictEqual(m.__test.libraryViewStale().count, before + 1,
      'a folder photo hidden from the viewer left the grid with no way to notice');

    // A pool removal needs no help: the ordinary config broadcast already carries it, and
    // saying so twice rebuilds the grid twice and drops the scroll position.
    const afterHide = m.__test.libraryViewStale().count;
    await m.invokeAs('viewer', 'library-remove-many', [{ id: pooledId, path: pooled, type: 'image' }]);
    assert.strictEqual(m.__test.libraryViewStale().count, afterHide,
      'a pool removal sent a second, redundant notice');
  });

  await test('the main window is not told about its own removals', async (dir) => {
    const watched = path.join(dir, 'watched');
    const inside = H.writeImage(path.join(watched, 'inside.png'));
    const watchedId = library.idFor(watched);
    H.writeJson(cfgFile(dir), baseConfig({}));
    H.writeJson(storeFile(dir), {
      version: 1,
      library: { [watchedId]: { id: watchedId, type: 'folder', path: watched, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setLiveFolderState(indexFolder(watched, [inside]));

    const before = m.__test.libraryViewStale().count;
    const hide = await m.invokeAs('main', 'library-remove-many', [{ id: '', path: inside, type: 'image' }]);
    assert.strictEqual(m.__test.libraryViewStale().count, before,
      'the window that did the removing was told to rebuild, which loses its scroll position');
    assert.strictEqual(hide.hidden, 1, 'precondition: nothing was hidden, so the case measured nothing');
  });

  await test('Undo makes the restored record newer than the removal after a degraded restart', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'undo-revision.png'));
    const id = library.idFor(photo);
    const item = { id, type: 'image', path: photo, addedAt: 1, favorite: true, tags: ['keep'], rev: 5 };
    H.writeJson(cfgFile(dir), baseConfig({ library: { [id]: item }, libraryTrash: [] }));
    fs.mkdirSync(storeFile(dir)); // unreadable store => edits are persisted inline

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    await m.invoke('library-remove-many', [{ id, path: photo, type: 'image' }]);
    const tombstone = JSON.parse(JSON.stringify(m.__test.getConfig().libraryTrash[0]));
    assert.strictEqual(tombstone.rev, 6, 'precondition: removal revision was not recorded');

    await m.invoke('library-undo-remove');
    const restored = m.__test.getConfig().library[id];
    assert.ok(restored && restored.rev > tombstone.rev,
      'Undo returned the old record without making it newer than its tombstone');

    H.unloadMain();
    fs.rmSync(storeFile(dir), { recursive: true, force: true });
    H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [tombstone] });
    const restarted = H.loadMain(dir);
    restarted.__test.loadConfig();
    assert.ok(restarted.__test.getConfig().library[id],
      'the returning tombstone deleted a record the user had restored with Undo');
  });

  await test('restoring from the persistent trash beats the tombstone after recovery', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'restore-revision.png'));
    const id = library.idFor(photo);
    const item = { id, type: 'image', path: photo, addedAt: 1, favorite: true, tags: ['keep'], rev: 5 };
    const tombstone = { item, removedAt: 10, rev: 6 };
    H.writeJson(cfgFile(dir), baseConfig({ library: {}, libraryTrash: [tombstone] }));
    fs.mkdirSync(storeFile(dir));

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    await m.invoke('library-restore', [photo]);
    const restored = m.__test.getConfig().library[id];
    assert.ok(restored && restored.rev > tombstone.rev,
      'Restore returned the old record without superseding the tombstone');

    H.unloadMain();
    fs.rmSync(storeFile(dir), { recursive: true, force: true });
    H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [tombstone] });
    const restarted = H.loadMain(dir);
    restarted.__test.loadConfig();
    assert.ok(restarted.__test.getConfig().library[id],
      'the returning tombstone deleted a record restored from the persistent trash');
  });

  await test('re-importing through the pool funnel supersedes a returned tombstone', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'reimport-revision.png'));
    const id = library.idFor(photo);
    const removedItem = { id, type: 'image', path: photo, addedAt: 1, favorite: false, tags: [], rev: 5 };
    const tombstone = { item: removedItem, removedAt: 10, rev: 6 };
    H.writeJson(cfgFile(dir), baseConfig({ library: {}, libraryTrash: [tombstone] }));
    fs.mkdirSync(storeFile(dir));

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    assert.strictEqual(m.__test.addToPool('image', photo, {}), id, 'the photo was not re-imported');
    m.__test.saveConfig();
    const revived = m.__test.getConfig().library[id];
    assert.ok(revived && revived.rev > tombstone.rev,
      'the shared import/download/assignment funnel did not supersede the tombstone');

    H.unloadMain();
    fs.rmSync(storeFile(dir), { recursive: true, force: true });
    H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [tombstone] });
    const restarted = H.loadMain(dir);
    restarted.__test.loadConfig();
    assert.ok(restarted.__test.getConfig().library[id],
      'the returning tombstone deleted a photo the user re-imported');
  });

  await test('an Undo token cannot restore a newer removal from another window', async (dir) => {
    const a = H.writeImage(path.join(dir, 'wallpapers', 'undo-a.png'));
    const b = H.writeImage(path.join(dir, 'wallpapers', 'undo-b.png'));
    const aId = library.idFor(a);
    const bId = library.idFor(b);
    H.writeJson(cfgFile(dir), baseConfig());
    H.writeJson(storeFile(dir), {
      version: 1,
      library: {
        [aId]: { id: aId, type: 'image', path: a, addedAt: 1, favorite: false, tags: [], rev: 0 },
        [bId]: { id: bId, type: 'image', path: b, addedAt: 1, favorite: false, tags: [], rev: 0 },
      },
      trash: [],
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    const first = await m.invoke('library-remove-many', [{ id: aId, path: a, type: 'image' }]);
    const second = await m.invoke('library-remove-many', [{ id: bId, path: b, type: 'image' }]);
    assert.ok(first.undo && first.undo.token && second.undo && second.undo.token,
      'removal did not return an opaque Undo identity');
    assert.notStrictEqual(first.undo.token, second.undo.token, 'two removals shared one Undo identity');

    const stale = await m.invoke('library-undo-remove', first.undo.token);
    assert.strictEqual(stale.error, 'stale_undo', 'an older window undid the latest unrelated removal');
    assert.ok(!m.__test.getConfig().library[aId] && !m.__test.getConfig().library[bId],
      'a stale Undo changed the active pool');

    const latest = await m.invoke('library-undo-remove', second.undo.token);
    assert.strictEqual(latest.restored, 1, 'the current Undo token no longer worked');
    assert.ok(!m.__test.getConfig().library[aId] && m.__test.getConfig().library[bId],
      'the current Undo restored the wrong removal');
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
