'use strict';

// CODE-001 2.2b. The library removal line: taking photos and folders out of the library,
// the toast's Undo, the "Removed" section, putting things back from it, and deleting a
// removed file into the Windows Recycle Bin. The promises these make to the user are kept
// here, in one place, instead of across five IPC handlers in main.js.
//
// It owns one piece of state — the most recent removal, kept for Undo. Everything else
// arrives as a dependency: the pool core (src/library-service.js), the removed-marks in
// the live-folder index (the same narrow `marks` port the core uses; the index and its
// file format stay with the live folders), the wallpaper, saving, Znada's own copies.
// Electron stays in main.js: the Recycle Bin call, the confirmation dialog and the
// switch that keeps deleting files OFF come in as functions.
//
// `config` is read through getConfig() at every place the old handlers read the
// variable, after an await included: set-config can replace the whole object while a
// handler waits for the wallpaper or the dialog, and the answer has to carry the new one.
//
// The order of every write — marks before saveConfig, the orphan sweep after it, two
// separate flushes of the folder index in Undo — is part of the behaviour and is kept
// exactly as it was in main.js.

const path = require('path');

/**
 * @typedef {{ changed: boolean, matched: string[], updated: number }} MarkResult
 * @typedef {{
 *   setHidden: (paths: string[], hidden: boolean) => MarkResult,
 *   setHiddenDir: (paths: string[], hidden: boolean) => MarkResult,
 *   persistNow: () => void,
 *   hiddenPaths: () => Set<string>,
 *   listHiddenImages: () => any[],
 *   listHiddenDirs: () => Array<{ folderId: string, path: string }>,
 * }} RemovalMarks
 * @typedef {{
 *   withLock: <T>(fn: () => T | Promise<T>) => Promise<T>,
 *   markRecordRevived: (item: any) => boolean,
 *   dropFromTrash: (id: string) => boolean,
 *   inUsePaths: () => Set<string>,
 *   clearRemovedState: (p: string) => boolean,
 *   followActiveMove: (from: string, to: string, removedPaths: Set<string>) => boolean,
 * }} PoolCore
 * @typedef {{
 *   library: typeof import('./library'),
 *   libraryStore: { pushEntry: (trash: any[], entry: any) => { trash: any[], evicted: any[] } },
 *   pathKey: (p: unknown) => string,
 *   getConfig: () => any,
 *   pool: PoolCore,
 *   marks: RemovalMarks,
 *   liveFolders: {
 *     forget: (ids: string[]) => void,
 *     sync: () => void,
 *     refresh: (ids: string[]) => void,
 *     notifyViewStale: (reason: string) => void,
 *   },
 *   wallpaper: {
 *     apply: () => Promise<unknown>,
 *     storeSlideshowPosition: (monitorId: string, theme: string, position: { index: number, path: string }) => void,
 *     gc: () => void,
 *   },
 *   save: () => void,
 *   broadcast: () => void,
 *   refreshTray: () => void,
 *   ownCopies: { isOwnCopy: (p: string) => boolean, rootReady: () => boolean, trashDir: () => string },
 *   physicalDeleteEnabled: () => boolean,
 *   askDeleteForever: (targets: string[]) => Promise<boolean>,
 *   trashItem: (p: string) => Promise<void>,
 *   fs: { existsSync: (p: string) => boolean, mkdirSync: (p: string, o?: any) => unknown, renameSync: (a: string, b: string) => void },
 *   now: () => number,
 *   randomHex: (bytes: number) => string,
 *   log?: { log: (...args: unknown[]) => void, error: (...args: unknown[]) => void },
 * }} LibraryRemovalDeps
 */

/**
 * @param {LibraryRemovalDeps} deps
 */
