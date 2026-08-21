'use strict';

const path = require('path');
const { spawn } = require('child_process');

const PROTOCOL_VERSION = 1;
const DEFAULT_STARTUP_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 500;
const DEFAULT_FRAME_LIMIT = 12 * 1024 * 1024;

class ThumbnailHostError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'ThumbnailHostError';
    this.code = code || 'internal';
    this.retriable = !!options.retriable;
  }
}

function resolveThumbnailHelperPath({ isPackaged, resourcesPath, appPath }) {
  if (isPackaged) {
    return path.join(resourcesPath, 'thumbnail-helper', 'Znada.ThumbnailHelper.exe');
  }
  return path.join(appPath, '.build', 'thumbnail-helper', 'Znada.ThumbnailHelper.exe');
}

class ThumbnailHost {
  constructor(options = {}) {
    this.executablePath = options.executablePath || '';
    this.spawnImpl = options.spawnImpl || spawn;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.startupTimeoutMs = options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs || DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.frameLimit = options.frameLimit || DEFAULT_FRAME_LIMIT;
    this.crashLimit = options.crashLimit || 3;
    this.crashWindowMs = options.crashWindowMs || 60000;
    this.cooldownMs = options.cooldownMs || 30000;

    this.proc = null;
    this.buffer = '';
    this.ready = false;
    this.startPromise = null;
    this.startResolve = null;
    this.startReject = null;
    this.startTimer = null;
    this.pending = new Map();
    this.nextId = 1;
    this.intentionalExit = false;
    this.disposed = false;
    this.crashTimes = [];
    this.circuitUntil = 0;
  }

  _event(name, attributes = {}) {
    try { this.onEvent(name, attributes); } catch {}
  }

  _makeError(code, message, retriable) {
    return new ThumbnailHostError(code, message, { retriable });
  }

