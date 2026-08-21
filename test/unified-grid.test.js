'use strict';

const assert = require('assert');
const UnifiedGrid = require('../renderer/unified-grid');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  \u2713 ' + name);
  passed += 1;
};

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type);
    if (handlers) handlers.delete(handler);
  }

  dispatch(type) {
    for (const handler of Array.from(this.listeners.get(type) || [])) handler({ type, target: this });
  }

  listenerCount(type) {
    return (this.listeners.get(type) || new Set()).size;
  }
}

class FakeNode extends FakeEventTarget {
  constructor(tagName = 'div') {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.parentNode = null;
    this.childNodes = [];
    this.style = {};
    this.dataset = {};
    this.classList = new FakeClassList();
    this.className = '';
    this.isConnected = true;
  }

  get firstChild() { return this.childNodes[0] || null; }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    const index = siblings.indexOf(this);
    return index >= 0 ? siblings[index + 1] || null : null;
  }

  insertBefore(node, reference) {
    if (node.parentNode) {
      const previousIndex = node.parentNode.childNodes.indexOf(node);
      if (previousIndex >= 0) node.parentNode.childNodes.splice(previousIndex, 1);
    }
    const index = reference == null ? this.childNodes.length : this.childNodes.indexOf(reference);
    assert.ok(index >= 0, 'reference node belongs to its parent');
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    assert.ok(index >= 0, 'removed node belongs to its parent');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
}

class FakeScrollRoot extends FakeEventTarget {
  constructor(height = 800) {
    super();
    this.clientHeight = height;
    this._scrollTop = 0;
    this.onSetScrollTop = null;
  }

  get scrollTop() { return this._scrollTop; }

  set scrollTop(value) {
    this._scrollTop = Number(value) || 0;
    if (this.onSetScrollTop) this.onSetScrollTop(this._scrollTop);
  }

  getBoundingClientRect() { return { top: 0, height: this.clientHeight }; }
}

class FakeGrid extends FakeNode {
  constructor(scrollRoot, width = 1000) {
    super('div');
    this.scrollRoot = scrollRoot;
    this.clientWidth = width;
    this.offsetParent = {};
    this.ownerDocument = { createElement: (tag) => new FakeNode(tag) };
  }

  getBoundingClientRect() {
    return { top: -this.scrollRoot.scrollTop, width: this.clientWidth };
  }
}

class FakeResizeObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    FakeResizeObserver.instances.push(this);
  }

  observe(target) { this.observed.push(target); }
  disconnect() { this.disconnected = true; }
  fire() { this.callback(); }
}

function createFrames() {
  let nextId = 1;
  const queued = new Map();
  const cancelled = [];
  return {
    request(callback) {
      const id = nextId;
      nextId += 1;
      queued.set(id, callback);
      return id;
    },
    cancel(id) {
      cancelled.push(id);
      queued.delete(id);
    },
    flush() {
      while (queued.size) {
        const callbacks = Array.from(queued.entries());
        queued.clear();
        for (const [, callback] of callbacks) callback();
      }
    },
    queued,
    cancelled,
  };
}

function fixture(entries, options = {}) {
  const scrollRoot = new FakeScrollRoot(options.height || 800);
  const grid = new FakeGrid(scrollRoot, options.width || 1000);
  const windowTarget = new FakeEventTarget();
  const frames = createFrames();
  const built = [];
  const dropped = [];
  const state = UnifiedGrid.create({
    grid,
    scrollRoot,
    windowTarget,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame: (callback) => frames.request(callback),
    cancelAnimationFrame: (id) => frames.cancel(id),
    entries,
    overscanPx: options.overscanPx == null ? 0 : options.overscanPx,
    getKey: (entry) => entry.id,
    getVersion: options.getVersion,
    getAspect: (entry) => entry.aspect,
    buildCard(entry) {
      const card = new FakeNode('article');
      card.entryId = entry.id;
      built.push(card);
      return card;
    },
    bindCard: options.bindCard,
    dropCard(card) { dropped.push(card); },
    captureAnchor: options.captureAnchor,
    onDestroy: options.onDestroy,
  });
  frames.flush();
  return { state, grid, scrollRoot, windowTarget, frames, built, dropped };
}

function items(count, aspect = 1.6) {
  return Array.from({ length: count }, (_, index) => ({ id: `item-${index}`, aspect }));
}

