'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createDiagnosticsController } = require('../diagnostics/main/controller');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  OK ' + name);
  passed++;
};

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'znada-diagnostics-controller-'));
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(name, fn) {
      handlers.set(name, fn);
    },
  };
}

(async () => {
  const root = tmpRoot();
  const ipcMain = fakeIpcMain();
  let nowMs = Date.parse('2026-07-09T12:00:00.000Z');
  const controller = createDiagnosticsController({
    userDataPath: root,
    ipcMain,
    appInfo: { name: 'Lumina', version: 'test', isPackaged: false },
    source: { role: 'main', pid: 42 },
    now: () => nowMs,
    env: { ZNADA_DIAGNOSTICS_RETENTION: '2' },
  });

  controller.registerIpc();
  ok('registerIpc exposes diagnostics channels', ipcMain.handlers.has('diagnostics-start') && ipcMain.handlers.has('diagnostics-mark'));
  ok('registerIpc exposes the renderer batch + clock channels',
    ipcMain.handlers.has('diagnostics-record') && ipcMain.handlers.has('diagnostics-clock'));

  const started = await controller.startIfNeeded('startup');
  ok('startIfNeeded creates a recording session', started.ok && controller.status().state === 'recording');
  ok('start creates session files', fs.existsSync(controller.status().eventsPath) && fs.existsSync(controller.status().metaPath));

  nowMs += 100;
  const recorded = controller.record({ kind: 'span', category: 'library', name: 'render', timestampMs: nowMs });
  ok('record normalizes and queues main events', recorded.ok && recorded.accepted === 1);

  nowMs += 100;
  const marked = controller.mark('lag');
  ok('mark queues a reserved manual event', marked.ok && marked.accepted === 1);

  nowMs += 100;
  const stopped = await controller.stopRecording({ reason: 'test' });
  ok('stop flushes and completes session', stopped.ok && stopped.status.state === 'complete');

  const events = fs.readFileSync(controller.status().eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  ok('events include lifecycle, recorded event and manual mark',
    events.some((event) => event.name === 'session-started') &&
    events.some((event) => event.category === 'library') &&
    events.some((event) => event.kind === 'mark'));

  const meta = JSON.parse(fs.readFileSync(controller.status().metaPath, 'utf8'));
  ok('final meta includes writer stats and app info', meta.writer.enqueued >= 3 && meta.app.name === 'Lumina');

  // Stop generated the readable report artefacts next to the raw session.
  const reportDir = path.dirname(controller.status().eventsPath);
  ok('stop writes summary.json/html and trace.json',
    fs.existsSync(path.join(reportDir, 'summary.html')) &&
    fs.existsSync(path.join(reportDir, 'summary.json')) &&
    fs.existsSync(path.join(reportDir, 'trace.json')));
  const summaryHtml = fs.readFileSync(path.join(reportDir, 'summary.html'), 'utf8');
  ok('summary.html is a self-contained page', summaryHtml.startsWith('<!doctype html>') && !/<script/i.test(summaryHtml));
  const exported = await controller.exportSanitized();
  ok('sanitized export writes a separate folder without the private map',
    exported.ok && fs.existsSync(path.join(reportDir, 'sanitized', 'summary.sanitized.html')) &&
    !fs.existsSync(path.join(reportDir, 'sanitized', 'private-map.json')));

  const opened = await createDiagnosticsController({
    userDataPath: tmpRoot(),
    shell: { openPath: async () => '' },
    autoStart: false,
  }).openSessionFolder();
  ok('openSessionFolder returns unavailable without a session', !opened.ok && opened.error === 'unavailable');

  const retentionRoot = path.join(tmpRoot(), 'diagnostics', 'sessions');
  const retentionController = createDiagnosticsController({
    sessionsRoot: retentionRoot,
    autoStart: false,
    now: () => Date.parse('2026-07-09T13:00:00.000Z'),
    env: { ZNADA_DIAGNOSTICS_RETENTION: '1' },
  });
  await retentionController.startRecording({ reason: 'first' });
  await retentionController.stopRecording({ reason: 'first' });
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  await retentionController.startRecording({ reason: 'second' });
  await retentionController.stopRecording({ reason: 'second' });
  const sessionDirs = fs.readdirSync(retentionRoot).filter((name) => name.startsWith('session-'));
  ok('controller applies retention before new sessions', sessionDirs.length === 1);

  const blockedRetentionFs = {
    ...fs,
    promises: {
      ...fs.promises,
      async readdir() {
        const err = new Error('resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      },
    },
  };
  const blockedRetentionController = createDiagnosticsController({
    userDataPath: tmpRoot(),
    fsModule: blockedRetentionFs,
    autoStart: false,
  });
  const blockedRetentionStart = await blockedRetentionController.startRecording({ reason: 'locked-retention' });
  ok('retention enumeration failure does not block a fresh recording',
    blockedRetentionStart.ok && blockedRetentionController.status().state === 'recording'
    && blockedRetentionController.status().writer.active);
  await blockedRetentionController.stopRecording({ reason: 'locked-retention-test' });

  let forceWriterDegraded = null;
  const degradedWriterStats = {
    active: false, degraded: true, degradedReason: 'write_error', enqueued: 0,
    dropped: 0, droppedByCategory: {}, flushes: 0, flushErrors: 1,
    bytesWritten: 0, lastFlushDurationMs: 0, maxQueueDepth: 0,
    pendingBytes: 0, pendingLines: 0,
  };
  const degradedMetaController = createDiagnosticsController({
    userDataPath: tmpRoot(),
    autoStart: false,
    writerFactory: ({ onDegraded }) => {
      forceWriterDegraded = onDegraded;
      return {
        start: async () => {},
        enqueue: () => ({ accepted: 1, dropped: 0 }),
        flush: async () => {},
        stop: async () => degradedWriterStats,
        shutdownBestEffort: async () => degradedWriterStats,
        getStats: () => degradedWriterStats,
      };
    },
  });
  await degradedMetaController.startRecording({ reason: 'degraded-meta-test' });
  forceWriterDegraded('write_error');
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  const degradedMeta = JSON.parse(fs.readFileSync(degradedMetaController.status().metaPath, 'utf8'));
  ok('writer degradation is persisted immediately without waiting for manual Stop',
    degradedMeta.state === 'degraded' && degradedMeta.degradedReason === 'write_error'
    && degradedMeta.stopReason === 'writer-degraded');

  // --- Stage "main metrics/probes": sampler lifecycle, spans, window/app/error events ---
  let probeNow = Date.parse('2026-07-09T14:00:00.000Z');
  const fakeSampler = {
    started: 0,
    stopped: 0,
    counted: [],
    record: null,
    start() { this.started += 1; },
    stop() { this.stopped += 1; },
    countChannel(channel) { this.counted.push(channel); },
  };
  const probeController = createDiagnosticsController({
    userDataPath: tmpRoot(),
    autoStart: false,
    now: () => probeNow,
    samplerFactory: ({ record }) => { fakeSampler.record = record; return fakeSampler; },
  });

  const idleRecord = probeController.recordEvent({ kind: 'span', category: 'library', name: 'idle' });
  ok('recordEvent before start is a silent no-op', idleRecord.accepted === 0 && idleRecord.dropped === 0);
  probeController.startSpan('library', 'early')(); // must not throw while idle
  probeController.countChannel('config-changed'); // sampler absent: silent

  await probeController.startRecording({ reason: 'probe-test' });
  ok('sampler starts with the recording', fakeSampler.started === 1 && probeController.status().sampler === true);

  fakeSampler.record({ kind: 'sample', category: 'main', name: 'event-loop', attributes: { maxMs: 12 } });
  probeController.countChannel('config-changed');
  ok('countChannel delegates to the active sampler', fakeSampler.counted.length === 1 && fakeSampler.counted[0] === 'config-changed');

  // Renderer batch: role comes from the event, webContentsId is stamped by the controller.
  probeController.record([{ kind: 'sample', category: 'renderer', name: 'frame-window', source: { role: 'renderer-main' }, attributes: { count: 5 } }], { webContentsId: 7 });

  const endSpan = probeController.startSpan('library', 'folder-entries', { count: 3 });
  probeNow += 250;
  endSpan({ status: 'ok' });
  endSpan({ status: 'twice' }); // second end must be ignored

  const fakeWin = new EventEmitter();
  probeController.attachWindowEvents(fakeWin, 'viewer');
  fakeWin.emit('show');

  const fakeApp = new EventEmitter();
  probeController.attachAppEvents(fakeApp);
  fakeApp.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 5 });

  const fakeProc = new EventEmitter();
  probeController.attachProcessEvents(fakeProc);
  fakeProc.emit('uncaughtExceptionMonitor', new TypeError('secret message'));
  fakeProc.emit('unhandledRejection', 'expected-diagnostics-test-print');

  probeNow += 50;
  await probeController.stopRecording({ reason: 'probe-test' });
  ok('sampler stops with the recording', fakeSampler.stopped === 1 && probeController.status().sampler === false);

  const probeEvents = fs.readFileSync(probeController.status().eventsPath, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  const spanEvents = probeEvents.filter((event) => event.kind === 'span' && event.name === 'folder-entries');
  ok('startSpan records duration and merged attributes', spanEvents.length === 1 &&
    spanEvents[0].durationMs === 250 &&
    spanEvents[0].attributes.count === 3 &&
    spanEvents[0].attributes.status === 'ok');
  ok('sampler events flow through recordEvent', probeEvents.some((event) =>
    event.name === 'event-loop' && event.attributes.maxMs === 12));
  const rendererBatch = probeEvents.find((event) => event.category === 'renderer' && event.name === 'frame-window');
  ok('renderer batch keeps its role and gets a stamped webContentsId', rendererBatch &&
    rendererBatch.source.role === 'renderer-main' && rendererBatch.source.webContentsId === 7);
  const windowEvents = probeEvents.filter((event) => event.category === 'window');
  ok('window probes record created and show with a label',
    windowEvents.some((event) => event.name === 'created' && event.attributes.label === 'viewer') &&
    windowEvents.some((event) => event.name === 'show'));
  const gone = probeEvents.find((event) => event.name === 'child-process-gone');
  ok('child-process-gone records role, reason and exit code', gone &&
    gone.attributes.role === 'GPU' && gone.attributes.reason === 'crashed' && gone.attributes.errorCode === 5);
  const uncaught = probeEvents.find((event) => event.name === 'uncaught-exception');
  ok('uncaught exception records only the error class', uncaught &&
    uncaught.attributes.reason === 'TypeError' && !JSON.stringify(probeEvents).includes('secret message'));
  ok('unhandled rejection is recorded without payload', probeEvents.some((event) =>
    event.name === 'unhandled-rejection' && event.attributes.reason === 'UnhandledRejection'));

  fakeWin.emit('hide');
  const idleSpanEnd = probeController.startSpan('library', 'after-stop');
  idleSpanEnd();
  ok('probes after stop stay silent', probeController.status().state === 'complete');

  console.log('\nAll ' + passed + ' diagnostics controller tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
