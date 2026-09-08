'use strict';

// Plain Node test: `node test/auto-load.test.js`.
//
// ONL-003, the owner's complaint of 2026-09-02: "и кнопку убирай" — reaching the end of
// the online feed should load the next page instead of asking for a click.
//
// Every check here is about the one way this feature can go badly wrong. Scrolling to the
// bottom asks for more; if "more" adds nothing, the bottom is still the bottom and the
// next frame asks again. That is a request storm made out of one gesture, against three
// sites, and BUG-020 spent a whole task limiting exactly this kind of traffic. The owner
// asked for this change "максимально осторожно", so the loader is suspicious by design
// and these tests exist to keep it that way.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AutoLoad = require('../renderer/auto-load');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; };

const READY = { active: true, hasMore: true, loading: false, now: 100000 };

// ---------------------------------------------------------------------------
// When one more page may be asked for.
// ---------------------------------------------------------------------------
{
  const a = AutoLoad.createAutoLoader();
  ok('with everything in place, the end of the feed asks for more', a.shouldLoad(READY) === true);
  ok('not while another round is in flight — pages would interleave',
    a.shouldLoad({ ...READY, loading: true }) === false);
  ok('not when nobody has a next page — that would be asking into the void',
    a.shouldLoad({ ...READY, hasMore: false }) === false);
  ok('not while the user is looking at something else',
    a.shouldLoad({ ...READY, active: false }) === false);
  ok('a state that says nothing loads nothing',
    a.shouldLoad({}) === false && a.shouldLoad() === false);
}

// A fast scroll through a tall feed must not become several requests in one second.
{
  const a = AutoLoad.createAutoLoader({ minGapMs: 700 });
  ok('the first round goes at once', a.shouldLoad({ ...READY, now: 1000 }) === true);
  a.started(1000);
  ok('a second one moments later does not',
    a.shouldLoad({ ...READY, now: 1200 }) === false);
  ok('and is allowed again once the gap has passed',
    a.shouldLoad({ ...READY, now: 1750 }) === true);
  // Measured from the REQUEST, not from its answer: a slow site would otherwise let a
  // queue of them through while the first was still running.
  ok('the gap is measured from when the round started', a.state().lastAt === 1000);
}

// ---------------------------------------------------------------------------
// The loop guard. This is the reason the file exists.
// ---------------------------------------------------------------------------
// Measured on the real app: after ONE round that adds nothing the page does not get
// taller, so the end of the feed never leaves the viewport and the watcher — which only
// reports CHANGES — says nothing more. The automatic path goes quiet there, long before
// the third empty round. So "stopped moving" is a separate, earlier question from "gave
// up", and it is the one the button has to answer to; without it the feed simply stopped
// with no button and no explanation.
{
  const a = AutoLoad.createAutoLoader({ idleLimit: 3, minGapMs: 0 });
  ok('a feed that is filling itself needs no button', a.stalled() === false);
  a.finished(0);
  ok('one empty round already counts as stopped moving, though it has not given up',
    a.stalled() === true && a.exhausted() === false);
  a.finished(7);
  ok('and a round that produces cards puts the button away again', a.stalled() === false);
}

{
  const a = AutoLoad.createAutoLoader({ idleLimit: 3, minGapMs: 0 });
  a.finished(0);
  a.finished(0);
  ok('two rounds that produced nothing are forgiven — a page of duplicates happens',
    a.exhausted() === false && a.shouldLoad(READY) === true);
  a.finished(0);
  ok('the third stops the automatic path outright',
    a.exhausted() === true && a.shouldLoad(READY) === false);
  // Nothing about the page's state can talk it back into looping.
  ok('and nothing re-enables it while it keeps producing nothing',
    a.shouldLoad({ ...READY, now: 999999 }) === false);
}

{
  const a = AutoLoad.createAutoLoader({ idleLimit: 3, minGapMs: 0 });
  a.finished(0); a.finished(0);
  a.finished(5);
  a.finished(0); a.finished(0);
  ok('a round that produced cards clears the count, so a slow feed is not punished',
    a.exhausted() === false);
}

