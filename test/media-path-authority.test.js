'use strict';

// SEC-002, slice 2: which paths a window may turn into bytes.
//
// Slice 1 settled WHO may call a channel. This is about WHAT they may name. Four channels
// took an absolute path from the window and acted on it with no question asked at all:
//
//   * `file-url` turned any path into a file:// URL the window could then load;
//   * `thumb` / `thumb-info` / `thumb-aspects` returned the image bytes of any file as a
//     data URL;
//   * `folder-entries` / `folder-info` listed any directory;
//   * `library-path-sizes` reported the size of any file.
//
// And one channel laundered authority: `library-materialize` put any path the window
// named into the pool, after which every check above would have said yes to it honestly.
//
// The rule is that a path has to be one the app already vouches for: a pool record or
// something inside a folder the user added, one of Znada's own wallpaper copies, or a
// short-lived grant main issued because IT learned the path — from a dialog it opened or
// a listing it produced.
//
// Run: node test/media-path-authority.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const grantsMod = require('../src/path-grants');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = H.makeTempProfile('media-authority');
  const captured = [];
  const real = { log: console.log, error: console.error };
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  try {
    await fn(dir);
    console.log = real.log; console.error = real.error;
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log = real.log; console.error = real.error;
    failures.push({ name, err, captured });
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
  } finally {
    console.log = real.log; console.error = real.error;
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function sync(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
    failures.push({ name, err, captured: [] });
  }
}

const cfgFile = (dir) => path.join(dir, 'config.json');
const storeFile = (dir) => path.join(dir, 'config.library.json');

function writeImage(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  return file;
}

// A profile with one photo of its own and one watched folder, plus a file somewhere else
// entirely that nothing in Znada has ever heard of.
function seedProfile(dir) {
  const own = writeImage(path.join(dir, 'wallpapers', 'own.png'));
  const watched = path.join(dir, 'watched');
  const inside = writeImage(path.join(watched, 'inside.png'));
  fs.mkdirSync(watched, { recursive: true });
  const ownId = library.idFor(own);
  const watchedId = library.idFor(watched);
  H.writeJson(cfgFile(dir), { autoSwitch: true, style: 'fill', monitors: {} });
  H.writeJson(storeFile(dir), {
    version: 1,
    library: {
      [ownId]: { id: ownId, type: 'image', path: own, addedAt: 1, favorite: false, tags: [] },
      [watchedId]: { id: watchedId, type: 'folder', path: watched, addedAt: 1, favorite: false, tags: [] },
    },
    trash: [],
  });
  return { own, watched, inside };
}

// Deliberately outside the profile: a real file the user never gave Znada.
function outsideFile(name = 'private.png') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-elsewhere-'));
  return { dir, file: writeImage(path.join(dir, name)) };
}

