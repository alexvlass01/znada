'use strict';

// BUG-041. Шестерня настроек открывала страницу, но повторным нажатием не закрывала:
// обработчик безусловно звал `showPage('prefs')`. Жалоба пользователя — «закрывать
// настройки на ту же кнопку что и открыл».
//
// Здесь проверяется чистое решение «что делает клик», вынутое из настоящего
// `renderer/renderer.js`. Сам обработчик трогает DOM и в тест не годится, поэтому
// отдельно проверено, что он этим решением действительно пользуется и запоминает
// вкладку ДО перехода — иначе возвращаться будет некуда.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8')
  .split('\r\n').join('\n');

const m = rendererSrc.match(/function gearTargetPage\([^)]*\) \{[\s\S]*?\n\}/);
assert.ok(m, 'gearTargetPage must remain an explicit boundary in renderer.js');
const ctx = {};
vm.createContext(ctx);
const gearTargetPage = vm.runInContext(`(${m[0]})`, ctx);

let passed = 0;
function ok(name, fn) { fn(); console.log('  OK ' + name); passed += 1; }

ok('с любой вкладки шестерня открывает настройки', () => {
  assert.strictEqual(gearTargetPage('home', 'home'), 'prefs');
  assert.strictEqual(gearTargetPage('library', 'home'), 'prefs');
  assert.strictEqual(gearTargetPage('design', 'home'), 'prefs');
});

ok('повторное нажатие возвращает туда, откуда пришли', () => {
  assert.strictEqual(gearTargetPage('prefs', 'library'), 'library');
  assert.strictEqual(gearTargetPage('prefs', 'design'), 'design');
});

ok('возврат в сами настройки невозможен — иначе кнопка перестала бы закрывать', () => {
  assert.strictEqual(gearTargetPage('prefs', 'prefs'), 'home');
  assert.strictEqual(gearTargetPage('prefs', ''), 'home');
  assert.strictEqual(gearTargetPage('prefs', null), 'home');
});

ok('обработчик пользуется этим решением и запоминает вкладку до перехода', () => {
  const handler = rendererSrc.match(/\$\('#btnPrefs'\)\.addEventListener\([\s\S]*?\n {2}\}\);/);
  assert.ok(handler, 'обработчик шестерни не найден');
  const body = handler[0];
  assert.ok(body.includes('gearTargetPage('),
    'обработчик снова решает сам, мимо проверенной функции');
  // Порядок важен: после showPage('prefs') activePage уже 'prefs', и если запомнить
  // страницу ПОСЛЕ перехода, вернуться будет некуда.
  const remembered = body.indexOf('pageBeforePrefs = activePage');
  // Именно вызов, а не любое упоминание: в комментарии рядом тоже написано `showPage`,
  // и поиск по нему находил бы комментарий, стоящий выше кода.
  const navigated = body.indexOf('showPage(gearTargetPage(');
  assert.ok(remembered >= 0, 'обработчик не запоминает вкладку, с которой ушли');
  assert.ok(remembered < navigated, 'вкладка запоминается уже после перехода — поздно');
});

console.log(`\nAll ${passed} prefs-toggle tests passed.`);
