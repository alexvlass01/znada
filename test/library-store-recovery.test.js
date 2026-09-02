'use strict';

// DATA-004: what startup is allowed to do with a damaged pool file.
//
// The pool lives in config.library.json. config.json may still carry an INLINE copy —
// but only a stale one: it is what a pre-split build wrote, or what the degraded path
// left behind. It is not a backup of the current pool and nothing keeps it in step.
//
// So a corrupt store plus an inline copy is NOT a recovery. Accepting it as one and
// writing it back is the difference between "the damaged file is still sitting there"
// and "the library now contains whatever that old copy happened to hold" — with the
// wallpaper collector free to sweep every own-copy the lost records referenced.
//
// These tests run the real main.js over a real temp profile and assert on the BYTES
// left on disk, because that is the part a module test cannot see.
//
// Run: node test/library-store-recovery.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const libraryStore = require('../src/library-store');
const library = require('../src/library');

let passed = 0;
const failures = [];

// The degraded paths below are exactly what main.js is supposed to complain about, so
// its console output is captured and only shown when a test actually fails.
async function test(name, fn) {
  const dir = H.makeTempProfile('store-recovery');
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

const cfgFile = (dir) => path.join(dir, 'config.json');
const storeFile = (dir) => path.join(dir, 'config.library.json');

const idFor = (file) => library.idFor(file);

function item(_name, file) {
  return { id: idFor(file), type: 'image', path: file, addedAt: 1, favorite: false, tags: [] };
}

const keyedLibrary = (...items) => Object.fromEntries(items.map((entry) => [entry.id, entry]));

function writeProfile(dir, { config, store }) {
  fs.writeFileSync(cfgFile(dir), JSON.stringify(config, null, 2), 'utf8');
  if (store !== undefined) fs.writeFileSync(storeFile(dir), store, 'utf8');
}

const CORRUPT = '{"version":1,"library":{"a1":{"id":"a1","typ';
// Parses cleanly. Holds no library. The damage a truncation test cannot see.
const STRUCTURALLY_BROKEN = '{"version":999,"library":"not-an-object","trash":{}}';

function backupsIn(dir) {
  return fs.readdirSync(dir).filter((f) => /^config\.library\.json\.corrupt-\d+\.bak$/.test(f));
}

(async () => {
  console.log('\nDATA-004: damaged pool file\n');

  await test('a corrupt store is never overwritten by the stale inline copy', async (dir) => {
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: keyedLibrary(item('old1', path.join(dir, 'old1.png'))),
      },
      store: CORRUPT,
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    assert.strictEqual(
      fs.readFileSync(storeFile(dir), 'utf8'), CORRUPT,
      'the damaged pool file was rewritten — its contents are now unrecoverable',
    );
    assert.strictEqual(backupsIn(dir).length, 1, 'no .corrupt-*.bak was left next to it');
    assert.strictEqual(m.__test.isUnsafeToWrite(), true, 'writes to the pool file were not suppressed');
  });

  await test('the stale inline copy still shows in the library instead of an empty grid', async (dir) => {
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: keyedLibrary(item('old1', path.join(dir, 'old1.png'))),
      },
      store: CORRUPT,
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    // Showing nothing would read as "everything is gone" — the pool is unusable, not
    // empty, and whatever is still readable belongs on screen.
    assert.deepStrictEqual(
      Object.keys(m.__test.getConfig().library),
      [idFor(path.join(dir, 'old1.png'))],
    );
  });

  await test('config.json keeps carrying the pool while the store is unusable', async (dir) => {
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: keyedLibrary(item('old1', path.join(dir, 'old1.png'))),
      },
      store: CORRUPT,
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    // Any settings write must not strip the inline copy: while the store is unusable
    // config.json is the only readable pool there is.
    await m.invoke('set-config', { style: 'fit' });

    const onDisk = JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8'));
    assert.strictEqual(onDisk.style, 'fit', 'precondition: the settings write happened');
    assert.ok(onDisk.library && onDisk.library[idFor(path.join(dir, 'old1.png'))],
      'the inline pool was dropped from config.json');
    assert.strictEqual(
      fs.readFileSync(storeFile(dir), 'utf8'), CORRUPT,
      'a later settings write reached the damaged pool file',
    );
  });

  await test('a corrupt store with nothing inline still blocks writes', async (dir) => {
    writeProfile(dir, {
      config: { autoSwitch: true, style: 'fill', monitors: {} },
      store: CORRUPT,
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    assert.strictEqual(m.__test.isUnsafeToWrite(), true);
    assert.strictEqual(fs.readFileSync(storeFile(dir), 'utf8'), CORRUPT);
  });

  await test('the damaged file is reported to the user, not just to the console', async (dir) => {
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: keyedLibrary(item('old1', path.join(dir, 'old1.png'))),
      },
      store: CORRUPT,
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    const entries = m.__test.eventLogEntries();
    const entry = entries.find((e) => e.channel === 'library-store');
    assert.ok(entry, 'nothing about the damaged pool reached the event journal');
    assert.strictEqual(entry.kind, 'failure');
    assert.ok(entry.messageKey, 'the journal entry has no message key');
  });

  await test('an edit made while degraded survives a restart, and the damaged file still does not move', async (dir) => {
    const photo = path.join(dir, 'old1.png');
    fs.writeFileSync(photo, 'x');
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: keyedLibrary(item('old1', photo)),
      },
      store: CORRUPT,
    });

    const first = H.loadMain(dir);
    first.__test.loadConfig();
    const photoId = idFor(photo);
    await first.invoke('library-toggle-favorite', photoId);
    first.__test.disposeForTests();
    H.unloadMain();

    // Restart on the same profile: the edit must still be there, because in this mode
    // config.json is where it was written, and the damaged file must still be exactly
    // as it was found.
    const second = H.loadMain(dir);
    second.__test.loadConfig();
    assert.strictEqual(second.__test.isUnsafeToWrite(), true, 'the damaged file was accepted on the second start');
    assert.strictEqual(
      second.__test.getConfig().library[photoId].favorite, true,
      'the favourite added while degraded was lost across the restart',
    );
    assert.strictEqual(fs.readFileSync(storeFile(dir), 'utf8'), CORRUPT);
    assert.strictEqual(backupsIn(dir).length, 2, 'each start backs the damaged file up once');
  });

  // DATA-005, and the scenario the whole task exists for — run through the real path,
  // because the module tests around the merge rule prove only that the rule is right,
  // not that the app reaches it.
  //
  // The store is damaged, so an edit goes inline. Then a REPAIRED store comes back
  // carrying an older copy of the same photo. Before revisions the store won by virtue
  // of being the store, and the tag added meanwhile disappeared without a word.
  await test('тег, поставленный при повреждённом файле, переживает его возврат', async (dir) => {
    const photo = path.join(dir, 'old1.png');
    fs.writeFileSync(photo, 'x');
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: keyedLibrary(item('old1', photo)),
      },
      store: CORRUPT,
    });

    const first = H.loadMain(dir);
    first.__test.loadConfig();
    const photoId = idFor(photo);
    await first.invoke('library-add-tag', photoId, 'sunset');
    const bumped = first.__test.getConfig().library[photoId].rev;
    assert.ok(bumped > 0, 'the edit left the record looking untouched, so no merge could favour it');
    first.__test.disposeForTests();
    H.unloadMain();

    // The repaired file holds the same photo as it was BEFORE the tag: older, and with
    // no tag. It is a perfectly valid store — just behind.
    fs.writeFileSync(storeFile(dir), JSON.stringify({
      version: 1,
      library: keyedLibrary(Object.assign(item('old1', photo), { rev: bumped - 1, tags: [] })),
      trash: [],
    }), 'utf8');

    const second = H.loadMain(dir);
    second.__test.loadConfig();
    assert.strictEqual(second.__test.isUnsafeToWrite(), false, 'the repaired file was still refused');
    assert.deepStrictEqual(
      second.__test.getConfig().library[photoId].tags, ['sunset'],
      'the tag added while the file was unreadable was thrown away when the file came back',
    );
  });

  await test('putting the file back ends the degraded mode and keeps records only config had', async (dir) => {
    const keepPath = path.join(dir, 'keep.png');
    const inlinePath = path.join(dir, 'inline.png');
    const good = { version: 1, library: keyedLibrary(item('keep', keepPath)), trash: [] };
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: keyedLibrary(item('onlyInline', inlinePath)),
      },
      store: JSON.stringify(good, null, 2),
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    assert.strictEqual(m.__test.isUnsafeToWrite(), false);
    const store = JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));
    assert.ok(store.library[idFor(keepPath)], 'the restored file lost its own records');
    assert.ok(store.library[idFor(inlinePath)],
      'a record that existed only in config.json was dropped on recovery');
  });

  await test('a healthy store is loaded and stays writable', async (dir) => {
    const keepPath = path.join(dir, 'keep.png');
    const good = { version: 1, library: keyedLibrary(item('keep', keepPath)), trash: [] };
    writeProfile(dir, {
      config: { autoSwitch: true, style: 'fill', monitors: {} },
      store: JSON.stringify(good, null, 2),
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    assert.strictEqual(m.__test.isUnsafeToWrite(), false, 'a readable pool must not be treated as damaged');
    assert.deepStrictEqual(Object.keys(m.__test.getConfig().library), [idFor(keepPath)]);
    assert.strictEqual(backupsIn(dir).length, 0, 'a healthy pool file was backed up as corrupt');
    assert.strictEqual(
      m.__test.eventLogEntries().some((e) => e.channel === 'library-store'), false,
      'a healthy pool file was reported as a failure',
    );
  });

  await test('a valid but empty store is not mistaken for a damaged one', async (dir) => {
    // The fourth branch: broken, unreadable and missing are all different from a store
    // that simply says the library is empty — and that one must stay writable, or a
    // fresh profile would spend its whole life in the degraded mode.
    writeProfile(dir, {
      config: { autoSwitch: true, style: 'fill', monitors: {} },
      store: JSON.stringify({ version: 1, library: {}, trash: [] }, null, 2),
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    assert.strictEqual(m.__test.isUnsafeToWrite(), false);
    assert.strictEqual(backupsIn(dir).length, 0);
    assert.strictEqual(m.__test.eventLogEntries().some((e) => e.channel === 'library-store'), false);
  });

  await test('a damaged store is refused on the strength of the trash alone', async (dir) => {
    // The decision must not look at the active pool. A profile whose only inline record
    // is a removed one is still a profile with something to lose.
    const gone = item('gone', path.join(dir, 'gone.png'));
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        libraryTrash: [{ item: gone, removedAt: 2 }],
      },
      store: CORRUPT,
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    assert.strictEqual(m.__test.isUnsafeToWrite(), true);
    assert.strictEqual(fs.readFileSync(storeFile(dir), 'utf8'), CORRUPT);
    assert.strictEqual(
      m.__test.getConfig().libraryTrash.length, 1,
      'the only recoverable record left was dropped',
    );
  });

  // Found by the pre-release gate 2026-08-21, and it had been shipping since the
  // split-store went out. Everything above proves the TRUNCATED file is protected —
  // and truncation is only the loud half of damage. A file can parse perfectly and
  // still have lost the library: {"library":"not-an-object"} is valid JSON. That went
  // straight through: load said broken:false, the pool read as empty, no backup was
  // made, and the next save wrote the emptiness over the file. Silent, and final.
  await test('a file that parses but no longer holds a library is treated as damaged', async (dir) => {
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: keyedLibrary(item('old1', path.join(dir, 'old1.png'))),
      },
      store: STRUCTURALLY_BROKEN,
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    assert.strictEqual(
      fs.readFileSync(storeFile(dir), 'utf8'), STRUCTURALLY_BROKEN,
      'the damaged pool file was rewritten — whatever it still held is now gone',
    );
    assert.strictEqual(backupsIn(dir).length, 1, 'no .corrupt-*.bak was left next to it');
    assert.strictEqual(m.__test.isUnsafeToWrite(), true, 'writes to the pool file were not suppressed');
  });

  await test('the containers are judged, one by one', async () => {
    const cases = [
      ['{"library":"not-an-object"}', 'library replaced by a string'],
      ['{"library":[]}', 'library replaced by an array'],
      ['{"library":{},"trash":"gone"}', 'trash replaced by a string'],
      ['[]', 'the whole file replaced by an array'],
      ['null', 'the whole file replaced by null'],
      ['42', 'the whole file replaced by a number'],
      // save() writes `library` on every path, so a file without it was never written
      // by this app. The first cut of the check tolerated these three, which left the
      // hole open — {} went through as healthy — and the test below asserted that was
      // right, so the bug was locked in by its own test.
      ['{}', 'the library gone entirely'],
      ['{"version":1,"library":null,"trash":[]}', 'library replaced by null'],
      ['{"version":1,"library":{},"trash":null}', 'trash replaced by null'],
    ];
    for (const [content, what] of cases) {
      assert.strictEqual(
        libraryStore.validateStoreShape(JSON.parse(content)).ok, false,
        `accepted as healthy: ${what}`,
      );
    }
  });

  // The other half of the same rule, and the more dangerous one to get wrong: calling a
  // healthy file damaged would push a working profile into degraded mode for nothing.
  // Entry-level wear stays tolerated — one record missing its path has always been
  // filtered out quietly, and that is not corruption.
  await test('ordinary wear is not mistaken for damage', async () => {
    const healthy = [
      '{"version":1,"library":{},"trash":[]}',
      '{"library":{"a":{"id":"a","path":"C:/x.jpg"}}}',
      // One record short of a path is ordinary wear and has always been filtered out.
      '{"library":{"a":{"id":"a","path":"C:/x.jpg"},"b":{"id":"b"}}}',
      // The earliest store shape had no trash at all, so ABSENT stays acceptable —
      // unlike present-but-null, which is damage.
      '{"version":1,"library":{}}',
      // An unknown version with sound containers belongs to a build newer than this
      // one. Refusing it would drop a rollback into degraded mode for nothing.
      '{"version":999,"library":{},"trash":[]}',
    ];
    for (const content of healthy) {
      assert.strictEqual(
        libraryStore.validateStoreShape(JSON.parse(content)).ok, true,
        `a healthy file was called damaged: ${content}`,
      );
    }
  });

  // The fixture above mixes an unknown version with two wrecked containers, so a green
  // run does not say WHICH of them the app refused. These isolate one cause each, and
  // the last one proves the opposite: a version we do not know is not a reason to
  // refuse anything.
  for (const [label, store] of [
    ['only the library is wrecked', '{"version":1,"library":"not-an-object","trash":[]}'],
    ['only the trash is wrecked', '{"version":1,"library":{},"trash":"gone"}'],
    ['the library is missing entirely', '{"version":1,"trash":[]}'],
  ]) {
    await test(`a damaged store is refused when ${label}`, async (dir) => {
      writeProfile(dir, {
        config: { autoSwitch: true, style: 'fill', monitors: {}, library: {} },
        store,
      });
      const m = H.loadMain(dir);
      m.__test.loadConfig();
      assert.strictEqual(fs.readFileSync(storeFile(dir), 'utf8'), store, 'the damaged file was rewritten');
      assert.strictEqual(backupsIn(dir).length, 1, 'no .corrupt-*.bak was left next to it');
      assert.strictEqual(m.__test.isUnsafeToWrite(), true, 'writes were not suppressed');
    });
  }

  await test('a store written by a newer build is read but never written back', async (dir) => {
    const newerPath = 'C:/a.png';
    const newerId = idFor(newerPath);
    const store = JSON.stringify({
      version: 999,
      library: keyedLibrary(item('a', newerPath)),
      trash: [],
    });
    writeProfile(dir, {
      config: { autoSwitch: true, style: 'fill', monitors: {}, library: {} },
      store,
    });
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    assert.strictEqual(backupsIn(dir).length, 0, 'a rollback from a newer build was treated as damage');
    // Readable, so the rollback still sees its library — but writes stay blocked: save()
    // stamps the version back down and drops every field this build does not know.
    assert.strictEqual(m.__test.isUnsafeToWrite(), true, 'a newer file was left writable and would be downgraded');
    assert.ok(m.__test.getConfig().library[newerId],
      'the pool from the newer build was not loaded');
  });

  // The container is intact, so the shape check sees nothing wrong — and every record
  // inside it is unusable. Read as empty, no backup, and the next save writes that
  // emptiness over the file. Same silent loss as a wrecked container, one level in.
  await test('a library that kept none of its records is damaged, not empty', async (dir) => {
    const store = '{"version":1,"library":{"a":{"id":"a"},"b":null},"trash":[]}';
    writeProfile(dir, {
      config: { autoSwitch: true, style: 'fill', monitors: {}, library: {} },
      store,
    });
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    assert.strictEqual(fs.readFileSync(storeFile(dir), 'utf8'), store, 'the damaged file was rewritten');
    assert.strictEqual(backupsIn(dir).length, 1, 'no .corrupt-*.bak was left next to it');
    assert.strictEqual(m.__test.isUnsafeToWrite(), true, 'writes were not suppressed');
  });

  // One bad record among good ones is ordinary wear and must stay silent, or every
  // profile with a single stale entry would land in degraded mode.
  await test('one unusable record among sound ones is still ordinary wear', async (dir) => {
    const soundPath = 'C:/a.png';
    const sound = item('a', soundPath);
    const store = JSON.stringify({
      version: 1,
      library: { [sound.id]: sound, b: null },
      trash: [],
    });
    writeProfile(dir, {
      config: { autoSwitch: true, style: 'fill', monitors: {}, library: {} },
      store,
    });
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    assert.strictEqual(backupsIn(dir).length, 0, 'ordinary wear was treated as damage');
    assert.strictEqual(m.__test.isUnsafeToWrite(), false, 'writes were blocked over one stale record');
    assert.ok(m.__test.getConfig().library[sound.id], 'the sound record was lost');
  });

  // A damaged library must still surrender the trash: those photos exist nowhere else.
  // The first cut of the shape check returned empty for BOTH containers, breaking this
  // invariant while its unit test kept passing — that test exercises normalizeStore,
  // not the path the app takes.
  await test('a damaged library still hands back the trash beside it', async (dir) => {
    const survivorPath = path.join(dir, 'survivor.png');
    const survivorId = idFor(survivorPath);
    const entry = {
      removedAt: 1, removalId: 'r1', via: 'manual',
      item: { id: survivorId, type: 'image', path: survivorPath, tags: [] },
    };
    const store = JSON.stringify({ version: 1, library: 'broken', trash: [entry] });
    fs.writeFileSync(storeFile(dir), store, 'utf8');
    fs.writeFileSync(path.join(dir, 'config.json'), '{}', 'utf8');

    const loaded = libraryStore.load(path.join(dir, 'config.json'));
    assert.strictEqual(loaded.broken, true, 'a wrecked library was not reported as damage');
    assert.strictEqual(
      loaded.trash.length, 1,
      'the trash went down with the library — those photos exist nowhere else',
    );
    assert.strictEqual(loaded.trash[0].item.id, survivorId);
  });

  // ...and the same the other way round.
  await test('a damaged trash still hands back the library beside it', async (dir) => {
    const keepPath = path.join(dir, 'keep.png');
    const liveItem = { id: idFor(keepPath), type: 'image', path: keepPath, tags: [] };
    const store = JSON.stringify({ version: 1, library: keyedLibrary(liveItem), trash: 'broken' });
    fs.writeFileSync(storeFile(dir), store, 'utf8');
    fs.writeFileSync(path.join(dir, 'config.json'), '{}', 'utf8');

    const loaded = libraryStore.load(path.join(dir, 'config.json'));
    assert.strictEqual(loaded.broken, true, 'a wrecked trash was not reported as damage');
    assert.ok(loaded.library[liveItem.id], 'the library went down with the trash');
  });
  await test('a profile with no store yet is created normally', async (dir) => {
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        library: keyedLibrary(item('old1', path.join(dir, 'old1.png'))),
      },
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    assert.strictEqual(m.__test.isUnsafeToWrite(), false);
    const store = JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));
    assert.ok(store.library[idFor(path.join(dir, 'old1.png'))],
      'the inline pool was not migrated into its own file');
  });

  // ---- BUG-024: a damaged inline copy must not become the canonical file ----
  //
  // The merge read revisions off both sides before checking either was a record, so a
  // config.json holding `{ id, rev: 999 }` beat the healthy store entry. main then saw
  // "something inline contributed" and wrote that winner back as canonical. The photo's
  // path, tags and star were gone after one start, and nothing had reported a failure.

  await test('an invalid inline record never becomes the canonical one', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'keep.png'));
    const photoId = idFor(photo);
    const healthy = { id: photoId, type: 'image', path: photo, addedAt: 1, favorite: true, tags: ['keep'], rev: 3 };
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        // Has a plausible path but no supported type. It cannot safely replace an image:
        // the GC keep-set deliberately ignores records it cannot classify.
        library: { [photoId]: { id: photoId, path: path.join(dir, 'other.bin'), rev: 999 } },
      },
      store: JSON.stringify({ version: 1, library: { [photoId]: healthy }, trash: [] }, null, 2),
    });

    const first = H.loadMain(dir);
    first.__test.loadConfig();
    first.__test.flushLibraryWriter();
    assert.strictEqual(
      first.__test.getConfig().library[photoId].path, photo,
      'the pathless record won on revision alone',
    );

    // Startup -> automatic persistence -> two cold reloads: the state that was chosen
    // has to still be the state on disk, twice over.
    for (let round = 0; round < 2; round++) {
      H.unloadMain();
      const again = H.loadMain(dir);
      again.__test.loadConfig();
      again.__test.flushLibraryWriter();
      const record = again.__test.getConfig().library[photoId];
      assert.ok(record, 'the photo disappeared after reload ' + (round + 1));
      assert.strictEqual(record.path, photo, 'reload ' + (round + 1) + ' lost the path');
      assert.strictEqual(record.favorite, true, 'reload ' + (round + 1) + ' lost the star');
      assert.deepStrictEqual(record.tags, ['keep'], 'reload ' + (round + 1) + ' lost the tags');
    }

    const onDisk = JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));
    assert.strictEqual(onDisk.library[photoId].path, photo,
      'the damaged record was written to the store file');
  });

  await test('a malformed inline tombstone does not delete a live photo', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'alive.png'));
    const photoId = idFor(photo);
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        // A path alone is not enough: the app never writes a deletion without the item
        // kind, and GC cannot protect a typeless tombstone's file.
        libraryTrash: [{ item: { id: photoId, path: photo }, removedAt: 9000, rev: 999 }],
      },
      store: JSON.stringify({
        version: 1,
        library: { [photoId]: { id: photoId, type: 'image', path: photo, addedAt: 1, favorite: false, tags: [], rev: 2 } },
        trash: [],
      }, null, 2),
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.flushLibraryWriter();

    assert.ok(m.__test.getConfig().library[photoId],
      'a malformed tombstone deleted a live photo');
    assert.strictEqual(
      m.__test.getConfig().libraryTrash.length, 0,
      'and it was not offered as something the user could restore either',
    );
    const onDisk = JSON.parse(fs.readFileSync(storeFile(dir), 'utf8'));
    assert.ok(onDisk.library[photoId], 'the deletion reached the canonical file');
  });

  await test('an inline copy that contributed nothing does not trigger a rewrite', async (dir) => {
    const photo = H.writeImage(path.join(dir, 'keep.png'));
    const photoId = idFor(photo);
    const storeText = JSON.stringify({
      version: 1,
      library: { [photoId]: { id: photoId, type: 'image', path: photo, addedAt: 1, favorite: true, tags: ['keep'], rev: 3 } },
      trash: [],
    }, null, 2);
    writeProfile(dir, {
      config: {
        autoSwitch: true,
        style: 'fill',
        monitors: {},
        // Present, but every candidate in it is refused. Presence is not a contribution:
        // treating it as one makes damage alone rewrite a healthy canonical file and
        // strip the damaged copy without leaving a backup of it.
        library: { [photoId]: { id: photoId, type: 'video', path: photo, rev: 999 } },
      },
      store: storeText,
    });
    const configBefore = fs.readFileSync(cfgFile(dir), 'utf8');

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.flushLibraryWriter();

    assert.strictEqual(
      fs.readFileSync(storeFile(dir), 'utf8'), storeText,
      'a healthy canonical file was rewritten because a damaged inline copy existed',
    );
    assert.strictEqual(
      fs.readFileSync(cfgFile(dir), 'utf8'), configBefore,
      'the damaged inline copy was stripped without anything having been recovered from it',
    );
  });

  console.log(`\n${failures.length ? `${failures.length} FAILED, ` : ''}${passed} pool-recovery tests passed.\n`);
  if (failures.length) {
    for (const f of failures) {
      console.error(`\nFAILED: ${f.name}\n${f.err && f.err.stack}`);
      if (f.captured.length) console.error(`  main.js said:\n    ${f.captured.join('\n    ')}`);
    }
    process.exit(1);
  }
})();
