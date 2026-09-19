'use strict';

// ONL-014c. Our own catalogue as one more site in the registry.
//
// Everything about it differs from a public picture site, and the point of the change is
// that all of those differences are DECLARED rather than special-cased in the handler.
// So this file is mostly about the declaration being true.

const assert = require('assert');
const provider = require('../src/cloud/provider');
const registry = require('../src/provider-registry');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

const entry = {
  id: '01KVP6SJXMVBWWBMZPVKHNEPJ1',
  title: 'dualsense',
  rating: 'general',
  published_at: 1782085192274,
  width: 3840,
  height: 2160,
  thumb_url: 'https://storage.example/media/thumb/abc.webp?X-Amz-Expires=900',
};

// The invariant the owner ruled on: a catalogue card has no lasting address of either
// kind, so it must not pretend to. Handing over the signed preview as if it were a file
// URL would give the user a link that dies within the quarter of an hour.
{
  const card = provider.mapItem(entry);
  ok('a catalogue card has no page to open and no lasting file link',
    card.page === '' && card.full === '');
  ok('but it does carry the preview the window may load itself',
    card.thumb === entry.thumb_url && provider.PROVIDER.loadsDirectly === true);
  ok('and it says nothing about a format, because at this point nobody knows one',
    card.format === '' && provider.PROVIDER.capabilities.cardFormat === false);
  ok('the shape is the one every other site answers in',
    card.provider === 'znada' && card.resolution === '3840x2160' && card.purity === 'sfw');
  ok('an entry with no id is not a card', provider.mapItem({}) === null && provider.mapItem(null) === null);
  ok('the catalogue ratings are translated into the shared three purity groups',
    provider.mapItem({ ...entry, id: 'suggestive', rating: 'suggestive' }).purity === 'sketchy'
    && provider.mapItem({ ...entry, id: 'explicit', rating: 'explicit' }).purity === 'nsfw');
  const incomplete = provider.mapItem({ ...entry, id: 'incomplete', width: 'not-a-size' });
  ok('an incomplete size is honest instead of inventing a resolution',
    incomplete.width === 0 && incomplete.resolution === '');
}

// This site pages by an opaque marker. `null` from it is an ANSWER — that was the last of
// it — which is why ONL-014b decides on the field being present, not on it being truthy.
{
  const page = provider.parseCatalog({ items: [entry], next_cursor: 'abc' });
  ok('a marker is passed through as the bookmark to carry on with',
    page.items.length === 1 && page.meta.nextCursor === 'abc');
  ok('and no marker means that was everything',
    provider.parseCatalog({ items: [], next_cursor: null }).meta.nextCursor === null);
  ok('rubbish instead of a page is empty and final',
    provider.parseCatalog(null).items.length === 0 && provider.parseCatalog(null).meta.nextCursor === null);
}

// Adult content is gated by the ACCOUNT as well as by the user's own setting. Asking for
// what the server will refuse only spends a request to be told no.
ok('the three groups become the catalogue\'s three ratings',
  provider.ratingFor({ sfw: true }, false) === 'general'
  && provider.ratingFor({ sketchy: true }, false) === 'suggestive'
  && provider.ratingFor({ nsfw: true }, true) === 'explicit');
ok('and an account that may not see adult content is not asked for it',
  provider.ratingFor({ nsfw: true }, false) !== 'explicit');

// The declaration has to match what the site can really do, because the handler acts on
// it without asking anything else.
{
  const declared = registry.byId('znada');
  ok('it is in the registry with its search hook attached',
    !!declared && typeof declared.search === 'function');
  ok('it answers no fingerprint and no tag suggestion, and says so',
    declared.capabilities.fingerprints.length === 0
    && declared.capabilities.tagSuggest === false
    && !registry.fingerprintProviders().some((p) => p.id === 'znada'));
  ok('it is reached by a session rather than by a key in a file',
    declared.credentials.kind === 'session' && declared.credentials.required === true
    && typeof declared.loadCredentials !== 'function');
  ok('it declares which switch turns it on, and which kind of card it makes',
    declared.sourceKey === 'lumina' && declared.cardKind === 'cloud');
  ok('and it is its own source, not an alternative to a public site',
    declared.group === 'znada');
}

// A catalogue card carries no hash, no source page and no lasting file link — the three
// things deduplication used to recognise. So it was identified by NOTHING, and the same
// picture arriving from two orderings of the front page counted twice: measured live as
// four cards for two pictures.
{
  const online = require('../src/online');
  const card = provider.mapItem(entry);
  ok('a catalogue card is identified by something', online.itemKeys(card).length > 0);
  ok('and the same picture from two orderings is one picture',
    online.interleave([[card], [provider.mapItem(entry)]]).length === 1);
  // A card is the same card if ANY of its keys has been seen, so adding the site-and-id
  // key cannot split a picture that two different sites both hold.
  ok('while the same picture on two different sites is still one picture',
    online.interleave([
      [{ provider: 'a', id: '1', md5: 'a'.repeat(32) }],
      [{ provider: 'b', id: '2', md5: 'a'.repeat(32) }],
    ]).length === 1);
  ok('but equal site-local ids from different sites remain two different pictures',
    online.interleave([
      [{ provider: 'a', id: '42' }],
      [{ provider: 'b', id: '42' }],
    ]).length === 2);
}

(async () => {
  // Without a session there is nothing to ask with, and that is not a crash.
  const noSession = await provider.search({}, { credentials: null });
  const halfSession = await provider.search({}, { credentials: { token: 'tok' } });
  ok('with no session it says so instead of reaching for the network',
    noSession.error === 'unavailable' && halfSession.error === 'unavailable');

  let asked = null;
  const session = {
    token: 'tok',
    explicitAllowed: false,
    client: { getCatalog: async (o) => { asked = o; return { ok: true, data: { items: [entry], next_cursor: 'next1' } }; } },
  };
  const res = await provider.search({ q: ' sky ', purity: { nsfw: true }, cursor: 'from-here', limit: 30 }, { credentials: session });
  ok('the request carries the marker it was told to carry on from', asked.cursor === 'from-here');
  ok('the typed word is passed on, trimmed', asked.tag === 'sky');
  ok('the session token goes with it', asked.token === 'tok');
  ok('an account that may not see adult content asks for the safe tier',
    asked.rating === 'general');
  ok('and the answer arrives in the shared shape', res.items.length === 1 && res.meta.nextCursor === 'next1');

  let defaults = null;
  await provider.search({ q: '   ', purity: { sketchy: true }, cursor: '', limit: 0 }, {
    credentials: {
      explicitAllowed: true,
      client: { getCatalog: async (o) => { defaults = o; return { ok: true, data: { items: [], next_cursor: null } }; } },
    },
  });
  ok('blank optional values stay absent and the catalogue keeps its bounded default page size',
    defaults.tag === undefined && defaults.cursor === undefined && defaults.token === undefined
    && defaults.limit === 30);
  ok('the widest selected non-adult tier is sent to the catalogue',
    defaults.rating === 'suggestive');

  // A refused session has to be dropped where sessions are kept, not inside a site.
  let dropped = false;
  const refused = await provider.search({}, {
    credentials: {
      client: { getCatalog: async () => ({ ok: false, error: { code: 'unauthorized' } }) },
      onAuthError: () => { dropped = true; },
    },
  });
  ok('a refusal is reported as an ordinary failure and handed upwards to be dealt with',
    refused.error === 'unauthorized' && dropped === true);

  console.log(`\nAll ${passed} cloud-provider tests passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
