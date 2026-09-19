'use strict';

// `node test/dev-launch.test.js` — COLLAB-003: what a DEV/DIAG check window says about
// itself, the hour after which it closes, and the two page-side pieces that put the label
// on screen: the real preload and the title-bar badge.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const tools = require('../diagnostics/main/dev-launch');
const { REFUSALS } = require('../src/dev-launch-gate');

const ROOT = path.join(__dirname, '..');
const HOUR = 60 * 60 * 1000;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const BRANCH = 'claude/COLLAB-003-dev-diag-launch';

let passed = 0;
const failures = [];
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { failures.push({ name, err }); console.log('  ✗ ' + name); }
}

const porcelain = ({ sha = SHA_A, head = BRANCH, extra = '' } = {}) =>
  `# branch.oid ${sha}\n# branch.head ${head}\n# branch.upstream origin/main\n# branch.ab +0 -0\n${extra}`;
const revision = (overrides = {}) => ({ known: true, sha: SHA_A, branch: BRANCH, detached: false, dirty: false, ...overrides });
const UNKNOWN = { known: false, sha: '', branch: '', detached: false, dirty: false };
// 14:05 local time, so the clock text in the details does not depend on the machine's zone.
const T0 = new Date(2026, 8, 15, 14, 5, 0).getTime();
const describe = (overrides = {}) => tools.describeLaunch({
  mode: 'dev',
  userDataPath: 'C:\\Users\\someone\\AppData\\Local\\Znada-Dev',
  revision: revision(),
  startedAt: T0,
  ...overrides,
});

// A clock pair and a timer queue under the test's control. Timers fire by the MONOTONIC
// clock, as libuv's do — which is what makes "the machine slept" expressible: the wall
// clock moves on and nothing becomes due.
function fakeClock() {
  let wall = 1_700_000_000_000;
  let mono = 5_000;
  let nextId = 1;
  const timers = new Map();
  return {
    wallNow: () => wall,
    monoNow: () => mono,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, due: mono + ms, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms, { wallOnly = false, monoOnly = false } = {}) {
      if (!monoOnly) wall += ms;
      if (!wallOnly) mono += ms;
    },
    setWall(value) { wall = value; },
    wall: () => wall,
    run() {
      let fired = 0;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.due <= mono).sort((a, b) => a[1].due - b[1].due);
        if (!due.length) return fired;
        const [id, timer] = due[0];
        timers.delete(id);
        timer.fn();
        fired += 1;
        if (fired > 100000) throw new Error('timer storm: a check re-armed itself without waiting');
      }
    },
    pending: () => [...timers.values()],
  };
}

function limitOn(clock, extra = {}) {
  let expired = 0;
  const session = tools.createSessionLimit({
    wallNow: clock.wallNow,
    monoNow: clock.monoNow,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onExpire: () => { expired += 1; },
    ...extra,
  }).start();
  return { session, expiries: () => expired };
}

