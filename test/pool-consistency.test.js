'use strict';

// DATA-005, second half: the two files are each written atomically, but not together.
//
// Measured 2026-08-21, and the ordering turned out to be the dangerous one rather than
// a rare instant: saveConfig() writes config.json SYNCHRONOUSLY and only then schedules
// the pool write, which is debounced by 1200 ms. So after every assignment there is a
// window in which the settings on disk reference a record the pool file does not have
// yet. Lose power there and the slot points at nothing.
//
// A dangling slot is not loud. It looks filled, resolves to no path, and a resolved-to-
// nothing slot is deliberately silent — the same silence BUG-014 was about, one level
// further back.
//
// Two answers, and they are different in kind:
//   * close the window — write the pool BEFORE the settings that reference it;
//   * repair what still slips through, and say so, without ever touching a photo.
//
// Run: node test/pool-consistency.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const consistency = require('../src/pool-consistency');

let passed = 0;
const failures = [];

function ok(name, fn) {
  try {
    fn();
    console.log('  OK ' + name);
    passed++;
  } catch (err) {
    console.log('  FAIL ' + name);
    failures.push({ name, err });
  }
}

async function test(name, fn) {
  const dir = H.makeTempProfile('pool-consistency');
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

console.log('\nDATA-005: расхождение двух файлов после падения\n');

// --- the rule ----------------------------------------------------------------

ok('ссылка на существующую запись расхождением не считается', () => {
  const report = consistency.findDanglingSlots(
    { m1: { light: { itemIds: ['a'] }, dark: { itemIds: [] } } },
    { a: { id: 'a' } },
  );
  assert.strictEqual(report.length, 0);
});

ok('ссылка в никуда находится с точностью до монитора и темы', () => {
  const report = consistency.findDanglingSlots(
    { m1: { light: { itemIds: ['a', 'gone'] }, dark: { itemIds: ['also-gone'] } } },
    { a: { id: 'a' } },
  );
  assert.strictEqual(report.length, 2);
  assert.deepStrictEqual(report[0], { monitorId: 'm1', theme: 'light', itemId: 'gone' });
  assert.deepStrictEqual(report[1], { monitorId: 'm1', theme: 'dark', itemId: 'also-gone' });
});

ok('пустой слот расхождением не считается', () => {
  assert.strictEqual(consistency.findDanglingSlots({ m1: { light: { itemIds: [] } } }, {}).length, 0);
  assert.strictEqual(consistency.findDanglingSlots({ m1: {} }, {}).length, 0);
  assert.strictEqual(consistency.findDanglingSlots({}, {}).length, 0);
});

ok('ремонт убирает только мёртвую ссылку и не трогает живые', () => {
  const monitors = { m1: { light: { itemIds: ['a', 'gone', 'b'] }, dark: { itemIds: ['gone'] } } };
  const removed = consistency.repairDanglingSlots(monitors, { a: { id: 'a' }, b: { id: 'b' } });

  assert.strictEqual(removed, 2, 'the repair reported the wrong count');
  assert.deepStrictEqual(monitors.m1.light.itemIds, ['a', 'b'], 'a live reference was thrown away with the dead one');
  assert.deepStrictEqual(monitors.m1.dark.itemIds, []);
});

ok('ремонт ничего не делает, когда чинить нечего', () => {
  const monitors = { m1: { light: { itemIds: ['a'] } } };
  assert.strictEqual(consistency.repairDanglingSlots(monitors, { a: { id: 'a' } }), 0);
  assert.deepStrictEqual(monitors.m1.light.itemIds, ['a']);
});

// The single-wallpaper fallback is a PATH, not a reference into the pool. Treating it
// as one would clear a perfectly good wallpaper.
ok('старый глобальный запасной путь ремонт не трогает', () => {
  const monitors = { m1: { light: { itemIds: [] } } };
  const config = { monitors, lightWallpaper: 'C:/wall.png', library: {} };
  consistency.repairDanglingSlots(config.monitors, config.library);
  assert.strictEqual(config.lightWallpaper, 'C:/wall.png');
});

(async () => {
  // --- the path the app actually takes ---------------------------------------

  await test('висячая ссылка чинится при старте и попадает в журнал', async (dir) => {
    const photo = path.join(dir, 'kept.png');
    fs.writeFileSync(photo, 'png');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      autoSwitch: true,
      style: 'fill',
      // The pool write never landed: the settings reference a record that is nowhere.
      monitors: { m1: { light: { itemIds: ['lost'] }, dark: { itemIds: [] } } },
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'config.library.json'),
      JSON.stringify({ version: 1, library: {}, trash: [] }), 'utf8');

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    const slot = m.__test.getConfig().monitors.m1.light;
    assert.deepStrictEqual(slot.itemIds, [], 'the reference to nothing was left in place');

    const entries = m.__test.eventLogEntries().filter((e) => e.channel === 'pool-consistency');
    assert.strictEqual(entries.length, 1, 'the repair happened silently');
    assert.strictEqual(entries[0].kind, 'failure');

    assert.ok(fs.existsSync(photo), 'a photo file was touched by a repair that must never touch files');
  });

  await test('целый профиль при старте не чинится и молчит', async (dir) => {
    const photo = path.join(dir, 'a.png');
    fs.writeFileSync(photo, 'png');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      autoSwitch: true,
      style: 'fill',
      monitors: { m1: { light: { itemIds: ['a'] }, dark: { itemIds: [] } } },
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'config.library.json'), JSON.stringify({
      version: 1,
      library: { a: { id: 'a', type: 'image', path: photo, tags: [] } },
      trash: [],
    }), 'utf8');

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    assert.deepStrictEqual(m.__test.getConfig().monitors.m1.light.itemIds, ['a'],
      'a sound profile was "repaired"');
    assert.strictEqual(
      m.__test.eventLogEntries().filter((e) => e.channel === 'pool-consistency').length, 0,
      'a sound profile was reported as broken',
    );
  });

  // --- closing the window rather than repairing after it ---------------------

  // The repair above is the safety net. This is the fix: by the time the settings
  // naming a record are on disk, the record is on disk too.
  await test('запись пула ложится на диск ДО настроек, которые на неё ссылаются', async (dir) => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      autoSwitch: true, style: 'fill', monitors: {},
    }), 'utf8');

    const m = H.loadMain(dir);
    m.__test.loadConfig();

    const photo = path.join(dir, 'new.png');
    fs.writeFileSync(photo, 'png');
    const id = m.__test.addToPool('image', photo, {});
    assert.ok(id, 'precondition: the photo went into the pool');

    m.__test.saveConfig();

    // No flush, no waiting: this is the state a power cut would freeze.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8'));
    assert.ok(onDisk.library[id],
      'settings were written while the record they name was still only in memory');
  });

  if (failures.length) {
    console.log('\n' + failures.length + ' FAILED, ' + passed + ' passed\n');
    for (const f of failures) {
      console.log('FAILED: ' + f.name);
      console.log(String(f.err && f.err.stack ? f.err.stack : f.err));
      if (f.captured && f.captured.length) console.log('  main.js said:\n    ' + f.captured.join('\n    '));
    }
    process.exit(1);
  }
  console.log('\nAll ' + passed + ' pool-consistency tests passed.');
})();
