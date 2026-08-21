'use strict';

const DEFAULT_MAX_GALLERY_ITEMS = 500;

function clampIndex(length, index) {
  if (!length) return 0;
  const n = Number(index);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(length - 1, Math.floor(n)));
}

function windowItemsAroundIndex(items, index, maxItems = DEFAULT_MAX_GALLERY_ITEMS) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(1, Math.floor(Number(maxItems) || DEFAULT_MAX_GALLERY_ITEMS));
  const safeIndex = clampIndex(list.length, index);
  if (list.length <= max) return { items: list.slice(), index: safeIndex, start: 0 };

  const half = Math.floor(max / 2);
  const start = Math.max(0, Math.min(safeIndex - half, list.length - max));
  return {
    items: list.slice(start, start + max),
    index: safeIndex - start,
    start,
  };
}

function sanitizeGalleryPayload(payload, options = {}) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const windowed = windowItemsAroundIndex(rawItems, raw.index, options.maxItems || DEFAULT_MAX_GALLERY_ITEMS);
  const safeItems = windowed.items.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const rawItem = item.raw && typeof item.raw === 'object' ? item.raw : {};
    return {
      kind: String(item.kind || ''),
      key: String(item.key || ''),
      title: String(item.title || '').slice(0, 300),
      subtitle: String(item.subtitle || '').slice(0, 300),
      path: typeof item.path === 'string' ? item.path : '',
      previewUrl: typeof item.previewUrl === 'string' ? item.previewUrl : '',
      query: typeof item.query === 'string' ? item.query.slice(0, 500) : '',
      added: !!item.added,
      raw: rawItem,
    };
  }).filter(Boolean);

  return {
    items: safeItems,
    index: safeItems.length ? Math.max(0, Math.min(safeItems.length - 1, windowed.index)) : 0,
  };
}

module.exports = {
  DEFAULT_MAX_GALLERY_ITEMS,
  clampIndex,
  windowItemsAroundIndex,
  sanitizeGalleryPayload,
};
