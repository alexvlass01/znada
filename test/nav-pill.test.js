'use strict';

// DESIGN-010i. The active tab's highlight travels to the new tab like the owner's reference
// (Takayu Studio s-split): the edge on the side of the move leaves first, the other follows,
// in about 400 ms. Settings fades it out where it stands; "reduce motion" places it instantly.
//
// The frames are checked as numbers, and the real attach() runs against a stand-in switcher
// whose MutationObserver is driven by hand — the claim is which class change animates and
// which does not.
//
// Run: node test/nav-pill.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const NavPill = require('../renderer/nav-pill');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').split('\r\n').join('\n');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const px = (value) => parseFloat(value);
const edges = (frame) => ({ left: px(frame.left), right: px(frame.left) + px(frame.width) });

ok('the move starts where the pill is and ends exactly on the new tab', () => {
  const frames = NavPill.splitFrames(3, 90, 92, 200);
  assert.deepStrictEqual(edges(frames[0]), { left: 3, right: 90 });
  assert.deepStrictEqual(edges(frames[frames.length - 1]), { left: 92, right: 200 });
});

ok('moving right, the right edge leads and the pill stretches wider than either tab', () => {
  const frames = NavPill.splitFrames(3, 90, 200, 290).map(edges);
  const mid = frames[Math.round(frames.length / 4)];
  const progressRight = (mid.right - 90) / 200;
  const progressLeft = (mid.left - 3) / 197;
  assert.ok(progressRight > progressLeft + 0.1, `front ${progressRight} vs back ${progressLeft}`);
  const widest = Math.max(...frames.map((f) => f.right - f.left));
  assert.ok(widest > 87 + 40, `the pill stretches (widest ${widest})`);
});

ok('moving left, the left edge leads', () => {
  const frames = NavPill.splitFrames(200, 290, 3, 90).map(edges);
  const mid = frames[Math.round(frames.length / 4)];
  assert.ok((200 - mid.left) / 197 > (290 - mid.right) / 200 + 0.1);
});

ok('the edges never cross, so the pill never turns inside out', () => {
  for (const [a, b, c, d] of [[3, 90, 200, 290], [200, 290, 3, 90], [3, 90, 92, 120]]) {
    NavPill.splitFrames(a, b, c, d).forEach((frame) => assert.ok(px(frame.width) >= 0));
  }
});

ok('both springs settle (the move does not end on a visible snap)', () => {
  for (const spring of [NavPill.FRONT, NavPill.BACK]) {
    const track = NavPill.springTrack(spring);
    assert.ok(Math.abs(1 - track[track.length - 1]) < 0.01);
  }
  assert.strictEqual(NavPill.DURATION, 400, 'the owner chose about 400 ms');
});

// --- the real attach() against a stand-in switcher ----------------------------------

function makeSwitcher({ reduced = false } = {}) {
  const classSet = (initial) => {
    const set = new Set(initial);
    return {
      contains: (c) => set.has(c),
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
    };
  };
  const tabs = [0, 1, 2].map((i) => ({
    offsetLeft: 3 + i * 100, offsetWidth: 90, classList: classSet(i === 0 ? ['navbtn', 'active'] : ['navbtn']),
  }));
  const animations = [];
  const pill = {
    classList: classSet(['tb-nav-pill', 'off']),
    style: { left: '', width: '' },
    animate(frames, options) {
      const anim = { frames, options, cancelled: false, cancel() { this.cancelled = true; } };
      animations.push(anim);
      return anim;
    },
  };
  const nav = {
    querySelector: (sel) => (sel === '.tb-nav-pill' ? pill : tabs.find((t) => t.classList.contains('active')) || null),
    querySelectorAll: () => tabs,
  };
  let mutated = null;
  const env = {
    MutationObserver: class { constructor(cb) { mutated = cb; } observe() {} },
    getComputedStyle: (el) => ({ left: el.style.left, width: el.style.width }),
    matchMedia: () => ({ matches: reduced }),
  };
  const select = (index) => {
    tabs.forEach((t, i) => t.classList.toggle('active', i === index));
    mutated();
  };
  NavPill.attach(nav, env);
  return { pill, animations, select };
}

ok('at start the pill sits on the active tab without moving', () => {
  const { pill, animations } = makeSwitcher();
  assert.deepStrictEqual(pill.style, { left: '3px', width: '90px' });
  assert.strictEqual(pill.classList.contains('off'), false);
  assert.strictEqual(animations.length, 0);
});

ok('clicking another tab animates from the old tab to the new one in 400 ms', () => {
  const { pill, animations, select } = makeSwitcher();
  select(2);
  assert.strictEqual(animations.length, 1);
  assert.strictEqual(animations[0].options.duration, 400);
  assert.deepStrictEqual(edges(animations[0].frames[0]), { left: 3, right: 93 });
  assert.deepStrictEqual(pill.style, { left: '203px', width: '90px' }, 'the resting place is set, not left to the animation');
});

ok('Settings fades the pill out where it stands; coming back it appears on the tab without sliding', () => {
  const { pill, animations, select } = makeSwitcher();
  select(-1);
  assert.strictEqual(pill.classList.contains('off'), true);
  assert.deepStrictEqual(pill.style, { left: '3px', width: '90px' }, 'it fades where it stood');
  select(1);
  assert.strictEqual(pill.classList.contains('off'), false);
  assert.deepStrictEqual(pill.style, { left: '103px', width: '90px' });
  assert.strictEqual(animations.length, 0, 'no slide from where it vanished');
});

ok('a click during a move cancels the old move', () => {
  const { animations, select } = makeSwitcher();
  select(2);
  select(1);
  assert.strictEqual(animations.length, 2);
  assert.strictEqual(animations[0].cancelled, true);
});

ok('a class change that does not change the active tab does not animate', () => {
  const { animations, select } = makeSwitcher();
  select(0);
  assert.strictEqual(animations.length, 0);
});

ok('with "reduce motion" the pill jumps straight to the tab', () => {
  const { pill, animations, select } = makeSwitcher({ reduced: true });
  select(2);
  assert.strictEqual(animations.length, 0);
  assert.deepStrictEqual(pill.style, { left: '203px', width: '90px' });
});

// --- wiring ---------------------------------------------------------------------------

ok('the page has the pill inside the switcher and loads the module before renderer.js', () => {
  const html = read('renderer/index.html');
  assert.match(html, /<div class="tb-nav" id="tbNav">\s*<span class="tb-nav-pill off" aria-hidden="true"><\/span>/);
  assert.ok(html.indexOf('src="nav-pill.js"') > 0 && html.indexOf('src="nav-pill.js"') < html.indexOf('src="renderer.js"'));
});

ok('the tab itself no longer paints a highlight, and the pill stands still under "reduce motion"', () => {
  const css = read('renderer/styles.css');
  assert.ok(!/\.navbtn\.active\s*\{/.test(css), 'a second highlight on the tab would jump while the pill travels');
  // The fade exists only when the system allows motion, like the Library tabs' add button.
  const gated = '@media (prefers-reduced-motion: no-preference) { .tb-nav-pill { transition: opacity var(--rail-motion); } }';
  assert.ok(css.includes(gated));
  const rest = css.split(gated).join('');
  assert.ok(!/\.tb-nav-pill[^{]*\{[^}]*transition/.test(rest), 'no unconditional fade');
});

console.log(`nav-pill: ${passed} passed`);
