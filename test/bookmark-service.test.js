'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Store = require('../src/bookmark-store');
const Service = require('../src/bookmark-service');
const Resolver = require('../src/bookmark-resolver');
const Preview = require('../src/bookmark-preview');
const Runtime = require('../src/bookmark-runtime');
const library = require('../src/library');
const { makeTempDir } = require('./helpers/temp-dir');

(async () => {
  const dir = makeTempDir('znada-bookmark-service-');
  const configPath = path.join(dir, 'config.json');
  const config = { library: {} };
  let account = null, generation = 1;
  const store = Store.create({ configPath });
  const service = Service.create({ store, getConfig: () => config, getAccount: () => account,
    updateItem: (id, patch) => library.updateItem(config.library, id, patch), savePool: () => {}, now: () => 500 });
  const remote = { provider: 'wallhaven', id: 'abc123', title: 'Mountains', tags: ['sky'], width: 1600, height: 900 };
  const card = { kind: 'internet', item: remote };
  assert.equal(service.set(card, true).error, null);
  assert.equal(Object.keys(config.library).length, 0, 'a star must not add a file record');
  assert.equal(service.list().entries[0].record.metadata.title, 'Mountains');
  assert.equal(Store.create({ configPath }).snapshot(null)['wallhaven:abc123'].state, 'active');
  const id = library.addPath(config.library, 'image', path.join(dir, 'original.jpg'), { source: 'https://wallhaven.cc/w/abc123' });
  library.updateItem(config.library, id, { source: 'https://wallhaven.cc/w/abc123' });
  service.adopt(id);
  assert.equal(config.library[id].favorite, true);
  assert.ok(config.library[id].tags.includes('sky'), 'adopting a saved link preserves searchable source tags');
  assert.equal(config.library[id].favoritedAt, 500);
  assert.equal(service.list().entries.length, 1, 'download and bookmark are one card');
  assert.equal(service.list().entries[0].kind, 'local');
  assert.equal(service.list().entries[0].record.source, 'wallhaven', 'a downloaded favorite keeps its bookmark for tag editing');
  library.updateItem(config.library, id, { tags: ['sky', 'local-only'] });
  assert.equal(service.tags({ kind: 'local', id }, ['mine']).error, null);
  const incoming = { ...store.get(null, 'wallhaven:abc123'), metadata: {
    source_tags: ['sky'], user_tags: ['other-device'],
  } };
  assert.equal(service.applyRemote(null, [incoming]), true);
  assert.deepEqual(config.library[id].tags, ['sky', 'local-only', 'other-device'],
    'incoming user tags replace previous user tags even when star/date did not change');
  assert.equal(service.applyRemote(null, [{ ...incoming, metadata: { source_tags: ['sky'] } }]), true);
  assert.deepEqual(config.library[id].tags, ['sky', 'local-only'], 'removing user tags remotely preserves unrelated local/source tags');
  assert.equal(service.applyRemote('other-account', [{ ...incoming, metadata: { user_tags: ['private'] } }]), true);
  assert.deepEqual(config.library[id].tags, ['sky', 'local-only'], 'an inactive account must not change local tags');
  account = 'B';
  assert.equal(service.state({ kind: 'local', id }).on, false, 'a downloaded A bookmark does not become a B bookmark');
  assert.equal(service.list().entries.length, 0);
  service.set({ kind: 'local', id }, true);
  service.set({ kind: 'local', id }, false);
  account = null;
  assert.equal(service.list().entries.length, 1, 'B removing its own star does not remove A favorite');
  service.adopt(id);
  service.set({ kind: 'local', id }, false);
  assert.equal(service.list().entries.length, 0);
  assert.equal(config.library[id].favorite, false);
  assert.equal(fs.existsSync(Store.storePathFor(configPath)), true);
  service.set(card, true);
  library.removeItem(config.library, id);
  assert.equal(service.list().entries[0].kind, 'bookmark', 'removing a file does not remove its link');
  assert.equal(service.tags(card, ['mine']).error, null);
  assert.equal(service.list().entries[0].record.metadata.user_tags[0], 'mine');
  assert.equal(service.tags(card, ['mine', 'mine']).error, 'badItem');
  account = 'B';
  assert.equal(service.list().entries.length, 0, 'account B must not see anonymous links');
  assert.equal(service.set({ ...card, owner: 'anonymous' }, false).error, 'session_changed');
  service.set(card, true);
  account = null;
  assert.equal(service.list().entries[0].record.metadata.user_tags[0], 'mine');
  const locked = Store.create({ configPath, io: { ...fs, renameSync() { throw Error('IO refused'); } } });
  const refused = Service.create({ store: locked, getConfig: () => config, updateItem: () => assert.fail('must not mutate pool'), savePool: () => {} });
  assert.equal(refused.set(card, false).error, 'bookmark_write_failed');
  assert.equal(locked.snapshot(null)['wallhaven:abc123'].state, 'active');
  assert.equal(Store.create({ configPath }).snapshot(null)['wallhaven:abc123'].state, 'active');
  assert.equal(Service.reference({ provider: '[', id: 'anything' }), null);
  assert.equal(Service.reference({ path: 'x', source: 'https://wallhaven.cc.evil.test/w/abc123' }), null);
  assert.equal(Service.reference({ path: 'x', source: 'https://user@wallhaven.cc/w/abc123' }), null);
  assert.equal(Service.reference({ path: 'x', source: 'https://wallhaven.cc:444/w/abc123' }), null,
    'a provider source URL with a custom port must not become a canonical bookmark');
  assert.equal(Service.reference({ provider: 'danbooru', id: 'danbooru:99999999999999999999' }).post_id, '99999999999999999999');
  for (const [purity, rating] of [['sfw', 'general'], ['sketchy', 'suggestive'], ['nsfw', 'explicit']]) {
    assert.equal(Service.metadata({ purity }).source_rating, rating, 'Wallhaven purity maps to bookmark rating');
  }
  const departed = Store.create({ configPath: path.join(makeTempDir('bookmark-departed-'), 'config.json') });
  departed.put('departed', { source: 'wallhaven', post_id: 'abc123', favorited_at: 100, metadata: {}, state: 'removed' });
  assert.equal(departed.hasElsewhere('new', 'wallhaven:abc123'), true, 'a tombstone still claims its account-owned key');
  const staleLocal = { id, type: 'image', path: path.join(dir, 'stale.jpg'), source: 'https://wallhaven.cc/w/abc123', favorite: true };
  const isolated = Service.create({ store: departed, getConfig: () => ({ library: { [id]: staleLocal } }),
    getAccount: () => 'new', updateItem() {}, savePool() {} });
  assert.equal(isolated.state({ kind: 'local', id }).on, false, 'stale flags cannot leak a removed link into another account');
  assert.equal(isolated.list().entries.length, 0);
  const personal = library.addPath(config.library, 'image', path.join(dir, 'personal.png'));
  assert.equal(service.set({ kind: 'local', id: personal }, true).error, null);
  assert.equal(service.list().entries.filter((entry) => entry.key.startsWith('local:')).length, 1);

  const record = store.snapshot(null)['wallhaven:abc123'];
  const thumb = 'data:image/png;base64,aGVsbG8=';
  const cacheDir = path.join(dir, 'previews');
  let calls = 0;
  const options = { directory: cacheDir, getOwner: () => String(account), getGeneration: () => generation,
    lookup: async () => { calls++; return { item: remote }; }, preview: async () => thumb };
  const resolver = Resolver.create(options);
  const [one, two] = await Promise.all([resolver.resolve(record), resolver.resolve(record)]);
  assert.equal(calls, 1, 'visible duplicate requests share one resolution');
  assert.equal(one.thumb, two.thumb);
  const offline = Resolver.create({ ...options, lookup: async () => ({ error: 'network' }) });
  const answer = await offline.resolve(record);
  assert.equal(answer.thumb, thumb, 'cached preview survives a new service instance and no network');
  assert.equal(answer.unavailable, false, 'a network failure does not mean a deleted post');
  const gone = await Resolver.create({ ...options, lookup: async () => ({ error: '404' }) }).resolve(record);
  assert.equal(gone.unavailable, true);
  let release;
  const stale = Resolver.create({ ...options, lookup: () => new Promise((resolve) => { release = resolve; }) });
  const waiting = stale.resolve(record);
  await new Promise((resolve) => { setImmediate(resolve); });
  generation++;
  release({ item: remote });
  assert.equal((await waiting).error, 'session_changed');
  account = 'other';
  assert.equal(offline.cached(String(account), 'wallhaven:abc123'), '', 'preview namespaces are account isolated');
  assert.equal(Preview.allowed({ provider: 'wallhaven', thumb: 'https://th.wallhaven.cc/small/a.jpg' }), true);
  for (const url of ['http://th.wallhaven.cc/a.jpg', 'https://user@th.wallhaven.cc/a.jpg',
    'https://user:password@th.wallhaven.cc/a.jpg', 'https://th.wallhaven.cc:444/a.jpg']) {
    assert.equal(Preview.allowed({ provider: 'wallhaven', thumb: url }), false, 'refuse insecure or credentialed preview URL: ' + url);
  }
  assert.equal(Preview.allowed({ provider: 'wallhaven', thumb: 'https://evil.test/a.jpg' }), false);
  assert.equal(Preview.allowed({ provider: 'znada', thumb: 'https://r2.cloudflarestorage.com.evil.test/a.jpg' }), false);
  let cancelled = false;
  const oversized = await Preview.fetchPreview({ provider: 'wallhaven', thumb: 'https://th.wallhaven.cc/a.jpg' }, {},
    async (_url, init) => {
      assert.equal(init.redirect, 'error');
      return { ok: true, headers: new Headers({ 'content-type': 'image/jpeg' }), body: new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(Preview.LIMIT + 1)); }, cancel() { cancelled = true; },
      }) };
    });
  assert.equal(oversized, ''); assert.equal(cancelled, true);
  const runtimeDir = makeTempDir('znada-bookmark-runtime-');
  let answerPost;
  const runtimeOptions = { configPath: path.join(runtimeDir, 'config.json'),
    getConfig: () => ({ library: {} }), updateItem() {}, savePool() {},
    authState: () => ({ signedIn: false }), sessionSnapshot: () => ({ revision: 1 }),
    sessionIsCurrent: () => true, client: () => null,
    providers: { context: () => ({}), requestHeaders: () => ({}) },
    registry: { byId: () => ({ lookup: async () => ({ error: '404' }) }) },
    publish() {}, ipcMain: { handle() {} },
  };
  let runtime = Runtime.create(runtimeOptions);
  runtime.set(card, true);
  assert.equal((await runtime.resolveForUse('wallhaven:abc123')).unavailable, true);
  assert.equal(runtime.list().entries[0].record.state, 'unavailable', 'confirmed unavailable state survives in the record');
  runtime = Runtime.create({ ...runtimeOptions, registry: { byId: () => ({ lookup: async () => ({ item: remote }) }) } });
  await runtime.resolveForUse('wallhaven:abc123');
  assert.equal(runtime.list().entries[0].record.state, 'active', 'a recovered post becomes usable again');
  runtime = Runtime.create({ ...runtimeOptions, registry: { byId: () => ({ lookup: () => new Promise((resolve) => { answerPost = resolve; }) }) } });
  const loading = runtime.resolveForUse('wallhaven:abc123');
  await new Promise((resolve) => { setImmediate(resolve); });
  runtime.set(card, false);
  answerPost({ item: remote });
  assert.equal((await loading).error, 'badItem', 'a late fetch cannot revive a removed bookmark');
  assert.equal(runtime.list().entries.length, 0);
  const cloudProvider = require('../src/cloud/provider');
  const catalogId = '01J00000000000000000000000';
  const previewUrl = 'https://media.r2.cloudflarestorage.com/preview.jpg';
  const catalog = await cloudProvider.lookup(catalogId, { credentials: {
    client: { getContent: async (id) => { assert.equal(id, catalogId); return { ok: true, data: {
      id, title: 'Catalog', preview_url: previewUrl, tags: ['sky'], width: 1600, height: 900,
      rating: 'general', format: 'jpg', published_at: 10,
    } }; } }, isCurrent: () => true,
  } });
  assert.equal(catalog.item.thumb, previewUrl, 'ContentCard preview_url is distinct from CatalogItem thumb_url');
  assert.equal(catalog.item.tags[0], 'sky');
  const foreignCatalog = await cloudProvider.lookup(catalogId, { credentials: {
    client: { getContent: async () => ({ ok: true, data: {
      id: '01J00000000000000000000001', title: 'Other', preview_url: previewUrl, tags: ['sky'],
      width: 1600, height: 900, rating: 'general', format: 'jpg', published_at: 10,
    } }) }, isCurrent: () => true,
  } });
  assert.equal(foreignCatalog.error, '404', 'catalog lookup must reject another valid post ID');
  assert.equal(foreignCatalog.item, undefined);
  const wallhaven = await require('../src/wallhaven').lookup('abc123', { fetchJson: async () => ({ json: { data: {
    id: 'wrong1', path: 'https://w.wallhaven.cc/full/a.jpg', thumbs: { original: 'https://th.wallhaven.cc/a.jpg' },
  } } }) });
  assert.equal(wallhaven.error, '404', 'a lookup may not attach another post to a saved key');
  for (const name of ['gelbooru', 'danbooru']) {
    const post = { id: 42, file_url: 'https://cdn.donmai.us/a.jpg', image_width: 1600, image_height: 900,
      width: 1600, height: 900, preview_file_url: 'https://cdn.donmai.us/preview.jpg' };
    const found = await require('../src/' + name).lookup('42', {
      credentials: { apiKey: 'fixture', userId: '1' }, fetchJson: async () => ({ json: name === 'gelbooru' ? { post: [post] } : [post] }),
    });
    assert.equal(found.item.id, name + ':42');
    const foreign = await require('../src/' + name).lookup('42', {
      credentials: { apiKey: 'fixture', userId: '1' }, fetchJson: async () => ({
        json: name === 'gelbooru' ? { post: [{ ...post, id: 99 }] } : [{ ...post, id: 99 }],
      }),
    });
    assert.equal(foreign.error, '404', name + ' lookup must reject another post ID');
    assert.equal(foreign.item, undefined);
  }
  console.log('bookmark-service: durable stars, dedup, download adoption, failures, partitions and preview recovery PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
