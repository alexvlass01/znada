'use strict';

// BUG-035, in the windows themselves. test/motion-badge.test.js proves what the chip says;
// this proves the places that should wear it actually do, by running the REAL functions
// out of renderer/renderer.js and renderer/viewer.js against a small fake DOM:
//
//   * a library card, a tile in "Appearance" and a card in Home's "recently added" get
//     the chip from the same answer as their thumbnail, and lose it when reused;
//   * the previews that stand for the desktop (Home's monitors, "Appearance") draw the
//     still frame, at the picture's own size, instead of the file that would play;
//   * the viewer's assign window says "first frame" for a moving picture, and only then.
//
// A helper that passes its own tests while nobody calls it would pass everything in the
// other file, which is why this one exists.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MotionBadge = require('../renderer/motion-badge.js');
const MotionHover = require('../renderer/motion-hover.js');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8').split('\r\n').join('\n');
const rendererSrc = read('renderer', 'renderer.js');
const viewerSrc = read('renderer', 'viewer.js');
const en = JSON.parse(read('locales', 'en.json'));

let checks = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    await fn();
    checks += 1;
    console.log(`  ok ${name}`);
  });
}

// A top-level declaration, from its first line to the first closing brace in column 0.
function extract(src, head, where) {
  const start = src.indexOf(head);
  assert.ok(start >= 0, `${where}: "${head}" must remain an explicit boundary`);
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, `${where}: "${head}" has no end`);
  return src.slice(start, end + 2);
}
function extractLine(src, head, where) {
  const start = src.indexOf(head);
  assert.ok(start >= 0, `${where}: "${head}" must remain`);
  return src.slice(start, src.indexOf('\n', start));
}

function t(key, params = {}) {
  const text = key.split('.').reduce((node, part) => (node == null ? node : node[part]), en);
  if (typeof text !== 'string') throw new Error(`missing string ${key}`);
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
// Objects made inside the vm context have that context's prototypes; compare their data.
const plain = (value) => JSON.parse(JSON.stringify(value));

// --- a DOM just big enough for these functions ------------------------------------------
const camel = (name) => name.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
class FakeClassList {
  constructor(el) { this.el = el; }
  get set() { return new Set(String(this.el.className || '').split(/\s+/).filter(Boolean)); }
  contains(name) { return this.set.has(name); }
  add(...names) { const s = this.set; names.forEach((n) => s.add(n)); this.el.className = [...s].join(' '); }
  remove(...names) { const s = this.set; names.forEach((n) => s.delete(n)); this.el.className = [...s].join(' '); }
}
class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.hidden = false;
    this.listeners = {};
    this.html = '';
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.classList = new FakeClassList(this);
    this.root = false;
  }
  get isConnected() {
    for (let node = this; node; node = node.parentElement) if (node.root) return true;
    return false;
  }
  get innerHTML() { return this.html; }
  set innerHTML(value) {
    this.html = String(value);
    for (const child of this.children) child.parentElement = null;
    this.children = [];
  }
  get offsetWidth() { return 240; }
  get offsetHeight() { return 120; }
  appendChild(child) {
    if (child.parentElement) child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name.startsWith('data-')) delete this.dataset[camel(name.slice(5))];
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((fn) => fn({ target: this, stopPropagation() {} })); }
  get childElementCount() { return this.children.length; }
  focus() {}
  matches(selector) {
    if (selector === '[data-motion]') return Object.prototype.hasOwnProperty.call(this.dataset, 'motion');
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (/^[a-z]+$/.test(selector)) return this.tagName === selector.toUpperCase();
    throw new Error(`selector not supported here: ${selector}`);
  }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => node.children.forEach((child) => {
      if (child.matches(selector)) found.push(child);
      walk(child);
    });
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function makeDocument() {
  const doc = {
    createElement: (tag) => new FakeElement(doc, tag),
    documentElement: { clientWidth: 1600, clientHeight: 900 },
    listeners: [],
    addEventListener: (...args) => doc.listeners.push(args),
  };
  return doc;
}
const chipOf = (host) => host.children.find((c) => c.classList.contains('lib-motion')) || null;
const noteOf = (pop) => pop.children.find((c) => c.classList.contains('lib-popup-note')) || null;

