'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JustifiedLayout = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  function finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // Card dimensions are serialized to two CSS decimals by renderer.js. Rounding every
  // item independently can make a mathematically exact row 0.01px wider than its
  // container, which makes flex-wrap push the last card onto the next line. Quantize
  // inside the layout and give the final item the remaining width so the row geometry
  // used by virtualization always matches the browser's physical rows.
  function roundCssPx(value) {
    return Math.round(value * 100) / 100;
  }

  function floorCssPx(value) {
    return Math.floor(value * 100 + 1e-7) / 100;
  }

  function normalizeAspect(value, minAspect = 0.5, maxAspect = 3) {
    const n = Number(value);
    return clamp(Number.isFinite(n) && n > 0 ? n : 1.6, minAspect, maxAspect);
  }

  // Row-aware layout: one { width, height } box per aspect PLUS the row list
  // ({ start, end, top, height } — `end` exclusive) and the grid's total height.
  // The virtualized Library grid needs the row geometry to know which cards fall
  // into the viewport without materializing any DOM. Same row-breaking algorithm
  // as always: complete rows fill the container; the final row keeps the target
  // height and stays left-aligned instead of stretching.
  function layoutRows(aspects, containerWidth, options = {}) {
    const width = Math.max(1, finite(containerWidth, 1));
    const gap = Math.max(0, finite(options.gap, 12));
    const targetHeight = Math.max(1, finite(options.targetHeight, 160));
    const minAspect = Math.max(0.05, finite(options.minAspect, 0.5));
    const maxAspect = Math.max(minAspect, finite(options.maxAspect, 3));
    const safeAspects = (Array.isArray(aspects) ? aspects : [])
      .map((aspect) => normalizeAspect(aspect, minAspect, maxAspect));
    const boxes = new Array(safeAspects.length);
    const rows = [];
    let rowStart = 0;
    let rowSum = 0;

    function finish(end, fill) {
      const count = end - rowStart;
      if (count <= 0) return;
      const available = Math.max(1, width - gap * (count - 1));
      const fittedHeight = available / rowSum;
      const height = fill ? fittedHeight : Math.min(targetHeight, fittedHeight);
      const cssHeight = roundCssPx(height);
      const cssAvailable = floorCssPx(available);
      let usedWidth = 0;
      for (let i = rowStart; i < end; i++) {
        const isLast = i === end - 1;
        const rawWidth = safeAspects[i] * height;
        const cssWidth = fill && isLast
          ? floorCssPx(cssAvailable - usedWidth)
          : floorCssPx(rawWidth);
        boxes[i] = { width: Math.max(0.01, cssWidth), height: cssHeight };
        usedWidth += boxes[i].width;
      }
      rows.push({ start: rowStart, end, top: 0, height: cssHeight });
      rowStart = end;
      rowSum = 0;
    }

    for (let i = 0; i < safeAspects.length; i++) {
      const aspect = safeAspects[i];
      rowSum += aspect;
      const count = i - rowStart + 1;
      const available = Math.max(1, width - gap * (count - 1));
      const height = available / rowSum;
      if (height <= targetHeight) {
        if (count > 1) {
          const previousAvailable = Math.max(1, width - gap * (count - 2));
          const previousHeight = previousAvailable / (rowSum - aspect);
          if (Math.abs(previousHeight - targetHeight) < Math.abs(height - targetHeight)) {
            rowSum -= aspect;
            finish(i, true);
            rowStart = i;
            rowSum = aspect;
            continue;
          }
        }
        finish(i + 1, true);
      }
    }
    finish(safeAspects.length, false);

    let top = 0;
    for (const row of rows) {
      row.top = top;
      top += row.height + gap;
    }
    const totalHeight = rows.length ? top - gap : 0;
    return { boxes, rows, totalHeight, gap };
  }

  // Returns one { width, height } box per aspect (historic API; delegates to
  // layoutRows so the two can never drift apart).
  function layout(aspects, containerWidth, options = {}) {
    return layoutRows(aspects, containerWidth, options).boxes;
  }

  return { normalizeAspect, layout, layoutRows };
});
