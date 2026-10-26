'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../src/bookmark-store');
const { makeTempDir } = require('./helpers/temp-dir');
const dir = makeTempDir('znada-bookmarks-');
const configPath = path.join(dir, 'config.json');
const file = S.storePathFor(configPath);
const item = { source: 'gelbooru', post_id: '99999999999999999999', favorited_at: 5,
  state: 'active', metadata: { user_tags: ['own'] } };
let store = S.create({ configPath });
assert.ok(store.status().writable);
assert.ok(store.put(null, item));
assert.ok(store.put('anonymous', { ...item, state: 'removed' }));
assert.ok(store.put('__proto__', { ...item, favorited_at: 9 }));
store = S.create({ configPath });
const key = 'gelbooru:99999999999999999999';
assert.strictEqual(store.snapshot(null)[key].state, 'active');
assert.strictEqual(store.snapshot('anonymous')[key].state, 'removed');
assert.strictEqual(store.snapshot('__proto__')[key].favorited_at, 9);
assert.deepStrictEqual(store.snapshot('another'), {});
const snapshot = store.snapshot(null);
snapshot[key].metadata.user_tags.push('outside');
assert.deepStrictEqual(store.snapshot(null)[key].metadata.user_tags, ['own']);
assert.notStrictEqual(file, S.storePathFor(path.join(dir, 'other.json')));
const before = fs.readFileSync(file, 'utf8');
const failingIO = Object.create(fs);
failingIO.renameSync = (from, to) => {
  if (to === file) throw new Error('disk unavailable');
  fs.renameSync(from, to);
};
const failed = S.create({ configPath, io: failingIO });
assert.strictEqual(failed.put(null, { ...item, state: 'removed' }), false);
assert.strictEqual(failed.snapshot(null)[key].state, 'active');
assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
assert.strictEqual(S.create({ configPath }).snapshot(null)[key].state, 'active');
// A failed write is retryable with the same caller-owned record.
failingIO.renameSync = fs.renameSync;
assert.ok(failed.put(null, { ...item, state: 'removed' }));
assert.strictEqual(S.create({ configPath }).snapshot(null)[key].state, 'removed');
const backup = fs.readFileSync(file + '.bak', 'utf8');
fs.writeFileSync(file, '{broken', 'utf8');
const broken = S.create({ configPath });
assert.strictEqual(broken.status().writable, false);
assert.strictEqual(broken.snapshot(null)[key].state, 'active');
assert.strictEqual(broken.put(null, item), false);
assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
assert.strictEqual(fs.readFileSync(file + '.bak', 'utf8'), backup);
// A future format may contain the user's data we do not understand. Preserve it.
fs.writeFileSync(file, JSON.stringify({ version: 2, partitions: {} }), 'utf8');
assert.strictEqual(S.create({ configPath }).status().writable, false);
fs.writeFileSync(file, '\uFEFF' + before, 'utf8');
assert.ok(S.create({ configPath }).status().writable);
assert.throws(() => S.validate({ version: 1, partitions: { anonymous: { wrong: item } } }));
assert.throws(() => S.validate({ version: 1, partitions: {}, lostField: true }));
// No valid primary/backup: still locked, never an empty successful write.
const deniedIO = Object.create(fs);
deniedIO.readFileSync = () => { const e = new Error('access denied'); e.code = 'EACCES'; throw e; };
const denied = S.create({ configPath, io: deniedIO });
assert.strictEqual(denied.status().writable, false);
assert.strictEqual(denied.put(null, item), false);
// A primary can be damaged before the second successful save creates a backup.
// That must lock writes too; the backup branch must not be the only guard.
const unbackedConfig = path.join(dir, 'unbacked.json');
const unbackedFile = S.storePathFor(unbackedConfig);
const firstSave = S.create({ configPath: unbackedConfig });
assert.ok(firstSave.put(null, item));
assert.strictEqual(fs.existsSync(unbackedFile + '.bak'), false);
fs.writeFileSync(unbackedFile, '{broken-without-backup', 'utf8');
const unbacked = S.create({ configPath: unbackedConfig });
assert.strictEqual(unbacked.status().writable, false);
assert.strictEqual(unbacked.put(null, item), false);
assert.strictEqual(fs.readFileSync(unbackedFile, 'utf8'), '{broken-without-backup');
console.log('bookmark-store: restart, isolation, atomic failure, backup and fail-closed PASS');
