'use strict';

// BUG-012: one removal/restore model for folder trees, with exact provenance.
//
// The scenarios come from the removal cross-review. They all turn
// on the same question: when a folder comes back, WHAT came back with it? Answering
// that by path ancestry — "this record sits under the folder, so it belongs to it" —
// is what produced photos that were listed in the library and in the trash at the same
// time, and folders that lost their star and their tags on the way out.
//
// Provenance is therefore explicit: each trash entry names the exact folder it left
// with and the single removal it belonged to. Nothing here is inferred from a path
// prefix or a timestamp.
//
// Run: node test/folder-removal-provenance.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const folderState = require('../src/folder-state');
const library = require('../src/library');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = H.makeTempProfile('provenance');
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
const stateFile = (dir) => path.join(dir, 'folder-state.json');

function poolItem(type, p, extra = {}) {
  return {
    id: library.idFor(p), type, path: p, addedAt: 1, favorite: false, tags: [], ...extra,
  };
}

// A watched root with `files` already discovered, optionally several roots at once.
function indexRoots(roots) {
  let state = folderState.emptyState();
  for (const { root, files } of roots) {
    state = folderState.reconcileFolder(state, {
      folderId: library.idFor(root),
      rootPath: root,
      status: 'complete',
      entries: files.map((p) => ({ path: p, modifiedAt: 1000 })),
    }).state;
  }
  return state;
}

// Everything the user can still see or that still plays. A photo must never be in both
// this and the removed list.
function activePaths(m) {
  const cfg = m.__test.getConfig();
  return new Set(Object.values(cfg.library).map((it) => library.pathKey(it.path)));
}

async function removedPaths(m) {
  const res = await m.invoke('library-hidden-list');
  return res.images.map((im) => library.pathKey(im.path));
}

