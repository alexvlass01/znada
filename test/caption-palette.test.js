'use strict';

// Верхние 44 px окна собирают ДВА разных источника. Полосу шапки и разделительную черту красит
// CSS (`--headerbar` / `--headerbar-border` в `renderer/styles.css`), а область нативных кнопок
// справа рисует Windows по значению из `main.js` (`titleBarOverlayColors`). Область кнопок
// НЕПРОЗРАЧНА и лежит поверх страницы, поэтому внутри этих 44 px всё, что положил CSS, под
// кнопками пропадает. Отсюда два правила, которые невозможно вывести из кода глядя на один файл:
//
//   1. цвет кнопок обязан совпадать с цветом ПОЛОСЫ (`--headerbar`). Совпал — полоса читается
//      как сплошная во всю ширину; не совпал — зона кнопок становится прямоугольником поверх
//      приложения, а полоса обрывается, не доходя до правого угла.
//   2. разделительная черта обязана лежать НИЖЕ этих 44 px. Пока она была `border-bottom`
//      у `.titlebar`, то есть на 43-м пикселе, под кнопками её съедал оверлей и она не доходила
//      до правого угла окна. Теперь её рисует `.titlebar::after` на `top: 100%`.
//
// Комментарием такую связку не удержать: она живёт в двух файлах сразу. Проверяющий PR #99
// однажды вернул в `main.js` прежние цвета, и ВЕСЬ `npm test` остался зелёным — дефект возвращался
// молча. Этот файл закрывает дыру.
//
// Проверяется не копия функции, а настоящий путь: подставное окно (`__test.useMainWindow`)
// получает ровно то, что `main.js` передаёт в `setTitleBarOverlay`, когда Windows сообщает
// о смене темы через `__test.themeUpdated()`.
//
// Чего тут НЕТ: ширины области кнопок. Её задаёт Windows по масштабу экрана, в коде проекта
// этого числа нет, и выдумывать его в тесте нельзя — сам стык проверяется глазами на живом окне.
//
// Run: node test/caption-palette.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = H.makeTempProfile('caption');
  const real = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    await fn(dir);
    console.log = real.log; console.error = real.error;
    console.log('  OK ' + name);
    passed += 1;
  } catch (e) {
    console.log = real.log; console.error = real.error;
    failures.push({ name, e });
    console.log('  FAIL ' + name + '\n    ' + (e && e.message));
  } finally {
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function ok(name, fn) {
  try { fn(); console.log('  OK ' + name); passed += 1; }
  catch (e) { failures.push({ name, e }); console.log('  FAIL ' + name + '\n    ' + (e && e.message)); }
}

const cssText = fs.readFileSync(path.join(H.ROOT, 'renderer', 'styles.css'), 'utf8')
  .split('\r\n').join('\n');
const mainText = fs.readFileSync(path.join(H.ROOT, 'main.js'), 'utf8')
  .split('\r\n').join('\n');

// Значение переменной из настоящего файла стилей, а не повторённое здесь константой:
// иначе тест сверял бы копию с копией.
function cssVar(selector, name) {
  const block = cssText.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\n\\}'));
  assert.ok(block, 'в styles.css не найден блок ' + selector);
  const value = block[1].match(new RegExp('--' + name + ':\\s*([^;]+);'));
  assert.ok(value, 'в блоке ' + selector + ' не объявлен --' + name);
  return value[1].trim().toLowerCase();
}

function cssBlock(selector) {
  const block = cssText.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\n\\}'));
  assert.ok(block, selector + ' в styles.css не найден');
  return block[1].replace(/\/\*[\s\S]*?\*\//g, ''); // комментарии не считаются объявлениями
}

