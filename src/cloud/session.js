'use strict';

// CODE-001 1.3. Owns the bearer, profile, session generation, encrypted storage and
// the single OAuth attempt. IPC authority and library downloads stay in main.js.
// Dependencies are read on each call; no Electron import or module-level state.
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

function createCloudSession(deps) {
  const { cloudClient, cloudCapability, getUserDataPath, safeStorage, openExternal, publishState, cloudOauth, buildGoogleStartUrl } = deps;
  // ---- Znada Cloud session (C4) -------------------------------------------------
  // The session token lives ONLY in main: encrypted at rest via safeStorage (DPAPI),
  // never in config.json and never sent to the renderer. The renderer gets only the
  // public profile + entitlements through cloudAuthState().
  let _cloudToken = null;          // in-memory bearer token (never crosses IPC to renderer)
  let _cloudUser = null;           // cached { user, entitlements } from /v1/me
  let _cloudSessionRevision = 0;   // changes only when the bearer session itself changes
  const cloudSessionPath = () => path.join(getUserDataPath(), 'cloud-session.bin');
  const defaultCloudSessionStorage = Object.freeze({
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p) => fs.readFileSync(p),
    mkdirSync: (p, options) => fs.mkdirSync(p, options),
    writeFileSync: (p, bytes) => fs.writeFileSync(p, bytes),
    renameSync: (from, to) => fs.renameSync(from, to),
    rmSync: (p, options) => fs.rmSync(p, options),
  });
  let cloudSessionStorage = defaultCloudSessionStorage;

  function loadStoredToken() {
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const p = cloudSessionPath();
      if (!cloudSessionStorage.existsSync(p)) return null;
      return safeStorage.decryptString(cloudSessionStorage.readFileSync(p)) || null;
    } catch { return null; }
  }
  function saveStoredToken(token) {
    const p = cloudSessionPath();
    const temp = `${p}.tmp`;
    try {
      // A Cloud account is either durable as one token/profile pair or is not published.
      // Writing beside the target and renaming in the same directory keeps the previous
      // encrypted bearer intact across write/rename failures and process interruption.
      if (!safeStorage.isEncryptionAvailable()) return false;
      const encrypted = safeStorage.encryptString(token);
      cloudSessionStorage.mkdirSync(path.dirname(p), { recursive: true });
      cloudSessionStorage.writeFileSync(temp, encrypted);
      cloudSessionStorage.renameSync(temp, p);
      return true;
    } catch (err) {
      try { cloudSessionStorage.rmSync(temp, { force: true }); } catch {}
      console.error('cloud token save:', err);
      return false;
    }
  }
  function clearStoredToken() {
    try {
      cloudSessionStorage.rmSync(cloudSessionPath(), { force: true });
      return true;
    } catch (err) {
      console.error('cloud token clear:', err);
      return false;
    }
  }

  // Every async protected call carries the identity of the session whose bearer token it
  // sent. Token text alone is not enough: a logout/sign-in cycle may eventually receive
  // the same token again, while a late answer from the older cycle must still be inert.
  function cloudSessionSnapshot() {
    return { token: _cloudToken, revision: _cloudSessionRevision };
  }
  function cloudSessionIsCurrent(session) {
    return !!session
      && session.revision === _cloudSessionRevision
      && session.token === _cloudToken;
  }
  function replaceCloudSession(token, user, { persist = false, broadcast = false } = {}) {
    const nextToken = token || null;
    let persisted = true;
    if (persist) {
      // The two directions are NOT symmetric, and treating them as one is what stranded
      // the account. Failing to WRITE a token means the sign-in would not survive a
      // restart, so refusing is honest. Failing to DELETE one — an antivirus holding the
      // file, a roaming profile, a locked disk — says nothing about whether the user is
      // still signed in, and refusing there left the app believing he was: every request
      // then failed, and signing out again failed the same way, with no way back short of
      // reinstalling. Forgetting the session in memory is what the user asked for, and it
      // always happens; the leftover file is reported, not obeyed.
      persisted = nextToken ? saveStoredToken(nextToken) : clearStoredToken();
      if (nextToken && !persisted) return false;
    }
    _cloudToken = nextToken;
    _cloudUser = _cloudToken && user ? user : null;
    _cloudSessionRevision++;
    if (broadcast) broadcastCloudSession();
    return true;
  }

  // Renderer-safe auth state (no token).
  function cloudAuthState() {
    return {
      available: !!cloudCapability().apiBase,
      signedIn: !!_cloudToken && !!_cloudUser,
      user: _cloudUser ? _cloudUser.user : null,
      entitlements: _cloudUser ? _cloudUser.entitlements : [],
      // BUG-031. Whether a sign-in is running and whether it can still be called off. It
      // used to live only in the window that pressed Sign in, so a window created meanwhile
      // never learned it. Two booleans on purpose: nothing of the attempt itself - its
      // state, challenge or port - crosses to the renderer.
      signingIn: !!activeCloudSignin,
      signinCancellable: !!(activeCloudSignin && typeof activeCloudSignin.cancel === 'function'),
    };
  }
  function broadcastCloudSession() {
    publishState(cloudAuthState());
  }

  // A protected call returned a normalized result. If it's a 401 for the SAME session
  // that made the call, the session is dead: drop it everywhere and tell the renderer.
  // A late 401 from an older bearer must not sign out the account that replaced it.
  // Returns true if the result itself was an auth error, whether or not it was stale.
  function cloudHandleAuthError(result, session) {
    if (result && result.ok === false && result.error && result.error.status === 401) {
      if (cloudSessionIsCurrent(session)) {
        replaceCloudSession(null, null, { persist: true, broadcast: true });
      }
      return true;
    }
    return false;
  }

  // Bring up a one-shot loopback listener, open the system browser at the Google start
  // URL, and resolve with the one-time exchange code from the redirect (RFC 8252).
  // SEC-002, slice 3. One sign-in at a time, and the listener belongs to it.
  //
  // Two presses used to mean two listeners, two browser tabs and two codes in flight, with
  // no way to say which answer belonged to which attempt. Now a second press is refused
  // until the first transaction finishes. Its loopback socket and five-minute browser timer
  // end at redirect/cancel/timeout; the same single-flight then remains occupied for the
  // separately bounded exchange and /me requests.
  let activeCloudSignin = null;

  function cancelCloudSignin() {
    if (!activeCloudSignin || typeof activeCloudSignin.cancel !== 'function') return false;
    return activeCloudSignin.cancel();
  }

  function runLoopbackSignin(challenge, state, attempt) {
    return new Promise((resolve, reject) => {
      let ourPort = 0;
      const server = http.createServer((req, res) => {
        // Not "does the URL carry a code": the request has to look like the browser coming
        // back to US, for THIS sign-in. See src/cloud/oauth.js for what that means.
        const parsed = cloudOauth.parseLoopbackRequest(req, { port: ourPort, state });
        res.writeHead(parsed.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loopbackHtml(parsed.ok));
        if (parsed.ok) { cleanup(); resolve(parsed.code); }
        else console.error(`[Cloud] refused a loopback request (${parsed.reason})`);
      });
      let done = false;
      const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 5 * 60 * 1000);
      function cleanup() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { server.close(); } catch {}
        attempt.cleanup = null;
        attempt.cancel = null;
      }
      attempt.cleanup = cleanup;
      attempt.cancel = () => {
        if (done) return false;
        cleanup();
        reject(new Error('cancelled'));
        return true;
      };
      server.on('error', (err) => { cleanup(); reject(err); });
      server.listen(0, '127.0.0.1', () => {
        ourPort = /** @type {import('net').AddressInfo} */ (server.address()).port;
        const url = buildGoogleStartUrl(cloudCapability().apiBase, { port: ourPort, challenge, state });
        Promise.resolve(openExternal(url)).catch((err) => { cleanup(); reject(err); });
      });
    });
  }

  function loopbackHtml(okCode) {
    const msg = okCode ? 'Готово! Можете закрыть эту вкладку и вернуться в Znada.' : 'Код авторизации не получен. Вернитесь в Znada и попробуйте снова.';
    return `<!doctype html><meta charset="utf-8"><title>Znada</title><body style="font-family:Segoe UI,system-ui,sans-serif;background:#fafafa;color:#2e3436;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="margin:0 0 8px">Znada</h2><p>${msg}</p></div></body>`;
  }

  // Current auth state (renderer-safe). If a stored token exists but the profile isn't
  // loaded yet, validate it against /v1/me (a dead/expired token is dropped silently).
  async function readSession() {
    const client = cloudClient();
    if (_cloudToken && !_cloudUser && client) {
      const session = cloudSessionSnapshot();
      const me = await client.getMe(session.token);
      if (me.ok) {
        if (cloudSessionIsCurrent(session)) _cloudUser = me.data;
      } else if (cloudHandleAuthError(me, session)) { /* current token cleared; stale answer ignored */ }
    }
    return cloudAuthState();
  }

  // Google sign-in: PKCE + loopback + system browser + exchange → store token, load /me.
  async function runCloudSignin() {
    const client = cloudClient();
    if (!client) return { ok: false, error: 'unavailable' };
    // SEC-002. A second press while one is still going would open a second listener and a
    // second browser tab, and neither answer could be tied to the press that asked for it.
    if (activeCloudSignin) return { ok: false, error: 'busy' };
    const attempt = { cleanup: null, cancel: null };
    activeCloudSignin = attempt;
    try {
      const { verifier, challenge } = cloudOauth.generatePkce();
      // One per press. The backend stores it and hands it back on the redirect; anything
      // that comes to the listener without it is not this sign-in.
      const state = cloudOauth.generateState();
      const browserAnswer = runLoopbackSignin(challenge, state, attempt);
      // BUG-031. Every open window is told, not only the one that pressed the button. Sent
      // after runLoopbackSignin, which hands the attempt its cancel synchronously, so the
      // announcement already carries the way out.
      broadcastCloudSession();
      const code = await browserAnswer;
      // The listener is down and the exchange cannot be called back: windows drop the Cancel.
      broadcastCloudSession();
      const ex = await client.exchangeAuth({ code, pkce_verifier: verifier, client_label: `Znada on ${os.hostname()}` });
      if (!ex.ok) return { ok: false, error: ex.error.code };
      // Keep the exchange answer local until /me validates that exact bearer and returns
      // its authoritative profile. No failed validation may replace the previous live or
      // persisted session — including a definite 401 and a transient/server failure.
      const candidateToken = ex.data.session_token;
      const me = await client.getMe(candidateToken);
      if (!me.ok) return { ok: false, error: me.error.code };
      if (!replaceCloudSession(candidateToken, me.data, { persist: true, broadcast: true })) {
        return { ok: false, error: 'storage' };
      }
      return { ok: true };
    } catch (err) {
      // A sign-in the user called off is not a failure, and the window already has a
      // branch that stays silent for it — one that could never fire while every rejection
      // arrived here as 'signin_failed'.
      const text = String((err && err.message) || '');
      const msg = /timeout/.test(text) ? 'timeout'
        : /cancelled/.test(text) ? 'cancelled' : 'signin_failed';
      console.error('cloud signin:', err);
      return { ok: false, error: msg };
    } finally {
      // The socket is only the browser half. The single-flight covers the whole
      // transaction through exchange + /me, so another attempt cannot race its commit.
      if (attempt.cleanup) attempt.cleanup();
      if (activeCloudSignin === attempt) {
        activeCloudSignin = null;
        // Success, failure, cancel and timeout all end here, and so does telling the
        // windows that the sign-in is over.
        broadcastCloudSession();
      }
    }
  }

  async function signin() {
    const result = await runCloudSignin();
    // BUG-031. The state is read after the slot is released. Read inside the transaction it
    // still reported this sign-in as running, and the window that pressed the button
    // stores this reply after the announcement that the sign-in had ended.
    if (result.ok) result.state = cloudAuthState();
    return result;
  }

  // A sign-in nobody finished used to hold the window for the full five minutes: the strip
  // said "Opening your browser…", drew no button, and the only cure was quitting — because
  // before-quit was the sole production caller of cancelCloudSignin. The machinery was
  // already here and already tested; what was missing was a door from the window.
  //
  // `cancelled` is the honest half. Past the redirect the listener is already down
  // (runLoopbackSignin cleans up before it resolves) and the token exchange cannot be
  // called back, so the window is told the difference rather than shown a control that
  // silently does nothing.
  function cancelSignin() {
    // Through cancelCloudSignin, never by nulling the slot: the SEC-002 single-flight
    // invariant depends on cleanup() closing the socket. After the redirect the socket
    // is already closed, so cancellation honestly says false while the transaction stays
    // busy until its bounded exchange/profile requests finish.
    return { ok: true, cancelled: cancelCloudSignin() };
  }

  // Sign out: revoke the session server-side (best effort) and drop the local token.
  async function signout() {
    const client = cloudClient();
    const token = _cloudToken;
    // The session is forgotten whatever the disk does. Making the deletion the commit
    // point meant a file we could not remove — an antivirus holding it, a roaming profile
    // — kept the user signed in to an account he had just left, with every request failing
    // and a second attempt failing the same way.
    //
    // Revoking remotely is what makes a leftover file harmless: the token stops working on
    // the service, so finding it again after a restart signs nobody in. That is why the
    // revoke now happens even when the delete did not, rather than being skipped with it.
    replaceCloudSession(null, null, { persist: true, broadcast: true });
    if (client && token) { try { await client.logout(token); } catch {} }
    return { ok: true, error: null, state: cloudAuthState() };
  }

  // Cloud favorites (C5) — account-synced, distinct from the local Library favorites.
  // All require a session; a 401 drops it. add/remove are idempotent on the backend.
  async function favorites() {
    const client = cloudClient();
    if (!client) return { items: [], error: 'unavailable' };
    if (!_cloudToken) return { items: [], error: 'missing_token' };
    const session = cloudSessionSnapshot();
    const r = await client.getFavorites(session.token);
    if (!cloudSessionIsCurrent(session)) return { items: [], error: 'session_changed' };
    if (!r.ok) { cloudHandleAuthError(r, session); return { items: [], error: r.error.code }; }
    return { items: r.data.items, error: null };
  }

  async function favorite(id, on) {
    const client = cloudClient();
    if (!client) return { ok: false, error: 'unavailable' };
    if (!_cloudToken) return { ok: false, error: 'missing_token' };
    if (!id) return { ok: false, error: 'badItem' };
    const session = cloudSessionSnapshot();
    const r = on ? await client.addFavorite(id, session.token) : await client.removeFavorite(id, session.token);
    if (!cloudSessionIsCurrent(session)) return { ok: false, error: 'session_changed' };
    if (!r.ok) { cloudHandleAuthError(r, session); return { ok: false, error: r.error.code }; }
    return { ok: true, error: null };
  }

  function appSession() {
    const client = cloudClient();
    if (!client) return null;
    const session = cloudSessionSnapshot();
    return {
      client,
      token: session.token || null,
      // Whether THIS account may be shown adult content. Carried with the session because
      // it belongs to the account, and asking for what the server will refuse anyway just
      // spends a request to be told no.
      explicitAllowed: !!(_cloudUser && _cloudUser.user && _cloudUser.user.explicit_opt_in),
      // A successful response is account-owned too. The shared provider path checks this
      // after await so catalogue A cannot be rendered after the user moved to account B.
      isCurrent: () => cloudSessionIsCurrent(session),
      // A refused session has to be dropped where sessions are kept, not inside a site.
      onAuthError: (res) => cloudHandleAuthError(res, session),
    };
  }

  return {
    loadStoredToken, replaceCloudSession, cloudSessionSnapshot, cloudSessionIsCurrent,
    cloudHandleAuthError, cloudAuthState, cancelCloudSignin, appSession,
    readSession, signin, cancelSignin, signout, favorites, favorite,
    signinInFlight: () => !!activeCloudSignin,
    setStorage: (overrides) => {
      cloudSessionStorage = { ...defaultCloudSessionStorage, ...(overrides || {}) };
    },
  };
}

module.exports = { createCloudSession };
