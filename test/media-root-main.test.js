'use strict';

// DATA-006 step 1, through the REAL main.js.
//
// The setting is worth nothing unless the code that copies, sweeps and prunes actually
// follows it, and that is exactly what a module test cannot see. So: a real temp
// profile, a real chosen folder, real files on disk, and then the chosen folder is
// taken away mid-life the way an unplugged drive takes it away.
//
// The case that matters most is the last one. `library-refresh` deletes every pool
// record whose file is missing; with the managed folder absent that is every own copy
// at once. The owner's rule for an absent disk (2026-09-09) is that nothing is cleaned
// up and nothing is marked as gone.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers/main-harness');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ok ${name}`);
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `znada-${label}-`));
}

function filesIn(dir) {
  try { return fs.readdirSync(dir).filter((f) => f !== '.trash'); } catch { return []; }
}

(async () => {
  // --- the default: unchanged for everyone who never picks a folder ---------------
  {
    const userData = H.makeTempProfile('media-root-default');
    H.writeJson(path.join(userData, 'config.json'), { monitors: {} });
    const main = H.loadMain(userData);
    main.__test.loadConfig();
    const resolved = main.__test.managedRoot();
    check('with no folder chosen the copies stay in the profile', () => {
      assert.strictEqual(resolved.root, path.join(userData, 'wallpapers'));
      assert.strictEqual(resolved.custom, false);
      assert.strictEqual(resolved.state, 'ready');
    });
    H.unloadMain();
  }

  // --- a chosen folder: copies, sweeping and the window's read rule follow it ------
  const chosen = tempDir('chosen');
  const userData = H.makeTempProfile('media-root-custom');
  // Znada names its subfolder after the profile it belongs to, so two profiles can
  // never share one folder and sweep each other's files. The shipped names are pinned
  // in test/media-root.test.js; here the profile is a temp one, so the same rule is
  // read off the profile itself rather than hardcoded.
  const folderName = path.basename(userData);
  let addedPath = '';
  let removedPath = '';
  {
    H.writeJson(path.join(userData, 'config.json'), { monitors: {}, mediaFolder: chosen });
    const main = H.loadMain(userData);
    main.__test.loadConfig();
    const resolved = main.__test.managedRoot();

    check('a chosen folder is used through our own subfolder', () => {
      assert.strictEqual(resolved.root, path.join(chosen, folderName));
      assert.strictEqual(resolved.custom, true);
      // The subfolder does not exist yet, and that is not a failure: the place the
      // user picked is there, so Znada may create its own folder inside it.
      assert.strictEqual(resolved.state, 'creatable');
    });

    const source = H.writeImage(path.join(tempDir('src'), 'photo.png'));
    const result = await main.invoke('library-add-paths', [source], '');
    addedPath = Object.values(result.config.library)[0].path;

    check('an added photo is copied into the chosen folder, not into the profile', () => {
      assert.strictEqual(result.added, 1);
      assert.ok(fs.existsSync(addedPath), 'the copy must be on disk');
      assert.strictEqual(path.dirname(addedPath), path.join(chosen, folderName));
      assert.deepStrictEqual(filesIn(path.join(userData, 'wallpapers')), [],
        'nothing may be written into the profile once a folder is chosen');
    });

    check('what the window may read follows the chosen folder', () => {
      assert.strictEqual(main.__test.isAuthorizedMediaPath(addedPath), true);
      assert.strictEqual(
        main.__test.isAuthorizedMediaPath(path.join(userData, 'wallpapers', 'wp-old.png')), false,
        'the old location must not stay authorised by accident',
      );
    });

    check('the sweeper works inside the chosen folder', () => {
      const orphan = H.writeImage(path.join(chosen, folderName, 'wp-orphan.png'));
      main.__test.gcWallpapers();
      assert.ok(!fs.existsSync(orphan), 'an unreferenced file must leave the folder');
      assert.ok(fs.existsSync(path.join(chosen, folderName, '.trash', 'wp-orphan.png')),
        'and land in the recoverable trash inside the same folder');
      assert.ok(fs.existsSync(addedPath), 'a file the library references must stay');
    });

    // Put a second photo in the library trash, so the away-case below can try to
    // restore something whose file lives in the folder that is about to disappear.
    const second = H.writeImage(path.join(tempDir('src-removed'), 'removed.png'));
    fs.appendFileSync(second, 'a second photo, different bytes'); // or it dedupes into the first
    const secondAdd = await main.invoke('library-add-paths', [second], '');
    const removedItem = Object.values(secondAdd.config.library).find((item) => item.path !== addedPath);
    removedPath = removedItem && removedItem.path;
    const removal = await main.invoke('library-remove-many', [{ id: removedItem.id, path: removedPath }], {}, '');
    check('setup: a removed photo waits in the library trash', () => {
      assert.ok(removedPath, 'the second photo has a record');
      assert.ok((removal.config.libraryTrash || []).some((entry) => entry.item.path === removedPath),
        'and removing it put that record in the trash');
      assert.ok(fs.existsSync(removedPath), 'while its file stays where it was');
    });

    main.__test.flushLibraryWriter();
    H.unloadMain();
  }

  // --- the drive goes away ---------------------------------------------------------
  {
    fs.rmSync(chosen, { recursive: true, force: true }); // unplugged drive, silent share
    const main = H.loadMain(userData);
    main.__test.loadConfig();

    check('a missing folder reads as unavailable, never as an empty library', () => {
      const resolved = main.__test.managedRoot();
      assert.strictEqual(resolved.state, 'unavailable');
      assert.strictEqual(resolved.reason, 'missing');
      assert.ok(main.__test.getConfig().library[Object.keys(main.__test.getConfig().library)[0]],
        'the pool itself is intact — only the files are out of reach');
    });

    const refreshed = await main.invoke('library-refresh', null, '');
    check('refresh refuses to prune records while the folder is away', () => {
      assert.strictEqual(refreshed.error, 'media_root_unavailable');
      assert.strictEqual(refreshed.removed, 0);
      assert.strictEqual(Object.keys(main.__test.getConfig().library).length, 1,
        'the record must survive: "cannot tell" is not "the file is gone"');
    });

    const source = H.writeImage(path.join(tempDir('src2'), 'second.png'));
    const blocked = await main.invoke('library-add-paths', [source], '');
    check('nothing is written anywhere while the folder is away', () => {
      assert.strictEqual(blocked.added, 0);
      assert.ok(!fs.existsSync(chosen), 'the folder the user picked must not be recreated');
      assert.deepStrictEqual(filesIn(path.join(userData, 'wallpapers')), [],
        'and there must be no quiet fallback into the profile — that is two libraries');
    });

    const restored = await main.invoke('library-restore', [removedPath], '');
    check('a removed photo is not declared restored while its file is out of reach', () => {
      // Found by the independent review of this step. recordTargetLost answers
      // "cannot tell" when the drive is gone — correctly — so without checking that the
      // copy actually came back, the record returned to the library while the file
      // stayed in the trash on a disk nobody can reach.
      assert.strictEqual(restored.restored, 0, 'nothing may be reported as brought back');
      assert.ok((main.__test.getConfig().libraryTrash || []).some((e) => e.item.path === removedPath),
        'the trash entry has to stay, or the photo becomes unrecoverable');
      assert.ok(!main.__test.getConfig().library[require('../src/library').idFor(removedPath)],
        'and it must not appear in the active library with no file behind it');
    });

    check('the sweeper stays put while the folder is away', () => {
      main.__test.gcWallpapers();
      assert.ok(!fs.existsSync(chosen), 'the sweeper must not create the folder to sweep it');
      assert.strictEqual(Object.keys(main.__test.getConfig().library).length, 1);
    });

    await assert.rejects(
      () => main.__test.importWallpaper(source),
      /unavailable/i,
      'the copy funnel itself must refuse, not only the handlers above it',
    );
    checks += 1;
    console.log('  ok the copy funnel itself refuses');

    H.unloadMain();
  }

  // --- a drive letter that is not there at all --------------------------------------
  // The case the review of this step found, and it needs a MISSING ROOT to reproduce:
  // with the folder deleted on a disk that is still mounted, `recordTargetLost` proves
  // the file is gone and the restore stops there anyway. On an unplugged drive it
  // correctly answers "cannot tell" — and that is where ignoring whether the copy came
  // back would put the record into the library with nothing behind it.
  {
    const freeLetter = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('')
      .find((letter) => !fs.existsSync(`${letter}:\\`));
    if (!freeLetter) {
      console.log('  SKIP drive-not-there case: every drive letter on this machine exists');
    } else {
      const userData2 = H.makeTempProfile('media-root-gone');
      const media = `${freeLetter}:\\znada-media`;
      const root = path.join(media, path.basename(userData2));
      const missing = path.join(root, 'wp-removed.png');
      const libraryMod = require('../src/library');
      H.writeJson(path.join(userData2, 'config.json'), { monitors: {}, mediaFolder: media });
      H.writeJson(path.join(userData2, 'config.library.json'), {
        version: 1,
        library: {},
        trash: [{
          at: Date.now(),
          item: {
            id: libraryMod.idFor(missing), type: 'image', path: missing,
            addedAt: Date.now(), favorite: false, tags: [], author: '', source: '',
          },
        }],
      });
      const main = H.loadMain(userData2);
      main.__test.loadConfig();

      check('a drive that is not mounted reads as unavailable', () => {
        assert.strictEqual(main.__test.managedRoot().state, 'unavailable');
      });

      const restored = await main.invoke('library-restore', [missing], '');
      check('a photo on an unplugged drive is not declared restored', () => {
        assert.strictEqual(restored.restored, 0, 'nothing may be reported as brought back');
        assert.ok((main.__test.getConfig().libraryTrash || []).some((e) => e.item.path === missing),
          'the trash entry has to stay, or the photo becomes unrecoverable');
        assert.ok(!main.__test.getConfig().library[libraryMod.idFor(missing)],
          'and it must not appear in the active library with no file behind it');
      });
      H.unloadMain();
    }
  }

  // --- a setting pointing somewhere forbidden freezes too ---------------------------
  {
    const forbidden = H.makeTempProfile('media-root-forbidden');
    H.writeJson(path.join(forbidden, 'config.json'), {
      monitors: {}, mediaFolder: path.join(forbidden, 'inside-the-profile'),
    });
    fs.mkdirSync(path.join(forbidden, 'inside-the-profile'), { recursive: true });
    const main = H.loadMain(forbidden);
    main.__test.loadConfig();
    check('a folder inside the profile is refused rather than quietly used', () => {
      const resolved = main.__test.managedRoot();
      assert.strictEqual(resolved.state, 'unavailable');
      assert.strictEqual(resolved.reason, 'invalid');
    });
    H.unloadMain();
  }

  console.log(`PASS media-root-main: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
