'use strict';

// Pure OAuth / PKCE helpers for the Google sign-in flow (C4). The interactive parts
// (loopback HTTP server, opening the system browser, safeStorage token store) live in
// main.js; these pieces are pure so they can be unit-tested without Electron or network
// (see test/cloud-oauth.test.js). Handshake reference: Znada-Cloud/tests/spikes/google-oauth.mjs.

const crypto = require('crypto');

// Backend requirement: PKCE verifier/challenge must match this (base64url, 43–128 chars).
const PKCE_RE = /^[A-Za-z0-9_-]{43,128}$/;

// PKCE pair: verifier = base64url(32 random bytes) → 43 chars; challenge =
// base64url(sha256(verifier)) → 43 chars. randomBytesFn is injectable for tests.
function generatePkce(randomBytesFn = crypto.randomBytes) {
  const verifier = Buffer.from(randomBytesFn(32)).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function isValidPkce(s) {
  return typeof s === 'string' && PKCE_RE.test(s);
}

// Extract the one-time exchange code from the loopback redirect request URL
// (e.g. "/?code=abc"). Returns null when absent or unparseable.
function parseLoopbackCode(reqUrl) {
  try {
    const u = new URL(reqUrl, 'http://127.0.0.1');
    const code = u.searchParams.get('code');
    return code || null;
  } catch {
    return null;
  }
}


// SEC-002, slice 3 (the half that needs nothing from the backend). What this listener is
// willing to treat as the browser coming back.
//
// It used to accept ANY request that carried a `code` parameter, by any method, from any
// origin that could reach the port. A loopback listener is reachable by every program on
// the machine, and a page in any browser can be made to fetch `http://127.0.0.1:<port>/`
// - that is the whole reason RFC 8252 asks for the request to be pinned down. So:
//
//   * GET only. A sign-in redirect is a navigation; nothing else has any business here.
//   * The Host header must be the loopback address and OUR port, spelled numerically. A
//     request that arrives naming a hostname is a name that resolved to 127.0.0.1, which
//     is what a DNS rebinding attempt looks like.
//   * A code must actually be present.
//
// What this still cannot do is prove the code belongs to the sign-in the user started.
// That needs something the desktop can send and get back - `state`, or a secret in the
// callback path - and today it sends neither: the start request carries only the port
// and the PKCE challenge, and the backend builds the redirect address itself. Until that
// changes the binding is missing, and saying so plainly is better than a check that
// looks like one.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

// What the backend accepts and echoes back untouched (its contract, not ours to widen).
const STATE_RE = /^[A-Za-z0-9_-]{8,128}$/;

// One per sign-in, and never reused. 32 random bytes as base64url is 43 characters, well
// inside what the backend accepts.
function generateState(randomBytesFn = crypto.randomBytes) {
  return Buffer.from(randomBytesFn(32)).toString('base64url');
}

function isValidState(s) {
  return typeof s === 'string' && STATE_RE.test(s);
}

// Compared without letting the comparison itself leak how much of it matched. The value
// is not a secret the way a token is, but a timing-safe compare costs nothing here and
// removes the question entirely.
function sameState(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function parseLoopbackState(reqUrl) {
  try {
    return new URL(reqUrl, 'http://127.0.0.1').searchParams.get('state') || null;
  } catch {
    return null;
  }
}

function parseLoopbackRequest(req, { port, state } = {}) {
  const method = String((req && req.method) || '').toUpperCase();
  if (method !== 'GET') return { ok: false, reason: 'method' };
  const rawHost = String(((req && req.headers) || {}).host || '');
  const cut = rawHost.lastIndexOf(':');
  const host = cut > 0 ? rawHost.slice(0, cut) : rawHost;
  const hostPort = cut > 0 ? rawHost.slice(cut + 1) : '';
  if (!LOOPBACK_HOSTS.has(host)) return { ok: false, reason: 'host' };
  if (!port || hostPort !== String(port)) return { ok: false, reason: 'port' };
  const code = parseLoopbackCode(req && req.url);
  if (!code) return { ok: false, reason: 'code' };
  // SEC-002 slice 3, the half that needed the backend. `state` is ours, sent at the start
  // and echoed back on the redirect, and it is what ties this answer to the sign-in the
  // user actually began. PKCE alone does not: the challenge travels in the address bar of
  // the system browser, so anyone who can read it can start a flow of their own with the
  // same challenge, sign in as themselves and hand us that code - and the exchange would
  // succeed. The user would end up quietly signed in to somebody else's account.
  //
  // A missing echo is a mismatch, not a pass. Both deployments send it back; nothing that
  // omits it is a redirect meant for this sign-in.
  if (!isValidState(state)) return { ok: false, reason: 'noState' };
  if (!sameState(parseLoopbackState(req && req.url), state)) return { ok: false, reason: 'state' };
  return { ok: true, code };
}

module.exports = {
  PKCE_RE, generatePkce, isValidPkce, parseLoopbackCode, parseLoopbackRequest, LOOPBACK_HOSTS,
  STATE_RE, generateState, isValidState, sameState, parseLoopbackState,
};
