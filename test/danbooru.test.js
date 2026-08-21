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

const url = D.buildSearchUrl({ q: 'landscape, sky', purity: { sfw: true, sketchy: false, nsfw: false }, sorting: 'random', page: 2, limit: 30 });
ok('buildSearchUrl: official posts endpoint', url.startsWith(D.API_BASE + '?'));
ok('buildSearchUrl: page and limit', url.includes('page=2') && url.includes('limit=30'));
ok('buildSearchUrl: ratings, static images and minimum size', (() => {
  const tags = new URL(url).searchParams.get('tags');
  return tags.includes('rating:g') && tags.includes('filetype:jpg,png') && tags.includes('mpixels:1..') && tags.includes('order:random');
})());

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
ok('mapItem: unsupported animation is skipped', D.mapItem({ ...sample, file_ext: 'webm' }) === null);
ok('mapItem: missing downloadable URL is skipped', D.mapItem({ ...sample, file_url: '', large_file_url: '' }) === null);

const parsed = D.parseSearch([sample], { page: 3, limit: 1 });
ok('parseSearch: page metadata and optimistic next page', parsed.items.length === 1 && parsed.meta.currentPage === 3 && parsed.meta.lastPage === 4 && parsed.meta.hasMore === true);
ok('parseSearch: junk is empty and final', (() => {
  const result = D.parseSearch(null, { page: 1, limit: 24 });
  return result.items.length === 0 && result.meta.hasMore === false;
})());
const hundredUrl = D.buildSearchUrl({ q: '1girl', purity: { sfw: false, sketchy: false, nsfw: true }, page: 1, limit: 100 });
ok('buildSearchUrl: supports 100 results in one request', new URL(hundredUrl).searchParams.get('limit') === '100');

console.log('\nAll ' + passed + ' danbooru tests passed.');
