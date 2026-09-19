'use strict';

// Pure Gelbooru adapter. Network requests and credentials stay in main.js;
// this module only builds API URLs and maps posts to Znada's online-card shape.

const media = require('./media-type');
// The SEARCH BOX module, not another site: it owns how a typed tag is spelled
// (lowercase, underscores) and how the token under the caret is found and replaced.
const searchBox = require('./tag-suggest');

const API_BASE = 'https://gelbooru.com/index.php';
const POST_BASE = 'https://gelbooru.com/index.php?page=post&s=view&id=';
// The most this API will send in one page. A caller that asks for fewer gets fewer; the
// handler's own front-page size is its decision, not this file's.
const MAX_PAGE_SIZE = 100;
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

// ONL-010. This site understands `width:` and `height:` and has no `ratio:` at all —
// measured against the live API on 2026-09-03, where every spelling of a ratio metatag
// came back empty. So the shape is left to our own check and only the floor is asked for
// here. A narrowing, never the decision.
//
// Written here rather than passed through `q`: `queryTags` deliberately throws away
// anything containing a colon, so that a person typing "rating:explicit" into the search
// box cannot walk around their own content setting. That guard stays; this is the app
// speaking, not the user.
function sizeTags(hints) {
  if (!hints || typeof hints !== 'object') return [];
  const out = [];
  const width = Number(hints.minWidth);
  const height = Number(hints.minHeight);
  if (Number.isFinite(width) && width > 0) out.push(`width:>=${Math.floor(width)}`);
  if (Number.isFinite(height) && height > 0) out.push(`height:>=${Math.floor(height)}`);
  return out;
}

function buildSearchTags(opts = {}) {
  return [
    ...queryTags(opts.q),
    ...ratingTags(opts.purity),
    ...sizeTags(opts.sizeHints),
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
  // ONL-012: reported, not judged. Whether Znada can use this kind of file is the
  // handler's decision, in one place, for every site.
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
    // ONL-016. Deliberately 0, and deliberately present: checked against the live API on
    // 2026-09-03, a Gelbooru post carries no size field of any kind. Declaring the fact
    // is worth more than omitting it — the next person does not have to go and look.
    fileSize: 0,
    fileType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
    format: media.normalizeFormat(ext),
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

// META-001: find the post that IS this exact file.
//
// `md5:<hash>` is an ordinary Gelbooru search term, so this reuses the search endpoint
// rather than needing a new one. The hash is validated here and not merely interpolated:
// the value comes from a local file, but a malformed one would otherwise turn into a
// search for arbitrary text and quietly return somebody else's picture.
function buildMd5Url(md5, { apiKey, userId } = {}) {
  const hash = String(md5 == null ? '' : md5).trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hash)) return '';
  const p = new URLSearchParams({
    page: 'dapi',
    s: 'post',
    q: 'index',
    json: '1',
    limit: '1',
    tags: `md5:${hash}`,
  });
  if (apiKey) p.set('api_key', String(apiKey));
  if (userId) p.set('user_id', String(userId));
  return `${API_BASE}?${p.toString()}`;
}

const TAG_TYPE_NAME_BY_ID = Object.freeze(
  Object.entries(TAG_TYPE_BY_NAME).reduce((acc, [name, id]) => {
    // `meta` and `metadata` share an id; keep the shorter, canonical spelling.
    if (!acc[id] || name.length < acc[id].length) acc[id] = name;
    return acc;
  }, {}),
);

// Gelbooru speaks in type numbers; everything downstream of the adapters speaks in
// names, so the numeric encoding stops here and never reaches storage.
function tagTypeName(type) {
  const id = normalizeTagType(type);
  return Number.isFinite(id) && TAG_TYPE_NAME_BY_ID[id] ? TAG_TYPE_NAME_BY_ID[id] : '';
}

// A post reduced to the shape the metadata lookup stores. `typeMap` is optional: the
// post response carries no tag types at all, so they arrive from a second request that
// is allowed to fail — untyped tags are still the tags the user asked for.
function postSummary(post, typeMap) {
  if (!post || post.id == null) return null;
  const postId = String(post.id).trim();
  if (!/^\d+$/.test(postId)) return null;
  const map = typeMap instanceof Map ? typeMap : new Map(Object.entries(typeMap || {}));
  const names = allTags(post);
  const artists = artistNamesFromTypes(names, map);
  return {
    postId,
    page: `${POST_BASE}${postId}`,
    md5: String(post.md5 || '').trim().toLowerCase(),
    rating: String(post.rating || '').trim().toLowerCase(),
    author: artistLabel(artists),
    tags: names.map((name) => {
      const type = tagTypeName(map.get(name));
      return type ? { name, type } : { name };
    }),
  };
}