// Keyed mutations must preserve card identity; the data source can append, reorder,
// patch or remove without throwing away every thumbnail node.
{
  const data = items(12);
  const env = fixture(data, { height: 2400, width: 900 });
  const card2 = env.state.cardForKey('item-2');
  const card7 = env.state.cardForKey('item-7');
  ok('initial small collection materializes its cards', card2 && card7 && env.state.cards.size === data.length);

  const reordered = [data[7], data[0], data[1], data[2], ...data.slice(3, 7), ...data.slice(8)];
  env.state.replace(reordered);
  ok('replace reuses nodes by stable key across a reorder',
    env.state.cardForKey('item-2') === card2 && env.state.cardForKey('item-7') === card7);
  ok('reused nodes receive their new virtual indices',
    card7.dataset.virtualIndex === '0' && card2.dataset.virtualIndex === '3');

  env.state.append([{ id: 'item-12', aspect: 1.2 }]);
  ok('append preserves existing card identity and adds the new key',
    env.state.cardForKey('item-2') === card2 && env.state.cardForKey('item-12'));

  const removedCard = env.state.cardForKey('item-7');
  ok('remove reports an existing key', env.state.remove('item-7') === true);
  ok('remove drops only the removed keyed node',
    env.state.cardForKey('item-7') === null
      && env.state.cardForKey('item-2') === card2
      && env.dropped.includes(removedCard));
  env.state.destroy();
}

// Any non-structural presentation state is intentionally not part of a card key or
// version. A reused virtual card must receive fresh UI state through bindCard; the
// card-interaction tests separately own the real selection model behavior.
{
  const before = { id: 'same-image', kind: 'pool-image', aspect: 1.6, selected: false };
  const after = { ...before, selected: true };
  const env = fixture([before], {
    height: 800,
    getVersion: (entry) => entry.kind,
    bindCard: (card, entry) => { card.selected = entry.selected; },
  });
  const card = env.state.cardForKey(before.id);
  env.state.replace([after]);
  ok('a stable keyed card is reused when only bound presentation state changes',
    env.state.cardForKey(after.id) === card);
  ok('bindCard refreshes non-structural state on the reused node', card.selected === true);
  env.state.destroy();
}

// A stable path key keeps the logical position across materialization, while a
// structural version change rebuilds the card so its controls and event handlers
// switch from ephemeral-image to pool-image semantics.
{
  const before = { id: 'same-path', kind: 'ephemeral-image', aspect: 1.6 };
  const after = { id: 'same-path', kind: 'pool-image', aspect: 1.6 };
  const env = fixture([before], { height: 800, getVersion: (entry) => entry.kind });
  const ephemeralCard = env.state.cardForKey('same-path');
  env.state.replace([after]);
  ok('a structural version change rebuilds a stable keyed card',
    env.state.cardForKey('same-path') !== ephemeralCard);
  ok('version invalidation drops the obsolete card exactly once', env.dropped.includes(ephemeralCard));
  env.state.destroy();
}

// Folder contents can change while their stable path and semantic kind stay the
// same. A caller-owned epoch must still be able to invalidate the visible collage.
{
  let folderEpoch = 0;
  const folder = { id: 'same-folder', kind: 'pool-folder', aspect: 1.6 };
  const env = fixture([folder], {
    height: 800,
    getVersion: (entry) => `${entry.kind}:${folderEpoch}`,
  });
  const oldCollage = env.state.cardForKey('same-folder');
  folderEpoch += 1;
  env.state.replace([folder]);
  ok('a caller epoch rebuilds a same-key same-kind folder card',
    env.state.cardForKey('same-folder') !== oldCollage);
  ok('folder epoch invalidation drops the stale collage', env.dropped.includes(oldCollage));
  env.state.destroy();
}

