'use strict';

/*
 * BUG-042. Просмотрщик сдавался с первой неудачной загрузки: «Не удалось открыть это
 * изображение» — и тупик, из которого нет выхода. Владелец поймал это на кадре 96 из 115
 * при быстром листании.
 *
 * Замер на живом окне тогда исключил три очевидных объяснения: файл 9.1 МБ (вдвое ниже
 * лимита), 151 млн точек Chromium тянет за 0.6 с, а Wallhaven грузится окном напрямую.
 * Отказала сеть, и повторить было некому — по `retry` в `renderer/viewer.js` не находилось
 * ничего.
 *
 * Здесь проверяется политика повторов. Она опаснее, чем кажется, поэтому проверяется
 * поимённо: главная гипотеза причины — всплеск запросов к сайту при быстром листании
 * вместе с предзагрузкой соседей, и слепые повторы этот всплеск УСИЛИВАЮТ. Значит
 * бесконечности быть не должно ни при каких входных данных, а брошенный кадр обязан
 * замолкать сразу, как человек ушёл дальше.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const viewerSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'viewer.js'), 'utf8')
  .split('\r\n').join('\n');

function viewerFn(name) {
  const m = viewerSrc.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} must remain an explicit boundary in viewer.js`);
  return m[0];
}

const ctx = {};
vm.createContext(ctx);
const retryDelayMs = vm.runInContext(`(${viewerFn('retryDelayMs')})`, ctx);

let passed = 0;
function ok(name, fn) { fn(); console.log('  OK ' + name); passed += 1; }

/* ------------------------------------------------------------- политика ---- */

ok('первый отказ даёт повтор, а не приговор — это и есть дефект', () => {
  assert.ok(retryDelayMs(1, 2, 450, true) >= 0,
    'после первой неудачи обязана быть вторая попытка');
});

ok('число попыток ограничено: последняя не порождает следующую', () => {
  assert.strictEqual(retryDelayMs(2, 2, 450, true), -1);
  assert.strictEqual(retryDelayMs(3, 2, 450, true), -1);
});

ok('уход человека на другое фото отменяет повтор немедленно', () => {
  // Не оптимизация: брошенные повторы бьют по сайту ровно тогда, когда ему тяжело,
  // то есть усиливают подозреваемую причину дефекта.
  assert.strictEqual(retryDelayMs(1, 2, 450, false), -1);
  assert.strictEqual(retryDelayMs(1, 99, 450, false), -1);
});

ok('пауза растёт с номером попытки, а не повторяет ту же секунду', () => {
  assert.ok(retryDelayMs(2, 5, 100, true) > retryDelayMs(1, 5, 100, true),
    'вторая попытка обязана ждать дольше первой');
});

ok('пауза никогда не отрицательна и не NaN', () => {
  for (const base of [0, -1, NaN, undefined, 'быстро']) {
    const d = retryDelayMs(1, 2, base, true);
    assert.ok(d === -1 || (Number.isFinite(d) && d >= 0),
      'пауза ' + String(base) + ' дала ' + String(d));
  }
});

ok('мусор на входе не открывает бесконечный цикл', () => {
  // Каждое из этих значений когда-то могло прийти из настроек или из ошибки в вызове.
  for (const [attempt, max] of [
    [NaN, 2], [1, NaN], [Infinity, Infinity], [0, 2], [1, 0], [-5, 5], [1, -1],
  ]) {
    assert.strictEqual(retryDelayMs(attempt, max, 450, true), -1,
      'attempt=' + String(attempt) + ' max=' + String(max) + ' обязан останавливать');
  }
});

/* --------------------------------------------------- проводка в файле ---- */

/*
 * Политика ничего не стоит, если её не зовут. Дальше — то, что легко потерять при
 * следующей правке просмотрщика, и что не видно из чистой функции.
 */

ok('повтор отменяется признаком «человек всё ещё здесь», а не просто числом попыток', () => {
  assert.ok(/active: \(\) => token === VIEWER\.token/.test(viewerSrc),
    'present обязан передавать проверку токена: без неё брошенные кадры продолжают грузиться');
});

ok('загрузка действительно ходит через политику, а не мимо неё', () => {
  const loader = viewerFn('loadImage');
  assert.ok(/retryDelayMs\(/.test(loader), 'loadImage перестал спрашивать политику');
  assert.ok(/loadOnce\(/.test(loader), 'loadImage перестал делать саму попытку');
});

ok('пустой адрес не повторяется', () => {
  // Отсутствие адреса — не сетевой отказ: второй раз он не появится, а ожидание съест
  // время до честного сообщения об ошибке.
  assert.ok(/src \? retryDelayMs\(/.test(viewerFn('loadImage')),
    'повтор пустого src тратит паузу впустую');
});

ok('у отказа есть выход, а не только текст', () => {
  assert.ok(/function setLoadError\(/.test(viewerSrc), 'состояние отказа с действием пропало');
  assert.ok(/setLoadError\(t\('viewer\.loadError'\)/.test(viewerSrc),
    'точка «показать нечего» снова стала тупиком без кнопки');
  const fn = viewerFn('setLoadError');
  assert.ok(/createElement\('button'\)/.test(fn), 'кнопка повтора исчезла');
  assert.ok(!/innerHTML/.test(fn),
    'разметка состояния собирается строкой: в неё попадает перевод, это лишняя дыра');
});

ok('кнопка повтора не срабатывает дважды по одному нажатию', () => {
  const fn = viewerFn('setLoadError');
  assert.ok(/button\.disabled = true/.test(fn),
    'без блокировки двойное нажатие запускает два показа одновременно');
});

ok('подпись кнопки есть в обоих эталонных языках', () => {
  for (const lang of ['en', 'ru']) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lang + '.json'), 'utf8')
      .replace(/^\uFEFF/, ''));
    assert.ok(dict.viewer && dict.viewer.retry, lang + ': нет viewer.retry');
  }
});

ok('скрытие пилюли не ломается новым display', () => {
  // `.media-state[hidden]` и `.media-state.has-action` имеют ОДИНАКОВУЮ специфичность:
  // поставленный ниже `display: inline-flex` показал бы пустую пилюлю поверх фотографии.
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'viewer.css'), 'utf8');
  const action = css.indexOf('.media-state.has-action {');
  const hidden = css.indexOf('.media-state[hidden] {');
  assert.ok(action >= 0 && hidden >= 0, 'правила состояния пропали из viewer.css');
  assert.ok(action < hidden, 'правило has-action уехало ниже [hidden] и перебивает скрытие');
});

console.log(`\nAll ${passed} viewer-retry tests passed.`);