// ONL-011. What this site IS, as data — see the note in src/wallhaven.js.
const PROVIDER = Object.freeze({
  id: 'gelbooru',
  name: 'Gelbooru',
  status: 'active',
  hosts: Object.freeze({
    page: Object.freeze(['gelbooru.com', 'www.gelbooru.com']),
    image: Object.freeze([Object.freeze({ pattern: /^img\d*\.gelbooru\.com$/i })]),
    // The apex hotlink endpoint is reachable ONLY through the main process: it needs a
    // Referer the window cannot send, and it is a single path rather than a whole host.
    imageProxyOnly: Object.freeze([
      Object.freeze({ host: 'gelbooru.com', path: '/hotlink.php' }),
      Object.freeze({ host: 'www.gelbooru.com', path: '/hotlink.php' }),
    ]),
    thumb: Object.freeze([Object.freeze({ pattern: /^img\d*\.gelbooru\.com$/i })]),
  }),
  // ONL-012. Declared as an alternative of Danbooru. ONL-005 took that OUT of search: the
  // sites the user ticked are asked independently, and the grouping is left for a caller
  // that explicitly wants alternatives (production search is not one any more).
  group: 'anime',
  // Without the bundled key this site cannot be asked at all. Search then NAMES it as the
  // site that did not answer instead of quietly putting another one in its place.
  credentials: Object.freeze({ kind: 'bundled', required: true }),
  // Read by the shared handler — see the note in src/wallhaven.js about what does and
  // does not belong here.
  capabilities: Object.freeze({
    browse: true,
    textSearch: true,
    explicit: 'always',
    // Verified against the live API 2026-08-25: this site rejects every date-scoped form
    // of the query, so its "top" is ALL TIME and would hand back identical cards on every
    // launch unless it is read from a moving slice.
    topIsAllTime: true,
    // ONL-013. By which fingerprints this site can be asked "which post IS this exact
    // file". `META-001` used to keep its own separate list of sites for this; a site is
    // now declared once, here, and cannot be in one list and missing from the other.
    // A perceptual hash would be another entry, not another list.
    fingerprints: Object.freeze(['md5']),
    // ONL-014. This site can say what to offer while somebody types in the search box.
    tagSuggest: true,
    // ONL-015. Cards from here carry their format — see the note in src/wallhaven.js.
    cardFormat: true,
    // ONL-010. Measured on the live API 2026-09-03, and the odd one out: `width:>=` and
    // `height:>=` work, while `ratio:` does not exist here at all — every spelling tried
    // (`ratio:16:9`, `ratio:>=1.7`, `ratio:1.77`, `aspect_ratio:>=1.3`) returned an empty
    // page, which is how this site answers an unknown tag. So it narrows by size and the
    // shape is decided on our side.
    sizeFilter: Object.freeze({
      resolution: true, ratio: false, ratioList: false,
      // ONL-017. Its biggest page. Asked for only while the size filter is on, because
      // this site cannot narrow by shape and most of a normal page is thrown away here.
      maxPageSize: 100,
    }),
  }),
  // The image hosts refuse a request that does not say it came from the site.
  requestHeaders: Object.freeze({ Referer: 'https://gelbooru.com/' }),
  loadsDirectly: false,
});

// ONL-012. What the shared handler may ask this site to DO. See src/wallhaven.js for
// why `ctx.fetchJson` is injected rather than called directly here.
async function search(params, ctx) {
  const o = params || {};
  const page = Number(o.page) > 0 ? Number(o.page) : 1;
  const credentials = ctx && ctx.credentials;
  // No key means this site cannot be asked at all; search names it instead of replacing it.
  if (!credentials) return { error: 'unavailable' };
  const limit = Number(o.limit) > 0 ? Number(o.limit) : MAX_PAGE_SIZE;
  const url = buildSearchUrl({
    q: o.q || '',
    purity: o.purity,
    sorting: o.sort || o.sorting || 'date_added',
    page,
    limit,
    sizeHints: o.sizeHints,
    ...credentials,
  });
  const res = await ctx.fetchJson(url, { timeoutMs: 15000 });
  if (res.error) return { error: res.error };
  // This site can answer 200 and still be reporting a failure inside the body.
  const apiError = responseError(res.json);
  if (apiError) return { error: apiError };
  return parseSearch(res.json, { page, limit });
}

