'use strict';

// Pure Danbooru adapter. Network requests stay in main.js; this module only
// builds public API URLs and maps posts to Znada's shared online-card shape.

const media = require('./media-type');
// The SEARCH BOX module, not another site — see the note in src/gelbooru.js.
const searchBox = require('./tag-suggest');

const API_BASE = 'https://danbooru.donmai.us/posts.json';
const POST_BASE = 'https://danbooru.donmai.us/posts';
// The most this API will send in one page.
const MAX_PAGE_SIZE = 100;

// This site can be told not to send what Znada cannot use, which saves the slots that
// would otherwise come back as video and be dropped on arrival.
//
// ONL-012: WHICH formats is not decided here — the handler passes its one list in, the
// same list it filters the answer with. This file only knows how to SAY it: the site
// spells a JPEG `jpg` and would not recognise `jpeg`.
const FILE_EXT_ALIASES = Object.freeze({ jpeg: 'jpg' });

function fileTypeTag(formats) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(formats) ? formats : []) {
    const ext = String(raw || '').trim().toLowerCase();
    const name = FILE_EXT_ALIASES[ext] || ext;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out.length ? `filetype:${out.join(',')}` : '';
}

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

// ONL-005 task 3. `order:rank` is a trending window of the last few days: the right front
// page, and nothing at all for a rarer typed tag (live 2026-09-15: sameko_saba gave 0 posts
// with order:rank, 20 with order:score). A search's Top is the tag's all-time best — the
// meaning Top already has on Gelbooru.
function orderTag(sort, { hasQuery = false } = {}) {
  if (sort === 'toplist') return hasQuery ? 'order:score' : 'order:rank';
  if (sort === 'random') return 'order:random';
  if (sort === 'views') return 'order:favcount';
  return '';
}

// ONL-010. The loosest size bound that still covers every target, spelled the way this
// site spells it. Only a narrowing: the exact judgement is made against the card.
function sizeTags(hints) {
  if (!hints || typeof hints !== 'object') return [];
  const out = [];
  const width = Number(hints.minWidth);
  const height = Number(hints.minHeight);
  const ratio = Number(hints.minRatio);
  if (Number.isFinite(width) && width > 0) out.push(`width:>=${Math.floor(width)}`);
  if (Number.isFinite(height) && height > 0) out.push(`height:>=${Math.floor(height)}`);
  // A shape bound only when EVERY target names one — otherwise it would cut away the
  // pictures a target without a shape was meant to allow.
  if (hints.everyTargetHasRatio && Number.isFinite(ratio) && ratio > 0) {
    out.push(`ratio:>=${(ratio * 0.98).toFixed(3)}`);
  }
  return out;
}

