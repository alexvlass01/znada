'use strict';

// DATA-006 step 3. What the move window says, decided without a DOM.
//
// The three states are the owner's (2026-09-09): ask before starting, show the work,
// say how it ended. Each answer here is a key plus parameters, so the same decision can
// be checked in every language and cannot quietly become an empty screen.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const MediaFolder = require('../renderer/media-folder.js');

const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'en.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'ru.json'), 'utf8'));

let checks = 0;
const pending = [];
function check(name, fn) {
  // Every check runs in order; an async one is awaited before the next begins.
  pending.push(async () => {
    await fn();
    checks += 1;
    console.log(`  ok ${name}`);
  });
}

function lookup(catalogue, key) {
  return key.split('.').reduce((node, part) => (node == null ? node : node[part]), catalogue);
}

const seenKeys = new Set();
function keyed(value) {
  if (value) seenKeys.add(value);
  return value;
}

check('the settings row says either "in the app folder" or the folder itself', () => {
  assert.deepStrictEqual(
    MediaFolder.pathLabel({ custom: false, root: 'C:\\Users\\a\\AppData\\Roaming\\znada\\wallpapers' }),
    { key: keyed('mediaFolder.inProfile'), text: '' },
  );
  assert.deepStrictEqual(
    MediaFolder.pathLabel({ custom: true, root: 'D:\\Картинки\\Znada', folder: 'D:\\Картинки' }),
    { key: '', text: 'D:\\Картинки\\Znada' },
  );
  // No state at all reads as the default rather than as an empty row.
  assert.strictEqual(MediaFolder.pathLabel(null).key, 'mediaFolder.inProfile');
});

check('the question names the amount, the place and the free space', () => {
  const model = MediaFolder.confirmModel({
    count: 128, bytes: 561 * 1024 * 1024, free: 40 * 1024 * 1024 * 1024, to: 'D:\\Картинки\\Znada', blockers: [],
  });
  assert.strictEqual(model.canStart, true);
  assert.strictEqual(keyed(model.bodyKey), 'mediaFolder.confirmBody');
  assert.strictEqual(model.params.count, 128);
  assert.strictEqual(model.params.path, 'D:\\Картинки\\Znada');
  assert.deepStrictEqual(model.notes.map((note) => keyed(note.key)), ['mediaFolder.confirmFree']);
});

check('an empty library is not an error, and a removable drive is said out loud', () => {
  const model = MediaFolder.confirmModel({ count: 0, bytes: 0, to: 'E:\\Znada', blockers: [] }, { removable: true });
  assert.strictEqual(model.canStart, true);
  assert.strictEqual(keyed(model.bodyKey), 'mediaFolder.confirmNothing');
  assert.deepStrictEqual(model.notes.map((note) => keyed(note.key)), ['mediaFolder.confirmRemovable']);
});

check('a blocker stops the start and explains itself', () => {
  for (const [code, key] of [
    ['nested', 'mediaFolder.blockedNested'],
    ['no-space', 'mediaFolder.blockedNoSpace'],
    ['source-missing', 'mediaFolder.blockedSourceMissing'],
    ['destination-missing', 'mediaFolder.blockedDestinationMissing'],
    ['system', 'mediaFolder.blockedSystem'],
    ['profile', 'mediaFolder.blockedProfile'],
    ['relative', 'mediaFolder.blockedRelative'],
    ['library-degraded', 'mediaFolder.blockedDegraded'],
    ['source-invalid', 'mediaFolder.blockedSourceInvalid'],
  ]) {
    const model = MediaFolder.confirmModel({ count: 3, bytes: 10, to: 'D:\\x', blockers: [{ code }] });
    assert.strictEqual(model.canStart, false, `${code} must not be startable`);
    assert.strictEqual(keyed(model.blockers[0].key), key);
  }
  // An unknown code still says something rather than nothing.
  assert.strictEqual(MediaFolder.blockerKey('something-new'), 'mediaFolder.blockedRelative');
});

check('a count far above the visible library says where the rest comes from', () => {
  // Review of #34: 180 files for a library of six, 174 of them in the sweeper's own
  // recovery folder. The note names that share; the body still counts everything.
  const model = MediaFolder.confirmModel({
    count: 180, trashCount: 174, bytes: 513 * 1024 * 1024, free: 22 * 1024 * 1024 * 1024, to: 'D:\\x\\Znada', blockers: [],
  });
  assert.strictEqual(model.params.count, 180);
  assert.deepStrictEqual(model.notes.map((note) => keyed(note.key)), ['mediaFolder.confirmTrash', 'mediaFolder.confirmFree']);
  assert.strictEqual(model.notes[0].params.trash, 174);
  // Nothing in that folder: no note. A share larger than the whole is not believed.
  assert.deepStrictEqual(MediaFolder.confirmModel({ count: 6, trashCount: 0, to: 'D:\\x', blockers: [] }).notes, []);
  assert.strictEqual(MediaFolder.confirmModel({ count: 3, trashCount: 9, to: 'D:\\x', blockers: [] }).notes[0].params.trash, 3);
});

