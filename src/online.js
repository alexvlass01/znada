'use strict';

const THUMBNAIL_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function isGelbooruImageHost(hostname) {
  return /^img\d*\.gelbooru\.com$/i.test(String(hostname || ''));
}

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
  const keys = [];
  if (item && item.md5) keys.push(`md5:${String(item.md5).toLowerCase()}`);
  const source = canonicalUrl(item && item.source);
  if (source) keys.push(`source:${source}`);
  const full = canonicalUrl(item && item.full);
  if (full) keys.push(`full:${full}`);
  return keys;
}

function allowedDownloadUrl(item) {
  if (!item || !item.full || !item.provider) return false;
  try {
    const url = new URL(item.full);
    if (url.protocol !== 'https:') return false;
    if (item.provider === 'wallhaven') return url.hostname === 'w.wallhaven.cc';
    if (item.provider === 'danbooru') return url.hostname === 'cdn.donmai.us';
    if (item.provider === 'gelbooru') return isGelbooruImageHost(url.hostname);
    return false;
  } catch {
    return false;
  }
}

// Is this URL one whose image bytes the main process may fetch (referer-gated)
// for the viewer? Same host rules for the sample and full tiers. Like
// allowedDownloadUrl but also accepts Gelbooru's apex hotlink.php endpoint.
function isAllowedProviderImageUrl(provider, target) {
  if (!provider || !target) return false;
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (provider === 'wallhaven') return url.hostname === 'w.wallhaven.cc';
    if (provider === 'danbooru') return url.hostname === 'cdn.donmai.us';
    if (provider === 'gelbooru') {
      return isGelbooruImageHost(url.hostname)
        || ((url.hostname === 'gelbooru.com' || url.hostname === 'www.gelbooru.com') && url.pathname === '/hotlink.php');
    }
    return false;
  } catch {
    return false;
  }
}

function allowedFullFetchUrl(item) {
  return !!item && isAllowedProviderImageUrl(item.provider, item.full);
}

function allowedSampleFetchUrl(item) {
  return !!item && isAllowedProviderImageUrl(item.provider, item.sample);
}

function allowedThumbnailUrl(item) {
  if (!item || !item.thumb) return false;
  try {
    const url = new URL(item.thumb);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
    if (item.provider === 'danbooru') return url.hostname === 'cdn.donmai.us';
    if (item.provider === 'gelbooru') return isGelbooruImageHost(url.hostname);
    return false;
  } catch {
    return false;
  }
}

function thumbnailMime(value) {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return THUMBNAIL_MIME_TYPES.has(mime) ? mime : '';
}

function thumbnailDataUrl(bytes, mime) {
  const safeMime = thumbnailMime(mime);
  if (!safeMime || !bytes) return '';
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return buffer.length ? `data:${safeMime};base64,${buffer.toString('base64')}` : '';
}

function allowedPageUrl(item) {
  if (!item || !item.page || !item.provider) return false;
  try {
    const url = new URL(item.page);
    if (url.protocol !== 'https:') return false;
    if (item.provider === 'wallhaven') return url.hostname === 'wallhaven.cc';
    if (item.provider === 'danbooru') return url.hostname === 'danbooru.donmai.us';
    if (item.provider === 'gelbooru') return url.hostname === 'gelbooru.com' || url.hostname === 'www.gelbooru.com';
    return false;
  } catch {
    return false;
  }
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

module.exports = {
  canonicalUrl,
  itemKeys,
  isGelbooruImageHost,
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
