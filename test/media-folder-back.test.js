'use strict';

// DATA-006 step 3 fixes, through the REAL main.js and the same IPC the window calls.
//
// Two findings from the review of #34 and the check of that review (2026-09-24):
// - there was no way back to the app's own folder once the files had moved out;
// - the way a user would try instead — picking the folder the profile sits in — passed
//   every check. Znada's subfolder there IS the profile, and one sweep then moved
//   config.json, config.library.json and cloud-session.bin into .trash. That was measured
//   before the fix; the last block below is the same state, now refused.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok ${name}`);
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `znada-back-${label}-`));
}

const PROFILE_FILES = ['config.json', 'config.library.json', 'cloud-session.bin'];

(async () => {
  // --- a profile that moves out and then comes back ------------------------------
  const userData = H.makeTempProfile('media-folder-back');
  H.writeJson(path.join(userData, 'config.json'), { monitors: {} });
  fs.writeFileSync(path.join(userData, 'cloud-session.bin'), 'session');
  const main = H.loadMain(userData);
  main.__test.loadConfig();

  const source = tempDir('src');
  const photo = (name, body) => { fs.writeFileSync(path.join(source, name), body); return path.join(source, name); };
  const added = await main.invoke('library-add-paths', [photo('one.png', 'first photo'), photo('two.png', 'second photo')], '');
  assert.strictEqual(added.added, 2, 'setup: two photos in the library');
  // One is removed: its record sits in the library trash and has to survive both moves.
  const removed = Object.values(main.__test.getConfig().library)[0];
  await main.invoke('library-remove-many', [{ id: removed.id, path: removed.path, type: 'image' }]);
  const libraryTrash = () => main.__test.getConfig().libraryTrash || [];
  assert.strictEqual(libraryTrash().length, 1, 'setup: one record in the library trash');
  // And one old copy in the sweeper's own recovery folder, which the plan has to name.
  const appFolder = main.__test.managedRoot().root;
  fs.mkdirSync(path.join(appFolder, '.trash'), { recursive: true });
  fs.writeFileSync(path.join(appFolder, '.trash', 'wp-old.png'), 'an old copy');

  const chosen = tempDir('chosen');
  const out = await main.invoke('media-folder-move', chosen);
  assert.strictEqual(out.status, 'done', `setup: moved out (${out.error || out.status})`);

  await check('the folder the profile sits in is refused, and nothing is touched', async () => {
    const parent = path.dirname(userData);
    const plan = await main.invoke('media-folder-plan', parent);
    assert.strictEqual(plan.ok, false);
    assert.deepStrictEqual(plan.blockers.map((blocker) => blocker.code), ['profile']);
    const moved = await main.invoke('media-folder-move', parent);
    assert.strictEqual(moved.status, 'blocked');
    assert.deepStrictEqual(moved.blockers.map((blocker) => blocker.code), ['profile']);
    assert.strictEqual(main.__test.getConfig().mediaFolder, chosen);
    for (const name of PROFILE_FILES) assert.ok(fs.existsSync(path.join(userData, name)), `${name} stays put`);
  });

  await check('an empty or broken target never means "move it all back"', async () => {
    for (const raw of ['', null, {}, { appFolder: 'yes' }, 42]) {
      const moved = await main.invoke('media-folder-move', raw);
      assert.strictEqual(moved.status, 'blocked', `${JSON.stringify(raw)} must be refused`);
    }
    assert.strictEqual(main.__test.getConfig().mediaFolder, chosen);
  });

  await check('the way back is planned like any move and names the recovery-folder share', async () => {
    const plan = await main.invoke('media-folder-plan', { appFolder: true });
    assert.strictEqual(plan.ok, true, JSON.stringify(plan.blockers));
    assert.strictEqual(plan.toAppFolder, true);
    assert.strictEqual(plan.to, appFolder);
    assert.strictEqual(plan.trashCount, 1);
    assert.strictEqual(plan.count, 3, 'both copies (one of them removed) and the old one');
  });

  await check('moving back returns every file and record to the app folder', async () => {
    const back = await main.invoke('media-folder-move', { appFolder: true });
    assert.strictEqual(back.status, 'done', back.error);
    const config = main.__test.getConfig();
    assert.strictEqual(config.mediaFolder, '');
    const resolved = main.__test.managedRoot();
    assert.strictEqual(resolved.custom, false);
    assert.strictEqual(resolved.root, appFolder);
    for (const item of Object.values(config.library)) {
      assert.strictEqual(path.dirname(item.path), appFolder);
      assert.ok(fs.existsSync(item.path), 'every record names a file that is there');
    }
    assert.strictEqual(libraryTrash().length, 1, 'the library trash keeps its record');
    const entry = libraryTrash()[0];
    const trashed = (entry.item || entry).path;
    assert.strictEqual(path.dirname(trashed), appFolder);
    assert.ok(fs.existsSync(trashed));
    assert.ok(fs.existsSync(path.join(appFolder, '.trash', 'wp-old.png')), 'the recovery folder came back too');
    const settings = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    assert.strictEqual(settings.mediaFolder || '', '', 'the way back survives a restart');
  });

  await check('back in the app folder there is nowhere further back to go', async () => {
    const again = await main.invoke('media-folder-plan', { appFolder: true });
    assert.strictEqual(again.ok, false);
    assert.ok(again.blockers.some((blocker) => blocker.code === 'nested'));
  });

  H.unloadMain();

  // --- a saved setting that already names the profile's parent -------------------
  // Only a hand edit (or a build from before this fix) can produce it now. It must
  // freeze like an unplugged drive: no sweep, no reading the profile, no moving out.
  const edited = H.makeTempProfile('media-folder-edited');
  H.writeJson(path.join(edited, 'config.json'), { monitors: {}, mediaFolder: path.dirname(edited) });
  fs.writeFileSync(path.join(edited, 'cloud-session.bin'), 'session');
  // A pool that is not empty, or the sweeper would bail out for that reason instead.
  const outside = photo('outside.png', 'a photo that lives outside');
  const item = library.makeItem('image', outside);
  H.writeJson(path.join(edited, 'config.library.json'), { version: 1, library: { [item.id]: item }, trash: [] });
  const second = H.loadMain(edited);
  second.__test.loadConfig();

  await check('a saved folder that makes the profile Znada\'s folder freezes instead of sweeping', async () => {
    const resolved = second.__test.managedRoot();
    assert.strictEqual(path.resolve(resolved.root).toLowerCase(), path.resolve(edited).toLowerCase(),
      'setup: the saved setting really points at the profile');
    assert.strictEqual(resolved.state, 'unavailable');
    assert.strictEqual(resolved.reason, 'invalid');
    second.__test.gcWallpapers();
    for (const name of PROFILE_FILES) assert.ok(fs.existsSync(path.join(edited, name)), `${name} is not swept`);
    assert.strictEqual(fs.existsSync(path.join(edited, '.trash')), false);
  });

  await check('a window may not read the profile through that folder', async () => {
    for (const name of PROFILE_FILES) {
      assert.strictEqual(second.__test.isAuthorizedMediaPath(path.join(edited, name)), false, name);
    }
  });

  await check('and nothing may be moved out of it', async () => {
    const elsewhere = tempDir('elsewhere');
    const plan = await second.invoke('media-folder-plan', elsewhere);
    assert.deepStrictEqual(plan.blockers.map((blocker) => blocker.code), ['source-invalid']);
    const moved = await second.invoke('media-folder-move', elsewhere);
    assert.strictEqual(moved.status, 'blocked');
    assert.deepStrictEqual(fs.readdirSync(elsewhere), [], 'nothing was copied');
    for (const name of PROFILE_FILES) assert.ok(fs.existsSync(path.join(edited, name)));
  });

  H.unloadMain();
  console.log(`PASS media-folder-back: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
