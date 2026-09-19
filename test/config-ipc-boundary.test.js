'use strict';

// BUG-022: what the settings channel is allowed to change.
//
// `set-config` used to shallow-merge whatever object the window handed it straight into
// the live config. Every field was reachable that way, including the ones the window has
// no business naming: the photo pool, the trash, the per-monitor placement and the
// anonymous install id. That is not a theoretical hole. Settings are written with
// `skipLibrary`, which strips `library`/`libraryTrash` out of config.json on the way to
// disk — so a patch carrying `library: {}` first empties the pool in memory, and the next
// pool write (a tag, a favourite, an assignment) makes the empty version the real one.
// The photos are then orphans, and the collector is free to sweep them.
//
// So these tests are about the BOUNDARY, not about any single field:
//   - every key the window really sends still works, with its side effect and its
//     normalisation (that half must be GREEN before the fix and stay green after);
//   - every other key is refused, whole patches at a time, leaving the bytes on disk
//     untouched (that half must be RED before the fix).
//
// They run the real main.js over a real temp profile, because what makes the hole
// dangerous is the ORDER main writes things in, which no module test can see.
//
// Run: node test/config-ipc-boundary.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');

let passed = 0;
const failures = [];

// main.js legitimately reports the degraded paths some of these tests create (an apply
// that cannot run without a child process). Captured, and shown only when a test fails.
async function test(name, fn) {
  const dir = H.makeTempProfile('config-boundary');
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

function baseConfig(extra = {}) {
  return { autoSwitch: true, style: 'fill', monitors: {}, ...extra };
}

// A profile with everything a forbidden patch must not be able to reach: a favourited,
// tagged photo in the pool, a slot pointing at it, and a tombstone in the trash.
function seedProfile(dir) {
  const photo = H.writeImage(path.join(dir, 'wallpapers', 'keepme.png'));
  const gone = H.writeImage(path.join(dir, 'wallpapers', 'gone.png'));
  const id = library.idFor(photo);
  const goneId = library.idFor(gone);
  H.writeJson(cfgFile(dir), baseConfig({
    monitors: { MON1: { light: { itemIds: [id] }, dark: { itemIds: [] } } },
    anonId: 'aaaabbbbccccdddd',
  }));
  H.writeJson(storeFile(dir), {
    version: 1,
    library: { [id]: { id, type: 'image', path: photo, addedAt: 1, favorite: true, tags: ['keep'], rev: 3 } },
    trash: [{
      item: { id: goneId, type: 'image', path: gone, addedAt: 1, favorite: false, tags: [] },
      removedAt: 5,
      rev: 4,
    }],
  });
  return { photo, id, gone, goneId };
}

function bytes(dir) {
  return {
    config: fs.readFileSync(cfgFile(dir), 'utf8'),
    store: fs.readFileSync(storeFile(dir), 'utf8'),
  };
}

// Everything the pool has to still look like afterwards, in one comparable value.
function poolShape(cfg) {
  return {
    ids: Object.keys(cfg.library).sort(),
    favorite: Object.values(cfg.library).map((it) => it.favorite),
    tags: Object.values(cfg.library).map((it) => (it.tags || []).join(',')),
    trash: (cfg.libraryTrash || []).map((e) => e.item && e.item.id),
    monitors: JSON.stringify(cfg.monitors),
    anonId: cfg.anonId,
  };
}

const REJECTED = /E_SETTINGS_REJECTED/;

// Top-level keys of every `window.api.setConfig({...})` literal in renderer.js. Braces
// are matched rather than pattern-guessed, so a nested object contributes nothing and a
// spread (`...config.triggers`) is ignored — only what the window actually names.
function settingKeysUsedByRenderer() {
  const src = fs.readFileSync(path.join(H.ROOT, 'renderer', 'renderer.js'), 'utf8');
  const marker = 'window.api.setConfig(';
  const keys = new Set();
  let calls = 0;
  for (let at = src.indexOf(marker); at !== -1; at = src.indexOf(marker, at + 1)) {
    const open = src.indexOf('{', at);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) continue;
    calls++;
    const body = src.slice(open + 1, end);
    let d = 0;
    let token = '';
    for (const ch of body) {
      if (ch === '{' || ch === '[' || ch === '(') { d++; continue; }
      if (ch === '}' || ch === ']' || ch === ')') { d--; continue; }
      if (d !== 0) continue;
      if (ch === ':') {
        const m = token.match(/([A-Za-z_$][\w$]*)\s*$/);
        if (m) keys.add(m[1]);
        token = '';
        continue;
      }
      if (ch === ',') { token = ''; continue; }
      token += ch;
    }
  }
  return { keys: [...keys], calls };
}

