'use strict';

// Pure events → Chrome Trace Event Format object (openable in chrome://tracing or
// https://ui.perfetto.dev). Spans become complete "X" events; manual marks and errors
// become instant "i" events; numeric samples/counters become "C" counter events. All
// timestamps are microseconds from session start (ts), durations in microseconds (dur).
// Each source role maps to a stable tid so the tool lays main/renderer on their own lanes.

const ROLE_TID = {
  main: 1,
  'renderer-main': 2,
  'renderer-viewer': 3,
};

function tidFor(role, seen) {
  if (Number.isFinite(ROLE_TID[role])) return ROLE_TID[role];
  if (!seen.has(role)) seen.set(role, 10 + seen.size);
  return seen.get(role);
}

function toChromeTrace(events = [], meta = {}) {
  const list = Array.isArray(events) ? events : [];
  const seen = new Map();
  const traceEvents = [];
  const pid = 1;

  // Name the lanes.
  for (const [role, tid] of Object.entries(ROLE_TID)) {
    traceEvents.push({ ph: 'M', pid, tid, name: 'thread_name', args: { name: role } });
  }

  for (const e of list) {
    const role = (e.source && e.source.role) || 'main';
    const tid = tidFor(role, seen);
    const ts = Math.max(0, Math.round((e.timestampMs || 0) * 1000));
    const cat = `${e.category || 'diag'}`;
    const args = { ...(e.attributes || {}) };
    if (e.source && Number.isFinite(e.source.webContentsId)) args.webContentsId = e.source.webContentsId;

    if (e.kind === 'span') {
      traceEvents.push({ ph: 'X', pid, tid, ts, dur: Math.max(0, Math.round((e.durationMs || 0) * 1000)), name: e.name, cat, args });
    } else if (e.kind === 'mark') {
      traceEvents.push({ ph: 'i', pid, tid, ts, name: e.name, cat, s: 'g', args });
    } else if (e.kind === 'counter') {
      traceEvents.push({ ph: 'C', pid, tid, ts, name: e.name, cat, args: { value: Number(e.value) || 0 } });
    } else if (e.kind === 'sample') {
      // Represent a sample's headline number as a counter so it charts over time.
      const value = Number(
        (e.attributes && (e.attributes.maxMs ?? e.attributes.cpuPercent ?? e.attributes.heapMB ?? e.attributes.nodes)) ?? e.value,
      );
      if (Number.isFinite(value)) traceEvents.push({ ph: 'C', pid, tid, ts, name: e.name, cat, args: { value } });
      else traceEvents.push({ ph: 'i', pid, tid, ts, name: e.name, cat, s: 't', args });
    } else {
      traceEvents.push({ ph: 'i', pid, tid, ts, name: e.name, cat, s: 't', args });
    }
  }

  return {
    traceEvents,
    displayTimeUnit: 'ms',
    otherData: {
      sessionId: meta.sessionId || '',
      recordedBy: 'Znada Diagnostics',
      app: meta.app || {},
    },
  };
}

module.exports = { ROLE_TID, toChromeTrace };
