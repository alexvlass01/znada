'use strict';

// Перенос профиля Lumina → Znada.
//
// Цена ошибки здесь максимальная: это единственная копия библиотеки владельца.
// Поэтому проверяется не «функция что-то вернула», а конкретные инварианты:
// внутренние пути переехали, ВНЕШНИЕ не тронуты, опознаватели пересчитаны
// согласованно во всех местах сразу, а неоднозначность приводит к отказу,
// а не к тихому схлопыванию записей.
//
// Run: node test/profile-migration.test.js

const assert = require('assert');
const library = require('../src/library');
const { remapProfile, movedPath } = require('../src/profile-migration');

let passed = 0;
const ok = (name, fn) => { fn(); console.log('  ✓ ' + name); passed++; };

const OLD = 'C:\\Users\\u\\AppData\\Roaming\\lumina';
const NEW = 'C:\\Users\\u\\AppData\\Roaming\\znada';
const oldWp = (f) => `${OLD}\\wallpapers\\${f}`;
const newWp = (f) => `${NEW}\\wallpapers\\${f}`;
const EXTERNAL = 'D:\\Photos\\holiday\\a.jpg';
const EXTERNAL_DIR = 'D:\\Photos\\holiday';

function item(p, extra = {}) {
  return { id: library.idFor(p), type: 'image', path: p, addedAt: 1, favorite: false, tags: [], ...extra };
}

function profile(over = {}) {
  const own = item(oldWp('wp-1.png'));
  const ext = item(EXTERNAL);
  const folder = item(EXTERNAL_DIR, { type: 'folder' });
  return {
    oldRoot: OLD,
    newRoot: NEW,
    config: {
      monitors: { MON1: { light: { itemIds: [own.id, ext.id] }, dark: { itemIds: [folder.id] } } },
      lightWallpaper: oldWp('wp-1.png'),
      darkWallpaper: EXTERNAL,
      slideshowCurrentPath: { MON1: { light: oldWp('wp-1.png'), dark: EXTERNAL } },
      ...over.config,
    },
    store: {
      version: 1,
      library: { [own.id]: own, [ext.id]: ext, [folder.id]: folder },
      trash: [],
      ...over.store,
    },
    folderState: { version: 4, folders: {}, ...over.folderState },
  };
}

// ---- что переезжает, а что нет ---------------------------------------------

ok('картинка внутри профиля получает новый путь и новый опознаватель', () => {
  const p = profile();
  const before = library.idFor(oldWp('wp-1.png'));
  const { store } = remapProfile(p);
  const after = library.idFor(newWp('wp-1.png'));
  assert.ok(!store.library[before], 'старая запись осталась в пуле');
  assert.ok(store.library[after], 'новой записи нет в пуле');
  assert.strictEqual(store.library[after].path, newWp('wp-1.png'));
  assert.strictEqual(store.library[after].id, after, 'id внутри записи не совпал с ключом');
});

ok('extended-length путь \\\\?\\ remap-ится без ложного ?\\C: внутри назначения', () => {
  const extended = `\\\\?\\${oldWp('long.png')}`;
  assert.strictEqual(movedPath(extended, OLD, NEW), newWp('long.png'));
});

ok('файл ВНЕ профиля не трогается вообще', () => {
  const { store } = remapProfile(profile());
  const id = library.idFor(EXTERNAL);
  assert.ok(store.library[id], 'внешняя запись пропала');
  assert.strictEqual(store.library[id].path, EXTERNAL, 'внешний путь переписан');
});

ok('отслеживаемая папка пользователя остаётся на месте', () => {
  const { store } = remapProfile(profile());
  const id = library.idFor(EXTERNAL_DIR);
  assert.strictEqual(store.library[id].path, EXTERNAL_DIR);
});

ok('папка с похожим именем не считается частью папки обоев', () => {
  // Ловушка префикса: `…\wallpapers2` НЕ лежит внутри `…\wallpapers`.
  // Если бы сравнение шло строкой, этот файл уехал бы вместе с обоями и получил
  // бы неверный путь. Здесь он остаётся внутри старого профиля — и перенос
  // обязан на этом честно остановиться, потому что такой файл переехать не может,
  // а старый профиль потом удаляют.
  const p = profile();
  const it = item(`${OLD}\\wallpapers2\\x.png`);
  p.store.library[it.id] = it;
  assert.throws(() => remapProfile(p), /вне папки обоев/);
});

