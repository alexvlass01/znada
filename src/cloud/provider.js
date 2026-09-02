'use strict';

// ONL-014c. Our own catalogue, as one more site in the same registry.
//
// It is the last member of the provider line, and the awkward one: everything about it
// differs from a public picture site, and the point of this file is that all of those
// differences are DECLARED here rather than special-cased in the shared handler.
//
//   * it pages by an opaque CURSOR, not by a page number;
//   * it is reached with the account SESSION, which comes and goes while the app runs —
//     unlike a key in a file, which is loaded once and kept;
//   * its browse card carries no file format, because the format is only known once you
//     ask for the picture itself;
//   * it has no permanent page to open and no lasting file URL — a fresh signed link is
//     minted at the moment somebody actually wants the file.
//
// The last two are the invariant the owner has already ruled on: "open the source page"
// and "copy link" must never be offered for one of these cards, because the only link it
// has would be dead in the user's hands.

// The catalogue speaks in its own three ratings; Znada speaks in three groups. This is
// the whole translation, and it is one-way on purpose: we ask for the WIDEST rating the
// user has allowed.
//
// Adult content is gated by the ACCOUNT as well as by the user’s own setting, and the
// server has the final word either way. Asking for what it will refuse only spends a
// request to be told no, so the account’s answer is honoured here too.
function ratingFor(purity, explicitAllowed) {
  const p = purity || {};
  if (p.nsfw && explicitAllowed) return 'explicit';
  if (p.sketchy) return 'suggestive';
  return 'general';
}

// One catalogue entry in the shape every other site answers in.
//
// `page` and `full` are deliberately EMPTY. A card here has no lasting address of either
// kind, and inventing one — the signed preview URL, say — would hand the user a link that
// stops working within the quarter of an hour.
function mapItem(entry) {
  if (!entry || !entry.id) return null;
  const width = Number(entry.width) || 0;
  const height = Number(entry.height) || 0;
  return {
    id: String(entry.id),
    provider: 'znada',
    title: String(entry.title || ''),
    page: '',
    full: '',
    thumb: String(entry.thumb_url || ''),
    resolution: width > 0 && height > 0 ? `${width}x${height}` : '',
    width,
    height,
    // Not stated, and declared as not stated — see `cardFormat` below.
    format: '',
    purity: entry.rating === 'explicit' ? 'nsfw' : (entry.rating === 'suggestive' ? 'sketchy' : 'sfw'),
    category: 'znada',
    source: '',
    publishedAt: Number(entry.published_at) || 0,
  };
}

function parseCatalog(page) {
  const data = page && typeof page === 'object' ? page : {};
  const items = (Array.isArray(data.items) ? data.items : []).map(mapItem).filter(Boolean);
  const next = typeof data.next_cursor === 'string' && data.next_cursor ? data.next_cursor : null;
  return {
    items,
    // ONL-014b speaks in bookmarks; this is how a site that pages by cursor states one.
    // `null` is not "unknown", it is "that was the last of it".
    meta: { nextCursor: next },
  };
}

const PROVIDER = Object.freeze({
  id: 'znada',
  name: 'Znada',
  status: 'active',
  hosts: Object.freeze({
    // Deliberately all empty. Nothing about a catalogue card is a lasting address: the
    // preview is signed and short-lived, the file is minted on demand, and there is no
    // post page at all. Empty means "nothing is allowed here", which is exactly right —
    // every one of the shared address checks must refuse a card from this site.
    page: Object.freeze([]),
    image: Object.freeze([]),
    imageProxyOnly: Object.freeze([]),
    thumb: Object.freeze([]),
  }),
  // Its own group: it is not an alternative to a public site, it is a source of its own.
  group: 'znada',
  // A SESSION, not a key in a file. The difference matters to the handler: a bundled key
  // is read once and kept, while this can appear and disappear while the app runs.
  credentials: Object.freeze({ kind: 'session', required: true }),
  // Which switch in the interface turns this source on. Declared rather than worked out
  // from what kind of site it is.
  sourceKey: 'lumina',
  capabilities: Object.freeze({
    browse: true,
    textSearch: true,
    explicit: 'always',
    topIsAllTime: false,
    fingerprints: Object.freeze([]),
    tagSuggest: false,
    // ONL-015. A browse card genuinely does not carry a format, so this site vouches for
    // its own content instead of being judged on something it never said.
    cardFormat: false,
  }),
  requestHeaders: Object.freeze({}),
  // Previews are signed URLs the window may load itself.
  loadsDirectly: true,
  // What KIND of card this is, for the windows. Declared, so no window has to ask which
  // site a picture came from — the same reason `loadsDirectly` is on the card.
  cardKind: 'cloud',
});

// The one thing the shared handler asks this site to do.
//
// `ctx.credentials` is the live session — asked for on every call, never cached, because
// signing out has to take effect at once. `ctx.credentials.client` is the typed client
// main already owns; rebuilding the request here would be a second, drifting copy of the
// catalogue's contract.
async function search(params, ctx) {
  const o = params || {};
  const session = (ctx && ctx.credentials) || null;
  if (!session || !session.client) return { error: 'unavailable' };
  const res = await session.client.getCatalog({
    rating: ratingFor(o.purity, session.explicitAllowed),
    tag: String(o.q || '').trim() || undefined,
    cursor: o.cursor || undefined,
    limit: Number(o.limit) > 0 ? Number(o.limit) : 30,
    token: session.token || undefined,
  });
  if (!res || !res.ok) {
    const err = res && res.error;
    if (session.onAuthError) session.onAuthError(res);
    return { error: (err && err.code) || 'network' };
  }
  return parseCatalog(res.data);
}

module.exports = { PROVIDER, search, mapItem, parseCatalog, ratingFor };
