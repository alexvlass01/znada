'use strict';

// TRG-004, этап 1: расписание темы в НАСТОЯЩЕМ main.js.
//
// Расписание гасит свой таймер, спрашивает «идёт ли игра», переключает тему Windows и заводит
// таймер до следующей границы. Пока оно ждёт ответа или пока переключение ещё идёт, человек
// может выключить или поменять расписание. Устаревший запуск после ожидания не должен ничего
// сделать: ни переключить тему, ни завести таймер, ни затереть таймер нового запуска. Живых
// таймеров расписания всегда не больше одного, а после выключения — ноль.
//
// Ожидание делается управляемым без правок main.js: вместо настоящих процессов подставлены
// хост обоев (он отвечает на «идёт ли игра») и powershell для set-theme.ps1. Их ответы
// держатся, пока тест их не отпустит. Таймеры настоящие; тест не ждёт их, а считает, сколько
// долгих таймеров живо. Хост и счёт таймеров общие с этапом 2 — test/helpers/schedule-harness.js.
//
// Run: node test/theme-schedule-intent.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const {
  installTimerCensus, deadChild, makeFakeHost, darkNow, lightNow, saysDarkNow, turns, until,
} = require('./helpers/schedule-harness');

let passed = 0;
const failures = [];

// powershell для set-theme.ps1. Законченное переключение меняет тему так, как её потом увидит
// main.js, — через nativeTheme.
function makeThemeShell(nativeTheme) {
  const flips = [];
  const taskkills = [];
  let hold = false;
  const execFile = (file, args, options, cb) => {
    const callback = typeof options === 'function' ? options : cb;
    const list = Array.isArray(args) ? args.map(String) : [];
    const script = list[list.indexOf('-File') + 1] || '';
    // С WIN-002 срок держит запускатель: по его истечении он зовёт taskkill /T по номеру процесса.
    if (/taskkill\.exe$/i.test(String(file))) {
      taskkills.push(list);
      setImmediate(() => { if (callback) callback(null, '', ''); });
      return deadChild();
    }
    if (/set-theme\.ps1$/i.test(script)) {
      const flip = { dark: list[list.indexOf('-Light') + 1] === '0', pid: 5000 + flips.length, done: false };
      flip.finish = () => {
        if (flip.done) return;
        flip.done = true;
        nativeTheme.shouldUseDarkColors = flip.dark;
        setImmediate(() => { if (callback) callback(null, '', ''); });
      };
      flips.push(flip);
      if (!hold) flip.finish();
      const child = deadChild();
      child.pid = flip.pid;
      return child;
    }
    setImmediate(() => { if (callback) callback(new Error('child processes are disabled in tests'), '', ''); });
    return deadChild();
  };
  return { execFile, flips, taskkills, holdFlips: () => { hold = true; } };
}

const OFF = { mode: 'off' };