ok('одноимённая папка ВНЕ профиля переносу не мешает', () => {
  const near = 'D:\\wallpapers\\x.png';
  const p = profile();
  const it = item(near);
  p.store.library[it.id] = it;
  const { store } = remapProfile(p);
  assert.strictEqual(store.library[it.id].path, near, 'внешняя папка с тем же именем уехала зря');
});

// ---- согласованность ссылок ------------------------------------------------

ok('слоты монитора начинают ссылаться на новые опознаватели', () => {
  const { config, store } = remapProfile(profile());
  const ids = config.monitors.MON1.light.itemIds;
  assert.strictEqual(ids.length, 2);
  for (const id of ids) assert.ok(store.library[id], `слот ссылается на несуществующую запись ${id}`);
  assert.ok(ids.includes(library.idFor(newWp('wp-1.png'))), 'в слоте нет перенесённой картинки');
  assert.ok(ids.includes(library.idFor(EXTERNAL)), 'в слоте пропала внешняя картинка');
});

ok('запасные обои и позиция слайд-шоу переписаны согласованно', () => {
  const { config } = remapProfile(profile());
  assert.strictEqual(config.lightWallpaper, newWp('wp-1.png'));
  assert.strictEqual(config.darkWallpaper, EXTERNAL, 'внешние обои переписаны зря');
  assert.strictEqual(config.slideshowCurrentPath.MON1.light, newWp('wp-1.png'));
  assert.strictEqual(config.slideshowCurrentPath.MON1.dark, EXTERNAL);
});

ok('корзина переезжает вместе с путём, опознавателем и пометкой «ушло с папкой»', () => {
  const removed = item(oldWp('wp-9.png'));
  const p = profile();
  p.store.trash = [{ item: removed, removedAt: 100, via: oldWp('sub'), group: 'g1' }];
  const { store } = remapProfile(p);
  const entry = store.trash[0];
  assert.strictEqual(entry.item.path, newWp('wp-9.png'));
  assert.strictEqual(entry.item.id, library.idFor(newWp('wp-9.png')));
  assert.strictEqual(entry.via, newWp('sub'), 'via остался на старом профиле — возврат родителя не найдёт детей');
  assert.strictEqual(entry.group, 'g1', 'потеряна привязка к одному удалению');
  assert.strictEqual(entry.removedAt, 100);
});

ok('индекс отслеживаемых папок переезжает только для папок внутри профиля', () => {
  const inside = `${OLD}\\wallpapers\\album`;
  const p = profile({
    folderState: {
      folders: {
        [library.idFor(inside)]: {
          rootPath: inside,
          files: { 'a.png': { relativePath: 'a.png', firstSeenAt: 1, modifiedAt: 1 } },
          baselineComplete: true,
        },
        [library.idFor(EXTERNAL_DIR)]: { rootPath: EXTERNAL_DIR, files: {}, baselineComplete: true },
      },
    },
  });
  const { folderState, report } = remapProfile(p);
  const movedId = library.idFor(`${NEW}\\wallpapers\\album`);
  assert.ok(folderState.folders[movedId], 'папка внутри профиля не переехала');
  assert.strictEqual(folderState.folders[movedId].rootPath, `${NEW}\\wallpapers\\album`);
  assert.deepStrictEqual(
    folderState.folders[movedId].files,
    { 'a.png': { relativePath: 'a.png', firstSeenAt: 1, modifiedAt: 1 } },
    'относительные файлы потеряны',
  );
  assert.ok(folderState.folders[library.idFor(EXTERNAL_DIR)], 'внешняя папка потеряла ключ');
  assert.strictEqual(report.movedFolders, 1);
});

// ---- отказы вместо тихой порчи ---------------------------------------------

ok('ни одной ссылки на старый профиль не остаётся', () => {
  const { config, store, folderState } = remapProfile(profile());
  const text = JSON.stringify({ config, store, folderState });
  assert.ok(!/lumina/i.test(text), 'в результате осталось упоминание старого профиля');
});

ok('вложенные друг в друга профили отвергаются', () => {
  assert.throws(() => remapProfile({ ...profile(), newRoot: `${OLD}\\inner` }), /внутри другого/);
});

