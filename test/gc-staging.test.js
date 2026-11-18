'use strict';

// BUG-087, through the REAL main.js. Found by the 1.9.0 release gate (02-diff, F9).
//
// Import and network downloads stage their bytes in wallpapers/.download-<pid>-<hex>.tmp
// (BUG-076). Nothing references that file, so the sweeper used to move it into .trash
// mid-write: removing a slot thumbnail during a large import made the import fail with
// ENOENT and left a .tmp in .trash. The sweeper must leave this run's staging files
// alone; a leftover of a crashed run may go to .trash (never deleted), but only once it
// has stopped changing for a long while.

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

const HOUR = 60 * 60 * 1000;
function age(file, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
}

(async () => {
  const userData = H.makeTempProfile('gc-staging');
  H.writeJson(path.join(userData, 'config.json'), { monitors: {} });
  const own = path.join(userData, 'wallpapers');
  const trash = path.join(own, '.trash');
  const main = H.loadMain(userData);
  main.__test.loadConfig();

  // A non-empty pool, or the sweeper rightly touches nothing (QA-014).
  const srcDir = makeTempDir('znada-gc-staging-src-');
  const source = H.writeImage(path.join(srcDir, 'kept.png'));
  const added = await main.invoke('library-add-paths', [source], '');
  const keptPath = Object.values(added.config.library)[0].path;
  assert.strictEqual(path.dirname(keptPath), own, 'setup: the kept photo is our own copy');

  const trashed = () => (fs.existsSync(trash) ? fs.readdirSync(trash) : []);

  await check('a staging file of this run stays put, however old', async () => {
    const mine = path.join(own, `.download-${process.pid}-0123456789abcdef.tmp`);
    fs.writeFileSync(mine, 'bytes still being written');
    age(mine, 48 * HOUR); // a stalled download is still ours while this process lives
    main.__test.gcWallpapers();
    assert.ok(fs.existsSync(mine), 'the in-flight staging file was moved by the sweeper');
    assert.deepStrictEqual(trashed().filter((f) => f.endsWith('.tmp')), []);
    fs.rmSync(mine);
  });

  await check('a recent staging file of another process stays put', async () => {
    const other = path.join(own, `.download-${process.pid + 1}-fedcba9876543210.tmp`);
    fs.writeFileSync(other, 'recent');
    main.__test.gcWallpapers();
    assert.ok(fs.existsSync(other));
    fs.rmSync(other);
  });

  await check('an old leftover of a crashed run goes to .trash, never deleted', async () => {
    const stale = path.join(own, `.download-${process.pid + 1}-aaaaaaaaaaaaaaaa.tmp`);
    fs.writeFileSync(stale, 'leftover of a crash');
    age(stale, 2 * 24 * HOUR);
    main.__test.gcWallpapers();
    assert.ok(!fs.existsSync(stale));
    assert.strictEqual(fs.readFileSync(path.join(trash, path.basename(stale)), 'utf8'), 'leftover of a crash');
  });

  await check('a real import survives a sweep that runs while it streams', async () => {
    // Large enough that the stream is still open when the sweep runs.
    const big = path.join(srcDir, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(96 * 1024 * 1024, 7));
    const before = new Set(trashed());
    let seen = '';
    const pending = main.invoke('library-add-paths', [big], '').then(
      (r) => ({ ok: r }), (err) => ({ err }));
    let done = false;
    pending.then(() => { done = true; });
    while (!done && !seen) {
      seen = fs.readdirSync(own).find((f) => /^\.download-.*\.tmp$/.test(f)) || '';
      if (seen) main.__test.gcWallpapers(); // what remove-slot-item / clear-slot do
      else await new Promise((r) => { setImmediate(r); });
    }
    const res = await pending;
    assert.ok(seen, 'setup: the sweep must run while the staging file exists');
    assert.ok(res.ok, `the import failed: ${res.err && (res.err.code || res.err.message)}`);
    const items = Object.values(res.ok.config.library).filter((it) => it.path !== keptPath);
    assert.strictEqual(items.length, 1, 'the big photo is in the pool');
    assert.ok(fs.existsSync(items[0].path) && fs.statSync(items[0].path).size === 96 * 1024 * 1024);
    assert.deepStrictEqual(trashed().filter((f) => !before.has(f)), [], 'nothing new in .trash');
    assert.deepStrictEqual(fs.readdirSync(own).filter((f) => f.endsWith('.tmp')), [], 'staging cleaned up');
  });

  await check('a referenced own copy never moves; ordinary orphans still do', async () => {
    const orphan = path.join(own, 'wp-orphan.png');
    fs.writeFileSync(orphan, 'orphan');
    main.__test.gcWallpapers();
    assert.ok(fs.existsSync(keptPath));
    assert.ok(!fs.existsSync(orphan));
    assert.ok(trashed().includes('wp-orphan.png'));
  });

  H.unloadMain();
  console.log(`PASS gc-staging: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
