'use strict';

const fs = require('fs');
const path = require('path');
const { DiagnosticsSession } = require('../core/session');
const { JsonlWriter } = require('../core/writer');
const retention = require('../core/retention');
const report = require('../core/report');
const { toChromeTrace } = require('../core/trace-export');
const { redactValue } = require('../core/redaction');

function retentionLimitFromEnv(env = process.env) {
  const raw = Number.parseInt(String(env.ZNADA_DIAGNOSTICS_RETENTION || ''), 10);
  return Number.isFinite(raw) && raw >= 1 && raw <= 200 ? raw : 15;
}

function defaultSessionsRoot(userDataPath) {
  return path.join(userDataPath, 'diagnostics', 'sessions');
}

function createSessionMeta({ session, sessionDir, reason, appInfo = {}, startedAtIso }) {
  const snapshot = session.snapshot();
  return {
    schemaVersion: 1,
    sessionId: snapshot.sessionId,
    state: snapshot.state,
    reason,
    startedAtMs: snapshot.startedAtMs,
    startedAtIso,
    sessionDir,
    app: appInfo,
  };
}

class DiagnosticsController {
  constructor({
    userDataPath,
    appInfo = {},
    ipcMain = null,
    shell = null,
    fsModule = fs,
    now = () => Date.now(),
    env = process.env,
    source = { role: 'main', pid: process.pid },
    writerFactory = null,
    samplerFactory = null,
    sessionsRoot = null,
    autoStart = true,
  } = {}) {
    if (!userDataPath && !sessionsRoot) throw new Error('userDataPath or sessionsRoot is required');
    this.userDataPath = userDataPath || path.dirname(path.dirname(sessionsRoot));
    this.sessionsRoot = sessionsRoot || defaultSessionsRoot(userDataPath);
    this.appInfo = appInfo;
    this.ipcMain = ipcMain;
    this.shell = shell;
    this.fs = fsModule;
    this.now = now;
    this.env = env;
    this.source = source;
    this.writerFactory = writerFactory;
    this.samplerFactory = samplerFactory;
    this.autoStart = autoStart;
    this.session = new DiagnosticsSession({ source, now });
    this.writer = null;
    this.sampler = null;
    this.sessionDir = '';
    this.eventsPath = '';
    this.metaPath = '';
    this.summaryHtmlPath = '';
    this.lastError = '';
    this.registered = false;
    this.shuttingDown = false;
    this.retentionKeep = retentionLimitFromEnv(env);
  }

  registerIpc() {
    if (!this.ipcMain || this.registered) return;
    this.registered = true;
    this.ipcMain.handle('diagnostics-status', () => this.status());
    this.ipcMain.handle('diagnostics-start', (_event, opts) => this.startRecording(opts || {}));
    this.ipcMain.handle('diagnostics-stop', (_event, opts) => this.stopRecording(opts || {}));
    this.ipcMain.handle('diagnostics-mark', (_event, label) => this.mark(label));
    // Renderer/viewer batches arrive here; stamp the sender's webContents id onto each
    // event so the report can tell the two windows apart even if a role is missing.
    this.ipcMain.handle('diagnostics-record', (event, events) => this.record(events, {
      webContentsId: event && event.sender ? event.sender.id : undefined,
    }));
    // Clock handshake: renderers align their wall-clock timestamps to main's clock.
    this.ipcMain.handle('diagnostics-clock', () => ({ now: this.now() }));
    this.ipcMain.handle('diagnostics-open-session-folder', () => this.openSessionFolder());
    this.ipcMain.handle('diagnostics-open-report', () => this.openReport());
    this.ipcMain.handle('diagnostics-export-sanitized', () => this.exportSanitized());
    this.ipcMain.handle('diagnostics-clear-sessions', () => this.clearSessions());
  }

  async startIfNeeded(reason = 'startup') {
    if (!this.autoStart) return this.status();
    return this.startRecording({ reason });
  }

