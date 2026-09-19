'use strict';

// COLLAB-003. Is this a DEV check, a DIAG check or an ordinary launch — and must it be
// refused before it opens anything?
//
// The answer ships with the app for the same reason src/diagnostics-gate.js and
// src/cloud/dev-profile.js do: main.js has to be able to ask. What the answer switches on
// — the label naming the code, the revision read from git, the one-hour limit — lives in
// diagnostics/main/dev-launch.js, which no user package contains. A packaged build is an
// ordinary launch whatever it was started with, so it has neither the limit nor a way to
// arm it.
//
// The refusals exist because both check launches used to fall back without a word. Staging
// without a profile opened the real %APPDATA%\znada, and half of the DIAG opt-in became an
// ordinary run on that same profile. A check window that quietly shows production data is
// worse than none: whoever looks at it believes they are looking at a check.

const REFUSALS = Object.freeze({
  DEV_WITHOUT_PROFILE: 'dev_without_profile',
  DIAG_INCOMPLETE: 'diag_incomplete',
  DIAG_WITHOUT_PROFILE: 'diag_without_profile',
});

/**
 * @param {object} [options]
 * @param {boolean} [options.isPackaged] Anything but an explicit `false` counts as packaged.
 * @param {{ enabled?: boolean, requested?: boolean, reason?: string, userDataPath?: string|null }|null} [options.diagnostics]
 *   What src/diagnostics-gate.js decided for this launch.
 * @param {boolean} [options.stagingRequested] `ZNADA_CLOUD=staging` was set.
 * @param {string|null} [options.stagingUserData] What src/cloud/dev-profile.js resolved.
 * @returns {{ mode: 'dev'|'diag'|null, refusal: string|null, userDataPath: string|null }}
 */
function resolveDevLaunch({
  isPackaged = true,
  diagnostics = null,
  stagingRequested = false,
  stagingUserData = null,
} = {}) {
  const ordinary = { mode: null, refusal: null, userDataPath: null };
  if (isPackaged !== false) return ordinary;

  // Diagnostics first, in the same order main.js chooses the profile in.
  if (diagnostics && diagnostics.enabled) {
    return { mode: 'diag', refusal: null, userDataPath: diagnostics.userDataPath || null };
  }
  if (diagnostics && diagnostics.requested) {
    const refusal = diagnostics.reason === 'missing_user_data_path'
      ? REFUSALS.DIAG_WITHOUT_PROFILE
      : REFUSALS.DIAG_INCOMPLETE;
    return { mode: null, refusal, userDataPath: null };
  }

  if (stagingRequested) {
    return stagingUserData
      ? { mode: 'dev', refusal: null, userDataPath: stagingUserData }
      : { mode: null, refusal: REFUSALS.DEV_WITHOUT_PROFILE, userDataPath: null };
  }
  return ordinary;
}

module.exports = { REFUSALS, resolveDevLaunch };
