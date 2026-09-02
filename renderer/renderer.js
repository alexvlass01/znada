'use strict';

// Optional dev-diagnostics span bridge. window.znadaDiag is injected by preload ONLY
// under the diagnostics gate; in every normal run it is undefined and diagSpan returns
// a no-op end() closure, so instrumented call sites cost nothing.
function diagSpan(category, name) {
  return (window.znadaDiag && window.znadaDiag.span(category, name)) || (() => {});
}

// Fallback mock so the UI can be previewed in a plain browser (outside Electron).
// In the real app window.api is always provided by preload.js, so this is skipped.
if (!window.api) {
  let mock = { lightWallpaper: '', darkWallpaper: '', singleWallpaper: false, separateThemes: true, monitors: {}, library: {}, autoSwitch: true, wallpaperSchedule: { mode: 'system', lightStart: '07:00', darkStart: '20:00' }, style: 'fill', autostart: false, startMinimized: true, language: 'system', themeSchedule: { mode: 'off', lightStart: '07:00', darkStart: '20:00', lat: '', lng: '' }, slideshow: { enabled: false, intervalEnabled: true, intervalMin: 30, order: 'sequential' }, slideshowIndex: {}, slideshowCurrentPath: {}, triggers: { onStartup: false, onWakeup: false, stealth: { enabled: false, startup: true, wakeup: true, interval: false, timeoutMin: 5 } }, onlineSources: { lumina: false, internet: true }, onlineSort: 'date_added', onlinePurity: { sfw: true, sketchy: false, nsfw: false } };
  const mockAdd = (type, p) => { const iid = 'm' + p; mock.library[iid] = { id: iid, type, path: p }; return iid; };
  let mockUndo = []; // last mock removal, so the preview can exercise the Undo toast
  let mockUndoToken = '';
  let mockUndoSeq = 0;
  const mockSc = { desktop: false, startmenu: false };
  const mockCloud = { signedIn: false, user: null };
  let mockEventLog = [
    { atMs: Date.now() - 600e3, channel: 'live-folder:x', kind: 'failure', messageKey: 'journal.liveFolder', params: { name: 'Pictures' } },
    { atMs: Date.now() - 1800e3, channel: 'wallpaper-auto', kind: 'recovered', messageKey: 'journal.wallpaperAuto' },
    { atMs: Date.now() - 3600e3, channel: 'wallpaper-auto', kind: 'failure', messageKey: 'journal.wallpaperAuto' },
  ];
  // ?bigmock=N (browser preview only): synthesize a large Library of colored SVG
  // "photos" with varied aspect ratios to exercise the virtualized grid without
  // Electron. thumbInfo below parses the real width/height back out of the SVG.
  const bigMock = Number((location.search.match(/[?&]bigmock=(\d+)/) || [])[1]) || 0;
  for (let i = 0; i < bigMock; i++) {
    const hue = (i * 47) % 360;
    const [w, h] = [[320, 200], [200, 300], [320, 180], [260, 260], [420, 200]][i % 5];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="hsl(${hue},60%,45%)"/><text x="10" y="28" fill="#fff" font-size="22">${i}</text></svg>`;
    const p = 'data:image/svg+xml,' + encodeURIComponent(svg);
    mock.library['big' + i] = { id: 'big' + i, type: 'image', path: p, addedAt: 1000000 + i };
  }
  if (bigMock) mock.firstRunDone = true;
  window.api = {
    getConfig: async () => mock,
    setConfig: async (p) => (mock = { ...mock, ...p }),
    setHotkey: async (nextWallpaper) => {
      mock.hotkeys = { ...(mock.hotkeys || {}), nextWallpaper: { ...nextWallpaper } };
      return { ok: true, config: mock };
    },
    setHotkeyRecording: async () => ({ ok: true }),
    getVersion: async () => '1.0.0',
    getI18n: async () => {
      const load = async (code) => { try { return await (await fetch('../locales/' + code + '.json')).json(); } catch { return {}; } };
      const sys = 'ru';
      const set = mock.language || 'system';
      const code = set === 'system' ? sys : set;
      return { setting: set, system: sys, locale: code, dict: await load(code), fallback: await load('en') };
    },
    getMonitors: async () => [
      { id: 'MON-1', x: 0, y: 0, w: 1920, h: 1080, primary: true },
      { id: 'MON-2', x: 1920, y: -440, w: 1200, h: 1920, primary: false },
    ],
    getTheme: async () => 'light',
    getWallpaperTheme: async () => {
      if (mock.separateThemes === false) return 'light';
      const sch = mock.wallpaperSchedule || {};
      if (sch.mode !== 'time') return 'light';
      const hm = (s) => { const [h, m] = String(s || '').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
      const now = new Date();
      const n = now.getHours() * 60 + now.getMinutes();
      const light = hm(sch.lightStart || '07:00'), dark = hm(sch.darkStart || '20:00');
      const isLight = light < dark ? n >= light && n < dark : n >= light || n < dark;
      return isLight ? 'light' : 'dark';
    },
    addSlotImages: async (id, which) => {
      const theme = which === 'dark' ? 'dark' : 'light';
      if (!mock.monitors[id]) mock.monitors[id] = { light: { itemIds: [] }, dark: { itemIds: [] } };
      const slot = mock.monitors[id][theme];
      const iid = mockAdd('image', `C:/fake/photo${Object.keys(mock.library).length + 1}.jpg`);
      if (!slot.itemIds.includes(iid)) slot.itemIds.push(iid);
      return { config: mock, added: 1 };
    },
    addSlotFolder: async (id, which) => {
      const theme = which === 'dark' ? 'dark' : 'light';
      if (!mock.monitors[id]) mock.monitors[id] = { light: { itemIds: [] }, dark: { itemIds: [] } };
      const slot = mock.monitors[id][theme];
      const iid = mockAdd('folder', 'C:/fake/Pictures');
      if (!slot.itemIds.includes(iid)) slot.itemIds.push(iid);
      return { config: mock, added: 1 };
    },
    removeSlotItem: async (id, which, index) => {
      const theme = which === 'dark' ? 'dark' : 'light';
      const slot = mock.monitors[id] && mock.monitors[id][theme];
      if (slot && slot.itemIds) slot.itemIds.splice(index, 1);
      return mock;
    },
    clearSlot: async (id, which) => {
      const theme = which === 'dark' ? 'dark' : 'light';
      if (mock.monitors[id] && mock.monitors[id][theme]) mock.monitors[id][theme].itemIds = [];
      return mock;
    },
    currentImage: async (id, which) => {
      const theme = which === 'dark' ? 'dark' : 'light';
      const realId = mock.singleWallpaper ? 'MON-1' : id;
      const slot = mock.monitors[realId] && mock.monitors[realId][theme];
      const ids = slot && slot.itemIds ? slot.itemIds : [];
      const it = ids.map((x) => mock.library[x]).filter(Boolean)[0];
      if (!it) return '';
      return it.type === 'folder' ? '' : it.path; // mock can't scan folders
    },
    libraryAddImages: async () => { mockAdd('image', `C:/fake/lib${Object.keys(mock.library).length + 1}.jpg`); return { config: mock, added: 1 }; },
    libraryAddFolder: async () => { mockAdd('folder', 'C:/fake/LibFolder'); return { config: mock, added: 1 }; },
    libraryAddPaths: async (paths) => { (paths || []).forEach((p) => mockAdd('image', p)); return { config: mock, added: (paths || []).length }; },
    libraryRemoveMany: async (records) => {
      let removed = 0;
      mockUndo = [];
      mockUndoToken = '';
      for (const rec of (Array.isArray(records) ? records : [])) {
        const id = rec && (typeof rec === 'string' ? rec : rec.id);
        if (!id || !mock.library[id]) continue;
        mockUndo.push(mock.library[id]);
        delete mock.library[id];
        for (const m of Object.values(mock.monitors)) for (const th of ['light', 'dark']) if (m[th] && m[th].itemIds) m[th].itemIds = m[th].itemIds.filter((x) => x !== id);
        removed += 1;
      }
      // `affected` and `undo` are what the real handler returns and what the callers
      // branch on — without them the preview cannot exercise removal at all.
      if (removed) mockUndoToken = `mock-${++mockUndoSeq}`;
      return {
        config: mock, affected: removed, removed, hidden: 0, warning: null,
        undo: removed ? { count: removed, token: mockUndoToken } : null,
      };
    },
    libraryUndoRemove: async (token) => {
      if (!mockUndoToken || token !== mockUndoToken) {
        return { config: mock, restored: 0, error: 'stale_undo' };
      }
      const restored = mockUndo.length;
      for (const it of mockUndo) mock.library[it.id] = it;
      mockUndo = [];
      mockUndoToken = '';
      return { config: mock, restored };
    },
    libraryHiddenList: async () => ({ images: [] }),
    libraryRestore: async () => ({ config: mock, restored: 0 }),
    libraryDeleteForever: async () => ({ config: mock, deleted: 0, failed: 0, error: null }),
    libraryRefresh: async () => ({ config: mock, removed: 0 }),
    libraryToggleFavorite: async (id) => { if (mock.library[id]) mock.library[id].favorite = !mock.library[id].favorite; return mock; },
    libraryAddTag: async (id, tag) => { const it = mock.library[id]; const t = String(tag || '').trim().toLowerCase(); if (it && t) { it.tags = it.tags || []; if (!it.tags.includes(t)) it.tags.push(t); } return mock; },
    libraryRemoveTag: async (id, tag) => { const it = mock.library[id]; const t = String(tag || '').trim().toLowerCase(); if (it && it.tags) it.tags = it.tags.filter((x) => x !== t); return mock; },
    libraryAssign: async (id, monitorId, which) => {
      const theme = which === 'dark' ? 'dark' : 'light';
      const mid = monitorId || 'MON-1';
      if (!mock.monitors[mid]) mock.monitors[mid] = { light: { itemIds: [] }, dark: { itemIds: [] } };
      const slot = mock.monitors[mid][theme];
      if (!slot.itemIds.includes(id)) slot.itemIds.push(id);
      return { config: mock, ok: true, error: null };
    },
    libraryAssignRecord: async (record, monitorId, which) => {
      const existing = record && record.id && mock.library[record.id];
      const id = existing ? existing.id : mockAdd(record && record.type === 'folder' ? 'folder' : 'image', record && record.path);
      if (!monitorId || !id) return { config: mock, ok: false, error: 'bad_request', id: null, created: false };
      await window.api.libraryAssign(id, monitorId, which);
      return { config: mock, ok: true, error: null, id, created: !existing };
    },
    libraryAssignRecords: async (records, monitorId, which) => {
      let assigned = 0;
      let failed = 0;
      for (const record of (Array.isArray(records) ? records : [])) {
        const res = await window.api.libraryAssignRecord(record, monitorId, which);
        if (res.ok) assigned += 1;
        else failed += 1;
      }
      return { config: mock, ok: assigned > 0, error: assigned ? null : 'missing_item', assigned, failed };
    },
    folderInfo: async () => ({ count: 0, subfolders: 0, previews: [] }),
    folderEntries: async () => ({ folders: [], images: [], count: 0 }),
    expandFolders: async () => ({ images: [] }),
    libraryRecent: async (limit) => ({ items: Object.values(mock.library || {})
      .filter((item) => item && item.type === 'image' && item.path)
      .sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0))
      .slice(0, Number(limit) || 5) }),
    libraryEnsureSizes: async () => {
      // Mirror main: stamp a numeric size so needPool clears (otherwise size sort would
      // re-render forever in mock/preview mode).
      Object.values(mock.library || {}).forEach((it) => { if (it && it.type === 'image' && typeof it.size !== 'number') it.size = 0; });
      return mock;
    },
    libraryPathSizes: async (paths) => (Array.isArray(paths) ? paths : []).map((p) => ({ path: p, size: 0 })),
    itemDetails: async () => ({ exists: true, size: 2451234, modifiedAt: Date.now() - 864e5, width: 3840, height: 2160, isFolder: false }),
    itemReveal: async () => true,
    itemOpenSource: async () => true,
    itemCopyPath: async () => true,
    libraryMaterialize: async (p, type) => ({ config: mock, id: mockAdd(type === 'folder' ? 'folder' : 'image', p) }),
    getCloudCapability: async () => ({ environment: 'unavailable', available: false, authAvailable: false, reason: 'coming_soon' }),
    cloudAdd: async (item) => { const iid = 'cl' + item.id; mock.library[iid] = { id: iid, type: 'image', path: 'C:/fake/' + item.id + '.jpg', source: 'lumina:' + item.id }; return { config: mock, id: iid, error: null }; },
    cloudSession: async () => ({ available: true, signedIn: mockCloud.signedIn, user: mockCloud.signedIn ? mockCloud.user : null, entitlements: mockCloud.signedIn ? ['online_catalog'] : [] }),
    cloudSignin: async () => { mockCloud.signedIn = true; mockCloud.user = { id: 'u1', display_name: 'Test User', email: 'test@example.com', role: 'user', explicit_opt_in: false, created_at: Math.floor(Date.now() / 1000) }; return { ok: true, state: { available: true, signedIn: true, user: mockCloud.user, entitlements: ['online_catalog'] } }; },
    cloudSignout: async () => { mockCloud.signedIn = false; mockCloud.user = null; mockCloud.favs = {}; return { ok: true, state: { available: true, signedIn: false, user: null, entitlements: [] } }; },
    onCloudSession: () => {},
    cloudFavorites: async () => { const favs = mockCloud.favs || {}; const items = Object.keys(favs).map((id) => favs[id]); return { items, error: null }; },
    cloudFavorite: async (id, on) => { mockCloud.favs = mockCloud.favs || {}; if (on) mockCloud.favs[id] = { id, title: 'Fav ' + id, rating: 'general', published_at: Date.now() / 1000, width: 1920, height: 1080, thumb_url: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#e91e63"/></svg>') }; else delete mockCloud.favs[id]; return { ok: true, error: null }; },
    internetStatus: async () => ({ nsfwAvailable: true }),
    internetSearch: async (opts) => {
      const page = (opts && opts.page) || 1;
      const mk = (i, color) => ({ id: 'net' + page + '_' + i, provider: 'wallhaven', page: 'https://wh/' + page + '-' + i, full: 'data:', thumb: 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="${color}"/></svg>`), resolution: '1920x1080', category: 'general', width: 1920, height: 1080 });
      return { items: [mk(1, '#4b5563'), mk(2, '#374151'), mk(3, '#475569'), mk(4, '#334155')], meta: { currentPage: page, lastPage: 3 }, error: null, nsfwAvailable: true };
    },
    internetTagSuggest: async (opts) => {
      const q = String(opts && opts.q || '').toLowerCase();
      const items = [
        { name: 'blue_hair', count: 450000, category: 'general' },
        { name: 'blue_eyes', count: 390000, category: 'general' },
        { name: 'blue_archive', count: 90000, category: 'copyright' },
        { name: 'landscape', count: 70000, category: 'general' },
        { name: 'night_sky', count: 42000, category: 'general' },
      ].filter((it) => it.name.startsWith(q)).slice(0, (opts && opts.limit) || 10);
      return { items, error: null };
    },
    internetThumbnail: async (item) => ({ dataUrl: item && String(item.thumb || '').startsWith('data:') ? item.thumb : '', error: null }),
    // Records the source page the real handler records, so the preview can show a card
    // going in and back out again (ONL-008) rather than always looking un-added.
    internetAdd: async (item) => {
      const id = mockAdd('image', 'C:/fake/online-' + ((item && item.id) || Object.keys(mock.library).length) + '.jpg');
      mock.library[id].source = (item && item.page) || '';
      return { config: mock, id, error: null };
    },
    openGalleryViewer: async () => ({ ok: true }),
    setSlideshow: async (patch) => { mock.slideshow = { ...mock.slideshow, ...patch }; return mock; },
    setSlideshowIndex: async (monitorId, which, index) => {
      const theme = which === 'dark' ? 'dark' : 'light';
      if (!mock.slideshowIndex[monitorId]) mock.slideshowIndex[monitorId] = { light: 0, dark: 0 };
      mock.slideshowIndex[monitorId][theme] = index;
      return mock;
    },
    setSlideshowToPath: async () => ({ config: mock, apply: { ok: true } }),
    applyNow: async () => ({ ok: false, reason: 'no-wallpaper' }),
    nextWallpaper: async () => ({ config: mock, apply: { ok: false, reason: 'no-wallpaper' } }),
    // Отсчёт на Главной: в браузере таймера нет, поэтому имитируем взведённый.
    // ?held=gamemode|stealth показывает состояния паузы без запуска игры.
    getNextChange: async () => {
      const held = (location.search.match(/[?&]held=(gamemode|stealth)/) || [])[1];
      return window.NextChange.describe({
        slideshowEnabled: !!mock.slideshow.enabled,
        intervalEnabled: mock.slideshow.enabled && mock.slideshow.intervalEnabled !== false,
        dueAt: Date.now() + (Number(mock.slideshow.intervalMin) || 30) * 60000,
        hold: held || null,
      });
    },
    onNextChange: () => {},
    setAutostart: async (v) => (mock.autostart = v),
    setStartMinimized: async (v) => (mock.startMinimized = v),
    fileUrl: async (p) => p,
    thumb: async (p) => p,
    thumbInfo: async (p) => {
      const m = /width%3D%22(\d+)%22%20height%3D%22(\d+)%22|width="(\d+)"\s+height="(\d+)"/.exec(String(p));
      const w = m ? Number(m[1] || m[3]) : 16;
      const h = m ? Number(m[2] || m[4]) : 10;
      return { url: p, width: w, height: h };
    },
    thumbAspects: async (entries) => entries.map((entry) => ({ path: entry.path, aspect: 1.6 })),
    eventLogGet: async () => ({ entries: mockEventLog }),
    eventLogClear: async () => { mockEventLog = []; return { entries: [] }; },
    quitApp: () => {},
    createShortcuts: async (which) => {
      if (which === 'desktop' || which === 'both' || !which) mockSc.desktop = true;
      if (which === 'startmenu' || which === 'both' || !which) mockSc.startmenu = true;
      return ['ok'];
    },
    shortcutsStatus: async () => ({ ...mockSc }),
    checkForUpdates: async () => ({ started: false, supported: false }),
    installUpdate: () => {},
    openReleases: () => {},
    detectLocation: async () => ({ ok: true, lat: 50.45, lng: 30.52, city: 'Kyiv' }),
    getUpdateState: async () => ({ state: 'idle', supported: false }),
    onTheme: () => {},
    onWallpaperTheme: () => {},
    onConfig: () => {},
    onLiveFoldersChanged: () => {},
    onMonitors: () => {},
    onUpdate: () => {},
  };
}

const $ = (sel) => document.querySelector(sel);

let config = null;
let currentTheme = 'light';
let currentWallpaperTheme = 'light';

// ---------------------------------------------------------------------------
// i18n — dictionaries come from the main process (single source of truth).
// t(key, params) looks up the active locale, falls back to English, then key.
// ---------------------------------------------------------------------------
const I18N = { dict: {}, fallback: {} };

function tPath(obj, key) {
  return key.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj);
}
function t(key, params) {
  let v = tPath(I18N.dict, key);
  if (v == null) v = tPath(I18N.fallback, key);
  if (v == null) v = key;
  if (params) for (const k in params) v = v.split('{' + k + '}').join(params[k]);
  return v;
}
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const txt = t(el.dataset.i18nTitle);
    if (el.tagName === 'OPTGROUP') el.label = txt;
    else el.title = txt;
    if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', txt);
  });
  document.querySelectorAll('[data-i18n-tooltip]').forEach((el) => {
    el.setAttribute('data-tooltip', t(el.dataset.i18nTooltip));
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
}
// What this build is allowed to offer, answered by main so the button and the handler
// behind it cannot disagree. Deleting files is off until its guard is proved (see
// PHYSICAL_DELETE_ENABLED in main.js).
const FEATURES = { physicalDelete: false };
async function loadFeatureFlags() {
  try {
    const flags = await window.api.getFeatureFlags();
    FEATURES.physicalDelete = !!(flags && flags.physicalDelete);
  } catch { FEATURES.physicalDelete = false; }
}
async function loadI18n() {
  await loadFeatureFlags();
  const info = await window.api.getI18n();
  I18N.dict = info.dict || {};
  I18N.fallback = info.fallback || {};
  const sel = $('#selLang');
  if (sel) sel.value = info.setting || 'system';
  if (info.locale) document.documentElement.lang = info.locale;
}
// Re-apply every string after a language change.
function refreshTexts() {
  const sl = $('#stripLight'); if (sl) sl.removeAttribute('data-items');
  const sd = $('#stripDark'); if (sd) sd.removeAttribute('data-items');

  // Clear preview/thumbnail path cache so they re-render with new translations
  ['#previewLight', '#previewDark'].forEach((id) => {
    const el = $(id);
    if (el) el.removeAttribute('data-bg-path');
  });
  applyI18n();
  applyThemeToUI(currentTheme); // hero subtitle
  buildMonitorMap();            // chip titles + label
  updateSingleWallRow();        // toggle row visibility + state
  renderPreviews();             // "not selected" placeholders
  renderHome();                 // status values + thumbnail labels
  updateShortcutButtons();      // re-translate shortcut buttons + keep "done" state
  renderUpdate();               // re-translate update status + button
  renderSmartPanel();           // re-translate smart panel texts
  closeLibPopup();              // a visible card menu must not keep stale language
  syncSelectionUI();            // checkbox labels + floating selection toolbar
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// A toast that also offers to take the action back. Removing photos is the case that
// needs it: nothing was deleted from disk, so undoing costs nothing, and a stray
// click on a large selection should not be a one-way door. Stays up longer than a
// plain toast because it asks the user to decide something.
function toastAction(msg, actionLabel, onAction) {
  const el = $('#toast');
  el.textContent = '';
  const text = document.createElement('span');
  text.textContent = msg;
  el.appendChild(text);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-action';
  btn.textContent = actionLabel;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    clearTimeout(toastTimer);
    el.classList.remove('show');
    await onAction();
  });
  el.appendChild(btn);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); el.textContent = ''; }, 6000);
}

// Success message for a removal. It never claims more than happened, and it only
// offers undo when main actually kept a snapshot to undo from.
async function undoLastRemoval(token) {
  let res;
  try { res = await window.api.libraryUndoRemove(token); }
  catch { res = null; }
  if (!res || res.error) { toast(t('library.undoFailed')); return; }
  config = res.config || config;
  // ONL-008 made this reachable from the Online tab too. A full re-render there would
  // refetch the feed and throw away the user's place in it, and the only thing that can
  // be out of date is which cards show as added — so re-derive just that.
  if (LIB.filter === 'online') { renderLibRailTags(); refreshOnlineAddedState(); }
  else renderLibrary();
  renderPreviews();
  renderHome();
  toast(t('library.undoneToast'));
}

function toastRemoved(count, undoToken) {
  const msg = t('library.removedToastN', { n: count });
  if (undoToken) toastAction(msg, t('library.undo'), () => undoLastRemoval(undoToken));
  else toast(msg);
}

// Honest outcome reporting for manual wallpaper actions (plan: error_notifications T1).
// Takes an applyForTheme-shaped result ({ok, reason}) and shows a HUMAN error toast for
// known failures. Returns true when an error was shown, so callers skip their success
// toast. `ignoreNoWallpaper` is for flows where an empty slot is EXPECTED and silence
// is correct (e.g. removing the last item of a slot — see LF-QA7).
const APPLY_ERROR_KEYS = {
  'no-wallpaper': 'toast.applyNoWallpaper',
  'gamemode-blocked': 'toast.applyGameMode',
  'not-in-playlist': 'toast.applyMissingFile',
};
function toastApplyError(res, opts = {}) {
  if (!res || res.ok !== false) return false;
  if (opts.ignoreNoWallpaper && res.reason === 'no-wallpaper') return false;
  toast(t(APPLY_ERROR_KEYS[res.reason] || 'toast.applyFailed'));
  return true;
}

// ---------------------------------------------------------------------------
// Monitors (from IDesktopWallpaper). Each: { id, x, y, w, h, primary }.
// The selected monitor is the one being configured + previewed.
// ---------------------------------------------------------------------------
let monitorList = [];
let selectedMonitorId = null;
let homeSelectedMonitorId = null;
let homePage = 0;
let homeRenderVersion = 0;
let homeBackdropVersion = 0;
const homeWallpaperCache = new Map();
// HOME-001: состояние следующей автоматической смены приходит ГОТОВЫМ из main
// (см. src/next-change.js). Здесь его не пересчитывают — только форматируют
// остаток до присланного момента, поэтому подпись не может разойтись с таймером.
let nextChangeState = null;
let homeCountdownTimer = null;
let monitorAspect = 16 / 9;
let previewContextVersion = 0;

function selectedMonitor() {
  return monitorList.find((m) => m.id === selectedMonitorId) || null;
}

function applySelectedAspect() {
  const m = selectedMonitor();
  monitorAspect = m && m.h ? m.w / m.h : 16 / 9;
  layoutMonitors();
}

function setMonitors(list) {
  const previousMonitorId = selectedMonitorId;
  monitorList = Array.isArray(list) && list.length ? list : [];
  if (!monitorList.find((m) => m.id === selectedMonitorId)) {
    const primary = monitorList.find((m) => m.primary) || monitorList[0];
    selectedMonitorId = primary ? primary.id : null;
  }
  if (!monitorList.find((m) => m.id === homeSelectedMonitorId)) homeSelectedMonitorId = null;
  if (selectedMonitorId !== previousMonitorId) resetPreviewsForMonitor(selectedMonitorId);
  applySelectedAspect();
  buildMonitorMap();
  updateSingleWallRow();
  renderPreviews();
  renderHome();
}

function fmtResolution(m) {
  let s = `${m.w}×${m.h}`;
  if (m.w < m.h) s += ' · ' + t('monitor.vertical');
  return s;
}

function updateMonLabel() {
  const el = $('#monLabel');
  if (!el) return;
  const m = selectedMonitor();
  if (!m) { el.textContent = ''; return; }
  const idx = monitorList.findIndex((x) => x.id === m.id) + 1;
  el.textContent = t('monitor.label', { n: idx }) + ` · ${fmtResolution(m)}` + (m.primary ? ` (${t('monitor.primary')})` : '');
}

function selectMonitor(m) {
  const changed = selectedMonitorId !== m.id;
  selectedMonitorId = m.id;
  if (changed) resetPreviewsForMonitor(m.id);
  applySelectedAspect();
  document.querySelectorAll('.monchip').forEach((c) => {
    c.classList.toggle('sel', c.dataset.id === selectedMonitorId);
  });
  updateMonLabel();
  renderPreviews();
}

// Build the monitor map (shown only when there is more than one monitor).
function buildMonitorMap() {
  const bar = $('#monitorBar');
  const map = $('#monMap');
  if (!bar || !map) return;
  // hidden for a single monitor, and when one wallpaper is shared across all
  if (monitorList.length < 2 || (config && config.singleWallpaper)) { bar.hidden = true; map.innerHTML = ''; updateMonLabel(); return; }
  bar.hidden = false;

  const MAX_H = 92, MAX_W = 156;
  const maxH = Math.max(...monitorList.map((m) => m.h));
  const maxW = Math.max(...monitorList.map((m) => m.w));
  const scale = Math.min(MAX_H / maxH, MAX_W / maxW);

  map.innerHTML = '';
  monitorList.forEach((m, i) => {
    const chip = document.createElement('button');
    chip.className = 'monchip' + (m.id === selectedMonitorId ? ' sel' : '');
    chip.dataset.id = m.id;
    chip.style.width = Math.max(22, Math.round(m.w * scale)) + 'px';
    chip.style.height = Math.max(22, Math.round(m.h * scale)) + 'px';
    chip.title = t('monitor.label', { n: i + 1 }) + `: ${fmtResolution(m)}` + (m.primary ? ` (${t('monitor.primary')})` : '');
    chip.innerHTML = `<span class="mnum">${i + 1}</span>`;
    chip.addEventListener('click', () => selectMonitor(m));
    map.appendChild(chip);
  });
  updateMonLabel();
}

// The "one wallpaper for all monitors" toggle is only meaningful with 2+ monitors.
function updateSingleWallRow() {
  const row = $('#rowSingleWall');
  if (!row) return;
  row.hidden = monitorList.length < 2;
  setSwitch($('#swSingle'), !!(config && config.singleWallpaper));
}

// ---------------------------------------------------------------------------
// Preview rendering
// ---------------------------------------------------------------------------
// How each wallpaper "style" maps to a CSS preview.
const STYLE_CSS = {
  // Windows DWPOS_FILL keeps vertical overflow near the upper third rather than CSS' 50% center.
  // Matching that anchor keeps square/portrait wallpaper previews aligned with the real desktop.
  fill:    { size: 'cover',     repeat: 'no-repeat', position: 'center 33.333%' },
  fit:     { size: 'contain',   repeat: 'no-repeat', position: 'center' },
  stretch: { size: '100% 100%', repeat: 'no-repeat', position: 'center' },
  center:  { size: 'auto',      repeat: 'no-repeat', position: 'center' },
  tile:    { size: 'auto',      repeat: 'repeat',    position: 'top left' },
  span:    { size: 'cover',     repeat: 'no-repeat', position: 'center' },
};

function applyPreviewStyle() {
  const css = STYLE_CSS[config.style] || STYLE_CSS.fill;
  ['#previewLight', '#previewDark'].forEach((sel) => {
    const el = $(sel);
    el.style.backgroundSize = css.size;
    el.style.backgroundRepeat = css.repeat;
    el.style.backgroundPosition = css.position;
  });
}

// Size each monitor thumbnail to fit ("contain") inside its fixed-size stage.
const STAGE_PADDING = 20; // 10px padding each side (see .stage)
function layoutMonitors() {
  document.querySelectorAll('.stage').forEach((stage) => {
    const W = stage.clientWidth - STAGE_PADDING;
    const H = stage.clientHeight - STAGE_PADDING;
    if (W <= 0 || H <= 0) return;
    let tw = W;
    let th = W / monitorAspect;
    if (th > H) { th = H; tw = H * monitorAspect; }
    const mon = stage.querySelector('.monitor');
    if (mon) {
      mon.style.width = Math.round(tw) + 'px';
      mon.style.height = Math.round(th) + 'px';
    }
  });
}

// id основного монитора (для режима «одни обои на все мониторы»)
function primaryMonitorId() {
  const p = monitorList.find((m) => m.primary) || monitorList[0];
  return p ? p.id : null;
}

// монитор, для которого редактируем плейлист (single-режим → основной)
function editTargetId() {
  return config.singleWallpaper ? primaryMonitorId() : selectedMonitorId;
}

function baseName(p) { return String(p).split(/[\\/]/).filter(Boolean).pop() || String(p); }

// элементы плейлиста выбранного (или основного) монитора для темы.
// Слот хранит ССЫЛКИ (itemIds) в пул config.library — резолвим в объекты {id,type,path}.
function slotItems(theme) {
  const m = config.monitors && config.monitors[editTargetId()];
  const slot = m && m[theme];
  const ids = slot && Array.isArray(slot.itemIds) ? slot.itemIds : [];
  const lib = config.library || {};
  return ids.map((id) => lib[id]).filter(Boolean);
}

async function setPreview(which, filePath, monitorId = selectedMonitorId) {
  const el = which === 'dark' ? $('#previewDark') : $('#previewLight');
  const contextId = monitorId || '';

  // A different monitor is a different visual context. Never cross-fade its old
  // wallpaper into the new monitor's geometry.
  if (el.dataset.monitorId !== contextId) {
    el.dataset.monitorId = contextId;
    el.style.backgroundImage = 'none';
    el.innerHTML = '';
    el.classList.remove('empty');
    el.removeAttribute('data-bg-path');
  }

  // If the path is already set, do not reload or rebuild to prevent flickering
  if (el.dataset.bgPath === filePath) {
    return;
  }
  el.dataset.bgPath = filePath;

  // Increment load ID to cancel any pending stale loads
  const loadId = (el.dataset.loadId ? parseInt(el.dataset.loadId, 10) : 0) + 1;
  el.dataset.loadId = loadId;

  // Get current state
  const oldBg = el.style.backgroundImage;

  let newBg = '';
  let newHtml = '';
  
  if (filePath) {
    el.classList.remove('empty');
    const url = await window.api.fileUrl(filePath);
    const newBgUrl = `${url}?v=${Date.now()}`;
    newBg = `url("${newBgUrl}")`;
    
    // Preload image
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => resolve(); // continue even if loading fails
      img.src = newBgUrl;
    });
  } else {
    el.classList.add('empty');
    newHtml = `<span class="preview-empty">${t('design.notSelected')}</span>`;
  }

  // If another load has started in the meantime, discard this stale update
  if (parseInt(el.dataset.loadId, 10) !== loadId) {
    return;
  }

  // Apply instantly and flicker-free (browser has the image cached now)
  if (oldBg && oldBg !== 'none' && oldBg !== newBg) {
    el.style.backgroundImage = `${newBg}, ${oldBg}`;
    setTimeout(() => {
      if (parseInt(el.dataset.loadId, 10) === loadId) {
        el.style.backgroundImage = newBg;
      }
    }, 150);
  } else {
    el.style.backgroundImage = newBg;
  }
  el.innerHTML = newHtml;
  applyPreviewStyle();
}