// Смещения позиционированного блока. Разбирается и longhand (top/right/bottom/left), и шорткат
// `inset`: иначе честное переписывание правила на `inset` уронило бы тест, а это не дефект.
function offsets(block) {
  const out = { top: null, right: null, bottom: null, left: null };
  const inset = block.match(/(^|[;{\s])inset\s*:\s*([^;]+);/);
  if (inset) {
    const v = inset[2].trim().split(/\s+/);
    const four = v.length === 1 ? [v[0], v[0], v[0], v[0]]
      : v.length === 2 ? [v[0], v[1], v[0], v[1]]
        : v.length === 3 ? [v[0], v[1], v[2], v[1]]
          : [v[0], v[1], v[2], v[3]];
    [out.top, out.right, out.bottom, out.left] = four;
  }
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const m = block.match(new RegExp('(^|[;{\\s])' + side + '\\s*:\\s*([^;]+);'));
    if (m) out[side] = m[2].trim();
  }
  return out;
}

// `0`, `0px`, `0%` — всё это ноль; `142px` или `auto` — уже нет.
function isZero(value) {
  return typeof value === 'string' && /^0[a-z%]*$/i.test(value.replace(/\s+/g, ''));
}

const LIGHT_BG = cssVar(':root', 'bg');
const DARK_BG = cssVar('html.dark', 'bg');
const LIGHT_BAR = cssVar(':root', 'headerbar');
const DARK_BAR = cssVar('html.dark', 'headerbar');

// Подставное окно вместо настоящего: под стендом `app.whenReady()` не наступает, поэтому
// окна не существует, а именно ему main и отдаёт палитру.
function captionWindow() {
  const overlays = [];
  return {
    overlays,
    isDestroyed: () => false,
    setTitleBarOverlay: (opts) => overlays.push(opts),
    webContents: { send: () => {} },
  };
}

function seed(dir) {
  H.writeJson(path.join(dir, 'config.json'), {
    autoSwitch: true,
    style: 'fill',
    monitors: {},
    // Смена темы не должна утягивать за собой обои: проверяется палитра, а не расписание.
    wallpaperSchedule: { mode: 'off' },
    slideshow: { enabled: false },
  });
  H.writeJson(path.join(dir, 'config.library.json'), { version: 1, library: {}, trash: [] });
}

console.log('\nПолоса шапки и кнопки окна читаются как одно целое\n');

