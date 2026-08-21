'use strict';

// Pure Gelbooru adapter. Network requests and credentials stay in main.js;
// this module only builds API URLs and maps posts to Znada's online-card shape.

const API_BASE = 'https://gelbooru.com/index.php';
const POST_BASE = 'https://gelbooru.com/index.php?page=post&s=view&id=';
const SUPPORTED_EXTS = new Set(['jpg', 'jpeg', 'png']);
const RATINGS = ['general', 'sensitive', 'questionable', 'explicit'];

function queryTags(query, max = 2) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  const parts = raw.includes(',') ? raw.split(',') : raw.split(/\s+/);
  return parts
    .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter((tag) => tag && !tag.includes(':'))
    .slice(0, max);
}

function selectedRatings({ sfw = true, sketchy = true, nsfw = false } = {}) {
  const selected = [];
  if (sfw) selected.push('general');
  if (sketchy) selected.push('sensitive', 'questionable');
  if (nsfw) selected.push('explicit');
  return selected.length ? selected : ['general'];
}

// Gelbooru supports negative rating metatags, which lets us express every
// combination of Znada's three groups without fetching and filtering locally.
function ratingTags(purity) {
  const selected = selectedRatings(purity);
  if (selected.length === RATINGS.length) return [];
  if (selected.length === 1) return [`rating:${selected[0]}`];
  return RATINGS.filter((rating) => !selected.includes(rating)).map((rating) => `-rating:${rating}`);
}

function orderTag(sort) {
  if (sort === 'toplist' || sort === 'views') return 'sort:score:desc';
  if (sort === 'random') return 'sort:random';
  return '';
}

function buildSearchTags(opts = {}) {
  return [
    ...queryTags(opts.q),
    ...ratingTags(opts.purity),
    orderTag(opts.sorting),
  ].filter(Boolean).join(' ');
}

function buildSearchUrl(opts = {}) {
  const page = Number(opts.page) > 0 ? Math.floor(Number(opts.page)) : 1;
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 100));
  const p = new URLSearchParams({
    page: 'dapi',
    s: 'post',
    q: 'index',
    json: '1',
    limit: String(limit),
    pid: String(page - 1),
    tags: buildSearchTags(opts),
  });
  if (opts.apiKey) p.set('api_key', String(opts.apiKey));
  if (opts.userId) p.set('user_id', String(opts.userId));
  return `${API_BASE}?${p.toString()}`;
}

function fileExtension(post) {
  const candidates = [post && post.image, post && post.file_url];
  for (const value of candidates) {
    const match = String(value || '').match(/\.([a-z0-9]+)(?:$|[?#])/i);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

function compactTags(post, max = 24) {
  const values = [];
  const seen = new Set();
  for (const raw of String(post && post.tags || '').split(/\s+/)) {
    const tag = raw.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    values.push(tag);
    if (values.length >= max) break;
  }
  return values;
}

function purityName(rating) {
  const value = String(rating || '').toLowerCase();
  if (value === 'explicit') return 'nsfw';
  if (value === 'sensitive' || value === 'questionable') return 'sketchy';
  return 'sfw';
}

function mapItem(post) {
  if (!post || post.id == null) return null;
  const ext = fileExtension(post);
  if (!SUPPORTED_EXTS.has(ext)) return null;
  const full = String(post.file_url || '');
  if (!full) return null;
  const width = Number(post.width) || 0;
  const height = Number(post.height) || 0;
  // Gelbooru generates a downscaled "sample" only when post.sample is set; use it
  // as the viewer's intermediate tier (preview -> sample -> full).
  const hasSample = post.sample === 1 || post.sample === '1' || post.sample === true;
  const sample = hasSample && post.sample_url ? String(post.sample_url) : '';
  return {
    id: `gelbooru:${post.id}`,
    provider: 'gelbooru',
    page: `${POST_BASE}${post.id}`,
    full,
    sample,
    thumb: post.preview_url || post.sample_url || full,
    resolution: width > 0 && height > 0 ? `${width}x${height}` : '',
    width,
    height,
    fileType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    purity: purityName(post.rating),
    category: 'anime',
    source: post.source || '',
    artist: '',
    tags: compactTags(post),
    md5: post.md5 || '',
  };
}

function postsFromResponse(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.post)) return json.post;
  if (json && json.post && typeof json.post === 'object') return [json.post];
  return [];
}

function responseError(json) {
  if (!json || typeof json !== 'object') return '';
  if (json.success === false || json.success === 'false') return String(json.message || 'search');
  return '';
}

function parseSearch(json, opts = {}) {
  const data = postsFromResponse(json);
  const items = data.map(mapItem).filter(Boolean);
  const page = Number(opts.page) > 0 ? Math.floor(Number(opts.page)) : 1;
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 100));
  const attrs = json && json['@attributes'] || {};
  const total = Number(attrs.count);
  const offset = Number(attrs.offset);
  const hasTotal = Number.isFinite(total) && total >= 0;
  const hasOffset = Number.isFinite(offset) && offset >= 0;
  const hasMore = hasTotal && hasOffset ? offset + data.length < total : data.length >= limit;
  return {
    items,
    meta: {
      currentPage: page,
      lastPage: hasMore ? page + 1 : page,
      perPage: limit,
      total: hasTotal ? total : null,
      hasMore,
    },
  };
}

// --- Tag types (artist extraction) --------------------------------------
// A Gelbooru post's `tags` string carries names only, without type. The tag
// endpoint (`s=tag&q=index&json=1&names=...`) returns a `type` per name, where
// 1 = artist (0=general, 3=copyright, 4=character, 5=metadata). We look these up
// at download time to fill an item's author, which the base post response omits.
const TAG_TYPE_ARTIST = 1;
const TAG_TYPE_BY_NAME = { general: 0, artist: 1, copyright: 3, character: 4, metadata: 5, meta: 5 };

function buildTagTypesUrl(names, { apiKey, userId } = {}) {
  const list = Array.isArray(names) ? names : String(names || '').split(/\s+/);
  const clean = [];
  const seen = new Set();
  for (const raw of list) {
    const tag = String(raw || '').trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    clean.push(tag);
  }
  if (!clean.length) return '';
  const p = new URLSearchParams({
    page: 'dapi',
    s: 'tag',
    q: 'index',
    json: '1',
    names: clean.join(' '),
  });
  if (apiKey) p.set('api_key', String(apiKey));
  if (userId) p.set('user_id', String(userId));
  return `${API_BASE}?${p.toString()}`;
}

function tagsFromResponse(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.tag)) return json.tag;
  if (json && json.tag && typeof json.tag === 'object') return [json.tag];
  return [];
}

