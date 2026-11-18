'use strict';

// CODE-001. src/online-search.js and src/provider-access.js on their own, with sites the
// shipped registry cannot produce. The order of things through the real main.js stays proved
// by the harness suites (online-browse-feed, online-tag-limit, online-found, tag-search-main);
// this file proves what used to be pinned as TEXT of main.js — the size filter's rules and
// the list of site names a window is given — as behaviour, plus the two rules a module
// extracted from main.js must keep: settings read at the moment of the request, and no state
// shared between two instances.

const assert = require('assert');
const onlineSearchMod = require('../src/online-search');
const providerAccessMod = require('../src/provider-access');
const sizeFilter = require('../src/size-filter');
const providerRegistry = require('../src/provider-registry');
const online = require('../src/online');

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

// A site that answers `perPage` cards per page, in the sizes `sizes` cycles through, and
// records every request it was sent.
function site(id, { sizes = [[1920, 1080]], perPage = 6, capabilities = {}, failWith = '' } = {}) {
  const calls = [];
  return {
    calls,
    descriptor: {
      id,
      name: `Site ${id}`,
      status: 'active',
      sourceKey: 'internet',
      capabilities: { browse: true, ...capabilities },
      search: async (params) => {
        calls.push(params);
        if (failWith) return { error: failWith };
        const page = params.page || 1;
        const items = Array.from({ length: perPage }, (_, i) => {
          const [width, height] = sizes[(i + page) % sizes.length];
          return { provider: id, id: `${page}-${i}`, format: 'jpg', width, height };
        });
        return { items, meta: { hasMore: true } };
      },
    },
  };
}

function setup({ sites, config, monitors = [] }) {
  const list = sites.map((s) => s.descriptor);
  const registry = { PROVIDERS: list, active: () => list.filter((d) => d.status !== 'retired') };
  const state = { config: config || { onlineSources: { internet: true } } };
  const providers = providerAccessMod.create({ userAgent: 'test' });
  const search = onlineSearchMod.create({
    online,
    getConfig: () => state.config,
    getMonitors: () => monitors,
    providers,
    registry,
    random: () => 0,
  });
  return { search, state, providers };
}

const WIDE = { ratio: 16 / 9, minWidth: 1920, minHeight: 1080 };

