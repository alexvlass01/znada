'use strict';

const assert = require('assert');
const path = require('path');
const launch = require('../src/windows-launch');

let passed = 0;
function ok(name, fn) { fn(); console.log('  OK ' + name); passed++; }

const exe = 'C:\\Users\\u\\AppData\\Local\\Znada\\app-1.7.0\\Znada.exe';
const updateExe = path.win32.normalize('C:\\Users\\u\\AppData\\Local\\Znada\\Update.exe');

ok('installed launcher uses stable Update.exe and processStart', () => {
  const result = launch.resolveLauncher(exe, true);
  assert.strictEqual(path.win32.normalize(result.target), updateExe);
  assert.deepStrictEqual(result.args, ['--processStart', 'Znada.exe']);
  assert.strictEqual(result.shortcutArgs, '--processStart "Znada.exe"');
});

ok('portable launcher stays on the direct executable', () => {
  const result = launch.resolveLauncher(exe, false);
  assert.strictEqual(result.target, exe);
  assert.deepStrictEqual(result.args, []);
  assert.strictEqual(result.shortcutArgs, '');
});

ok('login item adds stable launcher, explicit identity and startup flags', () => {
  const result = launch.loginItemSettings(exe, {
    enabled: true,
    startMinimized: true,
    name: 'com.squirrel.Znada.Znada',
  });
  assert.strictEqual(path.win32.normalize(result.path), updateExe);
  assert.deepStrictEqual(result.args, [
    '--processStart', 'Znada.exe', '--process-start-args', '--autostart --hidden',
  ]);
  assert.strictEqual(result.name, 'com.squirrel.Znada.Znada');
});

ok('manual installed shortcut is update-stable and carries AUMID', () => {
  const result = launch.shortcutDetails(exe, {
    installed: true,
    description: 'Znada',
    appUserModelId: 'com.squirrel.Znada.Znada',
  });
  assert.strictEqual(path.win32.normalize(result.target), updateExe);
  assert.strictEqual(result.args, '--processStart "Znada.exe"');
  assert.strictEqual(result.icon, exe);
  assert.strictEqual(result.appUserModelId, 'com.squirrel.Znada.Znada');
});

ok('legacy cleanup includes the real Lumina v1.6 login-item identity', () => {
  assert.ok(launch.LEGACY_LOGIN_ITEM_NAMES.includes('com.squirrel.Lumina.Lumina'));
  assert.ok(!launch.LEGACY_LOGIN_ITEM_NAMES.includes('com.squirrel.Znada.Znada'));
});

// BUG-013. Uninstall used to walk the legacy names only, so the entry this build
// actually writes outlived the uninstaller and Windows kept trying to launch a
// deleted executable at every login. The two lists must stay different: the one
// used while the app is running must NOT contain the current name, or it would
// race against the entry it is writing.
ok('uninstall cleanup covers the name this build writes, not only the old ones', () => {
  const targets = launch.autostartCleanupTargets('com.squirrel.Znada.Znada');
  const names = new Set(targets.map((t) => t.name));
  assert.ok(names.has('com.squirrel.Znada.Znada'), 'own current login item must be removed');
  assert.ok(names.has('com.squirrel.Lumina.Lumina'), 'the predecessor must still be cleaned up');

  const keys = new Set(targets.map((t) => t.key));
  assert.strictEqual(keys.size, launch.AUTOSTART_REGISTRY_KEYS.length, 'both Run keys must be covered');
  assert.strictEqual(targets.length, keys.size * names.size, 'every name is removed from every key');

  const seen = new Set(targets.map((t) => `${t.key}|${t.name}`));
  assert.strictEqual(seen.size, targets.length, 'no duplicated delete');
});

ok('a name already in the legacy list is not scheduled twice', () => {
  const targets = launch.autostartCleanupTargets('com.squirrel.Lumina.Lumina');
  const pairs = targets.map((t) => `${t.key}|${t.name}`);
  assert.strictEqual(new Set(pairs).size, pairs.length);
});

// BUG-015. The installer files its shortcut under an author-named folder, which
// makes Windows list the app as a folder instead of an application: it drops out
// of the app list and only search finds it.
ok('the Start menu entry belongs directly in Programs, and the author folder is a stray', () => {
  const plan = launch.startMenuShortcutPlan({
    appData: 'C:\\Users\\u\\AppData\\Roaming',
    authors: 'alexv',
    productName: 'Znada',
  });
  assert.strictEqual(
    path.win32.normalize(plan.desired),
    'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Znada.lnk',
  );
  assert.strictEqual(
    path.win32.normalize(plan.strayLink),
    'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\alexv\\Znada.lnk',
  );
});

