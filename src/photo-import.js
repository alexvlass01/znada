'use strict';

// LIB-022 + LIB-023. What adding one local photo turns into: Znada's own copy, and
// under what name — or no copy at all, because the file is already in a watched folder.
//
// Name (LIB-022). The copy used to be called `wp-<hash>`, and the original name was
// stored nowhere. Everything that shows a photo's name — search, sorting by name, the
// status line, "Details", "Save as…", the folder of copies the user picks themselves —
// reads it from the FILE, so a photo added on its own was the one kind of photo with
// no name anywhere. Naming the copy itself `<name>-<hash>.<ext>` fixes all of those at
// once; a separate "display name" field would have to be remembered in each of them.
//
// The hash tail keeps the old rule: the same picture added twice is one copy. Before
// writing, an existing copy with the same hash is reused, whatever its name — an old
// `wp-<hash>` copy included, since those cannot be renamed honestly (their original
// names were never kept).
//
// Reference (LIB-023). A file that already lies inside a watched folder is shown by
// that folder. Copying it made a second card of the same picture; it is added the way
// a star adds it instead — a record that points at the original.

const path = require('path');
const { isUnderPath } = require('./path-key');

// The hash is part of the identity, so its length is not cosmetic: 16 hex digits is
// what the old names used, and a shorter tail would make two different pictures far
// more likely to be taken for one.
const HASH_LENGTH = 16;
// Enough for any real name to stay recognisable; the whole file name stays well inside
// the Windows path limit even in a deep folder of copies.
const MAX_NAME_CHARS = 60;
// What a name falls back to when nothing usable is left of it — the old prefix, so such
// a copy looks exactly like the copies made before this change.
const FALLBACK_NAME = 'wp';

// Characters Windows refuses in a file name, plus control characters.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

// The part of the original file name the copy keeps. Always a valid Windows name piece:
// forbidden characters become `_`, leading/trailing dots and spaces go (a trailing dot
// is silently dropped by Windows, a leading one would hide the file next to our own
// `.trash` and staging files), and the length is counted in characters, never cutting
// a character in half. Cyrillic and other scripts are kept as they are.
function copyBaseName(srcPath) {
  const base = path.win32.basename(String(srcPath || ''));
  const ext = path.win32.extname(base);
  let stem = (ext ? base.slice(0, -ext.length) : base).normalize('NFC');
  // Whitespace first: a tab is also a control character, and it should read as a space.
  stem = stem.replace(/\s+/g, ' ').replace(FORBIDDEN, '_');
  stem = stem.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  const chars = Array.from(stem);
  if (chars.length > MAX_NAME_CHARS) {
    stem = chars.slice(0, MAX_NAME_CHARS).join('').replace(/[\s.]+$/, '');
  }
  return stem || FALLBACK_NAME;
}

// The extension the copy gets. Lower case as before; a file without one keeps the old
// `.img` placeholder.
function copyExtension(srcPath) {
  const ext = path.win32.extname(path.win32.basename(String(srcPath || ''))).toLowerCase();
  return ext || '.img';
}

function copyFileName(srcPath, hash) {
  return `${copyBaseName(srcPath)}-${String(hash).slice(0, HASH_LENGTH)}${copyExtension(srcPath)}`;
}

// The files among `names` (the plain file names in the folder of copies) that may be an
// existing copy of the same picture: both `wp-<hash>.png` and `<any name>-<hash>.png`
// qualify. Dot-files are ours (staging, trash) and never a copy. Sorted, so which one is
// reused does not depend on the order the disk lists them in. Only candidates: the
// caller still confirms the size before reusing one.
function existingCopies(names, hash, ext) {
  const tail = `-${String(hash).slice(0, HASH_LENGTH)}${ext}`.toLowerCase();
  return (Array.isArray(names) ? names : [])
    .filter((name) => typeof name === 'string' && !name.startsWith('.')
      && name.length > tail.length && name.toLowerCase().endsWith(tail))
    .sort();
}

// The watched folder that already shows `filePath`, or '' when none does. A folder the
// user removed from the library (a removed subfolder of a watched one included) does
// not show it, so a file there is still copied, as before.
function watchedFolderFor(filePath, folderPaths, removedDirPaths) {
  if (!filePath) return '';
  for (const removed of removedDirPaths || []) {
    if (removed && isUnderPath(filePath, removed)) return '';
  }
  for (const folder of folderPaths || []) {
    if (folder && isUnderPath(filePath, folder)) return folder;
  }
  return '';
}

module.exports = {
  HASH_LENGTH,
  MAX_NAME_CHARS,
  copyBaseName,
  copyExtension,
  copyFileName,
  existingCopies,
  watchedFolderFor,
};
