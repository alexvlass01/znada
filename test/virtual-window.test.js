'use strict';

const assert = require('assert');
const J = require('../renderer/justified-layout');
const V = require('../renderer/virtual-window');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  ✓ ' + name); passed++; };
const near = (a, b, epsilon = 0.01) => Math.abs(a - b) <= epsilon;

// A realistic grid: 300 landscape cards, ~5 per row → 60 rows of ~190px + 10px gap.
const { rows, totalHeight, gap } = J.layoutRows(new Array(300).fill(1.6), 1000, { gap: 10, targetHeight: 178 });
ok('fixture produced a tall multi-row grid', rows.length >= 50 && totalHeight > 5000);

// --- responsive target height has no 18px one-pixel breakpoint jumps ---
ok('responsive height preserves the established density plateaus',
  V.responsiveTargetHeight(560) === 142
  && V.responsiveTargetHeight(700) === 160
  && V.responsiveTargetHeight(900) === 160
  && V.responsiveTargetHeight(1000) === 178);
ok('responsive height is continuous at the former 700/1000 breakpoints',
  Math.abs(V.responsiveTargetHeight(699.99) - V.responsiveTargetHeight(700)) < 0.01
  && Math.abs(V.responsiveTargetHeight(999.99) - V.responsiveTargetHeight(1000)) < 0.01);
const responsiveWidths = [500, 660, 670, 680, 690, 700, 900, 960, 970, 980, 990, 1000, 1200];
ok('responsive height remains monotonic across both blends', responsiveWidths.every((width, index) =>
  index === 0 || V.responsiveTargetHeight(width) >= V.responsiveTargetHeight(responsiveWidths[index - 1])));

// --- rowRangeForViewport ---
const atTop = V.rowRangeForViewport(rows, -1600, 800 + 1600);
ok('window at the top starts at row 0', atTop.first === 0 && atTop.last > 0 && atTop.last < rows.length - 1);

const mid = V.rowRangeForViewport(rows, 4000, 4800);
ok('mid-scroll window excludes rows above and below', mid.first > 0 && mid.last < rows.length - 1 && mid.first <= mid.last);
ok('first row of the window really intersects the viewport',
  rows[mid.first].top + rows[mid.first].height > 4000 && rows[mid.first].top < 4800);
ok('row before the window is fully above the viewport', rows[mid.first - 1].top + rows[mid.first - 1].height <= 4000);
ok('row after the window is fully below the viewport', rows[mid.last + 1].top >= 4800);

const atEnd = V.rowRangeForViewport(rows, totalHeight - 500, totalHeight + 2000);
ok('window at the bottom ends at the last row', atEnd.last === rows.length - 1);

const beyond = V.rowRangeForViewport(rows, totalHeight + 5000, totalHeight + 6000);
ok('scroll far beyond the end clamps to a real row instead of blanking', beyond.first === rows.length - 1 && beyond.last === rows.length - 1);

const before = V.rowRangeForViewport(rows, -9000, -8000);
ok('viewport above the grid clamps to the first row', before.first === 0 && before.last === 0);

ok('empty rows produce an empty range', V.rowRangeForViewport([], 0, 100).last === -1);

// --- padHeights: spacers must reproduce the exact scroll geometry ---
const pads = V.padHeights(rows, mid.first, mid.last, gap, totalHeight);
// Materialized block: topPad + gap + rows[first..last] + gap + bottomPad == totalHeight.
const windowHeight = rows[mid.last].top + rows[mid.last].height - rows[mid.first].top;
ok('top pad + gap lands the first window row at its true offset', near(pads.top + gap, rows[mid.first].top));
ok('pads + window + gaps reconstruct the full grid height',
  near(pads.top + gap + windowHeight + gap + pads.bottom, totalHeight));

const topPads = V.padHeights(rows, 0, mid.last, gap, totalHeight);
ok('window touching the top needs no top pad', topPads.top === 0 && topPads.bottom > 0);

const bottomPads = V.padHeights(rows, mid.first, rows.length - 1, gap, totalHeight);
ok('window touching the bottom needs no bottom pad', bottomPads.bottom === 0 && bottomPads.top > 0);

