'use strict';

const fs = require('fs');
const path = require('path');

function byteLength(lines) {
  return lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
}

function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('flush_timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class JsonlWriter {
  constructor({
    filePath,
    fsModule = fs,
    flushIntervalMs = 500,
    flushBytes = 64 * 1024,
    maxPendingBytes = 8 * 1024 * 1024,
    reservedPendingBytes = 256 * 1024,
    maxFileBytes = 200 * 1024 * 1024,
    // Disabled by default. A wall-clock timeout running on the same main event loop
    // cannot distinguish slow disk I/O from the exact long main-thread stall that
    // diagnostics is trying to capture: after the stall the timer may run before the
    // already-completed append callback and falsely stop the recording. Tests and
    // special callers can still opt into a timeout explicitly.
    flushTimeoutMs = 0,
    now = () => Date.now(),
    onDegraded = () => {},
  } = {}) {
    if (!filePath) throw new Error('filePath is required');
    this.filePath = filePath;
    this.fs = fsModule;
    this.flushIntervalMs = flushIntervalMs;
    this.flushBytes = flushBytes;
    this.maxPendingBytes = maxPendingBytes;
    this.reservedPendingBytes = reservedPendingBytes;
    this.maxFileBytes = maxFileBytes;
    this.flushTimeoutMs = flushTimeoutMs;
    this.now = now;
    this.onDegraded = onDegraded;
    this.active = false;
    this.degraded = false;
    this.degradedReason = '';
    this.pendingLines = [];
    this.pendingBytes = 0;
    this.bytesWritten = 0;
    this.flushTimer = null;
    this.flushPromise = null;
    this.stats = {
      enqueued: 0,
      dropped: 0,
      droppedByCategory: {},
      flushes: 0,
      flushErrors: 0,
      bytesWritten: 0,
      lastFlushDurationMs: 0,
      maxQueueDepth: 0,
    };
  }

  async start() {
    await this.fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    this.active = true;
    this.degraded = false;
    this.degradedReason = '';
    return this;
  }

  enqueue(events, { reserved = false } = {}) {
    if (!this.active || this.degraded) return { accepted: 0, dropped: 0 };
    const list = Array.isArray(events) ? events : [events];
    let accepted = 0;
    let dropped = 0;

    for (const event of list) {
      if (!event || typeof event !== 'object') {
        dropped += 1;
        this.markDropped('invalid');
        continue;
      }
      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line);
      const reserveLimit = reserved ? this.maxPendingBytes + this.reservedPendingBytes : this.maxPendingBytes;
      if (this.pendingBytes + bytes > reserveLimit) {
        dropped += 1;
        this.markDropped(event.category || 'unknown');
        continue;
      }
      if (this.bytesWritten + this.pendingBytes + bytes > this.maxFileBytes) {
        dropped += 1;
        this.markDropped(event.category || 'unknown');
        this.setDegraded('max_file_bytes');
        break;
      }
      this.pendingLines.push(line);
      this.pendingBytes += bytes;
      this.stats.enqueued += 1;
      accepted += 1;
    }

    this.stats.maxQueueDepth = Math.max(this.stats.maxQueueDepth, this.pendingLines.length);
    if (this.pendingBytes >= this.flushBytes) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
    return { accepted, dropped };
  }

  markDropped(category) {
    this.stats.dropped += 1;
    this.stats.droppedByCategory[category] = (this.stats.droppedByCategory[category] || 0) + 1;
  }

  scheduleFlush() {
    if (!this.active || this.flushTimer || !this.flushIntervalMs) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  async flush() {
    if (this.flushPromise) return this.flushPromise;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pendingLines.length || this.degraded) return;

    const lines = this.pendingLines;
    const bytes = this.pendingBytes || byteLength(lines);
    this.pendingLines = [];
    this.pendingBytes = 0;
    const started = this.now();

    this.flushPromise = withTimeout(
      this.fs.promises.appendFile(this.filePath, lines.join(''), 'utf8'),
      this.flushTimeoutMs,
    ).then(() => {
      this.bytesWritten += bytes;
      this.stats.bytesWritten = this.bytesWritten;
      this.stats.flushes += 1;
      this.stats.lastFlushDurationMs = Math.max(0, this.now() - started);
    }).catch((err) => {
      this.stats.flushErrors += 1;
      this.setDegraded(err && err.message === 'flush_timeout' ? 'flush_timeout' : 'write_error');
    }).finally(() => {
      this.flushPromise = null;
    });

    return this.flushPromise;
  }

  setDegraded(reason) {
    if (this.degraded) return;
    this.degraded = true;
    this.degradedReason = reason || 'unknown';
    this.active = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.onDegraded(this.degradedReason);
  }

  async stop() {
    this.active = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    return this.getStats();
  }

  async shutdownBestEffort() {
    try {
      return await this.stop();
    } catch {
      return this.getStats();
    }
  }

  getStats() {
    return {
      ...this.stats,
      active: this.active,
      degraded: this.degraded,
      degradedReason: this.degradedReason,
      pendingBytes: this.pendingBytes,
      pendingLines: this.pendingLines.length,
    };
  }
}

module.exports = {
  JsonlWriter,
};
