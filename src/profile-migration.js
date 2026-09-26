'use strict';

// Перенос профиля Lumina → Znada: пересчёт всего, что зависит от пути профиля.
//
// Зачем это отдельный модуль. Просто скопировать папку НЕЛЬЗЯ: приложение
// опознаёт каждую картинку по хэшу её полного пути (`library.idFor`). После
// смены `%APPDATA%\lumina` на `%APPDATA%\znada` меняются все пути внутри
// профиля, а значит и все опознаватели. Скопированный «как есть» профиль даст
// пустую библиотеку и сломанные слоты.
//
// Здесь только чистая логика: на входе разобранные документы, на выходе новые.
// Чтение и запись файлов — в scripts/migrate-profile.js, чтобы это можно было
// прогнать тестами без диска.
//
// Правило, которое важнее остальных: трогаются ТОЛЬКО пути внутри профиля.
// Папки пользователя и живые папки за его пределами остаются как есть — они
// никуда не переезжают, и переписать их значило бы сломать рабочие ссылки.

const path = require('path');
const { isDeepStrictEqual } = require('util');
const library = require('./library');
const folderStateStore = require('./folder-state');
const { isUnderPath } = require('./path-key');

// Внутри профиля переезжает только дерево обоев (вместе с .trash) — остальное
// это настройки и служебные файлы, на которые никто не ссылается по пути.
const OWNED_SUBDIR = 'wallpapers';

function ownedRoot(profileRoot) {
  return path.win32.join(canonicalWindowsPath(profileRoot), OWNED_SUBDIR);
}

// DATA-006 reuses everything below for a different move: the profile stays where it is
// and only the folder of Znada's own copies goes somewhere else. The arithmetic is the
// same — every id is a hash of a path — so the two cases differ in one place only:
// which folder is "ours" and which folder the result must no longer mention.
//
//   profile mode: the roots are profile folders, ours is <root>\wallpapers;
//   media mode:   the roots ARE the folders of copies.
function resolveRoots({ oldRoot, newRoot, mode }) {
  const from = String(oldRoot || '');
  const to = String(newRoot || '');
  if (!from || !to) throw new Error('remap: нужны oldRoot и newRoot');
  if (isUnderPath(to, from) || isUnderPath(from, to)) {
    throw new Error('remap: один корень лежит внутри другого');
  }
  const media = mode === 'media';
  return {
    oldOwned: media ? canonicalWindowsPath(from) : ownedRoot(from),
    newOwned: media ? canonicalWindowsPath(to) : ownedRoot(to),
    // What must not survive anywhere in the result — in both modes, the root that is
    // about to be emptied. In profile mode that is wider than "ours": a reference into
    // the old profile that is NOT a wallpaper cannot travel with the move, and the old
    // profile is deleted afterwards, so the remap refuses instead of guessing.
    scanRoot: canonicalWindowsPath(from),
  };
}

// `path-key` deliberately understands the extended Windows spellings, but
// `path.win32.relative()` does not: relative(plain, "\\\\?\\C:\\...") produces a
// path containing `?\\C:`. Strip only the two pass-through prefixes Windows uses,
// then let path.win32 normalize separators and dot segments. This preserves UNC
// roots and does not touch ordinary user paths.
function canonicalWindowsPath(value) {
  let p = String(value == null ? '' : value).trim().replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(p)) p = `\\\\${p.slice(8)}`;
  else if (/^\\\\[?.]\\/.test(p)) p = p.slice(4);
  return path.win32.normalize(p);
}

// Путь лежит в нашей папке? Сравнение через общий канонический ключ проекта,
// а не строкой: иначе `C:\x\wallpapers2` посчитается лежащим в `C:\x\wallpapers`.
function ownsPath(p, oldOwned) {
  if (typeof p !== 'string' || !p) return false;
  return isUnderPath(p, oldOwned);
}

function movedWithinOwned(p, oldOwned, newOwned) {
  const source = canonicalWindowsPath(p);
  const rel = path.win32.relative(oldOwned, source);
  if (rel === '..' || rel.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(rel)) {
    throw new Error(`movedPath: путь не принадлежит нашей папке: ${p}`);
  }
  return path.win32.join(newOwned, rel);
}

