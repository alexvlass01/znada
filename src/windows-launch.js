'use strict';

const path = require('path');

// Historical Run/StartupApproved value names created by source builds and the
// frozen Lumina v1.6.0 installer. The Lumina app set this AUMID before calling
// setLoginItemSettings(), so Electron used it as the default registry value name.
const LEGACY_LOGIN_ITEM_NAMES = Object.freeze([
  'com.squirrel.Lumina.Lumina',
  'electron.app.Znada',
  'electron.app.Lumina',
  'electron.app.Electron',
  'electron.app.Adwaita Wallpaper',
]);

function quoteWindowsArg(value) {
  const text = String(value == null ? '' : value);
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// Squirrel puts the real app in app-<version>/ and a stable Update.exe one level
// above it. Anything persisted by Windows must target the stable launcher; direct
// process.execPath is correct only for dev/portable builds.
function resolveLauncher(execPath, installed) {
  const appExe = path.basename(execPath);
  const appDir = path.dirname(execPath);
  if (!installed) {
    return { installed: false, appExe, target: execPath, cwd: appDir, args: [], shortcutArgs: '' };
  }
  const target = path.resolve(appDir, '..', 'Update.exe');
  const args = ['--processStart', appExe];
  return {
    installed: true,
    appExe,
    target,
    cwd: path.dirname(target),
    args,
    shortcutArgs: `--processStart ${quoteWindowsArg(appExe)}`,
  };
}

function loginItemSettings(execPath, { enabled, startMinimized, name } = {}) {
  const launch = resolveLauncher(execPath, true);
  const appArgs = ['--autostart'];
  if (startMinimized) appArgs.push('--hidden');
  return {
    openAtLogin: !!enabled,
    path: launch.target,
    args: [...launch.args, '--process-start-args', appArgs.join(' ')],
    ...(name ? { name } : {}),
  };
}

function shortcutDetails(execPath, { installed, description, appUserModelId } = {}) {
  const launch = resolveLauncher(execPath, !!installed);
  return {
    target: launch.target,
    cwd: launch.cwd,
    args: launch.shortcutArgs,
    // The current app exe supplies the intended product icon. Squirrel recreates
    // standard Desktop/Start Menu shortcuts on every update, refreshing this path.
    icon: execPath,
    iconIndex: 0,
    description: description || '',
    ...(appUserModelId ? { appUserModelId } : {}),
  };
}

const AUTOSTART_REGISTRY_KEYS = Object.freeze([
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
]);

// Every registry value uninstall has to remove, current name included.
//
// The legacy list on its own is what left an orphan behind: it names only the
// spellings older builds used, so the app's OWN entry survived being uninstalled
// and Windows kept trying to launch an executable that no longer existed. The
// current name belongs here and ONLY here — the routine that runs while the app
// is alive must keep using the legacy list, or it would race against the entry
// it is in the middle of writing.
function autostartCleanupTargets(currentName) {
  const names = [];
  for (const name of [currentName, ...LEGACY_LOGIN_ITEM_NAMES]) {
    if (typeof name === 'string' && name && !names.includes(name)) names.push(name);
  }
  const targets = [];
  for (const key of AUTOSTART_REGISTRY_KEYS) {
    for (const name of names) targets.push({ key, name });
  }
  return targets;
}

// Where the Start menu entry should live, and what to clear away.
//
// Squirrel files its shortcut under an author-named subfolder, so the app shows
// up in Windows as a FOLDER rather than an application: it disappears from the
// app list and is only reachable through search. The entry belongs directly in
// Programs. The stray is returned rather than deleted here so the caller can
// check it holds nothing but our own shortcut before removing anything from the
// user's Start menu.
function startMenuShortcutPlan({ appData, authors, productName } = {}) {
  const root = String(appData || '');
  const name = String(productName || '');
  if (!root || !name) return null;
  const programs = path.join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const desired = path.join(programs, `${name}.lnk`);
  const author = String(authors || '').trim();
  // An author folder named after the product is the same thing twice, not a stray.
  const strayDir = author && author.toLowerCase() !== name.toLowerCase()
    ? path.join(programs, author)
    : '';
  return {
    programs,
    desired,
    strayDir,
    strayLink: strayDir ? path.join(strayDir, `${name}.lnk`) : '',
  };
}

// Можно ли сейчас трогать автозапуск Windows.
//
// Два условия, и оба выучены дорого.
//   * Только установленная сборка. Иначе dev и портативная копии копят в Run
//     собственные записи, и при входе стартует не та версия.
//   * НИКОГДА во время squirrel-события. Деинсталляция честно удаляла запись,
//     но процесс шёл дальше в обычный старт, читал autostart=true и возвращал
//     её обратно. Со стороны это выглядело как «удаление не работает».
// События, на которых установщик распоряжается системой сам и приложение вот-вот
// завершится. `--squirrel-firstrun` СЮДА НЕ ВХОДИТ: это обычный первый запуск
// после установки, полноценная сессия. Запрет на него стоил регистрации
// автозапуска — после установки записи просто не появлялось.
const SQUIRREL_INSTALLER_EVENTS = Object.freeze([
  '--squirrel-install',
  '--squirrel-updated',
  '--squirrel-obsolete',
  '--squirrel-uninstall',
]);

function mayPersistWindowsState({ installed = false, squirrelEvent = '' } = {}) {
  if (!installed) return false;
  return !SQUIRREL_INSTALLER_EVENTS.includes(String(squirrelEvent || ''));
}

// Autostart and the Start menu shortcut ask the SAME question, so they get the same
// answer from the same place. They did not, and it cost half a fix: autostart was
// taught that the first run after install is a normal session, while the shortcut
// stayed behind a blanket "any --squirrel-* argument" test. So a clean install left
// the shortcut in the author folder — the very defect being fixed — until the app was
// launched a second time by hand.
const shouldWriteLoginItem = mayPersistWindowsState;
const shouldNormalizeShortcut = mayPersistWindowsState;

// Everything this app writes OUTSIDE its own install directory, and therefore has to
// take away itself.
//
// Squirrel removes the shortcuts SQUIRREL made, at the placement Squirrel chose. Ours
// are somewhere else by design: the Start menu entry is moved to the root of Programs
// precisely because the author folder made Windows list a folder instead of an app. So
// the uninstaller walked away leaving a shortcut that opens nothing.
function ownShortcutCleanupTargets({ appData, desktop, authors, productName } = {}) {
  const plan = startMenuShortcutPlan({ appData, authors, productName });
  const targets = [];
  if (plan && plan.desired) targets.push(plan.desired);
  if (plan && plan.strayLink) targets.push(plan.strayLink);
  const name = String(productName || '');
  if (desktop && name) targets.push(path.join(String(desktop), `${name}.lnk`));
  return targets;
}
module.exports = {
  AUTOSTART_REGISTRY_KEYS,
  LEGACY_LOGIN_ITEM_NAMES,
  autostartCleanupTargets,
  quoteWindowsArg,
  resolveLauncher,
  loginItemSettings,
  shortcutDetails,
  SQUIRREL_INSTALLER_EVENTS,
  mayPersistWindowsState,
  shouldWriteLoginItem,
  shouldNormalizeShortcut,
  ownShortcutCleanupTargets,
  startMenuShortcutPlan,
};
