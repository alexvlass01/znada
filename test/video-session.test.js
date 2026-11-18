'use strict';

const assert = require('assert/strict');
const { EventEmitter } = require('events');
const { createVideoSession } = require('../src/video-session');
let checks = 0;
const flush = () => new Promise(resolve => { setImmediate(resolve); });
function harness(options = {}) {
  const workers = [], states = [], imported = [], duplicates = [], timers = new Map(), external = [];
  let timer = 0;
  const session = createVideoSession({
    createWorker() {
      const worker = new EventEmitter(); worker.pid = 100 + workers.length; worker.sent = []; worker.killed = 0;
      worker.postMessage = message => worker.sent.push(message); worker.kill = () => { worker.killed++; };
      workers.push(worker); return worker;
    },
    resolveEntry: index => index === 0 || index === 1 ? { path: `authorized-${index}.mp4` } : null,
    openExternal: entry => { external.push(entry.path); return { ok: true }; },
    sendState: message => states.push(message),
    duplicateHandle: () => { const d = { buffer: Buffer.alloc(8), closes: 0, close() { this.closes++; } }; duplicates.push(d); return d; },
    importTexture: args => {
      const texture = { args, releases: 0, release() { this.releases++; args.allReferencesReleased(); } };
      imported.push(texture); return texture;
    },
    sendTexture: async () => {},
    setTimer: (callback, ms) => { const id = ++timer; timers.set(id, { callback, ms }); return id; },
    clearTimer: id => timers.delete(id),
    ...options,
  });
  const open = generation => session.request({ action: 'open', generation, index: 0 });
  const frame = (worker, id = 1) => worker.emit('message', { type: 'frame', id, width: 640, height: 360, ntBytes: Buffer.alloc(8), time: 1 });
  return { session, workers, states, imported, duplicates, timers, external, open, frame };
}
async function test(name, body) { await body(); checks++; console.log('  ok ' + name); }
(async () => {
  await test('only a payload index authorizes opening; arbitrary paths, unknown operations and invalid generations fail', () => {
    const h = harness();
    for (const request of [null, { action: 'open', generation: 1, index: -1 }, { action: 'open', generation: 1, index: 0, path: 'outside.mp4' },
      { action: '__proto__', generation: 1 }, { action: 'toString', generation: 1 }, { action: 'open', generation: NaN, index: 0 }]) {
      assert.equal(h.session.request(request).ok, false);
    }
    assert.equal(h.workers.length, 0); assert.equal(h.open(1).ok, true); assert.equal(h.open(1).ok, false);
  });
  await test('a displayed transfer holds both handles until all imported references release, exactly once', async () => {
    let finish;
    const h = harness({ sendTexture: () => new Promise(resolve => { finish = resolve; }) });
    h.open(1); h.frame(h.workers[0]);
    assert.equal(h.duplicates[0].closes, 0); assert.equal(h.workers[0].sent.length, 0);
    finish(); await flush();
    assert.equal(h.duplicates[0].closes, 1); assert.equal(h.imported[0].releases, 1);
    h.imported[0].args.allReferencesReleased();
    assert.equal(h.duplicates[0].closes, 1);
    assert.equal(h.workers[0].sent.filter(m => m.type === 'release').length, 1);
  });
  await test('rapid navigation releases stale frames, ignores stale errors and controls, and stops only the old worker', async () => {
    const h = harness(); h.open(1); const old = h.workers[0]; h.open(2); const next = h.workers[1];
    h.frame(old); old.emit('message', { type: 'error' }); await flush();
    assert.equal(h.imported.length, 0); assert.deepEqual(old.sent.map(m => m.type), ['stop', 'release']);
    assert.equal(h.session.request({ action: 'pause', generation: 1 }).ok, false);
    h.frame(next); await flush(); assert.equal(h.imported.length, 1);
    assert.equal(h.states.length, 0); assert.equal(next.killed, 0);
  });
  await test('a failed import closes the duplicated handle and releases the worker texture', async () => {
    const h = harness({ importTexture() { throw new Error('device lost'); } }); h.open(1); h.frame(h.workers[0]); await flush();
    assert.equal(h.duplicates[0].closes, 1);
    assert.equal(h.workers[0].sent.filter(m => m.type === 'release').length, 1);
    assert.equal(h.states.at(-1).code, 'display_failed');
  });
  await test('a failed send releases the imported wrapper and ends the session without external auto-launch', async () => {
    const h = harness({ sendTexture: async () => { throw new Error('renderer gone'); } }); h.open(1); h.frame(h.workers[0]); await flush();
    assert.equal(h.imported[0].releases, 1); assert.equal(h.duplicates[0].closes, 1);
    assert.equal(h.external.length, 0); assert.equal(h.states.at(-1).code, 'display_failed');
    assert.equal(h.session.request({ action: 'external', generation: 1 }).ok, true);
    assert.deepEqual(h.external, ['authorized-0.mp4']);
  });
  await test('a third pending frame and a duplicate frame id cannot grow the transfer queue', async () => {
    const h = harness({ sendTexture: () => new Promise(() => {}) }); h.open(1);
    h.frame(h.workers[0], 1); h.frame(h.workers[0], 2); h.frame(h.workers[0], 3); await flush();
    assert.equal(h.imported.length, 2); assert.equal(h.states.at(-1).type, 'error');
    const duplicate = harness(); duplicate.open(1); duplicate.frame(duplicate.workers[0]); await flush(); duplicate.frame(duplicate.workers[0]); await flush();
    assert.equal(duplicate.imported.length, 1); assert.equal(duplicate.states.at(-1).type, 'error');
  });
  await test('a frame over 4096 px on either side is released without import and ends playback', async () => {
    for (const [width, height] of [[4097, 360], [640, 4097]]) {
      const h = harness(); h.open(1);
      h.workers[0].emit('message', { type: 'frame', id: 1, width, height, ntBytes: Buffer.alloc(8), time: 1 }); await flush();
      assert.equal(h.imported.length, 0); assert.equal(h.duplicates.length, 0);
      assert.equal(h.workers[0].sent.filter(m => m.type === 'release').length, 1);
      assert.equal(h.states.at(-1).type, 'error');
    }
    const edge = harness(); edge.open(1);
    edge.workers[0].emit('message', { type: 'frame', id: 1, width: 4096, height: 4096, ntBytes: Buffer.alloc(8), time: 1 }); await flush();
    assert.equal(edge.imported.length, 1);
  });
  await test('stop barriers refuse obsolete opens and do not let old stop messages kill a newer session', () => {
    const h = harness(); h.open(1); h.session.request({ action: 'stop', generation: 4 });
    assert.equal(h.open(3).ok, false); assert.equal(h.open(5).ok, true);
    assert.equal(h.session.request({ action: 'stop', generation: 4 }).ok, false);
    assert.equal(h.workers[1].sent.length, 0);
  });
  await test('startup timeout and shutdown timeout affect only the owned decoder; dispose rejects all later work', () => {
    const h = harness(); h.open(1);
    [...h.timers.values()].find(t => t.ms === 12000).callback();
    assert.equal(h.states.at(-1).code, 'open_timeout');
    [...h.timers.values()].find(t => t.ms === 2200).callback(); assert.equal(h.workers[0].killed, 1);
    h.session.dispose(); assert.equal(h.open(2).ok, false);
    h.frame(h.workers[0]); assert.equal(h.imported.length, 0);
  });
  await test('worker crash is visible, cannot revive, and cancels shutdown timers after exit', () => {
    const h = harness(); h.open(1); h.workers[0].emit('exit', 1);
    assert.equal(h.states.at(-1).code, 'decoder_stopped');
    assert.equal(h.session.request({ action: 'pause', generation: 1 }).ok, false);
    assert.equal(h.external.length, 0);
  });
  await test('only finite bounded controls reach libmpv; stop of an error session remains safe', () => {
    const h = harness(); h.open(1);
    for (const [action, value] of [['seek', -1], ['seek', Infinity], ['volume', 101], ['volume', NaN]]) assert.equal(h.session.request({ action, value, generation: 1 }).ok, false);
    assert.equal(h.session.request({ action: 'seek', value: 2.5, generation: 1 }).ok, true);
    assert.equal(h.session.request({ action: 'volume', value: 0, generation: 1 }).ok, true);
    assert.equal(h.session.request({ action: 'pause', generation: 1 }).ok, true);
    assert.deepEqual(h.workers[0].sent.map(m => m.action), ['seek', 'volume', 'pause']);
  });
  await test('rapid opens keep at most two decoders and start only the latest queued request after exit', () => {
    const h = harness(); h.open(1); h.open(2); h.open(3); h.open(4);
    assert.equal(h.workers.length, 2);
    assert.equal(h.session.request({ action: 'pause', generation: 4 }).ok, false);
    h.workers[0].emit('exit', 0); assert.equal(h.workers.length, 3);
    h.workers[2].emit('message', { type: 'state' });
    assert.equal(h.states.at(-1).generation, 4);
    h.session.dispose(); assert.equal(h.workers[2].sent.at(-1).type, 'stop');
  });
  await test('a viewer reload resets its generation without reviving an old session', () => {
    const h = harness(); h.open(9); h.session.reset(); assert.equal(h.open(1).ok, true);
    h.workers[0].emit('message', { type: 'state', generation: 9 }); assert.equal(h.states.length, 0);
    h.workers[1].emit('message', { type: 'state', generation: 9 }); assert.equal(h.states.at(-1).generation, 1);
  });
  await test('renderer canvas failure stops the decoder and retains only its authorized fallback entry', () => {
    const h = harness(); h.open(1);
    assert.equal(h.session.request({ action: 'abort', generation: 1 }).ok, true);
    assert.equal(h.workers[0].sent.at(-1).type, 'stop');
    assert.equal(h.session.request({ action: 'pause', generation: 1 }).ok, false);
    assert.equal(h.session.request({ action: 'external', generation: 1 }).ok, true);
  });
  await test('disposing a queued open cancels its deadline, and failed spawn leaves no timer', () => {
    const h = harness(); h.open(1); h.open(2); h.open(3); h.session.dispose();
    assert.equal([...h.timers.values()].some(t => t.ms === 12000), false);
    const failure = harness({ createWorker() { throw new Error('unavailable'); } }); failure.open(1);
    assert.equal(failure.timers.size, 0); assert.equal(failure.states.at(-1).code, 'unavailable');
  });
  console.log(`PASS video-session: ${checks} checks`);
})().catch(error => { console.error(error); process.exitCode = 1; });