  async start() {
    if (this.disposed) throw this._makeError('disposed', 'Thumbnail helper is disposed', false);
    if (this.proc && this.ready) return this.proc;
    if (this.startPromise) return this.startPromise;
    if (!this.executablePath) throw this._makeError('start_failed', 'Thumbnail helper path is unavailable', false);

    const now = this.now();
    if (this.circuitUntil > now) {
      this._event('circuit-open', { cooldownMs: this.circuitUntil - now });
      throw this._makeError('circuit_open', 'Thumbnail helper is cooling down', true);
    }

    let proc;
    try {
      proc = this.spawnImpl(this.executablePath, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw this._makeError('start_failed', 'Thumbnail helper could not be started', true);
    }

    this.proc = proc;
    this.ready = false;
    this.buffer = '';
    this.intentionalExit = false;
    this._event('start', { pid: Number(proc.pid) || 0 });

    if (proc.stdout && typeof proc.stdout.setEncoding === 'function') proc.stdout.setEncoding('utf8');
    if (proc.stderr && typeof proc.stderr.setEncoding === 'function') proc.stderr.setEncoding('utf8');
    if (proc.stdout && typeof proc.stdout.on === 'function') {
      proc.stdout.on('data', (chunk) => this._onData(proc, chunk));
    }
    if (proc.stderr && typeof proc.stderr.on === 'function') {
      proc.stderr.on('data', () => {});
    }
    if (typeof proc.on === 'function') {
      proc.on('error', () => this._terminate(proc, this._makeError('process_lost', 'Thumbnail helper process failed', true), true));
      proc.on('exit', (code, signal) => {
        const error = this._makeError('process_lost', 'Thumbnail helper exited', true);
        error.exitCode = code;
        error.signal = signal;
        this._terminate(proc, error, !this.intentionalExit);
      });
    }

    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      this.startTimer = this.setTimer(() => {
        const error = this._makeError('start_timeout', 'Thumbnail helper start timed out', true);
        this._event('timeout', { phase: 'start', pid: Number(proc.pid) || 0 });
        this._kill(proc);
        this._terminate(proc, error, true);
      }, this.startupTimeoutMs);
    });
    return this.startPromise;
  }

  _onData(proc, chunk) {
    if (this.proc !== proc) return;
    this.buffer += String(chunk);
    if (this.buffer.length > this.frameLimit && this.buffer.indexOf('\n') < 0) {
      this._protocolFailure(proc, 'Thumbnail helper frame is too large');
      return;
    }

    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (line.length > this.frameLimit) {
        this._protocolFailure(proc, 'Thumbnail helper frame is too large');
        return;
      }

      let message;
      try { message = JSON.parse(line); }
      catch {
        this._protocolFailure(proc, 'Thumbnail helper sent malformed JSON');
        return;
      }
      if (!message || message.protocolVersion !== PROTOCOL_VERSION) {
        this._protocolFailure(proc, 'Thumbnail helper protocol is incompatible');
        return;
      }
      if (message.type === 'ready') {
        this._onReady(proc, message);
      } else if (message.type === 'response') {
        this._onResponse(proc, message);
      } else {
        this._protocolFailure(proc, 'Thumbnail helper message type is invalid');
        return;
      }
    }
  }

  _onReady(proc, message) {
    if (this.proc !== proc || this.ready || !this.startPromise) return;
    if (!message.capabilities || !Array.isArray(message.capabilities.delivery)
      || !message.capabilities.delivery.includes('inline')) {
      this._protocolFailure(proc, 'Thumbnail helper lacks inline delivery');
      return;
    }
    this.ready = true;
    if (this.startTimer) this.clearTimer(this.startTimer);
    this.startTimer = null;
    const resolve = this.startResolve;
    this.startResolve = null;
    this.startReject = null;
    this.startPromise = null;
    this._event('ready', {
      pid: Number(message.pid || proc.pid) || 0,
      protocolVersion: message.protocolVersion,
      helperVersion: String(message.helperVersion || ''),
    });
    if (resolve) resolve(proc);
  }

  _onResponse(proc, message) {
    if (this.proc !== proc) return;
    const id = Number(message.id);
    const item = this.pending.get(id);
    if (!item) return;
    if (typeof message.ok !== 'boolean') {
      this._protocolFailure(proc, 'Thumbnail helper response status is invalid');
      return;
    }
    if (message.ok && item.op === 'thumbnail' && !this._validThumbnailResult(message.result)) {
      this._protocolFailure(proc, 'Thumbnail helper result is invalid');
      return;
    }
    this.pending.delete(id);
    this.clearTimer(item.timer);

    const elapsedMs = Math.max(0, this.now() - item.startedAt);
    if (message.ok) {
      const result = message.result || {};
      this._event('response', {
        pid: Number(proc.pid) || 0,
        id,
        op: item.op,
        status: 'ok',
        totalMs: elapsedMs,
        durationMs: Number(result.durationMs) || 0,
        encodedBytes: Number(result.encodedBytes) || 0,
        mime: String(result.mime || ''),
        windowsCache: String(result.windowsCache || ''),
        lowQuality: !!result.lowQuality,
        retry: item.retry,
      });
      item.resolve(result);
      return;
    }

    const raw = message.error || {};
    const error = this._makeError(
      typeof raw.code === 'string' ? raw.code : 'internal',
      typeof raw.message === 'string' ? raw.message : 'Thumbnail helper request failed',
      !!raw.retriable
    );
    this._event('response', {
      pid: Number(proc.pid) || 0,
      id,
      op: item.op,
      status: 'error',
      errorCode: error.code,
      totalMs: elapsedMs,
      retry: item.retry,
    });
    item.reject(error);
  }

  _validThumbnailResult(result) {
    return !!(result && typeof result === 'object' && !Array.isArray(result)
      && result.delivery === 'inline'
      && (result.mime === 'image/jpeg' || result.mime === 'image/png')
      && Number.isInteger(result.width) && result.width > 0 && result.width <= 4096
      && Number.isInteger(result.height) && result.height > 0 && result.height <= 4096
      && typeof result.dataBase64 === 'string' && result.dataBase64.length > 0
      && Number.isInteger(result.encodedBytes) && result.encodedBytes > 0
      && result.encodedBytes <= 8 * 1024 * 1024);
  }

  _protocolFailure(proc, message) {
    const error = this._makeError('protocol_error', message, true);
    this._kill(proc);
    this._terminate(proc, error, true);
  }

  _recordCrash() {
    const now = this.now();
    this.crashTimes = this.crashTimes.filter((timestamp) => now - timestamp <= this.crashWindowMs);
    this.crashTimes.push(now);
    if (this.crashTimes.length >= this.crashLimit) {
      this.circuitUntil = now + this.cooldownMs;
      this._event('circuit-open', { cooldownMs: this.cooldownMs, crashes: this.crashTimes.length });
    }
  }

  _terminate(proc, error, unexpected) {
    if (this.proc !== proc) return;
    if (this.startTimer) this.clearTimer(this.startTimer);
    this.startTimer = null;

    const rejectStart = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    this.startPromise = null;
    if (rejectStart) rejectStart(error);

    for (const item of this.pending.values()) {
      this.clearTimer(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    this.proc = null;
    this.ready = false;
    this.buffer = '';
    if (unexpected) this._recordCrash();
    this._event('exit', {
      pid: Number(proc.pid) || 0,
      reason: unexpected ? 'unexpected' : 'shutdown',
      errorCode: error && error.code ? error.code : '',
    });
  }

  _kill(proc) {
    if (!proc) return;
    try { proc.kill(); } catch {}
  }

  async _request(op, payload = {}, options = {}) {
    const proc = await this.start();
    if (!this.ready || this.proc !== proc) throw this._makeError('process_lost', 'Thumbnail helper is unavailable', true);
    const id = this.nextId++;
    if (this.nextId > Number.MAX_SAFE_INTEGER) this.nextId = 1;
    const retry = Number(options.retry) || 0;
    const timeoutMs = Number(options.timeoutMs) || this.requestTimeoutMs;
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'request',
      id,
      op,
      ...payload,
    };

    return new Promise((resolve, reject) => {
      const startedAt = this.now();
      const timer = this.setTimer(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const error = this._makeError('extract_timeout', 'Thumbnail helper request timed out', true);
        reject(error);
        this._event('timeout', { phase: 'request', pid: Number(proc.pid) || 0, id, op, retry });
        this._kill(proc);
        this._terminate(proc, error, true);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, startedAt, op, retry });
      this._event('request', {
        pid: Number(proc.pid) || 0,
        id,
        op,
        size: Number(payload.size) || 0,
        retry,
      });
      try {
        proc.stdin.write(JSON.stringify(message) + '\n', 'utf8', (writeError) => {
          if (!writeError || !this.pending.has(id)) return;
          const error = this._makeError('process_lost', 'Thumbnail helper input failed', true);
          this._kill(proc);
          this._terminate(proc, error, true);
        });
      } catch {
        const error = this._makeError('process_lost', 'Thumbnail helper input failed', true);
        this._kill(proc);
        this._terminate(proc, error, true);
      }
    });
  }

  async thumbnail(sourcePath, size, jpegQuality = 82, retry = 0) {
    try {
      return await this._request('thumbnail', {
        path: sourcePath,
        size,
        encoding: { mode: 'auto', jpegQuality },
      }, { retry });
    } catch (error) {
      if (retry < 1 && error && error.code === 'process_lost' && !this.disposed) {
        this._event('restart', { retry: retry + 1 });
        return this.thumbnail(sourcePath, size, jpegQuality, retry + 1);
      }
      throw error;
    }
  }

  ping() {
    return this._request('ping');
  }

  async dispose() {
    if (this.disposed) return;
    const proc = this.proc;
    if (!proc) {
      this.disposed = true;
      return;
    }
    this.intentionalExit = true;
    try {
      await this._request('shutdown', {}, { timeoutMs: this.shutdownTimeoutMs });
    } catch {}
    this.disposed = true;
    if (this.proc === proc) {
      this._kill(proc);
      this._terminate(proc, this._makeError('disposed', 'Thumbnail helper was disposed', false), false);
    }
  }
}

module.exports = {
  PROTOCOL_VERSION,
  ThumbnailHost,
  ThumbnailHostError,
  resolveThumbnailHelperPath,
};
