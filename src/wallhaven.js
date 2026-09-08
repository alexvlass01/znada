'use strict';

// Wallhaven API client — PURE parts only (URL building + response parsing), so they
// can be unit-tested without network (see test/wallhaven.test.js). The actual fetch +
// file download live in main.js (Node global fetch), kept thin on purpose.
//
// API facts (wallhaven.cc/help/api): search is open to guests for SFW+Sketchy; NSFW
// needs a valid API key (else 401). Rate limit 45 req/min per key/IP → 429. The key is
// only sent when NSFW is requested (keeps the shared/bundled key off the common path).
//
//   purity     = 3-bit "sfw sketchy nsfw", e.g. 100=sfw, 110=sfw+sketchy, 111=all
//   categories = 3-bit "general anime people", default 111
//   sorting    = date_added | relevance | random | views | favorites | toplist
//   thumbs.small/large = preview URLs; path = full-resolution image URL

const media = require('./media-type');

const API_BASE = 'https://wallhaven.cc/api/v1/search';

// Build a 3-bit mask string from three booleans.
function mask(a, b, c) {
  return `${a ? 1 : 0}${b ? 1 : 0}${c ? 1 : 0}`;
}
function purityMask({ sfw = true, sketchy = true, nsfw = false } = {}) {
  return mask(sfw, sketchy, nsfw);
}
function categoryMask({ general = true, anime = true, people = true } = {}) {
  return mask(general, anime, people);
}

// Build the search URL. apikey is appended ONLY when provided (truthy).
function buildSearchUrl(opts = {}) {
  const p = new URLSearchParams();
  if (opts.q) p.set('q', String(opts.q));
  p.set('categories', opts.categories || '111');
  p.set('purity', opts.purity || '100');
  p.set('sorting', opts.sorting || 'date_added');
  p.set('order', opts.order || 'desc');
  p.set('page', String(opts.page && opts.page > 0 ? opts.page : 1));
  // ONL-010. Narrowing, not deciding: `atleast` is the smallest floor that still covers
  // every target, and `ratios` the list of shapes. The exact judgement happens on our
  // side afterwards, so a loose bound here can only cost bandwidth, never correctness.
  if (opts.atleast) p.set('atleast', String(opts.atleast));
  if (opts.ratios) p.set('ratios', String(opts.ratios));
  if (opts.apikey) p.set('apikey', String(opts.apikey));
  return `${API_BASE}?${p.toString()}`;
}

// Map one raw Wallhaven item → a compact shape Znada uses.
function mapItem(w) {
  if (!w || !w.path) return null;
  const thumbs = w.thumbs || {};
  const match = String(w.resolution || '').match(/^(\d+)x(\d+)$/i);
  const width = Number(w.dimension_x) || (match ? Number(match[1]) : 0);
  const height = Number(w.dimension_y) || (match ? Number(match[2]) : 0);
  return {
    id: w.id,
    provider: 'wallhaven',
    page: w.url || '',                       // wallhaven.cc page (attribution)
    full: w.path,                            // full-resolution image URL (download this)
    // BUG-039. `original` — превью В ПРОПОРЦИЯХ ФОТОГРАФИИ, а `small` обрезан под
    // фиксированные 300x200: у высокой картинки это её середина крупным планом, и
    // просмотрщик такой кадр показать честно не может — он его отбраковывает и ждёт
    // полную. Замер 2026-09-03 по живой ленте: `original` 300x169 и 5–19 КБ, `large`
    // 432x243 и 7–22 КБ, оба совпадают по форме; `small` расходится на 16% и весит
    // столько же. То есть обрезанный вариант не давал ни скорости, ни правды.
    // Обрезанный `small` остаётся ПОСЛЕДНИМ запасным перед полной картинкой: для сетки
    // он дёшев, а просмотрщик его отбракует по форме и дождётся полной — то есть хуже,
    // чем `original`, но много лучше, чем тянуть оригинал ради миниатюры.
    thumb: thumbs.original || thumbs.large || thumbs.small || w.path,
    resolution: w.resolution || '',
    width,
    height,
    // ONL-016. Reported by this site in bytes, so "Details" can answer "how big is it"
    // before anything is downloaded. Not every site can: Gelbooru has no size field at
    // all, and a card that cannot say leaves this at 0 rather than guessing.
    fileSize: Number(w.file_size) || 0,
    fileType: w.file_type || '',
    // Measured 2026-08-25 over 96 cards: this site serves only jpeg and png. Reported
    // anyway, so the handler — not this file — decides what Znada can use.
    format: media.normalizeFormat(w.file_type),
    purity: w.purity || '',
    category: w.category || '',
    source: w.source || '',                  // original source if provided
  };
}

