'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeTheme, dialog, shell, nativeImage, screen, autoUpdater, globalShortcut, powerMonitor, safeStorage, Notification, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execFile, execFileSync } = require('child_process');
const playlist = require('./src/playlist'); // чистая логика плейлистов (тестируется отдельно)
const library = require('./src/library'); // пул контента { [id]: Item }; слоты ссылаются по id
const { pathKey, isDirectChildPath } = require('./src/path-key'); // canonical identity for every local path map
const libraryAssignment = require('./src/library-assignment');
const folderState = require('./src/folder-state'); // persistent firstSeenAt для файлов живых папок
const liveFolderWatch = require('./src/live-folder-watch'); // lightweight fs.watch lifecycle + debounce
const wallhaven = require('./src/wallhaven'); // клиент Wallhaven (онлайн-обои): URL + разбор
const gelbooru = require('./src/gelbooru'); // Gelbooru: основной booru-провайдер
const danbooru = require('./src/danbooru'); // Danbooru: URL + нормализация в общую онлайн-карточку
const online = require('./src/online'); // смешивание и дедуп результатов внешних провайдеров
const tagSuggest = require('./src/tag-suggest'); // anonymous Gelbooru tag autocomplete
const itemDetails = require('./src/item-details'); // bounded metadata reader + URL/path validation
const { WallpaperHost, HOST_SCRIPT } = require('./src/wallpaper-host'); // живой PowerShell-COM-хост
const configMod = require('./src/config'); // дефолты + load/migrate/save (тестируется отдельно)
const libraryStore = require('./src/library-store'); // пул живёт в своём файле с пакетной записью
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
const galleryPayloadMod = require('./src/gallery-payload'); // viewer payload sanitizing/windowing
const hotkey = require('./src/hotkey'); // accelerator parsing + atomic globalShortcut replacement
const windowsLaunch = require('./src/windows-launch');
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
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
  diagnosticsControlWindow.loadFile(path.join(__dirname, 'diagnostics', 'ui', 'control.html'));
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
const WALLPAPERS_DIR = path.join(app.getPath('userData'), 'wallpapers');
const FOLDER_STATE_PATH = path.join(app.getPath('userData'), 'folder-state.json');

// Copy a chosen image into the app's own data dir so it survives app updates and
// the original being moved/deleted. Content-addressed name (wp-<md5>) → identical
// images dedupe automatically and re-adding the same file is a no-op. Returns path.
async function importWallpaper(srcPath) {
  await fs.promises.mkdir(WALLPAPERS_DIR, { recursive: true });
  const buf = await fs.promises.readFile(srcPath); // async: не блокируем main-поток на больших файлах
  const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 16);
  const ext = (path.extname(srcPath) || '.img').toLowerCase();
  const dest = path.join(WALLPAPERS_DIR, `wp-${hash}${ext}`);
  if (!fs.existsSync(dest)) await fs.promises.writeFile(dest, buf);
  return dest;
}

// Download a remote image into the app's data dir (content-addressed, like importWallpaper).
async function downloadImageTo(dir, url, fetchOptions = {}) {
  await fs.promises.mkdir(dir, { recursive: true });
  const res = await fetch(url, fetchOptions);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 16);
  let ext = '.jpg';
  try { const e = path.extname(new URL(url).pathname).toLowerCase(); if (/^\.[a-z0-9]{2,5}$/.test(e)) ext = e; } catch {}
  const dest = path.join(dir, `wp-${hash}${ext}`);
  if (!fs.existsSync(dest)) await fs.promises.writeFile(dest, buf);
  return dest;
}

// Downloading INTO the library. ONL-009 also needs the same picture somewhere the
// library does not own — an export or a clipboard copy must not leave an orphan file
// inside wallpapers/ for the sweeper to find — hence the split above.
async function downloadWallpaperFromUrl(url, fetchOptions = {}) {
  return downloadImageTo(WALLPAPERS_DIR, url, fetchOptions);
}

// Bundled Wallhaven API key — official builds only. It lives in a gitignored file
// (wallhaven-key.json) so it's never in the public repo; absent for self-builds, where
// the app simply stays keyless (SFW+sketchy still work, NSFW needs the bundled key).
function loadBundledWallhavenKey() {
  try {
    const k = require('./wallhaven-key.json');
    return k && typeof k.apikey === 'string' ? k.apikey.trim() : '';
  } catch { return ''; }
}
const BUNDLED_WALLHAVEN_KEY = loadBundledWallhavenKey();
// Effective key: the bundled one (official builds only). Users can't enter their own —
// the Wallhaven key is internal-only by design.
function wallhavenKey() {
  return BUNDLED_WALLHAVEN_KEY || '';
}

// Gelbooru credentials are bundled only with official/local builds and stay in
// a gitignored file. If absent or rejected, the search path falls back to the
// public Danbooru adapter instead of disabling the Internet source.
function loadBundledGelbooruCredentials() {
  try {
    const k = require('./gelbooru-key.json');
    const userId = String(k && (k.userId || k.user_id) || '').trim();
    const apiKey = String(k && (k.apiKey || k.api_key) || '').trim();
    return userId && apiKey ? { userId, apiKey } : null;
  } catch { return null; }
}
const BUNDLED_GELBOORU_CREDENTIALS = loadBundledGelbooruCredentials();

// Дефолты + load/migrate/save вынесены в ./src/config.js (тестируется: test/config.test.js).
let config = configMod.freshDefaults();
let slideshowPositionDirty = false;
// Snapshot of the most recent library removal so the toast can offer a real undo.
let lastLibraryRemoval = null;
// Set when the pool file could not be read at startup: every write is suppressed so a
// temporary access problem cannot be turned into an empty library on disk.
let libraryUnsafeToWrite = false;