// What counts is what reached the FEED, not what the sites returned: a page of pictures
// already on screen moves nothing and has to count as a round that went nowhere.
{
  const a = AutoLoad.createAutoLoader({ idleLimit: 2, minGapMs: 0 });
  a.finished(0);
  a.finished(NaN);
  ok('a round of no new cards, however it is reported, counts as idle', a.exhausted() === true);
}

// A round that threw is not "idle", it is broken. Retrying a broken thing every time the
// bottom scrolls back into view is the storm again.
{
  const a = AutoLoad.createAutoLoader({ minGapMs: 0 });
  a.failed();
  ok('one outright failure stops the automatic path immediately',
    a.exhausted() === true && a.shouldLoad(READY) === false);
}

// After giving up, the button comes back. Pressing it is the user asking, and a press
// that actually produces cards is proof the feed is alive again — a loop cannot restart
// from there, because a loop is made of rounds that produce nothing.
{
  const a = AutoLoad.createAutoLoader({ idleLimit: 2, minGapMs: 0 });
  a.finished(0); a.finished(0);
  ok('given up', a.exhausted() === true);
  a.finished(12);
  ok('a successful press of the button hands scrolling back its job',
    a.exhausted() === false && a.shouldLoad(READY) === true);
}

// A different question deserves a fresh start.
{
  const a = AutoLoad.createAutoLoader({ idleLimit: 1, minGapMs: 5000 });
  a.started(1000);
  a.finished(0);
  ok('stopped and rate-limited', a.exhausted() === true);
  a.reset();
  ok('a new search clears both the give-up and the gap',
    a.exhausted() === false && a.shouldLoad({ ...READY, now: 1001 }) === true
    && a.state().idleRounds === 0);
}

ok('silly settings fall back to the defaults rather than disabling the guard', (() => {
  const a = AutoLoad.createAutoLoader({ idleLimit: 0, minGapMs: -5 });
  for (let i = 0; i < AutoLoad.DEFAULT_IDLE_LIMIT; i++) a.finished(0);
  return a.exhausted() === true && AutoLoad.DEFAULT_IDLE_LIMIT > 1;
})());

// ---------------------------------------------------------------------------
// Wiring. The guard has to be on the path the app actually takes.
// ---------------------------------------------------------------------------
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

ok('the window loads the module', html.includes('auto-load.js'));
ok('the end of the feed is watched, and the watcher only asks through the guard',
  renderer.includes('function setupOnlineAutoLoad()')
  && renderer.includes('setupOnlineAutoLoad();')
  && renderer.includes('maybeAutoLoadOnline();')
  && renderer.includes('if (!onlineAutoLoad.shouldLoad({'));
// One loading path, not two. The button and the scroll call the same function, so the
// busy flag and the generation check cannot be got round by the new caller.
ok('scrolling uses the same loader the button always used',
  renderer.includes("whMoreBtn.addEventListener('click', loadMoreOnline);")
  && /function maybeAutoLoadOnline\(\)[\s\S]*?loadMoreOnline\(\);/.test(renderer));
ok('what reached the feed is what the guard is told',
  renderer.includes('const before = ONLINE.entries.length;')
  && renderer.includes('onlineAutoLoad.finished(ONLINE.entries.length - before);'));
ok('a failed round stops it rather than being retried on the next scroll',
  renderer.includes('onlineAutoLoad.failed();'));
ok('a fresh search gives the feed a clean slate', renderer.includes('onlineAutoLoad.reset();'));
// The button is the fallback now, so it must appear exactly when scrolling has stopped
// working — a feed that quietly stopped growing with no way to ask would look broken.
ok('the button hides while scrolling works and returns when the feed stops moving',
  renderer.includes('if (more) more.hidden = !hasMore || !onlineAutoLoad.stalled();'));
// A watcher anchored to a card would be watching something the virtual grid recycles.
ok('the watcher is anchored to the strip after the grid, not to a card',
  renderer.includes("document.querySelector('.lib-online-more')")
  && renderer.includes("rootMargin: '600px 0px'"));
ok('and it will not fire for a feed the user is not looking at',
  renderer.includes("active: LIB.filter === 'online' && ONLINE.view === 'search' && activePage === 'library',"));

console.log('\nAll ' + passed + ' auto-load tests passed.');