// --- Tags (ONL-008) -------------------------------------------------------
// The search endpoint never returns tags, so a downloaded wallpaper used to land in
// the library with none at all. The single-wallpaper endpoint does carry them, so the
// download path reads it once — the same shape as the Gelbooru artist lookup.
const WALLPAPER_BASE = 'https://wallhaven.cc/api/v1/w/';

function buildWallpaperUrl(id, { apikey } = {}) {
  const wallpaperId = String(id == null ? '' : id).replace(/^wallhaven:/, '').trim();
  if (!/^[A-Za-z0-9]{1,20}$/.test(wallpaperId)) return '';
  const suffix = apikey ? `?apikey=${encodeURIComponent(String(apikey))}` : '';
  return `${WALLPAPER_BASE}${wallpaperId}${suffix}`;
}

// Tag names from a single-wallpaper response, lowercased and deduplicated. Wallhaven
// tag names contain spaces ("anime girls"); they are kept verbatim rather than
// forced into booru underscore style, because that is what the site actually calls them.
function tagsFromWallpaper(json, max = 24) {
  const data = (json && json.data) || json || {};
  const list = Array.isArray(data.tags) ? data.tags : [];
  const cap = Number(max) > 0 ? Math.floor(Number(max)) : list.length;
  const out = [];
  const seen = new Set();
  for (const tag of list) {
    const name = String((tag && tag.name) || '').trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= cap) break;
  }
  return out;
}

// Parse a search response body → { items:[…], meta:{…} }. Tolerant of junk.
function parseSearch(json) {
  const data = json && Array.isArray(json.data) ? json.data : [];
  const items = data.map(mapItem).filter(Boolean);
  const m = (json && json.meta) || {};
  const meta = {
    currentPage: Number(m.current_page) || 1,
    lastPage: Number(m.last_page) || 1,
    perPage: Number(m.per_page) || items.length,
    total: Number(m.total) || items.length,
  };
  return { items, meta };
}

// ONL-011. What this site IS, as data — read by the registry without running any of
// the code below. The address lists are the security boundary: they are the only thing
// that stops the app being talked into fetching from somewhere else, so they live here,
// once, instead of in six copies spread through src/online.js.
const PROVIDER = Object.freeze({
  id: 'wallhaven',
  name: 'Wallhaven',
  status: 'active',
  hosts: Object.freeze({
    page: Object.freeze(['wallhaven.cc']),
    image: Object.freeze(['w.wallhaven.cc']),
    // Nothing extra is reachable only through the main process for this site.
    imageProxyOnly: Object.freeze([]),
    // Deliberately empty: Wallhaven's previews load straight from the window, so main
    // never fetches one and must not be allowed to.
    thumb: Object.freeze([]),
  }),
  // ONL-012. Sites in one group are ALTERNATIVES: asked in registry order until one
  // answers. Different groups are asked together. This is what replaces the hardwired
  // "Gelbooru, and Danbooru if that failed" pair.
  group: 'wallpapers',
  credentials: Object.freeze({ kind: 'bundled', required: false }),
  // Everything in a declaration is READ BY THE SHARED HANDLER. A fact only this file
  // uses is an ordinary constant below, not a field here — a declared field nobody reads
  // is the beginning of a form that describes nothing and drifts out of date unnoticed.
  capabilities: Object.freeze({
    browse: true,
    textSearch: true,
    // Wallhaven serves adult content only to a request carrying a key.
    explicit: 'withCredentials',
    // "Top" here is scoped to a time window by the site itself, so it renews on its own.
    topIsAllTime: false,
    // ONL-013. Declared empty rather than omitted: this site indexes no file hash at
    // all, so it can never answer "which post IS this exact file". An omission would
    // read as "nobody has looked into it".
    fingerprints: Object.freeze([]),
    // ONL-015. Every card from here states its own format, so the handler can judge it
    // against the one list. A site that cannot say must vouch for its content instead.
    cardFormat: true,
    // ONL-010. What this site can NARROW on its own, measured against the live API on
    // 2026-09-03: `atleast` and `ratios` both work, and `ratios` takes a list. It is an
    // optimisation and never the guarantee — every card is still checked here, because a
    // server told the loosest bound covering several targets cannot decide the exact one.
    sizeFilter: Object.freeze({
      resolution: true, ratio: true, ratioList: true,
      // Deliberately zero: this API has no page-size parameter at all — a page is
      // whatever the site decides to send — so there is nothing to widen.
      maxPageSize: 0,
    }),
  }),
  requestHeaders: Object.freeze({}),
  // The window may load these images itself: no Referer is required, so nothing has to
  // be proxied through main.
  loadsDirectly: true,
});

