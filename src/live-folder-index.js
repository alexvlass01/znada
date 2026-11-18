'use strict';

// Owns discovery history, removed marks, the hidden-path cache and its writer.
// Scans and their library consequences stay with main; this owner has no pool/lock callbacks.
// DATA-001: `restore` hands a damaged index its newest good copy, `onRestored(takenAt)`
// tells the user. Both optional; without them a damaged index starts empty as before.
function createLiveFolderIndex({
  filePath, folderState, pathKey, logger = console, timers = { setTimeout, clearTimeout },
  restore = null, onRestored = null,
}) {
  let liveFolderState = folderState.emptyState();
  let hiddenPathsCache = null;
  let folderStateDirty = false;
  let folderStateSaveTimer = null;
  const FOLDER_STATE_SAVE_DEBOUNCE_MS = 5000;
  function invalidateHiddenPaths() { hiddenPathsCache = null; }
  function hiddenPathSet() {
    if (hiddenPathsCache) return new Set(hiddenPathsCache);
    const set = new Set();
    try {
      for (const im of folderState.listImages(liveFolderState, null, { only: 'hidden' })) {
        // Keyed like everything else that answers "is this the same file" (pathKey).
        // Plain lowercase kept `\` here while the playlist and the delete guard asked
        // with `/`, so this set silently matched nothing they looked up.
        if (im && im.path) set.add(pathKey(im.path));
      }
    } catch (err) { logger.error('hiddenPathSet:', err); }
    hiddenPathsCache = set;
    return new Set(set);
  }
  function loadLiveFolderState() {
    try {
      const loaded = folderState.loadState(filePath, { restore });
      liveFolderState = loaded.state;
      invalidateHiddenPaths();
      if (loaded.restoredAt) {
        logger.warn('folder-state.json повреждён; индекс восстановлен из последней целой копии.', loaded.brokenPath || '');
        // The damaged file stays at its original path until this atomic replacement.
        scheduleLiveFolderStateSave();
        // A failing report must not reach the catch below, which would empty the index.
        if (typeof onRestored === 'function') {
          try { onRestored(loaded.restoredAt); } catch (err) { logger.error('onRestored:', err); }
        }
      } else if (loaded.recovered) {
        logger.warn('folder-state.json повреждён; создан безопасный новый индекс.', loaded.brokenPath || '');
      }
    } catch (err) {
      liveFolderState = folderState.emptyState();
      invalidateHiddenPaths();
      logger.error('Не удалось загрузить folder-state.json:', err);
    }
  }

  function flushLiveFolderState() {
    if (folderStateSaveTimer) { timers.clearTimeout(folderStateSaveTimer); folderStateSaveTimer = null; }
    if (!folderStateDirty) return;
    try {
      liveFolderState = folderState.saveState(filePath, liveFolderState);
      invalidateHiddenPaths();
      folderStateDirty = false;
    } catch (err) {
      logger.error('Не удалось сохранить folder-state.json:', err);
    }
  }

  function scheduleLiveFolderStateSave() {
    folderStateDirty = true;
    if (folderStateSaveTimer) timers.clearTimeout(folderStateSaveTimer);
    folderStateSaveTimer = timers.setTimeout(flushLiveFolderState, FOLDER_STATE_SAVE_DEBOUNCE_MS);
    if (folderStateSaveTimer && typeof folderStateSaveTimer.unref === 'function') folderStateSaveTimer.unref();
  }

  const libraryMarks = {
    setHidden(paths, hidden) {
      const res = folderState.setHidden(liveFolderState, paths, hidden);
      liveFolderState = res.state;
      invalidateHiddenPaths();
      return summary(res);
    },
    setHiddenDir(paths, hidden) {
      const res = folderState.setHiddenDir(liveFolderState, paths, hidden);
      liveFolderState = res.state;
      invalidateHiddenPaths();
      return summary(res);
    },
    persistNow() { folderStateDirty = true; flushLiveFolderState(); },
    hiddenPaths: () => hiddenPathSet(),
    listHiddenImages: () => structuredClone(folderState.listImages(liveFolderState, null, { only: 'hidden' })),
    listHiddenDirs: () => structuredClone(folderState.listHiddenDirs(liveFolderState)),
  };
  // folder-state owns normalization; this owner keeps its mutable document private.
  function summary(result) {
    const dto = { ...result };
    delete dto.state;
    return structuredClone(dto);
  }
  function update(result, save = false) {
    liveFolderState = result.state;
    invalidateHiddenPaths();
    if (save && result.changed) scheduleLiveFolderStateSave();
    return summary(result);
  }
  function forget(ids) {
    const state = folderState.normalizeState(liveFolderState);
    let removed = false;
    for (const id of (ids || [])) {
      if (id && state.folders[id]) { delete state.folders[id]; removed = true; }
    }
    liveFolderState = state;
    invalidateHiddenPaths();
    if (removed) scheduleLiveFolderStateSave();
  }
  function replaceForMove(document) {
    liveFolderState = structuredClone(document);
    invalidateHiddenPaths();
    libraryMarks.persistNow();
  }
  function dispose() {
    if (folderStateSaveTimer) timers.clearTimeout(folderStateSaveTimer);
    folderStateSaveTimer = null;
  }
  return {
    load: loadLiveFolderState, flush: flushLiveFolderState, scheduleSave: scheduleLiveFolderStateSave,
    persistNow: libraryMarks.persistNow, marks: libraryMarks, hiddenPaths: hiddenPathSet,
    listImages: (ids = null, options = undefined) => structuredClone(folderState.listImages(liveFolderState, ids, options)),
    listHiddenDirs: () => structuredClone(folderState.listHiddenDirs(liveFolderState)),
    knownPathKeys: (id) => new Set(folderState.knownPathKeys(liveFolderState, id)),
    reconcile: (input) => update(folderState.reconcileFolder(liveFolderState, input), true),
    setAspects: (updates) => update(folderState.setAspects(liveFolderState, updates), true),
    forget, replaceForMove, dispose,
    snapshot: () => structuredClone(liveFolderState),
    // Harness seeding preserves the old no-dirty/no-flush semantics, without aliases.
    __test: { replace: (state) => { liveFolderState = structuredClone(state); invalidateHiddenPaths(); } },
  };
}

module.exports = { createLiveFolderIndex };