// The photo pool has its own file and its own batched writer (see
// src/library-store.js). Settings stay on the immediate path — they are small and
// the user expects them saved at once — while pool edits coalesce, so adding tags
// to a folder full of photos no longer means one full rewrite per tag.
const libraryWriter = libraryStore.createWriter({
  configPath: CONFIG_PATH,
  onWriteFailure: () => enterLibraryWriteDegradedMode(),
});

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

// A store that was healthy at startup can still become unwritable later (locked tmp,
// full disk, permissions). From that first failed write onward config.json becomes the
// fail-closed copy for every pool edit until restart. Merely retaining the writer retry
// is insufficient: a later tag/favourite changes the in-memory pool while the pending
// trash array may already have been replaced.
function enterLibraryWriteDegradedMode() {
  if (libraryUnsafeToWrite) return;
  libraryUnsafeToWrite = true;
  console.error('Пул перестал записываться — новые изменения сохраняются inline до перезапуска.');
  configMod.save(config, CONFIG_PATH, { skipLibrary: true, keepInline: true });
  reportLibraryStoreProblem('unreadable');
}

function loadConfig() {
  config = configMod.load(CONFIG_PATH);
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
      configMod.save(config, CONFIG_PATH, { skipLibrary: true, keepInline: false });
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
    configMod.save(config, CONFIG_PATH, { skipLibrary: true, keepInline: true });
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
  const saved = configMod.save(config, CONFIG_PATH, { skipLibrary: true, keepInline });
  slideshowPositionDirty = false;
  broadcastConfig();
  return saved;
}

// For handlers that provably touch settings and nothing else. Keeps a switch flip from
// scheduling a full rewrite of thousands of pool records — the coupling the split
// storage existed to remove — without guessing on the paths that do touch the pool.
function saveSettingsOnly() {
  const saved = configMod.save(config, CONFIG_PATH, { skipLibrary: true, keepInline: libraryUnsafeToWrite });
  if (!saved) return false;
  slideshowPositionDirty = false;
  broadcastConfig();
  return true;
}

// Stable, anonymised install id for Znada Cloud usage stats (anonymous users).
// Generated once (32 hex chars), persisted in config; never contains personal data.
// Written directly (no broadcast) — it is main-only and the renderer never reads it.
function ensureAnonId() {
  if (/^[A-Za-z0-9_-]{8,128}$/.test(config.anonId || '')) return;
  config.anonId = crypto.randomBytes(16).toString('hex');
  configMod.save(config, CONFIG_PATH, { skipLibrary: true, keepInline: libraryUnsafeToWrite });
}

function persistSlideshowPosition() {
  if (!slideshowPositionDirty) return;
  configMod.save(config, CONFIG_PATH, { skipLibrary: true, keepInline: libraryUnsafeToWrite });
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
      return reject(new Error('Файл обоев не найден: ' + imagePath));
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
const TRASH_DIR = path.join(WALLPAPERS_DIR, '.trash');

// True when the file is Znada's own copy (import / Online download) rather than
// something of the user's that merely happens to be in the library. Only those go to
// wallpapers/.trash, and only those need remembering to be restorable from it.
function isOwnWallpaperCopy(p) {
  return isDirectChildPath(p, WALLPAPERS_DIR);
}
function gcWallpapers() {
  // Never sweep against a pool that failed to load: the keep-set would be wrong and
  // files still in use would be moved out from under the user.
  if (libraryUnsafeToWrite) return;
  try {
    // Предохранитель: если пул пуст (переходное/битое состояние) — НЕ трогаем ничего,
    // иначе keep свёлся бы к одним глобалам и всё остальное уехало бы в корзину.
    if (!config.library || Object.keys(config.library).length === 0) return;
    const keep = referencedFiles();
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    for (const f of fs.readdirSync(WALLPAPERS_DIR)) {
      if (f === '.trash') continue;
      const full = path.join(WALLPAPERS_DIR, f);
      try { if (!fs.statSync(full).isFile()) continue; } catch { continue; }
      if (!keep.has(pathKey(full))) {
        try { fs.renameSync(full, path.join(TRASH_DIR, f)); } catch { /* оставляем как есть, не удаляем */ }
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
    title: 'Znada',
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayColors(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#242424' : '#fafafa',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: diagRendererArgs('renderer-main'),
      // In diagnostics mode keep rAF running while the window is merely unfocused (the
      // floating control window must not zero out smoothness sampling). The probe still
      // stops counting when the window is genuinely hidden/minimized.
      backgroundThrottling: !DIAGNOSTICS_BOOTSTRAP.enabled,
    },
  });

  if (diagnosticsController) diagnosticsController.attachWindowEvents(mainWindow, 'main');

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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
    title: 'Znada Media Viewer',
    backgroundColor: '#050505',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'viewer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: diagRendererArgs('renderer-viewer'),
    },
  });

  if (diagnosticsController) diagnosticsController.attachWindowEvents(galleryWindow, 'viewer');

  galleryWindow.loadFile(path.join(__dirname, 'renderer', 'viewer.html'));

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
const cloudSessionPath = () => path.join(app.getPath('userData'), 'cloud-session.bin');

function loadStoredToken() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const p = cloudSessionPath();
    if (!fs.existsSync(p)) return null;
    return safeStorage.decryptString(fs.readFileSync(p)) || null;
  } catch { return null; }
}
function saveStoredToken(token) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false; // no DPAPI → keep in memory only
    fs.writeFileSync(cloudSessionPath(), safeStorage.encryptString(token));
    return true;
  } catch (err) { console.error('cloud token save:', err); return false; }
}
function clearStoredToken() {
  try { fs.rmSync(cloudSessionPath(), { force: true }); } catch {}
}

