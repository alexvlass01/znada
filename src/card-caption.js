'use strict';

// META-002. The words a card already shows: the author, when the site named one,
// otherwise the pixel size the site reported. A hash filename and a generic
// "Wallpaper" are not captions. The Home "recently added" row stays without one
// on purpose (owner, 2026-07-22): mixed empty and filled lines looked inconsistent.
//
// Loaded by the window as a script and by tests as a module. It does not read
// files: a caption is only what the record already carries.
(function initCardCaption(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CardCaption = api;
}(typeof window !== 'undefined' ? window : globalThis, function cardCaptionFactory() {
  const AUTHOR_CAP = 120;
  const PIXEL_CAP = 1000000;

  function pixels(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    const rw = Math.round(w);
    const rh = Math.round(h);
    if (rw <= 0 || rh <= 0 || rw > PIXEL_CAP || rh > PIXEL_CAP) return null;
    return { width: rw, height: rh };
  }

  // A resolution already written as text ("1920x1080" or "1920 × 1080") is the
  // same fact as numeric width and height. Anything else in the string is not.
  function pixelsFromResolution(value) {
    if (typeof value !== 'string') return null;
    const match = value.trim().match(/^(\d{1,7})\s*[x×]\s*(\d{1,7})$/i);
    return match ? pixels(match[1], match[2]) : null;
  }

  // A blank author falls through to the site's artist field. Online cards use
  // `artist`; pool records use `author`. Underscores stay as the site wrote them.
  function authorOf(item) {
    const author = typeof item.author === 'string' ? item.author.trim() : '';
    if (author) return author.slice(0, AUTHOR_CAP);
    const artist = typeof item.artist === 'string' ? item.artist.trim() : '';
    return artist ? artist.slice(0, AUTHOR_CAP) : '';
  }

  function text(item) {
    if (!item || typeof item !== 'object') return '';
    const author = authorOf(item);
    if (author) return author;
    const dims = pixels(item.width, item.height) || pixelsFromResolution(item.resolution);
    return dims ? `${dims.width} × ${dims.height}` : '';
  }

  return { text };
}));
