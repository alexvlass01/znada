'use strict';

// Minimal keyed DOM reconciliation for the virtualized Library grid. A resize
// changes card geometry often, but usually not the identity/order of the
// materialized nodes. Blind appendChild() calls move every card through the DOM
// again and invalidate paint even when nothing structural changed.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VirtualGridDom = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  function reconcileChildren(parent, requested) {
    if (!parent || typeof parent.insertBefore !== 'function' || typeof parent.removeChild !== 'function') {
      return { inserted: 0, moved: 0, removed: 0, unchanged: 0 };
    }

    const desired = [];
    const keep = new Set();
    for (const node of Array.isArray(requested) ? requested : []) {
      if (!node || keep.has(node)) continue;
      keep.add(node);
      desired.push(node);
    }

    let removed = 0;
    for (const child of Array.from(parent.childNodes || [])) {
      if (keep.has(child)) continue;
      parent.removeChild(child);
      removed += 1;
    }

    let inserted = 0;
    let moved = 0;
    let unchanged = 0;
    let cursor = parent.firstChild || null;
    for (const node of desired) {
      if (node === cursor) {
        cursor = cursor.nextSibling;
        unchanged += 1;
        continue;
      }
      const wasAttached = node.parentNode === parent;
      parent.insertBefore(node, cursor);
      if (wasAttached) moved += 1;
      else inserted += 1;
      cursor = node.nextSibling;
    }

    return { inserted, moved, removed, unchanged };
  }

  return { reconcileChildren };
});
