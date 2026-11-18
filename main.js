'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain: electronIpcMain, nativeTheme, dialog, shell, nativeImage, screen, autoUpdater, globalShortcut, powerMonitor, net, safeStorage, Notification, clipboard, protocol, session, utilityProcess, sharedTexture } = require('electron');
const { fetchVideo } = require('./src/online-video');
const { createVideoPlayer } = require('./src/video-player');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile, execFileSync } = require('child_process');
const playlist = require('./src/playlist'); // чистая логика плейлистов (тестируется отдельно)
const library = require('./src/library'); // пул контента { [id]: Item }; слоты ссылаются по id
const bookmarkRuntime = require('./src/bookmark-runtime');
const { createLibraryRemovalQuestion } = require('./src/library-removal-question');
const ipcAuthorityMod = require('./src/ipc-authority'); // SEC-002: кто вправе звать какой канал
const pathGrantsMod = require('./src/path-grants'); // SEC-002: какие пути приложение подтвердило само
const { pathKey, isDirectChildPath } = require('./src/path-key'); // canonical identity for every local path map
const folderState = require('./src/folder-state'); // persistent firstSeenAt для файлов живых папок
const liveFolderWatch = require('./src/live-folder-watch'); // lightweight fs.watch lifecycle + debounce
const { createManagedFolder, stagingInFlight } = require('./src/managed-folder'); // CODE-001 2.1b: папка своих копий, импорт и скачивание
const { moveNoClobber } = require('./src/no-clobber-move'); // BUG-084: GC-перенос в .trash без перезаписи
const { createLibraryService } = require('./src/library-service'); // CODE-001 2.2a: ядро пула — замок, дверь в пул, «что используется»
const { createLibraryRemoval } = require('./src/library-removal'); // CODE-001 2.2b: удаление, отмена, «Убранное», возврат, стирание в корзину Windows
// ONL-013: ни поиск, ни поиск по отпечатку больше не называют сайтов — оба ходят через
// реестр, поэтому прямые require адаптеров здесь не нужны.
const online = require('./src/online');
const contentRating = require('./src/content-rating');
const sizeFilter = require('./src/size-filter'); // ONL-010: подходит ли картинка под экран
const mediaProxy = require('./src/media-proxy'); // PERF-008: адресация потокового прокси картинок
const originalStoreMod = require('./src/original-store'); // PERF-010: оригинал, который уже скачан
const providerRegistry = require('./src/provider-registry'); // ONL-011/012: единый список сайтов и их объявления
const providerAccessMod = require('./src/provider-access'); // CODE-001: ключи сайтов, единая сетевая дверь, заголовки
const onlineSearchMod = require('./src/online-search'); // CODE-001: поиск, лента главной, подсказки тегов
const onlineSources = require('./src/online-sources');
const onlineQuickFilters = require('./src/online-quick-filters'); // DESIGN-002: закреплённые быстрые фильтры
const mediaFormats = require('./src/media-type'); // ONL-015: единый список форматов картинок
const itemDetails = require('./src/item-details'); // bounded metadata reader + URL/path validation
const imageMotion = require('./src/image-motion'); // BUG-035: does a picture move, read from its bytes
const wallpaperPlatformMod = require('./src/wallpaper-platform');
const { WallpaperHost, HOST_SCRIPT } = require('./src/wallpaper-host'); // живой PowerShell-COM-хост
const configMod = require('./src/config'); // дефолты + load/migrate/save (тестируется отдельно)
const libraryStore = require('./src/library-store'); // пул живёт в своём файле с пакетной записью
const { createConfigStore } = require('./src/config-store'); // CODE-001 2.1a: единственная дверь записи config.json и пула
const { createDataSnapshots } = require('./src/data-snapshots'); // DATA-001: последние целые копии файлов данных
const metadataLookup = require('./src/metadata-lookup'); // кого спрашивать, стоит ли и что это значит
const metadataLookupServiceMod = require('./src/metadata-lookup-service'); // CODE-001: отпечаток, бюджет запросов, журнал, запись в фото
const { createLibraryChecks } = require('./src/library-checks'); // LIB-030: фоновый проход по библиотеке, одинаковые файлы
const onlineHave = require('./src/online-have'); // LIB-031: карточка «Онлайн», которая уже есть в библиотеке
const coalesce = require('./src/coalesce'); // склейка частых рассылок конфига в интерфейс
const { createTrayController } = require('./src/tray'); // системный трей (меню + иконка)
const schedule = require('./src/schedule'); // чистая математика расписаний день/ночь (время/солнце)
const { createStealthController } = require('./src/stealth-session'); // отменяемая «невидимая смена» (под тестами)
const nextChange = require('./src/next-change'); // что Главной РАЗРЕШЕНО обещать про следующую смену (HOME-001)
const whatsNew = require('./src/whats-new'); // DESIGN-012: дата выхода и «Что нового» в «О программе»
const WHATS_NEW = require('./src/whats-new.json');
const { createLatestIntent } = require('./src/latest-intent'); // последнее намерение планировщика и его единственный таймер (TRG-004)
const { createThumbnailService } = require('./src/thumbnail-service');
const { ThumbnailHost, resolveThumbnailHelperPath } = require('./src/thumbnail-host');
const { createFailureNotifier } = require('./src/failure-notifier'); // edge-trigger «работало→сломалось» (T2)
const { createEventLog } = require('./src/event-log'); // bounded журнал сбоев/восстановлений (T3)
const { createNotificationDelivery } = require('./src/notification-delivery'); // отдельная проверка доставки Windows Notification
const cloudCapabilityMod = require('./src/cloud/capability'); // Znada Cloud: какое окружение разрешено (C2)
const cloudClientMod = require('./src/cloud/client'); // Znada Cloud: чистый API-клиент (C1); реальный fetch в main (C3)
const cloudContracts = require('./src/cloud/contracts.cjs');
const usagePingMod = require('./src/usage-ping'); // TELEM-001: обязательный минимальный сигнал использования
const cloudOauth = require('./src/cloud/oauth');
const { createCloudSession } = require('./src/cloud/session'); // CODE-001: bearer, OAuth and account state
const cloudDevProfile = require('./src/cloud/dev-profile'); // isolated userData for explicit staging launches
const diagnosticsGate = require('./src/diagnostics-gate'); // production-safe gate for dev-only diagnostics
const devLaunchGate = require('./src/dev-launch-gate'); // COLLAB-003: is this a DEV/DIAG check launch (the rest is dev-only)
const galleryPayloadMod = require('./src/gallery-payload'); // viewer payload sanitizing/windowing
const hotkey = require('./src/hotkey'); // accelerator parsing + atomic globalShortcut replacement
const windowsLaunch = require('./src/windows-launch');
const mediaRoot = require('./src/media-root'); // DATA-006: где лежат собственные копии Znada
const mediaMove = require('./src/media-move'); // DATA-006: копирование, проверка и уборка при переезде
const libraryFreeze = require('./src/library-freeze'); // DATA-009: чем отвечает правка во время переезда
const profileMigrationMod = require('./src/profile-migration'); // DATA-006: пересчёт путей под новый корень
const applyOutcome = require('./src/apply-outcome'); // пустой слот против исчезнувшего источника
const poolConsistency = require('./src/pool-consistency'); // ссылки слотов против содержимого пула // stable Squirrel launch targets for Run/.lnk
const childRunnerMod = require('./src/child-runner'); // WIN-002: системные программы — по полному пути и со сроком

// WIN-002. powershell.exe and reg.exe are started from System32 by absolute path, never
// looked up on PATH, and every run has a hard deadline after which its whole process tree
// is ended. A PowerShell that never returned used to hold its caller forever — including
// the wallpaper apply inside the library lock. Quitting ends whatever is still running.
// Every system program main starts goes through this one runner, and
// test/system-children-main.test.js keeps it that way.
const POWERSHELL_EXE = childRunnerMod.systemExecutable('powershell');
const REG_EXE = childRunnerMod.systemExecutable('reg');
// A cold PowerShell compiles its C# interop first: seconds, not half a minute. reg.exe is instant.
const systemChildTimeouts = { powershell: 30000, reg: 10000 };
const systemChildren = childRunnerMod.createChildRunner({ execFile });

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
      // `reg.exe` is a console program. The runner starts it hidden, so this best-effort
      // migration stays silent in the packaged GUI app instead of flashing up to ten
      // console windows at login.
      systemChildren.run(REG_EXE, ['delete', key, '/v', name, '/f'], { timeoutMs: systemChildTimeouts.reg })
        .catch(() => {});
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
      // Synchronous, so not through the runner; the same absolute path and a deadline.
      execFileSync(REG_EXE, ['delete', target.key, '/v', target.name, '/f'],
        { windowsHide: true, stdio: 'ignore', timeout: systemChildTimeouts.reg });
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
  translate: (key, params) => String(tMain(key)).replace(/\{(\w+)\}/g,
    (whole, name) => (params && params[name] != null ? String(params[name]) : whole)),
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