// --- the main window --------------------------------------------------------------------
// Everything the extracted functions reach for, faked. `answers` is what main would say
// about each file: whether it moves, and its size.
function mainWindow() {
  const doc = makeDocument();
  const answers = new Map();
  const asked = { thumbInfo: [], fileUrl: [], mediaMotion: [] };
  const elements = {};
  for (const id of ['#previewLight', '#previewDark', '#stripLight', '#stripDark',
    '#homeRecentGrid', '#homeRecentEmpty', '#homeRecentAll']) {
    elements[id] = doc.createElement('div');
    elements[id].root = true;
  }
  const api = {
    thumbInfo: async (p, w, h) => {
      asked.thumbInfo.push([p, w, h]);
      const answer = answers.get(p);
      return { url: `data:still/${w}/${p}`, width: w, height: h, ...(answer ? { motion: answer } : {}) };
    },
    thumb: async (p) => `data:plain/${p}`,
    mediaMotion: async (p) => {
      asked.mediaMotion.push(p);
      const answer = answers.get(p);
      if (answer instanceof Error) throw answer;
      return answer || null;
    },
    fileUrl: async (p) => { asked.fileUrl.push(p); return `file:///${p}`; },
    currentImage: async (monitorId) => (monitorId === 'mon1' ? 'C:\\w\\current.gif' : ''),
  };
  const openedAssign = [];
  const context = {
    window: { api, MotionBadge, MotionHover, JustifiedLayout: { normalizeAspect: (a) => a } },
    document: doc,
    t,
    $: (selector) => elements[selector] || null,
    LIB: { aspectCache: new Map() },
    normPathKey: (p) => String(p).toLowerCase(),
    setLibCardAspect: () => {},
    homeWallpaperCache: new Map(),
    wallTheme: () => 'light',
    STYLE_CSS: { fill: { size: 'cover', repeat: 'no-repeat', position: 'center' } },
    config: { style: 'fill' },
    stripItems: [],
    slotItems: () => context.stripItems,
    baseName: (p) => String(p).split(/[\\/]/).pop(),
    FOLDER_ICON_SVG: '<svg></svg>',
    bindSlotCardContextMenu: () => {},
    selectedMonitorId: 'mon1',
    previewContextVersion: 0,
    applyPreviewStyle: () => {},
    homeRecentRenderVersion: 1,
    layoutHomeRecentRow: () => {},
    openAssignMenu: (item, anchor) => openedAssign.push(anchor),
    localSelectionRecord: (p) => ({ path: p }),
    Image: class { set src(value) { this.url = value; setTimeout(() => this.onload && this.onload(), 0); } },
    setTimeout,
    console,
  };
  const pieces = [
    extractLine(rendererSrc, 'const STILL_FRAME_MAX = ', 'renderer.js'),
    extract(rendererSrc, 'function applyThumbInfo(card, p, info) {', 'renderer.js'),
    extract(rendererSrc, 'function thumbWithMotion(path, w, h) {', 'renderer.js'),
    extract(rendererSrc, 'function renderStrip(theme) {', 'renderer.js'),
    extract(rendererSrc, 'async function stillFrameView(path) {', 'renderer.js'),
    extract(rendererSrc, 'async function homeWallpaperView(monitor) {', 'renderer.js'),
    extract(rendererSrc, 'function applyHomeDisplayWallpaper(wallpaper, view) {', 'renderer.js'),
    extract(rendererSrc, 'async function setPreview(which, filePath, monitorId = selectedMonitorId) {', 'renderer.js'),
    extract(rendererSrc, 'function resetPreviewsForMonitor(monitorId) {', 'renderer.js'),
    extract(rendererSrc, 'function renderHomeRecentItems(items, version) {', 'renderer.js'),
  ];
  vm.createContext(context);
  const fns = vm.runInContext(`${pieces.join('\n')}
    ({ applyThumbInfo, thumbWithMotion, renderStrip, stillFrameView, homeWallpaperView,
       applyHomeDisplayWallpaper, setPreview, resetPreviewsForMonitor, renderHomeRecentItems });`, context);
  return { doc, answers, asked, elements, api, context, fns, openedAssign };
}

const GIF_MOVING = { format: 'gif', animated: true, frames: 3, width: 480, height: 270 };
const GIF_STILL = { format: 'gif', animated: false, frames: 1, width: 480, height: 270 };

