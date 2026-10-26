'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invokeMetadataLookup = (id, options) => ipcRenderer.invoke('item-lookup-metadata', id, options);

// QA-009. The diagnostics probe is not loaded from this file. The viewer has no library
// cards. The probe is a separate script, registered only for a diagnostics run.

contextBridge.exposeInMainWorld('viewerApi', {
  getI18n: () => ipcRenderer.invoke('get-i18n'),
  favoriteState: (card) => ipcRenderer.invoke('favorite-state', card),
  favoriteSet: (card, on) => ipcRenderer.invoke('favorite-set', card, on),
  getPayload: () => ipcRenderer.invoke('gallery-payload'),
  close: () => ipcRenderer.invoke('gallery-close'),
  toggleFullscreen: () => ipcRenderer.invoke('gallery-toggle-fullscreen'),
  fileUrl: (p) => ipcRenderer.invoke('file-url', p),
  internetAdd: (item, query) => ipcRenderer.invoke('internet-add', item, query),
  cloudAdd: (item) => ipcRenderer.invoke('cloud-add', item),
  // ONL-008: removing and immediately restoring an online item from inside the viewer.
  // These are the same validated handlers the Library tab uses: removal moves records
  // to the trash, and Undo restores the complete record without touching the file.
  libraryRemoveMany: (records, options) => ipcRenderer.invoke('library-remove-many', records, options),
  libraryUndoRemove: (token) => ipcRenderer.invoke('library-undo-remove', token),
  // ONL-009. The same handlers the grid uses: the viewer is where a picture is
  // actually being looked at, so it is where "save this" gets decided.
  cardOpenSource: (card) => ipcRenderer.invoke('card-open-source', card),
  cardCopyLink: (card) => ipcRenderer.invoke('card-copy-link', card),
  cardCopyFile: (card) => ipcRenderer.invoke('card-copy-file', card),
  cardSaveAs: (card) => ipcRenderer.invoke('card-save-as', card),
  cardAssignTargets: () => ipcRenderer.invoke('card-assign-targets'),
  cardEnsureRecord: (p, type) => ipcRenderer.invoke('card-ensure-record', p, type),
  itemLookupMetadata: (id) => invokeMetadataLookup(id),
  itemLookupVisualMetadata: (id) => invokeMetadataLookup(id, { action: 'visual' }),
  itemConfirmVisualMetadata: (id, token, accept) => invokeMetadataLookup(id, { action: 'confirm', token, accept }),
  libraryAssign: (id, monitorId, which) => ipcRenderer.invoke('library-assign', id, monitorId, which),
  // BUG-035: whether a file on the disk moves, for the assign window's first-frame line.
  mediaMotion: (p) => ipcRenderer.invoke('media-motion', p),
  onPayload: (cb) => ipcRenderer.on('gallery-payload', (_e, payload) => cb(payload)),
  onFullscreenChanged: (cb) => ipcRenderer.on('gallery-fullscreen-changed', (_e, on) => cb(on)),
  onBackgroundChanged: (cb) => ipcRenderer.on('gallery-background', (_e, mode) => cb(mode)),
});
