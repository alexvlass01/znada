'use strict';

// LIB-012. «Убрать из библиотеки» стоит вплотную к похожему действию в двух местах:
// в меню карточки — рядом с «Убрать из слота» (`DESIGN-004` поставил их подряд), во
// всплывающем окне — прямо под полем ввода тега (`BUG-038` свёл их вместе). Решение
// владельца 2026-09-03: в таких местах спрашивать подтверждение.
//
// Что здесь важно не перепутать. Подтверждение — свойство ПОВЕРХНОСТИ, а не операции:
// массовая кнопка, онлайн-карточка и просмотрщик такого соседства не имеют и спрашивать
// не должны. Поэтому признак приходит снаружи, и проверяется в обе стороны — что
// спрашивают там, где надо, и что молчат там, где не надо.
//
// И отдельно: «Убрать из слота» подтверждения не требует. Оно обратимо и к библиотеке
// не относится; если бы диалог появился и на нём, задача сделала бы ровно то, от чего
// защищала — приучила бы нажимать «Да» не глядя.
//
// Run: node test/remove-confirm.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = H.makeTempProfile('confirm');
  const real = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    await fn(dir);
    console.log = real.log; console.error = real.error;
    console.log('  OK ' + name);
    passed += 1;
  } catch (e) {
    console.log = real.log; console.error = real.error;
    failures.push({ name, e });
    console.log('  FAIL ' + name + '\n    ' + (e && e.message));
  } finally {
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function ok(name, fn) {
  try { fn(); console.log('  OK ' + name); passed += 1; }
  catch (e) { failures.push({ name, e }); console.log('  FAIL ' + name + '\n    ' + (e && e.message)); }
}

const cfgFile = (dir) => path.join(dir, 'config.json');
const storeFile = (dir) => path.join(dir, 'config.library.json');

function seed(dir) {
  const photo = H.writeImage(path.join(dir, 'photos', 'keep-me.png'));
  const id = library.idFor(photo);
  H.writeJson(cfgFile(dir), { autoSwitch: true, style: 'fill', monitors: {} });
  H.writeJson(storeFile(dir), {
    version: 1,
    library: { [id]: { id, path: photo, type: 'image', rev: 1, addedAt: 1 } },
    trash: [],
  });
  return { photo, id };
}

const rendererSrc = fs.readFileSync(path.join(H.ROOT, 'renderer', 'renderer.js'), 'utf8')
  .split('\r\n').join('\n');

console.log('\nLIB-012: подтверждение там, где пункт легко спутать с соседним\n');

(async () => {
  // ---- сторона main ----

  await test('отказ в диалоге не меняет ничего', async (dir) => {
    const { photo, id } = seed(dir);
    // 1 — это «Отмена»: у диалога defaultId и cancelId равны 1.
    const m = H.loadMain(dir, { onDialog: async () => 1 });
    m.__test.loadConfig();
    const before = JSON.stringify(m.__test.getConfig().library);

    const res = await m.invoke('library-remove-many',
      [{ id, path: photo, type: 'image' }], { confirm: true });

    assert.strictEqual(res.cancelled, true, 'отказ не отмечен в ответе');
    assert.strictEqual(res.error, null, 'отказ выдан за ошибку');
    assert.strictEqual(res.removed, 0, 'при отказе что-то всё же удалили');
    assert.strictEqual(res.undo, null, 'при отказе предложена отмена того, чего не было');
    assert.strictEqual(JSON.stringify(m.__test.getConfig().library), before,
      'библиотека изменилась, хотя человек отказался');
    assert.ok(fs.existsSync(photo), 'файл тронут при отказе');
    assert.strictEqual(m.calls.dialogs.length, 1, 'диалог не был показан вовсе');
  });

  await test('согласие в диалоге удаляет, как обычно', async (dir) => {
    const { photo, id } = seed(dir);
    const m = H.loadMain(dir, { onDialog: async () => 0 }); // 0 — «Убрать»
    m.__test.loadConfig();

    const res = await m.invoke('library-remove-many',
      [{ id, path: photo, type: 'image' }], { confirm: true });

    assert.ok(!res.cancelled, 'согласие принято за отказ');
    assert.strictEqual(res.error, null, 'удаление не прошло');
    assert.strictEqual(res.removed, 1, 'после согласия ничего не удалено');
    assert.ok(!m.__test.getConfig().library[id], 'запись осталась в библиотеке');
    assert.strictEqual(m.calls.dialogs.length, 1, 'диалог не был показан');
  });

  await test('без признака от поверхности диалога нет вовсе', async (dir) => {
    const { photo, id } = seed(dir);
    // Если бы диалог был свойством операции, он появился бы и здесь — и массовая кнопка,
    // просмотрщик и онлайн-карточка начали бы спрашивать, чего задача не просила.
    const m = H.loadMain(dir, { onDialog: async () => 1 });
    m.__test.loadConfig();

    const res = await m.invoke('library-remove-many', [{ id, path: photo, type: 'image' }]);

    assert.strictEqual(m.calls.dialogs.length, 0,
      'подтверждение спросили там, где поверхность о нём не просила');
    assert.strictEqual(res.removed, 1, 'обычное удаление перестало работать');
  });

  await test('вопрос называет то, что убирают, и по умолчанию выбрана отмена', async (dir) => {
    const { photo, id } = seed(dir);
    const m = H.loadMain(dir, { onDialog: async () => 1 });
    m.__test.loadConfig();
    await m.invoke('library-remove-many', [{ id, path: photo, type: 'image' }], { confirm: true });

    const shown = m.calls.dialogs[0];
    assert.ok(shown, 'диалог не показан');
    assert.strictEqual(shown.defaultId, 1, 'по умолчанию выбрано удаление, а не отмена');
    assert.strictEqual(shown.cancelId, 1, 'закрытие окна крестиком удалит запись');
    assert.ok(String(shown.detail).includes(path.basename(photo)),
      'вопрос не называет, что именно убирают: ' + shown.detail);
  });

  // ---- сторона окна: кто просит подтверждение, а кто нет ----

  ok('обе спорные поверхности идут через один путь, и он просит подтверждение', () => {
    // Меню карточки и всплывающее окно зовут одну и ту же функцию — значит признак
    // ставится один раз и не может разъехаться между ними.
    assert.ok(rendererSrc.includes('libraryRemoveMany(payload, { confirm: true })'),
      'путь одиночного удаления перестал просить подтверждение');
    const calls = rendererSrc.split('removeRecordFromLibrary(').length - 1;
    assert.ok(calls >= 3,
      'меню карточки и всплывающее окно больше не ходят через общую функцию (' + calls + ')');
  });

  ok('массовое удаление подтверждения не просит', () => {
    assert.ok(rendererSrc.includes('libraryRemoveMany(records)'),
      'массовая кнопка начала спрашивать подтверждение, чего задача не просила');
  });

  ok('«Убрать из слота» подтверждения не просит', () => {
    // Оно обратимо и библиотеки не касается. Диалог на нём приучил бы жать «Да» не глядя —
    // ровно то, от чего LIB-012 защищает.
    const branch = rendererSrc.match(/removeFromSlot: \(\) => \(subject\.slot[\s\S]{0,160}?\),/);
    assert.ok(branch, 'обработчик «Убрать из слота» в меню карточки не найден');
    assert.ok(!/confirm/.test(branch[0]),
      '«Убрать из слота» стало спрашивать подтверждение: ' + branch[0]);
    assert.ok(/takeOutOfSlot/.test(branch[0]),
      '«Убрать из слота» больше не ведёт в takeOutOfSlot');
  });

  if (failures.length) {
    console.log('\n' + failures.length + ' test(s) failed.');
    for (const f of failures) console.log('\n--- ' + f.name + ' ---\n' + (f.e && f.e.stack));
    process.exit(1);
  }
  console.log('\nAll ' + passed + ' remove-confirm tests passed.');
})();
