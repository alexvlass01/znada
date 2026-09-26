'use strict';

// DESIGN-008. Adding an online picture to the library takes seconds (the original is
// downloaded), and the button used to just go grey for that long — it read as a frozen
// app. The REAL code of both windows runs here against a small fake DOM and IPC replies
// that are held open, so every check looks at the button in the middle of a download:
//
// - the viewer: the button says "Adding…" at once, the state belongs to the picture
//   (stepping away and back keeps it), a second click or the menu gets the same download,
//   and a picture finished while another is on screen says so in a notice;
// - the Online grid: the same for the "+", including a card drawn again mid-download.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').split('\r\n').join('\n');
const viewerSource = read('renderer/viewer.js');
const rendererSource = read('renderer/renderer.js');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed++;
}

// A whole top-level function, `async` included, by its braces.
function functionSource(source, name) {
  let start = source.indexOf(`\nasync function ${name}(`);
  if (start < 0) start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  start += 1;
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function constSource(source, name) {
  const line = source.split('\n').find((text) => text.startsWith(`const ${name} = `));
  assert.ok(line, `missing const ${name}`);
  return line.replace('const ', 'var ');
}

// Just enough DOM for these functions: classes, text, children, attributes, listeners.
function makeElement(tag) {
  const classes = new Set();
  const el = {
    tag, children: [], parent: null, attrs: {}, dataset: {}, listeners: {}, disabled: false, title: '', type: '',
    ownText: '',
    get className() { return [...classes].join(' '); },
    set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; },
    },
    get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); },
    set textContent(value) { this.ownText = String(value); this.children = []; },
    set innerHTML(value) { this.ownText = ''; this.children = []; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(child) { child.parent = this; this.children.push(child); return child; },
    append(...kids) { kids.forEach((kid) => this.appendChild(kid)); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    async click() { for (const fn of this.listeners.click || []) await fn({ stopPropagation() {} }); },
    querySelectorAll(selector) {
      const cls = selector.replace(/^\./, '');
      const out = [];
      const walk = (node) => node.children.forEach((c) => { if (c.classList.contains(cls)) out.push(c); walk(c); });
      walk(this);
      return out;
    },
  };
  return el;
}

// An IPC reply the test decides when to deliver.
function held() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const CardTransfer = require('../renderer/card-transfer');

