'use strict';

// ONL-015. THE list of picture formats Znada handles — one answer for a file on disk and
// for a card from a site alike.
//
// This module used to also classify a file as picture / animation / video. That second
// classification is gone: nothing ever asked it. What decides is the list, and the day
// video is supported it needs a player rather than a label.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const media = require('../src/media-type');
const playlist = require('../src/playlist');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

ok('the formats Znada can put on a desktop, and no others',
  media.WALLPAPER_FORMATS.slice().sort().join() === 'bmp,gif,jpeg,jpg,png,webp');

// The point of the whole task: ONE list. If these ever disagree again, the same file
// becomes two different things depending on where it came from.
ok('a folder is scanned with exactly that list',
  [...playlist.IMG_EXTS].sort().join() === media.WALLPAPER_FORMATS.map((f) => `.${f}`).sort().join());

ok('moving pictures are not on it', !media.isWallpaperFormat('webm') && !media.isWallpaperFormat('mp4'));
ok('and neither is something we simply cannot read',
  !media.isWallpaperFormat('psd') && !media.isWallpaperFormat('') && !media.isWallpaperFormat(null));

ok('a format is read however the site chose to spell it',
  media.normalizeFormat('JPG') === 'jpg'
  && media.normalizeFormat('.Png') === 'png'
  && media.normalizeFormat('  webm ') === 'webm');
ok('a mime type is understood as the format it names',
  media.normalizeFormat('image/jpeg') === 'jpeg'
  && media.isWallpaperFormat('image/png')
  && !media.isWallpaperFormat('video/webm'));
ok('nothing but the format survives normalising',
  media.normalizeFormat('image/jpeg; charset=binary') === 'jpegcharsetbinary'
  && media.normalizeFormat('..jpg') === 'jpg');
ok('an unreadable value never sneaks through as a usable one',
  !media.isWallpaperFormat({}) && !media.isWallpaperFormat(undefined) && !media.isWallpaperFormat('jpg.exe'));

ok('response MIME accepts every wallpaper family but no HTML or video',
  media.wallpaperMime('image/jpeg; charset=binary') === 'image/jpeg'
  && media.wallpaperMime('image/gif') === 'image/gif'
  && media.wallpaperMime('image/bmp') === 'image/bmp'
  && media.wallpaperMime('image/webp') === 'image/webp'
  && media.wallpaperMime('text/html') === ''
  && media.wallpaperMime('video/webm') === '');

ok('response MIME must agree with the declared file format',
  media.mimeMatchesFormat('image/jpeg', 'jpg')
  && media.mimeMatchesFormat('image/jpeg', 'jpeg')
  && media.mimeMatchesFormat('image/gif', '.GIF')
  && !media.mimeMatchesFormat('image/png', 'jpg')
  && !media.mimeMatchesFormat('text/html', 'jpg'));

ok('the canonical list is frozen, so a caller cannot quietly widen it for everyone',
  (() => {
    const before = media.WALLPAPER_FORMATS.length;
    try { media.WALLPAPER_FORMATS.push('webm'); } catch { /* frozen */ }
    return media.WALLPAPER_FORMATS.length === before && !media.isWallpaperFormat('webm');
  })());

ok('the folder extension list is a fresh copy, so one scan cannot change the next',
  (() => {
    const first = media.fileExtensions();
    first[0] = '.webm';
    first.push('.mp4');
    const second = media.fileExtensions();
    return !second.includes('.webm') && !second.includes('.mp4')
      && second.length === media.WALLPAPER_FORMATS.length;
  })());

ok('the playlist extension export cannot be mutated process-wide by a caller',
  (() => {
    const first = playlist.IMG_EXTS;
    first.add('.webm');
    first.delete('.jpg');
    const second = playlist.IMG_EXTS;
    return !second.has('.webm') && second.has('.jpg');
  })());

// The native helper cannot require a JavaScript module, so hold its cross-language
// boundary beside the canonical list. A new format is not complete while thumbnails
// silently reject it.
{
  const source = fs.readFileSync(path.join(__dirname, '..', 'native', 'thumbnail-helper', 'ShellInterop.cs'), 'utf8');
  const block = source.match(/HashSet<string> Extensions[\s\S]*?\{([\s\S]*?)\};/);
  const native = block ? [...block[1].matchAll(/"(\.[a-z0-9]+)"/gi)].map((m) => m[1].toLowerCase()) : [];
  ok('the native thumbnail helper recognises exactly the canonical wallpaper formats',
    native.sort().join() === media.fileExtensions().sort().join());
}

console.log(`\nAll ${passed} media-type tests passed.`);
