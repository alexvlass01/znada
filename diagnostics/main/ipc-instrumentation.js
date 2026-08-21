'use strict';

function toList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesChannel(matcher, channel) {
  if (typeof matcher === 'string') return matcher === channel;
  if (matcher instanceof RegExp) return matcher.test(channel);
  if (typeof matcher === 'function') return matcher(channel);
  return false;
}

function isListed(channel, list) {
  return toList(list).some((matcher) => matchesChannel(matcher, channel));
}

function isThenable(value) {
  return value && (typeof value === 'object' || typeof value === 'function') &&
    typeof value.then === 'function';
}

function valueKind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function errorReason(err) {
  if (err && err.constructor && typeof err.constructor.name === 'string' && err.constructor.name) {
    return err.constructor.name;
  }
  return 'Error';
}

function safeRecord(record, event) {
  try { record(event); } catch {}
}

function createIpcSpanRecorder({ channel, startMs, now, record }) {
  const finish = (status, extra = {}) => {
    const endMs = now();
    safeRecord(record, {
      kind: 'span',
      category: 'ipc',
      name: channel,
      timestampMs: startMs,
      durationMs: Math.max(0, endMs - startMs),
      attributes: {
        status,
        ...extra,
      },
    });
  };
  return {
    ok(value) {
      finish('ok', { valueKind: valueKind(value) });
    },
    error(err) {
      finish('error', { reason: errorReason(err) });
    },
  };
}

function instrumentHandler(channel, handler, options) {
  const { now, record } = options;
  return function instrumentedIpcHandler(...args) {
    const startMs = now();
    const span = createIpcSpanRecorder({ channel, startMs, now, record });
    let result;
    try {
      result = handler.apply(this, args);
    } catch (err) {
      span.error(err);
      throw err;
    }

    if (isThenable(result)) {
      return result.then(
        (value) => {
          span.ok(value);
          return value;
        },
        (err) => {
          span.error(err);
          throw err;
        }
      );
    }

    span.ok(result);
    return result;
  };
}

function instrumentIpcMain(ipcMain, {
  enabled = false,
  now = () => Date.now(),
  record = () => {},
  denyList = [],
  muteList = [],
} = {}) {
  if (!enabled || !ipcMain || typeof ipcMain.handle !== 'function') return ipcMain;

  const originalHandle = ipcMain.handle;
  const facade = Object.create(ipcMain);

  facade.handle = function handle(channel, handler) {
    const shouldSkip = isListed(channel, denyList) || isListed(channel, muteList);
    const registeredHandler = shouldSkip
      ? handler
      : instrumentHandler(channel, handler, { now, record });
    return originalHandle.call(ipcMain, channel, registeredHandler);
  };

  return facade;
}

module.exports = {
  instrumentIpcMain,
  instrumentHandler,
  isListed,
};