// DATA-001. A damaged data file was replaced by its last good copy. Not a failure that
// will "recover" later — it already did — so it is journaled as a recovery straight away
// and, unless failure notifications are off, shown once. The copy's date is in both:
// work done after it may be missing, and the user should know from when.
const DATA_RESTORE_KEYS = Object.freeze({
  // The title names the damaged file on its own: a collapsed Windows notification shows
  // only the title, and "restored" without the reason left the owner asking why (2026-11-01).
  config: { journal: 'journal.configRestored', title: 'notify.configRestoredTitle', body: 'notify.configRestoredBody' },
  library: { journal: 'journal.libraryRestored', title: 'notify.libraryRestoredTitle', body: 'notify.libraryRestoredBody' },
  'folder-state': {
    journal: 'journal.folderStateRestored', title: 'notify.folderStateRestoredTitle', body: 'notify.folderStateRestoredBody',
  },
});
function reportDataRestored(kind, takenAt) {
  const keys = DATA_RESTORE_KEYS[kind];
  if (!keys) return;
  let date = '';
  try {
    date = new Date(takenAt).toLocaleString(effectiveLang(), {
      day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    });
  } catch { date = new Date(takenAt).toISOString(); }
  const params = { date };
  eventLog.append({ channel: 'data-restore', kind: 'recovered', messageKey: keys.journal, params });
  if (config.notifyOnFailure === false) return;
  deliverSystemNotification({ titleKey: keys.title, bodyKey: keys.body, params });
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
// two for the same event. 'superseded' (TRG-004) is a scheduler's wish that went stale
// before it reached the desktop: nothing was tried, and the newer wish reports its own.
const APPLY_EXPECTED_REASONS = new Set(['no-wallpaper', 'gamemode-blocked', 'wallpaper-missing', 'superseded']);

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

// DATA-001. The last good copies of the three small data files, in <profile>\backups.
// A damaged one is replaced by its newest copy at startup (the loaders ask through
// `restore`); copies are taken at startup, on an hourly check and after a folder move.
const dataSnapshots = createDataSnapshots({
  dir: path.join(app.getPath('userData'), 'backups'),
  kinds: {
    config: { file: CONFIG_PATH, accept: (text) => configMod.isLoadableText(text) },
    library: { file: libraryStore.storePathFor(CONFIG_PATH), accept: (text) => libraryStore.isHealthyText(text) },
    'folder-state': { file: FOLDER_STATE_PATH, accept: (text) => folderState.isLoadableText(text) },
  },
});
const restoreDataCopy = (kind) => dataSnapshots.findGood(kind);
const DATA_SNAPSHOT_CHECK_MS = 60 * 60 * 1000;

// DATA-006 + CODE-001 2.1b. Where Znada's own copies live, local photo import and remote
// download staging belong to src/managed-folder.js. main.js keeps one-line wrappers so
// the ~40 call sites and every harness suite stay unchanged.
const managedFolder = createManagedFolder({
  userDataPath: app.getPath('userData'),
  getConfig: () => config,
  getHiddenDirs: () => liveFolderIndex.listHiddenDirs().map((d) => d.path),
  liveMaterializeExtra: (srcPath, type) => liveMaterializeExtra(srcPath, type),
  dirExists: (p) => dirExists(p),
  getExeDir: () => { try { return path.dirname(app.getPath('exe')); } catch { return ''; } },
});
function wallpapersDir() { return managedFolder.wallpapersDir(); }
function trashDirPath() { return managedFolder.trashDirPath(); }
function refreshManagedRoot() { return managedFolder.refresh(); }
function managedRootInvalid() { return managedFolder.invalid(); }
function managedRootStatus() { return managedFolder.status(); }
function managedRootReady() { return managedFolder.ready(); }
function importWallpaper(srcPath) { return managedFolder.importWallpaper(srcPath); }
function photoForPool(srcPath) { return managedFolder.photoForPool(srcPath); }
function stageDownloadImage(dir, url, fetchOptions) { return managedFolder.stageDownloadImage(dir, url, fetchOptions); }
function commitDownloadArtifact(artifact, dir) { return managedFolder.commitDownloadArtifact(artifact, dir); }
function discardDownloadArtifact(artifact, dir) { return managedFolder.discardDownloadArtifact(artifact, dir); }
function downloadImageTo(dir, url, fetchOptions) { return managedFolder.downloadImageTo(dir, url, fetchOptions); }
function downloadWallpaperFromUrl(url, fetchOptions) { return managedFolder.downloadWallpaperFromUrl(url, fetchOptions); }

// Дефолты + load/migrate/save вынесены в ./src/config.js (тестируется: test/config.test.js).
// The config object stays here (CODE-001 2.1a, R2). WRITING it — config.json, the pool
// file, the order between them and both "do not write" modes — belongs to
// src/config-store.js, whose flags and batched pool writer nothing in this file can reach.
let config = configMod.freshDefaults();
const configStore = createConfigStore({
  configPath: CONFIG_PATH,
  configMod,
  libraryStore,
  poolConsistency,
  normalizeOnlineSources: (sources) => onlineSources.normalize(sources, providerRegistry.PROVIDERS),
  getConfig: () => config,
  setConfig: (next) => { config = next; },
  onLoaded: () => refreshManagedRoot(),
  broadcast: () => broadcastConfig(),
  notify: (channel, messageKey, options) => reportChannelFailure(channel, messageKey, options),
  randomId: () => crypto.randomBytes(16).toString('hex'),
  restore: restoreDataCopy,
  reportRestored: (kind, takenAt) => reportDataRestored(kind, takenAt),
});

function loadConfig() { configStore.load(); }

// CODE-001 2.2a. The pool core — the library lock, the single funnel into the pool,
// revival of a removed photo, "what is in use" for the delete guard, single record
// removal and trash rows — belongs to src/library-service.js. The removed-marks stay in
// the live-folder index and are reached through the narrow port below; main.js keeps
// one-line wrappers under the old names so the call sites and harness suites stay put.
// The same port serves the removal line below (CODE-001 2.2b), which also lists the marks.
const { createLiveFolderIndex } = require('./src/live-folder-index');
const liveFolderIndex = createLiveFolderIndex({
  filePath: FOLDER_STATE_PATH, folderState, pathKey,
  restore: restoreDataCopy,
  onRestored: (takenAt) => reportDataRestored('folder-state', takenAt),
});
const libraryMarks = liveFolderIndex.marks;
const libraryService = createLibraryService({
  library,
  playlist,
  pathKey,
  getConfig: () => config,
  slotFor: (monitorId, theme) => slotFor(monitorId, theme),
  localImport: {
    // This port performs IO and issues authority, never mutates the pool or a slot.
    inspectPath: (src, forSlot) => {
      if (!itemDetails.isValidAbsolutePath(src)) return '';
      const stats = fs.statSync(src);
      if (stats.isDirectory()) return 'folder';
      if (!stats.isFile()) return '';
      const accepted = forSlot ? playlist.IMG_EXTS : playlist.LIBRARY_EXTS;
      if (accepted.has(path.extname(src).toLowerCase())) return 'photo';
      return forSlot && mediaFormats.isVideoPath(src) ? 'video' : '';
    },
    preparePhoto: (src) => photoForPool(src),
    grantFile: (src) => grantMediaPath(src),
    grantFolder: (src) => grantMediaPath(src, { root: true }),
  },
  marks: libraryMarks,
  liveFolders: { forget: (id) => forgetLiveFolder(id), sync: () => syncLiveFolderWatchers() },
  storeSlideshowPosition: (monitorId, theme, position) => storeSlideshowPosition(monitorId, theme, position),
});
function withLibraryLock(fn) { return libraryService.withLock(fn); }
function clearRemovedState(paths) { return libraryService.clearRemovedState(paths); }
function addToPool(type, srcPath, extra) { return libraryService.addToPool(type, srcPath, extra); }
function removeFromLibrary(id) { return libraryService.removeRecord(id); }
// markRecordRevived, inUsePaths and dropFromTrash had no caller left here after 2.2b: the
// removal module receives the whole core as `pool`.

// CODE-001 2.2b. The removal line — remove, Undo, the "Removed" section, restore, delete
// into the Recycle Bin — and the pending Undo it keeps. Everything is read lazily: the
// handlers that use it are registered further down, after these functions exist.
const libraryRemoval = createLibraryRemoval({
  library,
  libraryStore,
  pathKey,
  getConfig: () => config,
  pool: libraryService,
  marks: libraryMarks,
  liveFolders: {
    forget: (ids) => forgetLiveFolders(ids),
    sync: () => syncLiveFolderWatchers(),
    refresh: (ids) => requestLiveFolderRefresh(ids),
    notifyViewStale: (reason) => notifyLibraryViewStale(reason),
  },
  wallpaper: {
    apply: () => applyForTheme(null, true),
    storeSlideshowPosition: (monitorId, theme, position) => storeSlideshowPosition(monitorId, theme, position),
    gc: () => gcWallpapers(),
  },
  save: () => saveConfig(),
  broadcast: () => broadcastConfig(),
  refreshTray: () => trayCtl.refresh(),
  ownCopies: {
    isOwnCopy: (p) => isOwnWallpaperCopy(p),
    rootReady: () => managedRootReady(),
    trashDir: () => trashDirPath(),
  },
  physicalDeleteEnabled: () => physicalDeleteEnabled,
  askDeleteForever: (targets) => askDeleteForever(targets),
  trashItem: (p) => shell.trashItem(p),
  fs,
  now: () => Date.now(),
  randomHex: (bytes) => crypto.randomBytes(bytes).toString('hex'),
});

// The four ways to save, under the names the handlers already use. What each guarantees
// (pool before settings, inline copy while the pool file is unusable, settings-only never
// touching the pool) is written and tested in src/config-store.js.
function saveLibrarySoon() { configStore.markPoolDirty(); }
function savePoolOnly() { configStore.savePool(); }
function saveConfig() { return configStore.save(); }
function saveSettingsOnly() { return configStore.saveSettings(); }

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
// the shape they have on disk. Config/pool stay live; remapMediaRoot deep-clones its
// input. The index supplies its own detached snapshot so move code cannot mutate it.
function mediaMoveDocuments() {
  return {
    config,
    store: {
      version: 1,
      library: config.library,
      trash: Array.isArray(config.libraryTrash) ? config.libraryTrash : [],
    },
    folderState: liveFolderIndex.snapshot(),
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
    const problem = managedFolder.folderProblem(targetFolder);
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
    liveFolderIndex.replaceForMove(documents.folderState);
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
  if (configStore.writesBlocked()) {
    return { status: 'blocked', blockers: [{ code: 'library-degraded' }] };
  }
  const blockers = mediaMoveBlockers(targetFolder, { toAppFolder });
  if (blockers.length) return { status: 'blocked', blockers };

  const target = managedFolder.resolveTarget(targetFolder);
  const from = wallpapersDir();
  // BUG-050. Where our folder is meant to live: with the place there and the folder not
  // yet made, there is simply nothing to carry.
  const fromAnchor = managedFolder.current().anchor;
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
    // DATA-001. The old folder is gone now, so a copy taken before the move points every
    // own-copy at files that no longer exist. Copy the moved state at once rather than up
    // to four hours later.
    dataSnapshots.take('config', { force: true });
    dataSnapshots.take('library', { force: true });
    // What is on the desktop right now came from a file that no longer exists under
    // that name. Applying again from the new paths keeps the next change honest.
    try { await applyForTheme(null, true); } catch (err) { console.error('move: re-apply failed', err); }
  }
  return report;
}


function ensureAnonId() { configStore.ensureAnonId(); }
function persistSlideshowPosition() { configStore.persistPosition(); }

// Discovery state and its writer belong to liveFolderIndex; runtime queues stay here.
function hiddenPathSet() { return liveFolderIndex.hiddenPaths(); }
let liveFolderAspectTimer = null;
const pendingLiveFolderAspects = new Map();
let folderRefreshQueue = Promise.resolve();
const folderScanFreshAt = new Map();
const FOLDER_SCAN_FRESH_MS = 5000;
const LIVE_FOLDER_ASPECT_FLUSH_MS = 750;
let liveFolderWatcher = null;
const liveFolderWatcherRetryTimers = new Map();
let liveFolderFullScanTimer = null;
let liveFolderLastFullScanAt = 0;
const LIVE_FOLDER_FULL_SCAN_MS = 60 * 60 * 1000;

function loadLiveFolderState() { liveFolderIndex.load(); }
function flushLiveFolderState() { liveFolderIndex.flush(); }

function flushPendingLiveFolderAspects() {
  if (liveFolderAspectTimer) { clearTimeout(liveFolderAspectTimer); liveFolderAspectTimer = null; }
  if (!pendingLiveFolderAspects.size) return 0;
  const updates = Array.from(pendingLiveFolderAspects.values());
  pendingLiveFolderAspects.clear();
  const result = liveFolderIndex.setAspects(updates);
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
  liveFolderIndex.forget(ids);
  for (const id of (ids || [])) folderScanFreshAt.delete(id);
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
      liveFolderIndex.listImages(),
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

// The scan holds the library lock; the library owns all consequences of a rename.
function followMovedFiles(pairs) { return libraryRemoval.followMovedFiles(pairs); }

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
  libraryChecks.schedule(); // LIB-030: a photo left or came back without the pool changing
  if (!mainWindow || mainWindow.isDestroyed()) return;
  diagCountSend('live-folders-changed');
  mainWindow.webContents.send('live-folders-changed', { folderIds: [] });
}

function broadcastLiveFolderChanges(summaries, recheckFingerprints = false) {
  const changed = (Array.isArray(summaries) ? summaries : []).filter((summary) => summary && summary.changed);
  if (changed.length || recheckFingerprints) libraryChecks.schedule();
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
        const result = liveFolderIndex.reconcile({
          folderId: item.id,
          rootPath: item.path,
          folderAddedAt: item.addedAt,
          now: scanNow,
          status,
          entries,
        });
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
        // MEDIA-002: the index is what the Library shows, video included. The slideshow
        // never reads it — it scans with playlist.scanFolder.
        imageExts: playlist.LIBRARY_EXTS,
        batchSize: 10000,
        knownPaths: liveFolderIndex.knownPathKeys(item.id),
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
      // Before the clean-up below decides that the old name's record is dead. Ordered
      // with every other change to the pool: no one holding the lock waits for a scan.
      if (finalResult.moved && finalResult.moved.length) {
        const followed = await withLibraryLock(() => followMovedFiles(finalResult.moved));
        if (followed) changed = true;
      }
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
    // A forced scan can be triggered by a same-path replacement. The discovery
    // index skips stats for known files, so ask the background pass to remeasure.
    const recheckFingerprints = force && summaries.some(({ status }) => status === 'complete' || status === 'partial');
    broadcastLiveFolderChanges(summaries.filter((summary) => !summary.notified), recheckFingerprints);
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
// CODE-001: Windows transport is independent of wallpaper selection and schedules.
const wallpaperPlatform = wallpaperPlatformMod.create({
  userDataPath: app.getPath('userData'),
  getConfig: () => config, systemChildren, powershellExe: POWERSHELL_EXE,
  getPowerShellTimeout: () => systemChildTimeouts.powershell,
  createHost: (scriptPath) => new WallpaperHost(scriptPath, {
    killProcess: (proc) => systemChildren.killTree(proc),
  }),
  hostScript: HOST_SCRIPT,
});
const { isGameOrFullscreenRunning, setWallpaper } = wallpaperPlatform;
// Main's current monitor snapshot is also used by placement, the feed and stealth.
let monitorsCache = [];
async function getMonitors() {
  monitorsCache = await wallpaperPlatform.getMonitors();
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

// TRG-004. The theme schedule waits for a flip already under way before it decides again, so
// a flip must always end: a hung powershell would otherwise hold the schedule until restart.
// The system-child runner gives it that deadline (WIN-002, systemChildTimeouts.powershell).

function setWindowsTheme(isDark) {
  return systemChildren.run(
    POWERSHELL_EXE,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', THEME_SCRIPT_PATH, '-Light', isDark ? '0' : '1'],
    { timeoutMs: systemChildTimeouts.powershell }
  ).then(() => undefined);
}

// TRG-004. The theme schedule's one timer and its latest intent. A run that went stale while
// it waited (the schedule was switched off or changed, or a newer run started) flips nothing
// and arms nothing; a flip already under way finishes, and the newer run decides after it.
const themeIntent = createLatestIntent();
let lastScheduledTheme = null;

// Schedule math (parse/sun/boundaries) lives in src/schedule.js — pure & unit-tested.
// This wrapper binds the Windows-theme schedule from the live config.
function themeScheduleBoundaries(date) {
  return schedule.boundaries(config.themeSchedule, date);
}

function clearThemeTimer() {
  themeIntent.cancel();
}

// Apply the scheduled theme now (modes: time / sun) and schedule the next flip.
async function applyThemeSchedule() {
  const intent = themeIntent.begin();
  // A flip started by an earlier run cannot be taken back: wait for it, so this run compares
  // against the theme it left behind rather than the one before it.
  if (themeIntent.busy()) {
    await themeIntent.settle(intent);
    if (!themeIntent.isCurrent(intent)) return;
  }
  const sch = config.themeSchedule || {};
  if (sch.mode !== 'time' && sch.mode !== 'sun') return; // 'off' — Znada does not drive the theme
  const now = new Date();
  const b = themeScheduleBoundaries(now);
  if (!b) { themeIntent.arm(intent, applyThemeSchedule, 60 * 60000); return; } // no coords / polar — retry in 1h
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
    themeIntent.arm(intent, applyThemeSchedule, schedule.minutesUntilNextBoundary(b, now) * 60000 + 3000);
    return;
  }

  if (wantDark !== nativeTheme.shouldUseDarkColors) {
    if (config.gameModeBlock) {
      const busy = await isGameOrFullscreenRunning();
      if (!themeIntent.isCurrent(intent)) return; // switched off or changed while asking
      if (busy) {
        console.log('[GameMode] Theme schedule flip blocked. Will retry in 1 minute.');
        themeIntent.arm(intent, applyThemeSchedule, 60000);
        return;
      }
    }
    const flip = await themeIntent.dispatch(intent, () => setWindowsTheme(wantDark).then(
      () => reportChannelSuccess('theme-schedule', 'journal.themeSchedule'),
      (e) => {
        console.error('Не удалось сменить тему Windows:', e);
        reportChannelFailure('theme-schedule', 'journal.themeSchedule', {
          titleKey: 'notify.themeFailedTitle',
          bodyKey: 'notify.themeFailedBody',
        });
      }
    ));
    // Not started, or superseded while the flip ran: the newer run arms the timer.
    if (!flip.started || !themeIntent.isCurrent(intent)) return;
  }
  themeIntent.arm(intent, applyThemeSchedule, schedule.minutesUntilNextBoundary(b, now) * 60000 + 3000);
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

// TRG-004. The wallpaper schedule's one timer and its latest intent, as for the theme above.
// A run that went stale while it waited — switched off, changed, overtaken by a newer run —
// puts nothing on the desktop and arms nothing. An apply already sent cannot be taken back:
// it finishes, and the newer run's apply goes after it.
const wallpaperIntent = createLatestIntent();
function clearWallpaperTimer() {
  wallpaperIntent.cancel();
}
const runWallpaperSchedule = () => applyWallpaperSchedule(false, true);

// Apply the independent wallpaper schedule now and arm its next boundary. `applyNow`
// is false when another scheduler (the slideshow) already applied the current frame.
async function applyWallpaperSchedule(isManual = false, applyNow = true) {
  const intent = wallpaperIntent.begin();
  const sch = wallpaperScheduleConfig();
  if (config.separateThemes === false || (sch.mode !== 'time' && sch.mode !== 'sun')) return;

  const now = new Date();
  const b = schedule.boundaries(sch, now);
  if (!b) {
    wallpaperIntent.arm(intent, runWallpaperSchedule, 60 * 60000);
    return;
  }

  const theme = schedule.saysDark(b, now) ? 'dark' : 'light';
  broadcastWallpaperTheme(theme);
  if (applyNow) {
    // The wish depends on the clock alone, so unlike the theme there is nothing to settle
    // before deciding it. dispatch() still waits for an apply under way, so wishes reach the
    // desktop in the order they were made even on the spawned fallback, where two applies
    // would otherwise race; applyForTheme itself stops a wish that goes stale on the way.
    const run = await wallpaperIntent.dispatch(intent, () => applyForTheme(theme, isManual, null, {
      stillWanted: () => wallpaperIntent.isCurrent(intent),
    }));
    // Not started, or superseded on the way: the newer run arms the timer.
    if (!run.started || !wallpaperIntent.isCurrent(intent)) return;
    if (run.value && run.value.reason === 'gamemode-blocked') {
      wallpaperIntent.arm(intent, runWallpaperSchedule, 60000);
      return;
    }
  }
  wallpaperIntent.arm(intent, runWallpaperSchedule, schedule.minutesUntilNextBoundary(b, now) * 60000 + 3000);
}

// Wallpaper mode 'system' without the slideshow: put up the slot of the theme Windows has now.
// TRG-004 stage 3. It runs on the wallpaper schedule's intent — the two modes never run at the
// same time, and switching the mode cancels it — so a flip during a game is retried in a minute
// instead of being lost.
async function followWindowsTheme() {
  // Checked before begin(): in another mode this must not touch the schedule's own timer.
  if (config.separateThemes === false || !config.wallpaperSchedule || config.wallpaperSchedule.mode !== 'system') return;
  if (config.slideshow && config.slideshow.enabled) return; // the slideshow owns the frame then
  const intent = wallpaperIntent.begin();
  const run = await wallpaperIntent.dispatch(intent, () => applyForTheme(null, false, null, {
    stillWanted: () => wallpaperIntent.isCurrent(intent),
  }));
  if (!run.started || !wallpaperIntent.isCurrent(intent)) return;
  if (run.value && run.value.reason === 'gamemode-blocked') wallpaperIntent.arm(intent, followWindowsTheme, 60000);
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
    configStore.markPositionDirty();
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
  // DATA-001: also while this session runs on a restored copy (configStore.sweepBlocked).
  if (configStore.sweepBlocked()) return;
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
      let st;
      try { st = fs.statSync(full); if (!st.isFile()) continue; } catch { continue; }
      // BUG-087: an import or download may be writing this file right now —
      // remove-slot-item and clear-slot sweep outside the library lock. Moving it made
      // the import fail and left a .tmp in .trash.
      if (stagingInFlight(f, st.mtimeMs)) continue;
      if (!keep.has(pathKey(full))) {
        // BUG-084: never renameSync here — on Windows it replaces a file already in
        // .trash under the same name. moveNoClobber picks a free name instead.
        try { moveNoClobber(full, trashDirPath()); } catch { /* оставляем как есть, не удаляем */ }
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
  return legacyGlobalWallpaper(theme);
}

// The two pre-library globals. Nothing in the app writes them any more, but a profile can
// still carry them; a video there must not reach the desktop either (MEDIA-002).
function legacyGlobalWallpaper(theme) {
  const p = (theme === 'dark' ? config.darkWallpaper : config.lightWallpaper) || '';
  return mediaFormats.isVideoPath(p) ? '' : p;
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
// `stillWanted` is for a scheduler (TRG-004): see applyForThemeCore.
async function applyForTheme(themeName, isManual = false, targetMonitors = null, { stillWanted = null } = {}) {
  const endSpan = diagSpan('wallpaper', 'apply');
  try {
    const result = await applyForThemeCore(themeName, isManual, targetMonitors, stillWanted);
    // Only known short reasons; a raw error message may carry a file path and
    // redaction does not exist until stage 4.
    const reason = result && result.ok ? 'ok' : ((result && result.reason) || 'error');
    endSpan({ status: ['ok', 'gamemode-blocked', 'no-wallpaper', 'wallpaper-missing', 'superseded'].includes(reason) ? reason : 'error' });
    reportApplyOutcome(result, isManual); // journal + edge-triggered notification (T2/T3)
    return result;
  } catch (err) {
    endSpan({ status: 'error' });
    reportApplyOutcome({ ok: false, reason: 'exception' }, isManual);
    throw err;
  }
}

// TRG-004. A scheduler passes `stillWanted`: "is this still my latest wish?". It is asked
// after the waits below and before each of the three ways a wallpaper goes up — the live
// host, a spawned COM process, one image for every monitor — so a wish that went stale
// meanwhile never reaches the desktop and reports nothing. Other callers pass nothing.
async function applyForThemeCore(themeName, isManual = false, targetMonitors = null, stillWanted = null) {
  const theme = config.separateThemes === false ? 'light' : (themeName || wallpaperThemeName());
  const superseded = () => typeof stillWanted === 'function' && !stillWanted();
  const SUPERSEDED = { ok: false, reason: 'superseded', theme };
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
    if (superseded()) return SUPERSEDED; // the game check or the monitor list took its time
    persistSlideshowPosition();
    if (!items.length) {
      return { ok: false, reason: outcome.reason, theme, missing: outcome.missingPaths, sourcesChecked: true };
    }
    const applied = await wallpaperPlatform.applyPerMonitor(items, superseded);
    if (applied === 'superseded') return SUPERSEDED;
    if (applied === 'applied') {
      return { ok: true, theme, missing: outcome.missingPaths, sourcesChecked: true };
    }
  }

  if (superseded()) return SUPERSEDED;
  // Fallback: single wallpaper for all monitors (older Windows / COM failure)
  const target = legacyGlobalWallpaper(theme);
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
// ---------------------------------------------------------------------------
// TRG-004 stage 3. The slideshow's one timer — the interval, or the one-minute game retry —
// and its latest intent, on the same controller as the theme and wallpaper schedules. Every
// start begins a new intent: the interval's turn, a retry, a manual "next", a picked frame, a
// theme flip, a settings change, the end of an invisible change. A run that went stale while
// it waited moves no frame, applies nothing and arms nothing.
const slideshowIntent = createLatestIntent();
// HOME-001: Главная показывает живой отсчёт, поэтому момент срабатывания таймера и
// причина, по которой честного момента НЕТ, живут рядом с самим таймером: момент —
// у контроллера (state().dueAt), причина — здесь. Второго набора «когда сменится» в
// приложении нет.
let slideshowHold = null;      // 'gamemode' — таймер лишь перепроверяет, а не сменит

function beginSlideshowRun() {
  slideshowHold = null;
  const intent = slideshowIntent.begin();
  pushNextChange();
  return intent;
}

// Switched off (or handed to an invisible change): no run is current and no timer is left.
function clearSlideshowTimer() {
  slideshowIntent.cancel();
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

// Arm the interval for a run that is still current, counted from now.
function armSlideshowInterval(intent, delayMs = slideshowIntervalMs()) {
  if (!slideshowIntervalEnabled()) return;
  const delay = Math.max(1, Math.floor(Number(delayMs) || slideshowIntervalMs()));
  if (slideshowIntent.arm(intent, runSlideshowInterval, delay)) pushNextChange();
}

// Restart the interval from now, superseding whatever was armed or still waiting.
function scheduleSlideshowTimer(delayMs) {
  armSlideshowInterval(beginSlideshowRun(), delayMs);
}

// Игровой режим/полный экран: таймер ниже НЕ меняет обои, он через минуту снова
// спрашивает систему. Поэтому взводим его с пометкой hold — интерфейс не должен
// превратить эту минуту в обещание «через 1 мин». Через минуту делается то, что
// отложили: смена кадра остаётся сменой, а показ текущего кадра (смена темы, настройки)
// остаётся показом — и не теряется, когда интервал выключен.
function retrySlideshowSoon(intent, advance) {
  if (!config.slideshow || !config.slideshow.enabled) return;
  if (slideshowIntent.arm(intent, () => runSlideshowRetry(advance), 60000)) {
    slideshowHold = 'gamemode';
    pushNextChange();
  }
}

// The game question of an automatic run: 'go', 'stale' (superseded while asking) or 'blocked'
// (a game is on; the retry is armed for this run).
async function slideshowGameCheck(intent, advance) {
  if (!config.gameModeBlock) return 'go';
  const busy = await isGameOrFullscreenRunning();
  if (!slideshowIntent.isCurrent(intent)) return 'stale';
  if (busy) {
    console.log('[GameMode] Slideshow rotation blocked. Will retry in 1 minute.');
    retrySlideshowSoon(intent, advance);
    return 'blocked';
  }
  if (slideshowHold) { slideshowHold = null; pushNextChange(); } // the game is over
  return 'go';
}

// The interval's turn: one frame on.
function runSlideshowInterval() {
  return runSlideshowTurn(true, false);
}

// The minute after a game: do what was postponed.
function runSlideshowRetry(advance) {
  return runSlideshowTurn(advance, true);
}

// A retry keeps "paused for a game" on the Home page while it asks again, so the page does not
// blink to "soon" every minute of a game; the pause goes when the game does.
async function runSlideshowTurn(advance, retry) {
  const hold = slideshowHold;
  const intent = beginSlideshowRun();
  if (retry) slideshowHold = hold;
  const wanted = advance ? slideshowIntervalEnabled() : !!(config.slideshow && config.slideshow.enabled);
  if (!wanted) {
    slideshowHold = null;
    pushNextChange();
    return;
  }
  if (await slideshowGameCheck(intent, advance) !== 'go') return;
  if (advance && stealthScoped('interval')) {
    requestWallpaperAdvance('interval', { initialDelayMs: 0, rescheduleInterval: true });
    return;
  }
  await slideshowStep(intent, advance, false);
}

// Move every monitor one frame on if asked, apply the current frame, arm the interval. The
// move happens when the apply starts, so a run superseded while it waited for an apply already
// under way moves nothing; dispatch() keeps the slideshow's applies in the order they were made.
async function slideshowStep(intent, advance, isManual) {
  const run = await slideshowIntent.dispatch(intent, () => {
    const theme = wallpaperThemeName();
    // Slideshow position only — the pool is untouched, so this must not schedule a full
    // rewrite of every photo record. This is the most frequent write in the app.
    if (advance) { advanceIndices(theme); saveSettingsOnly(); }
    return applyForTheme(theme, isManual, null, { stillWanted: () => slideshowIntent.isCurrent(intent) });
  });
  // Not started, or superseded on the way: the newer run reports and arms.
  if (!run.started || !slideshowIntent.isCurrent(intent)) return undefined;
  if (run.value && run.value.reason === 'gamemode-blocked') {
    // The apply asked about a game once more and one had started: the frame has moved, so
    // the retry only shows it.
    retrySlideshowSoon(intent, false);
    return run.value;
  }
  armSlideshowInterval(intent);
  return run.value;
}

// Returns the applyForTheme result on the paths that actually apply, so manual
// triggers (Home button, hotkey) can report an honest outcome to the user.
// Auto-only early exits keep returning undefined — their callers ignore it.
async function tickSlideshow(advance, isManual = false) {
  const intent = beginSlideshowRun();
  if (!config.slideshow || !config.slideshow.enabled) return;
  // A timer may already be queued when the user disables the interval trigger.
  if (advance && !isManual && !slideshowIntervalEnabled()) return;
  if (!isManual) {
    const game = await slideshowGameCheck(intent, advance);
    if (game === 'stale') return;
    if (game === 'blocked') return { ok: false, reason: 'gamemode-blocked' };
  }
  return slideshowStep(intent, advance, isManual);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const TITLEBAR_HEIGHT = 44;

function titleBarOverlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    // Цвет ПОЛОСЫ шапки (--headerbar в renderer/styles.css), а не фона страницы. Windows
    // рисует область кнопок непрозрачно поверх страницы, и этот цвет решает, видно ли шов
    // между полосой и кнопками: при равенстве полоса читается как сплошная во всю ширину
    // окна, при любом другом цвете зона кнопок становится заметным прямоугольником.
    // Разойтись этим двум значениям не даёт test/caption-palette.test.js.
    // backgroundColor окна ниже — другое и совпадать не обязано: это фон СТРАНИЦЫ, то есть
    // первый кадр до отрисовки, а не цвет шапки.
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
  // LIB-030: copies found while the window sat in the tray are announced now.
  mainWindow.on('show', () => sendLibraryChecks());
  mainWindow.on('restore', () => sendLibraryChecks());
  // A renderer crash/hide must never leave all app shortcuts suspended. The
  // recording UI also resumes explicitly, but main owns this final fail-safe.
  mainWindow.on('hide', resumeHotkeys);
  mainWindow.on('hide', () => { mainWindow.webContents.send('content-blur-reset'); });

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

// Copy, so a later setBounds cannot rewrite the rect remembered for leaving fullscreen.
function placeGalleryWindow(win, area) {
  if (!win || !area) return;
  win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height });
}

let galleryVideo = null;
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
  galleryVideo = createVideoPlayer({ app, sharedTexture, window: galleryWindow,
    createWorker: () => utilityProcess.fork(path.join(__dirname, 'src', 'video-worker.js'), [], { serviceName: 'Znada video decoder', stdio: 'ignore' }),
    resolveEntry(index) {
      const entry = galleryPayload.items[index];
      if (entry?.kind === 'internet' && online.allowedVideo(entry.raw)) {
        return { online: entry.raw, headers: providerAccess.requestHeaders(entry.raw) };
      }
      return entry && (entry.kind === 'library' || entry.kind === 'path')
        && mediaFormats.isVideoPath(entry.path) && isAuthorizedMediaPath(entry.path) ? { path: entry.path } : null;
    },
    async openExternal(entry) {
      if (!entry || !mediaFormats.isVideoPath(entry.path) || !isAuthorizedMediaPath(entry.path)) return { ok: false };
      const error = await shell.openPath(entry.path);
      return { ok: !error };
    },
  });
  const ownedVideo = galleryVideo;
  galleryWindow.webContents.on('render-process-gone', () => ownedVideo.reset());
  galleryWindow.webContents.on('did-start-loading', () => ownedVideo.reset());
  galleryWindow.on('close', () => ownedVideo.dispose());
  // BUG-052. The constructor applies this size with the primary monitor's scale.
  // On the portrait display (125%, work area 960×1536 at x=1920) that came out
  // 1200×1292: wider than the monitor and short of its bottom, so the picture sat
  // on the right and the forward arrow was off screen. setBounds, once the window
  // exists on that display, keeps the work area that was asked for. Show does not
  // undo it; the call is repeated at ready-to-show in case loading the page does.
  placeGalleryWindow(galleryWindow, bounds);

  if (diagnosticsController) diagnosticsController.attachWindowEvents(galleryWindow, 'viewer');
  if (DEV_LAUNCH_INFO) galleryWindow.on('page-title-updated', (event) => event.preventDefault());

  galleryWindow.loadFile(hardenWindow(galleryWindow, 'viewer'));

  galleryWindow.webContents.on('console-message', ({ message, sourceId, lineNumber }) => {
    console.log(`[Viewer Console] ${message} (${sourceId}:${lineNumber})`);
  });

  galleryWindow.once('ready-to-show', () => {
    endOpenSpan();
    if (!galleryWindow || galleryWindow.isDestroyed()) return;
    placeGalleryWindow(galleryWindow, galleryWindowNormalBounds);
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
    ownedVideo.dispose();
    if (galleryVideo === ownedVideo) galleryVideo = null;
    galleryWindow = null;
    galleryWindowNormalBounds = null;
    galleryWindowFullscreen = false;
  });
}

function openGalleryWindow(payload) {
  if (galleryVideo) galleryVideo.stop();
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
  checkCovered: () => wallpaperPlatform.checkCovered(),
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

// A manual wallpaper change (a picked frame, an assigned photo, "next" for one monitor) takes
// over from the slideshow: a pending invisible change and a run still waiting must not move
// the frame after it. Call this before the apply; it returns the run the change belongs to.
function supersedeSlideshowForManualChange() {
  cancelPendingStealth();
  return beginSlideshowRun();
}

// …and after the apply: the interval restarts from the change, unless something newer did.
function rescheduleSlideshowAfterManualWallpaperChange(intent) {
  armSlideshowInterval(intent);
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
    dueAt: slideshowIntent.state().dueAt,
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
    const intent = supersedeSlideshowForManualChange();
    advanceIndices(theme, targetMonitors);
    saveSettingsOnly();  // position only
    try {
      return await applyForTheme(theme, true, targetMonitors);
    } finally {
      rescheduleSlideshowAfterManualWallpaperChange(intent);
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

// ---- LIB-030: the background pass over the library and its first check -----------------
// One pass, many checks later (owner, 2026-11-02); today it finds identical files. It
// reads fingerprints through META-001's cache, never touches the network and never changes
// a file or a record. What the library holds, whether a game is running and whether the
// user switched it off stay main's and are read at the moment of use.
function libraryCheckFiles() {
  const files = new Map();
  for (const it of Object.values(config.library || {})) {
    if (!it || it.type !== 'image' || !it.path) continue;
    files.set(pathKey(it.path), { path: it.path, size: it.size, video: mediaFormats.isVideoPath(it.path) });
  }
  // Removed photos are already absent from this list (folder-state's default view).
  for (const im of liveFolderIndex.listImages()) {
    if (!im || !im.path) continue;
    const key = pathKey(im.path);
    const existing = files.get(key);
    files.set(key, { path: existing ? existing.path : im.path, size: im.size,
      video: mediaFormats.isVideoPath(im.path), watched: true });
  }
  return Array.from(files.values());
}

const libraryChecks = createLibraryChecks({
  configPath: CONFIG_PATH,
  isEnabled: () => !config.libraryChecks || config.libraryChecks.duplicates !== false,
  listFiles: libraryCheckFiles,
  fingerprint: (p) => metadataService.fingerprint(p),
  // LIB-031. Without reading the file: what the Online cards can know right after launch.
  cachedFingerprint: (p) => metadataService.cachedFingerprint(p),
  // A move of Znada's own folder copies files the pass would otherwise be reading.
  isBusy: () => mediaMoveRunning || isGameOrFullscreenRunning(),
  onChange: (summary) => sendLibraryChecks(summary),
  // LIB-031. What the library holds may have changed: the window re-asks its Online cards.
  onHaveChange: () => sendLibraryHaveChanged(),
});

// LIB-031. "This Online card is a photo you already have": matched against what the pass
// knows, never the network. The record, when the photo has one, so the card acts on it.
const onlineHaveMatcher = onlineHave.create({
  finder: () => libraryChecks.finder(),
  readHeader: (p) => itemDetails.readHeaderFromDisk(p),
  recordFor: (p) => {
    const pool = config.library || {};
    const direct = library.getItem(pool, library.idFor(p));
    if (direct && direct.type === 'image') return direct;
    const key = pathKey(p);
    for (const it of Object.values(pool)) {
      if (it && it.type === 'image' && it.path && pathKey(it.path) === key) return it;
    }
    return null;
  },
});

function sendLibraryHaveChanged() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  diagCountSend('library-have-changed');
  mainWindow.webContents.send('library-have-changed');
}

// The window may only announce copies when someone can see it. Main knows for certain
// whether the window is on screen (started in the tray, hidden, minimized), so it says so
// with every summary and sends one again when the window is shown or restored.
function libraryChecksForWindow(summary) {
  return { ...summary, windowShown: liveFolderWindowVisible() };
}

function sendLibraryChecks(summary = libraryChecks.summary()) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  diagCountSend('library-checks-changed');
  mainWindow.webContents.send('library-checks-changed', libraryChecksForWindow(summary));
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
  // LIB-030. A pool change may add or remove a copy. A pass already waiting is not pushed
  // back, and one that finds every fingerprint in the cache costs a few stats.
  libraryChecks.schedule();
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
  'favorites-list', 'bookmark-resolve', 'bookmark-tags', 'bookmark-sync-status', 'bookmark-sync-retry',
  'add-slot-folder', 'add-slot-images', 'add-slot-paths', 'apply-now', 'check-for-updates',
  'clear-slot', 'cloud-favorite', 'cloud-favorites', 'cloud-session', 'cloud-signin',
  'cloud-signin-cancel', 'cloud-signout', 'create-shortcuts', 'current-image',
  'cycle-theme-override',
  'detect-location', 'event-log-clear', 'event-log-get', 'expand-folders', 'feature-flags',
  'folder-entries', 'folder-info', 'gallery-open', 'get-cloud-capability', 'get-config',
  'get-monitors', 'get-release-info', 'get-theme', 'get-update-state', 'get-version', 'get-wallpaper-theme',
  'install-update', 'internet-search', 'internet-status', 'internet-tag-suggest',
  'item-copy-path', 'details-copy-tag', 'item-details', 'item-open-source', 'item-reveal', 'library-add-folder',
  'library-add-images', 'library-add-paths', 'library-add-tag', 'library-assign-record',
  'library-assign-records', 'library-delete-forever', 'library-ensure-sizes',
  'library-hidden-list', 'library-materialize', 'library-path-sizes', 'library-recent',
  'library-removal-answer',
  'library-refresh', 'library-remove-tag', 'library-restore', 'library-toggle-favorite',
  'media-folder-move', 'media-folder-pick', 'media-folder-plan', 'media-folder-state',
  'media-folder-stop',
  'library-checks-state', 'library-checks-ack', 'library-duplicates',
  'next-change-get', 'next-wallpaper', 'open-releases', 'open-video', 'open-website', 'quit-app',
  'remove-slot-item', 'set-autostart', 'set-config', 'set-hotkey', 'set-hotkey-recording',
  'set-slideshow', 'set-slideshow-index', 'set-slideshow-to-path', 'set-start-minimized',
  'media-motion-many', 'shortcuts-status', 'thumb', 'thumb-aspects', 'thumb-info',
  'online-have-many',
];

// Both windows show cards, so both need the actions behind a card's menu (ONL-009).
// `media-motion` (BUG-035) reads no more than `file-url` already hands the viewer: the
// same authorized files, and only whether they move.
const IPC_MAIN_AND_VIEWER = [
  'favorite-state', 'favorite-set',
  'card-copy-file', 'card-copy-link', 'card-open-source', 'card-save-as', 'cloud-add',
  'file-url', 'get-i18n', 'internet-add', 'internet-cancel-video', 'item-lookup-metadata',
  'library-assign', 'library-remove-many', 'library-undo-remove', 'media-motion',
];

// The fullscreen viewer's own window controls.
const IPC_VIEWER_ONLY = [
  'card-assign-targets', 'card-ensure-record', 'gallery-close', 'gallery-payload',
  'gallery-toggle-fullscreen', 'gallery-video',
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
  'favorite-set', 'bookmark-tags',
  'add-slot-folder', 'add-slot-images', 'add-slot-paths', 'card-ensure-record', 'clear-slot',
  'cloud-add', 'internet-add', 'item-lookup-metadata', 'library-add-folder',
  'library-add-images', 'library-add-paths',
  'library-add-tag', 'library-assign', 'library-assign-record', 'library-assign-records',
  'library-delete-forever', 'library-ensure-sizes', 'library-materialize', 'library-refresh',
  'library-remove-many',
  'library-remove-tag', 'library-restore', 'library-toggle-favorite', 'library-undo-remove',
  'remove-slot-item', 'set-slideshow-to-path',
]);

const ipcAuthority = ipcAuthorityMod.create({ ipcMain: electronIpcMain, roles: IPC_ROLES });
// Every `ipcMain.handle` below is that guarded door. The name is kept so the call sites read
// as they always did — and so the contract test keeps finding them where it expects.
const ipcMain = {
  handle: (channel, fn) => ipcAuthority.handle(channel, (event, ...args) => {
    // What the refusal looks like depends on who reads it: src/library-freeze.js.
    if (mediaMoveRunning && LIBRARY_EDIT_CHANNELS.has(channel)) return libraryFreeze.refusal(channel, config);
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
// SEC-002, slice 4. Sandbox stays on for every role, including diagnostics (QA-009).
// The probe is a separate script now, not a relative load inside the app preloads.
// An unknown role is refused so a typo cannot quietly drop the sandbox.
function windowSecurity(role) {
  if (role !== 'main' && role !== 'viewer' && role !== 'diagnostics') {
    throw new Error(`windowSecurity: unknown window role '${role}'`);
  }
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
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

// DESIGN-012. Дату выхода вшивает только официальная сборка (release-info.json рядом с
// app.asar); у DEV и обычной сборки её нет, и «О программе» показывает один номер.
// Текст «Что нового» — запись этой версии; язык выбирает окно, оно знает свой.
function readReleaseDate() {
  if (!app.isPackaged) return null;
  try {
    const raw = fs.readFileSync(path.join(process.resourcesPath, whatsNew.STAMP_FILE), 'utf8');
    return whatsNew.stampDate(raw, app.getVersion());
  } catch { return null; }
}
ipcMain.handle('get-release-info', () => ({
  version: app.getVersion(),
  date: readReleaseDate(),
  notes: WHATS_NEW[app.getVersion()] || null,
}));

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

// TELEM-001. The mandatory minimal usage signal; the schedule and the whole contract live
// in src/usage-ping.js, including which builds send at all (`isSender`). The test harness
// is never online.
// The `telemetry` settings switch is a different, optional feature and is not consulted.
let usagePingCtl = null;
function startUsagePing() {
  const cap = cloudCapability();
  if (!usagePingMod.isSender({ isPackaged: app.isPackaged, environment: cap.environment, apiBase: cap.apiBase })) return;
  usagePingCtl = usagePingMod.createUsagePing({
    isOnline: () => !!(net && typeof net.isOnline === 'function' && net.isOnline()),
    getVersion: () => app.getVersion(),
    isValidVersion: (v) => cloudContracts.UsagePingRequest.safeParse({ app_version: v }).success,
    loadState: () => config.usagePing,
    // Only a mark that reached the disk stays in memory: otherwise a later settings save
    // would store "used" for an attempt that was never sent.
    saveState: (state) => {
      const previous = config.usagePing;
      config.usagePing = state;
      if (configStore.persistUsagePing()) return true;
      config.usagePing = previous;
      return false;
    },
    send: (version) => {
      const client = cloudClient();
      return client ? client.usagePing(version) : Promise.resolve({ status: 0, code: 'no_client' });
    },
    log: (...args) => console.log('[usage]', ...args),
  });
  usagePingCtl.start();
}

// Cloud session state has one owner; only renderer-safe state is broadcast here.
// ONL-002 stage 3: bookmark sync follows the account; set once favorites exist below.
let onCloudSessionChange = () => {};
const cloudSession = createCloudSession({
  cloudClient, cloudCapability, cloudOauth,
  buildGoogleStartUrl: cloudClientMod.buildGoogleStartUrl,
  getUserDataPath: () => app.getPath('userData'),
  safeStorage,
  openExternal: (url) => shell.openExternal(url),
  publishState: (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cloud-session-changed', state);
    onCloudSessionChange();
  },
});
const {
  loadStoredToken, replaceCloudSession, cloudSessionSnapshot, cloudSessionIsCurrent,
  cloudHandleAuthError, cloudAuthState, cancelCloudSignin, appSession,
} = cloudSession;

// Download a catalog image into the local Library — fetches a FRESH signed URL at
// click time (never a stale catalog thumb URL), then reuses the existing safe import.
// PERF-010: the grid and the viewer adding the same catalogue picture at once share one
// signed URL and one download.
ipcMain.handle('cloud-add', (e, item) => addsInFlight.run(
  item && item.id ? 'cloud:' + String(item.id) : '',
  () => cloudAddOnce(item),
));

async function cloudAddOnce(item) {
  if (item?.bookmarkKey) {
    const resolved = await favoriteService.resolveForUse(item.bookmarkKey, 'znada');
    if (resolved.error) return { config, error: resolved.error };
    item = resolved.item;
  }
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
      const id = addToPool('image', artifact.path, { width: item.width, height: item.height });
      library.rememberDimensions(config.library, id, item.width, item.height);
      const it = config.library[id];
      // Through updateItem, not straight onto the record: a field written directly
      // leaves the revision untouched, and an untouched revision loses the next merge.
      if (it) library.updateItem(config.library, it.id, { source: 'znada:' + item.id, ...contentRating.patch(item) });
      favoriteService.adopt(id);
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

ipcMain.handle('cloud-session', async () => {
  const state = await cloudSession.readSession();
  onCloudSessionChange();
  return state;
});
ipcMain.handle('cloud-signin', () => cloudSession.signin());
ipcMain.handle('cloud-signin-cancel', () => cloudSession.cancelSignin());
ipcMain.handle('cloud-signout', () => cloudSession.signout());
ipcMain.handle('cloud-favorites', () => cloudSession.favorites());
ipcMain.handle('cloud-favorite', (e, id, on) => cloudSession.favorite(id, on));

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
  librarySidebarCollapsed: asBool,
  // LIB-030. One switch per check; today the only check is identical files.
  libraryChecks: asMergedObject({ duplicates: asBool }),
  contentBlur: asMergedObject({ nsfw: asBool, sketchy: asBool }),
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
  if (patch && 'libraryChecks' in patch) libraryChecks.settingsChanged();
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
    const imported = await libraryService.importSlotImages(res.filePaths, monitorId, which);
    if (imported.saveRequired) {
      saveConfig();
      trayCtl.refresh();
    }
    return { config, added: imported.added };
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
    const imported = libraryService.importSlotFolder(dir, monitorId, which);
    if (imported.saveRequired) saveConfig();
    if (imported.folderIds.length) syncLiveFolderWatchers();
    if (imported.folderIds.length) requestLiveFolderRefresh(imported.folderIds);
    return { config, added: imported.added };
  });
});

// add multiple dropped file paths (files or folders) to a monitor's playlist
ipcMain.handle('add-slot-paths', async (e, monitorId, which, paths) => withLibraryLock(async () => {
  if (!monitorId || !Array.isArray(paths)) return { config, added: 0 };
  const imported = await libraryService.importSlotPaths(paths, monitorId, which);
  if (imported.saveRequired) {
    saveConfig();
    trayCtl.refresh();
  }
  if (imported.folderIds.length) syncLiveFolderWatchers();
  if (imported.folderIds.length) requestLiveFolderRefresh(imported.folderIds);
  return { config, added: imported.added, videos: imported.videos };
}));

ipcMain.handle('remove-slot-item', (e, monitorId, which, index) => {
  if (!monitorId) return config;
  libraryService.removeSlotItem(monitorId, which, index);
  saveSettingsOnly();  // slot membership only; the pool is untouched
  gcWallpapers();
  trayCtl.refresh();
  return config;
});

ipcMain.handle('clear-slot', (e, monitorId, which) => {
  if (!monitorId) return config;
  libraryService.clearSlot(monitorId, which);
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
    // MEDIA-002: the Library takes video too; a monitor's own dialog stays IMG_FILTERS.
    filters: [{
      name: tMain('library.dialogFilterMedia'),
      extensions: mediaFormats.WALLPAPER_FORMATS.concat(mediaFormats.VIDEO_FORMATS),
    }],
  });
  if (res.canceled || !res.filePaths.length) return { config, added: 0 };
  for (const chosen of res.filePaths) grantMediaPath(chosen);
  return withLibraryLock(async () => {
    const imported = await libraryService.importLibraryImages(res.filePaths);
    if (imported.saveRequired) saveConfig();
    return { config, added: imported.added };
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
    custom: managedFolder.current().custom,
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
  const target = managedFolder.resolveTarget(folder);
  const plan = mediaMove.planMove({
    from: wallpapersDir(), fromAnchor: managedFolder.current().anchor, to: target.root, anchor: target.anchor,
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
    const imported = libraryService.importLibraryFolder(grantMediaPath(res.filePaths[0], { root: true }));
    if (imported.saveRequired) saveConfig();
    if (imported.folderIds.length) syncLiveFolderWatchers();
    if (imported.folderIds.length) requestLiveFolderRefresh(imported.folderIds);
    return { config, added: imported.added };
  });
});

// Добавить перетащенные пути (файлы/папки) в пул.
ipcMain.handle('library-add-paths', async (e, paths) => withLibraryLock(async () => {
  if (!Array.isArray(paths)) return { config, added: 0 };
  const imported = await libraryService.importLibraryPaths(paths);
  if (imported.saveRequired) saveConfig();
  if (imported.folderIds.length) syncLiveFolderWatchers();
  if (imported.folderIds.length) requestLiveFolderRefresh(imported.folderIds);
  return { config, added: imported.added };
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
// только там. LIB-020 добавляет вопрос от двух выбранных карточек в полосе выделения.
// Признак приходит от поверхности; онлайн-карточка и просмотрщик не спрашивают.
//
// Диалог показывается ДО блокировки библиотеки. Он живёт ровно столько, сколько человек
// думает, и блокировка на это время остановила бы все остальные операции; «Удалить с
// диска» по той же причине спрашивает снаружи блокировки.
//
// Убрать из библиотеки обратимо — запись уходит в корзину, — поэтому вопрос задаётся
// как вопрос, а не предупреждение, и по умолчанию выбрана отмена.
const libraryRemovalQuestion = createLibraryRemovalQuestion({
  getWindow: () => mainWindow,
  nextId: () => crypto.randomUUID(),
});
ipcMain.handle('library-removal-answer', (event, requestId, confirmed) =>
  libraryRemovalQuestion.answer(event.sender, requestId, confirmed));

async function confirmLibraryRemoval(rawRecords, rawOptions) {
  if (!rawOptions || rawOptions.confirm !== true) return null;
  const names = [];
  for (const raw of Array.isArray(rawRecords) ? rawRecords : []) {
    const rec = typeof raw === 'string' ? { id: raw, path: '' } : (raw || {});
    const id = typeof rec.id === 'string' && rec.id ? rec.id : '';
    const item = id ? library.getItem(config.library, id) : null;
    const full = (typeof rec.path === 'string' && rec.path) || (item && item.path) || '';
    if (full) names.push({ name: path.basename(full), type: (item && item.type) || (rec.type === 'folder' ? 'folder' : 'image') });
  }
  // Называть нечего — пусть обработчик сам ответит на пустой запрос, как отвечал всегда.
  if (!names.length) return null;

  const shown = names.slice(0, 10);
  const more = names.length - shown.length;
  const confirmed = await libraryRemovalQuestion.ask({
    names: shown,
    more,
    count: names.length,
    countLabel: tMain('library.itemsCount').replace('{n}', String(names.length)),
    yesLabel: tMain('library.removeConfirmYes'),
    cancelLabel: tMain('library.removeConfirmCancel'),
    closeLabel: tMain('details.close'),
    title: tMain('library.removeConfirmTitle'),
    // tMain() не умеет подстановку, как и у «Удалить с диска» — число подставляется здесь.
    message: tMain('library.removeConfirmMessage').replace('{n}', String(names.length)),
    detail: tMain('library.removeConfirmDetail'),
  });
  if (confirmed) return null;
  // Отказ не должен отличаться от «ничего не делали»: ни записи, ни отмены, ни тоста.
  return { config, affected: 0, removed: 0, hidden: 0, error: null, cancelled: true, warning: null, undo: null };
}

// CODE-001 2.2b. Removing, the toast's Undo, the "Removed" section, restoring and deleting
// into the Recycle Bin live in src/library-removal.js (libraryRemoval, created beside the
// pool core). The handlers stay here: the question before removing, the role of the
// window that asked and Electron itself belong to main.js.
ipcMain.handle('library-remove-many', async (e, rawRecords, rawOptions) => {
  const declined = await confirmLibraryRemoval(rawRecords, rawOptions);
  if (declined) return declined;
  return libraryRemoval.removeMany(rawRecords, { senderIsMain: () => ipcAuthority.roleOf(e) === 'main' });
});

// Put back exactly what the last removal took away. Only the most recent removal is
// kept — this backs the "Undo" in the toast, not a full history.
ipcMain.handle('library-undo-remove', async (e, expectedToken) => libraryRemoval.undo(expectedToken));

// The "removed" section: what the user took out of the library and can still put back.
ipcMain.handle('library-hidden-list', () => libraryRemoval.hiddenList());

// LIB-007: the one action allowed to touch the user's files — deleting a removed photo
// into the WINDOWS RECYCLE BIN. What it checks and in which order is in
// src/library-removal.js (deleteForever); the Recycle Bin call and the dialog stay here.
//
// Deleting the user's files is the one thing Znada does that they cannot simply undo
// inside the app, and five review rounds have not yet proved the guard around it sound:
// a file the app was still using could be deleted through a race between validating a
// path and committing the record that uses it. The owner's decision (2026-08-10) is to
// switch the feature OFF until that transaction is proved, rather than ship it and hope.
//
// Off in ONE place: this flag. The removal module asks it before anything else, and the
// renderer learns it through 'feature-flags', so the button and the handler cannot drift
// apart. Turning it back on is this constant.
let physicalDeleteEnabled = false;

ipcMain.handle('feature-flags', () => ({ physicalDelete: physicalDeleteEnabled }));

ipcMain.handle('library-delete-forever', async (e, rawPaths) => libraryRemoval.deleteForever(rawPaths));

// The confirmation before deleting into the Recycle Bin: native, and it names what is about
// to go. The window and the texts belong here; the removal module only hears yes or no.
async function askDeleteForever(targets) {
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
  return answer.response === 0;
}

ipcMain.handle('library-restore', async (e, rawPaths) => libraryRemoval.restore(rawPaths));

ipcMain.handle('library-toggle-favorite', (e, id, owner) => {
  const descriptor = { kind: 'local', id, owner };
  const result = favoriteService.set(descriptor, !favoriteService.state(descriptor).on);
  if (result.error) throw new Error(result.error);
  favoriteService.publish();
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
// BUG-035. One reader for "does this picture move", shared by the cards, the previews that
// stand for the desktop and the details sheet, so all of them give the same answer.
// MEDIA-004: the Library's filters ask about a whole library, so the cache holds one
// small answer per file of a large one, not only the cards on screen.
const motionReader = imageMotion.createMotionReader({ cacheCap: 50000 });
const readItemDetails = itemDetails.createDetailsReader({
  motion: motionReader,
  // Called only once a request arrives, long after thumbnailService exists below.
  video: (p) => thumbnailService.videoInfo(p),
});
// SEC-002, slice 2. Short-lived authority for paths main learned ITSELF — a dialog it
// opened, or a listing it produced. Everything else has to be vouched for by the pool.
const pathGrants = pathGrantsMod.create({
  isSameOrDescendant: (child, ancestor) => itemDetails.isSameOrDescendant(child, ancestor),
  normalize: (p) => pathKey(p),
});

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

// META-005. Copy the one tag the user pointed at in Details. This is not a general
// clipboard door: the text has to be one short label (src/item-details.js), and the
// call writes nothing to the library and does not change a search.
ipcMain.handle('details-copy-tag', async (e, raw) => {
  const tag = itemDetails.copyableTag(raw);
  if (!tag) return false;
  try {
    await clipboard.writeText(tag);
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
function authorizedLocalFile(descriptor, allowVideo = false) {
  const p = descriptor && descriptor.path;
  if (!p || !isAuthorizedMediaPath(p)) return '';
  // The same one list of formats the folder scanner and the online boundary use, so a
  // photo Znada can show is exactly a photo Znada can hand over (ONL-015).
  const ext = path.extname(p).replace('.', '');
  const format = mediaFormats.normalizeFormat(ext);
  if (!mediaFormats.isWallpaperFormat(format) && !(allowVideo && mediaFormats.isVideoFormat(format))) return '';
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
      let item = descriptor.item;
      // BUG-063. A Favorites card offers save/copy from its bookmark key alone, before its
      // background resolve has filled in `full`. Resolve the key here, as `internet-add` does.
      if (item?.bookmarkKey) {
        const result = await favoriteService.resolveForUse(item.bookmarkKey, item.provider);
        if (result.error) return { path: '', error: result.error };
        item = result.item;
      }
      if (!usableInternetDownload(item)) return { path: '', error: 'badItem' };
      const stored = await downloadImageTo(dir, item.full, onlineOriginalOptions(item));
      return { path: stored, error: null };
    }

    // BUG-029. No pool record — the ordinary case for a photo shown out of a watched
    // folder. The window's path is honoured only if the library vouches for it.
    const vouched = authorizedLocalFile(descriptor, !managed && opts.allowLocalVideo === true);
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
  const file = await ensureCardFile(descriptor, { managed: false, allowLocalVideo: true });
  if (file.error) return { ok: false, error: file.error };

  const parent = BrowserWindow.fromWebContents(e.sender) || mainWindow;
  const suggested = path.join(saveDialogStartDir(), path.basename(file.path));
  let res;
  try {
    res = await dialog.showSaveDialog(parent, {
      defaultPath: suggested,
      filters: [{ name: mediaFormats.isVideoPath(file.path) ? 'Video' : 'Image',
        extensions: [path.extname(file.path).replace('.', '') || 'jpg'] }],
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
  // pending stealth advance or waiting slideshow run so it can't overwrite this choice moments later.
  let warning = null;
  if (theme === wallpaperThemeName()) {
    const intent = supersedeSlideshowForManualChange();
    try {
      await applyForTheme(theme, true);
    } catch (err) {
      // The pool + slot transaction is already durably saved. Surface application
      // trouble as a warning instead of lying to the renderer that assignment failed.
      warning = 'apply_failed';
      console.error('library assignment apply failed:', err);
    } finally {
      rescheduleSlideshowAfterManualWallpaperChange(intent);
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
    const { result, poolTouched } = libraryService.assignRecord(record, monitorId, theme, options);
    if (!result.ok) return result;
    const warning = await finalizeLibraryAssignment(result, theme, poolTouched);
    return { ...result, config, warning };
  });
}

ipcMain.handle('library-assign', async (e, id, monitorId, which) => {
  return commitLibraryAssignmentRecord({ id }, monitorId, which);
});

// ---- Internet providers and online search --------------------------------------------
// CODE-001. How a site is reached lives in src/provider-access.js, and the search, the
// front-page feed, tag suggestions and the list of sites in src/online-search.js. What
// stays here is the wiring and the two pieces that belong to other areas: the account
// session a site may sign in with, and the check on an online item a window hands back.

const INTERNET_USER_AGENT = `Znada/${app.getVersion()} (https://github.com/alexvlass01/znada)`;

const providerAccess = providerAccessMod.create({
  appSession,
  userAgent: INTERNET_USER_AGENT,
  registry: providerRegistry,
});

const favoriteService = bookmarkRuntime.create({
  configPath: CONFIG_PATH, getConfig: () => config,
  updateItem: (id, patch) => library.updateItem(config.library, id, patch), savePool: savePoolOnly,
  authState: cloudAuthState, sessionSnapshot: cloudSessionSnapshot,
  sessionIsCurrent: cloudSessionIsCurrent, client: cloudClient,
  providers: providerAccess, registry: providerRegistry, ipcMain,
  // ONL-002 stage 5: any configured Cloud. Whether it can sync is the server's answer:
  // one without /v1/bookmarks is detected by the engine and left alone (src/bookmark-sync.js).
  syncEnabled: () => !!cloudCapability().apiBase,
  handleAuthError: cloudHandleAuthError,
  poolFrozen: () => mediaMoveRunning,
  // ONL-002 stage 4: the account row in the main window shows the sync state.
  publishSync: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('bookmark-sync-changed', status);
  },
  publish: () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('favorites-changed');
    }
  },
});
onCloudSessionChange = () => favoriteService.sessionChanged();

// Settings and monitors are read at the moment of each request: set-config replaces the
// whole config object, and a reference kept from now would quietly go stale.
const onlineSearch = onlineSearchMod.create({
  online,
  getConfig: () => config,
  getMonitors: () => monitorsCache,
  providers: providerAccess,
  registry: providerRegistry,
});

ipcMain.handle('internet-status', () => onlineSearch.status());
ipcMain.handle('internet-tag-suggest', (e, opts) => onlineSearch.suggestTags(opts));
ipcMain.handle('internet-search', (e, opts) => onlineSearch.search(opts));

// ONL-014c. The account session, as the one site that needs it sees it. There is one
// account in Znada, so “session” needs no site name to be unambiguous.
//
// The typed client is handed over rather than rebuilt: the catalogue’s contract already
// lives in src/cloud/client.js, and a second copy inside an adapter would drift.

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
    headers: providerAccess.requestHeaders(item),
    expectedFormat: item.format,
    fetchImpl: originalFetchFor(item),
  };
}

// Everything an add needs from the network, fetched together: the original and the
// site's extra request for tags (ONL-012). The tags used to be asked only after the
// download, with the library lock held across the request; now both run at once and
// neither is inside the lock, since neither touches anything shared.
function fetchOnlineForAdd(item) {
  const url = String(item.full).trim();
  // An original can appear in several posts. Share the bytes by URL, but only
  // share the entire add request between callers adding the same post.
  const key = JSON.stringify([item.provider, String(item.id ?? ''), url]);
  return addsInFlight.run('internet:' + key, async () => {
    const [stored, extra] = await Promise.all([
      addsInFlight.run('internet-original:' + url, () => downloadWallpaperFromUrl(item.full, onlineOriginalOptions(item))),
      enrichProviderItem(item),
    ]);
    return { stored, extra };
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
 *   2. заголовки провайдера — тот же `providerAccess.requestHeaders`;
 *   3. разбор MIME — тот же `online.thumbnailMime`;
 *   4. потолок размера — и по `content-length`, и ПО МЕРЕ чтения (см. ниже);
 *   5. таймаут.
 */
/*
 * BUG-065. The time limit used to be one 30 s deadline on the whole transfer
 * (`AbortSignal.timeout` on fetch also covers reading the body). A big GIF that was
 * still arriving got cut mid-way: measured 2026-11-07 on Gelbooru post 1945703, 23 MB,
 * cut at 22.97 MB after exactly 30 s. The window got an error for the original, and the
 * viewer stayed on the small thumbnail — every time, because every attempt hit the same
 * wall. A limit belongs on silence, not on size: the size cap already bounds how much
 * may come. So there are two limits:
 *   - `answerMs`: the site has to start answering (status and headers);
 *   - `stallMs`: the body may not go quiet for longer than this between two pieces.
 * A transfer that keeps moving is never cut; one that stops is, and the stream then
 * ends with an error — never as a complete (cut) picture.
 */
const mediaProxyTimeouts = { answerMs: 30000, stallMs: 30000 };

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

    // BUG-065. One controller for the whole transfer, one timer that is re-armed: first
    // for the answer, then before every read of the body.
    const abort = new AbortController();
    let timer = null;
    const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const arm = (ms) => {
      disarm();
      timer = setTimeout(() => { timer = null; abort.abort(new Error('stalled')); }, ms);
    };
    let upstream;
    arm(mediaProxyTimeouts.answerMs);
    try {
      upstream = await fetch(asked.url, {
        headers: providerAccess.requestHeaders(item),
        signal: abort.signal,
      });
    } catch (err) {
      const timedOut = abort.signal.aborted || (err && err.name === 'TimeoutError');
      return new Response('upstream', { status: timedOut ? 504 : 502 });
    } finally {
      disarm();
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
    let keep = asked.field === 'full' ? recentOriginals.begin(asked.url) : null;
    const kept = [];
    let seen = 0;
    const reader = upstream.body.getReader();
    const capped = new ReadableStream({
      async pull(controller) {
        let step;
        // BUG-065. The limit is on silence: armed before each read, cleared when a piece
        // arrives. A stalled site aborts the read, and the stream fails below.
        arm(mediaProxyTimeouts.stallMs);
        try {
          step = await reader.read();
        } catch (err) {
          disarm();
          if (keep) keep.fail();
          controller.error(err);
          return;
        }
        disarm();
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
        // BUG-065. The original's cap (100 MB) is above what the store keeps (64 MB):
        // past that, stop copying — the picture still streams to the window, and an add
        // downloads it itself, as it does for any original that was not kept.
        if (keep && seen > originalStoreMod.DEFAULTS.maxBytes) {
          keep.fail();
          keep = null;
          kept.length = 0;
        }
        // A copy: what is enqueued belongs to the window's side from here on.
        if (keep) kept.push(Buffer.from(chunk));
        controller.enqueue(chunk);
      },
      cancel(reason) {
        disarm();
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
async function enrichProviderItem(item, signal) {
  const descriptor = item ? providerRegistry.byId(item.provider) : null;
  if (!descriptor || typeof descriptor.enrich !== 'function') return { author: '', tags: [] };
  let extra;
  try {
    extra = await descriptor.enrich(item, providerAccess.context(descriptor, undefined, { signal }));
  } catch (err) {
    console.error(`${descriptor.id} enrich:`, err);
    return { author: '', tags: [] };
  }
  return {
    author: String((extra && extra.author) || '').trim(),
    tags: Array.isArray(extra && extra.tags) ? extra.tags : [],
    postTags: metadataLookup.normalizeTagList(extra?.postTags).map((tag) => tag.name),
  };
}

const videoDownloads = new Map();

ipcMain.handle('internet-cancel-video', (e, requestId) => {
  const operation = videoDownloads.get(e.sender.id)?.get(requestId);
  if (!operation) return false;
  operation.abort();
  return true;
});

ipcMain.handle('internet-add', async (e, item, query, requestId) => {
  const sender = e.sender;
  const senderId = sender?.id;
  const hasRequestId = requestId !== undefined && requestId !== null;
  if (hasRequestId && (typeof requestId !== 'string' || requestId.length > 64 || !requestId)) {
    return { config, error: 'badItem' };
  }
  if (hasRequestId && (!sender || sender.isDestroyed())) return { error: 'cancelled' };
  let operation = null;
  let staged = null;
  let dir = '';
  let transfers;
  const cancel = () => operation?.abort();
  // The video flow supplies its request id before resolving a favorite link. Register
  // cancellation at that boundary so the owner can abort while the provider lookup waits.
  // A request id is optional for ordinary photos, which keep their existing path.
  if (hasRequestId) {
    transfers = videoDownloads.get(senderId) || new Map();
    if (transfers.has(requestId) || transfers.size >= 4) return { config, error: 'download' };
    operation = new AbortController();
    transfers.set(requestId, operation);
    videoDownloads.set(senderId, transfers);
    sender.once('destroyed', cancel);
    sender.once('render-process-gone', cancel);
  }
  try {
    operation?.signal.throwIfAborted();
    if (item?.bookmarkKey) {
      const result = await favoriteService.resolveForUse(item.bookmarkKey, item.provider);
      operation?.signal.throwIfAborted();
      if (result.error) return { config, error: result.error };
      item = result.item;
    }
    const video = online.allowedVideo(item);
    if (!video && !usableInternetDownload(item)) return { config, error: 'badItem' };
    if (video && (!sender || sender.isDestroyed())) return { error: 'cancelled' };
    if (video && !managedRootReady()) return { config, error: 'media_root_unavailable' };
    if (video && !operation) return { config, error: 'badItem' };
    dir = video ? wallpapersDir() : '';
    // The download itself is outside the lock — it is slow and touches nothing shared.
    // Everything from "this file is now ours" onwards is inside it: a re-download lands
    // on the same content-addressed path a "delete from disk" may be aiming at.
    const { stored, extra } = video ? await (async () => {
      const signal = operation.signal;
      const transfer = await fetchVideo(item, providerAccess.requestHeaders(item), { signal });
      try {
        let lastProgress = -Infinity;
        staged = await managedFolder.stageDownloadVideo(dir, item.format, transfer, {
          signal,
          onProgress(received, total) {
            if (Date.now() - lastProgress < 100 || sender.isDestroyed()) return;
            lastProgress = Date.now();
            sender.send('internet-video-progress', { requestId, received, total });
          },
        });
        signal.throwIfAborted();
        return { stored: staged.path, extra: await enrichProviderItem(item, signal) };
      } finally { transfer.cancel(); }
    })() : await fetchOnlineForAdd(item);
    return await withLibraryLock(async () => {
      if (video) {
        operation.signal.throwIfAborted();
        if (mediaMoveRunning || dir !== wallpapersDir()) return { config, error: 'media_move_running' };
        commitDownloadArtifact(staged, dir);
      }
      const id = addToPool('image', stored, { width: item.width, height: item.height });
      library.rememberDimensions(config.library, id, item.width, item.height);
      const it = config.library[id];
      if (it) {
        // DATA-005. Every field goes through updateItem: assigning straight onto the
        // record leaves its revision untouched, and an untouched revision loses the
        // next merge — which is the silent loss this whole task is about.
        library.updateItem(config.library, id, {
          source: online.allowedPageUrl(item) ? item.page : '',
          ...contentRating.patch(item),
        });
        favoriteService.adopt(id);
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
        const cardTags = Array.isArray(item.tags) ? item.tags.slice(0, 24) : [];
        const postTags = extra.postTags?.length ? extra.postTags : cardTags;
        postTags.forEach((tag) => {
          if (typeof tag === 'string') library.addTag(config.library, id, tag.slice(0, 80));
        });
        // Wallhaven supplies supplemental tags that are absent from the card.
        extra.tags.forEach((tag) => library.addTag(config.library, id, tag.slice(0, 80)));
        String(query || '').slice(0, 500).split(/[\s,]+/).filter(Boolean).slice(0, 20)
          .forEach((tag) => library.addTag(config.library, id, tag.slice(0, 80)));
      }
      saveConfig();
      return { config, id, error: null };
    });
  } catch (err) {
    if (operation?.signal.aborted) return { error: 'cancelled' };
    console.error('internet add:', err);
    return { config, error: 'download' };
  } finally {
    if (operation) {
      managedFolder.discardDownloadArtifact(staged, dir);
      sender.removeListener('destroyed', cancel);
      sender.removeListener('render-process-gone', cancel);
      transfers.delete(requestId);
      if (!transfers.size) videoDownloads.delete(senderId);
    }
  }
});

// ---- META-001: tags and source for a photo the user already has ----------------------
// CODE-001. Fingerprinting, the per-site request budget, the journal of who was already
// asked and the write onto the photo's record live in src/metadata-lookup-service.js.
// The pool and the move freeze stay main's: the service reads them at the moment of use.
const metadataService = metadataLookupServiceMod.create({
  configPath: CONFIG_PATH,
  getConfig: () => config,
  library,
  lookup: metadataLookup,
  registry: providerRegistry,
  providers: providerAccess,
  userAgent: INTERNET_USER_AGENT,
  isAuthorizedItemPath: (p) => isAuthorizedItemPath(p),
  isMoveRunning: () => mediaMoveRunning,
  savePoolOnly: () => savePoolOnly(),
  thumbnail: (p) => thumbnailHost.thumbnail(p, 512, 82),
});

// LIB-030. The background library check, as the window sees it. The pass itself is
// created with the renderer broadcasts above, because a pool change schedules it.
ipcMain.handle('library-checks-state', () => libraryChecksForWindow(libraryChecks.summary()));
// The window showed the notification; the copies found so far are not news any more.
ipcMain.handle('library-checks-ack', () => libraryChecksForWindow(libraryChecks.acknowledge()));
// The groups, as cards the Library can draw: a pool record where there is one, the folder
// index's dates and proportions where there is not.
ipcMain.handle('library-duplicates', () => {
  const discovery = new Map(liveFolderIndex.listImages().map((im) => [pathKey(im.path), im]));
  return {
    groups: libraryChecks.duplicates().map((group) => ({
      size: group.size,
      files: group.paths.map((p) => {
        const id = library.idFor(p);
        const seen = discovery.get(pathKey(p));
        return {
          path: p,
          id,
          addedAt: (seen && seen.addedAt) || 0,
          modifiedAt: (seen && seen.modifiedAt) || 0,
          aspect: (seen && seen.aspect) || 0,
        };
      }),
    })),
  };
});

// Manual, explicit, one at a time — the button the user pressed.
ipcMain.handle('item-lookup-metadata', async (e, id, options) => {
  if (options?.action === 'visual') return metadataService.visualItem(id, e.sender.id);
  if (options?.action === 'confirm') return metadataService.applyVisual(id, options.token, e.sender.id,
    options.accept === true ? true : options.accept === false ? false : null);
  return metadataService.lookupItem(id);
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
    const removedDirs = liveFolderIndex.listHiddenDirs().map((d) => d.path);
    const subfolders = folders.filter((f) => !removedDirs.some((dir) => library.isUnderPath(f, dir))).length;
    // MEDIA-002: `count` is everything the folder shows, video included (owner: "all
    // together"); `videos` only lets the card say "files" instead of "photos".
    const videos = visible.filter((p) => mediaFormats.isVideoPath(p)).length;
    return { count: visible.length, videos, subfolders, previews: visible.slice(0, 4) };
  } catch { return { count: 0, subfolders: 0, previews: [] }; }
});

// Authority and writers read main's current state when the service calls them.
const thumbnailService = createThumbnailService({
  thumbnailHost, isAuthorizedMediaPath, queueLiveFolderAspect,
  setAspect: (id, p, aspect) => library.setAspect(config.library, id, p, aspect),
  saveLibrarySoon, diagEvent, diagSpan,
});
ipcMain.handle('thumb', async (e, p, w, h) => {
  const data = await thumbnailService.thumbnailData(p, w, h);
  return data.url;
});
// BUG-035. Whether a local picture moves. Same authority as a thumbnail, because it reads
// the file's bytes; JPEG and BMP are answered from the name and never opened.
function mediaMotionOf(p, options) {
  if (!p || typeof p !== 'string' || p.includes('\0') || !path.isAbsolute(p)) return Promise.resolve(null);
  if (!imageMotion.mayMove(p) || !isAuthorizedMediaPath(p)) return Promise.resolve(null);
  return motionReader(p, options);
}
// A card learns whether its picture moves in the same round trip as its thumbnail, so the
// grid needs no second request per card. The thumbnail itself stays a still frame.
ipcMain.handle('thumb-info', async (e, p, w, h, priority) => {
  const [data, motion, video] = await Promise.all([
    thumbnailService.thumbnailData(p, w, h, priority), mediaMotionOf(p), thumbnailService.videoInfo(p),
  ]);
  // MEDIA-002: a video card learns it is one, and its length, in the same round trip.
  // `video` is present even with no known length — the ▶ badge does not wait for it.
  const out = motion ? { ...data, motion } : data;
  return mediaFormats.isVideoPath(p) ? { ...out, video: video || { durationMs: 0, width: 0, height: 0 } } : out;
});

// MEDIA-002. Until our own viewer plays video (MEDIA-003), a video card opens in the
// program Windows uses for it. Same authority as a thumbnail, and video only: this must
// not become a way to launch any file the window names.
ipcMain.handle('open-video', async (e, p) => {
  if (!mediaFormats.isVideoPath(p) || !isAuthorizedMediaPath(p)) return { ok: false, error: 'bad_request' };
  const error = await shell.openPath(p);
  return error ? { ok: false, error: 'open_failed' } : { ok: true };
});
// MEDIA-003. The role/frame guard runs first. Resolve an index in main's current
// payload and recheck path authority; never accept a renderer path or mpv command.
ipcMain.handle('gallery-video', (e, request) => galleryVideo ? galleryVideo.request(request) : { ok: false });
// The previews that stand for the desktop ask before they choose between the file itself
// and its still frame.
ipcMain.handle('media-motion', (e, p) => mediaMotionOf(p));
// MEDIA-004. The same answer for many files, for the Library's "Filters": one boolean per
// path, in order. The window sends a few hundred at a time.
ipcMain.handle('media-motion-many', (e, paths) => {
  const list = Array.isArray(paths) ? paths.slice(0, 2000) : [];
  return imageMotion.motionOfMany(list, (p) => mediaMotionOf(p));
});

// LIB-031. Which of the Online cards on screen are photos the user already has. The window
// asks for a few hundred at a time; the answer maps each card's key to { path, id } or null.
ipcMain.handle('online-have-many', (e, cards) => onlineHaveMatcher.match(cards));

ipcMain.handle('thumb-aspects', (e, entries, w, h) => thumbnailService.aspects(entries, w, h));

// Look up one path's discovery metadata ({ firstSeenAt, modifiedAt, ... }) in the live
// folder index, or null if it isn't a watched-folder image. Used when materializing so
// the new pool item keeps the date Znada first saw the file.
function liveFolderDiscovery(p) {
  if (!p || typeof p !== 'string') return null;
  const key = pathKey(p);
  try {
    for (const im of liveFolderIndex.listImages()) {
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
      for (const im of liveFolderIndex.listImages(null, { only: 'all' })) {
        if (im && im.path) meta.set(pathKey(im.path), im);
      }
    } catch {}
    const visible = images.filter((p) => {
      const m = meta.get(pathKey(p));
      return !(m && m.hidden);
    });
    // A removed subfolder is gone from the library, so it must not remain as a card
    // in its parent — it would open empty and removing it again would do nothing.
    const removedDirs = liveFolderIndex.listHiddenDirs().map((d) => d.path);
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
    const indexed = liveFolderIndex.listImages();
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
    const indexed = liveFolderIndex.listImages();
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
  // MEDIA-002: a video may become a pool record (★, tags); assignment refuses it later.
  return stats.isFile() && playlist.LIBRARY_EXTS.has(path.extname(p).toLowerCase()) ? null : 'missing_file';
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
      for (const image of liveFolderIndex.listImages()) {
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
  // Same ordering guarantee as the single-record path (see commitLibraryAssignmentRecord).
  return withLibraryLock(async () => {
    const { result, poolTouched } = libraryService.assignRecords(valid, monitorId, theme);
    result.failed += validationFailed;
    if (!result.ok) {
      return { config, ok: false, error: result.error, assigned: 0, failed: result.failed, videos: result.videos, warning: null };
    }
    const warning = await finalizeLibraryAssignment(result, theme, poolTouched);
    // Keep the IPC response compact: config already contains authoritative items;
    // returning duplicate ids/items arrays would double serialization for huge batches.
    return {
      config,
      ok: true,
      error: null,
      assigned: result.assigned,
      failed: result.failed,
      videos: result.videos,
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

// BUG-068: read `config` only after the await. `{ config, id: await … }` captured the
// object before validation awaited fs.stat; a set-config meanwhile replaced it, and the
// window got its old settings back. test/ipc-reply-config.test.js guards the whole shape.
ipcMain.handle('library-materialize', (e, p, type) => withLibraryLock(async () => {
  const id = await materializePathIntoPool(p, type);
  return { config, id };
}));

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
    const intent = supersedeSlideshowForManualChange();
    try {
      await applyForTheme(t, true);
    } finally {
      rescheduleSlideshowAfterManualWallpaperChange(intent);
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
  // Picking a specific frame is a manual choice → cancel any pending stealth advance and any
  // slideshow run still waiting.
  if (t === wallpaperThemeName()) {
    const intent = supersedeSlideshowForManualChange();
    try {
      const apply = await applyForTheme(t, true);
      return { config, apply: apply || { ok: true } };
    } finally {
      rescheduleSlideshowAfterManualWallpaperChange(intent);
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
    await devLaunchTools.settleWithin(libraryService.settled(), devLaunchTools.SETTLE_LIMIT_MS);
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

// Windows switched light/dark (or only said it did). Registered on ready; a named function so
// a test can drive the same path a real flip takes (TRG-004).
function onNativeThemeUpdated() {
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
    } else followWindowsTheme();
  }
}

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
    // Before any window. On failure the sandbox stays on; there is no unsandboxed fallback.
    try {
      require('./diagnostics/main/probe-preload').install(session.defaultSession, DIAGNOSTICS_BOOTSTRAP.userDataPath);
    } catch (err) {
      console.error('[Diagnostics] probe preload was not installed:', err);
    }
  }
  loadConfig();
  ensureAnonId(); // generate the anonymous install id once, before any cloud request
  loadLiveFolderState();
  // DATA-001. After the loaders, so a file restored a moment ago is the one copied. A
  // file that does not load is never copied (the snapshot's own acceptance check), so a
  // degraded session leaves the earlier good copies alone.
  dataSnapshots.takeAll();
  const snapshotTimer = setInterval(() => dataSnapshots.takeAll(), DATA_SNAPSHOT_CHECK_MS);
  if (typeof snapshotTimer.unref === 'function') snapshotTimer.unref();
  // Restore as a new session generation: any in-flight answer from an earlier lifecycle
  // (tests exercise reloads in one process) must not be allowed to mutate it.
  replaceCloudSession(loadStoredToken(), null); // validated on first use
  // Установщик пересоздаёт ярлыки при каждом обновлении, поэтому чинить их место
  // нужно на каждом старте, а не один раз после установки.
  normalizeStartMenuShortcut();
  registerShortcut();
  wallpaperPlatform.ensureScripts();
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
  // LIB-030. Well after the window, the wallpaper and the folder scan have had their turn.
  libraryChecks.start(60000);

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
  nativeTheme.on('updated', onNativeThemeUpdated);

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
    if (usagePingCtl) usagePingCtl.trigger('resume');
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

  // Never delays startup: the first attempt waits 5-15 s on a timer of its own.
  startUsagePing();

  // background update check (installed build only); silent until an update is ready
  if (updatesSupported()) setTimeout(() => checkForUpdates(), 8000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Flush discovery metadata and dispose persistent helper processes on quit.
app.on('before-quit', () => {
  if (usagePingCtl) usagePingCtl.stop();
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
  liveFolderIndex.dispose();
  configStore.flush(); // batched pool edits must not die with the process
  // META-001: losing the journal costs no user data, but it does cost the memory of
  // which questions have already been asked — and re-asking is what gets us blocked.
  metadataService.flush();
  libraryChecks.dispose(); // LIB-030: its state is written as it changes; only the timer is left
  configBroadcast.dispose();
  if (liveFolderWatcher) liveFolderWatcher.closeAll();
  void thumbnailHost.dispose();
  wallpaperPlatform.dispose();
  // WIN-002. A fallback PowerShell or reg.exe still running now would outlive the app;
  // end them all and start no new one. Nothing is awaited: quitting is not held up.
  systemChildren.disposeAll();
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
    isUnsafeToWrite: () => !configStore.poolWritable(),
    // SEC-002 slice 2: what the media guard let through, and the grant side of it.
    thumbnailAttempts: () => thumbnailService.attempts(),
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
    setProviderCredentials: (id, value) => providerAccess.setCredentials(id, value),
    eventLogEntries: () => eventLog.list(),
    // DATA-001. Startup takes the copies inside app.whenReady, which the harness never
    // resolves; a restart test takes them through the same instance instead.
    dataSnapshots: () => dataSnapshots,
    // The restored index is written by the debounced writer; a test flushes it the way quit does.
    flushLiveFolderState: () => flushLiveFolderState(),
    flushMetadata: () => metadataService.flush(),
    // BUG-023. Both of these write config.json outside any IPC handler — anonId on
    // startup, the slideshow position from a timer — so a test cannot reach them through
    // the handlers, and they are exactly the two that must not write over a config the
    // app failed to read.
    ensureAnonId: () => ensureAnonId(),
    persistSlideshowPosition: (markDirty) => {
      if (markDirty) configStore.markPositionDirty();
      persistSlideshowPosition();
    },
    // Mirrors poolWritePending() for the settings side: a refused write has to leave the
    // position outstanding, or it is silently declared saved and never retried.
    slideshowPositionPending: () => configStore.positionPending(),
    applyLoginItem: () => applyLoginItem(),
    squirrelEvent: () => SQUIRREL_LIFECYCLE_EVENT,
    flushLibraryWriter: () => configStore.flush(),
    poolWritePending: () => configStore.poolWritePending(),
    activeHotkey: () => hotkeyCtl.active(),
    lastRemovalPending: () => libraryRemoval.undoPending(),
    // The guard around deleting files still has to be TESTED while the feature itself is
    // switched off for users — otherwise every one of those tests would pass by doing
    // nothing, and the day the feature is turned back on nobody would know whether its
    // guard still works. The default stays off; only the tests turn it on.
    setPhysicalDeleteEnabled: (on) => { physicalDeleteEnabled = !!on; },
    setLiveFolderState: (state) => liveFolderIndex.__test.replace(state),
    getLiveFolderState: () => liveFolderIndex.snapshot(),
    // The loader startup runs, so a restart test reads the index the way the app does.
    loadLiveFolderState: () => loadLiveFolderState(),
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
    // WIN-002: the deadlines are half a minute in the app; a test waits milliseconds.
    setSystemChildTimeouts: (limits) => { Object.assign(systemChildTimeouts, limits || {}); },
    // BUG-065: the proxy's two limits, shortened by tests instead of waiting 30 s.
    setMediaProxyTimeouts: (limits) => { Object.assign(mediaProxyTimeouts, limits || {}); },
    systemChildren: () => systemChildren,
    cleanLegacyAutostartRegistryValues: () => cleanLegacyAutostartRegistryValues(),
    checkLiveFolderReachability: () => checkLiveFolderReachability(),
    addToPool: (type, p, extra) => addToPool(type, p, extra),
    saveConfig: () => saveConfig(),
    // DATA-006. Where this profile's own copies live RIGHT NOW, as main resolved it,
    // plus the live state of that folder. A test that recomputed the path itself would
    // prove its own arithmetic instead of main's.
    managedRoot: () => managedFolder.snapshot(),
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
    lookupItemMetadata: (id) => metadataService.lookupItem(id),
    setMetadataBudget: (cfg) => metadataService.setBudget(cfg),
    // BUG-020. The browse feed is deliberately shuffled, which is untestable against a
    // real clock: a test that asserts "the order changed" is a coin toss it will
    // eventually lose. Pinning the generator makes the order exact.
    setBrowseRandom: (fn) => onlineSearch.setRandom(fn),
    // ONL-012. The adult-content answer is a RULE over the registry, not a constant;
    // proving that needs a list the shipped registry cannot produce.
    explicitContentReachableIn: (list) => providerAccess.explicitContentReachableIn(list),
    // Driving one site directly is the only way to prove the guarantees that matter for
    // a site we do not ship: one that throws, one that has no key, one that is refused.
    searchOneProvider: (descriptor, params) => onlineSearch.searchOneProvider(descriptor, params),
    searchAllProviders: (buildParams, list) => onlineSearch.searchAllProviders(buildParams, list),
    // The one list of formats an online picture may have. Exported so a test can hold it
    // beside what Znada accepts from a folder and prove the two paths stay identical.
    acceptedFormats: () => onlineSearch.acceptedFormats(),
    // ONL-013. Driving one site directly is the only way to prove the guarantees that
    // matter for a site we have NOT written: one that throws, one that answers a shape
    // we cannot read, one whose extra request is refused after it already found the post.
    askProviderForFingerprint: (descriptor, kind, hash) => metadataService.askProvider(descriptor, kind, hash),
    // Whether a site's declared key is present is a fact about THIS build, so a test can
    // only pin the shape: exactly the sites that said they need one, and nobody else.
    metadataCredentials: () => metadataService.credentials(),
    // ONL-014. The list is a parameter so "a broken site is skipped and the next one
    // answers" can be proved with sites the shipped registry cannot produce.
    suggestTagsFromProviders: (prefix, limit, list) => onlineSearch.suggestTagsFromProviders(prefix, limit, list),
    suggestTagProviders: (list) => onlineSearch.suggestTagProviders(list).map((d) => d.id),
    searchRound: (token, sorting, extra, list, browsing) => onlineSearch.searchRound(token, sorting, extra, list, browsing),
    recordRound: (token, attempts) => onlineSearch.recordRound(token, attempts),
    // ONL-014c. A key in a file is read once and kept; a session must be asked for every
    // time. The difference is only visible from here.
    providerCredentials: (descriptor) => providerAccess.credentials(descriptor),
    setCloudSession: (token, user, persist = false) => replaceCloudSession(token, user, { persist }),
    setCloudSessionStorage: (overrides) => cloudSession.setStorage(overrides),
    cloudAuthState: () => cloudAuthState(),
    stageDownloadArtifact: (dir, url, options) => stageDownloadImage(dir, url, options),
    commitDownloadArtifact: (artifact, dir) => commitDownloadArtifact(artifact, dir),
    discardDownloadArtifact: (artifact, dir) => discardDownloadArtifact(artifact, dir),
    metadataCache: () => metadataService.cache(),
    flushMetadataWriter: () => metadataService.flush(),
    libraryChecks: () => libraryChecks,
    // Проверять надо не саму функцию, а что плановый обход её ЗОВЁТ при скрытом окне:
    // ровно эта развилка и молчала.
    runHourlyLiveFolderPass: () => scheduleLiveFolderFullScan(String("hourly"), 0),
    windowVisibleForLiveFolders: () => liveFolderWindowVisible(),
    blockIntervalLikeGameMode: () => retrySlideshowSoon(beginSlideshowRun(), true),
    // TRG-004. The handler a real Windows light/dark flip runs; it is registered on ready,
    // which never comes under the harness. The test sets nativeTheme first, as Windows would.
    themeUpdated: () => onNativeThemeUpdated(),
    cloudSigninInFlight: () => cloudSession.signinInFlight(),
    cancelCloudSignin: () => cancelCloudSignin(),
    // BUG-031. whenReady never resolves under the harness, so no window exists and every
    // broadcast went nowhere. A stand-in lets a test hear what an open window is told.
    useMainWindow: (win) => { mainWindow = win || null; },
    disposeForTests: () => {
      if (devSession) devSession.dispose();
      cancelCloudSignin();
      configStore.dispose();
      metadataService.dispose();
      // LIB-030. A pass a library change scheduled must not run into the next test's profile.
      libraryChecks.dispose();
      configBroadcast.dispose();
      clearSlideshowTimer();
      // A test that switches the theme schedule on arms the next flip, which can be
      // hours away; without this the node process simply never exits.
      clearThemeTimer();
      clearWallpaperTimer();
      liveFolderIndex.dispose();
      if (liveFolderAspectTimer) clearTimeout(liveFolderAspectTimer);
      // A deadline of a test's hung child would otherwise keep node alive after it.
      wallpaperPlatform.dispose();
      systemChildren.disposeAll();
    },
  },
};