// ONL-012. The two things the shared handler may ask this site to DO. Everything
// awkward about the site lives here; the handler only orchestrates.
//
// `ctx.fetchJson` is injected rather than fetched here, so this file still needs no
// network to be tested, and so timeouts, error wording and — later — the request budget
// stay the handler's business rather than being reinvented per site.
//
// `params.limit` is ignored on purpose: this API has no page-size parameter at all, and
// a page is whatever the site decides to send.
// ONL-010. This site's own spelling of the loosest bound covering every target. It takes
// a LIST of shapes, so several monitors cost nothing extra; `atleast` is a single floor,
// so the smallest one is sent and the exact judgement is made against the card.
// Ratios are given as `WxH` — the site's own notation — from the ratio itself, so an
// unusual screen still produces something it understands.
function sizeParams(hints) {
  if (!hints || typeof hints !== 'object') return {};
  const out = {};
  const width = Math.floor(Number(hints.minWidth) || 0);
  const height = Math.floor(Number(hints.minHeight) || 0);
  if (width > 0 && height > 0) out.atleast = `${width}x${height}`;
  const ratios = Array.isArray(hints.ratios) ? hints.ratios : [];
  if (hints.everyTargetHasRatio && ratios.length) {
    const spelled = ratios.map(ratioToPair).filter(Boolean);
    if (spelled.length) out.ratios = spelled.join(',');
  }
  return out;
}

// 1.7777… → "16x9". Approximated over small denominators, because the site wants whole
// numbers and a screen's ratio is always close to one of these.
function ratioToPair(ratio) {
  const value = Number(ratio);
  if (!Number.isFinite(value) || value <= 0) return '';
  let best = null;
  for (let h = 1; h <= 20; h++) {
    const w = Math.round(value * h);
    if (w < 1) continue;
    const off = Math.abs((w / h) - value) / value;
    if (!best || off < best.off) best = { w, h, off };
    if (off === 0) break;
  }
  return best && best.off <= 0.02 ? `${best.w}x${best.h}` : '';
}

async function search(params, ctx) {
  const o = params || {};
  const key = (ctx && ctx.credentials && ctx.credentials.key) || '';
  const p = o.purity || { sfw: true, sketchy: true, nsfw: false };
  // Adult content needs a key; without one the request must not even ask for it.
  const wantNsfw = !!p.nsfw && !!key;
  if (!p.sfw && !p.sketchy && !wantNsfw) {
    return { items: [], meta: { currentPage: o.page || 1, lastPage: o.page || 1 } };
  }
  const url = buildSearchUrl({
    q: o.q || '',
    purity: purityMask({ sfw: !!p.sfw, sketchy: !!p.sketchy, nsfw: wantNsfw }),
    categories: o.categories || '111',
    sorting: o.sort || o.sorting || 'date_added',
    page: o.page || 1,
    ...sizeParams(o.sizeHints),
    apikey: wantNsfw ? key : '',
  });
  const res = await ctx.fetchJson(url, { timeoutMs: 15000 });
  if (res.error) return { error: res.error };
  return parseSearch(res.json);
}

// The search response carries no tags at all, so they cost one more request — made only
// when the user actually downloads the picture, never for a card in the feed.
async function enrich(item, ctx) {
  const key = (ctx && ctx.credentials && ctx.credentials.key) || '';
  const url = buildWallpaperUrl(item && item.id, { apikey: key });
  if (!url) return {};
  const res = await ctx.fetchJson(url, { timeoutMs: 10000 });
  if (res.error) return {};
  return { tags: tagsFromWallpaper(res.json) };
}

// The bundled key, if this build carries one. Absent in a keyless build, and absence
// is normal rather than an error — this site simply answers without adult content.
function loadCredentials() {
  try {
    const k = require('../wallhaven-key.json');
    const key = String((k && (k.key || k.apikey)) || '').trim();
    return key ? { key } : null;
  } catch { return null; }
}

module.exports = {
  PROVIDER,
  loadCredentials,
  search,
  enrich,
  API_BASE,
  WALLPAPER_BASE,
  mask,
  purityMask,
  categoryMask,
  buildSearchUrl,
  sizeParams,
  ratioToPair,
  buildWallpaperUrl,
  tagsFromWallpaper,
  mapItem,
  parseSearch,
};
