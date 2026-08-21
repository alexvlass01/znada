'use strict';

const GELBOORU_TAG_API = 'https://gelbooru.com/index.php';
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

function buildGelbooruTagSuggestUrl(opts = {}) {
  const prefix = normalizeTagPrefix(opts.q);
  const p = new URLSearchParams({
    page: 'autocomplete2',
    term: prefix,
    type: 'tag',
    limit: String(clampLimit(opts.limit)),
  });
  return `${GELBOORU_TAG_API}?${p.toString()}`;
}

function tagEntriesFromResponse(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.tag)) return json.tag;
  if (json && json.tag && typeof json.tag === 'object') return [json.tag];
  if (json && Array.isArray(json.tags)) return json.tags;
  return [];
}

function tagCategory(type) {
  const raw = String(type || '').toLowerCase();
  if (raw === 'tag' || raw === 'general') return 'general';
  if (raw === 'artist') return 'artist';
  if (raw === 'copyright') return 'copyright';
  if (raw === 'character') return 'character';
  if (raw === 'metadata' || raw === 'meta') return 'metadata';
  const n = Number(type);
  if (n === 1) return 'artist';
  if (n === 3) return 'copyright';
  if (n === 4) return 'character';
  if (n === 5) return 'metadata';
  return 'general';
}

function normalizeSuggestion(entry) {
  const rawName = String(entry && (entry.name || entry.tag || entry.value) || '').trim();
  if (!rawName || /\s/.test(rawName)) return null;
  const name = normalizeTagPrefix(rawName);
  if (!name) return null;
  const count = Math.max(0, Math.floor(Number(entry.count ?? entry.post_count ?? entry.posts) || 0));
  return { name, count, category: tagCategory(entry.category ?? entry.type) };
}

function parseGelbooruTagSuggestions(json, opts = {}) {
  const prefix = normalizeTagPrefix(opts.prefix || opts.q);
  const limit = clampLimit(opts.limit);
  const seen = new Set();
  const items = [];
  for (const entry of tagEntriesFromResponse(json)) {
    const item = normalizeSuggestion(entry);
    if (!item || seen.has(item.name)) continue;
    if (prefix && !item.name.startsWith(prefix)) continue;
    seen.add(item.name);
    items.push(item);
  }
  items.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  return items.slice(0, limit);
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
  GELBOORU_TAG_API,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MIN_PREFIX_LEN,
  normalizeTagPrefix,
  clampLimit,
  buildGelbooruTagSuggestUrl,
  tagEntriesFromResponse,
  tagCategory,
  normalizeSuggestion,
  parseGelbooruTagSuggestions,
  currentTokenRange,
  replaceCurrentToken,
};
