'use strict';

// Pure Danbooru adapter. Network requests stay in main.js; this module only
// builds public API URLs and maps posts to Znada's shared online-card shape.

const API_BASE = 'https://danbooru.donmai.us/posts.json';
const POST_BASE = 'https://danbooru.donmai.us/posts';
const SUPPORTED_EXTS = new Set(['jpg', 'jpeg', 'png']);

function queryTags(query, max = 2) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  const parts = raw.includes(',') ? raw.split(',') : raw.split(/\s+/);
  return parts
    .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter((tag) => tag && !tag.includes(':'))
    .slice(0, max);
}

function ratingTag({ sfw = true, sketchy = true, nsfw = false } = {}) {
  const ratings = [];
  if (sfw) ratings.push('g');
  if (sketchy) ratings.push('s', 'q');
  if (nsfw) ratings.push('e');
  return `rating:${ratings.length ? ratings.join(',') : 'g'}`;
}

function orderTag(sort) {
  if (sort === 'toplist') return 'order:rank';
  if (sort === 'random') return 'order:random';
  if (sort === 'views') return 'order:favcount';
  return '';
}

function buildSearchTags(opts = {}) {
  return [
    ...queryTags(opts.q),
    ratingTag(opts.purity),
    'filetype:jpg,png',
    'mpixels:1..',
    orderTag(opts.sorting),
  ].filter(Boolean).join(' ');
}

function buildSearchUrl(opts = {}) {
  const page = Number(opts.page) > 0 ? Math.floor(Number(opts.page)) : 1;
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 24));
  const p = new URLSearchParams({
    tags: buildSearchTags(opts),
    page: String(page),
    limit: String(limit),
  });
  return `${API_BASE}?${p.toString()}`;
}

function compactTags(post, max = 24) {
  const values = [];
  const seen = new Set();
  for (const field of ['tag_string_character', 'tag_string_copyright', 'tag_string_artist', 'tag_string_general']) {
    for (const tag of String(post && post[field] || '').split(/\s+/)) {
      const value = tag.trim().toLowerCase();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      values.push(value);
      if (values.length >= max) return values;
    }
  }
  return values;
}

function purityName(rating) {
  if (rating === 'e') return 'nsfw';
  if (rating === 's' || rating === 'q') return 'sketchy';
  return 'sfw';
}

function mapItem(post) {
  if (!post || post.id == null) return null;
  const ext = String(post.file_ext || '').toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) return null;
  const full = post.file_url || post.large_file_url || '';
  if (!full) return null;
  const width = Number(post.image_width) || 0;
  const height = Number(post.image_height) || 0;
  const artist = String(post.tag_string_artist || '').split(/\s+/).find(Boolean) || '';
  // Danbooru's large_file_url is the downscaled "sample"; use it as the viewer's
  // intermediate tier when it actually differs from the original.
  const sample = post.large_file_url && post.large_file_url !== full ? String(post.large_file_url) : '';
  return {
    id: `danbooru:${post.id}`,
    provider: 'danbooru',
    page: `${POST_BASE}/${post.id}`,
    full,
    sample,
    thumb: post.preview_file_url || post.large_file_url || full,
    resolution: width > 0 && height > 0 ? `${width}x${height}` : '',
    width,
    height,
    fileType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    purity: purityName(post.rating),
    category: 'anime',
    source: post.source || '',
    artist,
    tags: compactTags(post),
    md5: post.md5 || '',
  };
}

function parseSearch(json, opts = {}) {
  const data = Array.isArray(json) ? json : [];
  const items = data.map(mapItem).filter(Boolean);
  const page = Number(opts.page) > 0 ? Math.floor(Number(opts.page)) : 1;
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 24));
  const hasMore = data.length >= limit;
  return {
    items,
    meta: {
      currentPage: page,
      lastPage: hasMore ? page + 1 : page,
      perPage: limit,
      total: null,
      hasMore,
    },
  };
}

module.exports = {
  API_BASE,
  POST_BASE,
  queryTags,
  ratingTag,
  orderTag,
  buildSearchTags,
  buildSearchUrl,
  compactTags,
  purityName,
  mapItem,
  parseSearch,
};
