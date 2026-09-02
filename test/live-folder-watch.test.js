'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const W = require('../src/live-folder-watch');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  ✓ ' + name); passed++; };

function fakeRuntime() {
  let nextTimer = 1;
  const timers = new Map();
  const watches = [];
  const watch = (rootPath, options, callback) => {
    const watcher = new EventEmitter();
    watcher.rootPath = rootPath;
    watcher.options = options;
    watcher.callback = callback;
    watcher.closed = false;
    watcher.close = () => { watcher.closed = true; };
    watches.push(watcher);
    return watcher;
  };
  const setTimeout = (callback) => { const id = nextTimer++; timers.set(id, callback); return id; };
  const clearTimeout = (id) => timers.delete(id);
  const flush = async () => {
    const callbacks = Array.from(timers.values());
    timers.clear();
    for (const callback of callbacks) await callback();
  };
  return { watch, watches, setTimeout, clearTimeout, flush, timers };
}

async function run() {
  const rt = fakeRuntime();
  const changes = [];
  const errors = [];
  const ctl = W.createController({
    watch: rt.watch,
    setTimeout: rt.setTimeout,
    clearTimeout: rt.clearTimeout,
    onChange: async (id) => { changes.push(id); },
    onError: (id) => errors.push(id),
  });

  ok('sync starts one recursive watcher', ctl.sync([{ id: 'a', path: 'C:/A' }]).watched === 1
    && rt.watches.length === 1 && rt.watches[0].options.recursive === true);
  ctl.sync([{ id: 'a', path: 'C:/A' }]);
  ok('unchanged sync reuses watcher', rt.watches.length === 1 && !rt.watches[0].closed);
  ctl.sync([{ id: 'a', path: '\\\\?\\C:\\A\\.\\' }]);
  ok('extended-length alias reuses the same watcher', rt.watches.length === 1 && !rt.watches[0].closed);

  rt.watches[0].callback('rename', 'one.jpg');
  rt.watches[0].callback('change', 'one.jpg');
  ok('bursty events collapse into one debounce timer', rt.timers.size === 1);
  await rt.flush();
  ok('debounced event scans the affected folder once', changes.join(',') === 'a');

  ctl.sync([{ id: 'a', path: 'C:/B' }]);
  ok('root change closes and replaces watcher', rt.watches.length === 2
    && rt.watches[0].closed && !rt.watches[1].closed);

  rt.watches[1].emit('error', new Error('offline'));
  ok('watcher error closes handle and is reported', rt.watches[1].closed && errors.join(',') === 'a');
  const retried = ctl.sync([{ id: 'a', path: 'C:/B' }]);
  ok('later sync retries a failed watcher', retried.watched === 1 && rt.watches.length === 3);

  ok('explicit restart replaces a stale watcher', ctl.restart('a')
    && rt.watches.length === 4 && rt.watches[2].closed && !rt.watches[3].closed);

  ctl.sync([]);
  ok('removing folder closes its watcher', rt.watches[3].closed);
  ctl.closeAll();

  const rt2 = fakeRuntime();
  let release;
  const started = [];
  const ctl2 = W.createController({
    watch: rt2.watch,
    setTimeout: rt2.setTimeout,
    clearTimeout: rt2.clearTimeout,
    debounceMs: 0,
    onChange: async (id) => {
      started.push(id);
      if (started.length === 1) await new Promise((resolve) => { release = resolve; });
    },
  });
  ctl2.sync([{ id: 'q', path: 'C:/Queue' }]);
  rt2.watches[0].callback('change', 'a.jpg');
  const firstFlush = rt2.flush();
  await new Promise((resolve) => { setImmediate(resolve); });
  rt2.watches[0].callback('change', 'b.jpg');
  await rt2.flush();
  release();
  await firstFlush;
  await rt2.flush();
  ok('event during a running scan queues exactly one follow-up', started.length === 2);
  ctl2.closeAll();

  console.log('\nAll ' + passed + ' live-folder watcher tests passed.');
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