  async startRecording({ reason = 'manual' } = {}) {
    if (this.session.snapshot().state === 'recording') {
      return { ok: true, status: this.status() };
    }
    this.lastError = '';
    this.summaryHtmlPath = '';
    try {
      const root = await retention.ensureRetentionRoot(this.sessionsRoot, { fsModule: this.fs });
      const startedAtMs = this.now();
      const startedAtIso = new Date(startedAtMs).toISOString();
      const snapshot = this.session.start({ nowMs: startedAtMs });
      this.sessionDir = path.join(root, snapshot.sessionId);
      this.eventsPath = path.join(this.sessionDir, 'events.jsonl');
      this.metaPath = path.join(this.sessionDir, 'meta.json');
      this.writer = this.createWriter(this.eventsPath);
      await this.writer.start();
      let retentionFailures = 0;
      try {
        const pruned = await retention.pruneSessions(root, {
          keep: this.retentionKeep,
          fsModule: this.fs,
        });
        retentionFailures = Array.isArray(pruned.failed) ? pruned.failed.length : 0;
      } catch {
        // Retention is optional housekeeping. Failure to enumerate or delete an old
        // session must not downgrade the fresh recording that is already writable.
        retentionFailures = 1;
      }
      await this.writeMeta(createSessionMeta({
        session: this.session,
        sessionDir: this.sessionDir,
        reason,
        appInfo: this.appInfo,
        startedAtIso,
      }));
      await this.recordLifecycle('session-started', { reason });
      if (retentionFailures) {
        await this.recordLifecycle('retention-prune-skipped', { count: retentionFailures });
      }
      this.startSampler();
      await this.writer.flush();
      return { ok: true, status: this.status() };
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err);
      this.stopSampler();
      if (this.writer) {
        try { await this.writer.shutdownBestEffort(); } catch {}
        this.writer = null;
      }
      this.session.degrade(this.lastError);
      return { ok: false, error: this.lastError, status: this.status() };
    }
  }

  // Sampler probes live only while a session records; a sampler failure must not
  // fail the recording itself (events are still valuable without samples).
  startSampler() {
    if (!this.samplerFactory || this.sampler) return;
    try {
      this.sampler = this.samplerFactory({ record: (raw) => this.recordEvent(raw) });
      if (this.sampler) this.sampler.start();
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err);
      this.sampler = null;
    }
  }

  stopSampler() {
    if (!this.sampler) return;
    try { this.sampler.stop(); } catch {}
    this.sampler = null;
  }

  createWriter(filePath) {
    // A degraded writer also silences the sampler: probes must not keep burning
    // CPU for a session that can no longer be written.
    const onDegraded = (reason) => {
      this.session.degrade(reason);
      this.stopSampler();
      // Persist the reason immediately. A degraded writer may be followed by an app
      // close, so waiting for a manual Stop would leave meta.json claiming that the
      // session is still recording and erase the only useful failure evidence.
      if (this.metaPath) {
        const writerStats = this.writer && typeof this.writer.getStats === 'function'
          ? this.writer.getStats()
          : { active: false, degraded: true, degradedReason: reason };
        void this.writeFinalMeta(writerStats, 'writer-degraded').catch(() => {});
      }
    };
    if (this.writerFactory) return this.writerFactory({
      filePath,
      fsModule: this.fs,
      now: this.now,
      onDegraded,
    });
    return new JsonlWriter({
      filePath,
      fsModule: this.fs,
      now: this.now,
      onDegraded,
    });
  }

  // Single main-side entry point: normalize one raw event against the live session
  // and queue it. Silently no-ops when nothing records, so probes/spans can fire
  // unconditionally.
  recordEvent(raw, { reserved = false } = {}) {
    if (!this.writer) return { accepted: 0, dropped: 0 };
    const event = this.session.record(raw, { nowMs: this.now() });
    if (!event) return { accepted: 0, dropped: 0 };
    return this.writer.enqueue(event, { reserved });
  }

  async recordLifecycle(name, attributes = {}) {
    return this.recordEvent({
      kind: 'lifecycle',
      category: 'diagnostics',
      name,
      timestampMs: this.now(),
      attributes,
    }, { reserved: true });
  }

  // Explicit app span: returns an idempotent end(extraAttributes) closure. The event
  // carries the span START timestamp plus durationMs; if recording stops before the
  // span ends, recordEvent drops it (a span that began before the session started
  // would clamp to offset 0 — acceptable for a dev tool).
  startSpan(category, name, attributes = {}) {
    const startedAtMs = this.now();
    let ended = false;
    return (extra = {}) => {
      if (ended) return;
      ended = true;
      this.recordEvent({
        kind: 'span',
        category,
        name,
        timestampMs: startedAtMs,
        durationMs: Math.max(0, this.now() - startedAtMs),
        attributes: { ...attributes, ...extra },
      });
    };
  }

  // Aggregated webContents.send counter (flushed by the sampler once per second).
  countChannel(channel) {
    if (this.sampler && typeof this.sampler.countChannel === 'function') {
      this.sampler.countChannel(channel);
    }
  }

  // Window lifecycle probes. Listeners stay attached for the window's lifetime
  // (dev diagnostics run only); recordEvent gates on the active recording.
  attachWindowEvents(win, label = 'window') {
    if (!win || typeof win.on !== 'function') return;
    const windowEvent = (name) => this.recordEvent({
      kind: 'lifecycle',
      category: 'window',
      name,
      timestampMs: this.now(),
      attributes: { label },
    });
    windowEvent('created');
    for (const name of [
      'ready-to-show', 'show', 'hide', 'minimize', 'restore', 'focus', 'blur',
      'enter-full-screen', 'leave-full-screen', 'unresponsive', 'responsive', 'closed',
    ]) {
      try { win.on(name, () => windowEvent(name)); } catch {}
    }
  }

  // Crashed helper/GPU/renderer processes are prime suspects for stalls — record
  // reason/exit code, never payloads.
  attachAppEvents(appObj) {
    if (!appObj || typeof appObj.on !== 'function') return;
    appObj.on('child-process-gone', (_event, details) => {
      const attributes = {
        role: (details && details.type) || 'unknown',
        reason: (details && details.reason) || 'unknown',
      };
      if (details && Number.isFinite(details.exitCode)) attributes.errorCode = details.exitCode;
      this.recordEvent({
        kind: 'lifecycle', category: 'process', name: 'child-process-gone',
        timestampMs: this.now(), attributes,
      }, { reserved: true });
    });
    appObj.on('render-process-gone', (_event, _webContents, details) => {
      const attributes = { reason: (details && details.reason) || 'unknown' };
      if (details && Number.isFinite(details.exitCode)) attributes.errorCode = details.exitCode;
      this.recordEvent({
        kind: 'lifecycle', category: 'process', name: 'render-process-gone',
        timestampMs: this.now(), attributes,
      }, { reserved: true });
    });
  }

  // Error probes. Only the error CLASS name is recorded — message text stays out of
  // the session until the stage-4 redaction pipeline exists.
  attachProcessEvents(proc = process) {
    if (!proc || typeof proc.on !== 'function') return;
    // uncaughtExceptionMonitor observes without changing Node's fatal behavior.
    proc.on('uncaughtExceptionMonitor', (err) => {
      this.recordEvent({
        kind: 'lifecycle', category: 'error', name: 'uncaught-exception',
        timestampMs: this.now(),
        attributes: { reason: err && err.name ? String(err.name) : 'Error' },
      }, { reserved: true });
    });
    // Subscribing suppresses Node's default warning print, so re-print to keep the
    // dev console honest (diagnostics-gated process only).
    proc.on('unhandledRejection', (reason) => {
      console.error('[Diagnostics] unhandledRejection:', reason);
      this.recordEvent({
        kind: 'lifecycle', category: 'error', name: 'unhandled-rejection',
        timestampMs: this.now(),
        attributes: { reason: reason && reason.name ? String(reason.name) : 'UnhandledRejection' },
      }, { reserved: true });
    });
  }

  record(events, { webContentsId } = {}) {
    if (!this.writer) return { ok: false, error: 'not_recording', status: this.status() };
    const list = Array.isArray(events) ? events : [events];
    const stamped = Number.isInteger(webContentsId)
      ? list.map((raw) => (raw && typeof raw === 'object'
        ? { ...raw, source: { ...(raw.source && typeof raw.source === 'object' ? raw.source : {}), webContentsId } }
        : raw))
      : list;
    const normalized = this.session.recordBatch(stamped, { generation: this.session.snapshot().generation, nowMs: this.now() });
    const result = normalized.length ? this.writer.enqueue(normalized) : { accepted: 0, dropped: 0 };
    return { ok: true, accepted: result.accepted, dropped: result.dropped, status: this.status() };
  }

  mark(label = 'lag') {
    if (!this.writer) return { ok: false, error: 'not_recording', status: this.status() };
    const event = this.session.mark(label, { generation: this.session.snapshot().generation, nowMs: this.now() });
    const result = event ? this.writer.enqueue(event, { reserved: true }) : { accepted: 0, dropped: 0 };
    return { ok: true, accepted: result.accepted, dropped: result.dropped, status: this.status() };
  }

  async stopRecording({ reason = 'manual', writeReport = true } = {}) {
    if (!this.writer) {
      this.stopSampler();
      this.session.complete();
      return { ok: true, status: this.status() };
    }
    try {
      // Stop probes first: the final counter flush still lands in the live writer.
      this.stopSampler();
      await this.recordLifecycle('session-stopping', { reason });
      this.session.stop({ nowMs: this.now() });
      const writerStats = await this.writer.stop();
      if (writerStats.degraded) this.session.degrade(writerStats.degradedReason);
      else this.session.complete();
      await this.writeFinalMeta(writerStats, reason);
      this.writer = null;
      // Build the readable report from the flushed events. Best-effort: a report failure
      // must not mark the recording itself as failed. Skipped on app-quit (writeReport
      // false) so shutdown never blocks on reading a large session file.
      if (writeReport) {
        try { await this.generateReport(); } catch (err) {
          this.lastError = err && err.message ? err.message : String(err);
        }
      }
      return { ok: true, status: this.status() };
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err);
      this.stopSampler();
      this.session.degrade(this.lastError);
      return { ok: false, error: this.lastError, status: this.status() };
    }
  }

  async shutdownBestEffort({ reason = 'shutdown' } = {}) {
    if (this.shuttingDown) return this.status();
    this.shuttingDown = true;
    try {
      if (this.writer && this.session.snapshot().state === 'recording') {
        await this.stopRecording({ reason, writeReport: false });
      } else {
        this.stopSampler();
        if (this.writer) await this.writer.shutdownBestEffort();
      }
    } catch {
      // Best-effort shutdown must never block Znada quit.
    }
    return this.status();
  }

  async openSessionFolder() {
    if (!this.sessionDir || !this.shell || typeof this.shell.openPath !== 'function') {
      return { ok: false, error: 'unavailable', status: this.status() };
    }
    const error = await this.shell.openPath(this.sessionDir);
    return { ok: !error, error: error || '', status: this.status() };
  }

  // --- Report artefacts ----------------------------------------------------
  async readSessionEvents() {
    if (!this.eventsPath) return [];
    let raw = '';
    try { raw = await this.fs.promises.readFile(this.eventsPath, 'utf8'); } catch { return []; }
    const events = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { events.push(JSON.parse(trimmed)); } catch { /* skip a torn line */ }
    }
    return events;
  }

  async readSessionMeta() {
    if (!this.metaPath) return {};
    try { return JSON.parse(await this.fs.promises.readFile(this.metaPath, 'utf8')); } catch { return {}; }
  }

  // summary.json + summary.html + trace.json in the session directory. Also writes an
  // (empty) private-map.json placeholder: the local-only alias→path map lives here, and
  // the sanitized export is defined as "everything except this file".
  async generateReport() {
    if (!this.sessionDir) return { ok: false, error: 'no_session' };
    const events = await this.readSessionEvents();
    const meta = await this.readSessionMeta();
    const summary = report.buildSummary(events, meta);
    const html = report.renderSummaryHtml(summary, events, meta);
    const trace = toChromeTrace(events, meta);
    const write = (name, data) => this.fs.promises.writeFile(path.join(this.sessionDir, name), data, 'utf8');
    await write('summary.json', `${JSON.stringify(summary, null, 2)}\n`);
    await write('summary.html', html);
    await write('trace.json', JSON.stringify(trace));
    await write('private-map.json', `${JSON.stringify({ note: 'local only; never included in sanitized export', aliases: {} }, null, 2)}\n`);
    this.summaryHtmlPath = path.join(this.sessionDir, 'summary.html');
    return { ok: true, summaryHtmlPath: this.summaryHtmlPath };
  }

  async openReport() {
    if (!this.shell || typeof this.shell.openPath !== 'function') return { ok: false, error: 'unavailable' };
    const target = this.summaryHtmlPath && this.fs.existsSync(this.summaryHtmlPath) ? this.summaryHtmlPath : this.sessionDir;
    if (!target) return { ok: false, error: 'no_report' };
    const error = await this.shell.openPath(target);
    return { ok: !error, error: error || '' };
  }

  // Sanitized export: redact every event/summary string (paths, users, tokens, queries,
  // data URIs, emails) and write a separate `sanitized/` folder. The private map is never
  // copied. Safe to hand to another machine.
  async exportSanitized() {
    if (!this.sessionDir) return { ok: false, error: 'no_session' };
    try {
      const events = (await this.readSessionEvents()).map(redactValue);
      const meta = redactValue(await this.readSessionMeta());
      const summary = report.buildSummary(events, meta);
      const outDir = path.join(this.sessionDir, 'sanitized');
      await this.fs.promises.mkdir(outDir, { recursive: true });
      const write = (name, data) => this.fs.promises.writeFile(path.join(outDir, name), data, 'utf8');
      await write('events.sanitized.jsonl', events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      await write('summary.sanitized.json', `${JSON.stringify(summary, null, 2)}\n`);
      await write('summary.sanitized.html', report.renderSummaryHtml(summary, events, meta));
      if (this.shell && typeof this.shell.openPath === 'function') await this.shell.openPath(outDir);
      return { ok: true, dir: outDir };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async clearSessions() {
    if (this.session.snapshot().state === 'recording') {
      return { ok: false, error: 'recording_active', status: this.status() };
    }
    try {
      const removed = await retention.clearSessions(this.sessionsRoot, { fsModule: this.fs });
      return { ok: true, removed: removed.removed, status: this.status() };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err), status: this.status() };
    }
  }

  async writeMeta(meta) {
    await this.fs.promises.mkdir(this.sessionDir, { recursive: true });
    await this.fs.promises.writeFile(this.metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  }

  async writeFinalMeta(writerStats, reason) {
    if (!this.metaPath) return;
    const snapshot = this.session.snapshot();
    const meta = {
      schemaVersion: 1,
      sessionId: snapshot.sessionId,
      state: snapshot.state,
      stopReason: reason,
      startedAtMs: snapshot.startedAtMs,
      stoppedAtMs: snapshot.stoppedAtMs,
      sessionDir: this.sessionDir,
      app: this.appInfo,
      protocolCounters: snapshot.protocolCounters,
      lateBatches: snapshot.lateBatches,
      writer: writerStats,
      degradedReason: snapshot.degradedReason,
    };
    await this.writeMeta(meta);
  }

  status() {
    const snapshot = this.session.snapshot();
    return {
      enabled: true,
      state: snapshot.state,
      sessionId: snapshot.sessionId,
      startedAtMs: snapshot.startedAtMs,
      stoppedAtMs: snapshot.stoppedAtMs,
      degradedReason: snapshot.degradedReason,
      generation: snapshot.generation,
      sequence: snapshot.sequence,
      sessionsRoot: this.sessionsRoot,
      sessionDir: this.sessionDir,
      eventsPath: this.eventsPath,
      metaPath: this.metaPath,
      summaryHtmlPath: this.summaryHtmlPath,
      lastError: this.lastError,
      protocolCounters: snapshot.protocolCounters,
      lateBatches: snapshot.lateBatches,
      writer: this.writer ? this.writer.getStats() : null,
      sampler: !!this.sampler,
    };
  }
}

function createDiagnosticsController(options) {
  return new DiagnosticsController(options);
}

module.exports = {
  DiagnosticsController,
  createDiagnosticsController,
  defaultSessionsRoot,
  retentionLimitFromEnv,
};
