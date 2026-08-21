'use strict';

// Pure-ish playlist logic for the slideshow engine, extracted from main.js so it
// can be unit-tested WITHOUT launching Electron (see test/playlist.test.js).
// These functions take their inputs as arguments and only touch the filesystem —
// no Electron/app/config globals — which is what makes them safe to test.

const fs = require('fs');
const path = require('path');
// Shared with library.js so "the same file" means the same thing in the playlist as
// it does in the pool, the trash and the removed-markers (src/path-key.js).
const { pathKey } = require('./path-key');

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif']);

// Normalize a slot to { items: Item[] }. Legacy format was a plain string path
// (or empty). Item = { type: 'image' | 'folder', path }.
function normalizeSlot(slot) {
  if (typeof slot === 'string') return { items: slot ? [{ type: 'image', path: slot }] : [] };
  if (slot && Array.isArray(slot.items)) {
    return { items: slot.items.filter((it) => it && it.path && (it.type === 'image' || it.type === 'folder')) };
  }
  return { items: [] };
}

// List image files in a folder (sorted by name), cached for a few seconds so a
// rotating slideshow doesn't re-read the directory on every tick.
const folderScanCache = new Map(); // dir -> { at, files }
function scanFolder(dir, opts = {}) {
  const cached = folderScanCache.get(dir);
  if (!opts.force && cached && Date.now() - cached.at < 5000) return cached.files;
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => IMG_EXTS.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((f) => path.join(dir, f));
  } catch { files = []; }
  folderScanCache.set(dir, { at: Date.now(), files });
  return files;
}

// Like scanFolder but returns BOTH subfolders and images (one level) — for in-place
// library navigation (opening a folder to browse its contents + drill into subfolders).
const folderEntriesCache = new Map(); // dir -> { at, entries }
function scanFolderEntries(dir) {
  const cached = folderEntriesCache.get(dir);
  if (cached && Date.now() - cached.at < 5000) return cached.entries;
  const folders = [];
  const images = [];
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) folders.push(full);
      else if (d.isFile() && IMG_EXTS.has(path.extname(d.name).toLowerCase())) images.push(full);
    }
    folders.sort((a, b) => a.localeCompare(b));
    images.sort((a, b) => a.localeCompare(b));
  } catch { /* unreadable dir -> empty */ }
  const entries = { folders, images };
  folderEntriesCache.set(dir, { at: Date.now(), entries });
  return entries;
}

// Recursively collect image paths under `dir`, depth- and count-limited. Guards
// against huge trees (cap) and symlink cycles (realpath set). Powers the flat
// "All" view and folder image counts. NOTE: deliberately NOT used by resolveSlot —
// the slideshow stays one-level so assigning a folder behaves as before.
function scanFolderImagesDeep(dir, opts = {}) {
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 8;
  const cap = Number.isFinite(opts.cap) ? opts.cap : 10000;
  const out = [];
  const seenDirs = new Set();
  const stack = [{ dir, depth: 0 }];
  while (stack.length && out.length < cap) {
    const { dir: d, depth } = stack.pop();
    let real;
    try { real = fs.realpathSync(d); } catch { continue; }
    if (seenDirs.has(real)) continue; // cycle guard
    seenDirs.add(real);
    const { folders, images } = scanFolderEntries(d);
    for (const img of images) { if (out.length >= cap) break; out.push(img); }
    if (depth < maxDepth) {
      for (const f of folders) stack.push({ dir: f, depth: depth + 1 });
    }
  }
  return out;
}

