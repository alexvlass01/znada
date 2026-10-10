'use strict';

/*
 * Гейт должен собираться из дельты сам. Две вещи, которые ломают его молча:
 * выбор этапов, не соответствующий затронутым файлам (проверяющий не пойдёт туда,
 * где риск), и пропавший шаблон этапа (prepare падает в момент, когда исполнитель
 * уже ждёт задание).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'review-gate.js');
const TEMPLATES = path.join(ROOT, 'scripts', 'review-gate');

/*
 * Гейт — приватный инструмент разработки, его нет в публичном экспорте. Тот же приём,
 * что и в profile-migration-io: молча пропустить там, где инструмента и не должно быть,
 * но упасть, если он пропал в приватном checkout, где обязан лежать.
 */
if (!fs.existsSync(GATE)) {
  if (fs.existsSync(path.join(ROOT, 'AGENTS.md'))) {
    throw new Error('private canonical checkout is missing required scripts/review-gate.js');
  }
  console.log('SKIP review-gate: private owner-only tool is absent from this checkout.');
  process.exit(0);
}

const gate = require(GATE);

const ids = (files) => gate.pickStages(files).map((s) => s.id);

/* Дешёвые этапы идут всегда: даже правка одних тестов должна быть кем-то прочитана. */
{
  const only = ids(['test/foo.test.js', 'plans/index.md']);
  assert.deepStrictEqual(only, ['01-automated', '02-diff'],
    'правка тестов и планов не должна тянуть за собой дорогие этапы');
}

/* Данные пользователя — отдельный этап, и он обязан включаться от хранилища библиотеки. */
{
  const withData = ids(['src/library-store.js']);
  assert.ok(withData.includes('03-data'), 'правка library-store обязана включать этап данных');
  assert.ok(!withData.includes('04-runtime'), 'без интерфейса дорогой GUI-этап не нужен');
  assert.ok(!withData.includes('05-release'), 'без релизных файлов этап выпуска не нужен');
}

/* Интерфейс — GUI-этап, но не этап данных. */
{
  const withUi = ids(['renderer/renderer.js']);
  assert.ok(withUi.includes('04-runtime'), 'правка renderer обязана включать живое приложение');
  assert.ok(!withUi.includes('03-data'), 'renderer сам по себе не трогает хранилище');
}

/* main.js держит и системную логику, и оркестрацию интерфейса — включает оба. */
{
  const withMain = ids(['main.js']);
  assert.ok(withMain.includes('03-data'), 'main.js оркеструет пул — этап данных обязателен');
  assert.ok(withMain.includes('04-runtime'), 'main.js держит IPC интерфейса — GUI-этап обязателен');
}

/* Релизная механика включается от установщика и от версии в package.json. */
{
  assert.ok(ids(['scripts/build-installer.js']).includes('05-release'),
    'правка установщика обязана включать этап выпуска');
  assert.ok(ids(['package.json']).includes('05-release'),
    'смена версии обязана включать этап выпуска');
}

/*
 * Каждому этапу нужен свой шаблон. Без этой проверки пропавший файл обнаружился бы
 * только при prepare — то есть в момент, когда проверяющий уже ждёт задание.
 */
{
  const dir = TEMPLATES;
  assert.ok(fs.existsSync(path.join(dir, 'brief.md')), 'нет общего брифа');
  for (const stage of gate.STAGES) {
    const file = path.join(dir, 'stage-' + stage.id + '.md');
    assert.ok(fs.existsSync(file), 'нет шаблона для этапа ' + stage.id);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('{{REL}}'), stage.id + ': шаблон не говорит, куда писать результат');
    assert.ok(text.includes('{{STAGE_ID}}'), stage.id + ': в шаблоне нет команды сдачи');
    assert.ok(text.includes('{{LEAD_CHECKS}}'), stage.id + ': в задании нет места для списка ведущего');
  }
}

