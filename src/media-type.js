'use strict';

// ONL-015. THE list of picture formats Znada handles — one answer to one question,
// for a file on disk and for a card from a site alike.
//
// There used to be two answers. A folder yielded jpg, jpeg, png, bmp, webp and gif; a
// site was allowed jpg, jpeg and png only. Nobody chose the narrow one: it was each
// booru adapter's private `SUPPORTED_EXTS`, while the wallpaper site had no rule at all,
// and ONL-012 merely collected them into one place without settling which was right.
// The result was that the same webp was ordinary wallpaper out of a folder and invisible
// from a site — against the rule that a picture should behave the same whatever brought
// it in. Settled 2026-08-27, in the direction the app already handled.
//
// Folder scanners, main's file dialogs and the shared search/download boundaries all
// derive from this list. That is the whole point: ONE list, so widening it cannot
// half-happen.
//
// The kinds this file used to carry (image / animation / video) are gone. They were a
// second classification alongside the format, and after this rule nothing asked for
// them: video never arrives because `webm` is not on the list, and the day it does
// arrive it needs a player, not a label.

const WALLPAPER_FORMATS = Object.freeze(['jpg', 'jpeg', 'png', 'bmp', 'webp', 'gif']);

const FORMAT_SET = new Set(WALLPAPER_FORMATS);

// Content-Type is untrusted input too. Keep its spelling explicit: normalizing the tail
// of any slash-separated string would accidentally turn e.g. video/gif into an image.
// JPG and JPEG are the same file family; x-ms-bmp is a common Windows server alias.
const MIME_FORMATS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

// A bare extension, in lower case and without the dot. Accepts what the sites actually
// hand over: 'jpg', '.JPG', 'image/jpeg'.
function normalizeFormat(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return '';
  const slash = raw.lastIndexOf('/');
  const tail = slash >= 0 ? raw.slice(slash + 1) : raw;
  return tail.replace(/^\./, '').replace(/[^a-z0-9]/g, '');
}

// Can Znada put a file of this format on a desktop? An unrecognised format is a NO here;
// whether a card with no format at all may pass is a different question, and the shared
// handler answers it from what the site declared about itself.
function isWallpaperFormat(value) {
  return FORMAT_SET.has(normalizeFormat(value));
}

// The same list spelled the way a filename carries it, for scanning folders.
function fileExtensions() {
  return WALLPAPER_FORMATS.map((format) => `.${format}`);
}

function wallpaperMime(value) {
  const mime = String(value == null ? '' : value).split(';', 1)[0].trim().toLowerCase();
  const format = MIME_FORMATS[mime];
  return format && FORMAT_SET.has(format) ? mime : '';
}

function equivalentFormat(value) {
  const format = normalizeFormat(value);
  return format === 'jpeg' ? 'jpg' : format;
}

function mimeMatchesFormat(mimeValue, formatValue) {
  const mime = wallpaperMime(mimeValue);
  return !!mime && MIME_FORMATS[mime] === equivalentFormat(formatValue);
}

function sameWallpaperFormat(left, right) {
  const a = equivalentFormat(left);
  const b = equivalentFormat(right);
  return !!a && a === b && FORMAT_SET.has(a);
}

module.exports = {
  WALLPAPER_FORMATS,
  normalizeFormat,
  isWallpaperFormat,
  fileExtensions,
  wallpaperMime,
  mimeMatchesFormat,
  sameWallpaperFormat,
};
