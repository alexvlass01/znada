'use strict';

// Where the fingerprints and the journal live between runs.
//
// The rule this file guards: losing this store must cost re-derivable work and never a
// wrong answer. So a damaged file heals into an empty one rather than into a plausible
// one, and eviction may drop an old ANSWER (costing one repeated question much later)
// but must never merge two files' values together.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/metadata-store');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-meta-'));
const configPath = path.join(dir, 'config.json');
const T0 = 1_700_000_000_000;

// --- where the file goes --------------------------------------------------
ok('the store is named after its config, so two profiles cannot share one',
  store.storePathFor(configPath) === path.join(dir, 'config.metadata.json')
  && store.storePathFor(path.join(dir, 'other.json')) !== store.storePathFor(configPath));

// --- a round trip ---------------------------------------------------------
ok('a store that was never written reads as empty',
  Object.keys(store.load(configPath).files).length === 0);

const original = store.emptyStore();
original.files['c:/photos/a.jpg'] = { size: 10, mtimeMs: 5, values: { md5: { value: 'abc', v: 1 } }, at: T0 };
original.lookups['md5:abc'] = { result: null, providers: { danbooru: { at: T0, status: 'absent' } }, at: T0 };
ok('saving reports success', store.save(original, configPath, T0));

const file = store.storePathFor(configPath);
const raw = fs.readFileSync(file);
ok('the file is written as UTF-8 without a byte order mark',
  !(raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF));
ok('no temporary file is left behind', !fs.existsSync(file + '.tmp'));

let loaded = store.load(configPath);
ok('both halves survive the round trip',
  loaded.files['c:/photos/a.jpg'].values.md5.value === 'abc'
  && loaded.lookups['md5:abc'].providers.danbooru.status === 'absent');

// A single BOM is tolerated on the way in — some editors add one — while the app itself
// never writes one.
fs.writeFileSync(file, '\ufeff' + JSON.stringify(original), 'utf8');
ok('a byte order mark on the way in does not break the store',
  Object.keys(store.load(configPath).files).length === 1);

// --- damage ---------------------------------------------------------------
fs.writeFileSync(file, '{ this is not json', 'utf8');
loaded = store.load(configPath);
ok('an unparseable store heals into an empty one instead of throwing',
  Object.keys(loaded.files).length === 0 && Object.keys(loaded.lookups).length === 0);

fs.writeFileSync(file, JSON.stringify({ version: 1, files: 'nope', lookups: [1, 2] }), 'utf8');
loaded = store.load(configPath);
ok('halves of the wrong shape are dropped, not coerced',
  Object.keys(loaded.files).length === 0 && Object.keys(loaded.lookups).length === 0);

ok('entries that are not objects are dropped',
  Object.keys(store.normalizeStore({ files: { a: 'x', b: null, c: [1], d: { size: 1 } } }, T0).files).join() === 'd');

// --- bounds ---------------------------------------------------------------
const many = store.emptyStore();
for (let i = 0; i < store.FILE_LIMIT + 500; i++) many.files['f' + i] = { size: i, at: T0 + i };
const bounded = store.normalizeStore(many, T0);
ok('the file cache is bounded', Object.keys(bounded.files).length === store.FILE_LIMIT);
ok('and it is the OLDEST entries that go',
  !bounded.files.f0 && !!bounded.files['f' + (store.FILE_LIMIT + 499)]);

const undated = store.emptyStore();
for (let i = 0; i < store.LOOKUP_LIMIT + 10; i++) undated.lookups['k' + i] = { providers: {} };
ok('entries with no timestamp are still bounded rather than kept forever',
  Object.keys(store.normalizeStore(undated, T0).lookups).length === store.LOOKUP_LIMIT);

// --- the debounced writer -------------------------------------------------
const writes = [];
let timerFn = null;
const writer = store.createWriter({
  configPath,
  saveFn: (value) => { writes.push(value); return true; },
  setTimer: (fn) => { timerFn = fn; return 1; },
  clearTimer: () => { timerFn = null; },
});
writer.markDirty({ files: { a: 1 }, lookups: {} });
writer.markDirty({ files: { a: 2 }, lookups: {} });
writer.markDirty({ files: { a: 3 }, lookups: {} });
ok('a burst of changes has not written anything yet', writes.length === 0 && writer.isPending());
timerFn();
ok('and then produces exactly one write, of the newest value',
  writes.length === 1 && writes[0].files.a === 3 && !writer.isPending());

writer.markDirty({ files: { a: 4 }, lookups: {} });
ok('flush writes immediately without waiting for the timer',
  writer.flush() && writes.length === 2 && writes[1].files.a === 4);
ok('flushing with nothing pending writes nothing', !writer.flush() && writes.length === 2);
writer.dispose();

// --- write failures -------------------------------------------------------
const failing = store.createWriter({
  configPath,
  saveFn: () => false,
  setTimer: (fn) => { fn(); return 1; },
  clearTimer: () => {},
});
failing.markDirty({ files: {}, lookups: {} });
ok('a failed write is not retried forever for a cache nobody would miss', !failing.isPending());
failing.dispose();

// A real file where a directory would have to be: mkdir cannot succeed, so this
// exercises the failure path rather than quietly creating the folders and passing.
const blocker = path.join(dir, 'blocker');
fs.writeFileSync(blocker, 'not a directory', 'utf8');
ok('saving to an impossible location reports false instead of throwing',
  store.save(store.emptyStore(), path.join(blocker, 'config.json')) === false);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nAll ${passed} metadata-store tests passed.`);
