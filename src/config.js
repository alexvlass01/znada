'use strict';

// Config defaults + load / migrate / save. No Electron dependency — the config
// path is passed in — so the (regression-prone) migration logic is unit-testable
// directly (see test/config.test.js). main.js keeps the live `config` object and
// just calls load()/save() through thin wrappers.
//
// The photo pool (`config.library`) is still part of the in-memory config object,
// but it is PERSISTED to its own sibling file — see ./library-store.js.
// Keeping the in-memory shape unchanged is
// deliberate: ~90 call sites across main and renderer read `config.library`, and
// none of them should care where the bytes live.

const fs = require('fs');
const path = require('path');
const library = require('./library');
const libraryStore = require('./library-store');

const DEFAULT_CONFIG = {
  lightWallpaper: '',     // legacy global fallback (unless a slot was explicitly emptied)
  darkWallpaper: '',
  singleWallpaper: false, // одни обои на все мониторы (вместо своей пары на каждый)
  separateThemes: true,   // раздельные обои день/ночь (фишка Znada). false = один общий слот:
                          // UI прячет ночной слот, applyForTheme всегда берёт 'light', тема ОС
                          // игнорируется. Данные ночного слота при выключении НЕ стираются.
  monitors: {},           // { [deviceId]: { light: Slot, dark: Slot } }; Slot = { items: Item[] } (→ itemIds in Этап B)
  library: {},            // content pool { [id]: Item } — decoupled from placement (see src/library.js, future-todo #16)
  // Legacy compatibility mirror. New code uses wallpaperSchedule.mode; this stays true
  // only for mode='system' so older installed builds do not react to Windows while a
  // newer dev config is using an independent time/sun wallpaper schedule.
  autoSwitch: true,
  wallpaperSchedule: { mode: 'system', lightStart: '07:00', darkStart: '20:00' },
  style: 'fill',          // fill | fit | stretch | center | tile | span
  // Windows notification when a BACKGROUND change breaks (edge-triggered: once per
  // working→broken transition; a success resets). Manual actions toast in-app instead.
  notifyOnFailure: true,
  autostart: false,
  startMinimized: true,   // при автозапуске стартовать сразу в трее (флаг --hidden)
  language: 'system',     // 'system' | 'en' | 'ru' | 'uk'
  firstRunDone: false,
  telemetry: false,       // задел: анонимная статистика (пока ничего не отправляется)
  librarySort: 'added',   // сортировка в «Библиотеке»: 'added' | 'name' | 'size' | 'shuffle'
  // Znada itself switching the Windows theme on a schedule. mode: 'off'|'time'|'sun'
  themeSchedule: { mode: 'off', lightStart: '07:00', darkStart: '20:00', lat: '', lng: '' },
  themeOverride: null,    // manual override from the Home theme indicator: null (Auto) | 'light' | 'dark'
  _lastAutoTheme: null,   // theme that was active when the override was engaged (drives the Auto→light→dark→Auto cycle)
  // Слайдшоу: кадр меняют выбранные триггеры. order: 'sequential' | 'shuffle'
  slideshow: { enabled: false, intervalEnabled: true, intervalMin: 30, order: 'sequential' },
  slideshowIndex: {},     // { [deviceId]: { light: idx, dark: idx } } — текущий кадр
  slideshowCurrentPath: {}, // { [deviceId]: { light: path, dark: path } } — стабильная позиция при живых папках
  hotkeys: { nextWallpaper: { enabled: false, shortcut: '' } },
  gameModeBlock: false,
  // Wallpaper auto-change triggers. `stealth` is an object: enabled + which reasons it
  // applies to (startup/wakeup/interval) + how long to wait for a fullscreen window before
  // switching anyway. Legacy `stealth: true` migrates to enabled startup+wakeup (interval off).
  triggers: {
    onStartup: false,
    onWakeup: false,
    stealth: { enabled: false, startup: true, wakeup: true, interval: false, timeoutMin: 5 },
  },
  // Online tab content sources (Cloud C2). 'internet' = existing external search,
  // 'lumina' = the Znada Cloud catalog. Ключ настроек остался со старым именем
  // намеренно: он лежит в config.json у пользователей. Either or both may be on; default keeps the
  // previous behavior (external only) so existing users see no change.
  onlineSources: { lumina: false, internet: true },
  // Persisted Online search params (restored on restart). sort = whSort value;
  // purity = the SFW/Sketchy/NSFW content filter.
  onlineSort: 'date_added',
  onlinePurity: { sfw: true, sketchy: true, nsfw: false },
  // Fullscreen gallery viewer backdrop behind the (contained) photo.
  // 'ambient' = blurred copy of the photo, 'charcoal' = deep dark + vignette,
  // 'aurora' = subtle animated accent glow, 'color' = gradient from the photo's dominant color.
  viewerBackground: 'ambient',
  // Random, anonymised install id for Znada Cloud usage stats (anonymous users).
  // Generated once in main when empty; never contains personal data. Sent as the
  // X-Lumina-Anon-Id header on cloud requests; the server only stores a hash.
  anonId: '',
};

