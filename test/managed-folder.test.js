'use strict';

// CODE-001 2.1b. Direct unit tests for src/managed-folder.js:
// - where Znada's own copies live (default profile subdir vs custom mediaFolder, live readiness,
//   system/profile folder refusals);
// - local photo import (named copy, hash+size deduplication, refusal when unavailable or colliding);
// - watched-folder reference vs copy in photoForPool;
// - remote download staging, Content-Type validation, atomic commit, peer deduplication, and discard.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createManagedFolder } = require('../src/managed-folder');
const { makeTempDir } = require('./helpers/temp-dir');

let passed = 0;

async function test(name, fn) {
  const root = makeTempDir('znada-managed-folder-');
  try {
    await fn(root);
    passed += 1;
    console.log('  ok ' + name);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const OTHER_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452ff', 'hex');
const md5Hex16 = (buf) => crypto.createHash('md5').update(buf).digest('hex').slice(0, 16);

(async () => {
  await test('starts in profile wallpapers/ and switches on refresh() when config.mediaFolder changes', async (tmp) => {
    const profileDir = path.join(tmp, 'Znada-Dev');
    const customParent = path.join(tmp, 'Picked');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(customParent, { recursive: true });

    let config = { mediaFolder: '', library: {} };
    const mf = createManagedFolder({
      userDataPath: profileDir,
      getConfig: () => config,
    });

    assert.strictEqual(mf.wallpapersDir(), path.win32.join(profileDir, 'wallpapers'));
    assert.strictEqual(mf.trashDirPath(), path.win32.join(profileDir, 'wallpapers', '.trash'));
    assert.strictEqual(mf.current().custom, false);
    assert.strictEqual(mf.status().state, 'creatable');
    assert.strictEqual(mf.ready(), true);

    config = { mediaFolder: customParent, library: {} };
    mf.refresh();
    assert.strictEqual(mf.wallpapersDir(), path.win32.join(customParent, 'Znada-Dev'));
    assert.strictEqual(mf.current().custom, true);
    assert.strictEqual(mf.current().parent, path.win32.normalize(customParent));
    assert.strictEqual(mf.status().state, 'creatable');
    assert.strictEqual(mf.ready(), true);

    fs.mkdirSync(mf.wallpapersDir(), { recursive: true });
    assert.strictEqual(mf.status().state, 'ready');
    assert.strictEqual(mf.snapshot().state, 'ready');
  });

  await test('marks missing anchor or forbidden system/profile folders as unavailable', async (tmp) => {
    const profileDir = path.join(tmp, 'AppData', 'Znada');
    const winDir = path.join(tmp, 'Windows');
    const exeDir = path.join(tmp, 'InstallDir');
    const missingAnchor = path.join(tmp, 'UnpluggedDrive', 'Media');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(winDir, { recursive: true });
    fs.mkdirSync(exeDir, { recursive: true });

    let config = { mediaFolder: missingAnchor, library: {} };
    const mf = createManagedFolder({
      userDataPath: profileDir,
      getConfig: () => config,
      getExeDir: () => exeDir,
      env: { SystemRoot: winDir },
    });

    mf.refresh();
    assert.deepStrictEqual(mf.status(), { state: 'unavailable', reason: 'missing' });
    assert.strictEqual(mf.ready(), false);

    // Even when a forbidden directory exists on disk, invalid() forces unavailable/invalid.
    config = { mediaFolder: path.join(winDir, 'Sub'), library: {} };
    fs.mkdirSync(path.join(winDir, 'Sub', 'Znada'), { recursive: true });
    mf.refresh();
    assert.strictEqual(mf.invalid(), true);
    assert.deepStrictEqual(mf.status(), { state: 'unavailable', reason: 'invalid' });
    assert.strictEqual(mf.ready(), false);

    assert.strictEqual(mf.folderProblem(path.join(exeDir, 'Photos')), 'system');
    assert.strictEqual(mf.folderProblem(path.join(profileDir, 'inside')), 'profile');
    assert.strictEqual(mf.folderProblem(path.dirname(profileDir)), 'profile');
    assert.strictEqual(mf.folderProblem('relative/path'), 'relative');
  });

  await test('importWallpaper refuses when unavailable, copies with <name>-<hash>, and reuses only matching hash+size', async (tmp) => {
    const profileDir = path.join(tmp, 'Profile');
    const srcDir = path.join(tmp, 'Source');
    fs.mkdirSync(srcDir, { recursive: true });
    const srcA = path.join(srcDir, 'sunset.png');
    const srcB = path.join(srcDir, 'renamed.png');
    fs.writeFileSync(srcA, PNG_BYTES);
    fs.writeFileSync(srcB, PNG_BYTES);

    let config = { mediaFolder: path.join(tmp, 'MissingDrive'), library: {} };
    const mf = createManagedFolder({
      userDataPath: profileDir,
      getConfig: () => config,
    });
    mf.refresh();

    await assert.rejects(() => mf.importWallpaper(srcA), /Managed media folder is unavailable/);
    assert.strictEqual(fs.existsSync(mf.wallpapersDir()), false);

    // Switch back to the creatable profile root.
    fs.mkdirSync(profileDir, { recursive: true });
    config = { mediaFolder: '', library: {} };
    mf.refresh();

    const hash = md5Hex16(PNG_BYTES);
    const copiedA = await mf.importWallpaper(srcA);
    assert.strictEqual(path.basename(copiedA), `sunset-${hash}.png`);
    assert.ok(fs.readFileSync(copiedA).equals(PNG_BYTES));

    // Importing identical bytes under another filename reuses the first copy.
    const copiedB = await mf.importWallpaper(srcB);
    assert.strictEqual(copiedB, copiedA);

    // A legacy wp-<hash>.png of identical size is also reused.
    fs.unlinkSync(copiedA);
    const legacyPath = path.join(mf.wallpapersDir(), `wp-${hash}.png`);
    fs.writeFileSync(legacyPath, PNG_BYTES);
    const reusedLegacy = await mf.importWallpaper(srcA);
    assert.strictEqual(reusedLegacy, legacyPath);

    // A file that ends with -<hash>.png but has a different byte size is NEVER reused or overwritten.
    fs.unlinkSync(legacyPath);
    const imposter = path.join(mf.wallpapersDir(), `sunset-${hash}.png`);
    fs.writeFileSync(imposter, OTHER_BYTES);
    await assert.rejects(() => mf.importWallpaper(srcA), /EEXIST/);
    assert.ok(fs.readFileSync(imposter).equals(OTHER_BYTES), 'existing file must not be overwritten');
  });

  await test('a source replacement after the read cannot change the bytes filed under that hash', async (tmp) => {
    const profile = path.join(tmp, 'Profile');
    const source = path.join(tmp, 'source.png');
    const incoming = Buffer.from('AAAA');
    fs.mkdirSync(profile);
    fs.writeFileSync(source, incoming);
    const mf = createManagedFolder({ userDataPath: profile, getConfig: () => ({}) });
    mf.refresh();
    const createReadStream = fs.createReadStream;
    let exchanged = false;
    fs.createReadStream = (...args) => {
      const stream = createReadStream(...args);
      if (args[0] === source && !exchanged) stream.once('end', () => {
        fs.writeFileSync(source, 'BBBB');
        exchanged = true;
      });
      return stream;
    };
    try {
      const first = await mf.importWallpaper(source);
      assert.ok(exchanged);
      assert.deepStrictEqual(fs.readFileSync(first), incoming);
      assert.strictEqual(path.basename(first), `source-${md5Hex16(incoming)}.png`);
      fs.writeFileSync(source, incoming);
      assert.strictEqual(await mf.importWallpaper(source), first);
      assert.deepStrictEqual(fs.readdirSync(mf.wallpapersDir()), [path.basename(first)]);
    } finally {
      fs.createReadStream = createReadStream;
    }
  });

  await test('photoForPool references an active watched-folder image and copies hidden or outside files', async (tmp) => {
    const profileDir = path.join(tmp, 'Profile');
    const watchedDir = path.join(tmp, 'Watched');
    const hiddenSubdir = path.join(watchedDir, 'HiddenSub');
    const outsideDir = path.join(tmp, 'Outside');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(hiddenSubdir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    const inWatched = path.join(watchedDir, 'keep-in-place.png');
    const inHidden = path.join(hiddenSubdir, 'hidden-pic.png');
    const inOutside = path.join(outsideDir, 'outside-pic.png');
    fs.writeFileSync(inWatched, PNG_BYTES);
    fs.writeFileSync(inHidden, PNG_BYTES);
    fs.writeFileSync(inOutside, PNG_BYTES);

    const config = {
      mediaFolder: '',
      library: {
        f1: { id: 'f1', type: 'folder', path: watchedDir },
      },
    };
    const mf = createManagedFolder({
      userDataPath: profileDir,
      getConfig: () => config,
      getHiddenDirs: () => [hiddenSubdir],
      liveMaterializeExtra: (p, type) => ({ fromLive: p, type }),
    });

    const refResult = await mf.photoForPool(inWatched);
    assert.strictEqual(refResult.path, inWatched);
    assert.deepStrictEqual(refResult.extra, { fromLive: inWatched, type: 'image' });
    assert.strictEqual(fs.existsSync(mf.wallpapersDir()), false, 'no copy made for watched-folder photo');

    const hiddenResult = await mf.photoForPool(inHidden);
    assert.ok(hiddenResult.path.startsWith(mf.wallpapersDir()), 'photo under hidden subfolder is copied');
    assert.strictEqual(hiddenResult.extra, undefined);

    const outsideResult = await mf.photoForPool(inOutside);
    assert.ok(outsideResult.path.startsWith(mf.wallpapersDir()), 'photo outside watched folders is copied');
    assert.strictEqual(outsideResult.extra, undefined);
  });

  await test('stageDownloadImage, commitDownloadArtifact, discardDownloadArtifact and downloadWallpaperFromUrl enforce format, dedup, and path safety', async (tmp) => {
    const profileDir = path.join(tmp, 'Profile');
    const foreignDir = path.join(tmp, 'Foreign');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.mkdirSync(foreignDir, { recursive: true });

    let config = { mediaFolder: path.join(tmp, 'NoSuchDisk'), library: {} };
    let fetchCalls = 0;
    const mf = createManagedFolder({
      userDataPath: profileDir,
      getConfig: () => config,
      fetchImpl: async (url) => {
        fetchCalls += 1;
        if (String(url).includes('/404')) {
          return new Response('missing', { status: 404 });
        }
        if (String(url).includes('/wrong-mime')) {
          return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'text/html' } });
        }
        return new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });
      },
    });
    mf.refresh();

    // Unavailable root refuses before touching the network.
    await assert.rejects(
      () => mf.downloadWallpaperFromUrl('https://cdn.example.test/pic.png'),
      /Managed media folder is unavailable/,
    );
    assert.strictEqual(fetchCalls, 0);

    // Switch to ready profile root.
    config = { mediaFolder: '', library: {} };
    mf.refresh();
    const dir = mf.wallpapersDir();

    await assert.rejects(
      () => mf.stageDownloadImage(dir, 'https://cdn.example.test/404.png'),
      /HTTP 404/,
    );
    await assert.rejects(
      () => mf.stageDownloadImage(dir, 'https://cdn.example.test/wrong-mime.png', { expectedFormat: 'png' }),
      /Unexpected image Content-Type/,
    );

    // Stage + discard cleans up the temp file and leaves no final file.
    const staged1 = await mf.stageDownloadImage(dir, 'https://cdn.example.test/good.png', { expectedFormat: 'png' });
    assert.ok(staged1.stagingPath && fs.existsSync(staged1.stagingPath));
    assert.strictEqual(fs.existsSync(staged1.path), false);
    assert.strictEqual(mf.discardDownloadArtifact(staged1, dir), true);
    assert.strictEqual(fs.existsSync(staged1.stagingPath), false);

    // Stage + commit promotes to wp-<hash>.png and removes the staging file.
    const staged2 = await mf.stageDownloadImage(dir, 'https://cdn.example.test/good.png', { expectedFormat: 'png' });
    const committed = mf.commitDownloadArtifact(staged2, dir);
    assert.strictEqual(committed.created, true);
    assert.strictEqual(committed.path, staged2.path);
    assert.strictEqual(fs.existsSync(staged2.stagingPath), false);
    assert.ok(fs.readFileSync(committed.path).equals(PNG_BYTES));

    // When destination already exists, stageDownloadImage creates no temp file and commit reports created: false.
    const stagedDup = await mf.stageDownloadImage(dir, 'https://cdn.example.test/good.png', { expectedFormat: 'png' });
    assert.strictEqual(stagedDup.stagingPath, '');
    const committedDup = mf.commitDownloadArtifact(stagedDup, dir);
    assert.deepStrictEqual(committedDup, { path: committed.path, created: false });

    // Peer race: if destination appears after staging, commitDownloadArtifact cleans up staging and returns created: false.
    const peerStaging = path.join(dir, '.download-peer.tmp');
    fs.writeFileSync(peerStaging, PNG_BYTES);
    const peerResult = mf.commitDownloadArtifact({ path: committed.path, stagingPath: peerStaging }, dir);
    assert.deepStrictEqual(peerResult, { path: committed.path, created: false });
    assert.strictEqual(fs.existsSync(peerStaging), false);

    // Path safety: commitDownloadArtifact and discardDownloadArtifact refuse paths outside dir.
    const foreignFile = path.join(foreignDir, 'keep.tmp');
    fs.writeFileSync(foreignFile, PNG_BYTES);
    assert.throws(
      () => mf.commitDownloadArtifact({ path: foreignFile, stagingPath: '' }, dir),
      /Unsafe download artifact path/,
    );
    assert.throws(
      () => mf.commitDownloadArtifact({ path: committed.path, stagingPath: foreignFile }, dir),
      /Unsafe download staging path/,
    );
    assert.strictEqual(mf.discardDownloadArtifact({ path: committed.path, stagingPath: foreignFile }, dir), false);
    assert.strictEqual(fs.existsSync(foreignFile), true, 'foreign file must not be deleted');
  });

  console.log(`PASS managed-folder: ${passed} checks`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
