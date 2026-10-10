'use strict';

// BUG-035. The one chip that says "this picture moves", and the few words around it.
//
// Owner's choice 2026-09-26, variant A1 of the mock-up: whatever the file (GIF, animated
// WebP, APNG), a moving picture carries the same short GIF chip, since for most people
// that word already means any moving picture. The real format is not lost: it is in the chip's
// tooltip and in "Details". Video, when Znada gets it, will have its own ▶ chip; that is
// not built here. The chip is always visible, bottom-left, on the same dark glass as the
// card's star and menu (top-left is the star, top-right the menu and selection).
//
// A local picture is judged by main from the file's bytes (src/image-motion.js); a site
// card by what the site declared about the bytes it will hand over. "Unknown" draws
// nothing: a chip that guesses is worse than none.
//
// What to show is decided here without a DOM. `sync` only puts that answer on screen and
// takes it off again, because the grid reuses cards between views.

(function initMotionBadge(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MotionBadge = api;
}(typeof window !== 'undefined' ? window : globalThis, function motionBadgeFactory() {
  const CHIP_TEXT = 'GIF';
  const MOVING_FORMATS = new Set(['gif', 'png', 'webp']);
  // An animated PNG is "APNG": "PNG" alone would read as a still picture.
  const NAMES = Object.freeze({ gif: 'GIF', png: 'APNG', webp: 'WEBP' });

  function formatName(format) {
    const key = String(format || '').toLowerCase();
    return NAMES[key] || key.toUpperCase();
  }

  function frameCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 1 ? Math.trunc(n) : 0;
  }

  // Main's answer for a local file. Only an explicit `true` moves.
  function fromLocal(motion) {
    if (!motion || motion.animated !== true) return null;
    return { format: String(motion.format || '').toLowerCase(), frames: frameCount(motion.frames) };
  }

  // A site card: the site's word, and only for a format that can move at all.
  function fromSite(item) {
    if (!item || item.animated !== true) return null;
    const format = String(item.format || '').toLowerCase();
    return MOVING_FORMATS.has(format) ? { format, frames: 0 } : null;
  }

  // "Animation · WEBP", plus the frame count when it is known exactly.
  function describe(t, info) {
    if (!info) return '';
    const format = formatName(info.format);
    return info.frames > 1
      ? t('motion.formatFrames', { format, frames: info.frames })
      : t('motion.format', { format });
  }

  function findChip(host) {
    const children = host && host.children ? Array.from(host.children) : [];
    return children.find((child) => child.classList && child.classList.contains('lib-motion')) || null;
  }

  // Put the chip on `host` or take it off; calling it twice changes nothing. A card also
  // gets `data-motion`, which is what the assign window reads for its first-frame line.
  function sync(host, info, t, options = {}) {
    if (!host) return null;
    let chip = findChip(host);
    if (!info) {
      if (chip) chip.remove();
      if (host.dataset) delete host.dataset.motion;
      return null;
    }
    if (!chip) {
      chip = host.ownerDocument.createElement('span');
      chip.className = options.inline ? 'lib-motion inline' : 'lib-motion';
      chip.textContent = CHIP_TEXT;
      host.appendChild(chip);
    }
    const text = describe(t, info);
    chip.title = text;
    chip.setAttribute('aria-label', text);
    if (host.dataset && !options.inline) host.dataset.motion = formatName(info.format);
    return chip;
  }

  // Does this anchor — a card, or something on one — stand for a moving picture?
  function marksMotion(anchor) {
    if (!anchor || typeof anchor.closest !== 'function') return false;
    if (anchor.closest('[data-motion]')) return true;
    return !!(typeof anchor.querySelector === 'function' && anchor.querySelector('[data-motion]'));
  }

  const INFO_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/>'
    + '<path d="M8 7.2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
    + '<circle cx="8" cy="4.9" r=".95" fill="currentColor"/></svg>';

  // The one line an assign window adds for a moving picture: the desktop will show its
  // first frame. Both windows that can assign draw it from here, the main window and the
  // viewer, where the picture is seen moving. It starts with "for now" because live
  // wallpapers are planned (MEDIA-001), so it must not read as a permanent limit.
  function appendFirstFrameNote(pop, t) {
    if (!pop || !pop.ownerDocument) return null;
    const note = pop.ownerDocument.createElement('div');
    note.className = 'lib-popup-note';
    note.innerHTML = INFO_ICON;
    const text = pop.ownerDocument.createElement('span');
    text.textContent = t('motion.desktopFirstFrame');
    note.appendChild(text);
    pop.appendChild(note);
    return note;
  }

  return { CHIP_TEXT, formatName, fromLocal, fromSite, describe, sync, marksMotion, appendFirstFrameNote };
}));
