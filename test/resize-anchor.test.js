'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ResizeAnchor = require('../renderer/resize-anchor');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  ✓ ' + name); passed++; };

const session = ResizeAnchor.createSession();
const first = { key: 'path:first.jpg', combinedIndex: 137, top: -24 };
const shifted = { key: 'path:shifted.jpg', combinedIndex: 143, top: -24 };

const start = session.begin(first);
ok('first resize event starts a session with its logical anchor', start.anchor === first);

const observer = session.begin(shifted);
ok('later resize and observer events retain the first anchor', observer.anchor === first);
ok('later events advance the revision', observer.revision > start.revision);
ok('a stale settle callback cannot finish a newer resize revision', session.finish(start.revision) === null);

const touched = session.touch();
ok('observer relayout touches keep the same anchor', touched.anchor === first);
ok('observer relayout invalidates an older settle callback', session.finish(observer.revision) === null);

ok('the latest settle callback finishes the original anchor', session.finish(touched.revision) === first);
ok('a finished session becomes inactive', session.current() === null);

// The renderer keeps the finished logical anchor as its view anchor. A wider row
// can prepend another card (`shifted`), but the following restore burst must start
// from the original card until a real user scroll replaces it.
const preservedViewAnchor = first;
const restarted = session.begin(preservedViewAnchor || shifted);
ok('a later restore/maximize burst reuses the preserved logical anchor', restarted.anchor === first);
ok('explicit user interaction cancels the active anchor', session.cancel() === first && session.current() === null);
ok('cancelled sessions reject delayed settle callbacks', session.finish(restarted.revision) === null);

const afterScroll = session.begin(shifted);
ok('a later user scroll can establish a genuinely new anchor', afterScroll.anchor === shifted);
session.cancel();

const rendererHtml = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const modulePos = rendererHtml.indexOf('<script src="resize-anchor.js"></script>');
const rendererPos = rendererHtml.indexOf('<script src="renderer.js"></script>');
ok('resize-anchor runtime loads before renderer.js', modulePos >= 0 && rendererPos > modulePos);

// Runtime ordering guards for the asymmetric shrink path. A debounced shrink
// commit lets Chromium paint the stale flex-wrap first; assigning scrollTop before
// the new virtual pads exist lets the browser clamp a deep logical anchor.
const rendererJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const unifiedJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'unified-grid.js'), 'utf8');
const windowResize = rendererJs.indexOf("window.addEventListener('resize', () => {");
const shrinkBranch = rendererJs.indexOf('grid.clientWidth < liveVirtual.layoutWidth - 0.5', windowResize);
const shrinkLayout = rendererJs.indexOf('layoutLibGrid(grid);', shrinkBranch);
const resizeDebounce = rendererJs.indexOf('resizeT = setTimeout', shrinkBranch);
ok('window shrink relayout commits synchronously before the resize debounce',
  windowResize >= 0 && shrinkBranch > windowResize && shrinkLayout > shrinkBranch
  && resizeDebounce > shrinkLayout);
ok('a stale deferred width frame rechecks whether synchronous shrink already won',
  unifiedJs.includes('if (!isValid() || Math.abs(grid.clientWidth - state.layoutWidth) < 0.5) return;'));
ok('only shrink passes the logical anchor into the one-pass virtual relayout',
  rendererJs.includes('anchor: shrinking ? scrollAnchor : null'));

const anchorPlan = unifiedJs.indexOf('const anchor = normalizedAnchor(opts.anchor);');
const extentCommit = unifiedJs.indexOf('applyWindow(range.first, range.last);', anchorPlan);
const scrollCommit = unifiedJs.indexOf('scrollRoot.scrollTop = plan.scrollTop;', anchorPlan);
ok('deep shrink establishes the new virtual DOM extent before assigning scrollTop',
  anchorPlan >= 0 && extentCommit > anchorPlan && scrollCommit > extentCommit);
const actualClampCheck = unifiedJs.indexOf(
  'Math.abs(scrollRoot.scrollTop - plan.scrollTop) >= 0.5',
  scrollCommit
);
const clampRefresh = unifiedJs.indexOf('updateWindow(true);', actualClampCheck);
ok('a bottom-clamped anchor is reconciled synchronously against the actual viewport',
  actualClampCheck > scrollCommit && clampRefresh > actualClampCheck);

console.log('\nAll ' + passed + ' resize-anchor tests passed.');
