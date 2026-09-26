'use strict';

// DESIGN-009. The Library's left panel narrows and widens instead of jumping, without
// re-packing the gallery on every frame, and its toggle is the panel's own first row.
//
// The real setLibrarySidebarCollapsed and startRailAnimation from renderer.js run in a
// stand-in window: the claims are about the width the gallery is laid out at, the order
// of the resize lifecycle, and when the animation is NOT used.
//
// Run: node test/rail-animation.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').split('\r\n').join('\n');
const renderer = read('renderer/renderer.js');
const css = read('renderer/styles.css');
const html = read('renderer/index.html');

let passed = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); passed += 1; console.log('  ✓ ' + name); }
  catch (e) { failures.push({ name, e }); console.log('  ✗ ' + name + '\n    ' + (e && e.message)); }
}

const start = renderer.indexOf('function setLibrarySidebarCollapsed(');
const end = renderer.indexOf('function initLibrary()', start);
assert.ok(start > 0 && end > start, 'setLibrarySidebarCollapsed must stay just before initLibrary');
const source = renderer.slice(start, end);

const LIB_WIDTH = 1000;
const GAP = 22;
const widthFor = (collapsed) => LIB_WIDTH - GAP - (collapsed ? 54 : 174);

// A stand-in Library: `.lib` of a fixed width, a main column whose width is its fixed
// flex basis when one is set and the flexible remainder otherwise, and a grid inside it.
function env({ reduce = false, direction = 'row', libWidth = LIB_WIDTH } = {}) {
  const classes = new Set();
  const events = [];
  const timers = [];
  const main = { style: { flex: '' } };
  const lib = {
    querySelector: (sel) => (sel === '.lib-main' ? main : null),
    getBoundingClientRect: () => ({ width: libWidth }),
  };
  const view = {
    querySelector: (sel) => (sel === '.lib' ? lib : null),
    classList: {
      contains: (k) => classes.has(k),
      add: (k) => { classes.add(k); events.push('add:' + k); },
      remove: (k) => { classes.delete(k); events.push('remove:' + k); },
      toggle: (k, v) => { if (v) classes.add(k); else classes.delete(k); events.push(`toggle:${k}:${v}`); },
    },
  };
  const fixed = () => { const m = /^0 0 ([\d.]+)px$/.exec(main.style.flex); return m ? Number(m[1]) : null; };
  const grid = {
    isConnected: true,
    offsetParent: {},
    get clientWidth() { return fixed() ?? widthFor(classes.has('sidebar-collapsed')); },
  };
  const writes = [];
  const config = { librarySidebarCollapsed: false };
  const ctx = {
    config, Promise, t: (k) => k,
    $: (sel) => (sel === '#viewLibrary' ? view : { dataset: {}, setAttribute: () => {} }),
    activeLibraryGrid: () => grid,
    beginLibraryResizeAnchor: (g) => events.push(`capture:${g.clientWidth}`),
    layoutLibGrid: (g) => events.push(`layout:${g.clientWidth}`),
    scheduleLibraryResizeFinish: (g) => events.push(`finish:${g.clientWidth}`),
    getComputedStyle: (el) => (el === lib
      ? { flexDirection: direction, columnGap: GAP + 'px' }
      : { getPropertyValue: (name) => (name === '--rail-width' ? (classes.has('sidebar-collapsed') ? ' 54px' : ' 174px') : '') }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { if (id && timers[id - 1]) timers[id - 1].cleared = true; },
    window: {
      matchMedia: (q) => ({ matches: reduce && /prefers-reduced-motion:\s*reduce/.test(q) }),
      api: { setConfig: (patch) => { writes.push(patch); return Promise.resolve(); } },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  const runTimers = () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); };
  return { ctx, classes, events, timers, main, writes, config, runTimers };
}

console.log('\nDESIGN-009: the left panel moves, the gallery is laid out once\n');

ok('collapsing from the button lays the gallery out once, at its final width', () => {
  const e = env();
  e.ctx.setLibrarySidebarCollapsed(true, { persist: true, animate: true });
  assert.deepStrictEqual(e.events, [
    `capture:${widthFor(false)}`,
    'add:rail-animating',
    'toggle:sidebar-collapsed:true',
    `layout:${widthFor(true)}`,
    `finish:${widthFor(true)}`,
  ]);
  assert.strictEqual(e.main.style.flex, `0 0 ${widthFor(true)}px`, 'the main column takes its final width at once');
  assert.ok(e.classes.has('rail-animating') && e.classes.has('sidebar-collapsed'));
  // JSON: the patch is an object of the vm's realm, which deepStrictEqual refuses.
  assert.strictEqual(JSON.stringify(e.writes), '[{"librarySidebarCollapsed":true}]', 'the preference is still saved once');
});

ok('when the movement ends the main column is flexible again and the state stays', () => {
  const e = env();
  e.ctx.setLibrarySidebarCollapsed(true, { persist: true, animate: true });
  assert.strictEqual(e.timers.length, 1);
  assert.strictEqual(e.timers[0].ms, 240, '200 ms of movement and a little margin');
  e.runTimers();
  assert.strictEqual(e.main.style.flex, '');
  assert.ok(!e.classes.has('rail-animating'));
  assert.ok(e.classes.has('sidebar-collapsed'));
});

ok('widening works the same way the other round', () => {
  const e = env();
  e.ctx.setLibrarySidebarCollapsed(true);
  e.events.length = 0;
  e.ctx.setLibrarySidebarCollapsed(false, { persist: true, animate: true });
  assert.strictEqual(e.main.style.flex, `0 0 ${widthFor(false)}px`);
  assert.deepStrictEqual(e.events.filter((x) => /^(capture|layout|finish)/.test(x)),
    [`capture:${widthFor(true)}`, `layout:${widthFor(false)}`, `finish:${widthFor(false)}`]);
});

ok('a second press mid-movement turns it round without an old timer ending it early', () => {
  const e = env();
  e.ctx.setLibrarySidebarCollapsed(true, { persist: true, animate: true });
  e.ctx.setLibrarySidebarCollapsed(false, { persist: true, animate: true });
  assert.strictEqual(e.timers[0].cleared, true, 'the first movement\'s end is cancelled');
  assert.strictEqual(e.main.style.flex, `0 0 ${widthFor(false)}px`, 'the width comes from the panel\'s new target');
  assert.ok(e.classes.has('rail-animating') && !e.classes.has('sidebar-collapsed'));
  e.runTimers();
  assert.strictEqual(e.main.style.flex, '');
  assert.ok(!e.classes.has('rail-animating'));
});

ok('with "reduce motion" the panel switches at once, as before', () => {
  const e = env({ reduce: true });
  e.ctx.setLibrarySidebarCollapsed(true, { persist: true, animate: true });
  assert.ok(!e.events.includes('add:rail-animating'));
  assert.ok(e.classes.has('sidebar-collapsed'));
  assert.strictEqual(e.main.style.flex, '');
  assert.strictEqual(e.timers.length, 0);
  assert.deepStrictEqual(e.events.filter((x) => /^(capture|layout|finish)/.test(x)),
    [`capture:${widthFor(false)}`, `layout:${widthFor(true)}`, `finish:${widthFor(true)}`]);
});

ok('the narrow layout, where the panel is a strip on top, switches at once', () => {
  const e = env({ direction: 'column' });
  e.ctx.setLibrarySidebarCollapsed(true, { persist: true, animate: true });
  assert.ok(!e.events.includes('add:rail-animating'));
  assert.strictEqual(e.main.style.flex, '');
});

ok('a Library not on screen switches at once', () => {
  const e = env({ libWidth: 0 });
  e.ctx.setLibrarySidebarCollapsed(true, { persist: true, animate: true });
  assert.ok(!e.events.includes('add:rail-animating'));
  assert.ok(e.classes.has('sidebar-collapsed'));
});

ok('a preference restored at start-up is simply there, not animated', () => {
  const e = env();
  e.ctx.setLibrarySidebarCollapsed(true);
  assert.ok(!e.events.includes('add:rail-animating'));
  assert.strictEqual(e.timers.length, 0);
});

ok('pressing towards the state already shown does nothing', () => {
  const e = env();
  e.ctx.setLibrarySidebarCollapsed(false, { persist: true, animate: true });
  // The same no-op toggle the instant path always made; no capture, no movement.
  assert.deepStrictEqual(e.events, ['toggle:sidebar-collapsed:false']);
  assert.strictEqual(e.timers.length, 0);
});

ok('only the button asks for the movement', () => {
  const binding = renderer.slice(renderer.indexOf('function initLibrary()'));
  assert.ok(/\$\('#libSidebarToggle'\)\?\.addEventListener\('click', \(\) => \{\s*setLibrarySidebarCollapsed\(!config\.librarySidebarCollapsed, \{ persist: true, animate: true \}\);/.test(binding));
  assert.ok(/setLibrarySidebarCollapsed\(!!config\?\.librarySidebarCollapsed\);/.test(renderer), 'restoring the preference stays instant');
});

ok('the toggle is the panel\'s own first row, not a section and not a tab on its edge', () => {
  const nav = html.slice(html.indexOf('<nav class="lib-navigation" id="libNavigation">'));
  const firstButton = nav.match(/<button[^>]*>/)[0];
  assert.ok(/id="libSidebarToggle"/.test(firstButton), 'the first control inside the navigation card');
  assert.ok(/class="lib-rail-toggle"/.test(firstButton) && !/lib-railbtn/.test(firstButton),
    'not a section row: a click on it must not open a section');
  assert.ok(/aria-controls="libNavigation"/.test(firstButton));
  assert.ok(!/lib-rail-collapse/.test(html + css), 'the old edge tab is gone');
});

ok('the styles keep icons still, clip without breaking the sticky panel, and honour reduced motion', () => {
  assert.ok(/\.rail-animating \.lib-rail \{ transition: flex-basis var\(--rail-motion\); \}/.test(css));
  assert.ok(/--rail-motion: 200ms /.test(css) && /const RAIL_ANIMATION_MS = 200;/.test(renderer),
    'the CSS and the script agree on the length');
  assert.ok(/\.rail-animating \.lib \{ overflow-x: clip; \}/.test(css),
    'clip, not hidden: hidden would make .lib a scroll container and unstick the panel');
  assert.ok(!/\.sidebar-collapsed[^{]*\.lib-railbtn \{[^}]*padding/.test(css),
    'collapsed rows keep the expanded padding, so the icons do not move');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .lib-rail-section-body'));
  assert.ok(/\.lib-rail-toggle-divider, \.lib-navigation > \.lib-railbtn span, \.lib-account-caption \{ transition: none; \}/.test(reduced.slice(0, 400)));
});

if (failures.length) {
  console.log('\n' + failures.length + ' test(s) failed.');
  for (const f of failures) console.log('\n--- ' + f.name + ' ---\n' + (f.e && f.e.stack));
  process.exit(1);
}
console.log(`\nRail animation PASS: ${passed} checks`);
