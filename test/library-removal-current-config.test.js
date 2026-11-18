'use strict';

// CODE-001: the gap recorded in the 2.2b author report. Drive the actual IPC doors,
// not a replacement config getter or a fake library-removal service. Only Electron
// and child processes are fakes, using the existing host protocol from schedule tests.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const library = require('../src/library');
const { pathKey } = require('../src/path-key');
const H = require('./helpers/main-harness');
const { makeFakeHost, until } = require('./helpers/schedule-harness');

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('IPC did not finish')), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function scenario(action) {
  const dir = H.makeTempProfile('removal-current-config');
  const host = makeFakeHost();
  const root = path.join(dir, 'фото с пробелом');
  const photo = H.writeImage(path.join(root, 'море.png'));
  H.writeImage(path.join(root, 'hill.png'));
  const folderId = library.idFor(root);
  const photoId = library.idFor(photo);
  H.writeJson(path.join(dir, 'config.json'), {
    autoSwitch: false, style: 'fill', separateThemes: true, gameModeBlock: false,
    wallpaperSchedule: { mode: 'off' }, themeSchedule: { mode: 'off' },
    monitors: { M1: { light: { itemIds: [folderId] }, dark: { itemIds: [folderId] } } },
  });
  H.writeJson(path.join(dir, 'config.library.json'), {
    version: 1, trash: [], library: {
      [folderId]: { id: folderId, type: 'folder', path: root, addedAt: 1, favorite: false, tags: [] },
      [photoId]: { id: photoId, type: 'image', path: photo, addedAt: 2, favorite: true, tags: ['sea'] },
    },
  });
  host.answer('enum', { ok: true, monitors: [{ id: 'M1', x: 0, y: 0, w: 1920, h: 1080 }] });
  const record = { id: photoId, type: 'image', path: photo };
  let pending;
  try {
    // Like the schedule harness: wallpaper-host captures child_process when loaded.
    // Reload it so this profile's host receives commands, rather than a prior fake.
    delete require.cache[require.resolve('../src/wallpaper-host')];
    const m = H.loadMain(dir, { childProcess: { spawn: host.spawn } });
    m.__test.loadConfig();
    await bounded(m.invoke('library-refresh'));
    let removed;
    if (action !== 'remove') removed = await bounded(m.invoke('library-remove-many', [record]));
    if (removed) assert.strictEqual(removed.affected, 1, 'precondition: one photo removed');

    const before = m.__test.getConfig();
    const baselineApplies = host.commands.filter((c) => c.op === 'apply').length;
    host.hold('apply');
    let finished = false;
    pending = action === 'remove' ? m.invoke('library-remove-many', [record])
      : action === 'undo' ? m.invoke('library-undo-remove', removed.undo.token)
        : m.invoke('library-restore', [photo]);
    pending.then(() => { finished = true; }, () => { finished = true; });
    await until(() => host.waiting('apply') === 1, `${action} reaches wallpaper host`);
    assert.strictEqual(finished, false, 'the library IPC is still awaiting wallpaper application');

    // style is a validated setting that replaces config without another wallpaper apply.
    // Two replacements catch a reply that remembers just the first settings update too.
    const first = await bounded(m.invoke('set-config', { style: 'fit' }));
    const latest = await bounded(m.invoke('set-config', { style: 'center' }));
    assert.notStrictEqual(first, before, 'settings IPC really replaced the object');
    assert.notStrictEqual(latest, first, 'the second settings IPC replaced it again');
    assert.strictEqual(before.style, 'fill', 'the old object remains distinguishable');
    assert.strictEqual(finished, false, 'settings changed while the original IPC was pending');
    assert.strictEqual(host.commands.filter((c) => c.op === 'apply').length, baselineApplies + 1,
      'settings did not start a second apply');

    host.unhold('apply');
    host.release('apply', { ok: true });
    const result = await bounded(pending);
    assert.strictEqual(result.config.style, 'center', `${action} replied with stale settings`);
    assert.strictEqual(result.config, latest, `${action} must read config at reply time`);
    assert.strictEqual(result.config, m.__test.getConfig());
    assert.strictEqual(action === 'remove' ? result.affected : result.restored, 1);
    const active = action !== 'remove';
    assert.strictEqual(!!result.config.library[photoId], active, 'pool agrees with the operation');
    assert.strictEqual(result.config.libraryTrash.some((e) => e.item.id === photoId), !active);
    assert.strictEqual(m.__test.hiddenPathSet().has(pathKey(photo)), !active, 'removed mark agrees');
    assert.strictEqual(fs.existsSync(photo), true, 'source file was not deleted');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).style, 'center');

    // Reload both stores and the index: reply correctness must coexist with the original
    // removal/revival persistence, not just a successful in-memory settings swap.
    H.unloadMain();
    const reloaded = H.loadMain(dir);
    reloaded.__test.loadConfig();
    reloaded.__test.loadLiveFolderState();
    const saved = reloaded.__test.getConfig();
    assert.strictEqual(saved.style, 'center');
    assert.strictEqual(!!saved.library[photoId], active);
    assert.strictEqual(saved.libraryTrash.some((e) => e.item.id === photoId), !active);
    assert.strictEqual(reloaded.__test.hiddenPathSet().has(pathKey(photo)), !active);
    if (active) {
      assert.strictEqual(saved.library[photoId].favorite, true);
      assert.deepStrictEqual(saved.library[photoId].tags, ['sea']);
    }
    console.log(`PASS ${action}: current config after wallpaper await, persisted state after reload`);
  } finally {
    host.unhold('apply');
    if (host.waiting('apply')) host.release('apply', { ok: true });
    if (pending) await bounded(pending).catch(() => {});
    H.unloadMain();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  for (const action of ['remove', 'undo', 'restore']) await scenario(action);
})().catch((err) => { console.error(err); process.exitCode = 1; });
