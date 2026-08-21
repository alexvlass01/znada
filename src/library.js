'use strict';

// Wallpaper library — the CONTENT POOL, decoupled from placement.
//
// Design (agreed 2026-06-03, see future-todo #16): a slot (monitor × theme) stops
// embedding wallpaper objects and instead references pool items by `id`. This module
// owns the pool itself: create/dedup/list/resolve items + a one-time migration that
// hoists the old inline-slot model into the pool. Pure & injectable (no Electron) so
// the regression-prone migration is unit-testable directly (see test/library.test.js).
//
// Item = { id, type:'image'|'folder', path, addedAt, favorite, tags:[], author }
// Library (pool) = { [id]: Item }
//
// NOTE (Этап A): this module is additive — config.normalize() does NOT call
// migrateConfig() yet, so the live app keeps using inline slots. Etап B flips the
// model (normalize → migrate, main.js/renderer → itemIds) atomically.

const crypto = require('crypto');
const playlist = require('./playlist');
// One canonical key for the whole app — see src/path-key.js for why it is its own
// module and why it folds `.`/`..` itself.
const { pathKey, isUnderPath } = require('./path-key');

// Stable id from a normalized absolute path (cheap; no file read). Import already
// content-hashes stored filenames, so identical images mostly collapse to one path.
function idFor(p) {
  return crypto.createHash('sha1').update(pathKey(p)).digest('hex').slice(0, 16);
}

function baseName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

// Build a pool item with metadata defaults. type: 'image' | 'folder'.
function makeItem(type, p, extra = {}) {
  const item = {
    id: idFor(p),
    type: type === 'folder' ? 'folder' : 'image',
    path: p,
    addedAt: Number.isFinite(extra.addedAt) ? extra.addedAt : Date.now(),
    favorite: !!extra.favorite,
    tags: Array.isArray(extra.tags) ? extra.tags.slice() : [],
    author: typeof extra.author === 'string' ? extra.author : '',
  };
  const aspect = aspectOf(extra);
  if (aspect) item.aspect = aspect;
  // Preserve the live-folder discovery's modified time when materializing a folder
  // image, so the pool card sorts (newest-first secondary key) exactly like its
  // ephemeral form did and does not jump. Absent/invalid → omitted (treated as 0).
  if (Number.isFinite(extra.modifiedAt) && extra.modifiedAt > 0) item.modifiedAt = extra.modifiedAt;
  return item;
}

// Stable image proportion metadata. New items may provide either `aspect` directly
// or source dimensions; old configs simply return 0 and are backfilled lazily.
function aspectOf(item) {
  if (!item || typeof item !== 'object') return 0;
  const direct = Number(item.aspect);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const width = Number(item.width);
  const height = Number(item.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? width / height
    : 0;
}

// Additive metadata update only: it never creates/removes pool entries or touches files.
// The path check prevents a stale renderer response from updating a replaced item.
function setAspect(library, id, p, aspect) {
  const it = getItem(library, id);
  const value = Number(aspect);
  if (!it || it.type !== 'image' || it.path !== p || !Number.isFinite(value) || value <= 0) return false;
  if (Math.abs(aspectOf(it) - value) < 0.0001) return false;
  it.aspect = value;
  return true;
}

// Add an item to the pool (dedup by id). Returns the id, or null if invalid.
// An existing item is preserved (its metadata — e.g. favorite/tags — is not clobbered).
function addItem(library, item) {
  if (!library || typeof library !== 'object' || !item || !item.path) return null;
  const it = item.id && item.type ? item : makeItem(item.type, item.path, item);
  if (!library[it.id]) library[it.id] = it;
  return it.id;
}

// Convenience: add by (type, path). Returns id.
function addPath(library, type, p, extra) {
  if (!p || typeof p !== 'string') return null;
  return addItem(library, makeItem(type, p, extra));
}

function getItem(library, id) {
  return library && id && library[id] ? library[id] : null;
}

function removeItem(library, id) {
  if (library && id && library[id]) { delete library[id]; return true; }
  return false;
}

function toggleFavorite(library, id) {
  const it = getItem(library, id);
  if (!it) return false;
  it.favorite = !it.favorite;
  return it.favorite;
}

// Resolve an ordered list of ids → items (skips unknown ids), preserving order.
function resolveIds(library, ids) {
  const out = [];
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const it = getItem(library, id);
    if (it) out.push(it);
  }
  return out;
}

