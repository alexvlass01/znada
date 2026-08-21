'use strict';

// BUG-014: a wallpaper whose source went away must not disappear quietly.
//
// A slot the user emptied and a slot whose photos sit on an unplugged disk both used
// to end as 'no-wallpaper', and 'no-wallpaper' is deliberately silent — so a vanished
// source produced nothing at all: no notification, no line in the journal.
//
// These run the REAL main.js over a real temp profile. That a pure rule classifies
// correctly proves nothing on its own; what matters is that main calls it, that the
// outcome reaches the channel that owns it, and that a slot emptied on purpose still
// says nothing.
//
// Run: node test/wallpaper-source-missing.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const applyOutcome = require('../src/apply-outcome');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = H.makeTempProfile('wallpaper-source');
  const captured = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = (...a) => captured.push(a.join(' '));
  console.log = () => {};
  try {
    await fn(dir);
    console.log = realLog; console.error = realError;
    console.log('  OK ' + name);
    passed++;
  } catch (err) {
    console.log = realLog; console.error = realError;
    console.log('  FAIL ' + name);
    failures.push({ name, err, captured });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function writeProfile(dir, config) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

// The journal keeps newest first — the order the settings page shows it in. Asserting
// on [0] rather than [length - 1] is the difference between reading the event that just
// happened and the one that happened first.
function sourceEntries(m) {
  return m.__test.eventLogEntries().filter((e) => e.channel === 'wallpaper-source');
}

(async () => {
  console.log('\nBUG-014: пропавший источник обоев\n');

  await test('пустой слот и пропавший источник — РАЗНЫЕ поводы', async () => {
    const empty = applyOutcome.classifyApplyTargets([{ id: 'a', path: '', exists: false }]);
    assert.strictEqual(empty.reason, 'no-wallpaper');
    assert.strictEqual(empty.hasMissing, false);

    const gone = applyOutcome.classifyApplyTargets([{ id: 'a', path: 'C:/gone.png', exists: false }]);
    assert.strictEqual(gone.reason, 'wallpaper-missing', 'a vanished source read as an empty slot');
    assert.deepStrictEqual(gone.missingPaths, ['C:/gone.png']);
  });

  await test('частичная пропажа: применили что смогли, но молчать нельзя', async () => {
    const mixed = applyOutcome.classifyApplyTargets([
      { id: 'a', path: 'C:/ok.png', exists: true },
      { id: 'b', path: 'C:/gone.png', exists: false },
    ]);
    assert.strictEqual(mixed.applied.length, 1, 'the usable monitor was dropped');
    assert.strictEqual(mixed.reason, '', 'a partly successful apply must not be called a failure');
    assert.strictEqual(mixed.hasMissing, true, 'one broken source among two monitors went unreported');
    assert.deepStrictEqual(mixed.missingPaths, ['C:/gone.png']);
  });

  await test('ничего не настроено вовсе — это состояние, а не поломка', async () => {
    const none = applyOutcome.classifyApplyTargets([]);
    assert.strictEqual(none.reason, 'no-wallpaper');
    assert.strictEqual(none.hasMissing, false);
  });

  await test('исчезнувший файл: главный процесс сообщает в журнал', async (dir) => {
    const gone = path.join(dir, 'unplugged-disk', 'photo.png');
    writeProfile(dir, {
      autoSwitch: true, style: 'fill', monitors: {}, library: {},
      separateThemes: false, lightWallpaper: gone, darkWallpaper: gone,
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setMonitorsCache([]);
    const result = await m.__test.applyForTheme('light', false);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'wallpaper-missing', 'reported as ' + result.reason);
    assert.deepStrictEqual(result.missing, [gone]);

    const entries = sourceEntries(m);
    assert.strictEqual(entries.length, 1, 'exactly one journal line was expected');
    assert.strictEqual(entries[0].kind, 'failure');

    // ONE event, not two. The channel that owns this must be the only one to speak:
    // if the generic apply channel reports it as well, the user gets two notifications
    // for a single unplugged disk, and the checklist asks for exactly one.
    const auto = m.__test.eventLogEntries().filter((e) => e.channel === 'wallpaper-auto');
    assert.strictEqual(auto.length, 0, 'the same breakage was reported twice, on two channels');
  });

  await test('повторный сбой молчит, возврат файла даёт «снова работает»', async (dir) => {
    const wall = path.join(dir, 'wall.png');
    writeProfile(dir, {
      autoSwitch: true, style: 'fill', monitors: {}, library: {},
      separateThemes: false, lightWallpaper: wall, darkWallpaper: wall,
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setMonitorsCache([]);

    await m.__test.applyForTheme('light', false);
    await m.__test.applyForTheme('light', false);
    assert.strictEqual(sourceEntries(m).length, 1, 'a repeat of the same breakage spoke twice');

    fs.writeFileSync(wall, 'png', 'utf8');
    await m.__test.applyForTheme('light', false);

    const entries = sourceEntries(m);
    assert.strictEqual(entries.length, 2, 'the return of the file was not recorded');
    assert.strictEqual(entries[0].kind, 'recovered', 'newest first: the latest event is the recovery');
  });

  await test('слот, опустошённый пользователем, по-прежнему молчит', async (dir) => {
    writeProfile(dir, {
      autoSwitch: true, style: 'fill', monitors: {}, library: {},
      separateThemes: false, lightWallpaper: '', darkWallpaper: '',
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.setMonitorsCache([]);
    const result = await m.__test.applyForTheme('light', false);

    assert.strictEqual(result.reason, 'no-wallpaper');
    assert.strictEqual(sourceEntries(m).length, 0, 'an empty slot was reported as a breakage');
  });

  await test('пропавшая живая папка попадает в журнал при скрытом окне', async (dir) => {
    const folder = path.join(dir, 'live');
    fs.mkdirSync(folder, { recursive: true });
    writeProfile(dir, {
      autoSwitch: true, style: 'fill', monitors: {},
      library: { f1: { id: 'f1', type: 'folder', path: folder, tags: [], addedAt: 1 } },
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    const live = () => m.__test.eventLogEntries().filter((e) => e.channel === 'live-folder:f1');

    m.__test.checkLiveFolderReachability();
    assert.strictEqual(live().length, 0, 'a folder that is present was reported as broken');

    fs.rmSync(folder, { recursive: true, force: true });
    m.__test.checkLiveFolderReachability();
    assert.strictEqual(live().length, 1, 'a folder that vanished while the window was hidden stayed silent');
    assert.strictEqual(live()[0].kind, 'failure');

    fs.mkdirSync(folder, { recursive: true });
    m.__test.checkLiveFolderReachability();
    assert.strictEqual(live().length, 2, 'the folder coming back was not recorded');
    assert.strictEqual(live()[0].kind, 'recovered', 'newest first: the latest event is the recovery');
  });

  // The one above proves the check works. This one proves the hourly pass CALLS it with
  // the window hidden — which is the whole defect. Testing the helper instead of the
  // path that reaches it is how the first version of this fix passed while the app
  // stayed silent.
  await test('плановый обход зовёт проверку, даже когда окно скрыто', async (dir) => {
    const folder = path.join(dir, 'live');
    fs.mkdirSync(folder, { recursive: true });
    writeProfile(dir, {
      autoSwitch: true, style: 'fill', monitors: {},
      library: { f2: { id: 'f2', type: 'folder', path: folder, tags: [], addedAt: 1 } },
    });

    const m = H.loadMain(dir);
    m.__test.loadConfig();
    assert.strictEqual(m.__test.windowVisibleForLiveFolders(), false,
      'this test is meaningless unless the window counts as hidden');

    fs.rmSync(folder, { recursive: true, force: true });
    m.__test.runHourlyLiveFolderPass();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const live = m.__test.eventLogEntries().filter((e) => e.channel === 'live-folder:f2');
    assert.strictEqual(live.length, 1,
      'the hourly pass returned without looking, exactly as it did in the tray');
    assert.strictEqual(live[0].kind, 'failure');
  });

  if (failures.length) {
    console.log('\n' + failures.length + ' FAILED, ' + passed + ' passed\n');
    for (const f of failures) {
      console.log('FAILED: ' + f.name);
      console.log(String(f.err && f.err.stack ? f.err.stack : f.err));
      if (f.captured.length) console.log('  main.js said:\n    ' + f.captured.join('\n    '));
    }
    process.exit(1);
  }
  console.log('\nAll ' + passed + ' wallpaper-source tests passed.');
})();
