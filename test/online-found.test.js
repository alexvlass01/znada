'use strict';

// ONL-004. "How many did each site find?" — from the site's answer to one short number beside
// the site in Sources. The owner's decisions of 2026-09-27: per site, no combined total, no
// line under the filters, and nothing while "Fits my screen" is on. Each layer is checked
// where it lives, and the whole path runs once through the REAL `internet-search` handler
// (network stubbed) and the REAL window functions.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const OnlineFound = require('../renderer/online-found');
const online = require('../src/online');
const danbooru = require('../src/danbooru');
const gelbooru = require('../src/gelbooru');
const { makeTempProfile, loadMain, writeJson } = require('./helpers/main-harness');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

const t = (key, params) => `${key}|${params ? params.sites : ''}`;
const PROVIDERS = [
  { id: 'wallhaven', name: 'Wallhaven' },
  { id: 'gelbooru', name: 'Gelbooru' },
  { id: 'danbooru', name: 'Danbooru' },
  { id: 'lumina', name: 'Znada' },
];

// --- the number beside one site --------------------------------------------------
{
  const label = (totals, id, extra = {}) => OnlineFound.countLabel({ totals, id, locale: 'en', ...extra });
  const big = label({ gelbooru: 1979 }, 'gelbooru');
  ok('a site shows one short number, with the full one kept for its tooltip',
    big.text === '2K' && big.exact === '1,979');
  ok('small numbers stay as they are', label({ gelbooru: 844 }, 'gelbooru').text === '844');
  ok('a site that found nothing says 0 — that is an answer', label({ wallhaven: 0 }, 'wallhaven').text === '0');
  ok('with "Fits my screen" on there is no number at all — none would be honest',
    label({ gelbooru: 2700 }, 'gelbooru', { sizeFiltered: true }) === null);
  ok('a site without a number shows nothing, not 0',
    label({}, 'danbooru') === null && label({ danbooru: null }, 'danbooru') === null
    && label({ danbooru: NaN }, 'danbooru') === null && label({ danbooru: -1 }, 'danbooru') === null
    && label({ danbooru: '5' }, 'danbooru') === null && label(undefined, 'danbooru') === null);
  ok('numbers follow the language of the window',
    label({ gelbooru: 1979 }, 'gelbooru', { locale: 'uk' }).exact === new Intl.NumberFormat('uk').format(1979));
}

// --- merged reply ---------------------------------------------------------------
{
  const merged = online.mergeSearchResults([
    { provider: 'gelbooru', items: [], meta: { total: 1979 }, error: null },
    { provider: 'wallhaven', items: [], meta: { total: 0 }, error: null },
    { provider: 'danbooru', items: [], meta: { total: null }, error: null },
    { provider: 'lumina', items: [], meta: {}, error: null },
    { provider: 'broken', items: [], meta: { total: 50 }, error: 'timeout' },
  ]);
  ok('each site keeps its own number through the merge',
    merged.totals.gelbooru === 1979 && merged.totals.wallhaven === 0);
  ok('a site without a count and a failed site are not given one',
    !('danbooru' in merged.totals) && !('lumina' in merged.totals) && !('broken' in merged.totals));
}

// --- Danbooru: counted separately, once ----------------------------------------
{
  const request = { q: 'hakurei_reimu', purity: { sfw: false, sketchy: true, nsfw: true }, sorting: 'toplist', formats: ['jpg', 'png'] };
  const countUrl = new URL(danbooru.buildCountUrl(request));
  ok('the count asks the site\'s own count endpoint', countUrl.origin + countUrl.pathname === danbooru.COUNT_BASE);
  ok('with exactly the tags the page is asked with',
    countUrl.searchParams.get('tags') === danbooru.buildSearchTags(request));
  ok('a count is read only from a real number',
    danbooru.parseCount({ counts: { posts: 578 } }) === 578
    && danbooru.parseCount({ counts: {} }) === null && danbooru.parseCount([]) === null);
}

