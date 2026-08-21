'use strict';

// Optional observability hooks (used by dev-only diagnostics; production callers pass
// nothing and take the single `if (hooks)` branch per event):
//   onEnqueue({ pending, active })
//   onStart({ startedAt, waitMs, pending, active })
//   onSettle({ ok, startedAt, waitMs, runMs, pending, active })  // active still counts this job
// Hook errors are swallowed — a broken observer must never break or reorder the queue.
// `hooks.now` overrides the clock for deterministic tests.
function createTaskQueue(limit, hooks = null) {
  const max = Math.max(1, Math.floor(Number(limit) || 1));
  const queue = [];
  let active = 0;
  const now = hooks && typeof hooks.now === 'function' ? hooks.now : Date.now;

  const emit = (name, info) => {
    if (!hooks || typeof hooks[name] !== 'function') return;
    try { hooks[name](info); } catch {}
  };

  const pump = () => {
    while (active < max && queue.length) {
      // Higher-priority work represents the renderer's current virtual window.
      // Preserve FIFO order within the same priority so ordinary callers retain
      // the queue's historical behaviour.
      let nextIndex = 0;
      for (let i = 1; i < queue.length; i++) {
        if (queue[i].priority > queue[nextIndex].priority) nextIndex = i;
      }
      const job = queue.splice(nextIndex, 1)[0];
      active += 1;
      const startedAt = now();
      const waitMs = Math.max(0, startedAt - job.enqueuedAt);
      emit('onStart', { startedAt, waitMs, pending: queue.length, active });
      const settle = (ok) => emit('onSettle', {
        ok,
        startedAt,
        waitMs,
        runMs: Math.max(0, now() - startedAt),
        pending: queue.length,
        active,
      });
      Promise.resolve()
        .then(job.fn)
        .then(
          (value) => { settle(true); job.resolve(value); },
          (error) => { settle(false); job.reject(error); },
        )
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return function enqueue(fn, options = null) {
    return new Promise((resolve, reject) => {
      const rawPriority = options && Number(options.priority);
      const priority = Number.isFinite(rawPriority) ? rawPriority : 0;
      queue.push({ fn, resolve, reject, enqueuedAt: now(), priority });
      emit('onEnqueue', { pending: queue.length, active });
      pump();
    });
  };
}

module.exports = { createTaskQueue };
