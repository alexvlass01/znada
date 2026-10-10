'use strict';

// LIB-022 + LIB-023, through the REAL main.js and every route that adds a local photo:
// "Add photos…" in the Library, a drop on the Library, "Add photos…" on a monitor's
// theme card and a drop on that card.
//
//   LIB-022 — Znada's own copy is named after the original (`sunset-<hash>.png`), so the
//             photo can be found and sorted by its name; the same picture is still one
//             copy, an old `wp-<hash>` copy included.
//   LIB-023 — a file that a watched folder already shows is not copied: the record
//             points at the original, so the Library shows ONE card, with the date the
//             folder first saw the file.
//
// The claims are about files on disk and cards the window would draw, not about which
// helper was called.
//
// Run: node test/add-photo-main.test.js

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const folderState = require('../src/folder-state');
const { pathKey } = require('../src/path-key');

let passed = 0;
const failures = [];

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const bytes = (fill, size = 64) => Buffer.concat([PNG, Buffer.alloc(size, fill)]);
const hashOf = (buf) => crypto.createHash('md5').update(buf).digest('hex').slice(0, 16);
function writePhoto(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

const MONITOR = 'MONITOR-1';

// The four ways in. Each takes the files to add and returns what the handler said.
// The dialog routes are answered by the harness's open-dialog stub.
const ROUTES = {
  'Library: Add photos': (m, files, h) => { h.pick = files; return m.invoke('library-add-images'); },
  'Library: drop': (m, files) => m.invoke('library-add-paths', files),
  'Monitor: Add photos': (m, files, h) => { h.pick = files; return m.invoke('add-slot-images', MONITOR, 'light'); },
  'Monitor: drop': (m, files) => m.invoke('add-slot-paths', MONITOR, 'light', files),
};

async function test(name, fn) {
  const dir = H.makeTempProfile('add-photo');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-add-photo-src-'));
  const quiet = { log: console.log, error: console.error, warn: console.warn };
  console.error = () => {}; console.warn = () => {};
  try {
    const h = { pick: [] };
    const start = async (library0 = {}) => {
      H.writeJson(path.join(dir, 'config.json'), { autoSwitch: false, style: 'fill', monitors: {} });
      H.writeJson(path.join(dir, 'config.library.json'), { version: 1, library: library0, trash: [] });
      const m = H.loadMain(dir, { onOpenDialog: () => h.pick });
      m.__test.loadConfig();
      return m;
    };
    await fn({ dir, outside, h, start });
    console.error = quiet.error; console.warn = quiet.warn;
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error = quiet.error; console.warn = quiet.warn;
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n    ' + (err && err.message));
  } finally {
    console.error = quiet.error; console.warn = quiet.warn;
    try { H.unloadMain(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
  }
}

const cfg = (m) => m.__test.getConfig();
const copiesIn = (m) => {
  const root = m.__test.managedRoot().root;
  return fs.existsSync(root) ? fs.readdirSync(root).filter((n) => !n.startsWith('.')).sort() : [];
};
const images = (m) => Object.values(cfg(m).library).filter((it) => it.type === 'image');
const slotIds = (m) => ((cfg(m).monitors[MONITOR] || {}).light || {}).itemIds || [];

// Every card "All" would draw: the pool's photos plus the photos only a folder shows.
async function cards(m) {
  const { images: fromFolders } = await m.invoke('expand-folders');
  return [...images(m).map((it) => it.path), ...fromFolders.map((it) => it.path)];
}

// A watched folder with two photos, indexed once — the state of a profile that has had
// the folder for a while. The dates the folder first saw them are set far in the past,
// so "kept the folder's date" and "stamped now" cannot be confused.
async function withWatchedFolder(ctx) {
  const root = path.join(ctx.outside, 'Photos');
  const beach = writePhoto(path.join(root, 'beach.png'), bytes(1));
  const city = writePhoto(path.join(root, 'sub', 'city.png'), bytes(2));
  const rootId = library.idFor(root);
  const m = await ctx.start({
    [rootId]: { id: rootId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] },
  });
  await m.invoke('library-refresh');
  const state = JSON.parse(JSON.stringify(m.__test.getLiveFolderState()));
  for (const folder of Object.values(state.folders)) {
    for (const file of Object.values(folder.files)) file.firstSeenAt = 1000;
  }
  m.__test.setLiveFolderState(state);
  return { m, root, beach, city };
}

console.log('\nLIB-022: the copy carries the original name\n');

(async () => {
  for (const [route, add] of Object.entries(ROUTES)) {
    await test(`${route}: the copy is <name>-<hash>, and the photo is found by its name`, async (ctx) => {
      const m = await ctx.start();
      const buf = bytes(3);
      const src = writePhoto(path.join(ctx.outside, 'sunset.png'), buf);
      const res = await add(m, [src], ctx.h);
      assert.strictEqual(res.added, 1);
      assert.deepStrictEqual(copiesIn(m), [`sunset-${hashOf(buf)}.png`]);
      const [rec] = images(m);
      assert.strictEqual(path.basename(rec.path), `sunset-${hashOf(buf)}.png`);
      assert.ok(fs.readFileSync(rec.path).equals(buf), 'the copy holds the original bytes');
      if (route.startsWith('Monitor')) assert.deepStrictEqual(slotIds(m), [rec.id], 'and it is on the monitor');
    });

    await test(`${route}: the same picture added twice, under another name too, is one copy`, async (ctx) => {
      const m = await ctx.start();
      const buf = bytes(4);
      const first = writePhoto(path.join(ctx.outside, 'sunset.png'), buf);
      const again = writePhoto(path.join(ctx.outside, 'copy of sunset.png'), buf);
      await add(m, [first], ctx.h);
      await add(m, [first], ctx.h);
      await add(m, [again], ctx.h);
      assert.deepStrictEqual(copiesIn(m), [`sunset-${hashOf(buf)}.png`], 'one file');
      assert.strictEqual(images(m).length, 1, 'one record');
    });

    await test(`${route}: an old wp-<hash> copy of the same picture is reused, not doubled`, async (ctx) => {
      const buf = bytes(5);
      const m = await ctx.start();
      const root = m.__test.managedRoot().root;
      const old = writePhoto(path.join(root, `wp-${hashOf(buf)}.png`), buf);
      const oldId = library.idFor(old);
      cfg(m).library[oldId] = { id: oldId, type: 'image', path: old, addedAt: 1, favorite: true, tags: ['sea'] };
      await add(m, [writePhoto(path.join(ctx.outside, 'sunset.png'), buf)], ctx.h);
      assert.deepStrictEqual(copiesIn(m), [`wp-${hashOf(buf)}.png`], 'no second file');
      assert.strictEqual(images(m).length, 1, 'no second record');
      assert.strictEqual(cfg(m).library[oldId].favorite, true, 'the old record keeps its star');
    });
  }

  await test('a name with Cyrillic and characters Windows refuses gives a working copy', async (ctx) => {
    const m = await ctx.start();
    const buf = bytes(6);
    const src = writePhoto(path.join(ctx.outside, 'Закат над морем.png'), buf);
    await m.invoke('library-add-paths', [src]);
    assert.deepStrictEqual(copiesIn(m), [`Закат над морем-${hashOf(buf)}.png`]);
    // The forbidden characters cannot exist in a real Windows file name, so the drop
    // route — which reads the file first — never sees them; the cleaning is covered by
    // test/photo-import.test.js on the name alone.
  });

  await test('a user file under the exact copy name with other content is never overwritten or reused', async (ctx) => {
    const m = await ctx.start();
    const buf = bytes(7);
    const root = m.__test.managedRoot().root;
    const theirs = writePhoto(path.join(root, `sunset-${hashOf(buf)}.png`), Buffer.from('not this picture'));
    const res = await m.invoke('library-add-paths', [writePhoto(path.join(ctx.outside, 'sunset.png'), buf)]);
    assert.strictEqual(res.added, 0, 'the add is refused');
    assert.strictEqual(fs.readFileSync(theirs, 'utf8'), 'not this picture', 'their file is untouched');
    assert.strictEqual(images(m).length, 0, 'and no record names it as the photo');
  });

  await test('moving the folder of copies (DATA-006) carries the new names', async (ctx) => {
    const m = await ctx.start();
    const one = bytes(8);
    const two = bytes(9);
    await m.invoke('library-add-paths', [
      writePhoto(path.join(ctx.outside, 'Закат.png'), one),
      writePhoto(path.join(ctx.outside, 'beach day.png'), two),
    ]);
    const chosen = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-add-photo-move-'));
    try {
      const report = await m.__test.moveManagedFolder(chosen);
      assert.strictEqual(report.status, 'done', `move status: ${report.status} ${report.error || ''}`);
      const names = images(m).map((it) => path.basename(it.path)).sort();
      assert.deepStrictEqual(names, [`beach day-${hashOf(two)}.png`, `Закат-${hashOf(one)}.png`].sort());
      for (const it of images(m)) {
        assert.ok(it.path.startsWith(chosen), 'the record names the new place');
        assert.ok(fs.existsSync(it.path), 'and the file is there');
      }
    } finally {
      fs.rmSync(chosen, { recursive: true, force: true });
    }
  });

  console.log('\nLIB-023: a photo a watched folder already shows is one card\n');

  for (const [route, add] of Object.entries(ROUTES)) {
    await test(`${route}: no copy, the record points at the original, one card`, async (ctx) => {
      const { m, beach, city } = await withWatchedFolder(ctx);
      assert.strictEqual((await cards(m)).length, 2, 'setup: two photos, two cards');
      const res = await add(m, [beach], ctx.h);
      assert.deepStrictEqual(copiesIn(m), [], 'nothing was copied');
      const rec = cfg(m).library[library.idFor(beach)];
      assert.ok(rec, 'the record is the original\'s');
      assert.strictEqual(pathKey(rec.path), pathKey(beach));
      assert.strictEqual(res.added, 1, 'the add still reports it, like any other');
      const all = await cards(m);
      assert.strictEqual(all.length, 2, `two photos must stay two cards, got ${all.length}`);
      assert.strictEqual(new Set(all.map(pathKey)).size, 2);
      assert.strictEqual(rec.addedAt, 1000, 'it keeps the date the folder first saw it');
      if (route.startsWith('Monitor')) assert.deepStrictEqual(slotIds(m), [rec.id], 'and it is on the monitor');
      // A deeper file is the same case.
      await add(m, [city], ctx.h);
      assert.deepStrictEqual(copiesIn(m), []);
      assert.strictEqual((await cards(m)).length, 2);
    });
  }

  await test('a photo the user removed, added again, comes back as itself, not as a copy', async (ctx) => {
    const { m, beach } = await withWatchedFolder(ctx);
    await m.invoke('library-remove-many', [{ path: beach }]);
    assert.ok(m.__test.hiddenPathSet().has(pathKey(beach)), 'setup: it was removed');
    assert.strictEqual((await cards(m)).length, 1);
    await m.invoke('library-add-paths', [beach]);
    assert.deepStrictEqual(copiesIn(m), [], 'nothing was copied');
    assert.ok(!m.__test.hiddenPathSet().has(pathKey(beach)), 'it is no longer removed');
    const all = await cards(m);
    assert.strictEqual(all.length, 2, `back to two cards, got ${all.length}`);
  });

  await test('a file in a subfolder the user removed is still copied, as before', async (ctx) => {
    const { m, root, city } = await withWatchedFolder(ctx);
    await m.invoke('library-remove-many', [{ id: '', path: path.join(root, 'sub'), type: 'folder' }]);
    assert.ok(folderState.listHiddenDirs(m.__test.getLiveFolderState())
      .some((d) => pathKey(d.path) === pathKey(path.join(root, 'sub'))), 'setup: the subfolder was removed');
    await m.invoke('library-add-paths', [city]);
    assert.strictEqual(copiesIn(m).length, 1, 'a copy was made');
  });

  await test('a file outside every watched folder is copied, as before', async (ctx) => {
    const { m } = await withWatchedFolder(ctx);
    const buf = bytes(10);
    await m.invoke('library-add-paths', [writePhoto(path.join(ctx.outside, 'Elsewhere', 'tree.png'), buf)]);
    assert.deepStrictEqual(copiesIn(m), [`tree-${hashOf(buf)}.png`]);
  });

  await test('a sibling folder whose name only starts the same is not the watched folder', async (ctx) => {
    const { m } = await withWatchedFolder(ctx);
    const buf = bytes(11);
    await m.invoke('library-add-paths', [writePhoto(path.join(ctx.outside, 'Photos2', 'tree.png'), buf)]);
    assert.deepStrictEqual(copiesIn(m), [`tree-${hashOf(buf)}.png`]);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`\n✗ ${f.name}\n${f.err && f.err.stack}`);
    process.exit(1);
  }
})();
