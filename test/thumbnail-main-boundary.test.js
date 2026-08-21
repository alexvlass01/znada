'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = main.indexOf('const thumbCache = new Map();');
const end = main.indexOf('function liveFolderDiscovery', start);
assert.ok(start >= 0 && end > start, 'thumbnail integration block is present');
const block = main.slice(start, end);

assert.ok(block.includes('thumbnailHost.thumbnail(p, W, 82)'), 'main delegates extraction to ThumbnailHost');
assert.ok(block.includes('result.dataBase64'), 'main consumes the encoded helper payload');
assert.ok(block.includes("url: 'data:' + mime + ';base64,' + body"), 'thumbInfo keeps its data URL shape');
assert.ok(block.includes("ipcMain.handle('thumb'"), 'thumb IPC remains registered');
assert.ok(block.includes("ipcMain.handle('thumb-info'"), 'thumb-info IPC remains registered');
assert.ok(block.includes("ipcMain.handle('thumb-aspects'"), 'thumb-aspects IPC remains registered');
assert.ok(block.includes('thumbPending.get(key)'), 'matching pending work stays deduplicated');

// Renaming a sender guard must not leave a stale call behind. thumb-aspects once kept
// calling isTrustedThumbnailSender after the helper became isTrustedMainWindowSender,
// which threw ReferenceError at runtime and silently killed aspect prefetch/persistence.
// node --check cannot catch that, so assert every guard call resolves to a definition.
const guardCalls = new Set(
  Array.from(main.matchAll(/\b(isTrusted[A-Za-z]*Sender)\s*\(/g), (m) => m[1]),
);
assert.ok(guardCalls.size > 0, 'trusted-sender guards are still in use');
for (const name of guardCalls) {
  assert.ok(
    new RegExp(`function\\s+${name}\\s*\\(`).test(main),
    `${name}() is called but never defined in main.js`,
  );
}
assert.ok(block.includes('runThumbnailTask(async () =>'), 'thumbnail work stays in the bounded task queue');
assert.ok(block.includes('}, { priority }).finally'), 'current virtual window priority reaches the task queue');
assert.ok(block.includes('queueLiveFolderAspect(p, data.width / data.height)'),
  'successful thumbnails enqueue persistent live-folder aspect metadata');
assert.ok(main.includes('library.setAspect(config.library, id, update.path, update.aspect)'),
  'materialized live-folder images receive the same persistent aspect metadata');
assert.ok(main.includes('if (configChanged) saveLibrarySoon();'),
  'aspect-only pool backfill is saved without a renderer config broadcast');
// Scoped to the function body rather than "up to the first }": saveLibrarySoon now has
// a branch in it (the degraded mode where the store file cannot be written and the pool
// has to go inline into config.json instead), and a `[^}]*` regex silently stopped
// matching at that branch's brace.
const saveLibrarySoonBody = (() => {
  const start = main.indexOf('function saveLibrarySoon() {');
  return start < 0 ? '' : main.slice(start, main.indexOf('\n}', start));
})();
assert.ok(saveLibrarySoonBody.includes('libraryWriter.markDirty'),
  'the pool backfill path writes only the pool, and does so through the batched writer');
assert.ok(!saveLibrarySoonBody.includes('broadcastConfig'),
  'the pool backfill path still never broadcasts config');
assert.ok(saveLibrarySoonBody.includes('keepInline: true'),
  'an unusable store must not silently drop a pool edit: it goes inline into config.json');
assert.ok(block.includes('const key = `${p}|${W}`;'), 'dedup key matches the helper scalar size');
assert.ok(!main.includes('createThumbnailFromPath'), 'main no longer runs Windows thumbnail extraction');
assert.ok(main.includes('void thumbnailHost.dispose();'), 'app shutdown disposes the helper');
assert.ok(/flushPendingLiveFolderAspects\(\);\r?\n  flushLiveFolderState\(\);/.test(main),
  'shutdown flushes learned aspects before saving folder state');
assert.ok(main.includes('aspect: (m && m.aspect) || 0'),
  'folder navigation exposes persisted aspect metadata to renderer');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
assert.ok(renderer.includes('knownLibAspect(item, path, entry && entry.aspect)'),
  'virtual layout uses persisted folder aspects before creating cards');
assert.ok(renderer.includes('buildEphemeralImageCard(entry.path, entry.aspect)'),
  'ephemeral cards start with their persisted aspect metadata');
assert.ok(renderer.includes('Math.abs(current - window.JustifiedLayout.normalizeAspect(aspect, 0.65, 3))'),
  'a replaced file can correct stale persisted geometry from its real thumbnail');

console.log('thumbnail-main-boundary.test.js ok');
