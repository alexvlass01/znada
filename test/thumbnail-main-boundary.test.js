'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
// Thumbnail extraction/cache/queue behaviour is exercised by thumbnail-service.test.js.

// Renaming a sender guard must not leave a stale call behind. thumb-aspects once kept
// calling isTrustedThumbnailSender after the helper became isTrustedMainWindowSender,
// which threw ReferenceError at runtime and silently killed aspect prefetch/persistence.
// node --check cannot catch that, so assert every guard call resolves to a definition.
const guardCalls = new Set(
  Array.from(main.matchAll(/\b(isTrusted[A-Za-z]*Sender)\s*\(/g), (m) => m[1]),
);
// SEC-002 replaced the hand-written per-handler guards with the registrar in
// src/ipc-authority.js, so there are none left to call - and asserting that at least one
// still EXISTED was pinning the old mechanism rather than the rule behind it. The loop
// below stays (it costs nothing and catches the same class if a guard ever returns);
// what replaces the count is a check on what actually guards these three channels now.
for (const name of guardCalls) {
  assert.ok(
    new RegExp(`function\\s+${name}\\s*\\(`).test(main),
    `${name}() is called but never defined in main.js`,
  );
}
const mainOnlyBlock = main.slice(main.indexOf('const IPC_MAIN_ONLY'), main.indexOf('const IPC_MAIN_AND_VIEWER'));
for (const channel of ['thumb', 'thumb-info', 'thumb-aspects']) {
  assert.ok(mainOnlyBlock.includes("'" + channel + "'"),
    channel + ' must stay a main-window-only channel');
}
assert.ok(main.includes('library.setAspect(config.library, id, update.path, update.aspect)'),
  'materialized live-folder images receive the same persistent aspect metadata');
assert.ok(main.includes('if (configChanged) saveLibrarySoon();'),
  'aspect-only pool backfill is saved without a renderer config broadcast');
// CODE-001 2.1a. What saveLibrarySoon does — batched pool write, no broadcast, inline into
// config.json while the pool file is unusable — is markPoolDirty() in src/config-store.js
// and is tested there (test/config-store.test.js). main.js keeps a one-line wrapper.
assert.ok(main.includes('function saveLibrarySoon() { configStore.markPoolDirty(); }'),
  'the pool backfill path is the store\'s batched pool write, not a broadcast');
assert.ok(!main.includes('createThumbnailFromPath'), 'main no longer runs Windows thumbnail extraction');
assert.ok(main.includes('void thumbnailHost.dispose();'), 'app shutdown disposes the helper');
assert.ok(/flushPendingLiveFolderAspects\(\);\r?\n {2}flushLiveFolderState\(\);/.test(main),
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
