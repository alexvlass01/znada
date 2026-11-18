'use strict';

// LIB-031 through the REAL main.js over a real profile: a watched folder and a photo added
// on its own, the shared pass run for real, and the window's question asked over the real
// IPC channel. What the module suites cannot see: which files main hands to the pass, that
// the answer follows the library at once (a removed photo is not "yours" a moment later),
// that the identical-files switch does not turn this off, and that asking reaches nothing
// outside the machine and makes no record.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const { pathKey } = require('../src/path-key');

let passed = 0;
async function test(name, fn) {
  const dir = H.makeTempProfile('online-have');
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => { requests.push(String(url)); throw new Error('offline'); };
  try {
    await fn(dir, requests);
    passed += 1;
    console.log('  OK ' + name);
  } finally {
    globalThis.fetch = realFetch;
    H.unloadMain();
  }
}

function put(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function md5(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

// A PNG header of the given size, padded so its byte count is distinctive.
function png(width, height, pad) {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

async function setup(dir) {
  const root = path.join(dir, 'watched');
  const inFolder = put(path.join(root, 'saved-from-browser.jpg'), 'a picture saved from a browser');
  const wide = put(path.join(root, 'sub', 'wallpaper.png'), png(2560, 1440, 4000));
  const own = put(path.join(dir, 'wallpapers', 'own.jpg'), 'a photo added on its own');
  const video = put(path.join(root, 'clip.mp4'), 'a video, never offered');
  const folderId = library.idFor(root);
  const ownId = library.idFor(own);
  H.writeJson(path.join(dir, 'config.json'), { autoSwitch: false, monitors: {} });
  H.writeJson(path.join(dir, 'config.library.json'), { version: 1, trash: [], library: {
    [folderId]: { id: folderId, type: 'folder', path: root, addedAt: 1 },
    [ownId]: { id: ownId, type: 'image', path: own, addedAt: 2 },
  } });
  const m = H.loadMain(dir);
  m.__test.loadConfig();
  await m.invoke('library-refresh');
  m.__test.libraryChecks().start();
  const sent = [];
  m.__test.useMainWindow({
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: { send: (...args) => sent.push(args) },
  });
  return { m, root, inFolder, wide, own, ownId, video, sent };
}

function stamp(files) {
  return files.map((f) => { const st = fs.statSync(f); return `${f}|${st.size}|${st.mtimeMs}|${fs.readFileSync(f, 'hex')}`; }).join('\n');
}

const tick = () => new Promise((r) => { setTimeout(r, 20); });

(async () => {
  await test('an Online card is recognised as a file the user already has, wherever it lies', async (dir, requests) => {
    const { m, inFolder, wide, own, ownId, video, sent } = await setup(dir);
    const before = stamp([inFolder, wide, own, video]);
    const recordsBefore = Object.keys(m.__test.getConfig().library).sort();
    await m.__test.libraryChecks().runNow();
    await tick();
    assert.ok(sent.some(([channel]) => channel === 'library-have-changed'),
      'the window is told to ask its Online cards again once the pass learned something');

    const out = await m.invoke('online-have-many', [
      { key: 'gelbooru', md5: md5('a picture saved from a browser') },
      { key: 'danbooru', md5: md5('a photo added on its own').toUpperCase(), fileSize: 1 },
      { key: 'wallhaven', fileSize: fs.statSync(wide).size, width: 2560, height: 1440 },
      { key: 'other', md5: md5('nobody has this') },
      { key: 'turned', fileSize: fs.statSync(wide).size, width: 1440, height: 2560 },
      { key: 'video', md5: md5('a video, never offered') },
    ]);
    assert.ok(out.gelbooru && pathKey(out.gelbooru.path) === pathKey(inFolder) && out.gelbooru.id === '',
      'a file in a watched folder, found by its fingerprint, with no record yet');
    assert.ok(out.danbooru && pathKey(out.danbooru.path) === pathKey(own) && out.danbooru.id === ownId,
      'a photo with a record comes with its id');
    assert.ok(out.wallhaven && pathKey(out.wallhaven.path) === pathKey(wide),
      'a site without a fingerprint: the same size and resolution');
    assert.strictEqual(out.other, null, 'a picture nobody has');
    assert.strictEqual(out.turned, null, 'the same size, the resolution turned round');
    assert.strictEqual(out.video, null, 'a video is not offered');

    assert.deepStrictEqual(requests, [], 'nothing went over the network');
    assert.strictEqual(stamp([inFolder, wide, own, video]), before, 'no file changed');
    assert.deepStrictEqual(Object.keys(m.__test.getConfig().library).sort(), recordsBefore, 'asking made no record');
  });

  await test('a photo removed from the library is not "already yours" a moment later', async (dir) => {
    const { m, inFolder } = await setup(dir);
    await m.__test.libraryChecks().runNow();
    const card = [{ key: 'k', md5: md5('a picture saved from a browser') }];
    assert.ok((await m.invoke('online-have-many', card)).k, 'found before');
    await m.invoke('library-remove-many', [{ path: inFolder }]);
    assert.strictEqual((await m.invoke('online-have-many', card)).k, null, 'not found right after the removal, without a pass');
  });

  await test('a forced folder refresh rechecks a same-path replacement with a stale indexed size', async (dir) => {
    const { m, inFolder } = await setup(dir);
    const checks = m.__test.libraryChecks();
    const old = fs.readFileSync(inFolder);
    const replacement = Buffer.from('a different image with a larger number of bytes');
    const cards = [{ key: 'old', md5: md5(old) }, { key: 'new', md5: md5(replacement) }];
    await checks.runNow();
    assert.ok((await m.invoke('online-have-many', cards)).old);
    assert.ok(!checks.isScheduled());

    fs.writeFileSync(inFolder, replacement);
    await m.invoke('library-refresh');
    assert.ok(checks.isScheduled(), 'an unchanged discovery listing still requests a background check');
    const open = fs.createReadStream;
    fs.createReadStream = (file, ...args) => {
      if (file === inFolder) throw new Error('temporary read failure');
      return open(file, ...args);
    };
    try { await checks.runNow(); }
    finally { fs.createReadStream = open; }
    const unreadable = await m.invoke('online-have-many', cards);
    assert.strictEqual(unreadable.old, null);
    assert.strictEqual(unreadable.new, null);
    assert.deepStrictEqual(checks.finder().bySize(old.length), []);
    assert.deepStrictEqual(checks.finder().bySize(replacement.length), [inFolder]);

    await checks.runNow();
    const readable = await m.invoke('online-have-many', cards);
    assert.strictEqual(readable.old, null);
    assert.strictEqual(readable.new.path, inFolder);
  });

  await test('the identical-files switch does not turn this off', async (dir) => {
    const { m } = await setup(dir);
    await m.invoke('set-config', { libraryChecks: { duplicates: false } });
    await m.__test.libraryChecks().runNow();
    const out = await m.invoke('online-have-many', [{ key: 'k', md5: md5('a picture saved from a browser') }]);
    assert.ok(out.k, 'found with the identical-files check switched off');
    assert.strictEqual((await m.invoke('library-checks-state')).copies, 0, 'while that check still reports nothing');
  });

  await test('after a restart the answer is back at once, long before the first pass', async (dir) => {
    const first = await setup(dir);
    await first.m.__test.libraryChecks().runNow();
    await first.m.__test.flushMetadata();
    H.unloadMain();
    // Changed while the app was closed: what the cache remembers about it is no longer true.
    fs.writeFileSync(first.own, 'the same photo file, other bytes now');
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    await m.invoke('library-refresh');
    const checks = m.__test.libraryChecks();
    checks.start(60000);
    const card = [
      { key: 'k', md5: md5('a picture saved from a browser') },
      { key: 'none', md5: md5('nobody has this') },
      { key: 'old', md5: md5('a photo added on its own') },
    ];
    let out = null;
    for (let i = 0; i < 100; i++) {
      out = await m.invoke('online-have-many', card);
      if (out.k) break;
      await tick();
    }
    assert.ok(out.k, 'found from the fingerprint cache');
    assert.strictEqual(out.none, null, 'and only what the cache knows');
    assert.strictEqual(out.old, null, 'a file changed since it was hashed is not known by its old fingerprint');
    assert.strictEqual(checks.passCount(), 0, 'no pass has run yet');
    assert.strictEqual(checks.isScheduled(), true, 'the pass is still waiting for its turn');
    checks.dispose();
  });

  console.log(`\nAll ${passed} online-have main tests passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