// Flatten the pool into a deduped image list for the "All" view: every image item
// PLUS the recursively-expanded contents of every folder item. `scanDeep(dir)` is
// injected (main passes the FS-backed recursive scanner; tests pass a stub) so this
// stays pure and unit-testable. Returns [{ id, path, inPool }] deduped by id with
// pool items winning (they own metadata: favorite/tags/assigned), so a folder image
// that was already "materialized" into the pool shows once, as the real item.
function flattenImages(library, scanDeep) {
  const out = [];
  const seen = new Set();
  const push = (p, inPool) => {
    if (!p) return;
    const id = idFor(p);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, path: p, inPool: !!inPool });
  };
  const lib = library || {};
  for (const it of Object.values(lib)) {
    if (it && it.type === 'image' && it.path) push(it.path, true);
  }
  for (const it of Object.values(lib)) {
    if (it && it.type === 'folder' && it.path && typeof scanDeep === 'function') {
      for (const p of scanDeep(it.path)) push(p, false);
    }
  }
  return out;
}

// Metadata-rich counterpart for folder-state results. Pool images are omitted
// because renderer already owns their full metadata; duplicate folder paths keep
// the earliest discovery time so adding an overlapping source does not make them new.
function ephemeralFolderImages(library, folderImages) {
  const poolIds = new Set(Object.values(library || {})
    .filter((it) => it && it.type === 'image' && it.path)
    .map((it) => idFor(it.path)));
  const byId = new Map();
  for (const image of (Array.isArray(folderImages) ? folderImages : [])) {
    if (!image || !image.path) continue;
    const id = idFor(image.path);
    if (poolIds.has(id)) continue;
    const addedAt = Number.isFinite(Number(image.addedAt)) ? Number(image.addedAt) : 0;
    const modifiedAt = Number.isFinite(Number(image.modifiedAt)) ? Number(image.modifiedAt) : 0;
    const aspect = aspectOf(image);
    const current = byId.get(id);
    if (!current || addedAt < current.addedAt) {
      const retainedAspect = aspect || (current && current.aspect) || 0;
      byId.set(id, {
        id,
        path: image.path,
        addedAt,
        modifiedAt,
        ...(retainedAspect ? { aspect: retainedAspect } : {}),
      });
    } else if (!current.aspect && aspect) {
      current.aspect = aspect;
    }
  }
  return Array.from(byId.values());
}

function recentImages(library, folderImages, limit = 5) {
  const pool = Object.values(library || {})
    .filter((it) => it && it.type === 'image' && it.path)
    .map((it) => ({ ...it, ephemeral: false }));
  const ephemeral = ephemeralFolderImages(library, folderImages)
    .map((it) => ({ ...it, type: 'image', ephemeral: true }));
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const count = Math.min(100, Math.max(0, Math.floor(Number(limit) || 0)));
  return pool.concat(ephemeral)
    .sort((a, b) => number(b.addedAt) - number(a.addedAt)
      || number(b.modifiedAt) - number(a.modifiedAt)
      || baseName(a.path).localeCompare(baseName(b.path)))
    .slice(0, count);
}

function isPathInsideRoot(filePath, rootPath) {
  const file = pathKey(filePath);
  const root = pathKey(rootPath);
  return !!file && !!root && file !== root && isUnderPath(file, root);
}

