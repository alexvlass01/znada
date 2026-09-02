'use strict';

// The online SEARCH BOX: how a typed tag is spelled, and how the token under the caret
// is found and replaced.
//
// ONL-014: this file used to also contain one named site's autocomplete endpoint and its
// answer parser — the last path in the app that reached a single site with no alternative,
// so while that site was unreachable the dropdown silently offered nothing at all. Those
// two now live in the site's own file, behind a declared `tagSuggest` capability. What is
// left here is about the user's text box and belongs to no site.

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const MIN_PREFIX_LEN = 3;

function normalizeTagPrefix(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/^[-~]+/, '')
    .replace(/[^a-z0-9_()]+/g, '');
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

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MIN_PREFIX_LEN,
  normalizeTagPrefix,
  clampLimit,
  currentTokenRange,
  replaceCurrentToken,
};