/*
 * Бриф обязан запрещать чтение больших внутренних документов. Это не косметика:
 * именно обязательное чтение STATUS/ROADMAP/AGENTS/CLAUDE (~470 КБ) сделало проверку
 * дороже написания проверяемого кода. Вернуть их в бриф — значит вернуть ту же цену.
 */
{
  const brief = fs.readFileSync(
    path.join(TEMPLATES, 'brief.md'), 'utf8');
  for (const doc of ['STATUS.md', 'ROADMAP.md', 'AGENTS.md']) {
    assert.ok(brief.includes(doc), 'бриф должен называть ' + doc + ', чтобы явно его исключить');
  }
  assert.ok(/[Нн]е читай/.test(brief), 'бриф обязан прямо запрещать чтение больших документов');
}

/*
 * BLOCKED должен предлагаться заново. Иначе этап, который никто не сумел проверить,
 * молча уедет в «сделано»: у владельца есть настоящий рабочий стол, которого нет у
 * агента, и повторная раздача — единственный способ до него дойти.
 */
{
  const stages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const done = {
    a: { verdict: 'pass' },
    b: { verdict: 'blocked' },
    c: { verdict: 'fail' },
  };
  const pending = gate.pendingStages(stages, done).map((s) => s.id);
  assert.ok(pending.includes('b'), 'blocked обязан предлагаться заново — его никто не проверил');
  assert.ok(pending.includes('d'), 'несданный этап обязан предлагаться');
  assert.ok(!pending.includes('a'), 'пройденный этап заново не раздаётся');
  assert.ok(!pending.includes('c'),
    'fail заново не раздаётся сам: сначала правка, потом reopen — иначе тот же дефект просто перескажут');
}

/*
 * Исход пакета считается в двух местах — в итоге и в списке прошлых прогонов. Самое
 * опасное расхождение здесь — показать PASS там, где этап не закрыт: выпуск оперся бы
 * на доказательство, которого нет.
 */
{
  const stages = [{ id: 'a' }, { id: 'b' }];
  const O = gate.outcomeOf;
  assert.strictEqual(O(stages, { a: { verdict: 'pass' }, b: { verdict: 'pass' } }), 'PASS');
  assert.strictEqual(O(stages, { a: { verdict: 'pass' } }), 'НЕ ЗАВЕРШЁН',
    'несданный этап не имеет права выглядеть пройденным');
  assert.strictEqual(O(stages, { a: { verdict: 'pass' }, b: { verdict: 'blocked' } }), 'BLOCKED',
    'blocked — это «никто не проверил», а не пройдено');
  assert.strictEqual(O(stages, { a: { verdict: 'fail' }, b: { verdict: 'blocked' } }), 'FAIL',
    'дефект важнее незавершённости: FAIL перекрывает всё остальное');
}

/* Этап без объявленной способности нельзя раздать: исполнитель не поймёт, тянет ли он его. */
{
  for (const stage of gate.STAGES) {
    assert.ok(stage.needs && stage.cost, stage.id + ': не объявлены нужная способность и цена');
    assert.ok(stage.always || typeof stage.when === 'function',
      stage.id + ': этап ни всегдашний, ни условный — он не попадёт ни в один пакет');
  }
}

/*
 * ОДИН этап за заход — требование владельца от 2026-09-07, и оно охраняется здесь,
 * потому что живёт в тексте, а текст правят не глядя.
 *
 * Как оно ломалось на самом деле: проверяющий получал список из пяти этапов, брал все,
 * шёл часами, вырабатывал недельный лимит и обрывался посреди — сданным не оказывалось
 * НИЧЕГО, хотя работа была сделана. Повторить прогон после починки было уже нечем.
 * Механика гейта тут ни при чём: этапы независимы, а `submit` и так принимает их по
 * одному. Ломался ИМЕННО текст передачи.
 */
{
  const brief = fs.readFileSync(path.join(TEMPLATES, 'brief.md'), 'utf8');
  assert.ok(/один этап за заход/i.test(brief),
    'бриф больше не требует брать этапы по одному — вернётся прогон, сгорающий целиком');
  assert.ok(/спроси/i.test(brief),
    'бриф не велит спрашивать перед следующим этапом');

  for (const file of fs.readdirSync(TEMPLATES)) {
    if (!/^stage-/.test(file)) continue;
    const text = fs.readFileSync(path.join(TEMPLATES, file), 'utf8');
    assert.ok(/остановись/i.test(text) && /спроси/i.test(text),
      file + ': этап не велит остановиться и спросить про следующий');
  }

  // И сам текст передачи: он называет один этап, а остальные показывает как справку.
  const source = fs.readFileSync(GATE, 'utf8');
  assert.ok(source.includes("'Возьми ОДИН этап — вот он:'"),
    'передача снова раздаёт список этапов вместо одного');
  assert.ok(source.includes('Не переходи к нему сам.'),
    'передача не запрещает переходить к следующему этапу самостоятельно');
  assert.ok(source.includes('НЕ брать сейчас, показано чтобы был виден объём'),
    'остальные этапы должны быть справкой, а не заданием');
}

