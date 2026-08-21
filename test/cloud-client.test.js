'use strict';

// Plain Node test: `node test/cloud-client.test.js`. Covers the C1 cloud client —
// pure URL/header/param builders, response/error parsing against the vendored
// contracts, and the full request flow through an INJECTED fake fetch (no network).

const assert = require('assert');
const CL = require('../src/cloud/client');
const C = require('../src/cloud/contracts.cjs');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

const BASE = 'https://lumina-cloud-api-staging.alexvlass01.workers.dev';

// A fake fetch that records calls and returns a canned { status, body }. Pass an
// Error to simulate a network failure. Mimics a real Response via text().
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = typeof responder === 'function' ? responder(url, init) : responder;
    if (r instanceof Error) throw r;
    return {
      status: r.status,
      async text() { return r.body === undefined ? '' : JSON.stringify(r.body); },
    };
  };
  fn.calls = calls;
  return fn;
}

// Valid sample bodies (must pass the zod contracts).
const sampleCatalogItem = {
  id: 'c1', title: 'Sunset', rating: 'general', published_at: 1700000000,
  width: 1920, height: 1080, thumb_url: 'https://acct.r2.cloudflarestorage.com/t/c1.jpg',
};
const sampleUser = {
  id: 'u1', display_name: 'Alex', email: null, role: 'user',
  explicit_opt_in: false, created_at: 1700000000,
};
// session_token must match the contract's base64url pattern (43–128 chars).
const SESSION = 'A'.repeat(43);

// ---------------------------------------------------------------------------
// joinUrl / buildUrl / toQueryString
// ---------------------------------------------------------------------------
ok('joinUrl: trims base trailing slash, adds leading slash', CL.joinUrl(BASE + '/', 'v1/health') === BASE + '/v1/health');
ok('joinUrl: keeps a single slash', CL.joinUrl(BASE, '/v1/health') === BASE + '/v1/health');
ok('buildUrl: no query when empty', CL.buildUrl(BASE, '/v1/catalog', {}) === BASE + '/v1/catalog');
ok('buildUrl: skips null/undefined/empty params', (() => {
  const u = CL.buildUrl(BASE, '/v1/catalog', { rating: 'general', cursor: null, limit: undefined, tag: '' });
  return u === BASE + '/v1/catalog?rating=general';
})());
ok('buildUrl: encodes values', CL.buildUrl(BASE, '/v1/catalog', { tag: 'a b&c' }).includes('tag=a+b%26c'));
ok('toQueryString: stable for multiple params', (() => {
  const qs = CL.toQueryString({ rating: 'suggestive', limit: 50 });
  return qs.includes('rating=suggestive') && qs.includes('limit=50');
})());

// ---------------------------------------------------------------------------
// authHeaders / buildGoogleStartUrl
// ---------------------------------------------------------------------------
ok('authHeaders: empty without token', Object.keys(CL.authHeaders()).length === 0);
ok('authHeaders: Bearer with token', CL.authHeaders('TOK').Authorization === 'Bearer TOK');
ok('anonHeaders: header for a well-formed id', CL.anonHeaders('0123456789abcdef0123456789abcdef')['X-Lumina-Anon-Id'] === '0123456789abcdef0123456789abcdef');
ok('anonHeaders: empty for missing/short/garbage id', (() => {
  return Object.keys(CL.anonHeaders()).length === 0
    && Object.keys(CL.anonHeaders('')).length === 0
    && Object.keys(CL.anonHeaders('short')).length === 0
    && Object.keys(CL.anonHeaders('has spaces!!')).length === 0;
})());
ok('buildGoogleStartUrl: path + port + challenge', (() => {
  const u = CL.buildGoogleStartUrl(BASE, { port: 51789, challenge: 'CHAL' });
  return u.startsWith(BASE + C.API_PATHS.authGoogleStart) && u.includes('port=51789') && u.includes('challenge=CHAL');
})());

// ---------------------------------------------------------------------------
// validateCatalogParams
// ---------------------------------------------------------------------------
ok('validateCatalogParams: null when fine', CL.validateCatalogParams({ rating: 'general', limit: 24 }) === null);
ok('validateCatalogParams: ok when empty', CL.validateCatalogParams({}) === null);
ok('validateCatalogParams: bad rating → request error', (() => {
  const r = CL.validateCatalogParams({ rating: 'nope' });
  return r && r.ok === false && r.error.kind === 'request' && r.error.code === 'invalid_request';
})());
ok('validateCatalogParams: limit out of range → request error', (() => {
  return CL.validateCatalogParams({ limit: 101 }).error.code === 'invalid_request'
    && CL.validateCatalogParams({ limit: 0 }).error.code === 'invalid_request'
    && CL.validateCatalogParams({ limit: 2.5 }).error.code === 'invalid_request';
})());

