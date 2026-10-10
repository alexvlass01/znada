'use strict';

// LIB-020. Run the actual selection-bar binding and its main IPC over disposable
// files. The dialog's keys/focus/lifecycle are tested by library-removal-dialog;
// here cancellation must preserve the selection and never become a failure toast.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const folderState = require('../src/folder-state');
const { pathKey } = require('../src/path-key');
const CardInteraction = require('../renderer/card-interaction');

const source = fs.readFileSync(path.join(H.ROOT, 'renderer/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
function rendererFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `missing function ${name}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end >= 0, `unterminated function ${name}`);
  return source.slice(start, end + 2);
}

function rendererFor(m, { removedView = false, invoke } = {}) {
  const calls = { requests: [], toasts: [], removed: [], restored: [], purged: [], redraws: 0, pending: [] };
  const buttons = new Map();
  for (const id of ['libSelClear', 'libSelPurge', 'libSelAssign', 'libSelDelete']) {
    buttons.set('#' + id, { events: {}, addEventListener(event, handler) { this.events[event] = handler; } });
  }
  const context = vm.createContext({
    config: m.__test.getConfig(),
    LIB: { selection: CardInteraction.createSelectionModel(), poolBySelectionKey: null },
    normPathKey: pathKey,
    $: (selector) => buttons.get(selector),
    inRemovedView: () => removedView,
    window: { api: { libraryRemoveMany(records, options) {
      calls.requests.push({ records: JSON.parse(JSON.stringify(records)), options });
      return invoke ? invoke(records, options) : m.invoke('library-remove-many', records, options);
    } } },
    syncSelectionUI() { calls.pending.push(context.librarySelectionBatchPending()); },
    renderLibrary() { calls.redraws++; }, renderPreviews() {}, renderHome() {},
    toast(message) { calls.toasts.push(message); }, t: (key) => key,
    toastRemoved(...args) { calls.removed.push(args); },
    restorePaths(paths) { calls.restored.push(Array.from(paths)); },
    deleteForever(paths) { calls.purged.push(Array.from(paths)); }, openMassAssignMenu() {},
  });
  // Execute the unchanged binding section from initLibrary, including its early
  // restore path and purge callback. No copy of the removal handler in the test.
  const start = source.indexOf('  // Selection bar buttons', source.indexOf('function initLibrary()'));
  const end = source.indexOf("  const sortEl = $('#libSort');", start);
  assert.ok(start > 0 && end > start, 'selection-bar bindings not found');
  vm.runInContext('let libraryBatchAssignPending = false; let libraryBatchRemovePending = false;\n'
    + ['librarySelectionBatchPending', 'removeSelectionSnapshot', 'poolItemForRecord', 'clearSelection']
      .map(rendererFunction).join('\n') + '\n' + source.slice(start, end), context);
  return {
    context, calls,
    select(items) { for (const item of items) context.LIB.selection.toggle({ ...item,
      key: CardInteraction.localKey(item.path, item.type) }); },
    click: (id = 'libSelDelete') => buttons.get('#' + id).events.click(),
  };
}

function seed(dir, types) {
  const items = types.map((type, i) => {
    const p = type === 'folder' ? path.join(dir, 'photos', 'folder-' + i)
      : path.join(dir, 'photos', 'image-' + i + '.png');
    H.writeImage(type === 'folder' ? path.join(p, 'child.png') : p);
    return { id: library.idFor(p), path: p, type, rev: 1, addedAt: 1, tags: ['keep'], favorite: true };
  });
  H.writeJson(path.join(dir, 'config.json'), { autoSwitch: false, style: 'fill', monitors: {} });
  H.writeJson(path.join(dir, 'config.library.json'), { version: 1,
    library: Object.fromEntries(items.map((item) => [item.id, item])), trash: [] });
  return items;
}

function originalsExist(items) {
  for (const item of items) assert.ok(fs.existsSync(item.type === 'folder'
    ? path.join(item.path, 'child.png') : item.path), 'original file lost');
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  const dir = H.makeTempProfile('bulk-confirm');
  const real = { log: console.log, error: console.error };
  const captured = [];
  console.log = console.error = (...args) => captured.push(args.join(' '));
  try {
    await fn(dir);
    passed++;
    real.log('  OK ' + name);
  } catch (error) {
    failures.push({ name, error, captured });
    real.error('  FAIL ' + name + ': ' + error.message);
  } finally {
    console.log = real.log; console.error = real.error;
    H.unloadMain();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await test('empty selection does not ask or remove', async (dir) => {
    seed(dir, []);
    const m = H.loadMain(dir); m.__test.loadConfig();
    const r = rendererFor(m);
    await r.click();
    assert.strictEqual(r.calls.requests.length, 0);
    assert.deepStrictEqual(r.calls.pending, []);
  });

  for (const types of [['image'], ['folder'], ['image', 'image'], ['image', 'folder'], ['folder', 'folder']]) {
    await test(`${types.join('+')}: threshold, trash, original files and Undo`, async (dir) => {
      const items = seed(dir, types);
      const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => true }); m.__test.loadConfig();
      const r = rendererFor(m);
      // Cards can acquire pool ids after first display; the production lookup
      // must still send the current pool records, not only the original card ids.
      r.select(items.map((item) => ({ ...item, id: null })));
      await r.click();
      assert.strictEqual(r.calls.requests.length, 1);
      assert.strictEqual(r.calls.requests[0].options.confirm, types.length >= 2);
      assert.strictEqual(m.calls.removalQuestions.length, types.length >= 2 ? 1 : 0);
      assert.strictEqual(m.calls.dialogs.length, 0, 'native dialog was used');
      if (types.length >= 2) {
        assert.strictEqual(m.calls.removalQuestions[0].count, types.length);
        assert.deepStrictEqual(m.calls.removalQuestions[0].names.map((entry) => entry.type), types);
      }
      for (const item of items) {
        assert.ok(!m.__test.getConfig().library[item.id]);
        assert.ok(m.__test.getConfig().libraryTrash.some((entry) => entry.item.id === item.id));
      }
      originalsExist(items);
      assert.strictEqual(r.context.LIB.selection.size, 0);
      assert.strictEqual(r.calls.redraws, 1);
      assert.strictEqual(r.calls.toasts.length, 0);
      assert.strictEqual(r.calls.removed[0][0], types.length);
      assert.ok(r.calls.removed[0][1], 'missing Undo token');
      const undo = await m.invoke('library-undo-remove', r.calls.removed[0][1]);
      assert.strictEqual(undo.error, null);
      for (const item of items) {
        assert.deepStrictEqual(m.__test.getConfig().library[item.id].tags, item.tags);
        assert.strictEqual(m.__test.getConfig().library[item.id].favorite, true);
      }
      originalsExist(items);
      assert.strictEqual(r.context.librarySelectionBatchPending(), false);
    });
  }

  for (const types of [['image', 'image'], ['image', 'folder'], ['folder', 'folder']]) {
    await test(`${types.join('+')}: decline is silent and preserves selection and stores`, async (dir) => {
      const items = seed(dir, types);
      const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => false }); m.__test.loadConfig();
      const before = fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8');
      const beforePool = JSON.stringify(m.__test.getConfig().library);
      const r = rendererFor(m); r.select(items);
      await r.click();
      assert.strictEqual(m.calls.removalQuestions.length, 1);
      assert.strictEqual(m.calls.dialogs.length, 0);
      assert.strictEqual(r.context.LIB.selection.size, types.length);
      assert.strictEqual(r.calls.toasts.length + r.calls.removed.length + r.calls.redraws, 0);
      assert.strictEqual(JSON.stringify(m.__test.getConfig().library), beforePool);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8'), before);
      assert.strictEqual(r.context.librarySelectionBatchPending(), false);
      originalsExist(items);
    });
  }

  await test('waiting question blocks repeat, Clear and Purge; decline allows next attempt', async (dir) => {
    const items = seed(dir, ['image', 'folder']);
    let answer;
    const m = H.loadMain(dir, { onLibraryRemovalQuestion: () => new Promise((resolve) => { answer = resolve; }) });
    m.__test.loadConfig();
    const r = rendererFor(m); r.select(items);
    const pending = r.click();
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.strictEqual(typeof answer, 'function', 'question was not requested');
    assert.strictEqual(r.context.librarySelectionBatchPending(), true);
    assert.ok(r.calls.pending.includes(true), 'busy state was not displayed');
    await r.click(); await r.click('libSelClear'); await r.click('libSelPurge');
    assert.strictEqual(r.calls.requests.length, 1);
    assert.strictEqual(m.calls.removalQuestions.length, 1);
    assert.strictEqual(r.context.LIB.selection.size, 2);
    assert.strictEqual(r.calls.purged.length, 0);
    assert.ok(items.every((item) => m.__test.getConfig().library[item.id]));
    answer(false); await pending;
    assert.strictEqual(r.context.librarySelectionBatchPending(), false);
    assert.strictEqual(r.calls.toasts.length + r.calls.redraws, 0);
    const retry = r.click();
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.strictEqual(m.calls.removalQuestions.length, 2);
    answer(true); await retry;
    assert.strictEqual(r.calls.removed.length, 1);
  });

  await test('live-folder cards without pool ids ask together, hide and Undo without deleting files', async (dir) => {
    const [root] = seed(dir, ['folder']);
    const first = path.join(root.path, 'child.png');
    const second = H.writeImage(path.join(root.path, 'second.png'));
    const m = H.loadMain(dir, { onLibraryRemovalQuestion: async () => true }); m.__test.loadConfig();
    m.__test.setLiveFolderState(folderState.reconcileFolder(folderState.emptyState(), {
      folderId: root.id, rootPath: root.path, status: 'complete',
      entries: [first, second].map((p) => ({ path: p, modifiedAt: 1000 })),
    }).state);
    const r = rendererFor(m);
    r.select([first, second].map((p) => ({ path: p, type: 'image' })));
    await r.click();
    assert.strictEqual(m.calls.removalQuestions[0].count, 2);
    assert.ok(r.calls.requests[0].records.every((record) => record.id === ''));
    assert.ok(m.__test.getConfig().library[root.id], 'connected root was removed');
    assert.strictEqual(r.calls.removed[0][0], 2);
    assert.strictEqual(folderState.listImages(m.__test.getLiveFolderState()).length, 0);
    const undo = await m.invoke('library-undo-remove', r.calls.removed[0][1]);
    assert.strictEqual(undo.error, null);
    assert.strictEqual(folderState.listImages(m.__test.getLiveFolderState()).length, 2);
    assert.ok(fs.existsSync(first) && fs.existsSync(second));
  });

  await test('success removes only its original selection snapshot', async (dir) => {
    const items = seed(dir, ['image', 'image', 'image']);
    let answer;
    const m = H.loadMain(dir, { onLibraryRemovalQuestion: () => new Promise((resolve) => { answer = resolve; }) });
    m.__test.loadConfig();
    const r = rendererFor(m); r.select(items.slice(0, 2));
    const pending = r.click();
    await new Promise((resolve) => { setImmediate(resolve); });
    // A background reconciliation can refresh the selection while the user is
    // considering the question. Its new entry is outside this request's snapshot.
    r.select([items[2]]);
    answer(true); await pending;
    assert.strictEqual(r.calls.requests[0].records.length, 2);
    assert.strictEqual(r.context.LIB.selection.size, 1);
    assert.ok(r.context.LIB.selection.has(CardInteraction.localKey(items[2].path, 'image')));
    assert.ok(m.__test.getConfig().library[items[2].id]);
  });

  for (const result of ['reject', { error: 'remove_failed' }, { error: null, affected: 0 }, null]) {
    await test(`failure ${JSON.stringify(result)} preserves selection and clears pending`, async (dir) => {
      const items = seed(dir, ['image', 'image']);
      const m = H.loadMain(dir); m.__test.loadConfig();
      const r = rendererFor(m, { invoke: async () => {
        if (result === 'reject') throw new Error('transport failed');
        return result;
      } }); r.select(items);
      await r.click();
      assert.deepStrictEqual(r.calls.toasts, ['library.massDeleteFailed']);
      assert.strictEqual(r.calls.removed.length + r.calls.redraws, 0);
      assert.strictEqual(r.context.LIB.selection.size, 2);
      assert.strictEqual(r.context.librarySelectionBatchPending(), false);
    });
  }

  await test('two removed cards restore without a removal question', async (dir) => {
    const items = seed(dir, ['image', 'folder']);
    const m = H.loadMain(dir); m.__test.loadConfig();
    const r = rendererFor(m, { removedView: true }); r.select(items);
    await r.click();
    assert.deepStrictEqual(r.calls.restored, [items.map((item) => item.path)]);
    assert.strictEqual(r.calls.requests.length, 0);
    assert.strictEqual(m.calls.removalQuestions.length, 0);
  });

  await test('Purge keeps its existing photo-only path', async (dir) => {
    const items = seed(dir, ['image', 'folder']);
    const m = H.loadMain(dir); m.__test.loadConfig();
    const r = rendererFor(m); r.select(items);
    await r.click('libSelPurge');
    assert.deepStrictEqual(r.calls.purged, [[items[0].path]]);
    assert.strictEqual(r.calls.requests.length, 0);
  });

  for (const failure of failures) console.error(failure.name, failure.error.stack, failure.captured.join('\n'));
  console.log(`\n${passed} bulk-selection checks passed; ${failures.length} failed.`);
  process.exitCode = failures.length ? 1 : 0;
})();
