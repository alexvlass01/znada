'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../src/folder-state');
const { pathKey } = require('../src/path-key');
const { createLiveFolderIndex } = require('../src/live-folder-index');
const { makeTempDir } = require('./helpers/temp-dir');
const root = makeTempDir('index-owner-');
const photo = path.join(root, 'sub', 'a.png');
const b = path.join(root, 'b.png');
const input = { folderId: 'root', rootPath: root, folderAddedAt: 1, now: 10, status: 'complete', entries: [
  { path: photo, modifiedAt: 5, size: 100 },
  { path: b, modifiedAt: 6, size: 200 },
] };
function fixture() {
  const timers = new Map(); let unrefs = 0, writes = 0, fail = false, lists = 0;
  const logs = [];
  const filePath = path.join(makeTempDir('index-store-'), 'folder-state.json');
  const io = { ...F,
    saveState: (...args) => { writes++; if (fail) throw new Error('fixture IO failure'); return F.saveState(...args); },
    listImages: (...args) => { lists++; return F.listImages(...args); },
  };
  const index = createLiveFolderIndex({ filePath, folderState: io, pathKey,
    logger: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    timers: { setTimeout: (fn, ms) => { const t = { unref: () => unrefs++ }; timers.set(t, { fn, ms }); return t; }, clearTimeout: t => timers.delete(t) },
  });
  return { index, timers, logs, filePath, fail: value => { fail = value; },
    stats: () => ({ writes, unrefs, lists }), disk: () => F.loadState(filePath).state };
}
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`ok ${name}`); }

check('debounce, unref, failure keeps dirty, retry and dispose without write', () => {
  const f = fixture(), i = f.index;
  i.load(); i.flush(); assert.strictEqual(f.stats().writes, 0);
  i.reconcile(input);
  assert.strictEqual(f.timers.size, 1);
  assert.strictEqual([...f.timers.values()][0].ms, 5000);
  i.scheduleSave(); assert.strictEqual(f.timers.size, 1); assert.strictEqual(f.stats().unrefs, 2);
  f.fail(true); i.flush(); assert.strictEqual(f.timers.size, 0); assert.strictEqual(f.logs.length, 1);
  f.fail(false); i.flush(); assert.strictEqual(f.stats().writes, 2);
  assert.strictEqual(F.listImages(f.disk()).length, 2);
  i.flush(); assert.strictEqual(f.stats().writes, 2);
  i.scheduleSave(); i.dispose(); assert.strictEqual(f.timers.size, 0); assert.strictEqual(f.stats().writes, 2);
  i.flush(); assert.strictEqual(f.stats().writes, 3);
});

check('each marks call returns only summary; persistNow retains separate immediate writes', () => {
  const f = fixture(), i = f.index; i.reconcile(input); i.flush();
  for (const [method, paths] of [['setHidden', [b]], ['setHiddenDir', [path.dirname(photo)]]]) {
    const result = i.marks[method](paths, true);
    assert.deepStrictEqual(Object.keys(result).sort(), ['changed', 'matched', 'updated']);
    result.changed = false; result.state = F.emptyState();
    i.marks.persistNow();
  }
  assert.strictEqual(f.stats().writes, 3);
  assert.strictEqual(F.listImages(f.disk(), null, { only: 'hidden' }).length, 2);
});

check('snapshot, replace input, rows and Sets cannot mutate owned state or file', () => {
  const f = fixture(), i = f.index; i.reconcile(input); i.marks.setHiddenDir([path.dirname(photo)], true); i.marks.persistNow();
  const snapshot = i.snapshot(); f.fail(true); i.replaceForMove(snapshot); snapshot.folders = {};
  assert.strictEqual(i.listImages(null, { only: 'all' }).length, 2);
  const copy = i.snapshot(); copy.folders.root.files = {};
  for (const list of [i.listImages(null, { only: 'all' }), i.marks.listHiddenImages(), i.listHiddenDirs(), i.marks.listHiddenDirs()]) {
    list[0].path = 'tampered'; list.length = 0;
  }
  i.hiddenPaths().clear(); i.marks.hiddenPaths().add('tampered'); i.knownPathKeys('root').clear();
  assert.ok(i.hiddenPaths().has(pathKey(photo)));
  assert.ok(!i.hiddenPaths().has('tampered'));
  assert.strictEqual(i.knownPathKeys('root').size, 2);
  f.fail(false); i.persistNow(); assert.strictEqual(F.listImages(f.disk(), null, { only: 'all' }).length, 2);
  assert.strictEqual(i.snapshot().folders.root.files['sub/a.png'].relativePath, 'sub/a.png');
});

