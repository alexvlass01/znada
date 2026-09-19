'use strict';

// ONL-003. Load the next page when the user reaches the end, instead of asking them to
// press a button for it; the button itself goes away.
//
// The whole risk of this change is a loop. Scrolling to the bottom asks for more; if
// "more" adds nothing — every card filtered out by ONL-010, a site that has quietly
// stopped answering, a page of duplicates — the bottom is still the bottom, and the next
// frame asks again. That is a request storm built out of one gesture, and BUG-020 spent
// a whole task limiting exactly this kind of traffic.
//
// So the decision is kept here, away from the DOM, and it is deliberately suspicious:
// it counts rounds that produced NOTHING and stops after a few, handing the user back
// the button. A feed that stops filling itself is a much smaller failure than a feed
// that hammers three sites forever.
//
// It does not fetch and it does not touch the page. The renderer asks it whether to go,
// tells it what came back, and draws the button according to `exhausted()`.

(function initAutoLoad(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoLoad = api;
}(typeof window !== 'undefined' ? window : globalThis, function autoLoadFactory() {
  // Three empty rounds is enough to tell "the next page happened to be all duplicates"
  // from "this is not going anywhere".
  const DEFAULT_IDLE_LIMIT = 3;
  // A floor between automatic rounds, so a fast scroll through a tall feed cannot turn
  // into several requests in the same second. A press of the button is the user asking
  // and is never delayed.
  const DEFAULT_MIN_GAP_MS = 700;

  function createAutoLoader(options = {}) {
    const idleLimit = Number.isFinite(options.idleLimit) && options.idleLimit > 0
      ? Math.floor(options.idleLimit) : DEFAULT_IDLE_LIMIT;
    const minGapMs = Number.isFinite(options.minGapMs) && options.minGapMs >= 0
      ? Math.floor(options.minGapMs) : DEFAULT_MIN_GAP_MS;
    let idleRounds = 0;
    let stopped = false;
    let lastAt = 0;

    // Everything that must be true before one more page is asked for. Each of these has
    // its own reason to exist, and none of them is "probably fine":
    //   active   — the user is looking at this feed and not at another list
    //   more     — somebody actually has a next page; without this we ask into the void
    //   loading  — one request at a time, or the pages arrive interleaved
    //   now      — the gap above
    function shouldLoad(state = {}) {
      if (stopped) return false;
      if (!state.active || !state.hasMore || state.loading) return false;
      const now = Number.isFinite(state.now) ? state.now : 0;
      if (lastAt && now - lastAt < minGapMs) return false;
      return true;
    }

    // Call when a round has been STARTED, so the gap is measured from the request rather
    // than from its answer — a slow site would otherwise let several through.
    function started(now) {
      lastAt = Number.isFinite(now) ? now : 0;
    }

    // What that round produced. `gained` is how many NEW cards reached the feed, not how
    // many came back from the sites: a page of things we already had moves nothing on
    // the screen and must count as idle.
    function finished(gained) {
      const n = Number(gained);
      if (Number.isFinite(n) && n > 0) {
        idleRounds = 0;
        // A round that actually produced cards is proof the feed is alive, so the
        // automatic path is trusted again. This matters for the press of the button that
        // follows a give-up: it is how the user says "keep going", and a loop cannot
        // restart from here — a loop is made of rounds that produce nothing.
        stopped = false;
        return;
      }
      idleRounds += 1;
      if (idleRounds >= idleLimit) stopped = true;
    }

    // A round that failed outright stops the automatic path at once. It is not idle —
    // it is broken, and retrying a broken thing on scroll is the storm again.
    function failed() {
      stopped = true;
    }

    // The feed is a new one: a fresh search, a changed filter, a different source.
    function reset() {
      idleRounds = 0;
      stopped = false;
      lastAt = 0;
    }

    // True once the automatic path has given up. The renderer shows the button again —
    // the user can still ask, and asking is always allowed.
    function exhausted() { return stopped; }

    // Whether the feed has STOPPED MOVING, which is a wider question than "given up" and
    // is the one the button should answer to.
    //
    // Found by measuring the real app, not by reasoning: after a round that adds nothing,
    // the page does not get taller, so the end of the feed never leaves the viewport —
    // and an IntersectionObserver says nothing when the intersection has not changed. The
    // automatic path therefore goes quiet after ONE empty round, long before the third
    // one that would trip `stopped`. Without this the feed simply stopped growing with no
    // button and no explanation, which is a worse dead end than the one being fixed.
    function stalled() { return stopped || idleRounds > 0; }

    return { shouldLoad, started, finished, failed, reset, exhausted, stalled,
      // For tests and for anyone debugging a feed that stopped early.
      state: () => ({ idleRounds, stopped, lastAt }) };
  }

  return { createAutoLoader, DEFAULT_IDLE_LIMIT, DEFAULT_MIN_GAP_MS };
}));
