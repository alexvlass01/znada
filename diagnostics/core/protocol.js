'use strict';

const PROTOCOL_VERSION = 1;
const MAX_NAME_LENGTH = 160;
const MAX_STRING_LENGTH = 1000;
const MAX_ATTRIBUTES = 32;

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  'active',
  'bytes',
  'cards',
  'count',
  'cooldownMs',
  'cpuPercent',
  'crashes',
  'depth',
  'dropped',
  'durationMs',
  'encodedBytes',
  'errorCode',
  'extension',
  'heapMB',
  'height',
  'helperVersion',
  'hiddenMs',
  'id',
  'inserted',
  'label',
  'limit',
  'longFrames',
  'lowQuality',
  'maxMs',
  'meanMs',
  'memoryMB',
  'mime',
  'moved',
  'nodes',
  'nominalMs',
  'op',
  'p95Ms',
  'pathAlias',
  'pending',
  'phase',
  'pid',
  'protocolVersion',
  'queueDepth',
  'reason',
  'removed',
  'role',
  'retry',
  'size',
  'state',
  'status',
  'totalMs',
  'unavailable',
  'utilization',
  'valueKind',
  'waitMs',
  'width',
  'windowsCache',
  'windowEndMs',
  'windowStartMs',
]);

function createCounters() {
  return {
    invalidEvents: 0,
    invalidAttributes: 0,
    oversizedAttributes: 0,
    droppedAttributes: 0,
  };
}

function inc(counters, key, by = 1) {
  if (counters && Object.prototype.hasOwnProperty.call(counters, key)) counters[key] += by;
}

function safeString(value, max = MAX_NAME_LENGTH) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeSource(source, fallback) {
  const src = source && typeof source === 'object' ? source : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const role = safeString(src.role || base.role || 'unknown', 64) || 'unknown';
  const pidRaw = src.pid ?? base.pid;
  const pid = Number.isInteger(pidRaw) && pidRaw >= 0 ? pidRaw : undefined;
  const webContentsIdRaw = src.webContentsId ?? base.webContentsId;
  const webContentsId = Number.isInteger(webContentsIdRaw) && webContentsIdRaw >= 0
    ? webContentsIdRaw
    : undefined;
  const result = { role };
  if (pid !== undefined) result.pid = pid;
  if (webContentsId !== undefined) result.webContentsId = webContentsId;
  return result;
}

function sanitizeAttributeValue(value, counters) {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (isFiniteNumber(value)) return value;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      inc(counters, 'oversizedAttributes');
      return undefined;
    }
    return value;
  }
  inc(counters, 'invalidAttributes');
  return undefined;
}

function sanitizeAttributes(attributes, counters = createCounters()) {
  const result = {};
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return result;

  let kept = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key)) {
      inc(counters, 'droppedAttributes');
      continue;
    }
    if (kept >= MAX_ATTRIBUTES) {
      inc(counters, 'droppedAttributes');
      continue;
    }
    const clean = sanitizeAttributeValue(value, counters);
    if (clean === undefined) continue;
    result[key] = clean;
    kept += 1;
  }
  return result;
}

function normalizeTimestamp(rawTimestampMs, fallbackNowMs, timeOriginMs) {
  const absolute = isFiniteNumber(rawTimestampMs) ? rawTimestampMs : fallbackNowMs;
  return Math.max(0, Math.round(absolute - timeOriginMs));
}

function normalizeEvent(raw, {
  sessionId,
  sequence,
  source,
  timeOriginMs,
  nowMs,
  counters = createCounters(),
} = {}) {
  if (!raw || typeof raw !== 'object') {
    inc(counters, 'invalidEvents');
    return null;
  }
  const kind = safeString(raw.kind, 64);
  const category = safeString(raw.category, 96);
  const name = safeString(raw.name, MAX_NAME_LENGTH);
  if (!sessionId || !Number.isInteger(sequence) || sequence < 1 || !kind || !category || !name) {
    inc(counters, 'invalidEvents');
    return null;
  }

  const event = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    sequence,
    source: sanitizeSource(raw.source, source),
    timestampMs: normalizeTimestamp(raw.timestampMs, nowMs, timeOriginMs),
    kind,
    category,
    name,
    attributes: sanitizeAttributes(raw.attributes, counters),
  };

  if (raw.durationMs !== undefined) {
    if (isFiniteNumber(raw.durationMs) && raw.durationMs >= 0) event.durationMs = raw.durationMs;
    else inc(counters, 'invalidEvents');
  }
  if (raw.value !== undefined) {
    if (raw.value === null || typeof raw.value === 'boolean' || typeof raw.value === 'string' || isFiniteNumber(raw.value)) {
      event.value = raw.value;
    } else {
      inc(counters, 'invalidEvents');
    }
  }
  if (raw.correlationId !== undefined) {
    const correlationId = safeString(raw.correlationId, 160);
    if (correlationId) event.correlationId = correlationId;
  }

  return event;
}

function createProtocol({ sessionId, source, timeOriginMs = Date.now(), now = () => Date.now() } = {}) {
  const counters = createCounters();
  let sequence = 0;
  return {
    normalize(raw, nowMs = now()) {
      const event = normalizeEvent(raw, {
        sessionId,
        source,
        timeOriginMs,
        nowMs,
        sequence: sequence + 1,
        counters,
      });
      if (!event) return null;
      sequence = event.sequence;
      return event;
    },
    getSequence() {
      return sequence;
    },
    getCounters() {
      return { ...counters };
    },
  };
}

module.exports = {
  PROTOCOL_VERSION,
  ALLOWED_ATTRIBUTE_KEYS,
  createCounters,
  createProtocol,
  normalizeEvent,
  sanitizeAttributes,
};