(async () => {
  // --- which code ------------------------------------------------------------------
  await ok('a clean checkout names its commit and branch', () => {
    assert.deepStrictEqual(tools.parseRevision(porcelain()), revision());
  });
  await ok('a changed tracked file makes the tree dirty', () => {
    const text = porcelain({ extra: '1 .M N... 100644 100644 100644 abc def main.js\n' });
    assert.strictEqual(tools.parseRevision(text).dirty, true);
  });
  await ok('so does an untracked file: new code that is not committed still runs', () => {
    assert.strictEqual(tools.parseRevision(porcelain({ extra: '? src/new-module.js\n' })).dirty, true);
  });
  await ok('a detached checkout has no branch and says so', () => {
    assert.deepStrictEqual(tools.parseRevision(porcelain({ head: '(detached)' })),
      revision({ branch: '', detached: true }));
  });
  await ok('git for Windows line endings read the same', () => {
    const text = porcelain({ extra: '? x.js\n' }).replace(/\n/g, '\r\n');
    assert.deepStrictEqual(tools.parseRevision(text), revision({ dirty: true }));
  });
  await ok('a repository without a commit, or no answer at all, is not a known revision', () => {
    assert.deepStrictEqual(tools.parseRevision('# branch.oid (initial)\n# branch.head main\n? a.js\n'), UNKNOWN);
    assert.deepStrictEqual(tools.parseRevision(''), UNKNOWN);
    assert.deepStrictEqual(tools.parseRevision('fatal: not a git repository'), UNKNOWN);
  });
  await ok('the revision is read where the app runs from, without taking git locks', () => {
    const seen = [];
    const rev = tools.readRevision({
      root: 'C:\\work\\wt',
      execFileSync: (file, args, opts) => { seen.push({ file, args, opts }); return porcelain(); },
    });
    assert.deepStrictEqual(rev, revision());
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].file, 'git');
    assert.deepStrictEqual(seen[0].args.slice(0, 2), ['--no-optional-locks', 'status']);
    assert.ok(seen[0].args.includes('--porcelain=v2') && seen[0].args.includes('--branch'));
    assert.strictEqual(seen[0].opts.cwd, 'C:\\work\\wt');
    assert.strictEqual(seen[0].opts.windowsHide, true);
    assert.ok(seen[0].opts.timeout > 0 && seen[0].opts.timeout <= 10000, 'a hung git must not hold the launch');
  });
  await ok('a git that fails or is missing gives an unknown revision, not an exception', () => {
    const rev = tools.readRevision({ root: 'C:\\work', execFileSync: () => { throw new Error('spawn git ENOENT'); } });
    assert.deepStrictEqual(rev, UNKNOWN);
  });
  await ok('the task id comes from the branch name', () => {
    const cases = [
      [BRANCH, 'COLLAB-003'],
      ['codex/saibb228/LIB-009-trash-eviction-notice', 'LIB-009'],
      ['claude/BUG-031-signin-window-state', 'BUG-031'],
      ['codex/I18N-002-pass', 'I18N-002'],
      ['main', ''],
      ['codex/review/pr-8-8d104ab0', ''],
      ['', ''],
      [undefined, ''],
    ];
    for (const [branch, task] of cases) assert.strictEqual(tools.taskFromBranch(branch), task, String(branch));
  });

  // --- the label ------------------------------------------------------------------
  await ok('a clean check names mode, task and commit: badge, window titles and tray', () => {
    const info = describe();
    assert.strictEqual(info.badgeText, 'DEV · COLLAB-003 · aaaaaaa');
    assert.strictEqual(info.windowTitle, 'Znada · DEV · COLLAB-003 · aaaaaaa');
    assert.strictEqual(info.viewerTitle, 'Znada Media Viewer · DEV · COLLAB-003 · aaaaaaa');
    assert.strictEqual(info.trayTooltip, 'Znada · DEV · COLLAB-003 · aaaaaaa');
    assert.strictEqual(info.closesAt, T0 + HOUR);
    for (const part of [SHA_A, BRANCH, 'Znada-Dev', '14:05', '15:05']) {
      assert.ok(info.details.includes(part), `the details do not mention ${part}:\n${info.details}`);
    }
  });
  await ok('uncommitted changes are on the badge itself, not only on hover', () => {
    const info = describe({ revision: revision({ dirty: true }) });
    assert.strictEqual(info.badgeText, 'DEV · COLLAB-003 · aaaaaaa + правки');
    assert.ok(info.details.includes('незакоммиченные'), info.details);
  });
  await ok('without a task id the branch is shown, and a detached checkout says so', () => {
    assert.strictEqual(describe({ revision: revision({ branch: 'main' }) }).badgeText, 'DEV · main · aaaaaaa');
    assert.strictEqual(describe({ revision: revision({ branch: '', detached: true }) }).badgeText,
      'DEV · без ветки · aaaaaaa');
  });
  await ok('a long branch is shortened on the badge, kept whole in the details, and fits the tray', () => {
    const long = 'codex/review/pr-8-8d104ab0-with-a-rather-long-descriptive-tail';
    const info = describe({ revision: revision({ branch: long }) });
    assert.ok(!info.badgeText.includes(long));
    assert.ok(info.badgeText.includes('…'));
    assert.ok(info.details.includes(long));
    assert.ok(info.trayTooltip.length <= 127, `the tray tooltip is ${info.trayTooltip.length} characters`);
  });
  await ok('code that could not be identified is said out loud', () => {
    const info = describe({ revision: UNKNOWN });
    assert.strictEqual(info.badgeText, 'DEV · версия не определена');
    assert.ok(info.details.includes('git'), info.details);
    assert.strictEqual(describe({ revision: null }).badgeText, 'DEV · версия не определена');
  });
  await ok('DIAG is labelled as DIAG, and an unknown mode is an error rather than a blank label', () => {
    assert.strictEqual(describe({ mode: 'diag' }).badgeText, 'DIAG · COLLAB-003 · aaaaaaa');
    assert.throws(() => describe({ mode: 'prod' }), /unknown mode/);
  });

  // --- the same code? --------------------------------------------------------------
  const identity = (overrides) => tools.identityOf(describe({ revision: revision(overrides) }));
  await ok('the same clean commit is the same code', () => {
    assert.strictEqual(tools.sameCode(describe(), identity({})), true);
  });
  await ok('another commit is not', () => {
    assert.strictEqual(tools.sameCode(describe(), identity({ sha: SHA_B })), false);
  });
  await ok('uncommitted changes on either side cannot be proved the same', () => {
    assert.strictEqual(tools.sameCode(describe(), identity({ dirty: true })), false);
    assert.strictEqual(tools.sameCode(describe({ revision: revision({ dirty: true }) }), identity({ dirty: true })), false);
    // The running window has edits the commit does not; a clean launch of that commit is other code.
    assert.strictEqual(tools.sameCode(describe({ revision: revision({ dirty: true }) }), identity({})), false);
  });
  await ok('code that could not be named is never the same, on either side', () => {
    assert.strictEqual(tools.sameCode(describe({ revision: UNKNOWN }), tools.identityOf(describe({ revision: UNKNOWN }))), false);
    assert.strictEqual(tools.sameCode(describe(), tools.identityOf(describe({ revision: UNKNOWN }))), false);
    // Not even against a sender that claims a known revision with no commit in it.
    const hollow = { mode: 'dev', known: true, dirty: false, sha: '', badgeText: 'DEV' };
    assert.strictEqual(tools.sameCode(describe({ revision: UNKNOWN }), hollow), false);
  });
  await ok('an older launch that sends nothing is not the same', () => {
    assert.strictEqual(tools.sameCode(describe(), undefined), false);
    assert.strictEqual(tools.sameCode(describe(), {}), false);
    assert.strictEqual(tools.sameCode(describe(), 'DEV'), false);
  });
  await ok('DEV and DIAG are not the same launch even on one commit', () => {
    assert.strictEqual(tools.sameCode(describe(), tools.identityOf(describe({ mode: 'diag' }))), false);
  });
  await ok('what a launch tells the running one is only what the refusal shows', () => {
    assert.deepStrictEqual(Object.keys(tools.identityOf(describe())).sort(), ['badgeText', 'dirty', 'known', 'mode', 'sha']);
  });

  // --- refusals -------------------------------------------------------------------
  await ok('the busy-profile dialog names what is open and what was turned away', () => {
    const box = tools.busyProfileDialog(describe(), identity({ sha: SHA_B, branch: 'codex/saibb228/LIB-009-x' }));
    assert.ok(box.detail.includes('DEV · COLLAB-003 · aaaaaaa'), box.detail);
    assert.ok(box.detail.includes('DEV · LIB-009 · bbbbbbb'), box.detail);
    assert.ok(box.detail.includes('Znada-Dev'), box.detail);
  });
  await ok('a launch that sent no label is still named honestly', () => {
    assert.ok(tools.busyProfileDialog(describe(), undefined).detail.includes('не назван'));
  });
  await ok('the console refusal of a second launch names the profile and that launch', () => {
    const text = tools.busyProfileMessage(describe());
    assert.ok(text.includes('Znada-Dev') && text.includes('DEV · COLLAB-003 · aaaaaaa'), text);
  });
  await ok('each refusal says what is missing and how to launch instead', () => {
    const dev = tools.refusalMessage(REFUSALS.DEV_WITHOUT_PROFILE);
    assert.ok(dev.includes('ZNADA_DEV_USER_DATA') && dev.includes('Znada-DEV.bat'), dev);
    const partial = tools.refusalMessage(REFUSALS.DIAG_INCOMPLETE);
    assert.ok(partial.includes('ZNADA_DIAGNOSTICS=1') && partial.includes('--diagnostics')
      && partial.includes('Znada-DIAG.bat'), partial);
    const noFolder = tools.refusalMessage(REFUSALS.DIAG_WITHOUT_PROFILE);
    assert.ok(noFolder.includes('ZNADA_DIAGNOSTICS_USER_DATA'), noFolder);
    for (const code of Object.values(REFUSALS)) {
      assert.notStrictEqual(tools.refusalMessage(code), tools.refusalMessage(`unknown-${code}`),
        `${code} has no text of its own`);
    }
  });

  // --- the hour -------------------------------------------------------------------
  await ok('the limit is one hour, and that is the default', () => {
    assert.strictEqual(tools.SESSION_LIMIT_MS, HOUR);
    const session = tools.createSessionLimit({ onExpire: () => {} });
    try { assert.strictEqual(session.state().limitMs, HOUR); } finally { session.dispose(); }
  });
  await ok('nothing happens a moment before the hour', () => {
    const clock = fakeClock();
    const { session, expiries } = limitOn(clock);
    clock.advance(HOUR - 1);
    clock.run();
    assert.strictEqual(expiries(), 0);
    assert.strictEqual(session.state().expired, false);
    assert.strictEqual(clock.pending().length, 1);
  });
  await ok('at the hour it closes, exactly once', () => {
    const clock = fakeClock();
    const { session, expiries } = limitOn(clock);
    clock.advance(HOUR);
    clock.run();
    assert.strictEqual(expiries(), 1);
    clock.advance(HOUR);
    clock.run();
    session.check();
    session.start();
    assert.strictEqual(expiries(), 1);
    assert.strictEqual(clock.pending().length, 0);
  });
  await ok('an awake machine closes on time: the last wait is cut to what is left', () => {
    const clock = fakeClock();
    limitOn(clock);
    clock.advance(HOUR - 7_000);
    clock.run();
    assert.deepStrictEqual(clock.pending().map((t) => t.ms), [7_000]);
  });
  await ok('a sleep nobody reported still ends the hour within one check', () => {
    const clock = fakeClock();
    const { expiries } = limitOn(clock);
    clock.advance(2 * HOUR, { wallOnly: true });   // asleep: the wall clock runs, nothing becomes due
    clock.run();
    assert.strictEqual(expiries(), 0);
    clock.advance(tools.CHECK_EVERY_MS, { monoOnly: true });
    clock.run();
    assert.strictEqual(expiries(), 1);
  });
  await ok('a reported wake-up closes at once', () => {
    const clock = fakeClock();
    const { session, expiries } = limitOn(clock);
    clock.advance(HOUR + 1, { wallOnly: true });
    assert.strictEqual(session.check(), true);
    assert.strictEqual(expiries(), 1);
  });
  await ok('setting the wall clock back does not stretch the hour', () => {
    const clock = fakeClock();
    const { expiries } = limitOn(clock);
    clock.setWall(clock.wall() - 3 * HOUR);
    clock.advance(HOUR, { monoOnly: true });
    clock.run();
    assert.strictEqual(expiries(), 1);
  });
  await ok('a check from a wake-up does not leave a second timer behind', () => {
    const clock = fakeClock();
    const { session } = limitOn(clock);
    session.check();
    session.check();
    session.start();
    assert.strictEqual(clock.pending().length, 1);
  });
  await ok('there is nothing that extends, restarts or switches it off', () => {
    const clock = fakeClock();
    const { session, expiries } = limitOn(clock);
    assert.deepStrictEqual(Object.keys(session).sort(), ['check', 'dispose', 'start', 'state']);
    const deadline = session.state().deadline;
    clock.advance(40 * 60 * 1000);
    session.start();
    session.check();
    assert.strictEqual(session.state().deadline, deadline);
    clock.advance(20 * 60 * 1000);
    clock.run();
    assert.strictEqual(expiries(), 1);
  });
  await ok('an app that quits first disposes the timer, and nothing fires afterwards', () => {
    const clock = fakeClock();
    const { session, expiries } = limitOn(clock);
    session.dispose();
    clock.advance(2 * HOUR);
    clock.run();
    assert.strictEqual(session.check(), false);
    assert.strictEqual(expiries(), 0);
    assert.strictEqual(clock.pending().length, 0);
    assert.strictEqual(session.state().armed, false);
  });
  await ok('a failing exit handler is contained and not retried in a loop', () => {
    const clock = fakeClock();
    let calls = 0;
    const realError = console.error;
    console.error = () => {};
    try {
      const { session } = limitOn(clock, { onExpire: () => { calls += 1; throw new Error('boom'); } });
      clock.advance(HOUR);
      clock.run();
      session.check();
      assert.strictEqual(calls, 1);
      assert.strictEqual(session.state().expired, true);
      assert.strictEqual(clock.pending().length, 0);
    } finally {
      console.error = realError;
    }
  });
  await ok('an exit handler is required', () => {
    assert.throws(() => tools.createSessionLimit({}), /onExpire/);
  });

  // --- the bounded wait for a library change -----------------------------------------
  await ok('a change that finishes lets the exit go on at once', async () => {
    const clock = fakeClock();
    let finish;
    const change = new Promise((resolve) => { finish = resolve; });
    const waited = tools.settleWithin(change, 15_000, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    finish();
    assert.strictEqual(await waited, 'settled');
    assert.strictEqual(clock.pending().length, 0);
  });
  await ok('one that fails lets it go on too', async () => {
    const clock = fakeClock();
    const failed = Promise.reject(new Error('write failed'));
    const waited = tools.settleWithin(failed, 15_000, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    assert.strictEqual(await waited, 'settled');
  });
  await ok('one that never finishes cannot hold the exit past the bound', async () => {
    const clock = fakeClock();
    const waited = tools.settleWithin(new Promise(() => {}), 15_000, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    clock.advance(15_000);
    clock.run();
    assert.strictEqual(await waited, 'timeout');
  });
  await ok('the bound is short next to the hour', () => {
    assert.ok(tools.SETTLE_LIMIT_MS > 0 && tools.SETTLE_LIMIT_MS <= 60_000);
  });

  // --- the page side ---------------------------------------------------------------
  const PRELOAD = path.join(ROOT, 'preload.js');
  function loadPreload(extraArgv) {
    const exposed = {};
    const stub = {
      contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
      ipcRenderer: { invoke: () => Promise.resolve(), on: () => {} },
      webUtils: { getPathForFile: () => '' },
    };
    const originalLoad = Module._load;
    const originalArgv = process.argv;
    Module._load = function patched(request, parent, isMain) {
      if (request === 'electron') return stub;
      return originalLoad.call(this, request, parent, isMain);
    };
    process.argv = ['electron.exe', '--type=renderer', ...extraArgv];
    try {
      delete require.cache[require.resolve(PRELOAD)];
      require(PRELOAD);
    } finally {
      Module._load = originalLoad;
      process.argv = originalArgv;
      delete require.cache[require.resolve(PRELOAD)];
    }
    return exposed.api;
  }

  await ok('the real preload hands the page exactly the label main passed, frozen', () => {
    const info = describe({ revision: revision({ dirty: true }) });
    const api = loadPreload(['--enable-sandbox', tools.rendererArg(info)]);
    assert.deepStrictEqual({ ...api.devLaunch },
      { mode: 'dev', badgeText: info.badgeText, details: info.details, dirty: true, known: true });
    assert.ok(Object.isFrozen(api.devLaunch));
    assert.strictEqual(typeof api.getConfig, 'function', 'the rest of the bridge must still be there');
  });
  await ok('without the argument the page gets no label', () => {
    assert.strictEqual(loadPreload([]).devLaunch, null);
  });
  await ok('a damaged argument is no label, and the bridge still loads', () => {
    const damaged = [
      '--znada-dev-launch=%E0%A4%A',
      '--znada-dev-launch={',
      `--znada-dev-launch=${encodeURIComponent('{"badgeText":5}')}`,
    ];
    for (const bad of damaged) {
      const api = loadPreload([bad]);
      assert.strictEqual(api.devLaunch, null, bad);
      assert.strictEqual(typeof api.getConfig, 'function', bad);
    }
  });
  await ok('the preload reads the label without require: it runs sandboxed in DEV', () => {
    const source = fs.readFileSync(PRELOAD, 'utf8');
    const start = source.indexOf('COLLAB-003');
    const end = source.indexOf('contextBridge.exposeInMainWorld');
    assert.ok(start > 0 && end > start, 'the label block is not where this test expects it');
    assert.ok(!/\brequire\s*\(/.test(source.slice(start, end)),
      'a require in a sandboxed preload takes the whole bridge down (QA-009)');
  });

  const badge = require('../renderer/dev-launch-badge.js');
  const BADGE_SOURCE = fs.readFileSync(path.join(ROOT, 'renderer', 'dev-launch-badge.js'), 'utf8');
  // The title bar as the badge sees it: the badge starts right after the icon and the name
  // (x 90); the tabs are centred, so on a 780 px window they start at x 236, on 940 px at 316.
  function fakeDocument({ navLeft = 316, navWidth = 308, badgeLeft = 90 } = {}) {
    const classes = new Set();
    const el = {
      hidden: true,
      textContent: '',
      title: '',
      classes,
      style: {},
      classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); } },
      getBoundingClientRect: () => ({ left: badgeLeft }),
    };
    const nav = { box: { left: navLeft, width: navWidth }, getBoundingClientRect() { return this.box; } };
    const bar = { name: 'titlebar' };
    const byId = { tbDevLaunch: el, tbNav: nav, titlebar: bar };
    return { el, nav, bar, doc: { getElementById: (id) => byId[id] || null } };
  }
  const LABEL = { mode: 'dev', badgeText: 'DEV · COLLAB-003 · aaaaaaa', details: 'd', dirty: false, known: true };

  await ok('the badge shows the label and keeps the details for hover', () => {
    const { el, doc } = fakeDocument();
    const info = describe();
    const label = { mode: 'dev', badgeText: info.badgeText, details: info.details, dirty: false, known: true };
    assert.strictEqual(badge.apply(doc, label), true);
    assert.strictEqual(el.hidden, false);
    assert.strictEqual(el.textContent, 'DEV · COLLAB-003 · aaaaaaa');
    assert.strictEqual(el.title, info.details);
    assert.deepStrictEqual([...el.classes], []);
  });
  await ok('an ordinary window keeps the badge hidden', () => {
    const { el, doc } = fakeDocument();
    assert.strictEqual(badge.apply(doc, null), false);
    assert.strictEqual(el.hidden, true);
    assert.strictEqual(badge.apply(doc, { badgeText: '' }), false);
    assert.strictEqual(el.hidden, true);
  });
  await ok('uncommitted or unnamed code is marked, and DIAG is told apart', () => {
    const dirty = fakeDocument();
    badge.apply(dirty.doc, { mode: 'dev', badgeText: 'DEV · x · a + правки', details: '', dirty: true, known: true });
    assert.ok(dirty.el.classes.has('is-dirty'));
    const unknown = fakeDocument();
    badge.apply(unknown.doc, { mode: 'dev', badgeText: 'DEV · версия не определена', details: '', dirty: false, known: false });
    assert.ok(unknown.el.classes.has('is-dirty'));
    const diag = fakeDocument();
    badge.apply(diag.doc, { mode: 'diag', badgeText: 'DIAG · x · a', details: '', dirty: false, known: true });
    assert.ok(diag.el.classes.has('is-diag') && !diag.el.classes.has('is-dirty'));
  });
  await ok('on a narrow window the label is cut before it reaches the tabs, never run under them', () => {
    const { el, doc } = fakeDocument({ navLeft: 236 });
    badge.apply(doc, LABEL);
    assert.strictEqual(badge.fit(doc), 134);
    assert.strictEqual(el.style.maxWidth, '134px');
  });
  await ok('a wide window keeps the usual cap', () => {
    const { el, doc } = fakeDocument({ navLeft: 486 });
    badge.apply(doc, LABEL);
    assert.strictEqual(badge.fit(doc), 280);
    assert.strictEqual(el.style.maxWidth, '280px');
  });
  await ok('while the tabs are hidden on the first-run screen the style cap applies', () => {
    const { el, doc } = fakeDocument({ navWidth: 0, navLeft: 0 });
    badge.apply(doc, LABEL);
    el.style.maxWidth = '99px';
    assert.strictEqual(badge.fit(doc), null);
    assert.strictEqual(el.style.maxWidth, '');
  });
  await ok('an ordinary window with no label is not touched by the fit', () => {
    const { el, doc } = fakeDocument({ navLeft: 236 });
    assert.strictEqual(badge.fit(doc), null);
    assert.deepStrictEqual(el.style, {});
  });
  await ok('the fit follows the window and the tabs as they change', () => {
    const { el, nav, bar, doc } = fakeDocument({ navLeft: 316 });
    let callback = null;
    const observed = [];
    const win = { ResizeObserver: class { constructor(cb) { callback = cb; } observe(target) { observed.push(target); } } };
    badge.apply(doc, LABEL);
    assert.strictEqual(badge.keepClearOfNav(doc, win), true);
    assert.deepStrictEqual(observed, [bar, nav]);
    assert.strictEqual(el.style.maxWidth, '214px');
    nav.box = { left: 236, width: 308 };   // the window was made narrower
    callback();
    assert.strictEqual(el.style.maxWidth, '134px');
  });
  await ok('without ResizeObserver the badge is still fitted once', () => {
    const { el, doc } = fakeDocument({ navLeft: 236 });
    badge.apply(doc, LABEL);
    assert.strictEqual(badge.keepClearOfNav(doc, {}), false);
    assert.strictEqual(el.style.maxWidth, '134px');
  });
  await ok('the page puts the label up by itself when the bridge carries one, and keeps it clear of the tabs', () => {
    const { el, doc } = fakeDocument({ navLeft: 236 });
    const label = { mode: 'dev', badgeText: 'DEV · x · a', details: 'd', dirty: false, known: true };
    const observed = [];
    const ResizeObserver = class { observe(target) { observed.push(target); } };
    vm.runInNewContext(BADGE_SOURCE, { window: { document: doc, api: { devLaunch: label }, ResizeObserver } });
    assert.strictEqual(el.hidden, false);
    assert.strictEqual(el.textContent, 'DEV · x · a');
    assert.strictEqual(el.style.maxWidth, '134px');
    assert.strictEqual(observed.length, 2);
  });
  await ok('and leaves it hidden in the browser preview, which has no bridge', () => {
    const { el, doc } = fakeDocument();
    vm.runInNewContext(BADGE_SOURCE, { window: { document: doc } });
    assert.strictEqual(el.hidden, true);
  });
  await ok('the title bar has the slot, hidden by default, and its script runs before the app script', () => {
    const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    assert.ok(/<span class="tb-dev-launch" id="tbDevLaunch" hidden><\/span>/.test(html), 'the badge slot is missing or not hidden');
    const badgeAt = html.indexOf('<script src="dev-launch-badge.js"></script>');
    const appAt = html.indexOf('<script src="renderer.js"></script>');
    assert.ok(badgeAt > 0 && badgeAt < appAt, 'the badge script must load, and before renderer.js');
  });
  await ok('hidden really hides it: the badge style keeps [hidden] as display none', () => {
    const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
    assert.ok(/\.tb-dev-launch\[hidden\]\s*\{\s*display:\s*none;?\s*\}/.test(css));
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log(`FAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exit(1);
  }
})();
