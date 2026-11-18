'use strict';

// DATA-001. The last few GOOD copies of Znada's small data files, and the one way back
// to them.
//
// Owner decision 2026-11-01: no export file, no buttons, no photos. The only thing worth
// protecting against is "the main file broke": a damaged config.json used to mean every
// setting back to defaults, a damaged library file a write-locked library with nothing to
// go back to, a damaged folder index an empty one. Bookmarks already keep a .bak of their
// own (src/bookmark-store.js); these three did not.
//
// What makes a copy worth keeping is that it LOADED. Every candidate is passed through the
// same acceptance its loader applies before it is written here, and again before it is
// handed back, so a file that was already damaged can never become the "good" copy and a
// copy damaged later is skipped for the next older one.
//
// Copies are a few kilobytes to a couple of megabytes each and live in <profile>\backups.
// They are this module's own rotation: pruning them deletes nothing the user made.
//
// Never throws. A copy that cannot be taken is a missed safety net, not a reason to break
// the save or the startup that asked for it.

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  // Six copies at most one per four hours: about a day of active use, while the copy a
  // damaged file falls back to is never more than a few hours behind.
  keep: 6,
  intervalMs: 4 * 60 * 60 * 1000,
});

const KIND_RE = /^[a-z][a-z-]*$/;

function copyName(kind, takenAt) {
  return `${kind}-${String(takenAt).padStart(13, '0')}.json`;
}

function parseCopyName(kind, name) {
  const prefix = `${kind}-`;
  if (!name.startsWith(prefix) || !name.endsWith('.json')) return null;
  const stamp = name.slice(prefix.length, -'.json'.length);
  if (!/^\d{13,}$/.test(stamp)) return null;
  const takenAt = Number(stamp);
  return Number.isSafeInteger(takenAt) ? takenAt : null;
}

/**
 * @param {{
 *   dir: string,
 *   kinds: Record<string, { file: string, accept: (text: string) => boolean }>,
 *   keep?: number,
 *   intervalMs?: number,
 *   now?: () => number,
 *   fsModule?: typeof fs,
 *   log?: { error: (...args: any[]) => void },
 * }} options
 */
function createDataSnapshots({
  dir, kinds, keep = DEFAULTS.keep, intervalMs = DEFAULTS.intervalMs,
  now = () => Date.now(), fsModule = fs, log = console,
}) {
  const known = new Map();
  for (const [kind, spec] of Object.entries(kinds || {})) {
    if (!KIND_RE.test(kind) || !spec || typeof spec.file !== 'string' || typeof spec.accept !== 'function') {
      throw new Error(`data-snapshots: bad kind ${kind}`);
    }
    known.set(kind, spec);
  }

  function specFor(kind) {
    const spec = known.get(kind);
    if (!spec) throw new Error(`data-snapshots: unknown kind ${kind}`);
    return spec;
  }

  function accepts(spec, text) {
    try { return typeof text === 'string' && spec.accept(text) === true; } catch { return false; }
  }

  // Newest first. Anything in the folder that is not one of our names is ignored, so a
  // file someone put there by hand is neither offered as a copy nor pruned.
  function list(kind) {
    specFor(kind);
    let names = [];
    try { names = fsModule.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      const takenAt = parseCopyName(kind, name);
      if (takenAt != null) out.push({ path: path.join(dir, name), takenAt });
    }
    return out.sort((a, b) => b.takenAt - a.takenAt);
  }

  function readText(file) {
    try { return fsModule.readFileSync(file, 'utf8'); } catch { return null; }
  }

  function prune(kind) {
    for (const old of list(kind).slice(Math.max(1, keep))) {
      try { fsModule.unlinkSync(old.path); } catch {}
    }
  }

  // Copies the live file when the newest copy is older than the interval (or `force`),
  // the live file is accepted, and its bytes differ from the newest copy. Returns what
  // happened, for tests and logs: taken | fresh | same | missing | rejected | failed.
  function take(kind, { force = false } = {}) {
    const spec = specFor(kind);
    const at = now();
    const copies = list(kind);
    const newest = copies[0] || null;
    // A newest copy stamped in the future (clock moved back) is not "fresh": waiting for
    // the clock to catch up would leave the file without a recent copy for that long.
    if (!force && newest && newest.takenAt <= at && at - newest.takenAt < intervalMs) return 'fresh';
    const text = readText(spec.file);
    if (text == null) return 'missing';
    if (!accepts(spec, text)) return 'rejected';
    if (newest && readText(newest.path) === text) return 'same';
    const stamp = newest && newest.takenAt >= at ? newest.takenAt + 1 : at;
    const target = path.join(dir, copyName(kind, stamp));
    const tmp = `${target}.tmp`;
    try {
      fsModule.mkdirSync(dir, { recursive: true });
      fsModule.writeFileSync(tmp, text, 'utf8');
      fsModule.renameSync(tmp, target);
    } catch (err) {
      try { fsModule.unlinkSync(tmp); } catch {}
      log.error(`Не удалось сохранить копию ${kind}:`, err);
      return 'failed';
    }
    prune(kind);
    return 'taken';
  }

  function takeAll(options) {
    const out = {};
    for (const kind of known.keys()) out[kind] = take(kind, options);
    return out;
  }

  // The newest copy that still loads, or null. Older copies are tried in turn: a copy
  // damaged on disk after it was taken must not stand between the user and the one
  // before it.
  function findGood(kind) {
    const spec = specFor(kind);
    for (const copy of list(kind)) {
      const text = readText(copy.path);
      if (accepts(spec, text)) return { text, takenAt: copy.takenAt, path: copy.path };
    }
    return null;
  }

  return Object.freeze({ list, take, takeAll, findGood, dir });
}

module.exports = { createDataSnapshots, DEFAULTS };