check('the way back asks no folder, and a picker answer can never mean it', async () => {
  let asked = 0;
  const api = { mediaFolderPick: async () => { asked += 1; return { folder: 'D:\\Pictures', canceled: false }; } };
  const back = await MediaFolder.chooseTarget({ appFolder: true, api, t: (k) => k, toast: () => {} });
  assert.deepStrictEqual(back, { appFolder: true });
  assert.strictEqual(asked, 0, 'going back must not open the folder picker');

  assert.strictEqual(await MediaFolder.chooseTarget({ api, t: (k) => k, toast: () => {} }), 'D:\\Pictures');
  const canceled = { mediaFolderPick: async () => ({ folder: '', canceled: true }) };
  assert.strictEqual(await MediaFolder.chooseTarget({ api: canceled, t: (k) => k, toast: () => {} }), null);
  keyed('mediaFolder.moveBack');
});

check('progress is measured in bytes, and stopping is offered only while it is free', () => {
  const copying = MediaFolder.progressModel({
    phase: 'copying', done: 3, total: 10, bytesDone: 25, bytesTotal: 100,
  });
  assert.strictEqual(keyed(copying.phaseKey), 'mediaFolder.phaseCopying');
  assert.strictEqual(copying.percent, 25, 'a few huge files among many small ones make count a liar');
  assert.deepStrictEqual(copying.countParams, { done: 3, total: 10 });
  assert.strictEqual(copying.canStop, true);

  // After the copying there is nothing left to stop: the library write is one atomic
  // step and the cleanup cannot be undone. A button that lies is worse than no button.
  for (const phase of ['committing', 'cleaning', 'done']) {
    assert.strictEqual(MediaFolder.progressModel({ phase }).canStop, false, `${phase} must not offer a stop`);
  }
  keyed(MediaFolder.progressModel({ phase: 'committing' }).phaseKey);
  keyed(MediaFolder.progressModel({ phase: 'cleaning' }).phaseKey);
  // Nothing to copy: no division by zero, no NaN on screen.
  assert.strictEqual(MediaFolder.progressModel({ phase: 'copying', done: 0, total: 0 }).percent, 0);
});

check('every ending says what happened to the files', () => {
  const done = MediaFolder.resultModel({
    status: 'done', copied: 5, alreadyThere: 2, folder: { root: 'D:\\Картинки\\Znada' },
  });
  assert.strictEqual(keyed(done.titleKey), 'mediaFolder.doneTitle');
  assert.strictEqual(keyed(done.bodyKey), 'mediaFolder.doneBody');
  assert.strictEqual(done.params.count, 7, 'files that were already there still moved with the library');

  const stopped = MediaFolder.resultModel({ status: 'stopped' });
  assert.strictEqual(keyed(stopped.titleKey), 'mediaFolder.stoppedTitle');
  assert.strictEqual(keyed(stopped.bodyKey), 'mediaFolder.stoppedBody');

  const failed = MediaFolder.resultModel({ status: 'failed' });
  assert.strictEqual(keyed(failed.titleKey), 'mediaFolder.failedTitle');
  assert.strictEqual(keyed(failed.bodyKey), 'mediaFolder.failedBody');

  const blocked = MediaFolder.resultModel({ status: 'blocked', blockers: [{ code: 'no-space' }] });
  assert.strictEqual(keyed(blocked.blockers[0].key), 'mediaFolder.blockedNoSpace');

  const busy = MediaFolder.resultModel({ status: 'busy' });
  assert.strictEqual(keyed(busy.blockers[0].key), 'mediaFolder.blockedBusy');

  // An answer that never arrived is still an ending, and it must not be a blank window.
  assert.strictEqual(MediaFolder.resultModel(null).titleKey, 'mediaFolder.failedTitle');
});

check('a move that carried nothing does not claim files moved or a folder cleared', () => {
  // BUG-050: the usual ending for a profile that never kept a picture of its own.
  const nothing = MediaFolder.resultModel({
    status: 'done', copied: 0, alreadyThere: 0, folder: { root: 'D:\\Картинки\\Znada' },
  });
  assert.strictEqual(keyed(nothing.titleKey), 'mediaFolder.doneNothingTitle');
  assert.strictEqual(keyed(nothing.bodyKey), 'mediaFolder.doneNothingBody');
  assert.strictEqual(nothing.params.path, 'D:\\Картинки\\Znada', 'the body still names where new pictures go');
  assert.strictEqual(nothing.tone, 'done', 'it is a success, not an error');
  // One file is still a move, with the ordinary words.
  const one = MediaFolder.resultModel({ status: 'done', copied: 1, folder: { root: 'D:\\Z' } });
  assert.strictEqual(one.titleKey, 'mediaFolder.doneTitle');
});