const allPads = V.padHeights(rows, 0, rows.length - 1, gap, totalHeight);
ok('fully materialized grid needs no pads', allPads.top === 0 && allPads.bottom === 0);

ok('empty range needs no pads', V.padHeights(rows, 3, 2, gap, totalHeight).top === 0);

// --- cardRangeForRows ---
const cardRange = V.cardRangeForRows(rows, mid.first, mid.last);
ok('card range maps rows to inclusive card indices',
  cardRange.first === rows[mid.first].start && cardRange.last === rows[mid.last].end - 1);
ok('empty row range maps to an empty card range', V.cardRangeForRows(rows, 0, -1).last === -1);

// --- live resize retention: an already materialized boundary must not churn ---
const anchorCard = 137;
const retained = V.cardRangeForRows(rows, mid.first, mid.last);
const resizeWidths = [718, 1698, 1068, 558, 1122]; // grid widths from the owner QA window sequence
let retainedFirst = retained.first;
let retainedLast = retained.last;
for (const width of resizeWidths) {
  const resized = J.layoutRows(new Array(300).fill(1.6), width, {
    gap: 10,
    targetHeight: V.responsiveTargetHeight(width),
  });
  const anchorRow = resized.rows[V.rowIndexForCard(resized.rows, anchorCard)];
  const viewport = V.rowRangeForViewport(resized.rows, anchorRow.top - 1600, anchorRow.top + 900 + 1600);
  const expanded = V.expandRowRangeForCards(resized.rows, viewport, retainedFirst, retainedLast);
  const cards = V.cardRangeForRows(resized.rows, expanded.first, expanded.last);
  assert.ok(cards.first <= retainedFirst && cards.last >= retainedLast,
    `resize width ${width} retains every previously materialized boundary card`);
  assert.ok(expanded.first <= expanded.last && cards.first <= anchorCard && cards.last >= anchorCard,
    `resize width ${width} keeps a non-empty window around the logical anchor`);
  retainedFirst = cards.first;
  retainedLast = cards.last;
}
ok('owner QA width sequence keeps one expanding DOM window through the resize burst', true);

// --- logical scroll anchor survives a width-dependent relayout ---
const oldRowIndex = V.rowIndexForCard(rows, anchorCard);
ok('row lookup finds the row containing a virtual card',
  oldRowIndex >= 0 && rows[oldRowIndex].start <= anchorCard && rows[oldRowIndex].end > anchorCard);
ok('row lookup rejects cards outside the layout',
  V.rowIndexForCard(rows, -1) === -1 && V.rowIndexForCard(rows, 9999) === -1);

const gridTop = 260;
const desiredViewportTop = 34;
const narrower = J.layoutRows(new Array(300).fill(1.6), 720, { gap: 10, targetHeight: 160 });
const restoredScrollTop = V.scrollTopForCardAnchor(
  narrower.rows,
  anchorCard,
  gridTop,
  desiredViewportTop
);
const newRow = narrower.rows[V.rowIndexForCard(narrower.rows, anchorCard)];
ok('logical anchor keeps the same card row at the same viewport position after relayout',
  near(gridTop + newRow.top - restoredScrollTop, desiredViewportTop));
ok('invalid logical anchors do not produce a scroll target',
  V.scrollTopForCardAnchor(narrower.rows, 9999, gridTop, desiredViewportTop) === null);

const wider = J.layoutRows(new Array(300).fill(1.6), 1400, { gap: 10, targetHeight: 178 });
const widenedScrollTop = V.scrollTopForCardAnchor(wider.rows, anchorCard, gridTop, desiredViewportTop);
const widenedRow = wider.rows[V.rowIndexForCard(wider.rows, anchorCard)];
ok('the same logical card survives a second wider resize burst',
  near(gridTop + widenedRow.top - widenedScrollTop, desiredViewportTop));
const roundTripScrollTop = V.scrollTopForCardAnchor(rows, anchorCard, gridTop, desiredViewportTop);
const roundTripRow = rows[V.rowIndexForCard(rows, anchorCard)];
ok('the same logical card survives a width round trip',
  near(gridTop + roundTripRow.top - roundTripScrollTop, desiredViewportTop));

