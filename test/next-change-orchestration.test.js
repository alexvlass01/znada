'use strict';

// HOME-001 в НАСТОЯЩЕМ main.js: живой отсчёт на Главной верен ровно настолько,
// насколько верно состояние планировщика после реальных действий пользователя.
//
// Чистые тесты (test/next-change.test.js) доказывают только правила показа. Они не
// видят, в каком порядке main взводит и гасит таймер и остаётся ли пометка «время
// обещать нельзя» после перепланирования. Поэтому здесь загружается сам main.js и
// дёргаются его IPC-обработчики над временным профилем.
//
// Run: node test/next-change-orchestration.test.js

const assert = require('assert');
const fs = require('fs');
const H = require('./helpers/main-harness');

let passed = 0;
const failures = [];

// main сообщает о деградированных путях (обои нельзя применить без дочернего процесса).
// Это ожидаемо, поэтому вывод копится и показывается только при падении теста.
async function test(name, fn) {
  const dir = H.makeTempProfile('nextchange');
  const captured = [];
  const real = { log: console.log, error: console.error };
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  try {
    await fn(dir);
    console.log = real.log; console.error = real.error;
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log = real.log; console.error = real.error;
    failures.push({ name, err, captured });
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
  } finally {
    console.log = real.log; console.error = real.error;
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function boot(dir, slideshow) {
  H.writeJson(`${dir}/config.json`, { autoSwitch: true, style: 'fill', monitors: {}, slideshow });
  const main = H.loadMain(dir);
  main.__test.loadConfig();
  return main;
}

const state = (main) => main.__test.nextChangeState();

// set-slideshow не дожидается применения обоев, поэтому таймер взводится чуть позже
// ответа обработчика. Ждём именно состояния, а не «достаточной» паузы.
async function settle(main, predicate, what) {
  for (let i = 0; i < 400; i++) {
    if (predicate(state(main))) return state(main);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${what}: не дождались, состояние осталось ${JSON.stringify(state(main))}`);
}

const settleDue = (main) => settle(main, (st) => st.kind === 'due', 'отсчёт не запустился');
const running = { enabled: true, intervalEnabled: true, intervalMin: 30, order: 'sequential' };

console.log('\nnext-change orchestration (real main.js)\n');

(async () => {
  // ---- Что Главная получает после обычных действий -------------------------

  await test('интервал включён → Главная получает момент срабатывания, а не пересчитанный остаток', async (dir) => {
    const main = boot(dir, running);
    const before = Date.now();
    await main.invoke('set-slideshow', { intervalMin: 30 });
    const st = await settleDue(main);
    const after = Date.now();
    // Момент лежит в окне [сейчас + 30 мин], посчитанном по РЕАЛЬНО взведённому таймеру.
    assert.ok(st.dueAt >= before + 30 * 60000, `dueAt=${st.dueAt} раньше ожидаемого`);
    assert.ok(st.dueAt <= after + 30 * 60000 + 200, `dueAt=${st.dueAt} позже ожидаемого`);
    assert.deepStrictEqual(await main.invoke('next-change-get'), st);
  });

  await test('смена величины интервала переносит момент, а не оставляет старый', async (dir) => {
    const main = boot(dir, { ...running, intervalMin: 60 });
    await main.invoke('set-slideshow', { intervalMin: 60 });
    const long = (await settleDue(main)).dueAt;
    await main.invoke('set-slideshow', { intervalMin: 5 });
    const short = (await settle(main, (s) => s.kind === 'due' && s.dueAt !== long, 'момент не обновился')).dueAt;
    assert.ok(short < long - 50 * 60000, `после сокращения интервала момент не переехал: ${long} → ${short}`);
  });

  await test('выключенный интервальный триггер не превращается в отсчёт', async (dir) => {
    const main = boot(dir, running);
    await main.invoke('set-slideshow', { intervalMin: 30 });
    await settleDue(main);
    await main.invoke('set-slideshow', { intervalEnabled: false });
    assert.deepStrictEqual(state(main), { kind: 'events' });
  });

  await test('выключенное слайд-шоу снимает отсчёт полностью', async (dir) => {
    const main = boot(dir, running);
    await main.invoke('set-slideshow', { intervalMin: 30 });
    await settleDue(main);
    await main.invoke('set-slideshow', { enabled: false });
    assert.deepStrictEqual(state(main), { kind: 'off' });
  });

  await test('обратное включение возвращает честный момент, а не остатки прошлого', async (dir) => {
    const main = boot(dir, { ...running, intervalMin: 15 });
    await main.invoke('set-slideshow', { intervalMin: 15 });
    await settleDue(main);
    await main.invoke('set-slideshow', { enabled: false });
    const started = Date.now();
    await main.invoke('set-slideshow', { enabled: true });
    const st = await settleDue(main);
    assert.ok(st.dueAt >= started + 15 * 60000, 'момент взят не от нового включения');
  });

  // ---- Главное правило задачи: блокировка не становится обещанием -----------

  await test('перепроверка игрового режима НЕ показывается как «через 1 мин»', async (dir) => {
    const main = boot(dir, running);
    await main.invoke('set-slideshow', { intervalMin: 30 });
    await settleDue(main);

    // Ровно то, что делает main, когда игра или полноэкранное приложение заблокировали
    // смену: таймер взводится на минуту, но он лишь СПРОСИТ систему заново.
    main.__test.blockIntervalLikeGameMode();

    const st = state(main);
    assert.deepStrictEqual(st, { kind: 'held', reason: 'gamemode' },
      `блокировка показана как ${JSON.stringify(st)}`);
    assert.ok(!('dueAt' in st), 'момент срабатывания просочился в состояние паузы');
  });

  await test('пауза игрового режима снимается следующим нормальным планированием', async (dir) => {
    const main = boot(dir, running);
    await main.invoke('set-slideshow', { intervalMin: 30 });
    await settleDue(main);
    main.__test.blockIntervalLikeGameMode();
    assert.strictEqual(state(main).kind, 'held');

    // Игра закрыта, обычная смена состоялась → отсчёт обязан вернуться сам.
    await main.invoke('set-slideshow', { intervalMin: 30 });
    await settle(main, (s) => s.kind === 'due', 'пометка паузы пережила перепланирование');
  });

  await test('пауза не переживает выключение слайд-шоу', async (dir) => {
    const main = boot(dir, running);
    await main.invoke('set-slideshow', { intervalMin: 30 });
    await settleDue(main);
    main.__test.blockIntervalLikeGameMode();
    await main.invoke('set-slideshow', { enabled: false });
    assert.deepStrictEqual(state(main), { kind: 'off' });
  });

  // ---- Ручная смена обоев --------------------------------------------------

  await test('ручная смена обоев переносит момент следующей автоматической', async (dir) => {
    const main = boot(dir, running);
    await main.invoke('set-slideshow', { intervalMin: 30 });
    const first = (await settleDue(main)).dueAt;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await main.invoke('next-wallpaper', null);
    const second = (await settle(main, (s) => s.kind === 'due' && s.dueAt !== first, 'момент не сдвинулся')).dueAt;
    assert.ok(second > first, `отсчёт не перезапустился после ручной смены: ${first} → ${second}`);
  });

  console.log(`\n${failures.length ? `${failures.length} FAILED, ` : ''}${passed} next-change orchestration tests passed.\n`);
  if (failures.length) {
    for (const f of failures) {
      console.error(`\nFAILED: ${f.name}\n${f.err && f.err.stack}`);
      if (f.captured.length) console.error(`  main.js said:\n    ${f.captured.join('\n    ')}`);
    }
    process.exit(1);
  }
})();
