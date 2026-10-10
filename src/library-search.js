'use strict';

// LIB-014 stage 1. What the Library search box finds.
//
// Until now the box looked only at file names: a photo tagged `blue_sky` could not be found
// by typing `sky`, and two words were read as one phrase that had to sit in the name. The
// owner's decisions (2026-09-28):
//   * the box looks at the file name AND at the tags;
//   * several words mean ALL of them, never "any" — each word narrows. A word may be found in
//     the name or in any one tag, and different words may be found in different places;
//   * the same text means the same words on both tabs, so the text is split by the search
//     box's own rule (`TagSuggest.splitTerms`), the one the sites get their words from too.
//
// A word is looked for as a PART, the way the name search always worked: `sky` finds
// `blue_sky` and `skyline.jpg`. `_` and a space count as the same character, because a site
// writes the tag `blue_sky` while a person types `blue sky`; case does not matter.
//
// Pure: the window hands in the text and a photo's name and tags. Nothing here reads the
// disk, and a photo without tags (one from a watched folder that has no record yet) simply
// has only its name to be found by.

(function initLibrarySearch(root, factory) {
  const commonjs = typeof module === 'object' && module.exports;
  // The page loads this after `tag-suggest.js` (index.html); main and tests require it.
  const searchBox = commonjs ? require('./tag-suggest') : root && root.TagSuggest;
  if (!searchBox || typeof searchBox.splitTerms !== 'function') {
    throw new Error('library-search.js needs tag-suggest.js loaded before it');
  }
  const api = factory(searchBox);
  if (commonjs) module.exports = api;
  if (root) root.LibrarySearch = api;
}(typeof window !== 'undefined' ? window : globalThis, function librarySearchFactory(searchBox) {
  // One spelling for comparing: lowercase, `_` read as a space, runs of spaces as one.
  function fold(value) {
    return String(value == null ? '' : value).toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
  }

  // The words to look for, each already in the compared spelling. An empty list means the
  // box narrows nothing.
  function parse(text) {
    const words = searchBox.splitTerms(text).map(fold).filter((word) => word.length > 0);
    return Array.from(new Set(words));
  }

  function lower(value) {
    return String(value == null ? '' : value).toLowerCase();
  }

  // Is a folded word in this lowercase text? Folding every name on every keystroke was most of
  // the cost of a search over a big library (measured: 10 000 names, 11 ms against 2 ms for the
  // old name-only search), and it is only needed for a phrase. A word without a space has no `_`
  // and no space for folding to change, and neither do the places it occurs, so the plain
  // lowercase text answers for it exactly. A phrase is folded against only where every part of
  // it is present at all.
  function found(word, text) {
    const space = word.indexOf(' ');
    if (space < 0) return text.includes(word);
    if (!text.includes(word.slice(0, space))) return false;   // cheap refusal for most texts
    return word.split(' ').every((part) => text.includes(part)) && fold(text).includes(word);
  }

  // Does a photo with this file name and these tags answer the words? Every word must be
  // found somewhere; with no words, everything answers. Tags are looked at only when the name
  // did not answer. Plain loops: this runs for every photo on every keystroke.
  function matches(words, name, tags) {
    if (!Array.isArray(words) || !words.length) return true;
    const inName = lower(name);
    const hasTags = Array.isArray(tags) && tags.length > 0;
    let inTags = null;
    for (const word of words) {
      if (found(word, inName)) continue;
      if (!hasTags) return false;
      if (inTags === null) inTags = tags.map(lower);
      let inSomeTag = false;
      for (const tag of inTags) {
        if (found(word, tag)) { inSomeTag = true; break; }
      }
      if (!inSomeTag) return false;
    }
    return true;
  }

  // Exact chosen tags are a second predicate, distinct from the text's partial matches.
  function matchesTags(selected, tags) {
    return !selected.length || (Array.isArray(tags) && selected.every((tag) => tags.includes(tag)));
  }

  function changeTags(selected, tag, action = 'single') {
    if (!tag) return action === 'single' ? [] : selected.slice();
    if (action === 'remove' || (action === 'toggle' && selected.includes(tag))) {
      return selected.filter((value) => value !== tag);
    }
    if (action === 'single') return [tag];
    return selected.includes(tag) ? selected.slice() : selected.concat(tag);
  }

  // JSON keeps commas/other punctuation in tag names distinct; order does not identify a view.
  function tagKey(selected) {
    return JSON.stringify(selected.slice().sort());
  }

  function availableTags(items) {
    const tags = new Set();
    for (const item of items) {
      if (item && Array.isArray(item.tags)) item.tags.forEach((tag) => tags.add(tag));
    }
    return tags;
  }

  // Unlike site autocomplete, local tags can contain Cyrillic and spaces. Reuse the
  // search's comma/space rule without the sites' spelling/security normalization.
  function currentToken(text, caret = String(text || '').length) {
    const value = String(text || '');
    const pos = Math.max(0, Math.min(value.length, Number(caret) || 0));
    const separator = value.includes(',') ? /,/ : /\s/;
    let start = pos, end = pos;
    while (start > 0 && !separator.test(value[start - 1])) start--;
    while (end < value.length && !separator.test(value[end])) end++;
    return { start, end, raw: value.slice(start, end).trim() };
  }

  function consumeToken(text, caret) {
    const value = String(text || '');
    const range = currentToken(value, caret);
    let before = value.slice(0, range.start), after = value.slice(range.end);
    // Remove one separator with the consumed token, keeping the other words/phrases intact.
    if (after) {
      after = after.replace(/^[\s,]+/, '');
      if (before.endsWith(',') && after) after = ' ' + after;
    }
    else before = before.replace(/[\s,]+$/, '');
    let remaining = before + after;
    // A surviving spaced phrase must keep the comma grammar even when its neighbour
    // was the only other term. Otherwise choosing a tag would silently split it.
    if (value.includes(',') && !remaining.includes(',') && /\s/.test(remaining.trim())) remaining += ',';
    return { value: remaining, caret: before.length };
  }

  function suggestTags(tags, text, caret, limit = 10) {
    const prefix = fold(currentToken(text, caret).raw);
    return prefix ? tags.filter((tag) => fold(tag).includes(prefix)).slice(0, limit) : [];
  }

  // Counts describe adding a candidate to the chosen tags and the OTHER query words.
  // The unfinished token is being replaced: applying it too would hide valid candidates.
  // The caller passes the current view's real entries, including unpooled folder photos.
  function tagCandidates(items, selected, text, caret, limit = 8) {
    const prefix = fold(currentToken(text, caret).raw);
    const words = parse(consumeToken(text, caret).value);
    const uses = new Map(), counts = new Map();
    for (const item of items) {
      const tags = new Set(Array.isArray(item.tags) ? item.tags : []);
      const eligible = matchesTags(selected, Array.from(tags)) && matches(words, item.name, Array.from(tags));
      for (const tag of tags) {
        if (selected.includes(tag) || (prefix && !fold(tag).includes(prefix))) continue;
        uses.set(tag, (uses.get(tag) || 0) + 1);
        if (eligible) counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return Array.from(uses, ([tag, use]) => ({ tag, use, count: counts.get(tag) || 0 }))
      .sort((a, b) => b.count - a.count || b.use - a.use || a.tag.localeCompare(b.tag))
      .slice(0, limit).map(({ tag, count }) => ({ tag, count }));
  }

  return { fold, parse, matches, matchesTags, changeTags, tagKey, availableTags, currentToken, consumeToken, suggestTags, tagCandidates };
}));
