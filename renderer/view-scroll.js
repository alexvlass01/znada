'use strict';

// BUG-040. Where the user was in EACH list, not in the tab.
//
// The Library tab holds five different lists — All, Favourites, Folders, Online and a
// tag — and one remembered scroll position between them. Switching lists therefore had
// to throw the position away, or the wrong list would open half-way down. Throwing it
// away is right when the list really is a different one, and wrong when the user simply
// went somewhere and came back, which is what the complaint was about: the Online feed
// he had scrolled through for a while opened at the top again.
//
// One position per list fixes both at once. Bounded, because a tag view is a list too
// and the tag rail can hold hundreds; the oldest is dropped, and dropping one costs a
// view that opens at the top — exactly what happens today for every view.

(function initViewScroll(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ViewScroll = api;
}(typeof window !== 'undefined' ? window : globalThis, function viewScrollFactory() {
  const DEFAULT_LIMIT = 16;

  function createViewScrollMemory(limit = DEFAULT_LIMIT) {
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
    const seen = new Map();

    // A key of '' means "we do not know which list this was", and remembering under it
    // would hand one list's position to another.
    function remember(key, top) {
      const id = typeof key === 'string' ? key : '';
      if (!id) return;
      const value = Number(top);
      const at = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
      // Delete first so the re-insert moves it to the young end: the entry dropped when
      // the cap is reached is then the one nobody has looked at for longest.
      seen.delete(id);
      seen.set(id, at);
      while (seen.size > cap) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
    }

    // An unknown list opens at the top, which is what every list did before this existed.
    function recall(key) {
      const id = typeof key === 'string' ? key : '';
      if (!id || !seen.has(id)) return 0;
      const at = seen.get(id);
      // Touch it, so a list the user keeps returning to is not the one evicted.
      seen.delete(id);
      seen.set(id, at);
      return at;
    }

    // A list whose contents were deliberately replaced — a new search, say — has no
    // position worth keeping: the old number would point into somebody else's results.
    function forget(key) {
      const id = typeof key === 'string' ? key : '';
      if (id) seen.delete(id);
    }

    function size() { return seen.size; }
    function keys() { return [...seen.keys()]; }

    return { remember, recall, forget, size, keys };
  }

  return { createViewScrollMemory, DEFAULT_LIMIT };
}));
