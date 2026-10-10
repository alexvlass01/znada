'use strict';

// The SEARCH BOX: how the typed text becomes words, how a typed tag is spelled, and how the
// token under the caret is found and replaced.
//
// LIB-014: the word rule (`splitTerms`) is shared by the Library search box and the sites,
// so the same text means the same words on both tabs. What a word then matches is the
// caller's business: a site sends it as a tag, the Library looks for it in names and tags.
//
// ONL-014: this file used to also contain one named site's autocomplete endpoint and its
// answer parser — the last path in the app that reached a single site with no alternative,
// so while that site was unreachable the dropdown silently offered nothing at all. Those
// two now live in the site's own file, behind a declared `tagSuggest` capability. What is
// left here is about the user's text box and belongs to no site.

(function initTagSuggest(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TagSuggest = api;
}(typeof window !== 'undefined' ? window : globalThis, function tagSuggestFactory() {
  const DEFAULT_LIMIT = 10;
  const MAX_LIMIT = 20;
  const MIN_PREFIX_LEN = 3;

  // A colon in a parenthesized qualifier is part of a name (e.g. beatrice_(re:zero)),
  // not a search command. Outside a qualifier the existing metatag restriction stays.
  // An unfinished qualifier is allowed too, because autocomplete runs while typing it.
  function hasMetatag(value) {
    const tag = String(value || '');
    // Only name_(qualifier), not arbitrary parentheses/grouping around an operator.
    return tag.includes(':') && !/^[~-]?[a-z0-9_]+_\([^()\s]*\)?$/i.test(tag);
  }

  function normalizeTagPrefix(value) {
    const tag = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/^[-~]+/, '')
      .replace(/[^a-z0-9_():]+/g, '');
    return hasMetatag(tag) ? tag.replace(/:/g, '') : tag;
  }

  // With a comma anywhere, commas separate and a space stays inside a word ("blue sky, sea"
  // is two words, the first with a space in it); otherwise every space separates. Words come
  // back trimmed and lowercase, empty ones dropped. Search commands are NOT removed here —
  // refusing them is a site's rule (they could walk around the content setting there); the
  // Library has nothing to protect, and a name like `beatrice_(re:zero)` must stay findable.
  function splitTerms(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return [];
    const parts = raw.includes(',') ? raw.split(',') : raw.split(/\s+/);
    return parts.map((part) => part.trim().toLowerCase()).filter(Boolean);
  }

  // LIB-014 stage 3. The same words as a site is sent them: split by the rule above, a space
  // inside a phrase written as `_` (how the boards spell a tag), and search commands refused,
  // because one typed into the box could walk around the user's content setting. Nothing is
  // cut here: a site that cannot take this many words is not asked at all
  // (src/online-tag-limit.js). Every site gets its tags from this one function.
  function siteTags(value) {
    return splitTerms(value)
      .map((term) => term.replace(/\s+/g, '_'))
      .filter((tag) => tag && !hasMetatag(tag));
  }

  function clampLimit(value) {
    const n = Math.floor(Number(value) || DEFAULT_LIMIT);
    return Math.max(1, Math.min(MAX_LIMIT, n));
  }

  function currentTokenRange(query, caret = String(query || '').length) {
    const value = String(query || '');
    const pos = Math.max(0, Math.min(value.length, Number(caret) || 0));
    let start = pos;
    while (start > 0 && !/[\s,]/.test(value[start - 1])) start -= 1;
    let end = pos;
    while (end < value.length && !/[\s,]/.test(value[end])) end += 1;
    const raw = value.slice(start, end);
    const negative = raw.startsWith('-') || raw.startsWith('~');
    const prefix = normalizeTagPrefix(raw);
    return { start, end, raw, prefix, negative };
  }

  function replaceCurrentToken(query, caret, tag) {
    const value = String(query || '');
    const replacement = normalizeTagPrefix(tag);
    const range = currentTokenRange(value, caret);
    if (!replacement) return { value, caret: Math.max(0, Math.min(value.length, Number(caret) || 0)) };
    const marker = range.negative ? '-' : '';
    const before = value.slice(0, range.start);
    let after = value.slice(range.end);
    let inserted = `${marker}${replacement}`;
    if (!after) {
      inserted += ' ';
    } else if (!/^[\s,]/.test(after)) {
      after = ` ${after}`;
    }
    const next = `${before}${inserted}${after}`;
    return { value: next, caret: (before + inserted).length };
  }

  return {
    DEFAULT_LIMIT,
    MAX_LIMIT,
    MIN_PREFIX_LEN,
    hasMetatag,
    normalizeTagPrefix,
    splitTerms,
    siteTags,
    clampLimit,
    currentTokenRange,
    replaceCurrentToken,
  };
}));