// --- deep shrink must plan from the logical anchor, never the stale pixel viewport ---
// At a deep scroll position, interpreting the OLD scrollTop in the NEW, much taller
// shrink geometry points at unrelated cards. Joining that false viewport to the
// retained anchor window used to materialize thousands of cards for a single frame.
const deepAspects = new Array(5000).fill(1.6);
const deepAnchor = 4000;
const deepGridTop = 260;
const deepAnchorTop = 34;
const deepViewportHeight = 900;
const deepOverscan = 1600;
const deepWide = J.layoutRows(deepAspects, 1122, {
  gap: 10,
  targetHeight: V.responsiveTargetHeight(1122),
});
const deepWidePlan = V.windowForCardAnchor(
  deepWide.rows,
  deepAnchor,
  deepGridTop,
  deepAnchorTop,
  deepViewportHeight,
  deepOverscan
);
const deepWideCards = V.cardRangeForRows(deepWide.rows, deepWidePlan.first, deepWidePlan.last);
const deepNarrow = J.layoutRows(deepAspects, 558, {
  gap: 10,
  targetHeight: V.responsiveTargetHeight(558),
});

const staleViewport = V.rowRangeForViewport(
  deepNarrow.rows,
  deepWidePlan.scrollTop - deepGridTop - deepOverscan,
  deepWidePlan.scrollTop - deepGridTop + deepViewportHeight + deepOverscan
);
const staleUnion = V.expandRowRangeForCards(
  deepNarrow.rows,
  staleViewport,
  deepWideCards.first,
  deepWideCards.last
);
const staleCards = V.cardRangeForRows(deepNarrow.rows, staleUnion.first, staleUnion.last);
ok('the old pixel-first shrink order reproduces a multi-thousand-card false bridge',
  staleCards.last - staleCards.first + 1 > 2000);

const deepNarrowPlan = V.windowForCardAnchor(
  deepNarrow.rows,
  deepAnchor,
  deepGridTop,
  deepAnchorTop,
  deepViewportHeight,
  deepOverscan
);
const anchoredUnion = V.expandRowRangeForCards(
  deepNarrow.rows,
  deepNarrowPlan,
  deepWideCards.first,
  deepWideCards.last
);
const anchoredCards = V.cardRangeForRows(deepNarrow.rows, anchoredUnion.first, anchoredUnion.last);
const deepAnchorRow = deepNarrow.rows[V.rowIndexForCard(deepNarrow.rows, deepAnchor)];
ok('anchor-first shrink keeps the active DOM window bounded',
  anchoredCards.last - anchoredCards.first + 1 < 200
  && anchoredCards.first <= deepAnchor && anchoredCards.last >= deepAnchor);
ok('anchor-first shrink preserves the requested viewport position',
  near(deepGridTop + deepAnchorRow.top - deepNarrowPlan.scrollTop, deepAnchorTop));
ok('invalid deep anchor plans are rejected',
  V.windowForCardAnchor(deepNarrow.rows, 9999, deepGridTop, deepAnchorTop,
    deepViewportHeight, deepOverscan) === null);

// The target scroll position can be far below the OLD DOM extent. The renderer
// therefore has to apply the new pads/cards first, then assign scrollTop.
const oldScrollMax = deepGridTop + deepWide.totalHeight - deepViewportHeight;
const newScrollMax = deepGridTop + deepNarrow.totalHeight - deepViewportHeight;
ok('old DOM extent would clamp the deep shrink anchor by more than 100k pixels',
  deepNarrowPlan.scrollTop - Math.min(deepNarrowPlan.scrollTop, oldScrollMax) > 100000);
ok('new DOM extent accepts the projected deep anchor', deepNarrowPlan.scrollTop <= newScrollMax);

