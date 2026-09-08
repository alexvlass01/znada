'use strict';

const assert = require('assert');
const G = require('../src/gelbooru');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  OK ' + name); passed++; };

ok('queryTags: comma-separated phrases become tags', (() => {
  const tags = G.queryTags('blue archive, 1girl, ignored');
  return tags.length === 2 && tags[0] === 'blue_archive' && tags[1] === '1girl';
})());
ok('queryTags: metatags are not accepted from UI', G.queryTags('rating:explicit landscape').join(' ') === 'landscape');
ok('ratingTags: SFW and Sketchy exclude Explicit', G.ratingTags().join(' ') === '-rating:explicit');
ok('ratingTags: Sketchy covers Sensitive and Questionable', G.ratingTags({ sfw: false, sketchy: true, nsfw: false }).join(' ') === '-rating:general -rating:explicit');
ok('ratingTags: Explicit only uses an exact rating', G.ratingTags({ sfw: false, sketchy: false, nsfw: true }).join(' ') === 'rating:explicit');
ok('ratingTags: all ratings need no filter', G.ratingTags({ sfw: true, sketchy: true, nsfw: true }).length === 0);
ok('orderTag: Lumina sorts map to Gelbooru', G.orderTag('toplist') === 'sort:score:desc' && G.orderTag('random') === 'sort:random');

const url = G.buildSearchUrl({
  q: 'landscape, sky',
  purity: { sfw: true, sketchy: false, nsfw: false },
  sorting: 'toplist',
  page: 3,
  limit: 100,
  userId: '42',
  apiKey: 'secret',
});
const parsedUrl = new URL(url);
ok('buildSearchUrl: official DAPI endpoint', url.startsWith(G.API_BASE + '?') && parsedUrl.searchParams.get('page') === 'dapi');
ok('buildSearchUrl: one-based UI page maps to zero-based pid', parsedUrl.searchParams.get('pid') === '2');
ok('buildSearchUrl: includes 100 limit and credentials', parsedUrl.searchParams.get('limit') === '100' && parsedUrl.searchParams.get('user_id') === '42' && parsedUrl.searchParams.get('api_key') === 'secret');
ok('buildSearchUrl: ratings and sorting are sent to provider', (() => {
  const tags = parsedUrl.searchParams.get('tags');
  return tags.includes('rating:general') && tags.includes('sort:score:desc');
})());

const sample = {
  id: 123,
  rating: 'sensitive',
  width: 2400,
  height: 1600,
  image: 'sample.jpg',
  file_url: 'https://img4.gelbooru.com/images/a/b/sample.jpg',
  preview_url: 'https://img4.gelbooru.com/thumbnails/a/b/thumbnail_sample.jpg',
  sample_url: 'https://img4.gelbooru.com/samples/a/b/sample_sample.jpg',
  source: 'https://x.com/artist/status/1',
  md5: 'ABCDEF',
  tags: 'artist_name heroine some_series 1girl sky blue_sky',
};
const mapped = G.mapItem(sample);
ok('mapItem: shared online shape', mapped.id === 'gelbooru:123' && mapped.provider === 'gelbooru' && mapped.full === sample.file_url && mapped.thumb === sample.preview_url);
ok('mapItem: dimensions, purity and attribution', mapped.resolution === '2400x1600' && mapped.purity === 'sketchy' && mapped.page.endsWith('id=123'));
ok('mapItem: useful tags are retained', mapped.tags.includes('heroine') && mapped.tags.includes('some_series') && mapped.tags.includes('blue_sky'));
// ONL-012: reported, not judged — see the note in test/danbooru.test.js.
ok('mapItem: an animation is reported, not thrown away', (() => {
  const gif = G.mapItem({ ...sample, image: 'sample.gif', file_url: 'https://img4.gelbooru.com/sample.gif' });
  return !!gif && gif.format === 'gif';
})());
ok('mapItem: a still picture is reported as one', (() => {
  const still = G.mapItem(sample);
  return ['jpg', 'jpeg', 'png'].includes(still.format);
})());
ok('mapItem: missing downloadable URL is skipped', G.mapItem({ ...sample, file_url: '' }) === null);
// ONL-016. Checked against the live API on 2026-09-03: a Gelbooru post carries no size
// field of any kind, so the card states 0 and "Details" shows no size row rather than an
// empty one. Pinned so that a later "let's just read post.file_size" is caught: the field
// does not exist, and inventing it would put a wrong weight next to a real picture.
ok('mapItem: states 0 for a size this site does not report',
  mapped.fileSize === 0 && G.mapItem({ ...sample, file_size: 999 }).fileSize === 0);

