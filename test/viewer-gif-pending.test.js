'use strict';

// BUG-065. "Some GIFs stop loading at about the second second and stay half-loaded."
// Seen in the real viewer 2026-11-07 on Gelbooru: the still JPEG sample of a GIF went up
// within a second, the "loading full quality" note went away with it, and the picture
// stood still while the moving original was still on its way (22 s for 33.7 MB) — or,
// above the old 30 MB proxy cap, never came at all.
//
// This drives the REAL `renderCore` from renderer/viewer.js in a vm, with the sources and
// `present` stubbed, and records the note (`setHd`) over the whole sequence:
//   - a moving picture: the note stays on while only the still sample is up, and goes
//     away once the original is shown;
//   - a still photo: the note goes away with the sample, as before (no new noise);
//   - a moving picture whose sample is already cached: the note is on as well.
//
// Run: node test/viewer-gif-pending.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const viewerSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'viewer.js'), 'utf8')
  .split('\r\n').join('\n');
const motionBadge = require('../renderer/motion-badge.js');

function viewerFn(name) {
  const m = viewerSrc.match(new RegExp(`(async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} must remain an explicit function in viewer.js`);
  return m[0];
}

let passed = 0;
const failures = [];

function makeViewer({ entry, cachedSample = false }) {
  const log = [];
  let releaseFull;
  const fullArrived = new Promise((done) => { releaseFull = done; });
  const shown = [];
  const ctx = {
    VIDEO: null,
    window: { MotionBadge: motionBadge },
    VIEWER: { token: 0, index: 0, items: [entry] },
    STAGE: { front: { getAttribute: () => shown[shown.length - 1] || '' } },
    IMG_CACHE: new Map(cachedSample ? [[0, { sample: 'sample-src' }]] : []),
    renderFirstFrameEnd: null,
    renderFullEnd: null,
    currentEntry: () => entry,
    diagSpan: () => () => {},
    $: () => null,
    t: (k) => k,
    renderActions: () => {},
    stageHasImage: () => shown.length > 0,
    resetZoom: () => {},
    setStageAlt: () => {},
    setHd: (on) => log.push(['hd', !!on]),
    scheduleLoadingPill: () => {},
    clearLoadingTimer: () => {},
    clearStage: () => {},
    setLoadError: () => log.push(['error']),
    prefetchNeighbors: () => {},
    retargetPrefetch: () => {},
    updateBackgroundFromSrc: () => {},
    cacheTier: () => {},
    previewSource: async () => 'thumb-src',
    sampleSource: async () => 'sample-src',
    fullSource: async () => { await fullArrived; return 'full-src'; },
    present: async (src) => { shown.push(src); log.push(['show', src]); return true; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${viewerFn('isVideoEntry')}\n${viewerFn('sampleIsStillStandIn')}\n${viewerFn('renderCore')}\nthis.renderCore = renderCore;`, ctx);
  return { log, run: () => ctx.renderCore(), releaseFull };
}

const tick = () => new Promise((done) => { setImmediate(done); });

// What the note was right after `src` went up.
function noteAfter(log, src) {
  const at = log.findIndex(([kind, value]) => kind === 'show' && value === src);
  assert.ok(at >= 0, `${src} was never shown: ${JSON.stringify(log)}`);
  let note = null;
  for (let i = 0; i < log.length; i++) {
    if (log[i][0] === 'hd') note = log[i][1];
    if (i > at && log[i][0] === 'show') break;
  }
  return note;
}

const GIF = { kind: 'internet', title: 'gif', raw: { provider: 'gelbooru', format: 'gif', animated: true } };
const PHOTO = { kind: 'internet', title: 'photo', raw: { provider: 'gelbooru', format: 'jpg', animated: false } };

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n    ' + (err && err.message));
  }
}

(async () => {
  await check('moving picture: the note stays while only the still sample is up', async () => {
    const v = makeViewer({ entry: GIF });
    const done = v.run();
    for (let i = 0; i < 20; i++) await tick();
    assert.strictEqual(noteAfter(v.log, 'sample-src'), true,
      'the original is still loading, and the still sample must not read as the whole picture');
    const last = v.log.filter(([k]) => k === 'hd').pop();
    assert.deepStrictEqual(last, ['hd', true], 'nothing may hide the note before the original');
    v.releaseFull();
    await done;
    assert.strictEqual(noteAfter(v.log, 'full-src'), false, 'the note goes once the original is up');
  });

  await check('still photo: the note goes with the sample, as before', async () => {
    const v = makeViewer({ entry: PHOTO });
    const done = v.run();
    for (let i = 0; i < 20; i++) await tick();
    assert.strictEqual(noteAfter(v.log, 'sample-src'), false);
    v.releaseFull();
    await done;
  });

  await check('moving picture with a cached sample: the note is on too', async () => {
    const v = makeViewer({ entry: GIF, cachedSample: true });
    const done = v.run();
    for (let i = 0; i < 20; i++) await tick();
    assert.strictEqual(noteAfter(v.log, 'sample-src'), true);
    v.releaseFull();
    await done;
    assert.strictEqual(noteAfter(v.log, 'full-src'), false);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
})().catch((err) => { console.error(err); process.exitCode = 1; });