function createLibraryRemoval({
  library,
  libraryStore,
  pathKey,
  getConfig,
  pool,
  marks,
  liveFolders,
  wallpaper,
  save,
  broadcast,
  refreshTray,
  ownCopies,
  physicalDeleteEnabled,
  askDeleteForever,
  trashItem,
  fs,
  now,
  randomHex,
  log = console,
}) {
  // Snapshot of the most recent library removal so the toast can offer a real undo.
  /** @type {any} */
  let lastRemoval = null;

  // Reconcile has already recognized these pairs and moved their removed marks.
  // The scan holds the pool lock. Preserve pair order and one removed-path snapshot
  // across both active and removed operations, then persist marks before config/tray.
  // No lock acquisition or scan await belongs in this synchronous command.
  function followMovedFiles(pairs) {
    let moved = 0;
    let removedMoved = 0;
    const removedPaths = marks.hiddenPaths();
    for (const pair of (Array.isArray(pairs) ? pairs : [])) {
      if (!pair || typeof pair.from !== 'string' || typeof pair.to !== 'string') continue;
      // LIB-025. A photo the user had removed: the index already moved its "removed" mark
      // to the new name, so here only what is kept for putting it back follows.
      if (pair.hidden === true) {
        if (followRemovedMove(pair.from, pair.to)) removedMoved++;
        continue;
      }
      if (pool.followActiveMove(pair.from, pair.to, removedPaths)) moved++;
    }
    if (removedMoved) {
      // The index normally waits five seconds before it is written. The mark that keeps a
      // removed photo out of the library is the user's decision; a crash in that window
      // would bring the photo back under its new name, so it is written now, as removal
      // itself does.
      marks.persistNow();
    }
    if (moved || removedMoved) {
      save();
      refreshTray();
    }
    return moved + removedMoved;
  }


  // LIB-025. A removed photo was renamed or moved inside its watched folder. What the user
  // can get back from "Removed" — its kept record with the star, tags and places on the
  // monitors, and the Undo still on screen — named the old path, so "Restore" on the new
  // card brought the photo back blank, and Undo looked for a file that is no longer there.
  // Both follow the new name here.
  //
  // One rule outranks this: a photo is never active and removed at once. If the new name
  // already has an active record, the active record stays, and the photo is shown — the
  // removed mark the index carried over is lifted, exactly as it would be by adding it.
  /** @param {string} from @param {string} to */
  // The scan coordinator already holds the pool lock. Stay synchronous here: taking it
  // again (or waiting for a scan) would deadlock the scan that reported this pair.
  function followRemovedMove(from, to) {
    const fromKey = pathKey(from);
    const oldId = library.idFor(from);
    const newId = library.idFor(to);
    const trash = getConfig().libraryTrash || [];
    const followsFrom = (entry) => !!(entry && entry.item && entry.item.type === 'image'
      && pathKey(entry.item.path) === fromKey);
    if (library.getItem(getConfig().library, newId)) {
      pool.clearRemovedState(to);
      // LIB-027. The kept record named the old file, and that name is gone: the file is
      // the active photo now. Left behind, it was a card in "Removed" for a file that does
      // not exist (gate 03, 2026-10-09).
      getConfig().libraryTrash = trash.filter((entry) => !followsFrom(entry));
      return true;
    }
    // LIB-027. A record already kept under the new name belongs to an earlier photo whose
    // file is gone — this file now holds that name. Two records under one id would be
    // settled later by a tie-break, maybe in favour of the stale one, so it is settled
    // here: the record that follows the file stays, and it is made newer than the one it
    // replaces, so a recovery merge with an older copy of the store decides the same way.
    const toKey = pathKey(to);
    let replacedRev = 0;
    const kept = [];
    for (const entry of trash) {
      if (!followsFrom(entry) && entry && entry.item && pathKey(entry.item.path) === toKey) {
        replacedRev = Math.max(replacedRev, library.revOf(entry));
        continue;
      }
      kept.push(entry);
    }
    for (const entry of kept) {
      if (!followsFrom(entry)) continue;
      entry.item = { ...entry.item, id: newId, path: to };
      if (replacedRev) entry.rev = Math.max(library.revOf(entry), replacedRev) + 1;
    }
    getConfig().libraryTrash = kept;
    const undo = lastRemoval;
    if (undo) {
      undo.items = (undo.items || []).map((item) => (
        item && item.type === 'image' && pathKey(item.path) === fromKey ? { ...item, id: newId, path: to } : item));
      for (const snap of (undo.slots || [])) {
        snap.itemIds = snap.itemIds.map((id) => (id === oldId ? newId : id));
      }
      undo.paths = (undo.paths || []).map((p) => (pathKey(p) === fromKey ? to : p));
    }
    // The index already moved the mark, so something changed either way.
    return true;
  }

  /**
   * @param {unknown} rawRecords
   * @param {{ senderIsMain?: () => boolean }} [options]
   */
  function removeMany(rawRecords, { senderIsMain = () => true } = {}) {
    return pool.withLock(async () => {
      if (!Array.isArray(rawRecords) || !rawRecords.length || rawRecords.length > 50000) {
        return { config: getConfig(), removed: 0, hidden: 0, error: 'bad_request', warning: null, undo: null };
      }

      /** @type {Array<{ id: string, path: string, item: any, type: string }>} */
      const records = [];
      const seen = new Set();
      for (const raw of rawRecords) {
        const rec = typeof raw === 'string' ? { id: raw, path: '' } : (raw || {});
        const id = typeof rec.id === 'string' && rec.id ? rec.id : '';
        const p = typeof rec.path === 'string' ? rec.path : '';
        const item = id ? library.getItem(getConfig().library, id) : null;
        const filePath = p || (item && item.path) || '';
        const type = (item && item.type) || (rec.type === 'folder' ? 'folder' : 'image');
        const key = `${id}|${pathKey(filePath)}`;
        if ((!id && !filePath) || seen.has(key)) continue;
        seen.add(key);
        records.push({ id: item ? id : '', path: filePath, item, type });
      }
      if (!records.length) return { config: getConfig(), removed: 0, hidden: 0, error: 'bad_request', warning: null, undo: null };

      // Removing a folder removes what is inside it — including the photos in there that
      // earned a pool record of their own (a star, a tag or an assignment creates one).
      //
      // This closure is computed FIRST, before anything is snapshotted or deleted. It used
      // to run at the very end, after the pool and the slots had already been rewritten,
      // which meant the descendants were found and then nothing was done with them: they
      // stayed in the pool and in their slots. Inside an ordinary subfolder the hidden
      // marker covered that up; remove a watched ROOT and its index is forgotten too, so
      // the photos came straight back on screen and into the rotation.
      const removedDirKeys = records
        .filter((r) => r.type === 'folder')
        .map((r) => pathKey(r.path))
        .filter(Boolean);
      /** @param {string} p */
      const underRemovedDir = (p) => removedDirKeys.some((dir) => library.isUnderPath(p, dir));
      /** @type {any[]} */
      const descendants = [];
      if (removedDirKeys.length) {
        const named = new Set(records.map((r) => r.id).filter(Boolean));
        for (const it of Object.values(getConfig().library)) {
          // Both kinds. Limiting this to images left a subfolder that had earned its own
          // record — a star, a tag or an assignment creates one — sitting in the library and
          // on a monitor after its parent was removed, still serving the photos inside it.
          if (!it || !it.path || named.has(it.id)) continue;
          if (it.type !== 'image' && it.type !== 'folder') continue;
          if (underRemovedDir(it.path)) descendants.push(it);
        }
      }

      // Snapshot enough to put everything back if the user immediately undoes. Slot
      // membership is part of that: removal empties slots, and an undo that restored the
      // pool record but not its placement would quietly change which wallpapers rotate.
      /** @type {any} */
      const undo = { items: [], slots: [], paths: [], dirs: [], at: now() };
      const removedIds = new Set();
      for (const rec of records) {
        if (!rec.item) continue;
        undo.items.push(JSON.parse(JSON.stringify(rec.item)));
        removedIds.add(rec.id);
      }
      for (const it of descendants) {
        undo.items.push(JSON.parse(JSON.stringify(it)));
        removedIds.add(it.id);
      }
      for (const [monitorId, monitor] of Object.entries(getConfig().monitors || {})) {
        for (const theme of ['light', 'dark']) {
          const slot = monitor[theme];
          if (!slot || !Array.isArray(slot.itemIds)) continue;
          if (!slot.itemIds.some((/** @type {string} */ id) => removedIds.has(id))) continue;
          undo.slots.push({ monitorId, theme, itemIds: slot.itemIds.slice(), emptied: false });
        }
      }

      // LIB-006: keep the whole record — tags, star, author, source — for every photo whose
      // record is being taken away, so putting it back means getting it back, not typing it
      // in again. Where the file lives decides nothing here; the record is the record.
      //
      // This used to be limited to photos Znada had copied for itself, on the reasoning
      // that only they needed protecting from the orphan sweep. But the file and the record
      // are two different things: a starred, tagged photo inside a watched folder kept its
      // FILE and lost its RECORD, so restoring the folder brought back a blank photo. (The
      // orphan sweep only ever looks inside wallpapers/, so keeping other paths in this list
      // costs nothing.)
      if (!Array.isArray(getConfig().libraryTrash)) getConfig().libraryTrash = [];
      const removedAt = now();
      // One id for this whole removal. The trash is bounded, and the bound applies to whole
      // removals: without this, removing a folder of 520 photos kept 500 of their records
      // and lost the stars and tags of the rest with nothing on screen saying so.
      const removalGroup = `${removedAt.toString(36)}-${randomHex(4)}`;
      // The main window replaces its one toast when another removal happens, but the
      // fullscreen viewer is a separate document and can still show the older action.
      // Carry the group as an opaque token so that stale Undo can never restore a newer,
      // unrelated removal.
      undo.token = removalGroup;
      // Each entry records WHY it went: named by the user, or carried along by a folder.
      // Putting a folder back may only undo the second kind.
      //
      // The NEAREST removed folder, not the first one that happens to contain the path.
      // Removing a folder and one of its own subfolders in a single action wrote the outer
      // one here, so restoring the subfolder alone brought nothing back with it.
      /** @param {any} item */
      const removalReason = (item) => {
        let best = '';
        for (const dir of removedDirKeys) {
          if (!library.isUnderPath(item.path, dir)) continue;
          if (dir.length > best.length) best = dir;
        }
        return best;
      };
      // Where each record was placed, so a restore after a restart can put it back on the
      // same monitor and theme rather than only into the library.
      /** @param {string} id */
      const placementsFor = (id) => {
        const out = [];
        for (const snap of undo.slots) {
          const index = snap.itemIds.indexOf(id);
          if (index < 0) continue;
          out.push({ monitorId: snap.monitorId, theme: snap.theme, index, emptied: false });
        }
        return out;
      };
      // LIB-009. Вытеснение переживает эту функцию: запись, выпавшая из корзины, теряет защиту
      // от сборщика обоев, и вернуть её одним нажатием уже нельзя. Раньше об этом знала только
      // консоль разработчика, поэтому счёт копится здесь и уходит в ответ вместе с остальным.
      let evicted = 0;
      // Descendants of a removed folder are covered by the same rule.
      for (const rec of [...records.map((r) => ({ ...r, named: true })),
        ...descendants.map((item) => ({ item, named: false }))]) {
        // Folders are kept too. Skipping them meant a subfolder that had earned a record —
        // a star, tags, a place on a monitor — lost all of it the moment its parent went,
        // and the only way back was the toast, which does not survive a restart.
        if (!rec.item || (rec.item.type !== 'image' && rec.item.type !== 'folder')) continue;
        // Bounded here, not only on save: the trash is what holds GC off these files, so
        // a list that is longer in memory than on disk would quietly drop protection for
        // the oldest entry at the next start.
        const pushed = libraryStore.pushEntry(getConfig().libraryTrash, {
          item: JSON.parse(JSON.stringify(rec.item)),
          // DATA-005. The tombstone has to be NEWER than the record it buries, or a merge
          // cannot tell "deleted after the last edit" from "edited after the deletion" —
          // and gets it wrong in the direction that brings the photo back.
          rev: library.revOf(rec.item) + 1,
          removedAt,
          via: rec.named ? '' : removalReason(rec.item),
          group: removalGroup,
          slots: placementsFor(rec.item.id),
        });
        getConfig().libraryTrash = pushed.trash;
        if (pushed.evicted.length) {
          evicted += pushed.evicted.length;
          log.log(`library trash full: ${pushed.evicted.length} oldest entr(y/ies) released to the orphan sweep`);
        }
      }

      // The pre-library fallback still applies a bare path, and migrateConfig would pull
      // it back into the pool on the next start — so a removed photo could reappear and
      // keep being used. Clear it here, keeping the explicit-empty semantics intact.
      const removedPaths = new Set(records.map((r) => pathKey(r.path)).filter(Boolean));
      for (const key of ['lightWallpaper', 'darkWallpaper']) {
        if (!getConfig()[key]) continue;
        // Either named directly, or sitting inside a folder that was just removed.
        if (!removedPaths.has(pathKey(getConfig()[key])) && !underRemovedDir(getConfig()[key])) continue;
        undo.legacy = undo.legacy || {};
        undo.legacy[key] = getConfig()[key];
        getConfig()[key] = '';
      }

      for (const id of removedIds) library.removeItem(getConfig().library, id);
      const emptiedSlots = new Set();
      for (const [monitorId, monitor] of Object.entries(getConfig().monitors || {})) {
        for (const theme of ['light', 'dark']) {
          const slot = monitor[theme];
          if (!slot || !Array.isArray(slot.itemIds)) continue;
          const before = slot.itemIds.length;
          slot.itemIds = slot.itemIds.filter((/** @type {string} */ id) => !removedIds.has(id));
          if (before > 0 && slot.itemIds.length === 0) {
            library.markSlotExplicitEmpty(slot);
            wallpaper.storeSlideshowPosition(monitorId, theme, { index: 0, path: '' });
            const snap = undo.slots.find((/** @type {any} */ sl) => sl.monitorId === monitorId && sl.theme === theme);
            if (snap) snap.emptied = true;
            emptiedSlots.add(`${monitorId}|${theme}`);
          }
        }
      }
      // Which slots this removal left empty is only known after the slots have been
      // rewritten, but the kept records were written before that. A restore has to lift the
      // "deliberately empty" marker it set, or the monitor would keep playing nothing with
      // its wallpaper sitting right there in the library again.
      if (emptiedSlots.size) {
        for (const entry of getConfig().libraryTrash) {
          if (!entry || entry.group !== removalGroup || !Array.isArray(entry.slots)) continue;
          for (const slot of entry.slots) {
            if (emptiedSlots.has(`${slot.monitorId}|${slot.theme}`)) slot.emptied = true;
          }
        }
      }

      // Photos still reachable through a watched folder would simply come back on the
      // next scan, so they are marked removed in the index instead.
      const hiddenResult = marks.setHidden(
        records.filter((r) => r.type !== 'folder').map((r) => r.path).filter(Boolean),
        true,
      );
      undo.paths = hiddenResult.matched;

      // LIB-008: a subfolder the user merely navigated into has no record of its own, so
      // it is removed by path prefix. That also covers photos dropped into it later —
      // hiding the files it holds today would let the folder come back one photo at a time.
      // Every removed folder, including one that had earned a pool record of its own
      // (a star, a tag, an assignment all create one). Its photos are indexed under the
      // watched ROOT as well, so dropping the record alone left them on screen while the
      // message claimed they were removed. The watched root itself is unaffected:
      // setHiddenDir resolves it to an empty relative path and skips it, and removing a
      // root is still done by dropping its record.
      const dirResult = marks.setHiddenDir(
        records.filter((r) => r.type === 'folder').map((r) => r.path).filter(Boolean),
        true,
      );
      undo.dirs = dirResult.matched;
      if (dirResult.changed) marks.persistNow();
      // Written at once rather than on the usual 5s debounce: this is a deliberate user
      // action, and a crash in that window would silently bring the photos back.
      if (hiddenResult.changed) marks.persistNow();

      // (The photos inside a removed folder that had their own pool record were collected
      // BEFORE any of the above and went through the same removal — see `descendants`.)

      // Including the subfolders that came with the parent: leaving their watcher running
      // would keep re-discovering the files of a folder the user has removed.
      const removedFolders = [...records.filter((r) => r.item && r.item.type === 'folder').map((r) => r.id),
        ...descendants.filter((it) => it.type === 'folder').map((it) => it.id)];
      if (removedFolders.length) { liveFolders.forget(removedFolders); liveFolders.sync(); }

      save();
      wallpaper.gc();
      refreshTray();
      lastRemoval = (undo.items.length || undo.paths.length || undo.dirs.length) ? undo : null;

      let warning = null;
      try { await wallpaper.apply(); }
      catch (err) {
        warning = 'apply_failed';
        log.error('bulk library removal apply failed:', err);
      }
      // What the user is told must be counted in CARDS, not in bookkeeping rows. A photo
      // that is both a library record and a file inside a watched folder touches two
      // rows, and one reachable through two overlapping folders touches two more — the
      // old sum said "2" for a single removed photo.
      const changedPaths = new Set(
        [...hiddenResult.matched, ...dirResult.matched].map(pathKey),
      );
      const affected = records.filter((rec) => (
        (rec.id && removedIds.has(rec.id)) || changedPaths.has(pathKey(rec.path))
      )).length;

      // A hide is invisible to the main window's grid, and only another window's removal
      // needs telling — the main window updates itself as part of its own removal, and
      // repeating it there would rebuild the grid twice and lose the scroll position.
      const hiddenNow = hiddenResult.updated + dirResult.updated;
      if (hiddenNow > 0 && !senderIsMain()) liveFolders.notifyViewStale('remove');

      return {
        config: getConfig(),
        affected,
        removed: undo.items.length,
        evicted,
        hidden: hiddenResult.updated + dirResult.updated,
        error: null,
        warning,
        undo: lastRemoval ? { count: records.length, token: lastRemoval.token } : null,
      };
    });
  }

  // Put back exactly what the last removal took away. Only the most recent removal is
  // kept — this backs the "Undo" in the toast, not a full history.
  /** @param {unknown} expectedToken */
  function undoRemoval(expectedToken) {
    return pool.withLock(async () => {
      const undo = lastRemoval;
      if (!undo) return { config: getConfig(), restored: 0, error: 'nothing_to_undo' };
      if (expectedToken && undo.token !== expectedToken) {
        return { config: getConfig(), restored: 0, error: 'stale_undo' };
      }

      const undoRestoredIds = new Set();
      /** @type {any[]} */
      const failedItems = [];
      for (const item of undo.items) {
        if (!item || !item.id) continue;
        // If Znada's own copy could not be brought back, do NOT add a record pointing at
        // a file that is not there and do NOT drop the recovery entry — that entry is the
        // only remaining way back.
        if (ownCopies.isOwnCopy(item.path) && !restoreOwnCopyFile(item)) {
          log.error('undo: копия не восстановлена, запись корзины сохранена:', item.path);
          failedItems.push(item);
          continue;
        }
        // Undo and Restore agree on a missing target on an available disk — a photo OR a
        // watched folder (1.9.0 gate: a folder whose directory was deleted came back as an
        // empty record reported "restored"). A disconnected disk is still allowed because
        // its files cannot be confirmed missing.
        if (recordTargetLost(item.path)) {
          failedItems.push(item);
          continue;
        }
        const activeItem = getConfig().library[item.id] || item;
        pool.markRecordRevived(activeItem);
        if (!getConfig().library[item.id]) getConfig().library[item.id] = activeItem;
        undoRestoredIds.add(item.id);
        pool.dropFromTrash(item.id);
      }
      // Put back only the ids this removal took out, in their original positions. The old
      // code assigned the whole pre-removal list, so anything the user added afterwards —
      // "remove A, then assign C" — vanished when they pressed Undo.
      for (const snap of undo.slots) {
        const monitor = (getConfig().monitors || {})[snap.monitorId];
        const slot = monitor && monitor[snap.theme];
        if (!slot || !Array.isArray(slot.itemIds)) continue;
        const present = new Set(slot.itemIds);
        const rebuilt = slot.itemIds.slice();
        snap.itemIds.forEach((/** @type {string} */ id, /** @type {number} */ index) => {
          if (!undoRestoredIds.has(id) || present.has(id)) return;
          rebuilt.splice(Math.min(index, rebuilt.length), 0, id);
          present.add(id);
        });
        if (snap.emptied && rebuilt.length > slot.itemIds.length) library.clearSlotExplicitEmpty(slot);
        slot.itemIds = rebuilt;
      }
      const failedPaths = new Set(failedItems.map((item) => pathKey(item.path)));
      const restoredPaths = undo.paths.filter((p) => !failedPaths.has(pathKey(p)));
      if (restoredPaths.length) {
        const res = marks.setHidden(restoredPaths, false);
        if (res.changed) marks.persistNow();
      }
      // The legacy fallback is a bare path with no record behind it, so putting it back
      // when its file did not come back would point the desktop at nothing.
      for (const [key, value] of Object.entries(undo.legacy || {})) {
        if (getConfig()[key]) continue;
        let present = true;
        try { present = fs.existsSync(value); } catch { present = false; }
        if (present) getConfig()[key] = value;
      }
      // A folder whose record stayed in the trash keeps its removed-mark too: lifting it
      // would count the folder as "restored" and drop it from the retry below.
      const restoredDirs = (undo.dirs || []).filter((/** @type {string} */ p) => !failedPaths.has(pathKey(p)));
      if (restoredDirs.length) {
        const res = marks.setHiddenDir(restoredDirs, false);
        if (res.changed) marks.persistNow();
      }
      const restoredFolders = undo.items.filter((/** @type {any} */ it) => (
        it && it.type === 'folder' && undoRestoredIds.has(it.id)
      ));
      if (restoredFolders.length) {
        liveFolders.sync();
        // Starting the watcher is not a scan: without this the folder's photos would only
        // reappear on the next file event or the hourly pass, so Undo would look partial.
        liveFolders.refresh(restoredFolders.map((/** @type {any} */ it) => it.id));
      }

      // What is left to retry, and nothing more. Clearing the whole record up front meant a
      // failed restore was unrepeatable; keeping the whole record would offer to undo work
      // that is already done. Slot positions travel with the items they belong to.
      const failedIds = new Set(failedItems.map((it) => it.id));
      lastRemoval = failedItems.length ? {
        items: failedItems,
        slots: (undo.slots || []).filter((/** @type {any} */ snap) => snap.itemIds.some((/** @type {string} */ id) => failedIds.has(id))),
        paths: undo.paths.filter((p) => failedPaths.has(pathKey(p))),
        dirs: (undo.dirs || []).filter((/** @type {string} */ p) => failedPaths.has(pathKey(p))),
        legacy: undo.legacy, at: undo.at, token: undo.token,
      } : null;

      save();
      refreshTray();
      try { await wallpaper.apply(); } catch (err) { log.error('undo removal apply failed:', err); }
      // Counted from what actually happened: the old sum reported every item in the
      // snapshot, including the ones whose file could not be brought back.
      // Counted in CARDS, not in bookkeeping rows. One photo inside a watched folder is both
      // a library record and a marked file in the index, so adding the two lists together
      // said "2 restored" for a single photo.
      const restoredKeys = new Set();
      for (const id of undoRestoredIds) {
        const item = getConfig().library[id];
        if (item && item.path) restoredKeys.add(pathKey(item.path));
      }
      for (const p of [...restoredPaths, ...restoredDirs]) restoredKeys.add(pathKey(p));

      return {
        config: getConfig(),
        restored: restoredKeys.size,
        failed: failedItems.length,
        error: null,
      };
    });
  }

  // The "removed" section: photos the user took out of the library that are still
  // physically present in a watched folder, so restoring them costs nothing.
  function hiddenList() {
    /** @type {any[]} */
    const images = [];
    const shown = new Set();   // one card per photo, whichever bookkeeping it appears in
    /** @type {string[]} */
    let hiddenDirs = [];
    try { hiddenDirs = marks.listHiddenDirs().map((d) => d.path); }
    catch (err) { log.error('library-hidden-list (hidden dirs):', err); }
    /** @param {string} p */
    const underHiddenDir = (p) => hiddenDirs.some((dir) => library.isUnderPath(p, dir));
    try {
      for (const im of marks.listHiddenImages()) {
        // Photos hidden only because their subfolder was removed are represented by
        // that folder's own card below; listing them too would turn one decision into
        // hundreds of cards the user cannot act on individually.
        if (im.hiddenByDir) continue;
        // Two watched folders can overlap, so the same file is indexed under both roots
        // and arrived here twice — two identical cards for one photo, and removing or
        // restoring one left the other on screen.
        const key = pathKey(im.path);
        if (shown.has(key)) continue;
        shown.add(key);
        images.push(im);
      }
      for (const dir of marks.listHiddenDirs()) {
        // Overlapping watched roots index the same subfolder twice, so it arrived here
        // twice — two identical folder cards for one decision, and acting on one left the
        // other on screen. The photos above were already deduplicated; folders were not.
        const key = pathKey(dir.path);
        if (shown.has(key)) continue;
        shown.add(key);
        images.push({
          folderId: dir.folderId, path: dir.path, type: 'folder',
          firstSeenAt: 0, addedAt: 0, modifiedAt: 0, aspect: 1.6, hidden: true,
        });
      }
    } catch (err) {
      log.error('library-hidden-list (folders):', err);
    }
    // LIB-006: photos whose record was taken away live here too — including the ones
    // whose only copy belongs to Znada, which need a way back the most.
    for (const entry of (getConfig().libraryTrash || [])) {
      if (!entry || !entry.item) continue;
      // The same photo can be both a kept record and a marked file in the folder index;
      // and a photo inside a removed FOLDER is represented by that folder's single card,
      // exactly as above. Either way it must not turn into a second card the user cannot
      // act on separately.
      const key = pathKey(entry.item.path);
      if (shown.has(key) || underHiddenDir(entry.item.path)) continue;
      shown.add(key);
      images.push({
        folderId: '',
        path: entry.item.path,
        // Folder records live in here too now, and a folder card is not drawn like a
        // photo: without this the removed view would try to show a thumbnail of a
        // directory and offer photo actions on it.
        ...(entry.item.type === 'folder' ? { type: 'folder' } : {}),
        firstSeenAt: entry.removedAt,
        addedAt: entry.item.addedAt || entry.removedAt,
        modifiedAt: entry.item.modifiedAt || 0,
        aspect: Number(entry.item.aspect) || 0,
        hidden: true,
      });
    }
    return { images };
  }

  // While a photo sits in the library trash its file stays where it was, held by the
  // GC keep-set. This only covers the older case where a previous build had already
  // swept the copy into wallpapers/.trash — then bring it back rather than telling the
  // user the photo is unrecoverable. Never overwrites an existing file.
  /** @param {any} item */
  function restoreOwnCopyFile(item) {
    if (!item || !item.path || !ownCopies.isOwnCopy(item.path)) return false;
    // DATA-006. With the folder away, "the file is not at its path" says nothing about
    // whether it still exists, and the trash to bring it back from is out of reach too.
    if (!ownCopies.rootReady()) return false;
    if (fs.existsSync(item.path)) return true;
    const trashed = path.join(ownCopies.trashDir(), path.basename(item.path));
    try {
      if (!fs.existsSync(trashed)) return false;
      fs.mkdirSync(path.dirname(item.path), { recursive: true });
      fs.renameSync(trashed, item.path);
      return true;
    } catch (err) {
      log.error('restore from .trash failed:', err);
      return false;
    }
  }

  // LIB-007: the one action allowed to touch the user's files. "Remove from library"
  // only stops showing something; this deletes the file — and it deletes it into the
  // WINDOWS RECYCLE BIN (`trashItem` is `shell.trashItem`), never past it, so the
  // project's rule that Znada does not destroy anything irreversibly still holds.
  //
  // Two guards make this safe to expose to the renderer:
  //   * only paths ALREADY in the library trash or marked removed can be deleted, so a
  //     compromised or buggy renderer cannot name an arbitrary file;
  //   * the user confirms in a native dialog that names what is about to go.
  // The switch that keeps the whole action OFF for users lives in main.js, in one
  // place, and is asked here before anything else.
  /** @param {unknown} rawPaths */
  async function deleteForever(rawPaths) {
    if (!physicalDeleteEnabled()) return { config: getConfig(), deleted: 0, error: 'disabled' };
    // DATA-006. Whatever re-enables this later must not be able to erase files while the
    // folder holding them is unreachable: "not there right now" is not "safe to delete".
    if (!ownCopies.rootReady()) return { config: getConfig(), deleted: 0, error: 'media_root_unavailable' };
    const asked = (Array.isArray(rawPaths) ? rawPaths : []).filter((p) => typeof p === 'string' && p);
    if (!asked.length) return { config: getConfig(), deleted: 0, error: 'bad_request' };

    // Deletable = what the user already removed. Directories are deliberately out of
    // scope: erasing a folder tree is a different question from erasing a photo.
    const allowed = new Set();
    for (const entry of (getConfig().libraryTrash || [])) {
      if (entry && entry.item && entry.item.path) allowed.add(pathKey(entry.item.path));
    }
    // This also covers photos under a removed SUBFOLDER, not only individually removed
    // ones. Deliberate: the user removed the folder, so its contents count as removed
    // here too. They have no card of their own in the trash, so nothing in the interface
    // can reach them today — the guard is simply not narrower than the decision the user
    // already made.
    for (const key of marks.hiddenPaths()) allowed.add(key);

    // Whatever is active RIGHT NOW can never be deleted, even if a stale trash entry
    // still names it: re-importing or re-downloading the same content-addressed file
    // makes it active again, and the leftover entry would otherwise authorise erasing
    // a photo the user is currently using.
    const activePaths = () => pool.inUsePaths();

    const before = activePaths();
    const targets = asked.filter((p) => allowed.has(pathKey(p)) && !before.has(pathKey(p)));
    if (!targets.length) return { config: getConfig(), deleted: 0, error: 'not_removed' };

    if (!(await askDeleteForever(targets))) return { config: getConfig(), deleted: 0, error: null, cancelled: true };

    // The dialog was open for as long as the user took, and every await below is another
    // chance for a download, a restore or an assignment to put one of these files back
    // into use. One re-check after the dialog is not enough: it says nothing about the
    // state between the second and the third `trashItem`.
    //
    // So the deletions run inside the library lock, which every route that activates a
    // photo also takes — nothing can change underneath the loop — and each target is
    // checked against the state as it is at that exact moment, immediately before it is
    // erased. Re-checking "removed" as well as "active": a restore while the dialog was
    // open takes a photo out of the trash without ever making it active.
    return pool.withLock(async () => {
      const deletable = () => {
        const set = new Set();
        for (const entry of (getConfig().libraryTrash || [])) {
          if (entry && entry.item && entry.item.path) set.add(pathKey(entry.item.path));
        }
        for (const key of marks.hiddenPaths()) set.add(key);
        return set;
      };

      let deleted = 0;
      const failed = [];
      const gone = new Set();
      let skipped = 0;
      for (const target of targets) {
        const key = pathKey(target);
        if (!deletable().has(key) || activePaths().has(key)) { skipped++; continue; }
        try {
          await trashItem(target);
          deleted++;
          gone.add(key);
        } catch (err) {
          failed.push(target);
          log.error('delete to recycle bin failed:', target, err);
        }
      }
      if (!deleted && !failed.length) return { config: getConfig(), deleted: 0, error: 'not_removed' };

      // Only forget what actually left: a file that could not be moved is still there,
      // and dropping its record would strand it exactly the way the trash exists to avoid.
      if (gone.size) {
        const trashBefore = (getConfig().libraryTrash || []).length;
        getConfig().libraryTrash = (getConfig().libraryTrash || [])
          .filter((/** @type {any} */ entry) => !(entry && entry.item && gone.has(pathKey(entry.item.path))));
        // The photo leaves the trash because its entry above is gone. The removed-marker
        // in the folder index is deliberately LEFT ALONE: clearing it would mean "show
        // this again", and the file no longer exists, so the grid would gain a broken
        // card pointing at nothing. reconcileFolder drops the index record on the next
        // complete scan, which is already how a file that vanished from disk is handled.
        if (trashBefore !== getConfig().libraryTrash.length) save();
      }
      return { config: getConfig(), deleted, failed: failed.length, skipped, error: null };
    });
  }

  // A path can be missing for two completely different reasons, and they need
  // opposite answers. The file was deleted: there is nothing to point a record at,
  // so refusing is right. The DISK was unplugged: the record has to come back —
  // live folders exist precisely to survive an absent volume, and refusing leaves
  // the entry stuck in the trash with no way out.
  //
  // Found by the owner 2026-08-16: a live folder on an unplugged disk was removed
  // and could then never be restored — "put back: 0" every time. Folder records
  // only started reaching this check when they began being kept in the trash
  // (BUG-012), which is what turned a reasonable guard for images into a trap.
  /** @param {string} target */
  function recordTargetLost(target) {
    try {
      if (fs.existsSync(target)) return false;
      const root = path.parse(path.resolve(String(target))).root;
      // No root at all means we cannot tell; treat that as "not proven lost".
      if (!root || !fs.existsSync(root)) return false;
      return true;
    } catch {
      return false;
    }
  }

  // Put a restored record back where it was playing. The index is only a hint: the slot
  // may have been edited since, so it is clamped rather than trusted, and an id that is
  // somehow already there is left alone instead of being listed twice.
  /** @param {any} entry */
  function restoreSlotPlacements(entry) {
    if (!entry || !Array.isArray(entry.slots) || !entry.item) return;
    for (const placement of entry.slots) {
      const monitor = (getConfig().monitors || {})[placement.monitorId];
      const slot = monitor && monitor[placement.theme];
      if (!slot || !Array.isArray(slot.itemIds)) continue;
      if (slot.itemIds.includes(entry.item.id)) continue;
      const at = Math.min(Math.max(placement.index, 0), slot.itemIds.length);
      slot.itemIds.splice(at, 0, entry.item.id);
      // The slot was emptied BY this removal, so the marker that says "the user wants this
      // one empty" was ours to set and is ours to lift.
      if (placement.emptied) library.clearSlotExplicitEmpty(slot);
    }
  }

  /** @param {unknown} rawPaths */
  function restore(rawPaths) {
    return pool.withLock(async () => {
      const paths = (Array.isArray(rawPaths) ? rawPaths : []).filter((p) => typeof p === 'string' && p);
      if (!paths.length) return { config: getConfig(), restored: 0 };
      const res = marks.setHidden(paths, false);
      const dirRes = marks.setHiddenDir(paths, false);
      if (res.changed || dirRes.changed) marks.persistNow();

      // The same button puts the RECORDS back — tags, star and all — and brings Znada's
      // own copies back from wallpapers/.trash on the way.
      //
      // Restoring a FOLDER has to reach the records of the photos inside it: those records
      // were taken away with the folder, and matching only exact paths meant the folder came
      // back full of photos that had quietly lost their stars and tags.
      let poolRestored = 0;
      // Which of the paths the CALLER asked about actually came back, for the count below.
      // A photo restored because its folder was restored is not a separate card.
      const restoredPoolKeys = new Set();
      const wanted = new Set(paths.map(pathKey));
      // A folder brings back exactly what went WITH IT — the entries whose `via` names THAT
      // folder — and nothing else.
      //
      // This used to match by ancestry: any entry whose `via` sat anywhere under the folder
      // being restored came back. So a subfolder the user had removed separately, earlier,
      // was undone by restoring its parent — and since the subfolder's own removed-marker is
      // untouched by that (it is a different folder), the photos ended up listed in "All"
      // and in the trash at the same time. Provenance is the exact folder, not the tree.
      /** @param {any} entry */
      const cameWithRestoredFolder = (entry) => !!entry.via && wanted.has(pathKey(entry.via));
      /** @type {string[]} */
      const restoredFolderIds = [];
      for (const entry of (getConfig().libraryTrash || []).slice()) {
        if (!entry || !entry.item) continue;
        if (!wanted.has(pathKey(entry.item.path)) && !cameWithRestoredFolder(entry)) continue;
        // Znada's own copy has to actually come back before its record does. Ignoring the
        // answer here was a real gap (found reviewing DATA-006 step 1): with the folder
        // away, `recordTargetLost` correctly says "cannot tell", so the record returned to
        // the active pool while the file stayed unreachable in the trash. The undo path
        // beside this one has always been strict; now both are.
        if (ownCopies.isOwnCopy(entry.item.path) && !restoreOwnCopyFile(entry.item)) {
          log.error('restore: копия не восстановлена, запись корзины сохранена:', entry.item.path);
          continue;
        }
        if (recordTargetLost(entry.item.path)) continue;  // nothing to point the record at
        const activeItem = getConfig().library[entry.item.id] || entry.item;
        pool.markRecordRevived(activeItem);
        if (!getConfig().library[entry.item.id]) getConfig().library[entry.item.id] = activeItem;
        restoreSlotPlacements(entry);
        if (entry.item.type === 'folder') restoredFolderIds.push(entry.item.id);
        pool.dropFromTrash(entry.item.id);
        restoredPoolKeys.add(pathKey(entry.item.path));
        poolRestored++;
      }
      // A watched folder that came back has to start being watched again, or it would sit
      // in the library while quietly ignoring everything added to it.
      if (restoredFolderIds.length) {
        liveFolders.sync();
        liveFolders.refresh(restoredFolderIds);
      }
      if (poolRestored) save();
      else broadcast();
      // Removal takes photos out of the playlist, so putting them back has to re-apply
      // for the same reason undo does: the slideshow position was computed without them.
      if (res.changed || dirRes.changed) {
        try { await wallpaper.apply(); }
        catch (err) { log.error('restore apply failed:', err); }
      }
      // Counted in cards for the same reason removal is: the caller asked about N cards, so
      // the answer is how many of THOSE came back — not how many rows changed underneath.
      // Restoring one folder card used to report 2, or 501.
      const changed = new Set([...res.matched, ...dirRes.matched].map(pathKey));
      for (const key of restoredPoolKeys) changed.add(key);
      const restored = paths.filter((p) => changed.has(pathKey(p))).length;
      return { config: getConfig(), restored };
    });
  }

  return {
    followRemovedMove,
    followMovedFiles,
    removeMany,
    undo: undoRemoval,
    undoPending: () => !!lastRemoval,
    hiddenList,
    restore,
    deleteForever,
  };
}

module.exports = { createLibraryRemoval };