const response = { '@attributes': { limit: 1, offset: 2, count: 5 }, post: [sample] };
const parsed = G.parseSearch(response, { page: 3, limit: 1 });
ok('parseSearch: wrapped response and total drive pagination', parsed.items.length === 1 && parsed.meta.currentPage === 3 && parsed.meta.total === 5 && parsed.meta.hasMore === true);
ok('parseSearch: final offset hides next page', G.parseSearch({ '@attributes': { offset: 4, count: 5 }, post: [sample] }, { page: 5, limit: 1 }).meta.hasMore === false);
ok('responseError: provider search failures are detected', G.responseError({ success: false, message: 'search down' }) === 'search down');

// --- Tag types / artist extraction ---
const tagUrl = new URL(G.buildTagTypesUrl(['artist_name', 'artist_name', '1girl'], { userId: '42', apiKey: 'secret' }));
ok('buildTagTypesUrl: DAPI tag endpoint, deduped names, credentials', (() => {
  return tagUrl.searchParams.get('page') === 'dapi'
    && tagUrl.searchParams.get('s') === 'tag'
    && tagUrl.searchParams.get('names') === 'artist_name 1girl'
    && tagUrl.searchParams.get('user_id') === '42'
    && tagUrl.searchParams.get('api_key') === 'secret';
})());
ok('buildTagTypesUrl: empty names produce no URL', G.buildTagTypesUrl([]) === '' && G.buildTagTypesUrl('   ') === '');

const tagResponse = { tag: [
  { name: 'artist_name', type: 1, count: 500 },
  { name: 'other_artist', type: '1' },
  { name: 'some_series', type: 3 },
  { name: 'heroine', type: 4 },
  { name: '1girl', type: 0 },
] };
const typeMap = G.parseTagTypes(tagResponse);
ok('parseTagTypes: numeric and string types map by name', typeMap.get('artist_name') === 1 && typeMap.get('other_artist') === 1 && typeMap.get('some_series') === 3 && typeMap.get('1girl') === 0);
ok('parseTagTypes: tolerates single-object and bare-array forms', G.parseTagTypes({ tag: { name: 'solo_artist', type: 1 } }).get('solo_artist') === 1 && G.parseTagTypes([{ name: 'x', type: 1 }]).get('x') === 1);

const postTags = 'artist_name heroine some_series 1girl other_artist sky';
const artists = G.artistNamesFromTypes(postTags, typeMap);
ok('artistNamesFromTypes: only type===1 tags, underscores normalized', artists.length === 2 && artists[0] === 'artist name' && artists[1] === 'other artist');
ok('artistNamesFromTypes: no artist tags yields empty', G.artistNamesFromTypes('1girl sky', typeMap).length === 0);
ok('artistNamesFromTypes: accepts a plain object typeMap', G.artistNamesFromTypes(['a', 'b'], { a: 1, b: 0 }).join(',') === 'a');
ok('artistLabel: comma-joins and caps at max', G.artistLabel(['a', 'b', 'c', 'd'], 3) === 'a, b, c' && G.artistLabel(['only'], 3) === 'only' && G.artistLabel([]) === '');

// BUG-002: the artist tag is often outside the search response's 24-tag cap, so the
// download path re-reads the post and needs both the display label and the raw tag.
ok('artistTagsFromTypes: keeps the original underscore form', G.artistTagsFromTypes(postTags, typeMap).join(',') === 'artist_name,other_artist');
ok('artistTagsFromTypes: no artists yields empty', G.artistTagsFromTypes('1girl sky', typeMap).length === 0);
ok('artistTagsFromTypes: deduplicates repeated names', G.artistTagsFromTypes('artist_name artist_name', typeMap).length === 1);

const bigPost = { tags: Array.from({ length: 51 }, (_, i) => `tag_${String(i).padStart(2, '0')}`).join(' ') };
ok('compactTags still caps the search payload at 24', G.compactTags(bigPost).length === 24);
ok('allTags returns every tag, untruncated', G.allTags(bigPost).length === 51);
ok('allTags deduplicates and lowercases', G.allTags({ tags: 'A_b  a_b   c' }).join(',') === 'a_b,c');
ok('allTags tolerates a missing post', G.allTags(null).length === 0 && G.allTags({}).length === 0);

