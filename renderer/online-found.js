'use strict';

// ONL-004. "How many are there?" — one short number beside each site in the Sources menu.
//
// The counter at the bottom says how many cards are LOADED. Until now nothing said how many
// the question had, so 13 cards read the same whether the site had 13 or two thousand
// (BUG-048, 2026-09-27). The owner's decisions (2026-09-27):
//   * per site, never a combined total — the same picture on two boards is shown once, so a
//     sum would promise more than the feed can ever load;
//   * not a line under the filters: rarely needed, and it took room on every search. The
//     number sits beside the site in "Sources", as short as possible, with no words;
//   * nothing at all while "Fits my screen" is on. A site can only narrow by a size floor,
//     not by shape, so its count there is neither what it has nor what the feed will show
//     (measured: 3k → 2.7k by the site, about 100 after the shape check). No honest number
//     exists without fetching every post, so none is shown.
//
// A site gets a number only when it answered with one. A failed site is named by the failure
// notice instead; one that keeps no count (our own catalogue) shows nothing rather than a guess.
//
// Pure: the window hands in what it holds and gets text back.

(function initOnlineFound(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OnlineFound = api;
}(typeof window !== 'undefined' ? window : globalThis, function onlineFoundFactory() {
  function numberFormat(locale, options) {
    try { return new Intl.NumberFormat(locale || undefined, options); } catch { return new Intl.NumberFormat(undefined, options); }
  }

  // What to show beside one site: `{ text, exact }` — `text` short ("1.9K", "844", "0"),
  // `exact` the full number for a tooltip — or null when there is nothing honest to show.
  function countLabel({ totals, id, sizeFiltered = false, locale } = {}) {
    if (sizeFiltered) return null;
    const n = totals && typeof totals === 'object' ? totals[id] : undefined;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    const value = Math.floor(n);
    return {
      text: numberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value),
      exact: numberFormat(locale).format(value),
    };
  }

  // LIB-014 stage 3. What stands beside one site in Sources: a pause when the search had more
  // words than the site takes (`{ paused: true, sortHelps }` — the window draws the mark and
  // picks the tooltip), otherwise the number above (`{ paused: false, text, exact }`), or
  // null. A pause is shown even with "Fits my screen" on: it is not a number, it says the
  // site was not asked.
  function sourceState({ totals, paused, id, sizeFiltered = false, locale } = {}) {
    const pause = paused && typeof paused === 'object' ? paused[id] : null;
    if (pause) return { paused: true, sortHelps: !!pause.sortHelps };
    const label = countLabel({ totals, id, sizeFiltered, locale });
    return label ? { paused: false, ...label } : null;
  }

  return { countLabel, sourceState };
}));
