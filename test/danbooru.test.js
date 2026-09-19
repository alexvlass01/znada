'use strict';

const assert = require('assert');
const D = require('../src/danbooru');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  ✓ ' + name); passed++; };

ok('queryTags: comma-separated phrases become tags', (() => {
  const tags = D.queryTags('blue archive, 1girl, ignored');
  return tags.length === 2 && tags[0] === 'blue_archive' && tags[1] === '1girl';
})());
ok('queryTags: metatags are not accepted from UI', D.queryTags('rating:e landscape').join(' ') === 'landscape');
ok('ratingTag: default maps SFW+Sketchy to g,s,q', D.ratingTag() === 'rating:g,s,q');
ok('ratingTag: explicit only', D.ratingTag({ sfw: false, sketchy: false, nsfw: true }) === 'rating:e');
ok('orderTag: Lumina sorts map to Danbooru', D.orderTag('toplist') === 'order:rank' && D.orderTag('views') === 'order:favcount');
// ONL-005 task 3. `order:rank` is a trending window of the last few days. On the front page
// that is the point; for a typed tag it answered nothing at all (live, 2026-09-15:
// `sameko_saba rating:g` gave 0 posts with order:rank and 20 with order:score). A search's
// Top is the tag's all-time best — the meaning Top already has on Gelbooru.
ok('buildSearchTags: Top on the front page stays the trending order',
  D.buildSearchTags({ q: '', sorting: 'toplist' }).split(' ').includes('order:rank'));
ok('buildSearchTags: Top for a typed tag is the all-time best, not a trending window', (() => {
  const tags = D.buildSearchTags({ q: 'sameko_saba', sorting: 'toplist' }).split(' ');
  return tags.includes('order:score') && !tags.includes('order:rank');
})());

const url = D.buildSearchUrl({ q: 'landscape, sky', purity: { sfw: true, sketchy: false, nsfw: false }, sorting: 'random', page: 2, limit: 30, formats: ['jpg', 'jpeg', 'png'] });
ok('buildSearchUrl: official posts endpoint', url.startsWith(D.API_BASE + '?'));
ok('buildSearchUrl: page and limit', url.includes('page=2') && url.includes('limit=30'));
ok('buildSearchUrl: ratings, static images and minimum size', (() => {
  const tags = new URL(url).searchParams.get('tags');
  return tags.includes('rating:g') && tags.includes('filetype:jpg,png') && tags.includes('mpixels:1..') && tags.includes('order:random');
})());


// ONL-012 review. WHICH formats is the handler's one rule; this file only knows how
// to say it. The site spells a JPEG 'jpg' and has never heard of 'jpeg', so the two
// spellings must collapse into one term — and a caller that says nothing about
// formats must not get a filter invented for it.
ok('fileTypeTag: the handler\'s list, in this site\'s own spelling',
  D.fileTypeTag(['jpg', 'jpeg', 'png']) === 'filetype:jpg,png'
  && D.fileTypeTag(['png']) === 'filetype:png'
  && D.fileTypeTag([]) === ''
  && D.fileTypeTag(undefined) === '');
ok('buildSearchTags: no format list means no format filter',
  !D.buildSearchTags({ q: 'sky' }).includes('filetype'));