const postUrl = G.buildPostUrl('gelbooru:14619442', { apiKey: 'k', userId: '7' });
ok('buildPostUrl: accepts the prefixed item id and asks for one post', postUrl.includes('s=post') && postUrl.includes('id=14619442') && !postUrl.includes('gelbooru%3A'));
ok('buildPostUrl: carries credentials when present', postUrl.includes('api_key=k') && postUrl.includes('user_id=7'));
ok('buildPostUrl: works without credentials', G.buildPostUrl('123').includes('id=123'));
ok('buildPostUrl: rejects a non-numeric id', G.buildPostUrl('gelbooru:abc') === '' && G.buildPostUrl('') === '' && G.buildPostUrl(null) === '');

// META-001: the same file, found by its bytes rather than by a search term.
const HASH = 'a'.repeat(32);
const md5Url = G.buildMd5Url(HASH, { apiKey: 'k', userId: '7' });
ok('buildMd5Url: asks for exactly one post matching the hash',
  new URL(md5Url).searchParams.get('tags') === 'md5:' + HASH && new URL(md5Url).searchParams.get('limit') === '1');
ok('buildMd5Url: carries credentials', md5Url.includes('api_key=k') && md5Url.includes('user_id=7'));
// A malformed hash must not become a free-text search: that would return an ARBITRARY
// picture, whose tags would then be written onto the user's photo.
ok('buildMd5Url: refuses anything that is not a hash',
  G.buildMd5Url('1girl') === '' && G.buildMd5Url(HASH + 'a') === '' && G.buildMd5Url('') === '' && G.buildMd5Url(null) === '');
ok('buildMd5Url: accepts a hash in upper case', G.buildMd5Url(HASH.toUpperCase()).includes('md5%3A' + HASH));

ok('tagTypeName: numbers stop at the adapter boundary',
  G.tagTypeName(1) === 'artist' && G.tagTypeName(5) === 'meta' && G.tagTypeName(0) === 'general' && G.tagTypeName(99) === '');

const md5Summary = G.postSummary({ id: 42, md5: HASH, rating: 'general', tags: '1girl highres artist_name' }, typeMap);
ok('postSummary: carries the post, its page and its hash',
  md5Summary.postId === '42' && md5Summary.page.endsWith('id=42') && md5Summary.md5 === HASH);
ok('postSummary: every tag is kept, with the kind the catalogue gave it',
  md5Summary.tags.length === 3 && md5Summary.tags.find((t) => t.name === 'artist_name').type === 'artist');
ok('postSummary: the artist becomes a readable author', md5Summary.author === 'artist name');
ok('postSummary: without a type map the tags survive untyped',
  G.postSummary({ id: 7, tags: 'a b' }).tags.every((t) => !t.type));
ok('postSummary: refuses a post with no usable id',
  G.postSummary({ tags: 'a' }) === null && G.postSummary(null) === null && G.postSummary({ id: 'abc' }) === null);

