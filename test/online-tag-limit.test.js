'use strict';

// LIB-014 stage 3 (closes BUG-051). A site that cannot take this many words sits the search out.
//
// Danbooru without an account takes two words and counts its own sort among them, so two typed
// tags with "Top" were sent anyway, refused with 422, and the window said the site could not
// load results. The boards also kept only the first two typed tags and dropped the rest without
// a word. The owner's decision: such a site is "paused" for that search — not asked, not called
// failed, and the user's choice of sites is left alone.
//
// Checked where each part lives: the rule on the measured table, every site in the registry
// against what it really sends, the REAL `internet-search` handler with the network stubbed,
// and the REAL window functions.
//
// Run: node test/online-tag-limit.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const tagLimit = require('../src/online-tag-limit');
const registry = require('../src/provider-registry');
const TagSuggest = require('../src/tag-suggest');
const OnlineFound = require('../renderer/online-found');
const { makeTempProfile, loadMain, writeJson } = require('./helpers/main-harness');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

const SORTS = ['date_added', 'toplist', 'random', 'views'];
const SFW = { sfw: true, sketchy: false, nsfw: false };
const danbooru = registry.byId('danbooru');
const catalogue = registry.byId('znada');
const verdict = (descriptor, q, sort = 'date_added', extra = {}) =>
  tagLimit.verdict(descriptor, { q, sort, purity: SFW, formats: ['jpg', 'png', 'webp'], ...extra });

// --- the rule ----------------------------------------------------------------------
{
  ok('a search command is known by its name, with or without - and ~',
    tagLimit.commandName('rating:g') === 'rating' && tagLimit.commandName('-rating:general') === 'rating'
    && tagLimit.commandName('~order:score') === 'order' && tagLimit.commandName('sky') === '');
  ok('words a site does not count are not counted; everything else is',
    tagLimit.countWords(['a', '-b', '~c', 'rating:g', 'order:score', 'width:>=1'], ['rating', 'width']) === 4);
  ok('a site without a declared limit always fits',
    tagLimit.verdict({ capabilities: { tagLimit: null } }, { q: 'a b c d e f g' }).fits === true
    && tagLimit.verdict({}, { q: 'a b c' }).fits === true);
}

// --- Danbooru, as measured on 2026-10-02 ---------------------------------------------
{
  ok('one tag fits with every sort', SORTS.every((sort) => verdict(danbooru, 'sky', sort).fits));
  ok('two tags fit with "Latest"', verdict(danbooru, 'sky mountain', 'date_added').fits);
  ok('two tags with Top, Random or Views do not — the sort is the third word — and "Latest" would help',
    ['toplist', 'random', 'views'].every((sort) => {
      const v = verdict(danbooru, 'sky mountain', sort);
      return !v.fits && v.max === 2 && v.used === 3 && v.sortHelps === true;
    }));
  ok('three tags never fit, and then no sort would help',
    SORTS.every((sort) => { const v = verdict(danbooru, 'sky mountain lake', sort); return !v.fits && !v.sortHelps; }));
  ok('an excluded tag and a ~tag are words too (measured)',
    !verdict(danbooru, '-sky mountain', 'toplist').fits && !verdict(danbooru, '~sky ~mountain ~lake').fits
    && verdict(danbooru, '~sky ~mountain').fits);
  ok('rating, file type, size floors and mpixels are not counted (measured)',
    verdict(danbooru, 'sky mountain', 'date_added', {
      purity: { sfw: true, sketchy: true, nsfw: true },
      sizeHints: { minWidth: 1920, minHeight: 1080, minRatio: 1.7, everyTargetHasRatio: true },
    }).fits);
  ok('the front page fits: no typed tag, and its "Top" is one word', verdict(danbooru, '', 'toplist').fits);
  ok('a phrase is one tag', verdict(danbooru, 'blue sky, sea', 'date_added').fits
    && !verdict(danbooru, 'blue sky, sea', 'toplist').fits);
}

// --- our catalogue: one tag, spelled like every other site's ---------------------------
{
  ok('one tag fits, two do not, and no sort helps',
    verdict(catalogue, 'nature').fits && !verdict(catalogue, 'nature sky').fits
    && verdict(catalogue, 'nature sky', 'toplist').sortHelps === false);
  ok('its words are the box\'s site tags', JSON.stringify(catalogue.searchTerms({ q: 'Blue Sky,' })) === '["blue_sky"]');
}

