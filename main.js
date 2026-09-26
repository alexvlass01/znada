'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain: electronIpcMain, nativeTheme, dialog, shell, nativeImage, screen, autoUpdater, globalShortcut, powerMonitor, safeStorage, Notification, clipboard, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile, execFileSync } = require('child_process');
const playlist = require('./src/playlist'); // чистая логика плейлистов (тестируется отдельно)
const library = require('./src/library'); // пул контента { [id]: Item }; слоты ссылаются по id
const ipcAuthorityMod = require('./src/ipc-authority'); // SEC-002: кто вправе звать какой канал
const pathGrantsMod = require('./src/path-grants'); // SEC-002: какие пути приложение подтвердило само
const { pathKey, isDirectChildPath } = require('./src/path-key'); // canonical identity for every local path map
const libraryAssignment = require('./src/library-assignment');
const folderState = require('./src/folder-state'); // persistent firstSeenAt для файлов живых папок
const liveFolderWatch = require('./src/live-folder-watch'); // lightweight fs.watch lifecycle + debounce
// ONL-013: ни поиск, ни поиск по отпечатку больше не называют сайтов — оба ходят через
// реестр, поэтому прямые require адаптеров здесь не нужны.
const online = require('./src/online');
const sizeFilter = require('./src/size-filter'); // ONL-010: подходит ли картинка под экран
const onlineResume = require('./src/online-resume'); // ONL-014b: где какой сайт остановился // смешивание и дедуп результатов внешних провайдеров
const mediaProxy = require('./src/media-proxy'); // PERF-008: адресация потокового прокси картинок
const originalStoreMod = require('./src/original-store'); // PERF-010: оригинал, который уже скачан
const providerRegistry = require('./src/provider-registry'); // ONL-011/012: единый список сайтов и их объявления
const onlineSources = require('./src/online-sources');
const onlineQuickFilters = require('./src/online-quick-filters'); // DESIGN-002: закреплённые быстрые фильтры
const mediaFormats = require('./src/media-type'); // ONL-015: единый список форматов картинок
const tagSuggest = require('./src/tag-suggest'); // ONL-014: строка поиска (написание тега, токен под курсором)
const itemDetails = require('./src/item-details'); // bounded metadata reader + URL/path validation
const { WallpaperHost, HOST_SCRIPT } = require('./src/wallpaper-host'); // живой PowerShell-COM-хост
const configMod = require('./src/config'); // дефолты + load/migrate/save (тестируется отдельно)
const libraryStore = require('./src/library-store'); // пул живёт в своём файле с пакетной записью
const fingerprint = require('./src/fingerprint'); // что файл ЕСТЬ: кешируемый отпечаток байтов
const metadataLookup = require('./src/metadata-lookup'); // кого спрашивать, стоит ли и что это значит
const metadataStore = require('./src/metadata-store'); // отпечатки и журнал запросов (производное, не данные пользователя)
const requestBudget = require('./src/request-budget'); // сколько запросов наружу вообще разрешено
const coalesce = require('./src/coalesce'); // склейка частых рассылок конфига в интерфейс
const { createTrayController } = require('./src/tray'); // системный трей (меню + иконка)
const schedule = require('./src/schedule'); // чистая математика расписаний день/ночь (время/солнце)
const { createStealthController } = require('./src/stealth-session'); // отменяемая «невидимая смена» (под тестами)
const nextChange = require('./src/next-change'); // что Главной РАЗРЕШЕНО обещать про следующую смену (HOME-001)
const { createTaskQueue } = require('./src/task-queue'); // small async queue for expensive OS thumbnail jobs
const { ThumbnailHost, resolveThumbnailHelperPath } = require('./src/thumbnail-host');
const { createFailureNotifier } = require('./src/failure-notifier'); // edge-trigger «работало→сломалось» (T2)
const { createEventLog } = require('./src/event-log'); // bounded журнал сбоев/восстановлений (T3)
const { createNotificationDelivery } = require('./src/notification-delivery'); // отдельная проверка доставки Windows Notification
const cloudCapabilityMod = require('./src/cloud/capability'); // Znada Cloud: какое окружение разрешено (C2)
const cloudClientMod = require('./src/cloud/client'); // Znada Cloud: чистый API-клиент (C1); реальный fetch в main (C3)
const cloudOauth = require('./src/cloud/oauth'); // Znada Cloud: чистый PKCE/loopback-разбор (C4)
const cloudDevProfile = require('./src/cloud/dev-profile'); // isolated userData for explicit staging launches
const diagnosticsGate = require('./src/diagnostics-gate'); // production-safe gate for dev-only diagnostics
const devLaunchGate = require('./src/dev-launch-gate'); // COLLAB-003: is this a DEV/DIAG check launch (the rest is dev-only)
const galleryPayloadMod = require('./src/gallery-payload'); // viewer payload sanitizing/windowing
const hotkey = require('./src/hotkey'); // accelerator parsing + atomic globalShortcut replacement
const windowsLaunch = require('./src/windows-launch');
const mediaRoot = require('./src/media-root'); // DATA-006: где лежат собственные копии Znada
const mediaMove = require('./src/media-move'); // DATA-006: копирование, проверка и уборка при переезде
const profileMigrationMod = require('./src/profile-migration'); // DATA-006: пересчёт путей под новый корень
const applyOutcome = require('./src/apply-outcome'); // пустой слот против исчезнувшего источника
const poolConsistency = require('./src/pool-consistency'); // ссылки слотов против содержимого пула // stable Squirrel launch targets for Run/.lnk

// Match the AppUserModelID written into the Start Menu shortcut by our
// electron-winstaller/Squirrel package (`name: Znada`, `exe: Znada.exe`).
// Packaged Electron discovers this identity automatically, but source/dev runs
// otherwise surface as `electron.app.Electron` in Windows notification banners.
const WINDOWS_APP_USER_MODEL_ID = 'com.squirrel.Znada.Znada';
// Установщик кладёт свой ярлык в папку с этим именем; отсюда же берём его, чтобы
// знать, что именно убирать. Держать в одном месте с AUMID.
const PACKAGE_AUTHORS = 'alexv';
function cleanLegacyAutostartRegistryValues() {
  for (const key of windowsLaunch.AUTOSTART_REGISTRY_KEYS) {
    for (const name of windowsLaunch.LEGACY_LOGIN_ITEM_NAMES) {
      // `reg.exe` is a console program. Keep this best-effort migration silent in
      // the packaged GUI app instead of flashing up to ten console windows at login.
      execFile('reg', ['delete', key, '/v', name, '/f'], { windowsHide: true }, () => {});
    }
  }
}

// Resolve dev-only userData overrides before the single-instance lock and before
// any paths are derived from app.getPath('userData'). Diagnostics intentionally
// has its own profile; Cloud staging remains independent and is used only when
// diagnostics is not explicitly enabled.
const DIAGNOSTICS_BOOTSTRAP = diagnosticsGate.resolveDiagnosticsBootstrap({
  isPackaged: app.isPackaged,
  env: process.env,
  argv: process.argv,
  localAppData: process.env.LOCALAPPDATA,
});
if (DIAGNOSTICS_BOOTSTRAP.enabled) app.setPath('userData', DIAGNOSTICS_BOOTSTRAP.userDataPath);

// Resolve staging userData after diagnostics. This keeps config, wallpapers,
// Chromium storage and safeStorage-encrypted Cloud sessions separate from prod.
const STAGING_USER_DATA = DIAGNOSTICS_BOOTSTRAP.enabled ? null : cloudDevProfile.resolveStagingUserData({
  isPackaged: app.isPackaged,
  cloudEnv: process.env.ZNADA_CLOUD,
  requestedPath: process.env.ZNADA_DEV_USER_DATA,
});
if (STAGING_USER_DATA) app.setPath('userData', STAGING_USER_DATA);

// COLLAB-003. A DEV or DIAG check launch says which code it runs and closes itself an hour
// after start. Only the decision ships: the label, the git read and the hour live in
// diagnostics/main/dev-launch.js, which no user package contains, and a packaged build is
// always an ordinary launch. A check launch that cannot say which profile it may use is
// refused here, before any path is derived from userData: falling back used to mean the
// real %APPDATA%\znada.
const DEV_LAUNCH = devLaunchGate.resolveDevLaunch({
  isPackaged: app.isPackaged,
  diagnostics: DIAGNOSTICS_BOOTSTRAP,
  stagingRequested: (process.env.ZNADA_CLOUD || '').trim() === 'staging',
  stagingUserData: STAGING_USER_DATA,
});
const devLaunchTools = DEV_LAUNCH.mode || DEV_LAUNCH.refusal ? require('./diagnostics/main/dev-launch') : null;
if (DEV_LAUNCH.refusal) {
  const message = devLaunchTools.refusalMessage(DEV_LAUNCH.refusal);
  console.error(`[DEV] ${message}`);
  // Allowed before ready, and shown on purpose: a launch from a shortcut has no console.
  try { dialog.showErrorBox('Znada: проверочный запуск отклонён', message); } catch { /* the console has it */ }
  app.exit(2);
}
// The hour starts here rather than on ready: it counts from the launch, and nothing a window
// does later, opening it again included, may move it.
let devSessionLimitReached = false;
const devSession = DEV_LAUNCH.mode
  ? devLaunchTools.createSessionLimit({
    onExpire: () => {
      quitForDevSessionLimit().catch((err) => console.error('[DEV] closing after the hour failed:', err));
    },
  }).start()
  : null;
const DEV_LAUNCH_INFO = DEV_LAUNCH.mode ? devLaunchTools.describeLaunch({
  mode: DEV_LAUNCH.mode,
  userDataPath: app.getPath('userData'),
  revision: devLaunchTools.readRevision({ root: __dirname, execFileSync }),
  startedAt: devSession.state().startedAt,
  limitMs: devSession.state().limitMs,
}) : null;
if (DEV_LAUNCH_INFO) {
  console.log(`[DEV] ${DEV_LAUNCH_INFO.windowTitle}; userData=${DEV_LAUNCH_INFO.profilePath}; `
    + `closes itself at ${new Date(DEV_LAUNCH_INFO.closesAt).toLocaleTimeString()}`);
}

// ---------------------------------------------------------------------------
// Squirrel.Windows install/update/uninstall events (creates/removes shortcuts,
// then quits immediately). No-op for the portable build / when not installed.
// ---------------------------------------------------------------------------
// electron-squirrel-startup removes shortcuts but knows nothing about the
// login item created by this app. Remove the exact, explicitly named entry
// before the dependency handles --squirrel-uninstall and exits. Keep this
// best-effort cleanup separate: a registry error must not suppress Squirrel's
// own uninstall handler.
// Squirrel запускает приложение своими событиями при установке, обновлении и
// удалении. В такие запуски обычная логика старта лезть не должна: она пишет
// в реестр и в меню «Пуск» то, что установщик прямо сейчас убирает.
const SQUIRREL_LIFECYCLE_EVENT = process.platform === 'win32'
  && /^--squirrel-/.test(String(process.argv[1] || ''))
  ? String(process.argv[1])
  : '';
if (SQUIRREL_LIFECYCLE_EVENT === '--squirrel-uninstall') {
  // SYNCHRONOUS on purpose, and going straight at the registry.
  //
  // The previous shape left the entry behind every time, for two reasons at once.
  // `app.setLoginItemSettings` ran before the app was ready, and the registry
  // cleanup was fired off asynchronously while `electron-squirrel-startup` quit
  // the process on the very next statement — the deletions never got to run. It
  // also walked the legacy names only, which do not include the name this build
  // actually writes, so even a completed run would have missed it.
  //
  // Cost of getting this wrong is not cosmetic: Windows keeps trying to start an
  // executable the uninstaller has already deleted, at every single login.
  for (const target of windowsLaunch.autostartCleanupTargets(WINDOWS_APP_USER_MODEL_ID)) {
    try {
      execFileSync('reg', ['delete', target.key, '/v', target.name, '/f'],
        { windowsHide: true, stdio: 'ignore' });
    } catch {
      // `reg delete` exits non-zero when the value is simply not there, which is
      // the normal case for most of these names. Nothing to report.
    }
  }

  // Squirrel takes away the shortcuts SQUIRREL made, at the placement Squirrel chose.
  // Ours are deliberately elsewhere — the Start menu entry is moved to the root of
  // Programs precisely because the author folder made Windows list a folder instead of
  // an app — so the uninstaller walked away leaving a shortcut that opens nothing.
  try {
    for (const target of windowsLaunch.ownShortcutCleanupTargets({
      appData: app.getPath('appData'),
      desktop: app.getPath('desktop'),
      authors: PACKAGE_AUTHORS,
      productName: 'Znada',
    })) {
      try { fs.rmSync(target, { force: true }); } catch { /* already gone */ }
    }
  } catch (err) {
    console.error('[Uninstall] Не удалось убрать собственные ярлыки:', err);
  }
}
try {
  if (require('electron-squirrel-startup')) {
    app.quit();
  }
} catch { /* module absent (e.g. running from source) — ignore */ }

// ---------------------------------------------------------------------------
// Single instance (the lock follows the selected userData profile, so isolated
// staging and installed production can run at the same time).
// ---------------------------------------------------------------------------
// COLLAB-003. A check launch tells the running one which code it carries, so a profile that
// is already open with other code is turned away out loud rather than silently showing that
// other window as if it were this one. An ordinary launch asks exactly as before.
// A refused check launch never asks at all: asking would wake whichever instance holds the
// profile it fell back to, and that one is the user's own Znada.
let gotLock = false;
if (!DEV_LAUNCH.refusal) {
  gotLock = DEV_LAUNCH_INFO
    ? app.requestSingleInstanceLock({ znadaDevLaunch: devLaunchTools.identityOf(DEV_LAUNCH_INFO) })
    : app.requestSingleInstanceLock();
}
if (!gotLock) {
  if (DEV_LAUNCH_INFO) console.error(`[DEV] ${devLaunchTools.busyProfileMessage(DEV_LAUNCH_INFO)}`);
  app.quit();
}

// Squirrel's Update.exe forwards login-item args via a single `--process-start-args`
// string; depending on its version the app may receive "--autostart --hidden" as one argv
// entry OR as two. Normalize by re-splitting all args on whitespace so each flag is detected
// either way (a brittle exact-match once silently broke --hidden).
const LAUNCH_FLAGS = process.argv.slice(1).join(' ').split(/\s+/).filter(Boolean);
const STARTED_HIDDEN = LAUNCH_FLAGS.includes('--hidden');
// True only when Windows launched us from the login item (the Run entry passes --autostart),
// NOT on a manual/dev/portable launch. Gates the "on Windows startup" wallpaper trigger.
const STARTED_AUTOSTART = LAUNCH_FLAGS.includes('--autostart');
const START_TS = Date.now();
// During startup and just after resume, a theme catch-up flip (schedule/OS settling) must not
// pop a "Windows switched theme" toast — it's a background event, not a fresh user action.
// Genuine visible theme changes after this window still announce. See nativeTheme 'updated'.
let themeToastQuietUntil = START_TS + 10000;
// Last light/dark value we actually acted on. Windows fires nativeTheme 'updated' spuriously
// when a wallpaper is applied (same value) — we compare against this to ignore those.
let lastNativeDark = null;

let mainWindow = null;
let galleryWindow = null;
let galleryWindowNormalBounds = null;
let galleryWindowFullscreen = false; // tracked explicitly: enter/leave-full-screen events are unreliable for frameless windows on Windows
let galleryPayload = { items: [], index: 0 };
let diagnosticsController = null;
let diagnosticsControlWindow = null;
app.isQuitting = false;

// --- Diagnostics glue (dev-only). When the gated controller is absent these are
// no-op closures, so instrumented hot paths pay a single null-check in production.
const DIAG_NOOP_END = () => {};
function diagSpan(category, name, attributes) {
  if (!diagnosticsController) return DIAG_NOOP_END;
  return diagnosticsController.startSpan(category, name, attributes);
}
function diagEvent(raw) {
  if (diagnosticsController) diagnosticsController.recordEvent(raw);
}
function diagCountSend(channel) {
  if (diagnosticsController) diagnosticsController.countChannel(channel);
}

// ---------------------------------------------------------------------------
// Background-failure reporting (plan error_notifications, T2+T3).
// failureNotifier = pure edge detector («работало→сломалось» уведомляет один раз,
// успех сбрасывает и один раз отмечает восстановление). eventLog = bounded журнал
// в СВОЁМ файле (не в config: запись не должна дёргать config-changed broadcast).
// ---------------------------------------------------------------------------
const failureNotifier = createFailureNotifier();
const eventLog = createEventLog({ filePath: path.join(app.getPath('userData'), 'event-log.json') });
const deliverSystemNotification = createNotificationDelivery({
  NotificationClass: Notification,
  translate: (key) => tMain(key),
  onClick: () => showWindow(),
  logError: (err) => console.error('[Notify] failed to show notification:', err),
});

// Journal + (optionally) a Windows notification, once per working→broken edge.
// `notify:false` channels journal quietly (e.g. a live folder on an unplugged disk —
// tolerated per LF-QA1, worth a journal line, not worth a popup).
function reportChannelFailure(channel, messageKey, { titleKey, bodyKey, notify = true, params } = {}) {
  if (!failureNotifier.fail(channel)) return; // still broken — stay silent until it recovers
  eventLog.append({ channel, kind: 'failure', messageKey, params });
  if (!notify || config.notifyOnFailure === false) return;
  deliverSystemNotification({ titleKey: titleKey || messageKey, bodyKey: bodyKey || messageKey });
}

function reportChannelSuccess(channel, messageKey, { params } = {}) {
  if (failureNotifier.success(channel)) {
    eventLog.append({ channel, kind: 'recovered', messageKey, params });
  }
}

// Wallpaper-apply outcomes flow through here from the applyForTheme wrapper.
//
// Reasons this channel stays quiet about. 'no-wallpaper' (nothing configured at all,
// or a slot the user emptied) and 'gamemode-blocked' (a deliberate postpone) are
// states rather than breakages. 'wallpaper-missing' IS a breakage — it is reported,
// just by the channel below that owns it, so the user gets one notification and not
// two for the same event.
const APPLY_EXPECTED_REASONS = new Set(['no-wallpaper', 'gamemode-blocked', 'wallpaper-missing']);

// A configured photo that is not there any more: the disk was unplugged, the folder
// was renamed, the file was deleted from outside the app.
//
// Its own channel on purpose. It is independent of whether the apply SUCCEEDED — with
// two monitors and one broken source the desktop still changes, and that half used to
// pass in silence. Journal-only would not do here: the checklist expects Windows to
// say something, and unlike a live folder that merely stopped indexing, this is the
// user's wallpaper not going up.
function reportMissingSources(result) {
  const missing = Array.isArray(result.missing) ? result.missing : [];
  if (missing.length) {
    reportChannelFailure('wallpaper-source', 'journal.wallpaperSource', {
      titleKey: 'notify.wallpaperSourceMissingTitle',
      bodyKey: 'notify.wallpaperSourceMissingBody',
    });
    return;
  }
  // Recovery is about the SOURCE, not about the apply. Tying it to a successful apply
  // would leave the channel stuck on "broken" whenever the file came back but the COM
  // call failed for its own reasons — and would report a recovery on paths that never
  // looked at a source at all (a game-mode postpone, a failed monitor enumeration).
  // sourcesChecked marks the results that actually resolved every slot.
  if (result.sourcesChecked) reportChannelSuccess('wallpaper-source', 'journal.wallpaperSource');
}

function reportApplyOutcome(result, isManual) {
  if (!result) return;
  reportMissingSources(result);
  if (result.ok) {
    // Any successful apply (manual or auto) proves the pipeline works again.
    reportChannelSuccess('wallpaper-auto', 'journal.wallpaperAuto');
    return;
  }
  if (APPLY_EXPECTED_REASONS.has(result.reason || '')) return;
  if (isManual) {
    // Manual failures already toast in the UI (T1); journal them for history.
    eventLog.append({ channel: 'wallpaper-manual', kind: 'failure', messageKey: 'journal.wallpaperManual' });
  } else {
    reportChannelFailure('wallpaper-auto', 'journal.wallpaperAuto', {
      titleKey: 'notify.wallpaperFailedTitle',
      bodyKey: 'notify.wallpaperFailedBody',
    });
  }
}

const thumbnailHost = new ThumbnailHost({
  executablePath: resolveThumbnailHelperPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  }),
  onEvent: (name, attributes) => {
    // Circuit open = thumbnails degraded to placeholders until the helper recovers —
    // exactly the kind of silent background breakage the journal/notifier exist for.
    if (name === 'circuit-open') {
      reportChannelFailure('thumbnail-helper', 'journal.thumbs', {
        titleKey: 'notify.thumbsFailedTitle',
        bodyKey: 'notify.thumbsFailedBody',
      });
    } else if (name === 'ready') {
      reportChannelSuccess('thumbnail-helper', 'journal.thumbs');
    }
    const totalMs = Number(attributes && attributes.totalMs);
    const isResponse = name === 'response' && Number.isFinite(totalMs);
    diagEvent({
      kind: isResponse ? 'span' : 'lifecycle',
      category: 'thumbnail-helper',
      name,
      timestampMs: isResponse ? Date.now() - Math.max(0, totalMs) : Date.now(),
      ...(isResponse ? { durationMs: Math.max(0, totalMs) } : {}),
      attributes,
    });
  },
});
// Renderer preloads only attach the diagnostics probe when they see this argument, and
// main only passes it under the dev-only gate — so a packaged build never activates it.
function diagRendererArgs(role) {
  return DIAGNOSTICS_BOOTSTRAP.enabled ? [`--znada-diagnostics-renderer=${role}`] : [];
}

// COLLAB-003. The main window's title bar shows which code a check launch runs.
function devLaunchRendererArgs() {
  return DEV_LAUNCH_INFO ? [devLaunchTools.rendererArg(DEV_LAUNCH_INFO)] : [];
}

// Small dev-only control window (Start/Stop/mark/report). It is NOT instrumented — it
// uses its own control-preload (no probe), and its process is tagged 'renderer-
// diagnostics' so the report excludes it from the app's own smoothness verdict.
function openDiagnosticsControlWindow() {
  if (!DIAGNOSTICS_BOOTSTRAP.enabled) return;
  if (diagnosticsControlWindow && !diagnosticsControlWindow.isDestroyed()) { diagnosticsControlWindow.focus(); return; }
  diagnosticsControlWindow = new BrowserWindow({
    width: 300,
    height: 520,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    alwaysOnTop: true, // float above the app so the user keeps working in the main window
    title: 'Znada Diagnostics',
    backgroundColor: '#1b1b1b',
    webPreferences: {
      preload: path.join(__dirname, 'diagnostics', 'ui', 'control-preload.js'),
      ...windowSecurity('diagnostics'),
    },
  });
  diagnosticsControlWindow.setMenuBarVisibility(false);
  // Electron 35+ passes one details object instead of positional args (and `level`
  // became a string). We only ever logged the text and origin, so nothing else moves.
  diagnosticsControlWindow.webContents.on('console-message', ({ message, sourceId, lineNumber }) => {
    console.log(`[Diag Control] ${message} (${sourceId}:${lineNumber})`);
  });
  diagnosticsControlWindow.webContents.on('preload-error', (e, p, err) => {
    console.error('[Diag Control] preload-error:', p, err);
  });
  diagnosticsControlWindow.webContents.on('did-fail-load', (e, code, desc) => {
    console.error('[Diag Control] did-fail-load:', code, desc);
  });
  diagnosticsControlWindow.loadFile(hardenWindow(diagnosticsControlWindow, 'diagnostics'));
  // Show WITHOUT stealing focus, so the main window stays foreground and keeps rendering
  // (and thus keeps being sampled) while this panel floats beside it.
  diagnosticsControlWindow.once('ready-to-show', () => {
    if (diagnosticsControlWindow && !diagnosticsControlWindow.isDestroyed()) diagnosticsControlWindow.showInactive();
  });
  diagnosticsControlWindow.on('closed', () => { diagnosticsControlWindow = null; });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const FOLDER_STATE_PATH = path.join(app.getPath('userData'), 'folder-state.json');

// DATA-006. Where Znada's own copies live is a SETTING, so it cannot be a constant
// resolved while this file loads — at that moment config.json has not been read yet.
// Everything asks wallpapersDir() instead, and the answer changes only through
// refreshManagedRoot(). Capturing it in another module-level const would quietly
// reintroduce the bug this replaces, which is what test/media-root-main.test.js checks.
const USER_DATA_PATH = app.getPath('userData');
let managedRoot = mediaRoot.resolveManagedRoot({ userDataPath: USER_DATA_PATH, mediaFolder: '' });
function wallpapersDir() { return managedRoot.root; }
function trashDirPath() { return path.join(managedRoot.root, '.trash'); }

function refreshManagedRoot() {
  managedRoot = mediaRoot.resolveManagedRoot({
    userDataPath: USER_DATA_PATH,
    mediaFolder: config && config.mediaFolder,
  });
  return managedRoot;
}

function systemRootsForFolderCheck() {
  const roots = [
    process.env.SystemRoot, process.env.windir, process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'], process.env.ProgramData,
  ];
  try { roots.push(path.dirname(app.getPath('exe'))); } catch {}
  return roots.filter(Boolean);
}

// Asked live, never cached: a removable drive can leave between two user actions, and a
// cached "ready" would let a write land somewhere the user did not choose.
// A saved folder the rules refuse today (a hand-edited setting, or one written before a
// rule existed). Pure string checks, no disk: it is also asked for every path a window
// wants to read.
function managedRootInvalid() {
  return managedRoot.custom && !!mediaRoot.folderProblem({
    folder: managedRoot.parent,
    userDataPath: USER_DATA_PATH,
    systemRoots: systemRootsForFolderCheck(),
  });
}

function managedRootStatus() {
  return mediaRoot.rootState({
    rootExists: dirExists(managedRoot.root),
    anchorExists: dirExists(managedRoot.anchor),
    invalid: managedRootInvalid(),
  });
}

// The single rule behind every guard below: while our folder is not there, Znada writes
// nothing, deletes nothing and declares nothing missing. Owner's decision 2026-09-09 —
// a disk that is absent means the files are temporarily unreachable, not gone.
function managedRootReady() {
  return managedRootStatus().state !== 'unavailable';
}

function managedRootUnavailableError() {
  return new Error('Managed media folder is unavailable');
}

// Copy a chosen image into the app's own data dir so it survives app updates and
// the original being moved/deleted. Content-addressed name (wp-<md5>) → identical
// images dedupe automatically and re-adding the same file is a no-op. Returns path.
async function importWallpaper(srcPath) {
  // DATA-006. mkdir would happily CREATE the chosen folder on a drive that is merely
  // missing its letter today, and the copy would land somewhere the user never picked.
  if (!managedRootReady()) throw managedRootUnavailableError();
  await fs.promises.mkdir(wallpapersDir(), { recursive: true });
  const buf = await fs.promises.readFile(srcPath); // async: не блокируем main-поток на больших файлах
  const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 16);
  const ext = (path.extname(srcPath) || '.img').toLowerCase();
  const dest = path.join(wallpapersDir(), `wp-${hash}${ext}`);
  if (!fs.existsSync(dest)) await fs.promises.writeFile(dest, buf);
  return dest;
}

// Download a remote image into a private staging file beside its content-addressed
// destination. The caller exposes it only after any session/ownership check succeeds.
// That matters for Cloud: writing the shared destination first and later deleting it on
// a stale result races a second, current operation that may already have adopted it.
async function stageDownloadImage(dir, url, fetchOptions = {}) {
  await fs.promises.mkdir(dir, { recursive: true });
  const options = fetchOptions && typeof fetchOptions === 'object' ? fetchOptions : {};
  // PERF-010. `fetchImpl` says where the bytes come from (see originalFetchFor). Whatever
  // answers, the checks below are the same ones: there is no second, trusting branch.
  const { expectedFormat = '', fetchImpl = fetch, ...requestOptions } = options;
  const res = await fetchImpl(url, requestOptions);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (expectedFormat) {
    const responseType = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('content-type')
      : '';
    if (!mediaFormats.mimeMatchesFormat(responseType, expectedFormat)) {
      throw new Error('Unexpected image Content-Type');
    }
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 16);
  let ext = '.jpg';
  try { const e = path.extname(new URL(url).pathname).toLowerCase(); if (/^\.[a-z0-9]{2,5}$/.test(e)) ext = e; } catch {}
  const dest = path.join(dir, `wp-${hash}${ext}`);
  if (fs.existsSync(dest)) return { path: dest, stagingPath: '' };
  const stagingPath = path.join(dir,
    `.download-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(stagingPath, buf, { flag: 'wx' });
  } catch (err) {
    try { fs.rmSync(stagingPath, { force: true }); } catch {}
    throw err;
  }
  return { path: dest, stagingPath };
}

// Synchronous after the await-heavy body download. A session cannot change between a
// caller's final guard, this promotion and the state mutation that takes ownership.
// If a peer already promoted identical bytes, only our private staging file is removed.
function commitDownloadArtifact(artifact, dir) {
  if (!artifact || !isDirectChildPath(artifact.path, dir)) {
    throw new Error('Unsafe download artifact path');
  }
  const stagingPath = artifact.stagingPath;
  if (!stagingPath) return { path: artifact.path, created: false };
  if (!isDirectChildPath(stagingPath, dir)) throw new Error('Unsafe download staging path');
  try {
    if (fs.existsSync(artifact.path)) {
      fs.rmSync(stagingPath, { force: true });
      return { path: artifact.path, created: false };
    }
    try {
      fs.renameSync(stagingPath, artifact.path);
      return { path: artifact.path, created: true };
    } catch (err) {
      // Another process may have won between existsSync and rename. A content hash names
      // identical bytes, so its completed destination is the safe deduplicated result.
      if (fs.existsSync(artifact.path)) {
        fs.rmSync(stagingPath, { force: true });
        return { path: artifact.path, created: false };
      }
      throw err;
    }
  } finally {
    try { fs.rmSync(stagingPath, { force: true }); } catch {}
  }
}

function discardDownloadArtifact(artifact, dir) {
  const stagingPath = artifact && artifact.stagingPath;
  if (!stagingPath || !isDirectChildPath(stagingPath, dir)) return false;
  try {
    fs.rmSync(stagingPath, { force: true });
    return true;
  } catch (err) {
    console.error('stale Cloud download cleanup:', err);
    return false;
  }
}

async function downloadImageArtifactTo(dir, url, fetchOptions = {}) {
  return commitDownloadArtifact(await stageDownloadImage(dir, url, fetchOptions), dir);
}

async function downloadImageTo(dir, url, fetchOptions = {}) {
  return (await downloadImageArtifactTo(dir, url, fetchOptions)).path;
}

// Downloading INTO the library. ONL-009 also needs the same picture somewhere the
// library does not own — an export or a clipboard copy must not leave an orphan file
// inside wallpapers/ for the sweeper to find — hence the split above.
async function downloadWallpaperFromUrl(url, fetchOptions = {}) {
  if (!managedRootReady()) throw managedRootUnavailableError();
  return downloadImageTo(wallpapersDir(), url, fetchOptions);
}

// Дефолты + load/migrate/save вынесены в ./src/config.js (тестируется: test/config.test.js).
let config = configMod.freshDefaults();
let slideshowPositionDirty = false;
// Snapshot of the most recent library removal so the toast can offer a real undo.
let lastLibraryRemoval = null;
// Set when the pool file could not be read at startup: every write is suppressed so a
// temporary access problem cannot be turned into an empty library on disk.
let libraryUnsafeToWrite = false;
// BUG-023. The same rule for config.json. A read failure is not an empty profile: the
// app runs on defaults for this session and writes nothing over the file it could not
// read, so a locked file or a bad sector cannot become "your settings are gone".
let configUnsafeToWrite = false;

// The photo pool has its own file and its own batched writer (see
// src/library-store.js). Settings stay on the immediate path — they are small and
// the user expects them saved at once — while pool edits coalesce, so adding tags
// to a folder full of photos no longer means one full rewrite per tag.
const libraryWriter = libraryStore.createWriter({
  configPath: CONFIG_PATH,
  onWriteFailure: () => enterLibraryWriteDegradedMode(),
});

// META-001. Derived knowledge about local files: their fingerprints, and the journal of
// what each catalogue has already answered about them. Kept apart from the pool on
// purpose — see src/metadata-store.js. Loaded lazily on first use so a feature nobody
// touches costs nothing at startup.
let metadataCache = null;
const metadataWriter = metadataStore.createWriter({ configPath: CONFIG_PATH });

function metadataCacheStore() {
  if (!metadataCache) metadataCache = metadataStore.load(CONFIG_PATH);
  return metadataCache;
}

function markMetadataDirty() {
  if (metadataCache) metadataWriter.markDirty(metadataCache);
}

// One channel for the pool file: to the user it is either usable or not, and the two
// ways it breaks differ only in what they can do about it, which is what the
// notification body says. There is no matching "working again" line — the file is read
// once per start and the notifier's state does not survive a restart, so a recovery
// would have to be invented rather than observed.
function reportLibraryStoreProblem(kind) {
  reportChannelFailure('library-store', 'journal.libraryStore', {
    titleKey: 'notify.libraryStoreFailedTitle',
    bodyKey: kind === 'broken' ? 'notify.libraryStoreDamagedBody' : 'notify.libraryStoreLockedBody',
  });
}

// BUG-023. One door for every config.json write. The gate is useless if a caller can
// walk past it, and there were six of them — two on the startup path, one on a timer and
// one that fires before any window exists. Returns false instead of throwing: a blocked
// write must be reported to the caller, not take down the action that asked for it.
function writeConfigFile(options) {
  if (configUnsafeToWrite) {
    reportConfigProblem();
    return false;
  }
  return configMod.save(config, CONFIG_PATH, options);
}

// One channel for config.json, bounded the same way the pool file's is: the notifier is
// edge-triggered, so a user who keeps clicking switches is told once and not once per
// click. The two states differ only in what can be done about them, which is what the
// body says.
function reportConfigProblem(kind) {
  reportChannelFailure('config-store', 'journal.configStore', {
    titleKey: 'notify.configStoreFailedTitle',
    bodyKey: kind === 'corrupt-unbacked' ? 'notify.configStoreDamagedBody' : 'notify.configStoreLockedBody',
  });
}

// A store that was healthy at startup can still become unwritable later (locked tmp,
// full disk, permissions). From that first failed write onward config.json becomes the
// fail-closed copy for every pool edit until restart. Merely retaining the writer retry
// is insufficient: a later tag/favourite changes the in-memory pool while the pending
// trash array may already have been replaced.
function enterLibraryWriteDegradedMode() {
  if (libraryUnsafeToWrite) return;
  libraryUnsafeToWrite = true;
  console.error('Пул перестал записываться — новые изменения сохраняются inline до перезапуска.');
  writeConfigFile({ skipLibrary: true, keepInline: true });
  reportLibraryStoreProblem('unreadable');
}

function loadConfig() {
  config = configMod.load(CONFIG_PATH);
  config.onlineSources = onlineSources.normalize(config.onlineSources, providerRegistry.PROVIDERS);
  // DATA-006. Straight after the settings are in memory and before anything can reach
  // for a file: every later caller asks wallpapersDir(), and until this runs that answer
  // is still the profile default.
  refreshManagedRoot();

  // BUG-023. Decided FIRST, and before any of the early returns below: a settings file
  // that could not be read must not be written over no matter what the pool file turns
  // out to be. What is in memory right now is the defaults, not the user's profile.
  const cfgSource = config._configSource || {};
  configUnsafeToWrite = cfgSource.writable === false;
  if (configUnsafeToWrite) {
    console.error(
      cfgSource.state === 'corrupt-unbacked'
        ? 'config.json повреждён и бэкап не создан — настройки НЕ перезаписываются до перезапуска.'
        : 'config.json не читается — настройки НЕ перезаписываются до перезапуска.',
    );
    reportConfigProblem(cfgSource.state);
  }

  const source = config._poolSource || {};

  // An unreadable store (locked, permissions, failing disk) says NOTHING about what
  // it contains. Writing over it, or dropping the inline copy that is currently the
  // only readable one, would turn a temporary problem into permanent loss.
  if (source.unreadable) {
    libraryUnsafeToWrite = true;
    console.error('Пул не читается — библиотека НЕ будет перезаписана до перезапуска.');
    reportLibraryStoreProblem('unreadable');
    return;
  }

  // A store that parsed as garbage is BACKED UP, not understood — and what config.json
  // still carries inline is NOT a backup of it. Nothing keeps the two in step: the
  // inline copy is whatever a pre-split build wrote, or what an earlier degraded session
  // left behind, and it can be months out of date.
  //
  // Treating it as a recovery is what made this dangerous (DATA-004). The old rule only
  // refused when the merge came out EMPTY, so a profile with any inline copy at all took
  // the normal path: the damaged file was overwritten with the stale snapshot, config
  // stopped carrying the inline copy, and — because the runtime now believed the pool
  // was whole — the wallpaper collector was free to sweep every own-copy that the
  // records lost in the swap had been protecting.
  //
  // So a damaged store is fail-closed whatever is inline. The file is never rewritten,
  // the .corrupt-*.bak beside it stays the recovery path, and edits made meanwhile go to
  // config.json through the same degraded path as an unreadable store.
  //
  // Deliberately NOT part of this decision: whether anything is assigned to a monitor.
  // The library is independent of placement — a photo can be in it and on no monitor at
  // all — so "no monitor uses anything" was never evidence that the library was empty.
  if (source.broken) {
    libraryUnsafeToWrite = true;
    console.error('Пул повреждён: запись заблокирована, рядом лежит .corrupt-*.bak.');
    reportLibraryStoreProblem('broken');
    return;
  }
  // A store written by a build NEWER than this one is readable, and reading it is
  // the right thing to do — refusing would strand a rollback with no library at all.
  // Writing it back is what destroys data: save() stamps the version back down and
  // drops every field this build does not know about. So the pool is shown and the
  // file is left exactly as the newer build wrote it.
  if (source.newerVersion) {
    libraryUnsafeToWrite = true;
    console.error('Пул записан более новой версией — читаем, но НЕ перезаписываем.');
    reportLibraryStoreProblem('newer-version');
    return;
  }
  libraryUnsafeToWrite = false;

  // DATA-005. The two files are written atomically each but not together, and the
  // settings go first, so a power cut in the pool writer's window leaves a slot naming
  // a record that never reached disk. It fails quietly — the slot looks filled and
  // resolves to nothing — so it is repaired here and SAID OUT LOUD. Only in the healthy
  // mode: in the degraded one the pool is knowingly incomplete, and "repairing" against
  // it would throw away references to records that are merely unreadable right now.
  const repaired = poolConsistency.repairDanglingSlots(config.monitors, config.library);
  if (repaired) {
    console.error(`Ссылок в никуда убрано: ${repaired} (файлы обоев не тронуты).`);
    reportChannelFailure('pool-consistency', 'journal.poolConsistency', {
      titleKey: 'notify.poolConsistencyTitle',
      bodyKey: 'notify.poolConsistencyBody',
    });
    saveSettingsOnly();
  }

  // A config written before the split still carries the pool inline, and a build that
  // was rolled back may have added ids there since. Either way the merged result has
  // to reach the store BEFORE config.json is allowed to stop carrying it — and only
  // if that write is confirmed, which configMod.save now reports.
  if (!source.storeExisted || source.mergedInline || source.broken || source.normalizeAdded) {
    const ok = libraryStore.save(config.library, CONFIG_PATH, config.libraryTrash);
    if (ok) {
      writeConfigFile({ skipLibrary: true, keepInline: false });
    } else {
      // This is the same state as a writer that becomes unwritable later. Merely
      // keeping the inline copy in THIS save is not enough: the next settings-only
      // save would otherwise strip it again while the store still contains nothing.
      enterLibraryWriteDegradedMode();
      console.error('Не удалось создать файл пула — inline-копия в config.json сохранена.');
    }
  }
}

// A photo cannot be active and removed at the same time. Every route that brings one
// back — materialize, re-import, re-download, assign — goes through this, so the
// removed-marker and the trash entry cannot survive underneath an active record.
// Without it a file could sit in a monitor's playlist while still being an allowed
// target for "delete from disk" (BUG-011).
// Everything that can move a photo between "active" and "removed" — or delete its
// file — runs one at a time. Ordering alone is what makes the delete guard sound: the
// check "is this file active right now" and the `shell.trashItem` that follows it are
// only meaningful together, and awaiting anything between them let a download, a
// restore or an assignment slip in and make the file active again before it was
// erased. A queue is enough; these are user-driven actions, not a hot path.
let libraryMutationQueue = Promise.resolve();
function withLibraryLock(fn) {
  const result = libraryMutationQueue.then(fn, fn);
  libraryMutationQueue = result.then(() => {}, () => {});
  return result;
}

// Bumped whenever bringing a photo back cleared a removed-marker or a trash entry.
// The add handlers decide whether to save by how much the pool GREW, and a photo that
// is already in the pool grows it by nothing — so re-adding a removed photo repaired
// it in memory, told the user it was back, and lost the repair on the next start.
let poolRevivals = 0;

function clearRemovedState(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p);
  if (!list.length) return false;
  let changed = false;

  const unhidden = folderState.setHidden(liveFolderState, list, false);
  liveFolderState = unhidden.state;
  const unhiddenDirs = folderState.setHiddenDir(liveFolderState, list, false);
  liveFolderState = unhiddenDirs.state;
  if (unhidden.changed || unhiddenDirs.changed) {
    invalidateHiddenPaths();
    folderStateDirty = true;
    flushLiveFolderState();
    changed = true;
  }

  const keys = new Set(list.map(pathKey));
  const before = (config.libraryTrash || []).length;
  config.libraryTrash = (config.libraryTrash || [])
    .filter((entry) => !(entry && entry.item && keys.has(pathKey(entry.item.path))));
  if (before !== config.libraryTrash.length) changed = true;
  return changed;
}

// A record brought back after a removal must be newer than the tombstone it replaces.
// Dropping the trash row without moving the record's revision works in the current
// process, but loses on the next recovery merge if an older copy of the store returns.
// Match by id OR canonical path: old entries and ephemeral/live-folder cards are not
// guaranteed to arrive with both fields populated.
function markRecordRevived(item) {
  if (!item || typeof item !== 'object') return false;
  const id = typeof item.id === 'string' ? item.id : '';
  const key = pathKey(item.path);
  let matched = false;
  let newestRemovalRev = 0;
  for (const entry of (config.libraryTrash || [])) {
    if (!entry || !entry.item) continue;
    const sameId = id && entry.item.id === id;
    const samePath = key && pathKey(entry.item.path) === key;
    if (!sameId && !samePath) continue;
    matched = true;
    newestRemovalRev = Math.max(newestRemovalRev, library.revOf(entry));
  }
  if (!matched) return false;
  library.bumpRev(item, newestRemovalRev);
  return true;
}

// The ONLY way a photo enters the active pool in main. Going through one funnel is
// what makes "active and removed at the same time" impossible: every entry point —
// import, drag and drop, download, materialize, assign — clears the removed state as
// part of becoming active, instead of six call sites each having to remember.
function addToPool(type, srcPath, extra) {
  const id = library.addPath(config.library, type, srcPath, extra);
  const item = id ? library.getItem(config.library, id) : null;
  const revisionMoved = markRecordRevived(item);
  if (id && (clearRemovedState(srcPath) || revisionMoved)) poolRevivals++;
  return id;
}

// Every file Znada is currently using, as path keys. This is what "delete from disk"
// is checked against, so it has to be the truth rather than a re-derivation of it.
//
// It used to be assembled by hand from the pool, the slot ids and the legacy fallback.
// That list looked complete and was not: an assigned FOLDER contributes the folder's own
// path, while what the desktop actually shows is the photos inside it, found by reading
// the disk. A photo dropped into a watched folder was therefore playing on the monitor
// and absent from the "in use" list at the same time — and a stale trash entry naming it
// was enough to authorise deleting it.
//
// So the playlist is asked directly, through the same resolveSlot() the slideshow uses.
// A photo the user removed is excluded by exactly the same rule there as here, so
// "removed" and "not in use" cannot drift apart.
function inUsePaths() {
  const set = new Set();
  for (const it of Object.values(config.library || {})) {
    if (it && it.type === 'image' && it.path) set.add(pathKey(it.path));
  }
  for (const legacy of [config.lightWallpaper, config.darkWallpaper]) {
    if (legacy) set.add(pathKey(legacy));
  }
  const excluded = hiddenPathSet();
  for (const monitorId of Object.keys(config.monitors || {})) {
    for (const theme of ['light', 'dark']) {
      let resolved = [];
      try {
        resolved = playlist.resolveSlot(slotFor(monitorId, theme), config.library, {
          forceFolderScan: true,
          exclude: excluded,
        });
      } catch (err) {
        // A folder that cannot be read right now says nothing about what is in it. The
        // safe answer for a delete guard is "assume it is in use", which is what an
        // empty result plus the pool paths above already gives — but log it, because a
        // silent failure here weakens a destructive guard.
        console.error('inUsePaths: не удалось развернуть плейлист', monitorId, theme, err);
      }
      for (const p of resolved) set.add(pathKey(p));
    }
  }
  return set;
}

function saveLibrarySoon() {
  // The store file cannot be touched, but config.json can — and while the store is
  // unusable, config.json is the ONLY copy. Writing the pool inline right here is what
  // makes a tag or a star in this mode real: without it the edit was applied in memory,
  // confirmed on screen, and gone after a restart. Synchronous and un-batched on
  // purpose; this is the degraded path, where being correct beats being cheap.
  if (libraryUnsafeToWrite) {
    writeConfigFile({ skipLibrary: true, keepInline: true });
    return;
  }
  libraryWriter.markDirty(config.library, config.libraryTrash);
}

// For edits that touch ONLY the pool (tags, favourites): settings did not change,
// so rewriting config.json would be pure waste — a tag used to cost a full config
// write. The renderer still gets told, through the coalesced broadcast.
function savePoolOnly() {
  saveLibrarySoon();
  broadcastConfig();
}

// Default is SAFE: assume the pool may have changed and schedule its write. Deciding
// by entry counts was cheaper but wrong — a tag, a favourite or a backfilled aspect
// leaves the counts identical, so those edits were never written and vanished on the
// next start. Getting this wrong costs data; getting the optimisation wrong only costs
// a background write, so the cheap path is opt-in and lives in saveSettingsOnly().
function saveConfig() {
  // In the degraded mode this single call already wrote the pool inline, so calling
  // saveLibrarySoon() as well would write the same bytes twice.
  const inlined = libraryUnsafeToWrite;
  // DATA-005. The pool goes FIRST. Settings used to be written synchronously while the
  // records they name sat in a 1200 ms debounce, so every assignment opened a window in
  // which a crash left a slot pointing at nothing. Written this way round the worst a
  // crash can leave is a record nobody references — an orphan, which the collector moves
  // to wallpapers/.trash rather than deleting.
  //
  // This is not the tag path and does not undo the split storage: tags and favourites go
  // through savePoolOnly(), which still coalesces. Only settings that can name a record
  // pay for the ordering, and those are user actions, not bursts.
  // Mark AND flush: flushing alone writes only what someone already marked, so an edit
  // that reached the pool without marking it would never have been written at all.
  let keepInline = inlined;
  if (!inlined) {
    saveLibrarySoon();
    // A failed flush leaves the newest pool pending for retry, but settings must not
    // point at that in-memory-only record. Keep the same pool inline until a later
    // successful save can safely remove it again.
    keepInline = !libraryWriter.flush();
  }
  const saved = writeConfigFile({ skipLibrary: true, keepInline });
  slideshowPositionDirty = false;
  broadcastConfig();
  return saved;
}

// For handlers that provably touch settings and nothing else. Keeps a switch flip from
// scheduling a full rewrite of thousands of pool records — the coupling the split
// storage existed to remove — without guessing on the paths that do touch the pool.
function saveSettingsOnly() {
  const saved = writeConfigFile({ skipLibrary: true, keepInline: libraryUnsafeToWrite });
  if (!saved) return false;
  slideshowPositionDirty = false;
  broadcastConfig();
  return true;
}

// ---------------------------------------------------------------------------
// DATA-006 step 2: moving the folder of Znada's own copies
// ---------------------------------------------------------------------------
// The copying, verifying and cleaning up live in src/media-move.js; the arithmetic of
// what every record is called afterwards lives in src/profile-migration.js. What main
// owns is the part only main can answer: which documents are the live ones, and what
// "written" means. There is no way to start this from a window yet — the progress
// window and the picker are steps 3 and 4.
let mediaMoveRunning = false;

// The pool and the trash are one in-memory model here, but the remap expects them in
// the shape they have on disk. Handed over live, not copied: remapMediaRoot deep-clones
// its input and returns new documents, so nothing here is mutated behind our back.
function mediaMoveDocuments() {
  return {
    config,
    store: {
      version: 1,
      library: config.library,
      trash: Array.isArray(config.libraryTrash) ? config.libraryTrash : [],
    },
    folderState: liveFolderState,
  };
}

// What stops a move before anything is counted or copied. Shared by the question the
// window asks and by the move itself, so the two cannot disagree.
//
// `toAppFolder` is the way back to `<profile>\wallpapers`. It is its own flag rather
// than an empty folder, so an empty or broken value can never read as "move it all back".
function mediaMoveBlockers(targetFolder, { toAppFolder = false } = {}) {
  if (toAppFolder) {
    if (targetFolder) return [{ code: mediaRoot.PROBLEMS.RELATIVE }];
  } else {
    const problem = mediaRoot.folderProblem({
      folder: targetFolder, userDataPath: USER_DATA_PATH, systemRoots: systemRootsForFolderCheck(),
    });
    if (problem) return [{ code: problem }];
  }
  // Moving OUT of a folder the rules refuse is no safer than moving into it: if that
  // folder is the profile, "everything in it" is the settings and the sign-in.
  if (managedRootInvalid()) return [{ code: 'source-invalid' }];
  return [];
}

// THE point of no return. Everything before it can be undone by deleting the files we
// made; after it the library names the new, verified copies.
function commitManagedFolderMove(targetFolder, documents) {
  config.library = documents.store.library;
  config.libraryTrash = documents.store.trash;
  config.monitors = documents.config.monitors;
  config.lightWallpaper = documents.config.lightWallpaper;
  config.darkWallpaper = documents.config.darkWallpaper;
  config.slideshowCurrentPath = documents.config.slideshowCurrentPath;
  if (typeof documents.config.lastSaveDir === 'string') config.lastSaveDir = documents.config.lastSaveDir;
  config.mediaFolder = targetFolder;
  if (documents.folderState) {
    liveFolderState = documents.folderState;
    invalidateHiddenPaths();
    folderStateDirty = true;
    flushLiveFolderState();
  }
  // From here on every caller asks for the new folder.
  refreshManagedRoot();
  // saveConfig() writes the pool atomically and only then the settings that name it
  // (DATA-005). A refusal here has to stop the move while the originals are still
  // there, so it throws rather than reporting success.
  if (!saveConfig()) throw new Error('settings could not be written; the move was not committed');
}

/**
 * Move everything Znada copied for itself into `targetFolder` (the folder the user
 * picks; Znada uses its own subfolder inside it).
 *
 * Runs inside the library mutation queue, so an assignment, a removal or a download
 * cannot interleave with the copy and the commit. Nothing else needs a lock of its own:
 * that queue is already what every route which can move a photo between active and
 * removed goes through.
 */
async function moveManagedFolder(targetFolder, {
  onProgress = () => {}, shouldStop = () => false, toAppFolder = false,
} = {}) {
  if (mediaMoveRunning) return { status: 'busy', blockers: [] };
  // A pool that could not be read or written is no basis for rewriting every path in
  // it. The move waits for a restart rather than building on a degraded copy.
  if (libraryUnsafeToWrite || configUnsafeToWrite) {
    return { status: 'blocked', blockers: [{ code: 'library-degraded' }] };
  }
  const blockers = mediaMoveBlockers(targetFolder, { toAppFolder });
  if (blockers.length) return { status: 'blocked', blockers };

  const target = mediaRoot.resolveManagedRoot({ userDataPath: USER_DATA_PATH, mediaFolder: targetFolder });
  const from = wallpapersDir();
  // BUG-050. Where our folder is meant to live: with the place there and the folder not
  // yet made, there is simply nothing to carry.
  const fromAnchor = managedRoot.anchor;
  mediaMoveRunning = true;
  let report;
  try {
    report = await withLibraryLock(() => mediaMove.runMove({
      from,
      fromAnchor,
      to: target.root,
      anchor: target.anchor,
      remap: () => profileMigrationMod.remapMediaRoot({
        oldRoot: from, newRoot: target.root, ...mediaMoveDocuments(),
      }),
      commit: (documents) => commitManagedFolderMove(targetFolder, documents),
      onProgress,
      shouldStop,
    }));
  } finally {
    mediaMoveRunning = false;
  }
  if (report.status === 'done') {
    // What is on the desktop right now came from a file that no longer exists under
    // that name. Applying again from the new paths keeps the next change honest.
    try { await applyForTheme(null, true); } catch (err) { console.error('move: re-apply failed', err); }
  }
  return report;
}


// Stable, anonymised install id for Znada Cloud usage stats (anonymous users).
// Generated once (32 hex chars), persisted in config; never contains personal data.
// Written directly (no broadcast) — it is main-only and the renderer never reads it.
function ensureAnonId() {
  if (/^[A-Za-z0-9_-]{8,128}$/.test(config.anonId || '')) return;
  // BUG-023. This is the write that turned a read failure into data loss: it runs on
  // every start, sees no id in the defaults and saves them over the real file. An
  // unreadable config very likely HAS an id, and one we cannot store would be a
  // different install on every launch — so nothing is generated at all.
  if (configUnsafeToWrite) return;
  config.anonId = crypto.randomBytes(16).toString('hex');
  writeConfigFile({ skipLibrary: true, keepInline: libraryUnsafeToWrite });
}

function persistSlideshowPosition() {
  if (!slideshowPositionDirty) return;
  // Stays dirty when the write is refused, so the position is retried rather than
  // silently declared saved.
  if (!writeConfigFile({ skipLibrary: true, keepInline: libraryUnsafeToWrite })) return;
  slideshowPositionDirty = false;
}

// Discovery history is intentionally separate from config.json: a folder may
// contain thousands of paths, while config remains small user-facing settings.
let liveFolderState = folderState.emptyState();
// Paths the user removed from the library, as a lowercased Set. Cached because it is
// consulted on the wallpaper path (playlist expansion) and rebuilding it walks the
// whole folder index. Every reassignment of liveFolderState drops the cache.
let hiddenPathsCache = null;
function invalidateHiddenPaths() { hiddenPathsCache = null; }
function hiddenPathSet() {
  if (hiddenPathsCache) return hiddenPathsCache;
  const set = new Set();
  try {
    for (const im of folderState.listImages(liveFolderState, null, { only: 'hidden' })) {
      // Keyed like everything else that answers "is this the same file" (pathKey).
      // Plain lowercase kept `\` here while the playlist and the delete guard asked
      // with `/`, so this set silently matched nothing they looked up.
      if (im && im.path) set.add(pathKey(im.path));
    }
  } catch (err) { console.error('hiddenPathSet:', err); }
  hiddenPathsCache = set;
  return set;
}
let folderStateDirty = false;
let folderStateSaveTimer = null;
let liveFolderAspectTimer = null;
const pendingLiveFolderAspects = new Map();
let folderRefreshQueue = Promise.resolve();
const folderScanFreshAt = new Map();
const FOLDER_SCAN_FRESH_MS = 5000;
const FOLDER_STATE_SAVE_DEBOUNCE_MS = 5000;
const LIVE_FOLDER_ASPECT_FLUSH_MS = 750;
let liveFolderWatcher = null;
const liveFolderWatcherRetryTimers = new Map();
let liveFolderFullScanTimer = null;
let liveFolderLastFullScanAt = 0;
const LIVE_FOLDER_FULL_SCAN_MS = 60 * 60 * 1000;

function loadLiveFolderState() {
  try {
    const loaded = folderState.loadState(FOLDER_STATE_PATH);
    liveFolderState = loaded.state;
    invalidateHiddenPaths();
    if (loaded.recovered) {
      console.warn('folder-state.json повреждён; создан безопасный новый индекс.', loaded.brokenPath || '');
    }
  } catch (err) {
    liveFolderState = folderState.emptyState();
    invalidateHiddenPaths();
    console.error('Не удалось загрузить folder-state.json:', err);
  }
}

function flushLiveFolderState() {
  if (folderStateSaveTimer) { clearTimeout(folderStateSaveTimer); folderStateSaveTimer = null; }
  if (!folderStateDirty) return;
  try {
    liveFolderState = folderState.saveState(FOLDER_STATE_PATH, liveFolderState);
    invalidateHiddenPaths();
    folderStateDirty = false;
  } catch (err) {
    console.error('Не удалось сохранить folder-state.json:', err);
  }
}

function scheduleLiveFolderStateSave() {
  folderStateDirty = true;
  if (folderStateSaveTimer) clearTimeout(folderStateSaveTimer);
  folderStateSaveTimer = setTimeout(flushLiveFolderState, FOLDER_STATE_SAVE_DEBOUNCE_MS);
  if (folderStateSaveTimer && typeof folderStateSaveTimer.unref === 'function') folderStateSaveTimer.unref();
}

function flushPendingLiveFolderAspects() {
  if (liveFolderAspectTimer) { clearTimeout(liveFolderAspectTimer); liveFolderAspectTimer = null; }
  if (!pendingLiveFolderAspects.size) return 0;
  const updates = Array.from(pendingLiveFolderAspects.values());
  pendingLiveFolderAspects.clear();
  const result = folderState.setAspects(liveFolderState, updates);
  liveFolderState = result.state;
  invalidateHiddenPaths();
  if (result.changed) scheduleLiveFolderStateSave();
  // A live-folder image may already be materialized in the pool (favorite/assigned).
  // Keep that additive metadata in sync too, otherwise "All" would omit the
  // folder-backed record and fall back to an unstable default aspect after restart.
  let configChanged = false;
  for (const update of updates) {
    const id = library.idFor(update.path);
    if (library.setAspect(config.library, id, update.path, update.aspect)) configChanged = true;
  }
  // Metadata backfill must not broadcast config: rebuilding the visible grid here
  // would reintroduce the very movement this batch is intended to remove. Only the
  // pool changed, so only the pool is written — and that write is batched.
  if (configChanged) saveLibrarySoon();
  return result.updated;
}

function queueLiveFolderAspect(p, aspect) {
  const value = Number(aspect);
  if (!p || typeof p !== 'string' || !Number.isFinite(value) || value <= 0 || !isPathUnderLiveFolder(p)) return;
  let key;
  try { key = pathKey(path.resolve(p)); } catch { return; }
  pendingLiveFolderAspects.set(key, { path: p, aspect: value });
  if (liveFolderAspectTimer) return;
  liveFolderAspectTimer = setTimeout(flushPendingLiveFolderAspects, LIVE_FOLDER_ASPECT_FLUSH_MS);
  if (liveFolderAspectTimer && typeof liveFolderAspectTimer.unref === 'function') liveFolderAspectTimer.unref();
}

function forgetLiveFolders(ids) {
  const state = folderState.normalizeState(liveFolderState);
  let removed = false;
  for (const id of (ids || [])) {
    if (id && state.folders[id]) { delete state.folders[id]; removed = true; }
    folderScanFreshAt.delete(id);
  }
  liveFolderState = state;
  invalidateHiddenPaths();
  if (removed) scheduleLiveFolderStateSave();
}

function forgetLiveFolder(id) {
  forgetLiveFolders([id]);
}

function liveFolderItems() {
  return Object.values(config.library || {}).filter((item) => item && item.type === 'folder' && item.id && item.path);
}

function pathExists(p) {
  try { return !!(p && fs.existsSync(p)); } catch { return false; }
}

function dirExists(p) {
  try { return !!(p && fs.statSync(p).isDirectory()); } catch { return false; }
}

function isPathUnderLiveFolder(p) {
  return liveFolderItems().some((folder) => library.isPathInsideRoot(p, folder.path));
}

function pruneConfirmedMissingLiveFolderImages() {
  let ids = [];
  try {
    ids = library.findConfirmedMissingLiveFolderImageIds(
      config.library,
      folderState.listImages(liveFolderState),
      pathExists,
      dirExists
    );
  } catch (err) {
    console.error('Не удалось проверить missing-файлы живых папок:', err);
    return 0;
  }
  let removed = 0;
  for (const id of ids) {
    if (removeFromLibrary(id)) removed++;
  }
  if (removed) {
    // Do not call applyForTheme here: removing a vanished live-folder source should
    // clean the UI/playlist, but the currently displayed desktop may stay until the
    // next manual or scheduled wallpaper change.
    saveConfig();
    trayCtl.refresh();
  }
  return removed;
}

function syncLiveFolderWatchers() {
  if (!liveFolderWatcher) return { watched: 0, failed: 0 };
  return liveFolderWatcher.sync(liveFolderItems());
}

// Something OUTSIDE the main window changed which pictures the Library shows, without
// changing the pool.
//
// Owner QA 2026-08-30: removing a photo in the fullscreen viewer left it on screen in the
// grid behind until the user switched rails and came back. Removing a photo that only
// lives inside a watched folder does not touch the pool — it is hidden by path — and the
// grid rebuilds itself off a signature of the POOL. A pool removal needs no help here: the
// ordinary config broadcast already carries it. This is only for the half that broadcast
// cannot express.
//
// Sent on the live-folder channel deliberately: the question the main window has to re-ask
// is exactly what that channel already means — "what is visible inside the folders you are
// watching" — and its handler in the renderer already does the right thing with it.
//
// The counter exists because no window is created in tests, so this is how a test can
// drive the real handler and see the decision. The send below is the same single line
// broadcastLiveFolderChanges uses.
const libraryViewStale = { count: 0, last: '' };
function notifyLibraryViewStale(reason) {
  libraryViewStale.count += 1;
  libraryViewStale.last = String(reason || '');
  if (!mainWindow || mainWindow.isDestroyed()) return;
  diagCountSend('live-folders-changed');
  mainWindow.webContents.send('live-folders-changed', { folderIds: [] });
}

function broadcastLiveFolderChanges(summaries) {
  const changed = (Array.isArray(summaries) ? summaries : []).filter((summary) => summary && summary.changed);
  if (!changed.length || !mainWindow || mainWindow.isDestroyed()) return;
  diagCountSend('live-folders-changed');
  mainWindow.webContents.send('live-folders-changed', {
    folderIds: changed.map((summary) => summary.id),
  });
}

// Serialize scans globally. Besides avoiding duplicate disk work, this prevents
// two async scans from reconciling against stale copies of the same state object.
function refreshLiveFolders(folderIds = null, force = false) {
  const requested = Array.isArray(folderIds) ? new Set(folderIds) : null;
  const run = async () => {
    const items = Object.values(config.library || {}).filter((it) => it && it.type === 'folder'
      && (!requested || requested.has(it.id)));
    const summaries = [];
    for (const item of items) {
      if (!force && Date.now() - (folderScanFreshAt.get(item.id) || 0) < FOLDER_SCAN_FRESH_MS) continue;
      const scanNow = Date.now();
      let changed = false;
      let added = 0;
      let removed = 0;
      let batchNotified = false;

      const reconcile = (status, entries, notify = false) => {
        const current = library.getItem(config.library, item.id);
        if (!current || current.type !== 'folder' || current.path !== item.path) return null;
        const result = folderState.reconcileFolder(liveFolderState, {
          folderId: item.id,
          rootPath: item.path,
          folderAddedAt: item.addedAt,
          now: scanNow,
          status,
          entries,
        });
        liveFolderState = result.state;
        invalidateHiddenPaths();
        if (result.changed) scheduleLiveFolderStateSave();
        changed = changed || result.contentChanged;
        added += result.added;
        removed += result.removed;
        if (notify && result.contentChanged) {
          broadcastLiveFolderChanges([{ id: item.id, changed: true }]);
          batchNotified = true;
        }
        return result;
      };

      const scan = await folderState.scanFolderTree(item.path, {
        imageExts: playlist.IMG_EXTS,
        batchSize: 10000,
        knownPaths: folderState.knownPathKeys(liveFolderState, item.id),
        onBatch: async (entries) => { reconcile('partial', entries, true); },
      });
      folderScanFreshAt.set(item.id, Date.now());
      // Journal-only (no popup): an unplugged disk is tolerated per LF-QA1, but the
      // journal should explain why a live folder stopped updating. Per-folder channel
      // so one broken folder does not mask another.
      if (scan.status === 'unavailable') {
        reportChannelFailure(`live-folder:${item.id}`, 'journal.liveFolder', {
          notify: false,
          params: { name: path.basename(item.path) },
        });
      } else {
        reportChannelSuccess(`live-folder:${item.id}`, 'journal.liveFolder', {
          params: { name: path.basename(item.path) },
        });
      }
      if (scan.status === 'unavailable' && liveFolderWatcher) liveFolderWatcher.restart(item.id);
      const finalResult = reconcile(scan.status, scan.entries);
      if (!finalResult) continue;
      summaries.push({
        id: item.id,
        status: scan.status,
        changed,
        added,
        removed,
        // Full batches have already notified the renderer. A final remainder or
        // deletion still needs one notification after the completed scan.
        notified: batchNotified && !finalResult.contentChanged,
      });
    }
    const pruned = pruneConfirmedMissingLiveFolderImages();
    if (pruned) {
      summaries.push({ id: 'library', status: 'pruned', changed: true, added: 0, removed: pruned });
    }
    broadcastLiveFolderChanges(summaries.filter((summary) => !summary.notified));
    return summaries;
  };
  folderRefreshQueue = folderRefreshQueue.then(run, run);
  return folderRefreshQueue;
}

function requestLiveFolderRefresh(folderIds = null) {
  refreshLiveFolders(folderIds).catch((err) => console.error('Не удалось обновить индекс живых папок:', err));
}

function startLiveFolderWatchers() {
  if (liveFolderWatcher) liveFolderWatcher.closeAll();
  liveFolderWatcher = liveFolderWatch.createController({
    debounceMs: 1500,
    onChange: async (folderId) => {
      await refreshLiveFolders([folderId], true);
    },
    onError: (folderId, err) => {
      console.warn(`[LiveFolders] watcher unavailable for ${folderId}:`, err && (err.message || err));
      if (liveFolderWatcherRetryTimers.has(folderId)) return;
      const retry = setTimeout(() => {
        liveFolderWatcherRetryTimers.delete(folderId);
        syncLiveFolderWatchers();
        refreshLiveFolders([folderId], true)
          .catch((scanErr) => console.error(`[LiveFolders] retry scan failed for ${folderId}:`, scanErr));
      }, 15000);
      liveFolderWatcherRetryTimers.set(folderId, retry);
      if (retry && typeof retry.unref === 'function') retry.unref();
    },
  });
  return syncLiveFolderWatchers();
}

// One stat per watched root, and the same channels the full pass uses — so the
// edge-trigger state is shared and a folder cannot be reported broken twice, once
// by each path.
//
// Journal-only, deliberately: LF-QA1 settled that a folder that stopped indexing is
// tolerated quietly. What earns a notification is the wallpaper itself failing to go
// up, and that is reported separately by the wallpaper-source channel.
function checkLiveFolderReachability() {
  for (const item of liveFolderItems()) {
    let reachable = false;
    try { reachable = fs.statSync(item.path).isDirectory(); }
    catch { reachable = false; }
    const params = { name: path.basename(item.path) };
    if (reachable) reportChannelSuccess(`live-folder:${item.id}`, 'journal.liveFolder', { params });
    else reportChannelFailure(`live-folder:${item.id}`, 'journal.liveFolder', { notify: false, params });
  }
}

function liveFolderWindowVisible() {
  return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized());
}

function scheduleLiveFolderFullScan(reason, delayMs) {
  if (liveFolderFullScanTimer) clearTimeout(liveFolderFullScanTimer);
  liveFolderFullScanTimer = setTimeout(async () => {
    liveFolderFullScanTimer = null;
    const visibleOnly = reason === 'hourly' || reason === 'window-visible';
    if (visibleOnly && !liveFolderWindowVisible()) {
      // The hourly pass is the only thing that notices a watched folder has gone
      // away — and it used to return here without doing anything at all. The app
      // lives in the tray, so in normal use it never ran: the journal stayed empty
      // exactly when it was meant to speak (BUG-014, second cause).
      //
      // What is expensive is re-indexing the tree, and that can still wait for the
      // window; measurements behind LF-QA5 are the reason it waits. Asking whether
      // the root is still there costs one stat per folder, so it happens whether or
      // not anyone is looking.
      checkLiveFolderReachability();
      scheduleLiveFolderFullScan('hourly', LIVE_FOLDER_FULL_SCAN_MS);
      return;
    }
    syncLiveFolderWatchers();
    try {
      await refreshLiveFolders(null, true);
      liveFolderLastFullScanAt = Date.now();
    } catch (err) {
      console.error(`[LiveFolders] ${reason} reconciliation failed:`, err);
    } finally {
      scheduleLiveFolderFullScan('hourly', LIVE_FOLDER_FULL_SCAN_MS);
    }
  }, Math.max(0, Number(delayMs) || 0));
  if (liveFolderFullScanTimer && typeof liveFolderFullScanTimer.unref === 'function') {
    liveFolderFullScanTimer.unref();
  }
}

function reconcileLiveFoldersIfStale() {
  if (Date.now() - liveFolderLastFullScanAt < LIVE_FOLDER_FULL_SCAN_MS) return;
  scheduleLiveFolderFullScan('window-visible', 2000);
}

// ---------------------------------------------------------------------------
// i18n — dictionaries are the single source of truth (used by both the UI and
// the tray menu). config.language: 'system' | 'en' | 'ru' | 'uk'.
// ---------------------------------------------------------------------------
const LOCALES = {
  en: require('./locales/en.json'),
  ru: require('./locales/ru.json'),
  uk: require('./locales/uk.json'),
  de: require('./locales/de.json'),
  es: require('./locales/es.json'),
  fr: require('./locales/fr.json'),
  it: require('./locales/it.json'),
  pt: require('./locales/pt.json'),
  pl: require('./locales/pl.json'),
  tr: require('./locales/tr.json'),
  nl: require('./locales/nl.json'),
  zh: require('./locales/zh.json'),
  ja: require('./locales/ja.json'),
  ko: require('./locales/ko.json'),
  ar: require('./locales/ar.json'),
  vi: require('./locales/vi.json'),
  hi: require('./locales/hi.json'),
  id: require('./locales/id.json'),
  sv: require('./locales/sv.json'),
  no: require('./locales/no.json'),
  da: require('./locales/da.json'),
  fi: require('./locales/fi.json'),
  cs: require('./locales/cs.json'),
  hu: require('./locales/hu.json'),
  ro: require('./locales/ro.json'),
  sk: require('./locales/sk.json'),
  bg: require('./locales/bg.json'),
  el: require('./locales/el.json'),
  he: require('./locales/he.json'),
  th: require('./locales/th.json'),
};
const SUPPORTED_LANGS = [
  'en', 'ru', 'uk', 'de', 'es', 'fr', 'it', 'pt', 'pl', 'tr', 'nl',
  'zh', 'ja', 'ko', 'ar', 'vi', 'hi', 'id', 'sv', 'no', 'da',
  'fi', 'cs', 'hu', 'ro', 'sk', 'bg', 'el', 'he', 'th'
];

function tPath(obj, key) {
  return key.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);
}
function systemLangCode() {
  const l = (app.getLocale() || 'en').toLowerCase();
  if (l.startsWith('uk')) return 'uk';
  if (l.startsWith('ru')) return 'ru';
  return 'en';
}
function effectiveLang() {
  const set = config.language || 'system';
  return SUPPORTED_LANGS.includes(set) ? set : systemLangCode();
}
function tMain(key) {
  const code = effectiveLang();
  const v = tPath(LOCALES[code] || LOCALES.en, key);
  if (v != null) return v;
  const f = tPath(LOCALES.en, key);
  return f != null ? f : key;
}

// ---------------------------------------------------------------------------
// Wallpaper setting (Windows API via PowerShell P/Invoke)
// ---------------------------------------------------------------------------
const STYLE_MAP = {
  fill: { style: 10, tile: 0 },
  fit: { style: 6, tile: 0 },
  stretch: { style: 2, tile: 0 },
  center: { style: 0, tile: 0 },
  tile: { style: 0, tile: 1 },
  span: { style: 22, tile: 0 },
};

const PS_SCRIPT_PATH = path.join(app.getPath('userData'), 'set-wallpaper.ps1');

const PS_SCRIPT = `param([string]$Path,[int]$Style,[int]$Tile)
Set-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name WallpaperStyle -Value $Style.ToString()
Set-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name TileWallpaper -Value $Tile.ToString()
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeWallpaper {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
"@
# SPI_SETDESKWALLPAPER = 20, SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE = 3
[NativeWallpaper]::SystemParametersInfo(20, 0, $Path, 3) | Out-Null
`;

function ensurePsScript() {
  try {
    fs.mkdirSync(path.dirname(PS_SCRIPT_PATH), { recursive: true });
    fs.writeFileSync(PS_SCRIPT_PATH, PS_SCRIPT, 'utf8');
  } catch (err) {
    console.error('Не удалось записать PS-скрипт:', err);
  }
}

// ---------------------------------------------------------------------------
// Per-monitor wallpaper via IDesktopWallpaper COM (PowerShell + Add-Type)
// ---------------------------------------------------------------------------
const COM_SCRIPT_PATH = path.join(app.getPath('userData'), 'wallpaper-com.ps1');
const APPLY_DATA_PATH = path.join(app.getPath('userData'), 'apply.json');

// our style names -> DESKTOP_WALLPAPER_POSITION
const COM_POS = { center: 0, tile: 1, stretch: 2, fit: 3, fill: 4, span: 5 };

const COM_SCRIPT = `param([string]$Mode='enum',[string]$DataFile='')
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct DW_RECT { public int Left, Top, Right, Bottom; }
[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDesktopWallpaper {
  void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint monitorIndex);
  uint GetMonitorDevicePathCount();
  DW_RECT GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
  void SetBackgroundColor(uint color);
  uint GetBackgroundColor();
  void SetPosition(int position);
}
public static class DW {
  static IDesktopWallpaper _i;
  static IDesktopWallpaper I { get { if(_i==null){ _i=(IDesktopWallpaper)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD"))); } return _i; } }
  public static uint Count(){ return I.GetMonitorDevicePathCount(); }
  public static string PathAt(uint i){ return I.GetMonitorDevicePathAt(i); }
  public static int[] Rect(string id){ var r=I.GetMonitorRECT(id); return new int[]{r.Left,r.Top,r.Right,r.Bottom}; }
  public static void SetPosition(int p){ I.SetPosition(p); }
  public static void SetWallpaper(string id,string p){ I.SetWallpaper(id,p); }

  [DllImport("shell32.dll")]
  public static extern int SHQueryUserNotificationState(out int pqunsState);
  public static bool IsUserBusy() {
    int state;
    int hr = SHQueryUserNotificationState(out state);
    if (hr == 0) {
      return (state == 2 || state == 3 || state == 4 || state == 6);
    }
    return false;
  }
}
"@
if ($Mode -eq 'enum') {
  $list = New-Object System.Collections.ArrayList
  $n = [DW]::Count()
  for ($i=0; $i -lt $n; $i++) {
    $id = [DW]::PathAt([uint32]$i)
    try { $r = [DW]::Rect($id) } catch { continue }
    [void]$list.Add([pscustomobject]@{ id=$id; x=$r[0]; y=$r[1]; w=($r[2]-$r[0]); h=($r[3]-$r[1]) })
  }
  ConvertTo-Json -InputObject @($list) -Compress
} elseif ($Mode -eq 'apply') {
  $data = Get-Content -LiteralPath $DataFile -Raw -Encoding utf8 | ConvertFrom-Json
  [DW]::SetPosition([int]$data.position)
  foreach ($it in $data.items) { [DW]::SetWallpaper([string]$it.id, [string]$it.path) }
} elseif ($Mode -eq 'check-fullscreen') {
  [DW]::IsUserBusy()
}
`;

function ensureComScript() {
  try {
    fs.mkdirSync(path.dirname(COM_SCRIPT_PATH), { recursive: true });
    fs.writeFileSync(COM_SCRIPT_PATH, COM_SCRIPT, 'utf8');
  } catch (err) {
    console.error('Не удалось записать COM-скрипт:', err);
  }
}

function runCom(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', COM_SCRIPT_PATH, ...args],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      }
    );
  });
}

// Живой PowerShell-хост: компилирует COM один раз, дальше применяет обои мгновенно
// (~1 мс вместо ~400 мс на spawn+Add-Type). Быстрый путь; при сбое — фоллбек на runCom.
const COM_HOST_SCRIPT_PATH = path.join(app.getPath('userData'), 'wallpaper-host.ps1');
function ensureComHostScript() {
  try {
    fs.mkdirSync(path.dirname(COM_HOST_SCRIPT_PATH), { recursive: true });
    fs.writeFileSync(COM_HOST_SCRIPT_PATH, HOST_SCRIPT, 'utf8');
  } catch (err) {
    console.error('Не удалось записать COM-host-скрипт:', err);
  }
}
const wpHost = new WallpaperHost(COM_HOST_SCRIPT_PATH);

async function isGameOrFullscreenRunning() {
  if (!config.gameModeBlock) return false;
  try {
    const isBusy = await wpHost.checkFullscreen();
    return !!isBusy;
  } catch (err) {
    console.error('[GameMode] Error checking fullscreen via host:', err);
    try {
      const out = await runCom(['-Mode', 'check-fullscreen']);
      return out.trim() === 'True';
    } catch (fallbackErr) {
      console.error('[GameMode] Error checking fullscreen via fallback:', fallbackErr);
    }
  }
  return false;
}

let monitorsCache = [];

async function getMonitors() {
  let list = null;
  try {
    list = await wpHost.enumMonitors(); // быстрый путь: живой COM-хост
  } catch (e1) {
    try {
      const out = await runCom(['-Mode', 'enum']); // фоллбек: spawn-per-call
      const parsed = JSON.parse((out || '').trim() || '[]');
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e2) {
      console.error('Не удалось перечислить мониторы (COM):', e2);
      list = [];
    }
  }
  monitorsCache = (list || []).map((m) => ({
    id: m.id,
    x: m.x, y: m.y, w: m.w, h: m.h,
    primary: m.x === 0 && m.y === 0,
  }));
  return monitorsCache;
}

// ---------------------------------------------------------------------------
// Theme schedule — Znada itself switches the Windows light/dark theme by time.
// ---------------------------------------------------------------------------
const THEME_SCRIPT_PATH = path.join(app.getPath('userData'), 'set-theme.ps1');

const THEME_SCRIPT = `param([int]$Light)
$p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
Set-ItemProperty -Path $p -Name AppsUseLightTheme -Value $Light -Type Dword -ErrorAction SilentlyContinue
Set-ItemProperty -Path $p -Name SystemUsesLightTheme -Value $Light -Type Dword -ErrorAction SilentlyContinue
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ThemeBcast {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
}
"@
$r=[IntPtr]::Zero
# HWND_BROADCAST=0xffff, WM_SETTINGCHANGE=0x1A, SMTO_ABORTIFHUNG=2
[ThemeBcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [IntPtr]::Zero, "ImmersiveColorSet", 2, 200, [ref]$r) | Out-Null
`;

function ensureThemeScript() {
  try {
    fs.mkdirSync(path.dirname(THEME_SCRIPT_PATH), { recursive: true });
    fs.writeFileSync(THEME_SCRIPT_PATH, THEME_SCRIPT, 'utf8');
  } catch (err) {
    console.error('Не удалось записать theme-скрипт:', err);
  }
}

function setWindowsTheme(isDark) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', THEME_SCRIPT_PATH, '-Light', isDark ? '0' : '1'],
      { windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      }
    );
  });
}

let themeTimer = null;
let lastScheduledTheme = null;

// Schedule math (parse/sun/boundaries) lives in src/schedule.js — pure & unit-tested.
// This wrapper binds the Windows-theme schedule from the live config.
function themeScheduleBoundaries(date) {
  return schedule.boundaries(config.themeSchedule, date);
}

function clearThemeTimer() {
  if (themeTimer) { clearTimeout(themeTimer); themeTimer = null; }
}

// Apply the scheduled theme now (modes: time / sun) and schedule the next flip.
async function applyThemeSchedule() {
  clearThemeTimer();
  const sch = config.themeSchedule || {};
  if (sch.mode !== 'time' && sch.mode !== 'sun') return; // 'off' — Znada does not drive the theme
  const now = new Date();
  const b = themeScheduleBoundaries(now);
  if (!b) { themeTimer = setTimeout(applyThemeSchedule, 60 * 60000); return; } // no coords / polar — retry in 1h
  const wantDark = schedule.saysDark(b, now);
  const scheduledTheme = wantDark ? 'dark' : 'light';

  // Smart reset: crossing a schedule boundary (e.g. sunrise→sunset) clears a manual override.
  if (lastScheduledTheme && lastScheduledTheme !== scheduledTheme && config.themeOverride != null) {
    console.log('[Theme] Scheduled boundary crossed — dropping manual override.');
    config.themeOverride = null;
    saveSettingsOnly();
  }
  lastScheduledTheme = scheduledTheme;

  // If there's an active override, we skip applying the scheduled theme to Windows, but keep the timer running to detect the next boundary.
  if (config.themeOverride != null) {
    themeTimer = setTimeout(applyThemeSchedule, schedule.minutesUntilNextBoundary(b, now) * 60000 + 3000);
    return;
  }

  if (wantDark !== nativeTheme.shouldUseDarkColors) {
    if (config.gameModeBlock && await isGameOrFullscreenRunning()) {
      console.log('[GameMode] Theme schedule flip blocked. Will retry in 1 minute.');
      themeTimer = setTimeout(applyThemeSchedule, 60000);
      return;
    }
    setWindowsTheme(wantDark).then(
      () => reportChannelSuccess('theme-schedule', 'journal.themeSchedule'),
      (e) => {
        console.error('Не удалось сменить тему Windows:', e);
        reportChannelFailure('theme-schedule', 'journal.themeSchedule', {
          titleKey: 'notify.themeFailedTitle',
          bodyKey: 'notify.themeFailedBody',
        });
      }
    );
  }
  themeTimer = setTimeout(applyThemeSchedule, schedule.minutesUntilNextBoundary(b, now) * 60000 + 3000);
}

function setWallpaper(imagePath) {
  return new Promise((resolve, reject) => {
    if (!imagePath || !fs.existsSync(imagePath)) {
      reject(new Error('Файл обоев не найден: ' + imagePath)); return;
    }
    const map = STYLE_MAP[config.style] || STYLE_MAP.fill;
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', PS_SCRIPT_PATH,
        '-Path', imagePath,
        '-Style', String(map.style),
        '-Tile', String(map.tile),
      ],
      { windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      }
    );
  });
}

// Тема ОС (для UI: титулбар, трей, тема окна). НЕ для выбора обоев — см. wallpaperThemeName().
function currentThemeName() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

// Shared coordinates live in themeSchedule for backward compatibility, while the
// wallpaper schedule owns its independent mode and clock times.
function wallpaperScheduleConfig() {
  const location = config.themeSchedule || {};
  return {
    ...(config.wallpaperSchedule || {}),
    lat: location.lat || '',
    lng: location.lng || '',
  };
}

// The single source of truth for choosing the wallpaper slot. Unified mode always
// uses 'light'; system/off keep the current Windows slot; time/sun use a virtual
// day/night state independent from Windows.
function wallpaperThemeName(date = new Date()) {
  if (config.separateThemes === false) return 'light';
  return schedule.resolveTheme(wallpaperScheduleConfig(), date, currentThemeName());
}

let wallpaperTimer = null;
function clearWallpaperTimer() {
  if (wallpaperTimer) { clearTimeout(wallpaperTimer); wallpaperTimer = null; }
}

// Apply the independent wallpaper schedule now and arm its next boundary. `applyNow`
// is false when another scheduler (the slideshow) already applied the current frame.
async function applyWallpaperSchedule(isManual = false, applyNow = true) {
  clearWallpaperTimer();
  const sch = wallpaperScheduleConfig();
  if (config.separateThemes === false || (sch.mode !== 'time' && sch.mode !== 'sun')) return;

  const now = new Date();
  const b = schedule.boundaries(sch, now);
  if (!b) {
    wallpaperTimer = setTimeout(() => applyWallpaperSchedule(false, true), 60 * 60000);
    return;
  }

  const theme = schedule.saysDark(b, now) ? 'dark' : 'light';
  broadcastWallpaperTheme(theme);
  if (applyNow) {
    const result = await applyForTheme(theme, isManual);
    if (result && result.reason === 'gamemode-blocked') {
      wallpaperTimer = setTimeout(() => applyWallpaperSchedule(false, true), 60000);
      return;
    }
  }
  wallpaperTimer = setTimeout(
    () => applyWallpaperSchedule(false, true),
    schedule.minutesUntilNextBoundary(b, now) * 60000 + 3000
  );
}

// id основного монитора (для режима «одни обои на все мониторы»)
function primaryMonitorId() {
  const p = monitorsCache.find((m) => m.primary) || monitorsCache[0];
  return p ? p.id : null;
}

// ---- Слайдшоу: слот = плейлист; чистая логика — в ./src/playlist.js ----
function slotFor(monitorId, theme) {
  const m = config.monitors && config.monitors[monitorId];
  const slot = m && m[theme];
  return slot && Array.isArray(slot.itemIds) ? slot : { itemIds: [] };
}

function ensureSlideshowPosition(monitorId) {
  if (!config.slideshowIndex[monitorId]) config.slideshowIndex[monitorId] = { light: 0, dark: 0 };
  if (!config.slideshowCurrentPath[monitorId]) config.slideshowCurrentPath[monitorId] = { light: '', dark: '' };
}

function storeSlideshowPosition(monitorId, theme, position) {
  ensureSlideshowPosition(monitorId);
  const index = Number.isFinite(position.index) ? position.index : 0;
  const p = typeof position.path === 'string' ? position.path : '';
  if (config.slideshowIndex[monitorId][theme] !== index || config.slideshowCurrentPath[monitorId][theme] !== p) {
    config.slideshowIndex[monitorId][theme] = index;
    config.slideshowCurrentPath[monitorId][theme] = p;
    slideshowPositionDirty = true;
  }
}

function resolveSlideshowPosition(monitorId, theme, options = {}) {
  const list = playlist.resolveSlot(slotFor(monitorId, theme), config.library, {
    forceFolderScan: !!options.forceFolderScan,
    exclude: hiddenPathSet(),
  });
  if (!list.length) return { list, index: 0, path: '' };
  ensureSlideshowPosition(monitorId);
  const position = playlist.reconcilePosition(
    list,
    config.slideshowCurrentPath[monitorId][theme],
    config.slideshowIndex[monitorId][theme],
    options
  );
  storeSlideshowPosition(monitorId, theme, position);
  return { list, ...position };
}

// Current path follows the saved path first and uses the legacy index only as fallback.
function currentImageFor(monitorId, theme) {
  return resolveSlideshowPosition(monitorId, theme).path;
}

// Все файлы, на которые ссылается БИБЛИОТЕКА (+ легаси-глобалы) — keep-набор для GC.
// Сама логика — в src/library.js (referencedFiles), под unit-тестами: это страховка от
// повторения инцидента 2026-06-03 (неполный keep-набор → файлы пользователя в корзину).
function referencedFiles() {
  return library.referencedFiles(config);
}

// Подчищает осиротевшие файлы из wallpapers/ — но БЕЗОПАСНО: НЕ удаляет навсегда, а
// ПЕРЕМЕЩАЕТ в подпапку .trash (восстановимо). Раньше тут был fs.rmSync + запуск на каждом
// СТАРТЕ → если keep-набор хоть на миг оказывался неполным (миграция/смена состояния), файлы
// пользователя удалялись безвозвратно. Теперь: только move-в-корзину, и НЕ на старте.

// True when the file is Znada's own copy (import / Online download) rather than
// something of the user's that merely happens to be in the library. Only those go to
// wallpapers/.trash, and only those need remembering to be restorable from it.
function isOwnWallpaperCopy(p) {
  return isDirectChildPath(p, wallpapersDir());
}
function gcWallpapers() {
  // Never sweep against a pool that failed to load: the keep-set would be wrong and
  // files still in use would be moved out from under the user.
  //
  // BUG-023: the same holds for the SETTINGS. The keep-set includes the two legacy
  // global fallback paths out of config.json, so a defaults-only config makes an
  // own-copy that nothing else references look like an orphan. Measured, not assumed:
  // without this line the regression test's photo really is moved to .trash.
  if (libraryUnsafeToWrite || configUnsafeToWrite) return;
  // DATA-006. Same rule, one level up: with the folder itself absent, readdir returns
  // nothing and the sweep would be a no-op today — but the moment it came back as a
  // freshly created empty folder, every own-copy would look like an orphan.
  if (!managedRootReady()) return;
  // And never while a move is under way: between the library write and the cleanup the
  // old folder is full of files nothing references any more, which is exactly what this
  // sweeps. It would move them into the old trash a moment before the move deletes them.
  if (mediaMoveRunning) return;
  try {
    // Предохранитель: если пул пуст (переходное/битое состояние) — НЕ трогаем ничего,
    // иначе keep свёлся бы к одним глобалам и всё остальное уехало бы в корзину.
    if (!config.library || Object.keys(config.library).length === 0) return;
    const keep = referencedFiles();
    fs.mkdirSync(trashDirPath(), { recursive: true });
    for (const f of fs.readdirSync(wallpapersDir())) {
      if (f === '.trash') continue;
      const full = path.join(wallpapersDir(), f);
      try { if (!fs.statSync(full).isFile()) continue; } catch { continue; }
      if (!keep.has(pathKey(full))) {
        try { fs.renameSync(full, path.join(trashDirPath(), f)); } catch { /* оставляем как есть, не удаляем */ }
      }
    }
  } catch {}
}

function wallpaperFor(monitorId, theme) {
  if (config.singleWallpaper) {
    // одни обои на все мониторы = текущая картинка плейлиста ОСНОВНОГО монитора
    return currentImageFor(primaryMonitorId(), theme);
  }
  const p = currentImageFor(monitorId, theme);
  if (p) return p;
  const m = config.monitors && config.monitors[monitorId];
  const slot = m && m[theme];
  if (!library.allowsLegacyFallback(slot)) return '';
  // Легаси-fallback нужен старым конфигам, но не после явной очистки слота пользователем.
  return (theme === 'dark' ? config.darkWallpaper : config.lightWallpaper) || '';
}

// Windows' IDesktopWallpaper renders a blank/solid desktop for a large PNG — it accepts the
// path without error but fails to decode/cache it past ~10-20 MB (a 21 MB PNG applies as a
// placeholder, though thumbnails are fine; small PNGs set fine). JPEG has no such limit. So a
// big NON-JPEG file is re-encoded to a FULL-RESOLUTION, maximum-quality JPEG (never downscaled)
// and that is applied; JPEGs and small files are used as-is, untouched. Cached in
// userData/wp-cache (key = path+size+mtime). Best-effort — any failure falls back to the original.
const WP_CACHE_DIR = path.join(app.getPath('userData'), 'wp-cache');
const WP_SAFE_BYTES = 10 * 1024 * 1024; // below this a PNG sets fine; above it we convert to JPEG
async function ensureWallpaperReady(srcPath) {
  const ext = path.extname(srcPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return srcPath; // JPEG has no size limit — apply as-is
  let st;
  try { st = fs.statSync(srcPath); } catch { return srcPath; }
  if (st.size <= WP_SAFE_BYTES) return srcPath; // small enough — keep the ORIGINAL file, untouched
  try {
    const key = crypto.createHash('md5').update(`${srcPath}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex').slice(0, 16);
    const dest = path.join(WP_CACHE_DIR, `wp-full-${key}.jpg`);
    if (fs.existsSync(dest)) return dest;
    const img = nativeImage.createFromPath(srcPath);
    if (img.isEmpty()) return srcPath;
    const jpeg = img.toJPEG(100); // FULL resolution, MAXIMUM quality — JPEG bypasses the PNG limit
    if (!jpeg || !jpeg.length) return srcPath;
    fs.mkdirSync(WP_CACHE_DIR, { recursive: true });
    fs.writeFileSync(dest, jpeg);
    const sz = img.getSize();
    console.log(`[Wallpaper] converted large ${ext} to full-res JPEG q100: ${(st.size / 1048576).toFixed(1)} MB → ${(jpeg.length / 1048576).toFixed(1)} MB at ${sz.width}x${sz.height}`);
    return dest;
  } catch (e) { console.error('ensureWallpaperReady:', e); return srcPath; }
}

// Thin diagnostics wrapper (span #6 of the MVP-A budget): every wallpaper apply is
// recorded with its duration and outcome; call sites keep using applyForTheme().
async function applyForTheme(themeName, isManual = false, targetMonitors = null) {
  const endSpan = diagSpan('wallpaper', 'apply');
  try {
    const result = await applyForThemeCore(themeName, isManual, targetMonitors);
    // Only known short reasons; a raw error message may carry a file path and
    // redaction does not exist until stage 4.
    const reason = result && result.ok ? 'ok' : ((result && result.reason) || 'error');
    endSpan({ status: ['ok', 'gamemode-blocked', 'no-wallpaper', 'wallpaper-missing'].includes(reason) ? reason : 'error' });
    reportApplyOutcome(result, isManual); // journal + edge-triggered notification (T2/T3)
    return result;
  } catch (err) {
    endSpan({ status: 'error' });
    reportApplyOutcome({ ok: false, reason: 'exception' }, isManual);
    throw err;
  }
}

async function applyForThemeCore(themeName, isManual = false, targetMonitors = null) {
  const theme = config.separateThemes === false ? 'light' : (themeName || wallpaperThemeName());
  broadcastWallpaperTheme(theme);
  if (!isManual && config.gameModeBlock && await isGameOrFullscreenRunning()) {
    console.log('[GameMode] Wallpaper change blocked due to active game / fullscreen app');
    return { ok: false, reason: 'gamemode-blocked' };
  }
  const monitors = monitorsCache.length ? monitorsCache : await getMonitors();

  // Preferred path: per-monitor via COM
  if (monitors.length) {
    // Every monitor's outcome is recorded, not just the usable ones: a path that
    // resolves to nothing is what "the source went away" looks like from here, and
    // dropping it on the floor is what made an unplugged disk silent.
    const targets = [];
    for (const m of monitors) {
      if (targetMonitors && !targetMonitors.includes(m.id)) continue;
      const p = wallpaperFor(m.id, theme);
      targets.push({ id: m.id, path: p, exists: !!(p && fs.existsSync(p)) });
    }
    const outcome = applyOutcome.classifyApplyTargets(targets);
    const items = [];
    for (const target of outcome.applied) {
      items.push({ id: target.id, path: await ensureWallpaperReady(target.path) });
    }
    persistSlideshowPosition();
    if (!items.length) {
      return { ok: false, reason: outcome.reason, theme, missing: outcome.missingPaths, sourcesChecked: true };
    }
    const pos = COM_POS[config.style] != null ? COM_POS[config.style] : 4;
    try {
      await wpHost.apply(pos, items); // быстрый путь: живой COM-хост (без перекомпиляции)
      return { ok: true, theme, missing: outcome.missingPaths, sourcesChecked: true };
    } catch (eHost) {
      try {
        fs.writeFileSync(APPLY_DATA_PATH, JSON.stringify({ position: pos, items }), 'utf8');
        await runCom(['-Mode', 'apply', '-DataFile', APPLY_DATA_PATH]); // фоллбек: spawn-per-call
        return { ok: true, theme, missing: outcome.missingPaths, sourcesChecked: true };
      } catch (err) {
        console.error('Ошибка применения per-monitor (COM), пробую legacy single:', err);
        // fall through to legacy single
      }
    }
  }

  // Fallback: single wallpaper for all monitors (older Windows / COM failure)
  const target = theme === 'dark' ? config.darkWallpaper : config.lightWallpaper;
  // The same fork on the single-wallpaper path. Fixing only the per-monitor loop
  // would have left this one silent on exactly the machines that fall back to it.
  const legacy = applyOutcome.classifyApplyTargets([
    { id: 'legacy', path: target, exists: !!(target && fs.existsSync(target)) },
  ]);
  if (target && fs.existsSync(target)) {
    try {
      await setWallpaper(target);
      return { ok: true, theme, path: target, missing: legacy.missingPaths, sourcesChecked: true };
    } catch (err) {
      console.error('Ошибка смены обоев:', err);
      return { ok: false, reason: err.message, theme, missing: legacy.missingPaths, sourcesChecked: true };
    }
  }
  return { ok: false, reason: legacy.reason, theme, missing: legacy.missingPaths, sourcesChecked: true };
}

// ---------------------------------------------------------------------------
// Slideshow scheduler — rotate each monitor's playlist on an interval.
// Mirrors applyThemeSchedule(): timer → advance indices → applyForTheme → reschedule.
// ---------------------------------------------------------------------------
let slideshowTimer = null;
// HOME-001: Главная показывает живой отсчёт, поэтому момент срабатывания таймера и
// причина, по которой честного момента НЕТ, обязаны жить рядом с самим таймером.
// Любая правка планировщика ниже проходит через эти же две переменные — второго
// набора «когда сменится» в приложении нет.
let slideshowTimerDueAt = 0;   // epoch ms взведённого таймера, 0 — таймера нет
let slideshowHold = null;      // 'gamemode' — таймер лишь перепроверяет, а не сменит

function clearSlideshowTimer() {
  if (slideshowTimer) { clearTimeout(slideshowTimer); slideshowTimer = null; }
  slideshowTimerDueAt = 0;
  slideshowHold = null;
  pushNextChange();
}

// Advance from the saved path in a freshly scanned playlist. If the current file
// disappeared, reconcilePosition keeps its old index as the successor position.
function advanceIndices(theme, targetMonitors = null) {
  const shuffle = config.slideshow.order === 'shuffle';
  const primary = config.singleWallpaper ? primaryMonitorId() : null;
  const sources = primary ? monitorsCache.filter((m) => m.id === primary) : monitorsCache;
  for (const m of sources) {
    if (!config.singleWallpaper && targetMonitors && !targetMonitors.includes(m.id)) continue;
    resolveSlideshowPosition(m.id, theme, {
      advance: true,
      shuffle,
      forceFolderScan: true,
    });
  }
}

// advance=true сдвигает кадр; false — просто применить текущее и (пере)запланировать.
function slideshowIntervalEnabled() {
  return !!(config.slideshow && config.slideshow.enabled && playlist.usesInterval(config.slideshow));
}

function slideshowIntervalMs() {
  const mins = Math.max(1, Math.floor(Number(config.slideshow && config.slideshow.intervalMin) || 30));
  return mins * 60000;
}

function scheduleSlideshowTimer(delayMs = slideshowIntervalMs()) {
  clearSlideshowTimer();
  if (!slideshowIntervalEnabled()) return;
  const delay = Math.max(1, Math.floor(Number(delayMs) || slideshowIntervalMs()));
  slideshowTimer = setTimeout(runSlideshowInterval, delay);
  slideshowTimerDueAt = Date.now() + delay;
  pushNextChange();
}

// Игровой режим/полный экран: таймер ниже НЕ меняет обои, он через минуту снова
// спрашивает систему. Поэтому взводим его с пометкой hold — интерфейс не должен
// превратить эту минуту в обещание «через 1 мин».
function retrySlideshowIntervalSoon() {
  clearSlideshowTimer();
  if (!config.slideshow || !config.slideshow.enabled) return;
  slideshowTimer = setTimeout(runSlideshowInterval, 60000);
  slideshowTimerDueAt = Date.now() + 60000;
  slideshowHold = 'gamemode';
  pushNextChange();
}

async function runSlideshowInterval() {
  slideshowTimer = null;
  slideshowTimerDueAt = 0;
  if (!slideshowIntervalEnabled()) { pushNextChange(); return; }
  if (config.gameModeBlock && await isGameOrFullscreenRunning()) {
    console.log('[GameMode] Slideshow rotation blocked. Will retry in 1 minute.');
    retrySlideshowIntervalSoon();
    return;
  }
  if (stealthScoped('interval')) {
    requestWallpaperAdvance('interval', { initialDelayMs: 0, rescheduleInterval: true });
    return;
  }
  await tickSlideshow(true, false);
}

// Returns the applyForTheme result on the paths that actually apply, so manual
// triggers (Home button, hotkey) can report an honest outcome to the user.
// Auto-only early exits keep returning undefined — their callers ignore it.
async function tickSlideshow(advance, isManual = false) {
  clearSlideshowTimer();
  if (!config.slideshow || !config.slideshow.enabled) return;
  const intervalEnabled = slideshowIntervalEnabled();
  // A timer may already be queued when the user disables the interval trigger.
  if (advance && !isManual && !intervalEnabled) return;

  if (!isManual && config.gameModeBlock && await isGameOrFullscreenRunning()) {
    console.log('[GameMode] Slideshow rotation blocked. Will retry in 1 minute.');
    retrySlideshowIntervalSoon();
    return { ok: false, reason: 'gamemode-blocked' };
  }

  const theme = wallpaperThemeName();
  // Slideshow position only — the pool is untouched, so this must not schedule a full
  // rewrite of every photo record. This is the most frequent write in the app.
  if (advance) { advanceIndices(theme); saveSettingsOnly(); }
  const result = await applyForTheme(theme, isManual);
  if (intervalEnabled) scheduleSlideshowTimer();
  return result;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const TITLEBAR_HEIGHT = 44;

function titleBarOverlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? '#303030' : '#ffffff',
    symbolColor: dark ? '#ffffff' : '#2e3436',
    height: TITLEBAR_HEIGHT,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 660,
    minWidth: 780,
    minHeight: 560,
    show: false,
    title: DEV_LAUNCH_INFO ? DEV_LAUNCH_INFO.windowTitle : 'Znada',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayColors(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#242424' : '#fafafa',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      ...windowSecurity('main'),
      additionalArguments: [...diagRendererArgs('renderer-main'), ...devLaunchRendererArgs()],
      // In diagnostics mode keep rAF running while the window is merely unfocused (the
      // floating control window must not zero out smoothness sampling). The probe still
      // stops counting when the window is genuinely hidden/minimized.
      backgroundThrottling: !DIAGNOSTICS_BOOTSTRAP.enabled,
    },
  });

  if (diagnosticsController) diagnosticsController.attachWindowEvents(mainWindow, 'main');
  // COLLAB-003. The page's own <title> would replace the check label on every load.
  if (DEV_LAUNCH_INFO) mainWindow.on('page-title-updated', (event) => event.preventDefault());

  mainWindow.loadFile(hardenWindow(mainWindow, 'main'));

  mainWindow.webContents.on('console-message', ({ message, sourceId, lineNumber }) => {
    console.log(`[Renderer Console] ${message} (${sourceId}:${lineNumber})`);
  });

  const resumeHotkeys = () => { hotkeyCtl.setSuspended(false); };
  // The renderer normally resumes after recording. Main still owns the final
  // fail-safe: a reload/crash between suspend and the renderer's `finally` must
  // not leave every global shortcut disabled until the whole app restarts.
  mainWindow.webContents.on('render-process-gone', resumeHotkeys);
  mainWindow.webContents.on('did-start-navigation', resumeHotkeys);
  mainWindow.webContents.on('destroyed', resumeHotkeys);

  mainWindow.once('ready-to-show', () => {
    if (!STARTED_HIDDEN) mainWindow.show();
  });

  mainWindow.on('show', reconcileLiveFoldersIfStale);
  // A renderer crash/hide must never leave all app shortcuts suspended. The
  // recording UI also resumes explicitly, but main owns this final fail-safe.
  mainWindow.on('hide', resumeHotkeys);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Если окно всё-таки разрушено — сбрасываем ссылку, чтобы showWindow() пересоздал
  // его, а не звал методы на «мёртвом» объекте (это бросает исключение → открывается
  // трей, но окно не появляется — тот самый баг «только трей»).
  mainWindow.on('closed', () => { mainWindow = null; });
}

function bringToFront(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  // Windows often suppresses focus from a background process; this flicker
  // reliably pulls the window to the foreground.
  win.setAlwaysOnTop(true);
  win.setAlwaysOnTop(false);
  win.moveTop();
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    mainWindow.once('ready-to-show', () => bringToFront(mainWindow));
    return;
  }
  bringToFront(mainWindow);
}

function sanitizeGalleryPayload(payload) {
  return galleryPayloadMod.sanitizeGalleryPayload(payload);
}

function createGalleryWindow() {
  // Span #5 of the MVP-A budget: viewer window creation → ready-to-show.
  const endOpenSpan = diagSpan('viewer', 'open-to-ready', { count: galleryPayload.items.length });
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = display.workArea || display.bounds;
  galleryWindowNormalBounds = { ...bounds };
  galleryWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 640,
    minHeight: 420,
    show: false,
    frame: false,
    thickFrame: false,
    autoHideMenuBar: true,
    title: DEV_LAUNCH_INFO ? DEV_LAUNCH_INFO.viewerTitle : 'Znada Media Viewer',
    backgroundColor: '#050505',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'viewer-preload.js'),
      ...windowSecurity('viewer'),
      backgroundThrottling: false,
      additionalArguments: diagRendererArgs('renderer-viewer'),
    },
  });

  if (diagnosticsController) diagnosticsController.attachWindowEvents(galleryWindow, 'viewer');
  if (DEV_LAUNCH_INFO) galleryWindow.on('page-title-updated', (event) => event.preventDefault());

  galleryWindow.loadFile(hardenWindow(galleryWindow, 'viewer'));

  galleryWindow.webContents.on('console-message', ({ message, sourceId, lineNumber }) => {
    console.log(`[Viewer Console] ${message} (${sourceId}:${lineNumber})`);
  });

  galleryWindow.once('ready-to-show', () => {
    endOpenSpan();
    if (!galleryWindow || galleryWindow.isDestroyed()) return;
    galleryWindow.show();
    bringToFront(galleryWindow);
  });

  galleryWindow.on('enter-full-screen', () => {
    galleryWindowFullscreen = true;
    if (galleryWindow && !galleryWindow.isDestroyed()) galleryWindow.webContents.send('gallery-fullscreen-changed', true);
  });
  galleryWindow.on('leave-full-screen', () => {
    galleryWindowFullscreen = false;
    if (galleryWindow && !galleryWindow.isDestroyed()) galleryWindow.webContents.send('gallery-fullscreen-changed', false);
  });

  galleryWindow.on('closed', () => {
    galleryWindow = null;
    galleryWindowNormalBounds = null;
    galleryWindowFullscreen = false;
  });
}

function openGalleryWindow(payload) {
  galleryPayload = sanitizeGalleryPayload(payload);
  galleryPayload.background = config.viewerBackground || 'ambient';
  if (!galleryPayload.items.length) return { ok: false, error: 'empty' };
  if (!galleryWindow || galleryWindow.isDestroyed()) {
    createGalleryWindow();
  } else {
    diagCountSend('gallery-payload');
    galleryWindow.webContents.send('gallery-payload', galleryPayload);
    bringToFront(galleryWindow);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Slideshow Helpers
// ---------------------------------------------------------------------------
function hasSlideshowItems() {
  const theme = wallpaperThemeName();
  if (config.singleWallpaper) {
    return playlist.resolveSlot(slotFor(primaryMonitorId(), theme), config.library, { exclude: hiddenPathSet() }).length >= 2;
  }
  for (const m of monitorsCache) {
    if (playlist.resolveSlot(slotFor(m.id, theme), config.library, { exclude: hiddenPathSet() }).length >= 2) {
      return true;
    }
  }
  return false;
}

// "Invisible" (stealth) wallpaper changes wait for a fullscreen window over a monitor before
// swapping its wallpaper. The cancelable wait/retry/timeout state machine lives in the tested
// src/stealth-session.js; here we inject the real timers, monitor list, coverage check and the
// apply. A single session exists at a time, so two automatic events (e.g. wake + a theme flip)
// can't double-advance; a manual change calls cancelPendingStealth() to supersede a pending one.
const stealthCtl = createStealthController({
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h),
  getMonitors: async () => (monitorsCache.length ? monitorsCache : await getMonitors()).map((m) => m.id),
  checkCovered: async () => { try { return await wpHost.checkMaximized(2000); } catch { return []; } },
  apply: async ({ theme, monitors, advance }) => {
    console.log(`[Stealth] applying ${theme} ${advance ? '(new frame)' : '(current frame)'} on`, monitors);
    if (advance) { advanceIndices(theme, monitors); saveSettingsOnly(); }  // position only
    await applyForTheme(theme, true, monitors);
    // Сессия закрывается сразу после последнего apply, поэтому Главная узнаёт об
    // окончании ожидания именно отсюда (см. отложенную отправку в pushNextChange).
    pushNextChange();
  },
  pollMs: 3000,
  log: (...a) => console.log('[Stealth]', ...a),
});

// The non-stealth path keeps a single delayed auto-advance (not the session controller).
let autoAdvanceTimer = null;
function cancelPendingStealth() {
  stealthCtl.cancel();
  if (autoAdvanceTimer) { clearTimeout(autoAdvanceTimer); autoAdvanceTimer = null; }
  pushNextChange();
}

// Stealth config helpers (the field is an object since v1.4.3: enabled + per-reason scopes + timeout).
function stealthCfg() { return (config.triggers && config.triggers.stealth) || {}; }
function stealthScoped(reason) { const s = stealthCfg(); return !!s.enabled && !!s[reason]; }
function stealthTimeoutMs() {
  const m = Number(stealthCfg().timeoutMin);
  return (Number.isFinite(m) && m >= 1 ? Math.min(60, Math.floor(m)) : 5) * 60000;
}

function rescheduleSlideshowAfterManualWallpaperChange() {
  if (slideshowIntervalEnabled()) scheduleSlideshowTimer();
}

// ---------------------------------------------------------------------------
// «Когда сменятся обои» для Главной (HOME-001)
// ---------------------------------------------------------------------------
// Renderer рисует отсчёт, но не решает, есть ли он: сюда сходятся ВСЕ причины,
// по которым честного времени нет. Ожидание «невидимой смены» не хранится
// отдельным флагом — его знает сама сессия, и второй флаг неминуемо разошёлся бы
// с ней. Чистая часть решения — src/next-change.js.
function nextChangeState() {
  return nextChange.describe({
    slideshowEnabled: !!(config.slideshow && config.slideshow.enabled),
    intervalEnabled: slideshowIntervalEnabled(),
    dueAt: slideshowTimerDueAt,
    hold: slideshowHold || (stealthCtl.isActive() ? 'stealth' : null),
  });
}

// Одна отправка на такт: перепланирование почти всегда идёт как clear + schedule,
// и без склейки интерфейс успел бы моргнуть промежуточным состоянием. Отправка
// именно через setImmediate (а не микрозадачу) — так состояние успевает досчитаться
// до конца: сессия «невидимой смены» закрывается в микрозадаче после apply.
let nextChangePushTimer = null;
function pushNextChange() {
  if (nextChangePushTimer) return;
  nextChangePushTimer = setImmediate(() => {
    nextChangePushTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('next-change', nextChangeState());
    }
  });
}

// Single entry point for every AUTOMATIC wallpaper advance (startup / wakeup / interval). With stealth on
// for that reason it routes through the one cancelable session; otherwise it advances after a
// short settle delay, as before.
function requestWallpaperAdvance(reason, options = {}) {
  if (!config.slideshow || !config.slideshow.enabled) return;
  const initialDelayMs = Number.isFinite(+options.initialDelayMs)
    ? Math.max(0, Math.floor(+options.initialDelayMs))
    : 5000;
  const rescheduleInterval = !!options.rescheduleInterval;
  if (rescheduleInterval) clearSlideshowTimer();
  const scoped = stealthScoped(reason);
  console.log(`[Stealth] advance requested: ${reason} (stealth ${scoped ? 'ON' : 'off'})`);
  if (scoped) {
    // Сессия становится активной только после перечисления мониторов внутри request(),
    // поэтому Главную уведомляем по её промису, а не сразу после вызова.
    const started = stealthCtl.request({
      theme: wallpaperThemeName(),
      advance: true,
      single: !!config.singleWallpaper,
      timeoutMs: stealthTimeoutMs(),
      initialDelayMs, // boot/resume settle for startup/wakeup; interval uses 0.
      onComplete: rescheduleInterval ? () => scheduleSlideshowTimer() : null,
    });
    if (started && typeof started.then === 'function') started.then(pushNextChange, pushNextChange);
    else pushNextChange();
  } else {
    if (autoAdvanceTimer) clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = setTimeout(() => {
      autoAdvanceTimer = null;
      if (!config.slideshow || !config.slideshow.enabled) return;
      triggerNextWallpaper();
    }, initialDelayMs);
  }
}

async function triggerNextWallpaper(targetMonitors = null) {
  cancelPendingStealth(); // a manual "next" supersedes any pending stealth/auto advance
  if (config.singleWallpaper) targetMonitors = null;
  const theme = wallpaperThemeName();
  if (config.slideshow && config.slideshow.enabled && !targetMonitors) {
    return tickSlideshow(true, true);
  } else {
    advanceIndices(theme, targetMonitors);
    saveSettingsOnly();  // position only
    try {
      return await applyForTheme(theme, true, targetMonitors);
    } finally {
      rescheduleSlideshowAfterManualWallpaperChange();
    }
  }
}

const hotkeyCtl = hotkey.createController({
  globalShortcut,
  onTrigger: (shortcut) => {
    console.log(`[Hotkey] Triggered: ${shortcut}`);
    triggerNextWallpaper();
  },
});

function registerShortcut() {
  const settings = config.hotkeys && config.hotkeys.nextWallpaper;
  const result = hotkeyCtl.apply(settings);
  if (result.ok && result.changed && result.active) {
    console.log(`[Hotkey] Registered successfully: ${result.active}`);
  }
  if (!result.ok && settings && settings.enabled) {
    // Windows can reserve an accelerator between sessions. Do not present a
    // knowingly non-working enabled toggle after startup; keep the user's text
    // so they can retry, but persist the honest disabled state.
    config.hotkeys = {
      ...(config.hotkeys || {}),
      nextWallpaper: { ...settings, enabled: false },
    };
    if (!saveSettingsOnly()) console.error('[Hotkey] Failed to persist disabled state after startup conflict.');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
// Системный трей вынесен в ./src/tray.js (Electron-объекты и действия инжектятся).
const trayCtl = createTrayController({
  Tray, Menu, nativeImage,
  assetsDir: path.join(__dirname, 'assets'),
  t: tMain,
  getState: () => ({
    theme: currentThemeName(),
    updateState,
    slideshowEnabled: !!(config.slideshow && config.slideshow.enabled),
    hasSlideshowItems: hasSlideshowItems(),
  }),
  tooltip: DEV_LAUNCH_INFO ? DEV_LAUNCH_INFO.trayTooltip : undefined, // COLLAB-003
  onOpen: () => showWindow(),
  onApplyCurrent: () => applyForTheme(null, true),
  onNextWallpaper: () => triggerNextWallpaper(),
  onInstallUpdate: () => quitAndInstallUpdate(),
  onQuit: () => { app.isQuitting = true; app.quit(); },
});

// ---------------------------------------------------------------------------
// Autostart
// ---------------------------------------------------------------------------
function applyLoginItem() {
  // НИКОГДА во время squirrel-события. Это и есть причина того, что деинсталляция
  // оставляла запись автозапуска: обработчик --squirrel-uninstall её честно удалял,
  // но процесс на этом не заканчивался — доходил до app.whenReady(), читал конфиг с
  // autostart=true и записывал её обратно. Удаление работало, его отменяли через
  // секунду. Найдено замером владельца 2026-08-18: после прямого вызова обработчика
  // запись снова была на месте.
  // Автозапуском Windows управляет ТОЛЬКО установленная (Squirrel) сборка. Dev и портативная
  // НЕ трогают реестр: иначе каждая сборка регистрируется под СВОИМ ключом (electron.app.<name>,
  // имя/путь различаются), записи в HKCU\…\Run накапливаются, и при входе в Windows стартует сразу
  // НЕСКОЛЬКО разных версий (баг 2026-06-05: поднималась портативная/dev вместо установленной,
  // а из-за дубль-экземпляра second-instance вылезало окно даже при --hidden).
  if (!windowsLaunch.shouldWriteLoginItem({
    installed: updatesSupported(),
    squirrelEvent: SQUIRREL_LIFECYCLE_EVENT,
  })) return;
  // Point the Run entry at the STABLE Squirrel Update.exe (one level above app-<ver>), NOT at
  // process.execPath. execPath is the versioned `…\app-<ver>\Znada.exe`, and Squirrel removes the
  // old app-<ver> folder on update — so a versioned Run entry goes stale after every update and the
  // app silently stops auto-starting (bug 2026-06-07). `Update.exe --processStart Znada.exe` always
  // launches the current version and survives updates.
  // Always tag the login launch with --autostart so the "on Windows startup" trigger fires
  // ONLY for a real login (not a manual relaunch). --hidden controls visibility only.
  app.setLoginItemSettings(windowsLaunch.loginItemSettings(process.execPath, {
    enabled: config.autostart,
    startMinimized: config.startMinimized,
    name: WINDOWS_APP_USER_MODEL_ID,
  }));
}

// Подчистить ОСИРОТЕВШИЕ записи автозапуска от dev/portable сборок (`electron.app.*`): право на
// автозапуск Windows есть только у установленной версии. Записи могут жить не только в `…\Run`, но и в
// `…\Explorer\StartupApproved\Run` (ветка статусов) — её Диспетчер задач показывает как автозапуск, и
// обычным `reg query …\Run` её не видно. Тихо, fire-and-forget; трогаем ТОЛЬКО наши ключи.
function cleanStrayAutostartEntries() {
  if (!updatesSupported()) return; // только установленная (Squirrel) сборка чистит
  cleanLegacyAutostartRegistryValues();
}

function setAutostart(enabled) {
  config.autostart = enabled;
  applyLoginItem();
  saveSettingsOnly();
}

function setStartMinimized(enabled) {
  config.startMinimized = enabled;
  applyLoginItem(); // переписываем аргументы автозапуска (--hidden) под новое значение
  saveSettingsOnly();
}

// ---------------------------------------------------------------------------
// Auto-update (Electron autoUpdater → Squirrel.Windows).
// Works ONLY in the installed (Squirrel) build, where Update.exe sits next to
// the app-<ver> folder. In dev / portable we fall back to the Releases page.
// Feed = update.electronjs.org (Electron's hosted service for public GitHub
// repos). NB: the GitHub release must include RELEASES + the *.nupkg, not just
// Setup.exe — otherwise there is nothing for Squirrel to read.
// ---------------------------------------------------------------------------
const RELEASES_PAGE = 'https://github.com/alexvlass01/znada/releases/latest';

let updateState = 'idle'; // idle | checking | downloading | ready | none | error
let updaterWired = false;

function updatesSupported() {
  try {
    // Squirrel installs Update.exe one level above the app-<ver> folder
    return fs.existsSync(path.join(path.dirname(process.execPath), '..', 'Update.exe'));
  } catch { return false; }
}

function setUpdateState(s) {
  updateState = s;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', { state: updateState, supported: updatesSupported() });
  }
  trayCtl.refresh(); // показать/убрать пункт «перезапустить и обновить»
}

function wireAutoUpdater() {
  if (updaterWired || !updatesSupported()) return;
  updaterWired = true;
  try {
    autoUpdater.setFeedURL({ url: `https://update.electronjs.org/alexvlass01/znada/${process.platform}/${app.getVersion()}` });
  } catch (e) { console.error('setFeedURL:', e); }
  autoUpdater.on('checking-for-update', () => setUpdateState('checking'));
  autoUpdater.on('update-available', () => setUpdateState('downloading')); // Squirrel качает сам
  autoUpdater.on('update-not-available', () => setUpdateState('none'));
  autoUpdater.on('update-downloaded', () => setUpdateState('ready'));
  autoUpdater.on('error', (err) => { console.error('autoUpdater:', err); setUpdateState('error'); });
}

// Returns false if updates aren't supported here (caller falls back to the page).
function checkForUpdates() {
  if (!updatesSupported()) return false;
  wireAutoUpdater();
  try { autoUpdater.checkForUpdates(); setUpdateState('checking'); }
  catch (e) { console.error(e); setUpdateState('error'); }
  return true;
}

function quitAndInstallUpdate() {
  if (updateState !== 'ready') return;
  app.isQuitting = true;
  try { autoUpdater.quitAndInstall(); } catch (e) { console.error('quitAndInstall:', e); }
}

// ---------------------------------------------------------------------------
// Renderer communication
// ---------------------------------------------------------------------------
// Each broadcast structured-clones the whole config, pool included — 0.3 ms today,
// 18.5 ms once a watched folder's photos each carry tags. Interactive changes still
// go out immediately (the Library grid depends on the broadcast arriving before the
// assign IPC reply); only machine-driven bursts collapse. See src/coalesce.js.
function sendConfigNow() {
  trayCtl.refresh();
  if (mainWindow && !mainWindow.isDestroyed()) {
    diagCountSend('config-changed');
    mainWindow.webContents.send('config-changed', config);
  }
}

const configBroadcast = coalesce.createLeadingCoalescer({ run: sendConfigNow });

function broadcastConfig() {
  configBroadcast.request();
}

function broadcastTheme(opts = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('theme-changed', currentThemeName(), { silent: !!opts.silent });
  }
}

function broadcastWallpaperTheme(theme = wallpaperThemeName()) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('wallpaper-theme-changed', theme);
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
// SEC-002. Which window may call which channel. Deny by default: `ipcAuthority.handle`
// refuses to register a channel that is not named here, so a new handler cannot quietly
// arrive without an answer to "who is this for".
//
// The lists ARE the three preload bridges — that is where a window's capability is actually
// decided — and test/ipc-authority.test.js reads the bridges back and compares them to this,
// so the two cannot drift. Before this, seventy-seven of the ninety-one channels asked
// nothing at all: the viewer could drive every setting, and an <iframe> inside either window
// shares its WebContents and therefore had its authority.
const IPC_MAIN_ONLY = [
  'add-slot-folder', 'add-slot-images', 'add-slot-paths', 'apply-now', 'check-for-updates',
  'clear-slot', 'cloud-favorite', 'cloud-favorites', 'cloud-session', 'cloud-signin',
  'cloud-signin-cancel', 'cloud-signout', 'create-shortcuts', 'current-image',
  'cycle-theme-override',
  'detect-location', 'event-log-clear', 'event-log-get', 'expand-folders', 'feature-flags',
  'folder-entries', 'folder-info', 'gallery-open', 'get-cloud-capability', 'get-config',
  'get-monitors', 'get-theme', 'get-update-state', 'get-version', 'get-wallpaper-theme',
  'install-update', 'internet-search', 'internet-status', 'internet-tag-suggest',
  'item-copy-path', 'item-details', 'item-open-source', 'item-reveal', 'library-add-folder',
  'library-add-images', 'library-add-paths', 'library-add-tag', 'library-assign-record',
  'library-assign-records', 'library-delete-forever', 'library-ensure-sizes',
  'library-hidden-list', 'library-materialize', 'library-path-sizes', 'library-recent',
  'library-refresh', 'library-remove-tag', 'library-restore', 'library-toggle-favorite',
  'media-folder-move', 'media-folder-pick', 'media-folder-plan', 'media-folder-state',
  'media-folder-stop',
  'next-change-get', 'next-wallpaper', 'open-releases', 'open-website', 'quit-app',
  'remove-slot-item', 'set-autostart', 'set-config', 'set-hotkey', 'set-hotkey-recording',
  'set-slideshow', 'set-slideshow-index', 'set-slideshow-to-path', 'set-start-minimized',
  'shortcuts-status', 'thumb', 'thumb-aspects', 'thumb-info',
];

// Both windows show cards, so both need the actions behind a card's menu (ONL-009).
const IPC_MAIN_AND_VIEWER = [
  'card-copy-file', 'card-copy-link', 'card-open-source', 'card-save-as', 'cloud-add',
  'file-url', 'get-i18n', 'internet-add', 'item-lookup-metadata',
  'library-assign', 'library-remove-many', 'library-undo-remove',
];

// The fullscreen viewer's own window controls.
const IPC_VIEWER_ONLY = [
  'card-assign-targets', 'card-ensure-record', 'gallery-close', 'gallery-payload',
  'gallery-toggle-fullscreen',
];

// Dev-only, and only in a gated diagnostics run; that window does not exist otherwise.
// The eight after the first are registered by diagnostics/main/controller.js rather than
// in this file, THROUGH THE SAME `ipcMain` it is handed - which is this guarded one.
// Leaving them out of the table did not make them unguarded, it made them
// unregisterable: the controller threw on the first one and diagnostics mode came up
// with no handlers at all. Where a channel is registered is not the same question as
// whose channel it is, and this list answers the second.
const IPC_DIAGNOSTICS_ONLY = [
  'diagnostics-test-notification',
  'diagnostics-clear-sessions', 'diagnostics-export-sanitized', 'diagnostics-mark',
  'diagnostics-open-report', 'diagnostics-open-session-folder', 'diagnostics-start',
  'diagnostics-status', 'diagnostics-stop',
];

// The probe that measures the app attaches inside BOTH renderer preloads, so these two
// come from the windows being measured, never from the control panel.
const IPC_DIAGNOSTICS_PROBE = ['diagnostics-clock', 'diagnostics-record'];

const IPC_ROLES = {};
for (const channel of IPC_MAIN_ONLY) IPC_ROLES[channel] = ['main'];
for (const channel of IPC_MAIN_AND_VIEWER) IPC_ROLES[channel] = ['main', 'viewer'];
for (const channel of IPC_VIEWER_ONLY) IPC_ROLES[channel] = ['viewer'];
for (const channel of IPC_DIAGNOSTICS_ONLY) IPC_ROLES[channel] = ['diagnostics'];
for (const channel of IPC_DIAGNOSTICS_PROBE) IPC_ROLES[channel] = ['main', 'viewer'];

// DATA-006. While a move is rewriting every path in the library, nothing may change the
// library underneath it. The owner's decision (2026-09-09) is that the window explains
// this and the MAIN PROCESS enforces it: a modal cannot stop the tray, a second window
// or a hotkey, and a restart mid-move would drop a window-side guard entirely.
//
// Declared as data, at the same door as the authority table, so the refusal happens once
// instead of in twenty handlers — and so a new editing channel is one line here.
// test/media-move-freeze.test.js holds this list against the handlers that actually
// touch the pool, so a channel added without a thought about the move is a red test.
//
// Only EDITS are frozen. Wallpaper changes, the tray, browsing and the viewer keep
// working: they change nothing the move is rewriting, and stopping them would annoy the
// user for no safety at all.
const LIBRARY_EDIT_CHANNELS = new Set([
  'add-slot-folder', 'add-slot-images', 'add-slot-paths', 'clear-slot', 'cloud-add',
  'internet-add', 'library-add-folder', 'library-add-images', 'library-add-paths',
  'library-add-tag', 'library-assign', 'library-assign-record', 'library-assign-records',
  'library-delete-forever', 'library-ensure-sizes', 'library-materialize', 'library-refresh',
  'library-remove-many',
  'library-remove-tag', 'library-restore', 'library-toggle-favorite', 'library-undo-remove',
  'remove-slot-item', 'set-slideshow-to-path',
]);

// The shape a refused edit comes back as. Callers read different fields — `added`,
// `removed`, `restored` — and every one of them means "nothing happened" here.
function libraryEditFrozenResult() {
  return {
    config, error: 'media_move_running',
    added: 0, removed: 0, restored: 0, deleted: 0, hidden: 0, warning: null, undo: null,
  };
}

const ipcAuthority = ipcAuthorityMod.create({ ipcMain: electronIpcMain, roles: IPC_ROLES });
// Every `ipcMain.handle` below is that guarded door. The name is kept so the call sites read
// as they always did — and so the contract test keeps finding them where it expects.
const ipcMain = {
  handle: (channel, fn) => ipcAuthority.handle(channel, (event, ...args) => {
    if (mediaMoveRunning && LIBRARY_EDIT_CHANNELS.has(channel)) return libraryEditFrozenResult();
    return fn(event, ...args);
  }),
};

// SEC-002. One place that says what a window of ours is allowed to become. A renderer that
// can be navigated somewhere else, open a window of its own, or be granted a device
// permission is no longer the thing whose authority the table above describes.
// A window's role and the page it is allowed to be on are ONE fact, not two arguments
// that have to agree. Declared here so a call site cannot pair them wrongly: harden
// returns the file to load, so getting the role wrong loads the wrong window outright
// instead of quietly giving it somebody else's authority.
// SEC-002, slice 4. What a window of ours is allowed to be, decided once.
//
// All three windows ran with the Chromium sandbox OFF. Context isolation and a
// method-by-method bridge already stood between a page and Node, but the sandbox is the
// layer under that: it is what keeps a renderer that has been taken over from reaching
// the operating system directly, rather than only from reaching our bridge.
//
// It is on everywhere except the two app windows of a DIAGNOSTICS run, and for one
// concrete reason: a sandboxed preload may only require `electron` and a couple of
// built-ins, while the dev-only measuring probe is a separate file the preloads pull in
// with a relative require. Bundling it would need a build step this project does not
// have. Diagnostics is unpackaged-only and never ships - test/diagnostics-package-boundary
// proves that separately - so the exception costs nothing a user could ever run into.
// The diagnostics control panel is sandboxed regardless: its preload needs only electron.
function windowSecurity(role) {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: role === 'diagnostics' ? true : !DIAGNOSTICS_BOOTSTRAP.enabled,
  };
}

const WINDOW_PAGES = {
  main: () => path.join(__dirname, 'renderer', 'index.html'),
  viewer: () => path.join(__dirname, 'renderer', 'viewer.html'),
  diagnostics: () => path.join(__dirname, 'diagnostics', 'ui', 'control.html'),
};

function hardenWindow(win, role) {
  const page = WINDOW_PAGES[role];
  if (!page) throw new Error(`hardenWindow: unknown window role '${role}'`);
  const expectedFile = page();
  if (!win || win.isDestroyed()) return expectedFile;
  const expected = pathToFileURL(expectedFile).href;
  const contents = win.webContents;
  ipcAuthority.register(contents, role, expected);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (ipcAuthorityMod.baseUrl(url) === ipcAuthorityMod.baseUrl(expected)) return;
    event.preventDefault();
    console.error(`[Window] refused navigation of ${role} to ${url}`);
  });
  // Nothing in Znada needs a camera, a microphone, a location or notifications from
  // inside a page: notifications are raised by main. Refusing them all is not a
  // restriction on any feature, it is declining to hold a capability we never use.
  const session = contents.session;
  if (session && typeof session.setPermissionRequestHandler === 'function') {
    session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  }
  if (session && typeof session.setPermissionCheckHandler === 'function') {
    session.setPermissionCheckHandler(() => false);
  }
  contents.on('destroyed', () => ipcAuthority.forget(contents));
  return expectedFile;
}

ipcMain.handle('get-config', () => config);

// Главная спрашивает это при открытии и при возврате окна из трея; дальше состояние
// приходит само через 'next-change'.
ipcMain.handle('next-change-get', () => nextChangeState());

ipcMain.handle('get-version', () => app.getVersion());

// Event journal (plan error_notifications T3): entries carry i18n KEYS + params —
// the renderer localizes them, so the stored history survives a language switch.
ipcMain.handle('event-log-get', () => ({ entries: eventLog.list() }));
ipcMain.handle('event-log-clear', async () => { await eventLog.clear(); return { entries: [] }; });

// Znada Cloud capability (C2). Resolved once: staging is reachable ONLY from an
// unpackaged dev build with an explicit opt-in; all normal launches use production.
// The renderer receives only the safe subset — never the API URL or any token.
let _cloudCapability = null;
function cloudCapability() {
  if (!_cloudCapability) {
    _cloudCapability = cloudCapabilityMod.resolveCapability({
      isPackaged: app.isPackaged,
      // `npm run dev:cloud` sets this; trim guards the Windows `set VAR=x` trailing-space gotcha.
      stagingOptIn: (process.env.ZNADA_CLOUD || '').trim() === 'staging',
    });
  }
  return _cloudCapability;
}
ipcMain.handle('get-cloud-capability', () => cloudCapabilityMod.publicCapability(cloudCapability()));

// Znada Cloud catalog client (C3). Created lazily with the REAL fetch and the
// capability-decided apiBase — only when the environment is staging/production.
// In 'unavailable' there is no apiBase, so no client and no network ever happens.
let _cloudClient = null;
function cloudClient() {
  const base = cloudCapability().apiBase;
  if (!base) return null; // unavailable → no client, no requests
  if (!_cloudClient) _cloudClient = cloudClientMod.createClient({ baseUrl: base, anonId: config.anonId });
  return _cloudClient;
}

// ---- Znada Cloud session (C4) -------------------------------------------------
// The session token lives ONLY in main: encrypted at rest via safeStorage (DPAPI),
// never in config.json and never sent to the renderer. The renderer gets only the
// public profile + entitlements through cloudAuthState().
let _cloudToken = null;          // in-memory bearer token (never crosses IPC to renderer)
let _cloudUser = null;           // cached { user, entitlements } from /v1/me
let _cloudSessionRevision = 0;   // changes only when the bearer session itself changes
const cloudSessionPath = () => path.join(app.getPath('userData'), 'cloud-session.bin');
const defaultCloudSessionStorage = Object.freeze({
  existsSync: (...args) => fs.existsSync(...args),
  readFileSync: (...args) => fs.readFileSync(...args),
  mkdirSync: (...args) => fs.mkdirSync(...args),
  writeFileSync: (...args) => fs.writeFileSync(...args),
  renameSync: (...args) => fs.renameSync(...args),
  rmSync: (...args) => fs.rmSync(...args),
});
let cloudSessionStorage = defaultCloudSessionStorage;

function loadStoredToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const p = cloudSessionPath();
    if (!cloudSessionStorage.existsSync(p)) return null;
    return safeStorage.decryptString(cloudSessionStorage.readFileSync(p)) || null;
  } catch { return null; }
}
function saveStoredToken(token) {
  const p = cloudSessionPath();
  const temp = `${p}.tmp`;
  try {
    // A Cloud account is either durable as one token/profile pair or is not published.
    // Writing beside the target and renaming in the same directory keeps the previous
    // encrypted bearer intact across write/rename failures and process interruption.
    if (!safeStorage.isEncryptionAvailable()) return false;
    const encrypted = safeStorage.encryptString(token);
    cloudSessionStorage.mkdirSync(path.dirname(p), { recursive: true });
    cloudSessionStorage.writeFileSync(temp, encrypted);
    cloudSessionStorage.renameSync(temp, p);
    return true;
  } catch (err) {
    try { cloudSessionStorage.rmSync(temp, { force: true }); } catch {}
    console.error('cloud token save:', err);
    return false;
  }
}
function clearStoredToken() {
  try {
    cloudSessionStorage.rmSync(cloudSessionPath(), { force: true });
    return true;
  } catch (err) {
    console.error('cloud token clear:', err);
    return false;
  }
}

// Every async protected call carries the identity of the session whose bearer token it
// sent. Token text alone is not enough: a logout/sign-in cycle may eventually receive
// the same token again, while a late answer from the older cycle must still be inert.
function cloudSessionSnapshot() {
  return { token: _cloudToken, revision: _cloudSessionRevision };
}
function cloudSessionIsCurrent(session) {
  return !!session
    && session.revision === _cloudSessionRevision
    && session.token === _cloudToken;
}
function replaceCloudSession(token, user, { persist = false, broadcast = false } = {}) {
  const nextToken = token || null;
  let persisted = true;
  if (persist) {
    // The two directions are NOT symmetric, and treating them as one is what stranded
    // the account. Failing to WRITE a token means the sign-in would not survive a
    // restart, so refusing is honest. Failing to DELETE one — an antivirus holding the
    // file, a roaming profile, a locked disk — says nothing about whether the user is
    // still signed in, and refusing there left the app believing he was: every request
    // then failed, and signing out again failed the same way, with no way back short of
    // reinstalling. Forgetting the session in memory is what the user asked for, and it
    // always happens; the leftover file is reported, not obeyed.
    persisted = nextToken ? saveStoredToken(nextToken) : clearStoredToken();
    if (nextToken && !persisted) return false;
  }
  _cloudToken = nextToken;
  _cloudUser = _cloudToken && user ? user : null;
  _cloudSessionRevision++;
  if (broadcast) broadcastCloudSession();
  return true;
}

// Renderer-safe auth state (no token).
function cloudAuthState() {
  return {
    available: !!cloudCapability().apiBase,
    signedIn: !!_cloudToken && !!_cloudUser,
    user: _cloudUser ? _cloudUser.user : null,
    entitlements: _cloudUser ? _cloudUser.entitlements : [],
    // BUG-031. Whether a sign-in is running and whether it can still be called off. It
    // used to live only in the window that pressed Sign in, so a window created meanwhile
    // never learned it. Two booleans on purpose: nothing of the attempt itself - its
    // state, challenge or port - crosses to the renderer.
    signingIn: !!activeCloudSignin,
    signinCancellable: !!(activeCloudSignin && typeof activeCloudSignin.cancel === 'function'),
  };
}
function broadcastCloudSession() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cloud-session-changed', cloudAuthState());
}

// A protected call returned a normalized result. If it's a 401 for the SAME session
// that made the call, the session is dead: drop it everywhere and tell the renderer.
// A late 401 from an older bearer must not sign out the account that replaced it.
// Returns true if the result itself was an auth error, whether or not it was stale.
function cloudHandleAuthError(result, session) {
  if (result && result.ok === false && result.error && result.error.status === 401) {
    if (cloudSessionIsCurrent(session)) {
      replaceCloudSession(null, null, { persist: true, broadcast: true });
    }
    return true;
  }
  return false;
}

// Bring up a one-shot loopback listener, open the system browser at the Google start
// URL, and resolve with the one-time exchange code from the redirect (RFC 8252).
// SEC-002, slice 3. One sign-in at a time, and the listener belongs to it.
//
// Two presses used to mean two listeners, two browser tabs and two codes in flight, with
// no way to say which answer belonged to which attempt. Now a second press is refused
// until the first transaction finishes. Its loopback socket and five-minute browser timer
// end at redirect/cancel/timeout; the same single-flight then remains occupied for the
// separately bounded exchange and /me requests.
let activeCloudSignin = null;

function cancelCloudSignin() {
  if (!activeCloudSignin || typeof activeCloudSignin.cancel !== 'function') return false;
  return activeCloudSignin.cancel();
}

function runLoopbackSignin(challenge, state, attempt) {
  return new Promise((resolve, reject) => {
    let ourPort = 0;
    const server = http.createServer((req, res) => {
      // Not "does the URL carry a code": the request has to look like the browser coming
      // back to US, for THIS sign-in. See src/cloud/oauth.js for what that means.
      const parsed = cloudOauth.parseLoopbackRequest(req, { port: ourPort, state });
      res.writeHead(parsed.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loopbackHtml(parsed.ok));
      if (parsed.ok) { cleanup(); resolve(parsed.code); }
      else console.error(`[Cloud] refused a loopback request (${parsed.reason})`);
    });
    let done = false;
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 5 * 60 * 1000);
    function cleanup() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { server.close(); } catch {}
      attempt.cleanup = null;
      attempt.cancel = null;
    }
    attempt.cleanup = cleanup;
    attempt.cancel = () => {
      if (done) return false;
      cleanup();
      reject(new Error('cancelled'));
      return true;
    };
    server.on('error', (err) => { cleanup(); reject(err); });
    server.listen(0, '127.0.0.1', () => {
      ourPort = server.address().port;
      const url = cloudClientMod.buildGoogleStartUrl(cloudCapability().apiBase, { port: ourPort, challenge, state });
      Promise.resolve(shell.openExternal(url)).catch((err) => { cleanup(); reject(err); });
    });
  });
}

function loopbackHtml(okCode) {
  const msg = okCode ? 'Готово! Можете закрыть эту вкладку и вернуться в Znada.' : 'Код авторизации не получен. Вернитесь в Znada и попробуйте снова.';
  return `<!doctype html><meta charset="utf-8"><title>Znada</title><body style="font-family:Segoe UI,system-ui,sans-serif;background:#fafafa;color:#2e3436;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="margin:0 0 8px">Znada</h2><p>${msg}</p></div></body>`;
}

// Download a catalog image into the local Library — fetches a FRESH signed URL at
// click time (never a stale catalog thumb URL), then reuses the existing safe import.
// PERF-010: the grid and the viewer adding the same catalogue picture at once share one
// signed URL and one download.
ipcMain.handle('cloud-add', (e, item) => addsInFlight.run(
  item && item.id ? 'cloud:' + String(item.id) : '',
  () => cloudAddOnce(item),
));

async function cloudAddOnce(item) {
  const client = cloudClient();
  if (!client) return { config, error: 'unavailable' };
  if (!item || !item.id) return { config, error: 'badItem' };
  // DATA-006. Checked before the network call, not after: asking the catalogue for a
  // signed URL we cannot write anywhere is a request spent for nothing.
  if (!managedRootReady()) return { config, error: 'media_root_unavailable' };
  const session = cloudSessionSnapshot();
  let stagedArtifact = null;
  try {
    const dl = await client.getDownload(item.id, { token: session.token || undefined });
    if (!cloudSessionIsCurrent(session)) return { config, error: 'session_changed' };
    if (!dl.ok) { cloudHandleAuthError(dl, session); return { config, error: dl.error.code }; }
    stagedArtifact = await stageDownloadImage(wallpapersDir(), dl.data.url);
    if (!cloudSessionIsCurrent(session)) {
      discardDownloadArtifact(stagedArtifact, wallpapersDir());
      stagedArtifact = null;
      return { config, error: 'session_changed' };
    }
    // The download is slow and touches nothing shared; everything after it is inside
    // the lock, because a re-download lands on the same content-addressed file that a
    // "delete from disk" may be aiming at right now.
    return await withLibraryLock(async () => {
      if (!cloudSessionIsCurrent(session)) {
        discardDownloadArtifact(stagedArtifact, wallpapersDir());
        stagedArtifact = null;
        return { config, error: 'session_changed' };
      }
      const artifact = commitDownloadArtifact(stagedArtifact, wallpapersDir());
      stagedArtifact = null;
      const aspect = item.width > 0 && item.height > 0 ? item.width / item.height : 0;
      const id = addToPool('image', artifact.path, { aspect });
      const it = config.library[id];
      // Through updateItem, not straight onto the record: a field written directly
      // leaves the revision untouched, and an untouched revision loses the next merge.
      if (it) library.updateItem(config.library, it.id, { source: 'znada:' + item.id });
      saveConfig();
      return { config, id, error: null };
    });
  } catch (err) {
    console.error('cloud add:', err);
    return { config, error: 'download' };
  } finally {
    discardDownloadArtifact(stagedArtifact, wallpapersDir());
  }
}

// Current auth state (renderer-safe). If a stored token exists but the profile isn't
// loaded yet, validate it against /v1/me (a dead/expired token is dropped silently).
ipcMain.handle('cloud-session', async () => {
  const client = cloudClient();
  if (_cloudToken && !_cloudUser && client) {
    const session = cloudSessionSnapshot();
    const me = await client.getMe(session.token);
    if (me.ok) {
      if (cloudSessionIsCurrent(session)) _cloudUser = me.data;
    } else if (cloudHandleAuthError(me, session)) { /* current token cleared; stale answer ignored */ }
  }
  return cloudAuthState();
});

// Google sign-in: PKCE + loopback + system browser + exchange → store token, load /me.
async function runCloudSignin() {
  const client = cloudClient();
  if (!client) return { ok: false, error: 'unavailable' };
  // SEC-002. A second press while one is still going would open a second listener and a
  // second browser tab, and neither answer could be tied to the press that asked for it.
  if (activeCloudSignin) return { ok: false, error: 'busy' };
  const attempt = { cleanup: null, cancel: null };
  activeCloudSignin = attempt;
  try {
    const { verifier, challenge } = cloudOauth.generatePkce();
    // One per press. The backend stores it and hands it back on the redirect; anything
    // that comes to the listener without it is not this sign-in.
    const state = cloudOauth.generateState();
    const browserAnswer = runLoopbackSignin(challenge, state, attempt);
    // BUG-031. Every open window is told, not only the one that pressed the button. Sent
    // after runLoopbackSignin, which hands the attempt its cancel synchronously, so the
    // announcement already carries the way out.
    broadcastCloudSession();
    const code = await browserAnswer;
    // The listener is down and the exchange cannot be called back: windows drop the Cancel.
    broadcastCloudSession();
    const ex = await client.exchangeAuth({ code, pkce_verifier: verifier, client_label: `Znada on ${os.hostname()}` });
    if (!ex.ok) return { ok: false, error: ex.error.code };
    // Keep the exchange answer local until /me validates that exact bearer and returns
    // its authoritative profile. No failed validation may replace the previous live or
    // persisted session — including a definite 401 and a transient/server failure.
    const candidateToken = ex.data.session_token;
    const me = await client.getMe(candidateToken);
    if (!me.ok) return { ok: false, error: me.error.code };
    if (!replaceCloudSession(candidateToken, me.data, { persist: true, broadcast: true })) {
      return { ok: false, error: 'storage' };
    }
    return { ok: true };
  } catch (err) {
    // A sign-in the user called off is not a failure, and the window already has a
    // branch that stays silent for it — one that could never fire while every rejection
    // arrived here as 'signin_failed'.
    const text = String((err && err.message) || '');
    const msg = /timeout/.test(text) ? 'timeout'
      : /cancelled/.test(text) ? 'cancelled' : 'signin_failed';
    console.error('cloud signin:', err);
    return { ok: false, error: msg };
  } finally {
    // The socket is only the browser half. The single-flight covers the whole
    // transaction through exchange + /me, so another attempt cannot race its commit.
    if (attempt.cleanup) attempt.cleanup();
    if (activeCloudSignin === attempt) {
      activeCloudSignin = null;
      // Success, failure, cancel and timeout all end here, and so does telling the
      // windows that the sign-in is over.
      broadcastCloudSession();
    }
  }
}

ipcMain.handle('cloud-signin', async () => {
  const result = await runCloudSignin();
  // BUG-031. The state is read after the slot is released. Read inside the transaction it
  // still reported this sign-in as running, and the window that pressed the button
  // stores this reply after the announcement that the sign-in had ended.
  if (result.ok) result.state = cloudAuthState();
  return result;
});

// A sign-in nobody finished used to hold the window for the full five minutes: the strip
// said "Opening your browser…", drew no button, and the only cure was quitting — because
// before-quit was the sole production caller of cancelCloudSignin. The machinery was
// already here and already tested; what was missing was a door from the window.
//
// `cancelled` is the honest half. Past the redirect the listener is already down
// (runLoopbackSignin cleans up before it resolves) and the token exchange cannot be
// called back, so the window is told the difference rather than shown a control that
// silently does nothing.
ipcMain.handle('cloud-signin-cancel', () => {
  // Through cancelCloudSignin, never by nulling the slot: the SEC-002 single-flight
  // invariant depends on cleanup() closing the socket. After the redirect the socket
  // is already closed, so cancellation honestly says false while the transaction stays
  // busy until its bounded exchange/profile requests finish.
  return { ok: true, cancelled: cancelCloudSignin() };
});

// Sign out: revoke the session server-side (best effort) and drop the local token.
ipcMain.handle('cloud-signout', async () => {
  const client = cloudClient();
  const token = _cloudToken;
  // The session is forgotten whatever the disk does. Making the deletion the commit
  // point meant a file we could not remove — an antivirus holding it, a roaming profile
  // — kept the user signed in to an account he had just left, with every request failing
  // and a second attempt failing the same way.
  //
  // Revoking remotely is what makes a leftover file harmless: the token stops working on
  // the service, so finding it again after a restart signs nobody in. That is why the
  // revoke now happens even when the delete did not, rather than being skipped with it.
  replaceCloudSession(null, null, { persist: true, broadcast: true });
  if (client && token) { try { await client.logout(token); } catch {} }
  return { ok: true, error: null, state: cloudAuthState() };
});

// Cloud favorites (C5) — account-synced, distinct from the local Library favorites.
// All require a session; a 401 drops it. add/remove are idempotent on the backend.
ipcMain.handle('cloud-favorites', async () => {
  const client = cloudClient();
  if (!client) return { items: [], error: 'unavailable' };
  if (!_cloudToken) return { items: [], error: 'missing_token' };
  const session = cloudSessionSnapshot();
  const r = await client.getFavorites(session.token);
  if (!cloudSessionIsCurrent(session)) return { items: [], error: 'session_changed' };
  if (!r.ok) { cloudHandleAuthError(r, session); return { items: [], error: r.error.code }; }
  return { items: r.data.items, error: null };
});

ipcMain.handle('cloud-favorite', async (e, id, on) => {
  const client = cloudClient();
  if (!client) return { ok: false, error: 'unavailable' };
  if (!_cloudToken) return { ok: false, error: 'missing_token' };
  if (!id) return { ok: false, error: 'badItem' };
  const session = cloudSessionSnapshot();
  const r = on ? await client.addFavorite(id, session.token) : await client.removeFavorite(id, session.token);
  if (!cloudSessionIsCurrent(session)) return { ok: false, error: 'session_changed' };
  if (!r.ok) { cloudHandleAuthError(r, session); return { ok: false, error: r.error.code }; }
  return { ok: true, error: null };
});

ipcMain.handle('get-i18n', () => {
  const code = effectiveLang();
  return {
    setting: config.language || 'system',
    system: systemLangCode(),
    locale: code,
    dict: LOCALES[code] || LOCALES.en,
    fallback: LOCALES.en,
  };
});

ipcMain.handle('get-monitors', () => getMonitors());

ipcMain.handle('get-theme', () => currentThemeName());

ipcMain.handle('get-wallpaper-theme', () => wallpaperThemeName());

// BUG-022. `set-config` is the window's settings channel, and it is deny-by-default.
//
// It used to shallow-merge whatever object arrived straight into the live config, so
// every field was reachable through it — including the ones the window does not own.
// `library` and `libraryTrash` are the dangerous pair: settings are written with
// `skipLibrary`, which strips them out of config.json, so a patch that empties the pool
// in memory leaves no trace on disk until the NEXT pool write (a tag, a favourite, an
// assignment) makes the empty version the real one. The photos it named are orphans by
// then, and the collector is free to sweep them.
//
// The table below is therefore not "the fields we validate": it is the complete set of
// keys this channel can change at all, built from the actual `window.api.setConfig` call
// sites in renderer.js. Placement (`monitors`), the pool, the trash, the slideshow,
// autostart, the theme override, the anonymous install id and the hotkey each have their
// own channel or belong to main alone, so they are refused here — as is any key we do
// not recognise. Sender/frame authority is a separate boundary (SEC-002); this one is
// only about WHAT may change.
const REJECT_SETTING = Symbol('reject-setting');
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const asBool = (v) => (typeof v === 'boolean' ? v : REJECT_SETTING);
const asString = (v) => (typeof v === 'string' ? v : REJECT_SETTING);
const asOneOf = (...allowed) => (v) => (allowed.includes(v) ? v : REJECT_SETTING);
// The single value that is normalised rather than refused, because it always has been:
// this mode drives `autoSwitch` and the apply branch below, and the handler has coerced
// anything unexpected to 'system' since long before this boundary existed.
const asWallpaperMode = (v) => (['off', 'system', 'time', 'sun'].includes(v) ? v : 'system');
const asMinutes = (min, max) => (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.floor(n)) : REJECT_SETTING;
};

// A nested setting is MERGED into the value already held: the window spreads the object
// it has and changes one field, so a field it did not name keeps its current value
// rather than falling back to a default. An unknown field inside refuses the patch too.
function asMergedObject(fields) {
  return (value, current) => {
    if (!isPlainObject(value)) return REJECT_SETTING;
    const out = { ...(isPlainObject(current) ? current : {}) };
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) return REJECT_SETTING;
      const validated = fields[key](value[key], out[key]);
      if (validated === REJECT_SETTING) return REJECT_SETTING;
      out[key] = validated;
    }
    return out;
  };
}

const SETTINGS_FIELDS = {
  style: asOneOf('fill', 'fit', 'stretch', 'center', 'tile', 'span'),
  separateThemes: asBool,
  singleWallpaper: asBool,
  language: (v) => (v === 'system' || SUPPORTED_LANGS.includes(v) ? v : REJECT_SETTING),
  firstRunDone: asBool,
  telemetry: asBool,
  notifyOnFailure: asBool,
  gameModeBlock: asBool,
  librarySort: asOneOf('added', 'name', 'size', 'shuffle'),
  viewerBackground: asOneOf('ambient', 'charcoal', 'aurora', 'color'),
  onlineSort: asOneOf('date_added', 'toplist', 'random', 'views'),
  onlineSources: (value, current) => onlineSources.patch(value, current, providerRegistry.PROVIDERS) || REJECT_SETTING,
  libraryTagsExpanded: asBool,
  librarySidebarCollapsed: asBool,
  onlinePurity: asMergedObject({ sfw: asBool, sketchy: asBool, nsfw: asBool }),
  // DESIGN-002. The whole list at once, validated by the module the window also uses.
  onlineQuickFilters: (v) => (onlineQuickFilters.isValidPins(v) ? onlineQuickFilters.normalizePins(v) : REJECT_SETTING),
  // ONL-010. The target list is validated by the module that also matches against it —
  // a second spelling of "what a target is" is where the two would drift apart. A list
  // that normalizes to nothing is refused rather than silently stored as empty, which
  // would look like the filter had been switched off by itself.
  onlineSizeFilter: asMergedObject({
    enabled: asBool,
    mode: asOneOf('auto', 'manual'),
    targets: (v) => {
      if (!Array.isArray(v)) return REJECT_SETTING;
      const targets = sizeFilter.normalizeTargets(v);
      return targets.length === v.length ? targets : REJECT_SETTING;
    },
  }),
  // Times and coordinates stay plain strings, exactly as config.normalize() treats them:
  // a stored value the window spreads back must not become unchangeable because a
  // stricter pattern was introduced under it.
  themeSchedule: asMergedObject({
    mode: asOneOf('off', 'time', 'sun'),
    lightStart: asString, darkStart: asString, lat: asString, lng: asString,
  }),
  wallpaperSchedule: asMergedObject({
    mode: asWallpaperMode, lightStart: asString, darkStart: asString,
  }),
  triggers: asMergedObject({
    onStartup: asBool,
    onWakeup: asBool,
    stealth: asMergedObject({
      enabled: asBool, startup: asBool, wakeup: asBool, interval: asBool,
      timeoutMin: asMinutes(1, 60),
    }),
  }),
};

// Whole patch or nothing. Applying the allowed half of a mixed patch would make the
// refusal advisory and leave the caller unable to tell what actually happened.
function validateSettingsPatch(patch) {
  if (!isPlainObject(patch)) {
    throw new Error('E_SETTINGS_REJECTED: a settings patch must be an object');
  }
  const validated = {};
  for (const key of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_FIELDS, key)) {
      throw new Error(`E_SETTINGS_REJECTED: '${key}' is not a setting this channel owns`);
    }
    const value = SETTINGS_FIELDS[key](patch[key], config[key]);
    if (value === REJECT_SETTING) {
      throw new Error(`E_SETTINGS_REJECTED: '${key}' was sent a value it cannot hold`);
    }
    validated[key] = value;
  }
  return validated;
}

ipcMain.handle('set-config', async (e, patch) => {
  // Validation is complete before anything mutates: a refused patch performs no
  // assignment, no save, no broadcast and no apply, and rejects the IPC call instead of
  // quietly returning the unchanged config.
  const clean = validateSettingsPatch(patch);
  const previousConfig = config;
  const next = { ...config, ...clean };
  config = next;
  if (patch && patch.triggers && Object.prototype.hasOwnProperty.call(patch.triggers, 'stealth')) {
    const s = config.triggers && config.triggers.stealth;
    if (!s || s.enabled === false) cancelPendingStealth();
  }
  if (patch && 'wallpaperSchedule' in patch) {
    const sch = config.wallpaperSchedule && typeof config.wallpaperSchedule === 'object'
      ? config.wallpaperSchedule
      : {};
    config.wallpaperSchedule = {
      mode: 'system',
      lightStart: '07:00',
      darkStart: '20:00',
      ...sch,
    };
    if (!['off', 'system', 'time', 'sun'].includes(config.wallpaperSchedule.mode)) {
      config.wallpaperSchedule.mode = 'system';
    }
    if (typeof config.wallpaperSchedule.lightStart !== 'string') config.wallpaperSchedule.lightStart = '07:00';
    if (typeof config.wallpaperSchedule.darkStart !== 'string') config.wallpaperSchedule.darkStart = '20:00';
    config.autoSwitch = config.wallpaperSchedule.mode === 'system';
  }
  if (!saveSettingsOnly()) { // settings only: never touches the pool
    config = previousConfig;
    return config;
  }
  trayCtl.refresh();
  if (patch && 'themeSchedule' in patch) applyThemeSchedule();
  if (patch && 'viewerBackground' in patch && galleryWindow && !galleryWindow.isDestroyed()) {
    diagCountSend('gallery-background');
    galleryWindow.webContents.send('gallery-background', config.viewerBackground);
  }
  if (patch && 'separateThemes' in patch) {
    // переключили парадигму слотов → сразу применить обои из актуального слота (GNOME: без «Сохранить»)
    clearWallpaperTimer();
    if (config.slideshow.enabled) await tickSlideshow(false, true);
    else await applyForTheme(null, true);
    if (config.separateThemes !== false) await applyWallpaperSchedule(true, false);
  } else if (patch && 'wallpaperSchedule' in patch) {
    const mode = config.wallpaperSchedule.mode;
    if (mode === 'time' || mode === 'sun') {
      await applyWallpaperSchedule(true, true);
    } else {
      clearWallpaperTimer();
      if (mode === 'system') {
        if (config.slideshow.enabled) await tickSlideshow(false, true);
        else await applyForTheme(currentThemeName(), true);
      } else {
        broadcastWallpaperTheme(wallpaperThemeName());
      }
    }
  } else if (patch && 'themeSchedule' in patch && config.wallpaperSchedule && config.wallpaperSchedule.mode === 'sun') {
    // Coordinates are shared by both schedules; changing them re-evaluates sun mode.
    await applyWallpaperSchedule(true, true);
  }
  return config;
});

ipcMain.handle('set-hotkey', async (e, nextWallpaper) => {
  const next = {
    enabled: !!(nextWallpaper && nextWallpaper.enabled),
    shortcut: typeof (nextWallpaper && nextWallpaper.shortcut) === 'string'
      ? nextWallpaper.shortcut.trim()
      : '',
  };
  const staged = hotkeyCtl.prepare(next);
  if (!staged.ok) return { ok: false, error: staged.error, config };
  const previousHotkeys = config.hotkeys;
  config.hotkeys = { ...(config.hotkeys || {}), nextWallpaper: next };
  if (!saveSettingsOnly()) {
    config.hotkeys = previousHotkeys;
    staged.rollback();
    return { ok: false, error: 'storage', config };
  }
  staged.commit();
  return { ok: true, config };
});

ipcMain.handle('set-hotkey-recording', (e, recording) => {
  return hotkeyCtl.setSuspended(!!recording);
});

const IMG_FILTERS = [{ name: 'Images', extensions: mediaFormats.WALLPAPER_FORMATS.slice() }];

function ensureSlot(monitorId, which) {
  const theme = which === 'dark' ? 'dark' : 'light';
  if (!config.monitors[monitorId]) config.monitors[monitorId] = { light: { itemIds: [] }, dark: { itemIds: [] } };
  const m = config.monitors[monitorId];
  if (!m.light || !Array.isArray(m.light.itemIds)) m.light = { itemIds: [] };
  if (!m.dark || !Array.isArray(m.dark.itemIds)) m.dark = { itemIds: [] };
  return m[theme];
}

// Импорт картинки/папки в пул + назначение её в слот (вернёт true, если реально добавили).
function assignToSlot(slot, type, srcPath) {
  const id = addToPool(type, srcPath);
  if (!id) return false;
  if (slot.itemIds.includes(id)) return false; // уже в этом слоте
  slot.itemIds.push(id);
  library.clearSlotExplicitEmpty(slot);
  return true;
}

// Удалить элемент из пула И из всех слотов, которые на него ссылаются (без висячих id).
function removeFromLibrary(id) {
  const item = library.getItem(config.library, id);
  if (!library.removeItem(config.library, id)) return false;
  for (const [monitorId, m] of Object.entries(config.monitors || {})) {
    for (const th of ['light', 'dark']) {
      if (m[th] && Array.isArray(m[th].itemIds)) {
        const before = m[th].itemIds.length;
        m[th].itemIds = m[th].itemIds.filter((x) => x !== id);
        if (before > 0 && m[th].itemIds.length === 0) {
          library.markSlotExplicitEmpty(m[th]);
          storeSlideshowPosition(monitorId, th, { index: 0, path: '' });
        }
      }
    }
  }
  if (item && item.type === 'folder') forgetLiveFolder(id);
  if (item && item.type === 'folder') syncLiveFolderWatchers();
  return true;
}

// add one or more local photos to a monitor's playlist (multi-select dialog)
ipcMain.handle('add-slot-images', async (e, monitorId, which) => {
  if (!monitorId) return { config, added: 0 };
  const res = await dialog.showOpenDialog(mainWindow, {
    // design.addPhotos was dropped from the dictionaries long ago, so tMain fell back to
    // echoing the key itself as the dialog title. The library wording is identical and
    // translated everywhere, so both entry points share it.
    title: tMain('library.addPhotos'),
    properties: ['openFile', 'multiSelections'],
    filters: IMG_FILTERS,
  });
  if (res.canceled || !res.filePaths.length) return { config, added: 0 };
  for (const chosen of res.filePaths) grantMediaPath(chosen);
  // Making a photo active has to be ordered against deleting files, like every other
  // route into the pool — this one is on the Design page and was outside the lock.
  return withLibraryLock(async () => {
    const slot = ensureSlot(monitorId, which);
    let added = 0;
    for (const src of res.filePaths) {
      try {
        const stored = await importWallpaper(src);
        if (assignToSlot(slot, 'image', stored)) added++;
      } catch (err) { console.error('Не удалось импортировать обои:', err); }
    }
    saveConfig();
    trayCtl.refresh();
    return { config, added };
  });
});

// add a local folder as a source (scanned live, not copied)
ipcMain.handle('add-slot-folder', async (e, monitorId, which) => {
  if (!monitorId) return { config, added: 0 };
  const res = await dialog.showOpenDialog(mainWindow, {
    title: tMain('library.addFolder'), // see add-slot-images: design.* keys no longer exist
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { config, added: 0 };
  const dir = grantMediaPath(res.filePaths[0], { root: true });
  return withLibraryLock(async () => {
    const slot = ensureSlot(monitorId, which);
    assignToSlot(slot, 'folder', dir);
    saveConfig();
    syncLiveFolderWatchers();
    requestLiveFolderRefresh([library.idFor(dir)]);
    return { config, added: 1 };
  });
});

// add multiple dropped file paths (files or folders) to a monitor's playlist
ipcMain.handle('add-slot-paths', async (e, monitorId, which, paths) => withLibraryLock(async () => {
  if (!monitorId || !Array.isArray(paths)) return { config, added: 0 };
  const slot = ensureSlot(monitorId, which);
  let added = 0;
  const revivalsBefore = poolRevivals;
  const folderIds = [];
  for (const src of paths) {
    try {
      if (!itemDetails.isValidAbsolutePath(src)) continue;
      const stats = fs.statSync(src);
      if (stats.isDirectory()) {
        if (assignToSlot(slot, 'folder', src)) added++;
        // The grant follows the POOL, not the slot, and it is issued only once the pool
        // actually holds the folder. `assignToSlot` answers false for two different
        // things — the pool refused it, or this slot already had it — and reading that
        // as "accepted" handed out recursive read authority over a directory the app had
        // just declined. Asking the pool directly tells the two apart: a folder already
        // in the slot is legitimately ours and stays readable.
        const folderId = library.idFor(src);
        if (library.getItem(config.library, folderId)) {
          grantMediaPath(src, { root: true });
          folderIds.push(folderId);
        }
      } else if (stats.isFile()) {
        const ext = path.extname(src).toLowerCase();
        if (playlist.IMG_EXTS.has(ext)) {
          const stored = await importWallpaper(src);
          if (assignToSlot(slot, 'image', stored)) added++;
          // importWallpaper completing proves the supported file was actually readable.
          // Rejected extensions and failed imports must not leave read authority behind.
          grantMediaPath(src);
        }
      }
    } catch (err) {
      console.error('Failed to import drag-dropped path:', src, err);
    }
  }
  // Also when nothing new was added: dropping a photo that is already here clears the
  // removed-marker still on it, and that repair has to reach the disk or the photo is
  // removed again after the next restart.
  if (added > 0 || poolRevivals !== revivalsBefore) {
    saveConfig();
    trayCtl.refresh();
  }
  if (folderIds.length) syncLiveFolderWatchers();
  if (folderIds.length) requestLiveFolderRefresh(folderIds);
  return { config, added };
}));

ipcMain.handle('remove-slot-item', (e, monitorId, which, index) => {
  if (!monitorId) return config;
  const theme = which === 'dark' ? 'dark' : 'light';
  const slot = ensureSlot(monitorId, which);
  if (index >= 0 && index < slot.itemIds.length) {
    slot.itemIds.splice(index, 1);
    if (slot.itemIds.length === 0) {
      library.markSlotExplicitEmpty(slot);
      storeSlideshowPosition(monitorId, theme, { index: 0, path: '' });
    }
  }
  saveSettingsOnly();  // slot membership only; the pool is untouched
  gcWallpapers();
  trayCtl.refresh();
  return config;
});

ipcMain.handle('clear-slot', (e, monitorId, which) => {
  if (!monitorId) return config;
  const theme = which === 'dark' ? 'dark' : 'light';
  const slot = ensureSlot(monitorId, which);
  slot.itemIds = [];
  library.markSlotExplicitEmpty(slot);
  storeSlideshowPosition(monitorId, theme, { index: 0, path: '' });
  saveSettingsOnly();  // slot membership only; the pool is untouched
  gcWallpapers();
  return config;
});

// ---- Библиотека (пул контента, независимый от назначения на мониторы) ----

// Добавить выбранные фото в пул (диалог мультивыбора), БЕЗ привязки к слоту.
ipcMain.handle('library-add-images', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: tMain('library.addPhotos'),
    properties: ['openFile', 'multiSelections'],
    filters: IMG_FILTERS,
  });
  if (res.canceled || !res.filePaths.length) return { config, added: 0 };
  for (const chosen of res.filePaths) grantMediaPath(chosen);
  return withLibraryLock(async () => {
    const before = Object.keys(config.library).length;
    const revivalsBefore = poolRevivals;
    for (const src of res.filePaths) {
      try { addToPool('image', await importWallpaper(src)); }
      catch (err) { console.error('library: не удалось импортировать', src, err); }
    }
    const added = Object.keys(config.library).length - before;
    // Re-adding a photo that is already in the pool adds no row, but it DOES clear the
    // removed-marker or trash entry that was still on it — and that repair has to be
    // written down, or the photo is removed again after the next restart.
    if (added || poolRevivals !== revivalsBefore) saveConfig();
    return { config, added };
  });
});

// Добавить папку-источник в пул (живое сканирование, файлы не копируем).
// ---------------------------------------------------------------------------
// DATA-006 step 3: the window's side of the move
// ---------------------------------------------------------------------------
// The window asks four things — where are we now, where would you like to put it, what
// would that involve, and go — plus a way to stop. Nothing here decides anything: the
// answers come from the same functions the move itself uses, so the number the user is
// shown and the number the move works from cannot drift apart.
let mediaMoveStopRequested = false;

function mediaFolderState() {
  const status = managedRootStatus();
  return {
    folder: (config && config.mediaFolder) || '',
    root: wallpapersDir(),
    custom: managedRoot.custom,
    state: status.state,
    reason: status.reason,
    moving: mediaMoveRunning,
  };
}

function broadcastMediaMove(progress) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media-move-progress', progress);
}

ipcMain.handle('media-folder-state', () => mediaFolderState());

ipcMain.handle('media-folder-pick', async () => {
  if (mediaMoveRunning) return { folder: '', error: 'media_move_running' };
  const res = await dialog.showOpenDialog(mainWindow, {
    title: tMain('mediaFolder.pickTitle'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { folder: '', canceled: true };
  return { folder: res.filePaths[0], canceled: false };
});

// The window names a target one of two ways: a folder the user picked (a string), or
// `{ appFolder: true }` for the way back to the app's own folder. Anything else is a
// folder that failed to normalize, and the rules then refuse it as not a folder at all.
function mediaMoveTarget(raw) {
  if (raw && typeof raw === 'object' && raw.appFolder === true) return { folder: '', toAppFolder: true };
  return { folder: mediaRoot.normalizeFolder(typeof raw === 'string' ? raw : ''), toAppFolder: false };
}

// What the user is asked to agree to: how much, where to, and whether anything stands in
// the way. Read-only: nothing moves before the person has seen this and agreed.
ipcMain.handle('media-folder-plan', (e, rawTarget) => {
  const { folder, toAppFolder } = mediaMoveTarget(rawTarget);
  const blockers = mediaMoveBlockers(folder, { toAppFolder });
  if (blockers.length) return { ok: false, blockers };
  const target = mediaRoot.resolveManagedRoot({ userDataPath: USER_DATA_PATH, mediaFolder: folder });
  const plan = mediaMove.planMove({
    from: wallpapersDir(), fromAnchor: managedRoot.anchor, to: target.root, anchor: target.anchor,
  });
  return {
    ok: !plan.blockers.length,
    folder,
    toAppFolder,
    from: plan.from,
    to: plan.to,
    count: plan.count,
    // The sweeper's own `.trash` travels too, so nothing restorable stays behind. It is
    // not the library's trash, and a count many times the visible library needs saying so.
    trashCount: plan.files.filter((file) => file.relative.split(/[\\/]/)[0] === '.trash').length,
    bytes: plan.bytes,
    free: plan.free,
    blockers: plan.blockers,
  };
});

ipcMain.handle('media-folder-move', async (e, rawTarget) => {
  const { folder, toAppFolder } = mediaMoveTarget(rawTarget);
  if (!folder && !toAppFolder) return { status: 'blocked', blockers: [{ code: mediaRoot.PROBLEMS.RELATIVE }] };
  mediaMoveStopRequested = false;
  const report = await moveManagedFolder(folder, {
    toAppFolder,
    onProgress: (progress) => broadcastMediaMove({ ...progress, folder }),
    shouldStop: () => mediaMoveStopRequested,
  });
  // The window has the result as the answer to this call; the broadcast is for any other
  // window that was watching the progress and has to stop watching.
  broadcastMediaMove({ phase: 'finished', folder, status: report.status });
  return {
    status: report.status,
    blockers: report.blockers || [],
    copied: report.copied || 0,
    alreadyThere: report.alreadyThere || 0,
    removed: report.removed || 0,
    bytes: (report.plan && report.plan.bytes) || 0,
    // An error object does not survive IPC in a useful shape, and its message can carry
    // a path. The window gets a short reason; the console keeps the detail.
    error: report.error ? String(report.error.message || report.error).slice(0, 200) : '',
    folder: mediaFolderState(),
  };
});

ipcMain.handle('media-folder-stop', () => {
  // Stopping is free before the library is written and impossible after it; the move
  // itself decides which side of that line it is on.
  mediaMoveStopRequested = true;
  return { ok: true, moving: mediaMoveRunning };
});

ipcMain.handle('library-add-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: tMain('library.addFolder'),
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { config, added: 0 };
  return withLibraryLock(async () => {
    const before = Object.keys(config.library).length;
    const revivalsBefore = poolRevivals;
    const id = addToPool('folder', grantMediaPath(res.filePaths[0], { root: true }));
    const added = Object.keys(config.library).length - before;
    if (added || poolRevivals !== revivalsBefore) saveConfig();
    if (id) syncLiveFolderWatchers();
    if (id) requestLiveFolderRefresh([id]);
    return { config, added };
  });
});

// Добавить перетащенные пути (файлы/папки) в пул.
ipcMain.handle('library-add-paths', async (e, paths) => withLibraryLock(async () => {
  if (!Array.isArray(paths)) return { config, added: 0 };
  // SEC-002. Drag-and-drop: the path is asserted by the window, because Electron resolves
  // a dropped File in the renderer and main has no way to confirm it. Adding is a visible
  // act - a card appears - which is what keeps this from being a silent read of anything
  // on the disk. Main grants only paths it has validated and successfully accepted below;
  // a missing or unsupported renderer-supplied path must never acquire read authority.
  const before = Object.keys(config.library).length;
  const revivalsBefore = poolRevivals;
  const folderIds = [];
  for (const src of paths) {
    try {
      if (!itemDetails.isValidAbsolutePath(src)) continue;
      const stats = fs.statSync(src);
      if (stats.isDirectory()) {
        const id = addToPool('folder', src);
        if (id) {
          grantMediaPath(src, { root: true });
          folderIds.push(id);
        }
      } else if (stats.isFile() && playlist.IMG_EXTS.has(path.extname(src).toLowerCase())) {
        const stored = await importWallpaper(src);
        if (addToPool('image', stored)) grantMediaPath(src);
      }
    } catch (err) { console.error('library: drop import failed', src, err); }
  }
  const added = Object.keys(config.library).length - before;
  if (added || poolRevivals !== revivalsBefore) saveConfig();
  if (folderIds.length) syncLiveFolderWatchers();
  if (folderIds.length) requestLiveFolderRefresh(folderIds);
  return { config, added };
}));

// LIB-004: "remove from library" means the same thing for every card — stop showing
// this photo in Znada. Where it came from (added one by one, pulled in with a
// folder, downloaded) is storage plumbing and must not decide what the user may do.
// A photo backed by a watched folder is marked removed in the folder index; a photo
// with its own pool record loses that record. Files on disk are NEVER deleted:
// Znada's own copies go to wallpapers/.trash through the existing GC.
//
// Input is a list of { path, id? } records — the renderer knows the path of every
// card it draws, whereas only some cards have a pool id.
// LIB-012. Подтверждение спрашивает не обработчик по своему усмотрению, а ПОВЕРХНОСТЬ:
// решение владельца 2026-09-03 — спрашивать там, где пункт легко спутать с соседним, и
// только там. Поэтому признак приходит снаружи, а массовая кнопка, онлайн-карточка и
// просмотрщик остаются как были.
//
// Диалог показывается ДО блокировки библиотеки. Он живёт ровно столько, сколько человек
// думает, и блокировка на это время остановила бы все остальные операции; «Удалить с
// диска» по той же причине спрашивает снаружи блокировки.
//
// Убрать из библиотеки обратимо — запись уходит в корзину, — поэтому вопрос задаётся
// как вопрос, а не предупреждение, и по умолчанию выбрана отмена.
async function confirmLibraryRemoval(rawRecords, rawOptions) {
  if (!rawOptions || rawOptions.confirm !== true) return null;
  const names = [];
  for (const raw of Array.isArray(rawRecords) ? rawRecords : []) {
    const rec = typeof raw === 'string' ? { id: raw, path: '' } : (raw || {});
    const id = typeof rec.id === 'string' && rec.id ? rec.id : '';
    const item = id ? library.getItem(config.library, id) : null;
    const full = (typeof rec.path === 'string' && rec.path) || (item && item.path) || '';
    if (full) names.push(path.basename(full));
  }
  // Называть нечего — пусть обработчик сам ответит на пустой запрос, как отвечал всегда.
  if (!names.length) return null;

  const shown = names.slice(0, 10);
  const more = names.length - shown.length;
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: [tMain('library.removeConfirmYes'), tMain('library.removeConfirmCancel')],
    defaultId: 1,
    cancelId: 1,
    title: tMain('library.removeConfirmTitle'),
    // tMain() не умеет подстановку, как и у «Удалить с диска» — число подставляется здесь.
    message: tMain('library.removeConfirmMessage').replace('{n}', String(names.length)),
    detail: [...shown, ...(more > 0 ? [`… +${more}`] : []), '', tMain('library.removeConfirmDetail')].join('\n'),
    noLink: true,
  });
  if (answer.response === 0) return null;
  // Отказ не должен отличаться от «ничего не делали»: ни записи, ни отмены, ни тоста.
  return { config, affected: 0, removed: 0, hidden: 0, error: null, cancelled: true, warning: null, undo: null };
}

ipcMain.handle('library-remove-many', async (e, rawRecords, rawOptions) => {
  const declined = await confirmLibraryRemoval(rawRecords, rawOptions);
  if (declined) return declined;
  return withLibraryLock(async () => {
  if (!Array.isArray(rawRecords) || !rawRecords.length || rawRecords.length > 50000) {
    return { config, removed: 0, hidden: 0, error: 'bad_request', warning: null, undo: null };
  }

  const records = [];
  const seen = new Set();
  for (const raw of rawRecords) {
    const rec = typeof raw === 'string' ? { id: raw, path: '' } : (raw || {});
    const id = typeof rec.id === 'string' && rec.id ? rec.id : '';
    const p = typeof rec.path === 'string' ? rec.path : '';
    const item = id ? library.getItem(config.library, id) : null;
    const filePath = p || (item && item.path) || '';
    const type = (item && item.type) || (rec.type === 'folder' ? 'folder' : 'image');
    const key = `${id}|${pathKey(filePath)}`;
    if ((!id && !filePath) || seen.has(key)) continue;
    seen.add(key);
    records.push({ id: item ? id : '', path: filePath, item, type });
  }
  if (!records.length) return { config, removed: 0, hidden: 0, error: 'bad_request', warning: null, undo: null };

  // Removing a folder removes what is inside it — including the photos in there that
  // earned a pool record of their own (a star, a tag or an assignment creates one).
  //
  // This closure is computed FIRST, before anything is snapshotted or deleted. It used
  // to run at the very end, after the pool and the slots had already been rewritten,
  // which meant the descendants were found and then nothing was done with them: they
  // stayed in the pool and in their slots. Inside an ordinary subfolder the hidden
  // marker covered that up; remove a watched ROOT and its index is forgotten too, so
  // the photos came straight back on screen and into the rotation.
  const removedDirKeys = records
    .filter((r) => r.type === 'folder')
    .map((r) => pathKey(r.path))
    .filter(Boolean);
  const underRemovedDir = (p) => removedDirKeys.some((dir) => library.isUnderPath(p, dir));
  const descendants = [];
  if (removedDirKeys.length) {
    const named = new Set(records.map((r) => r.id).filter(Boolean));
    for (const it of Object.values(config.library)) {
      // Both kinds. Limiting this to images left a subfolder that had earned its own
      // record — a star, a tag or an assignment creates one — sitting in the library and
      // on a monitor after its parent was removed, still serving the photos inside it.
      if (!it || !it.path || named.has(it.id)) continue;
      if (it.type !== 'image' && it.type !== 'folder') continue;
      if (underRemovedDir(it.path)) descendants.push(it);
    }
  }

  // Snapshot enough to put everything back if the user immediately undoes. Slot
  // membership is part of that: removal empties slots, and an undo that restored the
  // pool record but not its placement would quietly change which wallpapers rotate.
  const undo = { items: [], slots: [], paths: [], dirs: [], at: Date.now() };
  const removedIds = new Set();
  for (const rec of records) {
    if (!rec.item) continue;
    undo.items.push(JSON.parse(JSON.stringify(rec.item)));
    removedIds.add(rec.id);
  }
  for (const it of descendants) {
    undo.items.push(JSON.parse(JSON.stringify(it)));
    removedIds.add(it.id);
  }
  for (const [monitorId, monitor] of Object.entries(config.monitors || {})) {
    for (const theme of ['light', 'dark']) {
      const slot = monitor[theme];
      if (!slot || !Array.isArray(slot.itemIds)) continue;
      if (!slot.itemIds.some((id) => removedIds.has(id))) continue;
      undo.slots.push({ monitorId, theme, itemIds: slot.itemIds.slice(), emptied: false });
    }
  }

  // LIB-006: keep the whole record — tags, star, author, source — for every photo whose
  // record is being taken away, so putting it back means getting it back, not typing it
  // in again. Where the file lives decides nothing here; the record is the record.
  //
  // This used to be limited to photos Znada had copied for itself, on the reasoning
  // that only they needed protecting from the orphan sweep. But the file and the record
  // are two different things: a starred, tagged photo inside a watched folder kept its
  // FILE and lost its RECORD, so restoring the folder brought back a blank photo. (The
  // orphan sweep only ever looks inside wallpapers/, so keeping other paths in this list
  // costs nothing.)
  if (!Array.isArray(config.libraryTrash)) config.libraryTrash = [];
  const now = Date.now();
  // One id for this whole removal. The trash is bounded, and the bound applies to whole
  // removals: without this, removing a folder of 520 photos kept 500 of their records
  // and lost the stars and tags of the rest with nothing on screen saying so.
  const removalGroup = `${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  // The main window replaces its one toast when another removal happens, but the
  // fullscreen viewer is a separate document and can still show the older action.
  // Carry the group as an opaque token so that stale Undo can never restore a newer,
  // unrelated removal.
  undo.token = removalGroup;
  // Each entry records WHY it went: named by the user, or carried along by a folder.
  // Putting a folder back may only undo the second kind.
  //
  // The NEAREST removed folder, not the first one that happens to contain the path.
  // Removing a folder and one of its own subfolders in a single action wrote the outer
  // one here, so restoring the subfolder alone brought nothing back with it.
  const removalReason = (item) => {
    let best = '';
    for (const dir of removedDirKeys) {
      if (!library.isUnderPath(item.path, dir)) continue;
      if (dir.length > best.length) best = dir;
    }
    return best;
  };
  // Where each record was placed, so a restore after a restart can put it back on the
  // same monitor and theme rather than only into the library.
  const placementsFor = (id) => {
    const out = [];
    for (const snap of undo.slots) {
      const index = snap.itemIds.indexOf(id);
      if (index < 0) continue;
      out.push({ monitorId: snap.monitorId, theme: snap.theme, index, emptied: false });
    }
    return out;
  };
  // LIB-009. Вытеснение переживает эту функцию: запись, выпавшая из корзины, теряет защиту
  // от сборщика обоев, и вернуть её одним нажатием уже нельзя. Раньше об этом знала только
  // консоль разработчика, поэтому счёт копится здесь и уходит в ответ вместе с остальным.
  let evicted = 0;
  // Descendants of a removed folder are covered by the same rule.
  for (const rec of [...records.map((r) => ({ ...r, named: true })),
    ...descendants.map((item) => ({ item, named: false }))]) {
    // Folders are kept too. Skipping them meant a subfolder that had earned a record —
    // a star, tags, a place on a monitor — lost all of it the moment its parent went,
    // and the only way back was the toast, which does not survive a restart.
    if (!rec.item || (rec.item.type !== 'image' && rec.item.type !== 'folder')) continue;
    // Bounded here, not only on save: the trash is what holds GC off these files, so
    // a list that is longer in memory than on disk would quietly drop protection for
    // the oldest entry at the next start.
    const pushed = libraryStore.pushEntry(config.libraryTrash, {
      item: JSON.parse(JSON.stringify(rec.item)),
      // DATA-005. The tombstone has to be NEWER than the record it buries, or a merge
      // cannot tell "deleted after the last edit" from "edited after the deletion" —
      // and gets it wrong in the direction that brings the photo back.
      rev: library.revOf(rec.item) + 1,
      removedAt: now,
      via: rec.named ? '' : removalReason(rec.item),
      group: removalGroup,
      slots: placementsFor(rec.item.id),
    });
    config.libraryTrash = pushed.trash;
    if (pushed.evicted.length) {
      evicted += pushed.evicted.length;
      console.log(`library trash full: ${pushed.evicted.length} oldest entr(y/ies) released to the orphan sweep`);
    }
  }

  // The pre-library fallback still applies a bare path, and migrateConfig would pull
  // it back into the pool on the next start — so a removed photo could reappear and
  // keep being used. Clear it here, keeping the explicit-empty semantics intact.
  const removedPaths = new Set(records.map((r) => pathKey(r.path)).filter(Boolean));
  for (const key of ['lightWallpaper', 'darkWallpaper']) {
    if (!config[key]) continue;
    // Either named directly, or sitting inside a folder that was just removed.
    if (!removedPaths.has(pathKey(config[key])) && !underRemovedDir(config[key])) continue;
    undo.legacy = undo.legacy || {};
    undo.legacy[key] = config[key];
    config[key] = '';
  }

  for (const id of removedIds) library.removeItem(config.library, id);
  const emptiedSlots = new Set();
  for (const [monitorId, monitor] of Object.entries(config.monitors || {})) {
    for (const theme of ['light', 'dark']) {
      const slot = monitor[theme];
      if (!slot || !Array.isArray(slot.itemIds)) continue;
      const before = slot.itemIds.length;
      slot.itemIds = slot.itemIds.filter((id) => !removedIds.has(id));
      if (before > 0 && slot.itemIds.length === 0) {
        library.markSlotExplicitEmpty(slot);
        storeSlideshowPosition(monitorId, theme, { index: 0, path: '' });
        const snap = undo.slots.find((sl) => sl.monitorId === monitorId && sl.theme === theme);
        if (snap) snap.emptied = true;
        emptiedSlots.add(`${monitorId}|${theme}`);
      }
    }
  }
  // Which slots this removal left empty is only known after the slots have been
  // rewritten, but the kept records were written before that. A restore has to lift the
  // "deliberately empty" marker it set, or the monitor would keep playing nothing with
  // its wallpaper sitting right there in the library again.
  if (emptiedSlots.size) {
    for (const entry of config.libraryTrash) {
      if (!entry || entry.group !== removalGroup || !Array.isArray(entry.slots)) continue;
      for (const slot of entry.slots) {
        if (emptiedSlots.has(`${slot.monitorId}|${slot.theme}`)) slot.emptied = true;
      }
    }
  }

  // Photos still reachable through a watched folder would simply come back on the
  // next scan, so they are marked removed in the index instead.
  const hiddenResult = folderState.setHidden(
    liveFolderState,
    records.filter((r) => r.type !== 'folder').map((r) => r.path).filter(Boolean),
    true,
  );
  liveFolderState = hiddenResult.state;
  invalidateHiddenPaths();
  undo.paths = hiddenResult.matched;

  // LIB-008: a subfolder the user merely navigated into has no record of its own, so
  // it is removed by path prefix. That also covers photos dropped into it later —
  // hiding the files it holds today would let the folder come back one photo at a time.
  // Every removed folder, including one that had earned a pool record of its own
  // (a star, a tag, an assignment all create one). Its photos are indexed under the
  // watched ROOT as well, so dropping the record alone left them on screen while the
  // message claimed they were removed. The watched root itself is unaffected:
  // setHiddenDir resolves it to an empty relative path and skips it, and removing a
  // root is still done by dropping its record.
  const dirResult = folderState.setHiddenDir(
    liveFolderState,
    records.filter((r) => r.type === 'folder').map((r) => r.path).filter(Boolean),
    true,
  );
  liveFolderState = dirResult.state;
  invalidateHiddenPaths();
  undo.dirs = dirResult.matched;
  if (dirResult.changed) { folderStateDirty = true; flushLiveFolderState(); }
  // Written at once rather than on the usual 5s debounce: this is a deliberate user
  // action, and a crash in that window would silently bring the photos back.
  if (hiddenResult.changed) { folderStateDirty = true; flushLiveFolderState(); }

  // (The photos inside a removed folder that had their own pool record were collected
  // BEFORE any of the above and went through the same removal — see `descendants`.)

  // Including the subfolders that came with the parent: leaving their watcher running
  // would keep re-discovering the files of a folder the user has removed.
  const removedFolders = [...records.filter((r) => r.item && r.item.type === 'folder').map((r) => r.id),
    ...descendants.filter((it) => it.type === 'folder').map((it) => it.id)];
  if (removedFolders.length) { forgetLiveFolders(removedFolders); syncLiveFolderWatchers(); }

  saveConfig();
  gcWallpapers();
  trayCtl.refresh();
  lastLibraryRemoval = (undo.items.length || undo.paths.length || undo.dirs.length) ? undo : null;

  let warning = null;
  try { await applyForTheme(null, true); }
  catch (err) {
    warning = 'apply_failed';
    console.error('bulk library removal apply failed:', err);
  }
  // What the user is told must be counted in CARDS, not in bookkeeping rows. A photo
  // that is both a library record and a file inside a watched folder touches two
  // rows, and one reachable through two overlapping folders touches two more — the
  // old sum said "2" for a single removed photo.
  const changedPaths = new Set(
    [...hiddenResult.matched, ...dirResult.matched].map(pathKey),
  );
  const affected = records.filter((rec) => (
    (rec.id && removedIds.has(rec.id)) || changedPaths.has(pathKey(rec.path))
  )).length;

  // A hide is invisible to the main window's grid, and only another window's removal
  // needs telling — the main window updates itself as part of its own removal, and
  // repeating it there would rebuild the grid twice and lose the scroll position.
  const hiddenNow = hiddenResult.updated + dirResult.updated;
  if (hiddenNow > 0 && ipcAuthority.roleOf(e) !== 'main') notifyLibraryViewStale('remove');

  return {
    config,
    affected,
    removed: undo.items.length,
    evicted,
    hidden: hiddenResult.updated + dirResult.updated,
    error: null,
    warning,
    undo: lastLibraryRemoval ? { count: records.length, token: lastLibraryRemoval.token } : null,
  };
  });
});

// Put back exactly what the last removal took away. Only the most recent removal is
// kept — this backs the "Undo" in the toast, not a full history.
ipcMain.handle('library-undo-remove', async (e, expectedToken) => withLibraryLock(async () => {
  const undo = lastLibraryRemoval;
  if (!undo) return { config, restored: 0, error: 'nothing_to_undo' };
  if (expectedToken && undo.token !== expectedToken) {
    return { config, restored: 0, error: 'stale_undo' };
  }

  const undoRestoredIds = new Set();
  const failedItems = [];
  for (const item of undo.items) {
    if (!item || !item.id) continue;
    // If Znada's own copy could not be brought back, do NOT add a record pointing at
    // a file that is not there and do NOT drop the recovery entry — that entry is the
    // only remaining way back.
    if (isOwnWallpaperCopy(item.path) && !restoreOwnCopyFile(item)) {
      console.error('undo: копия не восстановлена, запись корзины сохранена:', item.path);
      failedItems.push(item);
      continue;
    }
    const activeItem = config.library[item.id] || item;
    markRecordRevived(activeItem);
    if (!config.library[item.id]) config.library[item.id] = activeItem;
    undoRestoredIds.add(item.id);
    dropFromLibraryTrash(item.id);
  }
  // Put back only the ids this removal took out, in their original positions. The old
  // code assigned the whole pre-removal list, so anything the user added afterwards —
  // "remove A, then assign C" — vanished when they pressed Undo.
  for (const snap of undo.slots) {
    const monitor = (config.monitors || {})[snap.monitorId];
    const slot = monitor && monitor[snap.theme];
    if (!slot || !Array.isArray(slot.itemIds)) continue;
    const present = new Set(slot.itemIds);
    const rebuilt = slot.itemIds.slice();
    snap.itemIds.forEach((id, index) => {
      if (!undoRestoredIds.has(id) || present.has(id)) return;
      rebuilt.splice(Math.min(index, rebuilt.length), 0, id);
      present.add(id);
    });
    slot.itemIds = rebuilt;
    if (snap.emptied) library.clearSlotExplicitEmpty(slot);
  }
  if (undo.paths.length) {
    const res = folderState.setHidden(liveFolderState, undo.paths, false);
    liveFolderState = res.state;
    invalidateHiddenPaths();
    if (res.changed) { folderStateDirty = true; flushLiveFolderState(); }
  }
  // The legacy fallback is a bare path with no record behind it, so putting it back
  // when its file did not come back would point the desktop at nothing.
  for (const [key, value] of Object.entries(undo.legacy || {})) {
    if (config[key]) continue;
    let present = true;
    try { present = fs.existsSync(value); } catch { present = false; }
    if (present) config[key] = value;
  }
  if ((undo.dirs || []).length) {
    const res = folderState.setHiddenDir(liveFolderState, undo.dirs, false);
    liveFolderState = res.state;
    invalidateHiddenPaths();
    if (res.changed) { folderStateDirty = true; flushLiveFolderState(); }
  }
  const restoredFolders = undo.items.filter((it) => it && it.type === 'folder');
  if (restoredFolders.length) {
    syncLiveFolderWatchers();
    // Starting the watcher is not a scan: without this the folder's photos would only
    // reappear on the next file event or the hourly pass, so Undo would look partial.
    requestLiveFolderRefresh(restoredFolders.map((it) => it.id));
  }

  // What is left to retry, and nothing more. Clearing the whole record up front meant a
  // failed restore was unrepeatable; keeping the whole record would offer to undo work
  // that is already done. Slot positions travel with the items they belong to.
  const failedIds = new Set(failedItems.map((it) => it.id));
  lastLibraryRemoval = failedItems.length ? {
    items: failedItems,
    slots: (undo.slots || []).filter((snap) => snap.itemIds.some((id) => failedIds.has(id))),
    paths: [], dirs: [], legacy: undo.legacy, at: undo.at, token: undo.token,
  } : null;

  saveConfig();
  trayCtl.refresh();
  try { await applyForTheme(null, true); } catch (err) { console.error('undo removal apply failed:', err); }
  // Counted from what actually happened: the old sum reported every item in the
  // snapshot, including the ones whose file could not be brought back.
  // Counted in CARDS, not in bookkeeping rows. One photo inside a watched folder is both
  // a library record and a marked file in the index, so adding the two lists together
  // said "2 restored" for a single photo.
  const restoredKeys = new Set();
  for (const id of undoRestoredIds) {
    const item = config.library[id];
    if (item && item.path) restoredKeys.add(pathKey(item.path));
  }
  for (const p of [...undo.paths, ...(undo.dirs || [])]) restoredKeys.add(pathKey(p));

  return {
    config,
    restored: restoredKeys.size,
    failed: failedItems.length,
    error: null,
  };
}));

// The "removed" section: photos the user took out of the library that are still
// physically present in a watched folder, so restoring them costs nothing.
ipcMain.handle('library-hidden-list', () => {
  const images = [];
  const shown = new Set();   // one card per photo, whichever bookkeeping it appears in
  let hiddenDirs = [];
  try { hiddenDirs = folderState.listHiddenDirs(liveFolderState).map((d) => d.path); }
  catch (err) { console.error('library-hidden-list (hidden dirs):', err); }
  const underHiddenDir = (p) => hiddenDirs.some((dir) => library.isUnderPath(p, dir));
  try {
    for (const im of folderState.listImages(liveFolderState, null, { only: 'hidden' })) {
      // Photos hidden only because their subfolder was removed are represented by
      // that folder's own card below; listing them too would turn one decision into
      // hundreds of cards the user cannot act on individually.
      if (im.hiddenByDir) continue;
      // Two watched folders can overlap, so the same file is indexed under both roots
      // and arrived here twice — two identical cards for one photo, and removing or
      // restoring one left the other on screen.
      const key = pathKey(im.path);
      if (shown.has(key)) continue;
      shown.add(key);
      images.push(im);
    }
    for (const dir of folderState.listHiddenDirs(liveFolderState)) {
      // Overlapping watched roots index the same subfolder twice, so it arrived here
      // twice — two identical folder cards for one decision, and acting on one left the
      // other on screen. The photos above were already deduplicated; folders were not.
      const key = pathKey(dir.path);
      if (shown.has(key)) continue;
      shown.add(key);
      images.push({
        folderId: dir.folderId, path: dir.path, type: 'folder',
        firstSeenAt: 0, addedAt: 0, modifiedAt: 0, aspect: 1.6, hidden: true,
      });
    }
  } catch (err) {
    console.error('library-hidden-list (folders):', err);
  }
  // LIB-006: photos whose record was taken away live here too — including the ones
  // whose only copy belongs to Znada, which need a way back the most.
  for (const entry of (config.libraryTrash || [])) {
    if (!entry || !entry.item) continue;
    // The same photo can be both a kept record and a marked file in the folder index;
    // and a photo inside a removed FOLDER is represented by that folder's single card,
    // exactly as above. Either way it must not turn into a second card the user cannot
    // act on separately.
    const key = pathKey(entry.item.path);
    if (shown.has(key) || underHiddenDir(entry.item.path)) continue;
    shown.add(key);
    images.push({
      folderId: '',
      path: entry.item.path,
      // Folder records live in here too now, and a folder card is not drawn like a
      // photo: without this the removed view would try to show a thumbnail of a
      // directory and offer photo actions on it.
      ...(entry.item.type === 'folder' ? { type: 'folder' } : {}),
      firstSeenAt: entry.removedAt,
      addedAt: entry.item.addedAt || entry.removedAt,
      modifiedAt: entry.item.modifiedAt || 0,
      aspect: Number(entry.item.aspect) || 0,
      hidden: true,
    });
  }
  return { images };
});

// While a photo sits in the library trash its file stays where it was, held by the
// GC keep-set. This only covers the older case where a previous build had already
// swept the copy into wallpapers/.trash — then bring it back rather than telling the
// user the photo is unrecoverable. Never overwrites an existing file.
function restoreOwnCopyFile(item) {
  if (!item || !item.path || !isOwnWallpaperCopy(item.path)) return false;
  // DATA-006. With the folder away, "the file is not at its path" says nothing about
  // whether it still exists, and the trash to bring it back from is out of reach too.
  if (!managedRootReady()) return false;
  if (fs.existsSync(item.path)) return true;
  const trashed = path.join(trashDirPath(), path.basename(item.path));
  try {
    if (!fs.existsSync(trashed)) return false;
    fs.mkdirSync(path.dirname(item.path), { recursive: true });
    fs.renameSync(trashed, item.path);
    return true;
  } catch (err) {
    console.error('restore from .trash failed:', err);
    return false;
  }
}

function dropFromLibraryTrash(id) {
  if (!id || !Array.isArray(config.libraryTrash)) return false;
  const before = config.libraryTrash.length;
  config.libraryTrash = config.libraryTrash.filter((e) => !(e && e.item && e.item.id === id));
  return config.libraryTrash.length !== before;
}

// LIB-007: the one action allowed to touch the user's files. "Remove from library"
// only stops showing something; this deletes the file — and it deletes it into the
// WINDOWS RECYCLE BIN (`shell.trashItem`), never past it, so the project's rule that
// Znada does not destroy anything irreversibly still holds.
//
// Two guards make this safe to expose to the renderer:
//   * only paths ALREADY in the library trash or marked removed can be deleted, so a
//     compromised or buggy renderer cannot name an arbitrary file;
//   * the user confirms in a native dialog that names what is about to go.
// Deleting the user's files is the one thing Znada does that they cannot simply undo
// inside the app, and five review rounds have not yet proved the guard around it sound:
// a file the app was still using could be deleted through a race between validating a
// path and committing the record that uses it. The owner's decision (2026-08-10) is to
// switch the feature OFF until that transaction is proved, rather than ship it and hope.
//
// Off in ONE place, checked here and published to the renderer through 'feature-flags',
// so the button and the handler cannot drift apart. Turning it back on is this constant.
let physicalDeleteEnabled = false;

ipcMain.handle('feature-flags', () => ({ physicalDelete: physicalDeleteEnabled }));

ipcMain.handle('library-delete-forever', async (e, rawPaths) => {
  if (!physicalDeleteEnabled) return { config, deleted: 0, error: 'disabled' };
  // DATA-006. Whatever re-enables this later must not be able to erase files while the
  // folder holding them is unreachable: "not there right now" is not "safe to delete".
  if (!managedRootReady()) return { config, deleted: 0, error: 'media_root_unavailable' };
  const asked = (Array.isArray(rawPaths) ? rawPaths : []).filter((p) => typeof p === 'string' && p);
  if (!asked.length) return { config, deleted: 0, error: 'bad_request' };

  // Deletable = what the user already removed. Directories are deliberately out of
  // scope: erasing a folder tree is a different question from erasing a photo.
  const allowed = new Set();
  for (const entry of (config.libraryTrash || [])) {
    if (entry && entry.item && entry.item.path) allowed.add(pathKey(entry.item.path));
  }
  // This also covers photos under a removed SUBFOLDER, not only individually removed
  // ones. Deliberate: the user removed the folder, so its contents count as removed
  // here too. They have no card of their own in the trash, so nothing in the interface
  // can reach them today — the guard is simply not narrower than the decision the user
  // already made.
  for (const key of hiddenPathSet()) allowed.add(key);

  // Whatever is active RIGHT NOW can never be deleted, even if a stale trash entry
  // still names it: re-importing or re-downloading the same content-addressed file
  // makes it active again, and the leftover entry would otherwise authorise erasing
  // a photo the user is currently using.
  const activePaths = () => inUsePaths();

  const before = activePaths();
  const targets = asked.filter((p) => allowed.has(pathKey(p)) && !before.has(pathKey(p)));
  if (!targets.length) return { config, deleted: 0, error: 'not_removed' };

  const shown = targets.slice(0, 10).map((p) => path.basename(p));
  const more = targets.length - shown.length;
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: [tMain('library.deleteForeverConfirm'), tMain('library.deleteForeverCancel')],
    defaultId: 1,
    cancelId: 1,
    title: tMain('library.deleteForeverTitle'),
    // tMain() has no placeholder support (tray labels never needed any), so the one
    // count this dialog shows is substituted here rather than growing that helper.
    message: tMain('library.deleteForeverMessage').replace('{n}', String(targets.length)),
    detail: [...shown, ...(more > 0 ? [`… +${more}`] : []), '', tMain('library.deleteForeverDetail')].join('\n'),
    noLink: true,
  });
  if (answer.response !== 0) return { config, deleted: 0, error: null, cancelled: true };

  // The dialog was open for as long as the user took, and every await below is another
  // chance for a download, a restore or an assignment to put one of these files back
  // into use. One re-check after the dialog is not enough: it says nothing about the
  // state between the second and the third `trashItem`.
  //
  // So the deletions run inside the library lock, which every route that activates a
  // photo also takes — nothing can change underneath the loop — and each target is
  // checked against the state as it is at that exact moment, immediately before it is
  // erased. Re-checking "removed" as well as "active": a restore while the dialog was
  // open takes a photo out of the trash without ever making it active.
  return withLibraryLock(async () => {
    const deletable = () => {
      const set = new Set();
      for (const entry of (config.libraryTrash || [])) {
        if (entry && entry.item && entry.item.path) set.add(pathKey(entry.item.path));
      }
      for (const key of hiddenPathSet()) set.add(key);
      return set;
    };

    let deleted = 0;
    const failed = [];
    const gone = new Set();
    let skipped = 0;
    for (const target of targets) {
      const key = pathKey(target);
      if (!deletable().has(key) || activePaths().has(key)) { skipped++; continue; }
      try {
        await shell.trashItem(target);
        deleted++;
        gone.add(key);
      } catch (err) {
        failed.push(target);
        console.error('delete to recycle bin failed:', target, err);
      }
    }
    if (!deleted && !failed.length) return { config, deleted: 0, error: 'not_removed' };

    // Only forget what actually left: a file that could not be moved is still there,
    // and dropping its record would strand it exactly the way the trash exists to avoid.
    if (gone.size) {
      const trashBefore = (config.libraryTrash || []).length;
      config.libraryTrash = (config.libraryTrash || [])
        .filter((entry) => !(entry && entry.item && gone.has(pathKey(entry.item.path))));
      // The photo leaves the trash because its entry above is gone. The removed-marker
      // in the folder index is deliberately LEFT ALONE: clearing it would mean "show
      // this again", and the file no longer exists, so the grid would gain a broken
      // card pointing at nothing. reconcileFolder drops the index record on the next
      // complete scan, which is already how a file that vanished from disk is handled.
      if (trashBefore !== config.libraryTrash.length) saveConfig();
    }
    return { config, deleted, failed: failed.length, skipped, error: null };
  });
});

// A path can be missing for two completely different reasons, and they need
// opposite answers. The file was deleted: there is nothing to point a record at,
// so refusing is right. The DISK was unplugged: the record has to come back —
// live folders exist precisely to survive an absent volume, and refusing leaves
// the entry stuck in the trash with no way out.
//
// Found by the owner 2026-08-16: a live folder on an unplugged disk was removed
// and could then never be restored — "put back: 0" every time. Folder records
// only started reaching this check when they began being kept in the trash
// (BUG-012), which is what turned a reasonable guard for images into a trap.
function recordTargetLost(target) {
  try {
    if (fs.existsSync(target)) return false;
    const root = path.parse(path.resolve(String(target))).root;
    // No root at all means we cannot tell; treat that as "not proven lost".
    if (!root || !fs.existsSync(root)) return false;
    return true;
  } catch {
    return false;
  }
}

// Put a restored record back where it was playing. The index is only a hint: the slot
// may have been edited since, so it is clamped rather than trusted, and an id that is
// somehow already there is left alone instead of being listed twice.
function restoreSlotPlacements(entry) {
  if (!entry || !Array.isArray(entry.slots) || !entry.item) return;
  for (const placement of entry.slots) {
    const monitor = (config.monitors || {})[placement.monitorId];
    const slot = monitor && monitor[placement.theme];
    if (!slot || !Array.isArray(slot.itemIds)) continue;
    if (slot.itemIds.includes(entry.item.id)) continue;
    const at = Math.min(Math.max(placement.index, 0), slot.itemIds.length);
    slot.itemIds.splice(at, 0, entry.item.id);
    // The slot was emptied BY this removal, so the marker that says "the user wants this
    // one empty" was ours to set and is ours to lift.
    if (placement.emptied) library.clearSlotExplicitEmpty(slot);
  }
}

ipcMain.handle('library-restore', async (e, rawPaths) => withLibraryLock(async () => {
  const paths = (Array.isArray(rawPaths) ? rawPaths : []).filter((p) => typeof p === 'string' && p);
  if (!paths.length) return { config, restored: 0 };
  const res = folderState.setHidden(liveFolderState, paths, false);
  liveFolderState = res.state;
  invalidateHiddenPaths();
  const dirRes = folderState.setHiddenDir(liveFolderState, paths, false);
  liveFolderState = dirRes.state;
  invalidateHiddenPaths();
  if (res.changed || dirRes.changed) { folderStateDirty = true; flushLiveFolderState(); }

  // The same button puts the RECORDS back — tags, star and all — and brings Znada's
  // own copies back from wallpapers/.trash on the way.
  //
  // Restoring a FOLDER has to reach the records of the photos inside it: those records
  // were taken away with the folder, and matching only exact paths meant the folder came
  // back full of photos that had quietly lost their stars and tags.
  let poolRestored = 0;
  // Which of the paths the CALLER asked about actually came back, for the count below.
  // A photo restored because its folder was restored is not a separate card.
  const restoredPoolKeys = new Set();
  const wanted = new Set(paths.map(pathKey));
  // A folder brings back exactly what went WITH IT — the entries whose `via` names THAT
  // folder — and nothing else.
  //
  // This used to match by ancestry: any entry whose `via` sat anywhere under the folder
  // being restored came back. So a subfolder the user had removed separately, earlier,
  // was undone by restoring its parent — and since the subfolder's own removed-marker is
  // untouched by that (it is a different folder), the photos ended up listed in "All"
  // and in the trash at the same time. Provenance is the exact folder, not the tree.
  const cameWithRestoredFolder = (entry) => !!entry.via && wanted.has(pathKey(entry.via));
  const restoredFolderIds = [];
  for (const entry of (config.libraryTrash || []).slice()) {
    if (!entry || !entry.item) continue;
    if (!wanted.has(pathKey(entry.item.path)) && !cameWithRestoredFolder(entry)) continue;
    // Znada's own copy has to actually come back before its record does. Ignoring the
    // answer here was a real gap (found reviewing DATA-006 step 1): with the folder
    // away, `recordTargetLost` correctly says "cannot tell", so the record returned to
    // the active pool while the file stayed unreachable in the trash. The undo path
    // beside this one has always been strict; now both are.
    if (isOwnWallpaperCopy(entry.item.path) && !restoreOwnCopyFile(entry.item)) {
      console.error('restore: копия не восстановлена, запись корзины сохранена:', entry.item.path);
      continue;
    }
    if (recordTargetLost(entry.item.path)) continue;  // nothing to point the record at
    const activeItem = config.library[entry.item.id] || entry.item;
    markRecordRevived(activeItem);
    if (!config.library[entry.item.id]) config.library[entry.item.id] = activeItem;
    restoreSlotPlacements(entry);
    if (entry.item.type === 'folder') restoredFolderIds.push(entry.item.id);
    dropFromLibraryTrash(entry.item.id);
    restoredPoolKeys.add(pathKey(entry.item.path));
    poolRestored++;
  }
  // A watched folder that came back has to start being watched again, or it would sit
  // in the library while quietly ignoring everything added to it.
  if (restoredFolderIds.length) {
    syncLiveFolderWatchers();
    requestLiveFolderRefresh(restoredFolderIds);
  }
  if (poolRestored) saveConfig();
  else broadcastConfig();
  // Removal takes photos out of the playlist, so putting them back has to re-apply
  // for the same reason undo does: the slideshow position was computed without them.
  if (res.changed || dirRes.changed) {
    try { await applyForTheme(null, true); }
    catch (err) { console.error('restore apply failed:', err); }
  }
  // Counted in cards for the same reason removal is: the caller asked about N cards, so
  // the answer is how many of THOSE came back — not how many rows changed underneath.
  // Restoring one folder card used to report 2, or 501.
  const changed = new Set([...res.matched, ...dirRes.matched].map(pathKey));
  for (const key of restoredPoolKeys) changed.add(key);
  const restored = paths.filter((p) => changed.has(pathKey(p))).length;
  return { config, restored };
}));

ipcMain.handle('library-toggle-favorite', (e, id) => {
  library.toggleFavorite(config.library, id);
  savePoolOnly();
  return config;
});

// Refresh discovery metadata and drop missing standalone images. Folder sources are
// never removed merely because a disk is currently offline or access is denied.
ipcMain.handle('library-refresh', async () => {
  // DATA-006. This drops every record whose file is gone. With the managed folder
  // absent — an unplugged drive, a share that does not answer — that is EVERY own copy
  // at once, and the honest answer to "is this file missing" is "cannot tell". The
  // owner's rule for an absent disk is: nothing is cleaned up, nothing is marked gone.
  if (!managedRootReady()) return { config, removed: 0, error: 'media_root_unavailable' };
  await refreshLiveFolders(null, true);
  liveFolderLastFullScanAt = Date.now();
  scheduleLiveFolderFullScan('hourly', LIVE_FOLDER_FULL_SCAN_MS);
  const staleLive = pruneConfirmedMissingLiveFolderImages();
  const dead = library.findMissingIds(config.library, (p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }).filter((id) => {
    const item = library.getItem(config.library, id);
    return item && item.type === 'image' && !isPathUnderLiveFolder(item.path);
  });
  let removed = 0;
  for (const id of dead) { if (removeFromLibrary(id)) removed++; }
  if (removed) {
    saveConfig();
    trayCtl.refresh();
    applyForTheme(null, true); // a removed item may have been the current wallpaper
  }
  return { config, removed: removed + staleLive };
});

// Заполнить размеры файлов (байты) для сортировки «по размеру» — лениво, по запросу.
// Считаем только для image-элементов без size; folder/недоступные → 0.
ipcMain.handle('library-ensure-sizes', async () => {
  // Async stat (NOT statSync): a synchronous loop here blocks the whole main process —
  // and a single pool image on a slow/disconnected drive would freeze the entire app
  // the first time the user sorts by size.
  let changed = false;
  for (const it of Object.values(config.library || {})) {
    if (it && it.type === 'image' && it.path && typeof it.size !== 'number') {
      let size = 0;
      try { size = (await fs.promises.stat(it.path)).size; } catch {}
      // `size` is derived metadata, but it is still part of the whole-record snapshot
      // selected by DATA-005 recovery. A direct assignment leaves the revision tied
      // with an older store copy, so that copy wins and silently discards this write.
      if (library.updateItem(config.library, it.id, { size })) changed = true;
    }
  }
  if (changed) saveConfig();
  return config;
});

// On-demand byte sizes for ephemeral folder images (files living in a watched folder
// that are NOT pool items, so they have no cached size). Used only by the renderer's
// "Largest first" sort. Async + cached so sorting a 1000+ folder never blocks the main
// loop and never re-stats a path twice in a session. Returns [{ path, size }].
const pathSizeCache = new Map(); // shared canonical path key -> size in bytes
const PATH_SIZE_CACHE_CAP = 50000;
ipcMain.handle('library-path-sizes', async (e, paths) => {
  const list = Array.isArray(paths) ? paths : [];
  const out = [];
  const pending = [];
  for (const p of list) {
    if (!p || typeof p !== 'string' || !isAuthorizedMediaPath(p)) continue;
    const key = pathKey(p);
    if (pathSizeCache.has(key)) out.push({ path: p, size: pathSizeCache.get(key) });
    else pending.push({ p, key });
  }
  const CONCURRENCY = 24; // bounded so a huge folder doesn't open thousands of FDs at once
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const slice = pending.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(async ({ p, key }) => {
      let size = 0;
      try { size = (await fs.promises.stat(p)).size; } catch { size = 0; }
      if (pathSizeCache.size > PATH_SIZE_CACHE_CAP) {
        const k0 = pathSizeCache.keys().next().value;
        pathSizeCache.delete(k0);
      }
      pathSizeCache.set(key, size);
      out.push({ path: p, size });
    }));
  }
  return out;
});

// --- Details view ("Подробнее") -----------------------------------------
// Metadata the pool does not store: file size, modification time and true pixel
// dimensions. Dimensions come from a bounded file-header read (src/item-details),
// never from a full decode.
// Path-based (not id-based) because details also open on transient live-folder
// cards that were never materialized into the pool; the same precedent as
// `library-path-sizes`, which already stats renderer-supplied paths.
const readItemDetails = itemDetails.createDetailsReader();
// SEC-002, slice 2. Short-lived authority for paths main learned ITSELF — a dialog it
// opened, or a listing it produced. Everything else has to be vouched for by the pool.
const pathGrants = pathGrantsMod.create({
  isSameOrDescendant: (child, ancestor) => itemDetails.isSameOrDescendant(child, ancestor),
  normalize: (p) => pathKey(p),
});

// Counted rather than logged: a test needs to see that an unauthorised path was refused
// BEFORE any bytes were read, and the empty result a blocked helper returns looks exactly
// like the empty result a refusal returns.
let thumbnailAttempts = 0;

// The one answer to "may a window turn this path into bytes". Three sources, in order of
// how much they are worth:
//
//   1. the pool — a record's own path, or anything inside a folder the user added;
//   2. Znada's own wallpaper copies, which exist because the app made them;
//   3. a short-lived grant, for a file that is legitimately on screen before it is a
//      pool record: the moment after a picker closes, or a folder being browsed.
//
// KNOWN LIMIT, stated rather than papered over: drag-and-drop paths reach main as strings
// the window asserts (Electron's `webUtils.getPathForFile` runs in the renderer, and main
// cannot tell a real drop from a made-up string). So a compromised window can still get a
// path in by pretending it was dropped — but only by ADDING it, which puts a card on
// screen. Silent reading of any file on the disk, which is what this used to allow, is
// gone. Closing the rest needs a drop contract Electron does not offer today.
function isAuthorizedMediaPath(p) {
  if (!itemDetails.isValidAbsolutePath(p)) return false;
  if (isAuthorizedItemPath(p)) return true;
  // Not while the saved folder is one the rules refuse: that folder may be the profile.
  if (!managedRootInvalid() && itemDetails.isSameOrDescendant(p, wallpapersDir())) return true;
  if (pathGrants.allows(p)) return true;
  noteMediaRefusal();
  return false;
}

// A refusal is either a bug in this rule or a window asking for something it should not
// have. Both are worth knowing about, and neither is worth the path itself: that is the
// user's business, and a log is the last place it belongs. Bounded, because a window in a
// loop would otherwise fill the console with the same line.
let mediaRefusals = 0;
const MEDIA_REFUSAL_LOG_LIMIT = 5;
function noteMediaRefusal() {
  mediaRefusals += 1;
  if (mediaRefusals <= MEDIA_REFUSAL_LOG_LIMIT) {
    console.error(`[Media] refused a path nothing vouches for (${mediaRefusals})`);
  }
}

// Called only after main has vouched for a path: either a native dialog/listing produced
// it, or a renderer-reported drop passed the filesystem/type/import boundary.
function grantMediaPath(p, options) {
  if (itemDetails.isValidAbsolutePath(p)) pathGrants.grant(p, options);
  return p;
}

function isAuthorizedItemPath(p) {
  if (!itemDetails.isValidAbsolutePath(p)) return false;
  return Object.values((config && config.library) || {}).some((item) => {
    if (!item || !itemDetails.isValidAbsolutePath(item.path)) return false;
    if (itemDetails.isSameOrDescendant(p, item.path)) {
      return item.type === 'folder' || itemDetails.isSameOrDescendant(item.path, p);
    }
    return false;
  });
}

ipcMain.handle('item-details', (e, p) => (
  isAuthorizedItemPath(p) ? readItemDetails(p) : itemDetails.emptyDetails()
));

// Reveal in Explorer. Only selects an existing path — no execution, no content leaves
// the machine — and the renderer can still only pass paths it already displays.
ipcMain.handle('item-reveal', async (e, p) => {
  if (!isAuthorizedItemPath(p)) return false;
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    shell.showItemInFolder(p);
    return true;
  } catch { return false; }
});

// Open an item's source page. The URL is NOT taken from the renderer: we look up the
// pool item and open the source we stored at download time, validated as http(s).
ipcMain.handle('item-open-source', async (e, id) => {
  const item = id && config.library ? config.library[id] : null;
  const raw = item && typeof item.source === 'string' ? item.source : '';
  const url = itemDetails.normalizeHttpUrl(raw);
  if (!url) return false;
  try {
    await shell.openExternal(url);
    return true;
  } catch { return false; }
});

ipcMain.handle('item-copy-path', async (e, p) => {
  if (!isAuthorizedItemPath(p)) return false;
  try {
    // Electron 43 made clipboard.writeText() return a Promise. Without awaiting it a
    // failure would escape this catch as an unhandled rejection, and we would report
    // success to the renderer before the write had actually happened.
    await clipboard.writeText(p);
    return true;
  } catch { return false; }
});

// ---------------------------------------------------------------------------
// ONL-009 — card actions (right-click menu), shared by both windows
// ---------------------------------------------------------------------------
// These used to carry their own sender checks, one comparing against the main window and
// one against either window. SEC-002 replaced both with the registrar above, which asks
// the same question and three more besides — top frame, still-on-its-own-page, and
// whether this window owns the channel at all. Two guards for one question is one guard
// too many: the weaker one had to be kept in step by hand, and it also made these
// handlers untestable, because it named a window the harness has no way to create.

// Exports and clipboard copies land here, NOT in wallpapers/. A file inside wallpapers/
// with no pool record pointing at it is an orphan, and the sweeper is entitled to move
// it to .trash — which would be a surprising thing to happen to a user's export.
const CARD_EXPORT_DIR = path.join(app.getPath('userData'), 'export-cache');

// Descriptors come from the renderer, so nothing in them is trusted. A pool id is
// looked up rather than believed, and every URL is validated by src/online.js before
// it reaches the network — the same rule the download path already follows.
function normalizeCardDescriptor(raw) {
  const card = raw && typeof raw === 'object' ? raw : {};
  const kind = ['local', 'internet', 'cloud'].includes(card.kind) ? card.kind : 'local';
  const id = typeof card.id === 'string' ? card.id : '';
  const path = typeof card.path === 'string' ? card.path : '';
  const item = card.item && typeof card.item === 'object' ? card.item : null;
  return { kind, id, path, item };
}

function pooledImageFor(descriptor) {
  const item = descriptor.id && config.library ? config.library[descriptor.id] : null;
  if (!item || item.type !== 'image' || !item.path) return null;
  return fs.existsSync(item.path) ? item : null;
}

// BUG-029. The file behind a local card that has no pool record of its own — a photo
// shown straight out of a watched folder. That is the commonest local photo there is,
// because people add folders, not single files.
//
// Everything here treats the window's path as a CLAIM. It is honoured only when the
// library already vouches for it (a record, or a folder the user added), which is the
// same rule the details sheet and the thumbnails go through — see isAuthorizedMediaPath.
// Two further conditions, because this path hands over an actual file:
//
//   * it must be a picture of a kind Znada works with. A watched folder legitimately
//     contains other things — a text file, an archive — and "add a folder of wallpapers"
//     is not permission to hand any file in it to the clipboard or a save dialog;
//   * it must still be there. A folder is live, and the answer must be "gone", not a
//     copy attempt that fails halfway.
function authorizedLocalFile(descriptor) {
  const p = descriptor && descriptor.path;
  if (!p || !isAuthorizedMediaPath(p)) return '';
  // The same one list of formats the folder scanner and the online boundary use, so a
  // photo Znada can show is exactly a photo Znada can hand over (ONL-015).
  const ext = path.extname(p).replace('.', '');
  if (!mediaFormats.isWallpaperFormat(mediaFormats.normalizeFormat(ext))) return '';
  try {
    return fs.statSync(p).isFile() ? p : '';
  } catch { return ''; }
}

// The page a card came from. For a downloaded photo that is the source we stored; for
// a live online card it is the provider's page, validated here. Our own catalogue has
// neither — its download link is signed and short-lived — and returns ''.
function resolveCardPageUrl(descriptor) {
  const pooled = descriptor.id && config.library ? config.library[descriptor.id] : null;
  if (pooled && typeof pooled.source === 'string') {
    const stored = itemDetails.normalizeHttpUrl(pooled.source);
    if (stored) return stored;
  }
  if (descriptor.kind === 'internet' && descriptor.item && online.allowedPageUrl(descriptor.item)) {
    return itemDetails.normalizeHttpUrl(descriptor.item.page) || '';
  }
  return '';
}

// THE one place anything obtains the actual image file. "Save as", "copy picture" and
// assigning an online photo to a monitor all cross the same boundary — does this thing
// have a local file — so they all cross it here, once, instead of growing three
// download paths that then have to be fixed three times.
//
// `managed` decides ownership, not location alone: a managed copy is one the library is
// about to take responsibility for; an unmanaged one is a throwaway for export.
async function ensureCardFile(descriptor, opts = {}) {
  const managed = !!opts.managed;
  // DATA-006. Only the managed side depends on the chosen folder; an export still works
  // while it is away, because it writes into the profile's own cache.
  if (managed && !managedRootReady()) return { path: '', error: 'media_root_unavailable' };
  const dir = managed ? wallpapersDir() : CARD_EXPORT_DIR;

  // Already ours and still on disk: nothing to fetch, whatever the card claims.
  const pooled = pooledImageFor(descriptor);
  if (pooled) return { path: pooled.path, error: null };

  try {
    if (descriptor.kind === 'cloud') {
      const client = cloudClient();
      if (!client) return { path: '', error: 'unavailable' };
      const id = descriptor.item && descriptor.item.id;
      if (!id) return { path: '', error: 'badItem' };
      const session = cloudSessionSnapshot();
      // Always a FRESH signed URL. The one the card is holding may already be dead,
      // and it must never be reused or handed further.
      const dl = await client.getDownload(id, { token: session.token || undefined });
      if (!cloudSessionIsCurrent(session)) return { path: '', error: 'session_changed' };
      if (!dl.ok) { cloudHandleAuthError(dl, session); return { path: '', error: dl.error.code }; }
      const stagedArtifact = await stageDownloadImage(dir, dl.data.url);
      if (!cloudSessionIsCurrent(session)) {
        discardDownloadArtifact(stagedArtifact, dir);
        return { path: '', error: 'session_changed' };
      }
      const artifact = commitDownloadArtifact(stagedArtifact, dir);
      return { path: artifact.path, error: null };
    }

    if (descriptor.kind === 'internet') {
      if (!usableInternetDownload(descriptor.item)) return { path: '', error: 'badItem' };
      const stored = await downloadImageTo(dir, descriptor.item.full, onlineOriginalOptions(descriptor.item));
      return { path: stored, error: null };
    }

    // BUG-029. No pool record — the ordinary case for a photo shown out of a watched
    // folder. The window's path is honoured only if the library vouches for it.
    const vouched = authorizedLocalFile(descriptor);
    if (vouched) return { path: vouched, error: null };

    // Local, and nothing stands behind it: the record's file is gone, or the window named
    // something nobody added. Saying so beats a silent no-op.
    return { path: '', error: 'missing' };
  } catch (err) {
    console.error('card file:', err);
    return { path: '', error: 'download' };
  }
}

// What the assign chooser needs, for a window that does not hold the config. The main
// window already has both; the fullscreen viewer has neither, and giving it the two
// values is cheaper and safer than giving it the whole config.
ipcMain.handle('card-assign-targets', () => {
  // BUG-037. What each spot already holds, so the fullscreen viewer's chooser can say the
  // same thing the main window's does. Ids rather than counts: the window also has to
  // answer "is the picture I am looking at one of them", and a count cannot.
  const slots = {};
  for (const [id, monitor] of Object.entries(config.monitors || {})) {
    const ids = (theme) => {
      const slot = monitor && monitor[theme];
      return slot && Array.isArray(slot.itemIds) ? slot.itemIds.slice() : [];
    };
    slots[id] = { light: ids('light'), dark: ids('dark') };
  }
  return {
    monitors: (monitorsCache || []).map((m) => ({ id: m.id, primary: !!m.primary })),
    separateThemes: config.separateThemes !== false,
    slots,
  };
});

ipcMain.handle('card-open-source', async (e, raw) => {
  const url = resolveCardPageUrl(normalizeCardDescriptor(raw));
  if (!url) return { ok: false, error: 'noSource' };
  try {
    await shell.openExternal(url);
    return { ok: true, error: null };
  } catch (err) {
    console.error('card open source:', err);
    return { ok: false, error: 'open' };
  }
});

ipcMain.handle('card-copy-link', async (e, raw) => {
  const url = resolveCardPageUrl(normalizeCardDescriptor(raw));
  if (!url) return { ok: false, error: 'noSource' };
  try {
    await clipboard.writeText(url);
    return { ok: true, error: null };
  } catch (err) {
    console.error('card copy link:', err);
    return { ok: false, error: 'copy' };
  }
});

// The picture itself onto the clipboard, so it pastes into a chat or an editor. Not a
// file handle: Windows' file-drop clipboard format is not something Electron exposes,
// and promising "paste into a folder" without being able to deliver it would be worse
// than the honest, useful thing.
ipcMain.handle('card-copy-file', async (e, raw) => {
  const descriptor = normalizeCardDescriptor(raw);
  const file = await ensureCardFile(descriptor, { managed: false });
  if (file.error) return { ok: false, error: file.error };
  try {
    const image = nativeImage.createFromPath(file.path);
    if (image.isEmpty()) return { ok: false, error: 'badImage' };
    clipboard.writeImage(image);
    return { ok: true, error: null };
  } catch (err) {
    console.error('card copy file:', err);
    return { ok: false, error: 'copy' };
  }
});

// Where the save dialog opens. A remembered folder that has since vanished (a removed
// drive) must not break the dialog, so it is checked and quietly dropped.
function saveDialogStartDir() {
  const remembered = typeof config.lastSaveDir === 'string' ? config.lastSaveDir : '';
  try {
    if (remembered && fs.statSync(remembered).isDirectory()) return remembered;
  } catch { /* gone — fall through */ }
  try { return app.getPath('downloads'); } catch { return app.getPath('home'); }
}

ipcMain.handle('card-save-as', async (e, raw) => {
  const descriptor = normalizeCardDescriptor(raw);
  const file = await ensureCardFile(descriptor, { managed: false });
  if (file.error) return { ok: false, error: file.error };

  const parent = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const suggested = path.join(saveDialogStartDir(), path.basename(file.path));
  let res;
  try {
    res = await dialog.showSaveDialog(parent, {
      defaultPath: suggested,
      filters: [{ name: 'Image', extensions: [path.extname(file.path).replace('.', '') || 'jpg'] }],
    });
  } catch (err) {
    console.error('card save dialog:', err);
    return { ok: false, error: 'save' };
  }
  if (res.canceled || !res.filePath) return { ok: false, error: null, canceled: true };

  try {
    await fs.promises.copyFile(file.path, res.filePath);
  } catch (err) {
    console.error('card save copy:', err);
    return { ok: false, error: 'save' };
  }
  // Remembered only after a save that actually worked, so a failed attempt cannot
  // leave the dialog pointing somewhere unusable next time.
  const dir = path.dirname(res.filePath);
  if (dir && dir !== config.lastSaveDir) {
    config.lastSaveDir = dir;
    saveSettingsOnly();
  }
  // Deliberately no library record: the owner's decision is that an export is an
  // export. Offering to add it afterwards is the renderer's job, as an explicit click.
  return { ok: true, error: null, path: res.filePath };
});

ipcMain.handle('library-add-tag', (e, id, tag) => {
  if (library.addTag(config.library, id, tag)) savePoolOnly();
  return config;
});

ipcMain.handle('library-remove-tag', (e, id, tag) => {
  if (library.removeTag(config.library, id, tag)) savePoolOnly();
  return config;
});

async function finalizeLibraryAssignment(result, theme, poolTouched = true) {
  // Assigning a photo that is already in the library only changes a slot, which lives in
  // the settings file. Rewriting every pool record for that was the coupling the split
  // storage existed to remove.
  if (poolTouched) saveConfig();
  else saveSettingsOnly();
  const createdIds = new Set(result.createdIds || (result.created ? [result.id] : []));
  const createdFolders = (result.items || (result.item ? [result.item] : []))
    .filter((item) => item && item.type === 'folder' && createdIds.has(item.id))
    .map((item) => item.id);
  if (createdFolders.length) {
    syncLiveFolderWatchers();
    requestLiveFolderRefresh(createdFolders);
  }
  trayCtl.refresh();
  // Assigning a new image to the active monitor×theme changes the current frame → drop any
  // pending stealth advance so it can't overwrite this choice moments later.
  let warning = null;
  if (theme === wallpaperThemeName()) {
    cancelPendingStealth();
    try {
      await applyForTheme(theme, true);
    } catch (err) {
      // The pool + slot transaction is already durably saved. Surface application
      // trouble as a warning instead of lying to the renderer that assignment failed.
      warning = 'apply_failed';
      console.error('library assignment apply failed:', err);
    } finally {
      rescheduleSlideshowAfterManualWallpaperChange();
    }
  }
  return warning;
}

// Назначить элемент пула на монитор×тему (добавляет в плейлист слота) + применить, если тема активна.
// Every assignment route ends here, so the lock lives here too: making a photo active
// has to be ordered against deleting its file, or the delete guard reads "not active"
// a moment before the assignment makes it active.
async function commitLibraryAssignmentRecord(record, monitorId, which, options = {}) {
  return withLibraryLock(async () => {
    const theme = which === 'dark' ? 'dark' : 'light';
    const known = record && (library.getItem(config.library, record.id)
      || library.getItem(config.library, library.idFor(record.path)));
    if (known && known.type === 'image' && !pathExists(known.path)) {
      return { config, ok: false, error: 'missing_file' };
    }
    // Share the single funnel so an assignment cannot create an active record that is
    // still marked removed — and so assigning one that ALREADY has a record repairs a
    // profile left in the active+removed state by an older build.
    const revivalsBefore = poolRevivals;
    const result = libraryAssignment.assignRecord(config, record, monitorId, theme,
      { ...options, addToPool });
    if (!result.ok) return result;
    // The pool changed only if a record was created, or if the funnel cleared a
    // removed-marker that was still on an existing one.
    const poolTouched = !!result.created || poolRevivals !== revivalsBefore;
    const warning = await finalizeLibraryAssignment(result, theme, poolTouched);
    return { ...result, config, warning };
  });
}

ipcMain.handle('library-assign', async (e, id, monitorId, which) => {
  return commitLibraryAssignmentRecord({ id }, monitorId, which);
});

// ---- Internet providers: whoever the registry lists (src/provider-registry.js) ----

const INTERNET_USER_AGENT = `Znada/${app.getVersion()} (https://github.com/alexvlass01/znada)`;
const INTERNET_TAG_SUGGEST_CACHE_SIZE = 200;
const internetTagSuggestCache = new Map();

// Two more fields used to ride along here — whether a Wallhaven key is bundled, twice
// under different names. Nothing has ever read them, and keeping them meant main had to
// name a site to fill them in. What the window actually asks is the next line.
ipcMain.handle('internet-status', () => ({
  // Computed rather than asserted: this used to be a hardcoded `true` beside a comment
  // reasoning about which sites cover it, and that reasoning silently stopped being
  // true whenever a site was removed or shipped without its key.
  nsfwAvailable: explicitContentReachableIn(providerRegistry.active().filter(sourceEnabled)),
  // ONL-016. "Details" has to name the site a picture came from, and the registry is
  // the one place that knows what a site is called. Sent as a list rather than copied
  // onto every card, and taken from ALL providers rather than the active ones: a card
  // saved from a site Znada no longer asks must still be able to say where it is from.
  providers: providerRegistry.PROVIDERS.map((p) => ({
    id: p.id, name: p.name, status: p.status || 'active',
    sourceKey: p.sourceKey || 'internet', browse: !!(p.capabilities && p.capabilities.browse),
  })),
}));

async function fetchInternetTagSuggestions(opts) {
  const prefix = tagSuggest.normalizeTagPrefix(opts && opts.q);
  if (prefix.length < tagSuggest.MIN_PREFIX_LEN) return { items: [], error: null };

  const limit = tagSuggest.clampLimit(opts && opts.limit);
  const selection = onlineSources.signature(config.onlineSources);
  const cacheKey = `${selection}|${prefix}|${limit}`;
  if (internetTagSuggestCache.has(cacheKey)) {
    const cached = internetTagSuggestCache.get(cacheKey);
    internetTagSuggestCache.delete(cacheKey);
    internetTagSuggestCache.set(cacheKey, cached);
    return cached;
  }

  const answer = await suggestTagsFromProviders(prefix, limit, providerRegistry.active().filter(sourceEnabled));
  if (selection !== onlineSources.signature(config.onlineSources)) return { items: [], error: null };
  if (answer.error) return { items: [], error: answer.error };
  const result = { items: answer.items, error: null };
  internetTagSuggestCache.set(cacheKey, result);
  while (internetTagSuggestCache.size > INTERNET_TAG_SUGGEST_CACHE_SIZE) {
    internetTagSuggestCache.delete(internetTagSuggestCache.keys().next().value);
  }
  return result;
}

// ONL-014. Ask whoever declared they can answer the search box, in registry order, and
// take the first real answer.
//
// This was the last path that reached ONE named site with no alternative: while it was
// unreachable the dropdown silently offered nothing, and there was no second site to
// fall through to because there was no list to fall through. Sorting and the final cut
// are done HERE, so a site returns what it found and does not each invent its own idea
// of "the best ten".
function suggestTagProviders(list) {
  return (Array.isArray(list) ? list : providerRegistry.active()).filter((descriptor) => (
    descriptor
    && descriptor.status !== 'retired'
    && descriptor.capabilities && descriptor.capabilities.tagSuggest
    && typeof descriptor.suggestTags === 'function'
  ));
}

function rankSuggestions(items, limit) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.name || seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item);
  }
  out.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  return out.slice(0, limit);
}

async function suggestTagsFromProviders(prefix, limit, list) {
  let lastError = 'network';
  for (const descriptor of suggestTagProviders(list)) {
    if (descriptor.credentials && descriptor.credentials.required && !providerCredentials(descriptor)) {
      lastError = 'unavailable';
      continue;
    }
    let res;
    try {
      res = await descriptor.suggestTags({ q: prefix, limit }, providerContext(descriptor));
    } catch (err) {
      console.error(`${descriptor.id} tag suggest:`, err);
      res = { error: 'network' };
    }
    if (!res || res.error) { lastError = (res && res.error) || 'network'; continue; }
    const items = rankSuggestions(res.items, limit);
    // An empty answer from a reachable site is an ANSWER — that tag prefix matches
    // nothing — so the next site is not asked. Only a failure falls through.
    return { items, error: null };
  }
  return { items: [], error: lastError };
}

ipcMain.handle('internet-tag-suggest', (e, opts) => fetchInternetTagSuggestions(opts));

// ---------------------------------------------------------------------------
// ONL-012 — one search path, for every site there will ever be
// ---------------------------------------------------------------------------
//
// There used to be a hand-written search function per site, each with its own fetch,
// its own timeouts and its own way of turning a failure into a word, plus a hardwired
// "ask Gelbooru, and Danbooru if that failed". None of it generalised: a fourth site
// would have needed every one of those written again, and the graceful behaviour we
// already had would not have come with it.
//
// Now the handler knows nothing about any site. It asks whoever DECLARES they can
// answer, in the order the registry lists them, and everything peculiar to a site lives
// in that site's own file.
//
// ONL-015. What Znada can put on a desktop is ONE list, and it is the same list a folder
// is scanned with (`src/media-type.js`). It used to be narrower here than there, so the
// same webp was ordinary wallpaper from a folder and invisible from a site.
//
// It is used TWICE and deliberately so: every answer is filtered by it, and it is also
// handed to the sites, so one that can narrow its own reply does not spend page slots on
// files that would only be dropped here. Asking and filtering must be the same list, or
// widening one of them silently does nothing.
const ACCEPTED_FORMAT_LIST = mediaFormats.WALLPAPER_FORMATS;

// Credentials are loaded by the site that needs them, once. Absence is normal: a build
// without a key simply cannot ask that site, and its group falls through to the next.
const providerCredentialsCache = new Map();
function providerCredentials(descriptor) {
  if (!descriptor) return null;
  // ONL-014c. A SESSION is asked for every single time. A key in a file is the same all
  // day; an account session appears and disappears while the app runs, and a cached one
  // would keep a signed-out user looking signed in until the next restart.
  if (descriptor.credentials && descriptor.credentials.kind === 'session') return appSession();
  if (!providerCredentialsCache.has(descriptor.id)) {
    let value = null;
    try {
      value = typeof descriptor.loadCredentials === 'function' ? descriptor.loadCredentials() : null;
    } catch (err) {
      console.error(`${descriptor.id} credentials:`, err);
    }
    providerCredentialsCache.set(descriptor.id, value || null);
  }
  return providerCredentialsCache.get(descriptor.id);
}

// ONL-014c. The account session, as the one site that needs it sees it. There is one
// account in Znada, so “session” needs no site name to be unambiguous.
//
// The typed client is handed over rather than rebuilt: the catalogue’s contract already
// lives in src/cloud/client.js, and a second copy inside an adapter would drift.
function appSession() {
  const client = cloudClient();
  if (!client) return null;
  const session = cloudSessionSnapshot();
  return {
    client,
    token: session.token || null,
    // Whether THIS account may be shown adult content. Carried with the session because
    // it belongs to the account, and asking for what the server will refuse anyway just
    // spends a request to be told no.
    explicitAllowed: !!(_cloudUser && _cloudUser.user && _cloudUser.user.explicit_opt_in),
    // A successful response is account-owned too. The shared provider path checks this
    // after await so catalogue A cannot be rendered after the user moved to account B.
    isCurrent: () => cloudSessionIsCurrent(session),
    // A refused session has to be dropped where sessions are kept, not inside a site.
    onAuthError: (res) => cloudHandleAuthError(res, session),
  };
}

// Which sources the user has switched on. A site declares WHICH switch it belongs to;
// the handler never works it out from what kind of site it is.
function sourceEnabled(descriptor) {
  return onlineSources.enabled(config && config.onlineSources, descriptor);
}
// The one way any site reaches the network. Timeouts, headers and the wording of a
// failure are the handler's business, so a new site inherits all of it and cannot get
// them subtly wrong. Never throws: a site that breaks must drop out of the round, not
// take the round down.
function providerFetchJson(descriptor) {
  return async (url, opts) => {
    const timeoutMs = Number(opts && opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': INTERNET_USER_AGENT, ...(descriptor.requestHeaders || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { error: String(res.status) };
      return { json: await res.json() };
    } catch (err) {
      return { error: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
  };
}

function providerContext(descriptor, credentials = providerCredentials(descriptor)) {
  return {
    credentials,
    fetchJson: providerFetchJson(descriptor),
  };
}

// Is this a picture Znada can use?
//
// The sites used to decide this themselves and throw the rest away before the app could
// see it — which is why a video from a board was unreachable no matter what the app
// learned. They now report the format and this decides, once, against the one list.
//
// ONL-015: a site that CANNOT state a format is not judged on it. Our own catalogue does
// not carry one on a browse card, and it is ours — what is in it is our doing, so it
// vouches for its content instead. Which of the two a site is, it declares; a site that
// said it states formats and then sends a card without one is refused, not excused.
function usableCard(item, descriptor) {
  if (!item) return false;
  const states = !descriptor || !descriptor.capabilities || descriptor.capabilities.cardFormat !== false;
  return states ? mediaFormats.isWallpaperFormat(item.format) : true;
}

// An item arriving over IPC is input, even if it originally came from our own renderer.
// The feed already applies the format rule, but every network/disk boundary must repeat
// it so a direct invoke cannot turn an allowed image host into a WebM downloader.
function usableInternetDownload(item) {
  if (!online.allowedDownloadUrl(item) || !mediaFormats.isWallpaperFormat(item && item.format)) return false;
  try {
    const urlFormat = path.extname(new URL(item.full).pathname);
    return mediaFormats.sameWallpaperFormat(item.format, urlFormat);
  } catch {
    return false;
  }
}

async function searchOneProvider(descriptor, params) {
  if (!descriptor) return { provider: '', items: [], meta: {}, error: 'unsupported' };
  const blank = { provider: descriptor.id, items: [], meta: {}, error: null };
  if (typeof descriptor.search !== 'function') return { ...blank, error: 'unsupported' };
  const credentials = providerCredentials(descriptor);
  if (descriptor.credentials && descriptor.credentials.required && !credentials) {
    return { ...blank, error: 'unavailable' };
  }
  let res;
  try {
    // The format rule travels WITH the request. A site that can narrow its own reply
    // does so; one that cannot simply ignores it and is filtered below instead.
    res = await descriptor.search(
      { ...(params || {}), formats: ACCEPTED_FORMAT_LIST },
      providerContext(descriptor, credentials),
    );
  } catch (err) {
    console.error(`${descriptor.id} search:`, err);
    return { ...blank, error: 'network' };
  }
  if (credentials && typeof credentials.isCurrent === 'function' && !credentials.isCurrent()) {
    return { ...blank, error: 'session_changed' };
  }
  if (!res || res.error) return { ...blank, error: (res && res.error) || 'network' };
  return {
    provider: descriptor.id,
    // The one thing a window has to know about a site: whether it may load the image
    // itself. Some hosts refuse a request that does not say where it came from, and a
    // window cannot send that — so those go through main. Carried ON THE CARD, so the
    // windows never have to hold the registry or name a site.
    items: (Array.isArray(res.items) ? res.items : []).filter((item) => usableCard(item, descriptor))
      .map((item) => ({
        ...item,
        loadsDirectly: !!descriptor.loadsDirectly,
        // ONL-014c. What KIND of card this is: one with a lasting page and file, or one
        // whose file is minted on demand. Declared by the site, carried on the card, so
        // no window has to ask which site a picture came from.
        cardKind: descriptor.cardKind || 'internet',
      })),
    meta: res.meta || {},
    error: null,
  };
}

// Sites in one group are ALTERNATIVES — the same kind of pictures from a different
// place — so they are asked in order until one answers, and only the answer is used.
// This is what the hardwired Gelbooru→Danbooru pair became; a third alternative is now
// a row in the registry rather than another branch here.
// ONL-005: SEARCH no longer uses this. `searchRound` gives every chosen site its own
// group, because a site the user switched off must not return as somebody's replacement.
// The mechanism stays for a caller that does want alternatives; today none does.
// ONL-014b. `attempts` collects every member that was actually ASKED, with the exact
// parameters it was asked with. Alternatives page independently of one another, so the
// one that answered this round has to carry on from where IT got to — a single "the
// group is on page N" would put the fallback back at the beginning the moment the
// primary recovered.
async function searchProviderGroup(members, buildParams, attempts) {
  let carried = null;
  for (const descriptor of members) {
    const params = buildParams(descriptor);
    const result = await searchOneProvider(descriptor, params);
    if (attempts) attempts.push({ descriptor, params, result });
    if (!online.providerFailed(result)) {
      if (carried) console.warn(`${carried.provider} unavailable (${carried.error}); using ${descriptor.id} instead`);
      return carried ? online.resolveFallback(carried, result) : result;
    }
    carried = carried ? online.resolveFallback(carried, result) : result;
  }
  return carried || { provider: '', items: [], meta: {}, error: 'network' };
}

// Every group that can answer this kind of request, in registry order. Retired sites are
// absent; a site that declares it cannot browse is absent too.
function searchableGroups(list) {
  const groups = new Map();
  for (const descriptor of Array.isArray(list) ? list : []) {
    if (!descriptor) continue;
    // Checked HERE and not only by whoever assembled the list: "a retired site is never
    // asked for new pictures" has to hold however the list was put together.
    if (descriptor.status === 'retired') continue;
    if (!descriptor.capabilities || !descriptor.capabilities.browse) continue;
    const key = descriptor.group || descriptor.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(descriptor);
  }
  return Array.from(groups.values());
}

// The list is passed in rather than fetched here: a wrapper that quietly reaches for
// the wrong list is exactly the kind of wiring a test cannot see, and this way there is
// no wrapper to get wrong.
// Returns the answers AND a record of who was asked what, because "carry on from here"
// is decided per site and cannot be reconstructed from the merged answer.
async function searchAllProviders(buildParams, list) {
  const members = Array.isArray(list) ? list : providerRegistry.active();
  const attempts = [];
  const results = await Promise.all(
    searchableGroups(members).map((group) => searchProviderGroup(group, buildParams, attempts)),
  );
  return { results, attempts };
}

// BUG-020 — the front page is OURS, a search is the user's.
//
// Until somebody types something we are not filtering anything; we are choosing what to
// put in front of them, and that is a different job with different rules. The measured
// problem was that we had never made that choice deliberately: the newest uploads on
// Wallhaven, with every category enabled, are mostly photo shoots of people (56% of a
// page, against 8 landscapes in 48), and the anime board was asked for four times as
// many cards as Wallhaven, so the feed alternated for one screen and then became one
// site for the rest of the page (79% of it).
//
// So while the search box is empty:
//   * Wallhaven is asked WITHOUT the `people` category. This is not a content rating —
//     a perfectly safe portrait is still `people`, which is why turning the rating down
//     does not remove them (measured: 56% -> 31%, not 0%);
//   * both sites are asked for the SAME number of cards, so the feed keeps alternating
//     all the way down instead of turning into one site after the first screen;
//   * both are asked for two orderings at once — what is new and what is well rated —
//     and the result is shuffled into one feed.
//
// The moment the user types anything, none of this applies: they asked for something
// specific and they get it, with every category and their own chosen ordering. The one
// thing that DOES cross over is the content rating, because that is their standing
// answer to "what am I willing to see", not our curation.
const BROWSE_CATEGORIES = '110';     // general + anime, no people
const SEARCH_CATEGORIES = '111';     // a search is not curated
const BROWSE_PAGE_SIZE = 24;         // Wallhaven's own page size; the booru matches it
const BROWSE_SORTS = ['date_added', 'toplist'];
// Wallhaven's "top" is scoped to the last month by default, so it renews on its own.
// Gelbooru has no such window — verified 2026-08-25: it rejects every date-scoped form
// of the query — so its "top" is ALL TIME and would hand back the identical cards on
// every launch. Starting from a random slice of that top keeps the ordering the owner
// asked for and still varies, which is the whole point of putting it on the front page.
const BROWSE_TOP_SLICES = 10;
// Injected so a test can pin the order and the slice; production uses Math.random.
let browseRandom = Math.random;

// ONL-014b. Where such a site STARTS, chosen once. It used to be re-rolled on every
// press of "show more", which meant a second press could ask for a slice already seen —
// the grid drops what it already has, so the button did the work and added nothing.
// Now the dice are thrown when the site has no bookmark yet, and from then on it simply
// walks forward (owner's decision, 2026-08-27).
function browseTopStartPage() {
  return 1 + Math.floor(browseRandom() * BROWSE_TOP_SLICES);
}

// Where this site should carry on from, for this ordering.
// ONL-005 task 3: the random slice is front-page curation only. A search is the user's
// question and starts at the top of its answer — sliced, a rare tag with a page or two of
// results started past its end and read as "nothing found" on Top.
function positionFor(token, descriptor, sorting, browsing = false) {
  const key = onlineResume.slotKey(descriptor.id, sorting);
  const at = onlineResume.positionOf(token, key);
  if (at !== undefined) return at;                    // null means finished
  return browsing && sorting === 'toplist' && descriptor.capabilities && descriptor.capabilities.topIsAllTime
    ? browseTopStartPage()
    : 1;
}

// One round of asking, for one ordering. Sites that have already said "nothing more" are
// not asked at all — the measured waste this whole change is about.
// The list is a parameter for the same reason it is everywhere else in this file: the
// wiring between a stored bookmark and the parameters a site is handed cannot be proved
// with the shipped sites alone, and a wrapper that quietly reaches for the wrong list is
// exactly the kind of thing a test cannot see.
async function searchRound(token, sorting, extra, list, browsing = false) {
  const live = (Array.isArray(list) ? list : providerRegistry.active())
    .filter(sourceEnabled)
    .filter((descriptor) => !onlineResume.isFinished(token, onlineResume.slotKey(descriptor.id, sorting)));
  if (!live.length) return { results: [], attempts: [] };
  return searchAllProviders((descriptor) => {
    const at = positionFor(token, descriptor, sorting, browsing);
    return {
      ...extra,
      // ONL-017. Ask for MORE, not more often. A site that cannot narrow by shape sends a
      // page that is mostly discarded here, so while the filter is on it is asked for its
      // biggest page — one request instead of several. Which sites those are is read from
      // their own declarations, never from their names; a site that narrows properly gets
      // the ordinary page it always got.
      limit: extra && extra.sizeHints
        ? sizeFilter.pageSizeFor(extra.limit, (descriptor.capabilities || {}).sizeFilter)
        : extra && extra.limit,
      sort: sorting,
      // ONL-014c. A bookmark is whatever the site said it was. Sites that count pages
      // read `page`; the one that hands back an opaque marker reads `cursor`. Which of
      // the two it is, is the shape of the value, not a question about which site it is.
      page: typeof at === 'number' ? at : 1,
      cursor: typeof at === 'string' ? at : '',
    };
  // ONL-005: chosen sites are independent search sources. Group alternatives remain
  // a lower-level mechanism for other callers, but cannot silently replace a choice.
  }, live.map((descriptor) => ({ ...descriptor, group: descriptor.id })));
}

// Write down where everyone got to. A site that failed keeps its bookmark and is asked
// the same piece again next time; only MAX_FAILS in a row finishes it.
function recordRound(token, attempts) {
  for (const attempt of attempts) {
    const key = onlineResume.slotKey(attempt.descriptor.id, attempt.params.sort);
    const asked = attempt.params.cursor || attempt.params.page;
    if (online.providerFailed(attempt.result)) {
      onlineResume.record(token, key, asked, { failed: true });
    } else {
      onlineResume.record(token, key, asked, { next: onlineResume.nextFrom(attempt.result, asked) });
    }
  }
}

async function searchBrowseFeed(o, token) {
  const rounds = await Promise.all(BROWSE_SORTS.map((sorting) => searchRound(token, sorting, {
    ...o,
    q: '',
    categories: BROWSE_CATEGORIES,
    limit: BROWSE_PAGE_SIZE,
  }, undefined, true)));
  const results = rounds.flatMap((round) => round.results);
  rounds.forEach((round) => recordRound(token, round.attempts));
  if (!rounds.some((round) => round.attempts.length)) return nobodyLeft();
  // mergeSearchResults does the deduplication — a picture that is both new and well
  // rated must appear once — and the shuffle then removes the two orderings' rhythm.
  const merged = online.mergeSearchResults(results);
  return { ...merged, items: online.shuffle(merged.items, browseRandom) };
}

async function searchQueryFeed(o, token) {
  const sorting = String(o.sort || 'date_added');
  const round = await searchRound(token, sorting, { ...o, categories: SEARCH_CATEGORIES });
  recordRound(token, round.attempts);
  if (!round.attempts.length) return nobodyLeft();
  return online.mergeSearchResults(round.results);
}

// Everyone has already said "nothing more". That is not a failure and must not be
// dressed as one: "no answers" means the same thing as "everybody refused" to
// mergeSearchResults, and only the caller knows which of the two actually happened.
function nobodyLeft() {
  return { items: [], meta: {}, error: null, providerErrors: {} };
}

// ONL-010. How many cards are worth one press before we stop trying to top the page up.
// Deliberately modest: on an anime board a strict 16:9 leaves four cards in a hundred
// (measured 2026-09-03), so "fill the page" is not a promise anybody can keep, and
// chasing it would be the request storm BUG-020 had just finished limiting.
const SIZE_FILTER_MIN_CARDS = 12;
const SIZE_FILTER_EXTRA_ROUNDS = 2;

// The filter, applied. Sites are asked to narrow what they can — measured per site, in
// their own declarations — and then EVERY card is judged here, because a server given
// the loosest bound that covers several targets cannot decide the exact one, and one
// site (Gelbooru) cannot judge shape at all.
async function searchFiltered(o, token, browsing) {
  const targets = sizeFilter.effectiveTargets(config.onlineSizeFilter, monitorsCache);
  const run = (extra) => (browsing
    ? searchBrowseFeed({ ...o, ...extra }, token)
    : searchQueryFeed({ ...o, ...extra }, token));
  if (!targets.length) return run({});

  const hints = sizeFilter.serverHints(targets);
  const keep = (items) => (Array.isArray(items) ? items : [])
    .filter((item) => sizeFilter.matches(item, targets));

  const first = await run({ sizeHints: hints });
  let merged = { ...first, items: keep(first.items) };
  // Ask for more of the same rather than more often: a wider page is one request, and a
  // site that filters on its own side will simply return a full one.
  for (let round = 0; round < SIZE_FILTER_EXTRA_ROUNDS; round++) {
    if (o.sourcesKey !== onlineSources.signature(config.onlineSources)) break;
    if (merged.items.length >= SIZE_FILTER_MIN_CARDS) break;
    const next = await run({ sizeHints: hints });
    const gained = keep(next.items);
    // Nobody left to ask, or nobody has anything that fits. Stop quietly and show the
    // shorter page — the owner's instruction was that the user must not be shown a
    // problem, not that the page must always be full.
    if (!gained.length && !(next.items || []).length) break;
    merged = {
      ...merged,
      items: online.mergeSearchResults([{ items: merged.items }, { items: gained }]).items,
      providerErrors: { ...(merged.providerErrors || {}), ...(next.providerErrors || {}) },
    };
  }
  return merged;
}

ipcMain.handle('internet-search', async (e, opts) => {
  const o = { ...(opts || {}), sourcesKey: onlineSources.signature(config.onlineSources) };
  // Both conditions, not just the renderer's flag: curation must never be able to
  // silently narrow a real search, whatever the renderer believes it asked for.
  const browsing = o.browse === true && !String(o.q || '').trim();
  // ONL-014b. The bookmarks travel with the request. They are the window's to carry and
  // nobody's to read — including the window's, which passes them back untouched. A token
  // that does not belong to this exact question is discarded rather than repaired.
  const token = onlineResume.parse(o.resume, onlineResume.signatureOf({ ...o, browse: browsing }));
  const merged = await searchFiltered(o, token, browsing);
  if (o.sourcesKey !== onlineSources.signature(config.onlineSources)) return { ...nobodyLeft(), resume: null };
  return {
    ...merged,
    browsing,
    resume: onlineResume.forReply(token),
    nsfwAvailable: explicitContentReachableIn(providerRegistry.active().filter(sourceEnabled)),
  };
});

// Headers a site's own hosts require. Declared by the site (some image hosts refuse a
// request that does not say where it came from) rather than special-cased here.
function internetRequestHeaders(item) {
  const descriptor = item ? providerRegistry.byId(item.provider) : null;
  return { 'User-Agent': INTERNET_USER_AGENT, ...((descriptor && descriptor.requestHeaders) || {}) };
}

/* ------------------------------------- PERF-010: the original main already has ---- */

/*
 * "Add to Library" used to download the original again although the viewer was showing
 * it. Where the bytes already are depends on the site, and the same declaration that
 * decides how the window loads the picture (`loadsDirectly`) decides it here:
 *   - booru originals reach the window through main's streaming proxy, so they passed
 *     through main; the proxy now keeps the last few complete ones (`recentOriginals`);
 *   - Wallhaven the window loads itself, so the original is in Chromium's HTTP cache of
 *     the same session, and main asks for it there with `force-cache`. Measured
 *     2026-09-25: 4.5 MB in 7 ms, against 253 ms for a new download.
 * A kept original is handed back as an ordinary Response, so the format check and the
 * content-addressed write in stageDownloadImage are the same code as before.
 */
const recentOriginals = originalStoreMod.createOriginalStore();
// The same picture added from the grid and from the viewer at once is downloaded once.
const addsInFlight = originalStoreMod.createInFlight();
// How long an add waits for an original the proxy is still fetching for the window
// before it fetches for itself. The proxy gives the site the same time.
const ORIGINAL_JOIN_WAIT_MS = 30000;

function originalFetchFor(item) {
  const descriptor = item ? providerRegistry.byId(item.provider) : null;
  if (descriptor && descriptor.loadsDirectly) {
    // A miss is not an error: force-cache then goes to the network the way the window does.
    return (url, init) => session.defaultSession.fetch(url, { ...init, cache: 'force-cache' });
  }
  return async (url, init) => {
    const kept = await recentOriginals.get(url, { waitMs: ORIGINAL_JOIN_WAIT_MS });
    if (kept) {
      return new Response(kept.bytes, { status: 200, headers: { 'Content-Type': kept.contentType } });
    }
    return fetch(url, init);
  };
}

// How to download the original of an online card, from wherever main already has it.
// The add and ensureCardFile (save as, copy, assign) take it the same way.
function onlineOriginalOptions(item) {
  return {
    headers: internetRequestHeaders(item),
    expectedFormat: item.format,
    fetchImpl: originalFetchFor(item),
  };
}

// Everything an add needs from the network, fetched together: the original and the
// site's extra request for tags (ONL-012). The tags used to be asked only after the
// download, with the library lock held across the request; now both run at once and
// neither is inside the lock, since neither touches anything shared.
async function fetchOnlineForAdd(item) {
  const [stored, extra] = await Promise.all([
    downloadWallpaperFromUrl(item.full, onlineOriginalOptions(item)),
    enrichProviderItem(item),
  ]);
  return { stored, extra };
}

// Can adult content be reached at all in THIS build?
//
// This used to be the constant `true` with a comment reasoning about which site covers
// it — a claim that quietly stopped being true when a site was removed or shipped
// without its key. Computed from the registry it cannot drift. It still describes what
// is CONFIGURED, not what is reachable this second: a site that is down right now is a
// separate problem, and pretending otherwise would need failure tracking this does not
// have.
// The list is a parameter so the rule can be tested against sites that do not exist —
// the whole point being that it follows the registry rather than asserting a constant.
function explicitContentReachableIn(list) {
  return (Array.isArray(list) ? list : []).some((descriptor) => {
    if (!descriptor) return false;
    const explicit = descriptor.capabilities && descriptor.capabilities.explicit;
    if (!explicit || explicit === 'never') return false;
    const needsKey = explicit === 'withCredentials'
      || (descriptor.credentials && descriptor.credentials.required);
    return needsKey ? !!providerCredentials(descriptor) : true;
  });
}



/* ------------------------------------------------- потоковый прокси картинок ---- */

/*
 * PERF-008. Картинки booru появлялись примерно на 1.5 с позже, чем могли бы: главный
 * процесс скачивал файл ЦЕЛИКОМ, кодировал в base64 и отдавал одной строкой через IPC.
 * Пока не проехало всё — окно не рисовало ничего, а строка потом оседала в его памяти.
 *
 * Убрать прокси нельзя: замер 2026-09-09 показал, что настоящее окно Electron получает от
 * `cdn.donmai.us` отказ за 151 мс. Дело не в `Referer` (Danbooru его вообще не шлёт и
 * получает 200), а в бот-защите Cloudflare, реагирующей на браузерную ФОРМУ запроса; её
 * окно изменить не может — `Sec-Fetch-*` ставит сам Chromium.
 *
 * Поэтому маршрут прежний, меняется форма: собственная схема отдаёт байты ПОТОКОМ, окно
 * рисует с первых байт, а все проверки остаются здесь же, где стояли:
 *   1. принадлежность адреса объявленным хостам провайдера — те же `online.allowed*`;
 *   2. заголовки провайдера — тот же `internetRequestHeaders`;
 *   3. разбор MIME — тот же `online.thumbnailMime`;
 *   4. потолок размера — и по `content-length`, и ПО МЕРЕ чтения (см. ниже);
 *   5. таймаут.
 */
function registerMediaProxy() {
  protocol.handle(mediaProxy.SCHEME, async (request) => {
    const asked = mediaProxy.parseUrl(request.url);
    if (!asked) return new Response('bad request', { status: 400 });

    /*
     * Проверка ТА ЖЕ, что была на IPC-пути, и намеренно выбирается по ступени: у превью
     * свой список хостов, и провайдер, чьи превью грузятся окном напрямую, не объявляет
     * ни одного. Пустой список означает «никаких», а не «любые».
     */
    const item = { provider: asked.provider, [asked.field]: asked.url };
    const allowed = asked.field === 'thumb'
      ? online.allowedThumbnailUrl(item)
      : (asked.field === 'sample' ? online.allowedSampleFetchUrl(item) : online.allowedFullFetchUrl(item));
    if (!allowed) return new Response('forbidden', { status: 403 });

    let upstream;
    try {
      upstream = await fetch(asked.url, {
        headers: internetRequestHeaders(item),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      return new Response('upstream', { status: err && err.name === 'TimeoutError' ? 504 : 502 });
    }
    if (!upstream.ok) return new Response('upstream', { status: upstream.status });

    const mime = online.thumbnailMime(upstream.headers.get('content-type'));
    if (!mime) return new Response('unsupported', { status: 415 });
    const declared = Number(upstream.headers.get('content-length')) || 0;
    if (mediaProxy.overLimit(declared, asked.limit)) return new Response('too large', { status: 413 });
    if (!upstream.body) return new Response('empty', { status: 502 });

    /*
     * Потолок проверяется ПО МЕРЕ чтения, а не после. В этом весь смысл потока: «после
     * загрузки» не наступает, пока файл не доехал, — а рвать соединение надо раньше.
     * Заголовку `content-length` доверять нельзя: его может не быть или он может лгать.
     *
     * PERF-010. Оригинал (и только он — не промежуточная ступень) заодно остаётся у главного
     * процесса: «Додати» той же картинки возьмёт эти байты, а не скачает их второй раз.
     * Сохраняется лишь ЦЕЛИКОМ дошедший ответ; оборванный, сбойный или перешедший потолок —
     * `fail`, и ждущее добавление скачает само. Поэтому поток читается вручную: у него есть
     * `cancel`, по которому видно, что окно бросило загрузку (ушло на другое фото).
     */
    const keep = asked.field === 'full' ? recentOriginals.begin(asked.url) : null;
    const kept = [];
    let seen = 0;
    const reader = upstream.body.getReader();
    const capped = new ReadableStream({
      async pull(controller) {
        let step;
        try {
          step = await reader.read();
        } catch (err) {
          if (keep) keep.fail();
          controller.error(err);
          return;
        }
        if (step.done) {
          if (keep) keep.finish(Buffer.concat(kept), mime);
          controller.close();
          return;
        }
        const chunk = step.value;
        seen += chunk.byteLength;
        if (mediaProxy.overLimit(seen, asked.limit)) {
          if (keep) keep.fail();
          reader.cancel().catch(() => {});
          controller.error(new Error('too large'));
          return;
        }
        // A copy: what is enqueued belongs to the window's side from here on.
        if (keep) kept.push(Buffer.from(chunk));
        controller.enqueue(chunk);
      },
      cancel(reason) {
        if (keep) keep.fail();
        return reader.cancel(reason);
      },
    });

    return new Response(capped, {
      status: 200,
      headers: { 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600' },
    });
  });
}





// ONL-012. The per-card extra request, asked of whoever declares one.
//
// Never fatal and never noisy: a site that cannot answer just gives nothing more, and
// the picture keeps whatever the search response already carried.
async function enrichProviderItem(item) {
  const descriptor = item ? providerRegistry.byId(item.provider) : null;
  if (!descriptor || typeof descriptor.enrich !== 'function') return { author: '', tags: [] };
  let extra;
  try {
    extra = await descriptor.enrich(item, providerContext(descriptor));
  } catch (err) {
    console.error(`${descriptor.id} enrich:`, err);
    return { author: '', tags: [] };
  }
  return {
    author: String((extra && extra.author) || '').trim(),
    tags: Array.isArray(extra && extra.tags) ? extra.tags : [],
  };
}

ipcMain.handle('internet-add', async (e, item, query) => {
  if (!usableInternetDownload(item)) return { config, error: 'badItem' };
  try {
    // The download itself is outside the lock — it is slow and touches nothing shared.
    // Everything from "this file is now ours" onwards is inside it: a re-download lands
    // on the same content-addressed path a "delete from disk" may be aiming at.
    // PERF-010: the grid and the viewer adding this picture at once share one download.
    const { stored, extra } = await addsInFlight.run(
      'internet:' + String(item.full).trim(),
      () => fetchOnlineForAdd(item),
    );
    return await withLibraryLock(async () => {
      const width = Number(item.width); const height = Number(item.height);
      const aspect = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? width / height : 0;
      const id = addToPool('image', stored, { aspect });
      const it = config.library[id];
      if (it) {
        // DATA-005. Every field goes through updateItem: assigning straight onto the
        // record leaves its revision untouched, and an untouched revision loses the
        // next merge — which is the silent loss this whole task is about.
        library.updateItem(config.library, id, {
          source: online.allowedPageUrl(item) ? item.page : '',
        });
        if (typeof item.artist === 'string' && item.artist.trim()) {
          library.updateItem(config.library, id, { author: item.artist.trim().slice(0, 120) });
        }
        // Some sites hide part of the metadata behind a per-item endpoint. ONL-012: the
        // extra request is a hook the site declares, asked on the explicit download
        // (fetchOnlineForAdd) and never for a card in the feed. A site without one simply
        // has nothing more to give, and nothing here needs to know which site that is.
        if (!it.author && extra.author) {
          library.updateItem(config.library, id, { author: extra.author });
        }
        const extraTags = extra.tags;
        (Array.isArray(item.tags) ? item.tags : []).slice(0, 24).forEach((tag) => {
          if (typeof tag === 'string') library.addTag(config.library, id, tag.slice(0, 80));
        });
        // Gelbooru: the artist tag is usually outside the search response's 24-tag cap.
        // Wallhaven: the search response has no tags at all. Either way these are the
        // tags the user expects to find the picture by.
        extraTags.forEach((tag) => library.addTag(config.library, id, tag.slice(0, 80)));
        String(query || '').slice(0, 500).split(/[\s,]+/).filter(Boolean).slice(0, 20)
          .forEach((tag) => library.addTag(config.library, id, tag.slice(0, 80)));
      }
      saveConfig();
      return { config, id, error: null };
    });
  } catch (err) {
    console.error('internet add:', err);
    return { config, error: 'download' };
  }
});

// ---------------------------------------------------------------------------
// META-001 — what an online catalogue knows about a file the user already has
// ---------------------------------------------------------------------------
//
// The question travels as a FINGERPRINT and nothing else: no bytes, no filename and no
// path leave the machine. What comes back — tags, artist, rating, the post's page — is
// written onto the photo's own record, so a picture the user brought himself ends up
// describing itself the same way a downloaded one does. That parity is the point.
//
// Three protections, because there are three separate ways to get this wrong:
//
//   * a wrong answer. The catalogue is asked for an exact hash, and the post that comes
//     back is CHECKED to carry that same hash before a single tag is believed. Attaching
//     somebody else's tags to the user's photo is worse than finding nothing.
//   * losing something the user wrote. The merge only fills blanks for fields a person
//     can set himself — see metadataLookup.planFor.
//   * a ban. Every request passes the budget; every question is remembered against the
//     fingerprint, so the same bytes are asked about once ever, no matter how many
//     copies or how many clicks; and the work runs one at a time.
//
// Deliberately manual for now: one photo, one explicit action. The queue and the budget
// exist anyway, because "look up everything as it is added" is meant to arrive later as
// a different CALLER of this same path rather than as a second, unbudgeted one.

// The thumbnail queue's primitive, at concurrency one. A manual click is high priority
// so that a future background sweep can never make the user wait behind it.
const metadataQueue = createTaskQueue(1);
const METADATA_MANUAL_PRIORITY = 10;

// Hashing reads every byte, so a pathological file is refused rather than holding the
// queue for minutes. No wallpaper comes close to this.
const MAX_FINGERPRINT_BYTES = 256 * 1024 * 1024;

// Per-provider traffic state. Kept in memory only: after a restart the journal still
// prevents repeat questions, and starting with a full bucket costs at most a few
// requests that the host was going to allow anyway.
const metadataBudgets = new Map();
// The live limits. An object rather than the module defaults so a test can loosen them
// without waiting out real seconds — the alternative is a suite that either takes
// minutes or, worse, quietly stops exercising the limiter at all.
let metadataBudgetConfig = null;
// Only the ordinary intra-operation separation is worth waiting inside the sole worker.
// A long/custom host policy must surface as busy rather than monopolise the queue.
const METADATA_INLINE_GAP_WAIT_MAX_MS = 1000;

function metadataBudgetTake(providerId, now) {
  const gate = requestBudget.take(metadataBudgets.get(providerId), now, metadataBudgetConfig);
  if (gate.allowed) metadataBudgets.set(providerId, gate.state);
  return gate;
}

function metadataBudgetNote(providerId, ok, now, kind) {
  const state = metadataBudgets.get(providerId);
  metadataBudgets.set(providerId, ok
    ? requestBudget.noteSuccess(state, now, metadataBudgetConfig)
    : requestBudget.noteFailure(state, now, kind, metadataBudgetConfig));
}

// One request through the budget. Returns a tagged outcome instead of throwing, so the
// caller never has to guess whether a failure was the host refusing, the network, or
// simply our own limiter saying "not yet".
async function metadataFetchJson(providerId, url, timeoutMs = 10000) {
  let gate = metadataBudgetTake(providerId, Date.now());
  // The minimum host gap separates REQUESTS, not user operations. Gelbooru legitimately
  // needs a second request for tag kinds after it found the post. Returning `busy` here
  // silently made that enrichment partial forever because the found result is journalled
  // and never asked again. Wait only for the short gap; rate exhaustion and host backoff
  // remain immediate refusals so a burst or a 429 can never turn into an unbounded queue.
  const gapMs = Number(gate.retryAfterMs);
  if (!gate.allowed && gate.reason === 'gap'
      && Number.isFinite(gapMs) && gapMs > 0 && gapMs <= METADATA_INLINE_GAP_WAIT_MAX_MS) {
    const waitMs = Math.max(1, Math.ceil(gapMs) + 1);
    await new Promise((resolve) => { setTimeout(resolve, waitMs); });
    gate = metadataBudgetTake(providerId, Date.now());
  }
  if (!gate.allowed) return { blocked: true, reason: gate.reason, retryAfterMs: Math.ceil(gate.retryAfterMs) };
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': INTERNET_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      metadataBudgetNote(providerId, false, Date.now(), requestBudget.failureKind(res.status, null));
      return { failed: true, reason: String(res.status) };
    }
    const json = await res.json();
    metadataBudgetNote(providerId, true, Date.now());
    return { json };
  } catch (err) {
    metadataBudgetNote(providerId, false, Date.now(), requestBudget.failureKind(0, err));
    return { failed: true, reason: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

function hashFileMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// The file's fingerprint, from cache when the file has not changed since it was hashed.
// Streamed rather than read whole: a fingerprint is needed for files far larger than a
// thumbnail, and holding one in memory for the sake of one hash is pure waste.
async function fingerprintForFile(filePath, kind = 'md5') {
  const store = metadataCacheStore();
  const key = fingerprint.fileKey(filePath);
  // BUG-026. Hashing is streamed, so the file can be replaced WHILE it is being read —
  // a live folder rescan, a re-download, any outside tool. The hash would then be of the
  // new bytes while the size and mtime recorded beside it belong to the old ones, and
  // that pairing is what gets cached: every later lookup of this photo would ask a
  // catalogue about a file that never existed. So the stamp is taken again afterwards
  // and must still match. One retry, because a single swap is ordinary; a file being
  // rewritten continuously is not something to keep chasing.
  for (let attempt = 0; attempt < 2; attempt++) {
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch { return { error: 'missing' }; }
    if (!stat.isFile()) return { error: 'missing' };
    if (stat.size <= 0 || stat.size > MAX_FINGERPRINT_BYTES) return { error: 'unsupported' };

    const stamp = fingerprint.stampOf(stat);
    const cached = fingerprint.valueOf(store.files[key], stamp, kind);
    if (cached) return { value: cached, cached: true, stamp };

    let value;
    try {
      value = await hashFileMd5(filePath);
    } catch (err) {
      console.error('metadata fingerprint:', err);
      return { error: 'unreadable' };
    }

    let after;
    try {
      after = await fs.promises.stat(filePath);
    } catch { return { error: 'missing' }; }
    if (!fingerprint.sameStamp(fingerprint.stampOf(after), stamp)) continue;

    const entry = fingerprint.withValues(store.files[key], stamp, { [kind]: value });
    // `at` belongs to the store, not to the pure fingerprint shape: it is only there so
    // eviction can drop the least recently touched file rather than an arbitrary one.
    store.files[key] = Object.assign({}, entry, { at: Date.now() });
    markMetadataDirty();
    return { value, cached: false, stamp };
  }
  return { error: 'changed' };
}

// A post is only believed when it carries the very hash we asked about. Gelbooru's
// `md5:` term is an ordinary search term, and a search that silently ignored it would
// otherwise hand back an arbitrary picture — with tags that would then be written onto
// the user's photo.
//
// BUG-026. This used to demand a match only when the post HAD a hash, so a post that
// carried none was accepted by default — and that is not a rare shape: Danbooru omits
// the file fields on restricted and deleted posts, and both adapters turn a missing
// field into an empty string. "I cannot tell you which file this is" is not the same
// answer as "this is your file", and only one of them may write tags onto a photo.
//
// Both sides are normalised first, because the other half of exactness is not being
// needlessly strict: a catalogue that spells the same hash in capitals has answered our
// question, and refusing it would report "not found" for a photo it does hold.
function normalizedFingerprint(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function postMatchesHash(summary, hash) {
  if (!summary) return false;
  const claimed = normalizedFingerprint(summary.md5);
  const asked = normalizedFingerprint(hash);
  return !!claimed && !!asked && claimed === asked;
}

// ONL-013. One way to ask a site "which post IS this exact file", for every site.
//
// There used to be a hand-written function per site here, plus a small table mapping an
// id to one of them — the same shape `ONL-012` removed from the search path, still alive
// on this one, and a second list of sites beside the registry's. A site now DECLARES
// that it can be searched by fingerprint and provides the hook; nothing below names one.
//
// The BUDGET is what makes this path different from the search path, and it stays here
// rather than in the sites: every request is metered, and a refusal by our own limiter
// is not the same thing as a failure by the host. The site sees an ordinary failure —
// it never has to learn the word — while this remembers that the refusal was OURS, so
// the answer becomes "busy, try later" and nothing is written to the journal. Nothing
// was asked, so nothing is known.
function metadataContext(descriptor) {
  const state = { blocked: null };
  return {
    credentials: providerCredentials(descriptor),
    state,
    fetchJson: async (url, opts) => {
      const timeoutMs = Number(opts && opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10000;
      const res = await metadataFetchJson(descriptor.id, url, timeoutMs);
      if (res.blocked) {
        if (!state.blocked) state.blocked = { reason: res.reason, retryAfterMs: res.retryAfterMs };
        return { error: res.reason || 'busy' };
      }
      if (res.failed) return { error: res.reason || 'network' };
      return { json: res.json };
    },
  };
}

async function askProviderForFingerprint(descriptor, kind, hash) {
  if (!descriptor || typeof descriptor.findByFingerprint !== 'function') {
    return { status: 'error', reason: 'unsupported' };
  }
  if (descriptor.credentials && descriptor.credentials.required && !providerCredentials(descriptor)) {
    return { status: 'error', reason: 'unavailable' };
  }
  const ctx = metadataContext(descriptor);
  let res;
  try {
    res = await descriptor.findByFingerprint(kind, hash, ctx);
  } catch (err) {
    console.error(`${descriptor.id} fingerprint lookup:`, err);
    res = { error: 'network' };
  }
  // A post FIRST, and only then the limiter. A site whose extra request was refused —
  // Gelbooru asks separately for tag kinds — has still found the picture, and answering
  // "busy" would throw away an answer already in hand.
  if (res && res.result) {
    // Checked HERE, once, for every site, and never delegated to the site itself:
    // `md5:` is an ordinary search term, so a catalogue that quietly ignored it would
    // hand back an arbitrary picture — whose tags would then be written onto the user's
    // photo. A site that forgot this check would be indistinguishable from one that did.
    return postMatchesHash(res.result, hash)
      ? { status: 'found', result: res.result }
      : { status: 'absent', reason: 'mismatch' };
  }
  if (ctx.state.blocked) {
    return { status: 'busy', reason: ctx.state.blocked.reason, retryAfterMs: ctx.state.blocked.retryAfterMs };
  }
  if (!res || typeof res !== 'object' || res.error) {
    return { status: 'error', reason: (res && res.error) || 'network' };
  }
  // "Not here" is an ANSWER, not a failure, and it rests for a MONTH where a failure
  // rests for an hour — so a site has to say it explicitly. An answer we cannot read is
  // a failure: silently reading it as "not here" would silence a findable photo for a
  // month on the strength of a shape we did not understand.
  if (res.result === null) return { status: 'absent' };
  return { status: 'error', reason: 'malformed' };
}

// Which sites are holding the key they declared they need. Only sites that require one
// appear at all: for the rest the question does not arise.
function metadataCredentials() {
  const map = {};
  for (const descriptor of providerRegistry.active()) {
    if (descriptor.credentials && descriptor.credentials.required) {
      map[descriptor.id] = !!providerCredentials(descriptor);
    }
  }
  return map;
}

// Ask whoever still has something to say about this fingerprint, in order, stopping at
// the first real answer. A provider that is merely rate-limited right now does NOT get
// journalled: nothing was asked, so nothing is known, and the next click may try again.
async function lookupByFingerprint(kind, hash) {
  const store = metadataCacheStore();
  const key = metadataLookup.journalKey(kind, hash);
  if (!key) return { status: 'error', reason: 'badFingerprint' };

  const known = metadataLookup.normalizeEntry(store.lookups[key]);
  if (known.result) return { status: 'found', result: known.result, cached: true };

  const now = Date.now();
  const pending = metadataLookup.pendingProviders(store.lookups[key], kind, now, {
    credentials: metadataCredentials(),
  });
  if (!pending.length) {
    // Nothing to ask is not the same as nothing being there. A catalogue that was
    // UNREACHABLE an hour ago has not told us the picture is absent, so reporting a
    // miss would be a lie the user acts on — he would stop pressing the button.
    const reasons = metadataLookup.providersFor(kind, { credentials: metadataCredentials() })
      .map((id) => metadataLookup.shouldAsk(store.lookups[key], id, now).reason);
    if (!reasons.length) return { status: 'error', reason: 'noProvider', settled: true };
    // BUG-032. `some`, not `every`. Absence is a claim about EVERY catalogue that could
    // have answered, so one of them still resting after an error is enough to make the
    // claim unsupportable — and the mixed state (one answered "not here", the other timed
    // out) is the common one in real life, not the rare one. The earlier `every` demanded
    // that ALL of them be unreachable before it would admit uncertainty, so the ordinary
    // case was reported as a definite "no catalogue has this file". A miss is remembered
    // for a month, so that answer stuck and pressing the button again did not re-ask.
    if (reasons.some((reason) => reason === 'errorRecently')) {
      return { status: 'error', reason: 'errorRecently', settled: true };
    }
    return { status: 'absent', reason: reasons[0], settled: true };
  }

  let lastError = null;
  for (const providerId of pending) {
    // Never throws: a site that breaks drops out of this round the same way it drops out
    // of a search round.
    const outcome = await askProviderForFingerprint(providerRegistry.byId(providerId), kind, hash);
    if (outcome.status === 'busy') { lastError = outcome; continue; }
    store.lookups[key] = Object.assign(
      metadataLookup.recordOutcome(store.lookups[key], providerId, outcome, Date.now()),
      { at: Date.now() },
    );
    markMetadataDirty();
    if (outcome.status === 'found') {
      return { status: 'found', result: metadataLookup.normalizeEntry(store.lookups[key]).result, provider: providerId };
    }
    if (outcome.status === 'error') lastError = outcome;
  }
  return lastError && lastError.status === 'busy'
    ? { status: 'busy', reason: lastError.reason, retryAfterMs: lastError.retryAfterMs }
    : (lastError ? { status: 'error', reason: lastError.reason } : { status: 'absent' });
}

// Write a found result onto one pool record. Re-reads the item AFTER the network work:
// the user may have removed the photo while the request was in flight, and reviving a
// removed record by writing tags to it is exactly the class of resurrection DATA-005
// was about.
function applyLookupToItem(id, result) {
  const item = library.getItem(config.library, id);
  if (!item) return { applied: false, reason: 'missing' };
  const plan = metadataLookup.planFor(item, result);
  if (metadataLookup.planIsEmpty(plan)) return { applied: false, reason: 'nothingNew', plan };
  // Every field goes through the library's own mutators so the record's revision moves
  // with it; a direct assignment would leave it looking older than it is and lose the
  // next merge.
  library.updateItem(config.library, id, plan.patch);
  let added = 0;
  for (const tag of plan.tags) {
    if (library.addTag(config.library, id, tag)) added++;
  }
  savePoolOnly();
  return { applied: true, added, plan };
}

// The renderer's whole view of one lookup. Deliberately flat and provider-agnostic:
// the interface says what happened, not which catalogue happened to answer.
function metadataLookupReply(outcome, applied) {
  const result = outcome.result || null;
  return {
    status: outcome.status,
    reason: outcome.reason || '',
    cached: !!outcome.cached,
    retryAfterMs: Number(outcome.retryAfterMs) || 0,
    provider: result ? result.provider : (outcome.provider || ''),
    page: result ? result.page : '',
    author: result ? result.author : '',
    rating: result ? result.rating : '',
    tagCount: result ? result.tags.length : 0,
    addedTags: applied && applied.applied ? applied.added : 0,
    skipped: applied && applied.plan ? applied.plan.skipped : [],
  };
}

// Look up one pool photo: fingerprint it, ask whoever can answer, write what comes back.
// Split out of the IPC handler so tests can drive the real sequence — the order of these
// steps is precisely what a module-level test cannot see.
// BUG-026. What "the same photo" has to mean for the length of one lookup: the same
// record, still naming the same path, with the same bytes behind it. The network round
// trip takes seconds, and all three can change inside it — so the answer is checked
// against the world it was asked about, not against whatever is there when it arrives.
//
// `addedAt` is in here on purpose. A record removed and added again keeps its id (the id
// is derived from the path), so `getItem` still finds one; but it is a decision the user
// made AFTER this request, and tags fetched for the old one do not belong to it.
async function itemIdentityUnchanged(id, snapshot) {
  const item = library.getItem(config.library, id);
  if (!item || item.type !== 'image') return false;
  // Redundant while ids are derived from paths (`library.idFor`) and nothing patches a
  // record's `path` — checked, and a mutation removing this line survives the battery
  // because of it. Kept as a stated invariant rather than deleted: it costs nothing, and
  // the day an id stops being the path is the day this becomes the only thing that
  // notices. Do not "prove" it with a test that hand-writes a path a record cannot have.
  if (pathKey(item.path) !== snapshot.path) return false;
  if ((Number(item.addedAt) || 0) !== snapshot.addedAt) return false;
  let stat;
  try {
    stat = await fs.promises.stat(item.path);
  } catch { return false; }
  return fingerprint.sameStamp(fingerprint.stampOf(stat), snapshot.stamp);
}

async function runItemMetadataLookup(id) {
  const item = library.getItem(config.library, id);
  if (!item || item.type !== 'image') return { status: 'error', reason: 'unsupported' };
  const filePath = item.path;
  if (!isAuthorizedItemPath(filePath)) return { status: 'error', reason: 'denied' };

  return metadataQueue(async () => {
    // Re-read rather than close over the record above: this runs behind a queue, so the
    // wait before it starts is as real as the wait inside it.
    const current = library.getItem(config.library, id);
    if (!current || current.type !== 'image' || pathKey(current.path) !== pathKey(filePath)) {
      return metadataLookupReply({ status: 'error', reason: 'changed' }, null);
    }
    const print = await fingerprintForFile(filePath, 'md5');
    if (print.error) return metadataLookupReply({ status: 'error', reason: print.error }, null);
    const snapshot = {
      path: pathKey(current.path),
      addedAt: Number(current.addedAt) || 0,
      stamp: print.stamp,
    };
    const outcome = await lookupByFingerprint('md5', print.value);
    if (outcome.status !== 'found') return metadataLookupReply(outcome, null);
    if (!(await itemIdentityUnchanged(id, snapshot))) {
      // The journal still keeps what the catalogue said — the answer is about a
      // fingerprint, not about this record — so pressing the button again is cheap and
      // will write it to whatever is actually there now.
      return metadataLookupReply({ status: 'error', reason: 'changed' }, null);
    }
    return metadataLookupReply(outcome, applyLookupToItem(id, outcome.result));
  }, { priority: METADATA_MANUAL_PRIORITY });
}

// Manual, explicit, one at a time — the button the user pressed.
ipcMain.handle('item-lookup-metadata', async (e, id) => {
  return runItemMetadataLookup(id);
});

// resolved current image for a slot (renderer can't scan folders itself)
ipcMain.handle('current-image', (e, monitorId, which) => {
  const theme = which === 'dark' ? 'dark' : 'light';
  const id = config.singleWallpaper ? primaryMonitorId() : monitorId;
  const p = currentImageFor(id, theme);
  persistSlideshowPosition();
  return p;
});

// Превью папки для библиотеки: число картинок внутри + N подпапок + первые превью
// (renderer сам сканировать ФС не может). Папки не копируем — живое сканирование.
ipcMain.handle('folder-info', (e, dir) => {
  if (!isAuthorizedMediaPath(dir)) return { count: 0, subfolders: 0, previews: [] };
  try {
    const { folders, images } = playlist.scanFolderEntries(dir);
    // The card's count and collage must match what opening the folder will show,
    // so photos the user removed are left out of both.
    const removed = hiddenPathSet();
    // Same key the removed-set is built with. A plain lowercase string kept the `\`
    // separators, so nothing ever matched and the folder card went on showing the old
    // count and preview after photos inside it were removed.
    const visible = images.filter((p) => !removed.has(pathKey(p)));
    const removedDirs = folderState.listHiddenDirs(liveFolderState).map((d) => d.path);
    const subfolders = folders.filter((f) => !removedDirs.some((dir) => library.isUnderPath(f, dir))).length;
    return { count: visible.length, subfolders, previews: visible.slice(0, 4) };
  } catch { return { count: 0, subfolders: 0, previews: [] }; }
});

// Маленький тамбнейл для библиотечных превью (через Windows shell) → data-URL. Без него
// карточки грузили бы полноразмерные (до 4K) файлы → тормоза декодирования + «лесенка»
// при даунскейле. Вместе с URL держим размер thumbnail: его пропорция совпадает с оригиналом
// и нужна justified-сетке. Windows cache принимает scalar width, поэтому LRU-key = "путь|W".
const thumbCache = new Map();
const thumbPending = new Map();
// Diagnostics observes every thumbnail job (queue wait + run + depth) through the
// optional task-queue hooks; with diagnostics off the hook body is a null-check.
const runThumbnailTask = createTaskQueue(2, {
  onSettle: ({ ok, startedAt, waitMs, runMs, pending, active }) => diagEvent({
    kind: 'span',
    category: 'task-queue',
    name: 'thumbnail-task',
    timestampMs: startedAt,
    durationMs: runMs,
    attributes: { status: ok ? 'ok' : 'error', waitMs, pending, active },
  }),
});
const THUMB_CAP = 800;
function cachedThumb(key) {
  const hit = thumbCache.get(key);
  if (hit === undefined) return undefined;
  thumbCache.delete(key);
  thumbCache.set(key, hit);
  return hit;
}
async function thumbnailData(p, w, h, priority = 0) {
  if (!p || typeof p !== 'string' || p.includes('\0') || !path.isAbsolute(p)) {
    return { url: '', width: 0, height: 0 };
  }
  // SEC-002. A thumbnail IS the file's contents, re-encoded and handed back as a data
  // URL. Guarded here rather than at each of the three channels above it, so a fourth
  // caller cannot arrive without the check.
  if (!isAuthorizedMediaPath(p)) return { url: '', width: 0, height: 0 };
  thumbnailAttempts += 1;
  const requestedWidth = Number(w);
  const requestedHeight = Number(h);
  const W = Number.isFinite(requestedWidth) ? Math.max(16, Math.min(1024, Math.round(requestedWidth))) : 320;
  const H = Number.isFinite(requestedHeight) ? Math.max(16, Math.min(1024, Math.round(requestedHeight))) : 200;
  const key = `${p}|${W}`;
  const hit = cachedThumb(key);
  if (hit !== undefined) {
    if (hit.width > 0 && hit.height > 0) queueLiveFolderAspect(p, hit.width / hit.height);
    return hit;
  }
  const pending = thumbPending.get(key);
  if (pending) return pending;
  const job = runThumbnailTask(async () => {
    const lateHit = cachedThumb(key);
    if (lateHit !== undefined) {
      if (lateHit.width > 0 && lateHit.height > 0) queueLiveFolderAspect(p, lateHit.width / lateHit.height);
      return lateHit;
    }
    let data = { url: '', width: 0, height: 0 };
    let cacheable = true;
    // Extraction and encoding run in the isolated Windows helper. Main keeps only
    // the lightweight JSONL round-trip and the bounded in-memory result cache.
    const endRequest = diagSpan('thumbnail', 'helper-roundtrip', { width: W, height: H });
    try {
      const result = await thumbnailHost.thumbnail(p, W, 82);
      const mime = result && result.mime === 'image/png' ? 'image/png' : 'image/jpeg';
      const body = result && typeof result.dataBase64 === 'string' ? result.dataBase64 : '';
      const width = Number(result && result.width) || 0;
      const height = Number(result && result.height) || 0;
      if (body && width > 0 && height > 0) {
        data = { url: 'data:' + mime + ';base64,' + body, width, height };
      }
      endRequest({
        status: data.url ? 'ok' : 'empty',
        bytes: Number(result && result.encodedBytes) || 0,
        width,
        height,
        windowsCache: String(result && result.windowsCache || ''),
      });
    } catch (error) {
      cacheable = !(error && error.retriable);
      endRequest({ status: 'error', errorCode: String(error && error.code || 'helper_failed') });
    }
    if (cacheable) {
      thumbCache.set(key, data);
      if (thumbCache.size > THUMB_CAP) {
        const k0 = thumbCache.keys().next().value;
        thumbCache.delete(k0);
      }
    }
    if (data.width > 0 && data.height > 0) queueLiveFolderAspect(p, data.width / data.height);
    return data;
  }, { priority }).finally(() => {
    thumbPending.delete(key);
  });
  thumbPending.set(key, job);
  return job;
}
ipcMain.handle('thumb', async (e, p, w, h) => {
  const data = await thumbnailData(p, w, h);
  return data.url;
});
ipcMain.handle('thumb-info', (e, p, w, h, priority) => thumbnailData(p, w, h, priority));

// Resolve proportions before renderer inserts the next justified-grid chunk. A small
// worker pool avoids hammering Windows shell with dozens of simultaneous thumbnail jobs.
// Pool-item aspects are persisted as additive metadata; folder-expanded images are
// persisted separately in folder-state by thumbnailData's batched backfill.
ipcMain.handle('thumb-aspects', async (e, entries, w, h) => {
  const input = Array.isArray(entries) ? entries.slice(0, 100) : [];
  const result = new Array(input.length);
  let cursor = 0;
  let changed = false;
  const worker = async () => {
    while (cursor < input.length) {
      const index = cursor++;
      const entry = input[index] || {};
      const p = typeof entry.path === 'string' ? entry.path : '';
      const data = await thumbnailData(p, w, h);
      const aspect = data.width > 0 && data.height > 0 ? data.width / data.height : 0;
      result[index] = { path: p, aspect };
      if (aspect && entry.id && library.setAspect(config.library, entry.id, p, aspect)) changed = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, input.length) }, () => worker()));
  // Internal metadata backfill must not broadcast config and restart the visible
  // library render that requested it. Only pool aspects changed, so this goes
  // through the batched pool writer instead of a full config rewrite.
  if (changed) saveLibrarySoon();
  return result;
});

// Look up one path's discovery metadata ({ firstSeenAt, modifiedAt, ... }) in the live
// folder index, or null if it isn't a watched-folder image. Used when materializing so
// the new pool item keeps the date Znada first saw the file.
function liveFolderDiscovery(p) {
  if (!p || typeof p !== 'string') return null;
  const key = pathKey(p);
  try {
    for (const im of folderState.listImages(liveFolderState)) {
      if (im && im.path && pathKey(im.path) === key) return im;
    }
  } catch {}
  return null;
}

// Содержимое папки для навигации ВНУТРЬ библиотеки: подпапки + картинки (один уровень).
// Span #1 of the MVP-A diagnostics budget.
ipcMain.handle('folder-entries', (e, dir) => {
  if (!isAuthorizedMediaPath(dir)) return { folders: [], images: [] };
  const endSpan = diagSpan('library', 'folder-entries');
  try {
    const { folders, images } = playlist.scanFolderEntries(dir);
    // Attach discovery/modified dates from the live-folder index so the renderer can
    // sort the folder like "All" (newest first, etc.) instead of in readdir order.
    const meta = new Map();
    try {
      // Browsing into a folder reads the disk directly, so photos the user removed
      // have to be filtered out here too — otherwise they reappear one level down.
      // One pass: rebuilding the index is the expensive part, and each entry already
      // says whether it is hidden.
      for (const im of folderState.listImages(liveFolderState, null, { only: 'all' })) {
        if (im && im.path) meta.set(pathKey(im.path), im);
      }
    } catch {}
    const visible = images.filter((p) => {
      const m = meta.get(pathKey(p));
      return !(m && m.hidden);
    });
    // A removed subfolder is gone from the library, so it must not remain as a card
    // in its parent — it would open empty and removing it again would do nothing.
    const removedDirs = folderState.listHiddenDirs(liveFolderState).map((d) => d.path);
    // Ancestor-aware: entering a removed folder used to still list its children, and
    // restoring one of those children did nothing because the removal is on the parent.
    // Through the shared helper, so "is this inside that folder" has ONE answer — the
    // hand-rolled prefix compare that used to live here also called C:\photos2 a child
    // of C:\photos.
    const underRemoved = (target) => removedDirs.some((dir) => library.isUnderPath(target, dir));
    const visibleFolders = folders.filter((f) => !underRemoved(f));
    const result = {
      folders: visibleFolders.map((p) => ({ path: p, name: path.basename(p) })),
      images: visible.map((p) => {
        const m = meta.get(pathKey(p));
        return {
          path: p,
          addedAt: (m && m.addedAt) || 0,
          modifiedAt: (m && m.modifiedAt) || 0,
          aspect: (m && m.aspect) || 0,
        };
      }),
      count: visible.length,
    };
    endSpan({ count: visible.length, status: 'ok' });
    return result;
  } catch {
    endSpan({ status: 'error' });
    return { folders: [], images: [], count: 0 };
  }
});

// Metadata-rich flat expansion for the "All" view. Pool images are omitted because
// renderer already has their full records; live-folder entries carry discovery dates.
// Span #2 of the MVP-A diagnostics budget.
ipcMain.handle('expand-folders', async () => {
  const endSpan = diagSpan('library', 'expand-folders');
  try {
    const indexed = folderState.listImages(liveFolderState);
    const images = library.ephemeralFolderImages(config.library, indexed);
    endSpan({ count: images.length, status: 'ok' });
    return { images };
  } catch (err) {
    endSpan({ status: 'error' });
    console.error('expand-folders:', err);
    return { images: [] };
  }
});

ipcMain.handle('library-recent', async (e, limit) => {
  try {
    const indexed = folderState.listImages(liveFolderState);
    return { items: library.recentImages(config.library, indexed, limit) };
  } catch (err) {
    console.error('library-recent:', err);
    return { items: library.recentImages(config.library, [], limit) };
  }
});

function liveMaterializeExtra(p, itemType, discoveryByPath = null) {
  if (itemType !== 'image') return undefined;
  const disc = discoveryByPath
    ? discoveryByPath.get(pathKey(p))
    : liveFolderDiscovery(p);
  return disc ? {
    addedAt: disc.firstSeenAt || disc.modifiedAt || Date.now(),
    modifiedAt: disc.modifiedAt,
    aspect: disc.aspect,
  } : undefined;
}

async function validateMaterializePath(p, itemType) {
  if (!p || typeof p !== 'string') return 'bad_request';
  // SEC-002. Both routes into the pool that take a PATH from the window come through
  // here. Without this, a window could name any file, have a record made for it, and
  // every check above would then say yes to it honestly - authority laundered in one
  // call. Drag-and-drop is deliberately not this route; see isAuthorizedMediaPath.
  if (!isAuthorizedMediaPath(p)) return 'bad_request';
  let stats;
  try { stats = await fs.promises.stat(p); }
  catch { return itemType === 'folder' ? 'missing_folder' : 'missing_file'; }
  if (itemType === 'folder') return stats.isDirectory() ? null : 'missing_folder';
  return stats.isFile() && playlist.IMG_EXTS.has(path.extname(p).toLowerCase()) ? null : 'missing_file';
}

// Atomic transient assignment: validation happens before the synchronous pool+slot
// transaction, so ok:false can never leave an orphan library record behind.
ipcMain.handle('library-assign-record', async (e, rawRecord, monitorId, which) => {
  const record = rawRecord && typeof rawRecord === 'object' ? rawRecord : null;
  if (!record || !monitorId) return { config, ok: false, error: 'bad_request', id: null, created: false };
  const known = library.getItem(config.library, record.id)
    || (record.path && library.getItem(config.library, library.idFor(record.path)));
  if (known) return commitLibraryAssignmentRecord({ id: known.id }, monitorId, which);

  const itemType = record.type === 'folder' ? 'folder' : 'image';
  const error = await validateMaterializePath(record.path, itemType);
  if (error) return { config, ok: false, error, id: null, created: false };
  return commitLibraryAssignmentRecord(
    { path: record.path, type: itemType }, monitorId, which,
    { allowCreate: true, extra: liveMaterializeExtra(record.path, itemType) },
  );
});

const LIBRARY_ASSIGN_BATCH_MAX = 50000;
const LIBRARY_ASSIGN_STAT_CONCURRENCY = 24;

async function prepareLibraryAssignmentRecord(rawRecord, discoveryByPath = null) {
  const record = rawRecord && typeof rawRecord === 'object' ? rawRecord : null;
  if (!record) return { error: 'bad_request' };
  const known = library.getItem(config.library, record.id)
    || (record.path && library.getItem(config.library, library.idFor(record.path)));
  if (known) {
    if (known.type === 'image') {
      const error = await validateMaterializePath(known.path, 'image');
      if (error) return { error };
    }
    return { record: { id: known.id }, options: {} };
  }
  const itemType = record.type === 'folder' ? 'folder' : 'image';
  const error = await validateMaterializePath(record.path, itemType);
  if (error) return { error };
  return {
    record: { path: record.path, type: itemType },
    options: { allowCreate: true, extra: liveMaterializeExtra(record.path, itemType, discoveryByPath) },
  };
}

// Bulk variant: bounded filesystem validation, one pool+slot transaction, one config
// write/broadcast and at most one wallpaper apply regardless of selection size.
ipcMain.handle('library-assign-records', async (e, rawRecords, monitorId, which) => {
  if (!Array.isArray(rawRecords) || !rawRecords.length || rawRecords.length > LIBRARY_ASSIGN_BATCH_MAX || !monitorId) {
    return { config, ok: false, error: 'bad_request', assigned: 0, failed: Array.isArray(rawRecords) ? rawRecords.length : 0 };
  }
  const unique = new Map();
  for (const record of rawRecords) {
    if (!record || typeof record !== 'object') continue;
    const key = record.id || (record.path && library.idFor(record.path));
    if (key && !unique.has(key)) unique.set(key, record);
  }
  const records = Array.from(unique.values());
  // Existing pool records already carry their metadata. Avoid cloning/scanning the
  // unlimited live-folder index for the common case of assigning existing cards;
  // discovery metadata is needed only when at least one transient image is created.
  const needsDiscovery = records.some((record) => {
    const known = library.getItem(config.library, record.id)
      || (record.path && library.getItem(config.library, library.idFor(record.path)));
    return !known && record.type !== 'folder' && typeof record.path === 'string';
  });
  let discoveryByPath = null;
  if (needsDiscovery) {
    discoveryByPath = new Map();
    try {
      for (const image of folderState.listImages(liveFolderState)) {
        if (image && image.path) discoveryByPath.set(pathKey(image.path), image);
      }
    } catch {}
  }
  const prepared = new Array(records.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < records.length) {
      const index = cursor++;
      prepared[index] = await prepareLibraryAssignmentRecord(records[index], discoveryByPath);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(LIBRARY_ASSIGN_STAT_CONCURRENCY, records.length) },
    () => worker(),
  ));
  const valid = prepared.filter((entry) => entry && !entry.error);
  const validationFailed = prepared.length - valid.length;
  if (!valid.length) {
    return { config, ok: false, error: (prepared.find((entry) => entry && entry.error) || {}).error || 'missing_item', assigned: 0, failed: validationFailed };
  }
  const theme = which === 'dark' ? 'dark' : 'light';
  const withFunnel = valid.map((entry) => ({
    ...entry,
    options: { ...(entry.options || {}), addToPool },
  }));
  // Same ordering guarantee as the single-record path (see commitLibraryAssignmentRecord).
  return withLibraryLock(async () => {
    const revivalsBefore = poolRevivals;
    const result = libraryAssignment.assignRecords(config, withFunnel, monitorId, theme);
    result.failed += validationFailed;
    if (!result.ok) {
      return { config, ok: false, error: result.error, assigned: 0, failed: result.failed, warning: null };
    }
    const poolTouched = (result.createdIds || []).length > 0 || poolRevivals !== revivalsBefore;
    const warning = await finalizeLibraryAssignment(result, theme, poolTouched);
    // Keep the IPC response compact: config already contains authoritative items;
    // returning duplicate ids/items arrays would double serialization for huge batches.
    return {
      config,
      ok: true,
      error: null,
      assigned: result.assigned,
      failed: result.failed,
      warning,
    };
  });
});

// «Материализация» картинки/папки из живого источника в пул — БЕЗ копирования (по ссылке на
// оригинальный путь, как и сама папка-источник живёт по оригиналу). Нужно, чтобы назначить/★
// картинку из открытой папки: получаем настоящий id, дальше работают обычные library-assign/
// toggle-favorite/assign-меню. id = idFor(origPath) → совпадает с pool-item ⇒ нет дублей в «Все».
// The one materialize. Both channels below are the same act — put a path the app already
// vouches for into the pool — and differ only in what the calling window is handed back.
// Two implementations of this is how the two windows drifted apart in the first place.
async function materializePathIntoPool(p, type) {
  if (!p || typeof p !== 'string') return null;
  const itemType = type === 'folder' ? 'folder' : 'image';
  if (await validateMaterializePath(p, itemType)) return null;
  // Inherit the discovery date from the live-folder index so assigning/★-ing a file
  // out of a watched folder does NOT mark it "just added" and jump it to the top under
  // "Newest first". Only genuinely new standalone imports (no index entry) keep now().
  const extra = liveMaterializeExtra(p, itemType);
  const id = addToPool(itemType, p, extra);
  if (id) { clearRemovedState(p); saveConfig(); }
  if (id && itemType === 'folder') {
    syncLiveFolderWatchers();
    requestLiveFolderRefresh([id]);
  }
  return id || null;
}

ipcMain.handle('library-materialize', (e, p, type) => withLibraryLock(
  async () => ({ config, id: await materializePathIntoPool(p, type) }),
));

// META-001 / ONL-009. The fullscreen viewer's half of "the record is made when the user
// acts". The main window gets the whole config back because it owns one; this window
// holds no config at all, so it is told the single thing it needs — the same choice
// `card-assign-targets` makes. The authority question is unchanged: validateMaterializePath
// still refuses a path nothing vouches for.
ipcMain.handle('card-ensure-record', (e, p, type) => withLibraryLock(
  async () => ({ id: (await materializePathIntoPool(p, type)) || '' }),
));

ipcMain.handle('set-slideshow', (e, patch) => {
  config.slideshow = { ...config.slideshow, ...(patch || {}) };
  config.slideshow.enabled = !!config.slideshow.enabled;
  config.slideshow.intervalEnabled = config.slideshow.intervalEnabled !== false;
  if (!Number.isFinite(+config.slideshow.intervalMin) || +config.slideshow.intervalMin < 1) config.slideshow.intervalMin = 30;
  config.slideshow.intervalMin = Math.floor(+config.slideshow.intervalMin);
  if (config.slideshow.order !== 'shuffle') config.slideshow.order = 'sequential';
  if (patch && (patch.enabled === false || patch.intervalEnabled === false)) cancelPendingStealth();
  saveSettingsOnly();
  if (config.slideshow.enabled) tickSlideshow(false, true);
  else { clearSlideshowTimer(); applyForTheme(null, true); }
  return config;
});

ipcMain.handle('apply-now', (e, which) => applyForTheme(which, true));

// Theme indicator on Home is a 3-step toggle: Auto → force opposite of the current
// auto theme → force the auto theme → back to Auto. _lastAutoTheme remembers what
// "auto" was when we left it, so the cycle is deterministic.
ipcMain.handle('cycle-theme-override', async () => {
  const isDark = nativeTheme.shouldUseDarkColors;
  let next;
  if (config.themeOverride == null) {
    config._lastAutoTheme = isDark ? 'dark' : 'light';
    next = isDark ? 'light' : 'dark';            // force the opposite first
  } else {
    const opposite = config._lastAutoTheme === 'dark' ? 'light' : 'dark';
    next = config.themeOverride === opposite ? config._lastAutoTheme : null;
  }

  config.themeOverride = next;
  saveSettingsOnly();
  if (next) await setWindowsTheme(next === 'dark');
  applyThemeSchedule(); // re-arm the boundary timer (no-op flip if schedule is off)
  return next;
});

// Ручная смена обоев на следующий кадр (кнопка на Главной / хоткей). Крутит слайдшоу,
// если включено, иначе просто сдвигает индекс плейлиста и применяет.
ipcMain.handle('next-wallpaper', async (e, monitorId) => {
  // apply carries the honest outcome ({ok, reason}) so the Home button can stop
  // showing a success toast when the wallpaper did not actually change.
  const apply = await triggerNextWallpaper(monitorId ? [monitorId] : null);
  return { config, apply: apply || { ok: true } };
});

// Jump to a specific playlist item for a monitor+theme and apply immediately.
ipcMain.handle('set-slideshow-index', async (e, monitorId, theme, index) => {
  if (!monitorId) return config;
  const t = theme === 'dark' ? 'dark' : 'light';
  const list = playlist.resolveSlot(slotFor(monitorId, t), config.library, { forceFolderScan: true, exclude: hiddenPathSet() });
  if (!list.length) return config;
  storeSlideshowPosition(monitorId, t, playlist.reconcilePosition(list, '', Number(index)));
  saveSettingsOnly();  // position only
  if (t === wallpaperThemeName()) {
    cancelPendingStealth();
    try {
      await applyForTheme(t, true);
    } finally {
      rescheduleSlideshowAfterManualWallpaperChange();
    }
  }
  return config;
});

// «Установить именно эту картинку» по клику на миниатюру. Индекс слайдшоу адресует
// РАЗВЁРНУТЫЙ плейлист (папка = много файлов), поэтому ищем индекс по ПУТИ, а не по
// позиции в стрипе (иначе при папке в плейлисте ставится не то фото).
// Returns { config, apply } — apply is the honest outcome of the pick, so the
// Design strip can stop toasting «Applied» when the file is gone from the playlist
// or Windows rejected the wallpaper (the old shape returned config alone and the
// renderer had no way to know the click silently did nothing).
ipcMain.handle('set-slideshow-to-path', async (e, monitorId, theme, p) => {
  if (!monitorId || !p) return { config, apply: { ok: false, reason: 'not-in-playlist' } };
  const t = theme === 'dark' ? 'dark' : 'light';
  const idx = playlist.resolvedIndexOf(slotFor(monitorId, t), config.library, p, {
    forceFolderScan: true,
    exclude: hiddenPathSet(),
  });
  // путь не в развёрнутом плейлисте (исключён/файла нет)
  if (idx < 0) return { config, apply: { ok: false, reason: 'not-in-playlist' } };
  // Keep the caller's spelling here; resolveSlideshowPosition reconciles it to the
  // freshly scanned path through pathKey before use (now for the active theme, or when
  // an inactive theme later becomes active).
  storeSlideshowPosition(monitorId, t, { index: idx, path: p });
  saveSettingsOnly();  // position only
  // Picking a specific frame is a manual choice → cancel any pending stealth advance.
  if (t === wallpaperThemeName()) {
    cancelPendingStealth();
    try {
      const apply = await applyForTheme(t, true);
      return { config, apply: apply || { ok: true } };
    } finally {
      rescheduleSlideshowAfterManualWallpaperChange();
    }
  }
  // Frame stored for the inactive theme — it will show when that theme activates.
  return { config, apply: { ok: true } };
});

ipcMain.handle('detect-location', async () => {
  const providers = [
    {
      url: 'https://ipapi.co/json/',
      parse: (data) => {
        if (data.latitude != null && data.longitude != null) {
          return { lat: String(data.latitude), lng: String(data.longitude), city: data.city || '' };
        }
      }
    },
    {
      url: 'http://ip-api.com/json/',
      parse: (data) => {
        if (data.lat != null && data.lon != null) {
          return { lat: String(data.lat), lng: String(data.lon), city: data.city || '' };
        }
      }
    },
    {
      url: 'https://freeipapi.com/api/json',
      parse: (data) => {
        if (data.latitude != null && data.longitude != null) {
          return { lat: String(data.latitude), lng: String(data.longitude), city: data.cityName || '' };
        }
      }
    }
  ];

  const TIMEOUT_MS = 6000; // не зависать на «висящем» провайдере — отвалимся к следующему
  let lastError = null;
  for (const provider of providers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      console.log(`Attempting location detection via ${provider.url}...`);
      const res = await fetch(provider.url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = await res.json();
      const result = provider.parse(data);
      if (result) {
        console.log(`Location successfully detected using ${provider.url}: ${result.city} (${result.lat}, ${result.lng})`);
        return { ok: true, ...result };
      }
      throw new Error('Invalid format returned by provider');
    } catch (err) {
      console.warn(`Location provider ${provider.url} failed:`, err.message);
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }

  console.error('All location providers failed.');
  return { ok: false, reason: lastError ? lastError.message : 'Unknown error' };
});

ipcMain.handle('set-autostart', (e, v) => {
  setAutostart(v);
  return config.autostart;
});

ipcMain.handle('set-start-minimized', (e, v) => {
  setStartMinimized(v);
  return config.startMinimized;
});

ipcMain.handle('check-for-updates', () => ({ started: checkForUpdates(), supported: updatesSupported() }));
ipcMain.handle('install-update', () => quitAndInstallUpdate());
ipcMain.handle('open-releases', () => shell.openExternal(RELEASES_PAGE));
ipcMain.handle('open-website', () => shell.openExternal('https://github.com/alexvlass01/znada'));
ipcMain.handle('get-update-state', () => ({ state: updateState, supported: updatesSupported() }));

ipcMain.handle('file-url', (e, p) => {
  // SEC-002. This is the channel that hands a window the address of a file on the disk.
  // It used to accept any absolute path at all.
  if (!isAuthorizedMediaPath(p)) return '';
  try {
    return pathToFileURL(p).href;
  } catch {
    return '';
  }
});

ipcMain.handle('gallery-open', (e, payload) => openGalleryWindow(payload));
ipcMain.handle('gallery-payload', () => galleryPayload);
ipcMain.handle('gallery-close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});
ipcMain.handle('gallery-toggle-fullscreen', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return { ok: false };
  // Toggle off our own tracked flag, not win.isFullScreen() — the latter (and the
  // enter/leave-full-screen events) are unreliable for frameless windows on Windows,
  // which left the "exit fullscreen" click stuck.
  const next = !galleryWindowFullscreen;
  if (next) {
    if (!win.isFullScreen()) galleryWindowNormalBounds = win.getBounds();
    win.setFullScreen(true);
  } else {
    win.setFullScreen(false);
    if (galleryWindowNormalBounds) win.setBounds(galleryWindowNormalBounds);
  }
  galleryWindowFullscreen = next;
  // Drive the renderer UI directly (the OS events may not fire on Windows).
  if (win.webContents && !win.webContents.isDestroyed()) win.webContents.send('gallery-fullscreen-changed', next);
  return { ok: true, fullscreen: next };
});

ipcMain.handle('quit-app', () => {
  app.isQuitting = true;
  app.quit();
});

function startMenuPlan() {
  return windowsLaunch.startMenuShortcutPlan({
    appData: app.getPath('appData'),
    authors: PACKAGE_AUTHORS,
    productName: 'Znada',
  });
}

// Squirrel files its Start menu shortcut under a folder named after the author,
// which makes Windows list the app as a FOLDER instead of an application: it
// drops out of the app list and only search finds it. Put the shortcut where it
// belongs and take the stray away — but only once it is confirmed to hold
// nothing except our own shortcut, because this is the user's Start menu.
function normalizeStartMenuShortcut() {
  if (process.platform !== 'win32') return;
  // The same rule as autostart, taken from the same place. A blanket "any --squirrel-*
  // argument" test here undid half the fix it belonged to: --squirrel-firstrun is a
  // normal first session, not an installer event, so a clean install left the shortcut
  // in the author folder until the app happened to be started a second time by hand.
  if (!windowsLaunch.shouldNormalizeShortcut({
    installed: updatesSupported(), squirrelEvent: SQUIRREL_LIFECYCLE_EVENT,
  })) return;
  // ONLY for an installed build. Without this the function was actively harmful:
  // running from source makes process.execPath point at node_modules\electron\
  // dist\electron.exe, so it wrote a Start menu entry aimed at Electron — with
  // Electron's name and icon — and then deleted the correct shortcut the
  // installer had made. One `npm start` was enough to replace the app in the
  // Start menu with something called "electron".
  const plan = startMenuPlan();
  if (!plan || !plan.strayLink) return;
  try {
    if (!fs.existsSync(plan.strayLink)) return;
    if (!fs.existsSync(plan.desired)) {
      const ok = shell.writeShortcutLink(plan.desired, windowsLaunch.shortcutDetails(process.execPath, {
        installed: updatesSupported(),
        description: 'Znada',
        appUserModelId: WINDOWS_APP_USER_MODEL_ID,
      }));
      if (!ok) return; // не смогли поставить свой — чужой не трогаем
    }
    fs.rmSync(plan.strayLink, { force: true });
    const left = fs.readdirSync(plan.strayDir);
    if (!left.length) fs.rmdirSync(plan.strayDir);
  } catch (err) {
    console.error('[Shortcut] Не удалось перенести ярлык меню «Пуск»:', err);
  }
}

ipcMain.handle('shortcuts-status', () => ({
  desktop: fs.existsSync(path.join(app.getPath('desktop'), 'Znada.lnk')),
  startmenu: (() => {
    const plan = startMenuPlan();
    return !!plan && fs.existsSync(plan.desired);
  })(),
}));

ipcMain.handle('create-shortcuts', (e, which) => {
  const done = [];
  // A shortcut is only meaningful for an installed build. Running from source,
  // process.execPath is node_modules\electron\dist\electron.exe, so this button
  // used to plant a Start menu entry that carried Electron's name and icon and
  // opened Electron — and it overwrote the real one on the way, since it deletes
  // any existing file at that path first. Reported by the owner 2026-08-16: an Electron
  // entry showed up in the Start menu and Znada's own entry was gone.
  if (!updatesSupported()) {
    console.warn('[Shortcut] Запуск не установленный — ярлыки не создаются: они указывали бы на electron.exe.');
    return done;
  }
  const make = (lnkPath, label) => {
    try {
      if (fs.existsSync(lnkPath)) fs.rmSync(lnkPath, { force: true });
      const ok = shell.writeShortcutLink(lnkPath, windowsLaunch.shortcutDetails(process.execPath, {
        installed: updatesSupported(),
        description: 'Znada',
        appUserModelId: WINDOWS_APP_USER_MODEL_ID,
      }));
      if (ok) done.push(label);
    } catch (err) {
      console.error('Не удалось создать ярлык:', label, err);
    }
  };
  if (which === 'desktop' || which === 'both' || !which) {
    make(path.join(app.getPath('desktop'), 'Znada.lnk'), 'desktop');
  }
  if (which === 'startmenu' || which === 'both' || !which) {
    make(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Znada.lnk'), 'startmenu');
  }
  return done;
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// COLLAB-003. What the end of the hour does: the same exit as «Quit» in the tray, after a
// library change already under way has had a bounded chance to finish.
async function quitForDevSessionLimit() {
  if (devSessionLimitReached) return;
  devSessionLimitReached = true;
  console.log('[DEV] Прошёл час с запуска: проверочный запуск закрывается штатно.');
  try {
    await devLaunchTools.settleWithin(libraryMutationQueue, devLaunchTools.SETTLE_LIMIT_MS);
  } finally {
    app.isQuitting = true;
    app.quit();
  }
}

app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
  // COLLAB-003. A launch of other code on this profile must not look as if it opened: the
  // running window comes forward and says what it runs and what was turned away. Its hour
  // is not touched.
  const incoming = additionalData && additionalData.znadaDevLaunch;
  if (DEV_LAUNCH_INFO && !devLaunchTools.sameCode(DEV_LAUNCH_INFO, incoming)) {
    showWindow();
    const box = devLaunchTools.busyProfileDialog(DEV_LAUNCH_INFO, incoming);
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    (parent ? dialog.showMessageBox(parent, box) : dialog.showMessageBox(box)).catch(() => {});
    return;
  }
  // Защита от ДУБЛЯ автозапуска: если в реестре осталось несколько устаревших записей (от dev/
  // портативной сборок), при входе в Windows поднимается несколько экземпляров — второй НЕ должен
  // «будить» окно, раз мы стартовали скрыто (--hidden). Ручной повторный запуск (позже) показывает окно.
  if (STARTED_HIDDEN && Date.now() - START_TS < 10000) return;
  showWindow();
});

/*
 * PERF-008. Схема объявляется ДО готовности приложения — позже Chromium её уже не примет.
 * `standard` нужен, чтобы адрес разбирался как обычный (хост + запрос), `stream` — ради чего
 * всё и делается, `secure` — чтобы окно не считало картинку небезопасным содержимым.
 * `bypassCSP` НЕ включается: схема обязана быть перечислена в `img-src` страницы, иначе она
 * стала бы обходом собственной политики.
 */
protocol.registerSchemesAsPrivileged([{
  scheme: mediaProxy.SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
}]);

app.whenReady().then(async () => {
  // Electron finalizes its default dev identity during startup, so apply the
  // Squirrel-matching ID immediately after ready and before any window/toast.
  if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  // BUG-044. A launch that did not get this profile's lock has already called app.quit() above,
  // but Electron still emits `ready`, and this whole block used to run in that dying process: it
  // rewrote the helper scripts inside the running app's profile, and by the order of the code it
  // would go on to open a window and a tray icon, take the hotkey and apply wallpapers. Nothing
  // below belongs to a process that is quitting. Kept after the identity line on purpose: that
  // call has no effect outside this process, and the package-boundary test pins it as the first.
  if (!gotLock) return;
  // PERF-008. До первого окна: иначе первая картинка попросится по схеме, которую ещё
  // никто не обслуживает.
  registerMediaProxy();

  Menu.setApplicationMenu(null); // убираем стандартное меню File/Edit/View
  if (DIAGNOSTICS_BOOTSTRAP.enabled) {
    console.log(`[Diagnostics] enabled; userData=${DIAGNOSTICS_BOOTSTRAP.userDataPath}`);
  }
  loadConfig();
  ensureAnonId(); // generate the anonymous install id once, before any cloud request
  loadLiveFolderState();
  // Restore as a new session generation: any in-flight answer from an earlier lifecycle
  // (tests exercise reloads in one process) must not be allowed to mutate it.
  replaceCloudSession(loadStoredToken(), null); // validated on first use
  // Установщик пересоздаёт ярлыки при каждом обновлении, поэтому чинить их место
  // нужно на каждом старте, а не один раз после установки.
  normalizeStartMenuShortcut();
  registerShortcut();
  ensurePsScript();
  ensureComScript();
  ensureComHostScript();
  ensureThemeScript();
  if (DIAGNOSTICS_BOOTSTRAP.enabled) {
    try {
      const { createDiagnosticsController } = require('./diagnostics/main/controller');
      const { createProcessSampler, createNodeEventLoopProviders } = require('./diagnostics/main/process-sampler');
      // Distinguish renderer processes by their OS pid so per-process CPU/memory
      // samples say WHICH window they belong to. The future diagnostics control
      // window must get its own role here (excluded from the app verdict).
      const rendererRoleForPid = (pid) => {
        try {
          if (mainWindow && !mainWindow.isDestroyed()
            && mainWindow.webContents.getOSProcessId() === pid) return 'renderer-main';
        } catch {}
        try {
          if (galleryWindow && !galleryWindow.isDestroyed()
            && galleryWindow.webContents.getOSProcessId() === pid) return 'renderer-viewer';
        } catch {}
        try {
          if (diagnosticsControlWindow && !diagnosticsControlWindow.isDestroyed()
            && diagnosticsControlWindow.webContents.getOSProcessId() === pid) return 'renderer-diagnostics';
        } catch {}
        return '';
      };
      diagnosticsController = createDiagnosticsController({
        userDataPath: app.getPath('userData'),
        appInfo: {
          name: app.getName(),
          version: app.getVersion(),
          isPackaged: app.isPackaged,
        },
        ipcMain,
        shell,
        source: { role: 'main', pid: process.pid },
        samplerFactory: ({ record }) => createProcessSampler({
          record,
          appMetrics: () => app.getAppMetrics(),
          classifyPid: rendererRoleForPid,
          ...createNodeEventLoopProviders(),
        }),
      });
      diagnosticsController.registerIpc();
      // Force-delivery test is deliberately separate from failure policy/journal.
      // It ignores notifyOnFailure and does not create a fake failure entry: the
      // Diagnostics button answers only whether Electron -> Windows delivery works.
      ipcMain.handle('diagnostics-test-notification', () => deliverSystemNotification({
        titleKey: 'notify.testTitle',
        bodyKey: 'notify.testBody',
      }));
      diagnosticsController.attachAppEvents(app);
      diagnosticsController.attachProcessEvents(process);
      const started = await diagnosticsController.startIfNeeded('startup');
      if (started && started.ok !== false) {
        console.log(`[Diagnostics] recording; sessionDir=${diagnosticsController.status().sessionDir}`);
      } else {
        console.warn('[Diagnostics] failed to start recording:', started && started.error);
      }
      openDiagnosticsControlWindow(); // small Start/Stop/report window
    } catch (err) {
      console.error('[Diagnostics] controller failed:', err);
    }
  }

  // keep the OS login item in sync with config (openAtLogin + the --autostart/--hidden args)
  applyLoginItem();
  cleanStrayAutostartEntries(); // убрать осиротевшие dev/portable записи автозапуска (см. функцию)

  createWindow();
  trayCtl.create();
  startLiveFolderWatchers();
  scheduleLiveFolderFullScan('startup', 3000);

  // refresh monitor list when displays change (added/removed/resolution/rotation)
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(ev, async () => {
      const mons = await getMonitors();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('monitors-changed', mons);
      }
    });
  }

  lastNativeDark = nativeTheme.shouldUseDarkColors; // baseline so the first real flip is detected
  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors;
    // Windows fires this event spuriously when a wallpaper is applied (WM_SETTINGCHANGE) with
    // the SAME light/dark value. Only a real flip should toast or re-apply wallpapers — without
    // this guard every stealth/manual wallpaper change wrongly announced "Windows switched theme".
    const reallyChanged = lastNativeDark === null ? true : (isDark !== lastNativeDark);
    lastNativeDark = isDark;
    if ((config.themeOverride === 'light' && isDark) || (config.themeOverride === 'dark' && !isDark)) {
      config.themeOverride = null;
      saveSettingsOnly();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.setTitleBarOverlay(titleBarOverlayColors()); } catch {}
    }
    trayCtl.refreshIcon();
    if (!reallyChanged) { broadcastTheme({ silent: true }); return; } // spurious event: refresh UI quietly, nothing else
    // Suppress the "Windows switched theme" toast during the startup/resume catch-up window
    // (background flip), but keep announcing genuine theme changes the user makes later.
    broadcastTheme({ silent: Date.now() < themeToastQuietUntil });
    // Wallpaper mode='system' follows Windows. Independent time/sun schedules ignore
    // nativeTheme events completely; unified mode always stays on the shared light slot.
    if (config.separateThemes !== false && config.wallpaperSchedule && config.wallpaperSchedule.mode === 'system') {
      if (config.slideshow.enabled) {
        if (stealthCtl.isActive()) {
          // A theme flip during an invisible session folds in (Option A) WITHOUT discarding the
          // session's advance intent — a wake session still shows a new photo on the new theme.
          // changeTheme() no-ops if the theme didn't actually change, so a spurious WM_SETTINGCHANGE
          // (Windows fires one when a wallpaper is applied) can't loop or clobber the session.
          stealthCtl.changeTheme(wallpaperThemeName());
        } else {
          tickSlideshow(false); // применить кадр новой темы + перепланировать
        }
      } else applyForTheme();
    }
  });

  // enumerate monitors, then apply correct wallpaper on launch
  await getMonitors();
  // NB: GC намеренно НЕ запускаем на старте — слишком опасно (см. gcWallpapers).
  // Осиротевшие файлы подчищаются только при явном удалении из библиотеки/слота, и то в .trash.
  const wallpaperMode = config.wallpaperSchedule && config.wallpaperSchedule.mode;
  const startupAction = schedule.wallpaperStartupAction(config);
  if (startupAction === 'slideshow') tickSlideshow(false); // применить текущее + запустить ротацию
  else if (startupAction === 'apply') applyForTheme();
  else if (startupAction === 'schedule') await applyWallpaperSchedule(false, true);
  else broadcastWallpaperTheme();
  if (config.slideshow.enabled && (wallpaperMode === 'time' || wallpaperMode === 'sun')) {
    await applyWallpaperSchedule(false, false);
  }

  // start theme schedule (if enabled): set the right theme now + schedule flips
  applyThemeSchedule();

  // ── Wallpaper triggers (route through requestWallpaperAdvance / stealthCtl) ──────────
  // Only a real Windows login (login item passes --autostart) counts as "on startup".
  // A manual/dev/portable launch must NOT advance the wallpaper.
  if (STARTED_AUTOSTART && config.slideshow && config.slideshow.enabled && config.triggers && config.triggers.onStartup) {
    requestWallpaperAdvance('startup');
  }

  // Switch wallpaper when the computer wakes from sleep/hibernate
  powerMonitor.on('resume', () => {
    if (devSession) devSession.check(); // COLLAB-003: a sleep does not stretch the hour
    themeToastQuietUntil = Date.now() + 10000; // resume catch-up flip must not toast
    syncLiveFolderWatchers();
    scheduleLiveFolderFullScan('resume', 5000);
    if (config.wallpaperSchedule && (config.wallpaperSchedule.mode === 'time' || config.wallpaperSchedule.mode === 'sun')) {
      applyWallpaperSchedule(false, true);
    }
    if (config.slideshow && config.slideshow.enabled && config.triggers && config.triggers.onWakeup) {
      requestWallpaperAdvance('wakeup');
    }
  });

  // background update check (installed build only); silent until an update is ready
  if (updatesSupported()) setTimeout(() => checkForUpdates(), 8000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Flush discovery metadata and dispose persistent helper processes on quit.
app.on('before-quit', () => {
  if (devSession) devSession.dispose(); // COLLAB-003: nothing of the hour outlives a quit
  if (diagnosticsController) {
    // A recording the hour cut short says so, instead of looking like a manual quit.
    void diagnosticsController.shutdownBestEffort({ reason: devSessionLimitReached ? 'dev-session-limit' : 'before-quit' });
  }
  if (liveFolderFullScanTimer) clearTimeout(liveFolderFullScanTimer);
  liveFolderFullScanTimer = null;
  for (const retry of liveFolderWatcherRetryTimers.values()) clearTimeout(retry);
  liveFolderWatcherRetryTimers.clear();
  flushPendingLiveFolderAspects();
  flushLiveFolderState();
  libraryWriter.flush(); // batched pool edits must not die with the process
  // META-001: losing the journal costs no user data, but it does cost the memory of
  // which questions have already been asked — and re-asking is what gets us blocked.
  metadataWriter.flush();
  configBroadcast.dispose();
  if (liveFolderWatcher) liveFolderWatcher.closeAll();
  void thumbnailHost.dispose();
  wpHost.dispose();
  // SEC-002. Only the browser-waiting phase owns this socket and five-minute timer;
  // post-redirect exchange and /me have their own short request deadlines. On quit,
  // cancel the listener phase when it still exists.
  cancelCloudSignin();
});

app.on('will-quit', () => {
  hotkeyCtl.dispose();
  globalShortcut.unregisterAll();
});

// Keep running in tray after all windows are closed
app.on('window-all-closed', () => {
  // do nothing — app lives in the tray
});

// --- Test seam -------------------------------------------------------------
// Electron never reads this. It exists because the bugs that kept surviving review
// were ORCHESTRATION bugs — the order these handlers mutate the pool, the slots and
// the folder index in, and what they write afterwards — which no module test can see
// and no source-string check can prove. test/helpers/main-harness.js loads this file
// against a stubbed Electron and drives the real handlers over a temp profile.
module.exports = {
  __test: {
    CONFIG_PATH,
    loadConfig,
    registerMediaProxy,
    recentOriginals,
    getConfig: () => config,
    isUnsafeToWrite: () => libraryUnsafeToWrite,
    // SEC-002 slice 2: what the media guard let through, and the grant side of it.
    thumbnailAttempts: () => thumbnailAttempts,
    mediaRefusals: () => mediaRefusals,
    grantPath: (p, options) => grantMediaPath(p, options),
    isAuthorizedMediaPath: (path_) => isAuthorizedMediaPath(path_),
    // SEC-002. The harness has no real windows, so it registers stand-ins through the
    // REAL authority and sends events shaped like real ones. Exposing the registration
    // rather than a bypass is the point: a test that could skip the guard would prove
    // nothing about the guard.
    // The window policy itself, so the three refusals it installs are provable without a
    // real Electron window: navigation away, a window of the page's own, and any device
    // permission. Without this seam they were code nothing had ever run.
    hardenWindow: (win, role) => hardenWindow(win, role),
    windowPages: () => Object.keys(WINDOW_PAGES),
    windowSecurity: (role) => windowSecurity(role),
    diagnosticsEnabled: () => DIAGNOSTICS_BOOTSTRAP.enabled,
    // COLLAB-003. The check launch as main.js resolved it, with the REAL hour controller: a
    // test that moves the clocks drives the same exit the timer would.
    devLaunch: () => ({ mode: DEV_LAUNCH.mode, refusal: DEV_LAUNCH.refusal, info: DEV_LAUNCH_INFO, session: devSession }),
    // The library mutation queue itself, so a test can hold a change open across the hour.
    withLibraryLock: (fn) => withLibraryLock(fn),
    // The tray is created on ready, which never comes under the harness. This creates it
    // through the real controller, so what main hands it (the check label) can be seen.
    createTray: () => trayCtl.create(),
    ipcAuthority: {
      register: (contents, role, url) => ipcAuthority.register(contents, role, url),
      forget: (contents) => ipcAuthority.forget(contents),
      roleOf: (event) => ipcAuthority.roleOf(event),
      roles: () => IPC_ROLES,
      denials: () => ipcAuthority.denials(),
      trackedWindows: () => ipcAuthority.trackedWindows(),
    },
    // BUG-022. Deny-by-default is only safe while this list keeps up with the window:
    // a setting added to renderer.js and forgotten here stops working silently. The
    // test reads the real call sites back out of renderer.js and compares them to this.
    settingsKeys: () => Object.keys(SETTINGS_FIELDS),
    libraryViewStale: () => ({ ...libraryViewStale }),
    // BUG-033. Which sites a checkout can reach is a property of the MACHINE: the keys
    // live in gitignored files, so an official build has them and a fresh clone does not.
    // Tests written on a machine that had one silently assumed it, passed here, and went
    // red for everyone else — while the app was behaving correctly and falling back. This
    // lets a test SAY which site is in play instead of inheriting the answer, so both the
    // first choice and the fallback are exercised wherever the suite runs.
    setProviderCredentials: (id, value) => {
      if (value === undefined) providerCredentialsCache.delete(id);
      else providerCredentialsCache.set(id, value);
    },
    eventLogEntries: () => eventLog.list(),
    // BUG-023. Both of these write config.json outside any IPC handler — anonId on
    // startup, the slideshow position from a timer — so a test cannot reach them through
    // the handlers, and they are exactly the two that must not write over a config the
    // app failed to read.
    ensureAnonId: () => ensureAnonId(),
    persistSlideshowPosition: (markDirty) => {
      if (markDirty) slideshowPositionDirty = true;
      persistSlideshowPosition();
    },
    // Mirrors poolWritePending() for the settings side: a refused write has to leave the
    // position outstanding, or it is silently declared saved and never retried.
    slideshowPositionPending: () => slideshowPositionDirty,
    applyLoginItem: () => applyLoginItem(),
    squirrelEvent: () => SQUIRREL_LIFECYCLE_EVENT,
    flushLibraryWriter: () => libraryWriter.flush(),
    poolWritePending: () => libraryWriter.isPending(),
    activeHotkey: () => hotkeyCtl.active(),
    lastRemovalPending: () => !!lastLibraryRemoval,
    // The guard around deleting files still has to be TESTED while the feature itself is
    // switched off for users — otherwise every one of those tests would pass by doing
    // nothing, and the day the feature is turned back on nobody would know whether its
    // guard still works. The default stays off; only the tests turn it on.
    setPhysicalDeleteEnabled: (on) => { physicalDeleteEnabled = !!on; },
    setLiveFolderState: (state) => { liveFolderState = state; invalidateHiddenPaths(); },
    getLiveFolderState: () => liveFolderState,
    hiddenPathSet: () => hiddenPathSet(),
    resolvePlaylist: (monitorId, theme) => playlist.resolveSlot(
      slotFor(monitorId, theme), config.library, { forceFolderScan: true, exclude: hiddenPathSet() },
    ),
    // HOME-001. Отсчёт на Главной верен ровно настолько, насколько верно состояние
    // планировщика ЗДЕСЬ; чистый модуль не видит, в каком порядке main взводит и
    // гасит таймер. Второй вход имитирует то единственное место, где таймер взводится
    // не ради смены обоев, а ради перепроверки игрового режима.
    nextChangeState: () => nextChangeState(),
    // BUG-014. Проверять «сообщил ли о пропавшем источнике» надо на настоящем пути:
    // чистое правило само по себе не доказывает, что main его зовёт и что отчёт уходит
    // в нужный канал. Мониторы подставляются, потому что их опрос идёт через процесс,
    // который в тестах намеренно заблокирован.
    applyForTheme: (theme, isManual) => applyForTheme(theme, isManual),
    setMonitorsCache: (list) => { monitorsCache = Array.isArray(list) ? list : []; },
    checkLiveFolderReachability: () => checkLiveFolderReachability(),
    addToPool: (type, p, extra) => addToPool(type, p, extra),
    saveConfig: () => saveConfig(),
    // DATA-006. Where this profile's own copies live RIGHT NOW, as main resolved it,
    // plus the live state of that folder. A test that recomputed the path itself would
    // prove its own arithmetic instead of main's.
    managedRoot: () => ({
      root: wallpapersDir(), trash: trashDirPath(), custom: managedRoot.custom,
      parent: managedRoot.parent, anchor: managedRoot.anchor, ...managedRootStatus(),
    }),
    importWallpaper: (src) => importWallpaper(src),
    // DATA-006 step 2. No window can start a move yet, and the part worth testing is
    // exactly the part a window would not see: which documents are handed over, what a
    // commit writes, and what the app believes afterwards.
    moveManagedFolder: (folder, options) => moveManagedFolder(folder, options),
    // DATA-006 step 3. The freeze is a property of the DOOR, not of twenty handlers, so
    // a test can take this list and try every channel on it for real.
    libraryEditChannels: () => [...LIBRARY_EDIT_CHANNELS],
    mediaFolderState: () => mediaFolderState(),
    // The sweeper runs on user actions rather than a channel, and its whole job is
    // moving files — so the freeze in front of it has to be provable.
    gcWallpapers: () => gcWallpapers(),
    // META-001. The IPC guard is exercised through the real handler (an untrusted
    // sender must be refused); this entry drives everything AFTER it, so the test sees
    // the actual order — fingerprint, journal, provider, merge, save — rather than the
    // modules in isolation, which is where the previous rounds of defects hid.
    lookupItemMetadata: (id) => runItemMetadataLookup(id),
    setMetadataBudget: (cfg) => { metadataBudgetConfig = cfg || null; metadataBudgets.clear(); },
    // BUG-020. The browse feed is deliberately shuffled, which is untestable against a
    // real clock: a test that asserts "the order changed" is a coin toss it will
    // eventually lose. Pinning the generator makes the order exact.
    setBrowseRandom: (fn) => { browseRandom = typeof fn === 'function' ? fn : Math.random; },
    // ONL-012. The adult-content answer is a RULE over the registry, not a constant;
    // proving that needs a list the shipped registry cannot produce.
    explicitContentReachableIn: (list) => explicitContentReachableIn(list),
    // Driving one site directly is the only way to prove the guarantees that matter for
    // a site we do not ship: one that throws, one that has no key, one that is refused.
    searchOneProvider: (descriptor, params) => searchOneProvider(descriptor, params),
    searchAllProviders: (buildParams, list) => searchAllProviders(buildParams, list),
    // The one list of formats an online picture may have. Exported so a test can hold it
    // beside what Znada accepts from a folder and prove the two paths stay identical.
    acceptedFormats: () => ACCEPTED_FORMAT_LIST,
    // ONL-013. Driving one site directly is the only way to prove the guarantees that
    // matter for a site we have NOT written: one that throws, one that answers a shape
    // we cannot read, one whose extra request is refused after it already found the post.
    askProviderForFingerprint: (descriptor, kind, hash) => askProviderForFingerprint(descriptor, kind, hash),
    // Whether a site's declared key is present is a fact about THIS build, so a test can
    // only pin the shape: exactly the sites that said they need one, and nobody else.
    metadataCredentials: () => metadataCredentials(),
    // ONL-014. The list is a parameter so "a broken site is skipped and the next one
    // answers" can be proved with sites the shipped registry cannot produce.
    suggestTagsFromProviders: (prefix, limit, list) => suggestTagsFromProviders(prefix, limit, list),
    suggestTagProviders: (list) => suggestTagProviders(list).map((d) => d.id),
    searchRound: (token, sorting, extra, list, browsing) => searchRound(token, sorting, extra, list, browsing),
    recordRound: (token, attempts) => recordRound(token, attempts),
    // ONL-014c. A key in a file is read once and kept; a session must be asked for every
    // time. The difference is only visible from here.
    providerCredentials: (descriptor) => providerCredentials(descriptor),
    setCloudSession: (token, user, persist = false) => replaceCloudSession(token, user, { persist }),
    setCloudSessionStorage: (overrides) => {
      cloudSessionStorage = { ...defaultCloudSessionStorage, ...(overrides || {}) };
    },
    cloudAuthState: () => cloudAuthState(),
    stageDownloadArtifact: (dir, url, options) => stageDownloadImage(dir, url, options),
    commitDownloadArtifact: (artifact, dir) => commitDownloadArtifact(artifact, dir),
    discardDownloadArtifact: (artifact, dir) => discardDownloadArtifact(artifact, dir),
    metadataCache: () => metadataCacheStore(),
    flushMetadataWriter: () => metadataWriter.flush(),
    // Проверять надо не саму функцию, а что плановый обход её ЗОВЁТ при скрытом окне:
    // ровно эта развилка и молчала.
    runHourlyLiveFolderPass: () => scheduleLiveFolderFullScan(String("hourly"), 0),
    windowVisibleForLiveFolders: () => liveFolderWindowVisible(),
    blockIntervalLikeGameMode: () => retrySlideshowIntervalSoon(),
    cloudSigninInFlight: () => !!activeCloudSignin,
    cancelCloudSignin: () => cancelCloudSignin(),
    // BUG-031. whenReady never resolves under the harness, so no window exists and every
    // broadcast went nowhere. A stand-in lets a test hear what an open window is told.
    useMainWindow: (win) => { mainWindow = win || null; },
    disposeForTests: () => {
      if (devSession) devSession.dispose();
      cancelCloudSignin();
      libraryWriter.dispose();
      metadataWriter.dispose();
      configBroadcast.dispose();
      clearSlideshowTimer();
      // A test that switches the theme schedule on arms the next flip, which can be
      // hours away; without this the node process simply never exits.
      clearThemeTimer();
      clearWallpaperTimer();
      if (folderStateSaveTimer) clearTimeout(folderStateSaveTimer);
      if (liveFolderAspectTimer) clearTimeout(liveFolderAspectTimer);
    },
  },
};