// A large source must keep only the viewport window in the DOM, including after a
// deep scroll. The spacers retain the full scroll extent without thousands of nodes.
{
  const env = fixture(items(5000), { height: 720, width: 1000, overscanPx: 300 });
  ok('five thousand entries keep a bounded initial card window',
    env.state.cards.size > 0 && env.state.cards.size < 100 && env.grid.childNodes.length < 105);
  ok('a large virtual grid exposes a bottom spacer at the top',
    env.grid.childNodes.some((node) => node === env.state.bottomPad));

  env.scrollRoot.scrollTop = env.state.totalHeight * 0.55;
  env.scrollRoot.dispatch('scroll');
  env.frames.flush();
  ok('deep scrolling still keeps the materialized window bounded',
    env.state.cards.size > 0 && env.state.cards.size < 100 && env.grid.childNodes.length < 105);
  ok('deep scrolling replaces top cards with cards near the requested viewport',
    Math.min(...env.state.cards.keys()) > 1000 && env.state.topPad && env.state.bottomPad);
  env.state.destroy();
}

// Learned image geometry updates row layout in place and does not rebuild the card.
{
  const env = fixture(items(30, 1), { height: 1400, width: 900 });
  const card = env.state.cardForKey('item-0');
  const oldWidth = env.state.boxes[0].width;
  ok('setAspect accepts a stable key', env.state.setAspect('item-0', 3) === true);
  ok('setAspect relayout changes the learned card geometry', env.state.boxes[0].width > oldWidth);
  ok('setAspect keeps the existing thumbnail node', env.state.cardForKey('item-0') === card);
  ok('setAspect rejects invalid geometry', env.state.setAspect('item-0', 0) === false);
  env.state.destroy();
}

// During a deep shrink, the anchored range must be materialized before scrollTop is
// moved to its new (usually much larger) value. That ordering prevents the huge
// transient DOM bridge which caused the original shrink flashing.
{
  const env = fixture(items(5000), { height: 720, width: 1400, overscanPx: 300 });
  const anchorKey = 'item-2600';
  let anchorWasMaterializedAtScrollAssignment = false;
  env.scrollRoot.onSetScrollTop = () => {
    const card = env.state.cardForKey(anchorKey);
    anchorWasMaterializedAtScrollAssignment = Boolean(card && card.parentNode === env.grid);
  };
  env.grid.clientWidth = 620;
  const didSynchronousShrink = env.state.handleViewportResize({
    root: env.scrollRoot,
    key: anchorKey,
    combinedIndex: 2600,
    top: 80,
  });
  ok('width shrink takes the synchronous anchor-aware relayout path', didSynchronousShrink === true);
  ok('deep anchor is materialized before assigning the restored scrollTop',
    anchorWasMaterializedAtScrollAssignment);
  ok('anchored deep shrink remains bounded', env.state.cards.size > 0 && env.state.cards.size < 100);
  env.state.destroy();
}

// destroy() owns the complete observer/listener/frame lifecycle so switching views
// cannot leave an inactive grid reacting to scroll or resize.
{
  let destroyed = 0;
  const observerStart = FakeResizeObserver.instances.length;
  const env = fixture(items(20), { onDestroy: () => { destroyed += 1; } });
  const observer = FakeResizeObserver.instances[observerStart];
  ok('grid lifecycle installs all shared input listeners',
    env.scrollRoot.listenerCount('scroll') === 1
      && env.scrollRoot.listenerCount('wheel') === 1
      && env.scrollRoot.listenerCount('pointerdown') === 1
      && env.scrollRoot.listenerCount('touchstart') === 1
      && env.scrollRoot.listenerCount('keydown') === 1
      && env.windowTarget.listenerCount('resize') === 1
      && observer.observed[0] === env.grid);

  env.scrollRoot.dispatch('scroll');
  ok('scroll work is queued before destruction', env.frames.queued.size === 1);
  env.state.destroy();
  ok('destroy removes listeners and disconnects the resize observer',
    env.scrollRoot.listenerCount('scroll') === 0
      && env.scrollRoot.listenerCount('wheel') === 0
      && env.scrollRoot.listenerCount('pointerdown') === 0
      && env.scrollRoot.listenerCount('touchstart') === 0
      && env.scrollRoot.listenerCount('keydown') === 0
      && env.windowTarget.listenerCount('resize') === 0
      && observer.disconnected);
  ok('destroy clears pending frames and detaches the controller marker',
    env.frames.queued.size === 0
      && env.frames.cancelled.length >= 1
      && env.grid.__virtual === null
      && !env.grid.classList.contains('is-virtualized'));
  env.state.destroy();
  ok('destroy is idempotent and calls its hook once', destroyed === 1);
}

console.log('\nAll ' + passed + ' unified-grid tests passed.');