(async () => {
  await ok('media kinds bind provider requests and bookmarks to the same selection', async () => {
    const pictures = site('pictures');
    const mixed = site('mixed', { capabilities: { onlineVideo: true } });
    mixed.descriptor.search = async params => {
      mixed.calls.push(params);
      return { items: [
        { provider: 'mixed', id: 1, format: 'mp4' },
        { provider: 'mixed', id: 2, format: 'gif', animated: true },
        { provider: 'mixed', id: 3, format: 'jpg' },
      ], meta: { hasMore: true } };
    };
    const { search } = setup({ sites: [pictures, mixed] });
    const videos = await search.search({ q: 'sky', kinds: ['video'] });
    assert.deepStrictEqual(videos.items.map(item => item.id), [1]);
    assert.deepStrictEqual(mixed.calls[0].formats, ['mp4', 'webm']);
    assert.equal(pictures.calls.length, 0);
    const stills = await search.search({ q: 'sky', kinds: ['photo'], resume: videos.resume });
    assert.equal(mixed.calls[1].page, 1);
    assert.ok(stills.items.some(item => item.id === 3));
    assert.ok(stills.items.every(item => item.format === 'jpg'));
    assert.ok(!mixed.calls[1].formats.includes('mp4'));
  });

  // --- what used to be text pins in test/size-filter.test.js -------------------------

  await ok('every card is judged here whatever a site managed', async () => {
    // Half of what the site sends is 4:3. The site was given the hint; it ignored it.
    const a = site('a', { sizes: [[1920, 1080], [1600, 1200]], perPage: 20 });
    const { search } = setup({
      sites: [a],
      config: { onlineSources: { internet: true }, onlineSizeFilter: { enabled: true, mode: 'manual', targets: [WIDE] } },
    });
    const res = await search.search({ q: 'sky' });
    assert.ok(res.items.length > 0, 'nothing came back');
    assert.ok(res.items.every((item) => sizeFilter.matches(item, [WIDE])), 'a card that does not fit got through');
    assert.strictEqual(res.sizeFiltered, true);
  });

  await ok('the sites are told the loosest bound, not the decision', async () => {
    const a = site('a');
    const targets = [WIDE, { ratio: 21 / 9, minWidth: 3440, minHeight: 1440 }];
    const { search } = setup({
      sites: [a],
      config: { onlineSources: { internet: true }, onlineSizeFilter: { enabled: true, mode: 'manual', targets } },
    });
    await search.search({ q: 'sky' });
    assert.deepStrictEqual(a.calls[0].sizeHints, sizeFilter.serverHints(sizeFilter.normalizeTargets(targets)));
  });

  await ok('a short page is topped up a bounded number of times and then left short', async () => {
    // Nothing this site sends fits, so every round is short: the first request and then
    // exactly the bounded number of extra rounds, never more.
    const a = site('a', { sizes: [[1600, 1200]] });
    const { search } = setup({
      sites: [a],
      config: { onlineSources: { internet: true }, onlineSizeFilter: { enabled: true, mode: 'manual', targets: [WIDE] } },
    });
    const res = await search.search({ q: 'sky' });
    assert.strictEqual(res.items.length, 0);
    assert.strictEqual(a.calls.length, 1 + onlineSearchMod.SIZE_FILTER_EXTRA_ROUNDS);
    assert.deepStrictEqual(a.calls.map((c) => c.page), [1, 2, 3], 'each top-up carries on from the next page');
  });

  await ok('a page that is already full is not topped up', async () => {
    const a = site('a', { perPage: onlineSearchMod.SIZE_FILTER_MIN_CARDS });
    const { search } = setup({
      sites: [a],
      config: { onlineSources: { internet: true }, onlineSizeFilter: { enabled: true, mode: 'manual', targets: [WIDE] } },
    });
    await search.search({ q: 'sky' });
    assert.strictEqual(a.calls.length, 1);
  });

  await ok('a site that has nothing more stops the top-up', async () => {
    const a = site('a', { sizes: [[1600, 1200]] });
    const quiet = a.descriptor.search;
    a.descriptor.search = async (params) => {
      const res = await quiet(params);
      return params.page > 1 ? { items: [], meta: {} } : res;
    };
    const { search } = setup({
      sites: [a],
      config: { onlineSources: { internet: true }, onlineSizeFilter: { enabled: true, mode: 'manual', targets: [WIDE] } },
    });
    await search.search({ q: 'sky' });
    assert.strictEqual(a.calls.length, 2, 'an empty answer is the end; asking again is the request storm BUG-020 limited');
  });

  await ok('the filter applies to a search as well as to the front page', async () => {
    const a = site('a', { sizes: [[1920, 1080], [1600, 1200]], perPage: 20 });
    const { search } = setup({
      sites: [a],
      config: { onlineSources: { internet: true }, onlineSizeFilter: { enabled: true, mode: 'manual', targets: [WIDE] } },
    });
    const browse = await search.search({ browse: true, q: '' });
    assert.strictEqual(browse.browsing, true);
    assert.ok(browse.items.length > 0 && browse.items.every((item) => sizeFilter.matches(item, [WIDE])));
    assert.ok(a.calls.every((c) => c.sizeHints), 'the front page was asked without the hint');
  });

  await ok('automatic mode reads the monitors at the moment of the request', async () => {
    const a = site('a', { sizes: [[2560, 1080], [1920, 1080]], perPage: 20 });
    const monitors = [{ w: 1920, h: 1080 }];
    const { search } = setup({
      sites: [a],
      monitors,
      config: { onlineSources: { internet: true }, onlineSizeFilter: { enabled: true, mode: 'auto' } },
    });
    let res = await search.search({ q: 'sky' });
    assert.ok(res.items.every((item) => item.width / item.height < 2), 'an ultrawide card passed a 16:9 monitor');
    monitors.splice(0, 1, { w: 2560, h: 1080 });
    res = await search.search({ q: 'sky' });
    assert.ok(res.items.every((item) => item.width === 2560), 'the new monitor was not used');
  });

  await ok('the window\'s flag alone never curates a typed search (BUG-020)', async () => {
    const a = site('a');
    const { search } = setup({ sites: [a] });
    const typed = await search.search({ browse: true, q: 'sky' });
    assert.strictEqual(typed.browsing, false);
    assert.strictEqual(a.calls[0].categories, '111', 'a typed search was narrowed like the front page');
    const front = await search.search({ browse: true, q: '  ' });
    assert.strictEqual(front.browsing, true);
    assert.ok(a.calls.slice(1).every((c) => c.categories === '110' && c.q === ''));
  });

  // --- what used to be a text pin in test/card-details.test.js ------------------------

  await ok('the window is told every site and what it is called, retired ones included', async () => {
    const a = site('a');
    const old = site('old');
    old.descriptor.status = 'retired';
    const { search } = setup({ sites: [a, old] });
    const { providers } = search.status();
    assert.deepStrictEqual(providers.map((p) => [p.id, p.name, p.status]), [
      ['a', 'Site a', 'active'],
      ['old', 'Site old', 'retired'],
    ]);
    // And the real registry is what the app sends, every site of it.
    const real = onlineSearchMod.create({
      online,
      getConfig: () => ({ onlineSources: { internet: true } }),
      providers: providerAccessMod.create({ userAgent: 'test', registry: providerRegistry }),
      registry: providerRegistry,
    }).status().providers;
    assert.deepStrictEqual(real.map((p) => p.id), providerRegistry.PROVIDERS.map((p) => p.id));
  });

  // --- the rules of a module that used to live in main.js -----------------------------

  await ok('settings are read at the moment of each request, not when the module was made', async () => {
    // set-config replaces the whole config object; a module holding the old one would keep
    // asking the sites the user has just switched off.
    const a = site('a');
    const b = site('b');
    const { search, state } = setup({
      sites: [a, b],
      config: { onlineSources: { internet: true, providers: { a: true, b: false } } },
    });
    await search.search({ q: 'sky' });
    assert.deepStrictEqual([a.calls.length, b.calls.length], [1, 0]);
    state.config = { onlineSources: { internet: true, providers: { a: false, b: true } } };
    await search.search({ q: 'sky' });
    assert.deepStrictEqual([a.calls.length, b.calls.length], [1, 1]);
  });

  await ok('two instances share nothing', async () => {
    // The harness drops only main.js between tests, so anything kept at module level
    // would leak from one test into the next.
    const one = setup({ sites: [site('a')] }).providers;
    const two = setup({ sites: [site('a')] }).providers;
    one.setCredentials('x', { key: 'one' });
    assert.deepStrictEqual(one.credentials({ id: 'x' }), { key: 'one' });
    assert.strictEqual(two.credentials({ id: 'x', loadCredentials: () => null }), null);
  });

  await ok('a site that fails is named, and the others still answer', async () => {
    const a = site('a');
    const down = site('down', { failWith: 'timeout' });
    const { search } = setup({ sites: [a, down] });
    const res = await search.search({ q: 'sky' });
    assert.ok(res.items.length > 0);
    assert.strictEqual(res.providerErrors.down, 'timeout');
  });

  // --- provider access ----------------------------------------------------------------

  await ok('a session is asked for every time; a key in a file once', async () => {
    let sessions = 0;
    let loads = 0;
    const providers = providerAccessMod.create({ appSession: () => { sessions += 1; return { token: 't' }; } });
    const cloud = { id: 'cloud', credentials: { kind: 'session' } };
    const keyed = { id: 'keyed', loadCredentials: () => { loads += 1; return { key: 'k' }; } };
    providers.credentials(cloud); providers.credentials(cloud);
    providers.credentials(keyed); providers.credentials(keyed);
    assert.deepStrictEqual([sessions, loads], [2, 1]);
  });

  await ok('the one network door never throws and names the failure', async () => {
    const answers = [
      () => ({ ok: false, status: 503 }),
      () => { const e = new Error('slow'); e.name = 'TimeoutError'; throw e; },
      () => { throw new Error('offline'); },
      () => ({ ok: true, json: async () => ({ fine: true }) }),
    ];
    const seen = [];
    const providers = providerAccessMod.create({
      userAgent: 'Znada/test',
      fetchImpl: async (url, init) => { seen.push(init.headers); return answers.shift()(); },
    });
    const fetchJson = providers.context({ id: 's', requestHeaders: { Referer: 'https://s.example/' } }).fetchJson;
    assert.deepStrictEqual(await fetchJson('https://s.example/1'), { error: '503' });
    assert.deepStrictEqual(await fetchJson('https://s.example/2'), { error: 'timeout' });
    assert.deepStrictEqual(await fetchJson('https://s.example/3'), { error: 'network' });
    assert.deepStrictEqual(await fetchJson('https://s.example/4'), { json: { fine: true } });
    assert.deepStrictEqual(seen[0], { 'User-Agent': 'Znada/test', Referer: 'https://s.example/' });
  });

  await ok('adult content is reachable only through a site that may serve it in this build', async () => {
    const providers = providerAccessMod.create({});
    providers.setCredentials('needsKey', null);
    assert.strictEqual(providers.explicitContentReachableIn([
      { id: 'never', capabilities: { explicit: 'never' } },
      { id: 'needsKey', capabilities: { explicit: 'withCredentials' } },
    ]), false);
    assert.strictEqual(providers.explicitContentReachableIn([
      { id: 'open', capabilities: { explicit: 'always' } },
    ]), true);
  });

  await ok('tag suggestion caches belong to each search instance', async () => {
    let calls = 0;
    const a = site('a');
    a.descriptor.capabilities.tagSuggest = true;
    a.descriptor.suggestTags = async () => {
      calls += 1;
      return { items: [{ name: 'sky', count: calls }] };
    };
    const one = setup({ sites: [a] }).search;
    const two = setup({ sites: [a] }).search;
    const first = await one.suggestTags({ q: 'sky' });
    assert.deepStrictEqual(await one.suggestTags({ q: 'sky' }), first);
    const second = await two.suggestTags({ q: 'sky' });
    assert.strictEqual(calls, 2);
    assert.notDeepStrictEqual(first, second);
  });

  await ok('an in-flight answer is discarded when settings are replaced', async () => {
    const a = site('a');
    let finish;
    a.descriptor.search = () => new Promise(resolve => { finish = resolve; });
    const { search, state } = setup({ sites: [a] });
    const pending = search.search({ q: 'sky' });
    assert.strictEqual(typeof finish, 'function');
    state.config = { onlineSources: { internet: false } };
    finish({ items: [{ provider: 'a', id: 'late', format: 'jpg' }], meta: {} });
    const reply = await pending;
    assert.deepStrictEqual(reply.items, []);
    assert.strictEqual(reply.resume, null);
  });

  await ok('default network dependency follows fetch replacements after creation', async () => {
    const original = globalThis.fetch;
    try {
      const providers = providerAccessMod.create({ userAgent: 'test' });
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ source: 'first' }) });
      const fetchJson = providers.context({ id: 'a' }).fetchJson;
      assert.deepStrictEqual(await fetchJson('https://a.example/'), { json: { source: 'first' } });
      globalThis.fetch = async () => ({ ok: false, status: 429 });
      assert.deepStrictEqual(await fetchJson('https://a.example/'), { error: '429' });
    } finally { globalThis.fetch = original; }
  });

  console.log(`\nPASS online-search: ${passed} checks`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
