'use strict';

// Dev-only glue that wires the generic renderer probe into a preload script. It is
// required ONLY when the gated diagnostics launch argument is present (which can only
// happen in an unpackaged diagnostics run), so a packaged build never loads it.
//
// Kept separate from probe.js (the pure, unit-tested core) because this half touches
// live Web APIs — performance, requestAnimationFrame, document, PerformanceObserver —
// and the Electron ipcRenderer/contextBridge, none of which exist under plain Node.

const { createRendererProbe } = require('./probe');

const ARG_PREFIX = '--znada-diagnostics-renderer';

function parseRole(argv = []) {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    if (arg === ARG_PREFIX) return 'renderer';
    if (arg.startsWith(`${ARG_PREFIX}=`)) return arg.slice(ARG_PREFIX.length + 1) || 'renderer';
  }
  return '';
}

function attachRendererProbe({ ipcRenderer, contextBridge, role, cardSelector = '' }) {
  // Wall-clock offset against main. Starts at 0 (already correct on a single machine's
  // shared OS clock) and is refined once by the clock handshake below.
  let offset = 0;
  const perf = typeof performance !== 'undefined' ? performance : null;
  const wallNow = () => (perf ? perf.timeOrigin + perf.now() + offset : Date.now());

  const probe = createRendererProbe({
    role,
    send: (events) => { ipcRenderer.invoke('diagnostics-record', events).catch(() => {}); },
    now: wallNow,
    perfNow: () => (perf ? perf.now() : Date.now()),
    raf: (fn) => requestAnimationFrame(fn),
    caf: (id) => cancelAnimationFrame(id),
    doc: typeof document !== 'undefined' ? document : null,
    win: typeof window !== 'undefined' ? window : null,
    PerfObserver: typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null,
    heapUsed: perf && perf.memory ? () => perf.memory.usedJSHeapSize : null,
    countNodes: typeof document !== 'undefined' ? () => document.getElementsByTagName('*').length : null,
    countCards: cardSelector && typeof document !== 'undefined'
      ? () => document.querySelectorAll(cardSelector).length : null,
  });

  probe.start();

  // One-shot clock handshake with main. On one machine the offset is ~0; this just
  // guards against any timeOrigin drift.
  ipcRenderer.invoke('diagnostics-clock').then((res) => {
    if (res && Number.isFinite(res.now) && perf) {
      offset = res.now - (perf.timeOrigin + perf.now());
    }
  }).catch(() => {});

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => probe.flush());
    window.addEventListener('beforeunload', () => probe.flush());
  }

  // Bridge for explicit spans from app code. window.znadaDiag is undefined when
  // diagnostics is off, so renderer/viewer call sites guard with optional chaining.
  if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
    contextBridge.exposeInMainWorld('znadaDiag', {
      span: (category, name) => probe.startSpan(String(category || 'renderer'), String(name || 'span')),
      mark: (category, name, attributes) => {
        probe.startSpan(String(category || 'renderer'), String(name || 'span'))(attributes || {});
      },
    });
  }

  return probe;
}

module.exports = { ARG_PREFIX, parseRole, attachRendererProbe };
