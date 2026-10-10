'use strict';

// TRG-004, этап 2: расписание обоев в НАСТОЯЩЕМ main.js.
//
// Расписание обоев («время» или «солнце») ставит обои дневного или ночного слота и заводит
// таймер до следующей границы. По сроку таймера оно спрашивает «идёт ли игра», затем хост
// перечисляет мониторы и применяет обои. Пока оно ждёт, человек может выключить расписание,
// переключить его на «как Windows» или поменять часы. Устаревший запуск после ожидания не
// должен ничего сделать: ни поставить обои по старому желанию, ни запустить запасной путь, ни
// завести таймер, ни затереть таймер нового запуска, ни записать в журнал сбой. Живых таймеров
// расписания всегда не больше одного, а после выключения — ноль.
//
// Хост обоев подставлен поддельным по его настоящему протоколу, его ответы держатся, пока тест
// их не отпустит; системные процессы (запасной путь применения) записываются и сразу падают.
// Срок таймера тест не ждёт: он срабатывает сам, когда тест его «дожидается» (census.fireOnly).
//
// Run: node test/wallpaper-schedule-intent.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const {
  installTimerCensus, deadChild, makeFakeHost, darkNow, lightNow, saysDarkNow, turns, until,
} = require('./helpers/schedule-harness');

let passed = 0;
const failures = [];

const MONITOR = { id: 'MON1', x: 0, y: 0, w: 1920, h: 1080, primary: true };
const SYSTEM = { mode: 'system' };
const OFF = { mode: 'off' };

// Системные процессы: taskkill отвечает сразу, всё остальное (запасной путь через отдельный
// powershell) падает, как и в остальных тестах обвязки, — но сначала записывается.
function makeShell() {
  const calls = [];
  const execFile = (file, args, options, cb) => {
    const callback = typeof options === 'function' ? options : cb;
    const list = Array.isArray(args) ? args.map(String) : [];
    if (/taskkill\.exe$/i.test(String(file))) {
      setImmediate(() => { if (callback) callback(null, '', ''); });
      return deadChild();
    }
    calls.push({ file: String(file), args: list });
    setImmediate(() => { if (callback) callback(new Error('child processes are disabled in tests'), '', ''); });
    return deadChild();
  };
  // Какой запасной путь пытался поставить обои: через отдельный COM-процесс или одной
  // картинкой на все мониторы.
  const fallbacks = () => calls
    .map((c) => c.args[c.args.indexOf('-File') + 1] || '')
    .filter((script) => /wallpaper-com\.ps1$|set-wallpaper\.ps1$/i.test(script))
    .map((script) => path.basename(script));
  return { execFile, calls, fallbacks };
}

async function test(name, fn) {
  const dir = H.makeTempProfile('wallpaper-intent');
  const captured = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  console.warn = (...a) => captured.push(a.join(' '));
  const census = installTimerCensus();
  let error = null;
  try {
    await fn({ dir, census });
  } catch (err) {
    error = err;
  }
  H.unloadMain();
  // Запуск, который провалившийся сценарий оставил ждать хоста, кончается только сейчас:
  // выгрузка отказывает всему, что хост ещё держал. Пусть он доживёт здесь — иначе его
  // таймер попал бы в счёт следующего сценария, а его запасной путь — в чужой профиль.
  await turns();
  census.restore();
  console.log = real.log; console.error = real.error; console.warn = real.warn;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  if (error) {
    failures.push({ name, err: error, captured });
    console.log(`  ✗ ${name}\n      ${error && error.message}`);
  } else {
    console.log(`  ✓ ${name}`);
    passed++;
  }
}

// Windows в светлой теме. У каждого слота своя картинка, поэтому по пути видно, чьё желание
// дошло до рабочего стола.
function boot(dir, { gameModeBlock, monitorsKnown = true }) {
  const light = H.writeImage(path.join(dir, 'pics', 'light.png'));
  const dark = H.writeImage(path.join(dir, 'pics', 'dark.png'));
  H.writeJson(`${dir}/config.json`, {
    autoSwitch: true,
    style: 'fill',
    monitors: {},
    library: {},
    separateThemes: true,
    lightWallpaper: light,
    darkWallpaper: dark,
    gameModeBlock,
    themeSchedule: { mode: 'off', lightStart: '07:00', darkStart: '20:00', lat: '', lng: '' },
    wallpaperSchedule: { mode: 'system', lightStart: '07:00', darkStart: '20:00' },
    slideshow: { enabled: false, intervalEnabled: true, intervalMin: 30, order: 'sequential' },
  });
  const nativeTheme = { shouldUseDarkColors: false, on: () => {} };
  const host = makeFakeHost();
  const shell = makeShell();
  // Хост обоев запоминает spawn при первой загрузке и остаётся в кеше модулей: без этого
  // все тесты файла говорили бы с хостом первого.
  delete require.cache[require.resolve(path.join(H.ROOT, 'src', 'wallpaper-host.js'))];
  const main = H.loadMain(dir, { nativeTheme, childProcess: { spawn: host.spawn, execFile: shell.execFile } });
  main.__test.loadConfig();
  // Мониторы перечисляются на старте, которого под обвязкой нет; без списка применение
  // само спросит хост.
  if (monitorsKnown) main.__test.setMonitorsCache([MONITOR]);
  // Что дошло до хоста как «применить»: слот по имени картинки.
  const applied = () => host.commands
    .filter((c) => c.op === 'apply')
    .map((c) => (/dark\.png$/i.test(String(c.items && c.items[0] && c.items[0].path)) ? 'dark' : 'light'));
  const failuresLogged = () => main.__test.eventLogEntries().filter((e) => e.kind === 'failure');
  return { main, host, shell, applied, failuresLogged };
}

