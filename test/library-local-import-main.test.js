'use strict';

// Baseline for the local-import command boundary. Real main/IPC, stores and IO;
// Electron and system children alone are stubbed by the shared harness.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const L = require('../src/library');

function setup(dir) {
  const root = path.join(dir, 'свои фото с пробелом');
  const a = H.writeImage(path.join(root, 'a.png'));
  const b = H.writeImage(path.join(root, 'b.png'));
  const aId = L.idFor(a), bId = L.idFor(b), folderId = L.idFor(root);
  H.writeJson(path.join(dir, 'config.json'), {
    autoSwitch: false, separateThemes: true, style: 'fill', gameModeBlock: false,
    wallpaperSchedule: { mode: 'off' }, themeSchedule: { mode: 'off' },
    monitors: { M1: { light: { itemIds: [] }, dark: { itemIds: [], explicitEmpty: true } } },
  });
  H.writeJson(path.join(dir, 'config.library.json'), { version: 1, trash: [], library: {
    [folderId]: { id: folderId, type: 'folder', path: root, addedAt: 1 },
    [aId]: { id: aId, type: 'image', path: a, addedAt: 2, tags: ['sea'], rev: 10 },
  } });
  const pick = { files: [] };
  const m = H.loadMain(dir, { onOpenDialog: () => pick.files });
  m.__test.loadConfig();
  return { m, pick, root, a, b, aId, bId, folderId };
}
const pool = dir => JSON.parse(fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8'));
const settings = dir => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
function reload(dir) {
  H.unloadMain();
  const m = H.loadMain(dir); m.__test.loadConfig(); m.__test.loadLiveFolderState();
  return m;
}
async function writesDuring(dir, fn) {
  const original = fs.renameSync;
  const writes = [];
  fs.renameSync = (from, to) => {
    if ([path.join(dir, 'config.json'), path.join(dir, 'config.library.json')].includes(path.resolve(to))) {
      writes.push(path.basename(to));
    }
    return original(from, to);
  };
  try { return { result: await fn(), writes }; }
  finally { fs.renameSync = original; }
}
let checks = 0;
async function check(name, fn) {
  const dir = H.makeTempProfile('local-import-main');
  try { await fn(dir); checks++; console.log(`PASS ${name}`); }
  finally { H.unloadMain(); }
}

(async () => {
  for (const dialog of [false, true]) {
    const route = dialog ? 'dialog' : 'drop';
    await check(`${route}: library imports count pool growth, retain metadata and persist revival`, async dir => {
      const { m, pick, a, b, aId, bId } = setup(dir);
      const cfg = m.__test.getConfig();
      cfg.libraryTrash = [{ item: { ...cfg.library[aId] }, rev: 100, removedAt: 1 }];
      m.__test.saveConfig();
      const add = async files => {
        pick.files = files;
        return dialog ? m.invoke('library-add-images') : m.invoke('library-add-paths', files);
      };
      const first = await add([a, a, b, path.join(dir, 'missing.png')]);
      assert.strictEqual(first.added, 1);
      assert.deepStrictEqual(first.config.library[aId].tags, ['sea']);
      assert.ok(first.config.library[aId].rev > 100);
      assert.ok(pool(dir).library[bId]);
      assert.deepStrictEqual(pool(dir).trash, []);
      const repeat = await writesDuring(dir, () => add([a, b]));
      assert.strictEqual(repeat.result.added, 0);
      assert.deepStrictEqual(repeat.writes, [], 'clean existing library import must not save');
      const saved = reload(dir).__test.getConfig();
      assert.ok(saved.library[bId]);
      assert.deepStrictEqual(saved.library[aId].tags, ['sea']);
      assert.deepStrictEqual(saved.libraryTrash, []);
    });

    await check(`${route}: legacy counts slot additions and fully saves clean existing records`, async dir => {
      const { m, pick, a, aId } = setup(dir);
      await m.invoke('library-refresh'); m.__test.saveConfig();
      const add = async files => {
        pick.files = files;
        return dialog ? m.invoke('add-slot-images', 'M1', 'dark')
          : m.invoke('add-slot-paths', 'M1', 'dark', files);
      };
      const first = await writesDuring(dir, () => add([a, a]));
      assert.strictEqual(first.result.added, 1, 'added means slot membership, not pool growth');
      assert.ok(first.writes.includes('config.library.json'), 'legacy must fully save even an existing clean item');
      assert.deepStrictEqual(settings(dir).monitors.M1.dark.itemIds, [aId]);
      assert.ok(!settings(dir).monitors.M1.dark.explicitEmpty);
      const repeat = await writesDuring(dir, () => add([a]));
      assert.strictEqual(repeat.result.added, 0);
      if (!dialog) assert.deepStrictEqual(repeat.writes, []);
      else assert.ok(repeat.writes.includes('config.library.json'), 'dialog retains unconditional save');
      assert.deepStrictEqual(reload(dir).__test.getConfig().monitors.M1.dark.itemIds, [aId]);
    });
  }

  for (const slot of [false, true]) {
    await check(`${slot ? 'slot' : 'library'} drop: folder repeated, invalid paths and video policy`, async dir => {
      const { m, root, folderId } = setup(dir);
      const video = path.join(dir, 'movie.mp4'); fs.writeFileSync(video, Buffer.alloc(12, 3));
      const unsupported = path.join(dir, 'no.txt'); fs.writeFileSync(unsupported, 'private');
      const result = slot
        ? await m.invoke('add-slot-paths', 'M1', 'dark', [null, 'relative', unsupported, root, root, video])
        : await m.invoke('library-add-paths', [null, 'relative', unsupported, root, root, video]);
      assert.strictEqual(result.added, 1);
      assert.strictEqual(await m.invoke('file-url', unsupported), '');
      if (slot) {
        assert.strictEqual(result.videos, 1);
        assert.strictEqual(await m.invoke('file-url', video), '');
        assert.deepStrictEqual(settings(dir).monitors.M1.dark.itemIds, [folderId]);
      } else {
        const item = Object.values(pool(dir).library).find(it => it.path.endsWith('.mp4'));
        assert.ok(item); assert.strictEqual(item.type, 'image', 'video keeps the existing record schema');
        assert.ok(await m.invoke('file-url', video));
      }
    });
  }

  await check('folder dialog preserves pool delta, revival and legacy unconditional save', async dir => {
    const { m, pick, root, folderId } = setup(dir);
    pick.files = [root];
    const cfg = m.__test.getConfig();
    cfg.libraryTrash = [{ item: { ...cfg.library[folderId] }, rev: 100, removedAt: 1 }];
    m.__test.saveConfig();
    const result = await m.invoke('library-add-folder');
    assert.strictEqual(result.added, 0);
    assert.deepStrictEqual(pool(dir).trash, []);
    assert.ok(pool(dir).library[folderId].rev > 100);
    const repeated = await writesDuring(dir, () => m.invoke('library-add-folder'));
    assert.deepStrictEqual(repeated.writes, []);
    const legacy = await writesDuring(dir, () => m.invoke('add-slot-folder', 'M1', 'dark'));
    assert.strictEqual(legacy.result.added, 1);
    assert.ok(legacy.writes.includes('config.library.json'));
    assert.deepStrictEqual(reload(dir).__test.getConfig().monitors.M1.dark.itemIds, [folderId]);
  });

  await check('await retains batch snapshots, latest config and lock through failed/duplicate imports', async dir => {
    const { m, b, aId, bId } = setup(dir);
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const stat = fs.promises.stat;
    fs.promises.stat = async (...args) => {
      if (args[0] === b) { started(); await gate; }
      return stat(...args);
    };
    try {
      const pending = m.invoke('library-add-paths', [b, b]);
      await entered;
      const old = m.__test.getConfig();
      await m.invoke('set-config', { viewerBackground: 'charcoal' });
      assert.notStrictEqual(m.__test.getConfig(), old);
      // Model unlocked missing-live-file pruning during IO. The command's public
      // count is NET batch growth, even though this import creates one new record.
      delete m.__test.getConfig().library[aId];
      let queued = false;
      const next = m.__test.withLibraryLock(() => { queued = true; });
      await Promise.resolve(); assert.strictEqual(queued, false);
      release();
      const result = await pending; await next;
      assert.strictEqual(result.added, 0, 'per-record created sums change the batch contract');
      assert.strictEqual(result.config, m.__test.getConfig());
      assert.strictEqual(result.config.viewerBackground, 'charcoal');
      assert.ok(result.config.library[bId]);
      // BUG-067: net zero, yet b was created — the save must follow the change, not the size.
      assert.ok(pool(dir).library[bId], 'a created record is saved although the pool did not grow');
    } finally { release(); fs.promises.stat = stat; }
  });

  // BUG-067. Real pruning (library-refresh outside the import lock) shrinks the pool while
  // an import waits on IO; the NET growth of that import is then zero. Both import routes
  // that await between pool writes are covered: drag-and-drop and the photo dialog.
  for (const dialog of [false, true]) {
    await check(`${dialog ? 'dialog' : 'drop'}: real pruning during import keeps the new record after reload`, async dir => {
      const { m, pick, a, b, aId, bId } = setup(dir);
      await m.invoke('library-refresh'); m.__test.saveConfig();
      let release, started, held = false;
      const gate = new Promise(resolve => { release = resolve; });
      const entered = new Promise(resolve => { started = resolve; });
      const stat = fs.promises.stat;
      fs.promises.stat = async (...args) => {
        if (args[0] === b && !held) { held = true; started(); await gate; }
        return stat(...args);
      };
      try {
        pick.files = [b];
        const pending = dialog ? m.invoke('library-add-images') : m.invoke('library-add-paths', [b]);
        await entered;
        fs.unlinkSync(a); // only this test's disposable source
        await m.invoke('library-refresh');
        assert.ok(!m.__test.getConfig().library[aId], 'real refresh must prune the missing source');
        assert.ok(!pool(dir).library[aId], 'pruning saves before import completes');
        release();
        const result = await pending;
        assert.strictEqual(result.added, 0, 'the response keeps net batch growth');
        assert.ok(result.config.library[bId], 'import succeeds in memory');
        assert.ok(pool(dir).library[bId], 'the created record reaches the disk');
        const saved = reload(dir).__test.getConfig();
        assert.ok(saved.library[bId], 'the new record survives a restart');
        assert.ok(!saved.library[aId], 'and the pruning is not undone');
      } finally { release(); fs.promises.stat = stat; }
    });
  }

  for (const slot of [false, true]) {
    await check(`${slot ? 'slot' : 'library'}: refused drop folder gains no authority; dialog retains its grant`, async dir => {
      const { m, pick } = setup(dir);
      const root = path.join(dir, 'refused directory');
      const child = H.writeImage(path.join(root, 'private.png'));
      const addPath = L.addPath;
      L.addPath = (lib, type, src, extra) => src === root ? null : addPath(lib, type, src, extra);
      try {
        const drop = slot ? await m.invoke('add-slot-paths', 'M1', 'dark', [root])
          : await m.invoke('library-add-paths', [root]);
        assert.strictEqual(drop.added, 0);
        assert.strictEqual(await m.invoke('file-url', child), '', 'rejected folder must not grant recursive reads');
        pick.files = [root];
        const chosen = slot ? await m.invoke('add-slot-folder', 'M1', 'dark') : await m.invoke('library-add-folder');
        assert.strictEqual(chosen.added, slot ? 1 : 0, 'legacy folder dialog always reports one');
        assert.ok(await m.invoke('file-url', child), 'confirmed dialog grants before pool admission');
      } finally { L.addPath = addPath; }
    });
  }

  await check('invalid/cancelled inputs keep the exact early-return shapes', async dir => {
    const { m } = setup(dir);
    const cfg = m.__test.getConfig();
    assert.deepStrictEqual(await m.invoke('library-add-paths', null), { config: cfg, added: 0 });
    assert.deepStrictEqual(await m.invoke('add-slot-paths', '', 'dark', []), { config: cfg, added: 0 });
    assert.deepStrictEqual(await m.invoke('library-add-images'), { config: cfg, added: 0 });
    assert.deepStrictEqual(await m.invoke('library-add-folder'), { config: cfg, added: 0 });
  });
  console.log(`${checks} local-import main scenarios PASS`);
})().catch(err => { console.error(err); process.exitCode = 1; });
