'use strict';

(function initCardInteraction(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CardInteraction = api;
}(typeof window !== 'undefined' ? window : globalThis, function cardInteractionFactory() {
  function validRecord(record) {
    return !!(record && typeof record.key === 'string' && record.key);
  }

  function localKey(path, type) {
    const safeType = type === 'folder' ? 'folder' : 'image';
    const normalized = String(path || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return `local-${safeType}:${normalized}`;
  }

  function createSelectionModel() {
    const selected = new Map();
    let anchorKey = null;

    function toggle(record, orderedRecords = [], extend = false) {
      if (!validRecord(record)) return false;

      if (extend && anchorKey) {
        const ordered = orderedRecords.filter(validRecord);
        const from = ordered.findIndex((entry) => entry.key === anchorKey);
        const to = ordered.findIndex((entry) => entry.key === record.key);
        if (from !== -1 && to !== -1) {
          selected.clear();
          const first = Math.min(from, to);
          const last = Math.max(from, to);
          for (let i = first; i <= last; i += 1) selected.set(ordered[i].key, ordered[i]);
          return true;
        }
      }

      if (extend && !anchorKey) {
        selected.set(record.key, record);
      } else if (selected.has(record.key)) {
        selected.delete(record.key);
      } else {
        selected.set(record.key, record);
      }
      anchorKey = record.key;
      return true;
    }

    function refresh(record) {
      if (validRecord(record) && selected.has(record.key)) selected.set(record.key, record);
    }

    return {
      get size() { return selected.size; },
      get anchorKey() { return anchorKey; },
      has: (key) => selected.has(key),
      values: () => Array.from(selected.values()),
      keys: () => Array.from(selected.keys()),
      toggle,
      refresh,
      delete(key) {
        const removed = selected.delete(key);
        if (key === anchorKey) anchorKey = null;
        return removed;
      },
      clear() { selected.clear(); anchorKey = null; },
    };
  }

  function actionsFor(record) {
    const isFolder = !!(record && record.type === 'folder');
    return {
      open: isFolder,
      assign: validRecord(record),
      favorite: validRecord(record),
      tags: validRecord(record),
      // Details are read-only, so they stay available for transient cards too: the
      // view reads metadata from disk by path and never materializes the item.
      details: validRecord(record),
      // LIB-004/LIB-008: removable regardless of how it got here — a photo, and a
      // subfolder the user merely navigated into as well. Removing a subfolder is
      // recorded against its path, so photos added to it later stay removed too.
      // Removal never deletes files.
      remove: validRecord(record),
    };
  }

  // Keeps transient cards lazy: constructing/opening their action UI does no
  // library write. The first committed mutating action performs one materialize,
  // and concurrent/repeated commits share that result.
  function createLazyPoolItem(initialItem, materialize) {
    let item = initialItem || null;
    let pending = null;
    return {
      current: () => item,
      async ensure() {
        if (item) return item;
        if (typeof materialize !== 'function') return null;
        if (!pending) {
          pending = Promise.resolve()
            .then(() => materialize())
            .then((value) => {
              item = value || null;
              return item;
            })
            .finally(() => { pending = null; });
        }
        return pending;
      },
    };
  }

  return { localKey, createSelectionModel, actionsFor, createLazyPoolItem };
}));
