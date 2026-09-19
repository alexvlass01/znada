'use strict';

// ONL-014b. Where each site got to, so "show more" carries on PER SITE instead of
// marching one page number across all of them.
//
// The old shape asked every site for "page N", with N owned by the window. That only
// worked because every site we happened to have pages by number, and it was already
// leaking. Measured against the live sites on 2026-08-26, searching `houseki_no_kuni`:
// one site returned nothing at all on page 1 and was asked again on pages 2, 3, 4 and
// 5 — half the requests in the round were pointless. And read from the code: a site
// that FAILED on page 3 lost that page for good, because the shared number moved on to
// 4 and nothing remembered where that site had got to. A second of bad network turned
// into a permanent hole in the feed.
//
// So each site gets a bookmark. Give the bookmark back and you get the next piece.
//
// Three states, and the difference between them is the whole point:
//   * no entry     — never asked. Ask from the beginning.
//   * { at: X }    — asked, and X is where to carry on from.
//   * { at: null } — finished. Never asked again for this query.
//
// A site that FAILED keeps its old bookmark, so the next press re-asks the same piece:
// a hiccup costs a delay rather than a hole (owner's decision, 2026-08-27). It is not
// retried forever, though — see MAX_FAILS.

// After this many consecutive failures on the SAME piece a site is finished for this
// query. Without it a permanently dead site keeps a bookmark forever, which keeps the
// "show more" button alive while every press adds nothing — a dead end the user can see,
// which is exactly what falling back to another site is supposed to prevent.
const MAX_FAILS = 2;

// One site, one ordering. The browse feed asks each site for TWO orderings at once
// (what is new, and what is well rated), and those walk forward independently.
function slotKey(providerId, sorting) {
  const id = String(providerId || '').trim();
  if (!id) return '';
  return `${id}@${String(sorting || '').trim()}`;
}

// What the bookmarks belong to. A token from a different question must not be able to
// steer this one: the window is our own code, but everything arriving over IPC is input.
function signatureOf(request) {
  const r = request || {};
  const purity = r.purity || {};
  return [
    String(r.q || '').trim().toLowerCase(),
    String(r.sort || ''),
    r.browse ? 'browse' : 'search',
    purity.sfw ? 1 : 0,
    purity.sketchy ? 1 : 0,
    purity.nsfw ? 1 : 0,
    String(r.sourcesKey || ''),
  ].join('|');
}

function emptyToken(signature) {
  return { sig: String(signature || ''), slots: {} };
}

// ONL-014c. A bookmark is a page NUMBER for a site that counts pages, and an opaque
// MARKER for one that hands back its own. Both are stored; nothing here interprets a
// marker, which is the point of it being opaque.
//
// `undefined` means "this is not a bookmark at all" — a slot carrying one is dropped
// rather than repaired, because a half-trusted position either skips content or repeats
// it. `null` is a real value: it means finished.
const MAX_MARKER_LENGTH = 512;
function readPosition(value) {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
  if (typeof value === 'string') {
    // A marker arrives over IPC like everything else, so it is bounded. Nothing reads it,
    // but it is handed straight back to a site, and unbounded text is not.
    return value && value.length <= MAX_MARKER_LENGTH ? value : undefined;
  }
  return undefined;
}

// A token as it came back from the window. Anything unrecognisable — a different query,
// a shape we do not understand — starts over rather than being repaired: starting over
// shows the user the first page again, while a half-trusted token could silently skip
// content or repeat it.
function parse(raw, signature) {
  const sig = String(signature || '');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyToken(sig);
  if (String(raw.sig || '') !== sig) return emptyToken(sig);
  const slots = {};
  const source = raw.slots && typeof raw.slots === 'object' && !Array.isArray(raw.slots) ? raw.slots : {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (!value || typeof value !== 'object') continue;
    const at = readPosition(value.at);
    if (at === undefined) continue;
    const fails = Math.max(0, Math.floor(Number(value.fails) || 0));
    slots[key] = { at, fails };
  }
  return { sig, slots };
}

// Where to carry on from, or undefined when this site has never been asked.
function positionOf(token, key) {
  const slot = token && token.slots ? token.slots[key] : null;
  if (!slot) return undefined;
  return slot.at;
}

function isFinished(token, key) {
  return positionOf(token, key) === null;
}

// What a site's answer says about carrying on.
//
// A site that hands back its own marker wins outright: it is the only one that knows what
// “carry on” means for it, and a marker is opaque by definition. `null` from such a site
// is an ANSWER — “that was the last of it” — which is why the field being PRESENT is what
// decides, not whether it is truthy.
function nextFrom(result, asked) {
  const meta = (result && result.meta) || {};
  if (Object.prototype.hasOwnProperty.call(meta, 'nextCursor')) {
    return typeof meta.nextCursor === 'string' && meta.nextCursor ? meta.nextCursor : null;
  }
  const at = Number(asked) > 0 ? Math.floor(Number(asked)) : 1;
  if (meta.hasMore === true) return at + 1;
  return Number(meta.lastPage) > at ? at + 1 : null;
}

// Record what happened to one site this round.
//   { next: N }  — carry on from N
//   { done: true }   — nothing more
//   { failed: true } — keep the same bookmark, and count the failure
function record(token, key, asked, outcome) {
  if (!token || !token.slots || !key) return token;
  const o = outcome || {};
  const prev = token.slots[key];
  const fails = prev ? prev.fails : 0;
  if (o.failed) {
    const count = fails + 1;
    const at = readPosition(asked) === undefined ? 1 : readPosition(asked);
    token.slots[key] = count >= MAX_FAILS ? { at: null, fails: count } : { at, fails: count };
    return token;
  }
  if (o.done || o.next == null) {
    token.slots[key] = { at: null, fails: 0 };
    return token;
  }
  token.slots[key] = { at: readPosition(o.next), fails: 0 };
  return token;
}

// Is there anything left to ask anybody? A site that has never been asked does not count
// here: this is only ever consulted AFTER a round, by which point everyone reachable has
// an entry.
function isEmpty(token) {
  const slots = (token && token.slots) || {};
  return !Object.keys(slots).some((key) => slots[key] && slots[key].at !== null);
}

// What goes back to the window: the token itself, or null for "that was everything".
// Null is what makes the "show more" button disappear, so it has to mean exactly that.
function forReply(token) {
  if (!token || isEmpty(token)) return null;
  return { sig: token.sig, slots: token.slots };
}

module.exports = {
  MAX_FAILS,
  MAX_MARKER_LENGTH,
  readPosition,
  slotKey,
  signatureOf,
  emptyToken,
  parse,
  positionOf,
  isFinished,
  nextFrom,
  record,
  isEmpty,
  forReply,
};
