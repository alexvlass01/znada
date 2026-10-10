'use strict';

// TRG-004, этап 3: слайд-шоу в НАСТОЯЩЕМ main.js.
//
// Слайд-шоу листает кадры по интервалу, во время игры откладывает смену и через минуту спрашивает
// снова, а ещё меняет кадр по ручному «Змінити», по выбору кадра и при смене темы Windows. Пока
// запуск ждёт («идёт ли игра», «применил ли»), человек может сделать что-то новое. Устаревший
// запуск после ожидания не должен ничего сделать: ни сдвинуть кадр, ни поставить обои, ни завести
// таймер, ни перевести Главную в «паузу». Отложенная смена, когда игра кончилась, делает то, что
// откладывали: показать кадр новой темы — это не «перелистнуть», и это не теряется, если интервал
// выключен. То же для обоев, которые без слайд-шоу просто следуют теме Windows.
//
// Хост обоев подставлен поддельным по его настоящему протоколу; его ответы держатся, пока тест их
// не отпустит. Таймеры настоящие: «срок таймера» наступает, когда тест его вызывает
// (census.fireOnly). Смену темы Windows тест делает так же, как она приходит в main.js: меняет
// nativeTheme и зовёт тот же обработчик.
//
// Run: node test/slideshow-intent.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const { installTimerCensus, makeFakeHost, turns, until } = require('./helpers/schedule-harness');

let passed = 0;
const failures = [];

const MONITOR = { id: 'MON1', x: 0, y: 0, w: 1920, h: 1080, primary: true };
const INTERVAL_MS = 30 * 60000;

