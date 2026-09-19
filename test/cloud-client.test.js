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

  // -------------------------------------------------------------------------
  // BUG-030 — every call has a deadline, and a missed one says so.
  //
  // This file had no timeout and no AbortSignal anywhere, so a stalled backend held
  // the caller for undici's own default, around five minutes. That is what made the
  // sign-in strip sit there while its Cancel could not reach the token exchange.
  //
  // The signal is injected here rather than waited on: a test that actually waits
  // fifteen seconds is a test nobody runs.
  // -------------------------------------------------------------------------
  {
    const abortError = (name) => Object.assign(new Error('aborted'), { name });
    const seen = [];
    const spySignal = (ms) => { seen.push(ms); return { spy: ms }; };

    // Every method, not a sample: a deadline that covers most calls is the kind of
    // guard that looks present and is missing exactly where it matters.
    const ff = fakeFetch({ status: 200, body: { ok: true } });
    const client = CL.createClient({ baseUrl: BASE, fetchImpl: ff, makeTimeoutSignal: spySignal });
    const TOKEN = 'tok';
    await client.health();
    await client.getCatalog({});
    await client.getContent('c1');
    await client.getDownload('c1');
    await client.getMe(TOKEN);
    await client.logout(TOKEN);
    await client.getFavorites(TOKEN);
    await client.addFavorite('c1', TOKEN);
    await client.removeFavorite('c1', TOKEN);
    await client.exchangeAuth({ code: 'C', pkce_verifier: 'V' });
    ok('every call is given a deadline', seen.length === ff.calls.length && ff.calls.length === 10);
    ok('and the deadline actually reaches fetch', ff.calls.every((c) => c.init.signal && c.init.signal.spy > 0));
    ok('a deadline is a real number of milliseconds, not a flag',
      seen.every((ms) => Number.isFinite(ms) && ms >= 1000));

    // The calls a person is actively waiting on get the shorter budget. Checked by
    // position so a method silently losing its override cannot hide behind the others.
    const short = [seen[4], seen[5], seen[7], seen[8], seen[9]]; // me, logout, add, remove, exchange
    const long = [seen[0], seen[1], seen[2], seen[3], seen[6]];
    ok('the calls a person waits on get the shorter budget',
      short.every((ms) => ms === CL.SHORT_TIMEOUT_MS));
    ok('and the rest get the ordinary one', long.every((ms) => ms === CL.DEFAULT_TIMEOUT_MS));
    ok('the two budgets are actually different, or the split means nothing',
      CL.SHORT_TIMEOUT_MS < CL.DEFAULT_TIMEOUT_MS);

    // A missed deadline is its own answer. It used to be indistinguishable from a
    // dead connection, and the tab then told the user to check their internet.
    for (const name of ['TimeoutError', 'AbortError']) {
      const c = CL.createClient({
        baseUrl: BASE,
        fetchImpl: fakeFetch(abortError(name)),
        makeTimeoutSignal: spySignal,
      });
      const r = await c.health();
      ok(`a ${name} is reported as a timeout, not as a broken connection`,
        r.ok === false && r.error.code === 'timeout' && r.error.kind === 'network');
    }
    const offline = await CL.createClient({
      baseUrl: BASE, fetchImpl: fakeFetch(new Error('getaddrinfo ENOTFOUND')), makeTimeoutSignal: spySignal,
    }).health();
    ok('an ordinary network failure still says network', offline.ok === false && offline.error.code === 'network');

    // Headers arrived, body never did. Swallowed, this looked like a 200 with an empty
    // body, and the contract check then blamed the server for sending nonsense.
    const stalledBody = async () => ({ status: 200, async text() { throw abortError('TimeoutError'); } });
    const stalled = await CL.createClient({
      baseUrl: BASE, fetchImpl: stalledBody, makeTimeoutSignal: spySignal,
    }).getMe('tok');
    ok('a body that never arrives is a timeout, not a broken contract',
      stalled.ok === false && stalled.error.code === 'timeout');

    // A body that is merely junk must still be tolerated exactly as before.
    const junk = await CL.createClient({
      baseUrl: BASE,
      fetchImpl: async () => ({ status: 500, async text() { return '<html>oops</html>'; } }),
      makeTimeoutSignal: spySignal,
    }).health();
    ok('a junk body is still an ordinary server error', junk.ok === false && junk.error.kind !== 'network');

    // And the deadline is settable, because staging and a slow connection are not the
    // same question as production.
    const custom = [];
    await CL.createClient({
      baseUrl: BASE,
      fetchImpl: fakeFetch({ status: 200, body: { ok: true } }),
      timeoutMs: 2500,
      makeTimeoutSignal: (ms) => { custom.push(ms); return null; },
    }).health();
    ok('the default deadline can be overridden by the caller', custom[0] === 2500);
  }

  // -------------------------------------------------------------------------
  // BUG-034 — an answer that stopped arriving part-way is a broken connection, not a
  // server that sent nonsense.
  //
  // readBody swallowed every failure of the body read except a missed deadline and
  // handed back null. For a success that read as "a 200 with nothing in it": the schema
  // check then blamed the server for breaking the contract, and a call without a schema
  // reported the cut-off answer as a success.
  //
  // Driven through a real local HTTP server and the real fetch, because the point is
  // what undici actually throws when the connection drops (TypeError 'terminated'), not
  // what a fake claims it throws. Nothing here talks to the production Cloud.
  // -------------------------------------------------------------------------
  {
    const http = require('http');
    const valid = JSON.stringify({ user: sampleUser, entitlements: [] });
    const cutOff = (res, status, body, headers) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.write(body.slice(0, 10));
      setTimeout(() => res.socket.destroy(), 20);
    };
    const routes = {
      // The headers promise more than ever arrives, then the connection drops.
      'cut-length': (res) => cutOff(res, 200, valid, { 'Content-Length': String(valid.length) }),
      // The same drop without a length: the closing chunk never comes.
      'cut-chunked': (res) => cutOff(res, 200, valid, {}),
      'cut-401': (res) => {
        const body = JSON.stringify({ error: { code: 'unauthorized', message: 'session expired' } });
        cutOff(res, 401, body, { 'Content-Length': String(body.length) });
      },
      'malformed': (res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(valid.slice(0, 20)); },
      'valid': (res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(valid); },
      'empty': (res) => { res.writeHead(204); res.end(); },
      // Headers, one byte, then silence with the connection left open.
      'stall': (res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); },
    };
    const server = http.createServer((req, res) => {
      const route = routes[String(req.url).split('/')[1]];
      if (route) route(res); else { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    const base = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;
    // No fetchImpl: the client uses the global fetch, exactly as main.js creates it. A real
    // deadline stays on so a regression fails the test instead of hanging it.
    const at = (route, ms = 5000) => CL.createClient({
      baseUrl: `${base}/${route}`, makeTimeoutSignal: () => AbortSignal.timeout(ms),
    });
    try {
      for (const route of ['cut-length', 'cut-chunked']) {
        const r = await at(route).getMe('tok');
        ok(`a success cut off mid-body (${route}) is a broken connection, not a broken contract`,
          r.ok === false && r.error.kind === 'network' && r.error.code === 'network');
      }
      const fav = await at('cut-length').addFavorite('c1', 'tok');
      ok('a call without a schema does not report a cut-off answer as success',
        fav.ok === false && fav.error.kind === 'network');
      // The status line did arrive. A 401 must still reach the caller as a 401, or it will
      // not drop the dead session.
      const denied = await at('cut-401').getFavorites('tok');
      ok('a server error keeps its status when only its explanation was cut off',
        denied.ok === false && denied.error.kind === 'http' && denied.error.status === 401);
      const junk = await at('malformed').getMe('tok');
      ok('a complete body that is not JSON is still the server breaking the contract',
        junk.ok === false && junk.error.kind === 'contract' && junk.error.code === 'invalid_response');
      const good = await at('valid').getMe('tok');
      ok('a whole valid answer still parses', good.ok === true && good.data.user.id === 'u1');
      const empty = await at('empty').addFavorite('c1', 'tok');
      ok('an empty 204 is still a success', empty.ok === true && empty.data === null);
      const late = await at('stall', 150).getMe('tok');
      ok('a body that stops without the connection dropping is still a timeout',
        late.ok === false && late.error.code === 'timeout');
    } finally {
      server.closeAllConnections();
      server.close();
    }

    // The same line for a response that only offers json(), where both failures arrive
    // through one call: its parse error is junk, anything else is the connection.
    const jsonOnly = (thrown) => CL.createClient({
      baseUrl: BASE,
      fetchImpl: async () => ({ status: 200, async json() { throw thrown; } }),
      makeTimeoutSignal: () => null,
    });
    const unparsable = await jsonOnly(new SyntaxError('Unexpected end of JSON input')).getMe('tok');
    ok('json(): a parse error is still a broken contract',
      unparsable.ok === false && unparsable.error.kind === 'contract');
    const dropped = await jsonOnly(new TypeError('terminated')).getMe('tok');
    ok('json(): a dropped connection is a network error',
      dropped.ok === false && dropped.error.kind === 'network');

    // Keeping a failure status must not swallow a missed deadline: a server error whose
    // body never arrives was a timeout before BUG-034 and stays one.
    const stalledError = await CL.createClient({
      baseUrl: BASE,
      fetchImpl: async () => ({ status: 503, async text() { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); } }),
      makeTimeoutSignal: () => null,
    }).health();
    ok('a failure status whose body misses the deadline is still a timeout',
      stalledError.ok === false && stalledError.error.code === 'timeout');
  }

  console.log('\nAll ' + passed + ' cloud-client tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
