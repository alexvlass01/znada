'use strict';

// LIB-025: a photo the user removed from the library stays removed after it is renamed
// or moved inside its watched folder in Explorer.
//
// Before this, the "removed" mark stayed on the old name, the renamed file was a new
// file to the index, and it came straight back into "All" (found while doing LIB-024,
// confirmed on the real main.js). The kept record — star, tags, places on the monitors —
// sat in the trash under the old name, so even restoring the new card brought it back
// blank. These scenarios run the REAL main.js on a real folder on disk; files are
// renamed with fs, exactly as Explorer would.
//
// Run: node test/live-folder-rename-removed.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const { pathKey } = require('../src/path-key');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = H.makeTempProfile('rename-removed');
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

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
function writePhoto(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([PNG, Buffer.alloc(size, 7)]));
  return file;
}

const record = (p, extra = {}) => ({
  id: library.idFor(p), type: 'image', path: p, addedAt: 5000, favorite: false, tags: [], ...extra,
});

// The LIB-024 folder: beach is starred, tagged and has its own places on a monitor
// (next to city in the light theme, alone in the dark one); plain has no record.
async function setup(dir) {
  const root = path.join(dir, 'photos');
  const beach = writePhoto(path.join(root, 'beach.png'), 100);
  const city = writePhoto(path.join(root, 'city.png'), 200);
  const plain = writePhoto(path.join(root, 'plain.png'), 300);
  const rootId = library.idFor(root);
  const beachId = library.idFor(beach);
  const cityId = library.idFor(city);
  H.writeJson(path.join(dir, 'config.json'), {
    autoSwitch: false, style: 'fill',
    monitors: { M1: { light: { itemIds: [beachId, cityId] }, dark: { itemIds: [beachId] } } },
  });
  H.writeJson(path.join(dir, 'config.library.json'), {
    version: 1, trash: [], library: {
      [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] },
      [beachId]: record(beach, { favorite: true, tags: ['sky', 'sea'], author: 'ann' }),
      [cityId]: record(city),
    },
  });
  const m = H.loadMain(dir);
  m.__test.loadConfig();
  await m.invoke('library-refresh');
  return { m, root, beach, plain, beachId, cityId };
}

const cfg = (m) => m.__test.getConfig();
const shownInAll = async (m) => {
  const fromFolders = (await m.invoke('expand-folders')).images.map((im) => pathKey(im.path));
  const fromPool = Object.values(cfg(m).library).filter((it) => it.type === 'image').map((it) => pathKey(it.path));
  return new Set([...fromFolders, ...fromPool]);
};
const removedCards = async (m) => (await m.invoke('library-hidden-list')).images.map((im) => pathKey(im.path));

function assertNotActiveAndRemoved(m) {
  const removed = m.__test.hiddenPathSet();
  for (const it of Object.values(cfg(m).library)) {
    assert.ok(!removed.has(pathKey(it.path)), `active and removed at once: ${it.path}`);
  }
  for (const entry of cfg(m).libraryTrash) {
    assert.ok(!cfg(m).library[entry.item.id], `in the library and in the trash: ${entry.item.path}`);
  }
}

