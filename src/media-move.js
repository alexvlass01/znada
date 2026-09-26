'use strict';

// DATA-006 step 2. Moving the folder of Znada's own copies to the place the user chose.
//
// The order is the owner's decision (2026-09-09) and it does not get rearranged:
//
//   copy everything -> verify every copy -> one atomic write of the library -> delete the old
//
// There is exactly ONE point of no return: the library write. Before it, stopping costs
// nothing — the originals have not been touched, so the only thing to undo is the files
// we created. After it, the library already names the new, verified files, and going
// back would point it at what we are about to delete; there the only safe direction is
// forward, finishing the cleanup.
//
// Nothing is ever renamed across the boundary. A move would be faster on the same drive
// and would also mean that a crash halfway leaves half the photos in a folder the
// library no longer names. Copy, verify, then delete.
//
// Verification is by CONTENT, not by file name. New copies are named after their own
// content hash (`wp-<md5>`), but profiles carry files from before that was true, and
// their names say nothing about the bytes inside. Hashing the source while it streams
// and hashing what landed catches a truncated copy either way.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { isUnderPath } = require('./path-key');

// Our half-written files. The prefix is what tells a leftover of ours apart from a
// user's file if a crash leaves one behind, so the sweep may only ever delete these.
const STAGING_PREFIX = '.znada-move-';
// Free space has to cover the copy with room left over; a disk filled to the last byte
// by us is a different kind of broken.
const FREE_SPACE_MARGIN = 64 * 1024 * 1024;

const BLOCKERS = {
  NESTED: 'nested',                 // one folder is inside the other
  SOURCE_MISSING: 'source-missing', // nothing to move
  DESTINATION_MISSING: 'destination-missing', // the place the user picked is not there
  NO_SPACE: 'no-space',
};

function hashStream(hash) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

async function hashFile(file) {
  const hash = crypto.createHash('md5');
  await pipeline(fs.createReadStream(file), hashStream(hash), new Transform({
    transform(_chunk, _encoding, callback) { callback(); },
  }));
  return hash.digest('hex');
}

// Every file under `root`, relative to it, including the recoverable `.trash` beside
// them — leaving that behind would quietly take away the user's undo.
function listFiles(root, relative = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(root, rel));
      continue;
    }
    if (!entry.isFile()) continue;                       // links are not ours to follow
    if (entry.name.startsWith(STAGING_PREFIX)) continue; // a leftover of ours, not content
    let size = 0;
    try { size = fs.statSync(path.join(root, rel)).size; } catch { continue; }
    out.push({ relative: rel, size });
  }
  return out;
}