check('a library card wears the chip from its thumbnail answer, and a reused card loses it', () => {
  const w = mainWindow();
  const card = w.doc.createElement('div');
  w.fns.applyThumbInfo(card, 'C:\\w\\a.gif', { url: 'data:x', width: 480, height: 270, motion: GIF_MOVING });
  assert.ok(chipOf(card), 'moving: chip');
  assert.strictEqual(card.dataset.motion, 'GIF');
  assert.strictEqual(chipOf(card).title, 'Animation · GIF · 3 frames');
  assert.strictEqual(card.dataset.playPath, 'C:\\w\\a.gif', 'LIB-017: it plays its own file on hover');
  w.fns.applyThumbInfo(card, 'C:\\w\\b.gif', { url: 'data:y', width: 480, height: 270, motion: GIF_STILL });
  assert.strictEqual(chipOf(card), null, 'the same card now shows a still GIF');
  assert.ok(!('motion' in card.dataset));
  assert.ok(!('playPath' in card.dataset), 'LIB-017: a reused card stops offering the old file');
  w.fns.applyThumbInfo(card, 'C:\\w\\c.jpg', { url: 'data:z', width: 480, height: 270 });
  assert.strictEqual(chipOf(card), null, 'no answer at all is no chip');
});

check('a tile in "Appearance" gets the same chip, from the same single request', async () => {
  const w = mainWindow();
  w.answers.set('C:\\w\\moving.gif', GIF_MOVING);
  w.answers.set('C:\\w\\still.gif', GIF_STILL);
  w.context.stripItems = [
    { id: '1', type: 'image', path: 'C:\\w\\moving.gif' },
    { id: '2', type: 'image', path: 'C:\\w\\still.gif' },
    { id: '3', type: 'folder', path: 'C:\\w\\folder' },
  ];
  w.fns.renderStrip('light');
  await flush();
  const [moving, still, folder] = w.elements['#stripLight'].children;
  assert.ok(chipOf(moving), 'the moving tile');
  assert.strictEqual(moving.dataset.motion, 'GIF', 'so its menu\'s assign window can say "first frame"');
  assert.strictEqual(moving.dataset.playPath, 'C:\\w\\moving.gif', 'LIB-017: the tile plays on hover');
  assert.strictEqual(chipOf(still), null);
  assert.strictEqual(chipOf(folder), null);
  assert.ok(!('playPath' in still.dataset) && !('playPath' in folder.dataset));
  assert.deepStrictEqual(w.asked.mediaMotion, [], 'the tile needs no second question');
  assert.ok(moving.style.backgroundImage.includes('data:still/200/'), 'the tile still shows the thumbnail');
});

check('the browser preview\'s stand-in API has no thumbInfo, and the tile just shows its thumbnail', async () => {
  const w = mainWindow();
  delete w.api.thumbInfo;
  assert.deepStrictEqual(plain(await w.fns.thumbWithMotion('C:\\w\\a.gif', 200, 130)), { url: 'data:plain/C:\\w\\a.gif', motion: null });
  w.api.thumb = async () => { throw new Error('gone'); };
  assert.deepStrictEqual(plain(await w.fns.thumbWithMotion('C:\\w\\a.gif', 200, 130)), { url: '', motion: null });
});

check('Home\'s "recently added" card wears the chip, and its assign window can find it', async () => {
  const w = mainWindow();
  w.answers.set('C:\\w\\moving.gif', GIF_MOVING);
  w.fns.renderHomeRecentItems([{ path: 'C:\\w\\moving.gif' }, { path: 'C:\\w\\photo.jpg' }], 1);
  await flush();
  const [moving, photo] = w.elements['#homeRecentGrid'].children;
  const preview = moving.querySelector('.home-recent-preview');
  assert.ok(chipOf(preview), 'the chip sits on the picture inside the card');
  assert.strictEqual(preview.dataset.playPath, 'C:\\w\\moving.gif', 'LIB-017: the picture plays on hover');
  assert.strictEqual(chipOf(photo.querySelector('.home-recent-preview')), null);
  assert.ok(!('playPath' in photo.querySelector('.home-recent-preview').dataset));
  moving.click();
  assert.strictEqual(MotionBadge.marksMotion(w.openedAssign[0]), true, 'the card handed to the assign window is marked');
});

