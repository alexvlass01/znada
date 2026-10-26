'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const Store = require('../src/bookmark-store');
const Service = require('../src/bookmark-service');
const Sync = require('../src/bookmark-sync');
const SyncState = require('../src/bookmark-sync-state');
const { makeTempDir } = require('./helpers/temp-dir');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const ui = source.slice(source.indexOf('const FAVORITES ='), source.indexOf('// End ONL-002 favorites UI.'));
assert.ok(ui.includes('function renderUnifiedFavorites('), 'exercise the real renderer orchestration');
function code(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, name); return match[0];
}

(async () => {
  const local = { id: 'local', path: 'C:/forest.png', type: 'image', tags: ['sky'], favorite: true };
  const entries = [
    { kind: 'local', key: 'local:local', item: local, favoritedAt: 100 },
    { kind: 'bookmark', key: 'wallhaven:abc123', favoritedAt: 200,
      record: { source: 'wallhaven', post_id: 'abc123', favorited_at: 200, state: 'active',
        metadata: { title: 'Mountains', source_tags: ['sky'], user_tags: ['mine'], width: 1920, height: 1080 } } },
  ];
  let mounted = [], stateCalls = 0, downloads = 0, on = false;
  const empty = {};
  const context = { window: { api: {
    favoritesList: async () => ({ owner: 'anonymous', entries }),
    favoriteState: async () => { stateCalls++; return { on, owner: 'anonymous' }; },
    favoriteSet: async (card, value) => { assert.equal(card.owner, 'anonymous'); on = value; return { on, error: null }; },
    getConfig: async () => ({ library: { local } }), internetAdd: () => { downloads++; },
  } },
  LIB: { filter: 'favorite', tags: [], q: '', sort: 'added', shuffleRank: {} },
  allViewToken: 1, config: { library: { local } }, CLOUDAUTH: { state: {} },
  $: () => empty, baseName: (value) => value.split(/[\\/]/).pop(),
  LibrarySearch: require('../src/library-search'),
  localGridDescriptor: (item) => ({ kind: 'pool-image', key: item.id, item }),
  setLibEmptyText() {}, libEmptyKey: (key) => key, setLibViewHeader() {},
  renderLibRailTags() {},
  reconcileSelectionRecords() {}, selectionRecordFromEntry: () => null,
  mountUnifiedGrid: (_grid, descriptors) => { mounted = descriptors; }, assignedIds: () => new Set(),
  localGridVersion() {}, buildLocalGridCard() {}, bindLocalGridCard() {},
  setCardFavorite() {}, renderLibrary() {}, toast: (message) => assert.fail(message),
  CardTransfer: { errorMessage: (_t, error) => error }, t: (key) => key,
  };
  vm.createContext(context);
  for (const name of ['sortItems', 'libMatchesTag', 'libNarrow']) vm.runInContext(code(name), context);
  vm.runInContext(ui, context);
  await context.renderUnifiedFavorites(1);
  assert.equal(mounted.length, 2);
  assert.equal(mounted[0].kind, 'bookmark', 'both collections share the date-of-star ordering');
  assert.equal(mounted[0].aspect, 1920 / 1080, 'the real aspect goes into the existing grid');
  context.LIB.q = 'sky'; await context.renderUnifiedFavorites(1);
  assert.equal(mounted.length, 2, 'the same search finds tags on local photos and links');
  context.LIB.tags = ['mine']; await context.renderUnifiedFavorites(1);
  assert.equal(mounted.length, 1); assert.equal(mounted[0].key, 'wallhaven:abc123');
  context.LIB.filter = 'online';
  await context.toggleOnlineFavorite('internet', { provider: 'wallhaven', id: 'abc123' });
  assert.equal(stateCalls, 1); assert.equal(on, true); assert.equal(downloads, 0, 'a star never downloads the original');
  let opened = null;
  context.window.api.bookmarkResolve = async () => ({ item: { provider: 'wallhaven', id: 'abc123' } });
  context.window.api.internetAdd = async (item) => {
    downloads++;
    assert.equal(item.bookmarkKey, 'wallhaven:abc123', 'opening keeps the key for the main-process recheck');
    return { id: 'downloaded', config: { library: { downloaded: { id: 'downloaded' } } } };
  };
  context.openGalleryFromCard = (_card, item) => { opened = item; };
  context.galleryItemFromLibrary = (item) => item;
  await context.openBookmark({ bookmarkKey: 'wallhaven:abc123' }, {});
  assert.equal(downloads, 1); assert.equal(opened.id, 'downloaded');

  // A refused bookmark-tag edit must explain a running media move, keep the tags
  // unchanged and let the editor stay open for retry.
  let tagPort, notice;
  context.openAssignMenu = (_item, _anchor, _ensure, options) => { tagPort = options.tagPort; };
  context.window.api.bookmarkTags = async () => ({ error: 'media_move_running' });
  context.CardTransfer = require('../renderer/card-transfer');
  context.toast = (message) => { notice = message; };
  context.openBookmarkTags({ bookmarkKey: 'wallhaven:abc123' }, {});
  assert.equal(await tagPort.set(['changed']), false);
  assert.equal(notice, 'mediaFolder.frozen');
  assert.deepEqual(Array.from(tagPort.get()), ['mine']);

  // BUG-059: a downloaded favorite uses the bookmark editor from every local
  // card menu, showing only personal tags and carrying the captured owner.
  vm.runInContext(code('openCardTags'), context);
  const downloaded = { ...local, source: 'https://wallhaven.cc/w/abc123', tags: ['sky', 'legacy'] };
  const linked = { kind: 'local', key: 'wallhaven:abc123', item: downloaded, record: entries[1].record };
  const previousFavoriteState = context.window.api.favoriteState;
  context.window.api.favoriteState = async () => ({ owner: 'account:A', ref: { source: 'wallhaven', post_id: 'abc123' } });
  context.window.api.favoritesList = async () => ({ owner: 'account:A', entries: [linked], records: { [linked.key]: linked.record } });
  let sent;
  context.window.api.bookmarkTags = async (input, next) => { sent = { input, next }; return { error: null }; };
  await context.openCardTags({ kind: 'local', raw: downloaded }, downloaded, {}, {});
  assert.deepEqual(Array.from(tagPort.get()), ['mine'], 'source and legacy tags are not promoted to user_tags');
  assert.equal(await tagPort.set(['sunset']), true);
  assert.equal(sent.input.owner, 'account:A');
  assert.equal(sent.input.item.id, 'local');
  assert.deepEqual(Array.from(sent.next), ['sunset']);
  assert.ok(code('openCardMenu').includes('tags: () => openCardTags('), 'the actual menu must route through the tested handler');
  let localEditor = false;
  context.openAssignMenu = (_item, _anchor, _ensure, options) => { localEditor = !options.tagPort; };
  context.window.api.favoriteState = async () => ({ owner: 'account:B', ref: null });
  context.window.api.favoritesList = async () => ({ owner: 'account:B', entries: [] });
  await context.openCardTags({ kind: 'local', raw: local }, local, {}, {});
  assert.equal(localEditor, true, 'personal photos retain the local tag editor');
  localEditor = false;
  context.window.api.favoriteState = async () => ({ owner: 'account:A', ref: { source: 'wallhaven', post_id: 'abc123' } });
  context.window.api.favoritesList = async () => { throw Error('IPC unavailable'); };
  await context.openCardTags({ kind: 'local', raw: downloaded }, downloaded, {}, {});
  assert.equal(localEditor, false, 'an IPC failure must not silently bypass synchronization');
  assert.equal(notice, 'bookmarks.retry');

  // PR #239 F1: list() deliberately chooses one file per bookmark. The menu of
  // another copy must still edit the same durable user_tags and sync queue.
  {
    const configPath = path.join(makeTempDir('bookmark-ui-copies-'), 'config.json');
    const copies = Object.fromEntries(['first', 'second'].map(id => [id, {
      id, type: 'image', path: 'C:/' + id + '.png', source: 'https://wallhaven.cc/w/abc123',
      tags: ['source-sky', 'legacy-local'],
    }]));
    const store = Store.create({ configPath }), state = SyncState.create({ configPath });
    let account = 'A';
    const service = Service.create({ store, getConfig: () => ({ library: copies }), getAccount: () => account,
      updateItem: (id, patch) => Object.assign(copies[id], patch), savePool() {},
      onChange: (owner, key) => engine.touch(owner, key) });
    const engine = Sync.create({ store, state, getAccount: () => account, connect: () => null,
      applyRemote: (owner, rows) => service.applyRemote(owner, rows), setTimer: () => null, clearTimer() {} });
    service.set({ kind: 'local', id: 'first' }, true);
    service.tags({ kind: 'local', id: 'first' }, ['personal-before']);
    assert.equal(service.list().entries.length, 1, 'one representative remains in Favorites');
    assert.equal(service.list().entries[0].item.id, 'first');
    context.window.api.favoriteState = async input => service.state(input);
    context.window.api.favoritesList = async () => service.list();
    context.window.api.bookmarkTags = async (input, tags) => service.tags(input, tags);
    context.openAssignMenu = (_item, _anchor, _ensure, options) => { tagPort = options.tagPort; };
    for (const id of ['first', 'second']) {
      tagPort = null;
      await context.openCardTags({ kind: 'local', raw: copies[id] }, copies[id], {}, {});
      assert.ok(tagPort, id + ' copy must use bookmark editor');
      assert.deepEqual(Array.from(tagPort.get()), ['personal-before']);
    }
    const before = state.seq();
    assert.equal(await tagPort.set(['personal-before', 'second-copy']), true);
    assert.deepEqual(Store.create({ configPath }).get('A', 'wallhaven:abc123').metadata.user_tags,
      ['personal-before', 'second-copy'], 'the second copy edits the durable bookmark');
    assert.ok(SyncState.create({ configPath }).account('A').dirty['wallhaven:abc123'].seq > before,
      'the second copy enqueues a new durable sync edit');
    for (const item of Object.values(copies)) assert.deepEqual(item.tags,
      ['source-sky', 'legacy-local', 'personal-before', 'second-copy']);
    // An account switch between reference and record lookup cannot open a local
    // editor or apply tags captured from the departed account.
    context.window.api.favoritesList = async () => { account = 'B'; return service.list(); };
    tagPort = null; notice = null;
    context.openAssignMenu = () => assert.fail('an account switch must not open either tag editor');
    await context.openCardTags({ kind: 'local', raw: copies.second }, copies.second, {}, {});
    assert.equal(tagPort, null);
    assert.equal(notice, 'bookmarks.retry');
  }
  context.window.api.favoriteState = previousFavoriteState;

  // Exercise the registered callback's real helpers: a viewer mutation must update
  // both mounted grids without a full Library rebuild or a stale config refresh.
  vm.runInContext(code('refreshFavoriteHighlights'), context);
  vm.runInContext(code('handleFavoritesChanged'), context);
  assert.ok(source.includes('onFavoritesChanged?.(handleFavoritesChanged)'), 'wire the tested callback');
  context.config = { library: { local } };
  const localCard = { dataset: { id: 'local' }, isConnected: true };
  const onlineCard = { __galleryItem: { kind: 'internet', raw: { provider: 'wallhaven', id: 'abc123' } }, isConnected: true };
  const painted = new Map();
  context.document = { querySelectorAll: (selector) => selector.startsWith('#libGrid') ? [localCard] : [onlineCard] };
  context.setCardFavorite = (card, value) => painted.set(card, value);
  context.libRenderKey = () => 'unchanged-grid';
  context.renderLibrary = () => assert.fail('star synchronization must not rebuild the All grid');
  context.LIB.filter = 'all'; on = false;
  context.handleFavoritesChanged();
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(painted.get(localCard), false, 'viewer unstar updates the mounted local card');
  assert.equal(painted.get(onlineCard), false);
  on = true; context.handleFavoritesChanged();
  await new Promise(resolve => { setImmediate(resolve); });
  assert.equal(painted.get(localCard), true); assert.equal(painted.get(onlineCard), true);
  console.log('bookmark-ui: actual mixed collection, existing query rules, aspect/order and no-download star PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