// --- every site in the registry, against what it really sends ---------------------------
(async () => {
  for (const descriptor of registry.PROVIDERS.filter((p) => p.capabilities && p.capabilities.textSearch)) {
    const caps = descriptor.capabilities;
    ok(`${descriptor.id}: states its tag limit, even when there is none`,
      Object.prototype.hasOwnProperty.call(caps, 'tagLimit'));
    if (caps.tagLimit) {
      ok(`${descriptor.id}: a limit says how many, which commands are free and when it was measured`,
        Number.isInteger(caps.tagLimit.max) && caps.tagLimit.max >= 1 && Array.isArray(caps.tagLimit.free)
        && /^\d{4}-\d{2}-\d{2}$/.test(String(caps.tagLimit.measured)));
      ok(`${descriptor.id}: a site with a limit can say what it would send`, typeof descriptor.searchTerms === 'function');
    }
  }

  // Ask each site the way the shared handler would, with a network that only writes down
  // what was asked. Every case the check lets through must carry every typed tag and stay
  // within the limit; a case it holds back must really be over the limit.
  const words = ['sky', 'mountain', 'lake', 'forest', 'river', 'cloud'];
  for (const descriptor of registry.active().filter((p) => p.capabilities && p.capabilities.browse)) {
    const limit = descriptor.capabilities.tagLimit;
    const problems = [];
    for (const sort of SORTS) {
      for (let n = 0; n <= words.length; n += 1) {
        for (const negative of [false, true]) {
          for (const sizeHints of [undefined, { minWidth: 1920, minHeight: 1080, minRatio: 1.7, everyTargetHasRatio: true }]) {
            const typed = words.slice(0, n).map((w, i) => (negative && i === n - 1 ? `-${w}` : w));
            const params = { q: typed.join(' '), sort, purity: SFW, page: 1, formats: ['jpg', 'png'], sizeHints };
            const v = tagLimit.verdict(descriptor, params);
            const label = `${sort}/${n}${negative ? '-' : ''}${sizeHints ? '/size' : ''}`;
            const asked = [];
            const ctx = {
              fetchJson: async (url) => { asked.push(String(url)); return { error: 'stub' }; },
              credentials: descriptor.id === 'znada'
                ? { client: { getCatalog: async (o) => { asked.push(o); return { ok: false, error: { code: 'stub' } }; } } }
                : { userId: 'u', apiKey: 'k', key: '' },
            };
            if (!v.fits) {
              if (!limit || v.used <= limit.max) problems.push(`${label}: held back while within the limit`);
              continue;
            }
            await descriptor.search(params, ctx);
            const first = asked[0];
            if (!first) { problems.push(`${label}: nothing was asked`); continue; }
            let sent;
            if (typeof first === 'object') sent = first.tag ? [first.tag] : [];
            else {
              // A board's `tags` is split on spaces only (`filetype:jpg,png` is one word there);
              // Wallhaven reads its free-text `q` on spaces and commas alike.
              const url = new URL(first);
              sent = url.searchParams.has('tags')
                ? String(url.searchParams.get('tags')).split(/\s+/).filter(Boolean)
                : String(url.searchParams.get('q') || '').split(/[\s,]+/).filter(Boolean);
            }
            const missing = TagSuggest.siteTags(params.q).filter((tag) => !sent.includes(tag));
            if (missing.length) problems.push(`${label}: dropped ${missing.join(' ')}`);
            if (limit && tagLimit.countWords(sent, limit.free) > limit.max) problems.push(`${label}: sent over the limit`);
          }
        }
      }
    }
    ok(`${descriptor.id}: every search it is asked carries every typed tag and stays within its limit`,
      problems.length === 0 || console.error(problems.slice(0, 5)));
  }

  ok('the catalogue refuses rather than cuts, if anyone asks it with two tags',
    (await catalogue.search({ q: 'a b' }, { credentials: { client: { getCatalog: async () => assert.fail('asked') } } })).error === 'tag_limit');
  {
    let asked = null;
    await catalogue.search({ q: ' Nature, ' }, { credentials: { client: { getCatalog: async (o) => { asked = o; return { ok: true, data: { items: [] } }; } } } });
    ok('the catalogue gets its tag spelled like every other site\'s, not the raw text', asked && asked.tag === 'nature');
  }

  // --- what stands beside a site in Sources ---------------------------------------------
  {
    const state = (extra) => OnlineFound.sourceState({ totals: { danbooru: 5, gelbooru: 7 }, paused: { danbooru: { max: 2, sortHelps: true } }, locale: 'en', ...extra });
    ok('a paused site shows the pause, not a number', JSON.stringify(state({ id: 'danbooru' })) === '{"paused":true,"sortHelps":true}');
    ok('the pause stays with "Fits my screen" on: it is not a number', state({ id: 'danbooru', sizeFiltered: true }).paused === true
      && state({ id: 'gelbooru', sizeFiltered: true }) === null);
    ok('the others show their numbers as before', state({ id: 'gelbooru' }).paused === false && state({ id: 'gelbooru' }).text === '7');
  }

  // --- the REAL handler ------------------------------------------------------------------
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    urls.push(target);
    let body = [];
    if (target.includes('wallhaven.cc')) {
      body = { data: [{ id: `wh${urls.length}`, url: `https://wallhaven.cc/w/wh${urls.length}`,
        path: `https://w.wallhaven.cc/full/wh${urls.length}.jpg`, thumbs: { small: `https://th.wallhaven.cc/small/wh${urls.length}.jpg` },
        resolution: '3840x2160', dimension_x: 3840, dimension_y: 2160, file_type: 'image/jpeg', purity: 'sfw', category: 'general' }],
      meta: { current_page: 1, last_page: 3, per_page: 24, total: 40 } };
    } else if (target.includes('gelbooru.com')) {
      body = { post: [{ id: `${urls.length}1`, md5: `${urls.length}`.padEnd(32, 'a'), image: 'g.jpg',
        file_url: `https://img3.gelbooru.com/images/aa/bb/g${urls.length}.jpg`,
        preview_url: `https://img3.gelbooru.com/thumbnails/aa/bb/g${urls.length}.jpg`,
        width: 1920, height: 1080, rating: 'general', tags: 'sky tree' }], '@attributes': { count: 100, offset: 0 } };
    } else if (target.includes('/counts/posts.json')) {
      body = { counts: { posts: 12 } };
    } else if (target.includes('donmai.us')) {
      body = [{ id: urls.length, md5: `d${urls.length}`.padEnd(32, 'a'), file_ext: 'jpg',
        file_url: `https://cdn.donmai.us/original/aa/d${urls.length}.jpg`, preview_file_url: `https://cdn.donmai.us/preview/aa/d${urls.length}.jpg`,
        image_width: 1920, image_height: 1080, rating: 'g', tag_string: 'sky', tag_string_general: 'sky' }];
    }
    return { ok: true, status: 200, json: async () => body };
  };
  const setup = (label, providers) => {
    const userData = makeTempProfile(label);
    writeJson(path.join(userData, 'config.json'), {
      autoSwitch: true, style: 'fill', monitors: {},
      onlineSources: { lumina: false, internet: true, providers },
    });
    const main = loadMain(userData);
    main.__test.setProviderCredentials('gelbooru', { userId: 'test', apiKey: 'test' });
    main.__test.loadConfig();
    return main;
  };
  const tagsOf = (host) => urls.filter((u) => u.includes(host) && !u.includes('/counts/'))
    .map((u) => String(new URL(u).searchParams.get('tags') || '').split(' '));
  const all = { wallhaven: true, gelbooru: true, danbooru: true };
  try {
    {
      urls.length = 0;
      const main = setup('limit-top', all);
      const res = await main.invoke('internet-search', { q: 'sky mountain', sort: 'toplist', purity: SFW, browse: false });
      ok('two tags and Top: Danbooru is not asked at all — no page, no count',
        !urls.some((u) => u.includes('donmai.us')));
      ok('…it is named as paused, with "Latest would help", and not as failed',
        res.paused && res.paused.danbooru && res.paused.danbooru.max === 2 && res.paused.danbooru.sortHelps === true
        && !(res.providerErrors || {}).danbooru && res.error === null && res.allPaused === false);
      ok('…it gets no number, and the others answer as usual',
        res.totals.danbooru === undefined && res.items.length > 0 && urls.some((u) => u.includes('wallhaven.cc')));
      ok('…Gelbooru is sent both tags', tagsOf('gelbooru.com').some((t) => t.includes('sky') && t.includes('mountain')));
      const before = JSON.stringify(main.__test.getConfig().onlineSources);
      urls.length = 0;
      const more = await main.invoke('internet-search', { q: 'sky mountain', sort: 'toplist', purity: SFW, browse: false, resume: res.resume });
      ok('the next page keeps it paused and still does not ask it',
        more.paused.danbooru && !urls.some((u) => u.includes('donmai.us')));
      ok('the user\'s choice of sites is left exactly as it was', JSON.stringify(main.__test.getConfig().onlineSources) === before
        && main.__test.getConfig().onlineSources.providers.danbooru === true);
      // The token's signature names the chosen sites; its slots are where each site got to.
      const slots = (r) => Object.keys((r && r.resume && r.resume.slots) || {});
      ok('and nothing about it went into the bookmarks — no place kept, no failure counted',
        slots(more).length > 0 && !slots(res).concat(slots(more)).some((key) => key.startsWith('danbooru@')));
    }
    {
      urls.length = 0;
      const main = setup('limit-latest', all);
      const res = await main.invoke('internet-search', { q: 'sky mountain', sort: 'date_added', purity: SFW, browse: false });
      ok('two tags with "Latest": Danbooru is asked, with both tags',
        Object.keys(res.paused).length === 0 && tagsOf('donmai.us').some((t) => t.includes('sky') && t.includes('mountain')));
    }
    {
      urls.length = 0;
      const main = setup('limit-three', all);
      const res = await main.invoke('internet-search', { q: 'sky mountain lake', sort: 'date_added', purity: SFW, browse: false });
      ok('three tags: Danbooru is paused even with "Latest", and no sort would help',
        res.paused.danbooru && res.paused.danbooru.sortHelps === false && !urls.some((u) => u.includes('donmai.us')));
      ok('…and Gelbooru gets all three — the third used to be dropped',
        tagsOf('gelbooru.com').some((t) => ['sky', 'mountain', 'lake'].every((w) => t.includes(w))));
    }
    {
      urls.length = 0;
      const main = setup('limit-only', { wallhaven: false, gelbooru: false, danbooru: true });
      const res = await main.invoke('internet-search', { q: 'sky mountain lake', sort: 'date_added', purity: SFW, browse: false });
      ok('every chosen site paused: nobody is asked, no error, and the reply says why',
        urls.length === 0 && res.items.length === 0 && res.error === null && res.allPaused === true
        && res.paused.danbooru && Object.keys(res.providerErrors || {}).length === 0);
      ok('…and there is no "more" to fetch, so nothing keeps asking', res.resume === null);
    }
    {
      // The round's own order is what is counted, whatever else the request carried: the
      // front page asks two orders in one go, and only the round knows which one it is.
      urls.length = 0;
      const main = setup('limit-round', all);
      const round = await main.__test.searchRound(null, 'toplist', { q: 'sky mountain', purity: SFW }, [danbooru]);
      ok('a round counts its own sort', round.paused.danbooru && round.attempts.length === 0 && urls.length === 0);
    }
    {
      urls.length = 0;
      const main = setup('limit-browse', all);
      const res = await main.invoke('internet-search', { q: '', sort: 'date_added', purity: SFW, browse: true });
      ok('the front page is untouched: Danbooru is asked, nobody is paused',
        Object.keys(res.paused).length === 0 && urls.some((u) => u.includes('donmai.us')));
    }
  } finally {
    globalThis.fetch = original;
  }

  // --- the window -------------------------------------------------------------------------
  {
    const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8').split('\r\n').join('\n');
    const fnSrc = (name) => {
      const m = renderer.match(new RegExp(`(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
      assert.ok(m, `${name} must remain an explicit renderer boundary`);
      return m[0];
    };
    const mark = renderer.match(/const ONLINE_PAUSE_MARK = [^;]+;/);
    assert.ok(mark, 'the pause mark is one constant');
    // The rows as applyOnlineSourceUI builds them: name, then the number's place.
    const rows = ['wallhaven', 'gelbooru', 'danbooru'].map((id) => {
      const classes = new Set();
      const name = { title: '' };
      const row = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), has: (c) => classes.has(c) },
        querySelector: (sel) => (sel === '.online-source-name' ? name : null) };
      const attrs = {};
      const span = { dataset: { countFor: id }, textContent: '', innerHTML: '', title: '',
        setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; },
        closest: () => row };
      return { id, row, name, span, attrs };
    });
    const by = (id) => rows.find((r) => r.id === id);
    const host = { querySelectorAll: (sel) => (sel === '.online-source-count' ? rows.map((r) => r.span) : []) };
    const note = { textContent: '' };
    let reply = null;
    const ctx = {
      LIB: { filter: 'online' },
      ONLINE: { generation: 0, loading: false, loaded: false, view: 'search', entries: [] },
      INTERNET: { q: '', sort: 'toplist', purity: {}, resume: null, sortTouched: false, providerNames: { danbooru: 'Danbooru' },
        totals: {}, sizeFiltered: false, paused: {}, allPaused: false },
      OnlineBrowse: { isBrowse: () => false, sortTouchedAfterSearch: (q, touched) => touched },
      OnlineFound,
      console: { error: () => {} },
      t: (key) => key,
      detailsLocale: () => 'en',
      $: (sel) => ({ '#whNote': note, '#onlineSourceOptions': host, '#whMore': { hidden: true, disabled: false }, '#whQuery': { value: 'sky mountain' } }[sel] || null),
      hideOnlineTagSuggest: () => {},
      applyFavToggleUI: () => {},
      replaceOnlineEntries: (list) => { ctx.ONLINE.entries = list.slice(); },
      appendOnlineEntries: (batch) => { ctx.ONLINE.entries = ctx.ONLINE.entries.concat(batch); return batch.length; },
      setLibViewHeader: () => {},
      recheckOnlineAutoLoad: () => {},
      updatePurityToggle: () => {},
      onlineGridDescriptor: (kind, item) => ({ kind, item, key: item.id }),
      onlineAutoLoad: require('../renderer/auto-load').createAutoLoader(),
      window: { api: { internetSearch: async () => reply } },
    };
    vm.createContext(ctx);
    vm.runInContext(mark[0], ctx);
    for (const n of ['onlineSearchIsCurrent', 'loadInternetResults', 'publishOnlineBatch',
      'finalizeOnlineFeed', 'doOnlineSearch', 'loadMoreOnline', 'renderOnlineSourceCounts']) {
      vm.runInContext(fnSrc(n), ctx);
    }

    reply = { items: [{ id: 'w1' }], totals: { wallhaven: 40, gelbooru: 100 }, providerErrors: {}, error: null,
      paused: { danbooru: { max: 2, sortHelps: true } }, allPaused: false, resume: null };
    await ctx.doOnlineSearch(true);
    const d = by('danbooru');
    ok('a paused site shows the pause mark where its number would be, and the others their numbers',
      d.span.innerHTML.includes('<svg') && by('wallhaven').span.textContent === '40' && by('gelbooru').span.textContent === '100');
    ok('its name goes quiet, and hovering the name or the mark says the sort is the reason',
      d.row.classList.has('paused') && d.name.title === 'online.sourcePausedSort' && d.span.title === 'online.sourcePausedSort'
      && d.attrs.role === 'img' && d.attrs['aria-label'] === 'online.sourcePausedSort');
    ok('the others are not marked', !by('wallhaven').row.classList.has('paused') && by('wallhaven').name.title === '');
    ok('a pause is not a failure: no "could not load" line, the cards are shown', note.textContent === '' && ctx.ONLINE.entries.length === 1);

    reply = { items: [], totals: {}, providerErrors: {}, error: null,
      paused: { danbooru: { max: 2, sortHelps: false } }, allPaused: true, resume: null };
    await ctx.doOnlineSearch(true);
    ok('when every chosen site sat it out, the feed says so instead of "nothing found"',
      note.textContent === 'online.allSourcesPaused');
    ok('…and the tooltip is the plain one when no sort would help', d.span.title === 'online.sourcePaused');

    reply = { items: [], totals: {}, providerErrors: {}, error: null, paused: {}, allPaused: false, resume: null };
    await ctx.doOnlineSearch(true);
    ok('a new search that fits clears the pause and its marks',
      !d.row.classList.has('paused') && d.span.textContent === '' && d.span.title === '' && d.attrs.role === undefined);
    ok('…and an empty answer is "nothing found" again', note.textContent === 'online.noResults' && d.name.title === '');

    reply = { items: [], totals: {}, providerErrors: { gelbooru: '500' }, error: 'network',
      paused: { danbooru: { max: 2, sortHelps: true } }, allPaused: false, resume: null };
    await ctx.doOnlineSearch(true);
    ok('a site that really failed is still named, and the paused one still shows its pause',
      note.textContent.startsWith('online.sourcesFailed') && d.row.classList.has('paused'));
  }

  console.log(`\nAll ${passed} online-tag-limit tests passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
