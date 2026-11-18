'use strict';

// CODE-001 assignment boundary insurance, run before moving any product code.
// Actual IPC + pool/index stores; Electron and the wallpaper host alone are fake.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const L = require('../src/library');
const F = require('../src/folder-state');
const { pathKey } = require('../src/path-key');
const { makeFakeHost, until } = require('./helpers/schedule-harness');

const bounded = (promise) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('assignment deadline')), 3000);
  })]).finally(() => clearTimeout(timer));
};

function setup(dir, host) {
  const root = path.join(dir, 'фото с пробелом');
  const a = H.writeImage(path.join(root, 'a.png'));
  const b = H.writeImage(path.join(root, 'b.png'));
  const folderId = L.idFor(root), aId = L.idFor(a), bId = L.idFor(b);
  H.writeJson(path.join(dir, 'config.json'), {
    autoSwitch: false, separateThemes: true, style: 'fill', gameModeBlock: false,
    wallpaperSchedule: { mode: 'off' }, themeSchedule: { mode: 'off' },
    monitors: { M1: { light: { itemIds: [] }, dark: { itemIds: [], explicitEmpty: true } } },
  });
  H.writeJson(path.join(dir, 'config.library.json'), { version: 1, trash: [], library: {
    [folderId]: { id: folderId, type: 'folder', path: root, addedAt: 1 },
    [aId]: { id: aId, type: 'image', path: a, addedAt: 2, favorite: true, tags: ['sea'], rev: 10 },
  } });
  if (host) delete require.cache[require.resolve('../src/wallpaper-host')];
  const m = H.loadMain(dir, host ? { childProcess: { spawn: host.spawn } } : {});
  m.__test.loadConfig();
  return { m, root, a, b, aId, bId, folderId };
}
function pool(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8')); }
function settings(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); }
function reload(dir) {
  H.unloadMain();
  const m = H.loadMain(dir); m.__test.loadConfig(); m.__test.loadLiveFolderState();
  return m;
}
let checks = 0;
async function check(name, fn) {
  const dir = H.makeTempProfile('assignment-main');
  try { await fn(dir); checks++; console.log(`PASS ${name}`); }
  finally { H.unloadMain(); }
}