// Which KIND each of these tags is (artist, character, copyright, …).
//
// A tag's kind is a global fact about the catalogue, not a fact about one picture, so
// the answers accumulate in one process-wide cache and only names nobody has asked
// about yet cost a request. Both callers — downloading a picture and looking one up by
// fingerprint — come through here, so a name resolved once is free afterwards.
//
// The cache is why this module has state at all, and why `resetState` exists: without
// it one test would quietly answer another test's question.
const tagTypeCache = new Map();
const TAG_TYPE_CACHE_MAX = 4000;

function resetState() {
  tagTypeCache.clear();
}

async function tagTypesFor(tags, ctx) {
  const typeMap = new Map();
  const unknown = [];
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (tagTypeCache.has(tag)) typeMap.set(tag, tagTypeCache.get(tag));
    else if (tag) unknown.push(tag);
  }
  if (!unknown.length) return typeMap;
  // One URL carries every unknown name, but a post with hundreds of tags would build a
  // request line long enough to be rejected outright, so the batch is bounded.
  const url = buildTagTypesUrl(unknown.slice(0, 100), (ctx && ctx.credentials) || {});
  if (!url) return typeMap;
  const res = await ctx.fetchJson(url, { timeoutMs: 10000 });
  if (res.error || !res.json) return typeMap;
  for (const [name, type] of parseTagTypes(res.json)) {
    tagTypeCache.set(name, type);
    typeMap.set(name, type);
  }
  while (tagTypeCache.size > TAG_TYPE_CACHE_MAX) {
    tagTypeCache.delete(tagTypeCache.keys().next().value);
  }
  return typeMap;
}

// The artist and the complete tag list, neither of which the search response carries.
//
// The post is re-read first: the search response caps tags at 24 and this site sorts
// them alphabetically, so a late-sorting artist (BUG-002: tag 45 of 51) is simply not
// in it. One request on an explicit download, never per card in the feed.
async function enrich(item, ctx) {
  let tags = Array.isArray(item && item.tags)
    ? item.tags.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const postUrl = buildPostUrl(item && item.id, (ctx && ctx.credentials) || {});
  if (postUrl) {
    const res = await ctx.fetchJson(postUrl, { timeoutMs: 10000 });
    if (!res.error && res.json) {
      const posts = postsFromResponse(res.json);
      const full = posts.length ? allTags(posts[0]) : [];
      if (full.length) tags = full;
    }
  }
  if (!tags.length) return {};
  const typeMap = await tagTypesFor(tags, ctx);
  // Owner decision: join multiple artists with a comma, at most 3.
  return {
    author: artistLabel(artistNamesFromTypes(tags, typeMap), 3).slice(0, 120),
    tags: artistTagsFromTypes(tags, typeMap),
  };
}

// ONL-013 (META-001). Which post IS this exact file.
//
// `md5:` is an ordinary search term here, so this is the search endpoint again rather
// than a new one — which is precisely why the post that comes back must be checked
// against the fingerprint before it is believed. That check is NOT done here: it is one
// rule in the handler, for every site, because a site that forgot it would quietly write
// somebody else's tags onto the user's photo.
//
// `ctx.fetchJson` on this path is the BUDGETED one. The difference is invisible from
// here on purpose: a refusal by our own limiter arrives as an ordinary failure, and the
// handler — which owns the limiter — is what turns it into "busy, try later".
async function findByFingerprint(kind, value, ctx) {
  if (kind !== 'md5') return { error: 'unsupported' };
  const credentials = (ctx && ctx.credentials) || null;
  if (!credentials) return { error: 'unavailable' };
  const url = buildMd5Url(value, credentials);
  if (!url) return { error: 'badFingerprint' };
  const res = await ctx.fetchJson(url, { timeoutMs: 10000 });
  if (res.error) return { error: res.error };
  // This site can answer 200 and still be reporting a failure inside the body.
  const apiError = responseError(res.json);
  if (apiError) return { error: apiError };
  const post = postsFromResponse(res.json)[0];
  // No post is an ANSWER — "not here" — and not a failure. The two are journalled
  // differently, so they must not be collapsed.
  if (!post) return { result: null };
  // Tag kinds cost a second request that is allowed to fail or be refused: untyped tags
  // are still the tags the user asked for, and the artist is a bonus on top. Swallowed
  // rather than reported, because losing the post over it would be the worse answer.
  let typeMap = new Map();
  try { typeMap = await tagTypesFor(allTags(post), ctx); } catch { typeMap = new Map(); }
  return { result: postSummary(post, typeMap) };
}