function resetPreviewsForMonitor(monitorId) {
  previewContextVersion++;
  ['#previewLight', '#previewDark'].forEach((selector) => {
    const el = $(selector);
    if (!el) return;
    const loadId = (Number.parseInt(el.dataset.loadId, 10) || 0) + 1;
    el.dataset.loadId = String(loadId);
    el.dataset.monitorId = monitorId || '';
    el.removeAttribute('data-bg-path');
    el.style.backgroundImage = 'none';
    el.innerHTML = '';
    el.classList.remove('empty');
  });
}

// big preview = resolved current image (main scans folders); strip = playlist items
function renderSlot(which) {
  const theme = which === 'dark' ? 'dark' : 'light';
  const monitorId = selectedMonitorId;
  const contextVersion = previewContextVersion;
  renderStrip(theme);
  window.api.currentImage(monitorId, theme).then((cur) => {
    if (contextVersion !== previewContextVersion || monitorId !== selectedMonitorId) return;
    setPreview(theme, cur, monitorId);
  });
}

function renderStrip(theme) {
  const strip = theme === 'dark' ? $('#stripDark') : $('#stripLight');
  if (!strip) return;
  const items = slotItems(theme);
  
  // Skip rebuilding if the items are identical to prevent flickering/re-rendering
  const itemsJson = JSON.stringify(items);
  if (strip.dataset.items === itemsJson) {
    return;
  }
  strip.dataset.items = itemsJson;
  
  strip.innerHTML = '';
  items.forEach((it, idx) => {
    const el = document.createElement('div');
    el.className = 'thumb' + (it.type === 'folder' ? ' folder' : '');
    if (it.type === 'folder') {
      el.innerHTML = '<span class="thumb-ic">' + FOLDER_ICON_SVG + '</span>';
      el.title = it.path;
    } else {
      el.title = baseName(it.path);
      // small thumbnail (data-URL is instant, no flicker; avoids decoding full-size files)
      window.api.thumb(it.path, 200, 130).then((u) => { if (u) el.style.backgroundImage = `url("${u}")`; });

      // Click on thumbnail → switch wallpaper to this item
      if (items.length > 1) {
        el.classList.add('clickable');
        el.addEventListener('click', async (ev) => {
          if (ev.target.closest('.thumb-remove')) return; // don't trigger on delete button
          const mon = editTargetId();
          if (!mon) return;
          // apply by PATH (folders expand, so the strip index != the slideshow index)
          const res = await window.api.setSlideshowToPath(mon, theme, it.path);
          config = (res && res.config) || res || config;
          // Clear preview cache so setPreview reloads with the new image
          const preview = theme === 'dark' ? $('#previewDark') : $('#previewLight');
          if (preview) preview.removeAttribute('data-bg-path');
          renderSlot(theme);
          renderHome();
          // Honest outcome: «Applied» only when the pick actually took effect.
          if (!toastApplyError(res && res.apply)) toast(t('toast.applied'));
        });
      }
    }
    const rm = document.createElement('button');
    rm.className = 'thumb-remove';
    rm.textContent = '×';
    rm.title = t('design.removeItem');
    rm.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      config = await window.api.removeSlotItem(editTargetId(), theme, idx);
      renderSlot(theme);
      renderHome();
      // Re-apply after removal; an emptied slot ('no-wallpaper') is expected silence
      // (LF-QA7), only a real apply failure deserves a toast.
      if (theme === currentTheme) {
        window.api.applyNow().then((r) => toastApplyError(r, { ignoreNoWallpaper: true })).catch(() => {});
      }
    });
    el.appendChild(rm);
    strip.appendChild(el);
  });
}

function renderPreviews() {
  if (!config) return;
  renderSlot('light');
  renderSlot('dark');
}

// Theme currently used for wallpapers. It may be independent from the Windows/UI theme.
function wallTheme() {
  return (config && config.separateThemes === false) ? 'light' : currentWallpaperTheme;
}

// Включает/выключает «единый» режим интерфейса: один широкий слот вместо пары день/ночь.
function updateSeparateThemesUI() {
  const single = !!(config && config.separateThemes === false);
  document.body.classList.toggle('single-theme', single);
  // Подпись под картой мониторов: в едином режиме без слов про «пару день/ночь».
  // Меняем сам data-i18n, чтобы applyI18n() при смене языка брал актуальный ключ.
  const note = document.querySelector('#monitorBar .mon-note');
  if (note) {
    note.dataset.i18n = single ? 'design.monitorNoteSingle' : 'design.monitorNote';
    note.textContent = t(note.dataset.i18n);
  }
}

// Adwaita-style line icons for light/dark. These replace the ☀️/🌙 emoji, which the OS
// drew as full-colour glyphs that clashed with the rest of the interface and shifted with
// the emoji font. Static markup only (no interpolation), so innerHTML stays safe.
const THEME_ICON_SVG = {
  light: '<svg class="theme-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.5V3.2M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4 4.6 4.6M11.4 11.4l1.2 1.2M12.6 3.4 11.4 4.6M4.6 11.4 3.4 12.6"/></svg>',
  dark: '<svg class="theme-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M14 8.53A6 6 0 1 1 7.47 2 4.67 4.67 0 0 0 14 8.53z"/></svg>',
};
// Оставшиеся эмодзи интерфейса, добитые тем же способом, что ☀️/🌙: ОС рисовала их
// цветными глифами шрифта Segoe UI Emoji, которые не совпадали по весу с линейным набором
// и ездили вместе со шрифтом. Разметка статическая (без подстановок), поэтому innerHTML безопасен.
const PANEL_ICON_SVG = {
  // Совет дня — лампочка.
  tip: '<svg class="panel-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.6a4.4 4.4 0 0 0-2.6 7.95c.4.3.63.76.63 1.25h3.94c0-.49.23-.95.63-1.25A4.4 4.4 0 0 0 8 1.6z"/><path d="M6.4 12.6h3.2M6.9 14.4h2.2"/></svg>',
  // Обновление скачано и ждёт перезапуска — стрелка «установить», а не ракета: она
  // говорит, что версия уже лежит на диске, а не что что-то взлетает.
  update: '<svg class="panel-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v7.4M4.9 6.5 8 9.6l3.1-3.1"/><path d="M2.8 12.6h10.4"/></svg>',
};
// Заглушка папки в полосе миниатюр «Оформления».
const FOLDER_ICON_SVG = '<svg class="thumb-ic-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" aria-hidden="true"><path d="M1.9 4.2c0-.5.4-.9.9-.9h3l1.4 1.6h6c.5 0 .9.4.9.9v6.1c0 .5-.4.9-.9.9H2.8a.9.9 0 0 1-.9-.9V4.2z"/></svg>';

// Pin badge for a manual override, drawn as a thumbtack (head + stem) instead of the 📌 emoji.
const THEME_PIN_SVG = '<span class="theme-pin" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="8" cy="5.6" r="4" fill="currentColor" stroke="none"/><path d="M8 9.8v3.4"/></svg></span>';

function setThemeIndicatorIcon(theme, pinned) {
  const el = $('#heroIcon');
  if (!el) return;
  el.innerHTML = THEME_ICON_SVG[theme === 'dark' ? 'dark' : 'light'] + (pinned ? THEME_PIN_SVG : '');
}

function applyThemeToUI(theme) {
  currentTheme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');

  const isDark = theme === 'dark';
  setThemeIndicatorIcon(isDark ? 'dark' : 'light', false);
  $('#heroSub').textContent = isDark ? t('home.themeDark') : t('home.themeLight');

  // Theme indicator doubles as a toggle: a pin badge marks a manual override (forced
  // light/dark), no pin means Auto. Tooltip explains the current mode + that it's clickable.
  if (config) {
    const mode = config.themeOverride;
    const ind = $('#themeIndicator');
    ind.style.cursor = 'pointer';
    if (mode === 'light') {
      ind.title = t('home.forceLight');
      setThemeIndicatorIcon('light', true);
    } else if (mode === 'dark') {
      ind.title = t('home.forceDark');
      setThemeIndicatorIcon('dark', true);
    } else {
      ind.title = t('home.themeAuto');
    }
  }

  // Подсвечиваем карточку слота, из которого СЕЙЧАС берутся обои (в едином режиме это
  // всегда светлый/общий слот, независимо от темы Windows).
  const activeSlot = wallTheme();
  document.querySelectorAll('.wallcard').forEach((c) => {
    c.style.outline = c.dataset.theme === activeSlot ? '2px solid var(--accent)' : 'none';
    c.style.outlineOffset = '1px';
  });
}

function setSwitch(el, on) {
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

function currentStealth() {
  const raw = config && config.triggers ? config.triggers.stealth : null;
  if (raw && typeof raw === 'object') {
    return {
      enabled: !!raw.enabled,
      startup: raw.startup !== false,
      wakeup: raw.wakeup !== false,
      interval: !!raw.interval,
      timeoutMin: raw.timeoutMin || 5,
    };
  }
  return { enabled: !!raw, startup: true, wakeup: true, interval: false, timeoutMin: 5 };
}

function setScopeCheckbox(el, checked, disabled) {
  if (!el) return;
  el.checked = !!checked;
  el.disabled = !!disabled;
  const wrap = el.closest('.stealth-scope-check');
  if (wrap) wrap.classList.toggle('disabled', !!disabled);
}

function renderSharedCoordinates() {
  const sch = (config && config.themeSchedule) || {};
  for (const id of ['#latInput', '#wallpaperLatInput']) if ($(id)) $(id).value = sch.lat || '';
  for (const id of ['#lngInput', '#wallpaperLngInput']) if ($(id)) $(id).value = sch.lng || '';
}

function renderWallpaperSchedule() {
  const sch = (config && config.wallpaperSchedule) || { mode: 'system', lightStart: '07:00', darkStart: '20:00' };
  if ($('#selWallpaperMode')) $('#selWallpaperMode').value = sch.mode || 'system';
  if ($('#wallpaperLightStart')) $('#wallpaperLightStart').value = sch.lightStart || '07:00';
  if ($('#wallpaperDarkStart')) $('#wallpaperDarkStart').value = sch.darkStart || '20:00';
  if ($('#wallpaperTimes')) $('#wallpaperTimes').hidden = (sch.mode !== 'time');
  if ($('#wallpaperSun')) $('#wallpaperSun').hidden = (sch.mode !== 'sun');
  renderSharedCoordinates();
}

function renderThemeSchedule() {
  const sch = (config && config.themeSchedule) || { mode: 'off', lightStart: '07:00', darkStart: '20:00', lat: '', lng: '' };
  const sel = $('#selThemeMode');
  if (sel) sel.value = sch.mode || 'off';
  if ($('#lightStart')) $('#lightStart').value = sch.lightStart || '07:00';
  if ($('#darkStart')) $('#darkStart').value = sch.darkStart || '20:00';
  if ($('#themeTimes')) $('#themeTimes').hidden = (sch.mode !== 'time');
  if ($('#themeSun')) $('#themeSun').hidden = (sch.mode !== 'sun');
  renderSharedCoordinates();
}

function updateSlideshowControls() {
  const ss = (config && config.slideshow) || { enabled: false, intervalEnabled: true, intervalMin: 30, order: 'sequential' };
  const trig = (config && config.triggers) || {};
  const stealth = currentStealth();
  setSwitch($('#swSlideshow'), !!ss.enabled);
  setSwitch($('#swSlideInterval'), ss.intervalEnabled !== false);
  if ($('#slideInterval')) $('#slideInterval').value = ss.intervalMin || 30;
  if ($('#slideInterval')) $('#slideInterval').hidden = ss.intervalEnabled === false;
  if ($('#selSlideOrder')) $('#selSlideOrder').value = ss.order || 'sequential';
  setSwitch($('#swTriggerStartup'), !!trig.onStartup);
  setSwitch($('#swTriggerWakeup'), !!trig.onWakeup);
  setSwitch($('#swTriggerStealth'), !!stealth.enabled);
  document.querySelectorAll('.slideshow-option').forEach((row) => { row.hidden = !ss.enabled; });
  const scopeRow = $('#rowTriggerStealthScope');
  if (scopeRow) scopeRow.hidden = !ss.enabled || !stealth.enabled;
  setScopeCheckbox($('#cbStealthStartup'), stealth.startup, !trig.onStartup);
  setScopeCheckbox($('#cbStealthWakeup'), stealth.wakeup, !trig.onWakeup);
  setScopeCheckbox($('#cbStealthInterval'), stealth.interval, ss.intervalEnabled === false);
  const list = $('#slideshowList');
  if (list) list.classList.toggle('collapsed', !ss.enabled);
}

async function renderConfig() {
  renderPreviews();
  applyPreviewStyle();
  setSwitch($('#swSeparate'), config.separateThemes !== false);
  updateSeparateThemesUI();
  setSwitch($('#swStartup'), config.autostart);
  setSwitch($('#swStartMin'), config.startMinimized !== false);
  setSwitch($('#swSingle'), !!config.singleWallpaper);
  setSwitch($('#swTelemetry'), !!config.telemetry);
  setSwitch($('#swGameMode'), !!config.gameModeBlock);
  setSwitch($('#swNotifyFail'), config.notifyOnFailure !== false);
  $('#selStyle').value = config.style || 'fill';
  const selVb = $('#selViewerBackground');
  selVb.value = config.viewerBackground || 'ambient';
  if (!selVb.value) selVb.value = 'ambient'; // a stored mode that isn't exposed yet → show ambient
  updateSingleWallRow();
  updateSlideshowControls();
  renderWallpaperSchedule();
  renderThemeSchedule();

  // Hotkeys
  const hk = config.hotkeys && config.hotkeys.nextWallpaper;
  const isEnabled = hk ? !!hk.enabled : false;
  const shortcutText = (hk && hk.shortcut) ? hk.shortcut : '';
  setSwitch($('#swShortcutEnabled'), isEnabled);
  const recBtn = $('#btnRecordShortcut');
  if (recBtn) {
    if (shortcutText) {
      recBtn.textContent = shortcutText;
      recBtn.classList.add('assigned');
    } else {
      recBtn.textContent = t('shortcuts.pressKeys');
      recBtn.classList.remove('assigned');
    }
  }
  const clearBtn = $('#btnClearShortcut');
  if (clearBtn) {
    clearBtn.hidden = !shortcutText;
  }
}

// ---------------------------------------------------------------------------
// Library (content pool) — browse/organize all wallpapers, assign from a card.
// ---------------------------------------------------------------------------
const LIB = {
  filter: 'all', sort: 'added', q: '', tagQuery: '', folderPath: null, crumbs: [], shuffleRank: {},
  selection: window.CardInteraction.createSelectionModel(), aspectCache: new Map(), sizeCache: new Map(),
  poolBySelectionKey: new Map(),
};
// The trash. Named rather than repeated as a string literal because a photo in there
// is REMOVED: the only things it may offer are putting it back and deleting its file.
// Every "is this allowed here" check asks this one question, so a new view or a new
// card type cannot quietly grow an action the trash is not supposed to have.
function inRemovedView() { return LIB.filter === 'removed'; }
let libraryBatchAssignPending = false;
let libraryBatchRemovePending = false;
const folderInfoCache = new Map(); // path key -> shared promise for virtualized folder cards
let folderCardEpoch = 0;           // rebuild visible collages after their directory contents change
let allViewToken = 0;   // guards async folder/All renders against races
let thumbIO = null;     // IntersectionObserver that loads thumbnails on scroll
const deferredLiveRefresh = window.DeferredRefresh.create(['home', 'library']);
let lastLibRenderKey = '';     // view+content the grid was last rendered for; skip rebuild when unchanged
let lastLibViewKey = '';       // view IDENTITY only (filter/folder/query/sort); scroll resets to top only when THIS changes
let activePage = 'home';       // current top-level tab; used to save/restore per-tab scroll
const pageScroll = { home: 0, library: 0, design: 0, prefs: 0 }; // remembered scrollTop per tab
let justifiedFrame = 0;
const justifiedPending = new Set();
let aspectLayoutTimer = 0;
let libLazyKick = null;
let thumbRequestPriority = 0;
let lastLibraryScrollAt = 0;
const libraryResizeSession = window.ResizeAnchor.createSession();
let libraryViewAnchor = null;
let libraryAnchorFrame = 0;
let libraryResizeFinishTimer = 0;
let libraryResizeLastChangeAt = 0;
let libraryResizeActive = false;
const LIB_RESIZE_SETTLE_MS = 120;
// BUG-020. `sortTouched` is the ONE exception to "an empty search box means the curated
// front page". It is set only when the user changes the ordering while the box is empty
// — at that point the control has to do what it says, or it reads as broken — and it is
// deliberately NOT persisted and NOT remembered past a real search. So the front page
// always comes back curated on the next visit; the ordering the user keeps is the one
// that applies to their searches.
const INTERNET = { q: '', sort: 'date_added', purity: { sfw: true, sketchy: false, nsfw: false }, resume: null, nsfwAvailable: false, searched: false, statusFetched: false, sortTouched: false };
const INTERNET_TAG_SUGGEST = { timer: 0, seq: 0, cache: new Map(), items: [], index: -1, token: null };
const INTERNET_TAG_SUGGEST_DEBOUNCE_MS = 450;
const INTERNET_TAG_SUGGEST_MIN_LEN = 3;
const GALLERY_MAX_PAYLOAD_ITEMS = 500;
const LIB_THUMB_PRELOAD_PX = 800;
const LIB_THUMB_PRELOAD_MARGIN = `${LIB_THUMB_PRELOAD_PX}px`;
// Virtualized grid: rows within viewport ± this margin stay materialized. Must be
// larger than the thumb preload margin so thumbnails still start loading off-screen.
const LIB_VIRTUAL_OVERSCAN_PX = 1600;
// Cloud C2: capability state (environment/available/reason) fetched once from main.
const CLOUD = { cap: null, fetched: false };
// Unified online feed state. view = 'search' | 'favorites'; loaded gates the initial
// auto-search and is reset when leaving the Online tab (so signed R2 URLs stay fresh).
const ONLINE = {
  view: 'search', loaded: false, loading: false, generation: 0, renderEpoch: 0, entries: [],
};
// Cloud C4: account/session state (renderer-safe; the token never leaves main).
const CLOUDAUTH = { state: null, fetched: false, signingIn: false };
// Cloud C5: account-synced favorites (ids of catalog items the user has hearted).
const CLOUDFAV = { ids: new Set(), fetched: false };

function setLibCardAspect(card, aspect, opts = {}) {
  if (!card) return;
  const safe = window.JustifiedLayout.normalizeAspect(aspect, 0.65, 3);
  const previous = Number(card.dataset.aspect);
  if (Number.isFinite(previous) && Math.abs(previous - safe) < 0.005) return;
  card.dataset.aspect = String(safe);
  const grid = card.closest('.lib-grid');
  if (grid) {
    // Virtualized grid: the layout is computed from the entries list, so the refined
    // aspect must land in the virtual state too (keyed by combined index) — the card
    // itself may be dematerialized and rebuilt later.
    const virtual = grid.__virtual;
    const gridIndex = Number(card.dataset.virtualIndex);
    if (virtual && typeof virtual.setAspect === 'function'
      && Number.isInteger(gridIndex) && gridIndex >= 0) {
      virtual.setAspect(gridIndex, safe, { relayout: false });
    }
    if (opts.deferred) scheduleDeferredJustifiedLayout(grid);
    else scheduleJustifiedLayout(grid);
  }
}

function knownLibAspect(item, p, fallbackAspect = 0) {
  const direct = item && Number(item.aspect);
  if (Number.isFinite(direct) && direct > 0) return direct;
  if (item && item.width > 0 && item.height > 0) return item.width / item.height;
  const cached = LIB.aspectCache.get(normPathKey(p || (item && item.path))) || 0;
  if (cached) return cached;
  const fallback = Number(fallbackAspect);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function primeLibCardAspect(card, item, p, fallbackAspect = 0) {
  const aspect = knownLibAspect(item, p, fallbackAspect);
  card.dataset.aspectKnown = aspect > 0 ? 'true' : 'false';
  setLibCardAspect(card, aspect || 1.6);
}

function layoutLibGrid(grid, suppliedAnchor = null) {
  if (!grid || !grid.isConnected) return;
  // Virtualized grid (#libGrid in All/folder views): geometry comes from the full
  // entries list, not from DOM children — delegate and keep the scroll anchor.
  if (grid.__virtual && typeof grid.__virtual.relayout === 'function') {
    const sessionAnchor = suppliedAnchor || currentLibraryResizeAnchor();
    const rememberedAnchor = !sessionAnchor
      && isMaterializedLibraryViewAnchor(libraryViewAnchor, grid) ? libraryViewAnchor : null;
    const scrollAnchor = sessionAnchor
      || rememberedAnchor
      || captureLibraryScrollAnchor(grid);
    const previousWidth = Number(grid.__virtual.layoutWidth) || 0;
    const shrinking = previousWidth > 0 && grid.clientWidth < previousWidth - 0.5;
    const relayout = grid.__virtual.relayout({
      // Expand keeps the established c23e257 path. Shrink gets a bounded one-pass
      // plan from the logical anchor so it never materializes the false viewport
      // represented by the old pixel scrollTop in the new, taller geometry.
      anchor: shrinking ? scrollAnchor : null,
    });
    if (!relayout || !relayout.anchorRestored) restoreLibraryScrollAnchor(scrollAnchor, grid);
    if (!currentLibraryResizeAnchor()) {
      libraryViewAnchor = scrollAnchor || captureLibraryScrollAnchor(grid);
    }
    return;
  }
  const width = grid.clientWidth;
  if (width < 40) return;
  const cards = Array.from(grid.children).filter((el) => el.classList.contains('lib-card'));
  if (!cards.length) return;
  const scrollAnchor = suppliedAnchor
    || currentLibraryResizeAnchor()
    || libraryViewAnchor
    || captureLibraryScrollAnchor(grid);
  const targetHeight = window.VirtualWindow.responsiveTargetHeight(width);
  const boxes = window.JustifiedLayout.layout(
    cards.map((card) => Number(card.dataset.aspect) || 1.6),
    width,
    { gap: 10, targetHeight, minAspect: 0.65, maxAspect: 3 }
  );
  cards.forEach((card, i) => {
    const box = boxes[i];
    card.style.width = `${box.width.toFixed(2)}px`;
    card.style.height = `${box.height.toFixed(2)}px`;
  });
  restoreLibraryScrollAnchor(scrollAnchor, grid);
  if (!currentLibraryResizeAnchor()) {
    libraryViewAnchor = scrollAnchor || captureLibraryScrollAnchor(grid);
  }
}

function scheduleJustifiedLayout(grid) {
  if (grid) justifiedPending.add(grid);
  if (justifiedFrame) return;
  justifiedFrame = requestAnimationFrame(() => {
    justifiedFrame = 0;
    const grids = Array.from(justifiedPending);
    justifiedPending.clear();
    grids.forEach(layoutLibGrid);
  });
}

function scheduleAllLibraryLayouts() {
  scheduleJustifiedLayout(activeLibraryGrid());
}

// ids referenced by any monitor×theme slot (to mark assigned items)
function assignedIds() {
  const set = new Set();
  for (const m of Object.values(config.monitors || {})) {
    for (const th of ['light', 'dark']) {
      const s = m[th];
      if (s && Array.isArray(s.itemIds)) s.itemIds.forEach((id) => set.add(id));
    }
  }
  return set;
}

// The part of the grid that needs a FULL rebuild when it changes: pool items + their
// favorite/type + the sort. Separated from the assigned set so that an assignment-only
// change (which only flips a card's .assigned ring) can be refreshed in place instead
// of flashing the whole grid.
function libraryContentSig() {
  const lib = (config && config.library) || {};
  const items = Object.keys(lib).sort().map((id) => {
    const it = lib[id] || {};
    return id + (it.favorite ? '*' : '') + (it.type === 'folder' ? 'F' : '');
  }).join(',');
  return `${items}|${(config && config.librarySort) || ''}`;
}

// Which items are assigned to a monitor — affects only the .assigned highlight.
function assignedSig() {
  return [...assignedIds()].sort().join(',');
}

// Cheap fingerprint of everything the Library grid renders from (content + assigned).
// Used to skip a wasteful full re-render on config broadcasts that don't touch the
// library (theme, schedule, viewer background, …) — those were flashing the whole grid.
function librarySignature() {
  return `${libraryContentSig()}|${assignedSig()}`;
}

// Full identity of what the Library grid currently shows (view + filter + folder +
// query + sort + content). When this is unchanged, a tab switch back to Library can
// reuse the existing DOM (and its loaded thumbnails) instead of rebuilding/flashing.
function libRenderKey() {
  return [LIB.filter, LIB.folderPath || '', LIB.q || '', LIB.sort || '', librarySignature()].join('');
}

function libAllTags() {
  const set = new Set();
  Object.values(config.library || {}).forEach((it) => (it.tags || []).forEach((tg) => set.add(tg)));
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function filterLibRailTags(tags, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return tags.slice();
  return tags.filter((tag) => String(tag).toLocaleLowerCase().includes(needle));
}

// Tag → number of pool items carrying it (popularity). Used by the assign-menu autocomplete.
function libTagCounts() {
  const counts = {};
  Object.values(config.library || {}).forEach((it) => (it.tags || []).forEach((tg) => { counts[tg] = (counts[tg] || 0) + 1; }));
  return counts;
}

// Сортировка массива на месте по LIB.sort (added/name/size/shuffle). `get` — аксессоры,
// чтобы одна логика работала и для элементов пула, и для записей плоского «Все» ({path,item,id}).
function sortItems(arr, get) {
  const g = {
    path: (x) => x.path,
    added: (x) => x.addedAt || 0,
    modified: (x) => x.modifiedAt || 0,
    size: (x) => x.size || 0,
    id: (x) => x.id,
    ...(get || {}),
  };
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const byName = (a, b) => baseName(g.path(a)).localeCompare(baseName(g.path(b)));
  if (LIB.sort === 'name') arr.sort((a, b) => baseName(g.path(a)).localeCompare(baseName(g.path(b))));
  else if (LIB.sort === 'size') arr.sort((a, b) => g.size(b) - g.size(a));
  else if (LIB.sort === 'shuffle') {
    arr.forEach((x) => { const id = g.id(x); if (LIB.shuffleRank[id] === undefined) LIB.shuffleRank[id] = Math.random(); });
    arr.sort((a, b) => LIB.shuffleRank[g.id(a)] - LIB.shuffleRank[g.id(b)]);
  } else {
    arr.sort((a, b) => number(g.added(b)) - number(g.added(a))
      || number(g.modified(b)) - number(g.modified(a))
      || byName(a, b));
  }
}

// Load any file sizes missing for a "Largest first" sort: pool items cache theirs in
// config (library-ensure-sizes), ephemeral folder files are statted on demand by main
// and cached in LIB.sizeCache so re-renders don't re-stat. Returns true if it actually
// loaded anything new (so the caller can re-render once). No-op for any other sort.
// `entries` are { path, item } records (item === null = ephemeral).
async function ensureSizesFor(entries) {
  if (LIB.sort !== 'size') return false;
  let loaded = false;
  const needPool = Object.values(config.library || {})
    .some((it) => it && it.type === 'image' && it.path && typeof it.size !== 'number');
  if (needPool) { try { config = await window.api.libraryEnsureSizes(); loaded = true; } catch {} }
  const missing = [];
  const seen = new Set();
  for (const en of entries) {
    if (!en || en.item) continue; // pool items already carry .size
    const key = normPathKey(en.path);
    if (!key || LIB.sizeCache.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(en.path);
  }
  if (missing.length) {
    try {
      const rows = await window.api.libraryPathSizes(missing);
      for (const row of (rows || [])) {
        if (row && row.path) LIB.sizeCache.set(normPathKey(row.path), Number(row.size) || 0);
      }
      loaded = true;
    } catch {}
  }
  return loaded;
}

// Size sort needs file sizes that may not be cached yet. Statting them up front froze
// the app on the first click (sync stat on main + the render awaiting thousands of
// stats). Instead the views render IMMEDIATELY with whatever sizes are cached, then
// this loads the missing ones in the background and re-renders ONCE so the order
// settles. The cache makes the follow-up render's ensureSizesFor a no-op, so it can't
// loop; the token guard drops the re-render if the user navigated away meanwhile.
function scheduleSizeReorder(entries, tok) {
  if (LIB.sort !== 'size') return;
  ensureSizesFor(entries).then((loaded) => {
    if (loaded && tok === allViewToken) renderLibrary();
  }).catch(() => {});
}

// Size accessor shared by folder/All views: pool item → its size, ephemeral → LIB.sizeCache.
// Pool size is re-read from the current config by id, because ensureSizesFor() may have
// refreshed config AFTER the entry captured its (now stale, size-less) item reference.
function entrySize(x) {
  if (!x) return 0;
  if (x.item) {
    const cur = config.library && config.library[x.item.id];
    return (cur && cur.size) || x.item.size || 0;
  }
  return LIB.sizeCache.get(normPathKey(x.path)) || 0;
}

function libList() {
  let items = Object.values(config.library || {});
  if (LIB.filter === 'favorite') items = items.filter((it) => it.favorite);
  else if (LIB.filter === 'folder') items = items.filter((it) => it.type === 'folder');
  else if (LIB.filter.startsWith('tag:')) {
    const tg = LIB.filter.slice(4);
    items = items.filter((it) => Array.isArray(it.tags) && it.tags.includes(tg));
  }
  const q = LIB.q.trim().toLowerCase();
  if (q) items = items.filter((it) => baseName(it.path).toLowerCase().includes(q));
  sortItems(items);
  return items;
}

function renderLibRailTags() {
  const box = $('#libTags');
  const section = $('#libTagSection');
  const empty = $('#libTagEmpty');
  const search = $('#libTagSearch');
  if (!box || !section || !empty) return;
  const tags = libAllTags();

  // Search only narrows the navigation list. The selected card filter is validated
  // against ALL tags so a zero-result query never silently switches the grid to All.
  if (LIB.filter.startsWith('tag:') && !tags.includes(LIB.filter.slice(4))) LIB.filter = 'all';
  section.hidden = tags.length === 0;
  if (!tags.length) {
    LIB.tagQuery = '';
    if (search) search.value = '';
  }

  const matches = filterLibRailTags(tags, LIB.tagQuery);
  box.innerHTML = '';
  matches.forEach((tg) => {
    const b = document.createElement('button');
    b.className = 'lib-railbtn';
    b.dataset.filter = `tag:${tg}`;
    const ic = document.createElement('span');
    ic.className = 'lib-rail-ic lib-rail-hash';
    ic.textContent = '#';
    const lbl = document.createElement('span');
    lbl.textContent = tg;
    b.append(ic, lbl);
    box.appendChild(b);
  });
  box.hidden = matches.length === 0;
  empty.hidden = matches.length !== 0;
  document.querySelectorAll('#viewLibrary .lib-railbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.filter === LIB.filter);
  });
}

// The duplicate title/count head above the grid was removed (the rail already names the
// section and the head ate vertical space). The item count now lives in the status bar as
// its idle text — shown whenever the pointer isn't hovering a card.
function setLibViewHeader(count = null) {
  libIdleStatus = (Number.isFinite(count) && count >= 0) ? t('library.itemsCount', { n: count }) : '';
  setLibStatus(''); // refresh the status bar back to the idle text
}

function renderLibrary() {
  // Budget span #8 (Library full render): thin wrapper measures the synchronous render
  // cost across every branch; lazy branches also emit per-chunk spans (#9).
  const end = diagSpan('renderer', 'library-render');
  try { return renderLibraryCore(); } finally { end({ label: LIB.filter || 'all' }); }
}

function renderLibraryCore() {
  // Record what we're about to render so a later tab switch can detect "nothing
  // changed" and skip a needless rebuild. Online does not consume a pending
  // local-folder refresh because the local grid has not been updated yet.
  if (LIB.filter !== 'online') deferredLiveRefresh.consume('library');
  lastLibRenderKey = libRenderKey();
  // Scroll back to the top ONLY when the view IDENTITY changes (new filter/folder/search/
  // sort) — NOT when content/assignment changes within the same view. Otherwise assigning
  // or favoriting an item in place would yank the window to the top (it changes the
  // signature inside libRenderKey, which is why we key the scroll on view identity only).
  const viewKey = [LIB.filter, LIB.folderPath || '', LIB.q || '', LIB.sort || ''].join('|');
  const viewChanged = viewKey !== lastLibViewKey;
  lastLibViewKey = viewKey;
  if (viewChanged && activePage === 'library') {
    const page = document.querySelector('.page');
    if (page) page.scrollTop = 0;
    pageScroll.library = 0;
    libraryViewAnchor = null;
    libraryResizeSession.cancel();
    libraryResizeActive = false;
  }
  renderLibRailTags();
  setLibViewHeader();
  const local = $('#libLocal');
  const online = $('#libOnline');
  const canAddLocalSources = !LIB.folderPath;
  const showAddPhotos = canAddLocalSources && LIB.filter === 'all';
  const showAddFolder = canAddLocalSources && (LIB.filter === 'all' || LIB.filter === 'folder');
  const addPhotos = $('#libAddPhotos');
  const addFolder = $('#libAddFolder');
  if (addPhotos) {
    addPhotos.hidden = !showAddPhotos;
    addPhotos.classList.toggle('suggested', showAddPhotos);
  }
  if (addFolder) {
    addFolder.hidden = !showAddFolder;
    addFolder.classList.toggle('suggested', LIB.filter === 'folder');
  }
  if (LIB.filter === 'online') {
    allViewToken += 1; // invalidate any pending local folder/All response
    resetLibObservers($('#libGrid'));
    if (local) local.hidden = true;
    if (online) online.hidden = false;
    exitFolderState(); // leaving the local view drops any folder navigation
    renderBreadcrumbs();
    renderOnline();
    return;
  }
  if (online) online.hidden = true;
  if (local) local.hidden = false;
  destroyUnifiedGrid($('#whGrid'));
  setGridGallerySource($('#whGrid'), []);
  ONLINE.generation += 1;
  ONLINE.renderEpoch += 1;
  ONLINE.entries = [];
  ONLINE.loading = false;
  ONLINE.loaded = false; // re-fetch fresh signed URLs next time Online opens
  renderBreadcrumbs();
  const tok = ++allViewToken; // invalidate any in-flight async render

  // Mark the grid itself, so the trash's rules hold for cards the virtual grid RECYCLES
  // from another view as well. Deciding at build time is not enough on its own: a card
  // built in "All" and reused here arrived with its star already attached.
  const gridEl = $('#libGrid');
  if (gridEl) gridEl.classList.toggle('removed-view', inRemovedView());

  if (LIB.folderPath) { renderFolderView(tok); return; }
  if (LIB.filter === 'all') { renderAllView(tok); return; }
  if (inRemovedView()) { renderRemovedView(tok); return; }

  // "Папки" / favorite / tag → plain pool-items grid (folders are entities here)
  const sentinel = $('#libSentinel'); if (sentinel) sentinel.hidden = true;
  const grid = $('#libGrid');
  if (!grid) return;
  const items = libList();
  const assigned = assignedIds();
  const empty = $('#libEmpty');
  if (empty) { empty.hidden = items.length > 0; if (!items.length) setLibEmptyText('library.empty'); }
  setLibViewHeader(items.length);
  renderEntriesLazily(grid, items, assigned, tok);
  // Favorites/Tags also sort by size: load pool sizes in the background and re-render
  // once (so a cold start with size sort, or any first size sort, isn't blocked).
  scheduleSizeReorder(items.map((it) => ({ item: it, path: it.path, id: it.id })), tok);
}

function buildLibCard(it, isAssigned) {
  const card = document.createElement('div');
  card.className = 'lib-card' + (it.type === 'folder' ? ' folder' : '') + (isAssigned ? ' assigned' : '');
  card.dataset.id = it.id;
  const selectionRecord = localSelectionRecord(it.path, it.type, it.id);
  makeLibCardFocusable(card);
  primeLibCardAspect(card, it, it.path);

  if (it.type === 'folder') {
    fillFolderCollage(card, it.path);
  } else {
    card.title = baseName(it.path);
    lazyThumb(card, it.path, 320, 200);
    card.__galleryItem = galleryItemFromLibrary(it);
  }

  // The star is always BUILT and hidden by CSS in the trash, never omitted. Omitting
  // it looked tidier but broke the other direction: the grid reuses cards between views,
  // so a card first built in the trash was reused in "All" with no star at all and no
  // code path that would add one back.
  const fav = document.createElement('button');
  fav.className = 'lib-fav' + (it.favorite ? ' on' : '');
  fav.textContent = it.favorite ? '★' : '☆';
  fav.title = t('library.favorite');
  fav.addEventListener('click', async (e) => {
    e.stopPropagation();
    await toggleFavoriteForRecord(selectionRecord, card);
  });
  card.appendChild(fav);
  setCardFavorite(card, !!it.favorite);

  if (isAssigned) {
    const mark = document.createElement('span');
    mark.className = 'lib-assigned';
    mark.title = t('library.assigned');
    card.appendChild(mark);
  }

  appendSelectionToggle(card, selectionRecord);
  bindLocalCardContextMenu(card, selectionRecord);

  card.addEventListener('mouseenter', () => setLibStatus(baseName(it.path)));
  card.addEventListener('mouseleave', () => setLibStatus(''));
  card.addEventListener('click', (e) => {
    if (handleSelectionModifierClick(e, selectionRecord)) return;
    if (it.type === 'folder') enterFolder(it.path, baseName(it.path));
    else if (card.__galleryItem) openGalleryFromCard(card, card.__galleryItem);
  });
  return card;
}

// Fill a .lib-card.folder with the 2×2 preview collage + name + count (count shows
// "N · ▸M" when the folder has M subfolders). Shared by pool folders and subfolders.
function fillFolderCollage(card, dirPath) {
  const collage = document.createElement('div');
  collage.className = 'lib-folder-collage';
  collage.innerHTML = '<svg class="lib-ic" viewBox="0 0 64 64" aria-hidden="true"><path class="lib-folder-back" d="M6 18c0-3 2.4-5.5 5.5-5.5h15l6 7H53c3 0 5.5 2.5 5.5 5.5v24c0 3-2.5 5.5-5.5 5.5H11.5C8.4 54.5 6 52 6 49z"/><path class="lib-folder-front" d="M6 25h52.5v24c0 3-2.5 5.5-5.5 5.5H11.5C8.4 54.5 6 52 6 49z"/></svg>';
  card.appendChild(collage);
  const cap = document.createElement('span');
  cap.className = 'lib-card-name';
  cap.textContent = baseName(dirPath);
  card.appendChild(cap);
  const cnt = document.createElement('span');
  cnt.className = 'lib-count';
  cnt.textContent = '0';
  card.appendChild(cnt);
  card.title = dirPath;
  const infoKey = normPathKey(dirPath);
  let infoPromise = folderInfoCache.get(infoKey);
  if (!infoPromise) {
    infoPromise = window.api.folderInfo(dirPath).catch(() => ({ count: 0, subfolders: 0, previews: [] }));
    folderInfoCache.set(infoKey, infoPromise);
  }
  infoPromise.then((info) => {
    const previews = (info && info.previews) || [];
    const sub = (info && info.subfolders) || 0;
    const n = (info && info.count) || 0;
    cnt.textContent = sub > 0 ? `${n} · +${sub}` : String(n);
    if (!previews.length) return;
    collage.innerHTML = '';
    previews.slice(0, 4).forEach((p) => {
      const tile = document.createElement('div');
      tile.className = 'ff';
      collage.appendChild(tile);
      window.api.thumb(p, 160, 160).then((u) => { if (u) tile.style.backgroundImage = `url("${u}")`; });
    });
  });
}

function invalidateFolderCards() {
  folderInfoCache.clear();
  folderCardEpoch += 1;
}

// ---------------------------------------------------------------------------
// Folder navigation (open a folder in place, drill into subfolders, breadcrumbs)
// ---------------------------------------------------------------------------
function exitFolderState() { LIB.folderPath = null; LIB.crumbs = []; }

function enterFolder(p, name) {
  clearSelection();
  syncSelectionUI();
  LIB.folderPath = p;
  LIB.crumbs.push({ path: p, name: name || baseName(p) });
  if (LIB.q) { LIB.q = ''; const s = $('#libSearch'); if (s) s.value = ''; }
  renderLibrary();
}
function crumbTo(i) {
  clearSelection();
  syncSelectionUI();
  LIB.crumbs = LIB.crumbs.slice(0, i + 1);
  LIB.folderPath = LIB.crumbs.length ? LIB.crumbs[LIB.crumbs.length - 1].path : null;
  renderLibrary();
}
function exitToFolders() {
  clearSelection();
  syncSelectionUI();
  exitFolderState();
  renderLibrary();
}

function navigateFolderBack() {
  if (!LIB.folderPath) return false;
  if (LIB.crumbs.length > 1) {
    LIB.crumbs = LIB.crumbs.slice(0, -1);
    LIB.folderPath = LIB.crumbs[LIB.crumbs.length - 1].path;
    renderLibrary();
  } else {
    exitToFolders();
  }
  return true;
}

// Render the breadcrumb bar (hidden unless inside a folder). Includes a "‹ all folders"
// back link and an "Assign this folder" action that materializes the current dir + assigns.
function renderBreadcrumbs() {
  const bar = $('#libCrumbs');
  if (!bar) return;
  // The trash is reached from the settings, not from the rail, so nothing in the rail
  // is highlighted while you are in it. Say where you are and offer the way out.
  if (inRemovedView()) {
    bar.hidden = false;
    bar.innerHTML = '';
    const back = document.createElement('button');
    back.className = 'lib-crumb lib-crumb-back';
    // Not library.back — that one says "All folders", which is where folder
    // navigation returns to. Leaving the trash returns to the library itself.
    back.textContent = t('library.all');
    back.addEventListener('click', () => { LIB.filter = 'all'; renderLibrary(); });
    bar.appendChild(back);
    const sep = document.createElement('span');
    sep.className = 'lib-crumb-sep';
    sep.textContent = '›';
    bar.appendChild(sep);
    const here = document.createElement('button');
    here.className = 'lib-crumb current';
    here.textContent = t('library.removedTitle');
    bar.appendChild(here);
    return;
  }
  if (!LIB.folderPath || !LIB.crumbs.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = '';
  const back = document.createElement('button');
  back.className = 'lib-crumb lib-crumb-back';
  back.textContent = t('library.back');
  back.addEventListener('click', exitToFolders);
  bar.appendChild(back);
  LIB.crumbs.forEach((c, i) => {
    const sep = document.createElement('span');
    sep.className = 'lib-crumb-sep';
    sep.textContent = '›';
    bar.appendChild(sep);
    const b = document.createElement('button');
    b.className = 'lib-crumb' + (i === LIB.crumbs.length - 1 ? ' current' : '');
    b.textContent = c.name;
    b.addEventListener('click', () => crumbTo(i));
    bar.appendChild(b);
  });
  const assignBtn = document.createElement('button');
  assignBtn.className = 'pill lib-assign-folder';
  assignBtn.textContent = t('library.assignThisFolder');
  assignBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Materialize the folder into the pool only once the user picks a slot in the menu.
    const record = localSelectionRecord(LIB.folderPath, 'folder');
    const current = poolItemForRecord(record);
    openAssignMenu(current, assignBtn, async () => {
      const res = await window.api.libraryMaterialize(record.path, 'folder');
      config = (res && res.config) || config;
      return res && res.id ? config.library[res.id] : null;
    }, { assignmentRecord: record, remove: !!current });
  });
  bar.appendChild(assignBtn);
}

// path → pool image item lookup (normalized like library.idFor, minus the hash), so a
// folder image that's already in the pool renders as the real card (favorite/assigned).
function normPathKey(p) {
  return window.ZnadaPathKey.pathKey(p);
}
function poolImageMap() {
  const map = new Map();
  for (const it of Object.values(config.library || {})) {
    if (it && it.type === 'image' && it.path) map.set(normPathKey(it.path), it);
  }
  return map;
}

// ---- lazy thumbnails: fetch a small preview only when the card scrolls into view ----
// Большие сетки «Все» иначе декодировали бы тысячи полноразмерных фото разом → зависания.
function libScrollRoot() {
  return document.querySelector('.page');
}
function activeLibraryGrid() {
  return LIB.filter === 'online' ? $('#whGrid') : $('#libGrid');
}
function libraryCardAnchorKey(card) {
  if (!card) return '';
  if (card.dataset.gridKey) return card.dataset.gridKey;
  if (card.__galleryItem && card.__galleryItem.key) return card.__galleryItem.key;
  if (card.dataset.id) return `id:${card.dataset.id}`;
  if (card.dataset.path) return `path:${normPathKey(card.dataset.path)}`;
  if (card.dataset.galleryIndex) return `index:${card.dataset.galleryIndex}`;
  return '';
}
function captureLibraryScrollAnchor(grid) {
  const root = libScrollRoot();
  if (!root || !grid || grid.offsetParent === null || root.scrollTop <= 0) return null;
  const rootRect = root.getBoundingClientRect();
  const cards = Array.from(grid.children).filter((card) => card.classList && card.classList.contains('lib-card'));
  if (!cards.length) return null;
  // Card tops are monotonic in DOM order. Find the first row intersecting the
  // viewport without forcing layout reads for every card in a large folder.
  let low = 0;
  let high = cards.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cards[middle].getBoundingClientRect().bottom <= rootRect.top) low = middle + 1;
    else high = middle;
  }
  const card = cards[low];
  if (!card) return null;
  const rect = card.getBoundingClientRect();
  if (rect.top >= rootRect.bottom) return null;
  return {
    root,
    card,
    key: libraryCardAnchorKey(card),
    top: rect.top - rootRect.top,
    combinedIndex: Number.isInteger(Number(card.dataset.virtualIndex))
      ? Number(card.dataset.virtualIndex)
      : null,
  };
}
function isMaterializedLibraryViewAnchor(anchor, grid) {
  if (!anchor || !anchor.root || !grid || anchor.root !== libScrollRoot()) return false;
  let card = anchor.card;
  const virtual = grid.__virtual;
  if (virtual && Number.isInteger(anchor.combinedIndex)) {
    card = virtual.cards.get(anchor.combinedIndex);
  }
  if (!card || !card.isConnected) return false;
  const rootRect = anchor.root.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  return cardRect.bottom > rootRect.top && cardRect.top < rootRect.bottom;
}
function restoreLibraryScrollAnchor(anchor, grid) {
  if (!anchor || !anchor.root || !grid || !grid.isConnected) return;
  const virtual = grid.__virtual;
  if (virtual && Number.isInteger(anchor.combinedIndex)
    && window.VirtualWindow && typeof window.VirtualWindow.scrollTopForCardAnchor === 'function') {
    const rootRect = anchor.root.getBoundingClientRect();
    const gridTop = grid.getBoundingClientRect().top - rootRect.top + anchor.root.scrollTop;
    const target = window.VirtualWindow.scrollTopForCardAnchor(
      virtual.rows,
      anchor.combinedIndex,
      gridTop,
      anchor.top
    );
    if (Number.isFinite(target)) {
      anchor.root.scrollTop = target;
      pageScroll.library = anchor.root.scrollTop;
      // relayout initially materializes around the old scroll position. Refresh once
      // more around the restored logical anchor so a resize cannot leave a blank grid.
      if (typeof virtual.updateWindow === 'function') virtual.updateWindow(true);
      return;
    }
  }
  let card = anchor.card;
  if (!card || !card.isConnected) {
    card = Array.from(grid.children).find((candidate) => libraryCardAnchorKey(candidate) === anchor.key);
  }
  if (!card) return;
  const rootRect = anchor.root.getBoundingClientRect();
  const nextTop = card.getBoundingClientRect().top - rootRect.top;
  const delta = nextTop - anchor.top;
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.5) return;
  anchor.root.scrollTop += delta;
  pageScroll.library = anchor.root.scrollTop;
}
function currentLibraryResizeAnchor() {
  return libraryResizeSession.current();
}
function beginLibraryResizeAnchor(grid) {
  if (!grid || !grid.isConnected || grid.offsetParent === null) {
    libraryResizeSession.cancel();
    libraryResizeActive = false;
    return null;
  }
  libraryResizeActive = true;
  libraryResizeLastChangeAt = Date.now();
  // A fast scroll can move the virtual window before the deferred remembered
  // anchor refresh runs. Never turn that stale, off-screen index into a resize
  // session: joining it to the current cards would recreate a huge DOM bridge.
  const activeAnchor = currentLibraryResizeAnchor();
  const candidate = activeAnchor || (isMaterializedLibraryViewAnchor(libraryViewAnchor, grid)
    ? libraryViewAnchor
    : captureLibraryScrollAnchor(grid));
  const snapshot = libraryResizeSession.begin(candidate);
  return snapshot.anchor;
}
function touchLibraryResizeAnchor() {
  if (libraryResizeActive) libraryResizeLastChangeAt = Date.now();
  const snapshot = libraryResizeSession.touch();
  return snapshot.anchor;
}
function scheduleLibraryResizeFinish(grid) {
  if (libraryResizeFinishTimer) clearTimeout(libraryResizeFinishTimer);
  if (!libraryResizeActive && !currentLibraryResizeAnchor()) return;
  const quietFor = Date.now() - libraryResizeLastChangeAt;
  const wait = Math.max(0, LIB_RESIZE_SETTLE_MS - quietFor);
  libraryResizeFinishTimer = setTimeout(() => {
    libraryResizeFinishTimer = 0;
    const pending = libraryResizeSession.snapshot();
    const pendingChangeAt = libraryResizeLastChangeAt;
    requestAnimationFrame(() => {
      const latest = libraryResizeSession.snapshot();
      if (libraryResizeLastChangeAt !== pendingChangeAt
        || latest.anchor !== pending.anchor || latest.revision !== pending.revision) {
        scheduleLibraryResizeFinish(grid);
        return;
      }
      if (!grid || !grid.isConnected || grid.offsetParent === null) {
        libraryResizeSession.cancel();
        libraryResizeActive = false;
        return;
      }
      const virtual = grid.__virtual;
      if (virtual && Math.abs(grid.clientWidth - virtual.layoutWidth) >= 0.5) {
        touchLibraryResizeAnchor();
        layoutLibGrid(grid, pending.anchor);
        scheduleLibraryResizeFinish(grid);
        return;
      }
      // One final correction after the actual grid width (including scrollbar
      // changes) is stable. Keep the ORIGINAL logical card authoritative: a wider
      // row may prepend neighbours, and recapturing its first card here would make
      // the original anchor drop by one row on the next restore/maximize burst.
      if (pending.anchor) restoreLibraryScrollAnchor(pending.anchor, grid);
      if (pending.anchor && libraryResizeSession.finish(pending.revision)) {
        libraryViewAnchor = pending.anchor;
      }
      libraryResizeActive = false;
      // The live resize window is an expanding union so no loaded card blinks.
      // Once geometry is stable, prune only the off-screen overscan boundary.
      if (virtual && typeof virtual.updateWindow === 'function') virtual.updateWindow(true);
    });
  }, wait);
}
function cancelLibraryResizeAnchorForUserInput() {
  if (!libraryResizeActive && !currentLibraryResizeAnchor()) return;
  libraryResizeSession.cancel();
  libraryResizeActive = false;
  if (libraryResizeFinishTimer) {
    clearTimeout(libraryResizeFinishTimer);
    libraryResizeFinishTimer = 0;
  }
  const grid = activeLibraryGrid();
  libraryViewAnchor = captureLibraryScrollAnchor(grid);
  const virtual = grid && grid.__virtual;
  if (virtual && typeof virtual.updateWindow === 'function') virtual.updateWindow(true);
}
function rememberLibraryScrollAnchor(grid) {
  if (libraryAnchorFrame || libraryResizeActive || currentLibraryResizeAnchor()) return;
  libraryAnchorFrame = requestAnimationFrame(() => {
    libraryAnchorFrame = 0;
    if (!libraryResizeActive && !currentLibraryResizeAnchor()) libraryViewAnchor = captureLibraryScrollAnchor(grid);
  });
}
function destroyUnifiedGrid(grid) {
  if (!grid) return;
  const virtual = grid.__virtual;
  if (virtual && typeof virtual.destroy === 'function') virtual.destroy();
  else {
    grid.__virtual = null;
    grid.classList.remove('is-virtualized');
    grid.innerHTML = '';
  }
  delete grid.__gridContext;
}
function resetLibObservers(grid = $('#libGrid')) {
  if (thumbIO) { thumbIO.disconnect(); thumbIO = null; }
  if (libraryAnchorFrame) { cancelAnimationFrame(libraryAnchorFrame); libraryAnchorFrame = 0; }
  destroyUnifiedGrid(grid);
  libraryViewAnchor = null;
  libraryResizeSession.cancel();
  libraryResizeActive = false;
  if (libraryResizeFinishTimer) { clearTimeout(libraryResizeFinishTimer); libraryResizeFinishTimer = 0; }
  libLazyKick = null;
}
// Small renderer-side LRU of thumbnail data-URLs. The virtualized grid DESTROYS cards
// that scroll far away; when the user scrolls back, the rebuilt card takes its
// background from here synchronously instead of flashing empty for an IPC round-trip.
// ~300 entries × ~30KB ≈ 10MB — bounded, unlike the unbounded DOM it replaces.
const LIB_THUMB_URL_CACHE_MAX = 320;
const thumbUrlCache = new Map(); // pathKey → { url, width, height }
function cachedThumbUrl(key) {
  const hit = thumbUrlCache.get(key);
  if (hit) { thumbUrlCache.delete(key); thumbUrlCache.set(key, hit); } // LRU bump
  return hit;
}
function rememberThumbUrl(key, info) {
  thumbUrlCache.set(key, info);
  if (thumbUrlCache.size > LIB_THUMB_URL_CACHE_MAX) {
    thumbUrlCache.delete(thumbUrlCache.keys().next().value);
  }
}
function applyThumbInfo(card, p, info) {
  card.dataset.thumbLoaded = 'true';
  card.classList.remove('missing');
  card.style.backgroundImage = `url("${info.url}")`;
  if (info.width > 0 && info.height > 0) {
    const aspect = info.width / info.height;
    LIB.aspectCache.set(normPathKey(p), aspect);
    // A file can be replaced in-place after its aspect was persisted. Matching
    // metadata is a no-op; genuinely changed geometry is corrected once and then
    // main's thumbnail backfill persists the new value for subsequent renders.
    const current = Number(card.dataset.aspect);
    if (card.dataset.aspectKnown !== 'true' || !Number.isFinite(current)
      || Math.abs(current - window.JustifiedLayout.normalizeAspect(aspect, 0.65, 3)) >= 0.005) {
      setLibCardAspect(card, aspect, { deferred: true });
    }
    card.dataset.aspectKnown = 'true';
  }
}
function loadThumbInto(card) {
  if (!card || card.dataset.thumbLoading === 'true' || card.dataset.thumbLoaded === 'true') return;
  const p = card.dataset.thumbPath;
  if (!p) return;
  const cached = cachedThumbUrl(normPathKey(p));
  if (cached && cached.url) { applyThumbInfo(card, p, cached); return; }
  card.dataset.thumbLoading = 'true';
  const w = +card.dataset.thumbW || 320;
  const h = +card.dataset.thumbH || 200;
  const request = window.api.thumbInfo
    ? window.api.thumbInfo(p, w, h, Number(card.dataset.thumbPriority) || 0)
    : window.api.thumb(p, w, h).then((url) => ({ url, width: 0, height: 0 }));
  request.then((info) => {
    const u = info && info.url;
    if (!u) { card.classList.add('missing'); return; }
    rememberThumbUrl(normPathKey(p), { url: u, width: info.width || 0, height: info.height || 0 });
    applyThumbInfo(card, p, info);
  }).finally(() => { delete card.dataset.thumbLoading; });
}
function lazyThumb(card, p, w, h) {
  card.dataset.thumbPath = p;
  if (w) card.dataset.thumbW = w;
  if (h) card.dataset.thumbH = h;
  // Cache hit → paint synchronously (a rematerialized card must not blink).
  if (thumbUrlCache.has(normPathKey(p))) { loadThumbInto(card); return; }
  if ('IntersectionObserver' in window) {
    if (!thumbIO) {
      thumbIO = new IntersectionObserver((ents) => {
        for (const en of ents) {
          if (en.isIntersecting) { thumbIO.unobserve(en.target); loadThumbInto(en.target); }
        }
      }, { root: libScrollRoot(), rootMargin: LIB_THUMB_PRELOAD_MARGIN });
    }
    thumbIO.observe(card);
  } else {
    loadThumbInto(card); // no observer support → load immediately
  }
}

