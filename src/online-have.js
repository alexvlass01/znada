'use strict';

// LIB-031. "This Online card is a photo you already have."
//
// Owner, 2026-11-08: a photo from Online that is the same as one the user already has IS
// that photo — the card shows as already downloaded, and that is all. No switch, no
// setting, no explanatory text.
//
// How a card is recognised depends only on what the card carries, never on the site's
// name, so a site that starts sending a fingerprint is recognised by it without a change
// here:
//   * a fingerprint (MD5 — Gelbooru and Danbooru send the original's) — the same bytes;
//   * otherwise an exact size in bytes AND a resolution (Wallhaven sends both, no MD5):
//     two different files that agree on both do not occur in practice, and a wrong match
//     costs one ✓, never a file.
// A card that carries a fingerprint is judged by it alone: a fingerprint that is not
// found means a different file, even if some file happens to have the same size.
//
// What the library holds comes from the shared pass (src/library-checks.js `finder()`),
// so nothing here walks the disk; the only reads are the first bytes of a same-sized file
// to learn its resolution. No network, and nothing is ever written.

const imageInfo = require('./image-info');

const MAX_CARDS = 500;
// More same-sized files than this and the size says nothing; don't read them all.
const MAX_SAME_SIZE = 8;
const DIMENSIONS_CACHE = 2000;

function text(value) {
  return value == null ? '' : String(value);
}

function fingerprintOf(card) {
  const md5 = text(card && card.md5).trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(md5) ? md5 : '';
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * @param {{
 *   finder: () => { byHash: (hash: string) => string, bySize: (size: number) => string[] },
 *   readHeader: (path: string) => Promise<Buffer>,
 *   recordFor?: (path: string) => { id: string, path: string } | null,
 *   logger?: { error: Function },
 * }} deps
 */
function create(deps) {
  const { finder, readHeader, recordFor = () => null, logger = console } = deps;
  const dimensions = new Map();

  // By path AND size: a file replaced by another of a different size is read again.
  async function dimensionsOf(filePath, size) {
    const cacheKey = filePath + '|' + size;
    if (dimensions.has(cacheKey)) return dimensions.get(cacheKey);
    let value = { width: 0, height: 0 };
    try { value = imageInfo.readDimensions(await readHeader(filePath)); }
    catch { return value; } // unreadable now — maybe not later, so not remembered
    dimensions.set(cacheKey, value);
    while (dimensions.size > DIMENSIONS_CACHE) dimensions.delete(dimensions.keys().next().value);
    return value;
  }

  async function bySizeAndResolution(find, size, width, height) {
    const same = find.bySize(size);
    if (!same.length || same.length > MAX_SAME_SIZE) return '';
    for (const filePath of same) {
      const d = await dimensionsOf(filePath, size);
      if (d.width === width && d.height === height) return filePath;
    }
    return '';
  }

  // `cards` is [{ key, md5?, fileSize?, width?, height? }]. The answer has an entry for every
  // card asked: { path, id } when the user has it, null when not.
  async function match(cards) {
    const list = Array.isArray(cards) ? cards.slice(0, MAX_CARDS) : [];
    const out = {};
    let find;
    try { find = finder(); } catch (err) {
      logger.error('online-have: finder:', err);
      return out;
    }
    for (const card of list) {
      const key = text(card && card.key);
      if (!key || Object.prototype.hasOwnProperty.call(out, key)) continue;
      let filePath = '';
      try {
        const md5 = fingerprintOf(card);
        if (md5) filePath = find.byHash(md5);
        else {
          const size = positive(card.fileSize);
          const width = positive(card.width);
          const height = positive(card.height);
          if (size && width && height) filePath = await bySizeAndResolution(find, size, width, height);
        }
      } catch (err) {
        logger.error('online-have: match:', err);
        filePath = '';
      }
      if (!filePath) { out[key] = null; continue; }
      const record = recordFor(filePath);
      out[key] = { path: filePath, id: record && record.id ? String(record.id) : '' };
    }
    return out;
  }

  return Object.freeze({ match });
}

module.exports = { MAX_CARDS, MAX_SAME_SIZE, fingerprintOf, create };
