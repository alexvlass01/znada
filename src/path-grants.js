'use strict';

// SEC-002, slice 2. Paths the app itself vouched for, for a little while.
//
// Most of what the windows ask to read is answerable from the pool: a record's own path,
// or anything inside a folder the user added. But not all of it. A file just chosen in a
// native dialog is not in the pool yet, and neither is a folder the user is browsing
// before they add it — and both have to draw a thumbnail immediately.
//
// So there is a second, smaller source of authority: paths main vouched for — from a
// dialog/listing it produced, or after it validated a renderer-reported drop and accepted
// it into the library. They live here rather than in a set that grows for the life of the
// process, because authority that never expires is not a grant, it is a slowly widening
// hole: every folder ever browsed would stay readable until the app closed.
//
// Bounded two ways on purpose. By age, so a grant reflects something the user is doing
// now; and by count, so a renderer that asked to browse ten thousand folders cannot turn
// this into a list of the whole disk. Oldest goes first.
//
// Pure: the clock and the path comparison are injected, so expiry and containment are
// tested without waiting and without a filesystem.

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX = 256;

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs] How long a grant lasts.
 * @param {number} [options.max] How many grants are kept at once; oldest goes first.
 * @param {() => number} [options.now] Injected clock, so expiry is testable without waiting.
 * @param {(child: string, ancestor: string) => boolean} options.isSameOrDescendant
 *   Required. How containment is decided for a grant that covers a whole folder.
 * @param {(p: any) => string} [options.normalize] How a path becomes a comparable key.
 */
function create(options) {
  const {
    ttlMs = DEFAULT_TTL_MS,
    max = DEFAULT_MAX,
    now = Date.now,
    isSameOrDescendant,
    normalize = (p) => String(p || ''),
  } = options || {};
  if (typeof isSameOrDescendant !== 'function') {
    throw new Error('path-grants: isSameOrDescendant(child, ancestor) is required');
  }
  // Insertion-ordered, which is what makes "drop the oldest" a Map operation rather than
  // a sort. Re-granting deletes first so a path the user is still working with moves to
  // the back of the queue instead of being evicted while in use.
  const grants = new Map();

  function expired(entry, at) {
    return !entry || at - entry.at >= ttlMs;
  }

  function sweep(at = now()) {
    for (const [key, entry] of grants) {
      if (expired(entry, at)) grants.delete(key);
    }
    return grants.size;
  }

  // `root: true` means "and everything under it" — a folder the user picked or is
  // browsing. Without it a grant covers exactly one file.
  function grant(p, { root = false } = {}) {
    const key = normalize(p);
    if (!key) return false;
    const at = now();
    sweep(at);
    if (grants.has(key)) grants.delete(key);
    grants.set(key, { path: p, root: !!root, at });
    while (grants.size > max) {
      const oldest = grants.keys().next();
      if (oldest.done) break;
      grants.delete(oldest.value);
    }
    return true;
  }

  function allows(p) {
    const key = normalize(p);
    if (!key) return false;
    const at = now();
    const direct = grants.get(key);
    if (direct && !expired(direct, at)) return true;
    for (const entry of grants.values()) {
      if (!entry.root || expired(entry, at)) continue;
      if (isSameOrDescendant(p, entry.path)) return true;
    }
    return false;
  }

  return {
    grant,
    allows,
    sweep,
    size: () => grants.size,
    clear: () => grants.clear(),
    // Diagnostics only: never the paths themselves, which are the user's business.
    stats: () => ({ size: grants.size, roots: [...grants.values()].filter((e) => e.root).length }),
  };
}

module.exports = { create, DEFAULT_TTL_MS, DEFAULT_MAX };
