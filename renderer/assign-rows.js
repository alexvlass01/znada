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
  // BUG-037. What is ALREADY in a slot. The chooser used to be built from the monitor
  // list alone, so an empty spot and a spot holding five photos drew the identical
  // button — and pressing one does not replace what is there, it adds alongside. People
  // pressed without knowing whether they were setting a wallpaper or extending a
  // slideshow, and nothing said which had happened afterwards either.
  //
  // `occupancy` is { slots: { [monitorId]: { light: [ids], dark: [ids] } }, itemId }.
  // Ids rather than counts, because the same answer has to serve both questions: how
  // many are in there, and is THIS picture one of them.
  function slotState(occupancy, monitorId, theme) {
    const source = occupancy && typeof occupancy === 'object' ? occupancy : {};
    const slots = source.slots && typeof source.slots === 'object' ? source.slots : {};
    const entry = slots[monitorId == null ? '' : monitorId];
    const ids = entry && Array.isArray(entry[theme]) ? entry[theme] : [];
    const itemId = str(source.itemId);
    return { count: ids.length, hasThis: !!itemId && ids.indexOf(itemId) !== -1 };
  }

  function str(value) {
    return typeof value === 'string' ? value : '';
  }

  // BUG-037. WHAT to say once the button has been pressed. The window used to say
  // "Assigned" to all four of these, including the one where it had done nothing at all,
  // and including the one where it had quietly turned a wallpaper into a slideshow.
  //
  //   set it now was ticked  → the picture is on the desktop, say so and stop
  //   it was already there   → nothing changed, and pretending otherwise is the lie
  //   the slot now holds >1  → it was ADDED, so name the number
  //   otherwise              → the plain first assignment
  function outcomeKey({ appliedNow = false, alreadyThere = false, countAfter = 0 } = {}) {
    if (appliedNow) return { key: 'toast.applied', params: null };
    if (alreadyThere) return { key: 'library.assignedAlready', params: null };
    const n = Number(countAfter);
    if (Number.isFinite(n) && n > 1) return { key: 'library.assignedAdded', params: { n } };
    return { key: 'library.assignedToast', params: null };
  }

  // One entry per monitor, each with the slots the user may actually pick.
  // `theme` is what the assign call receives; `themeIcon` is empty for the single-slot
  // case, where there is no light/dark to illustrate.
  function rowsFor(monitors, separateThemes, occupancy = null) {
    // No monitor list yet (it arrives asynchronously) still offers the primary slot,
    // rather than an empty menu that looks broken.
    const list = Array.isArray(monitors) && monitors.length ? monitors : [{ id: null, primary: true }];
    return list.map((monitor, index) => {
      const id = monitor && monitor.id !== undefined ? monitor.id : null;
      const themes = separateThemes === false
        ? [{ theme: 'light', themeIcon: '' }]
        : [{ theme: 'light', themeIcon: 'light' }, { theme: 'dark', themeIcon: 'dark' }];
      return {
        id,
        index,
        number: index + 1,
        primary: !!(monitor && monitor.primary),
        // With one wallpaper for both themes the single slot IS the light one, so it
        // reports the light slot's contents rather than nothing.
        slots: themes.map((slot) => ({ ...slot, ...slotState(occupancy, id, slot.theme) })),
      };
    });
  }

  // `ctx` = { doc, t, icons, monitorLabel, slotLabel, onPick }
  // The labels are passed in because the two windows name things from the same
  // dictionary but reach it differently, and this module must not own translations.
  function build(container, monitors, separateThemes, ctx = {}) {
    const doc = ctx.doc || (typeof document !== 'undefined' ? document : null);
    if (!container || !doc) return [];
    const icons = ctx.icons || {};
    const rows = rowsFor(monitors, separateThemes, ctx.occupancy);
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
        button.className = 'lib-popup-btn'
          + (slot.themeIcon ? ' with-ic' : '')
          + (slot.hasThis ? ' is-here' : '');
        // The icon is static markup we own; the label stays a text node so a monitor
        // name or a translation can never be parsed as HTML.
        if (slot.themeIcon && icons[slot.themeIcon]) {
          button.insertAdjacentHTML('afterbegin', icons[slot.themeIcon]);
        }
        const slotText = typeof ctx.slotLabel === 'function' ? ctx.slotLabel(slot, row) : slot.theme;
        button.appendChild(doc.createTextNode(slotText));
        // BUG-037. The number is the whole point: it is what tells the difference
        // between "this will be the wallpaper" and "this will be the third picture in a
        // rotation". An empty slot shows nothing rather than a nought, which would read
        // as a broken counter.
        if (slot.count > 0) {
          const badge = doc.createElement('span');
          badge.className = 'lib-popup-count';
          badge.textContent = String(slot.count);
          button.appendChild(badge);
        }
        // Words for the same fact, for a screen reader and for the tooltip. The visual
        // difference alone (an outline) says "something is special here" without saying
        // what, and the count alone does not say that THIS photo is one of them.
        const hint = typeof ctx.slotHint === 'function' ? ctx.slotHint(slot, row) : '';
        button.setAttribute('aria-label', hint ? `${monitorText} — ${slotText}, ${hint}` : `${monitorText} — ${slotText}`);
        if (hint) button.title = hint;
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

  return { rowsFor, slotState, outcomeKey, build };
}));
