'use strict';

// LIB-021. How long an Undo notice stays, and the line that shows it.
//
// Owner's decision 2026-10-01, mock-up approved 2026-10-08: a notice that offers Undo after a
// removal stays 8 seconds in both windows. A ~2px line in the Undo button's colour runs along
// its bottom edge and shrinks toward the left over those 8 seconds. The cursor on the notice,
// or keyboard focus on its button, stops both the line and the clock; leaving continues from
// where it stopped rather than starting over. With reduced motion the line stands still and
// the notice still lasts 8 seconds. No numbers, no blinking. The notice running out removes
// nothing: the entry stays in the library's trash.
//
// The clock is a timer, not the line's animation: a minimised window may not paint, and the
// owner chose that the 8 seconds keep running by the clock then. The line follows the same
// holds through `data-paused`, so on screen they stop and start together.
//
// `create` is the clock alone, with injectable timers so it is tested without a DOM.
// `attach` puts the line into a notice and wires the cursor and focus to the clock.

(function initUndoDeadline(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UndoDeadline = api;
}(typeof window !== 'undefined' ? window : globalThis, function undoDeadlineFactory() {
  const DURATION_MS = 8000;

  // Timers are passed in by the caller rather than defaulted here: each window hands over its
  // own, and the tests hand over fakes.
  function create({ duration = DURATION_MS, onExpire, now, setTimer, clearTimer }) {
    const holds = new Set();
    let remaining = duration;
    let startedAt = now();
    let timer = setTimer(expire, remaining);
    let finished = false;

    function expire() {
      if (finished) return;
      finished = true;
      timer = null;
      if (typeof onExpire === 'function') onExpire();
    }

    // Several reasons can hold the clock at once (cursor and focus). It runs again only when
    // the last of them lets go.
    function hold(reason, on) {
      if (finished) return;
      if (on) {
        if (holds.has(reason)) return;
        holds.add(reason);
        if (holds.size > 1) return;
        remaining = Math.max(0, remaining - (now() - startedAt));
        clearTimer(timer);
        timer = null;
      } else {
        if (!holds.delete(reason) || holds.size > 0) return;
        startedAt = now();
        timer = setTimer(expire, remaining);
      }
    }

    function cancel() {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      timer = null;
    }

    return {
      hold,
      cancel,
      isPaused: () => !finished && holds.size > 0,
      isFinished: () => finished,
      remaining: () => (finished ? 0 : holds.size > 0 ? remaining : Math.max(0, remaining - (now() - startedAt))),
    };
  }

  // The line goes last so it never shifts the text or the button; CSS lays it along the
  // bottom edge. Its duration comes from here so the clock and the line cannot disagree.
  //
  // The main window reuses one toast element for every message, so the listeners are taken
  // off again when the clock ends either way; otherwise each notice would add another set.
  function attach(element, doc, options) {
    const listeners = [];
    const detach = () => {
      for (const [type, fn] of listeners.splice(0)) element.removeEventListener(type, fn);
    };
    const onExpire = options.onExpire;
    const clock = create({
      ...options,
      onExpire: () => { detach(); if (typeof onExpire === 'function') onExpire(); },
    });
    const line = doc.createElement('div');
    line.className = 'undo-deadline';
    if (line.style && typeof line.style.setProperty === 'function') {
      line.style.setProperty('--undo-deadline-ms', (options.duration || DURATION_MS) + 'ms');
    }
    element.appendChild(line);
    element.setAttribute('data-paused', 'false');

    const sync = () => element.setAttribute('data-paused', clock.isPaused() ? 'true' : 'false');
    const holdOn = (reason) => () => { clock.hold(reason, true); sync(); };
    const holdOff = (reason) => () => { clock.hold(reason, false); sync(); };
    const listen = (type, fn) => { element.addEventListener(type, fn); listeners.push([type, fn]); };
    listen('mouseenter', holdOn('pointer'));
    listen('mouseleave', holdOff('pointer'));
    listen('focusin', holdOn('focus'));
    listen('focusout', holdOff('focus'));
    // A notice can appear right under a resting cursor; no mouseenter comes then.
    if (typeof element.matches === 'function' && element.matches(':hover')) holdOn('pointer')();
    return { ...clock, cancel: () => { detach(); clock.cancel(); } };
  }

  return { DURATION_MS, create, attach };
}));
