'use strict';

// BUG-023: "the file is not there" and "the file could not be read" are different answers.
//
// `src/config.js` treated EVERY read exception as "no config yet", so a locked file, a
// permission error or a failing disk produced a brand new profile full of defaults — and
// main then wrote it. `ensureAnonId()` alone is enough: it fires on startup, sees no id
// in the defaults, invents one and saves. One transient error, and the user's settings,
// their monitor assignments and the legacy wallpaper fallback are gone.
//
// The pool survives that (it lives in its own file) but not completely: the keep-set the
// wallpaper collector builds includes the two global fallback paths out of config.json,
// so a defaults-only config makes an own-copy that nothing else references look like an
// orphan.
//
// The rule these tests pin down is therefore: only ENOENT means a new profile. Anything
// else is fail-closed — the app runs on defaults for the session, and NOTHING is written
// over the file it could not read. A corrupt file keeps its existing recovery policy
// (back it up, fall back to defaults) but only when the backup was actually created;
// without one, the damaged file is the only copy of the user's settings there is.
//
// Read failures are injected on the config path alone, so the pool file next to it is
// read for real and the two paths stay independent.
//
// Run: node test/config-read-failure.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const configMod = require('../src/config');
const library = require('../src/library');

let passed = 0;
const failures = [];

// The degraded paths below are what main.js is supposed to complain about, so its output
// is captured and shown only when a test actually fails.
async function test(name, fn) {
  const dir = H.makeTempProfile('config-read');
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

// Fail reads of ONE file. Everything else — the pool store above all — is read for real,
// so these tests exercise a config problem and not a general filesystem outage.
function withReadFailure(targetPath, code, fn) {
  const realRead = fs.readFileSync;
  const target = path.resolve(targetPath);
  fs.readFileSync = function patched(p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === target) {
      const err = new Error(`${code}: injected for ${p}`);
      err.code = code;
      throw err;
    }
    return realRead.call(this, p, ...rest);
  };
  try { return fn(); } finally { fs.readFileSync = realRead; }
}

// Counts every write/rename that lands inside the profile, so "nothing was written" is
// checked directly and not only inferred from the bytes being equal.
function countingWrites(dir, fn) {
  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  const root = path.resolve(dir);
  const touched = [];
  const inProfile = (p) => typeof p === 'string' && path.resolve(p).startsWith(root);
  fs.writeFileSync = function patched(p, ...rest) {
    if (inProfile(p)) touched.push(`write ${path.basename(p)}`);
    return realWrite.call(this, p, ...rest);
  };
  fs.renameSync = function patched(from, to, ...rest) {
    if (inProfile(to)) touched.push(`rename ${path.basename(to)}`);
    return realRename.call(this, from, to, ...rest);
  };
  try { fn(); } finally { fs.writeFileSync = realWrite; fs.renameSync = realRename; }
  return touched;
}

function healthyProfile(dir) {
  const photo = H.writeImage(path.join(dir, 'wallpapers', 'own-copy.png'));
  const id = library.idFor(photo);
  H.writeJson(cfgFile(dir), {
    autoSwitch: true,
    style: 'center',
    language: 'ru',
    firstRunDone: true,
    anonId: 'aaaabbbbccccdddd',
    // The legacy global fallback: the ONLY thing keeping this own-copy in the keep-set.
    lightWallpaper: photo,
    monitors: { MON1: { light: { itemIds: [] }, dark: { itemIds: [] } } },
  });
  H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [] });
  return { photo, id };
}

const UNREADABLE_CODES = ['EACCES', 'EBUSY', 'EIO', 'EPERM'];