// ONL-012 review. The tag-kind cache is deliberately process-wide — a tag's kind is a
// fact about the catalogue, not about one picture — and `resetState` is the hook a site
// declares so a test run does not carry one test's answers into the next. Nothing called
// it, so what its comment promised was not actually true anywhere. Pinned here, and the
// test harness now calls it for every provider that has one.
(async () => {
  const asked = [];
  const ctx = {
    credentials: {},
    fetchJson: async (url) => { asked.push(url); return { json: { tag: [{ name: 'sky', type: 0 }] } }; },
  };

  G.resetState();
  await G.tagTypesFor(['sky'], ctx);
  ok('a tag kind costs one request', asked.length === 1);

  await G.tagTypesFor(['sky'], ctx);
  ok('and is free the second time it is wanted', asked.length === 1);

  G.resetState();
  const after = await G.tagTypesFor(['sky'], ctx);
  ok('resetState really empties it, so the next run asks again',
    asked.length === 2 && after.get('sky') === 0);

  // ONL-013. The hook the shared handler calls to ask "which post IS this exact file".
  // The branches below are the ones the integration suite cannot reach, because it
  // always arrives with a real hash and whatever credentials the build happens to carry.
  G.resetState();
  const never = async () => { throw new Error('should not have asked'); };
  ok('a fingerprint kind this site does not index is refused before any request',
    (await G.findByFingerprint('phash', HASH, { credentials: {}, fetchJson: never })).error === 'unsupported');
  ok('and so is a request with no credentials, which this site cannot serve at all',
    (await G.findByFingerprint('md5', HASH, { credentials: null, fetchJson: never })).error === 'unavailable');
  ok('a value that is not a hash never becomes a search for arbitrary text',
    (await G.findByFingerprint('md5', '1girl', { credentials: {}, fetchJson: never })).error === 'badFingerprint');

  {
    const seen = [];
    const reply = async (url) => {
      seen.push(url);
      if (url.includes('s=tag')) return { json: { tag: [{ name: 'artist_name', type: 1 }] } };
      return { json: { post: [{ id: 42, md5: HASH, rating: 'general', tags: 'sky artist_name' }] } };
    };
    const found = await G.findByFingerprint('md5', HASH, { credentials: {}, fetchJson: reply });
    ok('a post comes back whole, with the tag kinds its second request resolved',
      found.result.postId === '42'
      && found.result.author === 'artist name'
      && seen.length === 2);
    // The hash is NOT checked here on purpose: that is one rule in the handler, for every
    // site, so a site cannot forget it. Proven in test/fingerprint-lookup.test.js.
    ok('and the site hands the post over without judging whether it is ours',
      found.result.md5 === HASH);
  }

  // The tag kinds are a bonus on a second request. Losing the POST because that request
  // failed would trade the whole answer for a decoration.
  {
    G.resetState();
    const brittle = await G.findByFingerprint('md5', HASH, {
      credentials: {},
      fetchJson: async (url) => {
        if (url.includes('s=tag')) throw new Error('refused');
        return { json: { post: [{ id: 9, md5: HASH, rating: 'general', tags: 'sky' }] } };
      },
    });
    ok('the post survives even when the request for tag kinds falls over',
      brittle.result.postId === '9' && brittle.result.tags.some((t) => t.name === 'sky'));
    ok('and its tags simply arrive without a kind, rather than not at all',
      brittle.result.tags.every((t) => !t.type));
  }

  // ONL-014. What to offer while somebody types. These checks came over verbatim from
  // test/tag-suggest.test.js when the endpoint and its parser moved out of that module
  // into this site's own file — the module they were in belongs to the search box, not
  // to any site.
  {
    const url = new URL(G.buildTagSuggestUrl({ q: 'blue hai', limit: 50 }));
    ok('the anonymous autocomplete endpoint, and no other',
      url.origin + url.pathname === G.TAG_SUGGEST_API && url.searchParams.get('page') === 'autocomplete2');
    ok('the typed text goes out spelled the way this site spells tags, and without a key',
      url.searchParams.get('term') === 'blue_hai' && url.searchParams.get('type') === 'tag'
      && !url.searchParams.has('user_id') && !url.searchParams.has('api_key'));
    ok('and the count asked for is clamped', url.searchParams.get('limit') === '20');

    const parsed = G.parseTagSuggestions({
      tag: [
        { name: 'blue_hair', count: '450000', type: '0' },
        { name: 'blue_hair_ribbon', count: '1200', type: '0' },
        { name: 'blue_archive', count: '90000', type: '3' },
        { name: 'red_hair', count: '1000000', type: '0' },
      ],
    }, { prefix: 'blue_h' });
    ok('this site answers by prefix, so anything else is noise and is dropped',
      parsed.length === 2 && parsed.every((i) => i.name.startsWith('blue_h')));
    ok('the count is a number and the kind is spelled the way the rest of Znada spells it',
      parsed[0].count === 450000 && parsed[0].category === 'general');
    ok('a single-object answer is read the same as a list',
      G.parseTagSuggestions({ tag: { name: 'sky', count: 5 } }, { prefix: 'sky' }).length === 1);
    ok('and so is the newer autocomplete shape, full-width spaces and all', (() => {
      const items = G.parseTagSuggestions([
        { value: 'blue_hair', post_count: '1302060', category: 'tag' },
        { value: 'blue_hair　brown_hair', post_count: '8078', category: 'tag' },
        { value: 'blue_archive', post_count: '90000', category: 'copyright' },
      ], { prefix: 'blue_h' });
      return items.length === 1 && items[0].name === 'blue_hair' && items[0].count === 1302060;
    })());
    ok('a failure reported inside a successful answer is a failure here too',
      (await G.suggestTags({ q: 'sky', limit: 5 }, { fetchJson: async () => ({ json: { success: false, message: 'nope' } }) })).error === 'nope');
  }

  ok('nothing found is said explicitly, so it can be told apart from a failure',
    (await G.findByFingerprint('md5', HASH, { credentials: {}, fetchJson: async () => ({ json: { post: [] } }) })).result === null);
  ok('a failure reported inside a successful answer is still a failure',
    (await G.findByFingerprint('md5', HASH, { credentials: {}, fetchJson: async () => ({ json: { success: false, message: 'nope' } }) })).error === 'nope');
  ok('and a failed request is passed on as it came',
    (await G.findByFingerprint('md5', HASH, { credentials: {}, fetchJson: async () => ({ error: 'timeout' }) })).error === 'timeout');

  console.log('\nAll ' + passed + ' gelbooru tests passed.');
})().catch((err) => { console.error(err); process.exit(1); });
