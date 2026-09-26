'use strict';

// DATA-006 step 1. The rules behind "where do Znada's own copies live", on their own.
// Behaviour through the real main.js is a separate suite (media-root-main.test.js);
// this one pins the decisions that suite cannot see, such as what a dev profile is
// called inside the chosen folder.

const assert = require('assert');
const mediaRoot = require('../src/media-root');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ok ${name}`);
}

const PROFILE = 'C:\\Users\\a\\AppData\\Roaming\\znada';

check('no chosen folder keeps the profile folder everyone starts with', () => {
  const resolved = mediaRoot.resolveManagedRoot({ userDataPath: PROFILE, mediaFolder: '' });
  assert.strictEqual(resolved.root, 'C:\\Users\\a\\AppData\\Roaming\\znada\\wallpapers');
  assert.strictEqual(resolved.custom, false);
  // The profile itself is the anchor, so the default can never read as "unavailable".
  assert.strictEqual(resolved.anchor, PROFILE);
});

check('a chosen folder is used through our own subfolder, never directly', () => {
  const resolved = mediaRoot.resolveManagedRoot({ userDataPath: PROFILE, mediaFolder: 'D:\\Картинки' });
  assert.strictEqual(resolved.root, 'D:\\Картинки\\Znada');
  assert.strictEqual(resolved.parent, 'D:\\Картинки');
  assert.strictEqual(resolved.anchor, 'D:\\Картинки');
  assert.strictEqual(resolved.custom, true);
});

check('dev and diagnostics profiles never share one folder with the real one', () => {
  const dev = mediaRoot.resolveManagedRoot({
    userDataPath: 'C:\\Users\\a\\AppData\\Local\\Znada-Dev', mediaFolder: 'D:\\pics',
  });
  const diag = mediaRoot.resolveManagedRoot({
    userDataPath: 'C:\\Users\\a\\AppData\\Local\\Znada-Diagnostics', mediaFolder: 'D:\\pics',
  });
  const live = mediaRoot.resolveManagedRoot({ userDataPath: PROFILE, mediaFolder: 'D:\\pics' });
  assert.strictEqual(dev.root, 'D:\\pics\\Znada-Dev');
  assert.strictEqual(diag.root, 'D:\\pics\\Znada-Diagnostics');
  assert.strictEqual(live.root, 'D:\\pics\\Znada');
  // Sharing one folder would let each profile's sweeper move the other's files to trash.
  assert.strictEqual(new Set([dev.root, diag.root, live.root]).size, 3);
});

check('one folder has one spelling', () => {
  const spellings = ['D:\\pics', 'D:/pics', 'D:\\pics\\', 'D:\\pics\\sub\\..', '  D:\\pics  '];
  const roots = spellings.map((mediaFolder) => (
    mediaRoot.resolveManagedRoot({ userDataPath: PROFILE, mediaFolder }).root
  ));
  assert.deepStrictEqual(new Set(roots), new Set(['D:\\pics\\Znada']));
});

check('a drive root and a network share keep being roots', () => {
  assert.strictEqual(mediaRoot.normalizeFolder('D:\\'), 'D:\\');
  assert.strictEqual(mediaRoot.normalizeFolder('\\\\nas\\photos\\'), '\\\\nas\\photos\\');
  assert.strictEqual(
    mediaRoot.resolveManagedRoot({ userDataPath: PROFILE, mediaFolder: '\\\\nas\\photos' }).root,
    '\\\\nas\\photos\\Znada',
  );
});

check('anything that is not an absolute Windows path is refused, not guessed', () => {
  for (const value of ['', '   ', null, undefined, 'pics', '.\\pics', '..\\pics']) {
    assert.strictEqual(mediaRoot.normalizeFolder(value), '', `must refuse: ${String(value)}`);
    // …and a refused value falls back to the profile rather than becoming a root.
    assert.strictEqual(
      mediaRoot.resolveManagedRoot({ userDataPath: PROFILE, mediaFolder: value }).custom, false,
    );
  }
});

check('system folders and the profile itself are named as problems', () => {
  const systemRoots = ['C:\\Windows', 'C:\\Program Files'];
  const ask = (folder) => mediaRoot.folderProblem({ folder, userDataPath: PROFILE, systemRoots });
  assert.strictEqual(ask('C:\\Windows\\System32'), mediaRoot.PROBLEMS.SYSTEM);
  assert.strictEqual(ask('C:\\Program Files'), mediaRoot.PROBLEMS.SYSTEM);
  assert.strictEqual(ask(`${PROFILE}\\wallpapers`), mediaRoot.PROBLEMS.PROFILE);
  assert.strictEqual(ask('pics'), mediaRoot.PROBLEMS.RELATIVE);
  assert.strictEqual(ask('D:\\Картинки'), null);
  // A neighbour whose name merely starts the same way is NOT inside it.
  assert.strictEqual(ask('C:\\Windows2'), null);
});

check('the folder the profile sits in is refused: Znada\'s subfolder there IS the profile', () => {
  // Found 2026-09-24 through the real main.js: after a move out, picking %APPDATA% passed
  // every check, the managed root became the profile, and one sweep moved config.json,
  // config.library.json and cloud-session.bin into .trash.
  const ask = (folder, userDataPath) => mediaRoot.folderProblem({ folder, userDataPath, systemRoots: [] });
  // The installed profile: "Znada" in %APPDATA% is the same folder as "znada".
  assert.strictEqual(ask('C:\\Users\\a\\AppData\\Roaming', PROFILE), mediaRoot.PROBLEMS.PROFILE);
  assert.strictEqual(ask('c:\\users\\A\\appdata\\roaming\\', PROFILE), mediaRoot.PROBLEMS.PROFILE);
  // Dev and diagnostics keep their own names, and the same rule holds for them.
  const dev = 'C:\\Users\\a\\AppData\\Local\\Znada-Dev';
  assert.strictEqual(ask('C:\\Users\\a\\AppData\\Local', dev), mediaRoot.PROBLEMS.PROFILE);
  // A neighbouring folder whose subfolder is NOT the profile stays allowed.
  assert.strictEqual(ask('C:\\Users\\a\\AppData', PROFILE), null);
  assert.strictEqual(ask('C:\\Users\\a\\AppData\\Local', PROFILE), null);
  // Without a profile to compare with, nothing new is refused.
  assert.strictEqual(ask('C:\\Users\\a\\AppData\\Roaming', ''), null);
});

check('a missing folder is a freeze, and a missing subfolder is not', () => {
  assert.deepStrictEqual(
    mediaRoot.rootState({ rootExists: true, anchorExists: true }), { state: 'ready', reason: '' },
  );
  // The user picked the place and it is there; our own subfolder gets created on use.
  assert.deepStrictEqual(
    mediaRoot.rootState({ rootExists: false, anchorExists: true }), { state: 'creatable', reason: '' },
  );
  // The place itself is gone — unplugged drive, silent share. Nothing may be written,
  // deleted or declared missing until it is back.
  assert.deepStrictEqual(
    mediaRoot.rootState({ rootExists: false, anchorExists: false }), { state: 'unavailable', reason: 'missing' },
  );
  // A hand-edited setting pointing somewhere forbidden freezes too: it must never
  // silently fall back to the profile, or the files would live in two places at once.
  assert.deepStrictEqual(
    mediaRoot.rootState({ rootExists: true, anchorExists: true, invalid: true }),
    { state: 'unavailable', reason: 'invalid' },
  );
});

console.log(`PASS media-root: ${checks} checks`);