// Slow one-pixel shrink is the owner's failure mode. Retaining the current cards
// must only grow a small boundary around the same logical anchor, never a bridge.
let retainedDeepFirst = deepWideCards.first;
let retainedDeepLast = deepWideCards.last;
let peakDeepCards = retainedDeepLast - retainedDeepFirst + 1;
let maxDeepAdditions = 0;
for (let width = 1121; width >= 558; width--) {
  const resized = J.layoutRows(deepAspects, width, {
    gap: 10,
    targetHeight: V.responsiveTargetHeight(width),
  });
  const plan = V.windowForCardAnchor(
    resized.rows,
    deepAnchor,
    deepGridTop,
    deepAnchorTop,
    deepViewportHeight,
    deepOverscan
  );
  const retained = V.expandRowRangeForCards(
    resized.rows,
    plan,
    retainedDeepFirst,
    retainedDeepLast
  );
  const cards = V.cardRangeForRows(resized.rows, retained.first, retained.last);
  const additions = Math.max(0, retainedDeepFirst - cards.first)
    + Math.max(0, cards.last - retainedDeepLast);
  maxDeepAdditions = Math.max(maxDeepAdditions, additions);
  peakDeepCards = Math.max(peakDeepCards, cards.last - cards.first + 1);
  retainedDeepFirst = cards.first;
  retainedDeepLast = cards.last;
}
ok('one-pixel deep shrink sweep stays below 200 active cards', peakDeepCards < 200);
ok('one-pixel deep shrink adds at most a small row boundary per frame', maxDeepAdditions <= 8);

// A real one-pixel packing cliff: six equal cards fit at 1598px, only five at
// 1597px, so every later row changes even though the width moved by one pixel.
const cliffWide = J.layoutRows(deepAspects, 1598, {
  gap: 10,
  targetHeight: V.responsiveTargetHeight(1598),
});
const cliffNarrow = J.layoutRows(deepAspects, 1597, {
  gap: 10,
  targetHeight: V.responsiveTargetHeight(1597),
});
const cliffWidePlan = V.windowForCardAnchor(
  cliffWide.rows, deepAnchor, deepGridTop, deepAnchorTop, deepViewportHeight, deepOverscan
);
const cliffWideCards = V.cardRangeForRows(cliffWide.rows, cliffWidePlan.first, cliffWidePlan.last);
const cliffStaleViewport = V.rowRangeForViewport(
  cliffNarrow.rows,
  cliffWidePlan.scrollTop - deepGridTop - deepOverscan,
  cliffWidePlan.scrollTop - deepGridTop + deepViewportHeight + deepOverscan
);
const cliffStaleUnion = V.expandRowRangeForCards(
  cliffNarrow.rows, cliffStaleViewport, cliffWideCards.first, cliffWideCards.last
);
const cliffStaleCards = V.cardRangeForRows(
  cliffNarrow.rows, cliffStaleUnion.first, cliffStaleUnion.last
);
const cliffPlan = V.windowForCardAnchor(
  cliffNarrow.rows, deepAnchor, deepGridTop, deepAnchorTop, deepViewportHeight, deepOverscan
);
const cliffUnion = V.expandRowRangeForCards(
  cliffNarrow.rows, cliffPlan, cliffWideCards.first, cliffWideCards.last
);
const cliffCards = V.cardRangeForRows(cliffNarrow.rows, cliffUnion.first, cliffUnion.last);
ok('1598→1597 fixture exercises the global one-pixel row-packing cliff',
  cliffWide.rows.length === 834 && cliffNarrow.rows.length === 1000);
ok('anchor-first planning bounds the one-pixel packing cliff below 200 cards',
  cliffStaleCards.last - cliffStaleCards.first + 1 > 1000
  && cliffCards.last - cliffCards.first + 1 < 200);

// Portrait-heavy rows legitimately need more cards to cover the same pixel
// overscan. The safety property is "bounded near the anchor", not a universal
// 200-card cap derived from the landscape fixture above.
const portraitAspects = new Array(5000).fill(0.65);
const portraitWide = J.layoutRows(portraitAspects, 1598, {
  gap: 10,
  targetHeight: V.responsiveTargetHeight(1598),
});
const portraitNarrow = J.layoutRows(portraitAspects, 1597, {
  gap: 10,
  targetHeight: V.responsiveTargetHeight(1597),
});
const portraitWidePlan = V.windowForCardAnchor(
  portraitWide.rows, deepAnchor, deepGridTop, -42, deepViewportHeight, deepOverscan
);
const portraitWideCards = V.cardRangeForRows(
  portraitWide.rows, portraitWidePlan.first, portraitWidePlan.last
);
const portraitPlan = V.windowForCardAnchor(
  portraitNarrow.rows, deepAnchor, deepGridTop, -42, deepViewportHeight, deepOverscan
);
const portraitUnion = V.expandRowRangeForCards(
  portraitNarrow.rows, portraitPlan, portraitWideCards.first, portraitWideCards.last
);
const portraitCards = V.cardRangeForRows(
  portraitNarrow.rows, portraitUnion.first, portraitUnion.last
);
ok('portrait-heavy overscan remains local even when it naturally exceeds 200 cards',
  portraitCards.last - portraitCards.first + 1 > 200
  && portraitCards.last - portraitCards.first + 1 < 400
  && portraitCards.first <= deepAnchor && portraitCards.last >= deepAnchor);

