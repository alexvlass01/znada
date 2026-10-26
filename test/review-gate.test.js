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
const { makeTempDir } = require('./helpers/temp-dir');

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
  assert.deepStrictEqual(S({ hasRun: false }), { action: 'prepare', from: 'tag' });
  for (const behind of [0, 3, 9]) {
    assert.deepStrictEqual(S({ hasRun: true, behind, pendingCount: 2 }), { action: 'handoff' },
      'an active packet must preserve results, including when fixes advance HEAD');
    assert.deepStrictEqual(S({ hasRun: true, behind, pendingCount: 0 }), { action: 'verdict' },
      'no second packet for a revision already covered by all stages');
  }
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
  const tmp = makeTempDir('review-gate-checks-');
  const next = makeTempDir('review-gate-checks-next-');
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
  assert.deepStrictEqual(gate.nextStep({ hasRun: true, pendingCount: 1, behind: 9 }), { action: 'handoff' },
    'next должен сохранить существующий пакет вместе со списком ведущего');
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

  const ready = { version: '1.7.7', tag: 'v1.7.6', translationsLeft: 0, releaseText: true, whatsNewGaps: [] };
  assert.deepStrictEqual(gate.releasePrepGaps(ready), [], 'подготовленный выпуск задержан');
  const gaps = (over) => gate.releasePrepGaps({ ...ready, ...over }).join('\n');
  assert.ok(/не больше последнего выпуска v1\.7\.6/.test(gaps({ version: '1.7.6' })), 'старый номер не пойман');
  assert.ok(/не больше/.test(gaps({ version: '1.7.5' })), 'номер меньше выпущенного не пойман');
  assert.ok(/не читается/.test(gaps({ version: 'x' })), 'нечитаемый номер не пойман');
  assert.ok(/переводы не закончены: 9/.test(gaps({ translationsLeft: 9 })), 'хвост переводов не пойман');
  assert.ok(/не прочиталось/.test(gaps({ translationsLeft: null })), 'непрочитанные переводы сочтены готовыми');
  assert.ok(/release_text_1_7_7\.md/.test(gaps({ releaseText: false })), 'нет текста выпуска — не пойман');
  // DESIGN-012: текст окна «Что нового» — часть подготовки, непрочитанный не считается готовым.
  assert.ok(/Что нового.*нет текста 1\.7\.7 на языке ru/.test(gaps({ whatsNewGaps: ['нет текста 1.7.7 на языке ru'] })),
    'нехватка «Что нового» не названа');
  assert.ok(/«Что нового».*не прочитался/.test(gaps({ whatsNewGaps: null })), 'непрочитанный «Что нового» сочтён готовым');
  assert.ok(/не прочитался/.test(gaps({ whatsNewGaps: undefined })), 'отсутствие факта о «Что нового» сочтено готовностью');

  const real = gate.readReleasePrep('v0.0.0');
  assert.strictEqual(real.version, require(path.join(ROOT, 'package.json')).version, 'версия читается не оттуда');
  assert.strictEqual(typeof real.translationsLeft, 'number', 'состояние переводов настоящего дерева не прочиталось');
  assert.ok(Array.isArray(real.whatsNewGaps), '«Что нового» настоящего дерева не прочитался');
}

{
  const { spawnSync, execFileSync } = require('child_process');
  const tmp = makeTempDir('qa018-');
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
      'locales/en.json', 'locales/ru.json', 'locales/de.json', 'locales/state/de.json',
      'src/whats-new.js']) copy(rel);
    const writeWhatsNew = (data) => fs.writeFileSync(path.join(tmp, 'src', 'whats-new.json'), JSON.stringify(data));
    const note = [{ title: 't', text: 'x' }];
    writeWhatsNew({ '1.7.7': { en: note } }); // русского текста ещё нет
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
      && /переводы не закончены/.test(res.stderr) && /release_text_1_7_7\.md/.test(res.stderr)
      && /«Что нового».*нет текста 1\.7\.7 на языке ru/.test(res.stderr),
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
    // I18N-003 leaves the new plural forms out of the other catalogues on purpose.
    // This scenario is "the translation tail is closed", so the fixture fills those
    // leaves itself. The live de.json stays missing them until the freshness pass.
    {
      const i18n = require(path.join(ROOT, 'src', 'i18n-state'));
      const read = (rel) => JSON.parse(fs.readFileSync(path.join(tmp, rel), 'utf8'));
      const enDict = read('locales/en.json');
      const ruDict = read('locales/ru.json');
      const deDict = read('locales/de.json');
      const fill = (target, source) => {
        for (const [key, value] of Object.entries(source)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
            fill(target[key], value);
          } else if (typeof target[key] !== 'string' || target[key] === '') {
            target[key] = value;
          }
        }
      };
      fill(deDict, enDict);
      fs.writeFileSync(path.join(tmp, 'locales', 'de.json'), JSON.stringify(deDict, null, 2) + '\n');
      const recorded = i18n.buildState({
        enDict, ruDict, langDict: deDict, lang: 'de',
        at: '2026-10-14T00:00:00.000Z', verification: 'mechanical',
      });
      fs.writeFileSync(path.join(tmp, 'locales', 'state', 'de.json'), JSON.stringify(recorded, null, 2) + '\n');
    }
    const archived = path.join(tmp, 'plans', 'archive', 'releases', 'release_text_1_7_8.md');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.writeFileSync(archived, '# 1.7.8\n');
    writeWhatsNew({ '1.7.7': { en: note }, '1.7.8': { en: note, ru: note } });
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



