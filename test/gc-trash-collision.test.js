'use strict';

// BUG-084, through the REAL main.js. Found by the 1.9.0 release gate (03-data).
//
// The sweeper moves an orphaned own copy into wallpapers/.trash under the SAME name.
// On Windows fs.renameSync replaces an existing destination (MoveFileEx with
// MOVEFILE_REPLACE_EXISTING), so a file already waiting in .trash under that name was
// silently overwritten — the one place meant to keep things recoverable lost bytes.
// Both sets of bytes must survive; nothing the library still references may move.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const { makeTempDir } = require('./helpers/temp-dir');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok ${name}`);
}

function trashFiles(trash) {
  return fs.readdirSync(trash).sort();
}

function contentsOf(trash) {
  return trashFiles(trash).map((name) => fs.readFileSync(path.join(trash, name), 'utf8')).sort();
}

(async () => {
  const userData = H.makeTempProfile('gc-collision');
  H.writeJson(path.join(userData, 'config.json'), { monitors: {} });
  const own = path.join(userData, 'wallpapers');
  const trash = path.join(own, '.trash');
  const main = H.loadMain(userData);
  main.__test.loadConfig();

  // A non-empty pool, or the sweeper rightly touches nothing (QA-014).
  const source = H.writeImage(path.join(makeTempDir('znada-gc-collision-src-'), 'kept.png'));
  const added = await main.invoke('library-add-paths', [source], '');
  const keptPath = Object.values(added.config.library)[0].path;
  assert.strictEqual(path.dirname(keptPath), own, 'setup: the kept photo is our own copy');
  const keptBytes = fs.readFileSync(keptPath);

  fs.mkdirSync(trash, { recursive: true });
  const earlier = path.join(trash, 'wp-orphan.png');
  fs.writeFileSync(earlier, 'bytes swept away by an earlier pass');
  const orphan = path.join(own, 'wp-orphan.png');
  fs.writeFileSync(orphan, 'bytes of the file being swept now');

  await check('a name already in .trash is not overwritten: both sets of bytes survive', async () => {
    main.__test.gcWallpapers();
    assert.ok(!fs.existsSync(orphan), 'the orphan still leaves the folder');
    assert.strictEqual(fs.readFileSync(earlier, 'utf8'), 'bytes swept away by an earlier pass',
      'the file already in .trash keeps its name and its bytes');
    assert.deepStrictEqual(contentsOf(trash),
      ['bytes of the file being swept now', 'bytes swept away by an earlier pass']);
  });

  await check('a referenced own copy never moves', async () => {
    assert.ok(fs.existsSync(keptPath));
    assert.deepStrictEqual(fs.readFileSync(keptPath), keptBytes);
  });

  await check('a third file of the same name gets yet another free name', async () => {
    fs.writeFileSync(orphan, 'third bytes');
    main.__test.gcWallpapers();
    assert.ok(!fs.existsSync(orphan));
    assert.deepStrictEqual(contentsOf(trash),
      ['bytes of the file being swept now', 'bytes swept away by an earlier pass', 'third bytes']);
    assert.strictEqual(trashFiles(trash).length, 3);
  });

  await check('sweeping again with no orphans changes nothing (idempotent)', async () => {
    const before = trashFiles(trash);
    main.__test.gcWallpapers();
    assert.deepStrictEqual(trashFiles(trash), before);
    assert.ok(fs.existsSync(keptPath));
  });

  await check('a plain orphan with no clash keeps its own name in .trash', async () => {
    const plain = path.join(own, 'wp-plain.jpg');
    fs.writeFileSync(plain, 'plain');
    main.__test.gcWallpapers();
    assert.ok(!fs.existsSync(plain));
    assert.strictEqual(fs.readFileSync(path.join(trash, 'wp-plain.jpg'), 'utf8'), 'plain');
  });

  await check('a file outside our folder is never touched by the sweeper', async () => {
    assert.ok(fs.existsSync(source), 'the user\'s original next to nothing of ours stays');
  });

  H.unloadMain();
  console.log(`PASS gc-trash-collision: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
