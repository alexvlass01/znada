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

/* Этап без объявленной способности нельзя раздать: исполнитель не поймёт, тянет ли он его. */
{
  for (const stage of gate.STAGES) {
    assert.ok(stage.needs && stage.cost, stage.id + ': не объявлены нужная способность и цена');
    assert.ok(stage.always || typeof stage.when === 'function',
      stage.id + ': этап ни всегдашний, ни условный — он не попадёт ни в один пакет');
  }
}

console.log('review-gate: ok');