// The old 1000px target-height breakpoint is now blended, but mixed aspects can
// still move row boundaries there. Anchor-derived planning must remain bounded.
let pseudoSeed = 0x12345678;
const pseudoAspects = Array.from({ length: 5000 }, () => {
  pseudoSeed = (Math.imul(1664525, pseudoSeed) + 1013904223) >>> 0;
  return 0.65 + (pseudoSeed / 0x100000000) * 2.35;
});
const pseudoWide = J.layoutRows(pseudoAspects, 1000, {
  gap: 10,
  targetHeight: V.responsiveTargetHeight(1000),
});
const pseudoNarrow = J.layoutRows(pseudoAspects, 999, {
  gap: 10,
  targetHeight: V.responsiveTargetHeight(999),
});
const pseudoWidePlan = V.windowForCardAnchor(
  pseudoWide.rows, deepAnchor, deepGridTop, deepAnchorTop, deepViewportHeight, deepOverscan
);
const pseudoWideCards = V.cardRangeForRows(
  pseudoWide.rows, pseudoWidePlan.first, pseudoWidePlan.last
);
const pseudoPlan = V.windowForCardAnchor(
  pseudoNarrow.rows, deepAnchor, deepGridTop, deepAnchorTop, deepViewportHeight, deepOverscan
);
const pseudoUnion = V.expandRowRangeForCards(
  pseudoNarrow.rows, pseudoPlan, pseudoWideCards.first, pseudoWideCards.last
);
const pseudoCards = V.cardRangeForRows(pseudoNarrow.rows, pseudoUnion.first, pseudoUnion.last);
ok('1000→999 mixed-aspect boundary remains a bounded anchor window',
  pseudoNarrow.rows.length !== pseudoWide.rows.length
  && pseudoCards.last - pseudoCards.first + 1 < 200
  && pseudoCards.first <= deepAnchor && pseudoCards.last >= deepAnchor);

// Defensive bottom case: if a requested anchor is too close to the end, the
// browser clamps scrollTop. The follow-up window based on the ACTUAL value adds
// the two missing cards without ever creating a distant bridge.
const bottomViewportHeight = 2100;
const bottomAnchor = 4999;
const bottomWidePlan = V.windowForCardAnchor(
  deepWide.rows, bottomAnchor, deepGridTop, deepAnchorTop,
  bottomViewportHeight, deepOverscan
);
const bottomWideCards = V.cardRangeForRows(
  deepWide.rows, bottomWidePlan.first, bottomWidePlan.last
);
const bottomPlan = V.windowForCardAnchor(
  deepNarrow.rows, bottomAnchor, deepGridTop, deepAnchorTop,
  bottomViewportHeight, deepOverscan
);
const bottomPrepared = V.expandRowRangeForCards(
  deepNarrow.rows, bottomPlan, bottomWideCards.first, bottomWideCards.last
);
const bottomPreparedCards = V.cardRangeForRows(
  deepNarrow.rows, bottomPrepared.first, bottomPrepared.last
);
const bottomMaxScroll = deepGridTop + deepNarrow.totalHeight - bottomViewportHeight;
const bottomActualScroll = Math.min(bottomPlan.scrollTop, bottomMaxScroll);
const bottomActualViewport = V.rowRangeForViewport(
  deepNarrow.rows,
  bottomActualScroll - deepGridTop - deepOverscan,
  bottomActualScroll - deepGridTop + bottomViewportHeight + deepOverscan
);
const bottomCorrected = V.expandRowRangeForCards(
  deepNarrow.rows,
  bottomActualViewport,
  bottomPreparedCards.first,
  bottomPreparedCards.last
);
const bottomCorrectedCards = V.cardRangeForRows(
  deepNarrow.rows, bottomCorrected.first, bottomCorrected.last
);
ok('bottom clamp fixture really differs from the requested anchor scroll',
  bottomPlan.scrollTop - bottomActualScroll > 1000);
