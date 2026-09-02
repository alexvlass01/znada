'use strict';

// Znada Cloud API client — C1 (clean, testable layer).
//
// PURPOSE: centralise everything about talking to the Znada Cloud `/v1` API —
// URL building, query params, auth headers, ApiError parsing and response
// validation against the vendored contracts (./contracts.cjs). It does NOT touch
// the UI, main.js, the token store or user data. Tokens are passed in as plain
// arguments; this module never stores or reads them (that is C4's job in main).
//
// DESIGN (mirrors src/wallhaven.js + src/wallpaper-host.js conventions):
//   - Pure helpers (joinUrl/buildUrl/authHeaders/parseJsonResponse/…) are exported
//     and unit-tested directly, no network.
//   - createClient({ baseUrl, fetchImpl }) wires those helpers around an INJECTED
//     fetch, so the full request/response flow is tested with a fake fetch (see
//     test/cloud-client.test.js). main.js (C2) will create the client with the real
//     global fetch and the capability-decided baseUrl — it is NOT wired here.
//
// Every method returns a uniform Result:
//   success → { ok: true,  data }
//   failure → { ok: false, error: { code, message, status?, kind } }
//             kind = 'api' | 'http' | 'contract' | 'network' | 'request'
// so callers always branch on one shape. A 401 surfaces as { kind:'api'/'http',
// status:401 } → the caller (C4) decides to drop the session and re-login.

const C = require('./contracts.cjs');

// Staging base URL (only used in dev / manual testing — see cloud_client_integration
// plan). Kept as a constant, never hard-coded per call. main decides which baseUrl
// to actually use; a packaged build must NOT point at staging.
const STAGING_BASE = 'https://lumina-cloud-api-staging.alexvlass01.workers.dev';

const RATINGS = C.ContentRating.options; // ['general','suggestive','explicit']

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------
function ok(data) { return { ok: true, data }; }
function fail(error) { return { ok: false, error }; }
function requestError(code, message) { return fail({ code, message, kind: 'request' }); }

// BUG-030. "The server never answered" is not the same failure as "there is no network",
// and it used to be reported as neither: this file had no deadline at all, so a stalled
// backend held the caller for undici's own default — around five minutes. That is what
// made the sign-in strip sit there with a Cancel that could not reach the exchange.
//
// The distinction is carried in `code` and not in `kind`, so every existing caller that
// branches on kind === 'network' keeps working unchanged.
function isAbortError(err) {
  const name = err && err.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
function networkError(err) {
  if (isAbortError(err)) {
    return fail({ code: 'timeout', message: 'The server did not answer in time.', kind: 'network' });
  }
  return fail({ code: 'network', message: (err && err.message) || 'Network request failed.', kind: 'network' });
}

// How long any one call may take. The picture sites already answer this question the same
// way (src/wallhaven.js, src/gelbooru.js): a full page of results gets the longer budget,
// a small lookup the shorter one. Kept to two values on purpose — a table per endpoint is
// more to keep true than it is worth.
const DEFAULT_TIMEOUT_MS = 15000;
// The calls a person is actively waiting on with nothing else to look at: the token
// exchange and the profile read that follow the browser handshake, and the small
// favourite writes.
const SHORT_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Pure URL / header builders
// ---------------------------------------------------------------------------
function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const p = String(path || '');
  return base + (p.startsWith('/') ? p : '/' + p);
}

// Build a query string, skipping null/undefined/'' so optional params drop out.
function toQueryString(query) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  return p.toString();
}

function buildUrl(baseUrl, path, query) {
  const url = joinUrl(baseUrl, path);
  const qs = toQueryString(query);
  return qs ? `${url}?${qs}` : url;
}

// Authorization header only when a token is given (keeps it off public calls).
function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// X-Lumina-Anon-Id header — only for a well-formed id, so we never send junk. The
// server records anonymous installs by a hash of this (throttled); signed-in users
// are counted by session, so it is harmless to always include it.
const ANON_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
function anonHeaders(anonId) {
  return typeof anonId === 'string' && ANON_ID_RE.test(anonId) ? { 'X-Lumina-Anon-Id': anonId } : {};
}

