'use strict';

// TRG-004. The latest intent of ONE scheduler, and the only timer it owns.
//
// The theme schedule, the wallpaper schedule and the slideshow interval all run the same
// way: drop the timer, wait for something (is a game running? the COM or PowerShell
// apply), then apply and arm the next timer. While a run waits, the user can switch the
// scheduler off or change it, and the old run used to carry on regardless. It applied the
// old wish, armed a timer after being switched off, and two overlapping runs armed two
// timers, the second overwriting the handle of the first, which then kept running untracked.
//
// The rule this module enforces:
//   * begin() starts a new intent: the number goes up and the armed timer goes at once;
//   * after every await a run asks isCurrent(); a stale run neither applies nor arms;
//   * dispatch() starts a side effect only for the current intent. One already started
//     (a COM or PowerShell call cannot be taken back) runs to its end, and a newer run waits
//     for it in settle(), so it decides on what that call left behind, not on what was there
//     before it;
//   * arm() owns the ONE timer and arms it only for the current intent, so a stale run can
//     neither leave a timer of its own nor overwrite the current one;
//   * cancel() is "switched off": the number goes up and the timer goes. dispose() is
//     cancel() for good.
//
// Pure and injectable: main.js passes the real timers, the tests pass their own.

/**
 * @typedef {object} LatestIntentDeps
 * @property {(fn: () => void, ms: number) => any} [setTimer]
 * @property {(handle: any) => void} [clearTimer]
 * @property {() => number} [now]
 */

/**
 * @typedef {object} DispatchResult
 * @property {boolean} started  false when the intent was already stale and nothing ran
 * @property {any} [value]      what the side effect resolved to, when it ran
 */

/**
 * @param {LatestIntentDeps} [deps]
 */
function createLatestIntent(deps = {}) {
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((handle) => clearTimeout(handle));
  const now = deps.now || (() => Date.now());

  let generation = 0;
  let timer = null;
  let dueAt = 0;
  /** @type {Promise<any> | null} */
  let inFlight = null;
  let disposed = false;

  function dropTimer() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    dueAt = 0;
  }

  /** A new intent. Whatever ran before it is stale from this moment. */
  function begin() {
    generation += 1;
    dropTimer();
    return generation;
  }

  /** @param {number} token */
  function isCurrent(token) {
    return !disposed && token === generation;
  }

  /** Is a side effect of some earlier run still under way? */
  function busy() {
    return inFlight !== null;
  }

  /**
   * Wait until no side effect is in flight, then say whether `token` is still current.
   * The answer holds for that moment only: after awaiting it, ask isCurrent() again.
   * @param {number} token
   */
  async function settle(token) {
    while (inFlight) {
      try { await inFlight; } catch { /* its failure belongs to the run that started it */ }
    }
    return isCurrent(token);
  }

  /**
   * Start `effect` only if `token` is current once earlier side effects have finished.
   * With nothing in flight it starts at once, in the caller's own turn. The effect's own
   * rejection reaches the caller.
   * @param {number} token
   * @param {() => any} effect
   * @returns {Promise<DispatchResult>}
   */
  async function dispatch(token, effect) {
    // The check sits right before the start, in the same turn: a check made before an
    // await would let an intent that went stale during that await start anyway.
    for (;;) {
      if (!isCurrent(token)) return { started: false };
      if (!inFlight) break;
      try { await inFlight; } catch { /* its failure belongs to the run that started it */ }
    }
    const run = Promise.resolve().then(effect);
    inFlight = run;
    try {
      return { started: true, value: await run };
    } finally {
      if (inFlight === run) inFlight = null;
    }
  }

  /**
   * Arm the one timer for `token`. A stale token arms nothing and leaves the current timer.
   * @param {number} token
   * @param {() => void} fn
   * @param {number} ms
   */
  function arm(token, fn, ms) {
    if (!isCurrent(token)) return false;
    dropTimer();
    const delay = Math.max(0, Math.floor(Number(ms) || 0));
    const handle = setTimer(() => {
      if (timer === handle) {
        timer = null;
        dueAt = 0;
      }
      fn();
    }, delay);
    timer = handle;
    dueAt = now() + delay;
    return true;
  }

  /** Switched off: no intent is current and no timer is left. */
  function cancel() {
    generation += 1;
    dropTimer();
  }

  function dispose() {
    cancel();
    disposed = true;
  }

  /** For tests and diagnostics: what this scheduler holds right now. */
  function state() {
    return { generation, liveTimers: timer === null ? 0 : 1, dueAt, busy: inFlight !== null, disposed };
  }

  return { begin, isCurrent, busy, settle, dispatch, arm, cancel, dispose, state };
}

module.exports = { createLatestIntent };