// Independent deep copy of the defaults — avoids sharing nested objects (monitors,
// slideshowIndex/slideshowCurrentPath) with DEFAULT_CONFIG, which previously could leak runtime state.
function freshDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

// Bring any config (old or new shape) into the current shape. Idempotent.
function normalize(cfg) {
  if (!cfg.monitors || typeof cfg.monitors !== 'object') cfg.monitors = {};
  cfg.themeSchedule = {
    mode: 'off', lightStart: '07:00', darkStart: '20:00', lat: '', lng: '',
    ...(cfg.themeSchedule && typeof cfg.themeSchedule === 'object' ? cfg.themeSchedule : {}),
  };
  if (!['off', 'time', 'sun'].includes(cfg.themeSchedule.mode)) cfg.themeSchedule.mode = 'off';
  for (const key of ['lightStart', 'darkStart', 'lat', 'lng']) {
    if (typeof cfg.themeSchedule[key] !== 'string') cfg.themeSchedule[key] = key === 'lightStart' ? '07:00' : key === 'darkStart' ? '20:00' : '';
  }

  // Migrate the old autoSwitch boolean without changing existing user behavior:
  // true -> follow Windows, false -> stay on the current slot until changed manually.
  const rawWallpaperSchedule = cfg.wallpaperSchedule && typeof cfg.wallpaperSchedule === 'object'
    ? cfg.wallpaperSchedule
    : null;
  cfg.wallpaperSchedule = {
    mode: cfg.autoSwitch === false ? 'off' : 'system',
    lightStart: '07:00',
    darkStart: '20:00',
    ...(rawWallpaperSchedule || {}),
  };
  if (!['off', 'system', 'time', 'sun'].includes(cfg.wallpaperSchedule.mode)) cfg.wallpaperSchedule.mode = 'system';
  if (typeof cfg.wallpaperSchedule.lightStart !== 'string') cfg.wallpaperSchedule.lightStart = '07:00';
  if (typeof cfg.wallpaperSchedule.darkStart !== 'string') cfg.wallpaperSchedule.darkStart = '20:00';
  cfg.autoSwitch = cfg.wallpaperSchedule.mode === 'system';
  // Content-pool model (see src/library.js, future-todo #16): populate cfg.library and
  // rewrite each monitor slot { string | items[] } → { itemIds[] }. Handles legacy
  // shapes and is idempotent (re-running on a migrated config is a no-op).
  library.migrateConfig(cfg);
  cfg.slideshow = {
    enabled: false, intervalEnabled: true, intervalMin: 30, order: 'sequential',
    ...(cfg.slideshow && typeof cfg.slideshow === 'object' ? cfg.slideshow : {}),
  };
  cfg.slideshow.enabled = !!cfg.slideshow.enabled;
  cfg.slideshow.intervalEnabled = cfg.slideshow.intervalEnabled !== false;
  if (!Number.isFinite(+cfg.slideshow.intervalMin) || +cfg.slideshow.intervalMin < 1) cfg.slideshow.intervalMin = 30;
  cfg.slideshow.intervalMin = Math.floor(+cfg.slideshow.intervalMin);
  if (cfg.slideshow.order !== 'shuffle') cfg.slideshow.order = 'sequential';
  if (!cfg.slideshowIndex || typeof cfg.slideshowIndex !== 'object') cfg.slideshowIndex = {};
  const rawCurrentPaths = cfg.slideshowCurrentPath && typeof cfg.slideshowCurrentPath === 'object'
    ? cfg.slideshowCurrentPath
    : {};
  cfg.slideshowCurrentPath = {};
  for (const [monitorId, paths] of Object.entries(rawCurrentPaths)) {
    if (!paths || typeof paths !== 'object') continue;
    cfg.slideshowCurrentPath[monitorId] = {
      light: typeof paths.light === 'string' ? paths.light : '',
      dark: typeof paths.dark === 'string' ? paths.dark : '',
    };
  }

  cfg.hotkeys = {
    nextWallpaper: { enabled: false, shortcut: '' },
    ...(cfg.hotkeys && typeof cfg.hotkeys === 'object' ? cfg.hotkeys : {}),
  };
  if (cfg.hotkeys.nextWallpaper && typeof cfg.hotkeys.nextWallpaper === 'object') {
    cfg.hotkeys.nextWallpaper = {
      enabled: !!cfg.hotkeys.nextWallpaper.enabled,
      shortcut: typeof cfg.hotkeys.nextWallpaper.shortcut === 'string' ? cfg.hotkeys.nextWallpaper.shortcut : '',
    };
  } else {
    cfg.hotkeys.nextWallpaper = { enabled: false, shortcut: '' };
  }

  cfg.gameModeBlock = !!cfg.gameModeBlock;
  cfg.separateThemes = cfg.separateThemes !== false; // default ON (упавшее/чужое значение → true)

  // Manual theme override: only 'light' | 'dark' | null are meaningful — anything else
  // (corrupt config, older builds) collapses to null (= Auto) instead of wedging the cycle.
  if (cfg.themeOverride !== 'light' && cfg.themeOverride !== 'dark') cfg.themeOverride = null;
  if (cfg._lastAutoTheme !== 'light' && cfg._lastAutoTheme !== 'dark') cfg._lastAutoTheme = null;
  if (!['added', 'name', 'size', 'shuffle'].includes(cfg.librarySort)) cfg.librarySort = 'added';

  cfg.triggers = {
    onStartup: false, onWakeup: false,
    ...(cfg.triggers && typeof cfg.triggers === 'object' ? cfg.triggers : {}),
  };
  cfg.triggers.onStartup = !!cfg.triggers.onStartup;
  cfg.triggers.onWakeup = !!cfg.triggers.onWakeup;
  // Stealth migration: legacy boolean → object. Old `true` becomes enabled with the
  // startup+wakeup scopes (interval OFF) so an update never silently adds interval changes.
  const rawStealth = cfg.triggers.stealth;
  // Any truthy non-object legacy value (true / 1 / 'yes') counts as "was on".
  const legacyStealthOn = typeof rawStealth !== 'object' ? !!rawStealth : false;
  const s = (rawStealth && typeof rawStealth === 'object') ? rawStealth : {};
  const timeout = Number(s.timeoutMin);
  cfg.triggers.stealth = {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : legacyStealthOn,
    startup: s.startup !== false,
    wakeup: s.wakeup !== false,
    interval: !!s.interval,
    timeoutMin: Number.isFinite(timeout) && timeout >= 1 ? Math.min(60, Math.floor(timeout)) : 5,
  };

  cfg.onlineSources = {
    lumina: false, internet: true,
    ...(cfg.onlineSources && typeof cfg.onlineSources === 'object' ? cfg.onlineSources : {}),
  };
  cfg.onlineSources.lumina = !!cfg.onlineSources.lumina;
  cfg.onlineSources.internet = !!cfg.onlineSources.internet;
  // Never leave the Online tab with no source selected (avoids an empty page).
  if (!cfg.onlineSources.lumina && !cfg.onlineSources.internet) cfg.onlineSources.internet = true;

  if (!['date_added', 'toplist', 'random', 'views'].includes(cfg.onlineSort)) cfg.onlineSort = 'date_added';
  cfg.onlinePurity = {
    sfw: true, sketchy: true, nsfw: false,
    ...(cfg.onlinePurity && typeof cfg.onlinePurity === 'object' ? cfg.onlinePurity : {}),
  };
  cfg.onlinePurity.sfw = !!cfg.onlinePurity.sfw;
  cfg.onlinePurity.sketchy = !!cfg.onlinePurity.sketchy;
  cfg.onlinePurity.nsfw = !!cfg.onlinePurity.nsfw;
  // Keep at least one purity on (the UI enforces the same).
  if (!cfg.onlinePurity.sfw && !cfg.onlinePurity.sketchy && !cfg.onlinePurity.nsfw) cfg.onlinePurity.sfw = true;

  if (!['ambient', 'charcoal', 'aurora', 'color'].includes(cfg.viewerBackground)) cfg.viewerBackground = 'ambient';

  if (!Array.isArray(cfg.libraryTrash)) cfg.libraryTrash = [];

  // Anonymous install id: keep only a well-formed value; anything else resets to ''
  // so main re-generates a fresh one.
  if (typeof cfg.anonId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(cfg.anonId)) cfg.anonId = '';

  return cfg;
}

