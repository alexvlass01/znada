'use strict';

// CODE-001 2.2a. The one owner of the library pool core: the mutation lock every
// "active ↔ removed" change runs under, the single funnel into the active pool, revival
// of a photo the user had removed, the "what is in use right now" set the delete guard
// checks against, removing one record together with its slot references, and dropping
// a trash row. Active-record renames also stay here as one synchronous operation.
//
// main.js still holds the config object and the live-folder index. The removed-marks
// live in that index (src/folder-state.js format), so they are reached through the
// narrow `marks` port instead of the variable; the format does not change here.
// `config` is read through getConfig() at every place the old code read the variable:
// set-config can replace the object while a caller awaits, and a captured reference
// would answer with the stale one. No Electron and no module-level state.

const libraryAssignment = require('./library-assignment');

/**
 * @typedef {{ changed: boolean, matched: string[] }} MarkResult
 * @typedef {{
 *   setHidden: (paths: string[], hidden: boolean) => MarkResult,
 *   setHiddenDir: (paths: string[], hidden: boolean) => MarkResult,
 *   persistNow: () => void,
 *   hiddenPaths: () => Set<string>,
 * }} RemovalMarks
 * @typedef {{
 *   inspectPath: (src: unknown, forSlot: boolean) => 'folder' | 'photo' | 'video' | '',
 *   preparePhoto: (src: string) => Promise<{ path: string, extra?: Record<string, unknown> }>,
 *   grantFile: (src: string) => unknown,
 *   grantFolder: (src: string) => unknown,
 * }} LocalImportIO
 * @typedef {{
 *   library: typeof import('./library'),
 *   playlist: { resolveSlot: (slot: any, library: any, options?: any) => string[] },
 *   pathKey: (p: unknown) => string,
 *   getConfig: () => any,
 *   slotFor: (monitorId: string, theme: string) => any,
 *   marks: RemovalMarks,
 *   liveFolders: { forget: (id: string) => void, sync: () => void },
 *   storeSlideshowPosition: (monitorId: string, theme: string, position: { index: number, path: string }) => void,
 *   localImport?: LocalImportIO,
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
  localImport,
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

  // BUG-067. Every change addToPool makes to the stored pool: a record created or a
  // removed state repaired. Import handlers decide whether to save by this counter, not
  // by how much the pool grew: pruning outside the lock can shrink the pool while an
  // import is between awaits, and a net growth of zero then hid a record that was really
  // created — it lived in memory and was gone after the restart.
  let poolChangeCount = 0;
  function poolChanges() { return poolChangeCount; }

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
    const existed = typeof srcPath === 'string' && srcPath
      && !!library.getItem(getConfig().library, library.idFor(srcPath));
    const id = library.addPath(getConfig().library, type, srcPath, extra);
    const item = id ? library.getItem(getConfig().library, id) : null;
    const revisionMoved = markRecordRevived(item);
    const revived = !!id && (clearRemovedState(srcPath) || revisionMoved);
    if (revived) revivalCount++;
    if (revived || (item && !existed)) poolChangeCount++;
    return id;
  }

  // The caller holds withLock across this synchronous transaction and its runtime
  // finalization. The pool owner decides whether storage changed; assigning a known
  // record only touches settings unless the funnel repaired its removed state.
  // The funnel is supplied here, never by the runtime caller. Even a record that
  // already exists must go through it: active+removed profiles need a revision bump
  // and a durable repair although no new id was created.
  function assignRecord(record, monitorId, theme, options = {}) {
    const revivalsBefore = revivals();
    const result = libraryAssignment.assignRecord(getConfig(), record, monitorId, theme,
      { ...options, addToPool });
    const poolTouched = !!result.created || revivals() !== revivalsBefore;
    return { result, poolTouched };
  }

  function assignRecords(prepared, monitorId, theme) {
    const revivalsBefore = revivals();
    const withFunnel = prepared.map((entry) => ({
      ...entry,
      options: { ...(entry.options || {}), addToPool },
    }));
    const result = libraryAssignment.assignRecords(getConfig(), withFunnel, monitorId, theme);
    const poolTouched = (result.createdIds || []).length > 0 || revivals() !== revivalsBefore;
    return { result, poolTouched };
  }

  // Private slot repair shared by legacy import and placement commands. Callers
  // request an operation rather than obtaining a mutable slot through the service API.
  function ensureSlot(monitorId, which) {
    const theme = which === 'dark' ? 'dark' : 'light';
    if (!getConfig().monitors[monitorId]) getConfig().monitors[monitorId] = { light: { itemIds: [] }, dark: { itemIds: [] } };
    const m = getConfig().monitors[monitorId];
    if (!m.light || !Array.isArray(m.light.itemIds)) m.light = { itemIds: [] };
    if (!m.dark || !Array.isArray(m.dark.itemIds)) m.dark = { itemIds: [] };
    return m[theme];
  }

  // Placement-only commands stay synchronous and keep the legacy index coercion.
  // Runtime callers retain their distinct save/GC/tray policies outside the command.
  function removeSlotItem(monitorId, which, index) {
    const theme = which === 'dark' ? 'dark' : 'light';
    const slot = ensureSlot(monitorId, which);
    if (index >= 0 && index < slot.itemIds.length) {
      slot.itemIds.splice(index, 1);
      if (slot.itemIds.length === 0) {
        library.markSlotExplicitEmpty(slot);
        storeSlideshowPosition(monitorId, theme, { index: 0, path: '' });
      }
    }
  }

  function clearSlot(monitorId, which) {
    const theme = which === 'dark' ? 'dark' : 'light';
    const slot = ensureSlot(monitorId, which);
    slot.itemIds = [];
    library.markSlotExplicitEmpty(slot);
    storeSlideshowPosition(monitorId, theme, { index: 0, path: '' });
  }

  // Импорт картинки/папки в пул + назначение её в слот (вернёт true, если реально добавили).
  function assignToSlot(slot, type, srcPath, extra) {
    const id = addToPool(type, srcPath, extra);
    if (!id) return false;
    if (slot.itemIds.includes(id)) return false; // уже в этом слоте
    slot.itemIds.push(id);
    library.clearSlotExplicitEmpty(slot);
    return true;
  }

  async function importSlotImages(paths, monitorId, which) {
    const slot = ensureSlot(monitorId, which);
    let added = 0;
    for (const src of paths) {
      try {
        const photo = await localImport.preparePhoto(src);
        if (assignToSlot(slot, 'image', photo.path, photo.extra)) added++;
      } catch (err) { console.error('Не удалось импортировать обои:', err); }
    }
    return { added, saveRequired: true };
  }

  function importSlotFolder(dir, monitorId, which) {
    const slot = ensureSlot(monitorId, which);
    assignToSlot(slot, 'folder', dir);
    return { added: 1, saveRequired: true, folderIds: [library.idFor(dir)] };
  }

  async function importSlotPaths(paths, monitorId, which) {
    const slot = ensureSlot(monitorId, which);
    let added = 0;
    let videos = 0;
    const changesBefore = poolChanges();
    const folderIds = [];
    for (const src of paths) {
      try {
        const kind = localImport.inspectPath(src, true);
        if (kind === 'folder') {
          if (assignToSlot(slot, 'folder', src)) added++;
          // The grant follows the POOL, not the slot, and it is issued only once the pool
          // actually holds the folder. `assignToSlot` answers false for two different
          // things — the pool refused it, or this slot already had it — and reading that
          // as "accepted" handed out recursive read authority over a directory the app had
          // just declined. Asking the pool directly tells the two apart: a folder already
          // in the slot is legitimately ours and stays readable.
          const folderId = library.idFor(src);
          if (library.getItem(getConfig().library, folderId)) {
            localImport.grantFolder(src);
            folderIds.push(folderId);
          }
        } else {
          if (kind === 'photo') {
            const photo = await localImport.preparePhoto(src);
            if (assignToSlot(slot, 'image', photo.path, photo.extra)) added++;
            // photoForPool completing proves the supported file was actually readable.
            // Rejected extensions and failed imports must not leave read authority behind.
            localImport.grantFile(src);
          } else if (kind === 'video') {
            // MEDIA-002: a monitor takes pictures only; the window says why the video stayed out.
            videos++;
          }
        }
      } catch (err) {
        console.error('Failed to import drag-dropped path:', src, err);
      }
    }
    // Also when nothing new was added: dropping a photo that is already here clears the
    // removed-marker still on it, and that repair has to reach the disk or the photo is
    // removed again after the next restart.
    return { added, videos, saveRequired: added > 0 || poolChanges() !== changesBefore, folderIds };
  }

  async function importLibraryImages(paths) {
    // `added` stays NET batch growth (the window's toast contract). Whether to save is a
    // separate question answered by poolChanges() — see BUG-067 at its declaration.
    const before = Object.keys(getConfig().library).length;
    const changesBefore = poolChanges();
    for (const src of paths) {
      try {
        const photo = await localImport.preparePhoto(src);
        addToPool('image', photo.path, photo.extra);
      }
      catch (err) { console.error('library: не удалось импортировать', src, err); }
    }
    const added = Object.keys(getConfig().library).length - before;
    // Re-adding a photo that is already in the pool adds no row, but it DOES clear the
    // removed-marker or trash entry that was still on it — and that repair has to be
    // written down, or the photo is removed again after the next restart.
    return { added, saveRequired: !!added || poolChanges() !== changesBefore };
  }

  function importLibraryFolder(dir) {
    const before = Object.keys(getConfig().library).length;
    const changesBefore = poolChanges();
    const id = addToPool('folder', dir);
    const added = Object.keys(getConfig().library).length - before;
    return { added, saveRequired: !!added || poolChanges() !== changesBefore, folderIds: id ? [id] : [] };
  }

  async function importLibraryPaths(paths) {
    // SEC-002. Drag-and-drop: the path is asserted by the window, because Electron resolves
    // a dropped File in the renderer and main has no way to confirm it. Adding is a visible
    // act - a card appears - which is what keeps this from being a silent read of anything
    // on the disk. Main grants only paths it has validated and successfully accepted below;
    // a missing or unsupported renderer-supplied path must never acquire read authority.
    const before = Object.keys(getConfig().library).length;
    const changesBefore = poolChanges();
    const folderIds = [];
    for (const src of paths) {
      try {
        const kind = localImport.inspectPath(src, false);
        if (kind === 'folder') {
          const id = addToPool('folder', src);
          if (id) {
            localImport.grantFolder(src);
            folderIds.push(id);
          }
        } else if (kind === 'photo') {
          const photo = await localImport.preparePhoto(src);
          if (addToPool('image', photo.path, photo.extra)) localImport.grantFile(src);
        }
      } catch (err) { console.error('library: drop import failed', src, err); }
    }
    const added = Object.keys(getConfig().library).length - before;
    return { added, saveRequired: !!added || poolChanges() !== changesBefore, folderIds };
  }

  // LIB-024/LIB-027. The pool owns the entire active-record rename: metadata/revision,
  // slot references, slideshow positions and legacy paths. The caller already holds
  // withLock and supplies the one removed-path snapshot taken before this batch.
  // Stay synchronous; taking the lock again here would deadlock the scan.
  /** @param {string} from @param {string} to @param {Set<string>} removedPaths */
  function followActiveMove(from, to, removedPaths) {
    const oldId = library.idFor(from);
    const record = library.getItem(getConfig().library, oldId);
    if (!record || record.type !== 'image') return false;
    const newId = library.idFor(to);
    // The new name already has a record of its own (a star given to the new card before
    // this ran). Merging two records is not decided here: both stay as they are.
    if (library.getItem(getConfig().library, newId)) return false;
    // Moved into a place the user removed from the library. Bringing the record along
    // would make the photo active and removed at once — the one state the library must
    // never be in.
    if (removedPaths.has(pathKey(to))) return false;
    const { id: _oldId, path: _oldPath, rev: oldRev, ...carried } = record;
    // In through the one door every active photo uses, so the new name is cleared of any
    // old "removed" state the same way a star on it would clear it.
    //
    // LIB-027. The revision comes along too. Starting the new name from zero made the
    // user's latest edits look like the oldest state of the photo, and a recovery merge
    // then let any stale tombstone for that name delete the record (gate 03, 2026-10-09).
    if (addToPool('image', to, { ...carried, rev: oldRev }) !== newId) return false;
    // makeItem keeps only the fields it knows. Whatever else the record carries — the
    // source page, the age rating, a field added next year — comes across in one go, so
    // a new field cannot be forgotten here.
    library.updateItem(getConfig().library, newId, carried);
    library.replaceIdInSlots(getConfig().monitors, oldId, newId);
    library.removeItem(getConfig().library, oldId);
    // The slideshow remembers where it stopped by path; without this it would lose its
    // place on a monitor whose current photo was the one renamed.
    for (const [monitorId, byTheme] of Object.entries(getConfig().slideshowCurrentPath || {})) {
      for (const theme of ['light', 'dark']) {
        if (!byTheme || pathKey(byTheme[theme] || '') !== pathKey(from)) continue;
        storeSlideshowPosition(monitorId, theme, {
          index: ((getConfig().slideshowIndex || {})[monitorId] || {})[theme],
          path: to,
        });
      }
    }
    // The pre-library fallback is a bare path; migrateConfig folds it back into the pool
    // on every start, so a stale one would bring the old name back as a dead record.
    for (const key of ['lightWallpaper', 'darkWallpaper']) {
      if (getConfig()[key] && pathKey(getConfig()[key]) === pathKey(from)) getConfig()[key] = to;
    }
    return true;
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
    poolChanges,
    clearRemovedState,
    markRecordRevived,
    addToPool,
    assignRecord,
    assignRecords,
    removeSlotItem,
    clearSlot,
    importSlotImages,
    importSlotFolder,
    importSlotPaths,
    importLibraryImages,
    importLibraryFolder,
    importLibraryPaths,
    followActiveMove,
    inUsePaths,
    removeRecord,
    dropFromTrash,
  };
}

module.exports = { createLibraryService };
