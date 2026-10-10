'use strict';

// BUG-052. The viewer opens on the monitor under the cursor, in that monitor's work
// area, and the size is applied with setBounds after the window exists.
//
// The constructor is not the size that lands. On the portrait display (125%) it turned
// a 960×1536 work area into 1200×1292, so the picture sat on the right and the forward
// arrow was off the screen. Node cannot reproduce that DPI step. What it can lock is
// the call that the live measurement showed sticks: setBounds with the work area, not
// the full bounds (the primary taskbar stays) and not a size invented here.
//
// Run: node test/gallery-window.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');

let passed = 0;
const failures = [];

function test(name, fn) {
  const dir = H.makeTempProfile('gallery-window');
  const quiet = console.error;
  console.error = () => {};
  try {
    H.writeJson(path.join(dir, 'config.json'), { autoSwitch: true, style: 'fill', monitors: {} });
    H.writeJson(path.join(dir, 'config.library.json'), { version: 1, library: {}, trash: [] });
    fn(dir);
    console.error = quiet;
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error = quiet;
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n    ' + (err && err.message));
  } finally {
    console.error = quiet;
    try { H.unloadMain(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function openViewer(m, dir) {
  m.__test.loadConfig();
  const opened = m.invoke('gallery-open', {
    items: [{ kind: 'path', key: 'k', path: path.join(dir, 'x.png'), title: 'x' }],
    index: 0,
  });
  assert.strictEqual(opened && opened.ok, true, JSON.stringify(opened));
  const viewer = m.calls.windows.find((w) => String(w.options.title || '').startsWith('Znada Media Viewer'));
  assert.ok(viewer, 'no viewer window was created');
  return viewer;
}

const PORTRAIT = {
  id: 2,
  bounds: { x: 1920, y: -352, width: 960, height: 1600 },
  workArea: { x: 1920, y: -352, width: 960, height: 1536 },
  scaleFactor: 1.25,
};

test('the portrait monitor gets its work area through setBounds', (dir) => {
  const m = H.loadMain(dir, { cursorDisplay: PORTRAIT });
  const viewer = openViewer(m, dir);
  assert.deepStrictEqual(viewer.placed, PORTRAIT.workArea);
  assert.deepStrictEqual(
    { x: viewer.options.x, y: viewer.options.y, width: viewer.options.width, height: viewer.options.height },
    PORTRAIT.workArea,
  );
  assert.notStrictEqual(viewer.placed.height, PORTRAIT.bounds.height);
  assert.strictEqual(viewer.options.frame, false);
  assert.ok(viewer.options.fullscreen !== true);
});

test('the primary monitor keeps the taskbar inset', (dir) => {
  const m = H.loadMain(dir);
  const viewer = openViewer(m, dir);
  assert.deepStrictEqual(viewer.placed, { x: 0, y: 0, width: 1280, height: 680 });
  assert.notStrictEqual(viewer.placed.height, 720);
});

// The stub window reports itself destroyed, so ready-to-show would return before the
// second setBounds. Here the window stays alive and its size is spoiled first, as a page
// load might do: only the call at ready-to-show can bring the work area back.
test('ready-to-show puts the window back on the work area', (dir) => {
  const m = H.loadMain(dir, { cursorDisplay: PORTRAIT });
  const viewer = openViewer(m, dir);
  Object.assign(viewer, {
    isDestroyed: () => false, isMinimized: () => false, isVisible: () => true,
    restore() {}, focus() {}, setAlwaysOnTop() {}, moveTop() {},
  });
  viewer.placed = { x: 1920, y: -352, width: 1200, height: 1292 };
  const handlers = viewer.listeners.get('ready-to-show') || [];
  assert.strictEqual(handlers.length, 1, 'expected one ready-to-show handler');
  handlers[0]();
  assert.deepStrictEqual(viewer.placed, PORTRAIT.workArea);
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`FAILED: ${f.name}\n  ${f.err && f.err.stack}`);
  process.exit(1);
}
