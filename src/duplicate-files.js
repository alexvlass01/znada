'use strict';

// LIB-030. Which files in the library are the same file more than once.
//
// "The same" means byte for byte: the same fingerprint (src/fingerprint.js, MD5 today).
// A resized or re-encoded copy is a different file here. Finding those is LIB-002 — a
// different kind of fingerprint, not a looser comparison of this one.
//
// Two files of different sizes cannot hold the same bytes, so only files that share their
// size with another file are ever fingerprinted. On the owner's library (5508 photos,
// 18.6 GB, measured 2026-11-02) that is a few hundred files read in seconds instead of
// every byte of the library.
//
// The user hears about a copy once. What has been announced is remembered per file, and
// only copies nobody has been told about yet count as new — the owner asked for a
// notification each time new copies turn up, never a repeat of the old ones.
//
// No filesystem and no Electron here: the service in src/library-checks.js feeds it.

const { pathKey } = require('./path-key');

const STATE_VERSION = 1;
// A memory of announcements, not a record of the library: bounded so it cannot grow
// without limit. Losing an entry costs at most one repeated notification.
const ANNOUNCED_LIMIT = 50000;

function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// The files worth fingerprinting: every file whose size another file also has.
// `files` is [{ path, size, video }]. Pictures come before videos — videos are few, large
// and slow to read, and a pass interrupted by a game should have the pictures done.
function candidates(files) {
  const bySize = new Map();
  const seen = new Set();
  for (const file of (Array.isArray(files) ? files : [])) {
    if (!file || typeof file.path !== 'string' || !file.path) continue;
    const size = Number(file.size);
    if (!Number.isFinite(size) || size <= 0) continue;
    const key = pathKey(file.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const list = bySize.get(size) || [];
    list.push({ key, path: file.path, size, video: file.video === true });
    bySize.set(size, list);
  }
  const out = [];
  for (const list of bySize.values()) if (list.length > 1) out.push(...list);
  return out.sort((a, b) => (Number(a.video) - Number(b.video))
    || (b.size - a.size)
    || compareText(a.key, b.key));
}

// Fingerprinted files → groups of two or more. Largest first: that is where a copy costs
// the most space. Files inside a group keep a stable order so the view does not shuffle
// between passes.
function groupsOf(entries) {
  const byHash = new Map();
  for (const entry of (Array.isArray(entries) ? entries : [])) {
    if (!entry || !entry.key || !entry.path) continue;
    const hash = typeof entry.hash === 'string' ? entry.hash.trim().toLowerCase() : '';
    if (!hash) continue;
    const group = byHash.get(hash) || { hash, size: Number(entry.size) || 0, files: [] };
    if (group.files.some((file) => file.key === entry.key)) continue;
    group.files.push({ key: entry.key, path: entry.path });
    byHash.set(hash, group);
  }
  return Array.from(byHash.values())
    .filter((group) => group.files.length > 1)
    .map((group) => ({ ...group, files: group.files.slice().sort((a, b) => compareText(a.key, b.key)) }))
    .sort((a, b) => (b.size - a.size) || compareText(a.hash, b.hash));
}

// Groups as they stand NOW: a file the user has since removed, hidden or deleted leaves
// its group at once, without waiting for the next pass. `presentKeys` is the set of path
// keys the library shows at this moment.
function presentGroups(groups, presentKeys) {
  const out = [];
  for (const group of (Array.isArray(groups) ? groups : [])) {
    if (!group || !Array.isArray(group.files)) continue;
    const files = group.files.filter((file) => file && presentKeys.has(file.key));
    if (files.length > 1) out.push({ ...group, files });
  }
  return out;
}

// How many files could go without losing a single picture: every copy past the first.
function extraCopies(groups) {
  let extra = 0;
  for (const group of (Array.isArray(groups) ? groups : [])) {
    if (group && Array.isArray(group.files)) extra += Math.max(0, group.files.length - 1);
  }
  return extra;
}

// Copies nobody has been told about. A whole new pair is one new copy, not two files; a
// third file joining an announced pair is one new copy. A file counts as announced only
// with the fingerprint it had when announced — the same name holding new bytes is new.
function freshCopies(groups, announced) {
  const told = announced && typeof announced === 'object' ? announced : {};
  let fresh = 0;
  for (const group of (Array.isArray(groups) ? groups : [])) {
    if (!group || !Array.isArray(group.files)) continue;
    const known = group.files.filter((file) => told[file.key] === group.hash).length;
    fresh += Math.max(0, group.files.length - 1) - Math.max(0, known - 1);
  }
  return Math.max(0, fresh);
}

// After the user has been told: every file now in a group counts as announced. Nothing
// is forgotten just because a copy left the library for a while — removing one copy and
// putting it back must not announce it again. The memory is bounded instead, keeping the
// newest announcements.
function announce(groups, announced) {
  const next = {};
  const held = announced && typeof announced === 'object' ? announced : {};
  for (const [key, hash] of Object.entries(held)) {
    if (key && typeof hash === 'string' && hash) next[key] = hash;
  }
  for (const group of (Array.isArray(groups) ? groups : [])) {
    if (!group || !Array.isArray(group.files)) continue;
    for (const file of group.files) {
      if (!file || !file.key) continue;
      // Re-inserted so the newest announcements are the ones the bound keeps.
      delete next[file.key];
      next[file.key] = group.hash;
    }
  }
  const keys = Object.keys(next);
  if (keys.length <= ANNOUNCED_LIMIT) return next;
  const bounded = {};
  for (const key of keys.slice(keys.length - ANNOUNCED_LIMIT)) bounded[key] = next[key];
  return bounded;
}

function emptyState() {
  return { version: STATE_VERSION, checkedAt: 0, groups: [], announced: {} };
}

// The persisted shape, healed: anything unreadable is simply absent. Like the fingerprint
// cache this is derived knowledge — losing it costs a pass and, at worst, one repeated
// notification, never anything the user made.
function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
  const at = Number(raw.checkedAt);
  state.checkedAt = Number.isFinite(at) && at > 0 ? at : 0;
  const entries = [];
  for (const group of (Array.isArray(raw.groups) ? raw.groups : [])) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.files)) continue;
    for (const file of group.files) {
      if (!file || typeof file.path !== 'string' || !file.path) continue;
      entries.push({ key: pathKey(file.path), path: file.path, size: group.size, hash: group.hash });
    }
  }
  state.groups = groupsOf(entries);
  if (raw.announced && typeof raw.announced === 'object' && !Array.isArray(raw.announced)) {
    for (const [key, hash] of Object.entries(raw.announced)) {
      if (key && typeof hash === 'string' && hash) state.announced[key] = hash.trim().toLowerCase();
    }
  }
  return state;
}

module.exports = {
  STATE_VERSION,
  ANNOUNCED_LIMIT,
  candidates,
  groupsOf,
  presentGroups,
  extraCopies,
  freshCopies,
  announce,
  emptyState,
  normalizeState,
};
