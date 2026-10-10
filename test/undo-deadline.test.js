'use strict';

// LIB-021. The Undo notice after a removal lasts 8 seconds in both windows; the cursor or
// keyboard focus on it stops the clock, and leaving continues from where it stopped. The
// line on screen follows `data-paused`; the clock itself is a timer.
//
// Checked here: the clock with fake timers, the DOM wiring with a fake element, and that
// both windows actually route their removal Undo through it while every other action
// keeps its old time.
//
// Run: node test/undo-deadline.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const UndoDeadline = require('../renderer/undo-deadline');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); passed += 1; console.log('  OK ' + name); }
  catch (e) { failures.push({ name, e }); console.log('  FAIL ' + name); }
}

// A clock whose time moves only when the test says so.
function fakeTime() {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { seq += 1; pending.set(seq, { fn, at: t + ms, ms }); return seq; },
    clearTimer: (id) => { pending.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
    pending: () => [...pending.values()],
  };
}

function fakeElement({ hovered = false } = {}) {
  const listeners = new Map();
  const attrs = {};
  const children = [];
  return {
    attrs, children, listeners,
    setAttribute(k, v) { attrs[k] = String(v); },
    appendChild(c) { children.push(c); return c; },
    addEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).concat(fn)); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)); },
    matches: (sel) => sel === ':hover' && hovered,
    fire(type) { for (const fn of listeners.get(type) || []) fn(); },
    count() { return [...listeners.values()].reduce((n, list) => n + list.length, 0); },
  };
}
const fakeDoc = {
  createElement: (tag) => {
    const props = {};
    return { tag, className: '', style: { setProperty: (k, v) => { props[k] = v; }, props } };
  },
};

// ---- the clock ----

ok('the notice lasts 8 seconds', () => {
  assert.strictEqual(UndoDeadline.DURATION_MS, 8000);
  const time = fakeTime();
  let expired = 0;
  UndoDeadline.create({ onExpire: () => { expired += 1; }, ...time });
  time.advance(7999);
  assert.strictEqual(expired, 0, 'ended before 8 seconds');
  time.advance(1);
  assert.strictEqual(expired, 1, 'did not end at 8 seconds');
});

ok('a hold stops the clock, leaving continues where it stopped', () => {
  const time = fakeTime();
  let expired = 0;
  const clock = UndoDeadline.create({ onExpire: () => { expired += 1; }, ...time });
  time.advance(3000);
  clock.hold('pointer', true);
  assert.ok(clock.isPaused());
  time.advance(60000);
  assert.strictEqual(expired, 0, 'the clock ran under the cursor');
  assert.strictEqual(clock.remaining(), 5000);
  clock.hold('pointer', false);
  time.advance(4999);
  assert.strictEqual(expired, 0, 'leaving started the 8 seconds over or ended early');
  time.advance(1);
  assert.strictEqual(expired, 1, 'leaving did not continue from where it stopped');
});

// Review of PR #104: with one pause the expiry was right even if resuming forgot to restart
// the count, so a second pause — the cursor coming back — was never checked.
ok('a second pause counts only the time run since the first one ended', () => {
  const time = fakeTime();
  let expired = 0;
  const clock = UndoDeadline.create({ onExpire: () => { expired += 1; }, ...time });
  time.advance(2000);
  clock.hold('pointer', true);
  time.advance(10000);
  clock.hold('pointer', false);
  assert.strictEqual(clock.remaining(), 6000, 'remaining right after the first pause');
  time.advance(1000);
  assert.strictEqual(clock.remaining(), 5000, 'remaining while running after a pause');
  clock.hold('pointer', true);
  assert.strictEqual(clock.remaining(), 5000, 'the second pause counted the first pause as running time');
  time.advance(10000);
  clock.hold('pointer', false);
  time.advance(4999);
  assert.strictEqual(expired, 0, 'ended early after the second pause');
  time.advance(1);
  assert.strictEqual(expired, 1, 'did not end after the second pause');
});

ok('the clock runs again only when the last hold lets go', () => {
  const time = fakeTime();
  let expired = 0;
  const clock = UndoDeadline.create({ onExpire: () => { expired += 1; }, ...time });
  clock.hold('pointer', true);
  clock.hold('focus', true);
  clock.hold('pointer', false);
  assert.ok(clock.isPaused(), 'focus still holds it');
  time.advance(20000);
  assert.strictEqual(expired, 0);
  clock.hold('focus', false);
  time.advance(8000);
  assert.strictEqual(expired, 1);
});