check('Home\'s monitor draws a moving picture\'s still frame at the picture\'s own size', async () => {
  const w = mainWindow();
  w.answers.set('C:\\w\\current.gif', GIF_MOVING);
  const view = await w.fns.homeWallpaperView({ id: 'mon1' });
  assert.deepStrictEqual(w.asked.thumbInfo, [['C:\\w\\current.gif', 480, 480]], 'asked at 480, not blown up to 1024');
  assert.strictEqual(view.url, 'data:still/480/C:\\w\\current.gif');
  assert.deepStrictEqual(plain(view.motion), { format: 'gif', frames: 3 });
  assert.deepStrictEqual(w.asked.fileUrl, [], 'the file itself would play; it is not used');
  assert.strictEqual(w.context.homeWallpaperCache.get('mon1|light'), view, 'the cache holds the same answer');
});

check('a big moving picture is capped at the thumbnail limit; an unknown size asks for the limit', async () => {
  const w = mainWindow();
  w.answers.set('C:\\w\\current.gif', { format: 'webp', animated: true, frames: null, width: 3840, height: 2160 });
  await w.fns.homeWallpaperView({ id: 'mon1' });
  w.answers.set('C:\\w\\current.gif', { format: 'gif', animated: true, frames: null, width: 0, height: 0 });
  await w.fns.homeWallpaperView({ id: 'mon1' });
  assert.deepStrictEqual(w.asked.thumbInfo.map((call) => call[1]), [1024, 1024]);
});

check('a still picture, or a question that fails, draws the file exactly as before', async () => {
  const w = mainWindow();
  w.answers.set('C:\\w\\current.gif', GIF_STILL);
  const still = await w.fns.homeWallpaperView({ id: 'mon1' });
  assert.deepStrictEqual(plain(still), { url: 'file:///C:\\w\\current.gif', motion: null });
  w.answers.set('C:\\w\\current.gif', new Error('locked'));
  const failed = await w.fns.homeWallpaperView({ id: 'mon1' });
  assert.deepStrictEqual(plain(failed), { url: 'file:///C:\\w\\current.gif', motion: null });
  assert.deepStrictEqual(w.asked.thumbInfo, [], 'no still frame was asked for');
  assert.deepStrictEqual(plain(await w.fns.homeWallpaperView({ id: 'mon2' })), { url: '', motion: null }, 'an empty monitor');
});

check('the monitor\'s label row carries the chip beside the monitor name, and drops it', () => {
  const w = mainWindow();
  const screen = w.doc.createElement('div');
  const wallpaper = screen.appendChild(w.doc.createElement('span'));
  const labels = w.doc.createElement('span');
  labels.className = 'home-display-labels';
  const name = labels.appendChild(w.doc.createElement('span'));
  name.className = 'home-display-label';
  screen.appendChild(labels);
  w.fns.applyHomeDisplayWallpaper(wallpaper, { url: 'data:still', motion: { format: 'gif', frames: 3 } });
  assert.strictEqual(chipOf(labels).className, 'lib-motion inline');
  assert.ok(!('playPath' in wallpaper.dataset) && !('playPath' in labels.dataset), 'LIB-017: a monitor never plays');
  assert.strictEqual(labels.children[0], name, 'the chip follows the name, it does not replace it');
  assert.ok(wallpaper.style.backgroundImage.includes('data:still'));
  w.fns.applyHomeDisplayWallpaper(wallpaper, { url: 'file:///x.jpg', motion: null });
  assert.strictEqual(chipOf(labels), null);
  w.fns.applyHomeDisplayWallpaper(wallpaper, { url: 'data:still', motion: { format: 'gif', frames: 0 } });
  w.fns.applyHomeDisplayWallpaper(wallpaper, null);
  assert.strictEqual(chipOf(labels), null, 'an emptied monitor has no chip either');
});