// ---------------------------------------------------------------------------
// normalizeApiError
// ---------------------------------------------------------------------------
ok('normalizeApiError: canonical ApiError keeps server code (kind api)', (() => {
  const e = CL.normalizeApiError(401, { error: { code: 'unauthorized', message: 'no session' } });
  return e.kind === 'api' && e.code === 'unauthorized' && e.message === 'no session' && e.status === 401;
})());
ok('normalizeApiError: non-canonical body → http_<status>', (() => {
  const e = CL.normalizeApiError(500, { oops: true });
  return e.kind === 'http' && e.code === 'http_500' && e.status === 500;
})());

// ---------------------------------------------------------------------------
// parseJsonResponse
// ---------------------------------------------------------------------------
ok('parseJsonResponse: 2xx + valid schema → ok+data', (() => {
  const r = CL.parseJsonResponse({ status: 200, body: { ok: true, service: 'lumina-cloud-api', version: '1.0' } }, C.HealthResponse);
  return r.ok === true && r.data.service === 'lumina-cloud-api';
})());
ok('parseJsonResponse: 2xx + invalid schema → contract error', (() => {
  const r = CL.parseJsonResponse({ status: 200, body: { ok: true } }, C.HealthResponse);
  return r.ok === false && r.error.kind === 'contract' && r.error.code === 'invalid_response';
})());
ok('parseJsonResponse: 2xx no schema → raw body', (() => {
  const r = CL.parseJsonResponse({ status: 204, body: null });
  return r.ok === true && r.data === null;
})());
ok('parseJsonResponse: non-2xx → api error', (() => {
  const r = CL.parseJsonResponse({ status: 403, body: { error: { code: 'forbidden', message: 'x' } } });
  return r.ok === false && r.error.code === 'forbidden' && r.error.status === 403;
})());

// ---------------------------------------------------------------------------
// createClient — guards
// ---------------------------------------------------------------------------
ok('createClient: throws without baseUrl', (() => {
  try { CL.createClient({ fetchImpl: () => {} }); return false; } catch { return true; }
})());
ok('createClient: throws without a fetch', (() => {
  try { CL.createClient({ baseUrl: BASE, fetchImpl: 123 }); return false; } catch { return true; }
})());

