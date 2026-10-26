'use strict';

// CODE-001 2.1a. src/config-store.js owns every write of config.json and the pool file and
// both "do not write" modes. One scenario per guarantee in
// the CODE-001 stage 2 specification (R6). The fakes record what was written and
// in which order; the end-to-end proof over real files stays in the harness suites
// (config-read-failure, library-store-recovery, pool-consistency), which this move did not
// touch.
const assert = require('assert');
const { createConfigStore } = require('../src/config-store');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok ' + name);
}

/**
 * @param {{ configSource?: object, poolSource?: object, anonId?: string, configSave?: boolean,
 *   poolSave?: boolean, flush?: boolean, repaired?: number }} [options]
 */
function setup(options = {}) {
  const log = [];
  const notes = [];
  const errors = [];
  let config = { tag: 'defaults' };
  let onWriteFailure = null;
  let broadcasts = 0;
  let repairCalls = 0;
  let pending = false;
  const loaded = {
    tag: 'loaded',
    anonId: options.anonId,
    monitors: {},
    library: { a: { id: 'a' } },
    libraryTrash: [],
    onlineSources: { raw: true },
  };
  Object.defineProperty(loaded, '_configSource', { value: options.configSource || { writable: true } });
  Object.defineProperty(loaded, '_poolSource', { value: options.poolSource || { storeExisted: true } });
  const store = createConfigStore({
    configPath: 'C:\\profile\\config.json',
    configMod: {
      load: () => loaded,
      save: (cfg, path, opts) => {
        log.push({ op: 'config', keepInline: opts.keepInline, skipLibrary: opts.skipLibrary, anonId: cfg.anonId });
        return options.configSave !== false;
      },
    },
    libraryStore: {
      createWriter: (writerOptions) => {
        onWriteFailure = writerOptions.onWriteFailure;
        return {
          markDirty: () => { pending = true; log.push({ op: 'mark' }); },
          flush: () => { log.push({ op: 'flush' }); if (options.flush !== false) pending = false; return options.flush !== false; },
          isPending: () => pending,
          dispose: () => log.push({ op: 'dispose' }),
        };
      },
      save: () => { log.push({ op: 'pool-save' }); return options.poolSave !== false; },
    },
    poolConsistency: { repairDanglingSlots: () => { repairCalls++; return options.repaired || 0; } },
    normalizeOnlineSources: (sources) => ({ ...sources, normalized: true }),
    getConfig: () => config,
    setConfig: (next) => { log.push({ op: 'set' }); config = next; },
    onLoaded: () => log.push({ op: 'loaded', sawConfig: config.tag }),
    broadcast: () => { broadcasts++; },
    notify: (channel, key, opts) => notes.push({ channel, key, body: opts.bodyKey }),
    randomId: () => 'a'.repeat(32),
    log: { error: (...args) => errors.push(args.join(' ')) },
  });
  return {
    store,
    log,
    notes,
    errors,
    config: () => config,
    configWrites: () => log.filter((e) => e.op === 'config'),
    ops: () => log.map((e) => e.op),
    broadcasts: () => broadcasts,
    repairCalls: () => repairCalls,
    failPoolWrite: () => onWriteFailure(),
    clear: () => { log.length = 0; notes.length = 0; },
  };
}

test('load puts the loaded settings in place before anything asks for a file', () => {
  const t = setup();
  t.store.load();
  assert.deepStrictEqual(t.ops().slice(0, 2), ['set', 'loaded']);
  assert.strictEqual(t.log[1].sawConfig, 'loaded', 'onLoaded must see the new object');
  assert.strictEqual(t.config().onlineSources.normalized, true);
});

test('BUG-023: an unreadable config.json is never written over, by any path', () => {
  const t = setup({ configSource: { writable: false, state: 'locked' } });
  t.store.load();
  assert.strictEqual(t.notes[0].channel, 'config-store');
  assert.strictEqual(t.notes[0].body, 'notify.configStoreLockedBody');
  assert.strictEqual(t.store.save(), false);
  assert.strictEqual(t.store.saveSettings(), false);
  t.store.ensureAnonId();
  t.store.markPositionDirty();
  t.store.persistPosition();
  assert.deepStrictEqual(t.configWrites(), [], 'no config.json write may pass the door');
  assert.strictEqual(t.config().anonId, undefined, 'no id is generated for a config we cannot store');
  assert.strictEqual(t.store.writesBlocked(), true);
});

