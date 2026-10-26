'use strict';

// META-004. IQDB proposes an identity; it never supplies trusted tags or permission
// to write. HTML is treated as bounded data and never reaches a renderer.
const budget = require('./request-budget');
const POLICY = Object.freeze({ ratePerMinute: 2, burst: 1, minGapMs: 30000 });
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 200 * 1024;

function reference(raw) {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  const value = raw.replace(/&amp;/g, '&');
  let url;
  try { url = new URL(value.startsWith('//') ? 'https:' + value : value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  let id;
  if (url.hostname === 'danbooru.donmai.us' && !url.search) {
    id = (url.pathname.match(/^\/posts\/([1-9][0-9]{0,19})$/) || [])[1];
    if (id) return { provider: 'danbooru', postId: id, page: `https://danbooru.donmai.us/posts/${id}` };
  }
  if (url.hostname === 'gelbooru.com' && url.pathname === '/index.php') {
    const params = url.searchParams;
    if (Array.from(params.keys()).sort().join(',') !== 'id,page,s') return null;
    id = params.get('id');
    if (params.get('page') === 'post' && params.get('s') === 'view' && /^[1-9][0-9]{0,19}$/.test(id || '')) {
      return { provider: 'gelbooru', postId: id, page: `https://gelbooru.com/index.php?page=post&s=view&id=${id}` };
    }
  }
  return null;
}

function parse(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_RESPONSE_BYTES) return { status: 'error', reason: 'malformed' };
  const data = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  const start = data.search(/<div\b[^>]*\bid=['"]pages['"]/i);
  const end = data.search(/<div\b[^>]*\bid=['"]show1['"]/i);
  if (start < 0 || end <= start || !/<h2>Search results<\/h2>/i.test(data)) return { status: 'error', reason: 'malformed' };
  const primary = data.slice(start, end);
  if (/<th>\s*No relevant matches\s*<\/th>/i.test(primary)) return { status: 'absent' };
  const candidates = [];
  for (const match of primary.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const table = match[0];
    if (!/<th>\s*(?:Best match|Additional match|Possible match)\s*<\/th>/i.test(table)) continue;
    const imageCell = table.match(/<td\b[^>]*class=['"]image['"][^>]*>([\s\S]*?)<\/td>/i);
    const href = imageCell && imageCell[1].match(/<a\s+href=['"]([^'"<>]+)['"]/i);
    const ref = href && reference(href[1]);
    const scores = Array.from(table.matchAll(/<td>\s*(\d+(?:\.\d+)?)% similarity\s*<\/td>/gi));
    if (!ref || scores.length !== 1) continue;
    const similarity = Number(scores[0][1]);
    if (similarity < 80 || similarity > 100) continue; // Our display threshold, not calibrated confidence.
    if (!candidates.some((c) => c.provider === ref.provider && c.postId === ref.postId)) candidates.push({ ...ref, similarity });
  }
  if (candidates.length !== 1) return { status: 'ambiguous' };
  return { status: 'candidate', candidate: candidates[0] };
}

function create({ userAgent = 'Znada', fetchImpl = (url, init) => fetch(url, init), now = Date.now } = {}) {
  let state;
  async function search(image) {
    if (!image || !Buffer.isBuffer(image.bytes) || image.bytes.length > MAX_IMAGE_BYTES || image.bytes.length === 0
      || !['image/jpeg', 'image/png'].includes(image.mime)) return { status: 'error', reason: 'thumbnail' };
    const gate = budget.take(state, now(), POLICY);
    if (!gate.allowed) return { status: 'busy', retryAfterMs: gate.retryAfterMs };
    state = gate.state;
    try {
      const form = new FormData();
      form.append('file', new Blob([image.bytes], { type: image.mime }), image.mime === 'image/png' ? 'image.png' : 'image.jpg');
      const res = await fetchImpl('https://iqdb.org/', {
        method: 'POST', body: form, redirect: 'manual',
        headers: { 'User-Agent': userAgent || 'Znada' }, signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        state = budget.noteFailure(state, now(), budget.failureKind(res.status, null), POLICY);
        const retry = res.headers.get('retry-after');
        const until = /^\d+$/.test(retry || '') ? now() + Number(retry) * 1000 : Date.parse(retry || '');
        if (Number.isFinite(until)) state.blockedUntil = Math.max(state.blockedUntil, until);
        return { status: 'error', reason: String(res.status) };
      }
      if (!(res.headers.get('content-type') || '').startsWith('text/html')) throw new Error('malformed');
      const reader = res.body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('oversize'); }
        chunks.push(Buffer.from(part.value));
      }
      const result = parse(Buffer.concat(chunks).toString('utf8'));
      state = result.status === 'error' ? budget.noteFailure(state, now(), 'network', POLICY) : budget.noteSuccess(state, now(), POLICY);
      return result;
    } catch (err) {
      state = budget.noteFailure(state, now(), 'network', POLICY);
      return { status: 'error', reason: err.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
  }
  return { search };
}

module.exports = { reference, parse, create, MAX_IMAGE_BYTES };