/*
 * Один запуск без единой команды — требование владельца от 2026-09-07: команды гейта он не
 * запоминает и пользоваться ими не станет, поэтому его сторона сведена к двойному клику.
 * Дальше проверяется решение, которое принимает этот единственный запуск, потому что
 * человек его уже не перепроверит.
 *
 * Опасность здесь несимметрична. Лишняя пересборка стирает работу, за которую кто-то уже
 * отчитался; пропущенная — выдаёт за проверку вердикты по коду, которого больше нет.
 */
{
  const S = gate.nextStep;
  const base = { hasRun: true, behind: 0, submittedCount: 0, pendingCount: 5, failedIds: [] };

  assert.deepStrictEqual(S({ ...base, hasRun: false }), { action: 'prepare', from: 'tag' },
    'без пакета первый запуск обязан собрать его сам');

  assert.deepStrictEqual(S(base), { action: 'handoff' },
    'свежий пакет — выдать этап, а не пересобирать');

  assert.deepStrictEqual(S({ ...base, behind: 3 }), { action: 'prepare', from: 'base' },
    'дельта уехала, сдано ничего — пересобрать, но с ТОЙ ЖЕ базой: иначе догоняющий пакет разрастается обратно до всей дельты релиза');

  assert.deepStrictEqual(S({ ...base, behind: 3, reopenedCount: 1 }), { action: 'handoff' },
    'снятый после починки вердикт — это отчёт: пересборка унесла бы след того, что дефект был');

  assert.deepStrictEqual(S({ ...base, behind: 3, submittedCount: 2, pendingCount: 3 }),
    { action: 'handoff' },
    'пересборка поверх сданного стёрла бы чужую работу — именно этого гейт и избегает');

  assert.deepStrictEqual(
    S({ ...base, behind: 2, submittedCount: 2, pendingCount: 3, failedIds: ['02-diff'] }),
    { action: 'reopen', stages: ['02-diff'] },
    'дефект починен — этап обязан уйти на повторную проверку, а не остаться FAIL навсегда');

  assert.deepStrictEqual(
    S({ ...base, behind: 0, submittedCount: 5, pendingCount: 0, failedIds: ['02-diff'] }),
    { action: 'verdict' },
    'пока код не менялся, FAIL переспрашивать нечего — это итог, а не помеха');

  assert.deepStrictEqual(S({ ...base, submittedCount: 5, pendingCount: 0 }),
    { action: 'verdict' },
    'всё сдано и дерево на месте — показать итог');

  assert.deepStrictEqual(
    S({ ...base, behind: 3, submittedCount: 5, pendingCount: 0, failedIds: ['02-diff'] }),
    { action: 'reopen', stages: ['02-diff'] },
    'пакет закрыт с дефектом: чинить надо переспросить ЗДЕСЬ, а не уводить вердикт в новый пакет');

  assert.deepStrictEqual(S({ ...base, behind: 4, submittedCount: 5, pendingCount: 0 }),
    { action: 'prepare', from: 'head' },
    'новые коммиты поверх закрытого пакета проверяются от его головы, а не от тега заново');
}

