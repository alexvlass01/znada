'use strict';

// DATA-006 step 2. The move, on real files.
//
// Every check here uses real directories and real bytes, because the failures this code
// exists to prevent are filesystem failures: a half-written copy, a name that already
// belongs to something else, a stop in the middle. A mocked filesystem would agree with
// whatever the code believes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mediaMove = require('../src/media-move');
const profileMigration = require('../src/profile-migration');
const library = require('../src/library');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok ${name}`);
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `znada-move-${label}-`));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// A source folder shaped like a real one: photos, plus the recoverable trash beside them.
function makeSource(label, { extra = {} } = {}) {
  const root = path.join(tempDir(label), 'Znada');
  writeFile(path.join(root, 'wp-aaaa.png'), 'first photo');
  writeFile(path.join(root, 'wp-bbbb.jpg'), 'second photo');
  writeFile(path.join(root, '.trash', 'wp-cccc.png'), 'removed but restorable');
  for (const [relative, content] of Object.entries(extra)) writeFile(path.join(root, relative), content);
  return root;
}

function documentsFor(root) {
  const pool = {};
  const first = library.addPath(pool, 'image', path.join(root, 'wp-aaaa.png'), {});
  const second = library.addPath(pool, 'image', path.join(root, 'wp-bbbb.jpg'), {});
  const outside = library.addPath(pool, 'folder', 'D:\\Мои фото', {});
  return {
    config: {
      monitors: { 'MONITOR-1': { light: { itemIds: [first] }, dark: { itemIds: [second, outside] } } },
      lightWallpaper: path.join(root, 'wp-aaaa.png'),
      darkWallpaper: '',
    },
    store: { version: 1, library: pool, trash: [] },
    ids: { first, second, outside },
  };
}

function remapperFor(documents, from, to) {
  return () => profileMigration.remapMediaRoot({
    oldRoot: from, newRoot: to, config: documents.config, store: documents.store,
  });
}

(async () => {
  await check('the plan counts everything that has to travel, trash included', () => {
    const from = makeSource('plan');
    const to = path.join(tempDir('plan-dest'), 'Znada');
    const plan = mediaMove.planMove({ from, to, anchor: path.dirname(to) });
    assert.strictEqual(plan.count, 3, 'two photos and the one in trash');
    assert.strictEqual(plan.bytes, ['first photo', 'second photo', 'removed but restorable']
      .reduce((sum, text) => sum + Buffer.byteLength(text), 0));
    assert.deepStrictEqual(plan.blockers, []);
  });

  await check('the plan refuses nesting, a missing source and a missing destination', () => {
    const from = makeSource('blockers');
    const inside = path.join(from, 'inner');
    assert.strictEqual(
      mediaMove.planMove({ from, to: inside, anchor: from }).blockers[0].code, mediaMove.BLOCKERS.NESTED,
    );
    const gone = path.join(from, '..', 'not-there');
    assert.ok(mediaMove.planMove({ from: gone, to: path.join(tempDir('b2'), 'Znada'), anchor: tempDir('b3') })
      .blockers.some((b) => b.code === mediaMove.BLOCKERS.SOURCE_MISSING));
    const unplugged = 'Q:\\не подключён';
    assert.ok(mediaMove.planMove({ from, to: path.join(unplugged, 'Znada'), anchor: unplugged })
      .blockers.some((b) => b.code === mediaMove.BLOCKERS.DESTINATION_MISSING));
  });

  await check('a folder not made yet is nothing to move when its place is named and there', () => {
    // BUG-050: a profile that never downloaded or added a picture has no folder of our
    // own. Asking to move it is asking to change where new pictures go.
    const profile = tempDir('never-made');
    const from = path.join(profile, 'wallpapers');
    const anchor = tempDir('never-made-dest');
    const plan = mediaMove.planMove({ from, fromAnchor: profile, to: path.join(anchor, 'Znada'), anchor });
    assert.deepStrictEqual(plan.blockers, [], 'nothing stands in the way');
    assert.strictEqual(plan.count, 0);
    assert.strictEqual(plan.bytes, 0);
  });

  await check('a source whose place is not there stays refused, named or not', () => {
    // The unplugged drive: its absence is "temporarily unreachable", never "empty".
    const unplugged = 'Q:\\не подключён';
    const anchor = tempDir('unplugged-dest');
    const named = mediaMove.planMove({
      from: path.join(unplugged, 'Znada'), fromAnchor: unplugged, to: path.join(anchor, 'Znada'), anchor,
    });
    assert.ok(named.blockers.some((b) => b.code === mediaMove.BLOCKERS.SOURCE_MISSING));
    // And a caller that does not say where the source lives keeps the strict answer.
    const profile = tempDir('unnamed');
    const unnamed = mediaMove.planMove({ from: path.join(profile, 'wallpapers'), to: path.join(anchor, 'Znada'), anchor });
    assert.ok(unnamed.blockers.some((b) => b.code === mediaMove.BLOCKERS.SOURCE_MISSING));
  });

  await check('moving a folder not made yet commits the new place and creates nothing', async () => {
    const profile = tempDir('empty-run');
    const from = path.join(profile, 'wallpapers');
    const anchor = tempDir('empty-run-dest');
    const to = path.join(anchor, 'Znada');
    const commits = [];
    const report = await mediaMove.runMove({
      from, fromAnchor: profile, to, anchor, remap: () => ({ nothing: true }), commit: (docs) => commits.push(docs),
    });
    assert.strictEqual(report.status, 'done');
    assert.strictEqual(report.copied + report.alreadyThere, 0);
    assert.strictEqual(commits.length, 1, 'the new place is still written, once');
    assert.ok(!fs.existsSync(to), 'our folder is made by the first picture, not by the move');
    assert.ok(!fs.existsSync(from), 'and nothing appears where there was nothing');
  });

  await check('a finished move copies, verifies, commits once and clears the old folder', async () => {
    const from = makeSource('happy');
    const anchor = tempDir('happy-dest');
    const to = path.join(anchor, 'Znada');
    const documents = documentsFor(from);
    const commits = [];
    const report = await mediaMove.runMove({
      from, to, anchor, remap: remapperFor(documents, from, to), commit: (docs) => commits.push(docs),
    });

    assert.strictEqual(report.status, 'done');
    assert.strictEqual(report.copied, 3);
    assert.strictEqual(report.alreadyThere, 0);
    assert.strictEqual(commits.length, 1, 'the library is written exactly once');

    for (const relative of ['wp-aaaa.png', 'wp-bbbb.jpg', path.join('.trash', 'wp-cccc.png')]) {
      assert.ok(fs.existsSync(path.join(to, relative)), `${relative} must be at the new place`);
    }
    assert.strictEqual(fs.readFileSync(path.join(to, 'wp-aaaa.png'), 'utf8'), 'first photo');
    assert.ok(!fs.existsSync(from), 'the old folder is gone, including its empty shell');

    // And the library now names the new files, with ids recomputed from the new paths.
    const pool = commits[0].store.library;
    const movedFirst = library.idFor(path.join(to, 'wp-aaaa.png'));
    assert.ok(pool[movedFirst], 'the record moved with its file');
    assert.strictEqual(pool[movedFirst].path, path.join(to, 'wp-aaaa.png'));
    assert.deepStrictEqual(commits[0].config.monitors['MONITOR-1'].light.itemIds, [movedFirst],
      'the slot follows the record');
    assert.ok(pool[documents.ids.outside], 'a folder of the user\'s own is left exactly where it was');
    assert.strictEqual(commits[0].config.lightWallpaper, path.join(to, 'wp-aaaa.png'));
    assert.strictEqual(
      JSON.stringify(commits[0]).includes(from), false,
      'nothing may still point into the folder we just emptied',
    );
  });

  await check('an identical file already there is accepted, a different one stops the move', async () => {
    const from = makeSource('clash');
    const anchor = tempDir('clash-dest');
    const to = path.join(anchor, 'Znada');
    writeFile(path.join(to, 'wp-aaaa.png'), 'first photo');      // same bytes, already moved once
    const mine = writeFile(path.join(to, 'wp-bbbb.jpg'), 'something else entirely');
    const documents = documentsFor(from);
    const commits = [];
    const report = await mediaMove.runMove({
      from, to, anchor, remap: remapperFor(documents, from, to), commit: (docs) => commits.push(docs),
    });

    assert.strictEqual(report.status, 'failed');
    assert.match(String(report.error && report.error.message), /already there/);
    assert.strictEqual(commits.length, 0, 'the library must not be written');
    assert.strictEqual(fs.readFileSync(mine, 'utf8'), 'something else entirely',
      'a file that is not ours is never overwritten');
    assert.strictEqual(fs.readFileSync(path.join(to, 'wp-aaaa.png'), 'utf8'), 'first photo',
      'and the identical one that was already there is left alone, not deleted by the rollback');
    for (const relative of ['wp-aaaa.png', 'wp-bbbb.jpg']) {
      assert.ok(fs.existsSync(path.join(from, relative)), 'every original is still where it was');
    }
  });

  await check('stopping before the commit undoes our copies and touches nothing else', async () => {
    const from = makeSource('stop');
    const anchor = tempDir('stop-dest');
    const to = path.join(anchor, 'Znada');
    const documents = documentsFor(from);
    const commits = [];
    let calls = 0;
    const report = await mediaMove.runMove({
      from, to, anchor, remap: remapperFor(documents, from, to), commit: (docs) => commits.push(docs),
      shouldStop: () => { calls += 1; return calls > 1; }, // let one file through, then stop
    });

    assert.strictEqual(report.status, 'stopped');
    assert.strictEqual(commits.length, 0);
    assert.deepStrictEqual(fs.existsSync(to) ? fs.readdirSync(to) : [], [],
      'nothing of ours is left at the destination');
    for (const relative of ['wp-aaaa.png', 'wp-bbbb.jpg', path.join('.trash', 'wp-cccc.png')]) {
      assert.ok(fs.existsSync(path.join(from, relative)), `${relative} is untouched`);
    }
  });

  await check('a library that could not be written leaves every original where it was', async () => {
    const from = makeSource('commit-fails');
    const anchor = tempDir('commit-dest');
    const to = path.join(anchor, 'Znada');
    const documents = documentsFor(from);
    const report = await mediaMove.runMove({
      from, to, anchor, remap: remapperFor(documents, from, to),
      commit: () => { throw new Error('settings could not be written'); },
    });

    assert.strictEqual(report.status, 'failed');
    // This is the whole reason the deletion comes AFTER the commit and not before it:
    // a commit that fails must cost nothing, and the photos are still the only copies
    // the library knows about.
    for (const relative of ['wp-aaaa.png', 'wp-bbbb.jpg', path.join('.trash', 'wp-cccc.png')]) {
      assert.ok(fs.existsSync(path.join(from, relative)), `${relative} must still be there`);
    }
    assert.deepStrictEqual(fs.existsSync(to) ? fs.readdirSync(to) : [], [],
      'and our half-finished copies are cleaned up');
  });

  await check('stopping after the last file copies still does not commit', async () => {
    const from = makeSource('stop-late');
    const anchor = tempDir('stop-late-dest');
    const to = path.join(anchor, 'Znada');
    const documents = documentsFor(from);
    const commits = [];
    let asked = 0;
    const report = await mediaMove.runMove({
      from, to, anchor, remap: remapperFor(documents, from, to), commit: (docs) => commits.push(docs),
      // False for every file, true only at the last chance before the commit.
      shouldStop: () => { asked += 1; return asked > 3; },
    });

    assert.strictEqual(report.status, 'stopped');
    assert.strictEqual(commits.length, 0, 'the last chance to stop is a real one');
    for (const relative of ['wp-aaaa.png', 'wp-bbbb.jpg']) {
      assert.ok(fs.existsSync(path.join(from, relative)), 'every original survives a late stop');
    }
    assert.deepStrictEqual(fs.existsSync(to) ? fs.readdirSync(to) : [], []);
  });

  await check('a library that cannot be recomputed costs no copying at all', async () => {
    const from = makeSource('remap-fails');
    const anchor = tempDir('remap-dest');
    const to = path.join(anchor, 'Znada');
    const commits = [];
    const report = await mediaMove.runMove({
      from, to, anchor, commit: (docs) => commits.push(docs),
      remap: () => { throw new Error('перенос остановлен: записи схлопываются'); },
    });
    assert.strictEqual(report.status, 'failed');
    assert.match(String(report.error.message), /схлопываются/);
    assert.strictEqual(commits.length, 0);
    assert.strictEqual(report.copied, 0);
    assert.deepStrictEqual(fs.existsSync(to) ? fs.readdirSync(to) : [], [],
      'not one byte is written before the library is known to survive the move');
  });

  await check('a copy that does not match its source is refused and leaves nothing behind', async () => {
    const from = makeSource('short-write');
    const to = path.join(tempDir('short-dest'), 'Znada');
    const realCreateWriteStream = fs.createWriteStream;
    // A disk that accepts the write and keeps only part of it. The file exists, has a
    // plausible size, and is wrong — the exact failure reading the copy back catches.
    fs.createWriteStream = function truncating(file, options) {
      const stream = realCreateWriteStream.call(fs, file, options);
      const write = stream.write.bind(stream);
      stream.write = (chunk, encoding, callback) => write(
        Buffer.from(chunk).slice(0, Math.max(1, Buffer.from(chunk).length - 3)), encoding, callback,
      );
      return stream;
    };
    try {
      await assert.rejects(
        () => mediaMove.copyVerified(path.join(from, 'wp-aaaa.png'), path.join(to, 'wp-aaaa.png')),
        /did not match the source/,
      );
    } finally {
      fs.createWriteStream = realCreateWriteStream;
    }
    assert.ok(!fs.existsSync(path.join(to, 'wp-aaaa.png')), 'a bad copy never becomes the real name');
    const leftovers = (fs.existsSync(to) ? fs.readdirSync(to) : [])
      .filter((name) => name.startsWith(mediaMove.STAGING_PREFIX));
    assert.deepStrictEqual(leftovers, [], 'and its staging file is cleaned up');
  });

  await check('progress is reported against the real total', async () => {
    const from = makeSource('progress');
    const anchor = tempDir('progress-dest');
    const to = path.join(anchor, 'Znada');
    const documents = documentsFor(from);
    const seen = [];
    await mediaMove.runMove({
      from, to, anchor, remap: remapperFor(documents, from, to), commit: () => {},
      onProgress: (state) => seen.push(state),
    });
    const last = seen[seen.length - 1];
    assert.strictEqual(last.phase, 'done');
    assert.strictEqual(last.done, 3);
    assert.strictEqual(last.total, 3);
    assert.strictEqual(last.bytesDone, last.bytesTotal);
    assert.ok(seen.some((state) => state.phase === 'committing'), 'the commit is visible as its own phase');
    assert.ok(seen.some((state) => state.phase === 'cleaning'), 'so is the cleanup after it');
  });

  await check('a file left over from an interrupted attempt is not treated as content', () => {
    const from = makeSource('leftover', { extra: {
      [`${mediaMove.STAGING_PREFIX}9999-abcdef.tmp`]: 'half a photo from a crash',
    } });
    const plan = mediaMove.planMove({ from, to: path.join(tempDir('leftover-dest'), 'Znada'), anchor: tempDir('leftover-anchor') });
    assert.strictEqual(plan.count, 3, 'our own leftover is not one of the user\'s files');
  });

  await check('the same bytes under a name with no hash in it still verify', async () => {
    // Profiles from before content-addressed names carry files like `<id>-light.jpg`.
    const from = makeSource('legacy', { extra: { 'a1b2c3-light.jpg': 'an old copy from 2026' } });
    const to = path.join(tempDir('legacy-dest'), 'Znada');
    const result = await mediaMove.copyVerified(
      path.join(from, 'a1b2c3-light.jpg'), path.join(to, 'a1b2c3-light.jpg'),
    );
    assert.strictEqual(result.status, 'copied');
    assert.strictEqual(fs.readFileSync(path.join(to, 'a1b2c3-light.jpg'), 'utf8'), 'an old copy from 2026');
    assert.strictEqual(
      await mediaMove.hashFile(path.join(to, 'a1b2c3-light.jpg')),
      crypto.createHash('md5').update('an old copy from 2026').digest('hex'),
    );
  });

  console.log(`PASS media-move: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
