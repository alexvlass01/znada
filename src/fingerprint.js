'use strict';

// What a local file IS, for the purpose of asking somebody else about it.
//
// META-001 asks an external catalogue "do you have this exact file". The question is
// asked about a fingerprint, never about the file itself: no bytes, no name and no path
// leave the machine. Today the only fingerprint is MD5 over the file's bytes, which is
// what the booru APIs index. Perceptual hashes for "same picture, different encoding"
// are the obvious next kind, so a fingerprint is a RECORD OF KINDS from the start
// rather than a bare string — adding pHash later must not mean re-reading every file
// or migrating the cache.
//
// Hashing a file is the expensive half of the operation, so the answer is cached. The
// cache has to be able to say "this file changed" without reading it again, hence the
// stamp: a file whose size and modification time both match is the file we hashed.
// That is the same evidence Windows itself uses for its thumbnail cache, and the same
// evidence Znada's own thumbnail keys already use.
//
// No filesystem and no Electron here — stat data is passed in — so this stays a plain
// unit-testable module.

const { pathKey } = require('./path-key');

// Bumping a kind's version invalidates every cached value of that kind and nothing
// else. It exists so that a future change in how a fingerprint is computed (a
// different pHash size, say) cannot silently compare new values against old ones.
const KIND_VERSIONS = Object.freeze({
  md5: 1,
});

const KINDS = Object.freeze(Object.keys(KIND_VERSIONS));

function isKnownKind(kind) {
  return Object.prototype.hasOwnProperty.call(KIND_VERSIONS, kind);
}

// The cache is keyed by the canonical path key, not the raw path: the same file
// reached as `C:\x\a.jpg` and `c:/x/../x/a.jpg` must not be hashed twice.
function fileKey(p) {
  return pathKey(p);
}

// Modification time arrives as a float from fs.Stats and as an integer from JSON after
// a round trip. Flooring both makes a reloaded cache entry match the live stat instead
// of looking stale on the first check after every restart.
function stampOf(stat) {
  if (!stat || typeof stat !== 'object') return null;
  const size = Number(stat.size);
  const raw = Number(stat.mtimeMs != null ? stat.mtimeMs : stat.mtime);
  if (!Number.isFinite(size) || size < 0 || !Number.isFinite(raw) || raw <= 0) return null;
  return { size: Math.floor(size), mtimeMs: Math.floor(raw) };
}

function sameStamp(a, b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stamp = stampOf(raw);
  if (!stamp) return null;
  const values = {};
  const source = raw.values && typeof raw.values === 'object' ? raw.values : {};
  for (const kind of KINDS) {
    const held = source[kind];
    if (!held || typeof held !== 'object') continue;
    const value = typeof held.value === 'string' ? held.value.trim().toLowerCase() : '';
    const version = Number(held.v);
    if (!value || !Number.isFinite(version)) continue;
    values[kind] = { value, v: version };
  }
  return { size: stamp.size, mtimeMs: stamp.mtimeMs, values };
}

// True when the cached answer may not be used for `kind` and the file has to be read.
// Deliberately fail-open towards recomputing: an unreadable or half-written cache entry
// costs one hash, while trusting it would attach another picture's tags to this file.
function needsCompute(entry, stamp, kind) {
  if (!isKnownKind(kind) || !stamp) return true;
  const held = normalizeEntry(entry);
  if (!held || !sameStamp(held, stamp)) return true;
  const value = held.values[kind];
  return !value || value.v !== KIND_VERSIONS[kind];
}

// Which of the requested kinds still have to be computed for this file.
function missingKinds(entry, stamp, kinds) {
  const wanted = Array.isArray(kinds) && kinds.length ? kinds : KINDS;
  return wanted.filter((kind) => isKnownKind(kind) && needsCompute(entry, stamp, kind));
}

// Fold freshly computed values into a cache entry. A changed stamp DROPS the old
// values rather than merging onto them: the file is a different file now, and keeping
// a stale sibling value is exactly how the wrong post would get attached.
function withValues(entry, stamp, values) {
  if (!stamp) return null;
  const held = normalizeEntry(entry);
  const base = held && sameStamp(held, stamp) ? held.values : {};
  const next = { ...base };
  for (const [kind, value] of Object.entries(values || {})) {
    if (!isKnownKind(kind)) continue;
    const clean = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!clean) continue;
    next[kind] = { value: clean, v: KIND_VERSIONS[kind] };
  }
  return { size: stamp.size, mtimeMs: stamp.mtimeMs, values: next };
}

// The cached fingerprint of one kind, or '' when it has to be computed. Callers use
// the empty string as "ask the disk", so a version mismatch must return '' and not the
// outdated value.
function valueOf(entry, stamp, kind) {
  if (needsCompute(entry, stamp, kind)) return '';
  return normalizeEntry(entry).values[kind].value;
}

module.exports = {
  KIND_VERSIONS,
  KINDS,
  isKnownKind,
  fileKey,
  stampOf,
  sameStamp,
  normalizeEntry,
  needsCompute,
  missingKinds,
  withValues,
  valueOf,
};