ok('a repeated hold or release changes nothing', () => {
  const time = fakeTime();
  let expired = 0;
  const clock = UndoDeadline.create({ onExpire: () => { expired += 1; }, ...time });
  clock.hold('pointer', false); // never held: must not start a second timer
  assert.strictEqual(time.pending().length, 1);
  clock.hold('pointer', true);
  clock.hold('pointer', true);
  clock.hold('pointer', false);
  assert.strictEqual(time.pending().length, 1);
  time.advance(8000);
  assert.strictEqual(expired, 1);
});

ok('cancel ends it without expiring', () => {
  const time = fakeTime();
  let expired = 0;
  const clock = UndoDeadline.create({ onExpire: () => { expired += 1; }, ...time });
  clock.cancel();
  time.advance(20000);
  clock.hold('pointer', true);
  clock.hold('pointer', false);
  time.advance(20000);
  assert.strictEqual(expired, 0);
  assert.strictEqual(time.pending().length, 0);
});

// ---- the line and the listeners ----

ok('attach adds the line last, with the same duration as the clock', () => {
  const time = fakeTime();
  const el = fakeElement();
  UndoDeadline.attach(el, fakeDoc, { onExpire() {}, ...time });
  const line = el.children[el.children.length - 1];
  assert.strictEqual(line.className, 'undo-deadline');
  assert.strictEqual(line.style.props['--undo-deadline-ms'], '8000ms');
  assert.strictEqual(el.attrs['data-paused'], 'false');
});

ok('cursor and focus pause the line and the clock together', () => {
  const time = fakeTime();
  let expired = 0;
  const el = fakeElement();
  UndoDeadline.attach(el, fakeDoc, { onExpire: () => { expired += 1; }, ...time });
  el.fire('mouseenter');
  assert.strictEqual(el.attrs['data-paused'], 'true');
  el.fire('focusin');
  el.fire('mouseleave');
  assert.strictEqual(el.attrs['data-paused'], 'true', 'focus on Undo should keep it paused');
  time.advance(30000);
  assert.strictEqual(expired, 0);
  el.fire('focusout');
  assert.strictEqual(el.attrs['data-paused'], 'false');
  time.advance(8000);
  assert.strictEqual(expired, 1);
});

ok('a notice appearing under a resting cursor starts paused', () => {
  const time = fakeTime();
  let expired = 0;
  const el = fakeElement({ hovered: true });
  UndoDeadline.attach(el, fakeDoc, { onExpire: () => { expired += 1; }, ...time });
  assert.strictEqual(el.attrs['data-paused'], 'true');
  time.advance(30000);
  assert.strictEqual(expired, 0);
});

ok('the reused main-window toast does not collect listeners', () => {
  const time = fakeTime();
  const el = fakeElement();
  const first = UndoDeadline.attach(el, fakeDoc, { onExpire() {}, ...time });
  first.cancel();
  assert.strictEqual(el.count(), 0, 'cancel left listeners behind');
  UndoDeadline.attach(el, fakeDoc, { onExpire() {}, ...time });
  time.advance(8000);
  assert.strictEqual(el.count(), 0, 'expiry left listeners behind');
});

// ---- both windows use it for the removal Undo, and only for that ----

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').split('\r\n').join('\n');
const grab = (file, name) => {
  const found = read(file).match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  assert.ok(found, name + ' must stay a separate function in ' + file);
  return found[0];
};

function mainWindow() {
  const time = fakeTime();
  const toastEl = Object.assign(fakeElement(), {
    textContent: '',
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } },
  });
  const ctx = {
    UndoDeadline,
    document: {
      createElement: (tag) => Object.assign(fakeDoc.createElement(tag), {
        addEventListener() {}, textContent: '',
      }),
    },
    $: (sel) => (sel === '#toast' ? toastEl : null),
    performance: { now: time.now },
    setTimeout: time.setTimer,
    clearTimeout: time.clearTimer,
  };
  // `toastAction` empties the toast with textContent = '' — let that drop the children.
  Object.defineProperty(toastEl, 'textContent', {
    get() { return this._text || ''; },
    set(v) { this._text = v; this.children.length = 0; },
  });
  vm.createContext(ctx);
  vm.runInContext('var toastTimer = null; var toastDeadline = null;', ctx);
  for (const name of ['stopToastDeadline', 'toast', 'toastAction']) vm.runInContext(grab('renderer/renderer.js', name), ctx);
  return { ctx, time, toastEl, shown: () => toastEl.classList.set.has('show') };
}