ok('an author folder named after the product is not treated as a stray', () => {
  const plan = launch.startMenuShortcutPlan({
    appData: 'C:\\Users\\u\\AppData\\Roaming',
    authors: 'Znada',
    productName: 'Znada',
  });
  assert.strictEqual(plan.strayDir, '', 'removing it would delete the shortcut we just placed');
  assert.strictEqual(plan.strayLink, '');
});
// BUG-013. Деинсталляция оставляла запись автозапуска, и выглядело это как
// «код удаления не работает». Работал он верно: обработчик её удалял, но процесс
// шёл дальше в обычный старт, читал autostart=true и записывал обратно.
ok('во время squirrel-события автозапуск не трогается', () => {
  assert.strictEqual(
    launch.shouldWriteLoginItem({ installed: true, squirrelEvent: '--squirrel-uninstall' }), false,
    'удаление отменялось тем, что приложение тут же возвращало запись',
  );
  assert.strictEqual(launch.shouldWriteLoginItem({ installed: true, squirrelEvent: '--squirrel-install' }), false);
  assert.strictEqual(launch.shouldWriteLoginItem({ installed: true, squirrelEvent: '--squirrel-updated' }), false);
});

ok('обычный запуск установленной сборки автозапуск настраивает', () => {
  assert.strictEqual(launch.shouldWriteLoginItem({ installed: true, squirrelEvent: '' }), true);
});

ok('запуск не из установки автозапуск не трогает вовсе', () => {
  assert.strictEqual(launch.shouldWriteLoginItem({ installed: false, squirrelEvent: '' }), false);
});

// Первый запуск после установки Squirrel передаёт --squirrel-firstrun. Это
// полноценная сессия, а не событие установщика: запрет на него стоил регистрации
// автозапуска — после установки записи в реестре просто не появлялось.
ok('первый запуск после установки автозапуск настраивает', () => {
  assert.strictEqual(
    launch.shouldWriteLoginItem({ installed: true, squirrelEvent: '--squirrel-firstrun' }), true,
    'после установки автозапуск не регистрировался вовсе',
  );
});


const ROAMING = path.win32.join('C:', 'U', 'AppData', 'Roaming');
const DESKTOP = path.win32.join('C:', 'U', 'Desktop');
const PROGRAMS = path.win32.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

// BUG-015, the half that was missed. Autostart learned that the first run after an
// install is a normal session; the shortcut did not, and stayed behind a blanket "any
// --squirrel-* argument" test. So a clean install left the entry in the author folder —
// the very thing being fixed — until the app happened to be started a second time.
// One question, one rule, one place to change it.
ok('первый запуск после установки нормализует ярлык, как и автозапуск', () => {
  for (const fn of [launch.shouldWriteLoginItem, launch.shouldNormalizeShortcut]) {
    assert.strictEqual(fn({ installed: true, squirrelEvent: '--squirrel-firstrun' }), true);
    assert.strictEqual(fn({ installed: true, squirrelEvent: '--squirrel-install' }), false);
    assert.strictEqual(fn({ installed: true, squirrelEvent: '--squirrel-uninstall' }), false);
    assert.strictEqual(fn({ installed: false, squirrelEvent: '' }), false);
    assert.strictEqual(fn({ installed: true, squirrelEvent: '' }), true);
  }
});

// Squirrel removes what SQUIRREL made, where Squirrel put it. Ours is somewhere else on
// purpose: the Start menu entry is moved to the root of Programs precisely because the
// author folder made Windows list a folder instead of an app. Nothing took it away, so
// uninstalling left a shortcut that opens nothing.
ok('удаление знает про каждый ярлык, который приложение делает само', () => {
  const targets = launch.ownShortcutCleanupTargets({
    appData: ROAMING,
    desktop: DESKTOP,
    authors: 'alexv',
    productName: 'Znada',
  }).map((p) => path.win32.normalize(p));

  assert.ok(
    targets.includes(path.win32.join(PROGRAMS, 'Znada.lnk')),
    'the entry the app moves into Programs itself is never removed',
  );
  assert.ok(
    targets.includes(path.win32.join(DESKTOP, 'Znada.lnk')),
    'the desktop shortcut the app writes itself is never removed',
  );
  assert.ok(
    targets.includes(path.win32.join(PROGRAMS, 'alexv', 'Znada.lnk')),
    'the author-folder entry is left behind when the app never normalised it',
  );
});

ok('ярлык в папке с именем продукта не считается лишним и при уборке', () => {
  const targets = launch.ownShortcutCleanupTargets({
    appData: ROAMING,
    desktop: DESKTOP,
    authors: 'Znada',
    productName: 'Znada',
  });
  assert.strictEqual(targets.length, 2, 'the same folder was listed twice under two names');
});

console.log(`\nAll ${passed} Windows-launch tests passed.`);