function freeBytesFor(dir) {
  // Walk up to the nearest folder that exists: the destination subfolder is usually
  // about to be created, and statfs on a path that is not there tells us nothing.
  let probe = path.resolve(dir);
  for (let i = 0; i < 40; i += 1) {
    try {
      const stats = fs.statfsSync(probe);
      return Number(stats.bsize) * Number(stats.bavail);
    } catch { /* keep walking up */ }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return null; // unknown — do not invent a number, let the caller decide
}

/**
 * What the move would involve, and what stands in its way. Reads only.
 *
 * `anchor` is the folder the user picked. Znada may create its own subfolder inside it
 * but must never create the place itself: a drive that is not mounted would otherwise
 * turn into a brand new empty folder on C:.
 *
 * `fromAnchor` is the same thing for the folder we move OUT of (BUG-050). Znada makes its
 * own folder only when the first picture lands, so a profile that never downloaded or
 * added one has none — and that is nothing to move, not a folder gone missing. Only
 * the caller knows where the source was meant to live, so without `fromAnchor` a
 * missing source stays refused. With it, the place decides: there, and the folder is
 * simply empty; not there (an unplugged drive), and the refusal stands.
 */
function planMove({ from, to, anchor, fromAnchor }) {
  const source = String(from || '');
  const destination = String(to || '');
  const place = String(anchor || path.dirname(destination));
  const blockers = [];

  if (isUnderPath(destination, source) || isUnderPath(source, destination)) {
    blockers.push({ code: BLOCKERS.NESTED });
  }
  let sourceExists = false;
  try { sourceExists = fs.statSync(source).isDirectory(); } catch { sourceExists = false; }
  let sourcePlaceExists = false;
  if (!sourceExists && fromAnchor) {
    try { sourcePlaceExists = fs.statSync(String(fromAnchor)).isDirectory(); } catch { sourcePlaceExists = false; }
  }
  if (!sourceExists && !sourcePlaceExists) blockers.push({ code: BLOCKERS.SOURCE_MISSING });
  let placeExists = false;
  try { placeExists = fs.statSync(place).isDirectory(); } catch { placeExists = false; }
  if (!placeExists) blockers.push({ code: BLOCKERS.DESTINATION_MISSING });

  const files = sourceExists ? listFiles(source) : [];
  const bytes = files.reduce((sum, file) => sum + file.size, 0);

  const free = placeExists ? freeBytesFor(destination) : null;
  if (free != null && free < bytes + FREE_SPACE_MARGIN) {
    blockers.push({ code: BLOCKERS.NO_SPACE, needed: bytes + FREE_SPACE_MARGIN, free });
  }

  return { from: source, to: destination, anchor: place, files, count: files.length, bytes, free, blockers };
}

/**
 * One file, copied through a private staging name and proved by its content.
 *
 * A file already at the destination is only accepted when its bytes are identical —
 * which is the ordinary case, because identical pictures share a content-addressed
 * name. Anything else is a real collision and stops the move rather than overwriting
 * something that is not ours.
 */
async function copyVerified(sourceFile, destinationFile) {
  const dir = path.dirname(destinationFile);
  fs.mkdirSync(dir, { recursive: true });

  const sourceHash = crypto.createHash('md5');
  const staging = path.join(dir, `${STAGING_PREFIX}${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await pipeline(
      fs.createReadStream(sourceFile),
      hashStream(sourceHash),
      fs.createWriteStream(staging, { flags: 'wx' }),
    );
    const expected = sourceHash.digest('hex');
    // Read back what actually landed. This is the whole point of "verify": a short
    // write, a full disk or a flaky drive all produce a file that exists and is wrong.
    const landed = await hashFile(staging);
    if (landed !== expected) throw new Error(`copy did not match the source: ${sourceFile}`);

    if (fs.existsSync(destinationFile)) {
      const there = await hashFile(destinationFile);
      if (there === expected) {
        fs.rmSync(staging, { force: true });
        return { status: 'already-there', created: false };
      }
      throw new Error(`a different file is already there: ${destinationFile}`);
    }
    fs.renameSync(staging, destinationFile);
    return { status: 'copied', created: true };
  } finally {
    try { if (fs.existsSync(staging)) fs.rmSync(staging, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * The move itself.
 *
 * `remap` recomputes the library documents for the new folder and throws rather than
 * guessing (src/profile-migration.js). It runs twice on purpose: once before a single
 * byte is copied, so a profile that cannot be remapped costs nothing, and once more
 * immediately before the commit, so what is written is built from the documents as they
 * are at that moment.
 *
 * `commit` is the point of no return and must write atomically.
 */
async function runMove({
  from, to, anchor, fromAnchor, remap, commit, onProgress = () => {}, shouldStop = () => false,
}) {
  const plan = planMove({ from, to, anchor, fromAnchor });
  const report = {
    status: 'failed', plan, blockers: plan.blockers, copied: 0, alreadyThere: 0, bytesDone: 0, removed: 0,
    createdFiles: [], committed: false, error: null,
  };
  if (plan.blockers.length) {
    report.status = 'blocked';
    return report;
  }

  const progress = (phase) => onProgress({
    phase,
    done: report.copied + report.alreadyThere,
    total: plan.count,
    bytesDone: report.bytesDone,
    bytesTotal: plan.bytes,
  });

  // Fail fast, before any bytes move: an id collision or a reference that cannot travel
  // is a refusal, and the user should hear it in a second rather than after ten minutes.
  try {
    remap();
  } catch (err) {
    report.status = 'failed';
    report.error = err;
    return report;
  }

  progress('copying');
  for (const file of plan.files) {
    if (shouldStop()) {
      rollback(report.createdFiles, plan.to);
      report.status = 'stopped';
      return report;
    }
    try {
      const result = await copyVerified(path.join(plan.from, file.relative), path.join(plan.to, file.relative));
      if (result.created) report.createdFiles.push(path.join(plan.to, file.relative));
      if (result.status === 'copied') report.copied += 1; else report.alreadyThere += 1;
      report.bytesDone += file.size;
    } catch (err) {
      // Nothing of the user's has been touched yet, so the honest answer is to undo our
      // own files and say what failed.
      rollback(report.createdFiles, plan.to);
      report.status = 'failed';
      report.error = err;
      return report;
    }
    progress('copying');
  }

  // Last chance to stop: after this the library names the new files.
  if (shouldStop()) {
    rollback(report.createdFiles, plan.to);
    report.status = 'stopped';
    return report;
  }

  progress('committing');
  try {
    commit(remap());
    report.committed = true;
  } catch (err) {
    rollback(report.createdFiles, plan.to);
    report.status = 'failed';
    report.error = err;
    return report;
  }

  // ---- past the point of no return -----------------------------------------
  // Only files whose copy was verified are removed, and a failure here costs disk
  // space, never data: the library already points at the copies.
  progress('cleaning');
  for (const file of plan.files) {
    try {
      fs.rmSync(path.join(plan.from, file.relative), { force: true });
      report.removed += 1;
    } catch { /* leftovers are harmless; the library no longer names them */ }
  }
  removeEmptyDirs(plan.from);

  report.status = 'done';
  progress('done');
  return report;
}

// Undo OUR files only. A file that was already at the destination was not created by
// this move and is none of its business — nor is a folder that still holds one, which
// is why the folders are pruned only while they are empty.
function rollback(createdFiles, destinationRoot) {
  for (const file of createdFiles) {
    try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  }
  if (destinationRoot) removeEmptyDirs(destinationRoot);
}

function removeEmptyDirs(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) removeEmptyDirs(path.join(root, entry.name));
  }
  try {
    if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
  } catch { /* not empty, or in use — leave it */ }
}

module.exports = {
  BLOCKERS,
  STAGING_PREFIX,
  FREE_SPACE_MARGIN,
  planMove,
  copyVerified,
  runMove,
  hashFile,
};
