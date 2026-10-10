'use strict';

// LIB-018, решение владельца 2026-10-01. Одиночное удаление спрашивает только
// в меню, где действительно показано «Убрать из слота». Обычная карточка и окно
// назначения не спрашивают. Исполняем настоящие функции renderer и main вместе:
// проверяем отмену, корзину, Undo и сохранность файла, а не только текст вызова.
//
// Что здесь важно не перепутать. Подтверждение — свойство ПОВЕРХНОСТИ, а не операции:
// онлайн-карточка и просмотрщик такого соседства не имеют и не спрашивают. LIB-020
// добавляет отдельное правило для массовой кнопки (от двух выбранных карточек),
// исполняемое в bulk-selection-confirm.test.js. Признак приходит от поверхности.
//
// И отдельно: «Убрать из слота» подтверждения не требует. Оно обратимо и к библиотеке
// не относится; если бы диалог появился и на нём, задача сделала бы ровно то, от чего
// защищала — приучила бы нажимать «Да» не глядя.
//
// Run: node test/remove-confirm.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const CardActions = require('../renderer/card-actions');
const CardInteraction = require('../renderer/card-interaction');

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

function rendererFunction(name) {
  const start = rendererSrc.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `missing renderer function ${name}`);
  const end = rendererSrc.indexOf('\n}', start);
  assert.ok(end >= 0, `unterminated renderer function ${name}`);
  return rendererSrc.slice(start, end + 2);
}

function rendererFor(m) {
  const calls = { redraws: 0, toasts: [], removed: [], slot: [], requests: [] };
  const elements = [];
  const element = () => {
    const node = {
      children: [], style: {}, events: {}, offsetWidth: 200, offsetHeight: 200,
      appendChild(child) { this.children.push(child); },
      setAttribute() {},
      addEventListener(name, fn) { this.events[name] = fn; },
      querySelector() { return null; },
    };
    elements.push(node);
    return node;
  };
  const context = vm.createContext({
    config: m.__test.getConfig(),
    CardActions, FEATURES: { physicalDelete: false },
    window: {
      innerHeight: 800, CardInteraction,
      MotionBadge: { marksMotion: () => false },
      api: { libraryRemoveMany(records, options) {
        calls.requests.push({ records: JSON.parse(JSON.stringify(records)), options });
        calls.pending = m.invoke('library-remove-many', records, options);
        return calls.pending;
      } },
    },
    document: { createElement: element, body: { appendChild() {} } },
    CardMenu: { openMenu(options) { calls.menu = options; } },
    LIB: { selection: new Map() },
    normPathKey: (p) => String(p || '').replace(/\\/g, '/').toLowerCase(),
    t: (key) => key,
    closeLibPopup() {}, armLibPopupDismiss() {}, requestAnimationFrame() {},
    appendAssignRows() {}, appendApplyNowToggle: () => ({}), appendTagEditor: () => ({}),
    syncSelectionUI() {},
    renderLibrary() { calls.redraws++; }, renderPreviews() {}, renderHome() {},
    toast(message) { calls.toasts.push(message); },
    toastRemoved(...args) { calls.removed.push(args); },
    takeOutOfSlot(...args) { calls.slot.push(args); },
    async removeOnlineFromLibrary() { calls.online = true; },
  });
  vm.runInContext([
    'localSelectionRecord', 'poolItemForRecord', 'removeRecordFromLibrary',
    'openCardMenu', 'openAssignMenu',
  ].map(rendererFunction).join('\n'), context);
  return { context, calls, elements, async pick(action) {
    calls.menu.onPick({ id: action });
    if (calls.pending) await calls.pending;
    await Promise.resolve();
  } };
}

console.log('\nLIB-018: вопрос только рядом с «Убрать из слота»\n');