// Materialized live-folder images are ordinary pool image items, but their backing
// file still lives under a connected folder root. If a COMPLETE live-folder scan has
// removed the path from folder-state and the root itself is available, the pool item
// is a confirmed stale reference and can be removed safely. If the root is offline
// or the path is still retained in folder-state (partial/unavailable scan), keep it.
function findConfirmedMissingLiveFolderImageIds(library, folderImages, fileExistsFn, rootExistsFn) {
  const out = [];
  if (typeof fileExistsFn !== 'function') return out;
  const rootExists = typeof rootExistsFn === 'function' ? rootExistsFn : fileExistsFn;
  const lib = library || {};
  const indexedIds = new Set((Array.isArray(folderImages) ? folderImages : [])
    .filter((image) => image && image.path)
    .map((image) => idFor(image.path)));
  const roots = Object.values(lib)
    .filter((it) => it && it.type === 'folder' && it.path)
    .map((it) => it.path);

  if (!roots.length) return out;

  for (const it of Object.values(lib)) {
    if (!it || it.type !== 'image' || !it.id || !it.path) continue;
    if (indexedIds.has(idFor(it.path))) continue;
    let fileExists = false;
    try { fileExists = !!fileExistsFn(it.path); } catch { fileExists = false; }
    if (fileExists) continue;

    const confirmedRoot = roots.some((root) => {
      if (!isPathInsideRoot(it.path, root)) return false;
      try { return !!rootExists(root); } catch { return false; }
    });
    if (confirmedRoot) out.push(it.id);
  }
  return out;
}

// The GC keep-set: every file the config still references (normalized lowercase paths).
// The pool is self-sufficient — an image stays referenced even when assigned to no monitor
// (that's the point of the library) — so ALL image paths are kept, plus the legacy globals.
// ⚠️ SAFETY-CRITICAL: gcWallpapers() moves anything NOT in this set to .trash. An
// under-inclusive set here is how the 2026-06-03 data-loss incident happened — when in
// doubt, keep MORE, never less. Unit-tested in test/library.test.js.
function referencedFiles(cfg) {
  const set = new Set();
  const add = (p) => {
    const key = pathKey(p);
    if (key) set.add(key);
  };
  for (const it of Object.values((cfg && cfg.library) || {})) {
    if (it && it.type === 'image' && it.path) add(it.path);
  }
  // A photo the user removed is still held by the library trash until they empty it
  // (LIB-006). Keeping the file where it is — rather than letting GC sweep it into
  // wallpapers/.trash — is what lets the "Removed" section show a real thumbnail and
  // makes putting it back a matter of restoring the record alone.
  for (const entry of (Array.isArray(cfg && cfg.libraryTrash) ? cfg.libraryTrash : [])) {
    if (entry && entry.item && entry.item.type === 'image' && entry.item.path) add(entry.item.path);
  }
  if (cfg) { add(cfg.lightWallpaper); add(cfg.darkWallpaper); }
  return set;
}

// Ids of pool items whose backing path no longer exists on disk. `existsFn(path)` is
// injected (FS-backed in main, stubbed in tests) so this stays pure/testable. Powers the
// library "refresh" sanity check — note it only flags POOL ENTRIES, never touches files.
function findMissingIds(library, existsFn) {
  const out = [];
  if (typeof existsFn !== 'function') return out;
  for (const it of Object.values(library || {})) {
    if (it && it.id && it.path && !existsFn(it.path)) out.push(it.id);
  }
  return out;
}

// A migrated old config can still use lightWallpaper/darkWallpaper as a legacy
// fallback when a monitor has no playlist. Once the user explicitly empties a
// slot, that fallback becomes surprising, so the slot carries a small opt-out.
function markSlotExplicitEmpty(slot) {
  if (!slot || !Array.isArray(slot.itemIds) || slot.itemIds.length > 0) return false;
  if (slot.legacyFallbackDisabled === true) return false;
  slot.legacyFallbackDisabled = true;
  return true;
}
function clearSlotExplicitEmpty(slot) {
  if (!slot || slot.legacyFallbackDisabled !== true) return false;
  delete slot.legacyFallbackDisabled;
  return true;
}
function allowsLegacyFallback(slot) {
  return !(slot && slot.legacyFallbackDisabled === true);
}

// ---- tags (manual, on pool items) ----

