'use strict';

// `node test/tray.test.js` — tests the (conditional) tray menu logic without Electron.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMenuTemplate, createTrayController } = require('../src/tray');

const t = (k) => k; // identity i18n
const A = { onOpen: 'open', onApplyCurrent: 'apply', onNextWallpaper: 'next', onInstallUpdate: 'upd', onQuit: 'quit' };
const labels = (items) => items.filter((i) => i.label).map((i) => i.label);

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

let m = buildMenuTemplate({ slideshowEnabled: false, hasSlideshowItems: false, updateState: 'idle' }, t, A);
ok('base menu = open + applyCurrent + quit (no next, no update)',
  JSON.stringify(labels(m)) === JSON.stringify(['tray.open', 'tray.applyCurrent', 'tray.quit']));

m = buildMenuTemplate({ slideshowEnabled: true, hasSlideshowItems: false, updateState: 'idle' }, t, A);
ok('shows "next wallpaper" when slideshow enabled', labels(m).includes('tray.nextWallpaper'));

m = buildMenuTemplate({ slideshowEnabled: false, hasSlideshowItems: true, updateState: 'idle' }, t, A);
ok('shows "next wallpaper" when playlist has 2+ items', labels(m).includes('tray.nextWallpaper'));

m = buildMenuTemplate({ slideshowEnabled: false, hasSlideshowItems: false, updateState: 'ready' }, t, A);
ok('shows "install update" only when update ready', labels(m).includes('tray.installUpdate'));

ok('click handlers are wired through', m[0].click === A.onOpen && m[m.length - 1].click === A.onQuit);
ok('reapply action remains available without a slideshow', m[1].click === A.onApplyCurrent);

// ---- какой файл иконки берётся -----------------------------------------
// Иконка трея — самая заметная брендовая поверхность: она видна всегда.
// Здесь проверяется ВЫБОР файла, а не картинка: ICO предпочтительнее, потому
// что содержит кадр 16 px, нарисованный попиксельно, и Windows берёт его без
// ужимания. Если ICO нет — обязан работать прежний PNG-путь, иначе сборка без
// новых иконок останется вообще без значка в трее.
function trayWith(files, theme) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-tray-'));
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  const used = [];
  const ctl = createTrayController({
    Tray: class { constructor(img) { used.push(img); } setToolTip() {} setContextMenu() {} on() {} destroy() {} setImage(img) { used.push(img); } },
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: (p) => path.basename(p) },
    assetsDir: dir,
    t,
    getState: () => ({ theme, slideshowEnabled: false, hasSlideshowItems: false, updateState: 'idle' }),
    onOpen: () => {},
  });
  ctl.create();
  fs.rmSync(dir, { recursive: true, force: true });
  return used;
}

const ALL = ['tray-light.ico', 'tray-light.png', 'tray-dark.ico', 'tray-dark.png', 'tray.png'];
ok('светлая тема Windows берёт свой ICO', trayWith(ALL, 'light').every((n) => n === 'tray-light.ico'));
ok('тёмная тема Windows берёт свой ICO', trayWith(ALL, 'dark').every((n) => n === 'tray-dark.ico'));
ok('без ICO работает прежний PNG того же назначения',
  trayWith(['tray-light.png', 'tray-dark.png', 'tray.png'], 'dark').every((n) => n === 'tray-dark.png'));
ok('без тематических файлов остаётся общий запасной',
  trayWith(['tray.png'], 'dark').every((n) => n === 'tray.png'));
ok('иконка ставится сразу при создании, а не только при смене темы',
  trayWith(ALL, 'dark').length >= 1 && trayWith(ALL, 'dark')[0] === 'tray-dark.ico');

// ---- подсказка значка -----------------------------------------------------
// COLLAB-003. Проверочный запуск DEV/DIAG называет свой код и в подсказке трея: значок
// виден, даже когда окно спрятано. Обычный запуск остаётся просто «Znada».
function tooltipsOf(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-tray-'));
  fs.writeFileSync(path.join(dir, 'tray.png'), 'x');
  const tips = [];
  const ctl = createTrayController({
    Tray: class { constructor() {} setToolTip(tip) { tips.push(tip); } setContextMenu() {} on() {} destroy() {} setImage() {} },
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: (p) => path.basename(p) },
    assetsDir: dir,
    t,
    getState: () => ({ theme: 'light', slideshowEnabled: false, hasSlideshowItems: false, updateState: 'idle' }),
    onOpen: () => {},
    ...extra,
  });
  ctl.create();
  fs.rmSync(dir, { recursive: true, force: true });
  return tips;
}
ok('обычный запуск подписан в трее просто «Znada»',
  JSON.stringify(tooltipsOf({})) === JSON.stringify(['Znada']));
ok('проверочный запуск называет в трее свой код',
  JSON.stringify(tooltipsOf({ tooltip: 'Znada · DEV · COLLAB-003 · aaaaaaa' })) === JSON.stringify(['Znada · DEV · COLLAB-003 · aaaaaaa']));

console.log('\nAll ' + passed + ' tray tests passed.');