(async () => {
  console.log('\nBUG-012: folder removal provenance\n');

  // --- 1. a removed tree keeps every record it took with it -------------------

  await test('removing a folder keeps the records of the folder itself, not only of its photos',
    async (dir) => {
      const root = path.join(dir, 'shots');
      const sub = path.join(root, 'trip');
      const photo = H.writeImage(path.join(sub, 'a.png'));
      fs.mkdirSync(sub, { recursive: true });

      H.writeJson(cfgFile(dir), {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: {
          [library.idFor(root)]: poolItem('folder', root),
          [library.idFor(sub)]: poolItem('folder', sub, { favorite: true, tags: ['trip'] }),
          [library.idFor(photo)]: poolItem('image', photo, { favorite: true, tags: ['best'] }),
        },
      });
      H.writeJson(stateFile(dir), indexRoots([{ root, files: [photo] }]));

      const m = H.loadMain(dir);
      m.__test.loadConfig();
      m.__test.setLiveFolderState(indexRoots([{ root, files: [photo] }]));

      await m.invoke('library-remove-many', [{ id: library.idFor(root), path: root, type: 'folder' }]);

      const trash = m.__test.getConfig().libraryTrash || [];
      const byPath = new Map(trash.map((e) => [library.pathKey(e.item.path), e]));
      assert.ok(byPath.has(library.pathKey(photo)), 'the photo record was not kept');
      assert.ok(byPath.has(library.pathKey(sub)), 'the SUBFOLDER record was thrown away, with its star and tags');
      assert.ok(byPath.has(library.pathKey(root)), 'the removed folder kept no record of itself');

      const subEntry = byPath.get(library.pathKey(sub));
      assert.strictEqual(subEntry.item.favorite, true, 'the folder lost its star');
      assert.deepStrictEqual(subEntry.item.tags, ['trip'], 'the folder lost its tags');
    });

  await test('a long restore after a restart brings the tree back with its metadata and its places',
    async (dir) => {
      const root = path.join(dir, 'shots');
      const sub = path.join(root, 'trip');
      const photo = H.writeImage(path.join(sub, 'a.png'));

      H.writeJson(cfgFile(dir), {
        autoSwitch: true,
        style: 'fill',
        monitors: {
          MON1: {
            light: { itemIds: [library.idFor(sub)] },
            dark: { itemIds: [library.idFor(photo)] },
          },
        },
        library: {
          [library.idFor(root)]: poolItem('folder', root),
          [library.idFor(sub)]: poolItem('folder', sub, { favorite: true, tags: ['trip'] }),
          [library.idFor(photo)]: poolItem('image', photo, { favorite: true, tags: ['best'] }),
        },
      });
      H.writeJson(stateFile(dir), indexRoots([{ root, files: [photo] }]));

      const first = H.loadMain(dir);
      first.__test.loadConfig();
      first.__test.setLiveFolderState(indexRoots([{ root, files: [photo] }]));
      await first.invoke('library-remove-many', [{ id: library.idFor(root), path: root, type: 'folder' }]);
      first.__test.flushLibraryWriter();
      first.__test.disposeForTests();
      H.unloadMain();

      // A restart is the point: undo is gone, only what reached disk can help.
      const second = H.loadMain(dir);
      second.__test.loadConfig();
      await second.invoke('library-restore', [root]);

      const cfg = second.__test.getConfig();
      assert.ok(cfg.library[library.idFor(photo)], 'the photo record did not come back');
      assert.ok(cfg.library[library.idFor(sub)], 'the subfolder record did not come back');
      assert.strictEqual(cfg.library[library.idFor(sub)].favorite, true, 'the star did not come back');
      assert.deepStrictEqual(cfg.library[library.idFor(photo)].tags, ['best'], 'the tags did not come back');

      assert.deepStrictEqual(
        cfg.monitors.MON1.light.itemIds, [library.idFor(sub)],
        'the folder came back but not to the monitor it was on',
      );
      assert.deepStrictEqual(
        cfg.monitors.MON1.dark.itemIds, [library.idFor(photo)],
        'the photo came back but not to the monitor it was on',
      );
    });

  // --- 2. a separate earlier removal is not undone by the parent --------------

  await test('restoring the parent does not revive what a separate earlier removal took',
    async (dir) => {
      const root = path.join(dir, 'shots');
      const sub = path.join(root, 'trip');
      const inSub = H.writeImage(path.join(sub, 'a.png'));
      const inRoot = H.writeImage(path.join(root, 'b.png'));

      H.writeJson(cfgFile(dir), {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: {
          [library.idFor(root)]: poolItem('folder', root),
          [library.idFor(inSub)]: poolItem('image', inSub, { tags: ['sub'] }),
          [library.idFor(inRoot)]: poolItem('image', inRoot, { tags: ['root'] }),
        },
      });
      const state = indexRoots([{ root, files: [inSub, inRoot] }]);
      H.writeJson(stateFile(dir), state);

      const m = H.loadMain(dir);
      m.__test.loadConfig();
      m.__test.setLiveFolderState(state);

      // First the user removes the subfolder on its own…
      await m.invoke('library-remove-many', [{ id: '', path: sub, type: 'folder' }]);
      // …and later the whole root.
      await m.invoke('library-remove-many', [{ id: library.idFor(root), path: root, type: 'folder' }]);

      await m.invoke('library-restore', [root]);

      const active = activePaths(m);
      assert.ok(active.has(library.pathKey(inRoot)), 'the photo that went with the root did not come back');
      assert.ok(
        !active.has(library.pathKey(inSub)),
        'restoring the parent also undid the separate removal of the subfolder',
      );

      // And the state must not be self-contradictory: whatever is not active is removed,
      // and nothing is both.
      const removed = new Set(await removedPaths(m));
      assert.ok(
        !(active.has(library.pathKey(inSub)) && removed.has(library.pathKey(inSub))),
        'the photo is listed as present AND as removed at the same time',
      );
    });

  await test('restoring the child afterwards finishes the job without leaving it half-removed',
    async (dir) => {
      const root = path.join(dir, 'shots');
      const sub = path.join(root, 'trip');
      const inSub = H.writeImage(path.join(sub, 'a.png'));

      H.writeJson(cfgFile(dir), {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: {
          [library.idFor(root)]: poolItem('folder', root),
          [library.idFor(inSub)]: poolItem('image', inSub, { tags: ['sub'] }),
        },
      });
      const state = indexRoots([{ root, files: [inSub] }]);
      H.writeJson(stateFile(dir), state);

      const m = H.loadMain(dir);
      m.__test.loadConfig();
      m.__test.setLiveFolderState(state);

      await m.invoke('library-remove-many', [{ id: '', path: sub, type: 'folder' }]);
      await m.invoke('library-remove-many', [{ id: library.idFor(root), path: root, type: 'folder' }]);
      await m.invoke('library-restore', [root]);
      await m.invoke('library-restore', [sub]);

      const active = activePaths(m);
      const removed = new Set(await removedPaths(m));
      assert.ok(active.has(library.pathKey(inSub)), 'the photo never came back');
      assert.deepStrictEqual(
        active.has(library.pathKey(inSub)) && removed.has(library.pathKey(inSub)), false,
        'the photo is back in the library while still being listed as removed',
      );
      assert.deepStrictEqual(
        cfgTags(m, inSub), ['sub'],
        'the photo came back without the tags it was removed with',
      );
    });

  await test('a record removed with both a folder and its subfolder belongs to the subfolder',
    async (dir) => {
      const root = path.join(dir, 'shots');
      const sub = path.join(root, 'trip');
      const inSub = H.writeImage(path.join(sub, 'a.png'));

      H.writeJson(cfgFile(dir), {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: {
          [library.idFor(root)]: poolItem('folder', root),
          [library.idFor(inSub)]: poolItem('image', inSub, { tags: ['sub'] }),
        },
      });
      const state = indexRoots([{ root, files: [inSub] }]);
      H.writeJson(stateFile(dir), state);

      const m = H.loadMain(dir);
      m.__test.loadConfig();
      m.__test.setLiveFolderState(state);

      // Both named in a single action, outer one first.
      await m.invoke('library-remove-many', [
        { id: library.idFor(root), path: root, type: 'folder' },
        { id: '', path: sub, type: 'folder' },
      ]);

      // The photo went with the SUBFOLDER — the nearest folder that was removed — so
      // putting the subfolder back has to be enough to bring it with it.
      await m.invoke('library-restore', [sub]);
      assert.ok(
        activePaths(m).has(library.pathKey(inSub)),
        'the photo was filed under the outer folder, so restoring the subfolder brought nothing back',
      );
    });

  await test('a folder on an unplugged disk can still be put back',
    async (dir) => {
      // A drive letter nothing is mounted on: the same situation as the owner's
      // unplugged disk, where the path is absent because the VOLUME is absent.
      const freeDrive = ['Q', 'X', 'Y', 'V', 'U']
        .map((letter) => `${letter}:\\`)
        .find((root) => !fs.existsSync(root));
      if (!freeDrive) return; // на этой машине все буквы заняты — сценарий неприменим
      const gone = path.join(freeDrive, 'shots');

      H.writeJson(cfgFile(dir), {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: { [library.idFor(gone)]: poolItem('folder', gone, { favorite: true, tags: ['поездка'] }) },
      });

      const m = H.loadMain(dir);
      m.__test.loadConfig();
      await m.invoke('library-remove-many', [{ id: library.idFor(gone), path: gone, type: 'folder' }]);
      assert.strictEqual(
        (m.__test.getConfig().libraryTrash || []).length, 1,
        'precondition: the record is in the trash',
      );

      const res = await m.invoke('library-restore', [gone]);
      assert.strictEqual(
        res.restored, 1,
        'the folder could not be put back, so the record is stuck in the trash for good',
      );
      const back = m.__test.getConfig().library[library.idFor(gone)];
      assert.ok(back, 'the record did not come back');
      assert.strictEqual(back.favorite, true, 'the star did not come back with it');
      assert.strictEqual((m.__test.getConfig().libraryTrash || []).length, 0, 'the trash entry was left behind');
    });

  await test('a record whose file really was deleted is still refused',
    async (dir) => {
      // Same shape, but the disk is right here and the file is simply gone —
      // putting a record back that points at nothing helps nobody.
      const missing = path.join(dir, 'deleted.png');
      H.writeJson(cfgFile(dir), {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: { [library.idFor(missing)]: poolItem('image', missing) },
      });

      const m = H.loadMain(dir);
      m.__test.loadConfig();
      await m.invoke('library-remove-many', [{ id: library.idFor(missing), path: missing, type: 'image' }]);
      const res = await m.invoke('library-restore', [missing]);

      assert.strictEqual(res.restored, 0, 'a record pointing at nothing was put back');
      assert.strictEqual(
        (m.__test.getConfig().libraryTrash || []).length, 1,
        'the recovery entry must stay: it is the only way back if the file returns',
      );
    });

  // --- 6. undo and a long restore agree on the result ------------------------

  await test('undo and a restore after a restart leave the same library and the same monitors',
    async (dir) => {
      const root = path.join(dir, 'shots');
      const sub = path.join(root, 'trip');
      const photo = H.writeImage(path.join(sub, 'a.png'));
      const other = H.writeImage(path.join(dir, 'solo.png'));

      const startingConfig = {
        autoSwitch: true,
        style: 'fill',
        monitors: {
          MON1: {
            light: { itemIds: [library.idFor(other), library.idFor(sub)] },
            dark: { itemIds: [library.idFor(photo)] },
          },
        },
        library: {
          [library.idFor(other)]: poolItem('image', other),
          [library.idFor(root)]: poolItem('folder', root),
          [library.idFor(sub)]: poolItem('folder', sub, { favorite: true, tags: ['trip'] }),
          [library.idFor(photo)]: poolItem('image', photo, { tags: ['best'] }),
        },
      };
      const state = indexRoots([{ root, files: [photo] }]);

      // Path A: remove, then press Undo straight away.
      H.writeJson(cfgFile(dir), startingConfig);
      H.writeJson(stateFile(dir), state);
      const undoRun = H.loadMain(dir);
      undoRun.__test.loadConfig();
      undoRun.__test.setLiveFolderState(state);
      await undoRun.invoke('library-remove-many', [{ id: library.idFor(root), path: root, type: 'folder' }]);
      await undoRun.invoke('library-undo-remove');
      const afterUndo = snapshot(undoRun.__test.getConfig());
      undoRun.__test.disposeForTests();
      H.unloadMain();

      // Path B: remove, restart, then restore the folder from the removed view.
      H.writeJson(cfgFile(dir), startingConfig);
      H.writeJson(stateFile(dir), state);
      try { fs.rmSync(path.join(dir, 'config.library.json'), { force: true }); } catch {}
      const removeRun = H.loadMain(dir);
      removeRun.__test.loadConfig();
      removeRun.__test.setLiveFolderState(state);
      await removeRun.invoke('library-remove-many', [{ id: library.idFor(root), path: root, type: 'folder' }]);
      removeRun.__test.flushLibraryWriter();
      removeRun.__test.disposeForTests();
      H.unloadMain();

      const restoreRun = H.loadMain(dir);
      restoreRun.__test.loadConfig();
      await restoreRun.invoke('library-restore', [root]);
      const afterRestore = snapshot(restoreRun.__test.getConfig());

      assert.deepStrictEqual(
        afterRestore.pool, afterUndo.pool,
        'the same removal undone two ways left two different libraries',
      );
      assert.deepStrictEqual(
        afterRestore.slots, afterUndo.slots,
        'the same removal undone two ways left the monitors in two different states',
      );
    });

  // --- 3. overlapping watched roots are one card, not two --------------------

  await test('a subfolder reachable through two watched roots is one removed card',
    async (dir) => {
      const outer = path.join(dir, 'pics');
      const inner = path.join(outer, 'nested');
      const sub = path.join(inner, 'trip');
      const photo = H.writeImage(path.join(sub, 'a.png'));

      H.writeJson(cfgFile(dir), {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: {
          [library.idFor(outer)]: poolItem('folder', outer),
          [library.idFor(inner)]: poolItem('folder', inner),
        },
      });
      // The same physical subfolder is indexed under both roots.
      const state = indexRoots([
        { root: outer, files: [photo] },
        { root: inner, files: [photo] },
      ]);
      H.writeJson(stateFile(dir), state);

      const m = H.loadMain(dir);
      m.__test.loadConfig();
      m.__test.setLiveFolderState(state);

      await m.invoke('library-remove-many', [{ id: '', path: sub, type: 'folder' }]);

      const removed = await removedPaths(m);
      const cards = removed.filter((p) => p === library.pathKey(sub));
      assert.strictEqual(cards.length, 1, `one removed subfolder produced ${cards.length} cards`);
    });

  // --- 5. a hidden subfolder stays hidden when its parent is opened ----------

  await test('opening the parent does not show the photos of a removed subfolder',
    async (dir) => {
      const root = path.join(dir, 'shots');
      const sub = path.join(root, 'trip');
      const inSub = H.writeImage(path.join(sub, 'a.png'));
      const inRoot = H.writeImage(path.join(root, 'b.png'));

      H.writeJson(cfgFile(dir), {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: { [library.idFor(root)]: poolItem('folder', root) },
      });
      const state = indexRoots([{ root, files: [inSub, inRoot] }]);
      H.writeJson(stateFile(dir), state);

      const m = H.loadMain(dir);
      m.__test.loadConfig();
      m.__test.setLiveFolderState(state);
      await m.invoke('library-remove-many', [{ id: '', path: sub, type: 'folder' }]);

      // Walking straight into the removed subfolder must not hand its photos back.
      const entries = await m.invoke('folder-entries', sub);
      const shown = (entries.images || []).map((im) => library.pathKey(im.path || im));
      assert.ok(
        !shown.includes(library.pathKey(inSub)),
        'navigating into a removed subfolder listed the photos it was removed with',
      );

      const info = await m.invoke('folder-info', root);
      assert.strictEqual(
        info.count, 1,
        `the parent counts ${info.count} photos, but one of them is inside a removed subfolder`,
      );
    });

  console.log(`\n${failures.length ? `${failures.length} FAILED, ` : ''}${passed} provenance tests passed.\n`);
  if (failures.length) {
    for (const f of failures) {
      console.error(`\nFAILED: ${f.name}\n${f.err && f.err.stack}`);
      if (f.captured.length) console.error(`  main.js said:\n    ${f.captured.join('\n    ')}`);
    }
    process.exit(1);
  }
})();

function cfgTags(m, p) {
  const it = m.__test.getConfig().library[library.idFor(p)];
  return it ? it.tags : null;
}

// The part of the state the user would notice: which records exist with which metadata,
// and what each monitor plays. Ordering is normalised so the comparison is about
// content, not about the order two different code paths happened to write things in.
function snapshot(cfg) {
  const pool = Object.values(cfg.library || {})
    .map((it) => ({ path: library.pathKey(it.path), type: it.type, favorite: !!it.favorite, tags: (it.tags || []).slice().sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const slots = [];
  for (const [monitorId, monitor] of Object.entries(cfg.monitors || {})) {
    for (const theme of ['light', 'dark']) {
      const slot = monitor[theme];
      if (!slot || !Array.isArray(slot.itemIds)) continue;
      slots.push({
        monitorId,
        theme,
        itemIds: slot.itemIds.slice(),
        explicitEmpty: slot.legacyFallbackDisabled === true,
      });
    }
  }
  slots.sort((a, b) => `${a.monitorId}${a.theme}`.localeCompare(`${b.monitorId}${b.theme}`));
  return { pool, slots };
}