(async () => {
  // =============================== the viewer ===================================
  {
    const root = makeElement('main');
    const actions = makeElement('div');
    const replies = [];
    const ctx = {
      t: (key) => key,
      document: { createElement: makeElement },
      $: (selector) => {
        if (selector === '#viewerRoot') return root;
        if (selector === '#viewerActions') return actions;
        if (selector === '#viewerActions [data-action="add"]') {
          return actions.children.find((c) => c.dataset.action === 'add') || null;
        }
        return null;
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
      CardTransfer,
      CardActions: { descriptorFor: (subject) => ({ kind: subject.kind }) },
      viewerSubjectFor: (entry) => entry,
      removeViewerCard: async () => true,
      window: { viewerApi: {
        internetAdd: () => { const reply = held(); replies.push(reply); return reply.promise; },
        cloudAdd: () => { throw new Error('not a catalogue card'); },
      } },
    };
    vm.createContext(ctx);
    vm.runInContext(constSource(viewerSource, 'VIEWER'), ctx);
    vm.runInContext(constSource(viewerSource, 'VIEWER_NOTICE'), ctx);
    for (const name of ['currentEntry', 'dismissViewerNotice', 'createViewerNotice', 'showViewerMessage',
      'syncAddAction', 'syncCurrentAddAction', 'addViewerCardToLibrary', 'downloadViewerCard', 'renderActions']) {
      vm.runInContext(functionSource(viewerSource, name), ctx);
    }

    const card = (n) => ({ kind: 'internet', raw: { page: `https://site/${n}`, full: `https://cdn/${n}.jpg` }, added: false, pooled: null });
    ctx.VIEWER.items = [card(1), card(2), card(3), card(4)];
    const [first, , third, fourth] = ctx.VIEWER.items;
    const show = (index) => { ctx.VIEWER.index = index; ctx.renderActions(ctx.VIEWER.items[index]); };
    const button = () => ctx.$('#viewerActions [data-action="add"]');
    const notice = () => root.children.find((c) => c.classList.contains('media-notice')) || null;
    const isBusy = (b) => b.classList.contains('busy') && b.disabled === true
      && b.getAttribute('aria-busy') === 'true' && b.textContent === 'online.adding'
      && b.children.some((c) => c.classList.contains('spin'));

    show(0);
    const clicked = button().click();
    ok('viewer: right after the click the button says "Adding…" with a spinner and cannot be pressed',
      isBusy(button()) && replies.length === 1);

    await button().click();
    const fromMenu = ctx.addViewerCardToLibrary(first, { kind: 'internet' });
    ok('viewer: a second click or the menu\'s "Add" does not start a second download',
      replies.length === 1 && fromMenu === first.adding);

    show(1);
    ok('viewer: the next picture\'s button is an ordinary "Add"',
      !button().classList.contains('busy') && button().disabled === false && button().textContent === 'online.add');

    show(0);
    ok('viewer: back on the picture being added, the button is still busy',
      isBusy(button()) && replies.length === 1);

    show(1);
    replies[0].resolve({ id: 'new-1' });
    await clicked;
    const id = await fromMenu;
    ok('viewer: finishing while another picture is shown says "Added to library"',
      notice() && notice().textContent === 'online.added');
    ok('viewer: the menu gets the new record from the same download',
      id === 'new-1' && first.added === true && first.adding === null && first.pooled.id === 'new-1');
    ok('viewer: the button on screen is not touched by the other picture\'s add',
      button().textContent === 'online.add' && !button().classList.contains('busy'));

    show(0);
    ok('viewer: coming back, the added picture offers to take it out again',
      button().textContent === 'online.remove' && button().classList.contains('danger')
      && button().disabled === false && button().getAttribute('aria-busy') === 'false');

    ctx.dismissViewerNotice();
    show(2);
    const onScreen = button().click();
    replies[1].resolve({ id: 'new-3' });
    await onScreen;
    ok('viewer: finishing on screen turns the button into "Remove" and needs no notice',
      third.added === true && button().textContent === 'online.remove' && notice() === null);

    show(3);
    const failing = button().click();
    replies[2].resolve({ error: 'download' });
    await failing;
    ok('viewer: a failed add names the reason and the button offers "Add" again',
      notice() && notice().textContent === CardTransfer.errorMessage(ctx.t, 'download')
      && fourth.added === false && fourth.adding === null
      && button().textContent === 'online.add' && button().disabled === false && !button().classList.contains('busy'));

    ok('viewer: the menu\'s "Add" and "Assign" go through the same tracked add',
      viewerSource.includes('add: () => addViewerCardToLibrary(entry, descriptor)')
      && viewerSource.includes('id = await addViewerCardToLibrary(entry, descriptor);'));
  }

  // ============================ the Online grid ==================================
  {
    const grid = makeElement('div');
    const replies = [];
    const toasts = [];
    const ctx = {
      t: (key) => key,
      document: { createElement: makeElement },
      $: (selector) => (selector === '#whGrid' ? grid : null),
      OnlineAdd: require('../src/online-add'),
      CardTransfer,
      config: { library: {} },
      INTERNET: { q: '' },
      toast: (message) => toasts.push(message),
      refreshPoolDependentChrome: () => {},
      removeOnlineFromLibrary: async () => true,
      window: { api: {
        internetAdd: () => { const reply = held(); replies.push(reply); return reply.promise; },
      } },
    };
    vm.createContext(ctx);
    vm.runInContext(constSource(rendererSource, 'ONLINE_ADDING'), ctx);
    for (const name of ['attachOnlineAddButton', 'addOnlineItem', 'addOnlineToLibrary',
      'addCardToLibrary', 'refreshOnlineAddedState']) {
      vm.runInContext(functionSource(rendererSource, name), ctx);
    }

    // The way buildInternetCard mounts it; a second mount is the same picture drawn again.
    const mount = (item) => {
      const card = makeElement('div');
      card.className = 'lib-card';
      grid.appendChild(card);
      return ctx.attachOnlineAddButton(card, 'internet', item, () => ctx.window.api.internetAdd(item, ctx.INTERNET.q));
    };
    const glyph = (btn) => btn.children[0];
    const isBusy = (btn) => btn.classList.contains('adding') && btn.getAttribute('aria-busy') === 'true'
      && glyph(btn).textContent === '' && btn.title === 'online.adding';
    const photo = { page: 'https://site/a', full: 'https://cdn/a.jpg' };

    const plus = mount(photo);
    const clicked = plus.click();
    ok('grid: right after the click the "+" becomes a spinner', isBusy(plus) && replies.length === 1);

    const redrawn = mount(photo);
    await redrawn.click();
    ok('grid: a card drawn again mid-download shows the spinner and ignores a click',
      isBusy(redrawn) && replies.length === 1);

    const fromMenu = ctx.addCardToLibrary({ kind: 'internet', item: photo });
    ok('grid: the menu\'s "Add" waits for the same download', replies.length === 1);

    const other = mount({ page: 'https://site/b', full: 'https://cdn/b.jpg' });
    ok('grid: another picture\'s "+" is untouched', !other.classList.contains('adding') && glyph(other).textContent === '+');

    replies[0].resolve({ id: 'x1', config: { library: { x1: { id: 'x1', type: 'image', path: 'C:/w/x1.jpg', source: photo.page } } } });
    await clicked;
    const id = await fromMenu;
    ok('grid: when it lands every copy of the card shows ✓, once, with one "Added" message',
      [plus, redrawn].every((btn) => btn.classList.contains('added') && !btn.classList.contains('adding')
        && glyph(btn).textContent === '✓' && btn.getAttribute('aria-busy') === 'false')
      && id === 'x1' && toasts.filter((m) => m === 'online.added').length === 1 && ctx.ONLINE_ADDING.size === 0);

    const failing = other.click();
    replies[1].resolve({ error: 'download' });
    await failing;
    ok('grid: a failed add names the reason and gives the "+" back',
      toasts.includes(CardTransfer.errorMessage(ctx.t, 'download'))
      && glyph(other).textContent === '+' && !other.classList.contains('adding') && other.disabled === false);
  }

  console.log(`Add progress PASS: ${passed} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
