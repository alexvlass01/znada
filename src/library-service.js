'use strict';

// CODE-001 2.2a. The one owner of the library pool core: the mutation lock every
// "active ↔ removed" change runs under, the single funnel into the active pool, revival
// of a photo the user had removed, the "what is in use right now" set the delete guard
// checks against, removing one record together with its slot references, and dropping
// a trash row.
//
// main.js still holds the config object and the live-folder index. The removed-marks
// live in that index (src/folder-state.js format), so they are reached through the
// narrow `marks` port instead of the variable; the format does not change here.
// `config` is read through getConfig() at every place the old code read the variable:
// set-config can replace the object while a caller awaits, and a captured reference
// would answer with the stale one. No Electron and no module-level state.

/**
 * @typedef {{ changed: boolean, matched: string[] }} MarkResult
 * @typedef {{
 *   setHidden: (paths: string[], hidden: boolean) => MarkResult,
 *   setHiddenDir: (paths: string[], hidden: boolean) => MarkResult,
 *   persistNow: () => void,
 *   hiddenPaths: () => Set<string>,
 * }} RemovalMarks
 * @typedef {{
 *   library: typeof import('./library'),
 *   playlist: { resolveSlot: (slot: any, library: any, options?: any) => string[] },
 *   pathKey: (p: unknown) => string,
 *   getConfig: () => any,
 *   slotFor: (monitorId: string, theme: string) => any,
 *   marks: RemovalMarks,
 *   liveFolders: { forget: (id: string) => void, sync: () => void },
 *   storeSlideshowPosition: (monitorId: string, theme: string, position: { index: number, path: string }) => void,
 *   log?: { error: (...args: unknown[]) => void },
 * }} LibraryServiceDeps
 */

/**
 * @param {LibraryServiceDeps} deps
 */