(async () => {
  console.log('\nset-config boundary (BUG-022)\n');

  // ---- characterization: the keys the window really sends -------------------
  // Green before the fix and after it. This is the half that proves the allowlist was
  // built from the real call sites and not from a guess.

  await test('every scalar setting the window sends is applied and persisted', async (dir) => {
    seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();

    const sent = {
      style: 'fit',
      librarySort: 'name',
      language: 'ru',
      telemetry: true,
      gameModeBlock: true,
      notifyOnFailure: false,
      firstRunDone: true,
      singleWallpaper: true,
      viewerBackground: 'charcoal',
      onlineSort: 'toplist',
      onlineSourcesExpanded: true,
      libraryTagsExpanded: true,
    };
    for (const [key, value] of Object.entries(sent)) {
      await m.invoke('set-config', { [key]: value });
    }

    const live = m.__test.getConfig();
    for (const [key, value] of Object.entries(sent)) {
      assert.strictEqual(live[key], value, `${key} was not applied`);
    }
    const onDisk = JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8'));
    for (const [key, value] of Object.entries(sent)) {
      assert.strictEqual(onDisk[key], value, `${key} was not persisted`);
    }
  });

  await test('the nested objects the window sends are merged, not replaced wholesale', async (dir) => {
    seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();

    // The window always spreads the current object and changes one field. What matters is
    // that the fields it did NOT name survive.
    await m.invoke('set-config', {
      themeSchedule: { ...m.__test.getConfig().themeSchedule, lat: '50.4', lng: '30.5' },
    });
    let live = m.__test.getConfig();
    assert.strictEqual(live.themeSchedule.lat, '50.4');
    assert.strictEqual(live.themeSchedule.mode, 'off', 'an unnamed field of themeSchedule was lost');
    assert.strictEqual(live.themeSchedule.lightStart, '07:00');

    await m.invoke('set-config', { themeSchedule: { mode: 'time' } });
    live = m.__test.getConfig();
    assert.strictEqual(live.themeSchedule.mode, 'time');
    assert.strictEqual(live.themeSchedule.lat, '50.4', 'a partial themeSchedule patch dropped lat');

    await m.invoke('set-config', { triggers: { ...live.triggers, onStartup: true } });
    live = m.__test.getConfig();
    assert.strictEqual(live.triggers.onStartup, true);
    assert.strictEqual(live.triggers.stealth.timeoutMin, 5, 'the stealth sub-object was lost');

    await m.invoke('set-config', {
      triggers: { ...live.triggers, stealth: { ...live.triggers.stealth, enabled: true, interval: true } },
    });
    live = m.__test.getConfig();
    assert.strictEqual(live.triggers.stealth.enabled, true);
    assert.strictEqual(live.triggers.stealth.interval, true);
    assert.strictEqual(live.triggers.onStartup, true, 'changing stealth reset a sibling trigger');

    await m.invoke('set-config', { onlineSources: { lumina: true, internet: false } });
    live = m.__test.getConfig();
    assert.deepStrictEqual(live.onlineSources, {
      lumina: true, internet: false,
      providers: { wallhaven: false, gelbooru: false, danbooru: false },
    });

    await m.invoke('set-config', { onlinePurity: { sfw: true, sketchy: true, nsfw: false } });
    live = m.__test.getConfig();
    assert.deepStrictEqual(live.onlinePurity, { sfw: true, sketchy: true, nsfw: false });

    // ONL-010. A real target list is accepted and stored in the one canonical shape.
    await m.invoke('set-config', {
      onlineSizeFilter: { enabled: true, mode: 'manual', targets: [{ minWidth: 1920, minHeight: 1080 }] },
    });
    live = m.__test.getConfig();
    assert.strictEqual(live.onlineSizeFilter.enabled, true);
    assert.strictEqual(live.onlineSizeFilter.targets.length, 1);
    assert.strictEqual(live.onlineSizeFilter.targets[0].minWidth, 1920);

    // And a list that does not survive validation is refused OUTRIGHT rather than
    // quietly stored as fewer targets — silently dropping one would filter by a rule the
    // user never asked for, on a setting whose whole job is to decide what is hidden.
    for (const bad of [{}, 'wide', { minWidth: 0 }, null]) {
      await assert.rejects(
        () => m.invoke('set-config', { onlineSizeFilter: { enabled: true, targets: [bad] } }),
        REJECTED,
        `a target of ${JSON.stringify(bad)} was accepted`,
      );
    }
    await assert.rejects(
      () => m.invoke('set-config', { onlineSizeFilter: { targets: 'everything' } }), REJECTED);
    await assert.rejects(
      () => m.invoke('set-config', { onlineSizeFilter: { mode: 'sideways' } }), REJECTED);
    // Nothing above may have changed what was stored by the accepted call.
    live = m.__test.getConfig();
    assert.strictEqual(live.onlineSizeFilter.targets.length, 1);
  });

  await test('wallpaperSchedule keeps its normalisation and its autoSwitch mirror', async (dir) => {
    seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();

    await m.invoke('set-config', { wallpaperSchedule: { mode: 'off' } });
    let live = m.__test.getConfig();
    assert.strictEqual(live.wallpaperSchedule.mode, 'off');
    assert.strictEqual(live.autoSwitch, false, 'autoSwitch no longer mirrors the schedule mode');
    assert.strictEqual(live.wallpaperSchedule.lightStart, '07:00', 'a default field was dropped');

    // An unknown mode has always fallen back to 'system' rather than being stored.
    await m.invoke('set-config', { wallpaperSchedule: { mode: 'nonsense' } });
    live = m.__test.getConfig();
    assert.strictEqual(live.wallpaperSchedule.mode, 'system');
    assert.strictEqual(live.autoSwitch, true);
  });

  await test('separateThemes still re-applies the wallpaper as a side effect', async (dir) => {
    seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();

    // The apply itself cannot run here (child processes are disabled), but the handler
    // must still take that branch, survive it and commit the setting.
    await m.invoke('set-config', { separateThemes: false });
    assert.strictEqual(m.__test.getConfig().separateThemes, false);
    const onDisk = JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8'));
    assert.strictEqual(onDisk.separateThemes, false, 'the setting was not persisted');
  });

  await test('a settings change still leaves the pool alone', async (dir) => {
    const { id } = seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.flushLibraryWriter();

    const before = bytes(dir).store;
    await m.invoke('set-config', { style: 'fit' });
    assert.strictEqual(m.__test.poolWritePending(), false, 'a settings change scheduled a pool write');
    assert.strictEqual(bytes(dir).store, before, 'a settings change rewrote the pool file');
    assert.ok(m.__test.getConfig().library[id], 'the pool lost its record');
  });

  // ---- regression: the keys the window must not be able to name -------------
  // RED before the fix: today every one of these succeeds.

  const FORBIDDEN = [
    ['library', { library: {} }],
    ['libraryTrash', { libraryTrash: [] }],
    ['monitors', { monitors: {} }],
    ['anonId', { anonId: 'stolen-id' }],
    ['slideshow', { slideshow: { enabled: true, intervalEnabled: true, intervalMin: 1, order: 'shuffle' } }],
    ['autostart', { autostart: true }],
    ['themeOverride', { themeOverride: 'dark' }],
    ['an unknown key', { totallyMadeUp: 1 }],
    ['hotkeys (its own channel owns it)', { hotkeys: { nextWallpaper: { enabled: false, shortcut: '' } } }],
  ];

  for (const [label, patch] of FORBIDDEN) {
    await test(`a patch naming ${label} is refused`, async (dir) => {
      seedProfile(dir);
      const m = H.loadMain(dir);
      m.__test.loadConfig();
      m.__test.flushLibraryWriter();

      const beforeLive = poolShape(m.__test.getConfig());
      const beforeBytes = bytes(dir);

      await assert.rejects(() => m.invoke('set-config', patch), REJECTED, `${label} was accepted`);

      assert.deepStrictEqual(poolShape(m.__test.getConfig()), beforeLive, `${label} changed the live state`);
      assert.strictEqual(m.__test.poolWritePending(), false, `${label} scheduled a pool write`);
      assert.deepStrictEqual(bytes(dir), beforeBytes, `${label} reached the files on disk`);
    });
  }

  await test('a mixed patch is refused whole: the allowed half does not slip through', async (dir) => {
    seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.flushLibraryWriter();

    const beforeBytes = bytes(dir);
    await assert.rejects(
      () => m.invoke('set-config', { style: 'fit', library: {} }),
      REJECTED,
      'a patch carrying both an allowed and a forbidden key was accepted',
    );

    assert.strictEqual(m.__test.getConfig().style, 'fill', 'the allowed half of a refused patch was applied');
    assert.deepStrictEqual(bytes(dir), beforeBytes, 'a refused mixed patch still wrote to disk');
  });

  await test('a badly shaped value for an allowed key is refused, not coerced', async (dir) => {
    seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();

    // A string where an object belongs used to be spread character by character.
    await assert.rejects(() => m.invoke('set-config', { triggers: 'on' }), REJECTED);
    await assert.rejects(() => m.invoke('set-config', { themeSchedule: [] }), REJECTED);
    await assert.rejects(() => m.invoke('set-config', { style: 42 }), REJECTED);
    await assert.rejects(() => m.invoke('set-config', { language: 'klingon' }), REJECTED);
    await assert.rejects(() => m.invoke('set-config', { triggers: { onStartup: 'yes' } }), REJECTED);
    // A nested object is a boundary too: an unknown field inside one must not ride in
    // on the back of a key that is allowed.
    await assert.rejects(() => m.invoke('set-config', { triggers: { madeUp: true } }), REJECTED);
    await assert.rejects(() => m.invoke('set-config', { onlinePurity: { everything: true } }), REJECTED);
    await assert.rejects(
      () => m.invoke('set-config', { triggers: { stealth: { timeoutMin: 'soon' } } }),
      REJECTED,
    );

    const live = m.__test.getConfig();
    assert.strictEqual(live.style, 'fill');
    assert.strictEqual(live.language, 'system');
    assert.strictEqual(live.triggers.onStartup, false);
  });

  await test('after a refused patch the profile survives a flush, a full save and two reloads', async (dir) => {
    const { id, goneId } = seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.flushLibraryWriter();
    const baseline = poolShape(m.__test.getConfig());

    await assert.rejects(() => m.invoke('set-config', { library: {} }), REJECTED);

    // The dangerous part was never the refusal itself: it was the next legitimate write
    // making the emptied pool permanent. So do exactly that, both ways round.
    await m.invoke('set-config', { style: 'fit' });
    m.__test.flushLibraryWriter();
    m.__test.saveConfig();
    m.__test.flushLibraryWriter();

    H.unloadMain();
    const second = H.loadMain(dir);
    second.__test.loadConfig();
    assert.deepStrictEqual(poolShape(second.__test.getConfig()), baseline, 'the pool did not survive one reload');
    assert.strictEqual(second.__test.getConfig().style, 'fit', 'the legitimate setting did not survive');

    H.unloadMain();
    const third = H.loadMain(dir);
    third.__test.loadConfig();
    const final = third.__test.getConfig();
    assert.deepStrictEqual(poolShape(final), baseline, 'the pool did not survive two reloads');
    assert.ok(final.library[id], 'the photo is gone');
    assert.strictEqual(final.library[id].favorite, true, 'the favourite flag is gone');
    assert.deepStrictEqual(final.library[id].tags, ['keep'], 'the tags are gone');
    assert.strictEqual((final.libraryTrash[0] || {}).item.id, goneId, 'the tombstone is gone');
  });

  await test('the hotkey channel of its own still works', async (dir) => {
    seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();

    // set-config refuses `hotkeys` above; that is only safe because this channel owns it.
    const res = await m.invoke('set-hotkey', { enabled: false, shortcut: '' });
    assert.strictEqual(res.ok, true, 'the dedicated hotkey channel stopped working');
    assert.deepStrictEqual(
      m.__test.getConfig().hotkeys.nextWallpaper,
      { enabled: false, shortcut: '' },
    );
  });

  await test('the allowlist and the window still name the same settings', async (dir) => {
    seedProfile(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();

    // A coverage guard, not a behaviour test. Deny-by-default is only safe while the
    // list keeps up with the window: a setting added to renderer.js and forgotten here
    // would stop working with no error anyone sees. So the real call sites are read back
    // out of the file. The call count is asserted first — a scanner that quietly matched
    // nothing would otherwise "pass" forever.
    const { keys, calls } = settingKeysUsedByRenderer();
    assert.ok(calls >= 20, `only ${calls} setConfig call sites found: the scan is broken, not the code`);

    const allowed = m.__test.settingsKeys().sort();
    assert.deepStrictEqual(
      keys.sort(), allowed,
      'renderer.js and the set-config allowlist no longer name the same settings',
    );
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