(async () => {
  {
    const asked = [];
    const ctx = {
      fetchJson: async (url) => {
        asked.push(url);
        if (url.startsWith(danbooru.COUNT_BASE)) return { json: { counts: { posts: 1214 } } };
        return { json: [] };
      },
    };
    const first = await danbooru.search({ q: 'hakurei_reimu', page: 1 }, ctx);
    ok('the first page of a typed search carries the site\'s count', first.meta.total === 1214);
    asked.length = 0;
    const second = await danbooru.search({ q: 'hakurei_reimu', page: 2 }, ctx);
    ok('later pages do not ask again', second.meta.total === null && asked.length === 1);
    asked.length = 0;
    await danbooru.search({ q: '', page: 1 }, ctx);
    ok('the front page is not counted', asked.length === 1);
    const failed = await danbooru.search({ q: 'sky', page: 1 }, {
      fetchJson: async (url) => (url.startsWith(danbooru.COUNT_BASE) ? { error: '500' } : { json: [] }),
    });
    ok('a failed count leaves the search intact and names no number', !failed.error && failed.meta.total === null);
  }

  // --- Gelbooru: videos are not asked for, so its number is what can be shown ---
  {
    const tags = gelbooru.buildSearchTags({ q: 'hakurei_reimu', purity: { sfw: true, sketchy: true, nsfw: true } });
    ok('Gelbooru is asked without videos', tags.split(' ').includes('-video'));
    ok('on the front page too', gelbooru.buildSearchTags({ q: '' }).split(' ').includes('-video'));
    ok('a fingerprint lookup is not changed by it',
      new URL(gelbooru.buildMd5Url('a'.repeat(32))).searchParams.get('tags') === 'md5:' + 'a'.repeat(32));
  }

  // --- the real handler -------------------------------------------------------
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    urls.push(target);
    let body = [];
    if (target.includes('wallhaven.cc')) body = { data: [], meta: { current_page: 1, last_page: 1, per_page: 24, total: 0 } };
    else if (target.includes('gelbooru.com')) {
      body = {
        post: [{ id: 1, md5: 'b'.repeat(32), image: 'g.jpg', file_url: 'https://img3.gelbooru.com/images/aa/bb/g.jpg',
          preview_url: 'https://img3.gelbooru.com/thumbnails/aa/bb/g.jpg', width: 1920, height: 1080, rating: 'general', tags: 'sky' }],
        '@attributes': { count: 1979, offset: 0 },
      };
    } else if (target.includes('/counts/posts.json')) body = { counts: { posts: 1214 } };
    else if (target.includes('donmai.us')) body = [];
    return { ok: true, status: 200, json: async () => body };
  };
  function setup(label, patch = {}) {
    const userData = makeTempProfile(label);
    writeJson(path.join(userData, 'config.json'), {
      autoSwitch: true, style: 'fill', monitors: {},
      onlineSources: { lumina: false, internet: true, providers: { wallhaven: true, gelbooru: true, danbooru: true } },
      ...patch,
    });
    const main = loadMain(userData);
    main.__test.setProviderCredentials('gelbooru', { userId: 'test', apiKey: 'test' });
    main.__test.loadConfig();
    return main;
  }
  const purity = { sfw: true, sketchy: true, nsfw: true };
  try {
    {
      const main = setup('found-search');
      const res = await main.invoke('internet-search', { q: 'hakurei_reimu', sort: 'toplist', purity, browse: false });
      ok('a search reply carries every site\'s own number',
        res.totals && res.totals.gelbooru === 1979 && res.totals.danbooru === 1214 && res.totals.wallhaven === 0);
      ok('and says they are not before a screen check', res.sizeFiltered === false);
      ok('Danbooru is counted once for the search',
        urls.filter((u) => u.includes('/counts/posts.json')).length === 1);
    }
    {
      urls.length = 0;
      const main = setup('found-browse');
      const res = await main.invoke('internet-search', { q: '', sort: 'date_added', purity, browse: true });
      ok('the front page carries no numbers — it is our selection, not an answer',
        res.browsing === true && Object.keys(res.totals).length === 0);
      ok('and nobody is asked to count it', !urls.some((u) => u.includes('/counts/posts.json')));
    }
    {
      const main = setup('found-screen', {
        onlineSizeFilter: { enabled: true, mode: 'manual', targets: [{ ratio: 16 / 9, minWidth: 1920, minHeight: 1080 }] },
      });
      const res = await main.invoke('internet-search', { q: 'hakurei_reimu', sort: 'toplist', purity, browse: false });
      ok('with the screen filter on, the reply says so, and the window then shows no numbers',
        res.sizeFiltered === true && res.totals.gelbooru === 1979);
    }
  } finally {
    globalThis.fetch = original;
  }

  // --- the window -------------------------------------------------------------
  {
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8').split('\r\n').join('\n');
    const fnSrc = (name) => {
      const m = renderer.match(new RegExp(`(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
      assert.ok(m, `${name} must remain an explicit renderer boundary`);
      return m[0];
    };
    // The Sources menu as the real rows build it: one count span per site.
    const spans = ['wallhaven', 'gelbooru', 'danbooru'].map((id) => ({ dataset: { countFor: id }, textContent: '', title: '' }));
    const shown = () => Object.fromEntries(spans.map((el) => [el.dataset.countFor, el.textContent]));
    const host = { querySelectorAll: (sel) => (sel === '.online-source-count' ? spans : []) };
    const note = { textContent: '' };
    let reply = { items: [{ id: 'g1' }], totals: { gelbooru: 1979, danbooru: 1214, wallhaven: 0 }, sizeFiltered: false, resume: { p: 2 } };
    const ctx = {
      LIB: { filter: 'online' },
      ONLINE: { generation: 0, loading: false, loaded: false, view: 'search', entries: [] },
      INTERNET: { q: '', sort: 'toplist', purity: {}, resume: null, sortTouched: false, providers: PROVIDERS, totals: {}, sizeFiltered: false },
      OnlineBrowse: { isBrowse: () => false, sortTouchedAfterSearch: (q, touched) => touched },
      OnlineFound,
      console: { error: () => {} },
      t,
      detailsLocale: () => 'en',
      $: (sel) => ({ '#whNote': note, '#onlineSourceOptions': host, '#whMore': { hidden: true, disabled: false }, '#whQuery': { value: 'hakurei_reimu' } }[sel] || null),
      hideOnlineTagSuggest: () => {},
      applyFavToggleUI: () => {},
      replaceOnlineEntries: (list) => { ctx.ONLINE.entries = list.slice(); },
      appendOnlineEntries: (batch) => { ctx.ONLINE.entries = ctx.ONLINE.entries.concat(batch); return batch.length; },
      setLibViewHeader: () => {},
      // BUG-048: finalizing a page with cards re-asks the end-of-feed watcher; covered in
      // test/online-renderer-integration.test.js, not here.
      recheckOnlineAutoLoad: () => {},
      updatePurityToggle: () => {},
      onlineGridDescriptor: (kind, item) => ({ kind, item, key: item.id }),
      onlineAutoLoad: require('../renderer/auto-load').createAutoLoader(),
      window: { api: { internetSearch: async () => reply } },
    };
    vm.createContext(ctx);
    for (const n of ['onlineSearchIsCurrent', 'loadInternetResults', 'publishOnlineBatch',
      'finalizeOnlineFeed', 'doOnlineSearch', 'loadMoreOnline', 'renderOnlineSourceCounts']) {
      vm.runInContext(fnSrc(n), ctx);
    }
    await ctx.doOnlineSearch(true);
    ok('after a search each site in Sources shows its own short number',
      JSON.stringify(shown()) === JSON.stringify({ wallhaven: '0', gelbooru: '2K', danbooru: '1.2K' }));
    ok('with the exact number on hover', spans[1].title === '1,979');
    ok('and no line is added above the grid', note.textContent === '');

    reply = { items: [{ id: 'g2' }], totals: { gelbooru: 1979 }, sizeFiltered: false, resume: null };
    await ctx.loadMoreOnline();
    ok('a later page that no longer asks Danbooru keeps the number Danbooru already gave', shown().danbooru === '1.2K');

    let release;
    reply = new Promise((r) => { release = r; });
    const pending = ctx.doOnlineSearch(true);
    ok('a new search clears the old numbers while it is still asking',
      spans.every((el) => el.textContent === '' && el.title === ''));
    release({ items: [{ id: 'g3' }], totals: { gelbooru: 2700 }, sizeFiltered: true, resume: null });
    await pending;
    ok('with "Fits my screen" on, no site shows a number', spans.every((el) => el.textContent === ''));

    reply = { items: [], totals: {}, resume: null };
    await ctx.doOnlineSearch(true);
    ok('a reply with no numbers (the front page) shows none', spans.every((el) => el.textContent === ''));

    // The numbers are read when the menu opens — the real init wires that; nothing else in
    // the favourites path touches them.
    const listeners = {};
    Object.assign(ctx, {
      bindAnchoredPopover: () => {},
      renderOnlineQuickFilters: () => {},
      saveSizeFilter: () => {},
      sizeFilterState: () => ({ enabled: false }),
      document: { querySelectorAll: () => [] },
    });
    const popover = { addEventListener: (type, fn) => { listeners[type] = fn; } };
    const $real = ctx.$;
    ctx.$ = (sel) => (sel === '#onlineFilterPopover' ? popover : $real(sel));
    vm.runInContext(fnSrc('initOnlineFilterMenu'), ctx);
    ctx.initOnlineFilterMenu();
    ok('opening the menu reads the numbers afresh', typeof listeners.toggle === 'function');
    ctx.INTERNET.totals = { gelbooru: 5 }; ctx.INTERNET.sizeFiltered = false;
    listeners.toggle({ newState: 'open' });
    ok('in a search they appear when the menu opens', shown().gelbooru === '5');
    ctx.ONLINE.view = 'favorites';
    listeners.toggle({ newState: 'open' });
    ok('the favourites view shows no search numbers', spans.every((el) => el.textContent === ''));
  }



  console.log(`\nAll ${passed} online-found tests passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
