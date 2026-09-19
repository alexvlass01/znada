'use strict';

/*
 * install-check.js владелец запускает сам, и агент читает только его отчёт. Значит ошибку
 * в нём поймать некому: цифра в отчёте выглядит одинаково убедительно и когда она верна,
 * и когда нет. Под тестом здесь ровно то, что ОТДАЁТ ЧИСЛА, — остальное описывает систему,
 * которой на этой стороне всё равно нет.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHECK = path.join(ROOT, 'scripts', 'install-check.js');

/*
 * Сам отчёт — приватный инструмент владельца, в публичный экспорт он не уходит. Тот же приём,
 * что в review-gate и profile-migration-io: молча пропустить там, где инструмента и не должно
 * быть, но упасть, если он исчез из приватного checkout, где обязан лежать.
 */
if (!fs.existsSync(CHECK)) {
  if (fs.existsSync(path.join(ROOT, 'AGENTS.md'))) {
    throw new Error('private canonical checkout is missing required scripts/install-check.js');
  }
  console.log('SKIP install-check: private owner-only tool is absent from this checkout.');
  process.exit(0);
}

const {
  RUN_NAMES, commandTarget, compareVersions, folderSize, matchingDirs, referencesToLegacy,
} = require(CHECK);
const { LEGACY_LOGIN_ITEM_NAMES } = require('../src/windows-launch');

let passed = 0;
function ok(name, fn) {
  fn();
  console.log(`  OK ${name}`);
  passed += 1;
}

ok('версии сравниваются числами, а не строками', () => {
  // Ради этого функция и написана: по строкам «1.7.10» < «1.7.9», и тогда фид обновления
  // спрашивается от имени не той версии — то есть проверка обновления врёт молча.
  const versions = ['1.7.9', '1.10.0', '1.2.0', '1.7.10'];
  assert.deepStrictEqual([...versions].sort(compareVersions),
    ['1.2.0', '1.7.9', '1.7.10', '1.10.0']);
  assert.notDeepStrictEqual([...versions].sort(), [...versions].sort(compareVersions));

  // Разная длина номера — не повод считать отсутствующую часть больше нуля.
  assert.ok(compareVersions('1.7', '1.7.0') === 0);
  assert.ok(compareVersions('1.7.1', '1.7') > 0);
});

