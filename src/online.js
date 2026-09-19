'use strict';

const registry = require('./provider-registry');
const mediaFormats = require('./media-type');
const onlineIdentity = require('./online-identity');

function canonicalUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    let host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'twitter.com') host = 'x.com';
    return `${host}${url.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return String(value).trim().toLowerCase();
  }
}

function itemKeys(item) {
  return onlineIdentity.keys(item);
}

// ONL-011. Every "may we touch this address?" question now reads the same declared
// address lists (src/provider-registry.js) instead of repeating a per-provider ladder.
//
// The SHAPE of an address is now one rule too. The four checks below used to disagree
// about it — one refused an address carrying a password while its sibling allowed the
// very same address, and only one of the four refused an odd port. That disagreement was
// an accident of the order they were written in, and ONL-011 pinned it with a test
// rather than settling it. Settled here: no picture site's address legitimately carries
// a password or a port, so every one of the four refuses both.
function safeProviderUrl(target) {
  if (!target) return null;
  let url;
  try { url = new URL(String(target)); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.port) return null;
  return url;
}

// Downloading INTO the library: the picture's own file, on the provider's own CDN.
function allowedDownloadUrl(item) {
  if (!item || !item.full || !item.provider || !safeProviderUrl(item.full)) return false;
  return registry.matchesHost(item.provider, 'image', item.full);
}

// Bytes the MAIN process may fetch on the viewer's behalf (some hosts need a Referer
// the window cannot send). Same CDN rules, plus whatever a provider marks as reachable
// only this way — Gelbooru's apex hotlink endpoint.
function isAllowedProviderImageUrl(provider, target) {
  if (!provider || !safeProviderUrl(target)) return false;
  return registry.matchesHost(provider, ['image', 'imageProxyOnly'], target);
}

function allowedFullFetchUrl(item) {
  return !!item && isAllowedProviderImageUrl(item.provider, item.full);
}

function allowedSampleFetchUrl(item) {
  return !!item && isAllowedProviderImageUrl(item.provider, item.sample);
}

// Previews main is allowed to fetch. A provider whose previews load straight from the
// window declares NO thumbnail hosts, and an empty list means "none", never "any".
function allowedThumbnailUrl(item) {
  if (!item || !item.thumb || !safeProviderUrl(item.thumb)) return false;
  return registry.matchesHost(item.provider, 'thumb', item.thumb);
}

function thumbnailMime(value) {
  return mediaFormats.wallpaperMime(value);
}

function thumbnailDataUrl(bytes, mime) {
  const safeMime = thumbnailMime(mime);
  if (!safeMime || !bytes) return '';
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return buffer.length ? `data:${safeMime};base64,${buffer.toString('base64')}` : '';
}

// The post page we may open in the user's browser. Retired providers still match here:
// a picture saved long ago keeps its source address, and it must keep opening.
function allowedPageUrl(item) {
  if (!item || !item.page || !item.provider || !safeProviderUrl(item.page)) return false;
  return registry.matchesHost(item.provider, 'page', item.page);
}

function interleave(lists) {
  const sources = (lists || []).map((items) => Array.isArray(items) ? items : []);
  const positions = sources.map(() => 0);
  const seen = new Set();
  const merged = [];
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (let i = 0; i < sources.length; i++) {
      while (positions[i] < sources[i].length) {
        advanced = true;
        const item = sources[i][positions[i]++];
        if (!item) continue;
        const keys = itemKeys(item);
        if (keys.some((key) => seen.has(key))) continue;
        keys.forEach((key) => seen.add(key));
        merged.push(item);
        break;
      }
    }
  }
  return merged;
}

function resultHasMore(result, page) {
  const meta = result && result.meta || {};
  if (meta.hasMore === true) return true;
  return Number(meta.lastPage) > page;
}

function mergeSearchResults(results, page = 1) {
  const list = Array.isArray(results) ? results : [];
  const successful = list.filter((result) => result && !result.error);
  const providerErrors = {};
  for (const result of list) {
    if (result && result.error) providerErrors[result.provider || 'unknown'] = result.error;
  }
  const hasMore = successful.some((result) => resultHasMore(result, page));
  const error = successful.length ? null : Object.values(providerErrors).join(', ') || 'network';
  return {
    items: interleave(successful.map((result) => result.items)),
    meta: {
      currentPage: page,
      lastPage: hasMore ? page + 1 : page,
      hasMore,
    },
    error,
    providerErrors,
  };
}

function providerFailed(result) {
  return !result || !!result.error;
}

function resolveFallback(primary, fallback) {
  if (!providerFailed(primary)) return primary;
  if (!providerFailed(fallback)) {
    return {
      ...fallback,
      fallbackFrom: primary && primary.provider || '',
      fallbackReason: primary && primary.error || 'network',
    };
  }
  const errors = [primary && primary.error, fallback && fallback.error].filter(Boolean);
  return {
    provider: primary && primary.provider || fallback && fallback.provider || 'unknown',
    items: [],
    meta: {},
    error: errors.join(', ') || 'network',
  };
}

// BUG-020. The browse feed asks each site for TWO orderings at once (what is new and
// what is well rated) and hands the user one feed rather than two blocks. Interleaving
// them would produce a visible rhythm — new, top, new, top — and, worse, would put one
// ordering's first card at the very top every single time. A shuffle removes both.
//
// The randomness is injected so the tests are not a coin toss, and each page is shuffled
// ONCE as it arrives: re-shuffling on every render would reorder cards under the user's
// cursor, and pressing "more" must never disturb what is already on screen.
function shuffle(list, rng) {
  const out = Array.isArray(list) ? list.slice() : [];
  const random = typeof rng === 'function' ? rng : Math.random;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

module.exports = {
  canonicalUrl,
  shuffle,
  itemKeys,
  safeProviderUrl,
  allowedDownloadUrl,
  isAllowedProviderImageUrl,
  allowedFullFetchUrl,
  allowedSampleFetchUrl,
  allowedThumbnailUrl,
  allowedPageUrl,
  thumbnailMime,
  thumbnailDataUrl,
  interleave,
  resultHasMore,
  mergeSearchResults,
  providerFailed,
  resolveFallback,
};