// Read + parse + migrate + apply defaults. Never throws: a missing file yields
// defaults; a CORRUPT file is backed up (.corrupt-<ts>.bak) then replaced by defaults.
//
// The pool is read from its own file and merged in BEFORE normalize(), so
// library.migrateConfig() sees the real items and stays idempotent. A config that
// predates the split still carries its pool inline; that copy is picked up here and
// moves to the store on the next save.
function load(configPath) {
  let raw = null;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch { raw = null; }
  let cfg;
  let inlineLibrary = null;
  let inlineTrash = null;
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw.replace(/^﻿/, '')); // strip BOM if present
      cfg = { ...freshDefaults(), ...parsed };
      inlineLibrary = parsed.library && typeof parsed.library === 'object' ? parsed.library : null;
      // The recovery path writes the trash inline next to the pool; reading only the
      // pool back meant those entries vanished on the very next start.
      inlineTrash = Array.isArray(parsed.libraryTrash) ? parsed.libraryTrash : null;
      // The defaults are merged before normalize(). Preserve whether the new field
      // existed so legacy autoSwitch:false can migrate to mode='off'.
      if (!Object.prototype.hasOwnProperty.call(parsed, 'wallpaperSchedule')) cfg.wallpaperSchedule = null;
    } catch (err) {
      try { fs.copyFileSync(configPath, `${configPath}.corrupt-${Date.now()}.bak`); } catch {}
      console.error('config.json повреждён, откат к дефолтам (бэкап сохранён):', err);
      cfg = freshDefaults();
    }
  } else {
    cfg = freshDefaults();
  }
  const stored = libraryStore.load(configPath);
  cfg.library = libraryStore.mergeLibraries(stored.library, inlineLibrary);
  // Photos the user removed, kept so they can be put back (LIB-006). Lives with the
  // pool rather than in config.json for the same reason the pool does.
  cfg.libraryTrash = libraryStore.mergeTrash(stored.trash, inlineTrash);
  // Callers need to know how the pool got here: an unreadable store must not be
  // overwritten, and a merge that pulled ids out of the inline copy has to be
  // persisted rather than living only in memory. Non-enumerable so it never reaches
  // config.json or the renderer through a plain copy.
  const beforeNormalize = Object.keys(cfg.library).length + cfg.libraryTrash.length;
  const normalized = normalize(cfg);
  // normalize() calls migrateConfig(), which can CREATE pool entries out of legacy
  // slots or the old global fallback. Measured after it runs, or the entity would live
  // only in memory while its id was already written into a slot — a dangling reference
  // after the next restart.
  const afterNormalize = Object.keys(normalized.library).length + normalized.libraryTrash.length;
  Object.defineProperty(normalized, '_poolSource', {
    value: {
      storeExisted: !!stored.existed,
      unreadable: !!stored.unreadable,
      broken: !!stored.broken,
      newerVersion: !!stored.newerVersion,
      mergedInline: (!!inlineLibrary && Object.keys(inlineLibrary).length > 0)
        || (!!inlineTrash && inlineTrash.length > 0),
      normalizeAdded: afterNormalize !== beforeNormalize,
    },
    enumerable: false, writable: true, configurable: true,
  });
  return normalized;
}

// Atomic write (tmp + rename) so a crash mid-write can't truncate config.json.
//
// The pool goes to its own file and is written FIRST, and config.json only stops
// carrying the inline copy once that write is CONFIRMED. Dropping it regardless —
// which is what this did — meant a full disk, a permission error or an antivirus
// holding the file could leave the pool in neither place. Pass `skipLibrary` when a
// batched writer owns the pool, and `keepInline` when the store is known-unusable
// (an unreadable file) so the config stays self-sufficient until it is fixed.
function save(config, configPath, { skipLibrary = false, keepInline = false } = {}) {
  let poolSafe = true;
  if (!skipLibrary) {
    poolSafe = libraryStore.save(config && config.library, configPath, config && config.libraryTrash);
  }
  const inlineNeeded = keepInline || !poolSafe;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const onDisk = { ...config };
    if (!inlineNeeded) {
      delete onDisk.library;
      delete onDisk.libraryTrash;
    }
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(onDisk, null, 2), 'utf8');
    fs.renameSync(tmp, configPath);
  } catch (err) {
    console.error('Не удалось сохранить конфиг:', err);
    return false;
  }
  return poolSafe;
}

module.exports = { DEFAULT_CONFIG, freshDefaults, normalize, load, save };
