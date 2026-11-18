'use strict';

// DATA-001: the last good copies of config.json, config.library.json and
// folder-state.json, and the restore of a damaged one at startup.
//
// Owner decision 2026-11-01: no export, no buttons, no photos — only "if the main file
// breaks, do not lose everything", said once by a Windows notification and a journal line.
//
// The module is tested on real files in a temp folder. The restore is tested where it
// happens: each loader on a real damaged file, and the real main.js under the harness —
// healthy start, copy taken, file damaged, restart — because a loader that restores while
// main never asks it would pass every unit test here.
//
// Run: node test/data-snapshots.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeTempDir } = require('./helpers/temp-dir');
const { createDataSnapshots } = require('../src/data-snapshots');
const configMod = require('../src/config');
const libraryStore = require('../src/library-store');
const folderState = require('../src/folder-state');
const library = require('../src/library');
const H = require('./helpers/main-harness');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = makeTempDir('znada-snapshots-');
  const captured = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  console.warn = (...a) => captured.push(a.join(' '));
  try {
    await fn(dir);
    Object.assign(console, real);
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    Object.assign(console, real);
    failures.push({ name, err, captured });
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
  } finally {
    Object.assign(console, real);
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const HOUR = 60 * 60 * 1000;
const isJsonObject = (text) => {
  try { const v = JSON.parse(text); return !!v && typeof v === 'object' && !Array.isArray(v); } catch { return false; }
};

function makeSnapshots(dir, file, extra = {}) {
  let clock = 1_000_000_000_000;
  const snaps = createDataSnapshots({
    dir: path.join(dir, 'backups'),
    kinds: { config: { file, accept: isJsonObject } },
    now: () => clock,
    ...extra,
  });
  return { snaps, advance: (ms) => { clock += ms; }, at: () => clock };
}

const DAMAGED = '{"autoSwitch": tru';

function healthyLibraryText(photo) {
  const id = library.idFor(photo);
  return JSON.stringify({
    version: 1,
    library: { [id]: { id, type: 'image', path: photo, addedAt: 1, favorite: true, tags: ['sea'], rev: 3 } },
    trash: [],
  }, null, 2);
}

(async () => {
  console.log('\ndata snapshots (DATA-001)\n');

  // ---- the module ------------------------------------------------------------

  await test('a loadable file is copied, and a second copy waits for the interval', async (dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{"a":1}');
    const { snaps, advance } = makeSnapshots(dir, file);
    assert.strictEqual(snaps.take('config'), 'taken');
    fs.writeFileSync(file, '{"a":2}');
    assert.strictEqual(snaps.take('config'), 'fresh', 'within the interval nothing new is taken');
    advance(4 * HOUR);
    assert.strictEqual(snaps.take('config'), 'taken');
    assert.strictEqual(snaps.list('config').length, 2);
    assert.strictEqual(fs.readFileSync(snaps.list('config')[0].path, 'utf8'), '{"a":2}', 'newest first');
  });

  await test('unchanged bytes are not copied again, so history is not pushed out', async (dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{"a":1}');
    const { snaps, advance } = makeSnapshots(dir, file);
    snaps.take('config');
    advance(5 * HOUR);
    assert.strictEqual(snaps.take('config'), 'same');
    assert.strictEqual(snaps.list('config').length, 1);
  });

  await test('a damaged file is never copied as a good one', async (dir) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, DAMAGED);
    const { snaps } = makeSnapshots(dir, file);
    assert.strictEqual(snaps.take('config', { force: true }), 'rejected');
    assert.deepStrictEqual(snaps.list('config'), []);
  });

  await test('only the newest copies are kept, and foreign files in the folder are left alone', async (dir) => {
    const file = path.join(dir, 'config.json');
    const { snaps, advance } = makeSnapshots(dir, file, { keep: 3 });
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    const foreign = path.join(dir, 'backups', 'config-mine.json');
    fs.writeFileSync(foreign, '{}');
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(file, JSON.stringify({ n: i }));
      assert.strictEqual(snaps.take('config'), 'taken');
      advance(4 * HOUR);
    }
    const kept = snaps.list('config').map((c) => JSON.parse(fs.readFileSync(c.path, 'utf8')).n);
    assert.deepStrictEqual(kept, [4, 3, 2]);
    assert.ok(fs.existsSync(foreign), 'a file that is not ours is not pruned');
  });

  await test('findGood skips a copy damaged after it was taken and returns the one before', async (dir) => {
    const file = path.join(dir, 'config.json');
    const { snaps, advance } = makeSnapshots(dir, file);
    fs.writeFileSync(file, '{"n":1}');
    snaps.take('config');
    advance(4 * HOUR);
    fs.writeFileSync(file, '{"n":2}');
    snaps.take('config');
    fs.writeFileSync(snaps.list('config')[0].path, DAMAGED);
    const found = snaps.findGood('config');
    assert.ok(found);
    assert.strictEqual(found.text, '{"n":1}');
  });

  await test('a clock moved back does not block new copies until it catches up', async (dir) => {
    const file = path.join(dir, 'config.json');
    const { snaps, advance } = makeSnapshots(dir, file);
    fs.writeFileSync(file, '{"n":1}');
    snaps.take('config');
    advance(-24 * HOUR);
    fs.writeFileSync(file, '{"n":2}');
    assert.strictEqual(snaps.take('config'), 'taken');
    assert.strictEqual(snaps.findGood('config').text, '{"n":2}', 'the later write is the newest copy');
  });

  // ---- the loaders on real damaged files ----------------------------------

  await test('config.load restores a damaged settings file from its copy and keeps the damaged bytes', async (dir) => {
    const cfgPath = path.join(dir, 'config.json');
    const good = JSON.stringify({ style: 'center', language: 'ru', firstRunDone: true });
    const restore = (kind) => (kind === 'config' ? { text: good, takenAt: 1234 } : null);
    fs.writeFileSync(cfgPath, DAMAGED);
    const loaded = configMod.load(cfgPath, { restore });
    assert.strictEqual(loaded.style, 'center');
    assert.strictEqual(loaded.language, 'ru');
    assert.strictEqual(loaded._configSource.state, 'restored');
    assert.strictEqual(loaded._configSource.writable, true);
    assert.strictEqual(loaded._configSource.restoredAt, 1234);
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('config.json.corrupt-')), 'damaged bytes kept');
  });

  await test('an UNREADABLE settings file is not replaced by a copy (it says nothing about its contents)', async (dir) => {
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(cfgPath); // EISDIR on read: readable-but-damaged it is not
    let asked = false;
    const loaded = configMod.load(cfgPath, { restore: () => { asked = true; return { text: '{}', takenAt: 1 }; } });
    assert.strictEqual(asked, false);
    assert.strictEqual(loaded._configSource.state, 'unreadable');
    assert.strictEqual(loaded._configSource.writable, false);
  });

  await test('library-store.load restores a damaged library from its copy', async (dir) => {
    const cfgPath = path.join(dir, 'config.json');
    const photo = path.join(dir, 'wallpapers', 'sea.png');
    fs.writeFileSync(libraryStore.storePathFor(cfgPath), '{"version":1,"library":');
    const restore = (kind) => (kind === 'library' ? { text: healthyLibraryText(photo), takenAt: 777 } : null);
    const stored = libraryStore.load(cfgPath, { restore });
    assert.strictEqual(stored.broken, false);
    assert.strictEqual(stored.restoredAt, 777);
    assert.strictEqual(stored.library[library.idFor(photo)].favorite, true);
  });

  await test('a library copy from a NEWER build is not accepted as a good copy', async () => {
    const text = JSON.stringify({ version: libraryStore.VERSION + 1, library: {}, trash: [] });
    assert.strictEqual(libraryStore.isHealthyText(text), false);
    assert.strictEqual(libraryStore.isHealthyText(JSON.stringify({ version: 1, library: {}, trash: [] })), true);
  });

  await test('folder-state.loadState restores a damaged index from its copy, the damaged one renamed aside', async (dir) => {
    const file = path.join(dir, 'folder-state.json');
    const good = JSON.stringify({ version: folderState.VERSION, folders: {} });
    fs.writeFileSync(file, '{"version":4,');
    const loaded = folderState.loadState(file, { restore: () => ({ text: good, takenAt: 99 }) });
    assert.strictEqual(loaded.restoredAt, 99);
    assert.ok(loaded.brokenPath && fs.existsSync(loaded.brokenPath), 'damaged index kept');
    assert.strictEqual(folderState.isLoadableText(good), true);
    assert.strictEqual(folderState.isLoadableText('{"version":99,"folders":{}}'), false);
  });

  // ---- the real main.js: healthy start, copy, damage, restart ---------------

  const shown = [];
  class RecordingNotification {
    constructor(o) { this.o = o; }
    static isSupported() { return true; }
    on() {}
    show() { shown.push(this.o); }
  }

  function healthyProfile(dir) {
    const photo = H.writeImage(path.join(dir, 'wallpapers', 'own-copy.png'));
    H.writeJson(path.join(dir, 'config.json'), {
      style: 'center', language: 'ru', firstRunDone: true, anonId: 'aaaabbbbccccdddd',
      monitors: { MON1: { light: { itemIds: [library.idFor(photo)] }, dark: { itemIds: [] } } },
    });
    fs.writeFileSync(path.join(dir, 'config.library.json'), healthyLibraryText(photo));
    return photo;
  }

  async function startedOnce(dir) {
    const m = H.loadMain(dir, { Notification: RecordingNotification });
    m.__test.loadConfig();
    m.__test.loadLiveFolderState();
    const taken = m.__test.dataSnapshots().takeAll();
    H.unloadMain();
    return taken;
  }

  await test('main: a damaged config.json comes back from the copy, is rewritten and is reported', async (dir) => {
    healthyProfile(dir);
    const taken = await startedOnce(dir);
    assert.strictEqual(taken.config, 'taken');
    fs.writeFileSync(path.join(dir, 'config.json'), DAMAGED);
    shown.length = 0;

    const m = H.loadMain(dir, { Notification: RecordingNotification });
    m.__test.loadConfig();
    const cfg = m.__test.getConfig();
    assert.strictEqual(cfg.style, 'center', 'settings came back, not defaults');
    assert.strictEqual(cfg.language, 'ru');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.strictEqual(onDisk.style, 'center', 'the damaged file was replaced by the restored one');
    const entry = m.__test.eventLogEntries().find((e) => e.messageKey === 'journal.configRestored');
    assert.ok(entry, 'journal line written');
    assert.strictEqual(entry.kind, 'recovered');
    assert.ok(entry.params && entry.params.date, 'the copy date is in the journal');
    assert.strictEqual(shown.length, 1, 'one notification');
    // Owner 2026-11-01: the reason has to be in the title, the part a collapsed toast shows.
    const ru = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'locales', 'ru.json'), 'utf8'));
    assert.strictEqual(shown[0].title, ru.notify.configRestoredTitle);
    assert.match(shown[0].title, /повреждён/);
    assert.ok(shown[0].body.includes(entry.params.date), 'the notification names the copy date');
    assert.ok(!/\{date\}/.test(shown[0].body), 'placeholder filled');
  });

  await test('main: a damaged library comes back from the copy, the sweeper holds for the session', async (dir) => {
    const photo = healthyProfile(dir);
    await startedOnce(dir);
    fs.writeFileSync(path.join(dir, 'config.library.json'), '{"version":1,"library":{');
    // An own-copy added after the copy was taken and put on a monitor: its record does not
    // survive the restore, so the slot that names it is a dangling reference.
    const later = H.writeImage(path.join(dir, 'wallpapers', 'added-later.png'));
    const cfgNow = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    cfgNow.monitors.MON1.dark = { itemIds: [library.idFor(later)] };
    H.writeJson(path.join(dir, 'config.json'), cfgNow);
    shown.length = 0;

    const m = H.loadMain(dir, { Notification: RecordingNotification });
    m.__test.loadConfig();
    const cfg = m.__test.getConfig();
    assert.ok(cfg.library[library.idFor(photo)], 'the record came back');
    assert.strictEqual(cfg.library[library.idFor(photo)].favorite, true);
    const store = JSON.parse(fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8'));
    assert.ok(store.library[library.idFor(photo)], 'the store file was rewritten from the copy');
    assert.ok(m.__test.eventLogEntries().some((e) => e.messageKey === 'journal.libraryRestored'));
    assert.deepStrictEqual(cfg.monitors.MON1.dark.itemIds, [], 'the dangling slot was cleared');
    assert.ok(!m.__test.eventLogEntries().some((e) => e.messageKey === 'journal.poolConsistency'),
      'no "interrupted save" notice on top of the restore one');
    assert.strictEqual(shown.length, 1, 'exactly one notification: the restore');

    m.__test.gcWallpapers();
    assert.ok(fs.existsSync(later), 'an own-copy without a record is not swept in the restored session');
  });

  for (const damagedSection of ['library', 'trash']) {
    await test(`main: a damaged ${damagedSection} does not replace the other section with an old copy`, async (dir) => {
      const oldPhoto = healthyProfile(dir);
      const storeFile = path.join(dir, 'config.library.json');
      const configFile = path.join(dir, 'config.json');
      const latestPhoto = H.writeImage(path.join(dir, 'wallpapers', 'newer-copy.png'));
      const latestId = library.idFor(latestPhoto);
      assert.strictEqual((await startedOnce(dir)).library, 'taken');
      const store = JSON.parse(healthyLibraryText(latestPhoto));
      store.trash = [{ item: { ...store.library[latestId] }, removedAt: 2, removalId: 'latest', via: 'manual' }];
      store[damagedSection] = 'damaged';
      const damaged = JSON.stringify(store);
      fs.writeFileSync(storeFile, damaged);
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      config.monitors.MON1.light.itemIds = [latestId];
      H.writeJson(configFile, config);

      const m = H.loadMain(dir, { Notification: RecordingNotification });
      m.__test.loadConfig();
      const cfg = m.__test.getConfig();
      if (damagedSection === 'trash') assert.strictEqual(cfg.library[latestId].favorite, true);
      else assert.strictEqual(cfg.libraryTrash[0].item.id, latestId);
      assert.ok(!cfg.library[library.idFor(oldPhoto)], 'the snapshot pool did not replace the current file');
      assert.deepStrictEqual(cfg.monitors.MON1.light.itemIds, [latestId], 'degraded loading does not repair monitor slots');
      assert.strictEqual(fs.readFileSync(storeFile, 'utf8'), damaged, 'startup does not overwrite the damaged file');
      const backups = fs.readdirSync(dir).filter((name) => name.startsWith('config.library.json.corrupt-'));
      assert.ok(backups.some((name) => fs.readFileSync(path.join(dir, name), 'utf8') === damaged));
      assert.ok(!m.__test.eventLogEntries().some((entry) => entry.messageKey === 'journal.libraryRestored'));
      m.__test.gcWallpapers();
      assert.ok(fs.existsSync(latestPhoto), 'GC stays off while the store is damaged');
    });
  }

  await test('main: notifications off — journal line only', async (dir) => {
    healthyProfile(dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    cfg.notifyOnFailure = false;
    H.writeJson(path.join(dir, 'config.json'), cfg);
    await startedOnce(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), DAMAGED);
    shown.length = 0;
    const m = H.loadMain(dir, { Notification: RecordingNotification });
    m.__test.loadConfig();
    assert.strictEqual(shown.length, 0);
    assert.ok(m.__test.eventLogEntries().some((e) => e.messageKey === 'journal.configRestored'));
  });

  await test('main: with no copy, a damaged config.json keeps the old behaviour (defaults, no notice)', async (dir) => {
    healthyProfile(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), DAMAGED);
    shown.length = 0;
    const m = H.loadMain(dir, { Notification: RecordingNotification });
    m.__test.loadConfig();
    assert.strictEqual(m.__test.getConfig().style, 'fill');
    assert.ok(!m.__test.eventLogEntries().some((e) => e.messageKey === 'journal.configRestored'));
  });

  await test('main: a damaged folder index comes back from the copy and is written out again', async (dir) => {
    healthyProfile(dir);
    const index = { version: folderState.VERSION, folders: {} };
    fs.writeFileSync(path.join(dir, 'folder-state.json'), JSON.stringify(index));
    const taken = await startedOnce(dir);
    assert.strictEqual(taken['folder-state'], 'taken');
    fs.writeFileSync(path.join(dir, 'folder-state.json'), '{"version":4,');
    const m = H.loadMain(dir, { Notification: RecordingNotification });
    m.__test.loadConfig();
    m.__test.loadLiveFolderState();
    assert.ok(m.__test.eventLogEntries().some((e) => e.messageKey === 'journal.folderStateRestored'));
    m.__test.flushLiveFolderState();
    assert.ok(folderState.isLoadableText(fs.readFileSync(path.join(dir, 'folder-state.json'), 'utf8')),
      'a healthy index is back on disk');
  });

  await test('folder index recovery can be repeated before the first process flushes', async (dir) => {
    const file = path.join(dir, 'folder-state.json');
    const damaged = '{"version":4,';
    const photo = path.join(dir, 'hidden.png');
    const baseline = folderState.reconcileFolder(folderState.emptyState(), {
      folderId: 'folder', rootPath: dir, folderAddedAt: 1, now: 2, status: 'complete', entries: [photo],
    }).state;
    const marked = folderState.setHidden(baseline, [photo], true).state;
    const restore = () => ({ text: JSON.stringify(marked), takenAt: 123 });
    fs.writeFileSync(file, damaged);
    const first = folderState.loadState(file, { restore, now: 1 });
    assert.strictEqual(first.restoredAt, 123);
    assert.strictEqual(fs.readFileSync(first.brokenPath, 'utf8'), damaged);
    const restarted = folderState.loadState(file, { restore, now: 2 });
    assert.deepStrictEqual(folderState.listImages(restarted.state, null, { only: 'hidden' }).map((im) => im.path), [photo]);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) {
    console.log(`\n✗ ${f.name}\n${f.err && f.err.stack}`);
    if (f.captured.length) console.log('--- captured output ---\n' + f.captured.join('\n'));
  }
  process.exit(failures.length ? 1 : 0);
})();