check('"Appearance" previews the still frame with the chip, and loses both for a still file', async () => {
  const w = mainWindow();
  const el = w.elements['#previewLight'];
  w.answers.set('C:\\w\\moving.gif', GIF_MOVING);
  await w.fns.setPreview('light', 'C:\\w\\moving.gif', 'mon1');
  assert.ok(el.style.backgroundImage.includes('data:still/480/C:\\w\\moving.gif'), el.style.backgroundImage);
  assert.ok(chipOf(el));
  assert.strictEqual(el.dataset.motion, 'GIF', 'the preview\'s own menu can say "first frame"');
  assert.ok(!('playPath' in el.dataset), 'LIB-017: the desktop preview never plays, it shows the first frame');
  await w.fns.setPreview('light', 'C:\\w\\photo.jpg', 'mon1');
  assert.ok(el.style.backgroundImage.startsWith('url("file:///C:\\w\\photo.jpg?v='), el.style.backgroundImage);
  assert.strictEqual(chipOf(el), null);
  assert.ok(!('motion' in el.dataset));
});

check('switching monitors clears the preview\'s mark together with its chip', async () => {
  const w = mainWindow();
  const el = w.elements['#previewDark'];
  w.answers.set('C:\\w\\moving.gif', GIF_MOVING);
  await w.fns.setPreview('dark', 'C:\\w\\moving.gif', 'mon1');
  assert.strictEqual(el.dataset.motion, 'GIF');
  w.fns.resetPreviewsForMonitor('mon2');
  assert.strictEqual(chipOf(el), null);
  assert.ok(!('motion' in el.dataset), 'a mark without its chip would still add the line to the assign window');
  await w.fns.setPreview('dark', 'C:\\w\\moving.gif', 'mon1');
  assert.strictEqual(el.dataset.motion, 'GIF');
  // A different monitor is a different context: its first step wipes the old markup.
  const pending = w.fns.setPreview('dark', 'C:\\w\\photo.jpg', 'mon3');
  assert.ok(!('motion' in el.dataset), 'wiped at once, not only when the new picture has loaded');
  await pending;
});

check('the main assign window adds the line only for an anchor that marks a moving picture', () => {
  const block = extract(rendererSrc, 'function openAssignMenu(it, anchor, materializeFn, options = {}) {', 'renderer.js');
  assert.ok(block.includes('if (window.MotionBadge.marksMotion(anchor)) window.MotionBadge.appendFirstFrameNote(pop, t);'),
    'the one place the main window decides it');
});

// --- "Details" ----------------------------------------------------------------------------
// The sheet's "Type" row: for a local file it is filled once main has read the bytes, for
// a site card it is known from the card. The model half is in card-details.test.js; this
// is the drawing half, through the real openCardDetails.
function detailsWindow({ item = null, details = null } = {}) {
  const doc = makeDocument();
  doc.body = doc.createElement('body');
  doc.body.root = true;
  doc.activeElement = null;
  doc.removeEventListener = () => {};
  const context = {
    window: {
      MotionBadge,
      api: { itemDetails: async () => details, thumbInfo: async () => ({ url: '' }) },
    },
    document: doc,
    t,
    $: () => null,
    CardDetails: require('../renderer/card-details'),
    CardActions: require('../renderer/card-actions'),
    INTERNET: { providerNames: { gelbooru: 'Gelbooru' } },
    FEATURES: { physicalDelete: false },
    detailsCloseHandler: null,
    poolItemForRecord: () => item,
    inRemovedView: () => false,
    runDetailsLookup: async () => true,
    runCardTransfer: async () => true,
    toast: () => {},
    requestAnimationFrame: () => {},
    formatFileSize: (n) => `${n} B`,
    formatDetailsDate: (d) => `date ${d}`,
    detailsPreviewUrl: async () => '',
    console,
  };
  vm.createContext(context);
  const fns = vm.runInContext(`${extract(rendererSrc, 'function closeCardDetails() {', 'renderer.js')}
    ${extract(rendererSrc, 'function detailsRow(label, value, opts = {}) {', 'renderer.js')}
    ${extract(rendererSrc, 'async function openCardDetails(subject, record = null) {', 'renderer.js')}
    ({ openCardDetails });`, context);
  const typeText = () => {
    const rows = doc.body.querySelectorAll('.details-row');
    const row = rows.find((r) => r.children[0].textContent === t('details.type'));
    return row ? row.children[1].textContent : null;
  };
  return { fns, typeText, CardActions: context.CardActions };
}

