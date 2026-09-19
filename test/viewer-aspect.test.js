'use strict';

// BUG-039. Онлайн-фото «дёргалось» при открытии, причём не все, а некоторые.
//
// Прогрессивная загрузка сама по себе не дефект — «мыло, потом резко» ожидаемо. Дефект
// в том, что Wallhaven отдаёт ВСЕМ фотографиям превью 300x200, обрезанное под фиксированную
// рамку: у высокой картинки это её середина крупным планом, а не она сама. Замер на живом
// приложении 2026-09-02: у Wallhaven форма превью не совпала с фотографией в 21 случае из
// 21, расхождение до 144%; у Gelbooru превью уменьшено без обрезки и совпадает всегда.
// Отсюда «некоторые дёргаются, некоторые нет».
//
// Показать такой кадр честно нельзя ничем: вписать по полям — прыгнет размер, заполнить
// с обрезкой — прыгнет содержимое. Поэтому он не показывается вовсе; полная картинка
// всегда правильной формы, так что ждать есть чего.
//
// Здесь проверяются чистые функции, вынутые из настоящего `renderer/viewer.js`, и то, что
// решения из них действительно доходят до показа. Геометрию задаёт CSS-класс, поэтому его
// наличие проверено тоже.

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
const knownAspect = vm.runInContext(`(${viewerFn('knownAspect')})`, ctx);
const frameShapeMatches = vm.runInContext(`(${viewerFn('frameShapeMatches')})`, ctx);

let passed = 0;
function ok(name, fn) { fn(); console.log('  OK ' + name); passed += 1; }

ok('размеры карточки дают пропорции без загрузки файла', () => {
  assert.strictEqual(knownAspect({ raw: { width: 2560, height: 1280 } }), 2);
  assert.strictEqual(knownAspect({ raw: { width: 1000, height: 2000 } }), 0.5);
});

ok('когда размеров нет, разрешение читается из подписи', () => {
  // Ровно тот шаблон «ШИРИНАxВЫСОТА», который уже показывает сам просмотрщик.
  assert.strictEqual(knownAspect({ title: '2560x1280', raw: {} }), 2);
  assert.strictEqual(knownAspect({ subtitle: 'Онлайн - 800x400 - anime', raw: {} }), 2);
});

ok('неизвестные пропорции честно возвращают ноль, а не догадку', () => {
  assert.strictEqual(knownAspect({ title: 'фото', raw: {} }), 0);
  assert.strictEqual(knownAspect({ raw: { width: 0, height: 0 } }), 0);
  assert.strictEqual(knownAspect(null), 0);
  // Мусорные значения не должны превращаться в NaN-пропорции и ломать раскладку.
  assert.strictEqual(knownAspect({ raw: { width: 'широко', height: 10 } }), 0);
});

ok('обрезанный кадр не признаётся годным — его нельзя показать честно', () => {
  // Настоящие числа замера 2026-09-02: Wallhaven отдаёт ВСЕМ фотографиям превью
  // 300x200, поэтому у высокой картинки это её середина крупным планом.
  assert.strictEqual(frameShapeMatches(300, 200, 1000 / 1630), false, 'высокое фото');
  assert.strictEqual(frameShapeMatches(300, 200, 4520 / 1440), false, 'широкое фото');
  // Даже умеренное расхождение заметно: 3840x2161 против 300x200 это 16%.
  assert.strictEqual(frameShapeMatches(300, 200, 3840 / 2161), false, 'умеренное расхождение');
});

ok('уменьшенная копия признаётся годной — её показывать можно', () => {
  // Gelbooru уменьшает без обрезки: 289x350 против 1239x1500.
  assert.strictEqual(frameShapeMatches(289, 350, 1239 / 1500), true);
  assert.strictEqual(frameShapeMatches(2560, 1280, 2), true);
  // Округление размеров у провайдеров не должно отбраковывать годный кадр.
  assert.strictEqual(frameShapeMatches(1281, 640, 2), true);
});

ok('без известных пропорций кадр не отбраковывается', () => {
  // Локальным фотографиям разрешение неоткуда взять — прежнее поведение сохраняется.
  assert.strictEqual(frameShapeMatches(300, 300, 0), true);
  assert.strictEqual(frameShapeMatches(0, 0, 2), true);
});

ok('проверка формы включена именно для предварительных кадров', () => {
  assert.ok(viewerSrc.includes('await present(preview, token, entry, true)'),
    'миниатюра показывается без проверки формы');
  assert.ok(viewerSrc.includes('await present(sample, token, entry, true)'),
    'промежуточный кадр показывается без проверки формы');
  // Полная картинка — сама фотография, её отбраковывать нечем и незачем.
  assert.ok(viewerSrc.includes('await present(full, token, entry)'),
    'полная картинка не должна проходить проверку формы');
});

// Регрессия, которую я сам внёс первой попыткой и поймал замером живого приложения:
// прямоугольник менялся в начале отрисовки, пока на экране ещё висело ПРЕДЫДУЩЕЕ фото,
// и оно на мгновение сплющивалось в коробку нового. При смене формы коробки уходящий
// слой снимается мгновенно, а не уводится плавно.
const stageAspectChanged = vm.runInContext(`(${viewerFn('stageAspectChanged')})`, ctx);

ok('смена формы коробки распознаётся — иначе старое фото сплющит на переходе', () => {
  assert.strictEqual(stageAspectChanged(true, 1.778, 0.75), true, 'широкое → узкое не замечено');
  assert.strictEqual(stageAspectChanged(true, 0.75, 1.778), true, 'узкое → широкое не замечено');
});

