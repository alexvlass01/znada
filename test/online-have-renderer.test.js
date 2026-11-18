'use strict';

// LIB-031. The REAL renderer functions behind an Online card's "+"/"✓" and the viewer
// payload, run against the real OnlineAdd and OnlineHave with a stand-in for main and a
// minimal DOM. What the module suites cannot see: that a drawn card is actually asked
// about, that main's "yes" turns the very button on screen into ✓, and that taking it
// back out removes the user's file by its path through the ordinary removal line.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const OnlineAdd = require('../src/online-add');
const OnlineHave = require('../renderer/online-have');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8')
  .split('\r\n').join('\n');

function functionSource(name) {
  const match = renderer.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `${name} must remain in renderer.js`);
  return match[0];
}

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

function element(tag) {
  const classes = new Set();
  const listeners = {};
  return {
    tag, textContent: '', title: '', disabled: false, children: [], attrs: {}, style: {}, offsetWidth: 0, offsetHeight: 0,
    className: '',
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
    addEventListener(type, fn) { listeners[type] = fn; },
    fire(type) { return listeners[type]({ stopPropagation() {} }); },
  };
}

(async () => {
  const MD5 = '0123456789abcdef0123456789abcdef';
  const item = { page: 'https://gelbooru.example/post/7', full: 'https://img.example/7.jpg', md5: MD5 };
  const asked = [];
  const removed = [];
  let answer = { path: 'C:\\Pictures\\saved.jpg', id: '' };
  const timers = new Map();
  let next = 1;
  const card = element('div');
  card.className = 'lib-card';
  const grid = { querySelectorAll: () => [card] };

  const context = {
    OnlineAdd,
    ONLINE_ADDING: new Map(),
    config: { library: {} },
    t: (key) => key,
    document: { createElement: element },
    $: (sel) => (sel === '#whGrid' ? grid : null),
    toast: () => {},
    toastRemoved: () => {},
    refreshPoolDependentChrome: () => {},
    addOnlineItem: async () => { throw new Error('a found photo must not be downloaded'); },
    window: {
      MediaKind: require('../renderer/media-kind'),
      api: {
        onlineHaveMany: async (cards) => { asked.push(cards); return Object.fromEntries(cards.map((c) => [c.key, answer])); },
        libraryRemoveMany: async (payload) => { removed.push(payload); return { affected: 1, config: { library: {} } }; },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('refreshOnlineAddedState'),
    functionSource('removeOnlineFromLibrary'),
    functionSource('attachOnlineAddButton'),
    functionSource('galleryPoolRecord'),
  ].join('\n'), context);
  context.ONLINE_HAVE = OnlineHave.create({
    ask: (cards) => context.window.api.onlineHaveMany(cards),
    onChange: () => context.refreshOnlineAddedState(),
    timers: { setTimeout: (fn) => { const id = next++; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id) },
  });
  async function fire() {
    const fns = Array.from(timers.values());
    timers.clear();
    for (const fn of fns) fn();
    for (let i = 0; i < 4; i++) await new Promise((r) => { setImmediate(r); });
  }

  const btn = context.attachOnlineAddButton(card, 'internet', item, async () => ({}));
  const glyph = btn.children[0];
  ok('a freshly drawn card shows "+" until main answers', glyph.textContent === '+' && !btn.classList.contains('added'));
  await fire();
  ok('the drawn card was asked about, with the fingerprint the site sent',
    asked.length === 1 && asked[0][0].md5 === MD5 && asked[0][0].key === item.page);
  ok('main\'s "yes" turns the button on screen into ✓, exactly like a downloaded photo',
    glyph.textContent === '✓' && btn.classList.contains('added') && btn.title === 'online.remove');

  const payload = context.galleryPoolRecord({ kind: 'internet', raw: item });
  ok('the full-screen viewer is handed the user\'s file as this card\'s photo',
    payload && payload.path === answer.path);

  answer = null;
  await btn.fire('click');
  ok('taking it back out removes the user\'s file by its path, through the ordinary removal',
    removed.length === 1 && removed[0][0].path === 'C:\\Pictures\\saved.jpg' && removed[0][0].id === '');
  await fire();
  ok('and main is asked again at once, so the card turns back into "+"',
    asked.length === 2 && glyph.textContent === '+' && !btn.classList.contains('added'));

  // --- the card's menu in the main window: assign and remove act on the user's file --------
  {
    const CardActions = require('../renderer/card-actions');
    const calls = { assignMenu: [], ensured: [], removed: [], downloaded: 0 };
    let picked = null;
    const mctx = {
      CardActions,
      FEATURES: { physicalDelete: false },
      config: { library: {} },
      t: (key) => key,
      closeLibPopup: () => {},
      localSelectionRecord: (p, type, id) => ({ path: p, type, id: id || '' }),
      poolItemForRecord: () => null,
      ensurePoolItemForRecord: async (record) => { calls.ensured.push(record); return { id: 'rec', path: record.path }; },
      openAssignMenu: (current, _card, make, opts) => { calls.assignMenu.push({ current, make, opts }); },
      addCardToLibrary: async () => { calls.downloaded += 1; return null; },
      removeOnlineFromLibrary: async (pooled) => { calls.removed.push(pooled); return true; },
      CardMenu: { openMenu: (opts) => { picked = opts.onPick; } },
    };
    vm.createContext(mctx);
    vm.runInContext(functionSource('openCardMenu'), mctx);
    const pooled = OnlineAdd.pooledItem({}, 'internet', item, { lookup: () => ({ path: 'C:\\Pictures\\saved.jpg', id: '' }) });
    const subject = CardActions.internetSubject(item, pooled);
    mctx.openCardMenu(subject, element('div'));
    picked({ id: 'assign' });
    const menu = calls.assignMenu[0];
    await menu.make();
    ok('assigning a found photo from the card menu makes its record from the user\'s file and downloads nothing',
      calls.downloaded === 0 && calls.ensured.length === 1 && calls.ensured[0].path === 'C:\\Pictures\\saved.jpg'
      && menu.opts.assignmentRecord.path === 'C:\\Pictures\\saved.jpg');
    picked({ id: 'remove' });
    ok('removing it from the card menu goes by its path',
      calls.removed.length === 1 && calls.removed[0].path === 'C:\\Pictures\\saved.jpg' && calls.removed[0].id === '');
  }

  // --- the card's right-click menu asks about the found file too ---------------------------
  {
    const CardActions = require('../renderer/card-actions');
    let bound = null;
    const opened = [];
    const mctx = {
      OnlineAdd,
      CardActions,
      ONLINE_HAVE: { lookup: () => ({ path: 'C:\\Pictures\\saved.jpg', id: '' }) },
      config: { library: {} },
      CardMenu: { bind: (_card, fn) => { bound = fn; } },
      window: { api: { favoriteState: async () => ({ on: false }) } },
      openCardMenu: (subject) => { opened.push(subject); },
    };
    vm.createContext(mctx);
    vm.runInContext(functionSource('bindOnlineCardContextMenu'), mctx);
    mctx.bindOnlineCardContextMenu({ isConnected: true }, 'internet', item);
    await bound({ x: 1, y: 1 });
    ok('the right-click menu of a found card treats it as the user\'s photo',
      opened.length === 1 && opened[0].inLibrary === true && opened[0].path === 'C:\\Pictures\\saved.jpg');
  }

  // --- the full-screen viewer: assigning a found photo uses the user's file ----------------
  {
    const viewer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'viewer.js'), 'utf8')
      .split('\r\n').join('\n');
    const source = (name) => {
      const match = viewer.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
      assert.ok(match, `${name} must remain in viewer.js`);
      return match[0];
    };
    const calls = { ensured: [], assigned: [], downloaded: 0 };
    let pick = null;
    const vctx = {
      VIEWER: { token: 1 },
      currentEntry: () => entry,
      window: {
        viewerApi: {
          cardAssignTargets: async () => ({ monitors: [{ id: 'm1' }], separateThemes: false, slots: {} }),
          cardEnsureRecord: async (p) => { calls.ensured.push(p); return { id: 'rec-found' }; },
          libraryAssign: async (id, monitorId, theme) => { calls.assigned.push([id, monitorId, theme]); return { ok: true }; },
        },
      },
      document: { createElement: element, documentElement: { clientWidth: 800, clientHeight: 600 }, addEventListener() {} },
      $: () => ({ appendChild() {} }),
      t: (key) => key,
      closeViewerPopup: () => {},
      viewerEntryMoves: async () => false,
      AssignRows: { build: (_pop, _monitors, _separate, opts) => { pick = opts.onPick; } },
      CardMenu: { placeAt: () => ({ left: 0, top: 0 }) },
      VIEWER_POPUP: { element: null, dismiss: null },
      showViewerMessage: () => {},
      viewerFailureText: (_e, key) => key,
      addViewerCardToLibrary: async () => { calls.downloaded += 1; return 'downloaded'; },
      setTimeout: () => 0,
    };
    vm.createContext(vctx);
    vm.runInContext(`${source('ensureViewerRecord')}\n${source('openViewerAssign')}`, vctx);
    const entry = {
      kind: 'internet', raw: item, added: true,
      pooled: { id: '', path: 'C:\\Pictures\\saved.jpg', type: 'image' },
    };
    await vctx.openViewerAssign(entry, { kind: 'internet' }, { x: 1, y: 1 });
    await pick('m1', 'light');
    ok('assigning a found photo from the viewer gives the user\'s file its record and downloads nothing',
      calls.ensured.length === 1 && calls.ensured[0] === 'C:\\Pictures\\saved.jpg' && calls.downloaded === 0
      && calls.assigned.length === 1 && calls.assigned[0][0] === 'rec-found'
      && entry.pooled.id === 'rec-found' && entry.pooled.path === 'C:\\Pictures\\saved.jpg');
  }

  console.log(`\nAll ${passed} online-have renderer tests passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
