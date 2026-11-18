'use strict';

// LIB-030. The background pass over real files on disk, with everything around it —
// the library's file list, the fingerprint cache, "is a game running" — replaced by
// stand-ins the test controls. The orchestration through main.js is covered separately
// (test/library-checks-main.test.js); this suite is about the pass itself.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { makeTempDir } = require('./helpers/temp-dir');
const checks = require('../src/library-checks');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

function write(dir, name, text) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

function md5Of(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

// A fingerprint stand-in that hashes for real and records what it was asked to read.
function makeFingerprint() {
  const read = [];
  const fn = async (p) => {
    read.push(p);
    try { return { value: crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'), cached: false }; }
    catch { return { error: 'missing' }; }
  };
  return { fn, read };
}

// Timers the test fires by hand, so "a pass is waiting" is something it can look at.
function makeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pending,
  };
}

function setup(opts = {}) {
  const dir = makeTempDir('znada-checks-');
  const files = opts.files || [];
  const print = makeFingerprint();
  const changes = [];
  let enabled = opts.enabled !== false;
  let busy = false;
  const timers = makeTimers();
  const service = checks.createLibraryChecks({
    configPath: path.join(dir, 'config.json'),
    isEnabled: () => enabled,
    listFiles: () => files.slice(),
    fingerprint: opts.fingerprint || print.fn,
    isBusy: async () => busy,
    onChange: (s) => changes.push(s),
    onHaveChange: opts.onHaveChange,
    timers,
    delays: { gapMs: 0, busyCheckMs: 0 },
    logger: { error() {} },
  });
  // As main does once the app is up; a test about the gate itself passes started: false.
  if (opts.started !== false) service.start();
  return {
    dir, files, print, changes, timers, service,
    setEnabled(v) { enabled = v; },
    setBusy(v) { busy = v; },
    reopen() {
      return checks.createLibraryChecks({
        configPath: path.join(dir, 'config.json'),
        isEnabled: () => enabled,
        listFiles: () => files.slice(),
        fingerprint: print.fn,
        isBusy: async () => busy,
        timers: makeTimers(),
        delays: { gapMs: 0, busyCheckMs: 0 },
        logger: { error() {} },
      });
    },
  };
}

(async () => {
  // --- finding copies --------------------------------------------------------------
  {
    const t = setup();
    const lib = makeTempDir('znada-checks-lib-');
    const a = write(lib, 'a.jpg', 'same bytes');
    const b = write(lib, 'sub/b.jpg', 'same bytes');
    const c = write(lib, 'c.jpg', 'diff bytes'); // same size, different content
    const lonely = write(lib, 'lonely.jpg', 'a file of a size nobody else has');
    // Sizes are known for some (a watched folder's index) and missing for others.
    t.files.push({ path: a, size: 10 }, { path: b }, { path: c }, { path: lonely });
    // LIB-031 reads every photo, but only after the identical-files answer is in.
    let answeredBeforeLonely = null;
    const fingerprintAsIs = t.print.fn;
    t.print.fn = null;
    const service = checks.createLibraryChecks({
      configPath: path.join(t.dir, 'config.json'),
      isEnabled: () => true,
      listFiles: () => t.files.slice(),
      fingerprint: async (p) => {
        if (p === lonely) answeredBeforeLonely = service.summary().checked;
        return fingerprintAsIs(p);
      },
      isBusy: async () => false,
      onChange: (x) => t.changes.push(x),
      timers: makeTimers(),
      delays: { gapMs: 0, busyCheckMs: 0 },
      logger: { error() {} },
    });
    service.start();
    t.service = service;
    await t.service.runNow();
    const s = t.service.summary();
    ok('two files with the same bytes are one group with one extra copy',
      s.checked && s.groups === 1 && s.copies === 1 && s.fresh === 1);
    ok('a file whose size nobody shares is read only after identical files are answered',
      answeredBeforeLonely === true);
    const groups = t.service.duplicates();
    ok('the view gets the group with both paths, and not the look-alike of the same size',
      groups.length === 1 && groups[0].paths.length === 2 && !groups[0].paths.includes(c));
    ok('the window heard that a pass started and ended',
      t.changes.some((x) => x.running) && t.changes[t.changes.length - 1].running === false);

    // The user removes one copy: the group goes at once, without another pass.
    t.files.splice(t.files.findIndex((f) => f.path === b), 1);
    ok('a copy that leaves the library leaves its group without a pass',
      t.service.duplicates().length === 0 && t.service.summary().copies === 0);
  }

  // --- told once -------------------------------------------------------------------
  {
    const t = setup();
    const lib = makeTempDir('znada-checks-lib-');
    t.files.push({ path: write(lib, 'a.jpg', 'xx') }, { path: write(lib, 'b.jpg', 'xx') });
    await t.service.runNow();
    ok('found copies are new until the window says it showed them', t.service.summary().fresh === 1);
    const after = t.service.acknowledge();
    ok('after the notice nothing is new', after.fresh === 0 && after.copies === 1);

    const reopened = t.reopen();
    await reopened.runNow();
    ok('a restart does not announce the same copies again', reopened.summary().fresh === 0 && reopened.summary().copies === 1);

    t.files.push({ path: write(lib, 'c.jpg', 'xx') });
    await reopened.runNow();
    ok('a newly added file that repeats one already there is announced', reopened.summary().fresh === 1);
  }

  // --- switched off ------------------------------------------------------------------
  // LIB-031 has no switch of its own (owner, 2026-11-08): the pass still reads every photo.
  // The identical-files switch decides only whether copies are looked for and announced.
  {
    const t = setup({ enabled: false });
    const lib = makeTempDir('znada-checks-lib-');
    const a = write(lib, 'a.jpg', 'yy');
    const b = write(lib, 'b.jpg', 'yy');
    t.files.push({ path: a }, { path: b });
    ok('a library change still schedules the pass', t.service.schedule() === true && t.timers.pending.size === 1);
    await t.service.runNow();
    const s = t.service.summary();
    ok('switched off, copies are neither found nor reported',
      !s.enabled && !s.checked && s.fresh === 0 && s.copies === 0 && t.service.duplicates().length === 0);
    ok('switched off, every photo is still read for "already have it"',
      t.print.read.includes(a) && t.print.read.includes(b) && t.service.finder().byHash(md5Of('yy')) !== '');

  }
  {
    const t = setup({ enabled: false });
    t.setEnabled(true);
    t.service.settingsChanged();
    ok('switching it on looks soon', t.timers.pending.size === 1);
    t.setEnabled(false);
    t.service.settingsChanged();
    ok('switching it off leaves the pass waiting and says so',
      t.timers.pending.size === 1 && t.changes[t.changes.length - 1].enabled === false);
  }

  // --- switched off while the copies were being read keeps none ----------------------------
  {
    const t = setup();
    const lib = makeTempDir('znada-checks-lib-');
    t.files.push({ path: write(lib, 'a.jpg', 'zz') }, { path: write(lib, 'b.jpg', 'zz') });
    let enabled = true;
    const service = checks.createLibraryChecks({
      configPath: path.join(t.dir, 'config.json'),
      isEnabled: () => enabled,
      listFiles: () => t.files.slice(),
      fingerprint: async (p) => {
        if (enabled) { enabled = false; service.settingsChanged(); }
        return t.print.fn(p);
      },
      isBusy: async () => false,
      timers: makeTimers(),
      delays: { gapMs: 0, busyCheckMs: 0 },
      logger: { error() {} },
    });
    service.start();
    await service.runNow();
    ok('copies read while the switch went off are not kept', !service.summary().checked && service.duplicates().length === 0);
  }

  // --- a pass abandoned halfway keeps nothing ------------------------------------------
  {
    const t = setup();
    const lib = makeTempDir('znada-checks-lib-');
    t.files.push({ path: write(lib, 'a.jpg', 'zz') }, { path: write(lib, 'b.jpg', 'zz') });
    const service = checks.createLibraryChecks({
      configPath: path.join(t.dir, 'config.json'),
      isEnabled: () => true,
      listFiles: () => t.files.slice(),
      // The app shuts down while the first file is being read.
      fingerprint: async (p) => { service.dispose(); return t.print.fn(p); },
      isBusy: async () => false,
      timers: makeTimers(),
      delays: { gapMs: 0, busyCheckMs: 0 },
      logger: { error() {} },
    });
    service.start();
    await service.runNow();
    ok('a pass abandoned halfway saves nothing', !service.summary().checked && t.print.read.length === 1);
  }

  // --- LIB-031: what the library holds, by fingerprint and by size --------------------------
  {
    const t = setup();
    const lib = makeTempDir('znada-checks-lib-');
    const a = write(lib, 'a.jpg', 'one photo');
    const b = write(lib, 'b.png', 'another photo, longer');
    const v = write(lib, 'clip.mp4', 'a video file');
    t.files.push({ path: a }, { path: b, size: 21 }, { path: v, video: true });
    await t.service.runNow();
    const find = t.service.finder();
    ok('a photo is found by its fingerprint', find.byHash(md5Of('one photo')) === a);
    ok('the fingerprint is matched whatever its case', find.byHash(md5Of('one photo').toUpperCase()) === a);
    ok('an unknown fingerprint finds nothing', find.byHash(md5Of('nobody has this')) === '');
    ok('a video is never offered', find.byHash(md5Of('a video file')) === '' && !t.print.read.includes(v));
    ok('a photo is found by its size — told by the folder index or measured by the pass',
      find.bySize(21).includes(b) && find.bySize(Buffer.byteLength('one photo')).includes(a));

    // Removed from the library: gone at once, without waiting for a pass.
    t.files.splice(t.files.findIndex((f) => f.path === a), 1);
    ok('a photo that leaves the library is not offered any more',
      t.service.finder().byHash(md5Of('one photo')) === '' && !t.service.finder().bySize(Buffer.byteLength('one photo')).includes(a));

    // The file is overwritten with other bytes: the next pass forgets the old fingerprint.
    fs.writeFileSync(b, 'replaced content!!!!!');
    await t.service.runNow();
    ok('a file whose bytes changed is no longer found by the old fingerprint',
      t.service.finder().byHash(md5Of('another photo, longer')) === ''
      && t.service.finder().byHash(md5Of('replaced content!!!!!')) === b);
  }

  // --- LIB-031: the window hears that it should ask again ------------------------------------
  {
    let readable = true;
    let notices = 0;
    const t = setup({
      enabled: false,
      onHaveChange: () => { notices += 1; },
      fingerprint: async (file) => readable
        ? { value: md5Of(fs.readFileSync(file)), cached: true }
        : { error: 'unreadable' },
    });
    const photo = write(t.dir, 'replaced.jpg', 'original');
    t.files.push({ path: photo, size: 8, watched: true });
    await t.service.runNow();
    assert.strictEqual(t.service.finder().byHash(md5Of('original')), photo);
    const flushNotice = () => {
      for (const [id, { fn }] of t.timers.pending) {
        t.timers.pending.delete(id);
        fn();
      }
    };
    flushNotice();
    const previousMtime = fs.statSync(photo).mtimeMs;
    readable = false;
    fs.writeFileSync(photo, 'new data');
    fs.utimesSync(photo, new Date(previousMtime + 10000), new Date(previousMtime + 10000));
    await t.service.runNow();
    assert.strictEqual(t.service.finder().byHash(md5Of('original')), '');
    flushNotice();
    assert.strictEqual(notices, 2, 'invalidating the old fingerprint asks Online to refresh');
    readable = true;
    await t.service.runNow();
    ok('an unreadable same-size replacement invalidates the old match until its own fingerprint is read',
      t.service.finder().byHash(md5Of('new data')) === photo);
    t.service.dispose();
  }
  {
    const dir = makeTempDir('znada-checks-');
    const lib = makeTempDir('znada-checks-lib-');
    const files = [{ path: write(lib, 'a.jpg', 'aa') }, { path: write(lib, 'b.jpg', 'bbb') }];
    const timers = makeTimers();
    let heard = 0;
    const clock = 0;
    const service = checks.createLibraryChecks({
      configPath: path.join(dir, 'config.json'),
      isEnabled: () => true,
      listFiles: () => files.slice(),
      fingerprint: makeFingerprint().fn,
      isBusy: async () => false,
      onHaveChange: () => { heard += 1; },
      timers,
      now: () => clock,
      delays: { gapMs: 0, busyCheckMs: 0 },
      logger: { error() {} },
    });
    service.start();
    await service.runNow();
    const notices = () => Array.from(timers.pending.entries()).filter(([, x]) => x.ms <= checks.HAVE_NOTICE_MS);
    ok('fingerprints learned by a pass make one notice, not one per file', notices().length === 1);
    const [id, first] = notices()[0];
    timers.pending.delete(id);
    first.fn();
    ok('the notice reaches the window', heard === 1);
    service.schedule();
    const [, second] = notices()[0];
    ok('a library change makes the next notice, but not sooner than the pause between them',
      second.ms === checks.HAVE_NOTICE_MS);
    service.dispose();
  }

  // --- a game in progress ---------------------------------------------------------------
  {
    const t = setup();
    const lib = makeTempDir('znada-checks-lib-');
    t.files.push({ path: write(lib, 'a.jpg', 'gg') }, { path: write(lib, 'b.jpg', 'gg') });
    t.setBusy(true);
    await t.service.runNow();
    ok('during a game nothing is read and nothing is saved',
      t.print.read.length === 0 && !t.service.summary().checked);
    const waiting = Array.from(t.timers.pending.values());
    ok('the pass comes back a minute later', waiting.length === 1 && waiting[0].ms === checks.BUSY_RETRY_MS);
  }

  // --- nothing before the app is up ------------------------------------------------------
  {
    const t = setup({ started: false });
    ok('a library change before start schedules nothing', t.service.schedule() === false && t.timers.pending.size === 0);
    ok('start with a delay schedules the first pass', t.service.start(60000) === true
      && Array.from(t.timers.pending.values())[0].ms === 60000);
  }

  // --- a burst of changes is one pass ---------------------------------------------------
  {
    const t = setup();
    t.service.schedule();
    t.service.schedule();
    t.service.schedule(1);
    ok('several changes in a row leave one pass waiting', t.timers.pending.size === 1);
  }

  // --- the stored state -------------------------------------------------------------------
  {
    const t = setup();
    fs.writeFileSync(checks.storePathFor(path.join(t.dir, 'config.json')), '{ not json');
    const s = t.service.summary();
    ok('an unreadable state file is an empty one', !s.checked && s.copies === 0);
    ok('the state file is named after its profile',
      checks.storePathFor('C:\\p\\config.json') === path.join('C:\\p', 'config.checks.json'));
  }

  // --- LIB-031: right after launch, from the fingerprint cache --------------------------------
  {
    const lib = makeTempDir('znada-checks-recall-');
    const known = write(lib, 'known.jpg', 'a photo hashed long ago');
    const fresh = write(lib, 'fresh.jpg', 'a photo never hashed');
    const clip = write(lib, 'clip.mp4', 'a video');
    const files = [{ path: known }, { path: fresh }, { path: clip, video: true }];
    const make = (over = {}) => {
      const looked = [];
      const notices = [];
      const print = makeFingerprint();
      const timers = makeTimers();
      const service = checks.createLibraryChecks({
        configPath: path.join(makeTempDir('znada-checks-recall-cfg-'), 'config.json'),
        isEnabled: () => true,
        listFiles: () => files.slice(),
        fingerprint: print.fn,
        cachedFingerprint: async (p) => { looked.push(p); return p === known ? md5Of('a photo hashed long ago') : ''; },
        isBusy: async () => false,
        onHaveChange: () => notices.push(1),
        timers,
        delays: { gapMs: 0, busyCheckMs: 0, haveNoticeMs: 0 },
        logger: { error() {} },
        ...over,
      });
      return { service, timers, looked, notices, print };
    };
    // recall() reads real file sizes, so a fixed timer only guessed when it was done.
    const settle = (made) => made.service.recalled();
    const fireNotices = (t) => {
      for (const [id, entry] of [...t.timers.pending]) {
        if (entry.ms === 0) { t.timers.pending.delete(id); entry.fn(); }
      }
    };

    const t = make();
    t.service.start(60000);
    await settle(t);
    ok('right after launch a cached photo is known, long before the pass',
      t.service.finder().byHash(md5Of('a photo hashed long ago')) === known && t.service.passCount() === 0);
    ok('no file was read to know it', t.print.read.length === 0);
    ok('a photo the cache does not know waits for the pass', t.service.finder().byHash(md5Of('a photo never hashed')) === '');
    ok('its size is known already: a site without a fingerprint can match it',
      t.service.finder().bySize(Buffer.byteLength('a photo never hashed')).includes(fresh));
    ok('a video is not looked up', !t.looked.includes(clip));
    ok('the pass still waits for its minute', [...t.timers.pending.values()].some((e) => e.ms === 60000));

    // Without the delay nothing else asks for a notice: this one is recall's own.
    const told = make();
    told.service.start();
    await settle(told);
    fireNotices(told);
    ok('the window is told to ask its cards again', told.notices.length === 1);

    let asked = 0;
    const busy = make({ isBusy: async () => { asked += 1; return true; } });
    busy.service.start();
    await settle(busy);
    ok('a game running: not even a stat', asked === 1 && busy.looked.length === 0);

    const gone = make();
    gone.service.start();
    gone.service.dispose();
    await settle(gone);
    ok('closed meanwhile: nothing learned and nobody told',
      gone.service.finder().byHash(md5Of('a photo hashed long ago')) === '' && gone.timers.pending.size === 0);

    const broken = make({ cachedFingerprint: async () => { throw new Error('cache gone'); } });
    broken.service.start();
    await settle(broken);
    ok('a broken cache costs only the head start', broken.service.finder().byHash(md5Of('a photo hashed long ago')) === '');
  }

  console.log(`\nAll ${passed} library-checks tests passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
