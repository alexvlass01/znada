'use strict';

// Main-process health sampler for an active diagnostics recording. Once per second
// (default) it reports three groups of raw protocol events via `record`:
//   - event-loop delay percentiles + event-loop utilization of the main process;
//   - per-process CPU/memory from app.getAppMetrics() with stable role names
//     (browser/tab-роли различаются через classifyPid, diagnostics-окно получит
//     свою роль и на этапе отчёта исключается из verdict основного приложения);
//   - aggregated webContents.send counters (channel → count per window), чтобы
//     шторм какого-нибудь config-changed не превращался в шторм diagnostics-событий.
// Метрики, часы и таймеры инжектируются, поэтому тесты гоняют tick детерминированно
// без Electron. Сэмплер никогда не бросает наружу — сломанный провайдер не должен
// уронить Znada.

const DEFAULT_INTERVAL_MS = 1000;
const MAX_TRACKED_CHANNELS = 32;

function nsToMs(nanoseconds) {
  const value = Number(nanoseconds);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value / 1e4) / 100; // ns → ms, 0.01 ms precision
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Real perf_hooks providers for the event-loop half. app.getAppMetrics() is
// Electron-only, so main.js keeps injecting it separately.
function createNodeEventLoopProviders() {
  const { monitorEventLoopDelay, performance } = require('perf_hooks');
  return {
    createDelayMonitor() {
      const histogram = monitorEventLoopDelay({ resolution: 20 });
      return {
        enable: () => histogram.enable(),
        disable: () => histogram.disable(),
        reset: () => histogram.reset(),
        snapshot: () => ({
          meanMs: nsToMs(histogram.mean),
          maxMs: nsToMs(histogram.max),
          p95Ms: nsToMs(histogram.percentile(95)),
        }),
      };
    },
    eventLoopUtilization: (...args) => performance.eventLoopUtilization(...args),
  };
}

function roleForMetric(metric, classifyPid) {
  const type = String((metric && metric.type) || '').toLowerCase();
  if (type === 'tab') {
    let custom = '';
    if (typeof classifyPid === 'function') {
      try { custom = classifyPid(metric.pid) || ''; } catch { custom = ''; }
    }
    return custom || 'renderer';
  }
  return type || 'unknown';
}

function createProcessSampler({
  record,
  intervalMs = DEFAULT_INTERVAL_MS,
  appMetrics = null,
  createDelayMonitor = null,
  eventLoopUtilization = null,
  classifyPid = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof record !== 'function') throw new Error('record callback is required');

  let timer = null;
  let delayMonitor = null;
  let lastElu = null;
  // app.getAppMetrics() reports CPU% "since the previous call": the very first
  // reading is a meaningless baseline and is skipped, not recorded as 0.
  let sawCpuBaseline = false;
  const channelCounts = new Map();

  const safeElu = (...args) => {
    try { return eventLoopUtilization(...args); } catch { return null; }
  };

  const sampleEventLoop = () => {
    const attributes = {};
    let have = false;
    if (delayMonitor) {
      const snap = delayMonitor.snapshot();
      delayMonitor.reset();
      attributes.meanMs = snap.meanMs;
      attributes.maxMs = snap.maxMs;
      attributes.p95Ms = snap.p95Ms;
      have = true;
    }
    if (typeof eventLoopUtilization === 'function') {
      const current = safeElu();
      if (current) {
        const windowed = lastElu ? safeElu(current, lastElu) : null;
        lastElu = current;
        if (windowed && Number.isFinite(windowed.utilization)) {
          attributes.utilization = Math.round(windowed.utilization * 1000) / 1000;
          have = true;
        }
      }
    }
    if (!have) return;
    record({ kind: 'sample', category: 'main', name: 'event-loop', attributes });
  };

  const sampleProcesses = () => {
    if (typeof appMetrics !== 'function') return;
    const metrics = appMetrics();
    if (!Array.isArray(metrics) || !metrics.length) return;
    if (!sawCpuBaseline) { sawCpuBaseline = true; return; }
    for (const metric of metrics) {
      if (!metric || !Number.isInteger(metric.pid)) continue;
      const attributes = { role: roleForMetric(metric, classifyPid), pid: metric.pid };
      const cpu = metric.cpu ? Number(metric.cpu.percentCPUUsage) : NaN;
      if (Number.isFinite(cpu)) attributes.cpuPercent = round2(cpu);
      const workingSetKb = metric.memory ? Number(metric.memory.workingSetSize) : NaN;
      if (Number.isFinite(workingSetKb)) attributes.memoryMB = Math.round(workingSetKb / 102.4) / 10;
      record({ kind: 'sample', category: 'process', name: 'process', attributes });
    }
  };

  const flushChannelCounters = () => {
    if (!channelCounts.size) return;
    for (const [channel, count] of channelCounts) {
      record({ kind: 'counter', category: 'webcontents-send', name: channel, value: count });
    }
    channelCounts.clear();
  };

  const tick = () => {
    try { sampleEventLoop(); } catch {}
    try { sampleProcesses(); } catch {}
    try { flushChannelCounters(); } catch {}
  };

  return {
    start() {
      if (timer) return;
      sawCpuBaseline = false;
      if (typeof createDelayMonitor === 'function' && !delayMonitor) {
        try { delayMonitor = createDelayMonitor(); } catch { delayMonitor = null; }
      }
      if (delayMonitor) {
        try { delayMonitor.reset(); delayMonitor.enable(); } catch {}
      }
      // ELU baseline at start so the first tick reports the first window,
      // not utilization accumulated since process launch.
      lastElu = typeof eventLoopUtilization === 'function' ? safeElu() : null;
      timer = setIntervalFn(tick, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (!timer) return;
      clearIntervalFn(timer);
      timer = null;
      // Final counter flush happens while the controller's writer is still alive
      // (controller stops the sampler before stopping the writer).
      try { flushChannelCounters(); } catch {}
      if (delayMonitor) {
        try { delayMonitor.disable(); } catch {}
      }
      lastElu = null;
    },
    isActive() {
      return !!timer;
    },
    countChannel(channel) {
      if (!timer) return; // probes must stay silent outside an active recording
      const name = typeof channel === 'string' && channel ? channel : 'unknown';
      if (!channelCounts.has(name) && channelCounts.size >= MAX_TRACKED_CHANNELS) return;
      channelCounts.set(name, (channelCounts.get(name) || 0) + 1);
    },
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  createNodeEventLoopProviders,
  createProcessSampler,
};
