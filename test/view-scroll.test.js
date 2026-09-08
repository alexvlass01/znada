'use strict';

// Plain Node test: `node test/view-scroll.test.js`.
//
// BUG-040, the owner's complaint of 2026-09-02: leaving the Online rail and coming back
// put the feed at the very top again. Two separate causes, both checked here — the
// remembered position was per TAB rather than per list, and the feed itself was thrown
// away on the way out, so there was nothing to come back to.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ViewScroll = require('../renderer/view-scroll');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; };

// ---------------------------------------------------------------------------
// One position per list.
// ---------------------------------------------------------------------------
{
  const mem = ViewScroll.createViewScrollMemory();
  mem.remember('online', 1840);
  mem.remember('all', 320);
  ok('each list keeps its own position', mem.recall('online') === 1840 && mem.recall('all') === 320);
  ok('a list nobody has scrolled opens at the top', mem.recall('folder') === 0);

  mem.remember('online', 2600);
  ok('a later visit replaces the earlier position', mem.recall('online') === 2600);

  // A new search replaces the contents, so the old number points into results that are
  // no longer there.
  mem.forget('online');
  ok('a list can be told to forget', mem.recall('online') === 0 && mem.recall('all') === 320);
}

// The scroll value arrives from the DOM, so it must be treated as untrusted.
{
  const mem = ViewScroll.createViewScrollMemory();
  mem.remember('all', -50);
  mem.remember('fav', NaN);
  mem.remember('folder', 'high');
  mem.remember('tag', 12.7);
  ok('nonsense positions become the top rather than propagating',
    mem.recall('all') === 0 && mem.recall('fav') === 0 && mem.recall('folder') === 0);
  ok('a fractional position is kept as a whole number', mem.recall('tag') === 12);

  mem.remember('', 900);
  mem.remember(null, 900);
  ok('a list with no identity is not remembered — it would hand its position to another',
    mem.size() === 4 && mem.recall('') === 0 && mem.recall(null) === 0);
  ok('and cannot be recalled or forgotten by accident either',
    mem.recall(undefined) === 0 && (mem.forget(''), mem.size() === 4));
}

// ---------------------------------------------------------------------------
// Bounded: a tag is a list too, and the rail can hold hundreds of them.
// ---------------------------------------------------------------------------
{
  const mem = ViewScroll.createViewScrollMemory(3);
  mem.remember('a', 10); mem.remember('b', 20); mem.remember('c', 30);
  mem.remember('d', 40);
  ok('the oldest is dropped once the limit is reached',
    mem.size() === 3 && mem.recall('a') === 0 && mem.recall('d') === 40);

  // Returning to a list must keep it alive, or the one place the user actually goes back
  // to is the one that gets evicted.
  const keep = ViewScroll.createViewScrollMemory(3);
  keep.remember('online', 500); keep.remember('all', 10); keep.remember('fav', 20);
  keep.recall('online');
  keep.remember('tags', 30);
  ok('a list the user keeps returning to survives, and a stale one goes instead',
    keep.recall('online') === 500 && keep.recall('all') === 0);

  ok('a silly limit falls back to the default rather than breaking',
    ViewScroll.createViewScrollMemory(0).size() === 0
    && ViewScroll.createViewScrollMemory(-4) && ViewScroll.createViewScrollMemory('lots'));
  ok('the default limit is a real number', ViewScroll.DEFAULT_LIMIT > 1);
}

// ---------------------------------------------------------------------------
// Wiring.
// ---------------------------------------------------------------------------
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

ok('the window loads the module', html.includes('view-scroll.js'));
ok('the Library keeps one position per list rather than one per tab',
  renderer.includes('const libViewScroll = window.ViewScroll.createViewScrollMemory();')
  && renderer.includes('libViewScroll.remember(leavingKey, currentLibraryScrollTop());')
  && renderer.includes('const resumeAt = libViewScroll.recall(viewKey);'));
// The position is read from the page, NOT from `pageScroll.library`. That field only
// receives a value when the grid restores an anchor or when a tab switch samples it, so
// between those it sits at zero however far the user has scrolled — the first version of
// this fix remembered every list as "the top" and passed every unit test doing it.
ok('the position comes from the page itself, not from the tab-switch bookkeeping',
  renderer.includes('function currentLibraryScrollTop() {')
  && renderer.includes('return root ? root.scrollTop : pageScroll.library;')
  && !renderer.includes('libViewScroll.remember(leavingKey, pageScroll.library)'));
// The Online feed has two lists behind one rail button.
ok('search results and cloud favourites count as different lists',
  renderer.includes("if (LIB.filter === 'online') parts.push(ONLINE.view || 'search');"));

// The position cannot be applied before the grid exists — the page is still as tall as
// the list being left, and the browser clamps anything larger to its bottom.
ok('the position is applied after a grid mount, not before',
  renderer.includes('applyPendingLibraryScroll();')
  && renderer.indexOf('applyPendingLibraryScroll();') > renderer.indexOf('libLazyKick = kick;'));
ok('the attempt survives a first mount that is still too short',
  renderer.includes('if (root.scrollTop >= want - 2) pendingLibraryScroll = null;'));
ok('and gives up rather than grabbing the scrollbar later on',
  renderer.includes('if (Date.now() > pendingLibraryScroll.until) { pendingLibraryScroll = null; return; }'));
ok('the user taking hold of the list cancels it',
  renderer.includes('cancelPendingLibraryScroll();'));

// The bigger half of the defect: the feed was DELETED on the way out.
ok('leaving the Online rail no longer throws the feed away outright',
  !/ONLINE\.loaded = false; \/\/ re-fetch fresh signed URLs next time Online opens/.test(renderer)
  && renderer.includes("const keepable = ONLINE.entries.filter((entry) => entry && entry.kind !== 'cloud');"));
// A catalogue card's preview is a signed link with a lifetime this window does not know,
// so only THOSE cards go. Dropping the whole feed whenever one was present was the first
// attempt, and on the owner's bench that meant always: staging puts two in every feed.
ok('only the catalogue cards are dropped, and the rest of the feed survives',
  renderer.includes('if (keepable.length !== ONLINE.entries.length) ONLINE.entries = keepable;'));
ok('a feed left with nothing is asked for again, and its position dropped',
  renderer.includes('if (!ONLINE.entries.length) {\n    ONLINE.loaded = false;')
  && renderer.includes('libViewScroll.forget(leavingKey);'));
// Kept cards are data; their grid is not, so it has to be built again on return.
ok('a kept feed is rebuilt when the rail comes back',
  renderer.includes("renderOnlineEntries({ fresh: true });\n  finalizeOnlineFeed();"));

console.log('\nAll ' + passed + ' view-scroll tests passed.');
