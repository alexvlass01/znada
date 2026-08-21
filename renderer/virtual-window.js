'use strict';

// Pure math for the virtualized Library grid: which justified-layout rows fall into
// the (overscanned) viewport, and how tall the two flex spacers must be so the rows
// OUTSIDE that window keep the scrollbar and scroll offsets exactly where a fully
// materialized grid would put them. No DOM here — renderer.js applies the result,
// and plain-node tests drive it directly.
//
// Spacer math accounts for the flex `gap`: a spacer that stands in for rows
// 0..first-1 must be sum(heights) + gap*(first-1) tall, because the flex container
// inserts one more gap between the spacer and the first real row (same at the bottom).

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VirtualWindow = api;
})(typeof window !== 'undefined' ? window : null, function createApi() {
  // Preserve the established 142 / 160 / 178px density plateaus, but blend into
  // the larger value just before each old breakpoint. A one-pixel resize at
  // 699/700 or 999/1000 must not change the preferred row height by 18px at once.
  function responsiveTargetHeight(width) {
    const w = Number(width);
    if (!Number.isFinite(w) || w <= 660) return 142;
    if (w < 700) {
      const t = (w - 660) / 40;
      const eased = t * t * (3 - 2 * t);
      return 142 + 18 * eased;
    }
    if (w <= 960) return 160;
    if (w < 1000) {
      const t = (w - 960) / 40;
      const eased = t * t * (3 - 2 * t);
      return 160 + 18 * eased;
    }
    return 178;
  }

  // rows: [{ start, end, top, height }] from JustifiedLayout.layoutRows (tops ascending).
  // Returns the inclusive row range intersecting [viewTop, viewBottom], clamped so that
  // SOMETHING is always materialized when rows exist (an out-of-range scroll position
  // during relayout must not blank the grid). Empty rows → { first: 0, last: -1 }.
  function rowRangeForViewport(rows, viewTop, viewBottom) {
    const n = Array.isArray(rows) ? rows.length : 0;
    if (!n) return { first: 0, last: -1 };
    const top = Number.isFinite(viewTop) ? viewTop : 0;
    const bottom = Math.max(top, Number.isFinite(viewBottom) ? viewBottom : top);

    // first = the first row whose bottom edge is below viewTop.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].top + rows[mid].height <= top) lo = mid + 1;
      else hi = mid;
    }
    const first = lo;

    // last = the last row whose top edge is above viewBottom.
    lo = first;
    hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rows[mid].top < bottom) lo = mid;
      else hi = mid - 1;
    }
    let last = lo;
    if (rows[last].top >= bottom && last > first) last = first;
    return { first, last };
  }

  // Spacer heights replacing the rows outside [first, last]. `top === 0` /
  // `bottom === 0` means "no spacer needed" — the caller must REMOVE the element
  // then (a zero-height flex item would still occupy a row and add a stray gap).
  function padHeights(rows, first, last, gap, totalHeight) {
    const n = Array.isArray(rows) ? rows.length : 0;
    const g = Math.max(0, Number(gap) || 0);
    if (!n || last < first) return { top: 0, bottom: 0 };
    const total = Number.isFinite(totalHeight)
      ? totalHeight
      : rows[n - 1].top + rows[n - 1].height;
    const top = first > 0 ? Math.max(0, rows[first].top - g) : 0;
    const bottom = last < n - 1
      ? Math.max(0, total - (rows[last].top + rows[last].height) - g)
      : 0;
    return { top, bottom };
  }

  // Inclusive card-index range covered by the row range ({ 0, -1 } when empty).
  function cardRangeForRows(rows, first, last) {
    if (!Array.isArray(rows) || !rows.length || last < first) return { first: 0, last: -1 };
    return { first: rows[first].start, last: rows[last].end - 1 };
  }

  // During a live resize keep the rows that already own materialized cards in the
  // DOM as well as the rows required by the new viewport. Width-dependent row
  // breaks can otherwise make boundary cards detach/rebuild on alternating frames,
  // which is visible as thumbnail blinking even though their data URL is cached.
  function expandRowRangeForCards(rows, range, firstCard, lastCard) {
    const n = Array.isArray(rows) ? rows.length : 0;
    if (!n) return { first: 0, last: -1 };
    let first = Number.isInteger(range && range.first) ? range.first : 0;
    let last = Number.isInteger(range && range.last) ? range.last : first;
    first = Math.max(0, Math.min(n - 1, first));
    last = Math.max(first, Math.min(n - 1, last));

    const retainedFirst = rowIndexForCard(rows, firstCard);
    const retainedLast = rowIndexForCard(rows, lastCard);
    if (retainedFirst >= 0) first = Math.min(first, retainedFirst);
    if (retainedLast >= 0) last = Math.max(last, retainedLast);
    return { first, last };
  }

  // Find the justified-layout row containing a combined virtual card index.
  // Keeping this as pure math lets renderer restore a logical scroll anchor even
  // when virtualization removed the old DOM card during a resize relayout.
  function rowIndexForCard(rows, cardIndex) {
    const n = Array.isArray(rows) ? rows.length : 0;
    const index = Number(cardIndex);
    if (!n || !Number.isInteger(index) || index < 0) return -1;
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const row = rows[mid];
      if (index < row.start) hi = mid - 1;
      else if (index >= row.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  // Absolute scrollTop that keeps the anchored card row at the same viewport Y.
  // gridTop is the grid's position in scroll-content coordinates; anchorTop is the
  // card row's desired position relative to the scroll viewport.
  function scrollTopForCardAnchor(rows, cardIndex, gridTop, anchorTop) {
    const rowIndex = rowIndexForCard(rows, cardIndex);
    const grid = Number(gridTop);
    const top = Number(anchorTop);
    if (rowIndex < 0 || !Number.isFinite(grid) || !Number.isFinite(top)) return null;
    return Math.max(0, grid + rows[rowIndex].top - top);
  }

  // Project the viewport directly from a logical card anchor before touching the
  // DOM. During a deep shrink the OLD pixel scrollTop points at a completely
  // different card in the NEW, taller geometry; materializing that false viewport
  // first can bridge thousands of cards to the real anchor. This plan lets the
  // renderer build the bounded anchored window first, which also establishes the
  // new spacer extent before assigning the (possibly much larger) scrollTop.
  function windowForCardAnchor(rows, cardIndex, gridTop, anchorTop, viewportHeight, overscan = 0) {
    const grid = Number(gridTop);
    const target = scrollTopForCardAnchor(rows, cardIndex, grid, anchorTop);
    if (!Number.isFinite(target) || !Number.isFinite(grid)) return null;
    const height = Math.max(0, Number(viewportHeight) || 0);
    const pad = Math.max(0, Number(overscan) || 0);
    const relativeTop = target - grid;
    const range = rowRangeForViewport(rows, relativeTop - pad, relativeTop + height + pad);
    return { scrollTop: target, first: range.first, last: range.last };
  }

  return {
    responsiveTargetHeight,
    rowRangeForViewport,
    padHeights,
    cardRangeForRows,
    expandRowRangeForCards,
    rowIndexForCard,
    scrollTopForCardAnchor,
    windowForCardAnchor,
  };
});
