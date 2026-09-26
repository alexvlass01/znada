'use strict';

// PERF-010. Not downloading the same picture twice.
//
// "Add to Library" used to fetch the original again although the viewer was already
// showing it. For the booru sites the viewer's original comes through main's own
// streaming proxy (PERF-008): main downloads it, passes the bytes on, and kept none of
// them. `createOriginalStore` keeps the last few COMPLETE originals the proxy served,
// keyed by the address they came from, so an add of the picture being looked at takes
// the bytes main already has. A proxy download still in flight is joined rather than
// started a second time.
//
// What may go in is narrow on purpose:
//   * only bytes main itself fetched from that address — never bytes from a window;
//   * only the full tier — a downscaled sample must never stand in for the original.
// The caller enforces both by feeding the store from the proxy's full tier alone.
//
// It is a shortcut for "open, then add", not a cache of everything seen: bounded by
// count and by bytes, and entries expire. Clock and timers are injected for tests.
//
// `createInFlight` is the second half: the same picture added from two windows at once
// (the grid and the viewer) shares one download instead of racing two.

const DEFAULTS = Object.freeze({
  maxEntries: 3,
  maxBytes: 64 * 1024 * 1024,
  ttlMs: 10 * 60 * 1000,
});

function keyOf(url) {
  return String(url || '').trim();
}

function createOriginalStore({
  maxEntries = DEFAULTS.maxEntries,
  maxBytes = DEFAULTS.maxBytes,
  ttlMs = DEFAULTS.ttlMs,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  // Insertion order is age: the first key is the one to evict.
  const done = new Map(); // key -> { bytes, contentType, at }
  const pending = new Map(); // key -> { promise, settle }
  let total = 0;
  let sweep = null;

  function drop(key) {
    const entry = done.get(key);
    if (!entry) return;
    total -= entry.bytes.length;
    done.delete(key);
  }

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of done) {
      if (entry.at <= cutoff) drop(key);
    }
    for (const key of done.keys()) {
      if (done.size <= maxEntries && total <= maxBytes) break;
      drop(key);
    }
  }

  // Memory is given back when entries expire, not only when the store is next used:
  // otherwise one look at a large booru original would hold it for the whole session.
  function armSweep() {
    if (sweep) { clearTimer(sweep); sweep = null; }
    if (!done.size) return;
    sweep = setTimer(() => { sweep = null; prune(); armSweep(); }, ttlMs);
    if (sweep && typeof sweep.unref === 'function') sweep.unref();
  }

  // Start keeping a download. The handle must be settled exactly once: `finish` with the
  // complete bytes, or `fail` when it broke, was cut off or went over the limit.
  function begin(url) {
    const key = keyOf(url);
    let settled = false;
    let settle = () => {};
    const promise = new Promise((resolve) => { settle = resolve; });
    const slot = { promise, settle };
    if (key) pending.set(key, slot);
    const release = (value) => {
      if (settled) return;
      settled = true;
      if (pending.get(key) === slot) pending.delete(key);
      slot.settle(value);
    };
    return {
      finish(bytes, contentType) {
        if (settled) return;
        const type = String(contentType || '');
        if (!key || !Buffer.isBuffer(bytes) || !bytes.length || !type) { release(null); return; }
        const entry = { bytes, contentType: type, at: now() };
        // Too big to keep is still complete: whoever is waiting right now gets it.
        if (bytes.length <= maxBytes) {
          drop(key);
          done.set(key, entry);
          total += bytes.length;
          prune();
          armSweep();
        }
        release(entry);
      },
      fail() { release(null); },
    };
  }

  // The complete original for this address, or null. A download still in flight is
  // waited for up to `waitMs`; past that the caller fetches it itself.
  async function get(url, { waitMs = 0 } = {}) {
    const key = keyOf(url);
    if (!key) return null;
    prune();
    const entry = done.get(key);
    if (entry) {
      done.delete(key);
      done.set(key, entry);
      return entry;
    }
    const slot = pending.get(key);
    if (!slot || !(waitMs > 0)) return null;
    let timer = null;
    const late = new Promise((resolve) => { timer = setTimer(() => resolve(null), waitMs); });
    try {
      return await Promise.race([slot.promise, late]);
    } finally {
      clearTimer(timer);
    }
  }

  function clear() {
    done.clear();
    total = 0;
    armSweep();
  }

  return {
    begin,
    get,
    clear,
    stats: () => ({ entries: done.size, bytes: total, pending: pending.size }),
  };
}

// One run per key at a time; a second call while the first is running gets the same
// promise. An empty key is never joined.
function createInFlight() {
  const running = new Map();
  return {
    run(key, fn) {
      const k = String(key || '');
      if (!k) return Promise.resolve().then(fn);
      if (running.has(k)) return running.get(k);
      const job = Promise.resolve().then(fn).finally(() => {
        if (running.get(k) === job) running.delete(k);
      });
      running.set(k, job);
      return job;
    },
    size: () => running.size,
  };
}

module.exports = { createOriginalStore, createInFlight, DEFAULTS };
