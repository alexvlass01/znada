'use strict';

// ONL-009. "Put this picture on a monitor" — the monitor × theme chooser, in one place.
//
// It used to live inside renderer.js, which is fine while only the main window offers
// it. The fullscreen viewer needs the same chooser, and the alternative was a second
// copy that would answer "which slots exist" slightly differently the first time the
// single-wallpaper or per-theme rules changed.
//
// The interesting part is not the markup, it is WHICH targets exist: with separate
// themes each monitor has a light slot and a dark slot; with one wallpaper for both it
// has a single slot. That decision is pure and tested; the DOM around it is not.

(function initAssignRows(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AssignRows = api;
}(typeof window !== 'undefined' ? window : globalThis, function assignRowsFactory() {
  // One entry per monitor, each with the slots the user may actually pick.
  // `theme` is what the assign call receives; `themeIcon` is empty for the single-slot
  // case, where there is no light/dark to illustrate.
  function rowsFor(monitors, separateThemes) {
    // No monitor list yet (it arrives asynchronously) still offers the primary slot,
    // rather than an empty menu that looks broken.
    const list = Array.isArray(monitors) && monitors.length ? monitors : [{ id: null, primary: true }];
    return list.map((monitor, index) => ({
      id: monitor && monitor.id !== undefined ? monitor.id : null,
      index,
      number: index + 1,
      primary: !!(monitor && monitor.primary),
      slots: separateThemes === false
        ? [{ theme: 'light', themeIcon: '' }]
        : [{ theme: 'light', themeIcon: 'light' }, { theme: 'dark', themeIcon: 'dark' }],
    }));
  }

  // `ctx` = { doc, t, icons, monitorLabel, slotLabel, onPick }
  // The labels are passed in because the two windows name things from the same
  // dictionary but reach it differently, and this module must not own translations.
  function build(container, monitors, separateThemes, ctx = {}) {
    const doc = ctx.doc || (typeof document !== 'undefined' ? document : null);
    if (!container || !doc) return [];
    const icons = ctx.icons || {};
    const rows = rowsFor(monitors, separateThemes);
    const stamp = ctx.idPrefix || 'assignMonitor';

    rows.forEach((row) => {
      const el = doc.createElement('div');
      el.className = 'lib-popup-row';
      el.setAttribute('role', 'group');
      const label = doc.createElement('span');
      label.className = 'lib-popup-mon';
      const monitorText = (typeof ctx.monitorLabel === 'function'
        ? ctx.monitorLabel(row) : `#${row.number}`) + (row.primary ? ' ★' : '');
      label.textContent = monitorText;
      label.id = `${stamp}-${row.index}`;
      el.setAttribute('aria-labelledby', label.id);
      el.appendChild(label);

      row.slots.forEach((slot) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = slot.themeIcon ? 'lib-popup-btn with-ic' : 'lib-popup-btn';
        // The icon is static markup we own; the label stays a text node so a monitor
        // name or a translation can never be parsed as HTML.
        if (slot.themeIcon && icons[slot.themeIcon]) {
          button.insertAdjacentHTML('afterbegin', icons[slot.themeIcon]);
        }
        const slotText = typeof ctx.slotLabel === 'function' ? ctx.slotLabel(slot, row) : slot.theme;
        button.appendChild(doc.createTextNode(slotText));
        button.setAttribute('aria-label', `${monitorText} — ${slotText}`);
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          if (typeof ctx.onPick === 'function') ctx.onPick(row.id, slot.theme);
        });
        el.appendChild(button);
      });

      container.appendChild(el);
    });
    return rows;
  }

  return { rowsFor, build };
}));
