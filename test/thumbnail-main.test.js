'use strict';

// Real IPC wiring, current config after await, pool persistence and sender authority.
// Stub only the OS extractor; the original main harness is unchanged.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const folderState = require('../src/folder-state');
const { ThumbnailHost } = require('../src/thumbnail-host');
const image = { mime: 'image/png', dataBase64: 'cG5n', width: 400, height: 200 };
const original = ThumbnailHost.prototype.thumbnail;
let dir;
(async () => {
  let calls = 0;
  const release = {};
  ThumbnailHost.prototype.thumbnail = async () => { calls++; return release.hold ? new Promise(resolve => { release.resolve = resolve; }) : image; };
  dir = H.makeTempProfile('thumbnail-wiring');
  const p = H.writeImage(path.join(dir, 'wallpapers', 'фото с пробелом.png'));
  const id = library.idFor(p);
  const seed = aspect => H.writeJson(path.join(dir, 'config.library.json'), { version: 1, library: { [id]: { id, type: 'image', path: p, aspect, addedAt: 1 } }, trash: [] });
  seed(0);
  const app = H.loadMain(dir);
  await app.__test.loadConfig();
  assert.strictEqual(await app.invoke('thumb', p, 320, 200), 'data:image/png;base64,cG5n');
  const info = await app.invoke('thumb-info', p, 320, 200, 10);
  assert.deepStrictEqual({ url: info.url, width: info.width, height: info.height }, { url: 'data:image/png;base64,cG5n', width: 400, height: 200 });
  assert.strictEqual(info.motion.format, 'png', 'motion reader stays composed in main');
  assert.strictEqual(calls, 1, 'both IPC channels share service cache');
  assert.strictEqual(app.__test.thumbnailAttempts(), 2);
  assert.throws(() => app.invokeAs('viewer', 'thumb', p, 640, 200), /E_IPC_DENIED/);
  assert.throws(() => app.invokeAs('viewer', 'thumb-info', p, 640, 200), /E_IPC_DENIED/);
  assert.throws(() => app.invokeAs('viewer', 'thumb-aspects', [{ id, path: p }], 640, 200), /E_IPC_DENIED/);
  assert.strictEqual(calls, 1, 'all three thumbnail channels refuse viewer');
  assert.deepStrictEqual(await app.invoke('thumb-aspects', [{ id, path: p }], 320, 200), [{ path: p, aspect: 2 }]);
  assert.strictEqual(app.__test.getConfig().library[id].aspect, 2);
  await app.__test.flushLibraryWriter();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8')).library[id].aspect, 2);
  console.log('  ok real IPC cache, sender authority and batched pool persistence');

  // A reload while the helper is running must write to the new pool, not its predecessor.
  const oldPool = app.__test.getConfig().library;
  release.hold = true;
  const pending = app.invoke('thumb-aspects', [{ id, path: p }], 640, 200);
  await new Promise(resolve => { setImmediate(resolve); });
  assert.strictEqual(typeof release.resolve, 'function');
  seed(1.5); await app.__test.loadConfig();
  assert.notStrictEqual(app.__test.getConfig().library, oldPool);
  release.resolve({ ...image, width: 600 });
  await pending;
  assert.strictEqual(oldPool[id].aspect, 2, 'old config untouched');
  assert.strictEqual(app.__test.getConfig().library[id].aspect, 3, 'writer reads config after helper await');
  await app.__test.flushLibraryWriter();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8')).library[id].aspect, 3);
  console.log('  ok config replacement during helper await updates and persists current pool');

  // Exercise main's actual callback and quit-time flush, rather than the service's spy.
  const root = path.join(dir, 'watched');
  const folderPhoto = H.writeImage(path.join(root, 'фото з папки.png'));
  const folderId = library.idFor(root);
  app.__test.getConfig().library[folderId] = { id: folderId, type: 'folder', path: root, addedAt: 1 };
  app.__test.setLiveFolderState(folderState.reconcileFolder(folderState.emptyState(), {
    folderId, rootPath: root, status: 'complete', entries: [{ path: folderPhoto, modifiedAt: 1000 }],
  }).state);
  assert.strictEqual(folderState.listImages(app.__test.getLiveFolderState())[0].aspect, 0);
  release.hold = false;
  assert.strictEqual((await app.invoke('thumb-info', folderPhoto, 320, 200)).width, 400);
  app.emitApp('before-quit');
  const saved = folderState.loadState(path.join(dir, 'folder-state.json')).state;
  const files = folderState.listImages(saved);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(files[0].path, folderPhoto);
  assert.strictEqual(files[0].aspect, 2, 'main callback persists learned folder aspect after flush');
  console.log('  ok real main callback and shutdown flush persist live-folder aspect on disk');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  H.unloadMain(); ThumbnailHost.prototype.thumbnail = original;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
