'use strict';

// BUG-035. The one chip that says "this picture moves", and the few words around it.
//
// Owner's choice 2026-09-26, variant A1 of the mock-up: whatever the file (GIF, animated
// WebP, APNG), a moving picture carries the same short GIF chip, since for most people
// that word already means any moving picture. The real format is not lost: it is in the chip's
// tooltip and in "Details". Video (MEDIA-002) has its own chip from the same mock-up:
// ▶ and the length, on the same glass in the same corner. The chip is always visible, bottom-left, on the same dark glass as the
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

  // MEDIA-002. Main's `video` answer for a local file. Its presence alone makes a video
  // chip; the length is drawn only when Windows reported one.
  function fromVideo(video) {
    if (!video || typeof video !== 'object') return null;
    const ms = Number(video.durationMs);
    return { video: true, durationMs: Number.isFinite(ms) && ms > 0 ? ms : 0 };
  }

  // 0:44 · 1:14 · 1:02:05 — how players write a length, the same in every language.
  function formatDuration(ms) {
    const total = Math.round(Number(ms) / 1000);
    if (!Number.isFinite(total) || total <= 0) return '';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function chipText(info) {
    if (!info.video) return CHIP_TEXT;
    const length = formatDuration(info.durationMs);
    return length ? `▶ ${length}` : '▶';
  }

  // "Animation · WEBP", plus the frame count when it is known exactly.
  function describe(t, info) {
    if (!info) return '';
    if (info.video) {
      const length = formatDuration(info.durationMs);
      return length ? t('video.badgeLength', { length }) : t('video.badge');
    }
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
  // gets `data-motion`, which is what the assign window reads for its first-frame line —
  // or, for video, `data-video` instead: a video has no first frame on the desktop and
  // must never be hover-played as a picture (MEDIA-002). The grid reuses cards, so both
  // marks and the chip's text are set every time, never only added.
  function sync(host, info, t, options = {}) {
    if (!host) return null;
    let chip = findChip(host);
    if (!info) {
      if (chip) chip.remove();
      if (host.dataset) {
        delete host.dataset.motion;
        delete host.dataset.video;
      }
      return null;
    }
    if (!chip) {
      chip = host.ownerDocument.createElement('span');
      host.appendChild(chip);
    }
    chip.className = (options.inline ? 'lib-motion inline' : 'lib-motion') + (info.video ? ' video' : '');
    chip.textContent = chipText(info);
    const text = describe(t, info);
    chip.title = text;
    chip.setAttribute('aria-label', text);
    if (host.dataset && !options.inline) {
      if (info.video) {
        delete host.dataset.motion;
        host.dataset.video = '1';
      } else {
        delete host.dataset.video;
        host.dataset.motion = formatName(info.format);
      }
    }
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

  return {
    CHIP_TEXT, formatName, fromLocal, fromSite, fromVideo, formatDuration, describe, sync, marksMotion,
    appendFirstFrameNote,
  };
}));
