'use strict';

// ONL-008. The Online tab's "+" is a control that goes BOTH ways.
//
// Until now it latched: pressing it downloaded the photo, and the button then sat there
// disabled forever. Undoing a mis-click meant leaving the tab, finding the photo among
// everything else in the Library and removing it there. The first outside tester hit this
// within a minute of opening the app ("добавить можно, убрать нельзя").
//
// The whole decision — is this online card already in the pool, and what should the
// button therefore say and do — lives here, away from the DOM, so both card kinds
// (Znada Cloud and the Internet sources) ask exactly the same question and get exactly
// the same answer. renderer.js only draws the result and calls the IPC.
//
// It lives in src/ because that is where this project keeps pure, tested logic; the
// renderer loads it by <script> the same way it loads src/path-key.js.
(function initOnlineAdd(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OnlineAdd = api;
}(typeof window !== 'undefined' ? window : globalThis, function onlineAddFactory() {
  // A downloaded online photo is recognised again by the marker written into its pool
  // record at download time — NOT by its file path. The path is content-addressed
  // (`<hash>-<theme>.<ext>`) and says nothing about where the photo came from.
  function sourceMarkers(kind, item) {
    if (!item || typeof item !== 'object') return [];
    if (kind === 'cloud') {
      const id = item.id == null ? '' : String(item.id);
      if (!id) return [];
      // "lumina:" is the pre-rename marker. Records downloaded before the product was
      // renamed still carry it, and dropping it here would show every one of them as
      // never downloaded — and let the user download a second copy.
      return ['znada:' + id, 'lumina:' + id];
    }
    const page = typeof item.page === 'string' ? item.page : '';
    return page ? [page] : [];
  }

  // One pass over the pool, reusable across a whole grid of cards. Without it every
  // card would walk the entire library on every refresh.
  function sourceIndex(library) {
    const index = new Map();
    const pool = library && typeof library === 'object' ? library : {};
    for (const record of Object.values(pool)) {
      if (!record || typeof record.source !== 'string' || !record.source) continue;
      if (!index.has(record.source)) index.set(record.source, record);
    }
    return index;
  }

  // `pool` is either the library object or a prebuilt index from sourceIndex().
  function pooledItem(pool, kind, item) {
    const markers = sourceMarkers(kind, item);
    if (!markers.length) return null;
    const index = pool instanceof Map ? pool : sourceIndex(pool);
    for (const marker of markers) {
      const record = index.get(marker);
      if (record) return record;
    }
    return null;
  }

  function buttonState(pool, kind, item) {
    const pooled = pooledItem(pool, kind, item);
    if (!pooled) {
      return { added: false, pooled: null, glyph: '+', titleKey: 'online.add', action: 'add' };
    }
    return { added: true, pooled, glyph: '✓', titleKey: 'online.remove', action: 'remove' };
  }

  // The payload for `library-remove-many` — the same shape the Library tab sends, so
  // taking a photo back out from the Online tab goes through the trash, the undo and
  // the bounded removal history rather than round some private side door. Nothing here
  // touches the file on disk.
  function removalPayload(pooled) {
    if (!pooled || typeof pooled !== 'object') return null;
    const id = typeof pooled.id === 'string' ? pooled.id : '';
    const path = typeof pooled.path === 'string' ? pooled.path : '';
    if (!id && !path) return null;
    return [{ id, path, type: pooled.type === 'folder' ? 'folder' : 'image' }];
  }

  return { sourceMarkers, sourceIndex, pooledItem, buttonState, removalPayload };
}));
