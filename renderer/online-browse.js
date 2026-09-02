'use strict';

// BUG-020. One question, asked in one place: is this the front page we curate, or a
// search the user asked for?
//
// The rule is small but it is a state machine, and it lives in the window rather than in
// main — main can only see the flag it is handed. It is here rather than inline in
// renderer.js because it has three cases that are easy to get subtly wrong, and because
// the next thing to touch it (a saved search, a favourites view, an opt-out) will change
// the rule rather than add a branch somewhere else.
//
// The rule:
//   * nothing typed  -> the curated front page;
//   * anything typed -> the user's search, with their ordering and every category;
//   * ONE exception — changing the ordering while nothing is typed. At that moment the
//     control has to do what it says, or it reads as broken. That exception is
//     deliberately not persisted and does not survive a real search, so the front page
//     always comes back curated. Otherwise a single curious click would silently pin the
//     front page to one ordering forever, which is the state this whole task is undoing.

(function initOnlineBrowse(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OnlineBrowse = api;
}(typeof window !== 'undefined' ? window : globalThis, function onlineBrowseFactory() {
  function typed(query) {
    return !!String(query == null ? '' : query).trim();
  }

  // Whether this request should be curated. Both conditions, and main re-checks the
  // first one for itself: curation must never narrow something the user typed.
  function isBrowse(state) {
    const s = state || {};
    return !typed(s.q) && !s.sortTouched;
  }

  // The user just changed the ordering. With something typed this is an ordinary search
  // setting and nothing else changes; with nothing typed it is the exception above.
  function sortTouchedAfterChange(query, previous) {
    return typed(query) ? !!previous : true;
  }

  // A search just ran. A real one ends the exception, so clearing the box afterwards
  // returns to the curated front page rather than to whatever ordering was picked along
  // the way.
  function sortTouchedAfterSearch(query, previous) {
    return typed(query) ? false : !!previous;
  }

  return { isBrowse, sortTouchedAfterChange, sortTouchedAfterSearch };
}));
