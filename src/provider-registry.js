'use strict';

// ONL-011. The one list of picture sites Znada knows about, and the one place that
// answers "is this address one of theirs?".
//
// Before this, that question was answered by six separate functions in src/online.js,
// each carrying the same `if (provider === 'wallhaven') … 'danbooru' … 'gelbooru'`
// ladder. Those lists are the app's allow-list: the only thing stopping it from being
// talked into fetching from somewhere else. Adding a fourth site meant editing all six,
// and a forgotten one would be a hole rather than an untidiness.
//
// Each site declares its addresses as DATA, next to its own adapter. The declaration is
// deliberately readable without executing any of that adapter's code — the boundary has
// to be checkable by inspection, not by running the thing it is guarding.
//
// Retired sites stay in this list. What is written into a user's library is the page
// ADDRESS of a picture he saved, so a site we stop asking for new content must still be
// recognised, or "open the source page" would break on everything he already has. That
// is why removal is a `status`, never a deletion. It also means the id may be renamed
// safely while the hosts may not.

const wallhaven = require('./wallhaven');
const gelbooru = require('./gelbooru');
const danbooru = require('./danbooru');
const znada = require('./cloud/provider');

// A provider is its DECLARATION plus the handful of things it knows how to DO. The two
// halves are kept apart on purpose: the declaration is data and can be read — the
// address lists especially — without executing any of the code beside it, while the
// hooks are ordinary functions because a real site's awkwardness does not fit in a form.
//
// Every hook is optional. What a site can do is stated in its declaration, and the
// handler asks only those who said they can.
const HOOKS = Object.freeze([
  'search',
  'enrich',
  'findByFingerprint',
  'suggestTags',
  'tagTypesFor',
  'loadCredentials',
  'resetState',
]);

function describe(module) {
  const descriptor = { ...module.PROVIDER };
  for (const hook of HOOKS) {
    if (typeof module[hook] === 'function') descriptor[hook] = module[hook];
  }
  return Object.freeze(descriptor);
}

// Order matters: it is the order providers are asked in, and the first that can answer
// a given question is the primary. Deliberately data rather than a hardcoded pair.
const PROVIDERS = Object.freeze([
  describe(wallhaven),
  describe(gelbooru),
  describe(danbooru),
  // ONL-014c. Our own catalogue is a site like any other from here on. It is last so a
  // public site answers first while it can — the catalogue needs a session, and asking it
  // first would put an account check in front of an ordinary browse.
  describe(znada),
]);

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

// Every list of addresses a provider may declare. Named here so a typo in a declaration
// cannot silently create an empty, permissive-looking category.
const HOST_KINDS = Object.freeze(['page', 'image', 'imageProxyOnly', 'thumb']);

function byId(id) {
  return BY_ID.get(String(id || '')) || null;
}

// Everything we still ask for new content. Retired providers are absent here and
// present everywhere the question is about an address we may already hold.
//
// The list is a parameter so the rule itself can be tested against a retired provider
// without one having to exist yet; production always uses the real registry.
function activeFrom(list) {
  return (Array.isArray(list) ? list : []).filter((p) => p && p.status !== 'retired');
}

function active() {
  return activeFrom(PROVIDERS);
}

function ids() {
  return PROVIDERS.map((p) => p.id);
}

// ONL-013. The sites that can be asked "which post IS this exact file", in the small
// shape `src/metadata-lookup.js` reasons in.
//
// That module used to carry its OWN list of sites — the same two names, written out a
// second time, with a second way of saying "this one needs the bundled key". Two lists
// of the same thing drift: adding a site to one and forgetting the other is silent, and
// the symptom is a feature that simply never fires.
//
// Retired sites are KEPT here and filtered where the question is "who do we ask".
// The journal on disk names the site that answered, so a site we stopped asking must
// still be recognised or an answer already stored would be thrown away as unknown.
function fingerprintProviders(list) {
  return Object.freeze((Array.isArray(list) ? list : PROVIDERS)
    .filter((p) => p && typeof p.findByFingerprint === 'function')
    .filter((p) => p.capabilities && Array.isArray(p.capabilities.fingerprints) && p.capabilities.fingerprints.length)
    .map((p) => Object.freeze({
      id: p.id,
      status: p.status || 'active',
      kinds: Object.freeze([...p.capabilities.fingerprints]),
      // The same fact the search path reads, not a second spelling of it.
      requiresCredentials: !!(p.credentials && p.credentials.required),
    })));
}

function hostList(providerId, kind) {
  const provider = byId(providerId);
  if (!provider || !HOST_KINDS.includes(kind)) return [];
  const list = provider.hosts && provider.hosts[kind];
  return Array.isArray(list) ? list : [];
}

// One entry of an address list. Three forms, and no more — a small vocabulary is what
// keeps this readable as a boundary:
//   'w.wallhaven.cc'                        exactly this host
//   { pattern: /^img\d*\.gelbooru\.com$/i }  hosts matching this shape
//   { host: 'gelbooru.com', path: '/x.php' } this host, but only at this one path
function entryMatches(entry, url) {
  if (typeof entry === 'string') return url.hostname === entry;
  if (!entry || typeof entry !== 'object') return false;
  if (entry.pattern instanceof RegExp) return entry.pattern.test(url.hostname);
  if (typeof entry.host === 'string') {
    if (url.hostname !== entry.host) return false;
    return typeof entry.path === 'string' ? url.pathname === entry.path : true;
  }
  return false;
}

// The rule, over a declaration rather than over an id — so it can be tested with any
// shape, including ones no shipped provider has. Any list that is empty means "nothing
// is allowed here", never "everything": Wallhaven declares no thumbnail hosts precisely
// because main must never fetch one for it.
function matchesDeclaration(hosts, kinds, target) {
  if (!hosts || typeof hosts !== 'object' || !target) return false;
  const wanted = (Array.isArray(kinds) ? kinds : [kinds]).filter((k) => HOST_KINDS.includes(k));
  let url;
  try { url = new URL(String(target)); } catch { return false; }
  for (const kind of wanted) {
    const list = Array.isArray(hosts[kind]) ? hosts[kind] : [];
    for (const entry of list) {
      if (entryMatches(entry, url)) return true;
    }
  }
  return false;
}

// Does `target` belong to this provider, in this role? Retired providers answer too:
// the question is about an address, and addresses the user already holds outlive our
// decision to stop asking a site for new pictures.
function matchesHost(providerId, kinds, target) {
  const provider = byId(providerId);
  return !!provider && matchesDeclaration(provider.hosts, kinds, target);
}

module.exports = {
  PROVIDERS,
  HOOKS,
  HOST_KINDS,
  byId,
  active,
  activeFrom,
  matchesDeclaration,
  ids,
  fingerprintProviders,
  hostList,
  entryMatches,
  matchesHost,
};
