'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Dev-only diagnostics probe for the viewer window (see preload.js for the rationale).
// The viewer has no library cards, so no card selector is passed.
try {
  const hasDiag = process.argv.some((a) => typeof a === 'string' && a.indexOf('--znada-diagnostics-renderer') === 0);
  if (hasDiag) {
    const diag = require('../diagnostics/renderer/preload-attach');
    diag.attachRendererProbe({ ipcRenderer, contextBridge, role: diag.parseRole(process.argv) });
  }
} catch { /* diagnostics is optional */ }

contextBridge.exposeInMainWorld('viewerApi', {
  getI18n: () => ipcRenderer.invoke('get-i18n'),
  getPayload: () => ipcRenderer.invoke('gallery-payload'),
  close: () => ipcRenderer.invoke('gallery-close'),
  toggleFullscreen: () => ipcRenderer.invoke('gallery-toggle-fullscreen'),
  fileUrl: (p) => ipcRenderer.invoke('file-url', p),
  internetThumbnail: (item) => ipcRenderer.invoke('internet-thumbnail', item),
  internetSample: (item) => ipcRenderer.invoke('internet-sample', item),
  internetFull: (item) => ipcRenderer.invoke('internet-full', item),
  internetAdd: (item, query) => ipcRenderer.invoke('internet-add', item, query),
  cloudAdd: (item) => ipcRenderer.invoke('cloud-add', item),
  // ONL-008: removing and immediately restoring an online item from inside the viewer.
  // These are the same validated handlers the Library tab uses: removal moves records
  // to the trash, and Undo restores the complete record without touching the file.
  libraryRemoveMany: (records) => ipcRenderer.invoke('library-remove-many', records),
  libraryUndoRemove: (token) => ipcRenderer.invoke('library-undo-remove', token),
  // ONL-009. The same handlers the grid uses: the viewer is where a picture is
  // actually being looked at, so it is where "save this" gets decided.
  cardOpenSource: (card) => ipcRenderer.invoke('card-open-source', card),
  cardCopyLink: (card) => ipcRenderer.invoke('card-copy-link', card),
  cardCopyFile: (card) => ipcRenderer.invoke('card-copy-file', card),
  cardSaveAs: (card) => ipcRenderer.invoke('card-save-as', card),
  cardAssignTargets: () => ipcRenderer.invoke('card-assign-targets'),
  cardEnsureRecord: (p, type) => ipcRenderer.invoke('card-ensure-record', p, type),
  itemLookupMetadata: (id) => ipcRenderer.invoke('item-lookup-metadata', id),
  libraryAssign: (id, monitorId, which) => ipcRenderer.invoke('library-assign', id, monitorId, which),
  onPayload: (cb) => ipcRenderer.on('gallery-payload', (_e, payload) => cb(payload)),
  onFullscreenChanged: (cb) => ipcRenderer.on('gallery-fullscreen-changed', (_e, on) => cb(on)),
  onBackgroundChanged: (cb) => ipcRenderer.on('gallery-background', (_e, mode) => cb(mode)),
});
