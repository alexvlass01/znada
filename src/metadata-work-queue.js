'use strict';

// PERF-007. One-at-a-time queue for metadata lookup only.
// `createTaskQueue` stays unbounded: thumbnails and its tests depend on that.
// Here a pending cap answers `busy` instead of growing, the same key shares one
// promise, and a deadline aborts the job. The worker is released even when the
// function ignores the signal — the deadline races the promise.

const DEFAULT_MAX_PENDING = 8;
const DEFAULT_TIMEOUT_MS = 180000;

function abortError() {
  const err = /** @type {Error & { code: string }} */ (new Error('aborted'));
  err.code = 'ABORT_ERR';
  err.name = 'AbortError';
  return err;
}

function defaultBusy() {
  return { status: 'busy', reason: 'queue', retryAfterMs: 1000 };
}

function defaultTimeout() {
  return { status: 'error', reason: 'timeout' };
}

// Settle with `promise`, or reject when `signal` aborts. A later rejection of
// the original promise is swallowed once this race has already settled.
function raceSignal(promise, signal) {
  const wrapped = Promise.resolve(promise);
  if (!signal) return wrapped;
  if (signal.aborted) {
    wrapped.then(() => {}, () => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    wrapped.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function createMetadataWorkQueue(options) {
  const o = options || {};
  const maxPending = Math.max(1, Math.floor(Number(o.maxPending) || DEFAULT_MAX_PENDING));
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const setTimer = o.setTimer || setTimeout;
  const clearTimer = o.clearTimer || clearTimeout;
  const pending = [];
  const waiters = new Map();
  let active = 0;

  function lowestIndex() {
    let index = 0;
    for (let i = 1; i < pending.length; i++) {
      if (pending[i].priority < pending[index].priority) index = i;
    }
    return index;
  }

  function settleJob(job, value) {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimer(job.timer);
    job.timer = null;
    if (job.onAbort) job.controller.signal.removeEventListener('abort', job.onAbort);
    waiters.delete(job.key);
    job.resolve(value);
    active -= 1;
    pump();
  }

  function failJob(job, err) {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimer(job.timer);
    job.timer = null;
    if (job.onAbort) job.controller.signal.removeEventListener('abort', job.onAbort);
    waiters.delete(job.key);
    job.reject(err);
    active -= 1;
    pump();
  }

  function pump() {
    while (active < 1 && pending.length) {
      let nextIndex = 0;
      for (let i = 1; i < pending.length; i++) {
        if (pending[i].priority > pending[nextIndex].priority) nextIndex = i;
      }
      const job = pending.splice(nextIndex, 1)[0];
      active += 1;
      const controller = new AbortController();
      job.controller = controller;
      job.onAbort = () => {
        if (job.jobPromise) job.jobPromise.then(() => {}, () => {});
        settleJob(job, job.onTimeout());
      };
      controller.signal.addEventListener('abort', job.onAbort, { once: true });
      try {
        job.jobPromise = Promise.resolve(job.fn(controller.signal));
      } catch (err) {
        job.jobPromise = Promise.reject(err);
      }
      job.jobPromise.then(
        (value) => {
          if (job.settled || controller.signal.aborted) return;
          settleJob(job, value);
        },
        (err) => {
          if (job.settled || controller.signal.aborted) return;
          failJob(job, err);
        },
      );
      job.timer = setTimer(() => controller.abort(), timeoutMs);
      if (job.timer && typeof job.timer.unref === 'function') job.timer.unref();
    }
  }

  function enqueue(key, fn, options) {
    const opt = options || {};
    const name = String(key);
    const existing = waiters.get(name);
    if (existing) return existing.promise;

    const rawPriority = Number(opt.priority);
    const priority = Number.isFinite(rawPriority) ? rawPriority : 0;
    const busy = typeof opt.busy === 'function' ? opt.busy : defaultBusy;
    const onTimeout = typeof opt.onTimeout === 'function' ? opt.onTimeout : defaultTimeout;

    if (pending.length >= maxPending) {
      let lowest = Infinity;
      for (const job of pending) if (job.priority < lowest) lowest = job.priority;
      if (!(priority > lowest)) return Promise.resolve(busy());
      const dropped = pending.splice(lowestIndex(), 1)[0];
      dropped.settled = true;
      waiters.delete(dropped.key);
      dropped.resolve(busy());
    }

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const job = {
      key: name,
      fn,
      priority,
      resolve,
      reject,
      onTimeout,
      settled: false,
      timer: null,
      controller: null,
      onAbort: null,
      jobPromise: null,
    };
    pending.push(job);
    waiters.set(name, { promise, priority });
    pump();
    return promise;
  }

  return {
    enqueue,
    pendingCount() { return pending.length; },
    activeCount() { return active; },
  };
}

module.exports = {
  createMetadataWorkQueue,
  raceSignal,
  abortError,
  DEFAULT_MAX_PENDING,
  DEFAULT_TIMEOUT_MS,
};
