'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// Sources are compared as text, and git rewrites this checkout to CRLF. Normalising
// on read keeps multi-line assertions about CODE, not about line endings.
function readSource(...parts) {
  return fs.readFileSync(path.join(...parts), 'utf8').split('\r\n').join('\n');
}
const preload = readSource(ROOT, 'preload.js');
const main = readSource(ROOT, 'main.js');
const rendererDir = path.join(ROOT, 'renderer');
const renderer = fs.readdirSync(rendererDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => readSource(rendererDir, name))
  .join('\n');

function captures(text, re) {
  return [...text.matchAll(re)].map((match) => match[1]);
}

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

const invokedChannels = captures(preload, /ipcRenderer\.invoke\(['"]([^'"]+)/g);
const handledChannels = captures(main, /ipcMain\.handle\(['"]([^'"]+)/g);
const exposedMethods = captures(preload, /^\s{2}([A-Za-z_$][\w$]*):/gm);
const usedMethods = captures(renderer, /window\.api\.([A-Za-z_$][\w$]*)/g);

assert.deepStrictEqual(duplicates(invokedChannels), [], 'preload must expose each invoke channel once');
assert.deepStrictEqual(duplicates(handledChannels), [], 'main must register each invoke handler once');

const missingHandlers = [...new Set(invokedChannels)].filter((channel) => !handledChannels.includes(channel));
assert.deepStrictEqual(missingHandlers, [], `preload invoke channels without a main handler: ${missingHandlers.join(', ')}`);

const missingMethods = [...new Set(usedMethods)].filter((method) => !exposedMethods.includes(method));
assert.deepStrictEqual(missingMethods, [], `renderer window.api methods missing from preload: ${missingMethods.join(', ')}`);

assert.ok(invokedChannels.includes('set-hotkey'), 'atomic hotkey IPC is part of the public renderer bridge');
assert.ok(handledChannels.includes('set-hotkey'), 'main handles the atomic hotkey IPC');

// The fullscreen viewer is a SECOND window with a second bridge, and it was outside this
// check entirely — a typo in a viewer channel failed silently at runtime. It holds the
// same contract: nothing invoked that main does not handle, nothing called that the
// bridge does not expose.
const viewerPreload = readSource(rendererDir, 'viewer-preload.js');
const viewerJs = readSource(rendererDir, 'viewer.js');
const viewerCss = readSource(rendererDir, 'viewer.css');
const viewerInvoked = captures(viewerPreload, /ipcRenderer\.invoke\(['"]([^'"]+)/g);
const viewerExposed = captures(viewerPreload, /^\s{2}([A-Za-z_$][\w$]*):/gm);
const viewerUsed = captures(viewerJs, /window\.viewerApi\.([A-Za-z_$][\w$]*)/g);

assert.deepStrictEqual(duplicates(viewerInvoked), [], 'the viewer bridge must expose each invoke channel once');

const viewerMissingHandlers = [...new Set(viewerInvoked)].filter((channel) => !handledChannels.includes(channel));
assert.deepStrictEqual(viewerMissingHandlers, [], `viewer invoke channels without a main handler: ${viewerMissingHandlers.join(', ')}`);

const viewerMissingMethods = [...new Set(viewerUsed)].filter((method) => !viewerExposed.includes(method));
assert.deepStrictEqual(viewerMissingMethods, [], `viewer window.viewerApi methods missing from viewer-preload: ${viewerMissingMethods.join(', ')}`);

assert.ok(viewerUsed.length > 0, 'the viewer bridge check must actually be exercising the viewer');
assert.ok(viewerInvoked.includes('library-undo-remove'), 'the viewer exposes the real library Undo IPC');

// Both windows can remove while the other's toast is still visible. The main-window
// bridge and toast must carry the opaque removal token just like the viewer does;
// otherwise its old tokenless Undo would restore whichever newer snapshot main holds.
assert.ok(
  preload.includes("libraryUndoRemove: (token) => ipcRenderer.invoke('library-undo-remove', token)")
    && renderer.includes('async function undoLastRemoval(token)')
    && renderer.includes('window.api.libraryUndoRemove(token)')
    && renderer.includes("() => undoLastRemoval(undoToken)"),
  'the main-window Undo toast must stay bound to the exact removal token that created it',
);
const toastRemovedMatch = renderer.match(/function toastRemoved\([^)]*\) \{[\s\S]*?\n\}/);
assert.ok(toastRemovedMatch, 'main-window removal toast boundary is present');
let capturedUndo = null;
let invokedUndoToken = null;
const toastRemoved = vm.runInNewContext(`(${toastRemovedMatch[0]})`, {
  t: (key) => key,
  toast: () => {},
  toastAction: (_message, _label, action) => { capturedUndo = action; },
  undoLastRemoval: (token) => { invokedUndoToken = token; },
});
toastRemoved(1, 'older-main-removal');
assert.strictEqual(typeof capturedUndo, 'function');
capturedUndo();
assert.strictEqual(invokedUndoToken, 'older-main-removal',
  'the old main toast must submit its own token, allowing main to reject it after a newer viewer removal');

// A removal in fullscreen must not become a one-way state toggle. The notice is an
// actual button, stays visible long enough to act, and reports an unsuccessful Undo
// instead of painting the card as restored.
assert.ok(
  viewerJs.includes("undo.textContent = t('library.undo')")
    && viewerJs.includes('window.viewerApi.libraryUndoRemove(token)')
    && viewerJs.includes("t(restored ? 'library.undoneToast' : 'library.undoFailed')")
    && viewerJs.includes('}, 6000);')
    && viewerCss.includes('.media-notice-action'),
  'the viewer removal notice must expose a visible, transient, honestly reported Undo action',
);

// Execute the tiny state-transition boundary itself: transport errors and zero-work
// replies leave the entry removed; only a positive restore may put its identity back.
const applyUndoMatch = viewerJs.match(/function applyViewerUndoResult\([^)]*\) \{[\s\S]*?\n\}/);
assert.ok(applyUndoMatch, 'viewer Undo state boundary is present');
const applyViewerUndoResult = vm.runInNewContext(`(${applyUndoMatch[0]})`);
const pooled = { id: 'wallhaven:abc', path: 'C:/wallpapers/abc.jpg', type: 'image' };
for (const response of [null, { restored: 0, error: null }, { restored: 1, error: 'failed' }]) {
  const entry = { added: false, pooled: null };
  assert.strictEqual(applyViewerUndoResult(entry, pooled, response), false);
  assert.deepStrictEqual(entry, { added: false, pooled: null });
}
const restoredEntry = { added: false, pooled: null };
assert.strictEqual(applyViewerUndoResult(restoredEntry, pooled, { restored: 1, error: null }), true);
assert.strictEqual(restoredEntry.added, true);
assert.deepStrictEqual(restoredEntry.pooled, pooled);

// An IPC result can arrive after ArrowRight + ArrowLeft rebuilt the action bar. Prove
// the post-await synchronizer resolves the currently mounted button instead of writing
// to the detached pre-await node.
const syncCurrentMatch = viewerJs.match(/function syncCurrentAddAction\([^)]*\) \{[\s\S]*?\n\}/);
assert.ok(syncCurrentMatch, 'viewer post-await action synchronizer is present');
const current = { added: true, pooled };
const mounted = { name: 'mounted' };
let synced = null;
const syncCurrentAddAction = vm.runInNewContext(`(${syncCurrentMatch[0]})`, {
  currentEntry: () => current,
  $: () => mounted,
  syncAddAction: (entry, button) => { synced = { entry, button }; },
});
assert.strictEqual(syncCurrentAddAction(current), true);
assert.strictEqual(synced.entry, current);
assert.strictEqual(synced.button, mounted);
assert.strictEqual(syncCurrentAddAction({}), false, 'a result for a non-current card must not repaint the visible action');
assert.ok(
  viewerJs.includes('const restored = applyViewerUndoResult(entry, pooled, res);\n    syncCurrentAddAction(entry);'),
  'viewer Undo must re-resolve the mounted action after its IPC await',
);

// The same BrowserWindow is reused when the user opens a different gallery from the
// main window. Its old Undo belongs to the old payload and must disappear before the
// replacement is rendered.
const setPayloadMatch = viewerJs.match(/function setPayload\([^)]*\) \{[\s\S]*?\n\}/);
assert.ok(setPayloadMatch, 'viewer payload replacement boundary is present');
const payloadSequence = [];
const payloadState = { items: [], index: 0 };
const setPayload = vm.runInNewContext(`(${setPayloadMatch[0]})`, {
  VIEWER: payloadState,
  IMG_CACHE: { clear: () => payloadSequence.push('cache') },
  PREFETCHING: { clear: () => payloadSequence.push('prefetch') },
  normalizePayload: () => ({ items: [{ key: 'new' }], index: 0 }),
  applyBackgroundMode: () => payloadSequence.push('background'),
  dismissViewerNotice: () => payloadSequence.push('dismiss'),
  render: () => payloadSequence.push('render'),
});
setPayload({ background: 'ambient' });
assert.strictEqual(payloadSequence[0], 'dismiss', 'old viewer Undo must close before a new payload is rendered');
assert.strictEqual(payloadSequence[payloadSequence.length - 1], 'render');
assert.strictEqual(payloadState.items[0].key, 'new');

// The viewer closes when the user clicks the image background. The Undo notice is a
// control surface as a whole, so its text and padding must be excluded at both the
// pointer-down and pointer-up boundaries, not only the nested button.
const blocksCloseMatch = viewerJs.match(/function blocksViewerClose\([^)]*\) \{[\s\S]*?\n\}/);
assert.ok(blocksCloseMatch, 'viewer close-target boundary is present');
const blocksViewerClose = vm.runInNewContext(`(${blocksCloseMatch[0]})`);
const fakeTarget = (matches) => ({ closest: (selector) => {
  assert.strictEqual(selector, 'button, .media-notice');
  return matches;
} });
assert.strictEqual(blocksViewerClose(fakeTarget({ className: 'media-notice' })), true);
assert.strictEqual(blocksViewerClose(fakeTarget({ tagName: 'BUTTON' })), true);
assert.strictEqual(blocksViewerClose(fakeTarget(null)), false);
assert.strictEqual((viewerJs.match(/blocksViewerClose\(e\.target\)/g) || []).length, 2,
  'both pointer boundaries must protect notice clicks from closing the viewer');

console.log(`IPC contract OK: ${new Set(exposedMethods).size} methods, ${invokedChannels.length} invoke channels, ${handledChannels.length} handlers, ${new Set(viewerExposed).size} viewer methods.`);