// Renderer-safe auth state (no token).
function cloudAuthState() {
  return {
    available: !!cloudCapability().apiBase,
    signedIn: !!_cloudToken && !!_cloudUser,
    user: _cloudUser ? _cloudUser.user : null,
    entitlements: _cloudUser ? _cloudUser.entitlements : [],
  };
}
function broadcastCloudSession() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cloud-session-changed', cloudAuthState());
}

// A protected call returned a normalized result. If it's a 401, the session is dead:
// drop the token everywhere and tell the renderer. Returns true if it was an auth error.
function cloudHandleAuthError(result) {
  if (result && result.ok === false && result.error && result.error.status === 401) {
    _cloudToken = null; _cloudUser = null; clearStoredToken();
    broadcastCloudSession();
    return true;
  }
  return false;
}

// Bring up a one-shot loopback listener, open the system browser at the Google start
// URL, and resolve with the one-time exchange code from the redirect (RFC 8252).
function runLoopbackSignin(challenge) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const code = cloudOauth.parseLoopbackCode(req.url);
      res.writeHead(code ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loopbackHtml(!!code));
      if (code) { cleanup(); resolve(code); }
    });
    let done = false;
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 5 * 60 * 1000);
    function cleanup() { if (done) return; done = true; clearTimeout(timer); try { server.close(); } catch {} }
    server.on('error', (err) => { cleanup(); reject(err); });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const url = cloudClientMod.buildGoogleStartUrl(cloudCapability().apiBase, { port, challenge });
      shell.openExternal(url).catch((err) => { cleanup(); reject(err); });
    });
  });
}

function loopbackHtml(okCode) {
  const msg = okCode ? 'Готово! Можете закрыть эту вкладку и вернуться в Znada.' : 'Код авторизации не получен. Вернитесь в Znada и попробуйте снова.';
  return `<!doctype html><meta charset="utf-8"><title>Znada</title><body style="font-family:Segoe UI,system-ui,sans-serif;background:#fafafa;color:#2e3436;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="margin:0 0 8px">Znada</h2><p>${msg}</p></div></body>`;
}

// Catalog page (renderer never calls the API directly — everything goes through here).
ipcMain.handle('cloud-catalog', async (e, opts) => {
  const client = cloudClient();
  if (!client) return { items: [], nextCursor: null, error: 'unavailable' };
  const o = opts || {};
  const rating = ['general', 'suggestive', 'explicit'].includes(o.rating) ? o.rating : 'general';
  const tag = typeof o.tag === 'string' && o.tag.trim() ? o.tag.trim() : undefined;
  const r = await client.getCatalog({ rating, tag, cursor: o.cursor || undefined, limit: 30, token: _cloudToken || undefined });
  if (!r.ok) {
    cloudHandleAuthError(r);
    return { items: [], nextCursor: null, error: r.error.code, kind: r.error.kind };
  }
  return { items: r.data.items, nextCursor: r.data.next_cursor, error: null };
});