// --- Tag suggestions (ONL-014) -------------------------------------------
// What to offer while somebody is typing in the search box.
//
// This used to live in src/tag-suggest.js — the only path left that reached one named
// site directly, with no fallback, so the moment this site was unreachable the box
// silently stopped suggesting anything. It is a declared capability like every other
// now, and the site's own endpoint and spelling live here beside the rest of it.
//
// Anonymous on purpose: the autocomplete endpoint needs no key, and sending one would
// spend the bundled credentials on every keystroke.
const TAG_SUGGEST_API = API_BASE;

function buildTagSuggestUrl({ q, limit } = {}) {
  const p = new URLSearchParams({
    page: 'autocomplete2',
    term: searchBox.normalizeTagPrefix(q),
    type: 'tag',
    limit: String(searchBox.clampLimit(limit)),
  });
  return `${TAG_SUGGEST_API}?${p.toString()}`;
}

function suggestionEntries(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.tag)) return json.tag;
  if (json && json.tag && typeof json.tag === 'object') return [json.tag];
  if (json && Array.isArray(json.tags)) return json.tags;
  return [];
}

// One suggestion in the shape every site answers in. The KIND of tag is spelled the way
// the rest of Znada spells it (`tagTypeName`) rather than in a second vocabulary of its
// own — until ONL-014 this file said `meta` while the suggestion box said `metadata`.
function normalizeSuggestion(entry) {
  const raw = String((entry && (entry.name || entry.tag || entry.value)) || '').trim();
  if (!raw || /\s/.test(raw)) return null;
  const name = searchBox.normalizeTagPrefix(raw);
  if (!name) return null;
  const rawCount = entry.count == null ? (entry.post_count == null ? entry.posts : entry.post_count) : entry.count;
  const count = Math.max(0, Math.floor(Number(rawCount) || 0));
  const rawType = entry.category == null ? entry.type : entry.category;
  return { name, count, category: tagTypeName(rawType) || 'general' };
}

function parseTagSuggestions(json, opts = {}) {
  // This API answers by prefix, so anything that does not start with what was typed is
  // noise rather than a useful alias, and is dropped.
  const prefix = searchBox.normalizeTagPrefix(opts.prefix || opts.q);
  const out = [];
  for (const entry of suggestionEntries(json)) {
    const item = normalizeSuggestion(entry);
    if (!item) continue;
    if (prefix && !item.name.startsWith(prefix)) continue;
    out.push(item);
  }
  return out;
}

async function suggestTags(params, ctx) {
  const o = params || {};
  const url = buildTagSuggestUrl({ q: o.q, limit: o.limit });
  const res = await ctx.fetchJson(url, { timeoutMs: 10000 });
  if (res.error) return { error: res.error };
  const apiError = responseError(res.json);
  if (apiError) return { error: apiError };
  return { items: parseTagSuggestions(res.json, { prefix: o.q }) };
}

// This site cannot be asked anything without the bundled credentials; a keyless build gets
// the other sites the user ticked, and this one is reported as not having answered.
function loadCredentials() {
  try {
    const k = require('../gelbooru-key.json');
    const userId = String((k && (k.userId || k.user_id)) || '').trim();
    const apiKey = String((k && (k.apiKey || k.api_key)) || '').trim();
    return userId && apiKey ? { userId, apiKey } : null;
  } catch { return null; }
}

module.exports = {
  PROVIDER,
  loadCredentials,
  search,
  enrich,
  findByFingerprint,
  suggestTags,
  tagTypesFor,
  TAG_SUGGEST_API,
  buildTagSuggestUrl,
  parseTagSuggestions,
  resetState,
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
  buildMd5Url,
  tagTypeName,
  postSummary,
};
