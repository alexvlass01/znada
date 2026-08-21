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
  onPayload: (cb) => ipcRenderer.on('gallery-payload', (_e, payload) => cb(payload)),
  onFullscreenChanged: (cb) => ipcRenderer.on('gallery-fullscreen-changed', (_e, on) => cb(on)),
  onBackgroundChanged: (cb) => ipcRenderer.on('gallery-background', (_e, mode) => cb(mode)),
});