const sample = {
  id: 123,
  rating: 's',
  image_width: 2400,
  image_height: 1600,
  file_ext: 'jpg',
  file_url: 'https://cdn.donmai.us/original/a.jpg',
  large_file_url: 'https://cdn.donmai.us/sample/a.jpg',
  preview_file_url: 'https://cdn.donmai.us/180x180/a.jpg',
  source: 'https://x.com/artist/status/1',
  md5: 'ABCDEF',
  tag_string_artist: 'artist_name',
  tag_string_character: 'heroine',
  tag_string_copyright: 'some_series',
  tag_string_general: '1girl sky blue_sky',
};
const mapped = D.mapItem(sample);
ok('mapItem: shared online shape', mapped.id === 'danbooru:123' && mapped.provider === 'danbooru' && mapped.full === sample.file_url && mapped.thumb === sample.preview_file_url);
ok('mapItem: dimensions, purity and attribution', mapped.resolution === '2400x1600' && mapped.purity === 'sketchy' && mapped.page.endsWith('/123') && mapped.artist === 'artist_name');
ok('mapItem: useful tags are retained', mapped.tags.includes('heroine') && mapped.tags.includes('some_series') && mapped.tags.includes('blue_sky'));
// ONL-012: the adapter REPORTS what it found and no longer judges it. Throwing video
// away here is what made it unreachable no matter what the app learned; whether Znada
// can use a kind of file is now one decision, in the handler.
ok('mapItem: a video is reported, not thrown away', (() => {
  const video = D.mapItem({ ...sample, file_ext: 'webm', file_url: 'https://cdn.donmai.us/original/a.webm' });
  return !!video && video.format === 'webm';
})());
ok('mapItem: a still picture is reported as one', (() => {
  const still = D.mapItem(sample);
  return still.format === 'jpg';
})());
ok('mapItem: fallback full URL reports the format of the file actually selected', (() => {
  const fallback = D.mapItem({
    ...sample,
    file_ext: 'png',
    file_url: '',
    large_file_url: 'https://cdn.donmai.us/sample/fallback.jpg',
  });
  return !!fallback && fallback.full.endsWith('/fallback.jpg')
    && fallback.format === 'jpg' && fallback.fileType === 'image/jpeg';
})());
ok('mapItem: missing downloadable URL is skipped', D.mapItem({ ...sample, file_url: '', large_file_url: '' }) === null);
// ONL-016. Measured against the live API on 2026-09-03: this site reports `file_size`
// in bytes and Gelbooru reports no size at all. "Details" can only show what the card
// carried, so the mapping is checked here rather than only where it is displayed.
ok('mapItem: carries the file size this site reports',
  D.mapItem({ ...sample, file_size: 4484352 }).fileSize === 4484352);
ok('mapItem: a missing file size is 0, never NaN',
  D.mapItem({ ...sample, file_size: undefined }).fileSize === 0);

const parsed = D.parseSearch([sample], { page: 3, limit: 1 });
ok('parseSearch: page metadata and optimistic next page', parsed.items.length === 1 && parsed.meta.currentPage === 3 && parsed.meta.lastPage === 4 && parsed.meta.hasMore === true);
ok('parseSearch: junk is empty and final', (() => {
  const result = D.parseSearch(null, { page: 1, limit: 24 });
  return result.items.length === 0 && result.meta.hasMore === false;
})());
const hundredUrl = D.buildSearchUrl({ q: '1girl', purity: { sfw: false, sketchy: false, nsfw: true }, page: 1, limit: 100 });
ok('buildSearchUrl: supports 100 results in one request', new URL(hundredUrl).searchParams.get('limit') === '100');

// META-001: the same file, found by its bytes.
const HASH = 'b'.repeat(32);
const md5Url = D.buildMd5Url(HASH);
ok('buildMd5Url: one post, matched on the hash alone',
  new URL(md5Url).searchParams.get('tags') === 'md5:' + HASH && new URL(md5Url).searchParams.get('limit') === '1');
// The ordinary search adds a rating term and two more tags; an anonymous account only
// accepts two, and the rating is not part of the question "is this my file".
ok('buildMd5Url: does not inherit the search filters',
  !md5Url.includes('filetype') && !md5Url.includes('mpixels') && !md5Url.includes('rating'));
ok('buildMd5Url: refuses anything that is not a hash',
  D.buildMd5Url('1girl') === '' && D.buildMd5Url('') === '' && D.buildMd5Url(null) === '');

const md5Summary = D.postSummary({
  id: 7, md5: HASH, rating: 'q',
  tag_string_artist: 'foo_bar', tag_string_character: 'alice',
  tag_string_general: '1girl solo', tag_string_meta: 'highres',
  tag_string: '1girl solo highres foo_bar alice loose_one',
});
ok('postSummary: the one-letter rating is spelled the shared way', md5Summary.rating === 'questionable');
ok('postSummary: tag kinds come free, with no extra request',
  md5Summary.tags.find((t) => t.name === 'foo_bar').type === 'artist'
  && md5Summary.tags.find((t) => t.name === 'alice').type === 'character'
  && md5Summary.tags.find((t) => t.name === 'highres').type === 'meta');
ok('postSummary: a tag only in the flat list is still kept, just untyped',
  !!md5Summary.tags.find((t) => t.name === 'loose_one' && !t.type));
