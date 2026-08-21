'use strict';

const crypto = require('crypto');
const { createProtocol } = require('./protocol');

function createSessionId(nowMs = Date.now()) {
  const random = crypto.randomBytes(6).toString('hex');
  return `session-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}-${random}`;
}

class DiagnosticsSession {
  constructor({ source = { role: 'main', pid: process.pid }, now = () => Date.now() } = {}) {
    this.source = source;
    this.now = now;
    this.state = 'idle';
    this.sessionId = null;
    this.startedAtMs = 0;
    this.stoppedAtMs = 0;
    this.generation = 0;
    this.protocol = null;
    this.degradedReason = '';
    this.lateBatches = 0;
  }

  start({ sessionId, nowMs = this.now() } = {}) {
    if (this.state === 'recording') {
      return this.snapshot();
    }
    this.generation += 1;
    this.sessionId = sessionId || createSessionId(nowMs);
    this.startedAtMs = nowMs;
    this.stoppedAtMs = 0;
    this.degradedReason = '';
    this.lateBatches = 0;
    this.state = 'recording';
    this.protocol = createProtocol({
      sessionId: this.sessionId,
      source: this.source,
      timeOriginMs: this.startedAtMs,
      now: this.now,
    });
    return this.snapshot();
  }

  stop({ nowMs = this.now() } = {}) {
    if (this.state === 'recording') {
      this.state = 'stopping';
      this.stoppedAtMs = nowMs;
    }
    return this.snapshot();
  }

  complete() {
    if (this.state === 'recording' || this.state === 'stopping') {
      this.state = 'complete';
    }
    return this.snapshot();
  }

  degrade(reason = 'unknown') {
    if (this.state === 'idle') return this.snapshot();
    this.state = 'degraded';
    this.degradedReason = String(reason || 'unknown');
    return this.snapshot();
  }

  canAccept(generation = this.generation) {
    return this.state === 'recording' && generation === this.generation && this.protocol;
  }

  record(raw, { generation = this.generation, nowMs = this.now() } = {}) {
    if (!this.canAccept(generation)) return null;
    return this.protocol.normalize(raw, nowMs);
  }

  recordBatch(rawEvents, { generation = this.generation, nowMs = this.now() } = {}) {
    if (!this.canAccept(generation)) {
      this.lateBatches += 1;
      return [];
    }
    const list = Array.isArray(rawEvents) ? rawEvents : [rawEvents];
    return list.map((raw) => this.record(raw, { generation, nowMs })).filter(Boolean);
  }

  mark(label = 'lag', { generation = this.generation, nowMs = this.now(), windowMs = 3000 } = {}) {
    return this.record({
      kind: 'mark',
      category: 'manual',
      name: 'user-mark',
      timestampMs: nowMs,
      attributes: {
        label: String(label || 'lag'),
        windowStartMs: Math.max(0, nowMs - windowMs - this.startedAtMs),
        windowEndMs: Math.max(0, nowMs - this.startedAtMs),
      },
    }, { generation, nowMs });
  }

  snapshot() {
    return {
      state: this.state,
      sessionId: this.sessionId,
      generation: this.generation,
      startedAtMs: this.startedAtMs,
      stoppedAtMs: this.stoppedAtMs,
      degradedReason: this.degradedReason,
      lateBatches: this.lateBatches,
      protocolCounters: this.protocol ? this.protocol.getCounters() : null,
      sequence: this.protocol ? this.protocol.getSequence() : 0,
    };
  }
}

module.exports = {
  DiagnosticsSession,
  createSessionId,
};
