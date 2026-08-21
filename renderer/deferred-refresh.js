'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DeferredRefresh = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  function create(targets) {
    const allowed = new Set((Array.isArray(targets) ? targets : []).filter((key) => typeof key === 'string' && key));
    const pending = new Set();

    function mark(target) {
      if (allowed.has(target)) pending.add(target);
    }

    function markAll() {
      for (const target of allowed) pending.add(target);
    }

    function has(target) {
      return pending.has(target);
    }

    function consume(target) {
      const wasPending = pending.has(target);
      pending.delete(target);
      return wasPending;
    }

    return { mark, markAll, has, consume };
  }

  return { create };
});