// Прежние имена для вызовов, которые рассуждают в корнях ПРОФИЛЯ.
function isOwned(p, oldRoot) {
  return ownsPath(p, ownedRoot(oldRoot));
}

function movedPath(p, oldRoot, newRoot) {
  return movedWithinOwned(p, ownedRoot(oldRoot), ownedRoot(newRoot));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function failValidation(message) {
  throw new Error(`профиль Lumina не прошёл проверку: ${message}`);
}

function validateItem(item, expectedId, where) {
  if (!isPlainObject(item)) failValidation(`${where}: запись должна быть объектом`);
  if (typeof item.path !== 'string' || !item.path.trim()) failValidation(`${where}: нет пути`);
  if (!path.win32.isAbsolute(canonicalWindowsPath(item.path))) failValidation(`${where}: путь не абсолютный`);
  if (item.type !== 'image' && item.type !== 'folder') failValidation(`${where}: неизвестный тип`);
  if (typeof item.id !== 'string' || !item.id) failValidation(`${where}: нет item.id`);
  if (expectedId && item.id !== expectedId) failValidation(`${where}: ключ и item.id расходятся`);
  const canonicalId = library.idFor(item.path);
  if (item.id !== canonicalId) failValidation(`${where}: item.id не соответствует пути`);
  return item.id;
}

/**
 * Read-only validation of the one supported source format: a profile written by
 * Lumina v1.6.0 after the split library store existed. Do not normalize or merge
 * here: either operation would silently choose a winner for inconsistent input.
 */
function validateSourceProfile({ config, store, folderState = null } = {}) {
  if (!isPlainObject(config)) failValidation('config.json отсутствует или имеет неверный формат');
  if (!isPlainObject(config.monitors)) failValidation('config.json не содержит monitors');
  if (!isPlainObject(store)) failValidation('config.library.json отсутствует или имеет неверный формат');
  if (store.version !== 1) failValidation(`неподдерживаемая версия config.library.json: ${store.version}`);
  if (!isPlainObject(store.library)) failValidation('config.library.json не содержит library');
  if (!Array.isArray(store.trash)) failValidation('config.library.json не содержит trash');

  if (Object.prototype.hasOwnProperty.call(config, 'library')) {
    if (!isPlainObject(config.library)) failValidation('inline library имеет неверный формат');
    if (!isDeepStrictEqual(config.library, store.library)) {
      failValidation('inline library и config.library.json расходятся; автоматический выбор победителя запрещён');
    }
  }
  if (Object.prototype.hasOwnProperty.call(config, 'libraryTrash')) {
    if (!Array.isArray(config.libraryTrash)) failValidation('inline libraryTrash имеет неверный формат');
    if (!isDeepStrictEqual(config.libraryTrash, store.trash)) {
      failValidation('inline libraryTrash и config.library.json расходятся');
    }
  }

  const activeIds = new Set();
  for (const [id, item] of Object.entries(store.library)) {
    if (!id) failValidation('library содержит пустой ключ');
    validateItem(item, id, `library.${id}`);
    activeIds.add(id);
  }

  const removedIds = new Set();
  for (let i = 0; i < store.trash.length; i++) {
    const entry = store.trash[i];
    if (!isPlainObject(entry) || !isPlainObject(entry.item)) {
      failValidation(`trash[${i}] имеет неверный формат`);
    }
    const id = validateItem(entry.item, entry.item.id, `trash[${i}].item`);
    if (activeIds.has(id)) failValidation(`запись ${id} одновременно active и removed`);
    if (removedIds.has(id)) failValidation(`запись ${id} повторяется в trash`);
    removedIds.add(id);
  }

  for (const [monitorId, slots] of Object.entries(config.monitors)) {
    if (!isPlainObject(slots)) failValidation(`monitor ${monitorId} имеет неверный формат`);
    for (const theme of ['light', 'dark']) {
      const slot = slots[theme];
      if (!isPlainObject(slot) || !Array.isArray(slot.itemIds)) {
        failValidation(`slot ${monitorId}/${theme} не нормализован Lumina v1.6.0`);
      }
      const seen = new Set();
      for (const id of slot.itemIds) {
        if (typeof id !== 'string' || !id) failValidation(`slot ${monitorId}/${theme} содержит неверный id`);
        if (!activeIds.has(id)) failValidation(`slot ${monitorId}/${theme} ссылается на отсутствующую запись ${id}`);
        if (seen.has(id)) failValidation(`slot ${monitorId}/${theme} содержит повтор ${id}`);
        seen.add(id);
      }
    }
  }

  if (folderState != null) {
    // Runtime accepts v1-v4. Validate each version's persisted shape without
    // normalizing it here. Historical entries may derive relativePath from the
    // map key; current saves persist it explicitly.
    if (!isPlainObject(folderState) || ![1, 2, 3, 4].includes(folderState.version)
      || !isPlainObject(folderState.folders)) {
      failValidation('folder-state.json имеет неподдерживаемый формат или версию');
    }
    for (const [folderId, folder] of Object.entries(folderState.folders)) {
      if (!folderId || !isPlainObject(folder) || typeof folder.rootPath !== 'string' || !folder.rootPath) {
        failValidation(`folder-state.folders.${folderId || '<empty>'} имеет неверный формат`);
      }
      if (folderId !== library.idFor(folder.rootPath)) {
        failValidation(`folder-state key ${folderId} не соответствует rootPath`);
      }
      if (!isPlainObject(folder.files)) failValidation(`folder-state ${folderId}.files имеет неверный формат`);
      if (!path.win32.isAbsolute(canonicalWindowsPath(folder.rootPath))) {
        failValidation(`folder-state ${folderId}.rootPath не абсолютный`);
      }
      for (const [fileKey, file] of Object.entries(folder.files)) {
        if (!fileKey || !isPlainObject(file)) {
          failValidation(`folder-state ${folderId}.files.${fileKey || '<empty>'} имеет неверный формат`);
        }
        const rawRelative = typeof file.relativePath === 'string'
          ? file.relativePath
          : (file.relativePath == null ? fileKey : null);
        if (rawRelative == null) {
          failValidation(`folder-state ${folderId}.files.${fileKey}: нет relativePath`);
        }
        const relativePath = folderStateStore.normalizeRelativePath(rawRelative);
        if (!folderStateStore.isSafeRelativePath(relativePath) || fileKey !== relativePath.toLowerCase()) {
          failValidation(`folder-state ${folderId}: ключ файла не соответствует relativePath`);
        }
        for (const timeKey of ['firstSeenAt', 'modifiedAt']) {
          if (file[timeKey] != null
            && (typeof file[timeKey] !== 'number' || !Number.isFinite(file[timeKey]) || file[timeKey] < 0)) {
            failValidation(`folder-state ${folderId}.${fileKey}.${timeKey} имеет неверный формат`);
          }
        }
        if (file.aspect != null
          && (typeof file.aspect !== 'number' || !Number.isFinite(file.aspect) || file.aspect <= 0)) {
          failValidation(`folder-state ${folderId}.${fileKey}.aspect имеет неверный формат`);
        }
        if (file.hidden != null && typeof file.hidden !== 'boolean') {
          failValidation(`folder-state ${folderId}.${fileKey}.hidden имеет неверный формат`);
        }
      }
      if (folder.baselineComplete != null && typeof folder.baselineComplete !== 'boolean') {
        failValidation(`folder-state ${folderId}.baselineComplete имеет неверный формат`);
      }
      if (folder.hiddenDirs != null && !isPlainObject(folder.hiddenDirs)) {
        failValidation(`folder-state ${folderId}.hiddenDirs имеет неверный формат`);
      }
      for (const [dirKey, relativeValue] of Object.entries(folder.hiddenDirs || {})) {
        if (typeof relativeValue !== 'string') {
          failValidation(`folder-state ${folderId}.hiddenDirs.${dirKey} имеет неверный формат`);
        }
        const relativePath = folderStateStore.normalizeRelativePath(relativeValue);
        if (!folderStateStore.isSafeRelativePath(relativePath) || dirKey !== relativePath.toLowerCase()) {
          failValidation(`folder-state ${folderId}: ключ hiddenDirs не соответствует пути`);
        }
      }
    }
  }
  return true;
}

/**
 * Пересчитывает профиль под новый корень.
 *
 * Возвращает новые документы и отчёт. Ничего не мутирует на входе.
 * Бросает исключение при коллизии опознавателей: два разных элемента, схлопнутые
 * в один, — это молчаливая потеря данных, а её нельзя допускать «на всякий случай».
 */
function remapProfile(input) {
  const roots = resolveRoots(input);

  validateSourceProfile(input);

  const config = JSON.parse(JSON.stringify(input.config || {}));
  const store = JSON.parse(JSON.stringify(input.store || {}));
  const folderState = JSON.parse(JSON.stringify(input.folderState || {}));

  const report = {
    movedPaths: 0,        // сколько путей переписано
    keptExternal: 0,      // сколько оставлено как есть (вне профиля)
    remappedIds: 0,       // сколько записей сменило опознаватель
    movedFolders: 0,      // сколько отслеживаемых папок переехало
    warnings: [],
  };

  const idMap = new Map();      // старый id → новый id
  const seenNewIds = new Map(); // новый id → старый, для поиска коллизий

  const move = (p) => {
    if (!ownsPath(p, roots.oldOwned)) {
      if (typeof p === 'string' && p) report.keptExternal++;
      return p;
    }
    report.movedPaths++;
    return movedWithinOwned(p, roots.oldOwned, roots.newOwned);
  };

  // ---- пул -----------------------------------------------------------------
  // Ключ пула и item.id — это хэш пути, поэтому пересчитываются вместе с ним.
  const remapPool = (pool) => {
    if (!pool || typeof pool !== 'object') return pool;
    const out = {};
    for (const [oldId, rawItem] of Object.entries(pool)) {
      const item = { ...rawItem };
      const newPath = move(item.path);
      const newId = newPath === item.path ? oldId : library.idFor(newPath);
      if (newId !== oldId) {
        const clash = seenNewIds.get(newId);
        if (clash && clash !== oldId) {
          throw new Error(`перенос остановлен: записи ${clash} и ${oldId} схлопываются в ${newId}`);
        }
        seenNewIds.set(newId, oldId);
        idMap.set(oldId, newId);
        report.remappedIds++;
      }
      item.path = newPath;
      item.id = newId;
      if (out[newId]) throw new Error(`перенос остановлен: дубликат записи ${newId}`);
      out[newId] = item;
    }
    return out;
  };

  const mapId = (id) => idMap.get(id) || id;

  if (store.library) store.library = remapPool(store.library);
  if (config.library) config.library = remapPool(config.library);

  // ---- корзина -------------------------------------------------------------
  // `via` хранит, ВМЕСТЕ С КАКОЙ ПАПКОЙ ушла запись. Это тоже путь, и если его
  // не переписать, возврат родителя перестанет находить своих детей.
  const remapTrash = (list) => {
    if (!Array.isArray(list)) return list;
    return list.map((raw) => {
      const entry = { ...raw };
      if (entry.item && typeof entry.item === 'object') {
        const item = { ...entry.item };
        const newPath = move(item.path);
        if (newPath !== item.path) item.id = library.idFor(newPath);
        else if (item.id) item.id = mapId(item.id);
        item.path = newPath;
        entry.item = item;
      }
      if (typeof entry.via === 'string' && entry.via) entry.via = move(entry.via);
      return entry;
    });
  };

  if (store.trash) store.trash = remapTrash(store.trash);
  if (config.libraryTrash) config.libraryTrash = remapTrash(config.libraryTrash);

  // ---- слоты монитор × тема ------------------------------------------------
  for (const slots of Object.values(config.monitors || {})) {
    if (!slots || typeof slots !== 'object') continue;
    for (const theme of ['light', 'dark']) {
      const slot = slots[theme];
      if (!slot || !Array.isArray(slot.itemIds)) continue;
      slot.itemIds = slot.itemIds.map(mapId);
    }
  }

  // ---- прочие пути в настройках -------------------------------------------
  // lastSaveDir тоже путь: если человек сохранял картинку внутрь нашей папки, запись
  // про неё должна переехать, а не остаться ссылкой в опустевший корень.
  for (const key of ['lightWallpaper', 'darkWallpaper', 'lastSaveDir']) {
    if (typeof config[key] === 'string' && config[key]) config[key] = move(config[key]);
  }
  for (const perTheme of Object.values(config.slideshowCurrentPath || {})) {
    if (!perTheme || typeof perTheme !== 'object') continue;
    for (const theme of ['light', 'dark']) {
      if (typeof perTheme[theme] === 'string' && perTheme[theme]) perTheme[theme] = move(perTheme[theme]);
    }
  }

  // ---- индекс отслеживаемых папок -----------------------------------------
  // Ключ здесь тоже выведен из пути. Переезжают только папки внутри профиля;
  // папки пользователя остаются со своими прежними ключами.
  if (folderState.folders && typeof folderState.folders === 'object') {
    const out = {};
    for (const [folderId, rawFolder] of Object.entries(folderState.folders)) {
      const folder = { ...rawFolder };
      const newPath = move(folder.rootPath);
      const newId = newPath === folder.rootPath ? folderId : library.idFor(newPath);
      if (newId !== folderId) report.movedFolders++;
      folder.rootPath = newPath;
      if (out[newId]) throw new Error(`перенос остановлен: две отслеживаемые папки дают ключ ${newId}`);
      out[newId] = folder;
    }
    folderState.folders = out;
  }

  // ---- проверка результата -------------------------------------------------
  // Ни одной ссылки на старый профиль остаться не должно, а каждый id в слоте
  // обязан существовать в пуле. Иначе лучше отказаться, чем отдать битый профиль.
  const pool = store.library;
  const leftovers = [];
  const scan = (value, where) => {
    if (typeof value === 'string') {
      if (isUnderPath(value, roots.scanRoot)) leftovers.push(`${where}: ${value}`);
      return;
    }
    if (Array.isArray(value)) return value.forEach((v, i) => scan(v, `${where}[${i}]`));
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) scan(v, `${where}.${k}`);
    }
  };
  scan(config, 'config');
  scan(store, 'store');
  scan(folderState, 'folder-state');
  if (leftovers.length) {
    // Ссылка ведёт внутрь старого профиля, но не в его папку обоев — то есть
    // переехать вместе с ней она не может, а старый профиль потом удаляется.
    // Угадывать тут нечего: либо владелец переносит такой файл сам, либо
    // убирает запись. Поэтому отказ, а не «перенесём как получится».
    throw new Error(
      'перенос остановлен: есть ссылки внутрь старого профиля вне папки обоев.\n'
      + 'Такой файл не переедет, а старый профиль после уборки исчезнет.\n'
      + 'Перенесите эти файлы наружу или уберите записи, затем повторите:\n  '
      + leftovers.slice(0, 5).join('\n  '),
    );
  }

  for (const [monitorId, slots] of Object.entries(config.monitors || {})) {
    for (const theme of ['light', 'dark']) {
      const slot = slots && slots[theme];
      if (!slot || !Array.isArray(slot.itemIds)) continue;
      for (const id of slot.itemIds) {
        if (!pool[id]) throw new Error(`перенос остановлен: слот ${monitorId}/${theme} ссылается на отсутствующую запись ${id}`);
      }
    }
  }

  // A collision can be introduced by the remap itself (for example, an old
  // owned item and an external item already pointing at the future Znada path).
  // Re-run the same fail-closed invariants on the result before any caller writes
  // it to staging.
  validateSourceProfile({
    config,
    store,
    folderState: input.folderState == null ? null : folderState,
  });

  return { config, store, folderState, report };
}

/**
 * DATA-006: тот же пересчёт, но переезжает ОДНА папка собственных копий, а профиль
 * остаётся на месте. `oldRoot`/`newRoot` здесь — сами папки копий, а не профили.
 */
function remapMediaRoot(input) {
  return remapProfile({ ...input, mode: 'media' });
}

module.exports = {
  remapProfile,
  remapMediaRoot,
  validateSourceProfile,
  canonicalWindowsPath,
  isOwned,
  movedPath,
  OWNED_SUBDIR,
};