check('"Details" of a local file says it moves, with the frame count main read', async () => {
  const p = 'C:\\w\\moving.gif';
  const item = { id: 'a', type: 'image', path: p, addedAt: 1, tags: [] };
  const d = detailsWindow({
    item,
    details: { exists: true, width: 480, height: 270, size: 900, modifiedAt: 5, motion: GIF_MOVING },
  });
  await d.fns.openCardDetails(d.CardActions.localSubject({ path: p, type: 'image', id: 'a' }, item), { path: p, type: 'image', id: 'a' });
  assert.strictEqual(d.typeText(), 'Animation · GIF · 3 frames');
});

check('"Details" of a still local file keeps saying "Image"', async () => {
  const p = 'C:\\w\\still.gif';
  const item = { id: 'b', type: 'image', path: p, addedAt: 1, tags: [] };
  const d = detailsWindow({
    item,
    details: { exists: true, width: 480, height: 270, size: 900, modifiedAt: 5, motion: GIF_STILL },
  });
  await d.fns.openCardDetails(d.CardActions.localSubject({ path: p, type: 'image', id: 'b' }, item), { path: p, type: 'image', id: 'b' });
  assert.strictEqual(d.typeText(), t('details.typeImage'));
});

check('"Details" of a moving site card says so at once, without a frame count', async () => {
  const d = detailsWindow();
  const card = {
    id: 'gelbooru:1', provider: 'gelbooru', page: 'https://gelbooru.com/index.php?id=1',
    full: 'https://img3.gelbooru.com/images/aa/bb/x.gif', thumb: 'https://img3.gelbooru.com/thumb.jpg',
    width: 480, height: 270, format: 'gif', animated: true, purity: 'sfw', tags: ['animated'],
  };
  await d.fns.openCardDetails(d.CardActions.internetSubject(card), null);
  assert.strictEqual(d.typeText(), 'Animation · GIF');
});

// --- the viewer ---------------------------------------------------------------------------
function viewerWindow() {
  const doc = makeDocument();
  const root = doc.createElement('div');
  root.root = true;
  const asked = [];
  const answers = new Map();
  const context = {
    window: {
      MotionBadge,
      viewerApi: {
        cardAssignTargets: async () => ({ monitors: [{ id: 'm1' }], separateThemes: false, slots: {} }),
        mediaMotion: async (p) => {
          asked.push(p);
          const answer = answers.get(p);
          if (answer instanceof Error) throw answer;
          return answer || null;
        },
      },
    },
    document: doc,
    t,
    $: (selector) => (selector === '#viewerRoot' ? root : null),
    closeViewerPopup: () => { root.children.slice().forEach((c) => c.remove()); },
    AssignRows: {
      build: (pop) => {
        const row = doc.createElement('div');
        row.className = 'lib-popup-row';
        pop.appendChild(row);
      },
    },
    CardMenu: { placeAt: () => ({ left: 10, top: 10 }) },
    VIEWER_POPUP: { element: null, dismiss: null },
    showViewerMessage: () => {},
    setTimeout,
    Promise,
  };
  vm.createContext(context);
  const fns = vm.runInContext(`${extract(viewerSrc, 'async function viewerEntryMoves(entry) {', 'viewer.js')}
    ${extract(viewerSrc, 'async function openViewerAssign(entry, descriptor, point) {', 'viewer.js')}
    ({ viewerEntryMoves, openViewerAssign });`, context);
  return { root, asked, answers, fns, context };
}

check('the viewer knows a moving picture: a site\'s word for its cards, main\'s for files', async () => {
  const v = viewerWindow();
  v.answers.set('C:\\w\\moving.webp', { format: 'webp', animated: true, frames: null, width: 800, height: 600 });
  v.answers.set('C:\\w\\locked.gif', new Error('locked'));
  const yes = [
    { kind: 'internet', raw: { animated: true, format: 'gif' } },
    { kind: 'library', path: 'C:\\w\\moving.webp' },
    { kind: 'path', path: 'C:\\w\\moving.webp' },
  ];
  const no = [
    { kind: 'internet', raw: { animated: true, format: 'jpg' } },
    { kind: 'internet', raw: { format: 'gif' } },
    { kind: 'internet' },
    { kind: 'library', path: 'C:\\w\\still.gif' },
    { kind: 'path', path: 'C:\\w\\locked.gif' },
    { kind: 'cloud', raw: { animated: true, format: 'gif' } },
    { kind: 'library' },
    null,
  ];
  for (const entry of yes) assert.strictEqual(await v.fns.viewerEntryMoves(entry), true, JSON.stringify(entry));
  for (const entry of no) assert.strictEqual(await v.fns.viewerEntryMoves(entry), false, JSON.stringify(entry));
  assert.ok(!v.asked.includes(undefined), 'main is asked only about a real path');
});