ok('объём считается рекурсивно, а корзина отделяется от живого', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-size-'));
  try {
    const wallpapers = path.join(root, 'wallpapers');
    const trash = path.join(wallpapers, '.trash');
    fs.mkdirSync(path.join(wallpapers, 'sub'), { recursive: true });
    fs.mkdirSync(trash, { recursive: true });
    fs.writeFileSync(path.join(wallpapers, 'a.jpg'), Buffer.alloc(100));
    fs.writeFileSync(path.join(wallpapers, 'sub', 'b.png'), Buffer.alloc(250));
    fs.writeFileSync(path.join(trash, 'c.webp'), Buffer.alloc(30));

    const all = folderSize(wallpapers);
    assert.strictEqual(all.bytes, 380, 'вложенные папки обязаны попадать в счёт');
    assert.strictEqual(all.files, 3);

    // Отчёт вычитает корзину из общего: удалённое переезжать не должно, и человеку
    // нельзя показывать его как объём работы.
    const binned = folderSize(trash);
    assert.strictEqual(binned.bytes, 30);
    assert.strictEqual(all.bytes - binned.bytes, 350, 'живой объём — это всё минус корзина');
    assert.strictEqual(all.files - binned.files, 2);

    // Пустая папка — это ноль, а не отсутствие ответа.
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    assert.deepStrictEqual(folderSize(empty), { bytes: 0, files: 0 });
  }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

ok('отсутствующая папка не роняет отчёт', () => {
  // Отчёт снимается одним заходом. Упасть на одном разделе — значит не отдать владельцу
  // и все остальные, ради которых он файл и запускал.
  assert.deepStrictEqual(folderSize(path.join(os.tmpdir(), 'znada-no-such-dir-' + Date.now())),
    { bytes: 0, files: 0 });
});

ok('папки прежнего имени ищутся, а не берутся из списка известных', () => {
  // Ровно на этом проверка и промахнулась 2026-09-09: она смотрела на два жёстко прописанных
  // пути и отрапортовала «остатков нет», пока рядом лежали `Lumina-Dev` и `Lumina-Diagnostics`.
  // Нашёл их владелец глазами. Приложение заводит отдельный профиль на каждый режим и бэкап
  // при переносе, поэтому список известных мест устаревает быстрее, чем его правят.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-dirs-'));
  try {
    for (const name of ['Lumina', 'Lumina-Dev', 'Lumina-Diagnostics', 'Znada', 'Znada-Dev',
      'Znada-Dev-backup-2026-09-02', 'Illuminati', 'Sublime']) {
      fs.mkdirSync(path.join(root, name));
    }
    // Файл с подходящим именем каталогом не является и в счёт идти не должен.
    fs.writeFileSync(path.join(root, 'Lumina-notes.txt'), 'x');

    assert.deepStrictEqual(matchingDirs(root, 'lumina'),
      ['Lumina', 'Lumina-Dev', 'Lumina-Diagnostics'],
      'должны находиться ВСЕ папки прежнего имени, включая режимные');

    // Регистр в Windows не значим: `%APPDATA%\lumina` и `%LOCALAPPDATA%\Lumina` — одно имя.
    assert.deepStrictEqual(matchingDirs(root, 'LUMINA'), matchingDirs(root, 'lumina'));

    // Основную установку и основной профиль исключаем: у них свои разделы отчёта.
    assert.deepStrictEqual(matchingDirs(root, 'znada', ['Znada']),
      ['Znada-Dev', 'Znada-Dev-backup-2026-09-02']);
    assert.deepStrictEqual(matchingDirs(root, 'znada', ['ZNADA']),
      ['Znada-Dev', 'Znada-Dev-backup-2026-09-02'], 'исключение тоже без учёта регистра');

    // Отсутствующий или незаданный корень — пустой список, а не падение отчёта.
    assert.deepStrictEqual(matchingDirs(path.join(root, 'нет-такой'), 'lumina'), []);
    assert.deepStrictEqual(matchingDirs('', 'lumina'), []);
    assert.deepStrictEqual(matchingDirs(undefined, 'lumina'), []);
  }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

ok('из записи автозапуска берётся программа, а не вся командная строка', () => {
  // От этого зависит, будет ли запись помечена мёртвой. 2026-09-09 после деинсталляции
  // Lumina в `Run` осталась её строка, ведущая на удалённый `Update.exe`; отчёт печатал её
  // как обычную, и заметил это человек. Разбирать надо путь, а аргументы отбрасывать.
  assert.strictEqual(
    commandTarget('"C:\\Users\\me\\AppData\\Local\\Lumina\\Update.exe" --processStart Lumina.exe'),
    'C:\\Users\\me\\AppData\\Local\\Lumina\\Update.exe',
    'кавычки существуют ровно потому, что в пути бывают пробелы');

  // Аргументы тоже бывают в кавычках — закрывающая кавычка нужна ПЕРВАЯ, а не последняя.
  assert.strictEqual(
    commandTarget('"C:\\Program Files\\App\\a.exe" --args "--autostart --hidden"'),
    'C:\\Program Files\\App\\a.exe');

  // Без кавычек путь заканчивается на первом пробеле — так это и понимает Windows.
  assert.strictEqual(commandTarget('C:\\Tools\\run.exe --quiet'), 'C:\\Tools\\run.exe');
  assert.strictEqual(commandTarget('C:\\Tools\\run.exe'), 'C:\\Tools\\run.exe');

  // Пустое и битое не должны превращаться в путь: несуществующий '' пометил бы КАЖДУЮ
  // запись мёртвой, и настоящая находка утонула бы среди ложных.
  assert.strictEqual(commandTarget(''), '');
  assert.strictEqual(commandTarget('   '), '');
  assert.strictEqual(commandTarget(null), '');
  assert.strictEqual(commandTarget('"C:\\незакрытая\\кавычка.exe'), '');
});

ok('ссылка в старую папку находится, а нарочно оставленные строки — нет', () => {
  // Этот ответ решает, безопасно ли удалять старые папки. Ошибка в любую сторону дорогая:
  // пропустить настоящую ссылку — оставить запись без файла; поднять ложную тревогу на
  // строке, которая ДОЛЖНА быть старой, — отговорить от удаления без причины.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-legacy-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      // Ключ настройки называется так намеренно, с прежних времён — это НЕ путь.
      onlineSources: { lumina: true, wallhaven: true },
      // Маркер происхождения и заголовок тоже намеренно старые, слэшами не окружены.
      origin: 'lumina:12345',
      header: 'X-Lumina-Anon-Id',
      darkWallpaper: 'C:\\Users\\me\\AppData\\Roaming\\znada\\wallpapers\\wp-abc.jpg',
    }));
    fs.writeFileSync(path.join(dir, 'config.library.json'), JSON.stringify({
      library: {
        a: { path: 'C:\\Users\\me\\AppData\\Roaming\\lumina\\wallpapers\\old.jpg' },
        b: { path: 'D:\\Photos\\holiday.jpg' },
        c: { path: 'C:/Users/me/AppData/Local/Lumina/app-1.6.0/pic.png' },
      },
    }));

    const found = referencesToLegacy(dir).sort();
    assert.strictEqual(found.length, 2, 'найдено не то количество: ' + JSON.stringify(found));
    assert.ok(found.some((p) => /Roaming\\lumina\\/i.test(p)), 'старый профиль не найден');
    assert.ok(found.some((p) => /Local\/Lumina\//i.test(p)), 'прямые слэши обязаны ловиться тоже');

    // Чистый профиль — это ответ «удалять безопасно», и он должен быть однозначным.
    fs.writeFileSync(path.join(dir, 'config.library.json'), JSON.stringify({ library: {} }));
    assert.deepStrictEqual(referencesToLegacy(dir), []);

    // Нечитаемый или битый файл не превращается в «ссылок нет»... он просто не даёт ответа
    // по себе, и отчёт печатает то, что смог прочитать. Падать здесь нельзя.
    fs.writeFileSync(path.join(dir, 'config.library.json'), '{ битый');
    assert.deepStrictEqual(referencesToLegacy(dir), []);
    assert.deepStrictEqual(referencesToLegacy(path.join(dir, 'нет-такой-папки')), []);
  }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

ok('список имён автозапуска не расходится с приложением', () => {
  // Проверка ищет запись под ИСТОРИЧЕСКИМИ именами: «нет записи под нынешним» не значит
  // «автозапуска нет». Если приложение начнёт чистить имя, которого нет здесь, отчёт
  // будет уверенно сообщать о чистоте там, где запись осталась.
  for (const name of LEGACY_LOGIN_ITEM_NAMES) {
    assert.ok(RUN_NAMES.includes(name), `имя ${name} чистится приложением, но не ищется отчётом`);
  }
});

console.log(`\nAll ${passed} install-check tests passed.`);
