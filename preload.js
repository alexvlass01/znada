'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Dev-only diagnostics probe. Attached only when main passed the gated launch argument
// (unpackaged diagnostics run); a packaged build never sees the arg, so the diagnostics
// module is never required. Wrapped so a probe fault can never break the real preload.
try {
  const hasDiag = process.argv.some((a) => typeof a === 'string' && a.indexOf('--znada-diagnostics-renderer') === 0);
  if (hasDiag) {
    const diag = require('./diagnostics/renderer/preload-attach');
    diag.attachRendererProbe({ ipcRenderer, contextBridge, role: diag.parseRole(process.argv), cardSelector: '.lib-card' });
  }
} catch { /* diagnostics is optional */ }

// COLLAB-003. A DEV/DIAG check launch passes the label of the code it runs, and the title
// bar shows it. Read here with no module loading at all: in DEV this preload is sandboxed,
// and a relative module once took the whole bridge down there (QA-009). A user build never
// receives the argument, so `devLaunch` is null in it.
const devLaunch = (() => {
  const prefix = '--znada-dev-launch=';
  try {
    const arg = process.argv.find((a) => typeof a === 'string' && a.indexOf(prefix) === 0);
    if (!arg) return null;
    const label = JSON.parse(decodeURIComponent(arg.slice(prefix.length)));
    if (!label || typeof label.badgeText !== 'string' || !label.badgeText) return null;
    return Object.freeze({
      mode: label.mode === 'diag' ? 'diag' : 'dev',
      badgeText: label.badgeText.slice(0, 200),
      details: typeof label.details === 'string' ? label.details.slice(0, 2000) : '',
      dirty: label.dirty === true,
      known: label.known === true,
    });
  } catch {
    return null;
  }
})();

