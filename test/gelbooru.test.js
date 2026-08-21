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
ok('mapItem: unsupported animation is skipped', G.mapItem({ ...sample, image: 'sample.gif', file_url: 'https://img4.gelbooru.com/sample.gif' }) === null);
ok('mapItem: missing downloadable URL is skipped', G.mapItem({ ...sample, file_url: '' }) === null);

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

console.log('\nAll ' + passed + ' gelbooru tests passed.');
