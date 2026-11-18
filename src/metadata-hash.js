'use strict';

// PERF-007. MD5 of a local file as a stream that can be abandoned.
// A stalled SMB read used to sit in `data`/`end` forever and hold the one metadata
// worker. The deadline and an abort both destroy the stream so the read promise
// settles and the handle is released. `createReadStream` is read at call time:
// callers and tests patch `fs.createReadStream` after this module has loaded.

const fs = require('fs');
const crypto = require('crypto');

const HASH_TIMEOUT = 'HASH_TIMEOUT';
const ABORT_ERR = 'ABORT_ERR';

function hashError(code) {
  const err = /** @type {Error & { code: string }} */ (new Error(code === HASH_TIMEOUT ? 'hash timed out' : 'hash aborted'));
  err.code = code;
  err.name = code === HASH_TIMEOUT ? 'TimeoutError' : 'AbortError';
  return err;
}

function hashFileMd5(filePath, opts) {
  const o = opts || {};
  const open = o.createReadStream || fs.createReadStream;
  const setTimer = o.setTimer || setTimeout;
  const clearTimer = o.clearTimer || clearTimeout;
  const timeoutMs = Number(o.timeoutMs);
  const signal = o.signal || null;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(hashError(signal.reason && signal.reason.code === HASH_TIMEOUT ? HASH_TIMEOUT : ABORT_ERR));
      return;
    }

    let stream;
    try {
      stream = open(filePath);
    } catch (err) {
      reject(err);
      return;
    }

    const hash = crypto.createHash('md5');
    let settled = false;
    let timer = null;

    const finish = (fn, value, release) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      timer = null;
      if (signal) signal.removeEventListener('abort', onAbort);
      // A finished read closes itself. Destroying it here would run before a
      // listener that was registered first (the identity check swaps the file
      // on `end`). Cancel, timeout and a read error still release the handle.
      if (release) {
        try {
          if (stream && typeof stream.destroy === 'function' && !stream.destroyed) stream.destroy();
        } catch { /* the promise already has its answer */ }
      }
      fn(value);
    };

    const onAbort = () => finish(reject, hashError(
      signal.reason && signal.reason.code === HASH_TIMEOUT ? HASH_TIMEOUT : ABORT_ERR,
    ), true);

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimer(() => finish(reject, hashError(HASH_TIMEOUT), true), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    stream.on('error', (err) => finish(reject, err, true));
    stream.on('data', (chunk) => { if (!settled) hash.update(chunk); });
    stream.on('end', () => finish(resolve, hash.digest('hex'), false));
  });
}

module.exports = { hashFileMd5, HASH_TIMEOUT, ABORT_ERR };