// Inside-a-folder view: subfolders first (drill in), then images (one level).
async function renderFolderView(tok) {
  const grid = $('#libGrid');
  const empty = $('#libEmpty');
  if (!grid) return;
  const dir = LIB.folderPath;
  let res;
  try { res = await window.api.folderEntries(dir); } catch { res = null; }
  if (tok !== allViewToken) return; // navigated away while awaiting
  const folders = (res && res.folders) || [];
  let images = (res && res.images) || []; // [{ path, addedAt, modifiedAt, aspect }]
  const q = LIB.q.trim().toLowerCase();
  if (q) images = images.filter((im) => baseName(im.path).toLowerCase().includes(q));
  // Same entry shape, sorting and chunked rendering as "All": a folder image already
  // in the pool shows its real card, otherwise an ephemeral one. This applies the
  // chosen sort (newest first / name / size / shuffle) and renders big folders in
  // lazy chunks with batched aspect prefetch (the old code built every card at once).
  const pmap = poolImageMap();
  const entries = images.map((im) => {
    const item = pmap.get(normPathKey(im.path));
    return item
      ? { path: im.path, item, id: item.id, aspect: im.aspect }
      : {
        path: im.path,
        item: null,
        id: im.path,
        addedAt: im.addedAt,
        modifiedAt: im.modifiedAt,
        aspect: im.aspect,
      };
  });
  sortItems(entries, {
    added: (x) => (x.item ? x.item.addedAt : x.addedAt),
    modified: (x) => (x.item ? x.item.modifiedAt : x.modifiedAt),
    size: entrySize,
  });
  const total = folders.length + entries.length;
  setLibViewHeader(total);
  if (empty) { empty.hidden = total > 0; if (!total) setLibEmptyText('library.emptyFolder'); }
  const folderEntries = folders.map((folder) => ({ kind: 'subfolder', folder, path: folder.path }));
  renderEntriesLazily(grid, folderEntries.concat(entries), assignedIds(), tok);
  scheduleSizeReorder(entries, tok); // size sort: load missing sizes in bg, re-render once
}

// A subfolder card (not a pool item): click drills in; actions materialize only on commit.
function buildSubfolderCard(f) {
  const card = document.createElement('div');
  card.className = 'lib-card folder';
  card.dataset.path = f.path;
  const selectionRecord = localSelectionRecord(f.path, 'folder');
  makeLibCardFocusable(card);
  setLibCardAspect(card, 1.6);
  fillFolderCollage(card, f.path);
  appendSelectionToggle(card, selectionRecord);
  bindLocalCardContextMenu(card, selectionRecord);
  card.addEventListener('mouseenter', () => setLibStatus(f.path));
  card.addEventListener('mouseleave', () => setLibStatus(''));
  card.addEventListener('click', (e) => {
    if (handleSelectionModifierClick(e, selectionRecord)) return;
    enterFolder(f.path, f.name);
  });
  return card;
}

// Image living inside a folder, not yet in the pool. Preview can open it directly;
// actions that mutate library state first materialize it by reference (no copy).
function buildEphemeralImageCard(p, aspect = 0) {
  const card = document.createElement('div');
  card.className = 'lib-card';
  card.title = baseName(p);
  card.dataset.path = p; // lets onConfig upgrade this exact card in place once it's materialized
  const selectionRecord = localSelectionRecord(p, 'image');
  makeLibCardFocusable(card);
  primeLibCardAspect(card, null, p, aspect);
  lazyThumb(card, p, 320, 200);
  card.__galleryItem = galleryItemFromPath(p);

  // Always built, hidden by CSS in the trash — see buildLibCard.
  const fav = document.createElement('button');
  fav.className = 'lib-fav';
  fav.textContent = '☆';
  fav.title = t('library.favorite');
  fav.addEventListener('click', async (e) => {
    e.stopPropagation();
    await toggleFavoriteForRecord(selectionRecord, card);
  });
  card.appendChild(fav);
  setCardFavorite(card, false);

  appendSelectionToggle(card, selectionRecord);
  bindLocalCardContextMenu(card, selectionRecord);

  card.addEventListener('mouseenter', () => setLibStatus(baseName(p)));
  card.addEventListener('mouseleave', () => setLibStatus(''));
  card.addEventListener('click', (e) => {
    if (handleSelectionModifierClick(e, selectionRecord)) return;
    openGalleryFromCard(card, card.__galleryItem);
  });
  return card;
}

// Flat "All" view: pool images + recursively-expanded folder images, deduped, lazily
// rendered in chunks (folders can hold thousands of files).
async function renderAllView(tok) {
  const grid = $('#libGrid');
  const empty = $('#libEmpty');
  if (!grid) return;
  const poolImgs = Object.values(config.library || {}).filter((it) => it.type === 'image' && it.path);
  let folderImgs = [];
  try { const res = await window.api.expandFolders(); folderImgs = (res && res.images) || []; }
  catch { folderImgs = []; }
  if (tok !== allViewToken || LIB.folderPath || LIB.filter !== 'all') return; // stale
  // entries: pool items (with metadata) + ephemeral folder images (no overlap — expand
  // excludes anything already in the pool by content id)
  let entries = poolImgs.map((it) => ({ path: it.path, item: it, id: it.id }))
    .concat(folderImgs.map((fi) => ({
      path: fi.path,
      item: null,
      id: fi.id,
      addedAt: fi.addedAt,
      modifiedAt: fi.modifiedAt,
      aspect: fi.aspect,
    })));
  const q = LIB.q.trim().toLowerCase();
  if (q) entries = entries.filter((en) => baseName(en.path).toLowerCase().includes(q));
  sortItems(entries, {
    path: (x) => x.path,
    added: (x) => x.item ? x.item.addedAt : x.addedAt,
    modified: (x) => x.item ? x.item.modifiedAt : x.modifiedAt,
    size: entrySize,
    id: (x) => x.id,
  });
  if (empty) { empty.hidden = entries.length > 0; if (!entries.length) setLibEmptyText('library.empty'); }
  setLibViewHeader(entries.length);
  renderEntriesLazily(grid, entries, assignedIds(), tok);
  scheduleSizeReorder(entries, tok); // size sort: load missing sizes in bg, re-render once
}

// The "removed" view: everything the user took out of the library, whatever its origin.
// Being able to get it back is what makes removal safe to offer on every card.
//
// A photo still sitting in a watched folder costs nothing to restore. One whose only
// copy was Znada's own — imported, or downloaded from Online — is listed here too, and
// needs it the most: its record is kept whole, and that record is also what holds the
// wallpaper collector off the file.
async function renderRemovedView(tok) {
  const grid = $('#libGrid');
  const empty = $('#libEmpty');
  if (!grid) return;
  let images = [];
  try { const res = await window.api.libraryHiddenList(); images = (res && res.images) || []; }
  catch { images = []; }
  if (tok !== allViewToken || LIB.filter !== 'removed') return; // stale
  let entries = images.map((im) => ({
    path: im.path, item: null, id: im.path,
    addedAt: im.addedAt, modifiedAt: im.modifiedAt, aspect: im.aspect,
    // Carry the kind through: a removed FOLDER rendered as an image gave a broken
    // thumbnail and a "delete from disk" action that main correctly refused.
    kind: im.type === 'folder' ? 'subfolder' : undefined,
    folder: im.type === 'folder' ? { path: im.path, name: baseName(im.path) } : undefined,
  }));
  const q = LIB.q.trim().toLowerCase();
  if (q) entries = entries.filter((en) => baseName(en.path).toLowerCase().includes(q));
  sortItems(entries, {
    path: (x) => x.path,
    added: (x) => x.addedAt,
    modified: (x) => x.modifiedAt,
    size: entrySize,
    id: (x) => x.id,
  });
  if (empty) { empty.hidden = entries.length > 0; if (!entries.length) setLibEmptyText('library.removedEmpty'); }
  setLibViewHeader(entries.length);
  renderEntriesLazily(grid, entries, assignedIds(), tok);
}

// The only action that touches the user's files. Main asks for confirmation in a
// native dialog and moves them to the Windows Recycle Bin — nothing is destroyed
// outright — so the renderer only reports what came back.
async function deleteForever(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  let res;
  try { res = await window.api.libraryDeleteForever(list); }
  catch { res = null; }
  if (!res || res.error) { if (res && res.error !== 'bad_request') toast(t('library.deleteForeverFailed')); return; }
  if (res.cancelled) return;
  config = res.config || config;
  clearSelection();
  syncSelectionUI();
  renderLibrary();
  renderHome();
  if (res.failed) toast(t('library.deleteForeverFailed'));
  else toast(t('library.deleteForeverDone', { n: res.deleted }));
}

async function restorePaths(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  let res;
  try { res = await window.api.libraryRestore(list); }
  catch { res = null; }
  if (!res) { toast(t('library.undoFailed')); return; }
  config = res.config || config;
  clearSelection();
  syncSelectionUI();
  renderLibrary();
  renderHome();
  toast(t('library.restoredToast', { n: res.restored }));
}

function scheduleDeferredJustifiedLayout(grid) {
  if (grid) justifiedPending.add(grid);
  if (aspectLayoutTimer) clearTimeout(aspectLayoutTimer);
  const flush = () => {
    const scrollQuietFor = Date.now() - lastLibraryScrollAt;
    if (scrollQuietFor < 320) {
      aspectLayoutTimer = setTimeout(flush, 320 - scrollQuietFor);
      return;
    }
    aspectLayoutTimer = 0;
    if (!justifiedPending.size) return;
    scheduleJustifiedLayout();
  };
  aspectLayoutTimer = setTimeout(flush, 240);
}

function poolRecordMap() {
  const map = new Map();
  for (const item of Object.values((config && config.library) || {})) {
    if (!item || !item.path) continue;
    map.set(window.CardInteraction.localKey(item.path, item.type), item);
  }
  LIB.poolBySelectionKey = map;
  return map;
}

