'use strict';

// BUG-035. The one "moves" chip: what it says, where it comes from, and that a reused card
// never keeps a chip that is no longer true.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const MotionBadge = require('../renderer/motion-badge.js');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const en = JSON.parse(read('locales', 'en.json'));
const ru = JSON.parse(read('locales', 'ru.json'));

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

// t() the way the window does it: look the key up, fill {placeholders}.
function makeT(catalogue) {
  return (key, params = {}) => {
    const text = key.split('.').reduce((node, part) => (node == null ? node : node[part]), catalogue);
    if (typeof text !== 'string') throw new Error(`missing string ${key}`);
    return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
  };
}
const t = makeT(en);

// Just enough DOM for sync(): children, classes, attributes, dataset, closest/querySelector.
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
    const el = this;
    this.classList = { contains: (name) => el.className.split(/\s+/).includes(name) };
  }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  matchesMotion() { return Object.prototype.hasOwnProperty.call(this.dataset, 'motion'); }
  closest(selector) {
    assert.strictEqual(selector, '[data-motion]');
    for (let node = this; node; node = node.parentElement) if (node.matchesMotion()) return node;
    return null;
  }
  querySelector(selector) {
    assert.strictEqual(selector, '[data-motion]');
    for (const child of this.children) {
      if (child.matchesMotion()) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }
}
const doc = { createElement: (tag) => new FakeElement(doc, tag) };
const chipsOf = (host) => host.children.filter((c) => c.classList.contains('lib-motion'));

ok('a local picture moves only on an explicit yes from main', () => {
  assert.deepStrictEqual(MotionBadge.fromLocal({ format: 'gif', animated: true, frames: 48 }), { format: 'gif', frames: 48 });
  assert.deepStrictEqual(MotionBadge.fromLocal({ format: 'webp', animated: true, frames: null }), { format: 'webp', frames: 0 });
  for (const answer of [null, undefined, {}, { animated: false }, { animated: null }, { animated: 'yes' }]) {
    assert.strictEqual(MotionBadge.fromLocal(answer), null, JSON.stringify(answer));
  }
});

ok('a site card moves on the site\'s word, and only in a format that can', () => {
  assert.deepStrictEqual(MotionBadge.fromSite({ animated: true, format: 'gif' }), { format: 'gif', frames: 0 });
  assert.deepStrictEqual(MotionBadge.fromSite({ animated: true, format: 'WEBP' }), { format: 'webp', frames: 0 });
  assert.strictEqual(MotionBadge.fromSite({ animated: true, format: 'jpg' }), null);
  assert.strictEqual(MotionBadge.fromSite({ animated: false, format: 'gif' }), null);
  assert.strictEqual(MotionBadge.fromSite({ format: 'gif' }), null, 'an untagged GIF may be a still one');
});

ok('the chip says GIF for every moving format; the tooltip names the real one', () => {
  assert.strictEqual(MotionBadge.CHIP_TEXT, 'GIF');
  assert.strictEqual(MotionBadge.describe(t, { format: 'webp', frames: 0 }), 'Animation · WEBP');
  assert.strictEqual(MotionBadge.describe(t, { format: 'png', frames: 0 }), 'Animation · APNG');
  assert.strictEqual(MotionBadge.describe(t, { format: 'gif', frames: 48 }), 'Animation · GIF · 48 frames');
  assert.strictEqual(MotionBadge.describe(makeT(ru), { format: 'gif', frames: 48 }), 'Анимация · GIF · кадров: 48');
  assert.strictEqual(MotionBadge.describe(t, null), '');
});

ok('sync puts one chip on, keeps it one, and takes it off a reused card', () => {
  const card = doc.createElement('div');
  MotionBadge.sync(card, { format: 'webp', frames: 0 }, t);
  MotionBadge.sync(card, { format: 'webp', frames: 0 }, t);
  assert.strictEqual(chipsOf(card).length, 1, 'calling it twice changes nothing');
  const chip = chipsOf(card)[0];
  assert.strictEqual(chip.textContent, 'GIF');
  assert.strictEqual(chip.className, 'lib-motion');
  assert.strictEqual(chip.title, 'Animation · WEBP');
  assert.strictEqual(chip.attributes['aria-label'], 'Animation · WEBP');
  assert.strictEqual(card.dataset.motion, 'WEBP');
  // The same card now shows a still picture: the chip and the mark must go.
  MotionBadge.sync(card, null, t);
  assert.strictEqual(chipsOf(card).length, 0);
  assert.ok(!('motion' in card.dataset));
});

ok('an inline chip sits in a row and does not mark its row as a card', () => {
  const labels = doc.createElement('span');
  MotionBadge.sync(labels, { format: 'gif', frames: 0 }, t, { inline: true });
  assert.strictEqual(chipsOf(labels)[0].className, 'lib-motion inline');
  assert.ok(!('motion' in labels.dataset));
});

ok('the assign window finds a moving card from the card or from inside it', () => {
  const card = doc.createElement('button');
  const preview = card.appendChild(doc.createElement('span'));
  const button = card.appendChild(doc.createElement('button'));
  assert.strictEqual(MotionBadge.marksMotion(card), false);
  MotionBadge.sync(preview, { format: 'gif', frames: 0 }, t);
  assert.strictEqual(MotionBadge.marksMotion(card), true, 'Home "recently added": the chip lives on the preview inside');
  const grid = doc.createElement('div');
  MotionBadge.sync(grid, { format: 'gif', frames: 0 }, t);
  const inner = grid.appendChild(doc.createElement('span'));
  assert.strictEqual(MotionBadge.marksMotion(inner), true, 'anything on a moving card counts');
  assert.strictEqual(MotionBadge.marksMotion(button), false);
  assert.strictEqual(MotionBadge.marksMotion(null), false);
});

ok('the first-frame line is one line under whatever the window already drew', () => {
  const pop = doc.createElement('div');
  const rows = pop.appendChild(doc.createElement('div'));
  const note = MotionBadge.appendFirstFrameNote(pop, t);
  assert.deepStrictEqual(pop.children, [rows, note]);
  assert.strictEqual(note.className, 'lib-popup-note');
  assert.strictEqual(note.children.length, 1, 'the icon is markup; the words are one text node');
  assert.strictEqual(note.children[0].textContent, en.motion.desktopFirstFrame);
  assert.strictEqual(MotionBadge.appendFirstFrameNote(null, t), null);
});

ok('every string the chip and its neighbours use exists in both reference catalogues', () => {
  for (const key of ['format', 'formatFrames', 'desktopFirstFrame']) {
    assert.strictEqual(typeof en.motion[key], 'string', `en motion.${key}`);
    assert.strictEqual(typeof ru.motion[key], 'string', `ru motion.${key}`);
  }
  assert.ok(/\{format\}/.test(en.motion.format) && /\{frames\}/.test(ru.motion.formatFrames));
});

console.log(`PASS motion-badge: ${passed} checks`);
