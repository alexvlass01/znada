'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'scripts', 'random-task.js');

// Приватный инструмент владельца, в публичный экспорт не уходит — тот же приём, что в
// install-check: пропустить там, где его не должно быть, и упасть, если он пропал из private.
if (!fs.existsSync(TOOL)) {
  if (fs.existsSync(path.join(ROOT, 'AGENTS.md'))) {
    throw new Error('private canonical checkout is missing required scripts/random-task.js');
  }
  console.log('SKIP random-task: private owner-only tool is absent from this checkout.');
  process.exit(0);
}

const { openBacklogTasks, pickNumber } = require(TOOL);

const SAMPLE = [
  '## NEEDS OWNER',
  '| `HIST-001` | Решение владельца | ждёт |',
  '## BACKLOG',
  '### Библиотека',
  '| `LIB-001` | **Открытая** задача | описание |',
  // Слово «слито/принято» в тексте открытой записи про прошлый этап её не закрывает — скрипт закрытость не угадывает.
  '| `LIB-002` | Платформа | **Платформа открыта, первая версия слита (PR #290).** Дальше. |',
  '| `LIB-005` | Идея | **Черновая идея 2026-10-24.** |',
  '| `DESIGN-010b` | Подзадача | открыта |',
  '### Данные',
  '| `DATA-001` | Бэкап | открыта |',
  '## Постоянные инженерные границы',
  '| `ENG-001` | не задача | |',
].join('\r\n');

const tasks = openBacklogTasks(SAMPLE);
assert.deepStrictEqual(tasks.map((t) => t.id), ['LIB-001', 'LIB-002', 'DESIGN-010b', 'DATA-001'],
  'в жребий попали черновые или задачи вне BACKLOG');
assert.strictEqual(tasks[0].title, 'Открытая задача');
assert.strictEqual(tasks[3].group, 'Данные');

// Случайный номер всегда в 1..n, включая обе границы.
assert.strictEqual(pickNumber(3, undefined, (lo, hi) => { assert.deepStrictEqual([lo, hi], [1, 4]); return 3; }), 3);
assert.strictEqual(pickNumber(3, 2), 2);
assert.throws(() => pickNumber(3, 4), /от 1 до 3/);
assert.throws(() => pickNumber(3, 0), /от 1 до 3/);
assert.throws(() => pickNumber(3, NaN), /от 1 до 3/);
assert.throws(() => pickNumber(0), /нет открытых/);

// Настоящий ROADMAP разбирается и даёт непустой список без дублей.
const real = openBacklogTasks(fs.readFileSync(path.join(ROOT, 'ROADMAP.md'), 'utf8'));
assert.ok(real.length > 0, 'в настоящем ROADMAP не нашлось ни одной открытой задачи');
assert.strictEqual(new Set(real.map((t) => t.id)).size, real.length, 'одна задача попала в список дважды');

// Реестр хранит только открытое (решение владельца 2026-11-14): закрытой записи в ROADMAP нет, а охранник
// распознаёт старые и новые формулировки и не принимает за закрытую открытую запись с описанием слитого этапа.
const { closedEntries } = require(path.join(ROOT, 'plans', 'tools', 'roadmap-closed.js'));
const roadmapText = fs.readFileSync(path.join(ROOT, 'ROADMAP.md'), 'utf8');
assert.deepStrictEqual(closedEntries(roadmapText), [], 'в ROADMAP.md остались закрытые записи — перенеси их в архив');
const sample = (line) => closedEntries(line).length;
for (const closed of [
  '| `A-1` | t | **ЗАКРЫТО 2026-10-01 через PR #1** |',
  '| `A-2` | t | **Сделано, PR #311 слит 2026-11-07** |',
  '| `A-3` | t | **2026-11-08: принято и слито — PR #314** |',
  '| `A-4` | t | **Закрыта при интеграции PR #326** |',
  '| `A-5` | t | **Выполнено, 2026-10-24** |',
  '| `A-6` | t | закрыто / принято 2026-10-29 |'.replace('| закрыто', '| **закрыто'),
  '| `A-7` | **ЗАКРЫТО 2026-09-27 через PR #58.** Текст |',
  '| `A-8` | Общая основа — **ЗАКРЫТО 2026-10-17** | текст |',
  '`A-9` — **закрыто / принято 2026-10-26; PR #245**',
  '- `A-10` — **Завершена в PR #328**',
  '| `A-11` | t | [PR #320](https://example/320), 2026-11-10: закрыто |',
  '| `A-12` | t | **ЗАВЕРШЁН 2026-11-14** |',
  '| `A-13` | t | **выполнено 2026-11-14** |',
  '| `A-14` | t | **СДЕЛАНО, PR #1 слит** |',
]) assert.strictEqual(sample(closed), 1, 'не распознана закрытая запись: ' + closed);
for (const open of [
  '| `B-1` | t | **Платформа открыта. Первая версия слита (PR #290).** |',
  '| `B-2` | t | **Следующая задача.** … **2026-11-07: первая версия принята и слита.** |',
  '| `B-3` | t | **Открыто.** Постановка принята и слита в PR #320. |',
  '| `B-4` | t | **Закрытие обсуждается.** |'.replace('Закрытие', 'Закрытие'),
  '| `B-5` | t | Слитая постановка из PR #320, сама работа не сделана. |',
]) assert.strictEqual(sample(open), 0, 'открытая запись принята за закрытую: ' + open);

console.log('random-task: OK');