function localGridDescriptor(entry, pooledByPath = null) {
  if (entry && entry.kind === 'subfolder') {
    const folder = entry.folder || entry.raw || entry;
    const key = window.CardInteraction.localKey(folder.path, 'folder');
    // A directory can be both a child of the currently opened live folder and an
    // existing pool source. Preserve that pool identity so remove/bulk actions do
    // not incorrectly treat it as transient merely because this view called it a
    // subfolder.
    const pooled = pooledByPath ? pooledByPath.get(key) : poolItemForRecord(localSelectionRecord(folder.path, 'folder'));
    return {
      key,
      kind: pooled ? 'pool-folder' : 'subfolder',
      path: folder.path,
      folder,
      item: pooled || null,
      id: pooled ? pooled.id : folder.path,
      aspect: 1.6,
      galleryItem: null,
      selectableId: pooled ? pooled.id : null,
      selectionKey: key,
    };
  }
  const item = entry && entry.type ? entry : entry && entry.item;
  const path = (entry && entry.path) || (item && item.path) || '';
  const isFolder = !!(item && item.type === 'folder');
  const key = window.CardInteraction.localKey(path, isFolder ? 'folder' : 'image');
  return {
    key,
    kind: isFolder ? 'pool-folder' : (item ? 'pool-image' : 'ephemeral-image'),
    path,
    item: item || null,
    id: (item && item.id) || (entry && entry.id) || path,
    aspect: isFolder ? 1.6 : (knownLibAspect(item, path, entry && entry.aspect) || 1.6),
    galleryItem: isFolder ? null : (item ? galleryItemFromLibrary(item) : galleryItemFromPath(path)),
    selectableId: item && item.id ? item.id : null,
    selectionKey: key,
    raw: entry,
  };
}

function localGridVersion(entry) {
  if (entry && (entry.kind === 'subfolder' || entry.kind === 'pool-folder')) {
    return `${entry.kind}:${folderCardEpoch}`;
  }
  return entry && entry.kind;
}

function withUnifiedGalleryIndexes(entries) {
  let galleryIndex = 0;
  return (entries || []).map((entry) => ({
    ...entry,
    galleryIndex: entry && entry.galleryItem ? galleryIndex++ : -1,
  }));
}

function bindUnifiedGalleryCard(card, entry) {
  if (!card) return;
  if (entry && entry.galleryItem) {
    bindCardGalleryItem(card, entry.galleryItem, entry.galleryIndex);
  } else {
    delete card.__galleryItem;
    delete card.dataset.galleryIndex;
  }
}

function buildLocalGridCard(entry, grid) {
  if (entry.kind === 'subfolder') return buildSubfolderCard(entry.folder);
  const original = entry.item;
  const fresh = original && config.library && config.library[original.id]
    ? config.library[original.id] : original;
  const assigned = grid.__gridContext && grid.__gridContext.assigned;
  const card = fresh
    ? buildLibCard(fresh, !!(assigned && assigned.has(fresh.id)))
    : buildEphemeralImageCard(entry.path, entry.aspect);
  if (fresh && knownLibAspect(fresh, entry.path) <= 0 && Number(entry.aspect) > 0) {
    card.dataset.aspectKnown = 'true';
    setLibCardAspect(card, entry.aspect);
  }
  const record = selectionRecordFromEntry(entry, fresh);
  bindSelectionCard(card, record);
  return card;
}

function bindLocalGridCard(card, entry, grid) {
  bindUnifiedGalleryCard(card, entry);
  const original = entry && entry.item;
  const fresh = original && config.library && config.library[original.id]
    ? config.library[original.id] : original;
  const record = selectionRecordFromEntry(entry, fresh);
  bindSelectionCard(card, record);
  if (!fresh || !fresh.id) return;
  card.dataset.id = fresh.id;
  const assigned = grid.__gridContext && grid.__gridContext.assigned;
  setCardAssigned(card, !!(assigned && assigned.has(fresh.id)));
  setCardFavorite(card, !!fresh.favorite);
}

function mountUnifiedGrid(grid, entries, adapter, opts = {}) {
  if (!grid || !window.UnifiedGrid) return null;
  const prepared = withUnifiedGalleryIndexes(entries);
  setGridGallerySource(grid, prepared.map((entry) => entry.galleryItem).filter(Boolean));

  let virtual = grid.__virtual;
  if (virtual && (typeof virtual.destroy !== 'function' || virtual.adapterKind !== adapter.kind)) {
    destroyUnifiedGrid(grid);
    virtual = null;
  }
  // destroyUnifiedGrid deliberately drops controller-owned context. Reattach the
  // new adapter context afterwards so a future adapter switch on one DOM grid is safe.
  grid.__gridContext = { assigned: opts.assigned || new Set() };
  if (!virtual) {
    virtual = window.UnifiedGrid.create({
      grid,
      scrollRoot: libScrollRoot(),
      entries: prepared,
      overscanPx: LIB_VIRTUAL_OVERSCAN_PX,
      getKey: (entry) => entry.key,
      getVersion: (entry, index) => (typeof adapter.getVersion === 'function'
        ? adapter.getVersion(entry, index) : entry.kind),
      getAspect: (entry) => entry.aspect,
      buildCard: (entry, index) => adapter.buildCard(entry, index, grid),
      bindCard: (card, entry, index) => adapter.bindCard(card, entry, index, grid),
      dropCard: (card) => { if (thumbIO) thumbIO.unobserve(card); },
      nextPriority: () => ++thumbRequestPriority,
      captureAnchor: captureLibraryScrollAnchor,
      keepMaterialized: () => libraryResizeActive,
      onScrollTop: (top) => { pageScroll.library = top; },
      onScroll: () => {
        lastLibraryScrollAt = Date.now();
        rememberLibraryScrollAnchor(grid);
      },
      onUserInput: cancelLibraryResizeAnchorForUserInput,
      onWidthChange: () => {
        if (libraryResizeActive) touchLibraryResizeAnchor();
        layoutLibGrid(grid);
        if (libraryResizeActive) scheduleLibraryResizeFinish(grid);
        else rememberLibraryScrollAnchor(grid);
      },
      onWindow: (metrics) => {
        const end = diagSpan('renderer', 'lazy-chunk');
        end({ count: metrics.added, active: metrics.active, dropped: metrics.dropped,
          inserted: metrics.inserted, moved: metrics.moved, removed: metrics.removed });
      },
    });
    virtual.adapterKind = adapter.kind;
  } else {
    virtual.replace(prepared, { preserveAnchor: opts.preserveAnchor !== false });
  }
  virtual.assigned = grid.__gridContext.assigned;
  const kick = () => virtual.updateWindow(true);
  libLazyKick = kick;
  rememberLibraryScrollAnchor(grid);
  return virtual;
}

const LOCAL_GRID_ADAPTER = {
  kind: 'local',
  getVersion: (entry) => localGridVersion(entry),
  buildCard: (entry, index, grid) => buildLocalGridCard(entry, grid),
  bindCard: (card, entry, index, grid) => bindLocalGridCard(card, entry, grid),
};

function renderEntriesLazily(grid, entries, assigned) {
  const sentinel = $('#libSentinel');
  if (sentinel) sentinel.hidden = true;
  // Resolve pool-backed subfolders in one O(library + entries) pass. Looking up
  // every subfolder with a fresh Object.values(...).find() made large folder views
  // do quadratic work before virtualization even had a chance to mount a window.
  const pooledByPath = poolRecordMap();
  const descriptors = (entries || []).map((entry) => localGridDescriptor(entry, pooledByPath));
  reconcileSelectionRecords(descriptors.map((entry) => selectionRecordFromEntry(entry)).filter(Boolean));
  return mountUnifiedGrid(grid, descriptors, LOCAL_GRID_ADAPTER, { assigned, preserveAnchor: true });
}

// Faint Explorer-style status line: shows the hovered item's name at the bottom.
// Idle status-bar text (the Library item count). Hovering a card overrides it with the
// file name; leaving the card (empty text) restores this.
let libIdleStatus = '';
function setLibStatus(text) {
  const el = $('#libStatus');
  if (el) el.textContent = text || libIdleStatus || '';
}

// Stable local descriptors in display order for Shift-range selection. Most cards may
// be outside the DOM, so virtual entries — not mounted nodes — are the source of truth.
function orderedSelectionRecords() {
  const grid = $('#libGrid');
  const virtual = grid && grid.__virtual;
  if (virtual) {
    return virtual.entries.map((entry) => selectionRecordFromEntry(entry)).filter(Boolean);
  }
  return Array.from(document.querySelectorAll('#libGrid .lib-card[data-selection-key]'))
    .map((card) => card.__selectionRecord).filter(Boolean);
}

function makeLibCardFocusable(card) {
  card.tabIndex = 0;
  card.addEventListener('keydown', (e) => {
    if (e.target !== card || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    card.click();
  });
}

// ---- Gallery viewer helpers ----
function gallerySubtitle(parts) {
  return parts.filter(Boolean).join(' - ');
}

function setGridGallerySource(grid, items) {
  if (!grid) return;
  const list = (items || []).filter(Boolean);
  grid.__galleryItems = list;
  grid.__galleryIndexByKey = new Map();
  list.forEach((item, index) => {
    if (item && item.key && !grid.__galleryIndexByKey.has(item.key)) {
      grid.__galleryIndexByKey.set(item.key, index);
    }
  });
}

function bindCardGalleryItem(card, item, index) {
  if (!card || !item) return;
  card.__galleryItem = item;
  if (Number.isFinite(index) && index >= 0) card.dataset.galleryIndex = String(index);
  else delete card.dataset.galleryIndex;
}


function galleryPayloadWindow(items, index) {
  const list = (items || []).filter(Boolean);
  if (list.length <= GALLERY_MAX_PAYLOAD_ITEMS) return { items: list, index };
  const safeIndex = Math.max(0, Math.min(list.length - 1, Number.isFinite(index) ? Math.floor(index) : 0));
  const half = Math.floor(GALLERY_MAX_PAYLOAD_ITEMS / 2);
  const start = Math.max(0, Math.min(safeIndex - half, list.length - GALLERY_MAX_PAYLOAD_ITEMS));
  return {
    items: list.slice(start, start + GALLERY_MAX_PAYLOAD_ITEMS),
    index: safeIndex - start,
  };
}

function galleryItemFromLibrary(it) {
  return {
    kind: 'library',
    key: `library:${it.id}`,
    title: baseName(it.path),
    subtitle: t('viewer.local'),
    path: it.path,
    raw: it,
  };
}

function galleryItemFromPath(p) {
  return {
    kind: 'path',
    key: `path:${normPathKey(p)}`,
    title: baseName(p),
    subtitle: t('viewer.localFolder'),
    path: p,
    raw: { path: p },
  };
}

// Search cards arrive in the shared provider shape (`thumb`/`purity`), while the
// account-favorites endpoint still returns the Cloud API shape (`thumb_url`/`rating`).
// Keep the compatibility at this one renderer boundary instead of making either feed
// pretend it speaks the other's contract.
function cloudThumbUrl(item) {
  return String((item && (item.thumb || item.thumb_url)) || '');
}

function cloudRating(item) {
  const direct = String((item && item.rating) || '').trim().toLowerCase();
  if (['general', 'suggestive', 'explicit'].includes(direct)) return direct;
  const purity = String((item && item.purity) || '').trim().toLowerCase();
  return ({ sfw: 'general', sketchy: 'suggestive', nsfw: 'explicit' })[purity] || '';
}

function galleryItemFromCloud(item) {
  const resolution = item.width && item.height ? `${item.width}x${item.height}` : '';
  const rating = cloudRating(item);
  return {
    kind: 'cloud',
    key: `cloud:${item.id}`,
    title: item.title || t('online.sourceLumina'),
    subtitle: gallerySubtitle([t('online.sourceLumina'), resolution, rating && t(`online.rating${rating[0].toUpperCase()}${rating.slice(1)}`)]),
    previewUrl: cloudThumbUrl(item),
    raw: item,
  };
}

function galleryItemFromInternet(item) {
  return {
    kind: 'internet',
    key: `internet:${item.provider || 'source'}:${item.id || item.page || item.full || item.thumb}`,
    title: item.resolution || item.id || t('online.source'),
    subtitle: gallerySubtitle([t('online.source'), item.category, item.purity]),
    previewUrl: item.thumb || '',
    raw: item,
    query: INTERNET.q,
  };
}

function openGalleryFromCard(card, fallbackItem) {
  const grid = card && card.closest('.lib-grid');
  const fallback = fallbackItem || (card && card.__galleryItem);
  const source = grid && Array.isArray(grid.__galleryItems) ? grid.__galleryItems : [];
  if (source.length) {
    const explicitIndex = Number(card && card.dataset.galleryIndex);
    let index = Number.isInteger(explicitIndex) && explicitIndex >= 0 && explicitIndex < source.length
      ? explicitIndex
      : -1;
    if (index < 0 && fallback && fallback.key && grid.__galleryIndexByKey) {
      const keyed = grid.__galleryIndexByKey.get(fallback.key);
      if (Number.isInteger(keyed)) index = keyed;
    }
    if (index >= 0) {
      openGalleryViewer(source, index);
      return;
    }
  }
  const cards = grid
    ? Array.from(grid.querySelectorAll('.lib-card')).filter((c) => c.__galleryItem)
    : [card].filter(Boolean);
  const items = cards.map((c) => c.__galleryItem).filter(Boolean);
  const domIndex = Math.max(0, cards.indexOf(card));
  openGalleryViewer(items.length ? items : [fallback].filter(Boolean), domIndex);
}

function openGalleryViewer(items, index = 0) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return;
  closeLibPopup();
  hideOnlineTagSuggest();
  const payloadItems = list.map((entry) => {
    const pooled = galleryPoolRecord(entry);
    return {
      ...entry,
      added: entry.added || !!pooled,
      // Which library record this online photo already has, if any. The viewer window
      // has no pool of its own, so without this it could only ever add (ONL-008).
      pooled: pooled ? { id: pooled.id || '', path: pooled.path || '', type: pooled.type || 'image' } : null,
    };
  });
  const payload = galleryPayloadWindow(payloadItems, index);
  window.api.openGalleryViewer({
    items: payload.items,
    index: Math.max(0, Math.min(payload.items.length - 1, payload.index || 0)),
  }).catch(() => toast(t('viewer.loadError')));
}

function galleryPoolRecord(entry) {
  if (!entry || !entry.raw) return null;
  if (entry.kind === 'cloud' || entry.kind === 'internet') {
    return OnlineAdd.pooledItem((config && config.library) || {}, entry.kind, entry.raw);
  }
  // A local picture is not a different kind of thing because the viewer is showing it.
  // Without this every local entry crossed the window boundary as added:false/pooled:null
  // EVEN WHEN IT HAD A RECORD, and the viewer's menu then behaved as if the photo were an
  // un-added online card: "find tags" and "remove" did nothing and said nothing, and
  // assign asked main to download a file already sitting on the disk.
  if (entry.kind !== 'library' && entry.kind !== 'path') return null;
  return poolItemForRecord({
    id: (entry.raw && entry.raw.id) || null,
    path: entry.path,
    type: 'image',
  });
}

// ---- Multi-selection helpers ----
function localSelectionRecord(path, type, id = null) {
  const safeType = type === 'folder' ? 'folder' : 'image';
  return {
    key: window.CardInteraction.localKey(path, safeType),
    path,
    type: safeType,
    id: id || null,
  };
}

function selectionRecordFromEntry(entry, freshItem = null) {
  if (!entry || !entry.path) return null;
  const item = freshItem || (entry.item && config.library && config.library[entry.item.id]) || entry.item;
  const type = (item && item.type === 'folder') || entry.kind === 'subfolder' || entry.kind === 'pool-folder'
    ? 'folder' : 'image';
  const record = localSelectionRecord(entry.path, type, item && item.id);
  if (entry.selectionKey) record.key = entry.selectionKey;
  return record;
}

function selectionControlLabel(record, selected) {
  const name = baseName(record && record.path) || '';
  return t(selected ? 'library.deselectItem' : 'library.selectItem', { name });
}

function librarySelectionBatchPending() {
  return libraryBatchAssignPending || libraryBatchRemovePending;
}

function removeSelectionSnapshot(records) {
  for (const record of records || []) {
    if (record && record.key) LIB.selection.delete(record.key);
  }
}

function bindSelectionCard(card, record) {
  if (!card || !record) return;
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', t('library.openItem', { name: baseName(record.path) }));
  card.__selectionRecord = record;
  card.dataset.selectionKey = record.key;
  LIB.selection.refresh(record);
  const selected = LIB.selection.has(record.key);
  card.classList.toggle('selected', selected);
  const toggle = card.querySelector(':scope > .lib-select-toggle');
  if (toggle) {
    toggle.disabled = librarySelectionBatchPending();
    toggle.setAttribute('aria-checked', selected ? 'true' : 'false');
    const label = selectionControlLabel(record, selected);
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
}

function appendSelectionToggle(card, record) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'lib-select-toggle';
  toggle.setAttribute('role', 'checkbox');
  toggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.2 8.2 3 3 6.6-7"/></svg>';
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (librarySelectionBatchPending()) return;
    const current = card.__selectionRecord || record;
    LIB.selection.toggle(current, e.shiftKey ? orderedSelectionRecords() : [], e.shiftKey);
    syncSelectionUI();
  });
  card.appendChild(toggle);
  bindSelectionCard(card, record);
}

function handleSelectionModifierClick(e, record) {
  if (!e.shiftKey && !e.ctrlKey && !e.metaKey) return false;
  e.preventDefault();
  e.stopPropagation();
  if (librarySelectionBatchPending()) return true;
  LIB.selection.toggle(record, e.shiftKey ? orderedSelectionRecords() : [], e.shiftKey);
  syncSelectionUI();
  return true;
}

function reconcileSelectionRecords(records) {
  const current = new Map(records.map((record) => [record.key, record]));
  let changed = false;
  for (const key of LIB.selection.keys()) {
    if (!current.has(key)) { LIB.selection.delete(key); changed = true; }
    else LIB.selection.refresh(current.get(key));
  }
  // A stable path may have acquired a pool id without changing selection keys.
  // Refresh the action bar even when no selected key disappeared.
  if (changed || LIB.selection.size > 0) syncSelectionUI();
}

function clearSelection() {
  LIB.selection.clear();
}

function syncSelectionUI() {
  // Sync every mounted local card; virtualized cards receive the same state in bindCard.
  document.querySelectorAll('#libGrid .lib-card[data-selection-key]').forEach((card) => {
    bindSelectionCard(card, card.__selectionRecord);
  });
  // Show/hide selection bar
  const bar = $('#libSelectionBar');
  if (!bar) return;
  const batchPending = librarySelectionBatchPending();
  bar.setAttribute('aria-label', t('library.selectionActions'));
  bar.toggleAttribute('aria-busy', batchPending);
  const clear = $('#libSelClear');
  if (clear) {
    clear.setAttribute('aria-label', t('library.clearSelection'));
    clear.title = t('library.clearSelection');
    clear.disabled = batchPending;
  }
  if (LIB.selection.size === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const n = LIB.selection.size;
  $('#libSelCount').textContent = t('library.selected', { n });
  // In the "removed" view the only sensible bulk action is putting things back, so
  // the destructive slot becomes the restore action instead of offering to remove
  // what is already removed.
  const restoring = inRemovedView();
  const assign = $('#libSelAssign');
  // Assigning from the trash put the photo on a monitor while its card still sat in
  // the trash — an implicit restore the user never asked for, and the exact state the
  // removal work exists to make impossible. Restore first, then assign.
  assign.hidden = restoring;
  assign.textContent = t('library.massAssign');
  assign.disabled = batchPending;
  const remove = $('#libSelDelete');
  remove.classList.toggle('destructive', !restoring);
  remove.classList.toggle('suggested', restoring);
  remove.textContent = t(restoring ? 'library.massRestore' : 'library.massDelete');
  // LIB-004: removal works for every card. It used to be blocked unless every
  // selected photo already had its own pool record, which in a folder-backed library
  // meant the button was greyed out for ~98% of what the user could see — and the
  // rule behind it (an implementation detail of where the photo is stored) was
  // invisible on screen. Removing now means "stop showing this in Znada" for all of
  // them; files on disk are still never deleted.
  remove.disabled = batchPending;
  remove.title = '';
  remove.setAttribute('aria-label', t(restoring ? 'library.massRestore' : 'library.massDelete'));
  // Deleting the file itself is offered only where the user has already decided to
  // remove it, never alongside the everyday action (LIB-007).
  const purge = $('#libSelPurge');
  if (purge) {
    // Folders are out of scope for deleting from disk, so a selection with no image in
    // it would open a dialog that deletes nothing.
    const hasImage = LIB.selection.values().some((r) => r.type !== 'folder');
    purge.hidden = !restoring || !hasImage || !FEATURES.physicalDelete;
    purge.textContent = t('library.deleteForever');
    purge.disabled = batchPending;
    purge.setAttribute('aria-label', t('library.deleteForever'));
  }
}

// Set a card's assigned state in place — both the `.assigned` class AND the corner
// badge element. buildLibCard only appends the <span class="lib-assigned"> when the
// card is built assigned, so toggling the class alone left the badge missing.
function setCardAssigned(card, on) {
  card.classList.toggle('assigned', on);
  let mark = card.querySelector(':scope > .lib-assigned');
  if (on && !mark) {
    mark = document.createElement('span');
    mark.className = 'lib-assigned';
    mark.title = t('library.assigned');
    card.appendChild(mark);
  } else if (!on && mark) {
    mark.remove();
  }
}

function setCardFavorite(card, on) {
  if (!card) return;
  const fav = card.querySelector(':scope > .lib-fav');
  if (!fav) return;
  fav.classList.toggle('on', !!on);
  fav.textContent = on ? '★' : '☆';
  fav.setAttribute('aria-pressed', on ? 'true' : 'false');
  const label = t(on ? 'library.favoriteRemove' : 'library.favoriteAdd');
  fav.setAttribute('aria-label', label);
  fav.title = label;
}

function poolCardById(id) {
  for (const c of document.querySelectorAll('#libGrid .lib-card[data-id]')) {
    if (c.dataset.id === id) return c;
  }
  return null;
}

function poolItemForRecord(record, pooledByPath = null) {
  const lib = (config && config.library) || {};
  if (record && record.id && lib[record.id]) return lib[record.id];
  if (pooledByPath && record && record.key) return pooledByPath.get(record.key) || null;
  const key = normPathKey(record && record.path);
  if (!key) return null;
  return Object.values(lib).find((item) => item && item.type === record.type
    && normPathKey(item.path) === key) || null;
}

async function ensurePoolItemForRecord(record) {
  const existing = poolItemForRecord(record);
  if (existing) {
    LIB.selection.refresh(localSelectionRecord(existing.path, existing.type, existing.id));
    syncSelectionUI();
    return existing;
  }
  if (!record || !record.path) return null;
  let res;
  try { res = await window.api.libraryMaterialize(record.path, record.type); }
  catch { return null; }
  config = (res && res.config) || config;
  const item = res && res.id && config.library ? config.library[res.id] : poolItemForRecord(record);
  if (item) {
    LIB.selection.refresh(localSelectionRecord(item.path, item.type, item.id));
    syncSelectionUI();
  }
  return item || null;
}

function replaceLocalCardWithPoolItem(card, item) {
  if (!card || !card.isConnected || !item) return poolCardById(item && item.id);
  if (card.dataset.id === item.id) {
    bindSelectionCard(card, localSelectionRecord(item.path, item.type, item.id));
    syncSelectionUI();
    return card;
  }
  const oldIndex = Number(card.dataset.galleryIndex);
  const galleryItem = item.type === 'image' ? galleryItemFromLibrary(item) : null;
  const replacement = buildLibCard(item, assignedIds().has(item.id));
  if (galleryItem) bindCardGalleryItem(replacement, galleryItem, oldIndex);
  syncVirtualCardReplacement(card, replacement, item);
  card.replaceWith(replacement);
  syncSelectionUI();
  scheduleJustifiedLayout($('#libGrid'));
  return replacement;
}

// A star in the Removed view would quietly bring the photo back into the pool while
// its card still sits in the trash — active and removed at once. Restoring is the
// explicit action for that. The star is not drawn there at all (buildLibCard); this
// stays as the last line of defence for the keyboard/context paths.
async function toggleFavoriteForRecord(record, preferredCard = null) {
  if (inRemovedView()) { toast(t('library.restoreFirst')); return null; }
  const item = await ensurePoolItemForRecord(record);
  if (!item) return null;
  try { config = await window.api.libraryToggleFavorite(item.id); }
  catch { return null; }
  const fresh = config.library && config.library[item.id];
  if (!fresh) return null;
  if (LIB.filter === 'favorite' && !fresh.favorite) {
    renderLibrary();
    return fresh;
  }
  let current = poolCardById(fresh.id) || ephemeralCardByPath(fresh.path) || preferredCard;
  if (current && current.dataset.id !== fresh.id) current = replaceLocalCardWithPoolItem(current, fresh);
  setCardFavorite(current, !!fresh.favorite);
  if (current) bindSelectionCard(current, localSelectionRecord(fresh.path, fresh.type, fresh.id));
  lastLibRenderKey = libRenderKey();
  return fresh;
}

// Update the "assigned" badge on existing cards in place — assignment changes which
// monitors use an item but NOT the grid's contents or order, so a full renderLibrary()
// rebuild is wasteful and (in the lazy "All"/folder views) collapses the grid height,
// yanking the window scroll to the top. Mirrors syncSelectionUI's in-place toggle.
function refreshAssignedHighlights() {
  const assigned = assignedIds();
  document.querySelectorAll('#libGrid .lib-card[data-id]').forEach((card) => {
    setCardAssigned(card, assigned.has(card.dataset.id));
  });
  // Virtual grid: cards rebuilt on a later scroll-back must use the NEW assigned set,
  // not the one captured at render time.
  const grid = $('#libGrid');
  if (grid) {
    grid.__gridContext = { ...(grid.__gridContext || {}), assigned };
    if (grid.__virtual) grid.__virtual.assigned = assigned;
  }
  // The grid now matches the new assigned state, so record the key — a later tab
  // switch back to Library reuses this DOM (and its scroll) instead of rebuilding.
  lastLibRenderKey = libRenderKey();
}

function refreshFavoriteHighlights() {
  const lib = config.library || {};
  document.querySelectorAll('#libGrid .lib-card[data-id]').forEach((card) => {
    const it = lib[card.dataset.id];
    if (it) setCardFavorite(card, !!it.favorite);
  });
  lastLibRenderKey = libRenderKey();
}

function sameTags(a, b) {
  const aa = Array.isArray(a) ? a : [];
  const bb = Array.isArray(b) ? b : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return false;
  return true;
}

function isFavoriteOnlyLibraryChange(prevLib, nextLib) {
  const prev = prevLib || {};
  const next = nextLib || {};
  const prevIds = Object.keys(prev).sort();
  const nextIds = Object.keys(next).sort();
  if (prevIds.length !== nextIds.length) return false;
  let changed = false;
  for (let i = 0; i < prevIds.length; i++) {
    const id = prevIds[i];
    if (id !== nextIds[i]) return false;
    const a = prev[id] || {};
    const b = next[id] || {};
    if (a.type !== b.type || a.path !== b.path || a.addedAt !== b.addedAt || a.modifiedAt !== b.modifiedAt) return false;
    if (!sameTags(a.tags, b.tags)) return false;
    if (!!a.favorite !== !!b.favorite) changed = true;
  }
  return changed;
}

// Find the on-screen ephemeral card (folder image not yet in the pool) for a path.
function ephemeralCardByPath(path) {
  const key = normPathKey(path);
  for (const c of document.querySelectorAll('#libGrid .lib-card[data-path]')) {
    if (!c.dataset.id && normPathKey(c.dataset.path) === key) return c;
  }
  return null;
}

// After an in-place card.replaceWith(...), the virtual grid's index→element map (and
// the upgraded entry, if any) must follow the swap — otherwise the next window update
// re-appends the detached OLD node and the grid shows a stale card.
function syncVirtualCardReplacement(oldCard, newCard, upgradedItem = null, deferGalleryRefresh = false) {
  const grid = $('#libGrid');
  const virtual = grid && grid.__virtual;
  if (!virtual) return;
  const gridIndex = Number(oldCard && oldCard.dataset ? oldCard.dataset.virtualIndex : NaN);
  if (Number.isInteger(gridIndex) && virtual.cards.get(gridIndex) === oldCard) {
    virtual.cards.set(gridIndex, newCard);
    newCard.dataset.virtualIndex = String(gridIndex);
    if (oldCard.dataset.gridKey) newCard.dataset.gridKey = oldCard.dataset.gridKey;
    if (oldCard.dataset.thumbPriority) newCard.dataset.thumbPriority = oldCard.dataset.thumbPriority;
  }
  if (upgradedItem && Number.isInteger(gridIndex) && virtual.entries[gridIndex]) {
    const entry = virtual.entries[gridIndex];
    const galleryItem = upgradedItem.type === 'image' ? galleryItemFromLibrary(upgradedItem) : null;
    entry.item = upgradedItem;
    entry.id = upgradedItem.id;
    entry.kind = upgradedItem.type === 'folder' ? 'pool-folder' : 'pool-image';
    entry.selectableId = upgradedItem.id;
    entry.selectionKey = entry.key;
    entry.galleryItem = galleryItem;
    if (galleryItem && Number.isInteger(entry.galleryIndex) && entry.galleryIndex >= 0
        && Array.isArray(grid.__galleryItems)) {
      grid.__galleryItems[entry.galleryIndex] = galleryItem;
      if (!deferGalleryRefresh) setGridGallerySource(grid, grid.__galleryItems);
    }
    if (Array.isArray(virtual.versions)) virtual.versions[gridIndex] = localGridVersion(entry);
    bindLocalGridCard(newCard, entry, grid);
  }
}

// When the ONLY content change is pool image(s) added whose path is already shown as an
// ephemeral folder card — i.e. a materialize, e.g. from assigning a folder photo — upgrade
// those exact cards to real pool cards in place instead of rebuilding/flashing the whole
// grid. Returns true if it fully handled the change; false → the caller should rebuild.
function tryUpgradeMaterializedCards(prevPoolIds) {
  const lib = config.library || {};
  for (const id of prevPoolIds) if (!lib[id]) return false; // something removed → real rebuild
  const addedItems = Object.values(lib).filter((it) => it && it.path && !prevPoolIds.has(it.id));
  // A mixed batch can add images and a folder in one config broadcast. The image-only
  // in-place path cannot honestly claim that it handled the new pool-folder too.
  if (addedItems.some((it) => it.type !== 'image')) return false;
  const added = addedItems;
  if (!added.length) return false; // favorite/sort/other change → real rebuild
  const pairs = [];
  for (const it of added) {
    const card = ephemeralCardByPath(it.path);
    if (!card) return false; // a genuinely new item the grid doesn't show yet → rebuild
    pairs.push({ it, card });
  }
  const assigned = assignedIds();
  const grid = $('#libGrid');
  for (const { it, card } of pairs) {
    const replacement = buildLibCard(it, assigned.has(it.id));
    bindCardGalleryItem(replacement, galleryItemFromLibrary(it), Number(card.dataset.galleryIndex));
    syncVirtualCardReplacement(card, replacement, it, true);
    card.replaceWith(replacement);
  }
  if (grid && Array.isArray(grid.__galleryItems)) setGridGallerySource(grid, grid.__galleryItems);
  scheduleJustifiedLayout(grid);
  lastLibRenderKey = libRenderKey();
  return true;
}

// Shared monitor×theme grid for both the single- and multi-assign popups.
// onPick(monitorId, theme) performs the actual assignment.
function consumeAssignResult(res) {
  if (res && res.config) {
    config = res.config;
    return { ok: res.ok !== false && !res.error, error: res.error || null };
  }
  // Backward-compatible with older mock/preload shapes that returned config directly.
  if (res && res.library) {
    config = res;
    return { ok: true, error: null };
  }
  return { ok: false, error: 'unknown' };
}

async function assignLibraryItem(id, monitorId, th) {
  let res;
  try { res = await window.api.libraryAssign(id, monitorId, th); }
  catch { res = { config, ok: false, error: 'assign_failed' }; }
  return consumeAssignResult(res);
}

async function assignLibraryRecord(record, monitorId, th) {
  let res;
  try { res = await window.api.libraryAssignRecord(record, monitorId, th); }
  catch { res = { config, ok: false, error: 'assign_failed' }; }
  const status = consumeAssignResult(res);
  const item = res && res.id && config.library ? config.library[res.id] : poolItemForRecord(record);
  if (status.ok && item) {
    LIB.selection.refresh(localSelectionRecord(item.path, item.type, item.id));
    syncSelectionUI();
  }
  return { ...status, item: item || null, warning: (res && res.warning) || null };
}

async function assignLibraryRecords(records, monitorId, th) {
  let res;
  try { res = await window.api.libraryAssignRecords(records, monitorId, th); }
  catch { res = { config, ok: false, error: 'assign_failed', assigned: 0, failed: records.length }; }
  if (res && res.config) config = res.config;
  return {
    ok: !!(res && res.ok),
    assigned: Number(res && res.assigned) || 0,
    failed: Number(res && res.failed) || 0,
    error: (res && res.error) || null,
    warning: (res && res.warning) || null,
  };
}

// The rows themselves now live in renderer/assign-rows.js so the fullscreen viewer
// draws exactly the same chooser. This supplies the wording and this window's data.
// Единый режим (separateThemes off): у монитора один слот — одна кнопка «Назначить».
function appendAssignRows(pop, onPick) {
  const title = document.createElement('div');
  title.className = 'lib-popup-title';
  title.textContent = t('library.assignTo');
  pop.appendChild(title);

  AssignRows.build(pop, monitorList, config && config.separateThemes, {
    icons: THEME_ICON_SVG,
    idPrefix: `libAssignMonitor-${Date.now()}`,
    monitorLabel: (row) => t('monitor.label', { n: row.number }),
    slotLabel: (slot) => (slot.themeIcon
      ? t(slot.theme === 'dark' ? 'design.darkTheme' : 'design.lightTheme')
      : t('library.assignAction')),
    onPick,
  });
}

// Bulk assign: apply the chosen monitor×theme to every selected item. Anchored above the
// "assign" button in the selection bar (which sits at the bottom of the window).
function openMassAssignMenu(anchor) {
  if (librarySelectionBatchPending()) return;
  // The button is hidden in the trash; this covers the keyboard route to it.
  if (inRemovedView()) { toast(t('library.restoreFirst')); return; }
  closeLibPopup();
  const pop = document.createElement('div');
  pop.className = 'lib-popup';
  pop.id = 'libPopup';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('library.assignTo'));

  appendAssignRows(pop, async (monitorId, th) => {
    if (librarySelectionBatchPending()) return;
    // Keep a stable snapshot: if the user navigates while validation is running,
    // completion must never clear a later selection or close a newer popup.
    const records = LIB.selection.values();
    if (!records.length) return;
    libraryBatchAssignPending = true;
    pop.setAttribute('aria-busy', 'true');
    pop.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    syncSelectionUI();
    // Snapshot before the first IPC result can rebuild/upgrade cards. Selecting a
    // transient path is harmless; materialization starts only after this slot pick.
    try {
      const result = await assignLibraryRecords(records, monitorId, th);
      const { assigned, failed } = result;
      if (pop.isConnected && $('#libPopup') === pop) closeLibPopup();
      if (!failed && assigned === records.length) removeSelectionSnapshot(records);
      syncSelectionUI();
      refreshAssignedHighlights(); // in place — don't rebuild the grid / reset scroll
      renderPreviews();
      renderHome();
      toast(failed ? t(assigned ? 'library.assignPartialToast' : 'library.assignMissingToast') : t('library.assignedToast'));
    } finally {
      libraryBatchAssignPending = false;
      pop.removeAttribute('aria-busy');
      syncSelectionUI();
    }
  });

  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  let left = r.left + r.width / 2 - pop.offsetWidth / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8));
  let top = r.top - pop.offsetHeight - 8;
  if (top < 8) top = r.bottom + 8; // not enough room above → drop below
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  armLibPopupDismiss(anchor);
  requestAnimationFrame(() => {
    const first = pop.querySelector('.lib-popup-btn');
    if (first && first.isConnected) first.focus();
  });
}