// Google sign-in start URL (opened in the system browser by C4, not fetched here).
// `state` is optional on the wire and the backend omits it from the redirect when it is
// not sent, byte for byte as before - so an older client keeps working. The desktop always
// sends one now; see parseLoopbackRequest for what it is for.
function buildGoogleStartUrl(baseUrl, { port, challenge, state } = {}) {
  const params = { port, challenge };
  if (state) params.state = state;
  return buildUrl(baseUrl, C.API_PATHS.authGoogleStart, params);
}

function enc(id) { return encodeURIComponent(String(id)); }

// ---------------------------------------------------------------------------
// Pure parameter validation
// ---------------------------------------------------------------------------
// Reject clearly bad catalog input before any network call → returns a Result
// failure ({ kind:'request' }) or null when the input is fine.
function validateCatalogParams({ rating, limit } = {}) {
  if (rating !== undefined && rating !== null && !RATINGS.includes(rating)) {
    return requestError('invalid_request', `Unknown rating "${rating}". Expected one of: ${RATINGS.join(', ')}.`);
  }
  if (limit !== undefined && limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      return requestError('invalid_request', 'limit must be an integer between 1 and 100.');
    }
  }
  return null;
}

// Assemble the catalog query object; buildUrl drops the empties.
function catalogQuery({ rating, cursor, limit, tag } = {}) {
  return { rating, cursor, limit, tag };
}

// ---------------------------------------------------------------------------
// Pure response parsing
// ---------------------------------------------------------------------------
function isOkStatus(status) { return Number(status) >= 200 && Number(status) < 300; }

// Map a non-2xx response body to a normalized error. Canonical `{error:{code,
// message}}` bodies keep the server's stable machine code (kind:'api'); anything
// else becomes a generic http_<status> error (kind:'http').
function normalizeApiError(status, body) {
  const parsed = C.ApiError.safeParse(body);
  if (parsed.success) {
    return { code: parsed.data.error.code, message: parsed.data.error.message, status, kind: 'api' };
  }
  const message = (body && body.error && typeof body.error.message === 'string')
    ? body.error.message
    : `Request failed with HTTP ${status}.`;
  return { code: `http_${status}`, message, status, kind: 'http' };
}

// Core success/failure decision over { status, body }. On 2xx, validate against the
// optional contract schema (mismatch → kind:'contract' rather than a silent pass);
// on non-2xx, normalize the error.
function parseJsonResponse(res, schema) {
  const { status, body } = res || {};
  if (isOkStatus(status)) {
    if (!schema) return ok(body);
    const r = schema.safeParse(body);
    if (r.success) return ok(r.data);
    return fail({ code: 'invalid_response', message: 'Response did not match the expected contract.', status, kind: 'contract' });
  }
  return fail(normalizeApiError(status, body));
}

// ---------------------------------------------------------------------------
// Client factory (injected fetch)
// ---------------------------------------------------------------------------
// Read a fetch Response body as JSON, tolerant of empty bodies (e.g. 204 from an
// idempotent favorite) and non-JSON payloads. Works with both the real Response
// and the test fake (either text() or json()).
async function readBody(res) {
  if (!res) return null;
  if (typeof res.text === 'function') {
    let text;
    // A body that fails to arrive because the deadline expired is a TIMEOUT, not an empty
    // body. Swallowing it here reported a stalled server as a 200 with nothing in it, and
    // the schema check then called it a broken contract.
    try { text = await res.text(); } catch (err) { if (isAbortError(err)) throw err; return null; }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { _raw: text }; }
  }
  if (typeof res.json === 'function') {
    try { return await res.json(); } catch (err) { if (isAbortError(err)) throw err; return null; }
  }
  return null;
}