(async () => {
  // ---- сторона main ----

  await test('отказ в диалоге не меняет ничего', async (dir) => {
    const { photo, id } = seed(dir);
    // LIB-019: ответ главного окна проходит через настоящий main-only IPC.
    const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => false });
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
    assert.strictEqual(m.calls.removalQuestions.length, 1, 'вопрос не был показан вовсе');
    assert.strictEqual(m.calls.dialogs.length, 0, 'остался системный вопрос');
  });

  await test('согласие в диалоге удаляет, как обычно', async (dir) => {
    const { photo, id } = seed(dir);
    const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => true });
    m.__test.loadConfig();

    const res = await m.invoke('library-remove-many',
      [{ id, path: photo, type: 'image' }], { confirm: true });

    assert.ok(!res.cancelled, 'согласие принято за отказ');
    assert.strictEqual(res.error, null, 'удаление не прошло');
    assert.strictEqual(res.removed, 1, 'после согласия ничего не удалено');
    assert.ok(!m.__test.getConfig().library[id], 'запись осталась в библиотеке');
    assert.strictEqual(m.calls.removalQuestions.length, 1, 'вопрос не был показан');
    assert.strictEqual(m.calls.dialogs.length, 0, 'остался системный вопрос');
  });

  await test('без признака от поверхности диалога нет вовсе', async (dir) => {
    const { photo, id } = seed(dir);
    // Если бы диалог был свойством операции, он появился бы и здесь — и одно выделенное,
    // просмотрщик и онлайн-карточка начали бы спрашивать, чего задача не просила.
    const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => false });
    m.__test.loadConfig();

    const res = await m.invoke('library-remove-many', [{ id, path: photo, type: 'image' }]);

    assert.strictEqual(m.calls.removalQuestions.length, 0,
      'подтверждение спросили там, где поверхность о нём не просила');
    assert.strictEqual(m.calls.dialogs.length, 0, 'появился системный вопрос');
    assert.strictEqual(res.removed, 1, 'обычное удаление перестало работать');
  });

  await test('вопрос называет то, что убирают, и отказ оставляет запись', async (dir) => {
    const { photo, id } = seed(dir);
    const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => false });
    m.__test.loadConfig();
    const res = await m.invoke('library-remove-many', [{ id, path: photo, type: 'image' }], { confirm: true });

    const shown = m.calls.removalQuestions[0];
    assert.ok(shown, 'вопрос не показан');
    assert.deepStrictEqual(shown.names, [{ name: path.basename(photo), type: 'image' }],
      'вопрос не называет, что именно убирают');
    assert.strictEqual(shown.count, 1, 'число объектов неверно');
    assert.strictEqual(shown.more, 0, 'одному объекту добавлен остаток списка');
    assert.strictEqual(res.cancelled, true, 'отказ не принят');
    assert.ok(m.__test.getConfig().library[id], 'отказ убрал запись');
    // Начальный фокус/Enter/× исполняются renderer-тестами library-removal-dialog,
    // а не проверкой полей прежнего Electron MessageBox (defaultId/cancelId).
  });

  // ---- сторона окна: кто просит подтверждение, а кто нет ----

  await test('обычная карточка удаляется без вопроса, остаётся в корзине и возвращается через Undo', async (dir) => {
    const { photo, id } = seed(dir);
    const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => false });
    m.__test.loadConfig();
    const r = rendererFor(m);
    const item = m.__test.getConfig().library[id];
    r.context.openCardMenu(CardActions.localSubject(item, item), {});
    assert.ok(!r.calls.menu.groups.flat().some((a) => a.id === 'removeFromSlot'));
    await r.pick('remove');
    assert.strictEqual(m.calls.dialogs.length, 0, 'обычная карточка всё ещё спрашивает');
    assert.strictEqual(m.calls.removalQuestions.length, 0, 'обычная карточка открыла новый вопрос');
    assert.ok(!m.__test.getConfig().library[id], 'карточка не удалена');
    assert.ok(m.__test.getConfig().libraryTrash.some((entry) => entry.item.id === id), 'нет записи корзины');
    assert.ok(fs.existsSync(photo), 'оригинал стёрт с диска');
    assert.strictEqual(r.calls.redraws, 1);
    assert.strictEqual(r.calls.removed[0][0], 1);
    const undo = await m.invoke('library-undo-remove', r.calls.removed[0][1]);
    assert.strictEqual(undo.error, null);
    assert.ok(m.__test.getConfig().library[id], 'Undo не вернула карточку');
    assert.ok(fs.existsSync(photo), 'Undo потеряла оригинал');
  });

  await test('рядом с «Убрать из слота» отказ оставляет библиотеку, выделение и окно без уведомлений', async (dir) => {
    const { photo, id } = seed(dir);
    const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => false });
    m.__test.loadConfig();
    const r = rendererFor(m);
    const item = m.__test.getConfig().library[id];
    const subject = CardActions.localSubject({ ...item,
      slot: { monitorId: 'MON-1', theme: 'light', itemId: id, index: 0 } }, item);
    const record = r.context.localSelectionRecord(photo, 'image', id);
    r.context.LIB.selection.set(record.key, record);
    r.context.openCardMenu(subject, {});
    assert.ok(r.calls.menu.groups.flat().some((a) => a.id === 'removeFromSlot'));
    await r.pick('remove');
    assert.strictEqual(m.calls.removalQuestions.length, 1);
    assert.strictEqual(m.calls.dialogs.length, 0, 'остался системный вопрос');
    assert.ok(m.__test.getConfig().library[id]);
    assert.strictEqual(r.context.LIB.selection.size, 1);
    assert.strictEqual(r.calls.redraws, 0);
    assert.strictEqual(r.calls.toasts.length + r.calls.removed.length, 0);
    assert.ok(fs.existsSync(photo));
  });

  await test('согласие из меню слота сохраняет обычное удаление и Undo', async (dir) => {
    const { photo, id } = seed(dir);
    const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => true });
    m.__test.loadConfig();
    const r = rendererFor(m);
    const item = m.__test.getConfig().library[id];
    r.context.openCardMenu(CardActions.localSubject({ ...item,
      slot: { monitorId: 'MON-1', theme: 'light', itemId: id, index: 0 } }, item), {});
    await r.pick('remove');
    assert.strictEqual(m.calls.removalQuestions.length, 1);
    assert.strictEqual(m.calls.dialogs.length, 0, 'остался системный вопрос');
    assert.ok(!m.__test.getConfig().library[id]);
    assert.ok(r.calls.removed[0][1], 'нет токена Undo');
    assert.ok(fs.existsSync(photo));
  });

  await test('наличие slot в предмете не требует вопроса, если его пункт не показан', async (dir) => {
    const { id } = seed(dir);
    const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => false });
    m.__test.loadConfig();
    const r = rendererFor(m);
    // Use the real registry but hide this one action: proof that the rule concerns
    // the displayed menu, rather than a field that only usually means the same thing.
    r.context.CardActions = { ...CardActions, menuGroupsFor: (...args) => CardActions.menuGroupsFor(...args)
      .map((group) => group.filter((a) => a.id !== 'removeFromSlot')).filter((group) => group.length) };
    const item = m.__test.getConfig().library[id];
    r.context.openCardMenu(CardActions.localSubject({ ...item,
      slot: { monitorId: 'MON-1', theme: 'light', itemId: id, index: 0 } }, item), {});
    await r.pick('remove');
    assert.strictEqual(m.calls.dialogs.length, 0);
    assert.strictEqual(m.calls.removalQuestions.length, 0);
    assert.ok(!m.__test.getConfig().library[id]);
  });

  for (const type of ['image', 'folder']) {
    await test(`красная кнопка окна назначения (${type}) не спрашивает и сохраняет файл/папку`, async (dir) => {
      const { photo, id } = seed(dir);
      let item = { id, path: photo, type: 'image', rev: 1, addedAt: 1 };
      if (type === 'folder') {
        const folder = path.dirname(photo);
        item = { id: library.idFor(folder), path: folder, type: 'folder', rev: 1, addedAt: 1 };
        H.writeJson(storeFile(dir), { version: 1, library: { [item.id]: item }, trash: [] });
      }
      const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => false });
      m.__test.loadConfig();
      const r = rendererFor(m);
      r.context.openAssignMenu(item, { getBoundingClientRect: () => ({ right: 600, bottom: 200 }) });
      const button = r.elements.find((node) => node.className === 'lib-popup-btn danger');
      assert.ok(button, 'красная кнопка назначения пропала');
      await button.events.click({ stopPropagation() {} });
      assert.strictEqual(m.calls.dialogs.length, 0, 'кнопка назначения всё ещё спрашивает');
      assert.strictEqual(m.calls.removalQuestions.length, 0, 'кнопка назначения открыла новый вопрос');
      assert.ok(!m.__test.getConfig().library[item.id]);
      assert.ok(fs.existsSync(photo), 'файл папки/оригинал стёрт с диска');
      assert.ok(r.calls.removed[0][1]);
    });
  }

  await test('«Убрать из слота» не зовёт библиотеку или вопрос', async (dir) => {
    const { id } = seed(dir);
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    const r = rendererFor(m);
    const item = m.__test.getConfig().library[id];
    r.context.openCardMenu(CardActions.localSubject({ ...item,
      slot: { monitorId: 'MON-1', theme: 'light', itemId: id, index: 0 } }, item), {});
    await r.pick('removeFromSlot');
    assert.strictEqual(r.calls.slot.length, 1);
    assert.strictEqual(r.calls.requests.length, 0);
    assert.strictEqual(m.calls.dialogs.length, 0);
    assert.ok(m.__test.getConfig().library[id]);
  });

  // The former source guard forbidding bulk confirmation is superseded by
  // executable threshold/cancel/Undo scenarios in bulk-selection-confirm.test.js.

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
