'use strict';

// CODE-001. How Znada reaches an internet site: its credentials, the one way any site
// touches the network, and the headers its hosts require. Search, tag suggestions, the
// fingerprint lookup (META-001) and "Add to Library" all go through here, so none of them
// carries its own copy of a key, a timeout or a User-Agent.
//
// Owns: the credentials each site loaded from its key file, kept for the life of this
// instance. Does not own: which sites the user switched on (the search decides that), or
// the account session itself (handed in as `appSession`, asked fresh every time).
//
// Moved out of main.js unchanged; the comments below are the ones that stood there.

function create(deps = {}) {
  const {
    appSession = () => null,
    // src/provider-registry.js; only its byId() is asked, to find the headers a site declared.
    registry = { byId: () => null },
    userAgent = 'Znada',
    // Looked up at call time, not captured: the tests replace globalThis.fetch after main
    // has loaded, and a copy taken here would quietly bypass their stand-in.
    fetchImpl = (url, init) => fetch(url, init),
    log = console,
  } = deps;

  // Credentials are loaded by the site that needs them, once. Absence is normal: a build
  // without a key simply cannot ask that site, and its group falls through to the next.
  const credentialsCache = new Map();
  function credentials(descriptor) {
    if (!descriptor) return null;
    // ONL-014c. A SESSION is asked for every single time. A key in a file is the same all
    // day; an account session appears and disappears while the app runs, and a cached one
    // would keep a signed-out user looking signed in until the next restart.
    if (descriptor.credentials && descriptor.credentials.kind === 'session') return appSession();
    if (!credentialsCache.has(descriptor.id)) {
      let value = null;
      try {
        value = typeof descriptor.loadCredentials === 'function' ? descriptor.loadCredentials() : null;
      } catch (err) {
        log.error(`${descriptor.id} credentials:`, err);
      }
      credentialsCache.set(descriptor.id, value || null);
    }
    return credentialsCache.get(descriptor.id);
  }

  // BUG-033. Which sites a checkout can reach is a property of the MACHINE: the keys live
  // in gitignored files, so a test says which site is in play instead of inheriting it.
  // `undefined` forgets the override and the next call loads from the file again.
  function setCredentials(id, value) {
    if (value === undefined) credentialsCache.delete(id);
    else credentialsCache.set(id, value);
  }

  // The one way any site reaches the network. Timeouts, headers and the wording of a
  // failure are the handler's business, so a new site inherits all of it and cannot get
  // them subtly wrong. Never throws: a site that breaks must drop out of the round, not
  // take the round down.
  function fetchJson(descriptor) {
    return async (url, opts) => {
      const timeoutMs = Number(opts && opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 15000;
      try {
        const res = await fetchImpl(url, {
          headers: { 'User-Agent': userAgent, ...(descriptor.requestHeaders || {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return { error: String(res.status) };
        return { json: await res.json() };
      } catch (err) {
        return { error: err && err.name === 'TimeoutError' ? 'timeout' : 'network' };
      }
    };
  }

  // What a site's own code is handed for any request it makes.
  function context(descriptor, creds = credentials(descriptor)) {
    return {
      credentials: creds,
      fetchJson: fetchJson(descriptor),
    };
  }

  // Headers a site's own hosts require. Declared by the site (some image hosts refuse a
  // request that does not say where it came from) rather than special-cased here.
  function requestHeaders(item) {
    const descriptor = item ? registry.byId(item.provider) : null;
    return { 'User-Agent': userAgent, ...((descriptor && descriptor.requestHeaders) || {}) };
  }

  // Can adult content be reached at all in THIS build?
  //
  // This used to be the constant `true` with a comment reasoning about which site covers
  // it — a claim that quietly stopped being true when a site was removed or shipped
  // without its key. Computed from the registry it cannot drift. It still describes what
  // is CONFIGURED, not what is reachable this second: a site that is down right now is a
  // separate problem, and pretending otherwise would need failure tracking this does not
  // have.
  // The list is a parameter so the rule can be tested against sites that do not exist —
  // the whole point being that it follows the registry rather than asserting a constant.
  function explicitContentReachableIn(list) {
    return (Array.isArray(list) ? list : []).some((descriptor) => {
      if (!descriptor) return false;
      const explicit = descriptor.capabilities && descriptor.capabilities.explicit;
      if (!explicit || explicit === 'never') return false;
      const needsKey = explicit === 'withCredentials'
        || (descriptor.credentials && descriptor.credentials.required);
      return needsKey ? !!credentials(descriptor) : true;
    });
  }

  return Object.freeze({
    userAgent,
    credentials,
    setCredentials,
    context,
    requestHeaders,
    explicitContentReachableIn,
  });
}

module.exports = { create };