function createClient({ baseUrl, fetchImpl, anonId, timeoutMs, makeTimeoutSignal } = {}) {
  if (!baseUrl) throw new TypeError('createClient: baseUrl is required');
  const doFetch = fetchImpl || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
  if (typeof doFetch !== 'function') throw new TypeError('createClient: a fetch implementation is required');
  const defaultTimeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  // Injected so a test can prove the deadline is applied without waiting for it, and so
  // this module keeps working where AbortSignal.timeout is missing.
  const timeoutSignal = typeof makeTimeoutSignal === 'function'
    ? makeTimeoutSignal
    : (ms) => (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(ms)
      : undefined);

  // Low-level request: build → fetch → parse, all errors normalized. Every call goes
  // through here, which is the only reason one deadline covers all of them.
  async function request(method, path, opts = {}) {
    const { query, token, json, schema, requireToken } = opts;
    if (requireToken && !token) {
      return requestError('missing_token', 'This action requires a signed-in session.');
    }
    const url = buildUrl(baseUrl, path, query);
    const headers = { Accept: 'application/json', ...anonHeaders(anonId), ...authHeaders(token) };
    const init = { method, headers };
    const ms = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : defaultTimeoutMs;
    const signal = timeoutSignal(ms);
    if (signal) init.signal = signal;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    // The body read is inside the same try: the deadline covers the whole exchange, so a
    // response whose headers arrived and whose body never did is a timeout like any other.
    // Parsing stays outside it, so a contract failure is never reported as a network one.
    let res; let body;
    try {
      res = await doFetch(url, init);
      body = await readBody(res);
    } catch (err) {
      return networkError(err);
    }
    return parseJsonResponse({ status: res.status, body }, schema);
  }

  return {
    request,
    baseUrl,

    // --- public catalog (token only personalizes explicit) ---
    health: () => request('GET', C.API_PATHS.health, { schema: C.HealthResponse }),

    getCatalog: async (opts = {}) => {
      const bad = validateCatalogParams(opts);
      if (bad) return bad;
      return request('GET', C.API_PATHS.catalog, {
        query: catalogQuery(opts), token: opts.token, schema: C.CatalogPage,
      });
    },

    getContent: (id, { token } = {}) => {
      if (!id) return Promise.resolve(requestError('invalid_request', 'content id is required.'));
      return request('GET', `${C.API_PATHS.content}/${enc(id)}`, { token, schema: C.ContentCard });
    },

    getDownload: (id, { token } = {}) => {
      if (!id) return Promise.resolve(requestError('invalid_request', 'content id is required.'));
      return request('GET', `${C.API_PATHS.content}/${enc(id)}/download`, { token, schema: C.DownloadResponse });
    },

    // --- session (token required) ---
    getMe: (token) => request('GET', C.API_PATHS.me, { token, requireToken: true, schema: C.MeResponse, timeoutMs: SHORT_TIMEOUT_MS }),
    logout: (token) => request('POST', C.API_PATHS.logout, { token, requireToken: true, schema: C.LogoutResponse, timeoutMs: SHORT_TIMEOUT_MS }),

    // --- favorites (token required, add/remove idempotent) ---
    getFavorites: (token) => request('GET', C.API_PATHS.favorites, { token, requireToken: true, schema: C.FavoritesResponse }),
    addFavorite: (contentId, token) => {
      if (!contentId) return Promise.resolve(requestError('invalid_request', 'content id is required.'));
      return request('PUT', `${C.API_PATHS.favorites}/${enc(contentId)}`, { token, requireToken: true, timeoutMs: SHORT_TIMEOUT_MS });
    },
    removeFavorite: (contentId, token) => {
      if (!contentId) return Promise.resolve(requestError('invalid_request', 'content id is required.'));
      return request('DELETE', `${C.API_PATHS.favorites}/${enc(contentId)}`, { token, requireToken: true, timeoutMs: SHORT_TIMEOUT_MS });
    },

    // --- auth code exchange (PKCE handshake step 5; see client-integration §2) ---
    exchangeAuth: (payload = {}) => {
      const { code, pkce_verifier } = payload;
      if (!code || !pkce_verifier) {
        return Promise.resolve(requestError('invalid_request', 'code and pkce_verifier are required.'));
      }
      return request('POST', C.API_PATHS.authExchange, { json: payload, schema: C.AuthExchangeResponse, timeoutMs: SHORT_TIMEOUT_MS });
    },
  };
}

module.exports = {
  STAGING_BASE,
  DEFAULT_TIMEOUT_MS,
  SHORT_TIMEOUT_MS,
  // pure helpers
  joinUrl,
  toQueryString,
  buildUrl,
  authHeaders,
  anonHeaders,
  buildGoogleStartUrl,
  validateCatalogParams,
  catalogQuery,
  isOkStatus,
  normalizeApiError,
  parseJsonResponse,
  // factory
  createClient,
};
