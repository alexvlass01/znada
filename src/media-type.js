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
// MEDIA-002. Video is a SECOND list, not a wider first one. A video file is shown in the
// Library as a card, but nothing that puts a picture on the desktop may ever see it:
// the slideshow, folder expansion and the apply step all ask `isWallpaperFormat` /
// `isWallpaperPath`, so leaving this list alone is what keeps video off the desktop.
// What the Library shows is the union, `libraryExtensions()`.

const WALLPAPER_FORMATS = Object.freeze(['jpg', 'jpeg', 'png', 'bmp', 'webp', 'gif']);

const FORMAT_SET = new Set(WALLPAPER_FORMATS);

// Owner 2026-11-01: as many as people actually keep in folders, from day one. Windows
// gives a frame only where it has a codec; a format it cannot read still gets a card.
const VIDEO_FORMATS = Object.freeze([
  'mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', 'wmv', 'asf', 'mpg', 'mpeg', 'm2v',
  'ts', 'mts', 'm2ts', '3gp', '3g2', 'flv', 'ogv', 'f4v', 'vob', 'divx',
]);

const ONLINE_VIDEO_FORMATS = Object.freeze(['mp4', 'webm']);

const VIDEO_SET = new Set(VIDEO_FORMATS);

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

// The format of a path, from its extension. Only the last dot counts, so a folder name
// with a dot in it does not lend the file a format.
function formatOfPath(p) {
  const s = String(p == null ? '' : p);
  const base = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? normalizeFormat(base.slice(dot + 1)) : '';
}

// May this FILE go on the desktop? The one question the apply path asks.
function isWallpaperPath(p) {
  return FORMAT_SET.has(formatOfPath(p));
}

function isVideoFormat(value) {
  return VIDEO_SET.has(normalizeFormat(value));
}

function isVideoPath(p) {
  return VIDEO_SET.has(formatOfPath(p));
}

function videoExtensions() {
  return VIDEO_FORMATS.map((format) => `.${format}`);
}

// Everything the Library shows as a card: pictures and video.
function libraryExtensions() {
  return fileExtensions().concat(videoExtensions());
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
  VIDEO_FORMATS,
  ONLINE_VIDEO_FORMATS,
  normalizeFormat,
  isWallpaperPath,
  isVideoFormat,
  isVideoPath,
  videoExtensions,
  libraryExtensions,
  isWallpaperFormat,
  fileExtensions,
  wallpaperMime,
  mimeMatchesFormat,
  sameWallpaperFormat,
};
