'use strict';

// BUG-021. Windows draws the OPEN part of a native <select> itself — white sheet, blue
// highlight, system font — and no stylesheet the page writes reaches it. Everything CSS
// does allow was already in place here (`color-scheme` for dark, `select option` colours);
// the popup ignored it, and newer Chromium is stricter still. The owner's screenshot of
// the "Order" list next to Adwaita chrome is what that looks like.
//
// So the popup becomes ours and the <select> STAYS. The element remains the source of
// truth — its value, its `change` event, its <option> list (which applyI18n rewrites on
// a language switch) — so every existing handler in renderer.js keeps working untouched.
// This only stops the native popup from opening and draws the list itself.
//
// The closed control is unchanged: it is already ours, styled by `select` +
// `.select-wrap::after` in styles.css.

(function initSelectPopup(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SelectPopup = api;
}(typeof window !== 'undefined' ? window : globalThis, function selectPopupFactory() {
  const GAP = 6;          // breathing room between the control and its list
  const MARGIN = 8;       // never touch the window edge
  const MIN_ROOM = 132;   // below this much space, flipping above is worth it
  const PAGE_STEP = 10;
  const TYPEAHEAD_MS = 800;

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  // ---- pure geometry -------------------------------------------------------
  // Where the list goes, given the control, the list's natural size and the window.
  // Kept free of the DOM because this is where dropdowns actually break: clipped by
  // the bottom of the window, or hanging off the right edge.
  function placeMenu(anchor, menu, viewport, opts = {}) {
    const gap = num(opts.gap, GAP);
    const margin = num(opts.margin, MARGIN);
    const minRoom = num(opts.minRoom, MIN_ROOM);
    const roomWide = Math.max(0, viewport.width - margin * 2);
    const width = Math.min(Math.max(anchor.width, menu.width), roomWide);

    const roomTall = Math.max(0, viewport.height - margin * 2);
    const below = viewport.height - anchor.bottom - gap - margin;
    const above = anchor.top - gap - margin;
    // Flip up only when below is genuinely cramped AND above is roomier — otherwise a
    // list one pixel too tall would jump over the control for no gain.
    const flip = below < Math.min(menu.height, minRoom) && above > below;
    // Never taller than the window itself: a control scrolled off the bottom reports a
    // huge amount of "room above", and the list would then be taller than the screen.
    const maxHeight = Math.max(0, Math.min(flip ? above : below, roomTall));
    const height = Math.min(menu.height, maxHeight);
    const wanted = flip ? anchor.top - gap - height : anchor.bottom + gap;
    // With a control fully on screen this clamp changes nothing; with one scrolled out
    // of view it is what keeps the list itself visible.
    const top = Math.max(margin, Math.min(wanted, viewport.height - height - margin));
    const left = Math.max(margin, Math.min(anchor.left, viewport.width - width - margin));
    return { left, top, width, maxHeight, above: flip };
  }

  // ---- pure keyboard navigation -------------------------------------------
  // `enabled` is one boolean per option. Disabled entries are stepped over, never
  // landed on. Movement clamps at both ends rather than wrapping, which is how the
  // platform's own dropdowns behave. Returns -1 when the key is not a navigation key.
  function moveIndex(enabled, current, key) {
    const list = Array.isArray(enabled) ? enabled : [];
    const n = list.length;
    if (!n) return -1;
    const from = Number.isInteger(current) ? current : -1;

    const edge = (start, delta) => {
      for (let i = start; i >= 0 && i < n; i += delta) if (list[i]) return i;
      return -1;
    };
    const step = (start, delta, times) => {
      let at = start;
      for (let hop = 0; hop < times; hop += 1) {
        let next = -1;
        for (let i = at + delta; i >= 0 && i < n; i += delta) {
          if (list[i]) { next = i; break; }
        }
        if (next < 0) break;
        at = next;
      }
      return at;
    };

    switch (key) {
      case 'ArrowDown': return from < 0 ? edge(0, 1) : step(from, 1, 1);
      case 'ArrowUp': return from < 0 ? edge(n - 1, -1) : step(from, -1, 1);
      case 'PageDown': return from < 0 ? edge(0, 1) : step(from, 1, PAGE_STEP);
      case 'PageUp': return from < 0 ? edge(n - 1, -1) : step(from, -1, PAGE_STEP);
      case 'Home': return edge(0, 1);
      case 'End': return edge(n - 1, -1);
      default: return -1;
    }
  }

  // Whether the key belongs to the open list at all. Asked BEFORE moveIndex, because a
  // list whose every option is disabled has nowhere to move to — and an unhandled
  // ArrowDown would fall through to the <select> underneath and change its value.
  function isNavigationKey(key) {
    return key === 'ArrowDown' || key === 'ArrowUp'
      || key === 'PageDown' || key === 'PageUp'
      || key === 'Home' || key === 'End';
  }

  // Typing letters jumps through the list. A buffer of one repeated character means
  // "the NEXT option starting with that letter" (so pressing "e" repeatedly cycles);
  // a growing buffer refines from the current option instead of walking past it.
  function typeaheadIndex(labels, enabled, buffer, from) {
    const list = Array.isArray(labels) ? labels : [];
    const n = list.length;
    const query = String(buffer == null ? '' : buffer).toLowerCase();
    if (!n || !query) return -1;
    const chars = Array.from(query);
    const repeated = chars.every((c) => c === chars[0]);
    const needle = repeated ? chars[0] : query;
    const start = Number.isInteger(from) ? from : -1;
    const base = start < 0 ? 0 : (repeated ? start + 1 : start);
    for (let k = 0; k < n; k += 1) {
      const i = ((base + k) % n + n) % n;
      if (enabled && enabled[i] === false) continue;
      if (String(list[i] == null ? '' : list[i]).toLowerCase().startsWith(needle)) return i;
    }
    return -1;
  }

  // The keys that make a native <select> pop its own list open. Intercepting the click
  // alone is not enough: Alt+Down and F4 open it from the keyboard, and Space/Enter do
  // it on Windows too.
  function opensNativePopup(e) {
    if (!e) return false;
    if (e.key === 'F4') return true;
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return true;
    if (e.altKey || e.ctrlKey || e.metaKey) return false;
    return e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
  }

  // ---- DOM ----------------------------------------------------------------
  let openState = null;
  let menuSeq = 0;

  function isOpen() { return !!openState; }

  function readOptions(select) {
    return Array.from(select.options || []).map((option, index) => ({
      index,
      value: option.value,
      label: option.textContent || '',
      disabled: !!option.disabled,
      selected: index === select.selectedIndex,
    }));
  }

  function close(opts = {}) {
    const state = openState;
    if (!state) return;
    openState = null;
    document.removeEventListener('mousedown', state.onDocDown, true);
    document.removeEventListener('scroll', state.onViewportChange, true);
    window.removeEventListener('resize', state.onViewportChange);
    window.removeEventListener('blur', state.onViewportChange);
    if (state.menu && state.menu.parentNode) state.menu.remove();
    if (state.wrap) state.wrap.classList.remove('open');
    const select = state.select;
    if (select && select.isConnected) {
      select.setAttribute('aria-expanded', 'false');
      select.removeAttribute('aria-activedescendant');
      select.removeAttribute('aria-controls');
      if (opts.restoreFocus !== false) select.focus({ preventScroll: true });
    }
  }

  function commit(state, index) {
    const option = state.options[index];
    if (!option || option.disabled) return;
    const select = state.select;
    const changed = select.selectedIndex !== option.index;
    close();
    if (!changed) return;
    select.selectedIndex = option.index;
    // What every existing handler in renderer.js listens for. `input` goes first so a
    // future listener on either event sees the same value.
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setActive(state, index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.rows.length) return;
    const previous = state.rows[state.active];
    if (previous) previous.classList.remove('active');
    state.active = index;
    const row = state.rows[index];
    if (!row) return;
    row.classList.add('active');
    state.select.setAttribute('aria-activedescendant', row.id);
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }

  function open(select) {
    if (!select || select.disabled) return;
    close();
    const options = readOptions(select);
    if (!options.length) return;

    const menu = document.createElement('div');
    menuSeq += 1;
    menu.id = `selectMenu${menuSeq}`;
    menu.className = 'select-menu';
    menu.setAttribute('role', 'listbox');
    const label = select.getAttribute('aria-label') || select.id || '';
    if (label) menu.setAttribute('aria-label', label);

    const state = {
      select,
      menu,
      // The chevron lives on the wrapper's ::after; a class on the wrapper flips it.
      wrap: typeof select.closest === 'function' ? select.closest('.select-wrap') : null,
      options,
      rows: [],
      enabled: options.map((o) => !o.disabled),
      labels: options.map((o) => o.label),
      active: -1,
      buffer: '',
      bufferAt: 0,
    };

    options.forEach((option, index) => {
      const row = document.createElement('div');
      row.id = `${menu.id}-o${index}`;
      row.className = 'select-option' + (option.disabled ? ' disabled' : '') + (option.selected ? ' selected' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', option.selected ? 'true' : 'false');
      if (option.disabled) row.setAttribute('aria-disabled', 'true');
      const text = document.createElement('span');
      text.className = 'select-option-label';
      text.textContent = option.label;
      row.appendChild(text);
      // Pressing the mouse inside the list must not take focus off the <select>: it is
      // still the element the keys are read from.
      row.addEventListener('mousedown', (e) => e.preventDefault());
      if (!option.disabled) {
        row.addEventListener('mouseenter', () => setActive(state, index));
        row.addEventListener('click', () => commit(state, index));
      }
      menu.appendChild(row);
      state.rows.push(row);
    });

    // Measured off-screen first: placement needs the list's natural size, and a list
    // that painted at 0,0 for one frame would flash in the corner.
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';
    document.body.appendChild(menu);

    const anchor = select.getBoundingClientRect();
    const viewport = {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    };
    const spot = placeMenu(anchor, { width: menu.offsetWidth, height: menu.offsetHeight }, viewport);
    menu.style.left = `${spot.left}px`;
    menu.style.top = `${spot.top}px`;
    menu.style.width = `${spot.width}px`;
    menu.style.maxHeight = `${spot.maxHeight}px`;
    menu.classList.toggle('above', spot.above);
    menu.style.visibility = '';

    state.onDocDown = (e) => {
      if (menu.contains(e.target) || select.contains(e.target)) return;
      close({ restoreFocus: false });
    };
    // Any movement of the page under an anchored list leaves it pointing at nothing.
    // Scrolling INSIDE the list is the one exception.
    state.onViewportChange = (e) => {
      if (e && e.target instanceof Node && menu.contains(e.target)) return;
      close({ restoreFocus: false });
    };
    document.addEventListener('mousedown', state.onDocDown, true);
    document.addEventListener('scroll', state.onViewportChange, true);
    window.addEventListener('resize', state.onViewportChange);
    window.addEventListener('blur', state.onViewportChange);

    select.setAttribute('aria-expanded', 'true');
    select.setAttribute('aria-controls', menu.id);
    if (state.wrap) state.wrap.classList.add('open');
    openState = state;
    setActive(state, select.selectedIndex >= 0 && !options[select.selectedIndex].disabled
      ? select.selectedIndex
      : moveIndex(state.enabled, -1, 'ArrowDown'));
  }

  function onKeyDown(e) {
    const select = e.currentTarget;
    const state = openState && openState.select === select ? openState : null;

    if (!state) {
      if (opensNativePopup(e)) { e.preventDefault(); open(select); }
      return;
    }

    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') { close({ restoreFocus: false }); return; }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      commit(state, state.active);
      return;
    }
    if (isNavigationKey(e.key)) {
      e.preventDefault();
      const moved = moveIndex(state.enabled, state.active, e.key);
      if (moved >= 0) setActive(state, moved);
      return;
    }
    // While the list is open the <select> still has focus, so a bare letter would make
    // Chromium jump its value behind the list. Typing belongs to the list instead.
    if (e.key && Array.from(e.key).length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const now = Date.now();
      state.buffer = now - state.bufferAt > TYPEAHEAD_MS ? e.key : state.buffer + e.key;
      state.bufferAt = now;
      const hit = typeaheadIndex(state.labels, state.enabled, state.buffer, state.active);
      if (hit >= 0) setActive(state, hit);
    }
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    const select = e.currentTarget;
    // Chromium opens the native popup on mousedown; this is what stops it.
    e.preventDefault();
    if (openState && openState.select === select) { close(); return; }
    select.focus({ preventScroll: true });
    open(select);
  }

  function attach(select) {
    if (!select || select.__selectPopup) return;
    select.__selectPopup = true;
    select.addEventListener('mousedown', onMouseDown);
    select.addEventListener('keydown', onKeyDown);
  }

  function attachAll(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
    const list = scope.querySelectorAll('select');
    list.forEach(attach);
    return list.length;
  }

  return {
    placeMenu,
    moveIndex,
    isNavigationKey,
    typeaheadIndex,
    opensNativePopup,
    attach,
    attachAll,
    open,
    close,
    isOpen,
  };
}));
