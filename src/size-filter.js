'use strict';

// ONL-010. "Show me only pictures that would actually fit my screen."
//
// A filter is a LIST OF TARGETS, and a picture passes when it suits at least one of
// them. That single shape serves both modes the owner asked for: the automatic one
// builds the list from the monitors that exist, the manual one from what the user typed.
// Neither mode gets its own rule, which is the whole point — two rules would drift.
//
//   target = { ratio: 16/9, minWidth: 3840, minHeight: 2160 }
//
// Two things this file exists to get right, both named by the owner on 2026-08-25:
//
//   1. The ratio is compared WITH A TOLERANCE. 3840×2160 is exactly 16:9 and 3840×2159
//      is not; without a tolerance the filter throws away perfectly good wallpapers and
//      says nothing.
//   2. The resolution is a FLOOR, not a match. A target of 3840×2160 must let 5120×2880
//      through — it is bigger, which is better, not different.
//
// Measured against the live sites on 2026-09-03, which changed the plan for the better:
// Wallhaven narrows by both on its side, Danbooru narrows by both, and Gelbooru narrows
// by resolution but has no ratio metatag at all (every spelling returns nothing). So the
// server side is an OPTIMISATION and never the guarantee: whatever a site does or does
// not manage, every card is checked here before it is shown.

