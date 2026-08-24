'use strict';

// ONL-009. ONE context menu, drawn the same way wherever a card lives: the library
// grid, the Online grid, and the fullscreen viewer — which is a separate window with
// its own document, and the reason this is a module rather than a function inside
// renderer.js.
//
// It knows nothing about photos. It is handed a list of groups (from CardActions), a
// way to turn an action into a label, and a callback for the one that gets picked.
// Everything about WHAT the actions mean stays with the caller; everything about how a
// menu looks and behaves lives here, once.

(function initCardMenu(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CardMenu = api;
}(typeof window !== 'undefined' ? window : globalThis, function cardMenuFactory() {
  const MARGIN = 8;

  // Pure: where the menu goes, given where the user clicked, how big the menu turned
  // out and how big the window is. A context menu appears AT the pointer and is only
  // pulled back so it stays fully on screen — different from a dropdown, which aligns
  // to its control, so the two placements are deliberately not shared.
  function placeAt(wanted, size, viewport, margin = MARGIN) {
    const left = Math.max(margin, Math.min(wanted.x, viewport.width - size.width - margin));
    const top = Math.max(margin, Math.min(wanted.y, viewport.height - size.height - margin));
    return { left, top };
  }

  // Pure: which item the keyboard moves to. Menus wrap — unlike the dropdown, where
  // the platform clamps — because a context menu is short and cycling is expected.
  function nextIndex(count, current, key) {
    if (!Number.isInteger(count) || count <= 0) return -1;
    const at = Number.isInteger(current) ? current : -1;
    switch (key) {
      case 'ArrowDown': return at < 0 ? 0 : (at + 1) % count;
      case 'ArrowUp': return at < 0 ? count - 1 : (at - 1 + count) % count;
      case 'Home': return 0;
      case 'End': return count - 1;
      default: return -1;
    }
  }

  function closesMenu(key) {
    return key === 'Escape' || key === 'Esc' || key === 'Tab';
  }

  let open = null;

  function isOpen() { return !!open; }

  function close(opts = {}) {
    const state = open;
    if (!state) return;
    open = null;
    document.removeEventListener('mousedown', state.onDocDown, true);
    document.removeEventListener('scroll', state.onViewportChange, true);
    window.removeEventListener('resize', state.onViewportChange);
    window.removeEventListener('blur', state.onViewportChange);
    if (state.element && state.element.parentNode) state.element.remove();
    if (state.anchor && state.anchor.isConnected) {
      state.anchor.setAttribute('aria-expanded', 'false');
      if (opts.restoreFocus !== false) state.anchor.focus({ preventScroll: true });
    }
    if (typeof state.onClose === 'function') state.onClose();
  }

  // `groups` is an array of arrays of action objects; empty groups must already have
  // been dropped by the caller, so a separator is never drawn with nothing after it.
  function openMenu(options = {}) {
    const groups = (options.groups || []).filter((g) => Array.isArray(g) && g.length);
    if (!groups.length) return null;
    close({ restoreFocus: false });

    const doc = (options.document) || document;
    const host = options.root || doc.body;
    const labelFor = typeof options.labelFor === 'function' ? options.labelFor : (a) => a.id;

    const element = doc.createElement('div');
    element.className = 'lib-popup lib-context-menu card-menu';
    element.setAttribute('role', 'menu');
    if (options.ariaLabel) element.setAttribute('aria-label', options.ariaLabel);
    // A right-click INSIDE the menu should not open a second one behind it.
    element.addEventListener('contextmenu', (e) => e.preventDefault());

    const items = [];
    groups.forEach((group, groupIndex) => {
      if (groupIndex > 0) {
        const sep = doc.createElement('div');
        sep.className = 'lib-popup-sep';
        element.appendChild(sep);
      }
      for (const action of group) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'lib-context-item' + (action.danger ? ' danger' : '');
        button.setAttribute('role', 'menuitem');
        button.dataset.action = action.id;
        button.textContent = labelFor(action);
        // Pointing at an item MAKES it the current one, instead of merely painting a
        // second highlight next to the focused one. Without this, the menu opens with
        // the first item focused, the pointer lands on the second, and both light up
        // as one block — which is what it looked like: two rows selected at once.
        // One notion of "current", shared by the mouse and the arrow keys.
        button.addEventListener('mouseenter', () => button.focus({ preventScroll: true }));
        button.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          close({ restoreFocus: true });
          if (typeof options.onPick === 'function') options.onPick(action);
        });
        element.appendChild(button);
        items.push(button);
      }
    });

    // Measured before placing: the size is not known until it is in the document, and
    // a menu painted at 0,0 for one frame flashes in the corner.
    element.style.visibility = 'hidden';
    element.style.left = '0px';
    element.style.top = '0px';
    host.appendChild(element);

    const anchorRect = options.anchor && typeof options.anchor.getBoundingClientRect === 'function'
      ? options.anchor.getBoundingClientRect() : null;
    const wanted = options.point && Number.isFinite(options.point.x) && Number.isFinite(options.point.y)
      ? { x: options.point.x, y: options.point.y }
      : { x: (anchorRect ? anchorRect.left : 0) + 12, y: (anchorRect ? anchorRect.top : 0) + 12 };
    const spot = placeAt(wanted,
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight });
    element.style.left = `${spot.left}px`;
    element.style.top = `${spot.top}px`;
    element.style.visibility = '';

    const state = { element, anchor: options.anchor || null, onClose: options.onClose };
    state.onDocDown = (e) => { if (!element.contains(e.target)) close({ restoreFocus: false }); };
    // A menu anchored to a card that scrolls away points at nothing. Scrolling inside
    // the menu itself is the one exception.
    state.onViewportChange = (e) => {
      if (e && e.target instanceof Node && element.contains(e.target)) return;
      close({ restoreFocus: false });
    };
    document.addEventListener('mousedown', state.onDocDown, true);
    document.addEventListener('scroll', state.onViewportChange, true);
    window.addEventListener('resize', state.onViewportChange);
    window.addEventListener('blur', state.onViewportChange);

    element.addEventListener('keydown', (e) => {
      if (closesMenu(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        close({ restoreFocus: true });
        return;
      }
      const next = nextIndex(items.length, items.indexOf(doc.activeElement), e.key);
      if (next >= 0) {
        e.preventDefault();
        items[next].focus();
      }
    });

    if (state.anchor) state.anchor.setAttribute('aria-expanded', 'true');
    open = state;
    // Deliberately a timer and not requestAnimationFrame: moving focus is not a paint,
    // and rAF is throttled or suspended in a window Chromium is not drawing (an
    // occluded viewer, a minimised window). Tying the keyboard to a frame would mean
    // the menu opens but the arrow keys go nowhere.
    setTimeout(() => { if (items[0] && items[0].isConnected) items[0].focus(); }, 0);
    return state;
  }

  // Both routes to the menu, on any card: the pointer, and the keyboard (the dedicated
  // menu key, or Shift+F10). Kept here so no surface can forget the keyboard one.
  function bind(card, handler, guard = null) {
    if (!card || typeof handler !== 'function') return;
    card.setAttribute('aria-haspopup', 'menu');
    card.setAttribute('aria-expanded', 'false');
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof guard === 'function' && guard()) return;
      card.focus({ preventScroll: true });
      handler({ x: e.clientX, y: e.clientY });
    });
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof guard === 'function' && guard()) return;
      handler(null);
    });
  }

  return { placeAt, nextIndex, closesMenu, openMenu, close, isOpen, bind };
}));