test('BUG-023: a damaged, unbacked config.json says so in its own words', () => {
  const t = setup({ configSource: { writable: false, state: 'corrupt-unbacked' } });
  t.store.load();
  assert.strictEqual(t.notes[0].body, 'notify.configStoreDamagedBody');
});

for (const [kind, poolSource, body] of [
  ['unreadable', { unreadable: true, storeExisted: true }, 'notify.libraryStoreLockedBody'],
  ['broken', { broken: true, storeExisted: true }, 'notify.libraryStoreDamagedBody'],
  ['newer', { newerVersion: true, storeExisted: true }, 'notify.libraryStoreLockedBody'],
]) {
  test(`DATA-004: a ${kind} pool file is never written; edits go inline into config.json`, () => {
    const t = setup({ poolSource });
    t.store.load();
    assert.ok(!t.ops().includes('pool-save'), 'the pool file is left as it is');
    assert.strictEqual(t.repairCalls(), 0, 'no repair against a knowingly incomplete pool');
    assert.strictEqual(t.notes.find((n) => n.channel === 'library-store').body, body);
    assert.strictEqual(t.store.poolWritable(), false);
    assert.strictEqual(t.store.writesBlocked(), true);
    t.clear();
    t.store.markPoolDirty();
    assert.deepStrictEqual(t.log, [{ op: 'config', keepInline: true, skipLibrary: true, anonId: undefined }]);
    t.clear();
    t.store.save();
    assert.ok(!t.ops().includes('mark') && !t.ops().includes('flush'), 'the batched writer is not used');
    assert.strictEqual(t.configWrites().length, 1, 'one inline write, not two');
    assert.strictEqual(t.configWrites()[0].keepInline, true);
    t.clear();
    t.store.saveSettings();
    assert.strictEqual(t.configWrites()[0].keepInline, true, 'a settings save keeps the inline copy');
  });
}

test('the first failed pool write degrades to inline until restart, and says so once', () => {
  const t = setup();
  t.store.load();
  t.clear();
  t.failPoolWrite();
  assert.deepStrictEqual(t.configWrites(), [{ op: 'config', keepInline: true, skipLibrary: true, anonId: undefined }]);
  assert.strictEqual(t.notes.length, 1);
  assert.strictEqual(t.store.poolWritable(), false);
  t.failPoolWrite();
  assert.strictEqual(t.notes.length, 1, 'a second failure is the same state, not a new one');
  t.clear();
  t.store.saveSettings();
  assert.strictEqual(t.configWrites()[0].keepInline, true, 'a settings-only save must not strip the only copy');
});

test('DATA-005: save writes the pool before the settings that name it', () => {
  const t = setup();
  t.store.load();
  t.clear();
  assert.strictEqual(t.store.save(), true);
  assert.deepStrictEqual(t.ops(), ['mark', 'flush', 'config']);
  assert.strictEqual(t.configWrites()[0].keepInline, false);
  assert.strictEqual(t.broadcasts(), 1);
});

test('DATA-005: when the pool write fails, the settings keep the pool inline', () => {
  const t = setup({ flush: false });
  t.store.load();
  t.clear();
  t.store.save();
  assert.deepStrictEqual(t.ops(), ['mark', 'flush', 'config']);
  assert.strictEqual(t.configWrites()[0].keepInline, true);
  assert.strictEqual(t.store.poolWritePending(), true, 'the newest pool stays pending for retry');
});

test('a settings-only save never touches the pool', () => {
  const t = setup();
  t.store.load();
  t.clear();
  assert.strictEqual(t.store.saveSettings(), true);
  assert.deepStrictEqual(t.ops(), ['config']);
  assert.strictEqual(t.configWrites()[0].keepInline, false);
});

test('a refused settings save neither broadcasts nor clears the pending position', () => {
  const t = setup({ configSave: false });
  t.store.load();
  t.store.markPositionDirty();
  const before = t.broadcasts();
  assert.strictEqual(t.store.saveSettings(), false);
  assert.strictEqual(t.broadcasts(), before);
  assert.strictEqual(t.store.positionPending(), true);
});

test('pool edits are batched and never broadcast; savePool broadcasts once', () => {
  const t = setup();
  t.store.load();
  t.clear();
  const before = t.broadcasts();
  t.store.markPoolDirty();
  assert.deepStrictEqual(t.ops(), ['mark']);
  assert.strictEqual(t.broadcasts(), before);
  t.store.savePool();
  assert.strictEqual(t.broadcasts(), before + 1);
  assert.ok(!t.ops().includes('config'), 'a tag does not rewrite config.json');
});