// Set the empty-state caption (different wording inside an empty folder vs empty library).
function setLibEmptyText(key) {
  const empty = $('#libEmpty');
  if (!empty) return;
  const sp = empty.querySelector('span') || empty;
  sp.textContent = t(key);
}

let libPopupAnchor = null;
let libPopupDismissTimer = 0;
let libPopupResizeObserver = null;
let libPopupViewportSize = null;

function closeLibPopup(opts = {}) {
  const p = $('#libPopup');
  if (p) p.remove();
  if (libPopupDismissTimer) clearTimeout(libPopupDismissTimer);
  libPopupDismissTimer = 0;
  if (libPopupResizeObserver) libPopupResizeObserver.disconnect();
  libPopupResizeObserver = null;
  libPopupViewportSize = null;
  document.removeEventListener('click', onDocClosePopup, true);
  document.removeEventListener('scroll', onLibPopupViewportChange, true);
  window.removeEventListener('resize', onLibPopupViewportChange);
  window.removeEventListener('blur', onLibPopupViewportChange);
  if (libPopupAnchor) {
    libPopupAnchor.setAttribute('aria-expanded', 'false');
    libPopupAnchor.removeAttribute('aria-controls');
    if (opts.restoreFocus && libPopupAnchor.isConnected) libPopupAnchor.focus({ preventScroll: true });
  }
  libPopupAnchor = null;
}
function onDocClosePopup(e) {
  const p = $('#libPopup');
  if (p && !p.contains(e.target)) closeLibPopup();
}

function onLibPopupViewportChange(e) {
  const p = $('#libPopup');
  if (p && e && e.target instanceof Node && p.contains(e.target)) return;
  closeLibPopup();
}

function armLibPopupDismiss(anchor = null) {
  libPopupAnchor = anchor && anchor.isConnected ? anchor : null;
  if (libPopupAnchor) {
    libPopupAnchor.setAttribute('aria-expanded', 'true');
    libPopupAnchor.setAttribute('aria-controls', 'libPopup');
  }
  libPopupDismissTimer = setTimeout(() => {
    libPopupDismissTimer = 0;
    if (!$('#libPopup')) return;
    document.addEventListener('click', onDocClosePopup, true);
    document.addEventListener('scroll', onLibPopupViewportChange, true);
    window.addEventListener('resize', onLibPopupViewportChange);
    window.addEventListener('blur', onLibPopupViewportChange);
    if (typeof ResizeObserver === 'function') {
      libPopupViewportSize = [document.documentElement.clientWidth, document.documentElement.clientHeight];
      libPopupResizeObserver = new ResizeObserver(() => {
        const next = [document.documentElement.clientWidth, document.documentElement.clientHeight];
        if (!libPopupViewportSize || next[0] !== libPopupViewportSize[0] || next[1] !== libPopupViewportSize[1]) {
          closeLibPopup();
        }
      });
      libPopupResizeObserver.observe(document.documentElement);
    }
  }, 0);
}

function appendTagEditor(pop, state, ensureItem) {
  const tagBox = document.createElement('div');
  tagBox.className = 'lib-popup-tags';
  const tagHdr = document.createElement('div');
  tagHdr.className = 'lib-popup-title';
  tagHdr.textContent = t('library.tags');
  tagBox.appendChild(tagHdr);
  const chips = document.createElement('div');
  chips.className = 'lib-chips';
  tagBox.appendChild(chips);
  const tagInput = document.createElement('input');
  tagInput.className = 'lib-tag-input';
  tagInput.placeholder = t('library.addTagPh');
  tagInput.addEventListener('click', (e) => e.stopPropagation());
  tagBox.appendChild(tagInput);
  const suggest = document.createElement('div');
  suggest.className = 'lib-tag-suggest';
  suggest.hidden = true;
  suggest.addEventListener('mousedown', (e) => e.preventDefault());
  tagBox.appendChild(suggest);
  pop.appendChild(tagBox);

  const curTags = () => {
    const item = state.item && config.library && config.library[state.item.id];
    return (item && item.tags) || [];
  };
  const renderChips = () => {
    chips.innerHTML = '';
    curTags().forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'lib-chip';
      chip.textContent = tag;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'lib-chip-x';
      remove.textContent = '×';
      remove.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!state.item) return;
        config = await window.api.libraryRemoveTag(state.item.id, tag);
        renderChips();
        renderSuggest();
        renderLibrary();
      });
      chip.appendChild(remove);
      chips.appendChild(chip);
    });
  };

  const tagFreq = libTagCounts();
  const applyTag = async (raw) => {
    const value = String(raw || '').trim();
    if (!value) return;
    const item = await ensureItem();
    if (!item) return;
    config = await window.api.libraryAddTag(item.id, value);
    state.item = config.library && config.library[item.id] ? config.library[item.id] : item;
    tagInput.value = '';
    renderChips();
    renderSuggest();
    renderLibrary();
    tagInput.focus();
  };
  function renderSuggest() {
    const q = tagInput.value.trim().toLowerCase();
    const have = new Set(curTags());
    const list = Object.keys(tagFreq)
      .filter((tag) => !have.has(tag) && (!q || tag.includes(q)))
      .sort((a, b) => (tagFreq[b] - tagFreq[a]) || a.localeCompare(b))
      .slice(0, 40);
    suggest.innerHTML = '';
    if (!list.length) { suggest.hidden = true; return; }
    list.forEach((tag) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lib-tag-sug';
      const name = document.createElement('span');
      name.textContent = tag;
      const count = document.createElement('span');
      count.className = 'lib-tag-cnt';
      count.textContent = tagFreq[tag];
      button.append(name, count);
      button.addEventListener('click', (e) => { e.stopPropagation(); applyTag(tag); });
      suggest.appendChild(button);
    });
    suggest.hidden = false;
  }

  renderChips();
  tagInput.addEventListener('focus', renderSuggest);
  tagInput.addEventListener('input', renderSuggest);
  tagInput.addEventListener('blur', () => setTimeout(() => { suggest.hidden = true; }, 100));
  tagInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && tagInput.value.trim()) { e.stopPropagation(); await applyTag(tagInput.value); }
    else if (e.key === 'Escape' && !suggest.hidden) {
      e.preventDefault();
      e.stopPropagation();
      suggest.hidden = true;
    }
  });
  return tagInput;
}

