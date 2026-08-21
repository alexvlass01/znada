'use strict';

// The pure controller proves registration ordering; this suite drives the real
// main.js IPC so a failed config.json write cannot be mistaken for a successful
// shortcut update.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');

let passed = 0;
async function test(name, fn) {
  const dir = H.makeTempProfile('hotkey');
  try {
    await fn(dir);
    console.log(`  OK ${name}`);
    passed++;
  } finally {
    H.unloadMain();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await test('disk failure rolls back the staged shortcut and returns storage error', async (dir) => {
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    const first = await m.invoke('set-hotkey', { enabled: true, shortcut: 'Ctrl+Alt+A' });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(m.__test.activeHotkey(), 'Ctrl+Alt+A');

    const configPath = path.join(dir, 'config.json');
    fs.rmSync(configPath, { force: true });
    fs.mkdirSync(configPath);
    const failed = await m.invoke('set-hotkey', { enabled: true, shortcut: 'Ctrl+Alt+B' });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.error, 'storage');
    assert.strictEqual(m.__test.activeHotkey(), 'Ctrl+Alt+A');
    assert.strictEqual(m.__test.getConfig().hotkeys.nextWallpaper.shortcut, 'Ctrl+Alt+A');
    assert.ok(m.calls.hotkeyRegistered.has('Ctrl+Alt+A'));
    assert.ok(!m.calls.hotkeyRegistered.has('Ctrl+Alt+B'));
  });

  await test('registration conflict preserves the current shortcut and disk state', async (dir) => {
    const refused = new Set(['Ctrl+Alt+B']);
    const m = H.loadMain(dir, { refusedHotkeys: refused });
    m.__test.loadConfig();
    assert.strictEqual((await m.invoke('set-hotkey', {
      enabled: true, shortcut: 'Ctrl+Alt+A',
    })).ok, true);
    const failed = await m.invoke('set-hotkey', { enabled: true, shortcut: 'Ctrl+Alt+B' });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.error, 'unavailable');
    assert.strictEqual(m.__test.activeHotkey(), 'Ctrl+Alt+A');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.strictEqual(saved.hotkeys.nextWallpaper.shortcut, 'Ctrl+Alt+A');
  });

  // Not a hotkey, but the same shape of defect and the same harness: a Windows
  // launch artefact written from a build that has no business writing it. The
  // harness is never an installed build, which is exactly the case that used to
  // plant an Electron-branded shortcut over the real one.
  await test('a build running from source refuses to create shortcuts', async (dir) => {
    const m = H.loadMain(dir);
    m.__test.loadConfig();

    const made = await m.invoke('create-shortcuts', 'both');
    assert.deepStrictEqual(made, [], 'a source build reported creating shortcuts');

    const startMenu = path.join(dir, 'appData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Znada.lnk');
    const desktop = path.join(dir, 'desktop', 'Znada.lnk');
    assert.ok(!fs.existsSync(startMenu), 'a Start menu shortcut pointing at electron.exe was written');
    assert.ok(!fs.existsSync(desktop), 'a desktop shortcut pointing at electron.exe was written');
  });

  console.log(`\nAll ${passed} hotkey orchestration tests passed.`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
