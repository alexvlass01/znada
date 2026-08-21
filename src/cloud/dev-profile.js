'use strict';

const path = require('path');

// Staging may use a separate Electron userData directory, but only in an
// unpackaged build with an explicit staging opt-in. Packaged builds always keep
// their normal production profile even if inherited environment variables exist.
function resolveStagingUserData({ isPackaged = true, cloudEnv = '', requestedPath = '' } = {}) {
  if (isPackaged || String(cloudEnv).trim() !== 'staging') return null;
  const raw = String(requestedPath || '').trim();
  return raw ? path.resolve(raw) : null;
}

module.exports = { resolveStagingUserData };
