'use strict';

// COLLAB-003. The title-bar badge of a DEV or DIAG check window: which code this window
// runs. Main passes the label only to a check launch, through the preload; a user build
// never gets one, so there the badge simply stays hidden.
//
// A module of its own rather than a few lines in renderer.js: it has to appear even when
// something later in the page fails to start, and it is the one piece of the page a test
// can load without the whole app.

(function initDevLaunchBadge(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.DevLaunchBadge = api;
    if (root.document && root.api && api.apply(root.document, root.api.devLaunch)) {
      api.keepClearOfNav(root.document, root);
    }
  }
}(typeof window !== 'undefined' ? window : globalThis, function devLaunchBadgeFactory() {
  const GAP_BEFORE_NAV = 12;
  const MIN_WIDTH = 48;
  const MAX_WIDTH = 280;

  function apply(doc, label) {
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById('tbDevLaunch') : null;
    if (!el) return false;
    if (!label || typeof label.badgeText !== 'string' || !label.badgeText) {
      el.hidden = true;
      return false;
    }
    el.textContent = label.badgeText;
    // Hovering shows the whole commit, the branch, the profile and when the window closes itself.
    el.title = typeof label.details === 'string' && label.details ? label.details : label.badgeText;
    el.classList.toggle('is-diag', label.mode === 'diag');
    // Uncommitted or unnamed code is not the revision a PR names, so it is marked in colour too.
    el.classList.toggle('is-dirty', label.dirty === true || label.known === false);
    el.hidden = false;
    return true;
  }

  // The tabs sit centred over the title bar rather than in its row, so the badge cannot push
  // them aside: a long label, or an ordinary one in a narrow window, ran UNDER the first tab.
  // The badge is cut with an ellipsis before it reaches them instead; the whole text stays in
  // its tooltip, in the window title and in the tray.
  function fit(doc) {
    const el = doc && typeof doc.getElementById === 'function' ? doc.getElementById('tbDevLaunch') : null;
    const nav = el ? doc.getElementById('tbNav') : null;
    if (!el || el.hidden || !nav) return null;
    const navBox = nav.getBoundingClientRect();
    if (!(navBox.width > 0)) {
      // The tabs are hidden (the first-run screen): nothing to keep clear of, the style's cap applies.
      el.style.maxWidth = '';
      return null;
    }
    const room = Math.floor(navBox.left - GAP_BEFORE_NAV - el.getBoundingClientRect().left);
    const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, room));
    el.style.maxWidth = `${width}px`;
    return width;
  }

  // Fits now and again whenever the title bar or the tabs change size: the window was
  // resized, the tabs appeared after the first-run screen, or another language made them wider.
  function keepClearOfNav(doc, win) {
    fit(doc);
    const Observer = win && win.ResizeObserver;
    if (typeof Observer !== 'function') return false;
    const observer = new Observer(() => { fit(doc); });
    const bar = doc.getElementById('titlebar');
    const nav = doc.getElementById('tbNav');
    if (bar) observer.observe(bar);
    if (nav) observer.observe(nav);
    return true;
  }

  return { apply, fit, keepClearOfNav };
}));