function createLibraryService({
  library,
  playlist,
  pathKey,
  getConfig,
  slotFor,
  marks,
  liveFolders,
  storeSlideshowPosition,
  log = console,
}) {
  // Everything that can move a photo between "active" and "removed" — or delete its
  // file — runs one at a time. Ordering alone is what makes the delete guard sound: the
  // check "is this file active right now" and the `shell.trashItem` that follows it are
  // only meaningful together, and awaiting anything between them let a download, a
  // restore or an assignment slip in and make the file active again before it was
  // erased. A queue is enough; these are user-driven actions, not a hot path.
  let mutationQueue = Promise.resolve();
  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withLock(fn) {
    const result = mutationQueue.then(fn, fn);
    mutationQueue = result.then(() => {}, () => {});
    return result;
  }
  // Resolves once everything queued so far has finished (COLLAB-003 waits on it before
  // the hourly DEV exit). Never rejects.
  function settled() { return mutationQueue; }

  // Bumped whenever bringing a photo back cleared a removed-marker or a trash entry.
  // The add handlers decide whether to save by how much the pool GREW, and a photo that
  // is already in the pool grows it by nothing — so re-adding a removed photo repaired
  // it in memory, told the user it was back, and lost the repair on the next start.
  let revivalCount = 0;
  function revivals() { return revivalCount; }

  // A photo cannot be active and removed at the same time. Every route that brings one
  // back — materialize, re-import, re-download, assign — goes through this, so the
  // removed-marker and the trash entry cannot survive underneath an active record.
  // Without it a file could sit in a monitor's playlist while still being an allowed
  // target for "delete from disk" (BUG-011).
  /** @param {string | string[]} paths */
  function clearRemovedState(paths) {
    const list = (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string' && p);
    if (!list.length) return false;
    let changed = false;

    const unhidden = marks.setHidden(list, false);
    const unhiddenDirs = marks.setHiddenDir(list, false);
    if (unhidden.changed || unhiddenDirs.changed) {
      marks.persistNow();
      changed = true;
    }

    const keys = new Set(list.map(pathKey));
    const before = (getConfig().libraryTrash || []).length;
    getConfig().libraryTrash = (getConfig().libraryTrash || [])
      .filter((/** @type {any} */ entry) => !(entry && entry.item && keys.has(pathKey(entry.item.path))));
    if (before !== getConfig().libraryTrash.length) changed = true;
    return changed;
  }

  // A record brought back after a removal must be newer than the tombstone it replaces.
  // Dropping the trash row without moving the record's revision works in the current
  // process, but loses on the next recovery merge if an older copy of the store returns.
  // Match by id OR canonical path: old entries and ephemeral/live-folder cards are not
  // guaranteed to arrive with both fields populated.
  /** @param {any} item */
  function markRecordRevived(item) {
    if (!item || typeof item !== 'object') return false;
    const id = typeof item.id === 'string' ? item.id : '';
    const key = pathKey(item.path);
    let matched = false;
    let newestRemovalRev = 0;
    for (const entry of (getConfig().libraryTrash || [])) {
      if (!entry || !entry.item) continue;
      const sameId = id && entry.item.id === id;
      const samePath = key && pathKey(entry.item.path) === key;
      if (!sameId && !samePath) continue;
      matched = true;
      newestRemovalRev = Math.max(newestRemovalRev, library.revOf(entry));
    }
    if (!matched) return false;
    library.bumpRev(item, newestRemovalRev);
    return true;
  }

  // The ONLY way a photo enters the active pool in the main process. Going through one
  // funnel is what makes "active and removed at the same time" impossible: every entry
  // point — import, drag and drop, download, materialize, assign — clears the removed
  // state as part of becoming active, instead of six call sites each having to remember.
  /**
   * @param {string} type
   * @param {string} srcPath
   * @param {Record<string, unknown>} [extra]
   */
  function addToPool(type, srcPath, extra) {
    const id = library.addPath(getConfig().library, type, srcPath, extra);
    const item = id ? library.getItem(getConfig().library, id) : null;
    const revisionMoved = markRecordRevived(item);
    if (id && (clearRemovedState(srcPath) || revisionMoved)) revivalCount++;
    return id;
  }

  // Every file Znada is currently using, as path keys. This is what "delete from disk"
  // is checked against, so it has to be the truth rather than a re-derivation of it.
  //
  // It used to be assembled by hand from the pool, the slot ids and the legacy fallback.
  // That list looked complete and was not: an assigned FOLDER contributes the folder's own
  // path, while what the desktop actually shows is the photos inside it, found by reading
  // the disk. A photo dropped into a watched folder was therefore playing on the monitor
  // and absent from the "in use" list at the same time — and a stale trash entry naming it
  // was enough to authorise deleting it.
  //
  // So the playlist is asked directly, through the same resolveSlot() the slideshow uses.
  // A photo the user removed is excluded by exactly the same rule there as here, so
  // "removed" and "not in use" cannot drift apart.
  function inUsePaths() {
    const set = new Set();
    for (const it of Object.values(getConfig().library || {})) {
      if (it && it.type === 'image' && it.path) set.add(pathKey(it.path));
    }
    for (const legacy of [getConfig().lightWallpaper, getConfig().darkWallpaper]) {
      if (legacy) set.add(pathKey(legacy));
    }
    const excluded = marks.hiddenPaths();
    for (const monitorId of Object.keys(getConfig().monitors || {})) {
      for (const theme of ['light', 'dark']) {
        let resolved = [];
        try {
          resolved = playlist.resolveSlot(slotFor(monitorId, theme), getConfig().library, {
            forceFolderScan: true,
            exclude: excluded,
          });
        } catch (err) {
          // A folder that cannot be read right now says nothing about what is in it. The
          // safe answer for a delete guard is "assume it is in use", which is what an
          // empty result plus the pool paths above already gives — but log it, because a
          // silent failure here weakens a destructive guard.
          log.error('inUsePaths: не удалось развернуть плейлист', monitorId, theme, err);
        }
        for (const p of resolved) set.add(pathKey(p));
      }
    }
    return set;
  }

  // Удалить элемент из пула И из всех слотов, которые на него ссылаются (без висячих id).
  /** @param {string} id */
  function removeRecord(id) {
    const item = library.getItem(getConfig().library, id);
    if (!library.removeItem(getConfig().library, id)) return false;
    for (const [monitorId, m] of Object.entries(getConfig().monitors || {})) {
      for (const th of ['light', 'dark']) {
        if (m[th] && Array.isArray(m[th].itemIds)) {
          const before = m[th].itemIds.length;
          m[th].itemIds = m[th].itemIds.filter((/** @type {string} */ x) => x !== id);
          if (before > 0 && m[th].itemIds.length === 0) {
            library.markSlotExplicitEmpty(m[th]);
            storeSlideshowPosition(monitorId, th, { index: 0, path: '' });
          }
        }
      }
    }
    if (item && item.type === 'folder') liveFolders.forget(id);
    if (item && item.type === 'folder') liveFolders.sync();
    return true;
  }

  /** @param {string} id */
  function dropFromTrash(id) {
    if (!id || !Array.isArray(getConfig().libraryTrash)) return false;
    const before = getConfig().libraryTrash.length;
    getConfig().libraryTrash = getConfig().libraryTrash
      .filter((/** @type {any} */ e) => !(e && e.item && e.item.id === id));
    return getConfig().libraryTrash.length !== before;
  }

  return {
    withLock,
    settled,
    revivals,
    clearRemovedState,
    markRecordRevived,
    addToPool,
    inUsePaths,
    removeRecord,
    dropFromTrash,
  };
}

module.exports = { createLibraryService };
