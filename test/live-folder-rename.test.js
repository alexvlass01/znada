'use strict';

// LIB-024: a photo renamed or moved inside a watched folder keeps what the user gave it.
//
// Until this, the scan that noticed a rename was also the one that erased the photo's
// record: the star, the tags and its place on a monitor were gone, and a monitor where
// it stood alone was left with no wallpaper assigned (LIB-013, probes S4 and S7). These
// scenarios run the REAL main.js on a real folder on disk: the files are renamed with
// fs, exactly as Explorer would, and the library is asked to look again.
//
// Run: node test/live-folder-rename.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const libraryStore = require('../src/library-store');
const { pathKey } = require('../src/path-key');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = H.makeTempProfile('rename');
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

// Real files of different sizes: the size is part of what makes two files the same.
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
function writePhoto(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([PNG, Buffer.alloc(size, 7)]));
  return file;
}

const record = (p, extra = {}) => ({
  id: library.idFor(p), type: 'image', path: p, addedAt: 5000, favorite: false, tags: [], ...extra,
});

// A watched folder with a starred, tagged photo that also has its own places on a
// monitor: next to another photo in the light theme, ALONE in the dark one — the S7
// shape, where losing the record left the dark theme with nothing assigned.
async function setup(dir) {
  const root = path.join(dir, 'photos');
  const beach = writePhoto(path.join(root, 'beach.png'), 100);
  const city = writePhoto(path.join(root, 'city.png'), 200);
  writePhoto(path.join(root, 'plain.png'), 300);
  const rootId = library.idFor(root);
  const beachId = library.idFor(beach);
  const cityId = library.idFor(city);
  H.writeJson(path.join(dir, 'config.json'), {
    autoSwitch: false, style: 'fill',
    monitors: { M1: { light: { itemIds: [beachId, cityId] }, dark: { itemIds: [beachId] } } },
    slideshowIndex: { M1: { light: 0, dark: 0 } },
    slideshowCurrentPath: { M1: { light: city, dark: beach } },
  });
  H.writeJson(path.join(dir, 'config.library.json'), {
    version: 1, trash: [], library: {
      [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] },
      [beachId]: record(beach, {
        favorite: true, tags: ['sky', 'sea'], author: 'ann', source: 'https://example.org/post/1', aspect: 1.5,
      }),
      [cityId]: record(city),
    },
  });
  const m = H.loadMain(dir);
  m.__test.loadConfig();
  // The first look at the folder is its baseline: the index learns every file,
  // including its size, before anything is renamed.
  await m.invoke('library-refresh');
  return { m, root, beach, city, beachId, cityId };
}

const cfg = (m) => m.__test.getConfig();