// Download a catalog image into the local Library — fetches a FRESH signed URL at
// click time (never a stale catalog thumb URL), then reuses the existing safe import.
ipcMain.handle('cloud-add', async (e, item) => {
  const client = cloudClient();
  if (!client) return { config, error: 'unavailable' };
  if (!item || !item.id) return { config, error: 'badItem' };
  try {
    const dl = await client.getDownload(item.id, { token: _cloudToken || undefined });
    if (!dl.ok) { cloudHandleAuthError(dl); return { config, error: dl.error.code }; }
    const stored = await downloadWallpaperFromUrl(dl.data.url);
    // The download is slow and touches nothing shared; everything after it is inside
    // the lock, because a re-download lands on the same content-addressed file that a
    // "delete from disk" may be aiming at right now.
    return await withLibraryLock(async () => {
      const aspect = item.width > 0 && item.height > 0 ? item.width / item.height : 0;
      const id = addToPool('image', stored, { aspect });
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
  }
});

// Current auth state (renderer-safe). If a stored token exists but the profile isn't
// loaded yet, validate it against /v1/me (a dead/expired token is dropped silently).
ipcMain.handle('cloud-session', async () => {
  const client = cloudClient();
  if (_cloudToken && !_cloudUser && client) {
    const me = await client.getMe(_cloudToken);
    if (me.ok) _cloudUser = me.data;
    else if (cloudHandleAuthError(me)) { /* token cleared */ }
  }
  return cloudAuthState();
});

// Google sign-in: PKCE + loopback + system browser + exchange → store token, load /me.
ipcMain.handle('cloud-signin', async () => {
  const client = cloudClient();
  if (!client) return { ok: false, error: 'unavailable' };
  try {
    const { verifier, challenge } = cloudOauth.generatePkce();
    const code = await runLoopbackSignin(challenge);
    const ex = await client.exchangeAuth({ code, pkce_verifier: verifier, client_label: `Znada on ${os.hostname()}` });
    if (!ex.ok) return { ok: false, error: ex.error.code };
    _cloudToken = ex.data.session_token;
    saveStoredToken(_cloudToken);
    const me = await client.getMe(_cloudToken);
    _cloudUser = me.ok ? me.data : { user: ex.data.user, entitlements: [] };
    broadcastCloudSession();
    return { ok: true, state: cloudAuthState() };
  } catch (err) {
    const msg = err && /timeout/.test(String(err.message)) ? 'timeout' : 'signin_failed';
    console.error('cloud signin:', err);
    return { ok: false, error: msg };
  }
});

// Sign out: revoke the session server-side (best effort) and drop the local token.
ipcMain.handle('cloud-signout', async () => {
  const client = cloudClient();
  const token = _cloudToken;
  _cloudToken = null; _cloudUser = null; clearStoredToken();
  if (client && token) { try { await client.logout(token); } catch {} }
  broadcastCloudSession();
  return { ok: true, state: cloudAuthState() };
});

// Cloud favorites (C5) — account-synced, distinct from the local Library favorites.
// All require a session; a 401 drops it. add/remove are idempotent on the backend.
ipcMain.handle('cloud-favorites', async () => {
  const client = cloudClient();
  if (!client) return { items: [], error: 'unavailable' };
  if (!_cloudToken) return { items: [], error: 'missing_token' };
  const r = await client.getFavorites(_cloudToken);
  if (!r.ok) { cloudHandleAuthError(r); return { items: [], error: r.error.code }; }
  return { items: r.data.items, error: null };
});

ipcMain.handle('cloud-favorite', async (e, id, on) => {
  const client = cloudClient();
  if (!client) return { ok: false, error: 'unavailable' };
  if (!_cloudToken) return { ok: false, error: 'missing_token' };
  if (!id) return { ok: false, error: 'badItem' };
  const r = on ? await client.addFavorite(id, _cloudToken) : await client.removeFavorite(id, _cloudToken);
  if (!r.ok) { cloudHandleAuthError(r); return { ok: false, error: r.error.code }; }
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

ipcMain.handle('set-config', async (e, patch) => {
  const previousConfig = config;
  const next = { ...config, ...(patch || {}) };
  if (patch && patch.themeSchedule && typeof patch.themeSchedule === 'object') {
    next.themeSchedule = { ...config.themeSchedule, ...patch.themeSchedule };
  }
  if (patch && patch.wallpaperSchedule && typeof patch.wallpaperSchedule === 'object') {
    next.wallpaperSchedule = { ...config.wallpaperSchedule, ...patch.wallpaperSchedule };
  }
  // Register before committing the setting. Windows returns false when another
  // application owns the accelerator; in that case keep both the old config and
  // the old working registration instead of claiming success.
  let stagedHotkey = null;
  if (patch && 'hotkeys' in patch) {
    stagedHotkey = hotkeyCtl.prepare(next.hotkeys && next.hotkeys.nextWallpaper);
    if (!stagedHotkey.ok) return config;
  }
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
    if (stagedHotkey) stagedHotkey.rollback();
    return config;
  }
  if (stagedHotkey) stagedHotkey.commit();
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
  if (!isTrustedMainWindowSender(e)) return { ok: false, error: 'unauthorized' };
  return hotkeyCtl.setSuspended(!!recording);
});

const IMG_FILTERS = [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp', 'gif'] }];

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
  const dir = res.filePaths[0];
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
      const stats = fs.statSync(src);
      if (stats.isDirectory()) {
        if (assignToSlot(slot, 'folder', src)) added++;
        folderIds.push(library.idFor(src));
      } else if (stats.isFile()) {
        const ext = path.extname(src).toLowerCase();
        if (playlist.IMG_EXTS.has(ext)) {
          const stored = await importWallpaper(src);
          if (assignToSlot(slot, 'image', stored)) added++;
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
ipcMain.handle('library-add-folder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: tMain('library.addFolder'),
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { config, added: 0 };
  return withLibraryLock(async () => {
    const before = Object.keys(config.library).length;
    const revivalsBefore = poolRevivals;
    const id = addToPool('folder', res.filePaths[0]);
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
  const before = Object.keys(config.library).length;
  const revivalsBefore = poolRevivals;
  const folderIds = [];
  for (const src of paths) {
    try {
      const stats = fs.statSync(src);
      if (stats.isDirectory()) {
        const id = addToPool('folder', src);
        if (id) folderIds.push(id);
      } else if (stats.isFile() && playlist.IMG_EXTS.has(path.extname(src).toLowerCase())) {
        addToPool('image', await importWallpaper(src));
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
ipcMain.handle('library-remove-many', async (e, rawRecords) => withLibraryLock(async () => {
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

  return {
    config,
    affected,
    removed: undo.items.length,
    hidden: hiddenResult.updated + dirResult.updated,
    error: null,
    warning,
    undo: lastLibraryRemoval ? { count: records.length, token: lastLibraryRemoval.token } : null,
  };
}));

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
  if (fs.existsSync(item.path)) return true;
  const trashed = path.join(TRASH_DIR, path.basename(item.path));
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
    restoreOwnCopyFile(entry.item);
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
    if (!p || typeof p !== 'string') continue;
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
  isTrustedMainWindowSender(e) && isAuthorizedItemPath(p)
    ? readItemDetails(p) : itemDetails.emptyDetails()
));

// Reveal in Explorer. Only selects an existing path — no execution, no content leaves
// the machine — and the renderer can still only pass paths it already displays.
ipcMain.handle('item-reveal', async (e, p) => {
  if (!isTrustedMainWindowSender(e) || !isAuthorizedItemPath(p)) return false;
  try {
    await fs.promises.access(p, fs.constants.F_OK);
    shell.showItemInFolder(p);
    return true;
  } catch { return false; }
});

// Open an item's source page. The URL is NOT taken from the renderer: we look up the
// pool item and open the source we stored at download time, validated as http(s).
ipcMain.handle('item-open-source', async (e, id) => {
  if (!isTrustedMainWindowSender(e)) return false;
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
  if (!isTrustedMainWindowSender(e) || !isAuthorizedItemPath(p)) return false;
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
// The fullscreen viewer is a second window with its own bridge, so these cannot use
// isTrustedMainWindowSender: they would work in the grid and silently fail in the
// viewer, which is exactly the split ONL-008 was fixed for.
function isTrustedAppSender(event) {
  if (!event || !event.sender) return false;
  const windows = [mainWindow, galleryWindow];
  return windows.some((w) => w && !w.isDestroyed() && event.sender === w.webContents);
}

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
  const item = card.item && typeof card.item === 'object' ? card.item : null;
  return { kind, id, item };
}

function pooledImageFor(descriptor) {
  const item = descriptor.id && config.library ? config.library[descriptor.id] : null;
  if (!item || item.type !== 'image' || !item.path) return null;
  return fs.existsSync(item.path) ? item : null;
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
  const dir = managed ? WALLPAPERS_DIR : CARD_EXPORT_DIR;

  // Already ours and still on disk: nothing to fetch, whatever the card claims.
  const pooled = pooledImageFor(descriptor);
  if (pooled) return { path: pooled.path, error: null };

  try {
    if (descriptor.kind === 'cloud') {
      const client = cloudClient();
      if (!client) return { path: '', error: 'unavailable' };
      const id = descriptor.item && descriptor.item.id;
      if (!id) return { path: '', error: 'badItem' };
      // Always a FRESH signed URL. The one the card is holding may already be dead,
      // and it must never be reused or handed further.
      const dl = await client.getDownload(id, { token: _cloudToken || undefined });
      if (!dl.ok) { cloudHandleAuthError(dl); return { path: '', error: dl.error.code }; }
      return { path: await downloadImageTo(dir, dl.data.url), error: null };
    }

    if (descriptor.kind === 'internet') {
      if (!online.allowedDownloadUrl(descriptor.item)) return { path: '', error: 'badItem' };
      const stored = await downloadImageTo(dir, descriptor.item.full, {
        headers: internetRequestHeaders(descriptor.item),
      });
      return { path: stored, error: null };
    }

    // Local, but the record's file is gone. Saying so beats a silent no-op.
    return { path: '', error: 'missing' };
  } catch (err) {
    console.error('card file:', err);
    return { path: '', error: 'download' };
  }
}

// What the assign chooser needs, for a window that does not hold the config. The main
// window already has both; the fullscreen viewer has neither, and giving it the two
// values is cheaper and safer than giving it the whole config.
ipcMain.handle('card-assign-targets', (e) => {
  if (!isTrustedAppSender(e)) return { monitors: [], separateThemes: true };
  return {
    monitors: (monitorsCache || []).map((m) => ({ id: m.id, primary: !!m.primary })),
    separateThemes: config.separateThemes !== false,
  };
});

ipcMain.handle('card-open-source', async (e, raw) => {
  if (!isTrustedAppSender(e)) return { ok: false, error: 'denied' };
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
  if (!isTrustedAppSender(e)) return { ok: false, error: 'denied' };
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
  if (!isTrustedAppSender(e)) return { ok: false, error: 'denied' };
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
  if (!isTrustedAppSender(e)) return { ok: false, error: 'denied' };
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

// ---- Internet providers: Wallhaven + Gelbooru, with Danbooru fallback ----

const GELBOORU_PAGE_SIZE = 100;
const DANBOORU_PAGE_SIZE = 100;
const INTERNET_USER_AGENT = `Znada/${app.getVersion()} (https://github.com/alexvlass01/znada)`;
const INTERNET_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const INTERNET_THUMBNAIL_CACHE_SIZE = 200;
const INTERNET_FULL_MAX_BYTES = 30 * 1024 * 1024; // viewer full image (wallpapers can be large)
const INTERNET_TAG_SUGGEST_CACHE_SIZE = 200;
const internetThumbnailCache = new Map();
const internetTagSuggestCache = new Map();

ipcMain.handle('internet-status', () => ({
  hasKey: !!wallhavenKey(),
  bundled: !!BUNDLED_WALLHAVEN_KEY,
  // Gelbooru and the Danbooru fallback cover Explicit even when Wallhaven has
  // no bundled API key.
  nsfwAvailable: true,
}));

async function fetchInternetTagSuggestions(opts) {
  const prefix = tagSuggest.normalizeTagPrefix(opts && opts.q);
  if (prefix.length < tagSuggest.MIN_PREFIX_LEN) return { items: [], error: null };

  const limit = tagSuggest.clampLimit(opts && opts.limit);
  const cacheKey = `${prefix}|${limit}`;
  if (internetTagSuggestCache.has(cacheKey)) {
    const cached = internetTagSuggestCache.get(cacheKey);
    internetTagSuggestCache.delete(cacheKey);
    internetTagSuggestCache.set(cacheKey, cached);
    return cached;
  }

  const url = tagSuggest.buildGelbooruTagSuggestUrl({ q: prefix, limit });
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': INTERNET_USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { items: [], error: String(res.status) };
    const json = await res.json();
    const result = {
      items: tagSuggest.parseGelbooruTagSuggestions(json, { prefix, limit }),
      error: null,
    };
    internetTagSuggestCache.set(cacheKey, result);
    while (internetTagSuggestCache.size > INTERNET_TAG_SUGGEST_CACHE_SIZE) {
      internetTagSuggestCache.delete(internetTagSuggestCache.keys().next().value);
    }
    return result;
  } catch (err) {
    console.error('gelbooru tag suggest:', err);
    return { items: [], error: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

ipcMain.handle('internet-tag-suggest', (e, opts) => fetchInternetTagSuggestions(opts));

async function searchWallhavenProvider(opts) {
  const o = opts || {};
  const key = wallhavenKey();
  const p = o.purity || { sfw: true, sketchy: true, nsfw: false };
  const wantNsfw = !!p.nsfw && !!key;
  if (!p.sfw && !p.sketchy && !wantNsfw) {
    return { provider: 'wallhaven', items: [], meta: { currentPage: o.page || 1, lastPage: o.page || 1 }, error: null };
  }
  const purity = wallhaven.purityMask({ sfw: !!p.sfw, sketchy: !!p.sketchy, nsfw: wantNsfw });
  const url = wallhaven.buildSearchUrl({
    q: o.q || '',
    purity,
    categories: o.categories || '111',
    sorting: o.sort || o.sorting || 'date_added',
    page: o.page || 1,
    apikey: wantNsfw ? key : '',
  });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': INTERNET_USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { provider: 'wallhaven', items: [], meta: {}, error: String(res.status) };
    const json = await res.json();
    return { provider: 'wallhaven', ...wallhaven.parseSearch(json), error: null };
  } catch (err) {
    console.error('wallhaven search:', err);
    return { provider: 'wallhaven', items: [], meta: {}, error: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

async function searchDanbooruProvider(opts) {
  const o = opts || {};
  const page = Number(o.page) > 0 ? Number(o.page) : 1;
  const url = danbooru.buildSearchUrl({
    q: o.q || '',
    purity: o.purity,
    sorting: o.sort || o.sorting || 'date_added',
    page,
    limit: DANBOORU_PAGE_SIZE,
  });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': INTERNET_USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { provider: 'danbooru', items: [], meta: {}, error: String(res.status) };
    const json = await res.json();
    return { provider: 'danbooru', ...danbooru.parseSearch(json, { page, limit: DANBOORU_PAGE_SIZE }), error: null };
  } catch (err) {
    console.error('danbooru search:', err);
    return { provider: 'danbooru', items: [], meta: {}, error: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

async function searchGelbooruProvider(opts) {
  const o = opts || {};
  const page = Number(o.page) > 0 ? Number(o.page) : 1;
  const credentials = BUNDLED_GELBOORU_CREDENTIALS;
  if (!credentials) return { provider: 'gelbooru', items: [], meta: {}, error: 'unavailable' };
  const url = gelbooru.buildSearchUrl({
    q: o.q || '',
    purity: o.purity,
    sorting: o.sort || o.sorting || 'date_added',
    page,
    limit: GELBOORU_PAGE_SIZE,
    ...credentials,
  });
  try {
    const res = await fetch(url, { headers: { 'User-Agent': INTERNET_USER_AGENT }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { provider: 'gelbooru', items: [], meta: {}, error: String(res.status) };
    const json = await res.json();
    const apiError = gelbooru.responseError(json);
    if (apiError) return { provider: 'gelbooru', items: [], meta: {}, error: apiError };
    return { provider: 'gelbooru', ...gelbooru.parseSearch(json, { page, limit: GELBOORU_PAGE_SIZE }), error: null };
  } catch (err) {
    console.error('gelbooru search:', err);
    return { provider: 'gelbooru', items: [], meta: {}, error: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

async function searchBooruProvider(opts) {
  const primary = await searchGelbooruProvider(opts);
  if (!online.providerFailed(primary)) return primary;
  const fallback = await searchDanbooruProvider(opts);
  const resolved = online.resolveFallback(primary, fallback);
  if (!online.providerFailed(resolved)) {
    console.warn(`gelbooru unavailable (${primary.error}); using danbooru fallback`);
  }
  return resolved;
}

ipcMain.handle('internet-search', async (e, opts) => {
  const o = opts || {};
  const page = Number(o.page) > 0 ? Number(o.page) : 1;
  const results = await Promise.all([searchWallhavenProvider({ ...o, page }), searchBooruProvider({ ...o, page })]);
  const merged = online.mergeSearchResults(results, page);
  return {
    ...merged,
    hasKey: !!wallhavenKey(),
    nsfwAvailable: true,
  };
});

function internetRequestHeaders(item) {
  const headers = { 'User-Agent': INTERNET_USER_AGENT };
  if (item && item.provider === 'gelbooru') headers.Referer = 'https://gelbooru.com/';
  return headers;
}

async function fetchInternetThumbnail(item) {
  if (!online.allowedThumbnailUrl(item)) return { dataUrl: '', error: 'badItem' };
  const key = item.thumb;
  if (internetThumbnailCache.has(key)) {
    const cached = internetThumbnailCache.get(key);
    internetThumbnailCache.delete(key);
    internetThumbnailCache.set(key, cached);
    return cached;
  }

  const pending = (async () => {
    try {
      const res = await fetch(key, {
        headers: internetRequestHeaders(item),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { dataUrl: '', error: String(res.status) };
      const mime = online.thumbnailMime(res.headers.get('content-type'));
      const declaredSize = Number(res.headers.get('content-length')) || 0;
      if (!mime || declaredSize > INTERNET_THUMBNAIL_MAX_BYTES) return { dataUrl: '', error: 'badImage' };
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > INTERNET_THUMBNAIL_MAX_BYTES) return { dataUrl: '', error: 'badImage' };
      const dataUrl = online.thumbnailDataUrl(bytes, mime);
      return dataUrl ? { dataUrl, error: null } : { dataUrl: '', error: 'badImage' };
    } catch (err) {
      return { dataUrl: '', error: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
  })();

  internetThumbnailCache.set(key, pending);
  while (internetThumbnailCache.size > INTERNET_THUMBNAIL_CACHE_SIZE) {
    internetThumbnailCache.delete(internetThumbnailCache.keys().next().value);
  }
  const result = await pending;
  if (result.error) internetThumbnailCache.delete(key);
  return result;
}

// Booru CDNs may reject direct Chromium requests. Fetch only validated preview
// URLs in main and return a small data URL to renderer.
ipcMain.handle('internet-thumbnail', (e, item) => fetchInternetThumbnail(item));

// Full image for the viewer. Booru hosts (esp. Gelbooru's hotlink.php) need a Referer
// the renderer can't send, so main fetches the validated full URL and returns a data
// URL. Wallhaven loads directly in the viewer, so this is only used for booru items.
// Shared referer-gated, size-capped fetch → data URL. Used for both the sample
// (intermediate) and full (original) tiers; the viewer shows sample first and
// upgrades to full in the background to keep navigation fast and frugal.
async function fetchInternetImageUrl(item, url) {
  try {
    const res = await fetch(url, {
      headers: internetRequestHeaders(item),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { dataUrl: '', error: String(res.status) };
    const mime = online.thumbnailMime(res.headers.get('content-type'));
    if (!mime) return { dataUrl: '', error: 'badImage' };
    if ((Number(res.headers.get('content-length')) || 0) > INTERNET_FULL_MAX_BYTES) return { dataUrl: '', error: 'tooBig' };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > INTERNET_FULL_MAX_BYTES) return { dataUrl: '', error: 'tooBig' };
    const dataUrl = online.thumbnailDataUrl(bytes, mime);
    return dataUrl ? { dataUrl, error: null } : { dataUrl: '', error: 'badImage' };
  } catch (err) {
    return { dataUrl: '', error: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

async function fetchInternetFull(item) {
  if (!online.allowedFullFetchUrl(item)) return { dataUrl: '', error: 'badItem' };
  return fetchInternetImageUrl(item, item.full);
}
ipcMain.handle('internet-full', (e, item) => fetchInternetFull(item));

// Intermediate "sample" tier (booru downscale). Same host/referer rules as full.
async function fetchInternetSample(item) {
  if (!online.allowedSampleFetchUrl(item)) return { dataUrl: '', error: 'badItem' };
  return fetchInternetImageUrl(item, item.sample);
}
ipcMain.handle('internet-sample', (e, item) => fetchInternetSample(item));

// Gelbooru posts carry tag NAMES without types, so the base response can't tell
// us the artist. At download time we look up the tag types once and cache them per
// name (popular artist tags recur), then keep the artist(s) as the item's author.
// Danbooru already provides tag_string_artist; Wallhaven has no artist concept.
const gelbooruTagTypeCache = new Map();
const GELBOORU_TAG_TYPE_CACHE_MAX = 4000;

// Wallhaven's search endpoint carries no tags at all, so a downloaded wallpaper used
// to land in the library with none (ONL-008). The single-wallpaper endpoint has them;
// read it once, on the explicit download, not for every card in the feed.
async function wallhavenTagsForItem(item) {
  try {
    const url = wallhaven.buildWallpaperUrl(item && item.id, { apikey: wallhavenKey() });
    if (!url) return [];
    const res = await fetch(url, {
      headers: { 'User-Agent': INTERNET_USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    return wallhaven.tagsFromWallpaper(await res.json());
  } catch (err) {
    console.error('wallhaven tags:', err);
    return [];
  }
}

// Returns { label, tags }: the display label for item.author and the artist tags in
// their original underscore form, so the artist is searchable alongside other tags.
async function gelbooruArtistsForItem(item) {
  try {
    let tags = Array.isArray(item && item.tags)
      ? item.tags.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean)
      : [];
    // The item's tags came from the SEARCH response, where compactTags caps them at 24.
    // Gelbooru sorts tags alphabetically, so a late-sorting artist (BUG-002: tag 45 of
    // 51) is already missing here. Re-read the single post to see its full tag list;
    // this costs one request on an explicit user action, not on every search card.
    const postUrl = gelbooru.buildPostUrl(item && item.id, BUNDLED_GELBOORU_CREDENTIALS || {});
    if (postUrl) {
      const postRes = await fetch(postUrl, {
        headers: { 'User-Agent': INTERNET_USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (postRes.ok) {
        const posts = gelbooru.postsFromResponse(await postRes.json());
        const full = posts.length ? gelbooru.allTags(posts[0]) : [];
        if (full.length) tags = full;
      }
    }
    if (!tags.length) return { label: '', tags: [] };
    const typeMap = new Map();
    const unknown = [];
    for (const tag of tags) {
      if (gelbooruTagTypeCache.has(tag)) typeMap.set(tag, gelbooruTagTypeCache.get(tag));
      else unknown.push(tag);
    }
    if (unknown.length) {
      const url = gelbooru.buildTagTypesUrl(unknown, BUNDLED_GELBOORU_CREDENTIALS || {});
      if (url) {
        const res = await fetch(url, { headers: { 'User-Agent': INTERNET_USER_AGENT }, signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          for (const [name, type] of gelbooru.parseTagTypes(await res.json())) {
            gelbooruTagTypeCache.set(name, type);
            typeMap.set(name, type);
          }
          while (gelbooruTagTypeCache.size > GELBOORU_TAG_TYPE_CACHE_MAX) {
            gelbooruTagTypeCache.delete(gelbooruTagTypeCache.keys().next().value);
          }
        }
      }
    }
    // Owner decision: join multiple artists with a comma, at most 3.
    return {
      label: gelbooru.artistLabel(gelbooru.artistNamesFromTypes(tags, typeMap), 3).slice(0, 120),
      tags: gelbooru.artistTagsFromTypes(tags, typeMap),
    };
  } catch (err) {
    console.error('gelbooru author:', err);
    return { label: '', tags: [] };
  }
}

// Download a normalized provider item into the local pool. The renderer cannot
// turn this into an arbitrary downloader: provider and CDN host must match.
ipcMain.handle('internet-add', async (e, item, query) => {
  if (!online.allowedDownloadUrl(item)) return { config, error: 'badItem' };
  try {
    // The download itself is outside the lock — it is slow and touches nothing shared.
    // Everything from "this file is now ours" onwards is inside it: a re-download lands
    // on the same content-addressed path a "delete from disk" may be aiming at.
    const stored = await downloadWallpaperFromUrl(item.full, { headers: internetRequestHeaders(item) });
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
        // Both providers hide part of the metadata behind a per-item endpoint, so it is
        // fetched here, on the explicit download, rather than for every card in the feed.
        let extraTags = [];
        if (item.provider === 'gelbooru') {
          const artists = await gelbooruArtistsForItem(item);
          if (!it.author && artists.label) {
            library.updateItem(config.library, id, { author: artists.label });
          }
          extraTags = artists.tags;
        } else if (item.provider === 'wallhaven') {
          extraTags = await wallhavenTagsForItem(item);
        }
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
function isTrustedMainWindowSender(event) {
  return !!(event && mainWindow && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents);
}
ipcMain.handle('thumb', async (e, p, w, h) => {
  if (!isTrustedMainWindowSender(e)) return '';
  const data = await thumbnailData(p, w, h);
  return data.url;
});
ipcMain.handle('thumb-info', (e, p, w, h, priority) => (
  isTrustedMainWindowSender(e) ? thumbnailData(p, w, h, priority) : { url: '', width: 0, height: 0 }
));

// Resolve proportions before renderer inserts the next justified-grid chunk. A small
// worker pool avoids hammering Windows shell with dozens of simultaneous thumbnail jobs.
// Pool-item aspects are persisted as additive metadata; folder-expanded images are
// persisted separately in folder-state by thumbnailData's batched backfill.
ipcMain.handle('thumb-aspects', async (e, entries, w, h) => {
  if (!isTrustedMainWindowSender(e)) return [];
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
ipcMain.handle('library-materialize', async (e, p, type) => withLibraryLock(async () => {
  if (!p || typeof p !== 'string') return { config, id: null };
  const itemType = type === 'folder' ? 'folder' : 'image';
  if (await validateMaterializePath(p, itemType)) return { config, id: null };
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
  return { config, id };
}));

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
  try {
    return p ? pathToFileURL(p).href : '';
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
  // any existing file at that path first. Reported by the owner 2026-08-16 as
  // "an app called electron appeared and Znada disappeared from the list".
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
app.on('second-instance', () => {
  // Защита от ДУБЛЯ автозапуска: если в реестре осталось несколько устаревших записей (от dev/
  // портативной сборок), при входе в Windows поднимается несколько экземпляров — второй НЕ должен
  // «будить» окно, раз мы стартовали скрыто (--hidden). Ручной повторный запуск (позже) показывает окно.
  if (STARTED_HIDDEN && Date.now() - START_TS < 10000) return;
  showWindow();
});

app.whenReady().then(async () => {
  // Electron finalizes its default dev identity during startup, so apply the
  // Squirrel-matching ID immediately after ready and before any window/toast.
  if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);

  Menu.setApplicationMenu(null); // убираем стандартное меню File/Edit/View
  if (DIAGNOSTICS_BOOTSTRAP.enabled) {
    console.log(`[Diagnostics] enabled; userData=${DIAGNOSTICS_BOOTSTRAP.userDataPath}`);
  }
  loadConfig();
  ensureAnonId(); // generate the anonymous install id once, before any cloud request
  loadLiveFolderState();
  _cloudToken = loadStoredToken(); // restore a previous Znada Cloud session (validated on first use)
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
  if (diagnosticsController) {
    void diagnosticsController.shutdownBestEffort({ reason: 'before-quit' });
  }
  if (liveFolderFullScanTimer) clearTimeout(liveFolderFullScanTimer);
  liveFolderFullScanTimer = null;
  for (const retry of liveFolderWatcherRetryTimers.values()) clearTimeout(retry);
  liveFolderWatcherRetryTimers.clear();
  flushPendingLiveFolderAspects();
  flushLiveFolderState();
  libraryWriter.flush(); // batched pool edits must not die with the process
  configBroadcast.dispose();
  if (liveFolderWatcher) liveFolderWatcher.closeAll();
  void thumbnailHost.dispose();
  wpHost.dispose();
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
    getConfig: () => config,
    isUnsafeToWrite: () => libraryUnsafeToWrite,
    eventLogEntries: () => eventLog.list(),
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
    // Проверять надо не саму функцию, а что плановый обход её ЗОВЁТ при скрытом окне:
    // ровно эта развилка и молчала.
    runHourlyLiveFolderPass: () => scheduleLiveFolderFullScan(String("hourly"), 0),
    windowVisibleForLiveFolders: () => liveFolderWindowVisible(),
    blockIntervalLikeGameMode: () => retrySlideshowIntervalSoon(),
    disposeForTests: () => {
      libraryWriter.dispose();
      configBroadcast.dispose();
      clearSlideshowTimer();
      if (folderStateSaveTimer) clearTimeout(folderStateSaveTimer);
      if (liveFolderAspectTimer) clearTimeout(liveFolderAspectTimer);
    },
  },
};