(function initSizeFilter(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SizeFilter = api;
}(typeof window !== 'undefined' ? window : globalThis, function sizeFilterFactory() {
  // 2%: 1920×1080 and 1920×1200 are 11% apart, so this separates the shapes people mean
  // while forgiving the odd pixel. The owner approved 1–2%.
  const RATIO_TOLERANCE = 0.02;
  const MODES = ['auto', 'manual'];
  const MAX_TARGETS = 8;
  // Above this a "resolution" is somebody's typo, not a monitor.
  const MAX_SIDE = 30000;

  function positive(value, cap = MAX_SIDE) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.floor(n), cap);
  }

  // A target may state a shape, a floor, or both — but something. An empty one would
  // match everything, which is not a filter, and would quietly make the whole feature
  // look broken rather than off.
  function normalizeTarget(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const minWidth = positive(raw.minWidth);
    const minHeight = positive(raw.minHeight);
    let ratio = 0;
    const stated = Number(raw.ratio);
    if (Number.isFinite(stated) && stated > 0) ratio = stated;
    else if (minWidth && minHeight) ratio = minWidth / minHeight;
    if (!ratio && !minWidth && !minHeight) return null;
    const target = {};
    if (ratio) target.ratio = ratio;
    if (minWidth) target.minWidth = minWidth;
    if (minHeight) target.minHeight = minHeight;
    return target;
  }

  function sameTarget(a, b) {
    return (a.ratio || 0) === (b.ratio || 0)
      && (a.minWidth || 0) === (b.minWidth || 0)
      && (a.minHeight || 0) === (b.minHeight || 0);
  }

  function normalizeTargets(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const target = normalizeTarget(raw);
      if (!target) continue;
      if (out.some((seen) => sameTarget(seen, target))) continue;
      out.push(target);
      if (out.length >= MAX_TARGETS) break;
    }
    return out;
  }

  // Two identical monitors are ONE target: asking a site twice for the same shape buys
  // nothing and makes the request longer.
  function targetsFromMonitors(monitors) {
    return normalizeTargets((Array.isArray(monitors) ? monitors : []).map((monitor) => {
      if (!monitor || typeof monitor !== 'object') return null;
      const width = positive(monitor.w !== undefined ? monitor.w : monitor.width);
      const height = positive(monitor.h !== undefined ? monitor.h : monitor.height);
      if (!width || !height) return null;
      return { ratio: width / height, minWidth: width, minHeight: height };
    }));
  }

  function normalizeFilter(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const mode = MODES.includes(source.mode) ? source.mode : 'auto';
    return {
      // Off unless the user turned it on: the owner's decision, and the safe default —
      // a filter nobody asked for that hides most of a feed reads as a broken app.
      enabled: source.enabled === true,
      mode,
      targets: normalizeTargets(source.targets),
    };
  }

  // Which targets actually apply right now. Automatic mode reads the monitors, so a
  // second screen appearing changes the answer without anybody editing anything.
  function effectiveTargets(filter, monitors) {
    const normalized = normalizeFilter(filter);
    if (!normalized.enabled) return [];
    return normalized.mode === 'manual' ? normalized.targets : targetsFromMonitors(monitors);
  }

  function ratioFits(width, height, ratio, tolerance = RATIO_TOLERANCE) {
    if (!ratio) return true;
    if (!(width > 0) || !(height > 0)) return false;
    return Math.abs((width / height) - ratio) / ratio <= tolerance;
  }

  function fitsTarget(width, height, target, tolerance = RATIO_TOLERANCE) {
    if (!target) return false;
    if (target.minWidth && !(width >= target.minWidth)) return false;
    if (target.minHeight && !(height >= target.minHeight)) return false;
    return ratioFits(width, height, target.ratio, tolerance);
  }

  // At least one target, as the owner decided for several monitors. An empty list means
  // the filter is off, and off must let everything through rather than nothing.
  function matches(card, targets, options = {}) {
    const list = Array.isArray(targets) ? targets : [];
    if (!list.length) return true;
    const width = positive(card && card.width);
    const height = positive(card && card.height);
    // A card that will not say its size cannot be judged. Keeping it is the lesser
    // wrong: hiding pictures for lack of a field the site simply does not send would
    // look like the filter is broken.
    if (!width || !height) return true;
    const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : RATIO_TOLERANCE;
    return list.some((target) => fitsTarget(width, height, target, tolerance));
  }

  // What to ask a SITE for. Deliberately the loosest constraint that still covers every
  // target: the server may only narrow the field, never decide it — `matches` above is
  // what actually holds. Asking the server for one target's exact shape would silently
  // drop the pictures that suit another.
  function serverHints(targets) {
    const list = Array.isArray(targets) ? targets : [];
    if (!list.length) return null;
    let minWidth = Infinity;
    let minHeight = Infinity;
    const ratios = [];
    for (const target of list) {
      minWidth = Math.min(minWidth, target.minWidth || 0);
      minHeight = Math.min(minHeight, target.minHeight || 0);
      if (target.ratio && !ratios.includes(target.ratio)) ratios.push(target.ratio);
    }
    return {
      minWidth: Number.isFinite(minWidth) ? minWidth : 0,
      minHeight: Number.isFinite(minHeight) ? minHeight : 0,
      // Only usable as a single "at least this wide-ish" bound; a site that can take a
      // list gets the list, one that cannot gets the smallest.
      ratios,
      minRatio: ratios.length ? Math.min(...ratios) : 0,
      // Every target names a shape, so a site may narrow by shape without cutting into
      // what another target would have allowed.
      everyTargetHasRatio: list.every((target) => !!target.ratio),
    };
  }

  // ONL-017. How big a page to ask a site for while the filter is on.
  //
  // "Ask for more, not more often" — the owner's step 1, and the honest half of what the
  // buffer idea was reaching for. A site that cannot narrow by SHAPE returns a page that
  // is mostly thrown away here: measured against the live API on 2026-09-03, an anime
  // board leaves four cards in a hundred under a strict 16:9. Asking that site for its
  // biggest page is ONE request; getting the same cards by asking again and again is
  // four, and that is the traffic BUG-020 spent a whole task limiting.
  //
  // A site that CAN narrow by shape gets nothing extra: its page already comes back
  // full of things that fit, and a bigger page would just be a bigger download.
  function pageSizeFor(baseLimit, declaration) {
    const base = positive(baseLimit, 1000);
    const decl = declaration && typeof declaration === 'object' ? declaration : {};
    const max = positive(decl.maxPageSize, 1000);
    // Nothing to widen: either the site sets its own page size (Wallhaven has no such
    // parameter at all), or it does the shape filtering itself.
    if (!max || decl.ratio === true) return base;
    // Never below what the caller wanted: a caller asking for a big page has its own
    // reason, and this is an optimisation, not a cap.
    //
    // Worth knowing if you change either side: today each adapter's OWN default happens
    // to equal what this returns (Gelbooru 100, Danbooru 24), so dropping the value
    // entirely would look identical from outside — a mutation proving exactly that
    // survived on 2026-09-03 and was accepted as equivalent. The number is still sent
    // deliberately rather than left to a default that could drift.
    return base ? Math.max(base, max) : max;
  }

  // What the manual mode's text field means. "3840x2160, 1920x1080" — one target per
  // entry, written the way people write screen sizes. Parsing lives beside the matching
  // so the two cannot disagree about what a target is.
  function parseTargets(text) {
    const raw = typeof text === 'string' ? text : '';
    const parts = raw.split(/[,;\n]+/);
    const targets = [];
    for (const part of parts) {
      const match = part.trim().match(/^(\d{2,5})\s*[x×*:]\s*(\d{2,5})$/i);
      if (!match) continue;
      targets.push({ minWidth: Number(match[1]), minHeight: Number(match[2]) });
    }
    return normalizeTargets(targets);
  }

  // Back into the field, so what a person typed survives a restart recognisably.
  function formatTargets(targets) {
    return normalizeTargets(targets)
      .map((target) => (target.minWidth && target.minHeight
        ? `${target.minWidth}x${target.minHeight}` : ''))
      .filter(Boolean)
      .join(', ');
  }

  return {
    RATIO_TOLERANCE,
    MODES,
    MAX_TARGETS,
    parseTargets,
    formatTargets,
    pageSizeFor,
    normalizeTarget,
    normalizeTargets,
    normalizeFilter,
    targetsFromMonitors,
    effectiveTargets,
    ratioFits,
    fitsTarget,
    matches,
    serverHints,
  };
}));
