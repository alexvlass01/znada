'use strict';

// META-001. Given a fingerprint of a local file, decide WHO to ask, WHETHER to ask at
// all, and what the answer means for the photo's record.
//
// The three decisions are separated on purpose, because each grows differently:
//
//   * WHO — the providers that declared they can be searched by a fingerprint. Adding a
//     perceptual-hash service later is a new entry in a site's declaration, not a new
//     branch in main.js. Ordering is explicit, so "ask the one with credentials first,
//     fall back to the public one" is data rather than an if.
//   * WHETHER — the journal. Every question ever asked is remembered against the
//     FINGERPRINT, not against the photo: two copies of the same file in two folders
//     are one question, asked once, forever. This is the main defence against a ban,
//     and it is also what makes a future mass run resumable instead of starting over.
//   * WHAT IT MEANS — a merge plan computed as pure data, so "would this overwrite
//     something the user typed?" is a unit test and not a thing discovered in
//     production.
//
// Nothing here touches the network or the disk.

const registry = require('./provider-registry');

// ONL-013. Which fingerprint kind each provider indexes, and in what order to try them.
//
// This used to be a SECOND list of sites, written out here by hand beside the one in
// src/provider-registry.js. Two lists of the same thing drift apart quietly: a site
// added to one and forgotten in the other produces no error, only a feature that never
// fires. It is now a view of the single registry — each site declares
// `capabilities.fingerprints` next to everything else it declares, and the order is the
// registry's order, so "ask the one with the key first, fall back to the public one"
// stays data rather than an if.
//
// `requiresCredentials` is not a preference: Gelbooru's API needs the bundled key, so a
// self-build without one has to reach Danbooru or the feature silently does nothing.
// It is read from the same `credentials.required` the search path reads.
const PROVIDERS = registry.fingerprintProviders();

// How long an answer stands before the same question may be asked again.
//
// "Not found" is NOT permanent — catalogues gain posts, and a picture uploaded next
// month should become findable. But re-asking on every click is exactly the traffic
// pattern that gets an application blocked, so a miss rests for a month. An error
// rests for an hour: the host was unreachable, not the picture absent.
const RETRY = Object.freeze({
  absentMs: 30 * 24 * 60 * 60 * 1000,
  errorMs: 60 * 60 * 1000,
});

// A bound, not a filter. Every tag the post carries is kept — which is the point of the
// feature — but an unbounded list from an external service must not be able to grow one
// library record without limit.
const MAX_TAGS = 200;
const MAX_TAG_LENGTH = 80;
const MAX_AUTHOR_LENGTH = 120;

const RATINGS = Object.freeze(['general', 'safe', 'sensitive', 'questionable', 'explicit']);

const STATUSES = Object.freeze(['found', 'absent', 'error']);

// What KIND of thing a tag names, as the catalogue itself classifies it — not as Znada
// guesses. This is the honest answer to "how would you tell a real tag from a
// housekeeping one": we do not, and we do not have to. Every tag is kept; the kind is
// kept alongside it, so a later screen can group them (author / character / series /
// the rest) without another round of requests. Providers speak in these names; the
// numeric encoding Gelbooru uses stops inside its own adapter.
const TAG_TYPES = Object.freeze(['general', 'artist', 'character', 'copyright', 'meta']);

// Who to ASK. A retired site is never asked anything new — and is deliberately still
// KNOWN to providerById below, because the journal on disk names whoever answered.
//
// `opts.providers` exists so that rule can be tested against a retired site without one
// having to exist yet; production always passes nothing and gets the real registry.
function providersFor(kind, opts = {}) {
  const credentials = opts.credentials || {};
  return (Array.isArray(opts.providers) ? opts.providers : PROVIDERS)
    .filter((p) => p && p.status !== 'retired')
    .filter((p) => p.kinds.includes(kind))
    .filter((p) => !p.requiresCredentials || !!credentials[p.id])
    .map((p) => p.id);
}

// Who is RECOGNISED, retired included: an answer already stored under a site we have
// stopped asking must not be thrown away as coming from nobody.
function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

// The journal is keyed by the fingerprint itself, so the same bytes at any path share
// one entry. The kind is spelled into the key rather than implied, so a second kind
// cannot collide with md5.
function journalKey(kind, value) {
  const clean = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!clean || !kind) return '';
  return kind + ':' + clean;
}

function normalizeTagList(raw) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const name = typeof entry === 'string'
      ? entry
      : (entry && typeof entry.name === 'string' ? entry.name : '');
    const clean = String(name).trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const rawType = entry && typeof entry === 'object' ? String(entry.type || '').trim().toLowerCase() : '';
    const type = TAG_TYPES.includes(rawType) ? rawType : '';
    out.push(type ? { name: clean, type } : { name: clean });
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function normalizeRating(raw) {
  const clean = String(raw == null ? '' : raw).trim().toLowerCase();
  return RATINGS.includes(clean) ? clean : '';
}