const setWallpaperSchedule = (main, sch) => main.invoke('set-config', { wallpaperSchedule: sch });

console.log('\nwallpaper schedule latest intent (real main.js)\n');

(async () => {
  assert.ok(saysDarkNow(darkNow()) && !saysDarkNow(lightNow()), 'подготовка: окна «темно сейчас» и «светло сейчас»');

  // ---- Как расписание ведёт себя без помех (зелёные и до TRG-004) ----------

  await test('расписание включено: обои ночного слота и один таймер до следующей границы', async ({ dir, census }) => {
    const { main, applied } = boot(dir, { gameModeBlock: false });
    await setWallpaperSchedule(main, darkNow());
    await until(() => applied().length === 1 && census.live() === 1, 'применения и таймера');
    await turns();
    assert.deepStrictEqual(applied(), ['dark']);
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
    main.__test.disposeForTests();
    assert.strictEqual(census.live(), 0, `после остановки: ${census.describe()}`);
  });

  await test('срок таймера пришёлся на игру: обоев не трогаем, один таймер, чтобы спросить снова, и он гаснет с выключением', async ({ dir, census }) => {
    const { main, host, applied } = boot(dir, { gameModeBlock: true });
    await setWallpaperSchedule(main, darkNow()); // смену человек сделал сам: об игре не спрашивают
    await until(() => applied().length === 1 && census.live() === 1, 'применения и таймера');
    host.answer('check-fullscreen', { ok: true, busy: true });
    census.fireOnly();
    await until(() => host.seen.includes('check-fullscreen') && census.live() === 1, 'вопроса об игре и повтора');
    await turns();
    assert.deepStrictEqual(applied(), ['dark'], 'во время игры обои не меняются');
    assert.ok(/^60000 мс/.test(census.describe()), `ждали повтор через минуту: ${census.describe()}`);
    await setWallpaperSchedule(main, OFF);
    assert.strictEqual(census.live(), 0, `выключенное расписание оставило повтор: ${census.describe()}`);
  });

  await test('расписание «как Windows»: обои текущей темы Windows, таймера нет', async ({ dir, census }) => {
    const { main, applied } = boot(dir, { gameModeBlock: true });
    await setWallpaperSchedule(main, SYSTEM);
    await turns();
    assert.deepStrictEqual(applied(), ['light']);
    assert.strictEqual(census.live(), 0, `живых таймеров: ${census.describe()}`);
  });

  // ---- Устаревшее намерение (TRG-004) --------------------------------------

  // Расписание «темно сейчас» поставлено, по сроку таймера оно спрашивает об игре, ответ
  // придержан. Возвращает обещание set-config, которое ещё может ждать хоста.
  async function timerRunAsking({ main, host, applied, census }) {
    await setWallpaperSchedule(main, darkNow());
    await until(() => applied().length === 1 && census.live() === 1, 'первого применения и таймера');
    host.hold('check-fullscreen');
    census.fireOnly();
    await until(() => host.waiting('check-fullscreen') === 1, 'вопроса об игре по сроку таймера');
  }

  await test('переключили на «как Windows», пока срок таймера ждал ответа об игре: старое желание не доходит до рабочего стола', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await timerRunAsking({ ...t, census });
    const change = setWallpaperSchedule(t.main, SYSTEM);
    await until(() => t.applied().length === 2, 'обоев текущей темы Windows');
    t.host.release('check-fullscreen', { ok: true, busy: false });
    await change;
    await turns();
    assert.deepStrictEqual(t.applied(), ['dark', 'light'],
      'старое желание «темно» дошло до рабочего стола после переключения на «как Windows»');
    assert.strictEqual(census.live(), 0, `после переключения на «как Windows» остался таймер: ${census.describe()}`);
    assert.deepStrictEqual(t.failuresLogged(), [], 'устаревший запуск записан в журнал как сбой');
  });

  await test('переключили, пока спрашивали, а игра идёт: повтор через минуту не заводится', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await timerRunAsking({ ...t, census });
    const change = setWallpaperSchedule(t.main, SYSTEM);
    await until(() => t.applied().length === 2, 'обоев текущей темы Windows');
    t.host.release('check-fullscreen', { ok: true, busy: true });
    await change;
    await turns();
    assert.deepStrictEqual(t.applied(), ['dark', 'light']);
    assert.strictEqual(census.live(), 0, `выключенное расписание завело повтор: ${census.describe()}`);
  });

  await test('поменяли часы, пока срок таймера ждал ответа об игре: берёт верх новое желание', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await timerRunAsking({ ...t, census });
    const change = setWallpaperSchedule(t.main, lightNow()); // смена руками об игре не спрашивает
    await turns();
    t.host.release('check-fullscreen', { ok: true, busy: false });
    await change;
    await turns();
    assert.deepStrictEqual(t.applied(), ['dark', 'light'],
      'старое желание «темно» дошло до рабочего стола после смены часов');
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
    assert.deepStrictEqual(t.failuresLogged(), []);
  });

  await test('два наложившихся запуска: живой таймер один, а после остановки — ни одного', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await timerRunAsking({ ...t, census });
    const again = setWallpaperSchedule(t.main, darkNow());
    await turns();
    t.host.release('check-fullscreen', { ok: true, busy: true });
    await again;
    await turns();
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
    t.main.__test.disposeForTests();
    assert.strictEqual(census.live(), 0, `после остановки остался таймер: ${census.describe()}`);
  });

  await test('поменяли часы, пока обои применялись: новое применение идёт после начатого, таймер один', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: false });
    t.host.hold('apply');
    const first = setWallpaperSchedule(t.main, darkNow());
    await until(() => t.host.waiting('apply') === 1, 'применения ночного слота');
    const second = setWallpaperSchedule(t.main, lightNow());
    await turns();
    // Начатое применение не отменить. Новое уходит только после него: иначе на запасном
    // пути (отдельные процессы вместо хоста) два применения шли бы наперегонки, и последним
    // на рабочем столе могло оказаться старое.
    assert.deepStrictEqual(t.applied(), ['dark'], 'новое применение ушло, пока начатое ещё шло');
    assert.ok(census.live() <= 1, `пока обои применяются, живых таймеров больше одного: ${census.describe()}`);
    t.host.release('apply', { ok: true });
    await until(() => t.host.waiting('apply') === 1, 'применения дневного слота');
    t.host.release('apply', { ok: true });
    await first;
    await second;
    await turns();
    assert.deepStrictEqual(t.applied(), ['dark', 'light'], 'итог — новое желание, дневной слот');
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
  });

  await test('выключили, пока обои применялись: начатое доходит, но таймер после него не заводится', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: false });
    t.host.hold('apply');
    const first = setWallpaperSchedule(t.main, darkNow());
    await until(() => t.host.waiting('apply') === 1, 'применения ночного слота');
    await setWallpaperSchedule(t.main, OFF);
    t.host.release('apply', { ok: true });
    await first;
    await turns();
    assert.deepStrictEqual(t.applied(), ['dark'], 'начатое применение не отменить — оно доходит');
    assert.strictEqual(census.live(), 0, `выключенное расписание завело таймер: ${census.describe()}`);
  });

  await test('выключили, пока перечислялись мониторы: старое желание не доходит до рабочего стола', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: false, monitorsKnown: false });
    t.host.hold('enum');
    const first = setWallpaperSchedule(t.main, darkNow());
    await until(() => t.host.waiting('enum') === 1, 'перечисления мониторов');
    await setWallpaperSchedule(t.main, OFF);
    t.host.release('enum', { ok: true, monitors: [MONITOR] });
    await first;
    await turns();
    assert.deepStrictEqual(t.applied(), [], 'выключенное расписание поставило обои по старому желанию');
    assert.deepStrictEqual(t.shell.fallbacks(), []);
    assert.strictEqual(census.live(), 0, `выключенное расписание завело таймер: ${census.describe()}`);
  });

  await test('выключили, а мониторов не нашлось: запасной путь одной картинкой не запускается', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: false, monitorsKnown: false });
    t.host.hold('enum');
    const first = setWallpaperSchedule(t.main, darkNow());
    await until(() => t.host.waiting('enum') === 1, 'перечисления мониторов');
    await setWallpaperSchedule(t.main, OFF);
    t.host.release('enum', { ok: true, monitors: [] });
    await first;
    await turns();
    assert.deepStrictEqual(t.shell.fallbacks(), [], 'выключенное расписание запустило запасной путь по старому желанию');
    assert.deepStrictEqual(t.failuresLogged(), [], 'устаревший запуск записан в журнал как сбой');
    assert.strictEqual(census.live(), 0, `выключенное расписание завело таймер: ${census.describe()}`);
  });

  await test('выключили, пока хост применял и не смог: запасной путь не запускается', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: false });
    t.host.hold('apply');
    const first = setWallpaperSchedule(t.main, darkNow());
    await until(() => t.host.waiting('apply') === 1, 'применения ночного слота');
    await setWallpaperSchedule(t.main, OFF);
    t.host.release('apply', { ok: false, error: 'COM apply failed' });
    await first;
    await turns();
    assert.deepStrictEqual(t.shell.fallbacks(), [], 'выключенное расписание запустило запасной путь по старому желанию');
    assert.deepStrictEqual(t.failuresLogged(), [], 'устаревший запуск записан в журнал как сбой');
    assert.strictEqual(census.live(), 0, `выключенное расписание завело таймер: ${census.describe()}`);
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
