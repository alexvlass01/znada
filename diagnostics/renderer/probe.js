'use strict';

// Generic renderer probe for dev-only diagnostics. It runs inside a preload's
// isolated world (DOM timing APIs available there, plus a `send` bridge to main).
// Everything external is injected, so the module unit-tests in plain Node with fakes.
//
// While a recording is active on the main side it observes:
//   - frame gaps via requestAnimationFrame, AGGREGATED per batch window (never one IPC
//     per frame); the nominal interval is the smallest observed gap, so a 30/60/120 Hz
//     or throttled display is measured, not assumed;
//   - long tasks via PerformanceObserver('longtask'), flagged unavailable when the
//     entry type is unsupported instead of silently reporting nothing;
//   - visibility: while the window is hidden, frame accounting pauses and the gap
//     baseline is dropped, so a hidden stretch never becomes one giant fake stall;
//   - low-frequency heap / DOM-node / card samples;
//   - window error and unhandledrejection (only the error CLASS name — no message text,
//     which could carry a path or query until stage-4 redaction exists);
//   - explicit spans from app code through startSpan().
// Events are buffered and flushed to `send` about every batchMs. Main drops batches
// when nothing is recording, so this stays cheap fire-and-forget.

const DEFAULTS = {
  batchMs: 400,
  longFrameMs: 50, // a frame gap over this counts as a visible stutter
  sampleMs: 2000, // heap/DOM/card cadence
  maxBufferEvents: 512, // hard cap so a runaway page can't grow the buffer without bound
};

function pickNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createRendererProbe(options = {}) {
  const role = typeof options.role === 'string' && options.role ? options.role : 'renderer';
  const send = typeof options.send === 'function' ? options.send : () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const perfNow = typeof options.perfNow === 'function' ? options.perfNow : () => Date.now();
  const raf = typeof options.raf === 'function' ? options.raf : null;
  const caf = typeof options.caf === 'function' ? options.caf : () => {};
  const doc = options.doc || null;
  const win = options.win || null;
  const PerfObserver = options.PerfObserver || null;
  const heapUsed = typeof options.heapUsed === 'function' ? options.heapUsed : null;
  const countNodes = typeof options.countNodes === 'function' ? options.countNodes : null;
  const countCards = typeof options.countCards === 'function' ? options.countCards : null;
  const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : clearTimeout;

  const batchMs = pickNumber(options.batchMs, DEFAULTS.batchMs);
  const longFrameMs = pickNumber(options.longFrameMs, DEFAULTS.longFrameMs);
  const sampleMs = pickNumber(options.sampleMs, DEFAULTS.sampleMs);
  const maxBufferEvents = pickNumber(options.maxBufferEvents, DEFAULTS.maxBufferEvents);

  let running = false;
  let buffer = [];
  let dropped = 0;
  let rafHandle = 0;
  let batchTimer = null;
  let sampleTimer = null;
  let observer = null;
  let onVisibility = null;
  let onError = null;
  let onRejection = null;

  // Frame-window aggregate (reset every batch flush).
  let frames = 0;
  let maxGapMs = 0;
  let nominalMs = 0;
  let longFrames = 0;
  let lastFramePerf = null; // null = baseline unset (start or just-unhidden)
  let hiddenSincePerf = null;

  const round2 = (value) => Math.round(value * 100) / 100;

  function pushEvent(kind, category, name, extra = {}) {
    if (!running) return;
    if (buffer.length >= maxBufferEvents) { dropped += 1; return; }
    const event = {
      kind,
      category,
      name,
      timestampMs: Number.isFinite(extra.timestampMs) ? extra.timestampMs : now(),
      source: { role },
      attributes: extra.attributes || {},
    };
    if (Number.isFinite(extra.durationMs)) event.durationMs = Math.max(0, extra.durationMs);
    if (extra.value !== undefined) event.value = extra.value;
    buffer.push(event);
  }

  function flushFrameWindow() {
    if (frames <= 0) return;
    const attributes = { count: frames, maxMs: round2(maxGapMs), nominalMs: round2(nominalMs), longFrames };
    frames = 0;
    maxGapMs = 0;
    nominalMs = 0;
    longFrames = 0;
    pushEvent('sample', 'renderer', 'frame-window', { attributes });
  }

  function deliver() {
    flushFrameWindow();
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    if (dropped > 0) {
      batch.push({
        kind: 'counter', category: 'renderer', name: 'probe-dropped',
        timestampMs: now(), source: { role }, attributes: {}, value: dropped,
      });
      dropped = 0;
    }
    try { send(batch); } catch { /* delivery is best-effort; never throw into the page */ }
  }

  function onFrame() {
    if (!running) return;
    const isVisible = !doc || doc.visibilityState === undefined || doc.visibilityState === 'visible';
    if (isVisible) {
      const t = perfNow();
      if (lastFramePerf !== null) {
        const gap = t - lastFramePerf;
        if (gap > 0) {
          frames += 1;
          if (gap > maxGapMs) maxGapMs = gap;
          // Nominal interval = smallest gap observed this window (≈ the real refresh
          // period), so we don't hard-code 60 Hz / 16.7 ms.
          if (nominalMs === 0 || gap < nominalMs) nominalMs = gap;
          if (gap > longFrameMs) longFrames += 1;
        }
      }
      lastFramePerf = t;
    } else {
      lastFramePerf = null; // drop baseline: don't attribute the hidden stretch to one frame
    }
    if (raf) rafHandle = raf(onFrame);
  }

  function handleVisibility() {
    if (!doc) return;
    if (doc.visibilityState === 'hidden') {
      hiddenSincePerf = perfNow();
      lastFramePerf = null;
    } else {
      const hiddenMs = hiddenSincePerf === null ? 0 : Math.max(0, perfNow() - hiddenSincePerf);
      hiddenSincePerf = null;
      lastFramePerf = null; // first visible frame after unhide must not report a giant gap
      pushEvent('sample', 'renderer', 'visibility', { attributes: { state: 'visible', hiddenMs: Math.round(hiddenMs) } });
    }
  }

  function takeResourceSample() {
    const attributes = {};
    if (heapUsed) {
      const bytes = heapUsed();
      if (Number.isFinite(bytes)) attributes.heapMB = Math.round(bytes / 104857.6) / 10;
    }
    if (countNodes) {
      const n = countNodes();
      if (Number.isFinite(n)) attributes.nodes = n;
    }
    if (countCards) {
      const c = countCards();
      if (Number.isFinite(c)) attributes.cards = c;
    }
    if (Object.keys(attributes).length) pushEvent('sample', 'renderer', 'resources', { attributes });
  }

  function scheduleBatch() {
    batchTimer = setTimeoutFn(() => {
      deliver();
      if (running) scheduleBatch();
    }, batchMs);
  }

  function scheduleSample() {
    sampleTimer = setTimeoutFn(() => {
      takeResourceSample();
      if (running) scheduleSample();
    }, sampleMs);
  }

  function startLongTaskObserver() {
    if (!PerfObserver) {
      pushEvent('sample', 'renderer', 'long-task', { attributes: { unavailable: true, reason: 'no-observer' } });
      return;
    }
    const supported = Array.isArray(PerfObserver.supportedEntryTypes)
      ? PerfObserver.supportedEntryTypes
      : null;
    if (supported && !supported.includes('longtask')) {
      pushEvent('sample', 'renderer', 'long-task', { attributes: { unavailable: true, reason: 'unsupported' } });
      return;
    }
    try {
      observer = new PerfObserver((list) => {
        const entries = typeof list.getEntries === 'function' ? list.getEntries() : [];
        for (const entry of entries) {
          const duration = Number(entry && entry.duration);
          if (!Number.isFinite(duration)) continue;
          pushEvent('sample', 'renderer', 'long-task', {
            durationMs: duration,
            attributes: { maxMs: round2(duration) },
          });
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      observer = null;
      pushEvent('sample', 'renderer', 'long-task', { attributes: { unavailable: true, reason: 'observe-failed' } });
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastFramePerf = null;
      hiddenSincePerf = doc && doc.visibilityState === 'hidden' ? perfNow() : null;
      if (doc && typeof doc.addEventListener === 'function') {
        onVisibility = handleVisibility;
        doc.addEventListener('visibilitychange', onVisibility);
      }
      if (win && typeof win.addEventListener === 'function') {
        onError = (e) => pushEvent('lifecycle', 'error', 'window-error', {
          attributes: { reason: (e && e.error && e.error.name) ? String(e.error.name) : 'Error' },
        });
        onRejection = (e) => pushEvent('lifecycle', 'error', 'unhandled-rejection', {
          attributes: { reason: (e && e.reason && e.reason.name) ? String(e.reason.name) : 'UnhandledRejection' },
        });
        win.addEventListener('error', onError);
        win.addEventListener('unhandledrejection', onRejection);
      }
      startLongTaskObserver();
      if (raf) rafHandle = raf(onFrame);
      scheduleBatch();
      scheduleSample();
    },

    stop() {
      if (!running) return;
      running = false;
      if (rafHandle && caf) caf(rafHandle);
      rafHandle = 0;
      if (batchTimer !== null) { clearTimeoutFn(batchTimer); batchTimer = null; }
      if (sampleTimer !== null) { clearTimeoutFn(sampleTimer); sampleTimer = null; }
      if (observer) { try { observer.disconnect(); } catch {} observer = null; }
      if (doc && onVisibility) { try { doc.removeEventListener('visibilitychange', onVisibility); } catch {} onVisibility = null; }
      if (win && onError) { try { win.removeEventListener('error', onError); } catch {} onError = null; }
      if (win && onRejection) { try { win.removeEventListener('unhandledrejection', onRejection); } catch {} onRejection = null; }
      running = true; // allow the final flush to push the frame-window sample
      deliver();
      running = false;
    },

    flush() {
      if (running) deliver();
    },

    // Explicit app span: timestampMs anchors to the START, durationMs is measured with
    // the monotonic clock. Returns an idempotent end(extraAttributes) closure.
    startSpan(category, name, attributes = {}) {
      const startWall = now();
      const startPerf = perfNow();
      let ended = false;
      return (extra = {}) => {
        if (ended || !running) return;
        ended = true;
        pushEvent('span', String(category || 'renderer'), String(name || 'span'), {
          timestampMs: startWall,
          durationMs: perfNow() - startPerf,
          attributes: { ...attributes, ...extra },
        });
      };
    },

    isRunning() {
      return running;
    },
  };
}

module.exports = {
  DEFAULTS,
  createRendererProbe,
};