// The canonical answer, identical in shape whichever provider produced it. Everything
// downstream — the journal, the merge plan, the details sheet — sees only this.
function makeResult(providerId, raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const provider = String(providerId || '').trim();
  if (!provider || !providerById(provider)) return null;
  const postId = String(source.postId == null ? '' : source.postId).trim();
  if (!postId) return null;
  return {
    provider,
    postId,
    page: typeof source.page === 'string' ? source.page : '',
    md5: typeof source.md5 === 'string' ? source.md5.trim().toLowerCase() : '',
    author: String(source.author == null ? '' : source.author).trim().slice(0, MAX_AUTHOR_LENGTH),
    rating: normalizeRating(source.rating),
    tags: normalizeTagList(source.tags),
  };
}

function emptyEntry() {
  return { result: null, providers: {} };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyEntry();
  const providers = {};
  const source = raw.providers && typeof raw.providers === 'object' ? raw.providers : {};
  for (const id of Object.keys(source)) {
    const value = source[id];
    if (!providerById(id) || !value || typeof value !== 'object') continue;
    const at = Number(value.at);
    const status = String(value.status || '');
    if (!Number.isFinite(at) || at <= 0) continue;
    if (!STATUSES.includes(status)) continue;
    providers[id] = { at, status };
  }
  const result = raw.result ? makeResult(raw.result.provider, raw.result) : null;
  return { result, providers };
}

// Whether this provider may be asked about this fingerprint right now.
//
// Returns a reason as well as a verdict, because the user is shown one: "already
// known", "checked recently, nothing found" and "the service was unreachable" are three
// different things, and collapsing them into a silent no-op is how a feature acquires a
// reputation for doing nothing.
function shouldAsk(rawEntry, providerId, now, retry) {
  const policy = retry && typeof retry === 'object' ? retry : RETRY;
  if (!providerById(providerId)) return { ask: false, reason: 'unknownProvider' };
  const entry = normalizeEntry(rawEntry);
  if (entry.result) return { ask: false, reason: 'known' };
  const seen = entry.providers[providerId];
  if (!seen) return { ask: true, reason: 'new' };
  const at = Number(now) || 0;
  const age = at - seen.at;
  if (seen.status === 'found') return { ask: false, reason: 'known' };
  if (seen.status === 'absent') {
    return age < policy.absentMs
      ? { ask: false, reason: 'absentRecently', retryAtMs: seen.at + policy.absentMs }
      : { ask: true, reason: 'absentExpired' };
  }
  return age < policy.errorMs
    ? { ask: false, reason: 'errorRecently', retryAtMs: seen.at + policy.errorMs }
    : { ask: true, reason: 'errorExpired' };
}

// Which providers still have something to say about this fingerprint, in order.
function pendingProviders(rawEntry, kind, now, opts) {
  const o = opts || {};
  return providersFor(kind, o).filter((id) => shouldAsk(rawEntry, id, now, o.retry).ask);
}

function recordOutcome(rawEntry, providerId, outcome, now) {
  const entry = normalizeEntry(rawEntry);
  if (!providerById(providerId)) return entry;
  const at = Number(now) || 0;
  const given = outcome && typeof outcome === 'object' ? outcome : {};
  const status = STATUSES.includes(given.status) ? given.status : 'error';
  const providers = Object.assign({}, entry.providers);
  providers[providerId] = { at, status };
  const result = status === 'found' && given.result
    ? makeResult(providerId, given.result)
    : entry.result;
  return { result: result || null, providers };
}

// What applying a result to one library record would change.
//
// The rule that matters: a field the user can fill in HIMSELF is only ever filled when
// empty. A photo whose author he typed, or whose source he set by downloading it, must
// not be quietly rewritten because a catalogue disagrees. Tags are additive and
// deduplicated by the library itself, so they carry no such risk; rating has no manual
// counterpart at all, so it is simply set.
function planFor(item, rawResult) {
  const result = rawResult ? makeResult(rawResult.provider, rawResult) : null;
  const plan = { patch: {}, tags: [], skipped: [] };
  if (!result || !item || typeof item !== 'object') return plan;

  if (result.author) {
    if (String(item.author || '').trim()) plan.skipped.push('author');
    else plan.patch.author = result.author;
  }
  if (result.page) {
    if (String(item.source || '').trim()) plan.skipped.push('source');
    else plan.patch.source = result.page;
  }
  if (result.rating && String(item.rating || '') !== result.rating) plan.patch.rating = result.rating;

  const have = new Set((Array.isArray(item.tags) ? item.tags : [])
    .map((t) => String(t || '').trim().toLowerCase()));
  plan.tags = result.tags.map((t) => t.name).filter((name) => name && !have.has(name));
  return plan;
}

function planIsEmpty(plan) {
  return !plan || (!plan.tags.length && !Object.keys(plan.patch).length);
}

module.exports = {
  PROVIDERS,
  RETRY,
  RATINGS,
  STATUSES,
  TAG_TYPES,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_AUTHOR_LENGTH,
  providersFor,
  providerById,
  journalKey,
  makeResult,
  emptyEntry,
  normalizeEntry,
  shouldAsk,
  pendingProviders,
  recordOutcome,
  planFor,
  planIsEmpty,
};