(async () => {
  console.log('\nSEC-002 slice 2: which paths a window may name\n');

  // ---- the grant ledger, on its own ----------------------------------------

  {
    const under = (child, ancestor) => String(child).startsWith(String(ancestor));
    let clock = 1000;
    const make = (over = {}) => grantsMod.create({
      isSameOrDescendant: under,
      now: () => clock,
      ...over,
    });

    sync('a granted path is allowed and an ungranted one is not', () => {
      const g = make();
      g.grant('C:/a/one.png');
      assert.strictEqual(g.allows('C:/a/one.png'), true);
      assert.strictEqual(g.allows('C:/a/two.png'), false);
    });

    sync('a file grant covers exactly that file, not its neighbours', () => {
      const g = make();
      g.grant('C:/a/one.png');
      assert.strictEqual(g.allows('C:/a'), false);
      assert.strictEqual(g.allows('C:/a/one.png/deeper'), false);
    });

    sync('a root grant covers what is inside it', () => {
      const g = make();
      g.grant('C:/pics', { root: true });
      assert.strictEqual(g.allows('C:/pics/holiday/1.png'), true);
      assert.strictEqual(g.allows('C:/other/1.png'), false);
    });

    sync('a grant expires', () => {
      clock = 1000;
      const g = make({ ttlMs: 500 });
      g.grant('C:/a/one.png');
      clock = 1400;
      assert.strictEqual(g.allows('C:/a/one.png'), true, 'it expired early');
      clock = 1500;
      assert.strictEqual(g.allows('C:/a/one.png'), false, 'an expired grant still allowed the path');
    });

    sync('an expired root stops covering what was inside it', () => {
      clock = 1000;
      const g = make({ ttlMs: 500 });
      g.grant('C:/pics', { root: true });
      clock = 2000;
      assert.strictEqual(g.allows('C:/pics/1.png'), false);
    });

    sync('the ledger is bounded, oldest first', () => {
      clock = 1000;
      const g = make({ max: 3 });
      for (const n of [1, 2, 3, 4]) g.grant(`C:/a/${n}.png`);
      assert.strictEqual(g.size(), 3, 'the ledger grew past its bound');
      assert.strictEqual(g.allows('C:/a/1.png'), false, 'the oldest grant survived eviction');
      assert.strictEqual(g.allows('C:/a/4.png'), true);
    });

    sync('re-granting a path keeps it, rather than letting it age out in use', () => {
      clock = 1000;
      const g = make({ max: 3 });
      g.grant('C:/a/1.png');
      g.grant('C:/a/2.png');
      g.grant('C:/a/1.png'); // touched again: now the newest
      g.grant('C:/a/3.png');
      g.grant('C:/a/4.png');
      assert.strictEqual(g.allows('C:/a/1.png'), true, 'a path still in use was evicted');
      assert.strictEqual(g.allows('C:/a/2.png'), false);
    });

    sync('an empty path is never granted and never allowed', () => {
      const g = make();
      assert.strictEqual(g.grant(''), false);
      assert.strictEqual(g.allows(''), false);
      assert.strictEqual(g.allows(null), false);
    });
  }

  // ---- characterization: what the windows legitimately show -----------------

  await test('a pool photo and a file inside a watched folder stay readable', async (dir) => {
    const { own, inside } = seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();

    assert.ok(await m.invoke('file-url', own), 'the app cannot show its own photo');
    assert.ok(await m.invoke('file-url', inside), 'the app cannot show a photo in a watched folder');
    const sizes = await m.invoke('library-path-sizes', [own]);
    assert.strictEqual(sizes.length, 1, 'the size of a pool photo became unavailable');
  });

  await test('browsing a watched folder still lists it', async (dir) => {
    const { watched, inside } = seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();

    const entries = await m.invoke('folder-entries', watched);
    assert.ok(Array.isArray(entries.images), 'a watched folder stopped listing');
    assert.ok(entries.images.some((p) => p === inside || (p && p.path === inside)),
      'the photo inside the watched folder disappeared from its listing');
  });

  // ---- regression: a path nothing vouches for -------------------------------

  await test('a path the app never heard of is not turned into a URL', async (dir) => {
    seedProfile(dir);
    const away = outsideFile();
    try {
      const m = H.loadMain(dir);
      m.__test.loadConfig();
      assert.strictEqual(await m.invoke('file-url', away.file), '',
        'any file on the disk could be handed to the window as a URL');
    } finally { fs.rmSync(away.dir, { recursive: true, force: true }); }
  });

  await test('a directory the app never heard of is not listed', async (dir) => {
    seedProfile(dir);
    const away = outsideFile();
    try {
      const m = H.loadMain(dir);
      m.__test.loadConfig();
      const entries = await m.invoke('folder-entries', away.dir);
      assert.deepStrictEqual(entries.images, [], 'any directory could be enumerated');
      const info = await m.invoke('folder-info', away.dir);
      assert.strictEqual(info.count, 0, 'any directory could be counted');
    } finally { fs.rmSync(away.dir, { recursive: true, force: true }); }
  });

  await test('the size of a file the app never heard of is not reported', async (dir) => {
    seedProfile(dir);
    const away = outsideFile();
    try {
      const m = H.loadMain(dir);
      m.__test.loadConfig();
      const sizes = await m.invoke('library-path-sizes', [away.file]);
      assert.deepStrictEqual(sizes, [], 'the size of an arbitrary file was reported');
    } finally { fs.rmSync(away.dir, { recursive: true, force: true }); }
  });

  await test('no thumbnail is even attempted for a path nothing vouches for', async (dir) => {
    const { own } = seedProfile(dir);
    const away = outsideFile();
    try {
      const m = H.loadMain(dir);
      m.__test.loadConfig();
      const before = m.__test.thumbnailAttempts();
      await m.invoke('thumb', away.file, 100, 100);
      await m.invoke('thumb-info', away.file, 100, 100, 0);
      await m.invoke('thumb-aspects', [{ path: away.file }], 100, 100);
      assert.strictEqual(m.__test.thumbnailAttempts(), before,
        'the image bytes of an arbitrary file were read for a thumbnail');

      // ...and the ones it does vouch for still get through, or this would pass by
      // refusing everything.
      await m.invoke('thumb', own, 100, 100);
      assert.ok(m.__test.thumbnailAttempts() > before, 'a real pool photo stopped drawing');
    } finally { fs.rmSync(away.dir, { recursive: true, force: true }); }
  });

  await test('a rejected drop never becomes a short-lived media grant', async (dir) => {
    seedProfile(dir);
    const away = outsideFile('private.txt');
    try {
      const missing = path.join(away.dir, 'missing.png');
      const m = H.loadMain(dir);
      m.__test.loadConfig();
      const beforeThumbs = m.__test.thumbnailAttempts();

      // Existing but not a supported image: library-add-paths rejects it and must not
      // leave behind ten minutes of read authority just because the renderer named it.
      const libraryResult = await m.invoke('library-add-paths', [away.file]);
      assert.strictEqual(libraryResult.added, 0, 'precondition: unsupported file was accepted');
      assert.strictEqual(await m.invoke('file-url', away.file), '',
        'library-add-paths granted a file it rejected');
      await m.invoke('thumb', away.file, 100, 100);
      assert.strictEqual(m.__test.thumbnailAttempts(), beforeThumbs,
        'a rejected library drop reached thumbnail extraction');

      // A plausible image name that does not exist fails stat/import in add-slot-paths.
      // It is equally untrusted: no card was added and no path was validated.
      const slotResult = await m.invoke('add-slot-paths', 'MON1', 'light', [missing]);
      assert.strictEqual(slotResult.added, 0, 'precondition: missing file was accepted');
      assert.strictEqual(await m.invoke('file-url', missing), '',
        'add-slot-paths granted a path it rejected');
      await m.invoke('thumb', missing, 100, 100);
      assert.strictEqual(m.__test.thumbnailAttempts(), beforeThumbs,
        'a rejected slot drop reached thumbnail extraction');
    } finally { fs.rmSync(away.dir, { recursive: true, force: true }); }
  });

  await test('an arbitrary path cannot be laundered into the pool', async (dir) => {
    seedProfile(dir);
    const away = outsideFile();
    try {
      const m = H.loadMain(dir);
      m.__test.loadConfig();
      const before = Object.keys(m.__test.getConfig().library).length;

      const res = await m.invoke('library-materialize', away.file, 'image');
      assert.strictEqual(res.id, null, 'an arbitrary path was added to the pool');
      assert.strictEqual(Object.keys(m.__test.getConfig().library).length, before);

      const assigned = await m.invoke('library-assign-record',
        { path: away.file, type: 'image' }, 'MON1', 'light');
      assert.strictEqual(assigned.ok, false, 'an arbitrary path was assigned to a monitor');
      assert.strictEqual(Object.keys(m.__test.getConfig().library).length, before,
        'the refused assignment still created a record');

      // The fullscreen viewer got its own door to the same act (it holds no config, so
      // it is handed an id rather than the whole pool). A second door is a second place
      // to forget the guard, so it is checked here beside the first.
      const viewer = await m.invoke('card-ensure-record', away.file, 'image');
      assert.strictEqual(viewer.id, '', 'the viewer channel laundered an arbitrary path into the pool');
      assert.strictEqual(Object.keys(m.__test.getConfig().library).length, before);
    } finally { fs.rmSync(away.dir, { recursive: true, force: true }); }
  });

  await test('the viewer channel makes a record for a path the app does vouch for', async (dir) => {
    // The other half: a guard that refuses everything would pass the case above while
    // leaving the menu item as dead as it was before.
    const { inside } = seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    const before = Object.keys(m.__test.getConfig().library).length;

    // A file inside a watched folder: the exact population that has no record until it
    // is used, and the population whose menu items were dead in the viewer.
    const res = await m.invoke('card-ensure-record', inside, 'image');
    assert.ok(res.id, 'a photo inside a watched folder got no record');
    assert.ok(m.__test.getConfig().library[res.id], 'the id names nothing in the pool');
    assert.strictEqual(Object.keys(m.__test.getConfig().library).length, before + 1);

    // Asking twice is the ordinary case (the user pressed it again): same record, not a
    // duplicate, because the id is derived from the path.
    const again = await m.invoke('card-ensure-record', inside, 'image');
    assert.strictEqual(again.id, res.id, 'a second press created a second record');
    assert.strictEqual(Object.keys(m.__test.getConfig().library).length, before + 1);
  });

  await test('a file the user picked in a dialog is readable before it reaches the pool', async (dir) => {
    // The reason grants exist: a chosen file has to draw immediately, and it is not a
    // pool record yet at the moment the picker closes.
    seedProfile(dir);
    const away = outsideFile();
    try {
      const m = H.loadMain(dir);
      m.__test.loadConfig();
      assert.strictEqual(await m.invoke('file-url', away.file), '', 'precondition: not readable yet');

      m.__test.grantPath(away.file);
      assert.ok(await m.invoke('file-url', away.file), 'a file main itself learned stayed unreadable');
    } finally { fs.rmSync(away.dir, { recursive: true, force: true }); }
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) {
      console.log(`FAILED: ${f.name}`);
      console.log(`  ${f.err && f.err.stack}`);
      if (f.captured.length) console.log(`  --- main.js output ---\n  ${f.captured.join('\n  ')}`);
    }
    process.exit(1);
  }
})();
