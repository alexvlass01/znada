'use strict';

// DATA-006 step 2, through the REAL main.js.
//
// src/media-move.js is tested on its own with real files; what only main can answer is
// tested here: which documents it hands over, what a commit actually writes to disk, and
// what the app believes about itself once the move is done. The previous rounds of
// data-loss defects in this project all lived in exactly that seam — the modules were
// right, the order main called them in was not.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers/main-harness');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok ${name}`);
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `znada-movemain-${label}-`));
}

(async () => {
  const userData = H.makeTempProfile('media-move-main');
  H.writeJson(path.join(userData, 'config.json'), { monitors: {} });
  const main = H.loadMain(userData);
  main.__test.loadConfig();

  // Two photos the ordinary way, so their copies are real imports rather than fixtures.
  const source = tempDir('src');
  // Distinct bytes on purpose: copies are named after their content, so two identical
  // files would dedupe into one record and the move would have half as much to carry.
  const photo = (name, body) => { fs.writeFileSync(path.join(source, name), body); return path.join(source, name); };
  const added = await main.invoke('library-add-paths', [
    photo('one.png', 'first photo bytes'),
    photo('two.png', 'second photo bytes'),
  ], '');
  assert.strictEqual(added.added, 2, 'setup: both photos must be in the library');

  const profileFolder = main.__test.managedRoot().root;
  const before = Object.values(main.__test.getConfig().library).map((item) => item.path).sort();
  await check('setup: the copies start inside the profile', () => {
    for (const file of before) assert.strictEqual(path.dirname(file), profileFolder);
  });

  // Put one of them on a monitor, so the slot has to follow the record.
  const firstId = Object.keys(main.__test.getConfig().library)[0];
  await main.invoke('library-assign', firstId, 'MONITOR-1', 'light');
  assert.ok((main.__test.getConfig().monitors['MONITOR-1'].light.itemIds || []).includes(firstId),
    'setup: the photo is on a monitor');

  const chosen = tempDir('chosen');
  const phases = [];
  const report = await main.__test.moveManagedFolder(chosen, { onProgress: (s) => phases.push(s.phase) });
  const expectedRoot = path.join(chosen, path.basename(userData));

  await check('the move finishes and reports what it did', () => {
    assert.strictEqual(report.status, 'done', `status was ${report.status}: ${report.error || ''}`);
    assert.strictEqual(report.copied, 2);
    assert.ok(phases.includes('copying') && phases.includes('committing') && phases.includes('cleaning'));
  });

  await check('the files are in the chosen folder and gone from the profile', () => {
    const moved = fs.readdirSync(expectedRoot).filter((name) => name !== '.trash');
    assert.strictEqual(moved.length, 2, 'both copies are at the new place');
    assert.ok(!fs.existsSync(profileFolder) || fs.readdirSync(profileFolder).length === 0,
      'and the profile folder is left empty or removed');
  });

  await check('the app now works from the new folder', () => {
    const resolved = main.__test.managedRoot();
    assert.strictEqual(resolved.root, expectedRoot);
    assert.strictEqual(resolved.custom, true);
    assert.strictEqual(resolved.state, 'ready');
    assert.strictEqual(main.__test.getConfig().mediaFolder, chosen);
  });

  await check('every record and the slot that names it moved together', () => {
    const config = main.__test.getConfig();
    for (const item of Object.values(config.library)) {
      assert.strictEqual(path.dirname(item.path), expectedRoot, `${item.path} must live in the new folder`);
      assert.ok(fs.existsSync(item.path), 'and the file it names must be there');
    }
    const slot = config.monitors['MONITOR-1'].light.itemIds;
    assert.strictEqual(slot.length, 1);
    assert.ok(config.library[slot[0]], 'the slot names a record that exists after the remap');
    assert.notStrictEqual(slot[0], firstId, 'the id is recomputed, because it is a hash of the path');
  });

  await check('what is on disk matches what is in memory', () => {
    const pool = JSON.parse(fs.readFileSync(path.join(userData, 'config.library.json'), 'utf8'));
    const settings = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
    assert.strictEqual(settings.mediaFolder, chosen, 'the chosen folder survives a restart');
    for (const item of Object.values(pool.library)) {
      assert.strictEqual(path.dirname(item.path), expectedRoot);
    }
    assert.deepStrictEqual(
      Object.keys(pool.library).sort(), Object.keys(main.__test.getConfig().library).sort(),
      'the pool on disk is the pool the app is using',
    );
    assert.strictEqual(JSON.stringify(settings).includes(profileFolder), false,
      'no setting still points into the folder that was emptied');
  });

  await check('moving to the folder it already lives in is refused, not half-done', async () => {
    const again = await main.__test.moveManagedFolder(chosen);
    assert.strictEqual(again.status, 'blocked');
    assert.ok(again.blockers.some((blocker) => blocker.code === 'nested'));
    // ...and nothing was disturbed by asking.
    for (const item of Object.values(main.__test.getConfig().library)) {
      assert.ok(fs.existsSync(item.path));
    }
  });

  await check('a folder Znada must not use is refused before anything is copied', async () => {
    const inProfile = await main.__test.moveManagedFolder(path.join(userData, 'somewhere'));
    assert.strictEqual(inProfile.status, 'blocked');
    assert.ok(inProfile.blockers.some((blocker) => blocker.code === 'profile'));
    assert.strictEqual((await main.__test.moveManagedFolder('не абсолютный путь')).status, 'blocked');
  });

  const addedAfter = await main.invoke('library-add-paths', [photo('three.png', 'third photo bytes')], '');
  await check('a photo added after the move lands in the new folder', () => {
    assert.strictEqual(addedAfter.added, 1);
    const newest = Object.values(addedAfter.config.library).find((item) => item.path.endsWith('three.png')
      || !before.includes(item.path));
    assert.ok(newest, 'the new photo has a record');
    assert.strictEqual(path.dirname(newest.path), expectedRoot);
  });

  await check('a library edit asked for mid-move is refused, not quietly queued', async () => {
    const second = tempDir('chosen2');
    const poolBefore = Object.keys(main.__test.getConfig().library).length;
    let refused = null;
    const moveResult = await main.__test.moveManagedFolder(second, {
      onProgress: async (state) => {
        // Asked for while the copying is under way. Step 2 made such an edit WAIT on the
        // library queue; step 3 refuses it at the IPC door instead, because waiting
        // silently for minutes reads as a frozen application. Either way it must not
        // import into a folder the move is emptying, or change the pool the commit is
        // about to rewrite.
        if (refused || state.phase !== 'copying' || !state.done) return;
        refused = await main.invoke('library-add-paths', [photo('four.png', 'fourth photo bytes')], '');
      },
    });

    assert.strictEqual(moveResult.status, 'done');
    assert.ok(refused, 'the edit has to have been attempted mid-move');
    assert.strictEqual(refused.error, 'media_move_running');
    assert.strictEqual(refused.added, 0);
    assert.strictEqual(Object.keys(main.__test.getConfig().library).length, poolBefore,
      'nothing entered the pool while it was being rewritten');
    for (const item of Object.values(main.__test.getConfig().library)) {
      assert.strictEqual(path.dirname(item.path), path.join(second, path.basename(userData)));
      assert.ok(fs.existsSync(item.path), 'every record still names a file that exists');
    }

    // ...and the very same edit works the moment the move is over.
    const after = await main.invoke('library-add-paths', [photo('four.png', 'fourth photo bytes')], '');
    assert.strictEqual(after.added, 1, 'the freeze ends with the move');
  });

  H.unloadMain();
  console.log(`PASS media-move-main: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