// Normalize a tag: trimmed, collapsed whitespace, lowercase (tags are categories).
function normTag(tag) {
  return String(tag || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
function addTag(library, id, tag) {
  const it = getItem(library, id);
  const t = normTag(tag);
  if (!it || !t) return false;
  if (!Array.isArray(it.tags)) it.tags = [];
  if (it.tags.includes(t)) return false;
  it.tags.push(t);
  return true;
}
function removeTag(library, id, tag) {
  const it = getItem(library, id);
  const t = normTag(tag);
  if (!it || !Array.isArray(it.tags)) return false;
  const i = it.tags.indexOf(t);
  if (i < 0) return false;
  it.tags.splice(i, 1);
  return true;
}
// All distinct tags across the pool, sorted.
function allTags(library) {
  const set = new Set();
  for (const it of Object.values(library || {})) {
    if (Array.isArray(it.tags)) it.tags.forEach((t) => set.add(t));
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// List pool items with optional filter + sort.
//   filter: { type?: 'image'|'folder', favorite?: true, tag?: 'name' }
//   sort:   'added' (newest first, default) | 'added-asc' | 'name' | 'name-desc'
function listItems(library, opts = {}) {
  let items = Object.values(library || {});
  const f = opts.filter || {};
  if (f.type) items = items.filter((it) => it.type === f.type);
  if (f.favorite) items = items.filter((it) => it.favorite);
  if (f.tag) items = items.filter((it) => Array.isArray(it.tags) && it.tags.includes(f.tag));
  const byName = (a, b) => baseName(a.path).localeCompare(baseName(b.path));
  switch (opts.sort) {
    case 'name': items.sort(byName); break;
    case 'name-desc': items.sort((a, b) => byName(b, a)); break;
    case 'added-asc': items.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0)); break;
    default: items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)); // newest first
  }
  return items;
}

// ---- migration: inline-slot model → library-pool model (idempotent) ----

// One slot → { itemIds:[…] }. Accepts the new {itemIds} shape (kept as-is), the
// current {items:[{type,path}]} shape, or the legacy string path. Populates `library`.
function migrateSlot(library, slot) {
  if (slot && Array.isArray(slot.itemIds)) {
    const itemIds = slot.itemIds.filter((id) => typeof id === 'string' && id);
    const out = { itemIds };
    if (!itemIds.length && slot.legacyFallbackDisabled === true) out.legacyFallbackDisabled = true;
    return out;
  }
  const norm = playlist.normalizeSlot(slot); // -> { items: [{type,path}] }
  const itemIds = [];
  for (const it of norm.items) {
    const id = addPath(library, it.type, it.path);
    if (id && !itemIds.includes(id)) itemIds.push(id); // dedup within the slot
  }
  return { itemIds };
}

// Migrate a whole config: populate cfg.library and rewrite monitor slots to itemIds.
// Non-destructive to legacy globals (lightWallpaper/darkWallpaper kept as fallback
// strings AND folded into the pool so they show up in the library). Idempotent.
function migrateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  if (!cfg.library || typeof cfg.library !== 'object') cfg.library = {};
  const lib = cfg.library;

  if (cfg.monitors && typeof cfg.monitors === 'object') {
    for (const devId of Object.keys(cfg.monitors)) {
      const m = cfg.monitors[devId] || {};
      cfg.monitors[devId] = { light: migrateSlot(lib, m.light), dark: migrateSlot(lib, m.dark) };
    }
  }
  for (const p of [cfg.lightWallpaper, cfg.darkWallpaper]) {
    if (p && typeof p === 'string') addPath(lib, 'image', p);
  }
  return cfg;
}

module.exports = {
  pathKey, isUnderPath, idFor, baseName, makeItem, aspectOf, setAspect, addItem, addPath, getItem, removeItem,
  toggleFavorite, normTag, addTag, removeTag, allTags,
  resolveIds, flattenImages, ephemeralFolderImages, recentImages,
  isPathInsideRoot, findConfirmedMissingLiveFolderImageIds,
  findMissingIds, markSlotExplicitEmpty, clearSlotExplicitEmpty, allowsLegacyFallback,
  referencedFiles, listItems, migrateSlot, migrateConfig,
};
