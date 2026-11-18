'use strict';

// BUG-084. Move a file into a folder WITHOUT ever replacing what is already there.
//
// Why not fs.renameSync: on Windows libuv implements rename with MoveFileExW and
// MOVEFILE_REPLACE_EXISTING, so a file already at the destination is silently
// overwritten. Checking existsSync first does not help either: another writer can
// create the name between the check and the rename.
//
// So the "is this name free" question and the "take it" step are one call:
//   1. fs.linkSync(src, dest) — a hard link fails with EEXIST if dest exists, and
//      the check and the creation are atomic in the file system (NTFS). Then the
//      source name is unlinked. Same volume only, which is our case: .trash sits
//      inside the folder it is swept from.
//   2. If hard links are not available (FAT32/exFAT drive chosen for Znada's
//      folder, network share, EXDEV), fs.copyFileSync with COPYFILE_EXCL: on Windows
//      CopyFileW with COPY_FILE_FAIL_IF_EXISTS — also exclusive, but a copy rather than
//      a move, so for a moment both names hold the bytes. The size is compared before
//      the source is removed.
//
// A taken name is never retried as-is: the next candidate is `name (2).ext`,
// `name (3).ext`, … The first file to arrive keeps the plain name, which is the one
// restore looks up by basename.
//
// Failure rule: the SOURCE is the thing to protect. Any error leaves it where it was;
// a destination this call created is removed again only when the source is still
// intact, so no step can end with the bytes in neither place.

const path = require('path');
const nodeFs = require('fs');

const MAX_ATTEMPTS = 1000;

function candidateName(name, attempt) {
  if (attempt === 1) return name;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return `${stem} (${attempt})${ext}`;
}

function removeQuietly(fs, file) {
  try { fs.unlinkSync(file); } catch {}
}

/**
 * @param {string} src file to move
 * @param {string} dir destination folder (must already exist)
 * @param {{ fs?: typeof nodeFs, name?: string }} [options]
 * @returns {string} the path the file now has
 */
function moveNoClobber(src, dir, options = {}) {
  const fs = options.fs || nodeFs;
  const name = options.name || path.basename(src);
  let linkUnsupported = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const dest = path.join(dir, candidateName(name, attempt));
    if (!linkUnsupported) {
      try {
        fs.linkSync(src, dest);
      } catch (err) {
        if (err && err.code === 'EEXIST') continue;
        if (err && err.code === 'ENOENT') throw err;
        // Anything else: this volume does not do hard links. Same name, copy route.
        linkUnsupported = true;
      }
      if (!linkUnsupported) {
        try {
          fs.unlinkSync(src);
        } catch (err) {
          // Both names point at the same bytes; dropping ours leaves the source as it was.
          removeQuietly(fs, dest);
          throw err;
        }
        return dest;
      }
    }
    try {
      fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      // Not ours to remove: an error other than EEXIST may still have left a partial
      // file, but the source is untouched and .trash is only ever added to.
      throw err;
    }
    try {
      const copied = fs.statSync(dest).size;
      const original = fs.statSync(src).size;
      if (copied !== original) throw Object.assign(new Error('copy size mismatch'), { code: 'EIO' });
      fs.unlinkSync(src);
    } catch (err) {
      // The source is still there (unlink is the last step), so our copy can go.
      if (fs.existsSync(src)) removeQuietly(fs, dest);
      throw err;
    }
    return dest;
  }
  throw Object.assign(new Error(`no free name for ${name} in ${dir}`), { code: 'EEXIST' });
}

module.exports = { moveNoClobber, candidateName, MAX_ATTEMPTS };