// Floating popup: assign this item to a monitor×theme, or remove it from the library.
function openAssignMenu(it, anchor, materializeFn, options = {}) {
  closeLibPopup();
  // `it` may be null: an ephemeral folder image not yet in the pool. We add it to
  // the pool (materialize, by reference) ONLY when the user commits an action here
  // — assign / add tag / remove — never just for opening the menu. Opening it used
  // to materialize immediately, which jumped the card to the top under "newest
  // first" and left stray pool items behind after the folder was removed.
  const lazyItem = window.CardInteraction.createLazyPoolItem(it, materializeFn);
  const state = { item: lazyItem.current() };
  const ensureItem = async () => {
    if (!state.item) state.item = await lazyItem.ensure();
    return state.item;
  };
  const pop = document.createElement('div');
  pop.className = 'lib-popup';
  pop.id = 'libPopup';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', options.assign === false ? t('library.editTags') : t('library.assignTo'));
  let sections = 0;
  const addSeparator = () => {
    if (!sections) return;
    const sep = document.createElement('div');
    sep.className = 'lib-popup-sep';
    pop.appendChild(sep);
  };
  if (options.assign !== false) {
    appendAssignRows(pop, async (monitorId, th) => {
      // Close BEFORE doing the work, not after. For a photo that is already on disk
      // everything below is instant, so this never showed; for an online one the
      // picture still has to be downloaded, and the menu sat on screen for seconds
      // looking stuck. The removal button next door has always closed first.
      closeLibPopup();
      // `options.pending` marks a source that has to be fetched: it names the message
      // to show while waiting, AND says the producer reports its own failures, so we
      // do not talk over it with a second, vaguer one.
      const remote = !!options.pending && !state.item;
      if (remote) toast(t(options.pending));
      let res;
      if (!state.item && options.assignmentRecord) {
        res = await assignLibraryRecord(options.assignmentRecord, monitorId, th);
        if (res.item) state.item = res.item;
      } else {
        const item = await ensureItem();
        if (!item) {
          // Silence here used to leave the menu open with no explanation at all.
          if (!remote) toast(t('library.assignMissingToast'));
          return;
        }
        res = await assignLibraryItem(item.id, monitorId, th);
      }
      refreshAssignedHighlights();
      renderPreviews();
      renderHome();
      toast(res.ok ? t('library.assignedToast') : t('library.assignMissingToast'));
    });
    sections++;
  }

  let tagInput = null;
  if (options.tags !== false) {
    addSeparator();
    tagInput = appendTagEditor(pop, state, ensureItem);
    sections++;
  }

  if (options.remove !== false) {
    addSeparator();
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lib-popup-btn danger';
    remove.textContent = t('library.remove');
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!state.item) { closeLibPopup(); return; }
      // One removal path for the whole app. This button used to call an older IPC
      // that skipped the trash and the removed-marker entirely, so removing from
      // here lost a downloaded photo's only copy and left a folder photo on screen
      // under a "removed" toast (BUG-007).
      const item = state.item;
      closeLibPopup();
      await removeRecordFromLibrary(localSelectionRecord(item.path, item.type, item.id));
    });
    pop.appendChild(remove);
  }

  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  let left = r.right - pop.offsetWidth;
  if (left < 8) left = 8;
  let top = r.bottom + 6;
  if (top + pop.offsetHeight > window.innerHeight - 8) top = r.top - pop.offsetHeight - 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, top)}px`;
  armLibPopupDismiss(anchor);
  requestAnimationFrame(() => {
    const first = options.focusTags && tagInput ? tagInput : pop.querySelector('button, input');
    if (first && first.isConnected) first.focus();
  });
}


// One card, same meaning as the multi-select button: stop showing this in Znada.
// Goes through the same path so a photo without a pool record is removable too.
async function removeRecordFromLibrary(record) {
  if (!record) return;
  const item = poolItemForRecord(record);
  const payload = [{ path: (item && item.path) || record.path, id: (item && item.id) || '', type: record.type }];
  if (!payload[0].path && !payload[0].id) return;
  let res;
  try { res = await window.api.libraryRemoveMany(payload); }
  catch { res = null; }
  if (!res || res.error) { toast(t('library.massDeleteFailed')); return; }
  config = res.config || config;
  const affected = res.affected || 0;
  if (!affected) { toast(t('library.massDeleteFailed')); return; }
  LIB.selection.delete(record.key);
  syncSelectionUI();
  renderLibrary();
  renderPreviews();
  renderHome();
  toastRemoved(affected, res.undo && res.undo.token);
}

// --- Details view (UX1 step C) -------------------------------------------
// Read-only properties sheet for a card. Everything shown is either already in the
// pool item or fetched once per open through `item-details`; the view never writes
// to the library, so it works for transient live-folder cards without materializing
// them. Actions are limited to reveal / copy path / open source page.
let detailsCloseHandler = null;

function detailsLocale() {
  return document.documentElement.lang || undefined;
}

function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  const units = [t('details.unitB'), t('details.unitKb'), t('details.unitMb'), t('details.unitGb')];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString(detailsLocale(), { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

function formatDetailsDate(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return '';
  try {
    return new Intl.DateTimeFormat(detailsLocale(), {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toLocaleString(detailsLocale());
  }
}

function isOpenableDetailsSource(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch { return false; }
}

// Catalogue ratings, spelled for a person. `safe` is the older name some providers
// still use for `general`; an unknown word is shown as nothing rather than raw, so a
// provider inventing a new one cannot leak a bare English token into the interface.
const DETAILS_RATING_KEYS = {
  general: 'details.ratingGeneral',
  safe: 'details.ratingGeneral',
  sensitive: 'details.ratingSensitive',
  questionable: 'details.ratingQuestionable',
  explicit: 'details.ratingExplicit',
};

function detailsRatingLabel(value) {
  const key = DETAILS_RATING_KEYS[String(value || '').trim().toLowerCase()];
  return key ? t(key) : '';
}

function detailsSourceLabel(value) {
  const raw = String(value || '');
  const low = raw.toLowerCase();
  // 'lumina:' — метка, оставшаяся от прежнего имени; записи с ней не переписываются.
  return low.startsWith('znada:') || low.startsWith('lumina:') ? 'Znada' : raw;
}

function closeCardDetails() {
  const backdrop = $('#detailsBackdrop');
  if (!backdrop) return;
  if (detailsCloseHandler) {
    document.removeEventListener('keydown', detailsCloseHandler, true);
    detailsCloseHandler = null;
  }
  const restore = backdrop.__restoreFocus;
  backdrop.remove();
  if (restore && restore.isConnected) restore.focus({ preventScroll: true });
}

function detailsRow(label, value, opts = {}) {
  const row = document.createElement('div');
  row.className = 'details-row' + (opts.wide ? ' wide' : '');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  if (opts.node) dd.appendChild(opts.node);
  else {
    dd.textContent = value;
    if (opts.mono) dd.className = 'mono';
  }
  row.append(dt, dd);
  return row;
}

async function openCardDetails(record) {
  closeCardDetails();
  const item = poolItemForRecord(record);
  const filePath = String((item && item.path) || (record && record.path) || '');
  if (!filePath) return;
  const isFolder = (item && item.type === 'folder') || (record && record.type === 'folder');
  const displayName = baseName(filePath) || filePath;
  const sourceIsOpenable = !!(item && isOpenableDetailsSource(item.source));

  const backdrop = document.createElement('div');
  backdrop.className = 'lib-modal-backdrop';
  backdrop.id = 'detailsBackdrop';
  backdrop.__restoreFocus = document.activeElement;

  const modal = document.createElement('div');
  modal.className = 'lib-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'detailsTitle');
  modal.tabIndex = -1;

  const head = document.createElement('div');
  head.className = 'lib-modal-head';
  const title = document.createElement('strong');
  title.id = 'detailsTitle';
  title.textContent = displayName;
  title.title = displayName;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'lib-modal-close';
  close.setAttribute('aria-label', t('details.close'));
  close.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  close.addEventListener('click', closeCardDetails);
  head.append(title, close);

  const body = document.createElement('div');
  body.className = 'lib-modal-body';

  const preview = document.createElement('div');
  preview.className = 'details-preview';
  preview.hidden = isFolder;
  if (!isFolder) {
    preview.classList.add('loading');
    preview.setAttribute('aria-busy', 'true');
  }
  body.appendChild(preview);

  const rows = document.createElement('dl');
  rows.className = 'details-rows';
  body.appendChild(rows);

  const foot = document.createElement('div');
  foot.className = 'lib-modal-foot';
  const runAction = async (button, handler, failureKey) => {
    if (button.disabled) return;
    button.disabled = true;
    let ok = false;
    try { ok = (await handler()) !== false; } catch { ok = false; }
    if (!ok && failureKey) toast(t(failureKey));
    if (button.isConnected) button.disabled = false;
  };
  const addAction = (label, handler, failureKey) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill ghost';
    b.textContent = label;
    b.addEventListener('click', () => runAction(b, handler, failureKey));
    foot.appendChild(b);
    return b;
  };
  addAction(
    t('details.openFolder'),
    () => window.api.itemReveal(filePath),
    'details.revealFailed',
  );
  addAction(t('details.copyPath'), async () => {
    const ok = await window.api.itemCopyPath(filePath);
    if (ok) toast(t('details.copied'));
    return ok;
  }, 'details.copyFailed');
  if (sourceIsOpenable) {
    addAction(
      t('details.openSource'),
      () => window.api.itemOpenSource(item.id),
      'details.openFailed',
    );
  }
  // META-001. The sheet is where the user is already looking at the empty author, the
  // missing source and the missing tags, so it is where the button to go and find them
  // belongs. WHICH photos may be looked up is the registry's answer and not a second one
  // written here: asking "is it already in the pool" hid the button for every photo
  // inside a watched folder — precisely the population the action exists for, and the
  // population the card menu one click away already serves. The owner reported it as
  // "the button is missing when the photo has no tags", because tags can only live on a
  // pool record, so "has tags" looked like the rule while pool membership was.
  const lookupSubject = record
    ? CardActions.localSubject({ ...record, removedView: inRemovedView() }, item)
    : null;
  if (lookupSubject && CardActions.actionsFor(lookupSubject,
    { physicalDelete: FEATURES.physicalDelete, only: ['lookupMeta'] }).length) {
    // No failureKey: runAction would toast on a falsy return, and CardMetadata.run
    // answers null when a lookup for this photo is already running. "Could not check"
    // for "already checking" would be a new lie.
    addAction(t('details.lookupMeta'), () => runDetailsLookup(record, () => {
      if (backdrop.isConnected) openCardDetails(record);
    }));
  }

  modal.append(head, body, foot);
  backdrop.appendChild(modal);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeCardDetails(); });
  document.body.appendChild(backdrop);

  detailsCloseHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeCardDetails();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(modal.querySelectorAll(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )).filter((el) => !el.hidden && el.getClientRects().length);
    if (!focusable.length) {
      e.preventDefault();
      modal.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  };
  document.addEventListener('keydown', detailsCloseHandler, true);
  requestAnimationFrame(() => close.focus({ preventScroll: true }));

  // Static rows first so the sheet never appears empty, then fill in disk metadata.
  const unknown = t('details.unknown');
  rows.appendChild(detailsRow(t('details.type'), isFolder ? t('details.typeFolder') : t('details.typeImage')));
  const resRow = detailsRow(t('details.resolution'), unknown);
  const sizeRow = detailsRow(t('details.size'), unknown);
  if (!isFolder) rows.append(resRow, sizeRow);
  const added = item ? formatDetailsDate(item.addedAt) : '';
  if (added) rows.appendChild(detailsRow(t('details.added'), added));
  const modRow = detailsRow(t('details.modified'), unknown);
  rows.appendChild(modRow);
  if (item && item.author) rows.appendChild(detailsRow(t('details.author'), item.author));
  // META-001. Shown, and nothing more: Znada never hides, filters or reorders a photo
  // the user brought himself because a catalogue put a label on it. It is information
  // about where the picture came from, not permission to act on his library.
  const ratingLabel = detailsRatingLabel(item && item.rating);
  if (ratingLabel) rows.appendChild(detailsRow(t('details.rating'), ratingLabel));
  if (item && item.source) {
    let sourceNode;
    if (sourceIsOpenable) {
      sourceNode = document.createElement('button');
      sourceNode.type = 'button';
      sourceNode.className = 'details-link';
      sourceNode.textContent = detailsSourceLabel(item.source);
      sourceNode.addEventListener('click', () => runAction(
        sourceNode,
        () => window.api.itemOpenSource(item.id),
        'details.openFailed',
      ));
    } else {
      sourceNode = document.createElement('span');
      sourceNode.textContent = detailsSourceLabel(item.source);
    }
    rows.appendChild(detailsRow(t('details.source'), '', { node: sourceNode, wide: true }));
  }
  rows.appendChild(detailsRow(t('details.path'), filePath, { mono: true, wide: true }));
  if (item && Array.isArray(item.tags) && item.tags.length) {
    const chips = document.createElement('div');
    chips.className = 'details-tags';
    const maxVisibleTags = 80;
    item.tags.slice(0, maxVisibleTags).forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'details-tag';
      chip.textContent = tag;
      chips.appendChild(chip);
    });
    if (item.tags.length > maxVisibleTags) {
      const more = document.createElement('span');
      more.className = 'details-tag more';
      more.textContent = t('library.moreTags', { n: item.tags.length - maxVisibleTags });
      chips.appendChild(more);
    }
    rows.appendChild(detailsRow(t('details.tags'), '', { node: chips, wide: true }));
  }

  if (!isFolder) {
    const finishPreview = () => {
      preview.setAttribute('aria-busy', 'false');
      preview.classList.remove('loading');
    };
    window.api.thumbInfo(filePath, 360, 360).then((info) => {
      if (!backdrop.isConnected) return;
      if (!info || !info.url) {
        finishPreview();
        return;
      }
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.addEventListener('load', finishPreview, { once: true });
      img.addEventListener('error', finishPreview, { once: true });
      img.src = info.url;
      preview.appendChild(img);
    }).catch(() => {
      if (!backdrop.isConnected) return;
      finishPreview();
    });
  }

  try {
    const meta = await window.api.itemDetails(filePath);
    if (!backdrop.isConnected) return;
    if (!meta || !meta.exists) {
      modRow.querySelector('dd').textContent = t('details.missing');
      return;
    }
    if (meta.width > 0 && meta.height > 0) {
      resRow.querySelector('dd').textContent = `${meta.width} × ${meta.height}`;
    }
    const size = formatFileSize(meta.size);
    if (size) sizeRow.querySelector('dd').textContent = size;
    const modified = formatDetailsDate(meta.modifiedAt);
    if (modified) modRow.querySelector('dd').textContent = modified;
  } catch { /* metadata is optional; the sheet stays usable without it */ }
}

// ONL-009. One menu for every card in this window, and the same one the fullscreen
// viewer draws. The split is deliberate and the owner asked for it explicitly:
//   WHICH actions apply  → renderer/card-actions.js (pure, tested)
//   HOW a menu behaves   → renderer/card-menu.js (shared with the viewer)
//   WHAT an action means → here, where the rest of this window's machinery lives.
// Adding an action later means one registry entry plus one handler, not a fourth menu.

// Everything that needs the actual picture goes through main's single "get the file"
// path, and what each action MEANS lives in card-transfer.js so the viewer runs the
// same code. This window only supplies its bridge and its way of speaking.
function runCardTransfer(action, descriptor) {
  if (!descriptor) return Promise.resolve();
  return CardTransfer.run(action, {
    bridge: window.api,
    descriptor,
    t,
    notify: ({ message, actionLabel, onAction }) => {
      if (!message) return;
      if (actionLabel && onAction) toastAction(message, actionLabel, onAction);
      else toast(message);
    },
    // The owner's decision: an export is an export, so nothing was added to the
    // library. Offering it as one explicit click keeps that honest and still handy.
    onAddToLibrary: () => addCardToLibrary(descriptor),
  });
}

// The one place an online card becomes a library record, whichever menu asked for it.
// META-001. Ask an online catalogue about one photo the user already has. The whole
// operation, including which ending deserves which words, lives in card-metadata.js so
// that the viewer performs the identical action rather than a similar one.
function runMetadataLookup(id, opts) {
  const options = opts || {};
  return CardMetadata.run({
    bridge: window.api,
    id,
    t,
    notify: (message) => { if (message) toast(message); },
    onBusy: options.onBusy,
    onApplied: options.onApplied,
  });
}

// META-001 from the details sheet. The record is made only now, when the user has
// actually asked — the same moment "change tags" makes one, and exactly what the card
// menu does at `lookupMeta` below. Deliberately OUTSIDE openCardDetails: merely OPENING
// the sheet must still write nothing to the pool, and test/item-details-integration
// proves that by scanning that function's body for this very call.
async function runDetailsLookup(record, redraw) {
  const item = await ensurePoolItemForRecord(record);
  if (!item) { toast(t('card.lookupFailed')); return false; }
  const res = await runMetadataLookup(item.id, {
    onApplied: async () => {
      // Ask for the config the lookup just wrote instead of waiting on the broadcast.
      // savePoolOnly -> broadcastConfig is COALESCED (leading edge, 120 ms), and the
      // materialize immediately above stamps that window — so the arrival order this
      // redraw would otherwise depend on is not guaranteed, and a redraw that lost the
      // race would say "added N tags" over a sheet showing none.
      try { config = await window.api.getConfig(); } catch { /* keep what we have */ }
      if (typeof redraw === 'function') redraw();
    },
  });
  return !!res;
}

async function addCardToLibrary(descriptor) {
  if (!descriptor || descriptor.kind === 'local') return null;
  let res;
  try {
    res = descriptor.kind === 'cloud'
      ? await window.api.cloudAdd(descriptor.item)
      : await window.api.internetAdd(descriptor.item, INTERNET.q);
  } catch { res = { error: 'download' }; }
  if (res && res.config) config = res.config;
  if (!res || res.error) { toast(CardTransfer.errorMessage(t, res && res.error)); return null; }
  toast(t('online.added'));
  refreshPoolDependentChrome();
  refreshOnlineAddedState();
  return res.id || null;
}

function openCardMenu(subject, card, point = null) {
  if (!subject) return;
  closeLibPopup();
  const descriptor = CardActions.descriptorFor(subject);
  const groups = CardActions.menuGroupsFor(subject, { physicalDelete: FEATURES.physicalDelete });
  if (!groups.length) return;

  // Local actions still speak the record/pool-item language the rest of this file
  // uses; resolving it once here keeps the handlers below thin.
  const record = subject.kind === 'local'
    ? localSelectionRecord(subject.path, subject.type, subject.id) : null;
  const current = record ? poolItemForRecord(record) : null;

  const handlers = {
    open: () => enterFolder(subject.path, baseName(subject.path)),
    assign: () => {
      if (subject.kind === 'local') {
        openAssignMenu(current, card, () => ensurePoolItemForRecord(record), {
          assign: true, tags: false, remove: false, assignmentRecord: record,
        });
        return;
      }
      // An online picture has to be downloaded before a monitor can show it. The
      // assign menu already takes a "produce the pool item" callback and only calls
      // it once the user commits to a monitor, so the download happens then and not
      // merely because the menu was opened.
      openAssignMenu(null, card, async () => {
        const id = await addCardToLibrary(descriptor);
        return id && config.library ? config.library[id] : null;
      }, { assign: true, tags: false, remove: false, pending: 'card.downloading' });
    },
    favorite: () => toggleFavoriteForRecord(record, card),
    tags: () => openAssignMenu(current, card, () => ensurePoolItemForRecord(record), {
      assign: false, tags: true, remove: false, focusTags: true,
    }),
    details: () => openCardDetails(record),
    // The record is made only now, when the user has actually asked — the same moment
    // "change tags" makes one.
    lookupMeta: async () => {
      const item = await ensurePoolItemForRecord(record);
      if (item) runMetadataLookup(item.id);
      else toast(t('card.lookupFailed'));
    },
    add: () => addCardToLibrary(descriptor),
    remove: () => (subject.kind === 'local'
      ? removeRecordFromLibrary(record)
      : removeOnlineFromLibrary(config.library ? config.library[subject.id] : null)),
    restore: () => restorePaths([subject.path]),
    deleteForever: () => deleteForever([subject.path]),
    saveAs: () => runCardTransfer('saveAs', descriptor),
    copyFile: () => runCardTransfer('copyFile', descriptor),
    copyLink: () => runCardTransfer('copyLink', descriptor),
    openSource: () => runCardTransfer('openSource', descriptor),
  };

  CardMenu.openMenu({
    groups,
    point,
    anchor: card,
    ariaLabel: t('library.cardActions'),
    // The star reads "add" or "remove" depending on the photo, so the label is asked
    // for at draw time rather than baked into the registry.
    labelFor: (action) => (action.id === 'favorite' && current && current.favorite
      ? t('library.favoriteRemove') : t(action.labelKey)),
    onPick: (action) => {
      const run = handlers[action.id];
      if (run) run();
    },
  });
}

function bindLocalCardContextMenu(card, record) {
  CardMenu.bind(card, (point) => {
    const source = card.__selectionRecord || record;
    const current = poolItemForRecord(source);
    const fresh = current ? localSelectionRecord(current.path, current.type, current.id) : source;
    // A removed photo is not part of the library, so the menu must not offer to
    // assign or tag it — that would quietly revive it through a side door.
    openCardMenu(CardActions.localSubject({ ...fresh, removedView: inRemovedView() }, current), card, point);
  }, () => librarySelectionBatchPending());
}

// `kind` is 'internet' or 'cloud' — they are NOT interchangeable: a catalogue card has
// no source page and only a short-lived signed link, so it must never be offered the
// two link actions: there is no page, and the link it does have expires.
function bindOnlineCardContextMenu(card, kind, item) {
  CardMenu.bind(card, (point) => {
    const pooled = OnlineAdd.pooledItem((config && config.library) || {}, kind, item);
    const subject = kind === 'cloud'
      ? CardActions.cloudSubject(item, pooled)
      : CardActions.internetSubject(item, pooled);
    openCardMenu(subject, card, point);
  });
}

// ---------------------------------------------------------------------------
// Smart Panel
// ---------------------------------------------------------------------------
let currentSmartTipIndex = -1;

function showSmartTip() {
  const tips = tPath(I18N.dict, 'smart.tips') || tPath(I18N.fallback, 'smart.tips') || [];
  if (!tips || !tips.length) return;
  const panel = $('#smartPanel');
  if (!panel) return;
  panel.className = 'smart-panel';
  $('#spIcon').innerHTML = PANEL_ICON_SVG.tip;
  $('#spTitle').hidden = true; // No title for tips, looks cleaner
  $('#spText').textContent = tips[currentSmartTipIndex % tips.length];
  $('#btnSpAction').hidden = true;
  panel.hidden = false;
  
  panel.style.animation = 'none';
  panel.offsetHeight; // trigger reflow
  panel.style.animation = 'fadeSlideIn 0.3s ease';
}

// Smart panel = an "update ready" notice (if one is downloaded) or a random tip of the day.
async function renderSmartPanel() {
  const panel = $('#smartPanel');
  if (!panel) return;

  // update ready → "restart to update" with an action button
  const up = await window.api.getUpdateState();
  if (up && up.state === 'ready') {
    panel.className = 'smart-panel update';
    $('#spIcon').innerHTML = PANEL_ICON_SVG.update;
    $('#spTitle').hidden = false;
    $('#spTitle').textContent = t('smart.updateTitle');
    $('#spText').textContent = t('smart.updateText');
    const btn = $('#btnSpAction');
    btn.textContent = t('smart.updateBtn');
    btn.className = 'pill suggested';
    btn.hidden = false;
    btn.onclick = () => window.api.installUpdate();
    panel.hidden = false;
    return;
  }

  // otherwise → tip of the day (random, picked once per session)
  const tips = tPath(I18N.dict, 'smart.tips') || tPath(I18N.fallback, 'smart.tips') || [];
  if (tips && tips.length) {
    if (currentSmartTipIndex === -1) currentSmartTipIndex = Math.floor(Math.random() * tips.length);
    showSmartTip();
  }
}

function initSmartPanel() {
  window.api.onUpdate(() => renderSmartPanel());
  renderSmartPanel();
}

function initLibrary() {
  // Delegated so dynamically-rendered tag buttons work too.
  const rail = document.querySelector('#viewLibrary .lib-rail');
  if (rail) rail.addEventListener('click', (e) => {
    const btn = e.target.closest('.lib-railbtn');
    if (!btn) return;
    closeLibPopup();
    clearSelection();
    syncSelectionUI();
    LIB.filter = btn.dataset.filter;
    exitFolderState(); // switching rail leaves any open folder
    renderLibrary();
  });

  // Click on empty space in library clears selection
  const libView = $('#viewLibrary');
  if (libView) libView.addEventListener('click', (e) => {
    if (LIB.selection.size === 0) return;
    if (e.target.closest('.lib-card') || e.target.closest('.lib-popup') || e.target.closest('.lib-selection-bar') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return;
    clearSelection();
    syncSelectionUI();
  });

  let lastLibraryMouseBackAt = 0;
  function onLibraryMouseBack(e) {
    if (e.button !== 3 || activePage !== 'library' || !LIB.folderPath) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'mousedown') return;
    const now = Date.now();
    if (now - lastLibraryMouseBackAt < 120) return;
    lastLibraryMouseBackAt = now;
    closeLibPopup();
    clearSelection();
    syncSelectionUI();
    navigateFolderBack();
  }
  document.addEventListener('mousedown', onLibraryMouseBack, true);
  document.addEventListener('mouseup', onLibraryMouseBack, true);
  document.addEventListener('auxclick', onLibraryMouseBack, true);

  // Escape key clears selection
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#libPopup')) {
      closeLibPopup({ restoreFocus: true });
      return;
    }
    if (LIB.selection.size > 0 && !librarySelectionBatchPending()) {
      clearSelection();
      syncSelectionUI();
    }
  });

  // Selection bar buttons
  const selClear = $('#libSelClear');
  if (selClear) selClear.addEventListener('click', () => {
    if (librarySelectionBatchPending()) return;
    clearSelection();
    syncSelectionUI();
  });
  const selPurge = $('#libSelPurge');
  if (selPurge) selPurge.addEventListener('click', async () => {
    if (librarySelectionBatchPending()) return;
    // Folders are out of scope for deleting from disk — erasing a tree is a different
    // question. The context menu already skips them; a mixed selection would
    // otherwise leave the folder silently selected and untouched.
    await deleteForever(LIB.selection.values().filter((r) => r.type !== 'folder').map((r) => r.path));
  });
  const selAssign = $('#libSelAssign');
  if (selAssign) selAssign.addEventListener('click', () => openMassAssignMenu(selAssign));
  const selDelete = $('#libSelDelete');
  if (selDelete) selDelete.addEventListener('click', async () => {
    if (librarySelectionBatchPending()) return;
    const selected = LIB.selection.values();
    if (!selected.length) return;
    if (inRemovedView()) { await restorePaths(selected.map((r) => r.path)); return; }
    // Send what every card actually has: its path, plus a pool id when there is one.
    // Main decides per photo whether that means dropping a record, marking it removed
    // in the folder index, or both — the user just asked for it to go away.
    const records = selected.map((record) => {
      const item = poolItemForRecord(record, LIB.poolBySelectionKey);
      return { path: (item && item.path) || record.path, id: (item && item.id) || '', type: record.type };
    }).filter((r) => r.path || r.id);
    if (!records.length) { syncSelectionUI(); return; }
    libraryBatchRemovePending = true;
    syncSelectionUI();
    try {
      let res;
      try { res = await window.api.libraryRemoveMany(records); }
      catch { res = { config, removed: 0, error: 'remove_failed' }; }
      config = (res && res.config) || config;
      if (!res || res.error) {
        toast(t('library.massDeleteFailed'));
        return;
      }
      // Report what main actually did, not what we asked for. A card can be on
      // screen before it reaches the folder index (fresh file, or a partial scan),
      // and then nothing was removed — saying "removed" would be a lie about a
      // destructive action, and the card stays visible after the re-render.
      // `affected` counts CARDS: summing main's internal row counts said "2" for a
      // single photo that was both a library record and a file in a watched folder.
      const affected = res.affected || 0;
      if (!affected) { toast(t('library.massDeleteFailed')); return; }
      removeSelectionSnapshot(selected);
      syncSelectionUI();
      renderLibrary();
      renderPreviews();
      renderHome();
      toastRemoved(affected, res.undo && res.undo.token);
    } finally {
      libraryBatchRemovePending = false;
      syncSelectionUI();
    }
  });
  const sortEl = $('#libSort');
  if (sortEl) {
    LIB.sort = config.librarySort || 'added';
    sortEl.value = LIB.sort;
    sortEl.addEventListener('change', async () => {
      LIB.sort = sortEl.value;
      if (LIB.sort === 'shuffle') LIB.shuffleRank = {}; // новый случайный порядок при каждом выборе
      // Note: size sort no longer pre-loads sizes synchronously here (that froze the app
      // on first click). renderLibrary paints now; missing sizes load in the background
      // and trigger one re-sort (see scheduleSizeReorder).
      config = await window.api.setConfig({ librarySort: LIB.sort });
      renderLibrary();
    });
  }
  const searchEl = $('#libSearch');
  if (searchEl) searchEl.addEventListener('input', () => { LIB.q = searchEl.value; renderLibrary(); });
  const tagSearchEl = $('#libTagSearch');
  if (tagSearchEl) tagSearchEl.addEventListener('input', () => {
    LIB.tagQuery = tagSearchEl.value;
    renderLibRailTags();
    const tagList = $('#libTags');
    if (tagList) tagList.scrollTop = 0;
  });
  const refreshBtn = $('#libRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    if (refreshBtn.classList.contains('spinning')) return;
    refreshBtn.classList.add('spinning');
    try {
      const res = await window.api.libraryRefresh();
      if (res && res.config) config = res.config;
      invalidateFolderCards();
      renderLibrary();
      renderPreviews();
      renderHome();
    } finally {
      setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
    }
  });
  const addP = $('#libAddPhotos');
  if (addP) addP.addEventListener('click', async () => {
    const res = await window.api.libraryAddImages();
    config = (res && res.config) || config;
    renderLibrary();
    if (res && res.added > 0) toast(t('toast.photosAdded', { n: res.added }));
  });
  const addF = $('#libAddFolder');
  if (addF) addF.addEventListener('click', async () => {
    const res = await window.api.libraryAddFolder();
    config = (res && res.config) || config;
    renderLibrary();
    if (res && res.added > 0) toast(t('toast.folderAdded'));
  });

  // online source selector (Cloud C2)
  const srcLumina = $('#srcLumina');
  if (srcLumina) srcLumina.addEventListener('click', () => toggleOnlineSource('lumina'));
  const srcInternet = $('#srcInternet');
  if (srcInternet) srcInternet.addEventListener('click', () => toggleOnlineSource('internet'));

  // Znada Cloud favorites toggle (C5) — shares the unified search bar.
  const favToggle = $('#onlineFavToggle');
  if (favToggle) favToggle.addEventListener('click', toggleFavoritesView);

  // Unified online search. The wh* DOM ids are retained for compatibility.
  const whSearchBtn = $('#whSearch');
  if (whSearchBtn) whSearchBtn.addEventListener('click', () => { hideOnlineTagSuggest(); doOnlineSearch(true); });
  const whQ = $('#whQuery');
  const whSuggest = $('#whSuggest');
  if (whSuggest) whSuggest.addEventListener('mousedown', (e) => e.preventDefault());
  if (whQ) {
    whQ.addEventListener('input', scheduleOnlineTagSuggest);
    whQ.addEventListener('focus', scheduleOnlineTagSuggest);
    whQ.addEventListener('blur', () => setTimeout(hideOnlineTagSuggest, 120));
    whQ.addEventListener('keydown', (e) => {
      if (handleOnlineTagSuggestKeydown(e)) return;
      if (e.key === 'Enter') {
        hideOnlineTagSuggest();
        doOnlineSearch(true);
      }
    });
  }
  const whSortEl = $('#whSort');
  if (whSortEl) whSortEl.addEventListener('change', () => {
    INTERNET.sort = whSortEl.value;
    // Changing the ordering with nothing typed is itself a request, so honour it —
    // for this visit only.
    const qEl = $('#whQuery');
    INTERNET.sortTouched = OnlineBrowse.sortTouchedAfterChange(qEl && qEl.value, INTERNET.sortTouched);
    persistOnlineParams();
    if (ONLINE.loaded) doOnlineSearch(true);
  });
  const whFilterToggle = $('#whFilterToggle');
  const whFiltersRow = $('#whFiltersRow');
  if (whFilterToggle && whFiltersRow) {
    whFilterToggle.addEventListener('click', () => {
      whFiltersRow.hidden = !whFiltersRow.hidden;
      whFilterToggle.classList.toggle('suggested', !whFiltersRow.hidden);
    });
  }

  document.querySelectorAll('.wh-purity-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const p = cb.dataset.purity;
      if (p === 'nsfw' && !INTERNET.nsfwAvailable) {
        cb.checked = false;
        toast(t('online.nsfwNeedsKey'));
        return;
      }
      INTERNET.purity[p] = cb.checked;
      // Don't allow unchecking the last category — keep at least one purity on.
      if (!INTERNET.purity.sfw && !INTERNET.purity.sketchy && !INTERNET.purity.nsfw) {
        cb.checked = true;
        INTERNET.purity[p] = true;
        return;
      }
      persistOnlineParams();
      if (ONLINE.loaded) doOnlineSearch(true);
    });
  });
  const whMoreBtn = $('#whMore');
  if (whMoreBtn) whMoreBtn.addEventListener('click', loadMoreOnline);

  initLibraryDragDrop();
}

function initLibraryDragDrop() {
  const view = $('#viewLibrary');
  const grid = $('#libGrid');
  if (!view || !grid) return;
  let dc = 0;
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((ev) => {
    view.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); }, false);
  });
  // The empty-library card is a SIBLING of the grid, so with nothing in the library the
  // grid has no height and its outline collapsed into a hairline strip floating above the
  // card the user is actually aiming at. Both get the class; the stylesheet decides which
  // one is visible, because only it knows the grid is empty.
  const empty = $('#libEmpty');
  const setDragOver = (on) => {
    grid.classList.toggle('drag-over', on);
    if (empty) empty.classList.toggle('drag-over', on);
  };
  view.addEventListener('dragenter', () => { dc++; setDragOver(true); });
  view.addEventListener('dragover', (e) => { e.dataTransfer.dropEffect = 'copy'; });
  view.addEventListener('dragleave', () => { dc--; if (dc <= 0) { dc = 0; setDragOver(false); } });
  view.addEventListener('drop', async (e) => {
    dc = 0;
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (!files || !files.length) return;
    const paths = [];
    for (let i = 0; i < files.length; i++) {
      try { const p = window.api.getPathForFile(files[i]); if (p) paths.push(p); }
      catch (err) { console.error('lib drop path:', err); }
    }
    if (!paths.length) return;
    const res = await window.api.libraryAddPaths(paths);
    config = (res && res.config) || config;
    renderLibrary();
    if (res && res.added > 0) toast(t('toast.photosAdded', { n: res.added }));
  });
}

// ---- External online providers ----
function updatePurityToggle() {
  document.querySelectorAll('.wh-purity-cb').forEach(cb => {
    const p = cb.dataset.purity;
    cb.checked = !!INTERNET.purity[p];
    if (p === 'nsfw') {
      cb.disabled = !INTERNET.nsfwAvailable;
      const lbl = $('#lblPurityNsfw');
      if (lbl) {
        lbl.style.opacity = INTERNET.nsfwAvailable ? '1' : '0.5';
        lbl.title = INTERNET.nsfwAvailable ? '' : t('online.nsfwNeedsKey');
      }
    }
  });
}

function onlineTagToken(input) {
  if (!input) return null;
  const value = String(input.value || '');
  const caret = Number.isFinite(input.selectionStart) ? input.selectionStart : value.length;
  const pos = Math.max(0, Math.min(value.length, caret));
  let start = pos;
  while (start > 0 && !/[\s,]/.test(value[start - 1])) start -= 1;
  let end = pos;
  while (end < value.length && !/[\s,]/.test(value[end])) end += 1;
  const raw = value.slice(start, end);
  const prefix = raw
    .trim()
    .toLowerCase()
    .replace(/^[-~]+/, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_()]+/g, '');
  return { start, end, raw, prefix };
}

function onlineTagSuggestAllowed(token) {
  return !!(token
    && token.prefix.length >= INTERNET_TAG_SUGGEST_MIN_LEN
    && !token.raw.includes(':'));
}

function compactOnlineTagCount(value) {
  const n = Number(value) || 0;
  if (!n) return '';
  try {
    return new Intl.NumberFormat(document.documentElement.lang || undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n);
  } catch {
    return String(n);
  }
}

function hideOnlineTagSuggest() {
  const box = $('#whSuggest');
  const input = $('#whQuery');
  INTERNET_TAG_SUGGEST.seq += 1;
  clearTimeout(INTERNET_TAG_SUGGEST.timer);
  INTERNET_TAG_SUGGEST.items = [];
  INTERNET_TAG_SUGGEST.index = -1;
  INTERNET_TAG_SUGGEST.token = null;
  if (box) {
    box.innerHTML = '';
    box.hidden = true;
  }
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
}

function setOnlineTagSuggestIndex(index) {
  const box = $('#whSuggest');
  const input = $('#whQuery');
  const items = INTERNET_TAG_SUGGEST.items;
  if (!box || !items.length) return;
  const next = ((index % items.length) + items.length) % items.length;
  INTERNET_TAG_SUGGEST.index = next;
  Array.from(box.children).forEach((el, i) => {
    const selected = i === next;
    el.classList.toggle('active', selected);
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) {
      el.scrollIntoView({ block: 'nearest' });
      if (input) input.setAttribute('aria-activedescendant', el.id);
    }
  });
}

function renderOnlineTagSuggest(items, token) {
  const box = $('#whSuggest');
  const input = $('#whQuery');
  if (!box || !input || !items || !items.length) {
    hideOnlineTagSuggest();
    return;
  }

  INTERNET_TAG_SUGGEST.items = items;
  INTERNET_TAG_SUGGEST.token = token;
  INTERNET_TAG_SUGGEST.index = -1; // nothing pre-selected: Enter searches what was typed, not the top suggestion
  box.innerHTML = '';
  items.forEach((item, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'online-tag-sug';
    btn.id = `whSuggestOpt${index}`;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', 'false');

    const name = document.createElement('span');
    name.className = 'online-tag-name';
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'online-tag-meta';
    const count = compactOnlineTagCount(item.count);
    meta.textContent = [count, item.category].filter(Boolean).join(' · ');
    btn.append(name, meta);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      applyOnlineTagSuggestion(item);
    });
    box.appendChild(btn);
  });
  input.setAttribute('aria-expanded', 'true');
  input.removeAttribute('aria-activedescendant');
  box.hidden = false;
}

async function loadOnlineTagSuggestions(token) {
  if (!onlineTagSuggestAllowed(token)) {
    hideOnlineTagSuggest();
    return;
  }
  const key = token.prefix;
  if (INTERNET_TAG_SUGGEST.cache.has(key)) {
    renderOnlineTagSuggest(INTERNET_TAG_SUGGEST.cache.get(key), token);
    return;
  }

  const seq = ++INTERNET_TAG_SUGGEST.seq;
  let res;
  try { res = await window.api.internetTagSuggest({ q: token.prefix, limit: 10 }); }
  catch { res = { items: [] }; }
  if (seq !== INTERNET_TAG_SUGGEST.seq) return;
  const items = (res && Array.isArray(res.items)) ? res.items : [];
  INTERNET_TAG_SUGGEST.cache.set(key, items);
  renderOnlineTagSuggest(items, token);
}

function scheduleOnlineTagSuggest() {
  const input = $('#whQuery');
  const token = onlineTagToken(input);
  clearTimeout(INTERNET_TAG_SUGGEST.timer);
  if (!onlineTagSuggestAllowed(token)) {
    hideOnlineTagSuggest();
    return;
  }
  if (INTERNET_TAG_SUGGEST.cache.has(token.prefix)) {
    renderOnlineTagSuggest(INTERNET_TAG_SUGGEST.cache.get(token.prefix), token);
    return;
  }
  INTERNET_TAG_SUGGEST.timer = setTimeout(() => loadOnlineTagSuggestions(token), INTERNET_TAG_SUGGEST_DEBOUNCE_MS);
}

function applyOnlineTagSuggestion(item) {
  const input = $('#whQuery');
  const token = onlineTagToken(input);
  if (!input || !token || !item || !item.name) return;

  const value = String(input.value || '');
  const marker = token.raw.startsWith('-') || token.raw.startsWith('~') ? token.raw[0] : '';
  const before = value.slice(0, token.start);
  let after = value.slice(token.end);
  let inserted = marker + item.name;
  if (!after) inserted += ' ';
  else if (!/^[\s,]/.test(after)) after = ` ${after}`;
  input.value = before + inserted + after;
  const caret = (before + inserted).length;
  input.setSelectionRange(caret, caret);
  hideOnlineTagSuggest();
  input.focus();
}

function handleOnlineTagSuggestKeydown(e) {
  const box = $('#whSuggest');
  const open = !!(box && !box.hidden && INTERNET_TAG_SUGGEST.items.length);
  if (!open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') scheduleOnlineTagSuggest();
    return false;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setOnlineTagSuggestIndex(INTERNET_TAG_SUGGEST.index + 1);
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    setOnlineTagSuggestIndex(INTERNET_TAG_SUGGEST.index - 1);
    return true;
  }
  if (e.key === 'Enter') {
    // Apply a suggestion ONLY if the user explicitly highlighted one (arrow keys).
    // Otherwise let Enter fall through and search exactly what was typed — don't
    // silently swap e.g. "loli" for the most popular "lolipop".
    if (INTERNET_TAG_SUGGEST.index < 0) return false;
    const item = INTERNET_TAG_SUGGEST.items[INTERNET_TAG_SUGGEST.index];
    if (!item) return false;
    e.preventDefault();
    applyOnlineTagSuggestion(item);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideOnlineTagSuggest();
    return true;
  }
  return false;
}

// Active online content sources (Cloud C2). Defaults to external-only and never
// returns both off, so the Online tab is never empty.
function onlineSources() {
  const s = (config && config.onlineSources) || {};
  // Ключ настроек `onlineSources.lumina` НЕ переименован намеренно: он лежит
  // в config.json у пользователей, и менять его значило бы писать миграцию ради
  // одного флажка. Список совместимости плана переименования это разрешает.
  const lumina = !!s.lumina;
  let internet = s.internet !== false;
  if (!lumina && !internet) internet = true;
  return { lumina, internet };
}

// Restore persisted Online search params (sort + purity) into INTERNET at startup.
// Sources are read live from config.onlineSources; sort/purity live in INTERNET.
function hydrateOnlineFromConfig() {
  const sort = config && config.onlineSort;
  if (['date_added', 'toplist', 'random', 'views'].includes(sort)) INTERNET.sort = sort;
  const p = config && config.onlinePurity;
  if (p && typeof p === 'object') {
    INTERNET.purity = { sfw: !!p.sfw, sketchy: !!p.sketchy, nsfw: !!p.nsfw };
    if (!INTERNET.purity.sfw && !INTERNET.purity.sketchy && !INTERNET.purity.nsfw) INTERNET.purity.sfw = true;
  }
}

// Persist the current sort + purity so they survive a restart.
function persistOnlineParams() {
  if (!config) return;
  config.onlineSort = INTERNET.sort;
  config.onlinePurity = { sfw: !!INTERNET.purity.sfw, sketchy: !!INTERNET.purity.sketchy, nsfw: !!INTERNET.purity.nsfw };
  window.api.setConfig({ onlineSort: config.onlineSort, onlinePurity: config.onlinePurity });
}

// Fetch the cloud capability once from main (safe subset: no URL/token).
async function ensureCloudCapability() {
  if (CLOUD.fetched) return;
  try { CLOUD.cap = await window.api.getCloudCapability(); }
  catch { CLOUD.cap = { environment: 'unavailable', available: false, authAvailable: false, reason: 'coming_soon' }; }
  CLOUD.fetched = true;
}

// Reflect the source selection: chip pressed-state + which panel(s) show.
function applyOnlineSourceUI(sources) {
  const lum = $('#srcLumina'), net = $('#srcInternet');
  if (lum) { lum.setAttribute('aria-pressed', sources.lumina ? 'true' : 'false'); lum.classList.toggle('active', sources.lumina); }
  if (net) { net.setAttribute('aria-pressed', sources.internet ? 'true' : 'false'); net.classList.toggle('active', sources.internet); }
  if (!sources.internet) hideOnlineTagSuggest();
}

// --- Cloud account (C4) ---
async function ensureCloudSession(force) {
  if (CLOUDAUTH.fetched && !force) return CLOUDAUTH.state;
  try { CLOUDAUTH.state = await window.api.cloudSession(); }
  catch { CLOUDAUTH.state = { available: false, signedIn: false, user: null, entitlements: [] }; }
  CLOUDAUTH.fetched = true;
  return CLOUDAUTH.state;
}


// Account strip atop the Znada Cloud panel: sign-in button / signing-in / profile + sign-out.
function renderCloudAccount() {
  const host = $('#libCloudAccount');
  if (!host) return;
  host.hidden = false;
  host.innerHTML = '';
  const s = CLOUDAUTH.state || { signedIn: false };

  if (CLOUDAUTH.signingIn) {
    const msg = document.createElement('span');
    msg.className = 'lib-cloud-acc-msg';
    msg.textContent = t('online.signingIn');
    // The way out. Abandoning the browser tab sends nothing back, so without this the
    // strip sat here for five minutes with no control on it at all, and the only cure
    // was quitting the app.
    const cancel = document.createElement('button');
    cancel.className = 'pill ghost';
    cancel.textContent = t('online.signinCancel');
    cancel.addEventListener('click', async () => {
      if (cancel.disabled) return;
      cancel.disabled = true;
      // Deliberately does NOT clear CLOUDAUTH.signingIn: the single await in
      // doCloudSignin owns that flag, and clearing it here would let a code that is
      // still in flight resolve into a window that already believes it is signed out.
      try { await window.api.cloudSigninCancel(); } catch { /* the flag clears anyway */ }
    });
    host.append(msg, cancel);
    return;
  }

  if (s.signedIn && s.user) {
    const info = document.createElement('div');
    info.className = 'lib-cloud-acc-user';
    const name = document.createElement('strong'); name.textContent = s.user.display_name || s.user.email || '';
    const email = document.createElement('small'); email.textContent = s.user.email || '';
    info.append(name, email);
    const out = document.createElement('button');
    out.className = 'pill ghost';
    out.textContent = t('online.signOut');
    out.addEventListener('click', doCloudSignout);
    host.append(info, out);
    return;
  }

  // signed out (optionally after an expiry)
  if (s.expired) {
    const exp = document.createElement('span');
    exp.className = 'lib-cloud-acc-msg';
    exp.textContent = t('online.sessionExpired');
    host.appendChild(exp);
  }
  const btn = document.createElement('button');
  btn.className = 'pill suggested';
  btn.textContent = t('online.signIn');
  btn.addEventListener('click', doCloudSignin);
  host.appendChild(btn);
}

async function doCloudSignin() {
  if (CLOUDAUTH.signingIn) return;
  CLOUDAUTH.signingIn = true;
  renderCloudAccount();
  toast(t('online.signingIn'));
  let res;
  try { res = await window.api.cloudSignin(); } catch { res = { ok: false, error: 'signin_failed' }; }
  CLOUDAUTH.signingIn = false;
  if (res && res.ok) {
    CLOUDAUTH.state = res.state; CLOUDAUTH.fetched = true;
    if (LIB.filter === 'online') {
      renderCloudAccount();
      applyFavToggleUI();
      await ensureCloudFavorites(true); // heart states before the feed renders
      if (LIB.filter === 'online') {
        ONLINE.loaded = false;
        doOnlineSearch(true); // session may unlock the explicit tier / personalize
      }
    }
    toast(t('online.signedIn'));
  } else {
    if (LIB.filter === 'online') renderCloudAccount();
    if (!res || res.error !== 'cancelled') toast(t('online.signinFailed'));
  }
}

async function doCloudSignout() {
  let res;
  try { res = await window.api.cloudSignout(); }
  catch { res = { ok: false, error: 'network', state: CLOUDAUTH.state }; }
  if (!res || res.ok === false) {
    // Signing out no longer fails because a file could not be deleted — that stranded
    // the account. What is left here is the honest failure: the request never reached
    // main at all. The session state is then unknown, so nothing account-owned is
    // cleared on a guess.
    if (res && res.state) CLOUDAUTH.state = res.state;
    CLOUDAUTH.fetched = true;
    if (LIB.filter === 'online') {
      renderCloudAccount();
      applyFavToggleUI();
    }
    toast(CardTransfer.errorMessage(t, (res && res.error) || 'network'));
    return;
  }
  CLOUDAUTH.state = (res && res.state) || { available: true, signedIn: false, user: null, entitlements: [] };
  CLOUDAUTH.fetched = true;
  CLOUDFAV.ids = new Set(); CLOUDFAV.fetched = false;
  ONLINE.view = 'search';
  if (LIB.filter === 'online') {
    renderCloudAccount();
    applyFavToggleUI();
    ONLINE.loaded = false;
    doOnlineSearch(true);
  }
  toast(t('online.signedOut'));
}

// Znada Cloud is reachable only when capability says staging/production.
function cloudAvailable() {
  const c = CLOUD.cap;
  return !!(c && c.available && (c.environment === 'staging' || c.environment === 'production'));
}

// ONL-014c. Translating the shared content filter into the catalogue’s own three ratings
// moved into that site’s own file, along with everything else peculiar to it.

// "Избранное" toggle in the search bar — only when Znada Cloud is on and signed in.
function applyFavToggleUI() {
  const btn = $('#onlineFavToggle');
  if (!btn) return;
  const sources = onlineSources();
  const show = sources.lumina && cloudAvailable() && cloudSignedIn();
  btn.hidden = !show;
  if (!show && ONLINE.view === 'favorites') ONLINE.view = 'search';
  const isFav = ONLINE.view === 'favorites';
  btn.classList.toggle('active', isFav);
  btn.setAttribute('aria-pressed', isFav ? 'true' : 'false');
}

function toggleFavoritesView() {
  ONLINE.view = ONLINE.view === 'favorites' ? 'search' : 'favorites';
  applyFavToggleUI();
  if (ONLINE.view === 'favorites') loadFavoritesFeed();
  else { ONLINE.loaded = false; doOnlineSearch(true); }
}

// --- Cloud favorites (C5): account-synced, distinct from the local Library "Избранное" ---
function cloudSignedIn() { const s = CLOUDAUTH.state; return !!(s && s.signedIn); }

async function ensureCloudFavorites(force) {
  if (!cloudSignedIn()) { CLOUDFAV.ids = new Set(); CLOUDFAV.fetched = false; return; }
  if (CLOUDFAV.fetched && !force) return;
  try {
    const res = await window.api.cloudFavorites();
    CLOUDFAV.ids = new Set(((res && res.items) || []).map((it) => it.id));
  } catch { CLOUDFAV.ids = new Set(); }
  CLOUDFAV.fetched = true;
}

function onlineGridDescriptor(kind, item) {
  if (kind === 'cloud') {
    return {
      key: `cloud:${item.id}`,
      kind,
      item,
      aspect: item.width && item.height ? item.width / item.height : 1.6,
      galleryItem: galleryItemFromCloud(item),
      selectableId: null,
    };
  }
  const identity = item.id || item.page || item.full || item.thumb;
  return {
    key: `internet:${item.provider || 'source'}:${identity}`,
    kind: 'internet',
    item,
    aspect: item.width && item.height ? item.width / item.height : 1.6,
    galleryItem: galleryItemFromInternet(item),
    selectableId: null,
  };
}

function buildOnlineGridCard(entry) {
  return entry.kind === 'cloud' ? buildCloudCard(entry.item) : buildInternetCard(entry.item);
}

const ONLINE_GRID_ADAPTER = {
  kind: 'online',
  buildCard: (entry) => buildOnlineGridCard(entry),
  bindCard: (card, entry) => bindUnifiedGalleryCard(card, entry),
};

function renderOnlineEntries(opts = {}) {
  const grid = $('#whGrid');
  if (!grid) return null;
  // A fresh feed has a different numeric index space. Drop any resize settle
  // callback/anchor from the previous feed before its controller is replaced.
  if (opts.fresh) resetLibObservers(grid);
  return mountUnifiedGrid(grid, ONLINE.entries, ONLINE_GRID_ADAPTER, { preserveAnchor: !opts.fresh });
}

function replaceOnlineEntries(entries, opts = {}) {
  ONLINE.entries = Array.isArray(entries) ? entries : [];
  return renderOnlineEntries(opts);
}

function appendOnlineEntries(entries) {
  const known = new Set(ONLINE.entries.map((entry) => entry.key));
  const extra = [];
  for (const entry of (entries || [])) {
    if (!entry || !entry.key || known.has(entry.key)) continue;
    known.add(entry.key);
    extra.push(entry);
  }
  if (extra.length) ONLINE.entries = ONLINE.entries.concat(extra);
  renderOnlineEntries();
  return extra.length;
}

function removeOnlineEntry(key) {
  const next = ONLINE.entries.filter((entry) => entry.key !== key);
  if (next.length === ONLINE.entries.length) return false;
  ONLINE.entries = next;
  renderOnlineEntries();
  return true;
}

// The account's Znada Cloud favorites, shown in the same shared grid (a distinct mode).
async function loadFavoritesFeed() {
  const generation = ++ONLINE.generation;
  ONLINE.loading = true;
  const note = $('#whNote'); const more = $('#whMore');
  if (more) more.hidden = true;
  replaceOnlineEntries([], { fresh: true });
  if (note) note.textContent = t('online.loading');
  let res;
  try { res = await window.api.cloudFavorites(); } catch { res = { error: 'network' }; }
  if (LIB.filter !== 'online' || generation !== ONLINE.generation || ONLINE.view !== 'favorites') return;
  ONLINE.loading = false;
  if (!res || res.error) {
    // BUG-030. A server that never answered is not the same as having no connection —
    // saying "no internet" while the browser plainly works sends the user to check the
    // wrong thing. The client tells the two apart now, so this does too.
    if (note) note.textContent = CardTransfer.errorMessage(t, res && res.error);
    setLibViewHeader(0);
    return;
  }
  CLOUDFAV.ids = new Set((res.items || []).map((it) => it.id)); CLOUDFAV.fetched = true;
  replaceOnlineEntries((res.items || []).map((item) => onlineGridDescriptor('cloud', item)));
  const n = ONLINE.entries.length;
  setLibViewHeader(n);
  if (note) note.textContent = n ? '' : t('online.favEmpty');
}

// ONL-014c. The catalogue used to be fetched here, separately, with its own cursor and
// its own idea of when there was more. It is a site in the same registry now, so its
// cards arrive in the same answer as everyone else's and this loader is gone with it.

// ONL-008. One control for BOTH kinds of online card: "+" downloads the photo into the
// library, "✓" takes it back out. Which of the two it is comes from src/online-add.js
// (it knows the "znada:"/"lumina:" and page-URL markers); this only draws the answer and
// calls the IPC.
//
// Adding is unchanged. Removing goes through the SAME `library-remove-many` the Library
// tab uses, so the photo lands in the trash with a working Undo. Nothing is deleted from
// disk here — that stays off in production.
function attachOnlineAddButton(card, kind, item, addFn) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lib-menu-btn wh-add';
  const glyph = document.createElement('span');
  glyph.className = 'wh-add-glyph';
  // The way back out only has to be legible while the pointer (or focus) is on the
  // button, so the "added" badge stays a badge and still says how to undo itself.
  const undoGlyph = document.createElement('span');
  undoGlyph.className = 'wh-add-undo';
  undoGlyph.textContent = '−';
  btn.append(glyph, undoGlyph);

  const sync = (pool) => {
    const state = OnlineAdd.buttonState(pool || (config && config.library) || {}, kind, item);
    glyph.textContent = state.glyph;
    btn.classList.toggle('added', state.added);
    btn.title = t(state.titleKey);
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', state.added ? 'true' : 'false');
    return state;
  };
  // Re-derivable from the pool at any moment. An Undo, or a second card showing the same
  // photo, has to be able to put every mounted button back in step — the state is the
  // library's, not the button's.
  card.__syncOnlineAdd = sync;
  sync();

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    const state = sync();
    btn.disabled = true;
    try {
      if (state.action === 'remove') await removeOnlineFromLibrary(state.pooled);
      else await addOnlineToLibrary(addFn);
    } finally {
      btn.disabled = false;
      refreshOnlineAddedState();
    }
  });
  card.appendChild(btn);
  return btn;
}

async function addOnlineToLibrary(addFn) {
  let res;
  try { res = await addFn(); } catch { res = { error: 'download' }; }
  if (res && res.config) config = res.config;
  if (!res || res.error) { toast(CardTransfer.errorMessage(t, res && res.error)); return false; }
  toast(t('online.added'));
  refreshPoolDependentChrome();
  return true;
}

async function removeOnlineFromLibrary(pooled) {
  const payload = OnlineAdd.removalPayload(pooled);
  if (!payload) { toast(t('library.massDeleteFailed')); return false; }
  let res;
  try { res = await window.api.libraryRemoveMany(payload); }
  catch { res = null; }
  if (!res || res.error || !res.affected) { toast(t('library.massDeleteFailed')); return false; }
  config = res.config || config;
  refreshPoolDependentChrome();
  toastRemoved(res.affected, res.undo && res.undo.token);
  return true;
}

// What outside the Online grid can go stale when a photo enters or leaves the pool.
// The Library grid itself is NOT in this list on purpose: leaving the Online tab tears
// it down and builds it again, and re-rendering it from here would refetch the feed.
function refreshPoolDependentChrome() {
  renderLibRailTags();
  renderPreviews();
  renderHome();
}

// Every mounted online card re-asks the pool. One index for the whole pass: otherwise
// each card would walk the entire library.
function refreshOnlineAddedState() {
  const grid = $('#whGrid');
  if (!grid) return;
  const index = OnlineAdd.sourceIndex((config && config.library) || {});
  grid.querySelectorAll('.lib-card').forEach((card) => {
    if (typeof card.__syncOnlineAdd === 'function') card.__syncOnlineAdd(index);
  });
}

function buildCloudCard(item) {
  const card = document.createElement('div');
  card.className = 'lib-card';
  makeLibCardFocusable(card);
  setLibCardAspect(card, item.width && item.height ? item.width / item.height : 1.6);
  card.__galleryItem = galleryItemFromCloud(item);
  const thumb = cloudThumbUrl(item);
  if (thumb) card.style.backgroundImage = `url("${thumb}")`;
  const label = [item.width && item.height ? `${item.width}×${item.height}` : '', item.title].filter(Boolean).join(' · ');
  card.title = item.title || '';
  attachOnlineAddButton(card, 'cloud', item, () => window.api.cloudAdd(item));
  bindOnlineCardContextMenu(card, 'cloud', item);

  // Cloud favorite heart (account-synced; signed-in only). Distinct from the local
  // Library "Избранное" (a star on local cards).
  if (cloudSignedIn()) {
    const fav = document.createElement('button');
    const setFavUi = () => {
      const on = CLOUDFAV.ids.has(item.id);
      fav.className = 'lib-menu-btn cloud-fav' + (on ? ' on' : '');
      fav.title = t(on ? 'online.favRemove' : 'online.favAdd');
    };
    fav.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 14s-5.2-3.3-6.7-6.2C.2 5.3 1.5 3 3.8 3c1.4 0 2.3.8 2.9 1.6.3.4.6.4.9 0C8.2 3.8 9.1 3 10.5 3c2.3 0 3.6 2.3 2.5 4.8C12 10.7 8 14 8 14z"/></svg>';
    setFavUi();
    fav.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (fav.disabled) return;
      const on = !CLOUDFAV.ids.has(item.id);
      fav.disabled = true;
      let res;
      try { res = await window.api.cloudFavorite(item.id, on); } catch { res = { ok: false, error: 'network' }; }
      fav.disabled = false;
      if (res && res.ok) {
        if (on) CLOUDFAV.ids.add(item.id); else CLOUDFAV.ids.delete(item.id);
        if (!on && LIB.filter === 'online' && ONLINE.view === 'favorites') {
          removeOnlineEntry(`cloud:${item.id}`);
          const left = ONLINE.entries.length;
          const note = $('#whNote');
          if (!left && note) note.textContent = t('online.favEmpty');
          setLibViewHeader(left);
          return;
        }
        setFavUi();
      } else { toast(CardTransfer.errorMessage(t, res && res.error)); }
    });
    card.appendChild(fav);
  }

  card.addEventListener('mouseenter', () => setLibStatus(label || t('online.sourceLumina')));
  card.addEventListener('click', () => openGalleryFromCard(card, card.__galleryItem));
  return card;
}

async function renderOnline() {
  const renderEpoch = ++ONLINE.renderEpoch;
  await ensureCloudCapability();
  if (LIB.filter !== 'online' || renderEpoch !== ONLINE.renderEpoch) return;
  const sources = onlineSources();
  const sourceSignature = `${sources.lumina ? 1 : 0}${sources.internet ? 1 : 0}`;
  const isCurrent = () => {
    const current = onlineSources();
    return LIB.filter === 'online'
      && renderEpoch === ONLINE.renderEpoch
      && `${current.lumina ? 1 : 0}${current.internet ? 1 : 0}` === sourceSignature;
  };
  applyOnlineSourceUI(sources);
  await refreshOnlineAccount(sources, isCurrent);
  if (!isCurrent()) return;
  if (sources.internet && !INTERNET.statusFetched) {
    try { const st = await window.api.internetStatus(); INTERNET.nsfwAvailable = !!st.nsfwAvailable; }
    catch { INTERNET.nsfwAvailable = false; }
    if (!isCurrent()) return;
    INTERNET.statusFetched = true;
  }
  updatePurityToggle();
  const sortEl = $('#whSort'); if (sortEl && sortEl.value !== INTERNET.sort) sortEl.value = INTERNET.sort;
  if (ONLINE.view === 'favorites') { loadFavoritesFeed(); return; }
  if (!ONLINE.loaded) { doOnlineSearch(true); return; }
  setLibViewHeader(ONLINE.entries.length);
}

// Account chip + favorites toggle reflect the session (only when Znada Cloud is reachable).
async function refreshOnlineAccount(sources, isCurrent = () => true) {
  const acc = $('#libCloudAccount');
  if (!(sources.lumina && cloudAvailable())) {
    if (acc) acc.hidden = true;
    applyFavToggleUI();
    return;
  }
  await ensureCloudSession();
  if (!isCurrent()) return;
  renderCloudAccount();
  applyFavToggleUI();
  if (cloudSignedIn()) {
    await ensureCloudFavorites();
    if (!isCurrent()) return;
  }
}

// Toggle a content source on/off (keeps at least one on), persist, re-search.
function toggleOnlineSource(key) {
  const cur = onlineSources();
  const next = { lumina: cur.lumina, internet: cur.internet };
  next[key] = !next[key];
  if (!next.lumina && !next.internet) return; // never leave the tab empty
  config.onlineSources = next;
  window.api.setConfig({ onlineSources: next });
  ONLINE.generation += 1; // cancel pages still arriving from the previous source mix
  ONLINE.loading = false;
  ONLINE.loaded = false;
  renderOnline();
}

// Unified search: one query + content filter drives every active source into #whGrid.
async function doOnlineSearch(reset) {
  if (LIB.filter !== 'online') return;
  hideOnlineTagSuggest();
  const generation = ++ONLINE.generation;
  ONLINE.view = 'search';
  applyFavToggleUI();
  const qEl = $('#whQuery'); INTERNET.q = (qEl && qEl.value || '').trim();
  INTERNET.sortTouched = OnlineBrowse.sortTouchedAfterSearch(INTERNET.q, INTERNET.sortTouched);
  const note = $('#whNote'); const more = $('#whMore');
  if (reset) {
    // ONL-014b. One bookmark object for every site at once, and a fresh search drops
    // it: the bookmarks belong to the question that was asked.
    INTERNET.resume = null;
    ONLINE.loaded = true;
    replaceOnlineEntries([], { fresh: true });
  }
  ONLINE.loading = true; if (more) more.disabled = true;
  if (note) note.textContent = t('online.loading');

  // ONL-014c. One request for every source at once. Which of them are asked is decided
  // in main from what each site declared and which switches are on.
  // The release below is the ONLY thing that lets this tab work again, and it used to sit
  // behind a bare `await`. Anything thrown while publishing a page — the grid, the header,
  // the note — skipped it, and then `ONLINE.loading` stayed true forever: "Show more"
  // refuses while it is set, and `ONLINE.loaded` is already true so coming back to the tab
  // does not search again. Only switching to a local rail cleared it, because that path
  // resets the flag by hand. Caught here rather than wrapped in `finally`, because a
  // failure the user cannot see is the other half of the same problem.
  let failed = null;
  try {
    await publishOnlineBatch(loadInternetResults(generation), generation);
  } catch (err) { failed = err; }
  // Still not ours to release if a newer search or the favorites view took over: whoever
  // owns the flag now will clear it.
  if (!onlineSearchIsCurrent(generation)) return;

  ONLINE.loading = false; if (more) more.disabled = false;
  if (failed) {
    console.error('online search:', failed);
    if (note) note.textContent = t('online.error', { e: 'render' });
    return;
  }
  finalizeOnlineFeed();
}

// Append one Internet page (Wallhaven + Gelbooru/Danbooru, merged in main) into #whGrid.
async function loadInternetResults(generation) {
  let res;
  const browse = OnlineBrowse.isBrowse(INTERNET);
  try { res = await window.api.internetSearch({ q: INTERNET.q, sort: INTERNET.sort, purity: INTERNET.purity, resume: INTERNET.resume, browse }); }
  catch { res = { error: 'network' }; }
  if (!onlineSearchIsCurrent(generation)) return [];
  INTERNET.searched = true;
  if (res && typeof res.nsfwAvailable !== 'undefined') { INTERNET.nsfwAvailable = !!res.nsfwAvailable; updatePurityToggle(); }
  // Main records one strike per failed provider even when the merged round is an error.
  // Carry that replacement token before returning: otherwise every click sends the old
  // zero-strike token and a dead source keeps “Show more” alive forever. A transport
  // exception has no `resume` field, so it still keeps the old place.
  // The token is carried, never read: what is inside belongs to main.
  if (res && Object.prototype.hasOwnProperty.call(res, 'resume')) {
    INTERNET.resume = res.resume || null;
  }
  if (!res || res.error) return [];
  // ONL-014c. The kind comes from the CARD, not from which call fetched it — the same
  // reason it already carries whether a window may load its picture directly.
  return (res.items || []).map((item) => onlineGridDescriptor(item.cardKind === 'cloud' ? 'cloud' : 'internet', item));
}

function onlineSearchIsCurrent(generation) {
  return LIB.filter === 'online'
    && generation === ONLINE.generation
    && ONLINE.view === 'search';
}

async function publishOnlineBatch(task, generation) {
  let entries;
  try { entries = await task; } catch { entries = []; }
  if (!onlineSearchIsCurrent(generation)) return [];
  const batch = Array.isArray(entries) ? entries : [];
  if (batch.length) {
    appendOnlineEntries(batch);
    setLibViewHeader(ONLINE.entries.length);
    const note = $('#whNote');
    if (note) note.textContent = '';
  }
  return batch;
}

// Note + "more" button + header for the current shared grid.
function finalizeOnlineFeed() {
  const note = $('#whNote'); const more = $('#whMore');
  const n = ONLINE.entries.length;
  setLibViewHeader(n);
  if (note) note.textContent = n ? '' : t('online.noResults');
  const hasMore = !!INTERNET.resume;
  if (more) more.hidden = !hasMore;
}

// "Показать ещё" advances every active source that still has a next page.
async function loadMoreOnline() {
  if (LIB.filter !== 'online' || ONLINE.loading || ONLINE.view === 'favorites') return;
  const more = $('#whMore'); if (more) more.disabled = true;
  ONLINE.loading = true;
  const generation = ONLINE.generation;
  // Same reason as in doOnlineSearch: a throw here would leave the button disabled and
  // the flag set, and this is the very button that would have to clear them.
  let failed = null;
  try {
    if (INTERNET.resume) await publishOnlineBatch(loadInternetResults(generation), generation);
  } catch (err) { failed = err; }
  if (!onlineSearchIsCurrent(generation)) return;
  ONLINE.loading = false; if (more) more.disabled = false;
  if (failed) {
    console.error('online more:', failed);
    const note = $('#whNote');
    if (note) note.textContent = t('online.error', { e: 'render' });
    return;
  }
  finalizeOnlineFeed();
}

function setInternetCardThumbnail(card, item) {
  if (!item.thumb) return;
  // ONL-012: the card says whether its site can be loaded straight from here.
  if (item.loadsDirectly) {
    card.style.backgroundImage = `url("${item.thumb}")`;
    return;
  }
  window.api.internetThumbnail(item).then((result) => {
    if (result && result.dataUrl) card.style.backgroundImage = `url("${result.dataUrl}")`;
  }).catch(() => {});
}

function buildInternetCard(item) {
  const card = document.createElement('div');
  card.className = 'lib-card';
  card.dataset.provider = item.provider || '';
  makeLibCardFocusable(card);
  setLibCardAspect(card, item.width && item.height ? item.width / item.height : 1.6);
  card.__galleryItem = galleryItemFromInternet(item);
  setInternetCardThumbnail(card, item);
  const label = [item.resolution, item.category].filter(Boolean).join(' · ');
  card.title = label;
  attachOnlineAddButton(card, 'internet', item, () => window.api.internetAdd(item, INTERNET.q));
  bindOnlineCardContextMenu(card, 'internet', item);
  card.addEventListener('mouseenter', () => setLibStatus(label || t('online.source')));
  card.addEventListener('click', () => openGalleryFromCard(card, card.__galleryItem));
  return card;
}

// ---------------------------------------------------------------------------
// Page navigation (Home / Settings)
// ---------------------------------------------------------------------------
function showPage(name) {
  const views = { home: 'viewHome', library: 'viewLibrary', design: 'viewDesign', prefs: 'viewPrefs' };
  const target = views[name] || 'viewHome';
  const page = document.querySelector('.page');
  // All tabs share one .page scroll container, so remember the outgoing tab's
  // position and restore the incoming one — otherwise switching tabs clamps/loses it.
  if (page && Object.prototype.hasOwnProperty.call(pageScroll, activePage)) pageScroll[activePage] = page.scrollTop;
  if (page) {
    page.classList.toggle('library-page', name === 'library');
    page.classList.toggle('home-page', name === 'home');
  }
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== target; });
  document.querySelectorAll('.navbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === name);
  });
  const gear = $('#btnPrefs');
  if (gear) gear.classList.toggle('active', name === 'prefs');
  activePage = name;
  const endSwitch = diagSpan('renderer', 'page-switch'); // budget span #7

  if (name === 'home') {
    renderHome();
  } else if (name === 'library') {
    // Returning to a Library tab whose view + contents are unchanged reuses the
    // already-rendered grid (keeps scroll + loaded thumbnails). Rebuild only when
    // something actually changed, a live-folder refresh is pending, or it's Online.
    const grid = $('#libGrid');
    const upToDate = grid && grid.childElementCount > 0 && !deferredLiveRefresh.has('library')
      && LIB.filter !== 'online' && libRenderKey() === lastLibRenderKey;
    if (!upToDate) renderLibrary(); // a rebuild (changed view) resets pageScroll.library to 0
    scheduleAllLibraryLayouts();
  } else if (name === 'design') {
    renderPreviews();   // reflect current config
    layoutMonitors();   // stages just became visible — refit thumbnails
  } else if (name === 'prefs') {
    renderEventLog();   // journal is cheap to refresh on every visit
  }

  if (page) page.scrollTop = pageScroll[name] || 0;
  syncHomeCountdownTimer(); // уход с Главной гасит отсчёт, возврат — поднимает
  endSwitch({ label: name });
}

// Event journal (settings page): recent background failures/recoveries. Entries store
// i18n KEYS + params, so history re-renders correctly after a language switch.
async function renderEventLog() {
  const list = $('#eventLogList');
  if (!list) return;
  let entries = [];
  try {
    const res = await window.api.eventLogGet();
    entries = (res && res.entries) || [];
  } catch {}
  list.innerHTML = '';
  if (!entries.length) {
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('div');
    text.className = 'row-text';
    const sub = document.createElement('div');
    sub.className = 'row-sub';
    sub.textContent = t('journal.empty');
    text.appendChild(sub);
    row.appendChild(text);
    list.appendChild(row);
    return;
  }
  for (const en of entries) {
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('div');
    text.className = 'row-text';
    const title = document.createElement('div');
    title.className = 'row-title';
    const base = t(en.messageKey, en.params || {});
    title.textContent = en.kind === 'recovered'
      ? `✓ ${base} — ${t('journal.recoveredNote')}`
      : `⚠ ${base} — ${t('journal.failedNote')}`;
    const sub = document.createElement('div');
    sub.className = 'row-sub';
    sub.textContent = new Date(en.atMs).toLocaleString();
    text.appendChild(title);
    text.appendChild(sub);
    row.appendChild(text);
    list.appendChild(row);
  }
}

// First-run welcome screen (one-time).
function enterFirstRun() {
  document.body.classList.add('first-run');
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'viewWelcome'; });
  $('#welcomeLang').value = config.language || 'system';
  setSwitch($('#welcomeAuto'), !!(config.wallpaperSchedule && config.wallpaperSchedule.mode !== 'off'));
  setSwitch($('#welcomeStartup'), config.autostart);
  setSwitch($('#welcomeTheme'), !!(config.themeSchedule && config.themeSchedule.mode !== 'off'));
  updateShortcutButtons();
}

function exitFirstRun() {
  document.body.classList.remove('first-run');
  showPage('home');
}

// Reflect whether shortcuts already exist: disable the button + show "Created".
async function updateShortcutButtons() {
  let st = { desktop: false, startmenu: false };
  try { st = await window.api.shortcutsStatus(); } catch {}
  const apply = (btn, exists) => {
    if (!btn) return;
    btn.disabled = !!exists;
    btn.classList.toggle('done', !!exists);
    btn.textContent = exists ? t('welcome.shortcutDone') : t('welcome.shortcutsBtn');
  };
  apply($('#welcomeShortcutDesktop'), st.desktop);
  apply($('#welcomeShortcutStart'), st.startmenu);
}

// Home dashboard: current wallpaper per monitor (active theme) + status.
// Кнопка «Сменить обои» на Главной активна, когда есть что листать (слайдшоу включено,
// либо в плейлисте текущей темы ≥2 кадров / есть папка-источник).
function hasNextWallpaper(monitorId = null) {
  if (config.slideshow && config.slideshow.enabled) return true;
  const th = wallTheme();
  const monitorConfigs = monitorId
    ? [config.monitors && config.monitors[monitorId]]
    : Object.values(config.monitors || {});
  for (const m of monitorConfigs) {
    const slot = m && m[th];
    if (!slot || !Array.isArray(slot.itemIds)) continue;
    if (slot.itemIds.length >= 2) return true;
    for (const id of slot.itemIds) {
      const it = (config.library || {})[id];
      if (it && it.type === 'folder') return true;
    }
  }
  return false;
}

function homeMonitorNumber(monitor) {
  return monitorList.findIndex((m) => m.id === monitor.id) + 1;
}

function homePageSize() {
  const stage = $('#homeMonitors');
  const width = stage ? stage.clientWidth : window.innerWidth;
  if (width >= 510) return 3;
  if (width >= 320) return 2;
  return 1;
}

function homeMonitorPages() {
  const perPage = homePageSize();
  const ordered = [...monitorList].sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const primaryIndex = ordered.findIndex((m) => m.primary);
  if (primaryIndex >= 0) {
    const [primary] = ordered.splice(primaryIndex, 1);
    ordered.splice(Math.min(perPage >= 3 ? 1 : 0, ordered.length), 0, primary);
  }
  const pages = [];
  for (let i = 0; i < ordered.length; i += perPage) pages.push(ordered.slice(i, i + perPage));
  return pages.length ? pages : [[]];
}

function homePageLabel(monitors) {
  const numbers = monitors.map(homeMonitorNumber).filter((n) => n > 0).sort((a, b) => a - b);
  if (!numbers.length) return '';
  if (numbers.length === 1) return t('home.monitorSingle', { n: numbers[0] });
  const contiguous = numbers.every((number, index) => index === 0 || number === numbers[index - 1] + 1);
  const range = contiguous ? `${numbers[0]}–${numbers[numbers.length - 1]}` : numbers.join(', ');
  return t('home.monitorRange', { range });
}

function homeAutomationCopy() {
  const slideshow = config.slideshow || {};
  if (slideshow.enabled) {
    // Живая подпись строится ТОЛЬКО из состояния, присланного main.
    const live = window.NextChange && window.NextChange.label(nextChangeState, Date.now());
    if (live) return { title: t('home.automaticChange'), detail: t(live.key, live.params) };
    // До первого ответа main (и если модуль не загрузился) остаётся прежний текст про
    // настройку: он говорит о значении интервала и ничего не обещает про момент.
    if (slideshow.intervalEnabled !== false) {
      return {
        title: t('home.automaticChange'),
        detail: t('home.everyMinutes', { n: Math.max(1, Math.floor(Number(slideshow.intervalMin) || 30)) }),
      };
    }
    return { title: t('home.automaticChange'), detail: t('home.eventTriggers') };
  }

  const schedule = config.wallpaperSchedule || {};
  if (config.separateThemes !== false && schedule.mode && schedule.mode !== 'off') {
    const detailKeys = { system: 'home.followWindows', time: 'home.byTime', sun: 'home.bySun' };
    return { title: t('home.automaticTheme'), detail: t(detailKeys[schedule.mode] || 'home.followWindows') };
  }
  return { title: t('home.manualChange'), detail: t('home.manualControl') };
}

// Отдельно от updateHomeInfo(), потому что отсчёт перерисовывается сам по себе —
// раз в несколько секунд, без участия остальной Главной.
function renderHomeAutomation(automation = homeAutomationCopy()) {
  const title = $('#homeAutoTitle');
  const detail = $('#homeAutoDetail');
  if (!title || !detail) return;
  title.textContent = automation.title;
  detail.textContent = automation.detail;
  syncHomeCountdownTimer();
}

// Шаг перерисовки задаёт main-модуль, а таймер перевзводится после каждой отрисовки:
// как только состояние перестаёт быть отсчётом (пауза, событийный режим, уход с
// Главной, сворачивание в трей), он просто не встаёт заново.
function syncHomeCountdownTimer() {
  if (homeCountdownTimer) { clearTimeout(homeCountdownTimer); homeCountdownTimer = null; }
  const view = $('#viewHome');
  if (!window.NextChange || !view || view.hidden || document.hidden) return;
  const delay = window.NextChange.tickMs(nextChangeState, Date.now());
  if (delay > 0) homeCountdownTimer = setTimeout(() => renderHomeAutomation(), delay);
}

// Момент следующей смены знает только main; при открытии Главной и возврате окна из
// трея переспрашиваем его, чтобы не показывать состояние, устаревшее за время скрытия.
async function refreshNextChange() {
  if (!window.api.getNextChange) return;
  try {
    nextChangeState = await window.api.getNextChange();
  } catch { return; }
  renderHomeAutomation();
}

function updateHomeInfo() {
  const selected = monitorList.find((m) => m.id === homeSelectedMonitorId) || null;
  const title = $('#homeInfoTitle');
  const meta = $('#homeInfoMeta');
  const nextLabel = $('#homeNextLabel');
  const nextButton = $('#btnNextWall');
  const automation = homeAutomationCopy();

  if (selected) {
    const n = homeMonitorNumber(selected);
    title.textContent = t('monitor.label', { n });
    meta.textContent = fmtResolution(selected) + (selected.primary ? ` · ${t('monitor.primary')}` : '');
    nextLabel.textContent = config.singleWallpaper ? t('home.switchAll') : t('home.switchThis');
  } else {
    title.textContent = t('home.allMonitors');
    meta.textContent = t('home.generalMode');
    nextLabel.textContent = t('home.switchAll');
  }

  renderHomeAutomation(automation);
  const targetMonitorId = selected && !config.singleWallpaper ? selected.id : null;
  nextButton.disabled = !hasNextWallpaper(targetMonitorId);
  nextButton.title = nextButton.disabled ? t('home.noNextWallpaper') : t('home.nextWallpaperHint');
}

function sizeHomeDisplays(monitors) {
  const stage = $('#homeMonitors');
  const buttons = [...stage.querySelectorAll('.home-display')];
  if (!buttons.length) return;
  const gapSize = Number.parseFloat(getComputedStyle(stage).columnGap) || 0;
  const gap = buttons.length > 1 ? gapSize * (buttons.length - 1) : 0;
  const availableWidth = Math.max(180, stage.clientWidth - gap - 4);
  const availableHeight = Math.max(120, stage.clientHeight - 16);
  const primaryHeight = Math.min(220, availableHeight * 0.92);
  const dimensions = monitors.map((m) => {
    const aspect = Math.max(0.48, Math.min(2.45, m.h ? m.w / m.h : 16 / 9));
    const height = primaryHeight * (m.primary ? 1 : 0.74);
    return { primary: !!m.primary, aspect, height, width: height * aspect };
  });

  let totalWidth = dimensions.reduce((sum, d) => sum + d.width, 0);
  if (totalWidth < availableWidth) {
    const secondary = dimensions.filter((d) => !d.primary);
    const aspectSum = secondary.reduce((sum, d) => sum + d.aspect, 0);
    const maxSecondaryHeight = primaryHeight * 0.92;
    const sharedGrowth = aspectSum > 0
      ? Math.min(maxSecondaryHeight - primaryHeight * 0.74, (availableWidth - totalWidth) / aspectSum)
      : 0;
    secondary.forEach((d) => {
      d.height += Math.max(0, sharedGrowth);
      d.width = d.height * d.aspect;
    });
    totalWidth = dimensions.reduce((sum, d) => sum + d.width, 0);
  }

  const scale = Math.min(1, availableWidth / Math.max(1, totalWidth));
  buttons.forEach((button, index) => {
    button.style.setProperty('--display-w', `${Math.max(42, Math.round(dimensions[index].width * scale))}px`);
    button.style.setProperty('--display-h', `${Math.max(58, Math.round(dimensions[index].height * scale))}px`);
  });
}

async function homeWallpaperUrl(monitor) {
  if (!monitor) return '';
  const cacheKey = `${monitor.id}|${wallTheme()}`;
  const path = await window.api.currentImage(monitor.id, wallTheme());
  const url = path ? await window.api.fileUrl(path) : '';
  homeWallpaperCache.set(cacheKey, url);
  return url;
}

function applyHomeDisplayWallpaper(wallpaper, url) {
  const empty = wallpaper.parentElement.querySelector('.home-display-empty');
  if (!url) {
    wallpaper.style.backgroundImage = '';
    wallpaper.classList.add('empty');
    if (empty) empty.hidden = false;
    return;
  }
  const css = STYLE_CSS[config.style] || STYLE_CSS.fill;
  wallpaper.style.backgroundImage = `url("${url}")`;
  wallpaper.style.backgroundSize = css.size;
  wallpaper.style.backgroundRepeat = css.repeat;
  wallpaper.style.backgroundPosition = css.position;
  wallpaper.classList.remove('empty');
  if (empty) empty.hidden = true;
}

async function loadHomeDisplayWallpaper(monitor, wallpaper, version) {
  try {
    const url = await homeWallpaperUrl(monitor);
    if (version !== homeRenderVersion || !wallpaper.isConnected) return;
    applyHomeDisplayWallpaper(wallpaper, url);
  } catch {
    if (version === homeRenderVersion && wallpaper.isConnected) applyHomeDisplayWallpaper(wallpaper, '');
  }
}

async function updateHomeBackdrop() {
  const version = ++homeBackdropVersion;
  const selected = monitorList.find((m) => m.id === homeSelectedMonitorId);
  const primary = monitorList.find((m) => m.primary) || monitorList[0];
  try {
    const url = await homeWallpaperUrl(selected || primary);
    if (version !== homeBackdropVersion) return;
    $('#homeBackdrop').style.backgroundImage = url ? `url("${url}")` : '';
  } catch {
    if (version === homeBackdropVersion) $('#homeBackdrop').style.backgroundImage = '';
  }
}

function selectHomeMonitor(monitorId) {
  homeSelectedMonitorId = monitorId;
  document.querySelectorAll('.home-display').forEach((button) => {
    const selected = button.dataset.monitorId === monitorId;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  updateHomeInfo();
  updateHomeBackdrop();
}

function renderHomePager(pages) {
  const pager = $('#homePager');
  const scene = $('#homeScene');
  pager.setAttribute('aria-label', t('home.monitorPages'));
  const lastPage = Math.max(0, pages.length - 1);
  homePage = Math.max(0, Math.min(homePage, lastPage));
  pager.innerHTML = '';
  const hasPager = pages.length > 1;
  pager.hidden = !hasPager;
  scene.classList.toggle('has-pager', hasPager);
  if (!hasPager) return;

  const left = document.createElement('div');
  left.className = 'home-pager-side';
  if (homePage > 0) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `‹ ${homePageLabel(pages[homePage - 1])}`;
    button.addEventListener('click', () => { homePage--; homeSelectedMonitorId = null; renderHome(); });
    left.appendChild(button);
  } else {
    const current = document.createElement('span');
    current.className = 'current';
    current.textContent = homePageLabel(pages[homePage]);
    left.appendChild(current);
  }

  const dots = document.createElement('div');
  dots.className = 'home-page-dots';
  pages.forEach((_, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'home-page-dot' + (index === homePage ? ' active' : '');
    dot.title = t('home.pageLabel', { n: index + 1 });
    dot.setAttribute('aria-label', dot.title);
    dot.addEventListener('click', () => { homePage = index; homeSelectedMonitorId = null; renderHome(); });
    dots.appendChild(dot);
  });

  const right = document.createElement('div');
  right.className = 'home-pager-side';
  if (homePage < lastPage) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${homePageLabel(pages[homePage + 1])} ›`;
    button.addEventListener('click', () => { homePage++; homeSelectedMonitorId = null; renderHome(); });
    right.appendChild(button);
  } else if (homePage > 0) {
    const current = document.createElement('span');
    current.className = 'current';
    current.textContent = homePageLabel(pages[homePage]);
    right.appendChild(current);
  }

  pager.append(left, dots, right);
}

