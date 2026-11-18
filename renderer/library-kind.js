'use strict';

// MEDIA-004. Which kind of file a Library card is — photo, GIF or video — and whether the
// ticks in the Library's "Filters" let it through.
//
// "GIF" means what already carries the GIF chip (BUG-035): any picture that MOVES, whatever
// its format. A one-frame GIF is a photo. So the answer for a .gif, .png or .webp comes from
// main reading the file's bytes (src/image-motion.js), not from its name, and until that
// answer is in, the card's kind is unknown: it shows only when both "Photo" and "GIF" are
// ticked, the one case where the answer does not matter. A file main could not read counts
// as a photo — shown among the photos rather than lost.
//
// A card from a site (a cloud favourite) has no file here; it moves when the site said so,
// the same rule as its chip (MotionBadge.fromSite).
//
// The list of formats that can move mirrors CAN_MOVE in src/image-motion.js;
// test/library-kind.test.js holds them equal.

(function initLibraryKind(root, factory) {
  const api = factory(
    (root && root.MediaKind) || (typeof require === 'function' ? require('./media-kind') : null),
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LibraryKind = api;
}(typeof window !== 'undefined' ? window : globalThis, function libraryKindFactory(MediaKind) {
  const KINDS = Object.freeze(['photo', 'gif', 'video']);
  const CAN_MOVE = Object.freeze(['gif', 'png', 'webp']);
  const CAN_MOVE_SET = new Set(CAN_MOVE);
  const SITE_MOVING = new Set(['gif', 'png', 'webp']);

  function extOf(p) {
    const s = String(p == null ? '' : p);
    const base = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  }

  // The ticked kinds, in a fixed order. Anything unknown is dropped; nothing ticked at all
  // means everything — the last tick cannot be cleared, so an empty list is never a choice.
  function normalize(selection) {
    const set = new Set(Array.isArray(selection) ? selection : []);
    const out = KINDS.filter((kind) => set.has(kind));
    return out.length ? out : KINDS.slice();
  }

  function isNarrowed(selection) {
    return normalize(selection).length < KINDS.length;
  }

  // Tick or clear one kind. Clearing the last ticked one is refused: the grid would be
  // empty for no reason the person can see.
  function toggle(selection, kind, on) {
    const current = normalize(selection);
    if (!KINDS.includes(kind)) return current;
    const next = on ? current.concat(kind) : current.filter((k) => k !== kind);
    return next.length ? normalize(next) : current;
  }

  // Only a file that can move needs main's answer, and only when "Photo" and "GIF" are
  // ticked differently: with both ticked, or both cleared, a moving picture and a still one
  // are treated alike.
  function needsMotion(selection) {
    const sel = normalize(selection);
    return sel.includes('photo') !== sel.includes('gif');
  }

  function mayMove(p) {
    return CAN_MOVE_SET.has(extOf(p));
  }

  // `entry`: { path, local, item, folder }. `moving(path)` returns true / false for a file
  // main has answered about, undefined while it has not. Returns a kind, 'folder' for a
  // folder card, or null while unknown.
  function kindOf(entry, moving) {
    if (!entry) return null;
    if (entry.folder) return 'folder';
    if (entry.local === false) {
      const item = entry.item || {};
      if (MediaKind?.isOnlineVideo?.(item)) return 'video';
      return item.animated === true && SITE_MOVING.has(String(item.format || '').toLowerCase()) ? 'gif' : 'photo';
    }
    const p = entry.path;
    if (MediaKind && MediaKind.isVideoPath(p)) return 'video';
    if (!mayMove(p)) return 'photo';
    const answer = typeof moving === 'function' ? moving(p) : undefined;
    if (answer === true) return 'gif';
    if (answer === false) return 'photo';
    return null;
  }

  // Does a card of this kind show? A folder always does: it is a way in, not a file.
  function matches(selection, kind) {
    const sel = normalize(selection);
    if (kind === 'folder') return true;
    if (kind === null) return sel.includes('photo') && sel.includes('gif');
    return sel.includes(kind);
  }

  return { KINDS, CAN_MOVE, normalize, isNarrowed, toggle, needsMotion, mayMove, kindOf, matches };
}));