// One photo can never be both in the library and removed from it.
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
  await test('a renamed photo keeps its star, tags, author, source and date', async (dir) => {
    const { m, root, beach, beachId } = await setup(dir);
    const renamed = path.join(root, 'beach-2026.png');
    fs.renameSync(beach, renamed);
    await m.invoke('library-refresh');
    const moved = cfg(m).library[library.idFor(renamed)];
    assert.ok(moved, 'the new name has a record');
    assert.ok(!cfg(m).library[beachId], 'the old name has none');
    assert.strictEqual(moved.favorite, true);
    assert.deepStrictEqual(moved.tags, ['sky', 'sea']);
    assert.strictEqual(moved.author, 'ann');
    assert.strictEqual(moved.source, 'https://example.org/post/1');
    assert.strictEqual(moved.addedAt, 5000);
    assert.strictEqual(moved.aspect, 1.5);
    assert.strictEqual(cfg(m).libraryTrash.length, 0, 'nothing was "removed"');
    assertNotActiveAndRemoved(m);
  });

  // LIB-027 (gate 03, 2026-10-09). The revision is how a recovery merge tells the user's
  // latest edit from an older copy. Restarting it at zero on the new name let a stale
  // tombstone for that name win the merge and delete the record.
  await test('a renamed photo keeps its revision, so a stale tombstone cannot win a merge', async (dir) => {
    const { m, root, beach, beachId } = await setup(dir);
    cfg(m).library[beachId].rev = 15;
    const renamed = path.join(root, 'beach-2026.png');
    fs.renameSync(beach, renamed);
    await m.invoke('library-refresh');
    const moved = cfg(m).library[library.idFor(renamed)];
    assert.ok(moved && moved.rev >= 15, `the revision went back to ${moved && moved.rev}`);
    const stale = { item: { ...moved, rev: 0 }, removedAt: 1, rev: 2 };
    const merged = libraryStore.mergePool({ library: { [moved.id]: moved }, trash: [] }, { trash: [stale] });
    assert.ok(merged.library[moved.id], 'an older tombstone for the new name deleted the record');
  });

  await test('...and keeps its places on the monitor, in the same order', async (dir) => {
    const { m, root, beach, cityId } = await setup(dir);
    const renamed = path.join(root, 'beach-2026.png');
    fs.renameSync(beach, renamed);
    await m.invoke('library-refresh');
    const newId = library.idFor(renamed);
    const slots = cfg(m).monitors.M1;
    assert.deepStrictEqual(slots.light.itemIds, [newId, cityId]);
    assert.deepStrictEqual(slots.dark.itemIds, [newId], 'the dark theme still has its photo');
    assert.ok(library.allowsLegacyFallback(slots.dark), 'the slot was never marked "empty on purpose"');
    assert.strictEqual(pathKey(cfg(m).slideshowCurrentPath.M1.dark), pathKey(renamed),
      'the slideshow keeps its place on the renamed photo');
    const playing = m.__test.resolvePlaylist('M1', 'dark').map(pathKey);
    assert.deepStrictEqual(playing, [pathKey(renamed)], 'the dark theme plays the renamed file');
  });

  await test('...and that survives a restart', async (dir) => {
    const { m, root, beach } = await setup(dir);
    const renamed = path.join(root, 'beach-2026.png');
    fs.renameSync(beach, renamed);
    await m.invoke('library-refresh');
    m.__test.flushLibraryWriter();
    H.unloadMain();
    const again = H.loadMain(dir);
    again.__test.loadConfig();
    const newId = library.idFor(renamed);
    const moved = again.__test.getConfig().library[newId];
    assert.ok(moved && moved.favorite === true && moved.tags.join() === 'sky,sea', 'record read back from disk');
    assert.deepStrictEqual(again.__test.getConfig().monitors.M1.dark.itemIds, [newId]);
  });

  await test('the pre-library fallback path follows the rename too', async (dir) => {
    const { m, root, beach } = await setup(dir);
    cfg(m).lightWallpaper = beach;
    const renamed = path.join(root, 'beach-2026.png');
    fs.renameSync(beach, renamed);
    await m.invoke('library-refresh');
    assert.strictEqual(pathKey(cfg(m).lightWallpaper), pathKey(renamed));
  });

  await test('a photo moved into a subfolder is followed the same way', async (dir) => {
    const { m, root, beach } = await setup(dir);
    const moved = path.join(root, 'sea', 'beach.png');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(beach, moved);
    await m.invoke('library-refresh');
    const it = cfg(m).library[library.idFor(moved)];
    assert.ok(it && it.favorite === true, 'the record moved with the file');
    assert.deepStrictEqual(cfg(m).monitors.M1.dark.itemIds, [it.id]);
  });

  await test('a renamed photo without a record keeps its place under "newest first"', async (dir) => {
    const { m, root } = await setup(dir);
    const listed = async (name) => (await m.invoke('expand-folders')).images
      .find((im) => path.basename(im.path) === name);
    const before = await listed('plain.png');
    fs.renameSync(path.join(root, 'plain.png'), path.join(root, 'plain-renamed.png'));
    await m.invoke('library-refresh');
    const after = await listed('plain-renamed.png');
    assert.ok(after, 'the renamed photo is listed');
    assert.strictEqual(after.addedAt, before.addedAt, 'with the date it was first found, not "now"');
  });

  // --- what is left exactly as it was ---------------------------------------------

  await test('a deleted photo still goes the way it always went', async (dir) => {
    const { m, beach, beachId } = await setup(dir);
    fs.unlinkSync(beach);
    await m.invoke('library-refresh');
    assert.ok(!cfg(m).library[beachId], 'the record of a deleted file is dropped, as before');
    assert.strictEqual(cfg(m).libraryTrash.length, 0);
    assert.deepStrictEqual(cfg(m).monitors.M1.dark.itemIds, []);
  });

  await test('renamed and copied at once: no guess, the old record goes as before', async (dir) => {
    const { m, root, beach, beachId } = await setup(dir);
    const a = path.join(root, 'beach-a.png');
    const b = path.join(root, 'beach-b.png');
    fs.copyFileSync(beach, b);
    // The case only means something if the copy is indistinguishable by size and time.
    const sa = fs.statSync(beach);
    const sb = fs.statSync(b);
    assert.ok(sa.size === sb.size && sa.mtimeMs === sb.mtimeMs, 'precondition: the copy looks identical');
    fs.renameSync(beach, a);
    await m.invoke('library-refresh');
    assert.ok(!cfg(m).library[beachId]);
    assert.ok(!cfg(m).library[library.idFor(a)] && !cfg(m).library[library.idFor(b)],
      'neither copy received the star');
  });

  await test('moved into a subfolder the user removed: the record does not follow', async (dir) => {
    const { m, root, beach } = await setup(dir);
    const removedDir = path.join(root, 'hidden');
    writePhoto(path.join(removedDir, 'old.png'), 400);
    await m.invoke('library-refresh');
    const res = await m.invoke('library-remove-many', [{ path: removedDir, id: '', type: 'folder' }]);
    assert.ok(res && !res.error, 'the subfolder was removed');
    const target = path.join(removedDir, 'beach.png');
    fs.renameSync(beach, target);
    await m.invoke('library-refresh');
    assert.ok(!cfg(m).library[library.idFor(target)], 'no record inside the removed subfolder');
    assertNotActiveAndRemoved(m);
  });

  await test('a new name that already has its own record is left alone', async (dir) => {
    const { m, root, beach, beachId } = await setup(dir);
    const renamed = path.join(root, 'beach-2026.png');
    fs.renameSync(beach, renamed);
    // A star given to the new card before the folder was looked at again.
    m.__test.addToPool('image', renamed, { tags: ['mine'] });
    await m.invoke('library-refresh');
    const it = cfg(m).library[library.idFor(renamed)];
    assert.deepStrictEqual(it.tags, ['mine'], 'its own record is not overwritten');
    assert.ok(!cfg(m).library[beachId], 'the old record goes as before');
  });

  if (failures.length) {
    for (const f of failures) {
      console.log(`\n--- ${f.name}\n${f.err && f.err.stack}`);
      if (f.captured.length) console.log(f.captured.slice(-15).join('\n'));
    }
    process.exit(1);
  }
  console.log(`\nAll ${passed} live-folder-rename tests passed.`);
})();
