'use strict';

const { createVideoSession } = require('./video-session');
const { runtimeDirectory, verifyRuntime } = require('./video-runtime');
const { openVideoStream } = require('./online-video');
const { duplicateTextureHandle } = require('./video-handles');

function createVideoPlayer({ app, createWorker, sharedTexture, window, resolveEntry, openExternal }) {
  let dll;
  return createVideoSession({
    resolveEntry, openExternal,
    createWorker(entry, signal) {
      // Verify once per viewer, not for every frame/file. Only this pinned dev/package resource loads.
      // Build/package verifies the pin; a user may replace the dynamic LGPL DLL
      // with a compatible build in this fixed resource directory.
      dll ||= verifyRuntime(runtimeDirectory(app), { verifyDigest: false });
      const worker = createWorker();
      worker.once('spawn', async () => {
        if (signal.aborted) return;
        try {
          if (!entry.online) {
            worker.postMessage({ type: 'start', dll, file: entry.path });
            return;
          }
          const { url } = await openVideoStream(entry.online, entry.headers, { signal });
          if (!signal.aborted) worker.postMessage({ type: 'start', dll, file: url, format: entry.online.format });
        } catch {
          if (!signal.aborted) worker.kill();
        }
      });
      return worker;
    },
    duplicateHandle: duplicateTextureHandle,
    importTexture: options => sharedTexture.importSharedTexture(options),
    sendTexture: (texture, info) => sharedTexture.sendSharedTexture({ frame: window.webContents.mainFrame, importedSharedTexture: texture }, info),
    sendState: state => { if (!window.isDestroyed()) window.webContents.send('gallery-video-state', state); },
  });
}
module.exports = { createVideoPlayer };