ok('main window: removal Undo lasts 8 s, any other action keeps 6 s', () => {
  const w = mainWindow();
  w.ctx.toastAction('removed', 'Undo', () => {}, { deadline: true });
  assert.ok(w.toastEl.children.some((c) => c.className === 'undo-deadline'), 'no deadline line');
  w.time.advance(7999);
  assert.ok(w.shown(), 'the Undo notice went before 8 s');
  w.time.advance(1);
  assert.ok(!w.shown(), 'the Undo notice stayed past 8 s');

  const v = mainWindow();
  v.ctx.toastAction('exported', 'Add to library', () => {});
  assert.ok(!v.toastEl.children.some((c) => c.className === 'undo-deadline'), 'a non-Undo action got a line');
  v.time.advance(6000);
  assert.ok(!v.shown(), 'a non-Undo action changed its 6 s');
});

ok('main window: a newer message stops the old Undo clock', () => {
  const w = mainWindow();
  w.ctx.toastAction('removed', 'Undo', () => {}, { deadline: true });
  w.time.advance(1000);
  w.ctx.toast('Theme switched');
  // Only the plain toast's own 2.4 s timer may remain: the old 8 s one would hide whatever
  // is on screen when it fires.
  assert.deepStrictEqual(w.time.pending().map((p) => p.ms), [2400], 'the old Undo clock is still running');
  assert.strictEqual(vm.runInContext('toastDeadline', w.ctx), null);
  assert.strictEqual(w.toastEl.count(), 0, 'the old notice left its listeners on the toast');
});

ok('main window: the removal toast asks for the deadline', () => {
  const src = grab('renderer/renderer.js', 'toastRemoved');
  assert.ok(/toastAction\([^;]*\{\s*deadline:\s*true\s*\}\)/.test(src), 'toastRemoved does not pass { deadline: true }');
});

ok('viewer: removal Undo goes through the deadline, the "add" notice does not', () => {
  const src = grab('renderer/viewer.js', 'showRemovalUndo');
  assert.ok(src.includes('UndoDeadline.attach('), 'showRemovalUndo does not use UndoDeadline');
  assert.ok(!/\b6000\b/.test(src), 'showRemovalUndo still has its own 6 s timer');
  const dismiss = grab('renderer/viewer.js', 'dismissViewerNotice');
  assert.ok(dismiss.includes('stopViewerNoticeClock()'), 'closing a notice does not stop the Undo clock');
});

ok('both windows load the module before their own script', () => {
  for (const [html, own] of [['renderer/index.html', 'renderer.js'], ['renderer/viewer.html', 'viewer.js']]) {
    const src = read(html);
    const at = src.indexOf('<script src="undo-deadline.js"></script>');
    assert.ok(at >= 0, html + ' does not load undo-deadline.js');
    assert.ok(at < src.indexOf('<script src="' + own + '"></script>'), html + ' loads it too late');
  }
});

ok('styles: the toast follows the theme and the line stands still with reduced motion', () => {
  const css = read('renderer/styles.css');
  const toastRule = css.match(/\n\.toast \{([^}]*)\}/);
  assert.ok(toastRule && /background:\s*var\(--toast-bg\)/.test(toastRule[1]), 'the toast background is fixed again');
  assert.ok(/color:\s*var\(--toast-fg\)/.test(toastRule[1]), 'the toast text colour is fixed again');
  const light = css.match(/:root \{([^}]*)\}/)[1];
  const dark = css.match(/html\.dark \{([^}]*)\}/)[1];
  assert.ok(/--toast-bg:\s*#ffffff/.test(light), 'the light theme toast is not light');
  assert.ok(/--toast-bg:\s*#2e2e2e/.test(dark), 'the dark theme toast changed');
  for (const file of ['renderer/styles.css', 'renderer/viewer.css']) {
    const sheet = read(file);
    assert.ok(/\[data-paused="true"\] > \.undo-deadline \{[^}]*animation-play-state:\s*paused/.test(sheet), file + ': the line does not pause');
    assert.ok(/prefers-reduced-motion: reduce\) \{[^@]*\.undo-deadline \{[^}]*animation:\s*none/.test(sheet), file + ': the line moves with reduced motion');
  }
});

if (failures.length) {
  console.log('\n' + failures.length + ' test(s) failed.');
  for (const f of failures) console.log('\n--- ' + f.name + ' ---\n' + (f.e && f.e.stack));
  process.exit(1);
}
console.log('\nAll ' + passed + ' undo-deadline tests passed.');
