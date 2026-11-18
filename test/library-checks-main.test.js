'use strict';

// LIB-030 through the REAL main.js, over a real profile directory: a watched folder and a
// photo added on its own, with copies among them. What the module suites cannot see is
// which files main hands to the pass, what the window is told, and that removing a copy
// or switching the check off reaches the result.
//
// Two promises are checked here rather than trusted: the pass sends nothing over the
// network, and it changes no file on disk.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const { pathKey } = require('../src/path-key');

let passed = 0;
async function test(name, fn) {
  const dir = H.makeTempProfile('library-checks');
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

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// A watched folder with a pair inside it, a look-alike of the same size, and the same
// picture once more as a photo added on its own — the case the owner's library showed 74
// times: a file in Znada's own folder plus the same file in a watched folder.
async function setup(dir) {
  const root = path.join(dir, 'watched');
  const a = put(path.join(root, 'a.jpg'), 'same picture bytes');
  const b = put(path.join(root, 'sub', 'b.jpg'), 'same picture bytes');
  const lookalike = put(path.join(root, 'c.jpg'), 'other picture byte');
  const own = put(path.join(dir, 'wallpapers', 'own.jpg'), 'same picture bytes');
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
  // The harness never lets the app finish starting, so the gate is opened by hand —
  // what main does once the window and the folder scan are going.
  assert.ok(!m.__test.libraryChecks().isScheduled(), 'nothing is scheduled before the app is up');
  m.__test.libraryChecks().start();
  const sent = [];
  const win = { shown: true };
  m.__test.useMainWindow({
    isDestroyed: () => false,
    isVisible: () => win.shown,
    isMinimized: () => false,
    webContents: { send: (...args) => sent.push(args) },
  });
  return { m, root, a, b, lookalike, own, ownId, sent, win };
}

function stamp(files) {
  return files.map((f) => { const st = fs.statSync(f); return `${f}|${st.size}|${st.mtimeMs}|${fs.readFileSync(f, 'hex')}`; }).join('\n');
}

(async () => {
  await test('the pass finds the copies across a watched folder and a photo added on its own', async (dir, requests) => {
    const { m, a, b, lookalike, own, ownId, sent } = await setup(dir);
    const before = stamp([a, b, lookalike, own]);
    await m.__test.libraryChecks().runNow();

    const state = await m.invoke('library-checks-state');
    assert.deepStrictEqual(
      { enabled: state.enabled, checked: state.checked, copies: state.copies, groups: state.groups, fresh: state.fresh },
      { enabled: true, checked: true, copies: 2, groups: 1, fresh: 2 },
      'three files with one picture are one group with two extra copies');

    const { groups } = await m.invoke('library-duplicates');
    assert.strictEqual(groups.length, 1);
    const paths = groups[0].files.map((f) => pathKey(f.path)).sort();
    assert.deepStrictEqual(paths, [a, b, own].map(pathKey).sort(), 'the look-alike of the same size is not a copy');
    const ownCard = groups[0].files.find((f) => pathKey(f.path) === pathKey(own));
    assert.strictEqual(ownCard.id, ownId, 'a pooled copy carries its record id, so the card shows its star and tags');

    assert.ok(sent.some(([channel, s]) => channel === 'library-checks-changed' && s.fresh === 2),
      'the window was told there is something new');
    assert.deepStrictEqual(requests, [], 'the pass sent nothing over the network');
    assert.strictEqual(stamp([a, b, lookalike, own]), before, 'the pass changed no file');
    assert.deepStrictEqual(Object.keys(m.__test.getConfig().library).sort(),
      [library.idFor(path.dirname(a)), ownId].sort(), 'the pass made no library record');
  });

  await test('the window is told whether it is really shown, so a find in the tray waits', async (dir) => {
    const { m, sent, win } = await setup(dir);
    win.shown = false; // started in the tray
    await m.__test.libraryChecks().runNow();
    const hidden = sent.filter(([channel]) => channel === 'library-checks-changed').pop()[1];
    assert.strictEqual(hidden.windowShown, false, 'a hidden window is told so');
    assert.strictEqual(hidden.fresh, 2, 'and the find stays new');
    assert.strictEqual((await m.invoke('library-checks-state')).windowShown, false);
    win.shown = true;
    assert.strictEqual((await m.invoke('library-checks-state')).windowShown, true, 'shown, it may announce');
  });

  await test('after the notice the same copies are not news, and a restart keeps it that way', async (dir) => {
    const { m } = await setup(dir);
    await m.__test.libraryChecks().runNow();
    const acked = await m.invoke('library-checks-ack');
    assert.strictEqual(acked.fresh, 0);
    assert.ok(fs.existsSync(path.join(dir, 'config.checks.json')), 'what was announced is kept next to the config');
    H.unloadMain();

    const again = H.loadMain(dir);
    again.__test.loadConfig();
    await again.invoke('library-refresh');
    await again.__test.libraryChecks().runNow();
    const state = await again.invoke('library-checks-state');
    assert.strictEqual(state.copies, 2);
    assert.strictEqual(state.fresh, 0, 'the same copies are not announced again after a restart');
  });

  await test('removing one copy from the library takes it out of its group at once', async (dir) => {
    const { m, b } = await setup(dir);
    await m.__test.libraryChecks().runNow();
    await m.invoke('library-remove-many', [{ path: b }]);
    const state = await m.invoke('library-checks-state');
    assert.strictEqual(state.copies, 1, 'one extra copy is left');
    const { groups } = await m.invoke('library-duplicates');
    assert.ok(!groups[0].files.some((f) => pathKey(f.path) === pathKey(b)), 'the removed copy is not shown');
    assert.ok(m.__test.libraryChecks().isScheduled(), 'and a pass is waiting to look again');
  });

  // LIB-031: the pass itself goes on ("already have it" in Online has no switch); the
  // identical-files switch empties what that check shows and stops it announcing.
  await test('switching the check off empties what it shows', async (dir) => {
    const { m } = await setup(dir);
    await m.__test.libraryChecks().runNow();
    await m.invoke('set-config', { libraryChecks: { duplicates: false } });
    assert.strictEqual(m.__test.getConfig().libraryChecks.duplicates, false);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.strictEqual(onDisk.libraryChecks.duplicates, false, 'the switch is saved');
    const state = await m.invoke('library-checks-state');
    assert.strictEqual(state.enabled, false);
    assert.strictEqual(state.fresh, 0, 'a switched-off check announces nothing');
    assert.deepStrictEqual((await m.invoke('library-duplicates')).groups, []);

    await m.invoke('set-config', { libraryChecks: { duplicates: true } });
    assert.ok(m.__test.libraryChecks().isScheduled(), 'switched back on, it looks again soon');
  });

  await test('the switch accepts only a yes or a no for a check it knows', async (dir) => {
    const { m } = await setup(dir);
    await assert.rejects(() => m.invoke('set-config', { libraryChecks: { duplicates: 'yes' } }));
    await assert.rejects(() => m.invoke('set-config', { libraryChecks: { similar: true } }));
    assert.strictEqual(m.__test.getConfig().libraryChecks.duplicates, true, 'on by default, and still on');
  });

  console.log(`\nAll ${passed} library-checks main tests passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