ok('одинаковые пропорции подряд коробку не двигают — плавность сохраняется', () => {
  assert.strictEqual(stageAspectChanged(true, 1.778, 1.778), false);
  // Округление у провайдеров: 1920x1080 и 3840x2161 это одна и та же форма на глаз.
  assert.strictEqual(stageAspectChanged(true, 1.7777, 1.77779), false);
});

ok('появление и пропажа известных пропорций тоже меняют коробку', () => {
  assert.strictEqual(stageAspectChanged(false, 0, 1.5), true, 'коробка появилась, но это не замечено');
  assert.strictEqual(stageAspectChanged(true, 1.5, 0), true, 'коробка исчезла, но это не замечено');
  // Ничего не было и не появилось — двигать нечего.
  assert.strictEqual(stageAspectChanged(false, 0, 0), false);
});

ok('решение о мгновенной смене доходит до слоёв', () => {
  assert.ok(/function crossfadeTo\(pair, src, hardSwap\)/.test(viewerSrc),
    'crossfadeTo больше не принимает признак мгновенной смены');
  assert.ok(viewerSrc.includes('showImage(loaded.src, reshaped)'),
    'признак смены формы не передаётся из present в показ слоя');
  // Мало передать признак — он должен приходить от самой проверки. Подстановка
  // константы прошла бы предыдущее утверждение и молча отключила мгновенную смену.
  assert.ok(viewerSrc.includes('const reshaped = applyStageAspect(entry);'),
    'признак смены формы больше не берётся из applyStageAspect');
  const branch = viewerSrc.match(/if \(hardSwap\) \{[\s\S]*?\} else \{/);
  assert.ok(branch, 'нет ветки мгновенной смены для уходящего слоя');
  assert.ok(/transition = 'none'/.test(branch[0]),
    'уходящий слой всё ещё уводится плавно через смену формы коробки');
});

ok('сцена умеет принимать пропорции — иначе слои не совпадут ничем', () => {
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'viewer.css'), 'utf8');
  assert.match(css, /\.media-stage\.has-aspect\s*\{[^}]*aspect-ratio:\s*var\(--photo-aspect\)/,
    'у сцены нет правила, задающего пропорции по известному разрешению');
  assert.match(css, /\.media-stage\.has-aspect\s*\{[^}]*margin:\s*auto/,
    'сцена с заданными пропорциями обязана оставаться по центру окна');
  assert.ok(viewerSrc.includes("stage.classList.add('has-aspect')"),
    'viewer.js не включает режим известных пропорций');
  assert.ok(viewerSrc.includes("stage.classList.remove('has-aspect')"),
    'viewer.js не умеет вернуться к прежнему поведению, когда разрешение неизвестно');
});

// CODE-003. Оба конца этой цепочки проверены выше, а середина — нет, и держалась она на
// совпадении позиций: `showImage(src, fit, hardSwap)` звала `crossfadeTo(STAGE, src, fit, hardSwap)`
// четырьмя аргументами при трёх объявленных. В `hardSwap` попадал `fit`, четвёртый молча
// отбрасывался, и нужное поведение получалось случайно. Своего `fit` у `crossfadeTo` не было
// никогда: имя осталось от `c89d44e`, где параметр добавили в `showImage`, но не в неё.
// Пользователь этого не видит — опасность в следующем, кто «выровняет арность» и уберёт
// лишний аргумент: он вернёт BUG-039, и ни одна проверка не покраснеет.
ok('showImage передаёт признак мгновенной смены именем, а не совпадением позиций', () => {
  assert.ok(/function showImage\(src, hardSwap\)/.test(viewerSrc),
    'у showImage остался мёртвый параметр — признак снова едет по позиции, а не по имени');
  assert.ok(viewerSrc.includes('crossfadeTo(STAGE, src, hardSwap)'),
    'showImage зовёт crossfadeTo не тем набором аргументов, который та объявляет');
  assert.ok(!viewerSrc.includes('crossfadeTo(STAGE, src, fit, hardSwap)'),
    'лишний аргумент всё ещё передаётся и молча отбрасывается');
});

// Ветку выше проверяли регулярным выражением по исходнику: оно докажет, что строка на месте,
// но не то, что она срабатывает. Здесь `crossfadeTo` выполняется по-настоящему на подставных
// слоях, поэтому «мгновенно» и «плавно» различаются результатом, а не написанием.
ok('смена формы коробки снимает уходящий слой мгновенно, а не уводит за 70 мс', () => {
  const crossfadeTo = vm.runInContext(`(${viewerFn('crossfadeTo')})`, ctx);
  const layer = () => ({ style: {}, src: '' });

  const hard = { front: layer(), back: layer() };
  const leavingHard = hard.front;
  crossfadeTo(hard, 'new.jpg', true);
  assert.strictEqual(leavingHard.style.transition, 'none',
    'при смене формы коробки уходящий слой всё ещё уводится плавно — это и есть BUG-039');
  assert.strictEqual(leavingHard.style.opacity, '0', 'уходящий слой не снят');
  assert.strictEqual(hard.front.src, 'new.jpg', 'новый слой не стал текущим');

  const soft = { front: layer(), back: layer() };
  const leavingSoft = soft.front;
  crossfadeTo(soft, 'new.jpg', false);
  assert.strictEqual(leavingSoft.style.transition, '',
    'форма коробки не менялась, а плавный уход подменён мгновенным');
  assert.strictEqual(leavingSoft.style.opacity, '0', 'уходящий слой не снят');
});

console.log(`\nAll ${passed} viewer-aspect tests passed.`);