/* QA-025: a repeat FAIL at the fixed revision must not reopen itself forever. */
{
  const state = { hasRun: true, behind: 9, submittedCount: 5, pendingCount: 0,
    failedIds: ['02-diff'], coverageKnown: true };
  assert.deepStrictEqual(gate.nextStep(state), { action: 'verdict' },
    'a result already covering current HEAD must finish in the same packet');
  assert.deepStrictEqual(gate.nextStep({ ...state, pendingCount: 2 }), { action: 'handoff' },
    'only stages with unchecked scope are assigned, without erasing reports');
}

/* QA-025: exercise the real CLI, including legacy records and revision drift. */
{
  const { spawnSync, execFileSync } = require('child_process');
  const tmp = makeTempDir('qa025-coverage-');
  const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t',
    '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', ...args], { cwd: tmp, encoding: 'utf8' }).trim();
  const cli = (...args) => spawnSync(process.execPath, [path.join(tmp, 'scripts/review-gate.js'), ...args],
    { cwd: tmp, encoding: 'utf8' });
  const ok = (...args) => { const r = cli(...args); assert.strictEqual(r.status, 0, r.stdout + r.stderr); return r.stdout; };
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.copyFileSync(GATE, path.join(tmp, 'scripts/review-gate.js'));
    fs.cpSync(TEMPLATES, path.join(tmp, 'scripts/review-gate'), { recursive: true });
    for (const rel of ['src/i18n-state.js', 'src/whats-new.js']) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
    }
    fs.mkdirSync(path.join(tmp, 'locales'), { recursive: true });
    for (const lang of ['en', 'ru']) fs.writeFileSync(path.join(tmp, 'locales', lang + '.json'), '{}');
    fs.writeFileSync(path.join(tmp, '.gitignore'), '.tmp/\n');
    fs.writeFileSync(path.join(tmp, 'main.js'), '// baseline\n');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}\n');
    g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'baseline');
    g('-c', 'tag.gpgSign=false', 'tag', 'v1.7.7');
    g('commit', '--allow-empty', '-qm', 'explicit review base after the older release tag');
    const base = g('rev-parse', 'HEAD');
    fs.appendFileSync(path.join(tmp, 'main.js'), '// feature\n');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"1.8.0"}\n');
    g('add', '-A'); g('commit', '-qm', 'feature');
    const firstHead = g('rev-parse', 'HEAD');
    ok('prepare', '--by', 'author', '--base', base);
    const pointer = path.join(tmp, '.tmp/review/current.txt');
    const id = fs.readFileSync(pointer, 'utf8').trim();
    const root = path.join(tmp, '.tmp/review', id);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'run.json'), 'utf8'));
    const putReport = (stage, label) => {
      const report = 'results/' + stage + '-' + label + '.md';
      fs.writeFileSync(path.join(root, report), 'Inspected ' + label); return report;
    };
    const submit = (stage, verdict, head, label) => ok('submit', stage, '--verdict', verdict,
      '--by', 'reviewer', '--head', head, '--report', putReport(stage, label));
    for (const stage of manifest.stages) submit(stage.id, stage.id === '02-diff' ? 'fail' : 'pass', firstHead, 'first');
    assert.strictEqual(cli('next').status, 2, 'unchanged FAIL must remain final, not reassign itself');
    const old02 = fs.readFileSync(path.join(root, 'results/02-diff-first.md'), 'utf8');
    // F2: BLOCKED is pending even at the very same revision.
    submit('05-release', 'blocked', firstHead, 'blocked-same-head');
    assert.ok(ok('next').includes('  05-release —'), 'same-SHA BLOCKED was not assigned');
    submit('05-release', 'pass', firstHead, 'blocked-recovered');
    // F2: explicit reopen must retain the previous result and report.
    const releaseRecord = JSON.parse(fs.readFileSync(path.join(root, 'results/05-release.json')));
    const historyDir = path.join(root, 'history/05-release');
    const historyBefore = fs.readdirSync(historyDir).length;
    ok('reopen', '05-release', '--why', 'exercise archive retention');
    const historyAfter = fs.readdirSync(historyDir);
    assert.strictEqual(historyAfter.length, historyBefore + 1, 'reopen lost the previous verdict');
    assert.ok(historyAfter.some((name) => JSON.parse(fs.readFileSync(path.join(historyDir, name))).report
      === releaseRecord.report));
    assert.ok(fs.existsSync(path.join(root, releaseRecord.report)));
    submit('05-release', 'pass', firstHead, 'manual-recheck');
    // F2: a previously used report cannot be reused, even if it still exists.
    const usedReport = 'results/05-release-manual-recheck.md';
    const overwrite = cli('submit', '05-release', '--head', firstHead, '--report', usedReport,
      '--verdict', 'pass', '--by', 'reviewer');
    assert.strictEqual(overwrite.status, 1, 'submit allowed overwriting the previous report');
    const historical = cli('submit', '05-release', '--head', firstHead,
      '--report', 'results/05-release-first.md', '--verdict', 'pass', '--by', 'reviewer');
    assert.strictEqual(historical.status, 1, 'submit allowed reuse of an older archived report');
    const missingSha = cli('submit', '05-release', '--head', 'f'.repeat(40),
      '--report', 'results/05-release-unknown.md', '--verdict', 'pass', '--by', 'reviewer');
    assert.strictEqual(missingSha.status, 1);
    assert.ok(missingSha.stderr.includes('проверенный SHA не найден') && !missingSha.stderr.includes('at checkExecSyncError'));
    const otherStage = cli('submit', '05-release', '--head', firstHead,
      '--report', 'results/02-diff-first.md', '--verdict', 'pass', '--by', 'reviewer');
    assert.strictEqual(otherStage.status, 1, 'submit allowed the report of another stage');

    assert.strictEqual(cli('prepare', '--new', '--afterRelease', '--by', 'author', '--base', base).status, 1,
      'public --afterRelease bypassed the restart guard');
    assert.strictEqual(cli('prepare', '--new', '--by', 'author', '--base', base).status, 1,
      'a full restart of the failed packet was allowed without a reason');
    assert.strictEqual(cli('prepare', '--by', 'author', '--base', base).status, 1,
      'plain prepare restarted a fully submitted FAIL packet');
    assert.strictEqual(fs.readFileSync(pointer, 'utf8').trim(), id);
    // F1: a known data failure may be fixed outside the stage's static path list.
    submit('03-data', 'fail', firstHead, 'outside-path-failure');
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src/bookmark-store.js'), '// fix outside DATA_PATHS\n');
    g('add', '-A'); g('commit', '-qm', 'fix outside data path classifier');
    const outsideHead = g('rev-parse', 'HEAD');
    submit('01-automated', 'pass', outsideHead, 'outside-rechecked');
    submit('02-diff', 'pass', outsideHead, 'outside-rechecked');
    const outside = ok('next');
    assert.ok(outside.includes('  03-data —') && outside.includes('Предыдущий отчёт:'),
      'FAIL outside DATA_PATHS was stuck or lost its previous report');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'results/03-data.json'))).verdict, 'fail');
    submit('03-data', 'fail', outsideHead, 'outside-repeat-fail');
    assert.strictEqual(cli('next').status, 2, 'repeat FAIL without new changes was assigned again');
    // Leave the original diff finding open for the rest of this scenario.
    submit('02-diff', 'fail', outsideHead, 'original-diff-still-open');
    // A source fix affects 01/02/03/04; release verification remains credited.
    fs.appendFileSync(path.join(tmp, 'main.js'), '// fix\n');
    g('add', '-A'); g('commit', '-qm', 'fix');
    const fixedHead = g('rev-parse', 'HEAD');
    const text = ok('next');
    assert.ok(text.includes('01-automated') && text.includes('непроверенная дельта'), text);
    assert.strictEqual(fs.readFileSync(pointer, 'utf8').trim(), id, 'fix created another packet');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'results/02-diff.json'))).verdict, 'fail',
      'assignment erased the defect');
    assert.strictEqual(cli('verdict').status, 2, 'unfixed FAIL must still block release');
    // A stale handoff cannot silently credit the newer HEAD.
    let r = cli('submit', '02-diff', '--verdict', 'pass', '--by', 'reviewer', '--head', firstHead,
      '--report', putReport('02-diff', 'drift'));
    assert.strictEqual(r.status, 1); assert.ok(r.stderr.includes('HEAD изменился'), r.stderr);
    r = cli('submit', '02-diff', '--verdict', 'pass', '--by', 'reviewer');
    assert.strictEqual(r.status, 1); assert.ok(r.stderr.includes('--head'), r.stderr);
    fs.appendFileSync(path.join(tmp, 'main.js'), '// uncommitted\n');
    r = cli('submit', '02-diff', '--verdict', 'pass', '--by', 'reviewer', '--head', fixedHead,
      '--report', putReport('02-diff', 'dirty'));
    assert.strictEqual(r.status, 1); assert.ok(r.stderr.includes('незакоммиченные'), r.stderr);
    g('checkout', '--', 'main.js');
    // Repeat FAIL at fixedHead: keep that result and move to other pending work.
    submit('02-diff', 'fail', fixedHead, 'repeat-fail');
    assert.ok(!ok('next').includes('дефект, скорее всего, починен'));
    const repeat = JSON.parse(fs.readFileSync(path.join(root, 'results/02-diff.json')));
    assert.strictEqual(repeat.checkedHead, fixedHead);
    assert.strictEqual(repeat.verdict, 'fail');
    const assignment = ok('handoff', '02-diff', '--raw');
    assert.ok(assignment.includes('git diff ' + fixedHead + '..' + fixedHead));
    assert.ok(assignment.includes('если прежний отчёт оставил часть этапа'));
    // Final fix: complete each affected stage once at the actual fixed revision.
    fs.appendFileSync(path.join(tmp, 'main.js'), '// final fix\n');
    g('add', '-A'); g('commit', '-qm', 'final fix');
    const finalHead = g('rev-parse', 'HEAD');
    for (const stage of ['01-automated', '02-diff', '03-data', '04-runtime']) submit(stage, 'pass', finalHead, 'final');
    assert.ok(ok('next').includes('ИТОГ: PASS'), 'completed audit did not finish');
    fs.appendFileSync(path.join(tmp, 'main.js'), '// dirty after all PASS\n');
    const dirtyVerdict = cli('verdict');
    assert.strictEqual(dirtyVerdict.status, 3, 'verdict accepted dirty code after all PASS');
    assert.ok(dirtyVerdict.stdout.includes('незакоммиченные изменения'));
    g('checkout', '--', 'main.js');
    assert.strictEqual(cli('prepare', '--by', 'author', '--base', base).status, 1,
      'plain prepare restarted the completed audit before its release');
    assert.strictEqual(fs.readFileSync(pointer, 'utf8').trim(), id, 'completed recheck created a follow-up packet');
    assert.strictEqual(fs.readFileSync(path.join(root, 'results/02-diff-first.md'), 'utf8'), old02);
    assert.ok(fs.readdirSync(path.join(root, 'history/02-diff')).length >= 2, 'previous FAIL records were lost');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'results/05-release.json'))).checkedHead, firstHead,
      'unaffected release stage should retain its own checked revision');
    const dataResultPath = path.join(root, 'results/03-data.json');
    const dataResultBytes = fs.readFileSync(dataResultPath);
    const unrelated = g('commit-tree', base + '^{tree}', '-m', 'unrelated reviewed history');
    const foreignResult = JSON.parse(dataResultBytes); foreignResult.checkedHead = unrelated;
    fs.writeFileSync(dataResultPath, JSON.stringify(foreignResult));
    const rewritten = cli('status');
    assert.strictEqual(rewritten.status, 1);
    assert.ok(rewritten.stderr.includes('отсутствует в истории текущей ревизии')
      && !rewritten.stderr.includes('at checkExecSyncError'));
    fs.writeFileSync(dataResultPath, dataResultBytes);
    // Legacy records are credited only to creation HEAD, never to the current checkout.
    const legacyPath = path.join(root, 'results/01-automated.json');
    const legacy = JSON.parse(fs.readFileSync(legacyPath)); delete legacy.checkedHead;
    fs.writeFileSync(legacyPath, JSON.stringify(legacy));
    assert.strictEqual(cli('verdict').status, 3, 'legacy PASS was incorrectly promoted to a newer revision');
    assert.ok(ok('next').includes('01-automated'));
    submit('01-automated', 'pass', finalHead, 'legacy-rechecked');
    assert.ok(ok('next').includes('ИТОГ: PASS'));
    // F2: publishing a tag on an uncovered commit cannot discard the active audit.
    fs.appendFileSync(path.join(tmp, 'main.js'), '// uncovered tagged code\n');
    g('add', '-A'); g('commit', '-qm', 'uncovered release commit');
    const tagHead = g('rev-parse', 'HEAD');
    g('-c', 'tag.gpgSign=false', 'tag', 'v1.8.0');
    fs.appendFileSync(path.join(tmp, 'main.js'), '// work after uncovered tag\n');
    g('add', '-A'); g('commit', '-qm', 'post-tag work before review');
    ok('next');
    assert.strictEqual(fs.readFileSync(pointer, 'utf8').trim(), id, 'uncovered tag reset the audit');
    g('checkout', '--detach', tagHead);
    for (const stage of ['01-automated', '02-diff', '03-data', '04-runtime']) submit(stage, 'pass', tagHead, 'tag-covered');
    // No changes after an already checked release tag: show the finished audit.
    assert.ok(ok('next').includes('ИТОГ: PASS'), 'tagging a covered HEAD tried to prepare another release');
    // A real subsequent release uses a new package only AFTER the covered release is tagged.
    g('checkout', '-');
    fs.appendFileSync(path.join(tmp, 'main.js'), '// next release work\n');
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"version":"1.8.1"}\n');
    const note = [{ title: 't', text: 'x' }];
    fs.writeFileSync(path.join(tmp, 'src/whats-new.json'), JSON.stringify({ '1.8.1': { en: note, ru: note } }));
    fs.mkdirSync(path.join(tmp, 'plans', 'features'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'plans', 'features', gate.releaseTextName('1.8.1')), '# 1.8.1\n');
    g('add', '-A'); g('commit', '-qm', 'next release');
    ok('next');
    const nextId = fs.readFileSync(pointer, 'utf8').trim();
    assert.notStrictEqual(nextId, id, 'a published release did not start a new release package');
    const nextRun = JSON.parse(fs.readFileSync(path.join(tmp, '.tmp/review', nextId, 'run.json')));
    assert.strictEqual(nextRun.base, 'v1.8.0', 'normal .bat path did not use the last published tag');
    // New risks add stages in-place, even when the original package lacked them.
    const minimal = { ...nextRun, stages: nextRun.stages.filter((stage) => ['01-automated', '02-diff'].includes(stage.id)) };
    fs.writeFileSync(path.join(tmp, '.tmp/review', nextId, 'run.json'), JSON.stringify(minimal));
    ok('next');
    const expanded = JSON.parse(fs.readFileSync(path.join(tmp, '.tmp/review', nextId, 'run.json')));
    assert.ok(expanded.stages.some((stage) => stage.id === '03-data'));
    assert.ok(expanded.stages.some((stage) => stage.id === '04-runtime'));
    assert.strictEqual(fs.readFileSync(pointer, 'utf8').trim(), nextId);
    const nextRoot = path.join(tmp, '.tmp/review', nextId);
    const currentHead = g('rev-parse', 'HEAD');
    const initialHandoff = ok('handoff', '01-automated', '--raw');
    const blockedReport = /--report "([^"]+)"/.exec(initialHandoff)[1];
    fs.writeFileSync(path.join(nextRoot, blockedReport), 'GUI unavailable');
    ok('submit', '01-automated', '--head', currentHead, '--report', blockedReport,
      '--verdict', 'blocked', '--by', 'reviewer');
    const retryText = ok('handoff', '01-automated', '--raw');
    const retryReport = /--report "([^"]+)"/.exec(retryText)[1];
    assert.notStrictEqual(retryReport, blockedReport, 'same-SHA BLOCKED retry reused its generated report name');
    fs.writeFileSync(path.join(nextRoot, retryReport), 'GUI access recovered, same code');
    ok('submit', '01-automated', '--head', currentHead, '--report', retryReport,
      '--verdict', 'pass', '--by', 'reviewer');
    assert.ok(fs.existsSync(path.join(nextRoot, blockedReport)));
    assert.strictEqual(fs.readFileSync(path.join(nextRoot, blockedReport), 'utf8'), 'GUI unavailable');

  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

console.log('review-gate: ok');
