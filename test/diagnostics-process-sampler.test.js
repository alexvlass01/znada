'use strict';

const assert = require('assert');
const { createProcessSampler } = require('../diagnostics/main/process-sampler');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  OK ' + name);
  passed++;
};

function fakeEnvironment({ appMetrics } = {}) {
  const state = {
    events: [],
    tick: null,
    intervals: 0,
    cleared: 0,
    monitor: { enabled: 0, disabled: 0, resets: 0 },
    eluCalls: 0,
  };
  const sampler = createProcessSampler({
    record: (event) => state.events.push(event),
    appMetrics: appMetrics || (() => [
      { pid: 100, type: 'Browser', cpu: { percentCPUUsage: 12.345 }, memory: { workingSetSize: 204800 } },
      { pid: 200, type: 'Tab', cpu: { percentCPUUsage: 33.3 }, memory: { workingSetSize: 102400 } },
      { pid: 300, type: 'GPU', cpu: { percentCPUUsage: 5 }, memory: { workingSetSize: 51200 } },
      { pid: 400, type: 'Utility', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 10240 } },
    ]),
    createDelayMonitor: () => ({
      enable: () => { state.monitor.enabled += 1; },
      disable: () => { state.monitor.disabled += 1; },
      reset: () => { state.monitor.resets += 1; },
      snapshot: () => ({ meanMs: 1.5, maxMs: 42, p95Ms: 9.75 }),
    }),
    eventLoopUtilization: (current, previous) => {
      state.eluCalls += 1;
      if (current && previous) return { utilization: 0.25 };
      return { utilization: 0.9, seq: state.eluCalls };
    },
    classifyPid: (pid) => (pid === 200 ? 'renderer-main' : ''),
    setIntervalFn: (fn) => { state.tick = fn; state.intervals += 1; return { unref() {} }; },
    clearIntervalFn: () => { state.cleared += 1; },
  });
  return { sampler, state };
}

(() => {
  assert.throws(() => createProcessSampler({}), /record callback is required/);
  ok('record callback is required', true);

  const { sampler, state } = fakeEnvironment();
  ok('sampler is inactive before start', !sampler.isActive());
  sampler.countChannel('config-changed');

  sampler.start();
  sampler.start();
  ok('start is idempotent and installs one interval', sampler.isActive() && state.intervals === 1);
  ok('delay monitor enabled on start', state.monitor.enabled === 1 && state.monitor.resets === 1);

  state.tick();
  const firstTick = state.events.splice(0);
  const loopSample = firstTick.find((event) => event.name === 'event-loop');
  ok('first tick reports event-loop delay stats', loopSample &&
    loopSample.kind === 'sample' &&
    loopSample.attributes.meanMs === 1.5 &&
    loopSample.attributes.maxMs === 42 &&
    loopSample.attributes.p95Ms === 9.75);
  ok('event-loop utilization is a diffed window', loopSample.attributes.utilization === 0.25);
  ok('first CPU sample is skipped as baseline', !firstTick.some((event) => event.category === 'process'));
  ok('channel counted before start is not reported', !firstTick.some((event) => event.kind === 'counter'));

  sampler.countChannel('config-changed');
  sampler.countChannel('config-changed');
  sampler.countChannel('config-changed');
  sampler.countChannel('gallery-payload');

  state.tick();
  const secondTick = state.events.splice(0);
  const processes = secondTick.filter((event) => event.category === 'process');
  ok('second tick reports every app process', processes.length === 4);
  const browser = processes.find((event) => event.attributes.pid === 100);
  ok('browser sample carries rounded cpu/memory', browser &&
    browser.attributes.role === 'browser' &&
    browser.attributes.cpuPercent === 12.35 &&
    browser.attributes.memoryMB === 200);
  const rendererMain = processes.find((event) => event.attributes.pid === 200);
  ok('tab process is classified via classifyPid', rendererMain && rendererMain.attributes.role === 'renderer-main');
  const gpu = processes.find((event) => event.attributes.pid === 300);
  const utility = processes.find((event) => event.attributes.pid === 400);
  ok('gpu and utility keep their electron roles',
    gpu && gpu.attributes.role === 'gpu' && utility && utility.attributes.role === 'utility');
  const counters = secondTick.filter((event) => event.kind === 'counter');
  ok('channel counters aggregate per window', counters.length === 2 &&
    counters.find((event) => event.name === 'config-changed').value === 3 &&
    counters.find((event) => event.name === 'gallery-payload').value === 1);
  ok('counter events use webcontents-send category',
    counters.every((event) => event.category === 'webcontents-send'));

  state.tick();
  const thirdTick = state.events.splice(0);
  ok('flushed counters do not repeat on the next tick', !thirdTick.some((event) => event.kind === 'counter'));

  sampler.countChannel('live-folders-changed');
  sampler.stop();
  const stopped = state.events.splice(0);
  ok('stop clears the interval and disables the monitor',
    !sampler.isActive() && state.cleared === 1 && state.monitor.disabled === 1);
  ok('stop flushes pending channel counters', stopped.length === 1 &&
    stopped[0].kind === 'counter' && stopped[0].name === 'live-folders-changed' && stopped[0].value === 1);

  sampler.countChannel('after-stop');
  sampler.stop();
  ok('counters after stop are ignored and stop is idempotent', state.events.length === 0 && state.cleared === 1);

  const broken = fakeEnvironment({ appMetrics: () => { throw new Error('metrics down'); } });
  broken.sampler.start();
  broken.state.tick();
  const brokenEvents = broken.state.events.splice(0);
  ok('broken appMetrics provider does not kill the tick',
    brokenEvents.some((event) => event.name === 'event-loop'));
  broken.sampler.stop();

  let bareTick = null;
  const bare = createProcessSampler({
    record: () => { throw new Error('record must not be called'); },
    setIntervalFn: (fn) => { bareTick = fn; return {}; },
    clearIntervalFn: () => {},
  });
  bare.start();
  bareTick();
  ok('sampler without providers stays silent instead of reporting zeros', true);
  bare.stop();

  console.log('\nAll ' + passed + ' diagnostics process-sampler tests passed.');
})();