ok('ключ, item.id и путь обязаны согласовываться до переноса', () => {
  const p = profile();
  const a = item(oldWp('dup.png'));
  const b = { ...item(oldWp('dup.png')), id: 'старыйid' };
  p.store.library = { [a.id]: a, [b.id]: b };
  assert.throws(() => remapProfile(p), /ключ и item\.id|item\.id не соответствует пути/);
});

ok('inline pool и отдельный store не могут расходиться', () => {
  const p = profile();
  const inStore = item(oldWp('same.png'));
  const inConfig = { ...item(oldWp('same.png')), id: 'другойстарыйid', tags: ['важное'] };
  p.store.library = { [inStore.id]: inStore };
  p.config.library = { [inConfig.id]: inConfig };
  assert.throws(() => remapProfile(p), /inline library.*расходятся/);
});

ok('слот на отсутствующую запись останавливает перенос до записи', () => {
  const p = profile();
  p.config.monitors.MON1.light.itemIds.push('несуществующий');
  assert.throws(() => remapProfile(p), /отсутствующую запись несуществующий/);
});

ok('неподдерживаемая версия отдельного store останавливает перенос', () => {
  const p = profile({ store: { version: 2 } });
  assert.throws(() => remapProfile(p), /неподдерживаемая версия config\.library\.json/);
});

ok('одна запись не может одновременно быть active и removed', () => {
  const p = profile();
  const active = Object.values(p.store.library)[0];
  p.store.trash.push({ item: { ...active }, removedAt: 2 });
  assert.throws(() => remapProfile(p), /одновременно active и removed/);
});

ok('remap не может создать новую коллизию active+removed', () => {
  const p = profile();
  p.store.trash.push({ item: item(newWp('wp-1.png')), removedAt: 2 });
  assert.throws(() => remapProfile(p), /одновременно active и removed/);
});

ok('неподдерживаемая версия folder-state останавливает перенос', () => {
  const p = profile({ folderState: { version: 999 } });
  assert.throws(() => remapProfile(p), /folder-state\.json имеет неподдерживаемый формат или версию/);
});

ok('поддерживаемые folder-state v1 и v3 проходят строгую проверку своей схемы', () => {
  for (const version of [1, 3]) {
    const root = `${EXTERNAL_DIR}\\v${version}`;
    const file = version === 1
      ? { firstSeenAt: 1, modifiedAt: 2 }
      : { relativePath: 'a.png', firstSeenAt: 1, modifiedAt: 2 };
    const p = profile({
      folderState: {
        version,
        folders: {
          [library.idFor(root)]: { rootPath: root, files: { 'a.png': file }, baselineComplete: version === 1 ? false : true },
        },
      },
    });
    const { folderState } = remapProfile(p);
    assert.strictEqual(folderState.version, version);
    assert.ok(folderState.folders[library.idFor(root)]);
  }
});

ok('folder-state key и relativePath обязаны согласовываться', () => {
  const root = EXTERNAL_DIR;
  const p = profile({
    folderState: {
      folders: {
        [library.idFor(root)]: {
          rootPath: root,
          files: { 'wrong.png': { relativePath: 'actual.png', firstSeenAt: 1, modifiedAt: 1 } },
        },
      },
    },
  });
  assert.throws(() => remapProfile(p), /ключ файла не соответствует relativePath/);
});

ok('исходные документы не мутируются', () => {
  const p = profile();
  const snapshot = JSON.stringify(p);
  remapProfile(p);
  assert.strictEqual(JSON.stringify(p), snapshot, 'вход изменён на месте');
});

ok('отчёт считает переехавшее и оставленное', () => {
  const { report } = remapProfile(profile());
  assert.ok(report.movedPaths >= 3, 'переехало подозрительно мало путей: ' + report.movedPaths);
  assert.ok(report.keptExternal >= 3, 'внешних путей учтено мало: ' + report.keptExternal);
  assert.strictEqual(report.remappedIds, 1);
});

console.log(`\nAll ${passed} profile-migration tests passed.`);

// package.json intentionally remains unchanged; the real-filesystem/CLI suite is
// part of this existing test entry and can also be run directly.
require('./profile-migration-io.test').run();