contextBridge.exposeInMainWorld('api', {
  // COLLAB-003: the check-launch label, or null. A value, not a method.
  devLaunch,
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  setHotkey: (nextWallpaper) => ipcRenderer.invoke('set-hotkey', nextWallpaper),
  setHotkeyRecording: (recording) => ipcRenderer.invoke('set-hotkey-recording', recording),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getI18n: () => ipcRenderer.invoke('get-i18n'),
  getFeatureFlags: () => ipcRenderer.invoke('feature-flags'),
  getMonitors: () => ipcRenderer.invoke('get-monitors'),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  getWallpaperTheme: () => ipcRenderer.invoke('get-wallpaper-theme'),
  addSlotImages: (monitorId, which) => ipcRenderer.invoke('add-slot-images', monitorId, which),
  addSlotFolder: (monitorId, which) => ipcRenderer.invoke('add-slot-folder', monitorId, which),
  addSlotPaths: (monitorId, which, filePaths) => ipcRenderer.invoke('add-slot-paths', monitorId, which, filePaths),
  removeSlotItem: (monitorId, which, index) => ipcRenderer.invoke('remove-slot-item', monitorId, which, index),
  clearSlot: (monitorId, which) => ipcRenderer.invoke('clear-slot', monitorId, which),
  currentImage: (monitorId, which) => ipcRenderer.invoke('current-image', monitorId, which),
  folderInfo: (dir) => ipcRenderer.invoke('folder-info', dir),
  folderEntries: (dir) => ipcRenderer.invoke('folder-entries', dir),

  // Библиотека (пул контента)
  libraryAddImages: () => ipcRenderer.invoke('library-add-images'),
  libraryAddFolder: () => ipcRenderer.invoke('library-add-folder'),
  libraryAddPaths: (paths) => ipcRenderer.invoke('library-add-paths', paths),
  // Records are { path, id? }: every card knows its path, only some have a pool id.
  libraryRemoveMany: (records, options) => ipcRenderer.invoke('library-remove-many', records, options),
  // The token binds this UI action to the exact removal that created its toast.
  // Without it, an old toast in the main window could undo a newer removal made in
  // the fullscreen viewer (main intentionally keeps only one removal snapshot).
  libraryUndoRemove: (token) => ipcRenderer.invoke('library-undo-remove', token),
  // ONL-009 card actions. Descriptors, never URLs: main looks up or validates every
  // address itself, so a compromised renderer cannot aim these at somewhere else.
  cardOpenSource: (card) => ipcRenderer.invoke('card-open-source', card),
  cardCopyLink: (card) => ipcRenderer.invoke('card-copy-link', card),
  cardCopyFile: (card) => ipcRenderer.invoke('card-copy-file', card),
  cardSaveAs: (card) => ipcRenderer.invoke('card-save-as', card),
  libraryHiddenList: () => ipcRenderer.invoke('library-hidden-list'),
  libraryRestore: (paths) => ipcRenderer.invoke('library-restore', paths),
  libraryDeleteForever: (paths) => ipcRenderer.invoke('library-delete-forever', paths),
  libraryRefresh: () => ipcRenderer.invoke('library-refresh'),

  // DATA-006. The folder Znada keeps its own copies in, and moving everything into a
  // new one. `plan` only counts and checks — nothing is written until `move`.
  mediaFolderState: () => ipcRenderer.invoke('media-folder-state'),
  mediaFolderPick: () => ipcRenderer.invoke('media-folder-pick'),
  mediaFolderPlan: (folder) => ipcRenderer.invoke('media-folder-plan', folder),
  mediaFolderMove: (folder) => ipcRenderer.invoke('media-folder-move', folder),
  mediaFolderStop: () => ipcRenderer.invoke('media-folder-stop'),
  // Returns a disposer: the move window is opened and closed repeatedly, and a listener
  // left behind would report progress into a dialog that is no longer on screen.
  onMediaMoveProgress: (cb) => {
    const handler = (_e, progress) => cb(progress);
    ipcRenderer.on('media-move-progress', handler);
    return () => ipcRenderer.removeListener('media-move-progress', handler);
  },

  libraryToggleFavorite: (id) => ipcRenderer.invoke('library-toggle-favorite', id),
  libraryAddTag: (id, tag) => ipcRenderer.invoke('library-add-tag', id, tag),
  libraryRemoveTag: (id, tag) => ipcRenderer.invoke('library-remove-tag', id, tag),
  libraryAssign: (id, monitorId, which) => ipcRenderer.invoke('library-assign', id, monitorId, which),
  libraryAssignRecord: (record, monitorId, which) => ipcRenderer.invoke('library-assign-record', record, monitorId, which),
  libraryAssignRecords: (records, monitorId, which) => ipcRenderer.invoke('library-assign-records', records, monitorId, which),
  libraryMaterialize: (p, type) => ipcRenderer.invoke('library-materialize', p, type),
  expandFolders: () => ipcRenderer.invoke('expand-folders'),
  libraryRecent: (limit) => ipcRenderer.invoke('library-recent', limit),
  libraryEnsureSizes: () => ipcRenderer.invoke('library-ensure-sizes'),
  libraryPathSizes: (paths) => ipcRenderer.invoke('library-path-sizes', paths),
  // Details view: on-demand file metadata + reveal/source/copy actions.
  itemDetails: (p) => ipcRenderer.invoke('item-details', p),
  itemReveal: (p) => ipcRenderer.invoke('item-reveal', p),
  itemOpenSource: (id) => ipcRenderer.invoke('item-open-source', id),
  itemCopyPath: (p) => ipcRenderer.invoke('item-copy-path', p),
  // META-001: ask an online catalogue what it knows about this exact file.
  itemLookupMetadata: (id) => ipcRenderer.invoke('item-lookup-metadata', id),

  // Znada Cloud (C2): safe capability state only (environment/available/reason).
  getCloudCapability: () => ipcRenderer.invoke('get-cloud-capability'),
  cloudAdd: (item) => ipcRenderer.invoke('cloud-add', item),
  // Znada Cloud account (C4): token stays in main; renderer only sees profile state.
  cloudSession: () => ipcRenderer.invoke('cloud-session'),
  cloudSignin: () => ipcRenderer.invoke('cloud-signin'),
  cloudSigninCancel: () => ipcRenderer.invoke('cloud-signin-cancel'),
  cloudSignout: () => ipcRenderer.invoke('cloud-signout'),
  onCloudSession: (cb) => ipcRenderer.on('cloud-session-changed', (_e, s) => cb(s)),
  // Znada Cloud favorites (C5): account-synced; distinct from local Library favorites.
  cloudFavorites: () => ipcRenderer.invoke('cloud-favorites'),
  cloudFavorite: (id, on) => ipcRenderer.invoke('cloud-favorite', id, on),

  // Internet (онлайн-обои)
  internetStatus: () => ipcRenderer.invoke('internet-status'),
  internetSearch: (opts) => ipcRenderer.invoke('internet-search', opts),
  internetTagSuggest: (opts) => ipcRenderer.invoke('internet-tag-suggest', opts),
  internetAdd: (item, query) => ipcRenderer.invoke('internet-add', item, query),
  openGalleryViewer: (payload) => ipcRenderer.invoke('gallery-open', payload),
  setSlideshow: (patch) => ipcRenderer.invoke('set-slideshow', patch),
  setSlideshowIndex: (monitorId, which, index) => ipcRenderer.invoke('set-slideshow-index', monitorId, which, index),
  setSlideshowToPath: (monitorId, which, p) => ipcRenderer.invoke('set-slideshow-to-path', monitorId, which, p),
  applyNow: (which) => ipcRenderer.invoke('apply-now', which),
  nextWallpaper: (monitorId) => ipcRenderer.invoke('next-wallpaper', monitorId),
  // Главная: когда следующая автоматическая смена (или почему времени нет).
  getNextChange: () => ipcRenderer.invoke('next-change-get'),
  cycleThemeOverride: () => ipcRenderer.invoke('cycle-theme-override'),
  setAutostart: (v) => ipcRenderer.invoke('set-autostart', v),
  setStartMinimized: (v) => ipcRenderer.invoke('set-start-minimized', v),
  fileUrl: (p) => ipcRenderer.invoke('file-url', p),
  thumb: (p, w, h) => ipcRenderer.invoke('thumb', p, w, h),
  thumbInfo: (p, w, h, priority) => ipcRenderer.invoke('thumb-info', p, w, h, priority),
  thumbAspects: (entries, w, h) => ipcRenderer.invoke('thumb-aspects', entries, w, h),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  createShortcuts: (which) => ipcRenderer.invoke('create-shortcuts', which),
  shortcutsStatus: () => ipcRenderer.invoke('shortcuts-status'),

  // Event journal (recent background failures/recoveries; settings page)
  eventLogGet: () => ipcRenderer.invoke('event-log-get'),
  eventLogClear: () => ipcRenderer.invoke('event-log-clear'),

  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openReleases: () => ipcRenderer.invoke('open-releases'),
  openWebsite: () => ipcRenderer.invoke('open-website'),
  detectLocation: () => ipcRenderer.invoke('detect-location'),
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),

  onTheme: (cb) => ipcRenderer.on('theme-changed', (_e, t, meta) => cb(t, meta)),
  onWallpaperTheme: (cb) => ipcRenderer.on('wallpaper-theme-changed', (_e, t) => cb(t)),
  onConfig: (cb) => ipcRenderer.on('config-changed', (_e, c) => cb(c)),
  onLiveFoldersChanged: (cb) => ipcRenderer.on('live-folders-changed', (_e, change) => cb(change)),
  onMonitors: (cb) => ipcRenderer.on('monitors-changed', (_e, d) => cb(d)),
  onNextChange: (cb) => ipcRenderer.on('next-change', (_e, s) => cb(s)),
  onUpdate: (cb) => ipcRenderer.on('update-status', (_e, st) => cb(st)),
});
