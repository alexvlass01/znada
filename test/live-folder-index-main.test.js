'use strict';

// Behavioural insurance before CODE-001 2.3b: run the real main, delay only disk scans.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const F = require('../src/folder-state');
const L = require('../src/library');
const { ThumbnailHost } = require('../src/thumbnail-host');
const { makeTempDir } = require('./helpers/temp-dir');
const { pathKey } = require('../src/path-key');
const originalScan = F.scanFolderTree;
const originalThumb = ThumbnailHost.prototype.thumbnail;
const deadline = (p) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('scan/lock deadline')), 2000); })])
    .finally(() => clearTimeout(timer));
};
let checks = 0;
async function check(name, fn) {
  const dir = H.makeTempProfile('index-main');
  try { await fn(dir); checks++; console.log(`ok ${name}`); }
  finally { F.scanFolderTree = originalScan; ThumbnailHost.prototype.thumbnail = originalThumb; H.unloadMain(); }
}
async function setup(dir) {
  const root = path.join(dir, 'wallpapers');
  const p = H.writeImage(path.join(root, 'a.png'));
  const id = L.idFor(root);
  const photoId = L.idFor(p);
  H.writeJson(path.join(dir, 'config.json'), { autoSwitch: false, monitors: {} });
  H.writeJson(path.join(dir, 'config.library.json'), { version: 1, trash: [], library: {
    [id]: { id, type: 'folder', path: root, addedAt: 1 },
    [photoId]: { id: photoId, type: 'image', path: p, addedAt: 1 },
  } });
  const m = H.loadMain(dir);
  m.__test.loadConfig();
  await m.invoke('library-refresh');
  return { m, root, p, id, photoId };
}
function delayedScan() {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  F.scanFolderTree = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return originalScan(...args); };
  return { started, release: () => release() };
}
(async () => {
  await check('a root removed during a scan cannot be resurrected by partial/final reconcile', async dir => {
    const { m, id } = await setup(dir);
    const wait = delayedScan();
    const refresh = m.invoke('library-refresh');
    await deadline(wait.started);
    delete m.__test.getConfig().library[id];
    m.__test.setLiveFolderState(F.emptyState());
    wait.release(); await deadline(refresh);
    assert.strictEqual(m.__test.getLiveFolderState().folders[id], undefined);
  });
  await check('marks changed while scan awaits survive; Undo never waits for that scan under lock', async dir => {
    const { m, p, photoId } = await setup(dir);
    const wait = delayedScan();
    const refresh = m.invoke('library-refresh'); await deadline(wait.started);
    const removed = await deadline(m.invoke('library-remove-many', [{ id: photoId, path: p }]));
    assert.ok(m.__test.hiddenPathSet().has(pathKey(p)));
    assert.ok(F.listImages(F.loadState(path.join(dir, 'folder-state.json')).state, null, { only: 'hidden' }).length);
    // Finish the scan before Undo: a captured pre-await index would lose this mark.
    wait.release(); await deadline(refresh);
    assert.ok(m.__test.hiddenPathSet().has(pathKey(p)));
    const next = delayedScan();
    const refresh2 = m.invoke('library-refresh'); await deadline(next.started);
    try {
      const undo = await deadline(m.invoke('library-undo-remove', removed.undo.token));
      assert.ok(!undo.error);
      assert.ok(!m.__test.hiddenPathSet().has(pathKey(p)));
    } finally { next.release(); await deadline(refresh2); }
  });
  await check('a failed scan does not poison the serialized refresh queue', async dir => {
    const { m } = await setup(dir);
    let scans = 0;
    F.scanFolderTree = async (...args) => { if (++scans === 1) throw new Error('fixture scan failure'); return originalScan(...args); };
    const first = m.invoke('library-refresh');
    const rejected = assert.rejects(first, /fixture scan failure/);
    const second = m.invoke('library-refresh');
    await rejected; await deadline(second);
    assert.strictEqual(scans, 2);
  });
  await check('thumbnail aspect batch flushes index and pool on before-quit without broadcast', async dir => {
    const { m, p, photoId } = await setup(dir);
    ThumbnailHost.prototype.thumbnail = async () => ({ mime: 'image/png', dataBase64: 'cG5n', width: 400, height: 200 });
    const sent = [];
    m.__test.useMainWindow({ isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } });
    await m.invoke('thumb', p, 320, 200);
    m.emitApp('before-quit');
    const disk = F.loadState(path.join(dir, 'folder-state.json')).state;
    assert.strictEqual(F.listImages(disk)[0].aspect, 2);
    const pool = JSON.parse(fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8'));
    assert.strictEqual(pool.library[photoId].aspect, 2);
    assert.strictEqual(sent.filter(args => args[0] === 'config-changed').length, 0);
  });
  await check('DATA-006 remaps the persisted index and a warmed hidden cache', async dir => {
    const { m, p, root, photoId } = await setup(dir);
    await m.invoke('library-remove-many', [{ id: photoId, path: p }]);
    assert.ok(m.__test.hiddenPathSet().has(pathKey(p)));
    const target = makeTempDir('index-move-target-');
    const moved = await m.__test.moveManagedFolder(target);
    assert.strictEqual(moved.status, 'done');
    const newRoot = m.__test.managedRoot().root;
    const newPath = path.join(newRoot, path.relative(root, p));
    assert.ok(m.__test.hiddenPathSet().has(pathKey(newPath)));
    assert.ok(!m.__test.hiddenPathSet().has(pathKey(p)));
    m.__test.loadLiveFolderState();
    assert.ok(m.__test.hiddenPathSet().has(pathKey(newPath)));
    assert.ok(F.listImages(m.__test.getLiveFolderState(), null, { only: 'hidden' }).some(im => im.path === newPath));
  });
  await check('test snapshot and seed input cannot change live folder-entries', async dir => {
    const { m, id } = await setup(dir);
    const before = await m.invoke('expand-folders');
    const snapshot = m.__test.getLiveFolderState();
    snapshot.folders[id].files = {};
    assert.deepStrictEqual(await m.invoke('expand-folders'), before);
    const seeded = m.__test.getLiveFolderState();
    m.__test.setLiveFolderState(seeded); seeded.folders = {};
    assert.deepStrictEqual(await m.invoke('expand-folders'), before);
  });
  await check('batch assignment reads discovery only for transient cards and preserves its date', async dir => {
    // Seed before the initial scan: discovery date is 1, never the assignment clock.
    const transient = H.writeImage(path.join(dir, 'wallpapers', 'transient.png'));
    const { m, photoId } = await setup(dir);
    const discoveredAt = F.listImages(m.__test.getLiveFolderState()).find(im => im.path === transient).firstSeenAt;
    m.__test.hiddenPathSet();
    const originalList = F.listImages; let reads = 0;
    F.listImages = (...args) => { if (!args[2]) reads++; return originalList(...args); };
    try {
      const known = await m.invoke('library-assign-records', [{ id: photoId }], 'M1', 'light');
      assert.strictEqual(known.ok, true); assert.strictEqual(reads, 0);
      const fresh = await m.invoke('library-assign-records', [{ type: 'image', path: transient }], 'M1', 'light');
      assert.strictEqual(fresh.ok, true); assert.ok(reads > 0);
      assert.strictEqual(m.__test.getConfig().library[L.idFor(transient)].addedAt, discoveredAt);
    } finally { F.listImages = originalList; }
  });
  console.log(`PASS index-main: ${checks} scenarios`);
})().catch(err => { console.error(err); process.exitCode = 1; });