(async () => {
  console.log('\nLIB-025: a removed photo stays removed after a rename\n');

  await test('a removed photo without a record stays out of "All" under its new name', async (dir) => {
    const { m, root, plain } = await setup(dir);
    await m.invoke('library-remove-many', [{ path: plain }]);
    const renamed = path.join(root, 'plain-renamed.png');
    fs.renameSync(plain, renamed);
    await m.invoke('library-refresh');
    const all = await shownInAll(m);
    assert.ok(!all.has(pathKey(renamed)), 'the renamed file came back into "All"');
    assert.ok(m.__test.hiddenPathSet().has(pathKey(renamed)), 'the new name carries the removed mark');
    assert.deepStrictEqual(await removedCards(m), [pathKey(renamed)], '"Removed" shows one card, by its new name');
    assertNotActiveAndRemoved(m);
  });

  await test('...and "Restore" on that card brings it back', async (dir) => {
    const { m, root, plain } = await setup(dir);
    await m.invoke('library-remove-many', [{ path: plain }]);
    const renamed = path.join(root, 'plain-renamed.png');
    fs.renameSync(plain, renamed);
    await m.invoke('library-refresh');
    const res = await m.invoke('library-restore', [renamed]);
    assert.strictEqual(res.restored, 1);
    assert.ok((await shownInAll(m)).has(pathKey(renamed)));
    assert.deepStrictEqual(await removedCards(m), []);
  });

  await test('a removed starred photo: stays removed, and "Restore" brings back its star, tags and places', async (dir) => {
    const { m, root, beach, beachId, cityId } = await setup(dir);
    await m.invoke('library-remove-many', [{ id: beachId, path: beach }]);
    assert.ok(!cfg(m).library[beachId], 'setup: the record went to the trash');
    const renamed = path.join(root, 'beach-2026.png');
    fs.renameSync(beach, renamed);
    await m.invoke('library-refresh');
    const newId = library.idFor(renamed);
    assert.ok(!(await shownInAll(m)).has(pathKey(renamed)), 'it came back into "All"');
    assert.deepStrictEqual(await removedCards(m), [pathKey(renamed)], 'one card in "Removed", by its new name');
    const kept = cfg(m).libraryTrash.find((e) => e.item.id === newId);
    assert.ok(kept && pathKey(kept.item.path) === pathKey(renamed), 'the kept record names the new file');
    assertNotActiveAndRemoved(m);

    const res = await m.invoke('library-restore', [renamed]);
    assert.strictEqual(res.restored, 1);
    const back = cfg(m).library[newId];
    assert.ok(back, 'the record is back, under the new name');
    assert.strictEqual(back.favorite, true);
    assert.deepStrictEqual(back.tags, ['sky', 'sea']);
    assert.strictEqual(back.author, 'ann');
    assert.deepStrictEqual(cfg(m).monitors.M1.light.itemIds, [newId, cityId], 'its place in the light theme');
    assert.deepStrictEqual(cfg(m).monitors.M1.dark.itemIds, [newId], 'and in the dark one');
    assert.strictEqual(cfg(m).libraryTrash.length, 0);
    assertNotActiveAndRemoved(m);
  });

  await test('Undo after the rename brings the photo back under its new name, with everything', async (dir) => {
    const { m, root, beach, beachId, cityId } = await setup(dir);
    const removal = await m.invoke('library-remove-many', [{ id: beachId, path: beach }]);
    const renamed = path.join(root, 'beach-2026.png');
    fs.renameSync(beach, renamed);
    await m.invoke('library-refresh');
    const res = await m.invoke('library-undo-remove', removal.undo && removal.undo.token);
    assert.ok(!res.error, `undo failed: ${res.error}`);
    const newId = library.idFor(renamed);
    const back = cfg(m).library[newId];
    assert.ok(back && back.favorite === true && back.tags.join() === 'sky,sea', 'the record came back');
    assert.ok(!cfg(m).library[beachId], 'no record under the old name');
    assert.deepStrictEqual(cfg(m).monitors.M1.light.itemIds, [newId, cityId]);
    assert.deepStrictEqual(cfg(m).monitors.M1.dark.itemIds, [newId]);
    assert.ok((await shownInAll(m)).has(pathKey(renamed)), 'shown in "All"');
    assert.deepStrictEqual(await removedCards(m), [], 'and nothing left in "Removed"');
    assertNotActiveAndRemoved(m);
  });

  await test('moved into a subfolder: the same, the mark follows', async (dir) => {
    const { m, root, plain } = await setup(dir);
    await m.invoke('library-remove-many', [{ path: plain }]);
    const moved = path.join(root, 'sea', 'plain.png');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(plain, moved);
    await m.invoke('library-refresh');
    assert.ok(!(await shownInAll(m)).has(pathKey(moved)));
    assert.deepStrictEqual(await removedCards(m), [pathKey(moved)]);
  });

  await test('the new mark is on disk at once, and survives a restart', async (dir) => {
    const { m, root, beach, beachId } = await setup(dir);
    await m.invoke('library-remove-many', [{ id: beachId, path: beach }]);
    const renamed = path.join(root, 'beach-2026.png');
    fs.renameSync(beach, renamed);
    await m.invoke('library-refresh');
    // No timer flush: the removed mark must not wait for the five-second debounce.
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'folder-state.json'), 'utf8'));
    const files = Object.values(index.folders).flatMap((f) => Object.values(f.files));
    const entry = files.find((f) => f.relativePath === 'beach-2026.png');
    assert.ok(entry && entry.hidden === true, 'the index on disk does not yet know the new name is removed');
    m.__test.flushLibraryWriter();
    H.unloadMain();
    const again = H.loadMain(dir);
    again.__test.loadConfig();
    again.__test.loadLiveFolderState();
    await again.invoke('library-refresh');
    assert.ok(!(await shownInAll(again)).has(pathKey(renamed)), 'it came back after a restart');
    const kept = again.__test.getConfig().libraryTrash.find((e) => e.item.id === library.idFor(renamed));
    assert.ok(kept && kept.item.favorite === true, 'the kept record, read back from disk, names the new file');
  });

  await test('an active record already at the new name wins: shown, not removed at once', async (dir) => {
    const { m, root, plain } = await setup(dir);
    await m.invoke('library-remove-many', [{ path: plain }]);
    const renamed = path.join(root, 'plain-renamed.png');
    fs.renameSync(plain, renamed);
    // A star given to the new name before the folder was looked at again.
    m.__test.addToPool('image', renamed, { tags: ['mine'] });
    await m.invoke('library-refresh');
    assert.ok(cfg(m).library[library.idFor(renamed)], 'its record stays');
    assert.ok(!m.__test.hiddenPathSet().has(pathKey(renamed)), 'and it is not marked removed');
    assertNotActiveAndRemoved(m);
  });

  // LIB-027 (gate 03, 2026-10-09). The new name already had an active record, so the
  // active record wins — and the kept record of the old name named a file that is now
  // that active photo. Left behind, "Removed" showed a card for a file that is gone.
  await test('an active record at the new name wins, and no kept record is left for the old name', async (dir) => {
    const { m, root, beach, beachId } = await setup(dir);
    await m.invoke('library-remove-many', [{ id: beachId, path: beach }]);
    const renamed = path.join(root, 'beach-2026.png');
    fs.renameSync(beach, renamed);
    m.__test.addToPool('image', renamed, { tags: ['mine'] });
    await m.invoke('library-refresh');
    assert.ok(cfg(m).library[library.idFor(renamed)], 'the active record stays');
    assert.ok(!cfg(m).libraryTrash.some((e) => pathKey(e.item.path) === pathKey(beach)),
      'a kept record still names the file that is gone');
    assert.deepStrictEqual(await removedCards(m), [], '"Removed" shows a card for a file that does not exist');
    assertNotActiveAndRemoved(m);
  });

  // LIB-027. The new name already had a kept record — an earlier photo there was removed
  // and its file deleted. One record per name, and the one that follows the file wins.
  await test('renamed onto a name with an older kept record: one record, the one that moved', async (dir) => {
    const { m, beach, beachId, plain } = await setup(dir);
    m.__test.addToPool('image', plain, { tags: ['old'] });
    await m.invoke('library-remove-many', [{ id: library.idFor(plain), path: plain }]);
    const older = cfg(m).libraryTrash.find((e) => pathKey(e.item.path) === pathKey(plain));
    assert.ok(older, 'setup: the older photo is kept');
    fs.rmSync(plain);
    await m.invoke('library-refresh');
    await m.invoke('library-remove-many', [{ id: beachId, path: beach }]);
    fs.renameSync(beach, plain);
    await m.invoke('library-refresh');
    const kept = cfg(m).libraryTrash.filter((e) => pathKey(e.item.path) === pathKey(plain));
    assert.strictEqual(kept.length, 1, `${kept.length} kept records under one name`);
    assert.strictEqual(kept[0].item.favorite, true, 'the record that stayed is not the one that moved');
    assert.ok(library.revOf(kept[0]) > library.revOf(older), 'the moved record is not newer than the one it replaced');
    const res = await m.invoke('library-restore', [plain]);
    assert.strictEqual(res.restored, 1);
    assert.deepStrictEqual(cfg(m).library[library.idFor(plain)].tags, ['sky', 'sea']);
  });

  // --- what is left exactly as it was ---------------------------------------------

  await test('a photo that was not removed is not marked removed by a rename', async (dir) => {
    const { m, root, plain } = await setup(dir);
    const renamed = path.join(root, 'plain-renamed.png');
    fs.renameSync(plain, renamed);
    await m.invoke('library-refresh');
    assert.ok((await shownInAll(m)).has(pathKey(renamed)));
    assert.deepStrictEqual(await removedCards(m), []);
  });

  await test('a removed photo that is deleted leaves its kept record as it was', async (dir) => {
    const { m, beach, beachId } = await setup(dir);
    await m.invoke('library-remove-many', [{ id: beachId, path: beach }]);
    fs.unlinkSync(beach);
    await m.invoke('library-refresh');
    const kept = cfg(m).libraryTrash.find((e) => e.item.id === beachId);
    assert.ok(kept && pathKey(kept.item.path) === pathKey(beach), 'the kept record is untouched');
  });

  await test('two identical copies after a rename: no guess, neither copy is marked removed', async (dir) => {
    const { m, root, plain } = await setup(dir);
    await m.invoke('library-remove-many', [{ path: plain }]);
    const a = path.join(root, 'plain-a.png');
    const b = path.join(root, 'plain-b.png');
    fs.copyFileSync(plain, b);
    const sa = fs.statSync(plain);
    const sb = fs.statSync(b);
    assert.ok(sa.size === sb.size && sa.mtimeMs === sb.mtimeMs, 'precondition: the copy looks identical');
    fs.renameSync(plain, a);
    await m.invoke('library-refresh');
    const hidden = m.__test.hiddenPathSet();
    assert.ok(!hidden.has(pathKey(a)) && !hidden.has(pathKey(b)),
      'the mark went to neither copy: attaching it to the wrong one is a wrong answer');
  });

  if (failures.length) {
    for (const f of failures) {
      console.log(`\n--- ${f.name}\n${f.err && f.err.stack}`);
      if (f.captured.length) console.log(f.captured.slice(-15).join('\n'));
    }
    process.exit(1);
  }
  console.log(`\nAll ${passed} live-folder-rename-removed tests passed.`);
})();
