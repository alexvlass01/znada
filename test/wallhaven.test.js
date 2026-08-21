'use strict';

// Plain Node test: `node test/wallhaven.test.js`. Covers the pure parts of the
// Wallhaven client — URL building (incl. apikey gating) + response parsing.

const assert = require('assert');
const W = require('../src/wallhaven');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

// ---- masks ----
ok('purityMask: default = sfw+sketchy (110)', W.purityMask() === '110');
ok('purityMask: all', W.purityMask({ sfw: true, sketchy: true, nsfw: true }) === '111');
ok('purityMask: sfw only', W.purityMask({ sfw: true, sketchy: false, nsfw: false }) === '100');
ok('categoryMask: default all (111)', W.categoryMask() === '111');

// ---- buildSearchUrl ----
const u1 = W.buildSearchUrl({ q: 'nature space', purity: '110', categories: '111', page: 2 });
ok('buildSearchUrl: q encoded', u1.includes('q=nature+space') || u1.includes('q=nature%20space'));
ok('buildSearchUrl: purity + categories', u1.includes('purity=110') && u1.includes('categories=111'));
ok('buildSearchUrl: page', u1.includes('page=2'));
ok('buildSearchUrl: no apikey when absent', !u1.includes('apikey'));
ok('buildSearchUrl: apikey appended when present', W.buildSearchUrl({ q: 'x', apikey: 'SECRET' }).includes('apikey=SECRET'));
ok('buildSearchUrl: defaults (page>=1, sfw)', (() => {
  const u = W.buildSearchUrl({});
  return u.includes('page=1') && u.includes('purity=100') && u.includes('sorting=date_added');
})());

// ---- parseSearch ----
const sample = {
  data: [
    {
      id: 'abc123', url: 'https://wallhaven.cc/w/abc123', short_url: 'https://whvn.cc/abc123',
      purity: 'sfw', category: 'general', resolution: '1920x1080', file_type: 'image/jpeg',
      source: 'https://example.com/art', path: 'https://w.wallhaven.cc/full/ab/wallhaven-abc123.jpg',
      thumbs: { small: 'https://th.wallhaven.cc/small/ab/abc123.jpg', large: 'https://th.wallhaven.cc/lg/ab/abc123.jpg' },
    },
    { id: 'noPath' }, // missing path -> dropped
  ],
  meta: { current_page: 1, last_page: 5, per_page: 24, total: 120 },
};
const parsed = W.parseSearch(sample);
ok('parseSearch: drops items without path', parsed.items.length === 1);
ok('parseSearch: maps full + thumb + page', (() => {
  const it = parsed.items[0];
  return it.provider === 'wallhaven'
    && it.full === 'https://w.wallhaven.cc/full/ab/wallhaven-abc123.jpg'
    && it.thumb === 'https://th.wallhaven.cc/small/ab/abc123.jpg'
    && it.page === 'https://wallhaven.cc/w/abc123'
    && it.resolution === '1920x1080' && it.width === 1920 && it.height === 1080
    && it.source === 'https://example.com/art';
})());
ok('parseSearch: meta parsed', parsed.meta.currentPage === 1 && parsed.meta.lastPage === 5 && parsed.meta.total === 120);
ok('parseSearch: junk -> empty', (() => {
  const r = W.parseSearch(null);
  return r.items.length === 0 && r.meta.currentPage === 1;
})());

// ONL-008: the search endpoint carries no tags, so the download path reads the
// single-wallpaper endpoint instead.
const wUrl = W.buildWallpaperUrl('6lyd57', { apikey: 'secret' });
ok('buildWallpaperUrl: points at the single-wallpaper endpoint', wUrl.startsWith(W.WALLPAPER_BASE + '6lyd57'));
ok('buildWallpaperUrl: carries the key when present', wUrl.includes('apikey=secret'));
ok('buildWallpaperUrl: works keyless', W.buildWallpaperUrl('6lyd57') === W.WALLPAPER_BASE + '6lyd57');
ok('buildWallpaperUrl: strips a provider-prefixed id', W.buildWallpaperUrl('wallhaven:6lyd57').endsWith('/6lyd57'));
ok('buildWallpaperUrl: rejects junk ids', W.buildWallpaperUrl('') === '' && W.buildWallpaperUrl(null) === '' && W.buildWallpaperUrl('../etc') === '' && W.buildWallpaperUrl('a b') === '');

const wallpaperJson = { data: { id: '6lyd57', tags: [
  { id: 1, name: 'Anime Girls' },
  { id: 2, name: 'landscape' },
  { id: 3, name: 'anime girls' },
  { id: 4, name: '   ' },
] } };
ok('tagsFromWallpaper: lowercases and deduplicates', W.tagsFromWallpaper(wallpaperJson).join(',') === 'anime girls,landscape');
ok('tagsFromWallpaper: keeps Wallhaven spacing rather than forcing underscores', W.tagsFromWallpaper(wallpaperJson)[0] === 'anime girls');
ok('tagsFromWallpaper: honours the cap', W.tagsFromWallpaper(wallpaperJson, 1).length === 1);
ok('tagsFromWallpaper: tolerates junk and a missing tag list', W.tagsFromWallpaper(null).length === 0 && W.tagsFromWallpaper({}).length === 0 && W.tagsFromWallpaper({ data: {} }).length === 0);
ok('tagsFromWallpaper: accepts an already-unwrapped body', W.tagsFromWallpaper({ tags: [{ name: 'nature' }] }).join(',') === 'nature');

console.log('\nAll ' + passed + ' wallhaven tests passed.');
