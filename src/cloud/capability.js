'use strict';

// Znada Cloud capability resolution — C2 (pure, testable).
//
// Decides which cloud environment the app is allowed to talk to and exposes a
// SAFE state to the renderer. The renderer never sees the API URL or tokens — it
// only receives { environment, available, authAvailable, reason }. main.js keeps
// the resolved apiBase privately (used from C3 onward to build the real client).
//
// Environments:
//   unavailable — safe fallback when neither staging nor production is configured.
//   staging     — local dev + manual testing ONLY: requires (a) an unpackaged build
//                 AND (b) an explicit opt-in (env ZNADA_CLOUD=staging). It can never
//                 be activated by accident in an installed build.
//   production  — normal operation for public and ordinary local builds.

const { STAGING_BASE } = require('./client');

const PRODUCTION_ENABLED = true;
const PRODUCTION_BASE = 'https://api.vos.pp.ua';

// Pure resolver. All inputs are injected so this is unit-testable without Electron.
//   isPackaged       — app.isPackaged (installed build = true).
//   stagingOptIn     — explicit dev opt-in (main passes ZNADA_CLOUD === 'staging').
//   productionEnabled / productionBase — wired for C6; injectable for tests.
function resolveCapability({
  isPackaged = true,
  stagingOptIn = false,
  productionEnabled = PRODUCTION_ENABLED,
  productionBase = PRODUCTION_BASE,
  stagingBase = STAGING_BASE,
} = {}) {
  // An explicit unpackaged staging launch must win over production so
  // `npm run dev:cloud` remains a useful isolated backend test environment.
  if (!isPackaged && stagingOptIn) {
    return { environment: 'staging', available: true, authAvailable: true, reason: null, apiBase: stagingBase };
  }
  if (productionEnabled && productionBase) {
    return { environment: 'production', available: true, authAvailable: true, reason: null, apiBase: productionBase };
  }
  // Default safe state: visible UI, disabled actions, no network.
  return { environment: 'unavailable', available: false, authAvailable: false, reason: 'coming_soon', apiBase: null };
}

// Strip the private apiBase before sending capability to the renderer over IPC.
function publicCapability(cap) {
  const c = cap || {};
  return {
    environment: c.environment || 'unavailable',
    available: !!c.available,
    authAvailable: !!c.authAvailable,
    reason: c.reason || null,
  };
}

module.exports = { resolveCapability, publicCapability, PRODUCTION_ENABLED, PRODUCTION_BASE };