ok('actual-scroll correction covers the clamped viewport with a bounded delta',
  bottomCorrectedCards.first < bottomPreparedCards.first
  && bottomPreparedCards.first - bottomCorrectedCards.first <= 4
  && bottomCorrectedCards.last - bottomCorrectedCards.first + 1 < 200);

// A realistic bottom capture anchors the first partially visible row, not the
// final card. Its prepared overscan must fully cover the actual visible viewport.
const oldBottomScroll = deepGridTop + deepWide.totalHeight - deepViewportHeight;
const oldBottomVisible = V.rowRangeForViewport(
  deepWide.rows,
  oldBottomScroll - deepGridTop,
  oldBottomScroll - deepGridTop + deepViewportHeight
);
const realisticBottomRow = deepWide.rows[oldBottomVisible.first];
const realisticBottomAnchor = realisticBottomRow.start;
const realisticBottomTop = deepGridTop + realisticBottomRow.top - oldBottomScroll;
const realisticBottomWidePlan = V.windowForCardAnchor(
  deepWide.rows, realisticBottomAnchor, deepGridTop, realisticBottomTop,
  deepViewportHeight, deepOverscan
);
const realisticBottomWideCards = V.cardRangeForRows(
  deepWide.rows, realisticBottomWidePlan.first, realisticBottomWidePlan.last
);
const realisticBottomPlan = V.windowForCardAnchor(
  deepNarrow.rows, realisticBottomAnchor, deepGridTop, realisticBottomTop,
  deepViewportHeight, deepOverscan
);
const realisticBottomPrepared = V.expandRowRangeForCards(
  deepNarrow.rows,
  realisticBottomPlan,
  realisticBottomWideCards.first,
  realisticBottomWideCards.last
);
const realisticBottomMax = deepGridTop + deepNarrow.totalHeight - deepViewportHeight;
const realisticBottomActual = Math.min(realisticBottomPlan.scrollTop, realisticBottomMax);
const realisticBottomVisible = V.rowRangeForViewport(
  deepNarrow.rows,
  realisticBottomActual - deepGridTop,
  realisticBottomActual - deepGridTop + deepViewportHeight
);
ok('realistic first-visible bottom anchor fully covers the actual viewport',
  realisticBottomPrepared.first <= realisticBottomVisible.first
  && realisticBottomPrepared.last >= realisticBottomVisible.last);

// --- mixed aspect ratios keep the math consistent ---
const aspects = Array.from({ length: 500 }, (_, i) => [0.7, 1, 1.5, 2.4, 1.78][i % 5]);
const mixed = J.layoutRows(aspects, 860, { gap: 10, targetHeight: 160 });
for (let viewTop = -1000; viewTop < mixed.totalHeight + 1000; viewTop += 777) {
  const r = V.rowRangeForViewport(mixed.rows, viewTop, viewTop + 900);
  const p = V.padHeights(mixed.rows, r.first, r.last, 10, mixed.totalHeight);
  // Invariant 1: with the top spacer in place, the first materialized row sits at
  // its true offset inside the grid.
  const firstOffset = p.top > 0 ? p.top + 10 : 0;
  assert.ok(near(firstOffset, mixed.rows[r.first].top), `first-row offset holds at viewTop=${viewTop}`);
  // Invariant 2: spacers + materialized window + their joining gaps reconstruct the
  // exact total height, so the scrollbar never jumps as the window moves.
  const windowH = mixed.rows[r.last].top + mixed.rows[r.last].height - mixed.rows[r.first].top;
  const reconstructed = firstOffset + windowH + (p.bottom > 0 ? 10 + p.bottom : 0);
  assert.ok(near(reconstructed, mixed.totalHeight), `total height holds at viewTop=${viewTop}`);
}
ok('scroll sweep across mixed aspects keeps spacer geometry exact', true);

console.log('\nAll ' + passed + ' virtual-window tests passed.');