/*
 * Владелец запускает .bat двойным щелчком. Если он снова начнёт печатать в нём команды
 * по одной, вернётся ровно то, из-за чего проверку откладывали.
 */
{
  const bat = fs.readFileSync(path.join(ROOT, 'Znada-Review.bat'), 'utf8');
  const calls = bat.match(/review-gate\.js\s+\S+/g) || [];
  assert.deepStrictEqual(calls, ['review-gate.js next'],
    '.bat обязан звать ровно одну команду — next; остальное он решает сам');
  assert.ok(/--copy/.test(bat), '.bat не кладёт текст передачи в буфер обмена');
  assert.ok(/^chcp 65001/m.test(bat),
    'без UTF-8 кодовой страницы русский вывод в консоли превращается в мусор');

  const source = fs.readFileSync(GATE, 'utf8');
  assert.ok(/function copyToClipboard\(/.test(source), 'нет копирования в буфер обмена');
  assert.ok(/Text\.Encoding\]::UTF8/.test(source),
    'буфер наполняется без явного UTF-8 — кириллица в путях к пакету станет мусором');
}

/*
 * Снимок, на котором нет описанного, — худший из возможных отчётов: он выглядит проверкой.
 *
 * Как это выглядело 2026-09-08. Проверяющий сдал `04-runtime` с `pass` и описал меню карточки
 * пунктами, которых на кадре нет («Властивості», «Видалити з бібліотеки» вместо «Докладніше…»,
 * «Прибрати з бібліотеки»): он писал не то, что видел, а то, как приложение должно работать.
 * Три снимка, на которые он сослался, оказались побайтовыми копиями обычной сетки — захват
 * меню, листа подробностей и попапа назначения не сработал НИ РАЗУ.
 *
 * Поймал это только второй проход, вручную, сравнением md5. Второго прохода может не быть.
 */
{
  const G = gate.duplicateGroups;

  assert.deepStrictEqual(G([]), [], 'пустой набор снимков не порождает находок');
  assert.deepStrictEqual(
    G([{ name: 'a.png', hash: '1' }, { name: 'b.png', hash: '2' }]), [],
    'разные кадры совпадением не считаются');

  assert.deepStrictEqual(
    G([{ name: 'b.png', hash: '1' }, { name: 'a.png', hash: '1' }]),
    [['a.png', 'b.png']],
    'два одинаковых кадра обязаны попасть в находку');

  assert.deepStrictEqual(
    G([
      { name: 'c.png', hash: '1' },
      { name: 'a.png', hash: '1' },
      { name: 'b.png', hash: '1' },
    ]),
    [['a.png', 'b.png', 'c.png']],
    'группа больше двух не должна разваливаться на пары');

  assert.deepStrictEqual(
    G([
      { name: 'y.png', hash: '2' },
      { name: 'a.png', hash: '1' },
      { name: 'x.png', hash: '2' },
      { name: 'b.png', hash: '1' },
      { name: 'z.png', hash: '3' },
    ]),
    [['a.png', 'b.png'], ['x.png', 'y.png']],
    'несколько групп возвращаются устойчивым порядком — иначе вывод пляшет между запусками');

  // Мусорные записи не должны схлопываться в одну «группу пустышек».
  assert.deepStrictEqual(
    G([{ name: 'a.png' }, { name: 'b.png' }, { hash: '1' }, null]), [],
    'запись без имени или без отпечатка — не доказательство совпадения');
}