check('cache invalidation after marks, rename, forget, load and replace; older Sets stay detached', () => {
  const f = fixture(), i = f.index; i.reconcile(input);
  const initial = i.hiddenPaths(); i.marks.setHidden([b], true);
  const hidden = i.hiddenPaths(); assert.strictEqual(initial.size, 0); assert.ok(hidden.has(pathKey(b)));
  i.marks.setHiddenDir([path.dirname(photo)], true); assert.strictEqual(i.hiddenPaths().size, 2);
  i.marks.setHiddenDir([path.dirname(photo)], false); assert.strictEqual(i.hiddenPaths().size, 1);
  const renamed = path.join(root, 'c.png');
  const result = i.reconcile({ ...input, now: 20, entries: [input.entries[0], { ...input.entries[1], path: renamed }] });
  assert.ok(!('state' in result));
  assert.ok(i.hiddenPaths().has(pathKey(renamed))); assert.ok(!i.hiddenPaths().has(pathKey(b)));
  assert.ok(hidden.has(pathKey(b)));
  // Preserve hidden content on disk, then erase memory and load again.
  i.persistNow(); i.forget(['root']); assert.strictEqual(i.hiddenPaths().size, 0);
  i.load(); assert.ok(i.hiddenPaths().has(pathKey(renamed)));
  i.replaceForMove(F.emptyState()); assert.strictEqual(i.hiddenPaths().size, 0);
  i.dispose();
});

check('forget schedules one save and flush persists removal of the folder', () => {
  const f = fixture(), i = f.index;
  const readDisk = () => JSON.parse(fs.readFileSync(f.filePath, 'utf8'));
  i.reconcile(input);
  i.flush();
  assert.strictEqual(f.timers.size, 0);
  assert.ok(readDisk().folders.root);

  i.forget(['root']);
  assert.strictEqual(f.timers.size, 1, 'forget must schedule a save');
  assert.ok(readDisk().folders.root, 'forget must defer the write until flush');

  i.flush();
  assert.strictEqual(f.timers.size, 0);
  assert.strictEqual(readDisk().folders.root, undefined);
});

check('aspect and test-only replacement invalidate cache without leaking state or writing eagerly', () => {
  const f = fixture(), i = f.index; i.reconcile(input); i.marks.setHidden([b], true); i.flush();
  i.hiddenPaths(); const before = f.stats().lists;
  assert.deepStrictEqual(i.setAspects([{ path: b, aspect: 2 }]), { changed: true, updated: 1 });
  assert.ok(i.hiddenPaths().has(pathKey(b))); assert.strictEqual(f.stats().lists, before + 1);
  assert.strictEqual(f.stats().writes, 1); i.flush();
  assert.strictEqual(F.listImages(f.disk(), null, { only: 'hidden' })[0].aspect, 2);
  const replacement = F.emptyState(); i.__test.replace(replacement); replacement.folders.bad = {};
  assert.deepStrictEqual(i.snapshot(), F.emptyState()); assert.strictEqual(i.hiddenPaths().size, 0);
  i.flush(); assert.strictEqual(f.stats().writes, 2);
});

check('repeated hiddenPaths only copies hidden Set, never walks the index again', () => {
  const f = fixture(), i = f.index; i.reconcile(input); i.marks.setHidden([b], true);
  i.hiddenPaths(); const count = f.stats().lists;
  for (let n = 0; n < 100; n++) assert.strictEqual(i.hiddenPaths().size, 1);
  assert.strictEqual(f.stats().lists, count); i.dispose();
});

console.log(`PASS index owner: ${checks} scenarios`);
