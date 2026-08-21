'use strict';

const assert = require('assert');
const O = require('../src/online');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  ✓ ' + name); passed++; };
const item = (id, provider, source = '') => ({ id, provider, source, full: `https://${provider}.example/${id}.jpg` });

ok('canonicalUrl: strips query and normalizes Twitter to X', O.canonicalUrl('https://twitter.com/User/status/1?x=2') === 'x.com/user/status/1');
ok('interleave: alternates providers', (() => {
  const merged = O.interleave([[item('w1', 'w'), item('w2', 'w')], [item('d1', 'd'), item('d2', 'd')]]);
  return merged.map((x) => x.id).join(',') === 'w1,d1,w2,d2';
})());
ok('interleave: keeps the longer provider tail', O.interleave([[item('w1', 'w')], [item('d1', 'd'), item('d2', 'd')]]).length === 3);
ok('interleave: deduplicates matching original sources', (() => {
  const source = 'https://x.com/a/status/7';
  return O.interleave([[item('w1', 'w', source)], [item('d1', 'd', source)]]).length === 1;
})());
ok('allowedDownloadUrl: accepts only the provider CDN', (() => {
  return O.allowedDownloadUrl({ provider: 'wallhaven', full: 'https://w.wallhaven.cc/full/a.jpg' })
    && O.allowedDownloadUrl({ provider: 'danbooru', full: 'https://cdn.donmai.us/original/a.jpg' })
    && O.allowedDownloadUrl({ provider: 'gelbooru', full: 'https://img4.gelbooru.com/images/a.jpg' })
    && !O.allowedDownloadUrl({ provider: 'gelbooru', full: 'https://gelbooru.com/images/a.jpg' })
    && !O.allowedDownloadUrl({ provider: 'danbooru', full: 'https://example.com/a.jpg' });
})());
ok('allowedFullFetchUrl: like download + Gelbooru apex hotlink.php', (() => {
  return O.allowedFullFetchUrl({ provider: 'wallhaven', full: 'https://w.wallhaven.cc/full/a.jpg' })
    && O.allowedFullFetchUrl({ provider: 'gelbooru', full: 'https://img4.gelbooru.com/images/a.jpg' })
    && O.allowedFullFetchUrl({ provider: 'gelbooru', full: 'https://gelbooru.com/hotlink.php?hash=/images/1d/6e/x.jpeg' })
    && !O.allowedFullFetchUrl({ provider: 'gelbooru', full: 'https://gelbooru.com/index.php?page=post' })
    && !O.allowedFullFetchUrl({ provider: 'wallhaven', full: 'https://example.com/a.jpg' });
})());
ok('allowedSampleFetchUrl: validates the sample URL by provider host', (() => {
  return O.allowedSampleFetchUrl({ provider: 'gelbooru', sample: 'https://img3.gelbooru.com/samples/sample_a.jpg' })
    && O.allowedSampleFetchUrl({ provider: 'danbooru', sample: 'https://cdn.donmai.us/sample/a.jpg' })
    && !O.allowedSampleFetchUrl({ provider: 'gelbooru', sample: 'https://example.com/a.jpg' })
    && !O.allowedSampleFetchUrl({ provider: 'gelbooru' });
})());
ok('allowedThumbnailUrl: accepts only booru CDN previews', (() => {
  return O.allowedThumbnailUrl({ provider: 'danbooru', thumb: 'https://cdn.donmai.us/180x180/a.jpg' })
    && O.allowedThumbnailUrl({ provider: 'gelbooru', thumb: 'https://img3.gelbooru.com/thumbnails/a.jpg' })
    && !O.allowedThumbnailUrl({ provider: 'gelbooru', thumb: 'https://example.com/a.jpg' })
    && !O.allowedThumbnailUrl({ provider: 'danbooru', thumb: 'https://example.com/a.jpg' })
    && !O.allowedThumbnailUrl({ provider: 'danbooru', thumb: 'https://cdn.donmai.us:444/180x180/a.jpg' })
    && !O.allowedThumbnailUrl({ provider: 'wallhaven', thumb: 'https://cdn.donmai.us/180x180/a.jpg' });
})());
ok('thumbnailDataUrl: accepts supported images and rejects HTML', (() => {
  const dataUrl = O.thumbnailDataUrl(Buffer.from('image'), 'image/jpeg; charset=binary');
  return dataUrl === 'data:image/jpeg;base64,aW1hZ2U=' && O.thumbnailDataUrl(Buffer.from('nope'), 'text/html') === '';
})());
ok('allowedPageUrl: accepts only the provider post site', (() => {
  return O.allowedPageUrl({ provider: 'wallhaven', page: 'https://wallhaven.cc/w/abc123' })
    && O.allowedPageUrl({ provider: 'danbooru', page: 'https://danbooru.donmai.us/posts/123' })
    && O.allowedPageUrl({ provider: 'gelbooru', page: 'https://gelbooru.com/index.php?page=post&s=view&id=123' })
    && !O.allowedPageUrl({ provider: 'wallhaven', page: 'https://example.com/w/abc123' });
})());
ok('merge: one failed provider does not fail the search', (() => {
  const result = O.mergeSearchResults([
    { provider: 'wallhaven', items: [item('w1', 'w')], meta: { lastPage: 2 }, error: null },
    { provider: 'danbooru', items: [], meta: {}, error: '429' },
  ], 1);
  return result.error === null && result.items.length === 1 && result.providerErrors.danbooru === '429' && result.meta.hasMore;
})());
ok('merge: both failures are reported', (() => {
  const result = O.mergeSearchResults([{ provider: 'w', error: '500' }, { provider: 'd', error: '429' }], 1);
  return result.items.length === 0 && result.error.includes('500') && result.error.includes('429');
})());
ok('merge: Danbooru optimistic page keeps Show more visible', (() => {
  const result = O.mergeSearchResults([{ provider: 'd', items: [], meta: { hasMore: true }, error: null }], 5);
  return result.meta.lastPage === 6 && result.meta.hasMore;
})());
ok('fallback: successful primary is kept', (() => {
  const primary = { provider: 'gelbooru', items: [item('g1', 'g')], error: null };
  return O.resolveFallback(primary, { provider: 'danbooru', items: [item('d1', 'd')], error: null }) === primary;
})());
ok('fallback: Danbooru replaces a failed Gelbooru request', (() => {
  const result = O.resolveFallback(
    { provider: 'gelbooru', items: [], error: '429' },
    { provider: 'danbooru', items: [item('d1', 'd')], meta: { hasMore: true }, error: null },
  );
  return result.provider === 'danbooru' && result.items.length === 1 && result.fallbackFrom === 'gelbooru' && result.fallbackReason === '429';
})());
ok('fallback: both provider errors are retained', (() => {
  const result = O.resolveFallback({ provider: 'gelbooru', error: 'timeout' }, { provider: 'danbooru', error: '429' });
  return result.provider === 'gelbooru' && result.error.includes('timeout') && result.error.includes('429');
})());
console.log('\nAll ' + passed + ' online provider tests passed.');
