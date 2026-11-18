'use strict';

// MEDIA-002. Is this local file a video? The window has to know before any thumbnail
// arrives: a click on a card that has not loaded yet must still open a video in the
// Windows player, not in our picture viewer.
//
// The window cannot require src/media-type.js, so the list is mirrored here and
// test/media-kind.test.js holds it equal to VIDEO_FORMATS there — the same arrangement
// as the native thumbnail helper's list. Change both or neither.

(function initMediaKind(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MediaKind = api;
}(typeof window !== 'undefined' ? window : globalThis, function mediaKindFactory() {
  const VIDEO_FORMATS = Object.freeze([
    'mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', 'wmv', 'asf', 'mpg', 'mpeg', 'm2v',
    'ts', 'mts', 'm2ts', '3gp', '3g2', 'flv', 'ogv', 'f4v', 'vob', 'divx',
  ]);
  const VIDEO_SET = new Set(VIDEO_FORMATS);

  // Only the last dot of the file name counts, so a folder named "trip.mp4" lends its
  // files no format.
  function isVideoPath(p) {
    const s = String(p == null ? '' : p);
    const base = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
    const dot = base.lastIndexOf('.');
    return dot > 0 && VIDEO_SET.has(base.slice(dot + 1).toLowerCase());
  }

  function isOnlineVideo(item) {
    return item?.format === 'mp4' || item?.format === 'webm';
  }

  return { VIDEO_FORMATS, isVideoPath, isOnlineVideo };
}));