/*
 * Правила живут в тексте заданий, а текст правят не глядя. Здесь охраняется ровно то, без
 * чего случай 2026-09-08 повторится: требование писать увиденное и механическая проверка
 * совпадений.
 */
{
  const stage04 = fs.readFileSync(path.join(TEMPLATES, 'stage-04-runtime.md'), 'utf8');
  assert.ok(/ВИДНО В КАДРЕ/.test(stage04),
    'этап живого приложения больше не требует описывать именно кадр');
  assert.ok(/дословно/.test(stage04),
    'нет требования переписывать надписи с экрана дословно — вернётся пересказ по коду');
  assert.ok(/review-gate\.js evidence/.test(stage04),
    'этап не говорит, как самому проверить снимки на совпадения');
  assert.ok(/\| сценарий \| файл снимка \|/.test(stage04),
    'без таблицы «сценарий → снимок» ведущий снова будет сверять отчёт со снимками вручную');

  const brief = fs.readFileSync(path.join(TEMPLATES, 'brief.md'), 'utf8');
  assert.ok(/наблюдал, а не то, как оно должно работать/.test(brief),
    'бриф не запрещает описывать поведение по коду вместо наблюдения');

  const source = fs.readFileSync(GATE, 'utf8');
  assert.ok(/record\.evidenceDuplicates = dupes/.test(source),
    'совпадения не записываются в результат — факт останется в чужой закрытой сессии');
  assert.ok(/function warnAboutEvidence\(/.test(source),
    'ведущему агенту совпадения нигде не показываются');

  // Тело именно этой функции, а не весь файл: `submit` считает то же самое, и проверка
  // по всему тексту прошла бы даже с выпотрошенным предупреждением.
  const warnBody = source.split('function warnAboutEvidence(')[1].split('\n}')[0];
  assert.ok(!/stages/.test(warnBody),
    'предупреждение снова называет этап: каталог снимков общий на пакет, и первая версия'
    + ' указывала на 05-release, хотя снимки принёс 04-runtime');
  assert.ok(/duplicateGroups\(evidenceEntries\(id\)\)/.test(warnBody),
    'предупреждение читает только записанное поле: этапы, сданные раньше правила, останутся немыми');
}

/*
 * QA-012. Этап живого приложения обязан держать проверяющего подальше от системы владельца.
 *
 * 2026-09-19 проверяющий `04` сделал ровно то, что велело старое задание («перетащить файл…
 * файл добавлен», «светлая и тёмная тема»): добавил файл в библиотеку DIAG и переключил тему
 * Windows туда и обратно. DIAG в это время ставил обои по теме Windows — на настоящий рабочий
 * стол. Задание ничего не запрещало, потому что ничего не объясняло.
 */
{
  const stage04 = fs.readFileSync(path.join(TEMPLATES, 'stage-04-runtime.md'), 'utf8');
  assert.ok(/Не переключай тему Windows/.test(stage04), 'задание не запрещает переключать тему Windows');
  assert.ok(/Не ставь обои сам/.test(stage04), 'задание не запрещает ставить обои вручную');
  assert.ok(/Не меняй данные профиля/.test(stage04), 'задание не запрещает менять данные профиля');
  assert.ok(!/файл добавлен/.test(stage04), 'задание снова требует добавить файл в библиотеку профиля');
  assert.ok(/НЕ отпуская кнопку мыши, нажми Esc/.test(stage04),
    'перетаскивание снова заканчивается броском файла в окно, а не отменой');
  assert.ok(/владелец сам переключит/.test(stage04),
    'вторая тема снова проверяется сменой темы Windows руками проверяющего');

  // Проверка до запуска: таблица полей обязана говорить правду о том, что делает запуск.
  assert.ok(/только прочитай/.test(stage04), 'задание не велит проверить профиль до запуска');
  // Решение владельца 2026-09-24: обои, поставленные самим запуском, не повод блокировать проверку
  // на реалистичном профиле; тема Windows — повод.
  assert.ok(/Обои, которые приложение ставит само, разрешены/.test(stage04),
    'задание снова блокирует реалистичный профиль из-за обоев, которые владелец разрешил');
  assert.ok(/`themeSchedule\.mode` не `off` — не запускай/.test(stage04),
    'задание больше не останавливает запуск, который сам переключит тему Windows');
  for (const field of ['slideshow.enabled', 'separateThemes', 'wallpaperSchedule.mode', 'themeSchedule.mode']) {
    assert.ok(stage04.includes('`' + field + '`'), 'в проверке до запуска нет поля ' + field);
  }
  const { wallpaperStartupAction } = require('../src/schedule');
  const quiet = { slideshow: { enabled: false }, separateThemes: true, wallpaperSchedule: { mode: 'off' } };
  assert.strictEqual(wallpaperStartupAction(quiet), 'none',
    'профиль, который задание называет безопасным, всё равно ставит обои при запуске');
  for (const [name, patch] of [
    ['slideshow.enabled', { slideshow: { enabled: true } }],
    ['separateThemes', { separateThemes: false }],
    ['wallpaperSchedule.mode system', { wallpaperSchedule: { mode: 'system' } }],
    ['wallpaperSchedule.mode time', { wallpaperSchedule: { mode: 'time' } }],
    ['wallpaperSchedule.mode sun', { wallpaperSchedule: { mode: 'sun' } }],
  ]) {
    assert.notStrictEqual(wallpaperStartupAction({ ...quiet, ...patch }), 'none',
      'задание пугает полем ' + name + ', а запуск с ним обоев не ставит — таблица разошлась с кодом');
  }

  const brief = fs.readFileSync(path.join(TEMPLATES, 'brief.md'), 'utf8');
  assert.ok(/Не переключать тему Windows и не ставить обои вручную/.test(brief),
    'бриф не запрещает трогать тему и обои владельца');
  assert.ok(/Список ведущего/.test(brief), 'бриф не говорит, где искать список ведущего');
}

/*
 * QA-012. Список ведущего должен попадать в само задание: 2026-09-19 он до проверяющего `04`
 * не дошёл, потому что в передаче ему не было места. Проверяется настоящая сборка текста
 * пакета во временном каталоге, а не наличие слов в исходнике.
 */
{
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-checks-'));
  const next = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-checks-next-'));
  try {
    const run = {
      base: 'v0', head: 'abc1234', stat: '', fileCount: 1, dirtyCount: 0,
      stages: gate.STAGES.map((s) => ({ id: s.id, title: s.title, needs: s.needs, cost: s.cost })),
    };
    const list = '1. Меню карточки: пункт «Докладніше…» открывает лист.';
    fs.mkdirSync(path.join(tmp, 'checks'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'checks', '04-runtime.md'), list + '\n');
    gate.writePacketText(tmp, 'test-run', run, ['renderer/renderer.js']);

    const stage = (dir, id) => fs.readFileSync(path.join(dir, 'stages', id + '.md'), 'utf8');
    // QA-016: the worker reads the generated packet, not the contributor contract.
    // Keep the live-profile prohibition and link cleanup order in the delivered text.
    const brief = fs.readFileSync(path.join(tmp, 'BRIEF.md'), 'utf8').replace(/\s+/g, ' ');
    const runtime = stage(tmp, '04-runtime').replace(/\s+/g, ' ');
    for (const [name, text] of [['BRIEF', brief], ['04-runtime', runtime]]) {
      assert.ok(/На живом DEV\/DIAG окно переноса не открывать/.test(text),
        name + ': QA-016 потерян запрет окна переноса на живом профиле');
      assert.ok(/только на расходном профиле с расходными файлами/.test(text),
        name + ': QA-016 перенос больше не требует расходных файлов и профиля');
    }
    assert.ok(/собственная `npm ci`/.test(brief), 'BRIEF: QA-016 нет безопасного варианта установки');
    assert.ok(/абсолютные пути/.test(brief) && /junction\/symlink/.test(brief),
      'BRIEF: QA-016 не требуется проверить пути и тип node_modules');
    assert.ok(/сначала удалить только саму ссылку[\s\S]*целевая папка[\s\S]*сохранились[\s\S]*затем `git worktree remove`/.test(brief),
      'BRIEF: QA-016 потерян порядок: ссылка, проверка целевой папки, удаление worktree');
    assert.ok(/не удалять рекурсивно/.test(brief), 'BRIEF: QA-016 потерян запрет рекурсивного удаления ссылки');
    assert.ok(stage(tmp, '04-runtime').includes(list), 'список ведущего не попал в задание своего этапа');
    assert.ok(/Обязателен каждый пункт/.test(stage(tmp, '04-runtime')), 'список не назван обязательным');
    assert.ok(!stage(tmp, '02-diff').includes(list), 'список одного этапа попал в задание другого');
    assert.ok(/отдельного списка для этого этапа не передал/.test(stage(tmp, '02-diff')),
      'без списка задание молчит — проверяющий не отличит «списка нет» от «его потеряли»');

    // Пересборка с той же базой (next, дерево ушло вперёд, никто не отчитывался) список не теряет.
    const carried = gate.copyLeadChecks(tmp, next, run.stages.map((s) => s.id));
    assert.deepStrictEqual(carried, ['04-runtime'], 'при пересборке пакета список ведущего потерялся');
    gate.writePacketText(next, 'test-run-2', run, ['renderer/renderer.js']);
    assert.ok(stage(next, '04-runtime').includes(list), 'перенесённый список не попал в новое задание');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(next, { recursive: true, force: true });
  }

  const source = fs.readFileSync(GATE, 'utf8');
  assert.ok(/carryChecksFrom: step\.from === 'base' \? id : ''/.test(source),
    'next пересобирает пакет с той же базой, но список ведущего с собой не берёт');
  assert.ok(source.includes("'  в задании есть список проверок от ведущего — каждый его пункт обязателен'"),
    'текст передачи не говорит, что в задании есть список ведущего');
}

/*
 * QA-018: пакет от тега не собирается, пока выпуск не подготовлен. 2026-10-09 гейт 1.7.7
 * начали до подготовки: этап 05 упал на старом номере, а починка потянула второй пакет на
 * все пять этапов. Сначала правило по фактам, затем настоящий `prepare` во временном
 * репозитории — чистая функция без проводки в prepare ничего не защищает.
 */
{
  assert.ok(gate.versionNewer('1.7.10', 'v1.7.9'), 'версии сравниваются как числа, а не как строки');
  assert.ok(gate.versionNewer('1.8.0', 'v1.7.9'));
  assert.ok(!gate.versionNewer('1.7.6', 'v1.7.6'), 'тот же номер — не новее');
  assert.ok(!gate.versionNewer('1.7.5', 'v1.7.6'));
  assert.ok(!gate.versionNewer('1.7.7', 'nightly'), 'нечитаемый тег не делает версию новее');
  assert.strictEqual(gate.releaseTextName('1.7.7'), 'release_text_1_7_7.md');

  const ready = { version: '1.7.7', tag: 'v1.7.6', translationsLeft: 0, releaseText: true };
  assert.deepStrictEqual(gate.releasePrepGaps(ready), [], 'подготовленный выпуск задержан');
  const gaps = (over) => gate.releasePrepGaps({ ...ready, ...over }).join('\n');
  assert.ok(/не больше последнего выпуска v1\.7\.6/.test(gaps({ version: '1.7.6' })), 'старый номер не пойман');
  assert.ok(/не больше/.test(gaps({ version: '1.7.5' })), 'номер меньше выпущенного не пойман');
  assert.ok(/не читается/.test(gaps({ version: 'x' })), 'нечитаемый номер не пойман');
  assert.ok(/переводы не закончены: 9/.test(gaps({ translationsLeft: 9 })), 'хвост переводов не пойман');
  assert.ok(/не прочиталось/.test(gaps({ translationsLeft: null })), 'непрочитанные переводы сочтены готовыми');
  assert.ok(/release_text_1_7_7\.md/.test(gaps({ releaseText: false })), 'нет текста выпуска — не пойман');

  const real = gate.readReleasePrep('v0.0.0');
  assert.strictEqual(real.version, require(path.join(ROOT, 'package.json')).version, 'версия читается не оттуда');
  assert.strictEqual(typeof real.translationsLeft, 'number', 'состояние переводов настоящего дерева не прочиталось');
}

{
  const { spawnSync, execFileSync } = require('child_process');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa018-'));
  const copy = (rel) => fs.cpSync(path.join(ROOT, rel), path.join(tmp, rel), { recursive: true });
  const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false',
    '-c', 'tag.gpgSign=false', '-c', 'commit.gpgSign=false', ...args], { cwd: tmp, stdio: 'pipe' });
  const setVersion = (v) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ ...pkg, version: v }, null, 2) + '\n');
  };
  const runGate = (...args) => spawnSync(process.execPath, [path.join(tmp, 'scripts', 'review-gate.js'), ...args],
    { cwd: tmp, encoding: 'utf8' });
  const packets = () => {
    const dir = path.join(tmp, '.tmp', 'review');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n !== 'current.txt') : [];
  };
  try {
    for (const rel of ['scripts/review-gate.js', 'scripts/review-gate', 'src/i18n-state.js',
      'locales/en.json', 'locales/ru.json', 'locales/de.json', 'locales/state/de.json']) copy(rel);
    setVersion('1.7.7');
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'released');
    g('tag', 'v1.7.7');
    fs.writeFileSync(path.join(tmp, 'main.js'), '// changed after the release\n');
    // Хвост переводов: в немецком не хватает строки, которая есть в en/ru.
    const de = JSON.parse(fs.readFileSync(path.join(tmp, 'locales', 'de.json'), 'utf8'));
    const firstGroup = Object.keys(de).find((k) => de[k] && typeof de[k] === 'object' && !Array.isArray(de[k]));
    delete de[firstGroup][Object.keys(de[firstGroup])[0]];
    fs.writeFileSync(path.join(tmp, 'locales', 'de.json'), JSON.stringify(de, null, 2) + '\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'work');

    let res = runGate('prepare', '--by', 't');
    assert.strictEqual(res.status, 1, 'пакет от тега собран без подготовки выпуска:\n' + res.stdout + res.stderr);
    assert.ok(/не подготовлен/.test(res.stderr) && /не больше последнего выпуска v1\.7\.7/.test(res.stderr)
      && /переводы не закончены/.test(res.stderr) && /release_text_1_7_7\.md/.test(res.stderr),
      'отказ не называет, чего не хватает:\n' + res.stderr);
    assert.ok(/подготовь выпуск/.test(res.stderr), 'отказ не говорит владельцу, что делать дальше');
    assert.deepStrictEqual(packets(), [], 'отказ всё равно оставил пакет');

    res = runGate('next');
    assert.strictEqual(res.status, 1, 'Znada-Review.bat (next) обошёл проверку подготовки');
    assert.deepStrictEqual(packets(), [], 'next без подготовки оставил пакет');

    // Явная база — не проверка выпуска (догоняющий пакет, проверка ветки): её не задерживаем.
    res = runGate('prepare', '--by', 't', '--base', 'v1.7.7');
    assert.strictEqual(res.status, 0, 'явный --base задержан проверкой выпуска:\n' + res.stderr);
    assert.strictEqual(packets().length, 1, 'пакет с явной базой не собран');
    fs.rmSync(path.join(tmp, '.tmp'), { recursive: true, force: true });

    // Подготовка сделана: номер выше, перевод на месте. Текст выпуска сначала только в архиве
    // (так лежат уже опубликованные), затем только среди текущих постановок — оба места считаются.
    setVersion('1.7.8');
    copy('locales/de.json');
    const archived = path.join(tmp, 'plans', 'archive', 'releases', 'release_text_1_7_8.md');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.writeFileSync(archived, '# 1.7.8\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'prepare the release');
    res = runGate('prepare', '--by', 't');
    assert.strictEqual(res.status, 0, 'текст выпуска в архиве не засчитан:\n' + res.stderr);
    assert.strictEqual(packets().length, 1, 'после подготовки (текст в архиве) пакет не собран');
    fs.rmSync(path.join(tmp, '.tmp'), { recursive: true, force: true });

    fs.rmSync(path.join(tmp, 'plans', 'archive'), { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'plans', 'features'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'plans', 'features', 'release_text_1_7_8.md'), '# 1.7.8\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'release text back in features');
    res = runGate('prepare', '--by', 't');
    assert.strictEqual(res.status, 0, 'подготовленный выпуск не пустили в гейт:\n' + res.stderr);
    assert.strictEqual(packets().length, 1, 'после подготовки пакет не собран');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('review-gate: ok');
