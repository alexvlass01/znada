'use strict';

// One justified/virtual lifecycle for every wallpaper grid. Data fetching and card
// actions stay in renderer.js; this module owns row geometry, viewport materialization,
// keyed DOM reuse, resize observation and cleanup. Small collections naturally fit
// inside one virtual window, so they use the same path without a separate eager mode.
(function expose(root, factory) {
  let api;
  if (typeof module === 'object' && module.exports) {
    api = factory(
      require('./justified-layout'),
      require('./virtual-window'),
      require('./virtual-grid-dom')
    );
    module.exports = api;
  } else {
    api = factory(root && root.JustifiedLayout, root && root.VirtualWindow, root && root.VirtualGridDom);
  }
  if (root) root.UnifiedGrid = api;
})(typeof window !== 'undefined' ? window : null, function createApi(JustifiedLayout, VirtualWindow, VirtualGridDom) {
  const DEFAULTS = Object.freeze({
    gap: 10,
    minAspect: 0.65,
    maxAspect: 3,
    overscanPx: 1600,
  });

  function create(options = {}) {
    const grid = options.grid;
    const scrollRoot = options.scrollRoot;
    if (!grid || !scrollRoot) throw new Error('UnifiedGrid requires grid and scrollRoot');
    if (!JustifiedLayout || !VirtualWindow || !VirtualGridDom) {
      throw new Error('UnifiedGrid dependencies are unavailable');
    }
    if (grid.__virtual && typeof grid.__virtual.destroy === 'function') grid.__virtual.destroy();

    const gap = Math.max(0, Number.isFinite(Number(options.gap)) ? Number(options.gap) : DEFAULTS.gap);
    const minAspect = Math.max(0.01, Number(options.minAspect) || DEFAULTS.minAspect);
    const maxAspect = Math.max(minAspect, Number(options.maxAspect) || DEFAULTS.maxAspect);
    const overscanPx = Math.max(0, Number.isFinite(Number(options.overscanPx))
      ? Number(options.overscanPx) : DEFAULTS.overscanPx);
    const requestFrame = options.requestAnimationFrame
      || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis) : (fn) => setTimeout(fn, 0));
    const cancelFrame = options.cancelAnimationFrame
      || (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame.bind(globalThis) : clearTimeout);
    const resizeObserverClass = options.ResizeObserver
      || (typeof ResizeObserver === 'function' ? ResizeObserver : null);
    const windowTarget = options.windowTarget
      || (typeof window !== 'undefined' ? window : null);

    let destroyed = false;
    let scrollFrame = 0;
    let widthFrame = 0;
    let widthObserver = null;

    const state = {
      grid,
      scrollRoot,
      entries: [],
      keys: [],
      baseKeys: [],
      versions: [],
      rows: [],
      boxes: [],
      totalHeight: 0,
      layoutWidth: 0,
      first: 0,
      last: -1,
      cards: new Map(),
      overrides: new Map(),
      topPad: null,
      bottomPad: null,
      relayout,
      updateWindow,
      replace,
      append,
      remove,
      patch,
      setAspect,
      cardForKey,
      indexForKey,
      handleViewportResize,
      destroy,
    };

    function isValid() {
      if (destroyed || grid.__virtual !== state || grid.isConnected === false) return false;
      return typeof options.isValid !== 'function' || options.isValid();
    }

    function rawKey(entry, index) {
      const key = typeof options.getKey === 'function' ? options.getKey(entry, index) : index;
      return String(key == null || key === '' ? `index:${index}` : key);
    }

    function deriveKeys(entries) {
      const seen = new Map();
      const baseKeys = entries.map((entry, index) => rawKey(entry, index));
      const versions = entries.map((entry, index) => String(
        typeof options.getVersion === 'function' ? options.getVersion(entry, index) : ''
      ));
      const keys = baseKeys.map((base) => {
        const occurrence = seen.get(base) || 0;
        seen.set(base, occurrence + 1);
        return occurrence ? `${base}\u0000${occurrence}` : base;
      });
      return { keys, baseKeys, versions };
    }

    function aspectAt(index) {
      const override = Number(state.overrides.get(index));
      if (Number.isFinite(override) && override > 0) return override;
      const entry = state.entries[index];
      const value = typeof options.getAspect === 'function' ? options.getAspect(entry, index) : entry && entry.aspect;
      const aspect = Number(value);
      return Number.isFinite(aspect) && aspect > 0 ? aspect : 1.6;
    }

    function buildCardAt(index) {
      const entry = state.entries[index];
      const card = options.buildCard(entry, index);
      if (!card) throw new Error(`UnifiedGrid buildCard returned no card for index ${index}`);
      bindCard(card, entry, index);
      return card;
    }

    function bindCard(card, entry, index) {
      if (!card.dataset) card.dataset = {};
      card.dataset.virtualIndex = String(index);
      card.dataset.gridKey = state.baseKeys[index] || '';
      if (typeof options.bindCard === 'function') options.bindCard(card, entry, index);
    }

    function ensurePad(which) {
      const key = which === 'top' ? 'topPad' : 'bottomPad';
      if (!state[key]) {
        const doc = grid.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (!doc || typeof doc.createElement !== 'function') throw new Error('UnifiedGrid cannot create spacer');
        const pad = doc.createElement('div');
        pad.className = 'lib-vpad';
        state[key] = pad;
      }
      return state[key];
    }

    function dropCard(index, card) {
      if (typeof options.dropCard === 'function') options.dropCard(card, state.entries[index], index);
      if (card && typeof card.remove === 'function') card.remove();
      state.cards.delete(index);
    }

    function applyWindow(first, last) {
      const range = VirtualWindow.cardRangeForRows(state.rows, first, last);
      const priority = typeof options.nextPriority === 'function' ? options.nextPriority() : null;
      let added = 0;
      let dropped = 0;

      for (const [index, card] of Array.from(state.cards)) {
        if (index < range.first || index > range.last) {
          dropCard(index, card);
          dropped += 1;
        }
      }
      for (let index = range.first; index <= range.last; index += 1) {
        if (!state.cards.has(index)) {
          state.cards.set(index, buildCardAt(index));
          added += 1;
        }
      }

      const pads = VirtualWindow.padHeights(state.rows, first, last, gap, state.totalHeight);
      const desiredChildren = [];
      if (pads.top > 0) {
        const pad = ensurePad('top');
        const height = `${pads.top.toFixed(2)}px`;
        if (pad.style.height !== height) pad.style.height = height;
        desiredChildren.push(pad);
      }
      for (let index = range.first; index <= range.last; index += 1) {
        const card = state.cards.get(index);
        bindCard(card, state.entries[index], index);
        if (priority != null) card.dataset.thumbPriority = String(priority);
        const box = state.boxes[index];
        if (box) {
          const width = `${box.width.toFixed(2)}px`;
          const height = `${box.height.toFixed(2)}px`;
          if (card.style.width !== width) card.style.width = width;
          if (card.style.height !== height) card.style.height = height;
        }
        desiredChildren.push(card);
      }
      if (pads.bottom > 0) {
        const pad = ensurePad('bottom');
        const height = `${pads.bottom.toFixed(2)}px`;
        if (pad.style.height !== height) pad.style.height = height;
        desiredChildren.push(pad);
      }

      const dom = VirtualGridDom.reconcileChildren(grid, desiredChildren);
      state.first = first;
      state.last = last;
      if (typeof options.onWindow === 'function') {
        options.onWindow({
          added,
          dropped,
          active: state.cards.size,
          inserted: dom.inserted,
          moved: dom.moved,
          removed: dom.removed,
        });
      }
      return dom;
    }

    function currentRange() {
      if (!state.rows.length) return { first: 0, last: -1 };
      const rootRect = scrollRoot.getBoundingClientRect();
      const gridTop = grid.getBoundingClientRect().top - rootRect.top + scrollRoot.scrollTop;
      const viewTop = scrollRoot.scrollTop - gridTop - overscanPx;
      const viewBottom = scrollRoot.scrollTop - gridTop + scrollRoot.clientHeight + overscanPx;
      let range = VirtualWindow.rowRangeForViewport(state.rows, viewTop, viewBottom);
      if (typeof options.keepMaterialized === 'function' && options.keepMaterialized()
        && state.cards.size && typeof VirtualWindow.expandRowRangeForCards === 'function') {
        const active = Array.from(state.cards.keys());
        range = VirtualWindow.expandRowRangeForCards(
          state.rows,
          range,
          Math.min(...active),
          Math.max(...active)
        );
      }
      return range;
    }

    function updateWindow(afterLayout = false) {
      if (!isValid() || grid.offsetParent === null || !state.rows.length) return;
      const range = currentRange();
      if (!afterLayout && range.first === state.first && range.last === state.last) return;
      applyWindow(range.first, range.last);
    }

    function normalizedAnchor(anchor) {
      if (!anchor || anchor.root !== scrollRoot) return null;
      let index = Number.isInteger(anchor.combinedIndex) ? anchor.combinedIndex : -1;
      if (anchor.key) {
        const keyed = state.baseKeys.indexOf(String(anchor.key));
        if (keyed >= 0) index = keyed;
      }
      return index >= 0 && index < state.entries.length ? { ...anchor, combinedIndex: index } : null;
    }

    function relayout(opts = {}) {
      if (!isValid()) return { anchorRestored: false };
      const width = grid.clientWidth;
      if (width < 40) return { anchorRestored: false };
      state.layoutWidth = width;
      const aspects = state.entries.map((entry, index) => aspectAt(index));
      const targetHeight = typeof options.targetHeight === 'function'
        ? options.targetHeight(width)
        : VirtualWindow.responsiveTargetHeight(width);
      const result = JustifiedLayout.layoutRows(aspects, width, { gap, targetHeight, minAspect, maxAspect });
      state.rows = result.rows;
      state.boxes = result.boxes;
      state.totalHeight = result.totalHeight;

      if (!result.rows.length) {
        for (const [index, card] of Array.from(state.cards)) dropCard(index, card);
        VirtualGridDom.reconcileChildren(grid, []);
        state.first = 0;
        state.last = -1;
        return { anchorRestored: false };
      }

      const anchor = normalizedAnchor(opts.anchor);
      if (anchor && typeof VirtualWindow.windowForCardAnchor === 'function') {
        const rootRect = scrollRoot.getBoundingClientRect();
        const gridTop = grid.getBoundingClientRect().top - rootRect.top + scrollRoot.scrollTop;
        const plan = VirtualWindow.windowForCardAnchor(
          result.rows,
          anchor.combinedIndex,
          gridTop,
          anchor.top,
          scrollRoot.clientHeight,
          overscanPx
        );
        if (plan) {
          let range = { first: plan.first, last: plan.last };
          if (typeof options.keepMaterialized === 'function' && options.keepMaterialized()
            && state.cards.size && typeof VirtualWindow.expandRowRangeForCards === 'function') {
            const active = Array.from(state.cards.keys());
            range = VirtualWindow.expandRowRangeForCards(
              result.rows,
              range,
              Math.min(...active),
              Math.max(...active)
            );
          }
          applyWindow(range.first, range.last);
          scrollRoot.scrollTop = plan.scrollTop;
          if (typeof options.onScrollTop === 'function') options.onScrollTop(scrollRoot.scrollTop);
          if (Math.abs(scrollRoot.scrollTop - plan.scrollTop) >= 0.5) updateWindow(true);
          return { anchorRestored: true };
        }
      }
      updateWindow(true);
      return { anchorRestored: false };
    }

    function remapEntries(nextEntries) {
      const next = Array.isArray(nextEntries) ? nextEntries.slice() : [];
      const derived = deriveKeys(next);
      const oldCardsByKey = new Map();
      for (const [index, card] of state.cards) {
        oldCardsByKey.set(state.keys[index], { index, card, version: state.versions[index] });
      }
      const oldOverridesByKey = new Map();
      for (const [index, aspect] of state.overrides) oldOverridesByKey.set(state.keys[index], aspect);

      const nextCards = new Map();
      const reused = new Set();
      derived.keys.forEach((key, index) => {
        const hit = oldCardsByKey.get(key);
        if (!hit || hit.version !== derived.versions[index]) return;
        nextCards.set(index, hit.card);
        reused.add(hit.index);
      });
      for (const [index, card] of Array.from(state.cards)) {
        if (!reused.has(index)) {
          if (typeof options.dropCard === 'function') options.dropCard(card, state.entries[index], index);
          if (card && typeof card.remove === 'function') card.remove();
        }
      }

      state.entries = next;
      state.keys = derived.keys;
      state.baseKeys = derived.baseKeys;
      state.versions = derived.versions;
      state.cards.clear();
      for (const [index, card] of nextCards) state.cards.set(index, card);
      state.overrides.clear();
      derived.keys.forEach((key, index) => {
        const aspect = oldOverridesByKey.get(key);
        if (Number.isFinite(aspect) && aspect > 0) state.overrides.set(index, aspect);
      });
      for (const [index, card] of state.cards) bindCard(card, state.entries[index], index);
    }

    function replace(entries, opts = {}) {
      if (destroyed) return state;
      const anchor = opts.anchor || (opts.preserveAnchor && typeof options.captureAnchor === 'function'
        ? options.captureAnchor(grid) : null);
      // Capture before keyed reconciliation: the item being removed may be the
      // current visual anchor, and detaching it first would lose its viewport Y.
      remapEntries(entries);
      relayout({ anchor });
      return state;
    }

    function append(entries, opts = {}) {
      const extra = Array.isArray(entries) ? entries : [];
      if (!extra.length) return state;
      return replace(state.entries.concat(extra), opts);
    }

    function indexForKey(key) {
      return state.baseKeys.indexOf(String(key));
    }

    function cardForKey(key) {
      const index = indexForKey(key);
      return index >= 0 ? state.cards.get(index) || null : null;
    }

    function remove(key, opts = {}) {
      const index = indexForKey(key);
      if (index < 0) return false;
      const next = state.entries.slice();
      next.splice(index, 1);
      replace(next, { ...opts, preserveAnchor: opts.preserveAnchor !== false });
      return true;
    }

    function patch(key, entry, opts = {}) {
      const index = indexForKey(key);
      if (index < 0) return false;
      const next = state.entries.slice();
      next[index] = entry;
      replace(next, { ...opts, preserveAnchor: opts.preserveAnchor !== false });
      return true;
    }

    function setAspect(keyOrIndex, aspect, opts = {}) {
      const index = Number.isInteger(keyOrIndex) ? keyOrIndex : indexForKey(keyOrIndex);
      const safe = Number(aspect);
      if (index < 0 || index >= state.entries.length || !Number.isFinite(safe) || safe <= 0) return false;
      state.overrides.set(index, safe);
      if (opts.relayout !== false) {
        const anchor = opts.anchor || (typeof options.captureAnchor === 'function'
          ? options.captureAnchor(grid) : null);
        relayout({ anchor });
      }
      return true;
    }

    function handleViewportResize(anchor) {
      if (!isValid()) return false;
      const shrinking = state.layoutWidth > 0 && grid.clientWidth < state.layoutWidth - 0.5;
      if (shrinking) relayout({ anchor: anchor || null });
      else updateWindow(false);
      return shrinking;
    }

    function onScroll() {
      if (scrollFrame || !isValid()) return;
      scrollFrame = requestFrame(() => {
        scrollFrame = 0;
        updateWindow(false);
        if (typeof options.onScroll === 'function') options.onScroll(state);
      });
    }

    function onUserInput() {
      if (typeof options.onUserInput === 'function') options.onUserInput(state);
    }

    function onObservedWidth() {
      if (!isValid() || Math.abs(grid.clientWidth - state.layoutWidth) < 0.5 || widthFrame) return;
      widthFrame = requestFrame(() => {
        widthFrame = 0;
        if (!isValid() || Math.abs(grid.clientWidth - state.layoutWidth) < 0.5) return;
        if (typeof options.onWidthChange === 'function') options.onWidthChange(state);
        else relayout({ anchor: typeof options.captureAnchor === 'function' ? options.captureAnchor(grid) : null });
      });
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      const ownsGrid = grid.__virtual === state;
      scrollRoot.removeEventListener('scroll', onScroll);
      scrollRoot.removeEventListener('wheel', onUserInput);
      scrollRoot.removeEventListener('pointerdown', onUserInput);
      scrollRoot.removeEventListener('touchstart', onUserInput);
      scrollRoot.removeEventListener('keydown', onUserInput);
      if (windowTarget && typeof windowTarget.removeEventListener === 'function') {
        windowTarget.removeEventListener('resize', onObservedWidth);
      }
      if (scrollFrame) cancelFrame(scrollFrame);
      if (widthFrame) cancelFrame(widthFrame);
      if (widthObserver) widthObserver.disconnect();
      scrollFrame = 0;
      widthFrame = 0;
      widthObserver = null;
      if (ownsGrid) {
        for (const [index, card] of Array.from(state.cards)) dropCard(index, card);
        VirtualGridDom.reconcileChildren(grid, []);
        state.topPad = null;
        state.bottomPad = null;
        grid.__virtual = null;
        grid.classList.remove('is-virtualized');
      }
      if (typeof options.onDestroy === 'function') options.onDestroy(state);
    }

    grid.__virtual = state;
    grid.classList.add('is-virtualized');
    remapEntries(options.entries || []);
    scrollRoot.addEventListener('scroll', onScroll, { passive: true });
    scrollRoot.addEventListener('wheel', onUserInput, { passive: true });
    scrollRoot.addEventListener('pointerdown', onUserInput, { passive: true });
    scrollRoot.addEventListener('touchstart', onUserInput, { passive: true });
    scrollRoot.addEventListener('keydown', onUserInput);
    if (windowTarget && typeof windowTarget.addEventListener === 'function') {
      windowTarget.addEventListener('resize', onObservedWidth);
    }
    if (resizeObserverClass) {
      widthObserver = new resizeObserverClass(onObservedWidth);
      widthObserver.observe(grid);
    }
    relayout({ anchor: options.anchor || null });
    widthFrame = requestFrame(() => {
      widthFrame = 0;
      if (!isValid() || Math.abs(grid.clientWidth - state.layoutWidth) < 0.5) return;
      if (typeof options.onWidthChange === 'function') options.onWidthChange(state);
      else relayout({ anchor: typeof options.captureAnchor === 'function' ? options.captureAnchor(grid) : null });
    });
    return state;
  }

  return { create, DEFAULTS };
});