async function test(name, fn) {
  const dir = H.makeTempProfile('theme-intent');
  const captured = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  console.warn = (...a) => captured.push(a.join(' '));
  const census = installTimerCensus();
  try {
    await fn({ dir, census });
    console.log = real.log; console.error = real.error; console.warn = real.warn;
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log = real.log; console.error = real.error; console.warn = real.warn;
    failures.push({ name, err, captured });
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
  } finally {
    console.log = real.log; console.error = real.error; console.warn = real.warn;
    H.unloadMain();
    census.restore();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function boot(dir, { gameModeBlock }) {
  H.writeJson(`${dir}/config.json`, {
    autoSwitch: true,
    style: 'fill',
    monitors: {},
    gameModeBlock,
    themeSchedule: { mode: 'off', lightStart: '07:00', darkStart: '20:00', lat: '', lng: '' },
    slideshow: { enabled: false, intervalEnabled: true, intervalMin: 30, order: 'sequential' },
  });
  const nativeTheme = { shouldUseDarkColors: false, on: () => {} };
  const host = makeFakeHost();
  const shell = makeThemeShell(nativeTheme);
  // Хост обоев запоминает spawn при первой загрузке и остаётся в кеше модулей: без этого
  // все тесты файла говорили бы с хостом первого.
  delete require.cache[require.resolve(path.join(H.ROOT, 'src', 'wallpaper-host.js'))];
  const main = H.loadMain(dir, { nativeTheme, childProcess: { spawn: host.spawn, execFile: shell.execFile } });
  main.__test.loadConfig();
  return { main, host, shell, nativeTheme };
}

const setSchedule = (main, sch) => main.invoke('set-config', { themeSchedule: sch });

console.log('\ntheme schedule latest intent (real main.js)\n');

(async () => {
  assert.ok(saysDarkNow(darkNow()) && !saysDarkNow(lightNow()), 'подготовка: окна «темно сейчас» и «светло сейчас»');

  // ---- Как расписание ведёт себя без помех (зелёные и до TRG-004) ----------

  await test('расписание включено: одно переключение и один таймер до следующей границы', async ({ dir, census }) => {
    const { main, shell } = boot(dir, { gameModeBlock: false });
    await setSchedule(main, darkNow());
    await until(() => shell.flips.length === 1 && census.live() === 1, 'переключения и таймера');
    await turns();
    assert.strictEqual(shell.flips.length, 1, 'ровно одно переключение');
    assert.strictEqual(shell.flips[0].dark, true, 'переключение в тёмную');
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
    main.__test.disposeForTests();
    assert.strictEqual(census.live(), 0, `после остановки: ${census.describe()}`);
  });

  await test('идёт игра: темы не трогаем, один таймер, чтобы спросить снова', async ({ dir, census }) => {
    const { main, host, shell } = boot(dir, { gameModeBlock: true });
    host.answer('check-fullscreen', { ok: true, busy: true });
    await setSchedule(main, darkNow());
    await until(() => host.seen.includes('check-fullscreen') && census.live() === 1, 'вопроса об игре и таймера');
    await turns();
    assert.strictEqual(shell.flips.length, 0, 'во время игры тема не переключается');
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
  });

  await test('расписание выключено: ни переключения, ни таймера', async ({ dir, census }) => {
    const { main, host, shell } = boot(dir, { gameModeBlock: true });
    await setSchedule(main, OFF);
    await turns();
    assert.strictEqual(shell.flips.length, 0);
    assert.ok(!host.seen.includes('check-fullscreen'), 'выключенное расписание об игре не спрашивает');
    assert.strictEqual(census.live(), 0, `живых таймеров: ${census.describe()}`);
  });

  // ---- Устаревшее намерение (TRG-004) --------------------------------------

  await test('выключили, пока спрашивали об игре: тема не переключается, таймера нет', async ({ dir, census }) => {
    const { main, host, shell } = boot(dir, { gameModeBlock: true });
    host.hold('check-fullscreen');
    await setSchedule(main, darkNow());
    await until(() => host.waiting('check-fullscreen') === 1, 'вопроса об игре');
    await setSchedule(main, OFF);
    host.release('check-fullscreen', { ok: true, busy: false });
    await turns();
    assert.strictEqual(shell.flips.length, 0, 'выключенное расписание переключило тему по старому желанию');
    assert.strictEqual(census.live(), 0, `выключенное расписание оставило таймер: ${census.describe()}`);
  });

  await test('выключили, пока спрашивали, а игра идёт: повтор через минуту не заводится', async ({ dir, census }) => {
    const { main, host, shell } = boot(dir, { gameModeBlock: true });
    host.hold('check-fullscreen');
    await setSchedule(main, darkNow());
    await until(() => host.waiting('check-fullscreen') === 1, 'вопроса об игре');
    await setSchedule(main, OFF);
    host.release('check-fullscreen', { ok: true, busy: true });
    await turns();
    assert.strictEqual(shell.flips.length, 0);
    assert.strictEqual(census.live(), 0, `выключенное расписание завело повтор: ${census.describe()}`);
  });

  await test('два наложившихся запуска: живой таймер один, а после остановки — ни одного', async ({ dir, census }) => {
    const { main, host, shell } = boot(dir, { gameModeBlock: true });
    host.hold('check-fullscreen');
    await setSchedule(main, darkNow());
    await until(() => host.waiting('check-fullscreen') === 1, 'первого вопроса об игре');
    await setSchedule(main, darkNow());
    await until(() => host.waiting('check-fullscreen') === 2, 'второго вопроса об игре');
    host.release('check-fullscreen', { ok: true, busy: true });
    host.release('check-fullscreen', { ok: true, busy: true });
    await turns();
    assert.strictEqual(shell.flips.length, 0);
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
    main.__test.disposeForTests();
    assert.strictEqual(census.live(), 0, `после остановки остался таймер: ${census.describe()}`);
  });

  await test('поменяли, пока спрашивали: старое желание тему не переключает', async ({ dir, census }) => {
    const { main, host, shell, nativeTheme } = boot(dir, { gameModeBlock: true });
    host.hold('check-fullscreen');
    await setSchedule(main, darkNow());
    await until(() => host.waiting('check-fullscreen') === 1, 'вопроса об игре');
    await setSchedule(main, lightNow()); // сейчас и так светло — переключать нечего
    await turns();
    host.release('check-fullscreen', { ok: true, busy: false });
    await turns();
    assert.strictEqual(shell.flips.length, 0, 'старое желание «темно» переключило тему после смены расписания');
    assert.strictEqual(nativeTheme.shouldUseDarkColors, false);
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
  });

  await test('поменяли, пока тема переключалась: после переключения берёт верх новое желание', async ({ dir, census }) => {
    const { main, shell, nativeTheme } = boot(dir, { gameModeBlock: false });
    shell.holdFlips();
    await setSchedule(main, darkNow());
    await until(() => shell.flips.length === 1, 'переключения в тёмную');
    await setSchedule(main, lightNow());
    await turns();
    assert.ok(census.live() <= 1, `пока тема переключается, живых таймеров больше одного: ${census.describe()}`);
    shell.flips[0].finish(); // Windows стала тёмной по старому желанию
    await until(() => shell.flips.length === 2, 'нового переключения — назад в светлую');
    assert.strictEqual(shell.flips[1].dark, false, 'второе переключение — в светлую');
    shell.flips[1].finish();
    await until(() => census.live() === 1, 'таймера до следующей границы');
    await turns();
    assert.strictEqual(nativeTheme.shouldUseDarkColors, false, 'итог — новое желание, светлая тема');
    assert.strictEqual(shell.flips.length, 2);
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
  });

  await test('зависшее переключение кончается сроком запускателя, и расписание не застревает', async ({ dir, census }) => {
    // Следующий запуск ждёт начатого переключения, поэтому зависший powershell держал бы расписание
    // темы до перезапуска. Срок даёт запускатель WIN-002; здесь он сокращён до 50 мс.
    const { main, shell, nativeTheme } = boot(dir, { gameModeBlock: false });
    shell.holdFlips();
    main.__test.setSystemChildTimeouts({ powershell: 50 });
    await setSchedule(main, darkNow());
    await until(() => shell.flips.length === 1, 'переключения в тёмную');
    await until(() => shell.taskkills.length === 1, 'taskkill по сроку');
    assert.deepStrictEqual(shell.taskkills[0].slice(0, 4), ['/PID', String(shell.flips[0].pid), '/T', '/F'],
      'срок заканчивает процесс переключения вместе с дочерними');
    await until(() => census.live() === 1, 'таймера до следующей границы после сбоя');
    await setSchedule(main, lightNow()); // новое желание не ждёт зависшего вечно
    await turns();
    assert.strictEqual(shell.flips.length, 1, 'светло и так: переключать нечего');
    assert.strictEqual(nativeTheme.shouldUseDarkColors, false);
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) {
      console.log(`\n--- ${f.name}\n${f.err && f.err.stack}`);
      if (f.captured.length) console.log('    вывод main.js:\n      ' + f.captured.slice(-12).join('\n      '));
    }
    process.exit(1);
  }
})();
