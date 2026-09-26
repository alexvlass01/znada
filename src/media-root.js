'use strict';

// DATA-006. The one answer to "where do Znada's own copies live".
//
// Until now that was `<profile>\wallpapers`, computed into a module-level constant while
// main.js loaded — before any setting had been read. Two non-obvious rules hang off that
// same path: which files count as Znada's OWN copy (those go to the recoverable
// `.trash` instead of being deleted) and what a window is allowed to read from disk.
// Both must keep following the folder, so every caller asks here instead of building
// the path again.
//
// No filesystem access and no Electron: the existence checks are injected, so this stays
// unit-testable and cannot accidentally decide policy from whatever the test machine
// happens to have mounted.

const path = require('path');
const { isUnderPath } = require('./path-key');

// The default lives inside the profile, exactly where it always did.
const PROFILE_SUBDIR = 'wallpapers';
// Inside the folder the user picks, Znada always creates and uses its OWN subfolder.
// Two reasons, both measured rather than assumed: a window may read anything inside
// the managed folder (`isAuthorizedMediaPath` in main.js), so pointing it straight at
// `Documents` would hand the window every document; and cleanup must never be able to
// reach a file that is not ours.
const DEFAULT_FOLDER_NAME = 'Znada';

const PROBLEMS = {
  RELATIVE: 'relative',   // not an absolute Windows path
  SYSTEM: 'system',       // inside Windows / Program Files and the like
  PROFILE: 'profile',     // inside a Znada profile, or Znada's subfolder there WOULD be the profile
};

// Fold a user-supplied folder into one spelling. Returns '' for anything that is not an
// absolute Windows path, so a relative or empty value can never silently become a root.
function normalizeFolder(value) {
  const raw = String(value == null ? '' : value).trim().replace(/\//g, '\\');
  if (!raw) return '';
  if (!path.win32.isAbsolute(raw)) return '';
  const normalized = path.win32.normalize(raw);
  // `D:\` and `\\server\share\` ARE their own root and keep the separator; nothing else
  // is allowed to carry a trailing one, or two spellings of the same folder appear.
  if (/^[a-z]:\\$/i.test(normalized)) return normalized;
  if (/^\\\\[^\\]+\\[^\\]+\\$/.test(normalized)) return normalized;
  return normalized.replace(/\\+$/, '');
}

// The subfolder name for THIS profile. The ordinary profile gets `Znada`; the dev and
// diagnostics profiles keep their own names (`Znada-Dev`, `Znada-Diagnostics`).
//
// This is not cosmetic. Two profiles sharing one managed folder would each sweep the
// other's files into trash the moment their pools disagreed — and the owner runs the
// dev profile beside the installed app on purpose.
function managedFolderName(userDataPath) {
  const base = path.win32.basename(normalizeFolder(userDataPath) || String(userDataPath || ''));
  if (!base) return DEFAULT_FOLDER_NAME;
  return /^znada$/i.test(base) ? DEFAULT_FOLDER_NAME : base;
}

/**
 * Where this profile's own copies live, and which folder has to exist for that answer
 * to be usable.
 *
 * `anchor` is the folder the user picked (or the profile itself). It is what tells
 * "the drive is gone" apart from "the files were deleted": Znada may create its own
 * subfolder, but it must never create the place the user chose to put it.
 */
function resolveManagedRoot({ userDataPath, mediaFolder } = {}) {
  const profile = String(userDataPath || '');
  const parent = normalizeFolder(mediaFolder);
  if (!parent) {
    return { root: path.win32.join(profile, PROFILE_SUBDIR), parent: '', anchor: profile, custom: false };
  }
  return {
    root: path.win32.join(parent, managedFolderName(profile)),
    parent,
    anchor: parent,
    custom: true,
  };
}

/**
 * Why a chosen folder cannot be used, or null when it can.
 *
 * `systemRoots` is injected (main passes Windows/Program Files/the install directory)
 * so the rule stays pure and the list can grow without touching this logic.
 */
function folderProblem({ folder, userDataPath, systemRoots = [] } = {}) {
  const parent = normalizeFolder(folder);
  if (!parent) return PROBLEMS.RELATIVE;
  // The profile is checked first because it is the more specific answer: inside it the
  // move's source and destination would nest, and the remap refuses that outright.
  // Catch it here, where it can still be explained, rather than at the point of no
  // return — and say "that is Znada's own folder" rather than "that is a system folder"
  // when an installed build happens to keep both under one root.
  if (userDataPath && isUnderPath(parent, userDataPath)) return PROBLEMS.PROFILE;
  // The picked folder is not where the files go: Znada's own subfolder inside it is. Pick
  // the folder the profile sits in and that subfolder IS the profile — %APPDATA% plus
  // "Znada" names %APPDATA%\znada, because Windows ignores case. The sweeper would then
  // take the settings, the pool and the sign-in for orphaned copies, and a window could
  // read them. Measured through the real main.js before this check existed (2026-09-24).
  if (userDataPath) {
    const root = path.win32.join(parent, managedFolderName(userDataPath));
    if (isUnderPath(root, userDataPath) || isUnderPath(userDataPath, root)) return PROBLEMS.PROFILE;
  }
  for (const root of systemRoots) {
    if (root && isUnderPath(parent, root)) return PROBLEMS.SYSTEM;
  }
  return null;
}

/**
 * The runtime state of a resolved root.
 *
 * - `ready`       — the folder is there;
 * - `creatable`   — the place the user picked is there, our subfolder is not yet;
 * - `unavailable` — the chosen folder itself is missing: an unplugged drive, a network
 *   share that does not answer, or a setting that was never valid.
 *
 * Owner's rule (2026-09-09): files on a missing DISK are only out of reach for now, so
 * nothing may be cleaned up or marked as gone. `unavailable` is a freeze, never a fallback.
 */
function rootState({ rootExists, anchorExists, invalid = false } = {}) {
  if (invalid) return { state: 'unavailable', reason: 'invalid' };
  if (rootExists) return { state: 'ready', reason: '' };
  if (anchorExists) return { state: 'creatable', reason: '' };
  return { state: 'unavailable', reason: 'missing' };
}

module.exports = {
  PROFILE_SUBDIR,
  DEFAULT_FOLDER_NAME,
  PROBLEMS,
  normalizeFolder,
  managedFolderName,
  resolveManagedRoot,
  folderProblem,
  rootState,
};