// Expand a slot to a flat list of EXISTING paths (images + folder contents),
// de-duplicated, preserving order.
//
// New model: slot = { itemIds:[…] } + a `library` pool → items are resolved by id.
// Backward compatible: called as resolveSlot(slot) on a legacy { items:[…] } slot
// (no library) it behaves exactly as before. (Library model lands fully in Этап B.)
// `opts.exclude` is a Set of PATH KEYS (src/path-key.js) the user removed from the
// library (LIB-004). A folder is expanded by reading the disk, so without this the
// playlist would keep serving a photo that no longer exists as far as the user is
// concerned — the grid would hide it while the desktop kept showing it. The set is
// passed in rather than read here so this module stays free of app state. It must be
// keyed exactly like the caller builds it: a plain lowercase set and a `\`-spelled
// scan result never matched, so the exclusion silently did nothing.
function resolveSlot(slot, library, opts = {}) {
  const out = [];
  const seen = new Set();
  const exclude = opts.exclude instanceof Set ? opts.exclude : null;
  let items;
  if (library && slot && Array.isArray(slot.itemIds)) {
    items = slot.itemIds.map((id) => library[id]).filter(Boolean);
  } else {
    items = slot && Array.isArray(slot.items) ? slot.items : [];
  }
  for (const it of items) {
    if (!it || !it.path) continue;
    const paths = it.type === 'folder' ? scanFolder(it.path, { force: !!opts.forceFolderScan }) : [it.path];
    for (const p of paths) {
      const k = pathKey(p);
      if (exclude && exclude.has(k)) continue;
      if (!seen.has(k) && fs.existsSync(p)) { seen.add(k); out.push(p); }
    }
  }
  return out;
}

// Index of a specific path within a slot's EXPANDED playlist (-1 if absent). The
// slideshow index addresses the expanded list (a folder is one strip item but many
// resolved paths), so "apply this exact thumbnail" must map a path → expanded index
// rather than trusting the strip's item index. Case-insensitive match.
function resolvedIndexOf(slot, library, p, opts = {}) {
  if (!p) return -1;
  const list = resolveSlot(slot, library, opts);
  const key = pathKey(p);
  return list.findIndex((x) => pathKey(x) === key);
}

// Element of `list` at `idx`, wrapped into range. '' for an empty list.
function pickCurrent(list, idx) {
  if (!list || !list.length) return '';
  let i = (Number.isFinite(idx) ? idx : 0) % list.length;
  if (i < 0) i += list.length;
  return list[i];
}

// Next slideshow index: sequential (+1, wrap) or shuffle (random, never the
// current one). `rnd` is injectable for deterministic tests.
function nextIndex(cur, len, shuffle, rnd = Math.random) {
  if (len < 2) return Number.isFinite(cur) ? cur : 0;
  if (!shuffle) return ((Number.isFinite(cur) ? cur : 0) + 1) % len;
  let n;
  do { n = Math.floor(rnd() * len); } while (n === cur);
  return n;
}

function wrappedIndex(index, len) {
  if (!len) return 0;
  let value = (Number.isFinite(index) ? index : 0) % len;
  if (value < 0) value += len;
  return value;
}

// Reconcile a saved path/index against a freshly resolved playlist. A removed
// current path uses its old index as the successor position (without another +1).
function reconcilePosition(list, currentPath, oldIndex, options = {}) {
  if (!Array.isArray(list) || !list.length) return { index: 0, path: '' };
  const advance = !!options.advance;
  const shuffle = !!options.shuffle;
  const rnd = typeof options.rnd === 'function' ? options.rnd : Math.random;
  const savedPath = typeof currentPath === 'string' ? currentPath : '';
  // The saved path comes from config, the list from a fresh disk scan — the two can
  // legitimately spell the same file differently, and a raw compare then "lost" the
  // current frame and restarted the slideshow from the saved index.
  const savedKey = pathKey(savedPath);
  const found = savedPath ? list.findIndex((p) => pathKey(p) === savedKey) : -1;
  let index;

  if (found >= 0) {
    index = advance ? nextIndex(found, list.length, shuffle, rnd) : found;
  } else if (savedPath) {
    if (advance && shuffle) index = Math.min(list.length - 1, Math.floor(rnd() * list.length));
    else index = wrappedIndex(oldIndex, list.length);
  } else {
    const legacy = wrappedIndex(oldIndex, list.length);
    index = advance ? nextIndex(legacy, list.length, shuffle, rnd) : legacy;
  }
  return { index, path: list[index] };
}

// Existing configs predate the interval toggle, so only an explicit false disables it.
function usesInterval(slideshow) {
  return !!(slideshow && slideshow.enabled && slideshow.intervalEnabled !== false);
}

module.exports = {
  IMG_EXTS, normalizeSlot, scanFolder, scanFolderEntries, scanFolderImagesDeep,
  resolveSlot, resolvedIndexOf, pickCurrent, nextIndex, reconcilePosition, usesInterval,
};