// Just enough of a document for openMoveDialog: elements that remember their listeners,
// a body that marks what it holds as connected, and keydown listeners on the document.
function fakeDocument() {
  const docListeners = new Map();
  function element(tag) {
    const listeners = new Map();
    const node = {
      tag, className: '', id: '', textContent: '', hidden: false, disabled: false, type: '', tabIndex: 0,
      style: {}, children: [], isConnected: false,
      setAttribute() {}, focus() {},
      appendChild(child) { node.children.push(child); return child; },
      append(...kids) { node.children.push(...kids); },
      remove() { node.isConnected = false; },
      addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
      fire(type, event = {}) { for (const fn of listeners.get(type) || []) fn({ target: node, preventDefault() {}, ...event }); },
    };
    return node;
  }
  return {
    createElement: element,
    body: { last: null, appendChild(child) { child.isConnected = true; this.last = child; return child; } },
    addEventListener(type, fn) { docListeners.set(type, [...(docListeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { docListeners.set(type, (docListeners.get(type) || []).filter((f) => f !== fn)); },
    key(key) { for (const fn of [...(docListeners.get('keydown') || [])]) fn({ key, preventDefault() {} }); },
  };
}

// A window's worth of api whose progress subscription can be counted.
function countingApi({ report = { status: 'done', copied: 0, folder: { root: 'D:\\Z' } } } = {}) {
  const state = { live: 0, disposed: 0 };
  const api = {
    mediaFolderPick: async () => ({ folder: 'D:\\Pictures', canceled: false }),
    mediaFolderPlan: async () => ({ ok: true, count: 0, bytes: 0, to: 'D:\\Pictures\\Znada', blockers: [] }),
    mediaFolderMove: async () => report,
    mediaFolderStop: async () => {},
    onMediaMoveProgress: () => {
      state.live += 1;
      return () => { state.live -= 1; state.disposed += 1; };
    },
  };
  return { api, state };
}

async function openWithFakeDom(api) {
  const doc = fakeDocument();
  global.document = doc;
  const opened = await MediaFolder.openMoveDialog({
    api, t: (k) => k, formatSize: (n) => `${n} B`, toast: () => {}, onState: () => {},
  });
  return { doc, opened };
}

check('closing the move window without moving drops its progress listener, every way out', async () => {
  // Release gate 1.7.6, stage 02: only a finished move used to unsubscribe. Each
  // cancelled window left one more listener on the progress channel for good.
  const ways = {
    cancel: ({ backdrop }) => backdrop.children[0].children[2].children[0].fire('click'),
    escape: ({ doc }) => doc.key('Escape'),
    outside: ({ backdrop }) => backdrop.fire('mousedown'),
  };
  for (const [way, close] of Object.entries(ways)) {
    const { api, state } = countingApi();
    const { doc } = await openWithFakeDom(api);
    assert.strictEqual(state.live, 1, `${way}: the open window listens for progress`);
    close({ doc, backdrop: doc.body.last });
    assert.strictEqual(state.live, 0, `${way}: the closed window must not keep its listener`);
  }
  delete global.document;
});

check('a finished move drops the listener once, and closing afterwards does not drop it again', async () => {
  const { api, state } = countingApi();
  const { doc } = await openWithFakeDom(api);
  const backdrop = doc.body.last;
  const [, , foot] = backdrop.children[0].children;
  const [cancel, confirm] = foot.children;
  confirm.fire('click');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.strictEqual(state.live, 0, 'the move is over, nothing left to report');
  assert.strictEqual(state.disposed, 1);
  cancel.fire('click'); // the button now reads "Close"
  assert.strictEqual(state.disposed, 1, 'a disposer called twice would remove someone else\'s listener');
  delete global.document;
});

check('every string this window can show exists in both reference catalogues', () => {
  // Plus the ones only the drawing uses, which the models above never return.
  for (const key of [
    'mediaFolder.title', 'mediaFolder.sub', 'mediaFolder.change', 'mediaFolder.pickTitle',
    'mediaFolder.confirmTitle', 'mediaFolder.start', 'mediaFolder.cancel', 'mediaFolder.close',
    'mediaFolder.progressTitle', 'mediaFolder.progressCount', 'mediaFolder.dontClose',
    'mediaFolder.stop', 'mediaFolder.stopping', 'mediaFolder.frozen', 'mediaFolder.measuring',
  ]) seenKeys.add(key);

  const missing = [];
  for (const key of seenKeys) {
    if (typeof lookup(en, key) !== 'string') missing.push(`en: ${key}`);
    if (typeof lookup(ru, key) !== 'string') missing.push(`ru: ${key}`);
  }
  assert.deepStrictEqual(missing, [], `strings this window shows are missing: ${missing.join(', ')}`);
  assert.ok(seenKeys.size >= 25, 'the checks above have to cover the window, not a corner of it');
});

check('the two reference catalogues agree on this section, placeholders included', () => {
  const enKeys = Object.keys(en.mediaFolder).sort();
  const ruKeys = Object.keys(ru.mediaFolder).sort();
  assert.deepStrictEqual(enKeys, ruKeys, 'en and ru must carry the same keys');
  for (const key of enKeys) {
    const holders = (text) => (String(text).match(/\{(\w+)\}/g) || []).sort().join(',');
    assert.strictEqual(holders(en.mediaFolder[key]), holders(ru.mediaFolder[key]),
      `placeholders differ in mediaFolder.${key}`);
  }
});

(async () => {
  for (const run of pending) await run();
  console.log(`PASS media-folder-ui: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
