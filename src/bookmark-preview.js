'use strict';

const online = require('./online');
const registry = require('./provider-registry');
const LIMIT = 256 * 1024;

function allowed(item) {
  const url = online.safeProviderUrl ? online.safeProviderUrl(item?.thumb) : null;
  let parsed;
  try { parsed = url || new URL(item.thumb); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
  if (item.provider === 'wallhaven') return parsed.hostname === 'th.wallhaven.cc';
  if (item.provider === 'znada') return parsed.hostname.endsWith('.r2.cloudflarestorage.com');
  return registry.matchesHost(item.provider, 'thumb', item.thumb);
}

async function fetchPreview(item, headers, fetchImpl = fetch) {
  if (!allowed(item)) return '';
  const res = await fetchImpl(item.thumb, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!res.ok || !res.body || Number(res.headers.get('content-length')) > LIMIT) return '';
  const mime = online.thumbnailMime(res.headers.get('content-type'));
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return '';
  const reader = res.body.getReader(), chunks = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > LIMIT) { await reader.cancel(); return ''; }
    chunks.push(Buffer.from(part.value));
  }
  return online.thumbnailDataUrl(Buffer.concat(chunks), mime);
}

module.exports = { allowed, fetchPreview, LIMIT };