(async () => {
  console.log('\nconfig read failures (BUG-023)\n');

  // ---- characterization: the states that already behave correctly ----------

  await test('a genuinely absent config.json is still a new profile', async (dir) => {
    H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [] });
    assert.ok(!fs.existsSync(cfgFile(dir)), 'precondition: no config file');

    const loaded = configMod.load(cfgFile(dir));
    assert.strictEqual(loaded.style, 'fill', 'a missing config must yield the defaults');
    assert.strictEqual(loaded.firstRunDone, false);

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.ensureAnonId();
    assert.ok(fs.existsSync(cfgFile(dir)), 'a new profile must be written out');
    assert.match(JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8')).anonId, /^[0-9a-f]{32}$/);
  });

  await test('a readable config keeps its values and its install id', async (dir) => {
    healthyProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.ensureAnonId();

    const live = m.__test.getConfig();
    assert.strictEqual(live.style, 'center');
    assert.strictEqual(live.language, 'ru');
    assert.strictEqual(live.anonId, 'aaaabbbbccccdddd', 'the stored install id was replaced');
  });

  await test('unparseable JSON keeps its existing policy: back it up, fall back to defaults', async (dir) => {
    H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [] });
    fs.writeFileSync(cfgFile(dir), '{ this is not json', 'utf8');

    const loaded = configMod.load(cfgFile(dir));
    assert.strictEqual(loaded.style, 'fill', 'a corrupt config falls back to the defaults');
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    assert.strictEqual(backups.length, 1, 'the damaged file must be backed up beside itself');
  });

  // ---- regression: a read failure is not an empty profile ------------------

  for (const code of UNREADABLE_CODES) {
    await test(`${code} is reported as unreadable, not as missing`, async (dir) => {
      healthyProfile(dir);
      const loaded = withReadFailure(cfgFile(dir), code, () => configMod.load(cfgFile(dir)));
      const source = loaded._configSource || {};
      assert.strictEqual(source.state, 'unreadable', `${code} was classified as '${source.state}'`);
      assert.strictEqual(source.writable, false, `${code} left the config writable`);
    });
  }

  await test('a config path that is a directory is unreadable, not missing', async (dir) => {
    // A real, un-mocked non-ENOENT read error, to prove the rule is about the error code
    // and not about the way the test produces it.
    H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [] });
    fs.mkdirSync(cfgFile(dir), { recursive: true });

    const loaded = configMod.load(cfgFile(dir));
    assert.strictEqual((loaded._configSource || {}).state, 'unreadable');
  });

  await test('ENOENT is the only code that means a new profile', async (dir) => {
    H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [] });
    const loaded = withReadFailure(cfgFile(dir), 'ENOENT', () => configMod.load(cfgFile(dir)));
    const source = loaded._configSource || {};
    assert.strictEqual(source.state, 'missing');
    assert.strictEqual(source.writable, true, 'a new profile must still be writable');
  });

  await test('startup over an unreadable config writes nothing at all', async (dir) => {
    healthyProfile(dir);
    const before = fs.readFileSync(cfgFile(dir), 'utf8');

    const m = H.loadMain(dir);
    const touched = countingWrites(dir, () => {
      withReadFailure(cfgFile(dir), 'EACCES', () => m.__test.loadConfig());
      m.__test.ensureAnonId();
    });

    assert.deepStrictEqual(
      touched.filter((t) => t.includes('config.json')), [],
      `startup wrote to config.json: ${touched.join(', ')}`,
    );
    assert.strictEqual(fs.readFileSync(cfgFile(dir), 'utf8'), before, 'config.json was overwritten');
    assert.strictEqual(
      m.__test.getConfig().anonId, '',
      'an install id was invented that could not be stored, so it would differ every session',
    );
  });

  await test('a settings change over an unreadable config reports failure and changes nothing', async (dir) => {
    healthyProfile(dir);
    const before = fs.readFileSync(cfgFile(dir), 'utf8');

    const m = H.loadMain(dir);
    withReadFailure(cfgFile(dir), 'EBUSY', () => m.__test.loadConfig());

    const returned = await m.invoke('set-config', { style: 'fit' });
    assert.strictEqual(returned.style, 'fill', 'a change that cannot be saved was reported as applied');
    assert.strictEqual(m.__test.getConfig().style, 'fill', 'the live config kept an unsaved change');
    assert.strictEqual(fs.readFileSync(cfgFile(dir), 'utf8'), before, 'config.json was overwritten');
  });

  await test('the slideshow position is not persisted over an unreadable config', async (dir) => {
    healthyProfile(dir);
    const before = fs.readFileSync(cfgFile(dir), 'utf8');

    const m = H.loadMain(dir);
    withReadFailure(cfgFile(dir), 'EIO', () => m.__test.loadConfig());

    const touched = countingWrites(dir, () => {
      m.__test.getConfig().slideshowIndex = { MON1: { light: 3, dark: 0 } };
      m.__test.persistSlideshowPosition(true);
    });
    assert.deepStrictEqual(touched.filter((t) => t.includes('config.json')), []);
    assert.strictEqual(fs.readFileSync(cfgFile(dir), 'utf8'), before);
    // ...and it stays outstanding. Clearing the flag on a refused write would declare the
    // position saved, so the next chance to write it would never come.
    assert.strictEqual(
      m.__test.slideshowPositionPending(), true,
      'a refused write marked the slideshow position as saved',
    );
  });

  await test('the wallpaper collector does not sweep against a config it could not read', async (dir) => {
    const { photo } = healthyProfile(dir);
    // The pool is empty on purpose: this own-copy is kept ONLY by the legacy global
    // fallback in config.json, which a defaults-only config does not have.
    const m = H.loadMain(dir);
    withReadFailure(cfgFile(dir), 'EACCES', () => m.__test.loadConfig());
    m.__test.getConfig().library = {
      seed: { id: 'seed', type: 'image', path: path.join(dir, 'wallpapers', 'seed.png'), addedAt: 1, favorite: false, tags: [] },
    };

    await m.invoke('clear-slot', 'MON1', 'light'); // this handler runs the collector

    assert.ok(fs.existsSync(photo), 'an own-copy still referenced by the real config was swept away');
  });

  await test('once the config can be read again the original profile comes back', async (dir) => {
    healthyProfile(dir);

    const first = H.loadMain(dir);
    withReadFailure(cfgFile(dir), 'EACCES', () => first.__test.loadConfig());
    first.__test.ensureAnonId();
    await first.invoke('set-config', { style: 'fit' });
    first.__test.saveConfig();

    H.unloadMain();
    const second = H.loadMain(dir);
    second.__test.loadConfig();
    const live = second.__test.getConfig();
    assert.strictEqual(live.style, 'center', 'the original style did not survive the degraded session');
    assert.strictEqual(live.language, 'ru', 'the original language did not survive');
    assert.strictEqual(live.anonId, 'aaaabbbbccccdddd', 'the original install id did not survive');
    assert.strictEqual(live.firstRunDone, true, 'the user would be shown the first-run screen again');
  });

  await test('a corrupt config whose backup cannot be written is not overwritten either', async (dir) => {
    H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [] });
    fs.writeFileSync(cfgFile(dir), '{ "style": "center", TRUNCATED', 'utf8');
    const before = fs.readFileSync(cfgFile(dir), 'utf8');

    const realCopy = fs.copyFileSync;
    fs.copyFileSync = () => { throw new Error('backup refused'); };
    let loaded;
    try { loaded = configMod.load(cfgFile(dir)); } finally { fs.copyFileSync = realCopy; }

    assert.strictEqual(
      (loaded._configSource || {}).state, 'corrupt-unbacked',
      'a damaged file with no backup was treated like an ordinary recoverable one',
    );
    assert.strictEqual((loaded._configSource || {}).writable, false);

    const m = H.loadMain(dir);
    fs.copyFileSync = () => { throw new Error('backup refused'); };
    try { m.__test.loadConfig(); } finally { fs.copyFileSync = realCopy; }
    await m.invoke('set-config', { style: 'fit' });
    m.__test.ensureAnonId();

    assert.strictEqual(
      fs.readFileSync(cfgFile(dir), 'utf8'), before,
      'the only remaining copy of the settings was overwritten with defaults',
    );
  });

  await test('a corrupt config WITH a backup keeps working as before', async (dir) => {
    // The other side of the rule: the existing recovery path must not become fail-closed
    // just because a neighbouring one did.
    H.writeJson(storeFile(dir), { version: 1, library: {}, trash: [] });
    fs.writeFileSync(cfgFile(dir), '{ broken', 'utf8');

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    const returned = await m.invoke('set-config', { style: 'fit' });
    assert.strictEqual(returned.style, 'fit', 'a recoverable corrupt config stopped accepting settings');
    assert.strictEqual(JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8')).style, 'fit');
  });

  await test('the user is told once, not once per action', async (dir) => {
    healthyProfile(dir);
    const m = H.loadMain(dir);
    withReadFailure(cfgFile(dir), 'EACCES', () => m.__test.loadConfig());

    await m.invoke('set-config', { style: 'fit' });
    await m.invoke('set-config', { style: 'span' });
    await m.invoke('set-config', { telemetry: true });

    const entries = m.__test.eventLogEntries().filter((it) => it.channel === 'config-store');
    assert.strictEqual(entries.length, 1, `the failure was journalled ${entries.length} times`);
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