(async () => {
  // ---- CSS: полоса есть и видна ----

  ok('шапка красит себя сама — иначе полосы нет вовсе', () => {
    assert.match(cssBlock('.titlebar'), /(^|[;{\s])background\s*:\s*var\(--headerbar\)/,
      'у .titlebar больше нет фона var(--headerbar) — полоса сверху пропала целиком');
  });

  ok('полоса отличается от страницы в обеих темах — иначе она невидима', () => {
    for (const [bar, bg, label] of [[LIGHT_BAR, LIGHT_BG, 'светлой'], [DARK_BAR, DARK_BG, 'тёмной']]) {
      assert.match(bar, /^#[0-9a-f]{3,8}$/, label + ' --headerbar не похож на цвет: ' + bar);
      assert.match(bg, /^#[0-9a-f]{3,8}$/, label + ' --bg не похож на цвет: ' + bg);
      assert.notStrictEqual(bar, bg,
        'в ' + label + ' теме полоса (' + bar + ') совпала с фоном страницы (' + bg + ') — её не будет видно');
    }
    assert.notStrictEqual(LIGHT_BG, DARK_BG, 'светлая и тёмная тема получили один фон страницы');
  });

  // ---- CSS: черта лежит НИЖЕ зоны кнопок, иначе обрывается под ними ----

  ok('черта не внутри шапки — там её съедает оверлей кнопок', () => {
    assert.doesNotMatch(cssBlock('.titlebar'), /(^|[;{\s])border-bottom\s*:/,
      'черта снова объявлена внутри .titlebar: эти 44 px под кнопками рисует Windows, '
      + 'и справа черта оборвётся, не дойдя до угла окна');
  });

  ok('черту рисует слой под шапкой, на самой границе оверлея', () => {
    const after = cssBlock('.titlebar::after');
    assert.match(after, /(^|[;{\s])background\s*:\s*var\(--headerbar-border\)/,
      '.titlebar::after больше не красится в --headerbar-border — черта пропала');
    assert.strictEqual(offsets(after).top, '100%',
      '.titlebar::after съехал с top: 100% — черта либо заедет в зону кнопок и оборвётся под ними, '
      + 'либо отойдёт от шапки');
    assert.match(after, /(^|[;{\s])position\s*:\s*absolute/,
      '.titlebar::after перестал быть позиционированным — top: 100% ни на что не повлияет');
    assert.match(cssBlock('.titlebar'), /(^|[;{\s])position\s*:\s*relative/,
      'у .titlebar пропал position: relative — черта отсчитает top: 100% не от шапки');
  });

  // Вертикали мало: черта может стоять на правильной строке и при этом не доходить до кнопок.
  // Ровно это и было дефектом, и ровно это пропускала первая редакция теста — мутация
  // `right: 0` → `right: 142px` обрезала черту перед кнопками, а все проверки оставались
  // зелёными (R5 третьего ревью PR #99).
  ok('черта растянута до обоих краёв окна — иначе снова оборвётся у кнопок', () => {
    const o = offsets(cssBlock('.titlebar::after'));
    assert.ok(isZero(o.left),
      'левый край черты сдвинут (left: ' + o.left + ') — она не доходит до левого края окна');
    assert.ok(isZero(o.right),
      'правый край черты сдвинут (right: ' + o.right + ') — именно так черта и обрывалась перед '
      + 'нативными кнопками. Ширину их области CSS не знает и знать не может, её задаёт Windows '
      + 'по масштабу экрана; единственная запись, которая работает на любом масштабе, — растянуть '
      + 'черту до самого края окна');
  });

  // Правильные цвет, строка и ширина ещё не значат, что черту видно. Объявления могут остаться
  // на месте, а на экране не будет ничего: нулевая высота, снятый content, display/visibility/
  // opacity, прозрачный или слившийся с полосой цвет. Обнуление высоты проходило мимо теста
  // (R6 четвёртого ревью PR #99), поэтому закрывается весь класс, а не одна строка.
  ok('черту видно: есть высота и content, и ничто её не прячет', () => {
    const after = cssBlock('.titlebar::after');

    const height = after.match(/(^|[;{\s])height\s*:\s*([^;]+);/);
    assert.ok(height, 'у .titlebar::after нет высоты — черте неоткуда взяться');
    assert.ok(!isZero(height[2].trim()),
      'высота черты обнулена (height: ' + height[2].trim() + ') — правило на месте, на экране пусто');

    assert.match(after, /(^|[;{\s])content\s*:/,
      'у .titlebar::after пропал content — без него псевдоэлемент не создаётся вовсе');

    for (const [re, what] of [
      [/(^|[;{\s])display\s*:\s*none/, 'display: none'],
      [/(^|[;{\s])visibility\s*:\s*hidden/, 'visibility: hidden'],
      [/(^|[;{\s])opacity\s*:\s*0(?![.\d])/, 'opacity: 0'],
    ]) {
      assert.doesNotMatch(after, re,
        'черта спрятана через ' + what + ' — объявления на месте, на экране ничего');
    }

    // Цвет тоже умеет обнулять черту, не трогая ни одного объявления в .titlebar::after.
    for (const [selector, label] of [[':root', 'светлой'], ['html.dark', 'тёмной']]) {
      const border = cssVar(selector, 'headerbar-border');
      assert.notStrictEqual(border, 'transparent',
        'в ' + label + ' теме черта прозрачна — её не будет видно');
      assert.doesNotMatch(border, /rgba\([^)]*,\s*0(\.0+)?\s*\)$/,
        'в ' + label + ' теме у черты нулевая прозрачность (' + border + ') — её не будет видно');
      assert.notStrictEqual(border, cssVar(selector, 'headerbar'),
        'в ' + label + ' теме черта совпала по цвету с полосой (' + border + ') — она сольётся с ней');
    }
  });

  // ---- main: обработчик отдаёт окну цвет ПОЛОСЫ, а не фон страницы ----

  await test('тёмная тема: кнопки получают цвет полосы, а не фон страницы', async (dir) => {
    seed(dir);
    const theme = { shouldUseDarkColors: false, on: () => {} };
    const m = H.loadMain(dir, { nativeTheme: theme });
    m.__test.loadConfig();
    const win = captionWindow();
    m.__test.useMainWindow(win);

    theme.shouldUseDarkColors = true;
    m.__test.themeUpdated();

    assert.ok(win.overlays.length, 'окну не передали палитру при смене темы');
    const got = String(win.overlays[win.overlays.length - 1].color).toLowerCase();
    assert.notStrictEqual(got, DARK_BG,
      'кнопки покрашены фоном страницы — полоса оборвётся у кнопок, не дойдя до угла окна');
    assert.strictEqual(got, DARK_BAR,
      'кнопки окрашены в ' + got + ', а полоса в ' + DARK_BAR + ' — между ними будет видимый шов');
  });

  await test('светлая тема: то же самое в обратную сторону', async (dir) => {
    seed(dir);
    const theme = { shouldUseDarkColors: true, on: () => {} };
    const m = H.loadMain(dir, { nativeTheme: theme });
    m.__test.loadConfig();
    const win = captionWindow();
    m.__test.useMainWindow(win);

    theme.shouldUseDarkColors = false;
    m.__test.themeUpdated();

    assert.ok(win.overlays.length, 'окну не передали палитру при смене темы');
    const got = String(win.overlays[win.overlays.length - 1].color).toLowerCase();
    assert.notStrictEqual(got, LIGHT_BG,
      'кнопки покрашены фоном страницы — полоса оборвётся у кнопок');
    assert.strictEqual(got, LIGHT_BAR,
      'кнопки окрашены в ' + got + ', а полоса в ' + LIGHT_BAR);
  });

  await test('переключение туда и обратно каждый раз догоняет полосу', async (dir) => {
    seed(dir);
    const theme = { shouldUseDarkColors: false, on: () => {} };
    const m = H.loadMain(dir, { nativeTheme: theme });
    m.__test.loadConfig();
    const win = captionWindow();
    m.__test.useMainWindow(win);

    const seen = [];
    for (const dark of [true, false, true]) {
      theme.shouldUseDarkColors = dark;
      m.__test.themeUpdated();
      seen.push(String(win.overlays[win.overlays.length - 1].color).toLowerCase());
    }
    assert.deepStrictEqual(seen, [DARK_BAR, LIGHT_BAR, DARK_BAR],
      'после нескольких переключений палитра кнопок разошлась с полосой: ' + seen.join(' → '));
  });

  // ---- первый кадр: окно красится ещё до того, как страница нарисуется ----

  ok('фон окна — это фон СТРАНИЦЫ, а не цвет шапки', () => {
    // backgroundColor — то, чем Electron заливает окно ДО первой отрисовки страницы. Совпадать
    // с цветом кнопок он не обязан и не должен: кнопки это шапка, а backgroundColor — страница.
    const window = mainText.match(/backgroundColor:\s*nativeTheme\.shouldUseDarkColors\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/);
    assert.ok(window, 'в main.js не найден backgroundColor главного окна');
    assert.strictEqual(window[1].toLowerCase(), DARK_BG, 'тёмный фон окна разошёлся с --bg');
    assert.strictEqual(window[2].toLowerCase(), LIGHT_BG, 'светлый фон окна разошёлся с --bg');
  });

  if (failures.length) {
    console.log('\n' + failures.length + ' test(s) failed.');
    for (const f of failures) console.log('\n--- ' + f.name + ' ---\n' + (f.e && f.e.stack));
    process.exit(1);
  }
  console.log('\nAll ' + passed + ' caption-palette tests passed.');
})();
