'use strict';

// BUG-050 and QA-014, through the REAL main.js. Found by the 1.7.6 release gate.
//
// Znada makes its own folder only when the first picture lands in it. A profile that
// only ever used watched folders has none, and choosing a folder for Znada's files there
// was refused as "the current folder is not reachable" — the one case in which there is
// nothing at all to lose. An unplugged drive must still be refused: its files are only
// out of reach for now, which is not the same as an empty folder (owner's rule, 2026-09-09).
//
// QA-014 lives here too: the sweeper's "empty pool, touch nothing" guard held only by
// the code — deleting it left every test green, and its absence once swept the owner's
// files away.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), `znada-mfempty-${label}-`));
}

// A profile exactly as a watched-folders-only user has it: settings, no folder of ours.
function profileWithoutOwnFolder(label, config = { monitors: {} }) {
  const userData = H.makeTempProfile(label);
  fs.rmSync(path.join(userData, 'wallpapers'), { recursive: true, force: true });
  H.writeJson(path.join(userData, 'config.json'), config);
  return userData;
}

(async () => {
  {
    const userData = profileWithoutOwnFolder('never-made');
    const main = H.loadMain(userData);
    main.__test.loadConfig();
    const chosen = tempDir('chosen');
    const newRoot = path.join(chosen, path.basename(userData));

    await check('choosing a folder is asked as "nothing to move yet", not refused', async () => {
      const plan = await main.invoke('media-folder-plan', chosen);
      assert.strictEqual(plan.ok, true, `refused: ${JSON.stringify(plan.blockers)}`);
      assert.deepStrictEqual(plan.blockers, []);
      assert.strictEqual(plan.count, 0);
      assert.strictEqual(plan.to, newRoot);
    });

    await check('the move changes where new pictures go and creates no folder of its own', async () => {
      const moved = await main.invoke('media-folder-move', chosen);
      assert.strictEqual(moved.status, 'done', `move ended as ${moved.status}`);
      assert.strictEqual(main.__test.getConfig().mediaFolder, chosen, 'the setting names the chosen folder');
      assert.strictEqual(main.__test.managedRoot().root, newRoot, 'and the app now asks the new place');
      assert.ok(!fs.existsSync(newRoot), 'the folder is made by the first picture, not by the move');
      assert.ok(!fs.existsSync(path.join(userData, 'wallpapers')), 'nothing appears in the profile either');
      const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
      assert.strictEqual(onDisk.mediaFolder, chosen, 'the choice is written, not only held in memory');
    });

    await check('and the way back works the same while the new folder is still unmade', async () => {
      const plan = await main.invoke('media-folder-plan', { appFolder: true });
      assert.strictEqual(plan.ok, true, `refused: ${JSON.stringify(plan.blockers)}`);
      assert.strictEqual(plan.count, 0);
      const moved = await main.invoke('media-folder-move', { appFolder: true });
      assert.strictEqual(moved.status, 'done');
      assert.strictEqual(main.__test.getConfig().mediaFolder, '');
      assert.strictEqual(main.__test.managedRoot().root, path.join(userData, 'wallpapers'));
    });
    H.unloadMain();
  }

  {
    // The chosen folder was on a drive that is not plugged in now.
    const unplugged = 'Q:\\не подключён';
    const userData = profileWithoutOwnFolder('unplugged', { monitors: {}, mediaFolder: unplugged });
    const main = H.loadMain(userData);
    main.__test.loadConfig();

    await check('a folder on an unplugged drive is still refused as unreachable', async () => {
      const elsewhere = tempDir('elsewhere');
      const plan = await main.invoke('media-folder-plan', elsewhere);
      assert.strictEqual(plan.ok, false);
      assert.ok(plan.blockers.some((b) => b.code === 'source-missing'), JSON.stringify(plan.blockers));
      const moved = await main.invoke('media-folder-move', elsewhere);
      assert.strictEqual(moved.status, 'blocked');
      assert.strictEqual(main.__test.getConfig().mediaFolder, unplugged, 'the setting is left alone');
    });
    H.unloadMain();
  }

  {
    // QA-014. Files in our folder, a pool with nothing in it: the pool is what is broken
    // or in between, not the files. The sweeper must leave every one where it is.
    const userData = H.makeTempProfile('empty-pool');
    H.writeJson(path.join(userData, 'config.json'), { monitors: {} });
    const own = path.join(userData, 'wallpapers');
    const files = ['wp-aaaa.png', 'wp-bbbb.jpg'].map((name) => {
      const file = path.join(own, name);
      fs.writeFileSync(file, `bytes of ${name}`);
      return file;
    });
    const main = H.loadMain(userData);
    main.__test.loadConfig();
    assert.strictEqual(Object.keys(main.__test.getConfig().library || {}).length, 0, 'setup: the pool is empty');

    await check('the sweeper touches nothing while the pool is empty', async () => {
      main.__test.gcWallpapers();
      for (const file of files) assert.ok(fs.existsSync(file), `${path.basename(file)} must stay where it is`);
      assert.ok(!fs.existsSync(path.join(own, '.trash')), 'not even moved to its recovery folder');
    });
    H.unloadMain();
  }

  console.log(`PASS media-folder-empty: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