(async () => {
  for (const batch of [false, true]) {
    const route = batch ? 'batch' : 'single';
    const assign = (m, records, theme = 'dark') => batch
      ? m.invoke('library-assign-records', records, 'M1', theme)
      : m.invoke('library-assign-record', records[0], 'M1', theme);

    await check(`${route}: existing-only assignment saves settings without rewriting pool`, async dir => {
      const { m, aId } = setup(dir);
      await m.invoke('library-refresh');
      m.__test.saveConfig();
      const bytes = fs.readFileSync(path.join(dir, 'config.library.json'));
      // Detect even byte-identical rewrites (atomic rename), not just changed contents.
      const originalRename = fs.renameSync;
      let writes = 0;
      fs.renameSync = (from, to) => {
        if (path.resolve(to) === path.join(dir, 'config.library.json')) writes++;
        return originalRename(from, to);
      };
      let result;
      try { result = await assign(m, [{ id: aId }]); }
      finally { fs.renameSync = originalRename; }
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.warning, null);
      assert.strictEqual(writes, 0, 'assignment of an existing record rewrote pool storage');
      assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'config.library.json')), bytes);
      assert.deepStrictEqual(settings(dir).monitors.M1.dark.itemIds, [aId]);
      assert.ok(!settings(dir).monitors.M1.dark.explicitEmpty);
      const saved = reload(dir).__test.getConfig();
      assert.deepStrictEqual(saved.monitors.M1.dark.itemIds, [aId]);
      assert.deepStrictEqual(saved.library[aId].tags, ['sea']);
    });

    await check(`${route}: transient creation enters the same funnel and persists before settings`, async dir => {
      const { m, b, bId } = setup(dir);
      await m.invoke('library-refresh');
      const discovered = F.listImages(m.__test.getLiveFolderState()).find(im => im.path === b);
      const originalRename = fs.renameSync;
      let settingsWrites = 0;
      fs.renameSync = (from, to) => {
        if (path.resolve(to) === path.join(dir, 'config.json')) {
          assert.ok(pool(dir).library[bId], 'settings reference was saved before its pool record');
          settingsWrites++;
        }
        return originalRename(from, to);
      };
      let result;
      try { result = await assign(m, [{ type: 'image', path: b }]); }
      finally { fs.renameSync = originalRename; }
      assert.strictEqual(result.ok, true);
      assert.ok(settingsWrites > 0);
      assert.strictEqual(pool(dir).library[bId].addedAt, discovered.firstSeenAt);
      assert.deepStrictEqual(settings(dir).monitors.M1.dark.itemIds, [bId]);
      const saved = reload(dir).__test.getConfig();
      assert.ok(saved.library[bId]);
      assert.deepStrictEqual(saved.monitors.M1.dark.itemIds, [bId]);
    });

    await check(`${route}: existing active+removed repair persists revision, marks and trash`, async dir => {
      const { m, a, aId } = setup(dir);
      await m.invoke('library-refresh');
      const original = { ...m.__test.getConfig().library[aId] };
      const removed = await m.invoke('library-remove-many', [{ id: aId, path: a }]);
      assert.strictEqual(removed.affected, 1);
      const removalRev = m.__test.getConfig().libraryTrash[0].rev;
      // Historical inconsistent state: a record already exists but still has a tombstone.
      // Assignment must repair it even though no new record is created.
      m.__test.getConfig().library[aId] = original;
      m.__test.saveConfig();
      const result = await assign(m, [{ id: aId }]);
      assert.strictEqual(result.ok, true);
      assert.ok(pool(dir).library[aId].rev > removalRev);
      assert.ok(!pool(dir).trash.some(entry => entry.item.id === aId));
      assert.ok(!m.__test.hiddenPathSet().has(pathKey(a)));
      const savedMain = reload(dir), saved = savedMain.__test.getConfig();
      assert.ok(saved.library[aId].rev > removalRev);
      assert.deepStrictEqual(saved.library[aId].tags, ['sea']);
      assert.strictEqual(saved.library[aId].favorite, true);
      assert.ok(!saved.libraryTrash.some(entry => entry.item.id === aId));
      assert.ok(!savedMain.__test.hiddenPathSet().has(pathKey(a)));
      assert.deepStrictEqual(saved.monitors.M1.dark.itemIds, [aId]);
    });

    await check(`${route}: save precedes apply, lock spans await, response reads latest config`, async dir => {
      const host = makeFakeHost();
      host.answer('enum', { ok: true, monitors: [{ id: 'M1', x: 0, y: 0, w: 1920, h: 1080 }] });
      const { m, aId, b, bId } = setup(dir, host);
      await m.invoke('library-refresh');
      host.hold('apply');
      const pending = assign(m, [{ path: b, type: 'image' }], 'light');
      let queued;
      try {
        await until(() => host.waiting('apply') === 1, 'assignment reaches apply');
        assert.ok(pool(dir).library[bId]);
        assert.deepStrictEqual(settings(dir).monitors.M1.light.itemIds, [bId]);
        let finished = false;
        queued = assign(m, [{ id: aId }]);
        queued.then(() => { finished = true; });
        const latest = await bounded(m.invoke('set-config', { style: 'center' }));
        assert.strictEqual(finished, false, 'second assignment escaped the mutation lock');
        assert.deepStrictEqual(latest.monitors.M1.dark.itemIds, []);
        host.unhold('apply'); host.release('apply', { ok: true });
        const result = await bounded(pending);
        assert.strictEqual(result.config, latest, 'response captured pre-await config');
        assert.strictEqual(result.config.style, 'center');
        assert.strictEqual(result.warning, null);
        assert.strictEqual((await bounded(queued)).ok, true);
        assert.deepStrictEqual(settings(dir).monitors.M1.dark.itemIds, [aId]);
      } finally {
        host.unhold('apply');
        if (host.waiting('apply')) host.release('apply', { ok: true });
        await bounded(pending).catch(() => {});
        if (queued) await bounded(queued).catch(() => {});
      }
    });
  }
  await check('missing existing image is refused without a slot or persistence change', async dir => {
    const { m, a, aId } = setup(dir);
    fs.unlinkSync(a);
    const before = JSON.stringify(m.__test.getConfig());
    const result = await m.invoke('library-assign', aId, 'M1', 'dark');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'missing_file');
    assert.strictEqual(JSON.stringify(m.__test.getConfig()), before);
  });
  await check('partial batch keeps failures/video counts, compact response and theme normalization', async dir => {
    const { m, root, aId, b, bId } = setup(dir);
    const video = path.join(root, 'clip.mp4'); fs.writeFileSync(video, 'synthetic video');
    await m.invoke('library-refresh');
    const result = await m.invoke('library-assign-records', [
      { id: aId }, { id: aId }, { path: b, type: 'image' },
      { path: path.join(root, 'missing.png'), type: 'image' },
      { path: video, type: 'image' },
    ], 'M1', 'unrecognized-theme');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.assigned, 2);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.videos, 1);
    assert.deepStrictEqual(Object.keys(result).sort(), ['assigned', 'config', 'error', 'failed', 'ok', 'videos', 'warning']);
    assert.deepStrictEqual(result.config.monitors.M1.light.itemIds, [aId, bId]);
    assert.strictEqual(result.config.library[L.idFor(video)], undefined);
    assert.deepStrictEqual(settings(dir).monitors.M1.light.itemIds, [aId, bId]);
    assert.ok(pool(dir).library[bId]);
  });
  console.log(`PASS assignment-main: ${checks} scenarios`);
})().catch(error => { console.error(error); process.exitCode = 1; });