function buildSearchTags(opts = {}) {
  const typed = queryTags(opts.q);
  return [
    ...typed,
    ratingTag(opts.purity),
    fileTypeTag(opts.formats),
    ...sizeTags(opts.sizeHints),
    'mpixels:1..',
    orderTag(opts.sorting, { hasQuery: typed.length > 0 }),
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

function formatFromUrl(value) {
  try {
    const match = new URL(String(value)).pathname.match(/\.([a-z0-9]+)$/i);
    return match ? media.normalizeFormat(match[1]) : '';
  } catch {
    return '';
  }
}

function mapItem(post) {
  if (!post || post.id == null) return null;
  // ONL-012: reported, not judged — see the note in src/gelbooru.js.
  const full = post.file_url || post.large_file_url || '';
  if (!full) return null;
  // When the original is hidden, Danbooru may fall back to a JPEG large_file_url even
  // though file_ext still describes the unavailable original. The shared card must
  // describe the bytes it will actually download, or the strict boundary correctly
  // rejects a useful fallback as contradictory input.
  const format = formatFromUrl(full) || media.normalizeFormat(post.file_ext);
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
    // ONL-016. This site reports the size in bytes; Gelbooru does not report it at all.
    fileSize: Number(post.file_size) || 0,
    fileType: `image/${format === 'jpg' ? 'jpeg' : format}`,
    format,
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

// META-001: find the post that IS this exact file.
//
// Deliberately NOT built on `buildSearchUrl`: that one appends `filetype:`, `mpixels:`
// and a rating term, and an anonymous Danbooru search accepts only two tags. A hash
// search must also ignore the rating filter — the question is "is this my file", not
// "is this my file and is it safe".
function buildMd5Url(md5) {
  const hash = String(md5 == null ? '' : md5).trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hash)) return '';
  const p = new URLSearchParams({ tags: `md5:${hash}`, limit: '1' });
  return `${API_BASE}?${p.toString()}`;
}

// Danbooru's one-letter rating, spelled out the way Gelbooru spells it, so a stored
// result means the same thing whichever catalogue answered.
const RATING_NAMES = Object.freeze({ g: 'general', s: 'sensitive', q: 'questionable', e: 'explicit' });

// Unlike Gelbooru, Danbooru hands back tags ALREADY GROUPED by kind, so the types cost
// no extra request. `tag_string` is used only as a backstop for anything the grouped
// fields somehow omit.
const TAG_FIELDS = Object.freeze([
  ['tag_string_artist', 'artist'],
  ['tag_string_character', 'character'],
  ['tag_string_copyright', 'copyright'],
  ['tag_string_general', 'general'],
  ['tag_string_meta', 'meta'],
]);

function postSummary(post) {
  if (!post || post.id == null) return null;
  const postId = String(post.id).trim();
  if (!/^\d+$/.test(postId)) return null;
  const tags = [];
  const seen = new Set();
  const push = (raw, type) => {
    const name = String(raw || '').trim().toLowerCase();
    if (!name || seen.has(name)) return;
    seen.add(name);
    tags.push(type ? { name, type } : { name });
  };
  for (const [field, type] of TAG_FIELDS) {
    for (const raw of String(post[field] || '').split(/\s+/)) push(raw, type);
  }
  for (const raw of String(post.tag_string || '').split(/\s+/)) push(raw, '');
  const artist = String(post.tag_string_artist || '').split(/\s+/).filter(Boolean)
    .map((name) => name.replace(/_/g, ' '))
    .slice(0, 3)
    .join(', ');
  return {
    postId,
    page: `${POST_BASE}/${postId}`,
    md5: String(post.md5 || '').trim().toLowerCase(),
    rating: RATING_NAMES[String(post.rating || '').trim().toLowerCase()] || '',
    author: artist,
    tags,
  };
}

// ONL-011. What this site IS, as data — see the note in src/wallhaven.js.
const PROVIDER = Object.freeze({
  id: 'danbooru',
  name: 'Danbooru',
  status: 'active',
  hosts: Object.freeze({
    page: Object.freeze(['danbooru.donmai.us']),
    image: Object.freeze(['cdn.donmai.us']),
    imageProxyOnly: Object.freeze([]),
    thumb: Object.freeze(['cdn.donmai.us']),
  }),
  // ONL-012. Second in the 'anime' group: asked when the first cannot answer.
  group: 'anime',
  credentials: Object.freeze({ kind: 'none', required: false }),
  // Read by the shared handler — see the note in src/wallhaven.js about what does and
  // does not belong here.
  capabilities: Object.freeze({
    browse: true,
    textSearch: true,
    explicit: 'always',
    // On the front page `order:rank` is a trending window rather than an all-time list, so
    // the random slice meant for an all-time top does not apply. A typed search asks for
    // `order:score` instead — see orderTag.
    topIsAllTime: false,
    // ONL-013. By which fingerprints this site can be asked "which post IS this exact
    // file" — see the note in src/gelbooru.js.
    fingerprints: Object.freeze(['md5']),
    // ONL-014. Second site that can answer the search box, so suggestions survive the
    // first one being unreachable — which, until now, silently emptied the dropdown.
    tagSuggest: true,
    // ONL-015. Cards from here carry their format — see the note in src/wallhaven.js.
    cardFormat: true,
    // ONL-010. Measured on the live API 2026-09-03: `width:>=`, `height:>=` and
    // `ratio:>=` all work, and three terms at once are accepted. One bound at a time, so
    // no list.
    sizeFilter: Object.freeze({
      resolution: true, ratio: true, ratioList: false,
      // Stated for completeness; unused while `ratio` is true, because a page from here
      // already comes back narrowed by shape.
      maxPageSize: 200,
    }),
  }),
  requestHeaders: Object.freeze({}),
  loadsDirectly: false,
});

// ONL-012. See the note in src/wallhaven.js. This site has no `enrich`: its search
// response already carries grouped tags and the artist.
async function search(params, ctx) {
  const o = params || {};
  const page = Number(o.page) > 0 ? Number(o.page) : 1;
  const limit = Number(o.limit) > 0 ? Number(o.limit) : MAX_PAGE_SIZE;
  const url = buildSearchUrl({
    q: o.q || '',
    purity: o.purity,
    sorting: o.sort || o.sorting || 'date_added',
    page,
    limit,
    formats: o.formats,
    sizeHints: o.sizeHints,
  });
  const res = await ctx.fetchJson(url, { timeoutMs: 15000 });
  if (res.error) return { error: res.error };
  return parseSearch(res.json, { page, limit });
}

// ONL-013 (META-001). Which post IS this exact file. See the note in src/gelbooru.js for
// why the fingerprint is not verified here, and why a refusal by our own limiter is
// indistinguishable from any other failure at this level.
//
// No second request for tag kinds: this site groups its tags by kind already, so
// `postSummary` has everything the moment the post arrives.
async function findByFingerprint(kind, value, ctx) {
  if (kind !== 'md5') return { error: 'unsupported' };
  const url = buildMd5Url(value);
  if (!url) return { error: 'badFingerprint' };
  const res = await ctx.fetchJson(url, { timeoutMs: 10000 });
  if (res.error) return { error: res.error };
  const post = Array.isArray(res.json) ? res.json[0] : null;
  if (!post) return { result: null };
  return { result: postSummary(post) };
}

// --- Tag suggestions (ONL-014) -------------------------------------------
// The second site that can answer the search box. Needs no key.
//
// Worth knowing about this one: it resolves ALIASES, so typing `land` can suggest
// `houseki_no_kuni` (verified live 2026-08-26). Those do not start with what was typed,
// so — unlike the prefix-matching site — nothing here filters by prefix. Throwing them
// away would discard the single thing this site does better.
const TAG_SUGGEST_API = 'https://danbooru.donmai.us/autocomplete.json';

// The booru category numbers, spelled the way the rest of Znada spells tag kinds.
const CATEGORY_NAMES = Object.freeze({ 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' });

function buildTagSuggestUrl({ q, limit } = {}) {
  const p = new URLSearchParams({
    'search[query]': searchBox.normalizeTagPrefix(q),
    'search[type]': 'tag_query',
    limit: String(searchBox.clampLimit(limit)),
  });
  return `${TAG_SUGGEST_API}?${p.toString()}`;
}

function parseTagSuggestions(json) {
  const out = [];
  for (const entry of Array.isArray(json) ? json : []) {
    const raw = String((entry && (entry.value || entry.name)) || '').trim();
    if (!raw || /\s/.test(raw)) continue;
    const name = searchBox.normalizeTagPrefix(raw);
    if (!name) continue;
    out.push({
      name,
      count: Math.max(0, Math.floor(Number(entry.post_count) || 0)),
      category: CATEGORY_NAMES[Number(entry.category)] || 'general',
    });
  }
  return out;
}

async function suggestTags(params, ctx) {
  const o = params || {};
  const res = await ctx.fetchJson(buildTagSuggestUrl({ q: o.q, limit: o.limit }), { timeoutMs: 10000 });
  if (res.error) return { error: res.error };
  return { items: parseTagSuggestions(res.json) };
}

module.exports = {
  PROVIDER,
  search,
  findByFingerprint,
  suggestTags,
  TAG_SUGGEST_API,
  buildTagSuggestUrl,
  parseTagSuggestions,
  API_BASE,
  POST_BASE,
  RATING_NAMES,
  queryTags,
  ratingTag,
  orderTag,
  fileTypeTag,
  buildSearchTags,
  buildSearchUrl,
  compactTags,
  purityName,
  mapItem,
  parseSearch,
  buildMd5Url,
  postSummary,
};
