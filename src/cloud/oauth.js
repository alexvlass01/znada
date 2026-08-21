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

module.exports = { PKCE_RE, generatePkce, isValidPkce, parseLoopbackCode };
