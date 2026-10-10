'use strict';

// LIB-017. A moving picture plays on its card while the pointer rests on it.
//
// Owner's decisions 2026-10-09: playback starts after 0.4 s of hover, so a quick pass of the
// mouse over the grid starts and loads nothing; only the user's own pictures play (an online
// card would have to download the whole file just for a hover — those stay still until the
// viewer opens); it plays wherever the GIF chip is, except the previews that stand for the
// desktop (Home's monitors, "Appearance"), which show what is really there: the first frame.
//
// Mechanics, author's choice: one card plays at a time — the one under the pointer. The still
// thumbnail stays until the moving file is ready, so nothing blinks; leaving takes the moving
// picture away at once and abandons a load that has not finished. Nothing plays when Windows
// animations are off.
//
// A host opts in with `data-play-path` (set by `mark`, next to the chip) and must also carry
// the chip's `data-motion`: a reused card that lost its chip does not play. The moving file is
// laid OVER the thumbnail as an <img> instead of replacing the background, so the still frame
// is never touched and comes back by itself; the chip, star and menu stay above it.
//
// `create` is the controller alone, with injected timers and URL lookup, tested without a DOM.
// `install` wires one document's pointer to it.

(function initMotionHover(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MotionHover = api;
}(typeof window !== 'undefined' ? window : globalThis, function motionHoverFactory() {
  const DELAY_MS = 400;
  const PLAY_CLASS = 'motion-play';

  // Says that `host` may play the file at `filePath`, or takes that back. Called wherever the
  // chip is put on, with the same answer, because the grid reuses cards between views.
  function mark(host, filePath, moving) {
    if (!host || !host.dataset) return;
    if (moving && filePath) host.dataset.playPath = filePath;
    else delete host.dataset.playPath;
  }

  function playable(host) {
    return !!(host && host.dataset && host.dataset.playPath && host.dataset.motion);
  }

  function create({ delayMs = DELAY_MS, setTimer, clearTimer, resolveUrl, reducedMotion }) {
    let current = null; // { host, timer, img }

    function stop() {
      if (!current) return;
      const { timer, img } = current;
      current = null;
      if (timer !== null) clearTimer(timer);
      if (img) {
        img.onload = null;
        img.onerror = null;
        if (img.parentNode) img.parentNode.removeChild(img);
      }
    }

    function begin(state) {
      state.timer = null;
      Promise.resolve(resolveUrl(state.host.dataset.playPath)).then((url) => {
        if (current !== state || !url) return;
        const img = state.host.ownerDocument.createElement('img');
        img.className = PLAY_CLASS;
        img.alt = '';
        img.decoding = 'async';
        img.onload = () => {
          // Still the card under the pointer, still on screen, still a moving picture.
          if (current !== state || !state.host.isConnected || !playable(state.host)) return;
          state.host.insertBefore(img, state.host.firstChild || null);
        };
        img.onerror = () => { if (current === state) state.img = null; };
        state.img = img;
        img.src = url;
      }, () => {});
    }

    // The pointer is now over `host` (null: over nothing that plays).
    function hover(host) {
      if (current && current.host === host) return;
      stop();
      if (!playable(host)) return;
      if (typeof reducedMotion === 'function' && reducedMotion()) return;
      const state = { host, timer: null, img: null };
      current = state;
      state.timer = setTimer(() => begin(state), delayMs);
    }

    return {
      hover,
      stop,
      get host() { return current ? current.host : null; },
    };
  }

  function install(doc, controller) {
    const hostOf = (target) => (target && typeof target.closest === 'function'
      ? target.closest('[data-play-path]') : null);
    doc.addEventListener('mouseover', (e) => controller.hover(hostOf(e.target)));
    // The pointer left the window: relatedTarget is null.
    doc.addEventListener('mouseout', (e) => { if (!e.relatedTarget) controller.stop(); });
    doc.addEventListener('visibilitychange', () => { if (doc.hidden) controller.stop(); });
    const view = doc.defaultView;
    if (view) view.addEventListener('blur', () => controller.stop());
  }

  return { DELAY_MS, PLAY_CLASS, mark, playable, create, install };
}));