// Gelbooru returns `type` as an integer, but tolerate string labels too.
function normalizeTagType(type) {
  if (typeof type === 'number') return Number.isFinite(type) ? type : NaN;
  const s = String(type == null ? '' : type).trim().toLowerCase();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  return Object.prototype.hasOwnProperty.call(TAG_TYPE_BY_NAME, s) ? TAG_TYPE_BY_NAME[s] : NaN;
}

function parseTagTypes(json) {
  const map = new Map();
  for (const entry of tagsFromResponse(json)) {
    if (!entry || entry.name == null) continue;
    const name = String(entry.name).trim().toLowerCase();
    if (!name) continue;
    const type = normalizeTagType(entry.type);
    if (Number.isFinite(type)) map.set(name, type);
  }
  return map;
}

function displayArtistName(name) {
  return String(name || '').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

// tags: post tag names (array or space-separated string); typeMap: Map|object name->type.
function artistNamesFromTypes(tags, typeMap) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/\s+/);
  const map = typeMap instanceof Map ? typeMap : new Map(Object.entries(typeMap || {}));
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (map.get(key) !== TAG_TYPE_ARTIST) continue;
    const name = displayArtistName(key);
    if (name) out.push(name);
  }
  return out;
}

function artistLabel(names, max = 3) {
  const list = (Array.isArray(names) ? names : [names]).filter(Boolean);
  const cap = Number(max) > 0 ? Math.floor(Number(max)) : list.length;
  return list.slice(0, cap).join(', ');
}

// Artist tags in their ORIGINAL underscore form, for storing alongside the post's
// other tags. artistNamesFromTypes returns display names ("tenchi mayo"); the local
// library keeps booru tags as they come ("tenchi_mayo"), so both shapes are needed.
function artistTagsFromTypes(tags, typeMap) {
  const list = Array.isArray(tags) ? tags : String(tags || '').split(/\s+/);
  const map = typeMap instanceof Map ? typeMap : new Map(Object.entries(typeMap || {}));
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (map.get(key) === TAG_TYPE_ARTIST) out.push(key);
  }
  return out;
}

// Every tag of a post, deduplicated and untruncated — unlike compactTags, which caps
// the list for the search payload.
function allTags(post) {
  const out = [];
  const seen = new Set();
  for (const raw of String(post && post.tags || '').split(/\s+/)) {
    const tag = raw.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

// Single post by id. Needed because the search response is trimmed to `compactTags`
// (24) and Gelbooru orders tags alphabetically, so an artist whose name sorts late is
// already gone by the time the user downloads. Accepts "gelbooru:123" or "123".
function buildPostUrl(id, { apiKey, userId } = {}) {
  const postId = String(id == null ? '' : id).replace(/^gelbooru:/, '').trim();
  if (!/^\d+$/.test(postId)) return '';
  const p = new URLSearchParams({
    page: 'dapi',
    s: 'post',
    q: 'index',
    json: '1',
    id: postId,
  });
  if (apiKey) p.set('api_key', String(apiKey));
  if (userId) p.set('user_id', String(userId));
  return `${API_BASE}?${p.toString()}`;
}

module.exports = {
  API_BASE,
  POST_BASE,
  queryTags,
  selectedRatings,
  ratingTags,
  orderTag,
  buildSearchTags,
  buildSearchUrl,
  fileExtension,
  compactTags,
  purityName,
  mapItem,
  postsFromResponse,
  responseError,
  parseSearch,
  buildTagTypesUrl,
  tagsFromResponse,
  parseTagTypes,
  artistNamesFromTypes,
  artistTagsFromTypes,
  artistLabel,
  allTags,
  buildPostUrl,
};
