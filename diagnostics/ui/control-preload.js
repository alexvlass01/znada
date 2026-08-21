'use strict';

// Preload for the dev-only diagnostics control window. Exposes just the diagnostics IPC
// the small control UI needs — nothing else from the app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diag', {
  status: () => ipcRenderer.invoke('diagnostics-status'),
  start: () => ipcRenderer.invoke('diagnostics-start', { reason: 'manual' }),
  stop: () => ipcRenderer.invoke('diagnostics-stop', { reason: 'manual' }),
  mark: (label) => ipcRenderer.invoke('diagnostics-mark', label || 'lag'),
  testNotification: () => ipcRenderer.invoke('diagnostics-test-notification'),
  openReport: () => ipcRenderer.invoke('diagnostics-open-report'),
  openFolder: () => ipcRenderer.invoke('diagnostics-open-session-folder'),
  exportSanitized: () => ipcRenderer.invoke('diagnostics-export-sanitized'),
  clearSessions: () => ipcRenderer.invoke('diagnostics-clear-sessions'),
});
