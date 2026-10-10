'use strict';

// LIB-017. A moving picture plays on its card while the pointer rests on it.
// The controller from renderer/motion-hover.js with fake timers and a fake DOM: the delay, one
// card at a time, the still frame kept until the file is ready, leaving before or after the
// load, reduced motion, a reused card that lost its chip, and the document wiring.
// test/motion-renderer.test.js proves the real renderer functions mark the right hosts.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const MotionHover = require('../renderer/motion-hover.js');

let checks = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    await fn();
    checks += 1;
    console.log(`  ok ${name}`);
  });
}
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.connected = false;
  }
  get firstChild() { return this.children[0] || null; }
  get isConnected() {
    for (let node = this; node; node = node.parentNode) if (node.connected) return true;
    return false;
  }
  insertBefore(child, ref) {
    child.parentNode = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
    return child;
  }
  appendChild(child) { return this.insertBefore(child, null); }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }
  closest(selector) {
    assert.strictEqual(selector, '[data-play-path]');
    for (let node = this; node; node = node.parentNode) if (node.dataset && node.dataset.playPath) return node;
    return null;
  }
}

function setup(opts = {}) {
  const doc = { createElement: (tag) => new FakeElement(doc, tag) };
  const timers = new Map();
  let nextId = 1;
  const asked = [];
  const urls = opts.urls || {};
  let reduced = !!opts.reduced;
  const controller = MotionHover.create({
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    resolveUrl: (p) => { asked.push(p); return Promise.resolve(p in urls ? urls[p] : `file:///${p}`); },
    reducedMotion: () => reduced,
  });
  const root = doc.createElement('div');
  root.connected = true;
  function card(filePath, { moving = true } = {}) {
    const el = root.appendChild(doc.createElement('div'));
    if (moving) el.dataset.motion = 'GIF';
    MotionHover.mark(el, filePath, moving);
    el.appendChild(doc.createElement('span')); // the chip
    return el;
  }
  // Fires every pending timer once, as the clock would after the delay.
  function elapse() {
    const due = [...timers.entries()];
    timers.clear();
    for (const [, { fn }] of due) fn();
  }
  const imgOf = (el) => el.children.find((c) => c.className === MotionHover.PLAY_CLASS) || null;
  // The browser finishing the load of the picture `el` is fetching.
  const pending = [];
  const origCreate = doc.createElement;
  doc.createElement = (tag) => {
    const made = origCreate(tag);
    if (tag === 'img') pending.push(made);
    return made;
  };
  const loadAll = () => { while (pending.length) { const img = pending.shift(); if (img.onload) img.onload(); } };
  const failAll = () => { while (pending.length) { const img = pending.shift(); if (img.onerror) img.onerror(); } };
  return {
    doc, root, controller, timers, asked, card, elapse, imgOf, loadAll, failAll, pending,
    setReduced: (v) => { reduced = v; },
  };
}

check('mark offers a file only for a moving picture, and a reused host takes it back', () => {
  const host = { dataset: {} };
  MotionHover.mark(host, 'C:\\a.gif', true);
  assert.strictEqual(host.dataset.playPath, 'C:\\a.gif');
  MotionHover.mark(host, 'C:\\b.gif', false);
  assert.ok(!('playPath' in host.dataset));
  MotionHover.mark(host, '', true);
  assert.ok(!('playPath' in host.dataset), 'no path, nothing to play');
  MotionHover.mark(null, 'x', true); // a host that is gone is not an error
});

check('nothing starts before the delay: the timer is 0.4 s and nothing is asked yet', async () => {
  const s = setup();
  const el = s.card('C:\\w\\a.gif');
  s.controller.hover(el);
  assert.strictEqual(s.timers.size, 1);
  assert.strictEqual([...s.timers.values()][0].ms, 400);
  assert.strictEqual(MotionHover.DELAY_MS, 400, 'owner\'s choice 2026-10-09');
  await flush();
  assert.deepStrictEqual(s.asked, [], 'a quick pass loads nothing');
  assert.strictEqual(s.imgOf(el), null);
});

check('after the delay the file plays over the still frame, which stays until it is ready', async () => {
  const s = setup();
  const el = s.card('C:\\w\\a.gif');
  el.style = { backgroundImage: 'url("data:still")' };
  s.controller.hover(el);
  s.elapse();
  await flush();
  assert.deepStrictEqual(s.asked, ['C:\\w\\a.gif']);
  assert.strictEqual(s.imgOf(el), null, 'not shown before it has loaded: no blank flash');
  s.loadAll();
  const img = s.imgOf(el);
  assert.ok(img, 'playing');
  assert.strictEqual(img.src, 'file:///C:\\w\\a.gif');
  assert.strictEqual(el.children[0], img, 'first child: the chip, star and menu stay above it');
  assert.strictEqual(el.style.backgroundImage, 'url("data:still")', 'the still frame itself is never touched');
});

check('leaving takes the moving picture away at once', async () => {
  const s = setup();
  const el = s.card('C:\\w\\a.gif');
  s.controller.hover(el);
  s.elapse();
  await flush();
  s.loadAll();
  assert.ok(s.imgOf(el));
  s.controller.hover(null);
  assert.strictEqual(s.imgOf(el), null);
  assert.strictEqual(s.controller.host, null);
});

check('leaving before the delay cancels the timer; leaving during the load abandons it', async () => {
  const s = setup();
  const a = s.card('C:\\w\\a.gif');
  s.controller.hover(a);
  s.controller.hover(null);
  assert.strictEqual(s.timers.size, 0, 'timer cleared');
  s.controller.hover(a);
  s.elapse();
  await flush();
  assert.strictEqual(s.pending.length, 1, 'load started');
  const img = s.pending[0];
  s.controller.hover(null);
  assert.strictEqual(img.onload, null, 'a late load has nothing to do');
  s.loadAll();
  assert.strictEqual(s.imgOf(a), null);
});