async function test(name, fn) {
  const dir = H.makeTempProfile('slideshow-intent');
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
  // Запуск, который провалившийся сценарий оставил ждать хоста, доживает здесь: иначе его таймер
  // попал бы в счёт следующего сценария.
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

// Три кадра у дня и три у ночи; по имени файла видно, какой кадр дошёл до рабочего стола.
function boot(dir, { gameModeBlock, slideshow = true, intervalEnabled = true, stealth = false }) {
  const frames = {};
  const lib = {};
  const slot = (theme, names) => ({
    itemIds: names.map((name) => {
      const file = H.writeImage(path.join(dir, 'pics', `${name}.png`));
      const id = library.idFor(file);
      frames[name] = file;
      lib[id] = { id, type: 'image', path: file, tags: [] };
      return id;
    }),
  });
  const monitors = { [MONITOR.id]: { light: slot('light', ['l1', 'l2', 'l3']), dark: slot('dark', ['d1', 'd2', 'd3']) } };
  H.writeJson(`${dir}/config.json`, {
    autoSwitch: true,
    style: 'fill',
    monitors,
    separateThemes: true,
    gameModeBlock,
    themeSchedule: { mode: 'off', lightStart: '07:00', darkStart: '20:00', lat: '', lng: '' },
    wallpaperSchedule: { mode: 'system', lightStart: '07:00', darkStart: '20:00' },
    slideshow: { enabled: slideshow, intervalEnabled, intervalMin: 30, order: 'sequential' },
    triggers: {
      onStartup: false,
      onWakeup: false,
      stealth: { enabled: stealth, startup: false, wakeup: false, interval: stealth, timeoutMin: 5 },
    },
  });
  H.writeJson(`${dir}/config.library.json`, { version: 1, library: lib, trash: [] });
  const nativeTheme = { shouldUseDarkColors: false, on: () => {} };
  const host = makeFakeHost();
  // Хост обоев запоминает spawn при первой загрузке и остаётся в кеше модулей.
  delete require.cache[require.resolve(path.join(H.ROOT, 'src', 'wallpaper-host.js'))];
  const main = H.loadMain(dir, { nativeTheme, childProcess: { spawn: host.spawn } });
  main.__test.loadConfig();
  main.__test.setMonitorsCache([MONITOR]);
  const applied = () => host.commands
    .filter((c) => c.op === 'apply')
    .map((c) => path.basename(String(c.items && c.items[0] && c.items[0].path), '.png'));
  const homeState = () => main.__test.nextChangeState();
  // Windows переключила тему: так же, как это видит main.js.
  const flipTheme = (dark) => { nativeTheme.shouldUseDarkColors = dark; main.__test.themeUpdated(); };
  return { main, host, frames, applied, homeState, flipTheme };
}

// Слайд-шоу запущено настройками: текущий кадр поставлен, интервал заведён.
async function started(t, census, { interval = true } = {}) {
  await t.main.invoke('set-slideshow', { intervalMin: 30 });
  await until(() => t.applied().length === 1 && census.live() === (interval ? 1 : 0), 'первого кадра и таймера');
  await turns();
}

// Срок интервала пришёл, а ответ «идёт ли игра» придержан.
async function intervalAsking(t, census) {
  t.host.hold('check-fullscreen');
  census.fireOnly();
  await until(() => t.host.waiting('check-fullscreen') === 1, 'вопроса об игре по сроку интервала');
}

// Первый придержанный ответ отпущен; следующие вопросы об игре отвечают сразу тем же.
function gameAnswer(t, busy) {
  t.host.unhold('check-fullscreen');
  t.host.answer('check-fullscreen', { ok: true, busy });
  t.host.release('check-fullscreen', { ok: true, busy });
}

const due = (census) => census.describe().split(' | ').every((d) => d.startsWith(`${INTERVAL_MS} мс`));

console.log('\nslideshow latest intent (real main.js)\n');

(async () => {
  // ---- Как слайд-шоу ведёт себя без помех (зелёные и до этапа 3) ----------

  await test('срок интервала: следующий кадр и один таймер до следующего срока', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: false });
    await started(t, census);
    census.fireOnly();
    await until(() => t.applied().length === 2 && census.live() === 1, 'следующего кадра и таймера');
    await turns();
    assert.deepStrictEqual(t.applied(), ['l1', 'l2']);
    assert.ok(due(census), `живые таймеры: ${census.describe()}`);
    t.main.__test.disposeForTests();
    assert.strictEqual(census.live(), 0, `после остановки: ${census.describe()}`);
  });

  await test('срок пришёлся на игру: кадр не меняется, повтор через минуту, на Главной «пауза»', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await started(t, census);
    t.host.answer('check-fullscreen', { ok: true, busy: true });
    census.fireOnly();
    await until(() => t.host.seen.includes('check-fullscreen') && census.live() === 1, 'вопроса об игре и повтора');
    await turns();
    assert.deepStrictEqual(t.applied(), ['l1']);
    assert.ok(/^60000 мс/.test(census.describe()), `ждали повтор через минуту: ${census.describe()}`);
    assert.deepStrictEqual(t.homeState(), { kind: 'held', reason: 'gamemode' });
  });

  await test('игра кончилась: отложенный срок листает дальше и снова заводит интервал', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await started(t, census);
    t.host.answer('check-fullscreen', { ok: true, busy: true });
    census.fireOnly();
    await until(() => census.live() === 1 && /^60000 мс/.test(census.describe()), 'повтора через минуту');
    t.host.answer('check-fullscreen', { ok: true, busy: false });
    census.fireOnly();
    await until(() => t.applied().length === 2 && census.live() === 1 && due(census), 'следующего кадра и интервала');
    await turns();
    assert.deepStrictEqual(t.applied(), ['l1', 'l2']);
    assert.strictEqual(t.homeState().kind, 'due');
  });

  await test('повтор через минуту снова спрашивает об игре: на Главной всё это время «пауза», без «скоро»', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await started(t, census);
    t.host.answer('check-fullscreen', { ok: true, busy: true });
    census.fireOnly();
    await until(() => census.live() === 1 && /^60000 мс/.test(census.describe()), 'повтора через минуту');
    t.host.hold('check-fullscreen');
    census.fireOnly();
    await until(() => t.host.waiting('check-fullscreen') === 1, 'повторного вопроса об игре');
    await turns();
    assert.deepStrictEqual(t.homeState(), { kind: 'held', reason: 'gamemode' },
      'пока повтор спрашивает, Главная мигнула не тем состоянием');
    gameAnswer(t, true);
    await until(() => census.live() === 1, 'нового повтора');
    await turns();
    assert.deepStrictEqual(t.homeState(), { kind: 'held', reason: 'gamemode' });
    assert.deepStrictEqual(t.applied(), ['l1']);
  });

  await test('выключили слайд-шоу, пока срок ждал ответа об игре: старый запуск ничего не ставит, таймера нет', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await started(t, census);
    await intervalAsking(t, census);
    const off = t.main.invoke('set-slideshow', { enabled: false });
    await turns();
    gameAnswer(t, false);
    await off;
    await turns();
    assert.ok(!t.applied().includes('l2'), `выключенное слайд-шоу перелистнуло кадр: ${t.applied().join(', ')}`);
    assert.strictEqual(census.live(), 0, `выключенное слайд-шоу оставило таймер: ${census.describe()}`);
    assert.deepStrictEqual(t.homeState(), { kind: 'off' });
  });

  await test('невидимая смена по сроку: кадр меняется, когда окно на весь экран, и интервал заводится заново', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: false, stealth: true });
    t.host.answer('check-maximized', { ok: true, coveredMonitors: [MONITOR.id] });
    await started(t, census);
    census.fireOnly();
    await until(() => t.applied().length === 2 && census.live() === 1, 'невидимой смены и интервала');
    await turns();
    assert.deepStrictEqual(t.applied(), ['l1', 'l2']);
    assert.ok(due(census), `живые таймеры: ${census.describe()}`);
    assert.strictEqual(t.homeState().kind, 'due');
  });

  // ---- Устаревший запуск (TRG-004, этап 3) ---------------------------------

  await test('нажали «Змінити», пока срок интервала ждал ответа об игре: кадр сдвигается один раз', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await started(t, census);
    await intervalAsking(t, census);
    const next = t.main.invoke('next-wallpaper', null);
    await until(() => t.applied().length === 2, 'ручной смены');
    gameAnswer(t, false);
    await next;
    await turns(80);
    assert.deepStrictEqual(t.applied(), ['l1', 'l2'], 'после ручной смены старый срок перелистнул ещё раз');
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
    assert.ok(due(census), `живые таймеры: ${census.describe()}`);
  });

  await test('выбрали кадр, пока срок интервала ждал ответа об игре: выбранный кадр остаётся', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await started(t, census);
    await intervalAsking(t, census);
    const pick = t.main.invoke('set-slideshow-to-path', MONITOR.id, 'light', t.frames.l3);
    await until(() => t.applied().length === 2, 'выбранного кадра');
    gameAnswer(t, false);
    await pick;
    await turns(80);
    assert.deepStrictEqual(t.applied(), ['l1', 'l3'], 'выбранный кадр перелистнул устаревший срок интервала');
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
  });

  // Устаревший запуск берёт позицию в момент применения — это уже выбранный кадр, поэтому до
  // этапа 3 он ставил его ещё раз (l1, l3, l3): лишнее применение, а при смене темы в ту же
  // минуту — вспышка кадра старой темы перед новым.
  await test('выбрали кадр, пока применение по сроку само ещё спрашивало об игре: устаревший запуск обои уже не ставит', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await started(t, census);
    await intervalAsking(t, census);
    t.host.release('check-fullscreen', { ok: true, busy: false });
    // Срок пошёл дальше: кадр сдвинут, и уже применение спрашивает об игре ещё раз.
    await until(() => t.host.waiting('check-fullscreen') === 1, 'вопроса об игре изнутри применения');
    const pick = t.main.invoke('set-slideshow-to-path', MONITOR.id, 'light', t.frames.l3);
    await until(() => t.applied().length === 2, 'выбранного кадра');
    gameAnswer(t, false);
    await pick;
    await turns(80);
    assert.deepStrictEqual(t.applied(), ['l1', 'l3'], 'устаревший запуск по сроку всё равно применил обои после выбора');
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
  });

  await test('нажали «Змінити», пока срок ждал ответа, а игра идёт: Главная показывает отсчёт, а не «паузу»', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await started(t, census);
    await intervalAsking(t, census);
    const next = t.main.invoke('next-wallpaper', null);
    await until(() => t.applied().length === 2, 'ручной смены');
    gameAnswer(t, true);
    await next;
    await turns(80);
    assert.strictEqual(t.homeState().kind, 'due',
      `после ручной смены устаревший срок поставил на Главной ${JSON.stringify(t.homeState())}`);
    assert.ok(due(census), `ручная смена перезапустила интервал, а живые таймеры: ${census.describe()}`);
  });

  await test('нажали «Змінити», пока обои по сроку ещё применялись: новое применение идёт после начатого', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: false });
    await started(t, census);
    t.host.hold('apply');
    census.fireOnly();
    await until(() => t.host.waiting('apply') === 1, 'применения по сроку');
    const next = t.main.invoke('next-wallpaper', null);
    await turns();
    // Начатое применение не отменить. Новое уходит только после него: иначе на запасном пути
    // (отдельные процессы вместо хоста) два применения шли бы наперегонки.
    assert.deepStrictEqual(t.applied(), ['l1', 'l2'], 'ручное применение ушло, пока применение по сроку ещё шло');
    t.host.release('apply', { ok: true });
    await until(() => t.host.waiting('apply') === 1, 'ручного применения');
    t.host.release('apply', { ok: true });
    await next;
    await turns();
    assert.deepStrictEqual(t.applied(), ['l1', 'l2', 'l3']);
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
  });

  // Выбор этапа 3, а не исправление: до него каждое нажатие сдвигало кадр сразу, и при медленном
  // применении два нажатия давали две смены подряд (l3, затем l1). Теперь второе нажатие заменяет
  // ещё не начатое первое, как любое более новое намерение.
  await test('дважды нажали «Змінити», пока обои по сроку ещё применялись: второе заменяет первое, позиция = показанный кадр', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: false });
    await started(t, census);
    t.host.hold('apply');
    census.fireOnly();
    await until(() => t.host.waiting('apply') === 1, 'применения по сроку');
    const first = t.main.invoke('next-wallpaper', null);
    const second = t.main.invoke('next-wallpaper', null);
    await turns();
    t.host.unhold('apply');
    t.host.release('apply', { ok: true });
    await first;
    await second;
    await turns();
    // Кадр сдвигается, только когда его применение начинается: обогнанное нажатие кадр не
    // двигает, иначе позиция ушла бы на кадр, которого никто не видел.
    assert.deepStrictEqual(t.applied(), ['l1', 'l2', 'l3']);
    const pos = t.main.__test.getConfig().slideshowCurrentPath[MONITOR.id].light;
    assert.strictEqual(path.basename(pos, '.png'), 'l3', `позиция ушла дальше показанного: ${pos}`);
    assert.strictEqual(census.live(), 1, `живых таймеров: ${census.describe()}`);
  });

  await test('игра началась между двумя вопросами: кадр уже сдвинут, и через минуту показывается именно он', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await started(t, census);
    t.host.hold('check-fullscreen');
    census.fireOnly();
    await until(() => t.host.waiting('check-fullscreen') === 1, 'вопроса об игре по сроку');
    t.host.release('check-fullscreen', { ok: true, busy: false });
    // Применение спрашивает об игре ещё раз, и теперь игра идёт.
    await until(() => t.host.waiting('check-fullscreen') === 1, 'второго вопроса об игре');
    t.host.unhold('check-fullscreen');
    t.host.answer('check-fullscreen', { ok: true, busy: true });
    t.host.release('check-fullscreen', { ok: true, busy: true });
    await until(() => census.live() === 1 && /^60000 мс/.test(census.describe()), 'повтора через минуту');
    await turns();
    assert.deepStrictEqual(t.applied(), ['l1']);
    assert.deepStrictEqual(t.homeState(), { kind: 'held', reason: 'gamemode' });
    t.host.answer('check-fullscreen', { ok: true, busy: false });
    census.fireOnly();
    await until(() => t.applied().length === 2, 'отложенного кадра');
    await turns();
    assert.deepStrictEqual(t.applied(), ['l1', 'l2'], 'после игры показан не тот кадр, до которого уже сдвинулись');
    assert.ok(due(census), `после показа интервал не заведён: ${census.describe()}`);
  });

  await test('Windows сменила тему во время игры, интервал включён: после игры — текущий кадр новой темы, а не следующий', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true });
    await started(t, census);
    t.host.answer('check-fullscreen', { ok: true, busy: true });
    t.flipTheme(true);
    await until(() => census.live() === 1 && /^60000 мс/.test(census.describe()), 'повтора через минуту');
    t.host.answer('check-fullscreen', { ok: true, busy: false });
    census.fireOnly();
    await until(() => t.applied().length === 2, 'кадра новой темы');
    await turns(80);
    assert.deepStrictEqual(t.applied(), ['l1', 'd1'], 'отложенная смена темы перелистнула ночной плейлист');
    assert.ok(due(census), `после отложенной смены интервал не заведён заново: ${census.describe()}`);
  });

  await test('Windows сменила тему во время игры, интервал выключен: после игры кадр новой темы всё равно ставится', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true, intervalEnabled: false });
    await started(t, census, { interval: false });
    t.host.answer('check-fullscreen', { ok: true, busy: true });
    t.flipTheme(true);
    await until(() => census.live() === 1, 'повтора через минуту');
    t.host.answer('check-fullscreen', { ok: true, busy: false });
    census.fireOnly();
    await until(() => t.applied().length === 2, 'кадра новой темы', 1000).catch(() => {});
    await turns(80);
    assert.deepStrictEqual(t.applied(), ['l1', 'd1'], 'отложенная смена темы потерялась');
    assert.strictEqual(census.live(), 0, `интервал выключен, а таймер остался: ${census.describe()}`);
  });

  await test('без слайд-шоу обои следуют теме Windows: смена во время игры ставится, когда игра кончилась', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true, slideshow: false });
    t.host.answer('check-fullscreen', { ok: true, busy: true });
    t.flipTheme(true);
    await until(() => t.host.seen.includes('check-fullscreen'), 'вопроса об игре');
    await turns(80);
    assert.deepStrictEqual(t.applied(), []);
    assert.ok(/^60000 мс/.test(census.describe()), `смену темы во время игры некому повторить: ${census.describe()}`);
    t.host.answer('check-fullscreen', { ok: true, busy: false });
    census.fireOnly();
    await until(() => t.applied().length === 1, 'обоев новой темы');
    await turns();
    assert.deepStrictEqual(t.applied(), ['d1']);
    assert.strictEqual(census.live(), 0, `живых таймеров: ${census.describe()}`);
  });

  await test('без слайд-шоу: «как Windows» выключили, пока ждали конца игры — повтора нет', async ({ dir, census }) => {
    const t = boot(dir, { gameModeBlock: true, slideshow: false });
    t.host.answer('check-fullscreen', { ok: true, busy: true });
    t.flipTheme(true);
    await until(() => t.host.seen.includes('check-fullscreen'), 'вопроса об игре');
    await turns(80);
    await t.main.invoke('set-config', { wallpaperSchedule: { mode: 'off' } });
    await turns();
    assert.strictEqual(census.live(), 0, `выключенное «как Windows» оставило повтор: ${census.describe()}`);
    assert.deepStrictEqual(t.applied(), []);
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
