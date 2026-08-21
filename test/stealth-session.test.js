'use strict';

// Unit tests for the pure stealth session controller (src/stealth-session.js) using a
// deterministic fake clock + timer queue. No Electron, no real timers.

const { createStealthController } = require('../src/stealth-session');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL', name); } };

// ---- deterministic harness -------------------------------------------------
function makeHarness() {
  let nowMs = 0;
  let seq = 1;
  let timers = []; // { id, fn, fireAt }
  let monitorIds = ['M1', 'M2'];
  let coveredIds = [];
  const calls = { apply: [] };

  const env = {
    now: () => nowMs,
    pollMs: 3000,
    log: () => {},
    setTimer: (fn, ms) => { const id = seq++; timers.push({ id, fn, fireAt: nowMs + ms }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    getMonitors: async () => monitorIds.slice(),
    checkCovered: async () => coveredIds.slice(),
    apply: async (a) => { calls.apply.push({ theme: a.theme, monitors: a.monitors.slice(), advance: a.advance, single: a.single }); },
  };

  const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  // Fire every timer whose fireAt <= current time, awaiting async work after each so a tick
  // that schedules the next poll is honored. nowMs only moves via advance(ms).
  async function advance(ms) {
    nowMs += ms;
    let guard = 0;
    for (;;) {
      const due = timers.filter((t) => t.fireAt <= nowMs).sort((a, b) => a.fireAt - b.fireAt);
      if (!due.length) break;
      const t = due[0];
      const idx = timers.indexOf(t);
      if (idx >= 0) timers.splice(idx, 1);
      t.fn();
      await flush();
      if (++guard > 5000) throw new Error('timer loop guard tripped');
    }
  }

  return {
    env, calls, advance, flush,
    setMonitors: (m) => { monitorIds = m.slice(); },
    setCovered: (c) => { coveredIds = c.slice(); },
    timerCount: () => timers.length,
  };
}

// ---- 1. per-monitor coverage: each screen switches as it gets covered ----
(async () => {
  const h = makeHarness();
  const ctl = createStealthController(h.env);
  await ctl.request({ theme: 'dark', advance: true, timeoutMs: 600000, initialDelayMs: 0 });
  await h.flush();
  await h.advance(0); // first tick, nothing covered yet
  ok('1: waits while nothing is covered (no apply, still active)', h.calls.apply.length === 0 && ctl.isActive());
  h.setCovered(['M1']);
  await h.advance(3000);
  ok('1: applies M1 when covered (advance, dark)',
    h.calls.apply.length === 1 && h.calls.apply[0].monitors.join() === 'M1'
    && h.calls.apply[0].advance === true && h.calls.apply[0].theme === 'dark' && ctl.isActive());
  h.setCovered(['M1', 'M2']);
  await h.advance(3000);
  ok('1: applies M2, session ends, no leftover timers',
    h.calls.apply.length === 2 && h.calls.apply[1].monitors.join() === 'M2'
    && !ctl.isActive() && h.timerCount() === 0);
})();

// ---- 2. timeout: after the deadline, remaining monitors switch anyway ----
(async () => {
  const h = makeHarness();
  const ctl = createStealthController(h.env);
  await ctl.request({ theme: 'light', advance: true, timeoutMs: 10000, initialDelayMs: 0 });
  await h.flush();
  await h.advance(0);     // t=0 tick
  await h.advance(3000);  // 3000
  await h.advance(3000);  // 6000
  await h.advance(3000);  // 9000 (< deadline, nothing applied)
  const beforeTimeout = h.calls.apply.length;
  await h.advance(3000);  // 12000 (>= deadline) → force-apply all remaining
  ok('2: nothing applied before deadline', beforeTimeout === 0);
  ok('2: force-applies all remaining at timeout, session ends',
    h.calls.apply.length === 1 && h.calls.apply[0].monitors.slice().sort().join() === 'M1,M2'
    && !ctl.isActive() && h.timerCount() === 0);
})();

// ---- 3. cancel: a manual change invalidates a pending session ----
(async () => {
  const h = makeHarness();
  const ctl = createStealthController(h.env);
  await ctl.request({ theme: 'dark', advance: true, timeoutMs: 600000, initialDelayMs: 0 });
  await h.flush();
  await h.advance(0);
  ctl.cancel();
  h.setCovered(['M1', 'M2']);
  await h.advance(3000);
  ok('3: cancel stops all further applies, clears timers',
    h.calls.apply.length === 0 && !ctl.isActive() && h.timerCount() === 0);
})();

// ---- 4. theme retarget (dedup): a theme flip folds in, no double advance ----
(async () => {
  const h = makeHarness();
  const ctl = createStealthController(h.env);
  h.setCovered(['M1']);
  await ctl.request({ theme: 'dark', advance: true, timeoutMs: 600000, initialDelayMs: 0 });
  await h.flush();
  await h.advance(0); // applies M1 dark (advance)
  ok('4: M1 applied dark with advance', h.calls.apply.length === 1 && h.calls.apply[0].advance === true);
  // theme flips dark->light while M2 still pending → retarget, advance=false
  await ctl.request({ theme: 'light', advance: false, timeoutMs: 600000, initialDelayMs: 0 });
  await h.flush();
  await h.advance(0); // M1 still covered → re-applies light WITHOUT advancing
  ok('4: theme flip re-applies covered M1 as light, advance=false (no double advance)',
    h.calls.apply.length === 2 && h.calls.apply[1].monitors.join() === 'M1'
    && h.calls.apply[1].theme === 'light' && h.calls.apply[1].advance === false);
  ok('4: single session retargeted (M2 still pending, light)',
    ctl.isActive() && ctl._snapshot().theme === 'light' && ctl._snapshot().pending.join() === 'M2');
  h.setCovered(['M1', 'M2']);
  await h.advance(3000);
  ok('4: M2 finally applied as light, session ends',
    h.calls.apply.length === 3 && h.calls.apply[2].monitors.join() === 'M2'
    && h.calls.apply[2].theme === 'light' && !ctl.isActive());
})();

// ---- 5. singleWallpaper: advance the shared playlist exactly once ----
(async () => {
  const h = makeHarness();
  const ctl = createStealthController(h.env);
  h.setCovered(['M1']);
  await ctl.request({ theme: 'dark', advance: true, single: true, timeoutMs: 600000, initialDelayMs: 0 });
  await h.flush();
  await h.advance(0); // M1 covered → advance once
  h.setCovered(['M1', 'M2']);
  await h.advance(3000); // M2 covered → apply WITHOUT advancing again
  ok('5: single mode advances on first apply only',
    h.calls.apply.length === 2 && h.calls.apply[0].advance === true && h.calls.apply[1].advance === false
    && !ctl.isActive());
})();

// ---- 6. no monitors: no session, no timers ----
(async () => {
  const h = makeHarness();
  const ctl = createStealthController(h.env);
  h.setMonitors([]);
  await ctl.request({ theme: 'dark', advance: true, timeoutMs: 600000, initialDelayMs: 0 });
  await h.flush();
  ok('6: empty monitor list starts no session', !ctl.isActive() && h.timerCount() === 0 && h.calls.apply.length === 0);
})();

// ---- 7. initial delay: first poll is deferred (boot settle) ----
(async () => {
  const h = makeHarness();
  const ctl = createStealthController(h.env);
  h.setCovered(['M1', 'M2']);
  await ctl.request({ theme: 'dark', advance: true, timeoutMs: 600000, initialDelayMs: 5000 });
  await h.flush();
  await h.advance(0); // nothing fires yet (timer is at t=5000)
  const early = h.calls.apply.length;
  await h.advance(5000); // now the first tick fires
  ok('7: nothing applied before the initial delay', early === 0);
  ok('7: applies both after the initial delay', h.calls.apply.length === 1 && h.calls.apply[0].monitors.slice().sort().join() === 'M1,M2');
})();

// ---- 8. REGRESSION: cancel() while an apply is in flight must not crash ----
// (the bug: tick read session.advance after the apply await, after cancel had nulled session)
(async () => {
  let nowMs = 0, seq = 1; const timers = [];
  let resolveApply = null;
  const env = {
    now: () => nowMs, pollMs: 3000, log: () => {},
    setTimer: (fn, ms) => { const id = seq++; timers.push({ id, fn, fireAt: nowMs + ms }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    getMonitors: async () => ['M1'],
    checkCovered: async () => ['M1'],
    apply: () => new Promise((res) => { resolveApply = res; }), // stays pending until we resolve it
  };
  const ctl = createStealthController(env);
  const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
  const fire = async () => {
    const due = timers.filter((t) => t.fireAt <= nowMs).sort((a, b) => a.fireAt - b.fireAt);
    for (const t of due) { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); t.fn(); await flush(); }
  };
  let crashed = false;
  try {
    await ctl.request({ theme: 'dark', advance: true, single: true, timeoutMs: 600000, initialDelayMs: 0 });
    await flush();
    await fire();                 // tick runs, M1 covered, suspends inside apply()
    ctl.cancel();                 // cancel while the apply is in flight → session = null
    if (resolveApply) resolveApply(); // let the apply resolve; tick resumes after the await
    await flush();
  } catch (e) { crashed = true; console.log('  (8 caught)', e && e.message); }
  ok('8: cancel during apply does not crash, session ends inactive', !crashed && !ctl.isActive());
})();

// ---- 9. changeTheme: a real flip keeps advance (new photo); a no-change is a no-op ----
(async () => {
  const h = makeHarness();
  const ctl = createStealthController(h.env);
  h.setCovered([]);
  await ctl.request({ theme: 'dark', advance: true, timeoutMs: 600000, initialDelayMs: 0 });
  await h.flush();
  await h.advance(0); // tick: nothing covered yet
  const before = h.calls.apply.length;
  await ctl.changeTheme('dark'); // SAME theme → no-op (this is what breaks the spurious-event loop)
  await h.flush();
  ok('9: changeTheme(same theme) is a no-op', ctl._snapshot().theme === 'dark' && ctl._snapshot().advance === true && h.calls.apply.length === before);
  await ctl.changeTheme('light'); // REAL flip while both monitors still pending
  await h.flush();
  ok('9: real flip retargets theme + KEEPS advance + re-pends all',
    ctl._snapshot().theme === 'light' && ctl._snapshot().advance === true && ctl._snapshot().pending.slice().sort().join() === 'M1,M2');
  h.setCovered(['M1']);
  await h.advance(0); // fire the tick changeTheme scheduled
  ok('9: applies the NEW theme WITH advance (a new frame, not the same one)',
    h.calls.apply.length === 1 && h.calls.apply[0].theme === 'light' && h.calls.apply[0].advance === true && h.calls.apply[0].monitors.join() === 'M1');
})();

// ---- 10. completion callback: fires once only after the whole session finishes ----
(async () => {
  const h = makeHarness();
  let completed = 0;
  const ctl = createStealthController(h.env);
  h.setCovered(['M1']);
  await ctl.request({ theme: 'dark', advance: true, timeoutMs: 600000, initialDelayMs: 0, onComplete: () => { completed++; } });
  await h.flush();
  await h.advance(0); // M1 only; M2 still pending
  ok('10: onComplete is not called after a partial monitor apply', completed === 0 && ctl.isActive());
  h.setCovered(['M1', 'M2']);
  await h.advance(3000);
  ok('10: onComplete fires once when all pending monitors finish',
    completed === 1 && !ctl.isActive() && h.timerCount() === 0);
})();

// ---- 11. completion callback is not called when a manual cancel supersedes it ----
(async () => {
  const h = makeHarness();
  let completed = 0;
  const ctl = createStealthController(h.env);
  await ctl.request({ theme: 'dark', advance: true, timeoutMs: 600000, initialDelayMs: 0, onComplete: () => { completed++; } });
  await h.flush();
  await h.advance(0);
  ctl.cancel();
  h.setCovered(['M1', 'M2']);
  await h.advance(3000);
  ok('11: cancel does not call onComplete', completed === 0 && !ctl.isActive());
})();

// ---- 12. empty monitor list completes immediately so interval scheduling can continue ----
(async () => {
  const h = makeHarness();
  let completed = 0;
  const ctl = createStealthController(h.env);
  h.setMonitors([]);
  await ctl.request({ theme: 'dark', advance: true, timeoutMs: 600000, initialDelayMs: 0, onComplete: () => { completed++; } });
  await h.flush();
  ok('12: empty monitor list calls onComplete once without starting a session',
    completed === 1 && !ctl.isActive() && h.timerCount() === 0);
})();

// ---- 13. retarget without callback preserves the existing completion hook ----
(async () => {
  const h = makeHarness();
  let completed = 0;
  const ctl = createStealthController(h.env);
  await ctl.request({ theme: 'dark', advance: true, timeoutMs: 600000, initialDelayMs: 0, onComplete: () => { completed++; } });
  await h.flush();
  await h.advance(0);
  await ctl.request({ theme: 'light', advance: true, timeoutMs: 600000, initialDelayMs: 0 });
  await h.flush();
  h.setCovered(['M1', 'M2']);
  await h.advance(0);
  ok('13: retarget keeps onComplete when the new request has none',
    completed === 1 && !ctl.isActive());
})();

// summary (microtasks above are all settled synchronously enough; print on next tick)
setTimeout(() => {
  console.log(`\n${fail ? 'FAILED' : 'All'} ${pass} stealth-session ${fail ? `(${fail} failed)` : 'tests passed.'}`);
  process.exit(fail ? 1 : 0);
}, 50);