check('one card at a time: moving to another stops the first', async () => {
  const s = setup();
  const a = s.card('C:\\w\\a.gif');
  const b = s.card('C:\\w\\b.gif');
  s.controller.hover(a);
  s.elapse();
  await flush();
  s.loadAll();
  s.controller.hover(b);
  assert.strictEqual(s.imgOf(a), null, 'the first one is still again');
  s.elapse();
  await flush();
  s.loadAll();
  assert.ok(s.imgOf(b));
  assert.strictEqual(s.root.children.filter((c) => s.imgOf(c)).length, 1);
});

check('moving within the same card (onto its chip or star) does not restart it', async () => {
  const s = setup();
  const a = s.card('C:\\w\\a.gif');
  s.controller.hover(a);
  s.elapse();
  await flush();
  s.loadAll();
  const img = s.imgOf(a);
  s.controller.hover(a);
  assert.strictEqual(s.imgOf(a), img);
  assert.strictEqual(s.timers.size, 0, 'no second timer');
});

check('a slow URL answer for a card already left is ignored', async () => {
  const s = setup();
  const a = s.card('C:\\w\\a.gif');
  const b = s.card('C:\\w\\b.jpg', { moving: false });
  s.controller.hover(a);
  s.elapse(); // asked for the URL; the answer is still on its way
  s.controller.hover(b);
  await flush();
  assert.strictEqual(s.pending.length, 0, 'no load starts for a card the pointer left');
});

check('only a host with both the chip and a file plays', async () => {
  const s = setup();
  const still = s.card('C:\\w\\a.jpg', { moving: false });
  s.controller.hover(still);
  assert.strictEqual(s.timers.size, 0);
  const lost = s.card('C:\\w\\b.gif');
  delete lost.dataset.motion; // a reused card whose chip came off
  s.controller.hover(lost);
  assert.strictEqual(s.timers.size, 0);
  const online = s.root.appendChild(s.doc.createElement('div'));
  online.dataset.motion = 'GIF'; // an online card wears the chip, but offers no file
  s.controller.hover(online);
  assert.strictEqual(s.timers.size, 0);
});

check('a card that lost its chip or left the screen while loading does not show the file', async () => {
  const s = setup();
  const a = s.card('C:\\w\\a.gif');
  s.controller.hover(a);
  s.elapse();
  await flush();
  delete a.dataset.motion;
  s.loadAll();
  assert.strictEqual(s.imgOf(a), null);

  const b = s.card('C:\\w\\b.gif');
  s.controller.hover(b);
  s.elapse();
  await flush();
  s.root.removeChild(b); // the virtual grid dropped it
  s.loadAll();
  assert.strictEqual(s.imgOf(b), null);
});

check('with Windows animations off nothing plays', async () => {
  const s = setup({ reduced: true });
  const a = s.card('C:\\w\\a.gif');
  s.controller.hover(a);
  assert.strictEqual(s.timers.size, 0);
  s.setReduced(false);
  s.controller.hover(null);
  s.controller.hover(a);
  assert.strictEqual(s.timers.size, 1, 'and it is read at the moment of hover');
});

check('a file that cannot be loaded or has no address leaves the still frame', async () => {
  const s = setup({ urls: { 'C:\\w\\gone.gif': '' } });
  const gone = s.card('C:\\w\\gone.gif');
  s.controller.hover(gone);
  s.elapse();
  await flush();
  assert.strictEqual(s.pending.length, 0, 'main refused the path: nothing to load');
  const broken = s.card('C:\\w\\broken.gif');
  s.controller.hover(broken);
  s.elapse();
  await flush();
  s.failAll();
  assert.strictEqual(s.imgOf(broken), null);
  s.controller.hover(null); // and leaving after a failure is quiet
});

check('install: pointer over a card plays it, over nothing stops, leaving the window stops', async () => {
  const s = setup();
  const listeners = {};
  const viewListeners = {};
  const doc = {
    hidden: false,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    defaultView: { addEventListener: (type, fn) => { viewListeners[type] = fn; } },
  };
  MotionHover.install(doc, s.controller);
  const a = s.card('C:\\w\\a.gif');
  const chip = a.children[a.children.length - 1];
  listeners.mouseover({ target: chip });
  assert.strictEqual(s.controller.host, a, 'the chip inside the card counts as the card');
  listeners.mouseover({ target: s.root });
  assert.strictEqual(s.controller.host, null);
  listeners.mouseover({ target: a });
  listeners.mouseout({ target: a, relatedTarget: chip });
  assert.strictEqual(s.controller.host, a, 'moving inside the window is decided by mouseover');
  listeners.mouseout({ target: a, relatedTarget: null });
  assert.strictEqual(s.controller.host, null, 'pointer left the window');
  listeners.mouseover({ target: a });
  viewListeners.blur();
  assert.strictEqual(s.controller.host, null, 'window lost focus');
  listeners.mouseover({ target: a });
  doc.hidden = true;
  listeners.visibilitychange();
  assert.strictEqual(s.controller.host, null, 'window hidden');
});

check('online cards never offer a file to play (owner, 2026-10-09)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  for (const head of ['function buildInternetCard(item) {', 'function buildCloudCard(item) {']) {
    const start = src.indexOf(head);
    assert.ok(start >= 0, head);
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.ok(!body.includes('MotionHover') && !body.includes('playPath'), head);
  }
});

(async () => {
  for (const run of queue) await run();
  console.log(`PASS motion-hover: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