// ---------------------------------------------------------------------------
// createClient — request flow (async block)
// ---------------------------------------------------------------------------
(async () => {
  // health success
  {
    const ff = fakeFetch({ status: 200, body: { ok: true, service: 'lumina-cloud-api', version: '0.0.0' } });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff });
    const r = await client.health();
    ok('client.health: hits /v1/health', ff.calls[0].url === BASE + '/v1/health');
    ok('client.health: ok + parsed', r.ok === true && r.data.version === '0.0.0');
  }

  // catalog: builds query, sends token header, parses CatalogPage
  {
    const ff = fakeFetch({ status: 200, body: { items: [sampleCatalogItem], next_cursor: 'NEXT' } });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff });
    const r = await client.getCatalog({ rating: 'suggestive', limit: 24, tag: 'space', cursor: 'CUR', token: 'TOK' });
    const url = ff.calls[0].url;
    ok('client.getCatalog: query assembled', url.includes('rating=suggestive') && url.includes('limit=24') && url.includes('tag=space') && url.includes('cursor=CUR'));
    ok('client.getCatalog: bearer header when token given', ff.calls[0].init.headers.Authorization === 'Bearer TOK');
    ok('client.getCatalog: parsed CatalogPage', r.ok === true && r.data.items.length === 1 && r.data.next_cursor === 'NEXT');
  }

  // anon id: sent on requests when the client is created with one (even anonymously)
  {
    const ff = fakeFetch({ status: 200, body: { items: [], next_cursor: null } });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff, anonId: '0123456789abcdef0123456789abcdef' });
    await client.getCatalog({});
    ok('client: X-Lumina-Anon-Id sent when configured', ff.calls[0].init.headers['X-Lumina-Anon-Id'] === '0123456789abcdef0123456789abcdef');
  }
  {
    const ff = fakeFetch({ status: 200, body: { items: [], next_cursor: null } });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff });
    await client.getCatalog({});
    ok('client: no anon header when not configured', !('X-Lumina-Anon-Id' in ff.calls[0].init.headers));
  }

  // catalog: invalid rating short-circuits BEFORE fetch
  {
    const ff = fakeFetch({ status: 200, body: {} });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff });
    const r = await client.getCatalog({ rating: 'bogus' });
    ok('client.getCatalog: invalid rating → request error, no fetch', r.ok === false && r.error.code === 'invalid_request' && ff.calls.length === 0);
  }

  // content + download: id encoded into path
  {
    const ff = fakeFetch((url) => {
      if (url.includes('/download')) return { status: 200, body: { url: 'https://acct.r2.cloudflarestorage.com/f.jpg', expires_at: 1700000900 } };
      return { status: 200, body: { id: 'a/b', title: 'T', rating: 'general', published_at: 1, width: 10, height: 10, bytes: 100, format: 'jpg', tags: [], warnings: [], preview_url: 'https://acct.r2.cloudflarestorage.com/p.jpg' } };
    });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff });
    const card = await client.getContent('a/b');
    ok('client.getContent: id url-encoded', ff.calls[0].url === BASE + '/v1/content/a%2Fb');
    ok('client.getContent: parsed ContentCard', card.ok === true && card.data.format === 'jpg');
    const dl = await client.getDownload('a/b');
    ok('client.getDownload: /download path', ff.calls[1].url === BASE + '/v1/content/a%2Fb/download');
    ok('client.getDownload: parsed DownloadResponse', dl.ok === true && typeof dl.data.expires_at === 'number');
  }

  // protected endpoints require a token (no fetch fired)
  {
    const ff = fakeFetch({ status: 200, body: {} });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff });
    const me = await client.getMe();
    const fav = await client.getFavorites('');
    ok('client.getMe: missing token → request error, no fetch', me.ok === false && me.error.code === 'missing_token' && ff.calls.length === 0);
    ok('client.getFavorites: empty token → missing_token', fav.ok === false && fav.error.code === 'missing_token');
  }

  // me with a token parses MeResponse (entitlements are plain strings)
  {
    const ff = fakeFetch({ status: 200, body: { user: sampleUser, entitlements: ['online_catalog'] } });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff });
    const r = await client.getMe('TOK');
    ok('client.getMe: parsed MeResponse', r.ok === true && r.data.user.id === 'u1' && r.data.entitlements[0] === 'online_catalog');
  }

  // favorites add/remove: correct method + path, idempotent (no schema → raw ok)
  {
    const ff = fakeFetch({ status: 204, body: undefined });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff });
    const add = await client.addFavorite('c1', 'TOK');
    const rem = await client.removeFavorite('c1', 'TOK');
    ok('client.addFavorite: PUT /v1/favorites/c1', ff.calls[0].init.method === 'PUT' && ff.calls[0].url === BASE + '/v1/favorites/c1');
    ok('client.removeFavorite: DELETE /v1/favorites/c1', ff.calls[1].init.method === 'DELETE' && ff.calls[1].url === BASE + '/v1/favorites/c1');
    ok('client.addFavorite: 204 → ok with null data', add.ok === true && add.data === null && rem.ok === true);
  }

  // 401 from a protected endpoint surfaces as an api error with status
  {
    const ff = fakeFetch({ status: 401, body: { error: { code: 'unauthorized', message: 'session expired' } } });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff });
    const r = await client.getFavorites('STALE');
    ok('client: 401 → api error w/ status', r.ok === false && r.error.kind === 'api' && r.error.status === 401 && r.error.code === 'unauthorized');
  }

  // network failure → normalized network error
  {
    const ff = fakeFetch(new Error('getaddrinfo ENOTFOUND'));
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff });
    const r = await client.health();
    ok('client: fetch throw → network error', r.ok === false && r.error.kind === 'network' && r.error.code === 'network');
  }

  // exchangeAuth: POSTs JSON body + validates required fields
  {
    const ff = fakeFetch({ status: 200, body: { session_token: SESSION, user: sampleUser } });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff });
    const r = await client.exchangeAuth({ code: 'CODE', pkce_verifier: 'VERIFIER', client_label: 'Lumina on PC' });
    ok('client.exchangeAuth: POST /v1/auth/exchange w/ JSON body', (() => {
      const call = ff.calls[0];
      const sentBody = JSON.parse(call.init.body);
      return call.init.method === 'POST' && call.url === BASE + '/v1/auth/exchange'
        && call.init.headers['Content-Type'] === 'application/json' && sentBody.code === 'CODE';
    })());
    ok('client.exchangeAuth: parsed AuthExchangeResponse', r.ok === true && r.data.session_token === SESSION);
    const bad = await client.exchangeAuth({ code: 'CODE' });
    ok('client.exchangeAuth: missing verifier → request error', bad.ok === false && bad.error.code === 'invalid_request');
  }

  console.log('\nAll ' + passed + ' cloud-client tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
