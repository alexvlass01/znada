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
  const context = { window: { MediaKind: require('../renderer/media-kind'), api: {
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
  // MEDIA-004: the kind of file is tested in library-search.test.js; nothing is narrowed here.
  kindFilterActive: () => false, renderLibFilterButton() {},
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
  const remoteVideo = { provider: 'danbooru', id: '3', format: 'mp4' };
  context.window.api.bookmarkResolve = async () => ({ item: remoteVideo });
  context.openGalleryViewer = (items) => { opened = items[0]; };
  context.galleryItemFromInternet = (item) => ({ kind: 'internet', raw: item });
  await context.openBookmark({ bookmarkKey: 'danbooru:3' }, {});
  assert.equal(opened.kind, 'internet');
  assert.equal(opened.raw.bookmarkKey, 'danbooru:3');
  assert.equal(downloads, 1, 'opening a video bookmark starts the viewer without adding it');

  {
    const remote = { kind: 'bookmark', key: 'danbooru:3', favoritedAt: 300,
      record: { source: 'danbooru', post_id: '3', state: 'active', metadata: { title: 'A clip' } } };
    const still = { ...remote, key: 'danbooru:4',
      record: { ...remote.record, post_id: '4', metadata: { title: 'A still image' } } };
    const animation = { ...remote, key: 'danbooru:5',
      record: { ...remote.record, post_id: '5', metadata: { title: 'An animation' } } };
    const priorList = context.window.api.favoritesList;
    context.window.LibraryKind = require('../renderer/library-kind');
    context.KIND = { on: ['video'], moving: new Map() };
    context.LIB.filter = 'favorite';
    context.LIB.q = '';
    context.LIB.tags = [];
    context.kindFilterActive = () => context.KIND.on.length !== 3;
    context.scheduleKindCheck = () => {};
    context.requestAnimationFrame = () => 1;
    vm.runInContext(code('entryKind'), context);
    context.window.api.favoritesList = async () => ({ owner: 'anonymous', entries: [remote, still, animation] });
    await context.renderUnifiedFavorites(1);
    assert.deepEqual(Array.from(mounted, (row) => row.key), [remote.key, still.key, animation.key],
      'video-only Favorites lets unresolved cards reach the resolver');
    context.rememberFavoriteMediaKind(mounted[0], remoteVideo, 'anonymous');
    context.rememberFavoriteMediaKind(mounted[1], { format: 'jpg' }, 'anonymous');
    context.rememberFavoriteMediaKind(mounted[2], { format: 'gif', animated: true }, 'anonymous');
    await context.renderUnifiedFavorites(1);
    assert.deepEqual(Array.from(mounted, (row) => row.key), [remote.key]);
    context.KIND.on = ['photo'];
    await context.renderUnifiedFavorites(1);
    assert.deepEqual(Array.from(mounted, (row) => row.key), [still.key]);
    context.KIND.on = ['gif'];
    await context.renderUnifiedFavorites(1);
    assert.deepEqual(Array.from(mounted, (row) => row.key), [animation.key],
      'resolved animated bookmarks keep their media kind when the grid is rebuilt');
    context.KIND.on = ['video'];
    await context.renderUnifiedFavorites(1);
    assert.deepEqual(Array.from(mounted, (row) => row.key), [remote.key]);
    context.window.api.favoritesList = async () => ({ owner: 'account:B', entries: [still] });
    await context.renderUnifiedFavorites(1);
    assert.equal(mounted[0].item.format, undefined, 'format hints do not cross accounts');

    // BUG-086: a fresh account with only GIF selected. Unresolved booru bookmarks
    // must reach the resolver first, otherwise an animated one never appears.
    const gifRemote = { ...remote, key: 'gelbooru:6',
      record: { ...remote.record, source: 'gelbooru', post_id: '6', metadata: { title: 'A gif' } } };
    const gifStill = { ...remote, key: 'gelbooru:7',
      record: { ...remote.record, source: 'gelbooru', post_id: '7', metadata: { title: 'A still' } } };
    const gifClip = { ...remote, key: 'gelbooru:8',
      record: { ...remote.record, source: 'gelbooru', post_id: '8', metadata: { title: 'A video' } } };
    context.KIND.on = ['gif'];
    context.window.api.favoritesList = async () => ({ owner: 'account:C', entries: [gifRemote, gifStill, gifClip] });
    await context.renderUnifiedFavorites(1);
    assert.deepEqual(Array.from(mounted, (row) => row.key), [gifRemote.key, gifStill.key, gifClip.key],
      'GIF-only Favorites lets unresolved cards reach the resolver');
    // The resolver's answer must redraw the grid by itself, once per frame, and only
    // when the answer changes whether the card is shown.
    const frames = [];
    let redraws = 0;
    const priorRenderLibrary = context.renderLibrary;
    context.renderLibrary = () => { redraws++; };
    context.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
    vm.runInContext('FAVORITES.kindFrame = null', context);
    context.rememberFavoriteMediaKind(mounted[0], { format: 'gif', animated: true }, 'account:C');
    assert.equal(frames.length, 0, 'a GIF that stays in the GIF-only grid needs no redraw');
    context.rememberFavoriteMediaKind(mounted[1], { format: 'png' }, 'account:C');
    context.rememberFavoriteMediaKind(mounted[2], { provider: 'gelbooru', id: '8', format: 'mp4' }, 'account:C');
    assert.equal(frames.length, 1, 'a still and a video leaving the grid schedule one redraw');
    frames[0]();
    assert.equal(redraws, 1, 'the scheduled frame redraws the GIF-only grid');
    context.renderLibrary = priorRenderLibrary;
    context.requestAnimationFrame = () => 1;
    await context.renderUnifiedFavorites(1);
    assert.deepEqual(Array.from(mounted, (row) => row.key), [gifRemote.key],
      'resolved stills and videos leave the GIF-only grid');
    context.KIND.on = ['video'];
    await context.renderUnifiedFavorites(1);
    assert.deepEqual(Array.from(mounted, (row) => row.key), [gifClip.key]);
    context.KIND.on = ['photo'];
    await context.renderUnifiedFavorites(1);
    assert.deepEqual(Array.from(mounted, (row) => row.key), [gifStill.key]);
    // Photo-only must not open the gate: unresolved bookmarks already count as photos.
    context.window.api.favoritesList = async () => ({ owner: 'account:D', entries: [gifRemote] });
    await context.renderUnifiedFavorites(1);
    assert.deepEqual(Array.from(mounted, (row) => row.key), [gifRemote.key]);
    context.KIND.on = ['gif'];
    context.window.api.favoritesList = async () => ({ owner: 'account:E', entries: [gifRemote] });
    await context.renderUnifiedFavorites(1);
    assert.deepEqual(Array.from(mounted, (row) => row.key), [gifRemote.key],
      'a GIF resolved under another account is asked again, not taken from the old cache');
    context.kindFilterActive = () => false;
    context.window.api.favoritesList = priorList;
    await context.renderUnifiedFavorites(1);
  }

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