check('the viewer\'s assign window adds the first-frame line under the rows, only when it moves', async () => {
  const v = viewerWindow();
  v.answers.set('C:\\w\\moving.gif', { format: 'gif', animated: true, frames: 3, width: 2, height: 2 });
  await v.fns.openViewerAssign({ kind: 'library', path: 'C:\\w\\moving.gif' }, {}, { x: 5, y: 5 });
  const pop = v.root.children[0];
  const note = noteOf(pop);
  assert.ok(note, 'moving: the line is there');
  assert.strictEqual(pop.children[pop.children.length - 1], note, 'after the monitor rows');
  assert.strictEqual(note.children[0].textContent, 'For now, the desktop shows the first frame.');
  await v.fns.openViewerAssign({ kind: 'library', path: 'C:\\w\\still.gif' }, {}, { x: 5, y: 5 });
  assert.strictEqual(v.root.children.length, 1, 'the first chooser was closed');
  assert.strictEqual(noteOf(v.root.children[0]), null, 'still: no line');
});

check('the viewer\'s assign window still opens when main cannot answer', async () => {
  const v = viewerWindow();
  v.context.window.viewerApi.cardAssignTargets = async () => { throw new Error('gone'); };
  v.context.window.viewerApi.mediaMotion = async () => { throw new Error('gone'); };
  await v.fns.openViewerAssign({ kind: 'path', path: 'C:\\w\\x.gif' }, {}, null);
  assert.strictEqual(v.root.children.length, 1);
  assert.strictEqual(noteOf(v.root.children[0]), null);
});

check('both windows load the chip module before the code that uses it', () => {
  for (const [page, script] of [['index.html', 'renderer.js'], ['viewer.html', 'viewer.js']]) {
    const html = read('renderer', page);
    const module = html.indexOf('<script src="motion-badge.js"></script>');
    assert.ok(module > 0 && module < html.indexOf(`<script src="${script}"></script>`), page);
  }
});

// LIB-017, review of PR #114: the controller is wired by the real installMotionHover, and
// init() calls it. Without the call every card is marked and nothing ever plays, while all
// the checks above stay green.
check('the main window wires hover playback at start-up, through file-url', async () => {
  const listeners = {};
  const doc = {
    hidden: false,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    defaultView: { addEventListener: () => {} },
  };
  const asked = [];
  const timers = [];
  const context = {
    window: {
      MotionHover,
      api: { fileUrl: async (p) => { asked.push(p); return `file:///${p}`; } },
      matchMedia: () => ({ matches: false }),
    },
    document: doc,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  vm.createContext(context);
  vm.runInContext(`${extract(rendererSrc, 'function installMotionHover() {', 'renderer.js')}
    installMotionHover();`, context);
  assert.strictEqual(typeof listeners.mouseover, 'function', 'the document listens for the pointer');
  const host = {
    dataset: { motion: 'GIF', playPath: 'C:\\w\\a.gif' },
    closest: () => host,
    ownerDocument: { createElement: () => ({}) },
  };
  listeners.mouseover({ target: host });
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 400);
  timers[0].fn();
  await flush();
  assert.deepStrictEqual(asked, ['C:\\w\\a.gif'], 'the file address comes from main, as for any file');

  const init = extract(rendererSrc, 'async function init() {', 'renderer.js');
  assert.ok(/^async function init\(\) \{\n {2}installMotionHover\(\);/.test(init),
    'init() installs hover playback first, before any await');
});

check('the main window loads motion-hover.js before renderer.js', () => {
  // LIB-017: only the main window plays on hover; the viewer plays the file anyway.
  const html = read('renderer', 'index.html');
  const hover = html.indexOf('<script src="motion-hover.js"></script>');
  assert.ok(hover > 0 && hover < html.indexOf('<script src="renderer.js"></script>'), 'index.html loads motion-hover.js first');
});

(async () => {
  for (const run of queue) await run();
  console.log(`PASS motion-renderer: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