ok('postSummary: no tag is counted twice', new Set(md5Summary.tags.map((t) => t.name)).size === md5Summary.tags.length);
ok('postSummary: the artist becomes a readable author', md5Summary.author === 'foo bar');
ok('postSummary: an unknown rating letter is left empty rather than invented',
  D.postSummary({ id: 1, rating: 'x' }).rating === '');
ok('postSummary: refuses a post with no usable id', D.postSummary({}) === null && D.postSummary(null) === null);

// ONL-013. The hook the shared handler calls to ask "which post IS this exact file".
// Unlike Gelbooru this site needs no credentials and no second request: it groups its
// tags by kind already, so one request carries everything.
(async () => {
  const never = async () => { throw new Error('should not have asked'); };
  ok('a fingerprint kind this site does not index is refused before any request',
    (await D.findByFingerprint('phash', HASH, { fetchJson: never })).error === 'unsupported');
  ok('a value that is not a hash never becomes a search for arbitrary text',
    (await D.findByFingerprint('md5', 'landscape', { fetchJson: never })).error === 'badFingerprint');

  const seen = [];
  const found = await D.findByFingerprint('md5', HASH, {
    fetchJson: async (url) => {
      seen.push(url);
      return { json: [{ id: 7, md5: HASH, rating: 'q', tag_string_artist: 'someone', tag_string_general: 'sky' }] };
    },
  });
  ok('one request carries the post, its artist and its tag kinds',
    seen.length === 1
    && found.result.postId === '7'
    && found.result.author === 'someone'
    && found.result.tags.find((t) => t.name === 'sky').type === 'general');
  ok('nothing found is said explicitly, so it can be told apart from a failure',
    (await D.findByFingerprint('md5', HASH, { fetchJson: async () => ({ json: [] }) })).result === null);
  ok('and a failed request is passed on as it came',
    (await D.findByFingerprint('md5', HASH, { fetchJson: async () => ({ error: '429' }) })).error === '429');

  // ONL-014. The second site that can answer the search box, so the dropdown survives
  // the first one being unreachable.
  {
    const url = new URL(D.buildTagSuggestUrl({ q: 'Blue Hai', limit: 50 }));
    ok('the public autocomplete endpoint, with the typed text spelled as a tag',
      url.origin + url.pathname === D.TAG_SUGGEST_API
      && url.searchParams.get('search[query]') === 'blue_hai'
      && url.searchParams.get('search[type]') === 'tag_query'
      && url.searchParams.get('limit') === '20');

    // Verified live 2026-08-26: this site resolves ALIASES, so `land` suggests
    // `houseki_no_kuni`. Filtering by prefix here would throw away the one thing it does
    // better than its alternative, so nothing does.
    const items = D.parseTagSuggestions([
      { value: 'landscape', post_count: 10145, category: 0 },
      { value: 'houseki_no_kuni', post_count: 5590, category: 3 },
      { value: 'two words', post_count: 5, category: 0 },
    ]);
    ok('an alias that does not start with what was typed is kept, not dropped',
      items.length === 2 && items[1].name === 'houseki_no_kuni');
    ok('the kind is spelled the way the rest of Znada spells it',
      items[0].category === 'general' && items[1].category === 'copyright' && items[0].count === 10145);
    ok('rubbish where a list should be is an empty answer, not a crash',
      D.parseTagSuggestions(null).length === 0 && D.parseTagSuggestions({}).length === 0);

    // End to end through the hook, not just the parser: the alias has to survive the
    // whole way out, and a prefix filter quietly added anywhere in here would kill it.
    const aliased = await D.suggestTags({ q: 'land', limit: 6 }, {
      fetchJson: async () => ({
        json: [
          { value: 'landscape', post_count: 10145, category: 0 },
          { value: 'houseki_no_kuni', post_count: 5590, category: 3 },
        ],
      }),
    });
    ok('the alias survives all the way out of the hook, not only out of the parser',
      aliased.items.length === 2 && aliased.items.some((i) => i.name === 'houseki_no_kuni'));
    ok('and a failed request is passed on as it came',
      (await D.suggestTags({ q: 'sky', limit: 5 }, { fetchJson: async () => ({ error: 'timeout' }) })).error === 'timeout');
  }

  console.log('\nAll ' + passed + ' danbooru tests passed.');
})().catch((err) => { console.error(err); process.exit(1); });
