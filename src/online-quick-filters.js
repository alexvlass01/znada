'use strict';

// DESIGN-002. Which EXISTING online filters sit as quick buttons under the search, and
// how many of them fit the row. Chosen by the owner on 2026-09-23: "fits my screen",
// content purity and sources, each of which the user may pin or unpin; every setting
// stays reachable in the one "Filters" menu whatever is pinned. No new filter lives
// here: this only names, orders and measures controls that already exist.
//
// Pure and shared, so config normalization, the set-config boundary and the window read
// one spelling of "a pin" and cannot drift apart.
(function initOnlineQuickFilters(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OnlineQuickFilters = api;
}(typeof window !== 'undefined' ? window : globalThis, function onlineQuickFiltersFactory() {
  // Row order is fixed. A user choosing WHICH buttons show is the setting; letting the
  // order vary too would make the same button wander between windows.
  const KEYS = Object.freeze(['screen', 'purity', 'sources']);
  const PURITY = Object.freeze([['sfw', 'SFW'], ['sketchy', 'Sketchy'], ['nsfw', 'NSFW']]);

  // A stored value that is not a list at all is a missing setting: everything pinned.
  // An empty list is a real choice — only the "Filters" menu — and stays empty.
  function normalizePins(value) {
    if (!Array.isArray(value)) return KEYS.slice();
    const chosen = new Set(value.filter((key) => typeof key === 'string'));
    return KEYS.filter((key) => chosen.has(key));
  }

  // The set-config boundary refuses rather than repairs: a window sending an unknown or
  // repeated key has a bug, and silently dropping it would hide that.
  function isValidPins(value) {
    if (!Array.isArray(value)) return false;
    const seen = new Set();
    for (const key of value) {
      if (typeof key !== 'string' || !KEYS.includes(key) || seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  }

  // How many buttons, taken in order, fit the width. Later ones leave the row as a group
  // instead of a middle one vanishing, so the row reads the same at every width.
  function fitCount(widths, available, gap) {
    const room = Number(available) || 0;
    const space = Number(gap) || 0;
    let used = 0;
    let count = 0;
    for (const raw of Array.isArray(widths) ? widths : []) {
      const width = Math.max(0, Number(raw) || 0);
      const next = used + (count ? space : 0) + width;
      // Half a pixel of slack: layout widths are fractional and a button that fits
      // exactly must not be pushed out by rounding.
      if (next > room + 0.5) break;
      used = next;
      count += 1;
    }
    return count;
  }

  function purityLabel(purity) {
    const value = purity && typeof purity === 'object' ? purity : {};
    const names = PURITY.filter(([key]) => value[key] === true).map(([, name]) => name);
    return names.length ? names.join(' · ') : 'SFW';
  }

  // Which quick filters differ from what a fresh install shows. That is what makes a
  // button look pressed, and what the "Filters" count reports for buttons out of sight.
  function activeKeys(state) {
    const value = state && typeof state === 'object' ? state : {};
    const purity = value.purity && typeof value.purity === 'object' ? value.purity : {};
    const out = [];
    if (value.sizeEnabled === true) out.push('screen');
    if (!(purity.sfw === true && purity.sketchy !== true && purity.nsfw !== true)) out.push('purity');
    if (value.sourcesNarrowed === true) out.push('sources');
    return out;
  }

  function hiddenActiveCount(active, visible) {
    const shown = new Set(Array.isArray(visible) ? visible : []);
    return (Array.isArray(active) ? active : []).filter((key) => !shown.has(key)).length;
  }

  return { KEYS, normalizePins, isValidPins, fitCount, purityLabel, activeKeys, hiddenActiveCount };
}));