test('a refused position write stays pending and is retried', () => {
  const okRun = setup();
  okRun.store.load();
  okRun.store.markPositionDirty();
  okRun.clear();
  okRun.store.persistPosition();
  assert.strictEqual(okRun.configWrites().length, 1);
  assert.strictEqual(okRun.store.positionPending(), false);
  okRun.clear();
  okRun.store.persistPosition();
  assert.strictEqual(okRun.configWrites().length, 0, 'nothing pending, nothing written');

  const refused = setup({ configSave: false });
  refused.store.load();
  refused.store.markPositionDirty();
  refused.store.persistPosition();
  assert.strictEqual(refused.store.positionPending(), true);
});

test('TELEM-001: the usage mark reports whether it reached the disk', () => {
  const ok = setup();
  ok.store.load();
  ok.clear();
  assert.strictEqual(ok.store.persistUsagePing(), true);
  assert.strictEqual(ok.configWrites().length, 1);
  assert.strictEqual(ok.broadcasts(), 0, 'main-only state: the window is not told');
  const failed = setup({ configSave: false });
  failed.store.load();
  assert.strictEqual(failed.store.persistUsagePing(), false, 'a failed write must say so, or the ping goes out unrecorded');
  const unreadable = setup({ configSource: { writable: false, state: 'locked' } });
  unreadable.store.load();
  unreadable.clear();
  assert.strictEqual(unreadable.store.persistUsagePing(), false);
  assert.deepStrictEqual(unreadable.configWrites(), [], 'BUG-023: never over an unreadable config');
});

test('a full save also settles the slideshow position', () => {
  const t = setup();
  t.store.load();
  t.store.markPositionDirty();
  t.store.save();
  assert.strictEqual(t.store.positionPending(), false);
});

test('anonId is generated once and written without a broadcast', () => {
  const t = setup();
  t.store.load();
  t.clear();
  const before = t.broadcasts();
  t.store.ensureAnonId();
  assert.strictEqual(t.config().anonId, 'a'.repeat(32));
  assert.strictEqual(t.configWrites().length, 1);
  assert.strictEqual(t.broadcasts(), before);
  t.clear();
  t.store.ensureAnonId();
  assert.strictEqual(t.configWrites().length, 0, 'a valid id is kept');
});

test('dangling slots are repaired, announced and saved only in the healthy mode', () => {
  const t = setup({ repaired: 2 });
  t.store.load();
  assert.strictEqual(t.repairCalls(), 1);
  assert.ok(t.notes.some((n) => n.channel === 'pool-consistency'));
  assert.deepStrictEqual(t.ops().slice(2), ['config'], 'saved as settings only');
});

test('the inline copy is dropped only after the pool file is confirmed written', () => {
  const ok = setup({ poolSource: { storeExisted: false } });
  ok.store.load();
  assert.deepStrictEqual(ok.ops().slice(2), ['pool-save', 'config']);
  assert.strictEqual(ok.configWrites()[0].keepInline, false);

  const failed = setup({ poolSource: { mergedInline: true, storeExisted: true }, poolSave: false });
  failed.store.load();
  assert.deepStrictEqual(failed.ops().slice(2), ['pool-save', 'config']);
  assert.strictEqual(failed.configWrites()[0].keepInline, true, 'the only copy stays inline');
  assert.strictEqual(failed.store.poolWritable(), false);
});

test('a healthy store with nothing to migrate writes nothing at startup', () => {
  const t = setup();
  t.store.load();
  assert.deepStrictEqual(t.ops(), ['set', 'loaded']);
  assert.strictEqual(t.store.writesBlocked(), false);
});

test('two stores share no state (no module-level flags)', () => {
  const broken = setup({ poolSource: { broken: true } });
  broken.store.load();
  const healthy = setup();
  healthy.store.load();
  assert.strictEqual(broken.store.poolWritable(), false);
  assert.strictEqual(healthy.store.poolWritable(), true);
});

test('flush and dispose reach the pool writer', () => {
  const t = setup();
  t.store.markPoolDirty();
  assert.strictEqual(t.store.poolWritePending(), true);
  assert.strictEqual(t.store.flush(), true);
  t.store.dispose();
  assert.deepStrictEqual(t.ops().slice(-1), ['dispose']);
});

console.log(`config-store: ${passed} passed`);