function renderHome() {
  if (!config) return;
  const version = ++homeRenderVersion;
  const wrap = $('#homeMonitors');
  const pages = homeMonitorPages();
  const selectedPage = homeSelectedMonitorId
    ? pages.findIndex((page) => page.some((monitor) => monitor.id === homeSelectedMonitorId))
    : -1;
  homePage = selectedPage >= 0 ? selectedPage : Math.max(0, Math.min(homePage, pages.length - 1));
  const visibleMonitors = pages[homePage];
  wrap.innerHTML = '';

  if (!visibleMonitors.length) {
    wrap.innerHTML = `<div class="home-empty">${t('home.noMonitors')}</div>`;
  } else {
    visibleMonitors.forEach((monitor) => {
      const n = homeMonitorNumber(monitor);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'home-display'
        + (monitor.w < monitor.h ? ' portrait' : '')
        + (monitor.id === homeSelectedMonitorId ? ' selected' : '');
      button.dataset.monitorId = monitor.id;
      button.title = t('home.monitorDetails', { n });
      button.setAttribute('aria-pressed', monitor.id === homeSelectedMonitorId ? 'true' : 'false');
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        selectHomeMonitor(monitor.id);
      });

      const screen = document.createElement('span');
      screen.className = 'home-display-screen';
      const wallpaper = document.createElement('span');
      wallpaper.className = 'home-display-wallpaper empty';
      const empty = document.createElement('span');
      empty.className = 'home-display-empty';
      empty.textContent = t('home.noWallpaper');
      const cacheKey = `${monitor.id}|${wallTheme()}`;
      const hasCachedWallpaper = homeWallpaperCache.has(cacheKey);
      const cachedWallpaper = homeWallpaperCache.get(cacheKey) || '';
      empty.hidden = !hasCachedWallpaper || !!cachedWallpaper;
      const label = document.createElement('span');
      label.className = 'home-display-label';
      label.textContent = t('monitor.label', { n }) + (monitor.primary ? ` · ${t('monitor.primary')}` : '');
      screen.append(wallpaper, empty, label);
      if (cachedWallpaper) applyHomeDisplayWallpaper(wallpaper, cachedWallpaper);

      button.appendChild(screen);
      wrap.appendChild(button);
      loadHomeDisplayWallpaper(monitor, wallpaper, version);
    });
  }

  renderHomePager(pages);
  sizeHomeDisplays(visibleMonitors);
  updateHomeInfo();
  updateHomeBackdrop();
  renderHomeRecent();
}

// Fetch more than fit one row; layoutHomeRecentRow() shows as many as fill the width and
// hides the rest, so the visible count adapts to the window instead of being a fixed 5.
const HOME_RECENT_LIMIT = 15;
let homeRecentRenderVersion = 0;

function homeRecentItems() {
  return Object.values((config && config.library) || {})
    .filter((item) => item && item.type === 'image' && item.path)
    .sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0)
      || (Number(b.modifiedAt) || 0) - (Number(a.modifiedAt) || 0)
      || baseName(a.path).localeCompare(baseName(b.path)))
    .slice(0, HOME_RECENT_LIMIT);
}

function openRecentLibrary() {
  closeLibPopup();
  clearSelection();
  LIB.filter = 'all';
  LIB.sort = 'added';
  LIB.q = '';
  exitFolderState();
  const search = $('#libSearch'); if (search) search.value = '';
  const sort = $('#libSort'); if (sort) sort.value = 'added';
  showPage('library');
  const page = document.querySelector('.page');
  if (page) page.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderHomeRecentItems(items, version) {
  const grid = $('#homeRecentGrid');
  const empty = $('#homeRecentEmpty');
  const all = $('#homeRecentAll');
  if (!grid || !empty || !all) return;
  grid.innerHTML = '';
  grid.hidden = items.length === 0;
  empty.hidden = items.length > 0;
  all.hidden = items.length === 0;

  items.forEach((item) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'home-recent-card';
    card.title = t('home.recentAssignHint');
    card.dataset.pathKey = normPathKey(item.path);
    card.style.setProperty('--ar', '1.6'); // real aspect fills in from thumbAspects below

    const preview = document.createElement('span');
    preview.className = 'home-recent-preview';
    const placeholder = document.createElement('span');
    placeholder.className = 'home-recent-placeholder';
    placeholder.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m5.5 17 4-4.5 3 3 2.4-2.5 3.6 4"/><circle cx="15.5" cy="8.5" r="1.5"/></svg>';
    preview.appendChild(placeholder);

    // Caption-less: just the thumbnail. Authors are rarely available (most online images
    // carry none) and downloaded file names are random hashes, so any caption looked
    // inconsistent — a clean thumbnail grid reads better.
    card.appendChild(preview);
    card.addEventListener('click', () => {
      // Open the assign menu on the existing card; an ephemeral folder image is
      // materialized into the pool only when the user commits an action in the menu
      // (so merely opening it no longer reorders "recently added" or leaves strays).
      if (!item.ephemeral) { openAssignMenu(item, card); return; }
      const record = localSelectionRecord(item.path, 'image');
      openAssignMenu(null, card, async () => {
        const res = await window.api.libraryMaterialize(item.path, 'image');
        config = (res && res.config) || config;
        return res && res.id ? config.library[res.id] : null;
      }, { assignmentRecord: record, remove: false });
    });
    grid.appendChild(card);

    window.api.thumb(item.path, 360, 220).then((url) => {
      if (version !== homeRecentRenderVersion || !card.isConnected || !url) return;
      preview.style.backgroundImage = `url("${url}")`;
      preview.classList.add('loaded');
    }).catch(() => {});
  });

  // Fit the row to the container width right away with the fallback aspect, then refine once
  // the real aspect ratios arrive. Each card keeps its true proportions (no cropping) and the
  // row height is chosen so the cards fill the full width — no empty gap on the right.
  layoutHomeRecentRow();
  if (!grid.__recentResizeObserver && typeof ResizeObserver === 'function') {
    grid.__recentResizeObserver = new ResizeObserver(() => layoutHomeRecentRow());
    grid.__recentResizeObserver.observe(grid);
  }

  if (items.length && typeof window.api.thumbAspects === 'function') {
    window.api.thumbAspects(items.map((it) => ({ path: it.path })), 360, 220).then((res) => {
      if (version !== homeRecentRenderVersion) return;
      const byPath = new Map((Array.isArray(res) ? res : [])
        .map((r) => [normPathKey(r && r.path), Number(r && r.aspect) || 0]));
      grid.querySelectorAll('.home-recent-card').forEach((card) => {
        const ar = byPath.get(card.dataset.pathKey);
        if (ar > 0) card.style.setProperty('--ar', ar.toFixed(4));
      });
      layoutHomeRecentRow(); // real aspects known → re-fit the row to the width
    }).catch(() => {});
  }
}

// Compact justified single row: keep the cards near a small target height and show as many
// as fill the width (dynamic count, not a fixed 5), then scale the row so they fill it
// exactly. Each card keeps its true aspect ratio — the wallpaper is never cropped.
const HOME_RECENT_TARGET_H = 118;
function layoutHomeRecentRow() {
  const grid = $('#homeRecentGrid');
  if (!grid || grid.hidden) return;
  const all = Array.from(grid.querySelectorAll('.home-recent-card'));
  if (!all.length) return;
  const width = grid.clientWidth;
  if (width <= 0) return;
  const gap = 11;
  // Greedily take cards (at their true aspect) until the next one would overflow the row.
  const shown = [];
  let used = 0;
  for (const c of all) {
    const ar = parseFloat(c.style.getPropertyValue('--ar')) || 1.6;
    const w = ar * HOME_RECENT_TARGET_H + 2; // card width at the target height (+ borders)
    const next = used + w + (shown.length ? gap : 0);
    if (shown.length && next > width) break;
    shown.push({ c, ar });
    used = next;
  }
  const shownSet = new Set(shown.map((x) => x.c));
  all.forEach((c) => { c.style.display = shownSet.has(c) ? '' : 'none'; });
  // Scale the shown row so it fills the width exactly (justified, no cropping, no gap).
  const sumAR = shown.reduce((sum, x) => sum + x.ar, 0);
  const avail = width - gap * (shown.length - 1) - 2 * shown.length;
  const h = avail > 0 && sumAR > 0
    ? Math.max(90, Math.min(150, Math.floor(avail / sumAR))) : HOME_RECENT_TARGET_H;
  grid.style.setProperty('--rowH', `${h}px`);
}

function renderHomeRecent() {
  deferredLiveRefresh.consume('home');
  const version = ++homeRecentRenderVersion;
  renderHomeRecentItems(homeRecentItems(), version);
  if (typeof window.api.libraryRecent !== 'function') return;
  window.api.libraryRecent(HOME_RECENT_LIMIT).then((res) => {
    if (version !== homeRecentRenderVersion) return;
    renderHomeRecentItems((res && Array.isArray(res.items)) ? res.items : homeRecentItems(), version);
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Updates (Squirrel via main). Status text + a button that checks, then turns
// into "Restart" once an update is downloaded. On dev/portable (unsupported)
// the button opens the Releases page instead.
// ---------------------------------------------------------------------------
let lastUpdate = { state: 'idle', supported: true };
const UPDATE_STATUS_KEY = {
  idle: 'prefs.updateIdle', checking: 'prefs.updateChecking',
  downloading: 'prefs.updateDownloading', ready: 'prefs.updateReady',
  none: 'prefs.updateNone', error: 'prefs.updateError',
};
function renderUpdate(st) {
  if (st) lastUpdate = st;
  const btn = $('#btnCheckUpdate');
  const status = $('#updateStatus');
  if (!btn || !status) return;
  const state = lastUpdate.state || 'idle';
  status.textContent = t(UPDATE_STATUS_KEY[state] || 'prefs.updateIdle');
  const busy = state === 'checking' || state === 'downloading';
  if (state === 'ready') {
    btn.textContent = t('prefs.updateRestart');
    btn.classList.add('suggested');
    btn.disabled = false;
  } else {
    btn.textContent = t('prefs.updateCheck');
    btn.classList.remove('suggested');
    btn.disabled = busy;
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  config = await window.api.getConfig();
  hydrateOnlineFromConfig();
  currentTheme = await window.api.getTheme();
  currentWallpaperTheme = await window.api.getWallpaperTheme();
  await loadI18n();
  applyI18n();
  applyThemeToUI(currentTheme);
  // BUG-021. Every <select> keeps its value, its options and its `change` event; only
  // the popup Windows used to draw is replaced. Attaching once here covers all of them
  // — none is created later, and applyI18n rewrites option text in place.
  SelectPopup.attachAll(document);
  setMonitors(await window.api.getMonitors());
  await renderConfig();
  if (!config.firstRunDone) enterFirstRun();
  else showPage('home');

  refreshNextChange();

  window.api.getVersion().then((v) => {
    $('#appVersion').textContent = 'v' + v;
  });

  window.api.getUpdateState().then(renderUpdate);
  initSmartPanel();

  // ---- page navigation ----
  document.querySelectorAll('.navbtn').forEach((b) => {
    // Blur after a mouse click so the tab doesn't keep keyboard focus — otherwise pressing a
    // modifier (e.g. Shift for range-select) would light up its focus ring out of nowhere.
    b.addEventListener('click', () => { showPage(b.dataset.page); b.blur(); });
  });
  $('#btnPrefs').addEventListener('click', (e) => { showPage('prefs'); e.currentTarget.blur(); });

  // ---- home: switch to the next wallpaper now ----
  const btnNextWall = $('#btnNextWall');
  if (btnNextWall) btnNextWall.addEventListener('click', async () => {
    btnNextWall.disabled = true;
    try {
      const res = await window.api.nextWallpaper(config.singleWallpaper ? null : homeSelectedMonitorId);
      config = (res && res.config) || res || config;
      // «Switched» only when it really switched; otherwise say what went wrong.
      if (!toastApplyError(res && res.apply)) toast(t('toast.nextWallpaper'));
    } finally {
      setTimeout(() => { renderHome(); renderPreviews(); }, 350);
    }
  });

  const recentAll = $('#homeRecentAll');
  if (recentAll) recentAll.addEventListener('click', openRecentLibrary);
  const recentAdd = $('#homeRecentAdd');
  if (recentAdd) recentAdd.addEventListener('click', async () => {
    recentAdd.disabled = true;
    try {
      const res = await window.api.libraryAddImages();
      config = (res && res.config) || config;
      renderHome();
      if (res && res.added > 0) toast(t('toast.photosAdded', { n: res.added }));
    } finally {
      recentAdd.disabled = false;
    }
  });

  $('#homeScene').addEventListener('click', (event) => {
    if (!homeSelectedMonitorId) return;
    if (event.target !== event.currentTarget && event.target !== $('#homeMonitors')) return;
    selectHomeMonitor(null);
  });

  // ---- settings: quit the app ----
  $('#btnQuit').addEventListener('click', () => window.api.quitApp());

  // ---- settings: open the project website ----
  $('#btnWebsite').addEventListener('click', () => window.api.openWebsite());

  // ---- settings: usage statistics (opt-in placeholder) ----
  $('#swTelemetry').addEventListener('click', async () => {
    const on = $('#swTelemetry').getAttribute('aria-checked') !== 'true';
    setSwitch($('#swTelemetry'), on);
    config = await window.api.setConfig({ telemetry: on });
  });

  $('#swGameMode').addEventListener('click', async () => {
    const on = $('#swGameMode').getAttribute('aria-checked') !== 'true';
    setSwitch($('#swGameMode'), on);
    config = await window.api.setConfig({ gameModeBlock: on });
    renderConfig();
    toast(on ? t('toast.gameModeOn') : t('toast.gameModeOff'));
  });

  // ---- settings: Windows notifications for background failures (T2) ----
  const swNotifyFail = $('#swNotifyFail');
  if (swNotifyFail) swNotifyFail.addEventListener('click', async () => {
    const on = swNotifyFail.getAttribute('aria-checked') !== 'true';
    setSwitch(swNotifyFail, on);
    config = await window.api.setConfig({ notifyOnFailure: on });
  });

  // ---- settings: event journal (T3) ----
  const btnClearEventLog = $('#btnClearEventLog');
  if (btnClearEventLog) btnClearEventLog.addEventListener('click', async () => {
    try { await window.api.eventLogClear(); } catch {}
    renderEventLog();
  });

  // ---- settings: library trash ----
  // The trash lives here rather than in the library rail: it is not a place you work
  // in, and standing next to "All"/"Favourites"/"Folders" it read as one (LIB-005).
  const btnOpenRemoved = $('#btnOpenRemoved');
  if (btnOpenRemoved) btnOpenRemoved.addEventListener('click', () => {
    LIB.filter = 'removed';
    LIB.folderPath = '';
    LIB.q = '';
    const search = $('#libSearch');
    if (search) search.value = '';
    showPage('library');
    renderLibrary();
  });

  // ---- settings: re-open the welcome screen ----
  $('#btnShowWelcome').addEventListener('click', () => enterFirstRun());

  // ---- settings: check for / install updates ----
  $('#btnCheckUpdate').addEventListener('click', async () => {
    const cur = await window.api.getUpdateState();
    if (cur.state === 'ready') { window.api.installUpdate(); return; }
    const res = await window.api.checkForUpdates();
    if (!res || res.supported === false) {
      // dev / portable build (no Squirrel) — send the user to the Releases page
      toast(t('toast.updateManual'));
      window.api.openReleases();
    }
  });

  // ---- language ----
  $('#selLang').addEventListener('change', async () => {
    config = await window.api.setConfig({ language: $('#selLang').value });
    await loadI18n();
    refreshTexts();
  });

  // ---- first-run welcome ----
  $('#welcomeLang').addEventListener('change', async () => {
    config = await window.api.setConfig({ language: $('#welcomeLang').value });
    await loadI18n();
    refreshTexts();
    $('#welcomeLang').value = config.language || 'system';
  });
  $('#welcomeAuto').addEventListener('click', async () => {
    const on = $('#welcomeAuto').getAttribute('aria-checked') !== 'true';
    setSwitch($('#welcomeAuto'), on);
    config = await window.api.setConfig({
      wallpaperSchedule: { ...(config.wallpaperSchedule || {}), mode: on ? 'system' : 'off' }
    });
    currentWallpaperTheme = await window.api.getWallpaperTheme();
  });
  $('#welcomeStartup').addEventListener('click', async () => {
    const on = $('#welcomeStartup').getAttribute('aria-checked') !== 'true';
    setSwitch($('#welcomeStartup'), on);
    await window.api.setAutostart(on);
    config.autostart = on;
  });
  $('#welcomeTheme').addEventListener('click', async () => {
    const on = $('#welcomeTheme').getAttribute('aria-checked') !== 'true';
    setSwitch($('#welcomeTheme'), on);
    const sch = { ...(config.themeSchedule || {}), mode: on ? 'time' : 'off' };
    config = await window.api.setConfig({ themeSchedule: sch });
  });
  $('#welcomeShortcutDesktop').addEventListener('click', async () => {
    await window.api.createShortcuts('desktop');
    await updateShortcutButtons();
    toast(t('toast.shortcutsDone'));
  });
  $('#welcomeShortcutStart').addEventListener('click', async () => {
    await window.api.createShortcuts('startmenu');
    await updateShortcutButtons();
    toast(t('toast.shortcutsDone'));
  });
  $('#welcomeStart').addEventListener('click', async () => {
    config = await window.api.setConfig({ firstRunDone: true });
    renderConfig(); // sync the main settings controls with welcome choices
    exitFirstRun();
  });

  $('#themeIndicator').addEventListener('click', async () => {
    const override = await window.api.cycleThemeOverride();
    config.themeOverride = override;
    applyThemeToUI(currentTheme); // Update tooltip immediately
  });

  // shortcut to Library to pick wallpapers when the monitor preview is empty
  ['#previewLight', '#previewDark'].forEach((sel) => {
    const el = $(sel);
    if (el) {
      el.addEventListener('click', () => {
        if (el.classList.contains('empty')) {
          showPage('library');
        }
      });
    }
  });

  // Independent wallpaper day/night trigger.
  async function saveWallpaperSchedule(announce) {
    const sch = {
      mode: $('#selWallpaperMode').value,
      lightStart: $('#wallpaperLightStart').value || '07:00',
      darkStart: $('#wallpaperDarkStart').value || '20:00',
    };
    config = await window.api.setConfig({ wallpaperSchedule: sch });
    currentWallpaperTheme = await window.api.getWallpaperTheme();
    renderWallpaperSchedule();
    applyThemeToUI(currentTheme);
    renderHome();
    if (announce) toast(t('toast.wallpaperScheduleUpdated'));
  }
  $('#selWallpaperMode').addEventListener('change', () => saveWallpaperSchedule(true));
  $('#wallpaperLightStart').addEventListener('change', () => saveWallpaperSchedule(false));
  $('#wallpaperDarkStart').addEventListener('change', () => saveWallpaperSchedule(false));

  // separate day/night wallpapers (Znada's signature) vs. one unified wallpaper list.
  // Turning it off hides the dark slot in the UI but KEEPS its data; main re-applies
  // wallpapers from the now-active slot immediately (set-config side effect).
  $('#swSeparate').addEventListener('click', async () => {
    const on = $('#swSeparate').getAttribute('aria-checked') !== 'true';
    setSwitch($('#swSeparate'), on);
    config = await window.api.setConfig({ separateThemes: on });
    currentWallpaperTheme = await window.api.getWallpaperTheme();
    updateSeparateThemesUI();
    applyThemeToUI(currentTheme); // re-aim the active-slot outline
    renderPreviews();
    renderHome();
  });

  // one wallpaper for all monitors (vs. a separate pair per monitor)
  $('#swSingle').addEventListener('click', async () => {
    const on = $('#swSingle').getAttribute('aria-checked') !== 'true';
    setSwitch($('#swSingle'), on);
    config = await window.api.setConfig({ singleWallpaper: on });
    buildMonitorMap();   // show/hide the monitor map
    renderPreviews();    // previews now reflect global vs per-monitor
    renderHome();
    const applied = await window.api.applyNow();
    // The toggle itself succeeded; an apply error outranks the toggle toast
    // (an empty slot is fine — nothing to re-apply yet).
    if (!toastApplyError(applied, { ignoreNoWallpaper: true })) {
      toast(on ? t('toast.singleOn') : t('toast.singleOff'));
    }
  });

  $('#swStartup').addEventListener('click', async () => {
    const on = $('#swStartup').getAttribute('aria-checked') !== 'true';
    setSwitch($('#swStartup'), on);
    await window.api.setAutostart(on);
    renderHome();
    toast(on ? t('toast.startupOn') : t('toast.startupOff'));
  });

  // start minimized to tray (only affects the autostart launch; decoupled from it)
  $('#swStartMin').addEventListener('click', async () => {
    const on = $('#swStartMin').getAttribute('aria-checked') !== 'true';
    setSwitch($('#swStartMin'), on);
    await window.api.setStartMinimized(on);
    config.startMinimized = on;
    toast(on ? t('toast.startMinOn') : t('toast.startMinOff'));
  });

  // style select — applies live
  $('#selStyle').addEventListener('change', async (e) => {
    config = await window.api.setConfig({ style: e.target.value });
    applyPreviewStyle();
    renderHome();
    const res = await window.api.applyNow();
    if (res && res.ok) toast(t('toast.styleUpdated'));
    else toastApplyError(res, { ignoreNoWallpaper: true }); // no wallpaper yet → silence, as before
  });

  // viewer background select — live (the open viewer, if any, updates via gallery-background)
  $('#selViewerBackground').addEventListener('change', async (e) => {
    config = await window.api.setConfig({ viewerBackground: e.target.value });
  });

  // slideshow controls (live)
  $('#swSlideshow').addEventListener('click', async () => {
    const on = $('#swSlideshow').getAttribute('aria-checked') !== 'true';
    setSwitch($('#swSlideshow'), on);
    config = await window.api.setSlideshow({ enabled: on });
    updateSlideshowControls();
    renderHome();
    toast(on ? t('toast.slideshowOn') : t('toast.slideshowOff'));
  });
  $('#slideInterval').addEventListener('change', async () => {
    let v = parseInt($('#slideInterval').value, 10);
    if (!Number.isFinite(v) || v < 1) v = 30;
    config = await window.api.setSlideshow({ intervalMin: v });
    $('#slideInterval').value = config.slideshow.intervalMin;
    updateSlideshowControls();
    renderHome();
  });
  $('#selSlideOrder').addEventListener('change', async () => {
    config = await window.api.setSlideshow({ order: $('#selSlideOrder').value });
  });
  $('#swSlideInterval').addEventListener('click', async () => {
    const on = $('#swSlideInterval').getAttribute('aria-checked') !== 'true';
    setSwitch($('#swSlideInterval'), on);
    config = await window.api.setSlideshow({ intervalEnabled: on });
    updateSlideshowControls();
    renderHome();
  });

  // Slideshow event triggers (startup, wake from sleep, optional stealth delay)
  $('#swTriggerStartup').addEventListener('click', async () => {
    const on = $('#swTriggerStartup').getAttribute('aria-checked') !== 'true';
    setSwitch($('#swTriggerStartup'), on);
    config = await window.api.setConfig({ triggers: { ...config.triggers, onStartup: on } });
    updateSlideshowControls();
  });
  $('#swTriggerWakeup').addEventListener('click', async () => {
    const on = $('#swTriggerWakeup').getAttribute('aria-checked') !== 'true';
    setSwitch($('#swTriggerWakeup'), on);
    config = await window.api.setConfig({ triggers: { ...config.triggers, onWakeup: on } });
    updateSlideshowControls();
  });
  $('#swTriggerStealth').addEventListener('click', async () => {
    const on = $('#swTriggerStealth').getAttribute('aria-checked') !== 'true';
    setSwitch($('#swTriggerStealth'), on);
    const stealth = { ...currentStealth(), enabled: on };
    config = await window.api.setConfig({ triggers: { ...config.triggers, stealth } });
    updateSlideshowControls();
  });
  async function setStealthScope(key, on) {
    const stealth = { ...currentStealth(), [key]: !!on };
    config = await window.api.setConfig({ triggers: { ...config.triggers, stealth } });
    updateSlideshowControls();
  }
  document.querySelectorAll('[data-stealth-scope]').forEach((cb) => {
    cb.addEventListener('change', async (e) => {
      await setStealthScope(e.target.dataset.stealthScope, e.target.checked);
    });
  });

  async function saveSharedCoordinates(lat, lng) {
    const sch = { ...(config.themeSchedule || {}), lat, lng };
    config = await window.api.setConfig({ themeSchedule: sch });
    renderSharedCoordinates();
  }

  // theme schedule (Znada switches the Windows theme itself)
  async function saveThemeSchedule(announce) {
    const sch = {
      ...(config.themeSchedule || {}),
      mode: $('#selThemeMode').value,
      lightStart: $('#lightStart').value || '07:00',
      darkStart: $('#darkStart').value || '20:00',
    };
    config = await window.api.setConfig({ themeSchedule: sch });
    $('#themeTimes').hidden = (sch.mode !== 'time');
    $('#themeSun').hidden = (sch.mode !== 'sun');
    if (announce) toast(sch.mode === 'off' ? t('toast.scheduleOff') : t('toast.scheduleOn'));
  }
  $('#selThemeMode').addEventListener('change', () => saveThemeSchedule(true));
  $('#lightStart').addEventListener('change', () => saveThemeSchedule(false));
  $('#darkStart').addEventListener('change', () => saveThemeSchedule(false));
  for (const [latSel, lngSel] of [['#latInput', '#lngInput'], ['#wallpaperLatInput', '#wallpaperLngInput']]) {
    $(latSel).addEventListener('change', () => saveSharedCoordinates($(latSel).value.trim(), $(lngSel).value.trim()));
    $(lngSel).addEventListener('change', () => saveSharedCoordinates($(latSel).value.trim(), $(lngSel).value.trim()));
  }

  async function detectCoordinates(buttonSel, statusSel) {
    const btn = $(buttonSel);
    const status = $(statusSel);
    btn.disabled = true;
    status.textContent = t('theme.autoCoordsChecking') || '...';
    const res = await window.api.detectLocation();
    btn.disabled = false;
    if (res.ok) {
      await saveSharedCoordinates(String(res.lat), String(res.lng));
      const success = t('theme.autoCoordsSuccess', { city: res.city, lat: parseFloat(res.lat).toFixed(2), lng: parseFloat(res.lng).toFixed(2) });
      for (const id of ['#lblCoordsStatus', '#lblWallpaperCoordsStatus']) if ($(id)) $(id).textContent = success;
      toast(t('toast.locationUpdated'));
    } else {
      status.textContent = t('theme.autoCoordsError', { msg: res.reason });
      toast(t('toast.error', { msg: res.reason }));
    }
  }
  $('#btnDetectCoords').addEventListener('click', () => detectCoordinates('#btnDetectCoords', '#lblCoordsStatus'));
  $('#btnDetectWallpaperCoords').addEventListener('click', () => detectCoordinates('#btnDetectWallpaperCoords', '#lblWallpaperCoordsStatus'));

  // live updates from main process
  window.api.onTheme((theme, meta) => {
    applyThemeToUI(theme);
    renderHome();
    // A hidden autostart window must not queue a stale theme toast that appears when the
    // user opens Znada moments later. `meta.silent` marks a startup/resume catch-up flip
    // (background, not a fresh user action). Genuine visible theme changes still announce.
    if (!document.hidden && !(meta && meta.silent)) toast(theme === 'dark' ? t('toast.themeDark') : t('toast.themeLight'));
  });

  window.api.onWallpaperTheme((theme) => {
    currentWallpaperTheme = theme;
    applyThemeToUI(currentTheme);
    renderHome();
  });

  window.api.onConfig((cfg) => {
    const prevContentSig = libraryContentSig();
    const prevAssignedSig = assignedSig();
    const prevLibrary = config.library || {};
    const prevPoolIds = new Set(Object.keys(config.library || {}));
    config = cfg;
    renderConfig();
    renderHome();
    // The Online grid's added/remove badges are derived from the pool, so a change made
    // ANYWHERE else has to reach them — most obviously the fullscreen viewer, which can
    // now add and remove too (ONL-008). Rebuilding the feed here would refetch it and
    // lose the user's place, so only the badges are re-derived.
    if (LIB.filter === 'online') refreshOnlineAddedState();
    // Only rebuild the Library grid when its CONTENTS actually changed. Unrelated config
    // broadcasts (theme, schedule, viewer background, …) used to flash the whole grid and
    // drop the scroll to the top. Two cheaper paths avoid a full rebuild: an assignment-only
    // change just flips a card's badge (the config-changed broadcast arrives before the
    // assign IPC reply, so config still looks old here); and a materialize of an on-screen
    // folder photo upgrades just that one card. While hidden, defer a rebuild to next show.
    if (!$('#viewLibrary').hidden && LIB.filter !== 'online') {
      if (libraryContentSig() !== prevContentSig) {
        if (document.hidden) deferredLiveRefresh.mark('library');
        else if (LIB.filter !== 'favorite' && isFavoriteOnlyLibraryChange(prevLibrary, config.library)) refreshFavoriteHighlights();
        else if (!tryUpgradeMaterializedCards(prevPoolIds)) renderLibrary();
      } else if (assignedSig() !== prevAssignedSig && !document.hidden) {
        refreshAssignedHighlights();
      }
    }
    window.api.getWallpaperTheme().then((theme) => {
      currentWallpaperTheme = theme;
      applyThemeToUI(currentTheme);
      renderHome();
    });
  });

  window.api.onLiveFoldersChanged(() => {
    // Home and Library consume their own pending state. Refreshing one view must
    // not make the other stale view look current after a minimize/restore cycle.
    deferredLiveRefresh.markAll();
    invalidateFolderCards();
    if (document.hidden) return;
    if (!$('#viewHome').hidden) renderHomeRecent();
    if (!$('#viewLibrary').hidden && LIB.filter !== 'online') renderLibrary();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { syncHomeCountdownTimer(); return; }
    refreshNextChange(); // за время в трее отсчёт мог устареть или смениться паузой
    // Re-showing the window (un-minimize, viewer closed over it) must NOT rebuild
    // the grid on its own — that emptied the grid at a deep scroll position and
    // reloaded every thumbnail. Only catch up if live folders changed while hidden.
    if (!$('#viewHome').hidden && deferredLiveRefresh.has('home')) renderHomeRecent();
    else if (!$('#viewLibrary').hidden && LIB.filter !== 'online' && deferredLiveRefresh.has('library')) renderLibrary();
  });

  window.api.onMonitors((list) => {
    setMonitors(list);
  });

  // Момент следующей смены меняется в main (перепланирование, игровой режим,
  // ожидание «невидимой смены») — Главная только отражает присланное.
  if (window.api.onNextChange) {
    window.api.onNextChange((state) => {
      nextChangeState = state;
      renderHomeAutomation();
    });
  }

  window.api.onUpdate((st) => renderUpdate(st));

  // Cloud session changed in main (e.g. a 401 dropped an expired session) → refresh
  // the account chip + favorites toggle if the Online tab is open.
  window.api.onCloudSession((s) => {
    CLOUDAUTH.state = s; CLOUDAUTH.fetched = true;
    if (LIB.filter === 'online' && onlineSources().lumina) {
      const wasFavorites = ONLINE.view === 'favorites';
      renderCloudAccount();
      applyFavToggleUI();
      // Session expiry hides account favorites. If their request was still in
      // flight, immediately replace that now-invalid feed with ordinary search.
      if (wasFavorites && ONLINE.view !== 'favorites') {
        ONLINE.loading = false;
        ONLINE.loaded = false;
        doOnlineSearch(true);
      }
    }
  });

  // keep thumbnails fitted when the window (and thus cards) resize
  let resizeT = null;
  window.addEventListener('resize', () => {
    const grid = activeLibraryGrid();
    beginLibraryResizeAnchor(grid);
    const liveVirtual = grid && grid.__virtual;
    if (liveVirtual && grid.clientWidth < liveVirtual.layoutWidth - 0.5) {
      // Shrink is asymmetric: old full-width flex rows no longer fit, so deferring
      // canonical sizes lets Chromium paint an automatic wrap first. A window
      // resize event runs before paint; commit only shrink here. Expand and
      // height-only resize keep the established deferred path below.
      layoutLibGrid(grid);
    }
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const endSpan = diagSpan('renderer', 'resize-relayout'); // budget span #12
      layoutMonitors();
      const virtual = grid && grid.__virtual;
      if (!virtual || Math.abs(grid.clientWidth - virtual.layoutWidth) >= 0.5) layoutLibGrid(grid);
      if (libraryResizeActive) scheduleLibraryResizeFinish(grid);
      else if (!libraryViewAnchor) libraryViewAnchor = captureLibraryScrollAnchor(grid);
      if (libLazyKick) libLazyKick();
      if (!$('#viewHome').hidden) renderHome();
      endSpan();
    }, 60);
  });

  initHotkeys();
  initDragDrop();
  initLibrary();
}

function initHotkeys() {
  const recBtn = $('#btnRecordShortcut');
  const clearBtn = $('#btnClearShortcut');
  const swEnabled = $('#swShortcutEnabled');
  if (!recBtn || !clearBtn || !swEnabled) return;

  let isRecording = false;
  let operationPending = false;

  function handleKeydown(e) {
    e.preventDefault();
    e.stopPropagation();

    const result = window.ZnadaHotkey.interpretKeydown(e);
    if (result.status === 'waiting') {
      recBtn.textContent = result.display || t('shortcuts.pressKeys');
      return;
    }
    if (result.status === 'unsupported') return;
    if (result.status === 'invalid') {
      toast(t('toast.shortcutInvalid'));
      void stopRecording(false);
      return;
    }
    void saveShortcut(result.accelerator);
  }

  async function startRecording() {
    if (isRecording || operationPending) return;
    operationPending = true;
    recBtn.disabled = true;
    try {
      const result = await window.api.setHotkeyRecording(true);
      if (!result || !result.ok) {
        toast(t('toast.shortcutUnavailable'));
        return;
      }
      // Focus can move while the IPC round-trip is suspending the OS shortcut.
      // In that narrow window the blur handler cannot see `isRecording` yet, so
      // explicitly resume instead of starting an invisible recorder.
      if (document.hidden || !document.hasFocus()) {
        await window.api.setHotkeyRecording(false);
        return;
      }
      isRecording = true;
      recBtn.classList.add('recording');
      recBtn.textContent = t('shortcuts.recording') || 'Recording...';
      window.addEventListener('keydown', handleKeydown, true);
    } catch {
      toast(t('toast.shortcutUnavailable'));
    } finally {
      operationPending = false;
      recBtn.disabled = false;
    }
  }

  async function stopRecording(success) {
    if (isRecording) {
      isRecording = false;
      recBtn.classList.remove('recording');
      window.removeEventListener('keydown', handleKeydown, true);
    }
    try { await window.api.setHotkeyRecording(false); } catch {}
    if (!success) {
      const hk = config.hotkeys && config.hotkeys.nextWallpaper;
      const val = hk ? hk.shortcut : '';
      recBtn.textContent = val || t('shortcuts.pressKeys');
      if (val) recBtn.classList.add('assigned');
      else recBtn.classList.remove('assigned');
    }
  }

  async function saveShortcut(shortcut) {
    if (operationPending) return;
    operationPending = true;
    await stopRecording(false);
    try {
      const result = await window.api.setHotkey({ enabled: true, shortcut });
      if (!result || !result.ok) {
        if (result && result.config) config = result.config;
        toast(t(result && result.error === 'invalid' ? 'toast.shortcutInvalid' : 'toast.shortcutUnavailable'));
        return;
      }
      config = result.config;
      renderConfig();
      toast(t('toast.shortcutUpdated'));
    } catch {
      toast(t('toast.shortcutUnavailable'));
    } finally {
      operationPending = false;
    }
  }

  recBtn.addEventListener('click', () => {
    void startRecording();
  });

  clearBtn.addEventListener('click', async () => {
    if (operationPending) return;
    operationPending = true;
    await stopRecording(false);
    try {
      const result = await window.api.setHotkey({ enabled: false, shortcut: '' });
      if (!result || !result.ok) { toast(t('toast.shortcutUnavailable')); return; }
      config = result.config;
      renderConfig();
      toast(t('toast.shortcutUpdated'));
    } catch { toast(t('toast.shortcutUnavailable')); }
    finally { operationPending = false; }
  });

  swEnabled.addEventListener('click', async () => {
    if (operationPending) return;
    operationPending = true;
    await stopRecording(false);
    const on = swEnabled.getAttribute('aria-checked') !== 'true';
    setSwitch(swEnabled, on);
    try {
      const result = await window.api.setHotkey({
        enabled: on,
        shortcut: (config.hotkeys && config.hotkeys.nextWallpaper && config.hotkeys.nextWallpaper.shortcut) || '',
      });
      if (!result || !result.ok) throw new Error(result && result.error || 'unavailable');
      config = result.config;
      renderConfig();
    } catch {
      setSwitch(swEnabled, !on);
      toast(t('toast.shortcutUnavailable'));
    } finally {
      operationPending = false;
    }
  });

  window.addEventListener('blur', () => { if (isRecording) void stopRecording(false); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && isRecording) void stopRecording(false);
  });
}

function initDragDrop() {
  document.querySelectorAll('.wallcard').forEach((card) => {
    const theme = card.dataset.theme;
    let dragCounter = 0;

    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
      card.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, false);
    });

    card.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      card.classList.add('drag-over');
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    card.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        card.classList.remove('drag-over');
      }
    });

    // Handle dropped files
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      card.classList.remove('drag-over');

      const files = e.dataTransfer.files;
      if (!files || !files.length) return;

      const mon = editTargetId();
      if (!mon) return;

      const filePaths = [];
      for (let i = 0; i < files.length; i++) {
        try {
          const path = window.api.getPathForFile(files[i]);
          if (path) filePaths.push(path);
        } catch (err) {
          console.error('Failed to get path for dropped file:', err);
        }
      }

      if (filePaths.length === 0) return;

      const res = await window.api.addSlotPaths(mon, theme, filePaths);
      config = (res && res.config) || config;
      renderSlot(theme);
      renderHome();
      if (res && res.added > 0) {
        toast(t('toast.photosAdded', { n: res.added }));
        if (theme === currentTheme) {
          window.api.applyNow(theme).then((r) => toastApplyError(r)).catch(() => {});
        }
      }
    });
  });
}

init();
