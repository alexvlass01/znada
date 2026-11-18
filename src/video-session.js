'use strict';

// One viewer owns one decoder. Dependencies make race/failure paths executable in Node tests.
function createVideoSession({ createWorker, importTexture, sendTexture, duplicateHandle, sendState, resolveEntry, openExternal,
  setTimer = setTimeout, clearTimer = clearTimeout, startupMs = 12000, shutdownMs = 2200 }) {
  let active = null, generation = 0, disposed = false;
  const sessions = new Set();
  const validGeneration = n => Number.isSafeInteger(n) && n > 0;
  function state(session, data) {
    if (!disposed && session === active && !session.stopping) sendState({ ...data, generation: session.generation });
  }
  function post(session, data) { try { session.worker.postMessage(data); } catch { /* exit/stop races are expected */ } }
  function stop(session) {
    if (!session || session.stopping) return;
    session.stopping = true; clearTimer(session.startTimer);
    session.abort.abort();
    if (!session.worker || session.exited) return; // superseded before a slot, or already gone
    post(session, { type: 'stop' });
    session.stopTimer = setTimer(() => { if (!session.exited) session.worker.kill(); }, shutdownMs);
    session.stopTimer?.unref?.();
  }
  function fail(session, code = 'playback_failed') {
    state(session, { type: 'error', code }); stop(session);
  }
  async function frame(session, message) {
    const releaseSource = () => post(session, { type: 'release', id: message.id });
    if (session !== active || session.stopping || disposed) { releaseSource(); return; }
    if (!Number.isSafeInteger(message.id) || message.id <= session.lastFrame
      || !Number.isSafeInteger(message.width) || !Number.isSafeInteger(message.height)
      || message.width <= 0 || message.height <= 0 || message.width > 4096 || message.height > 4096
      || !message.ntBytes || message.ntBytes.length !== 8 || session.transfers >= 2) {
      releaseSource(); fail(session); return;
    }
    session.lastFrame = message.id; session.transfers++;
    let owned, imported, released = false;
    const release = () => {
      if (released) return; released = true;
      owned?.close(); releaseSource(); session.transfers--;
    };
    try {
      owned = duplicateHandle(session.worker.pid, message.ntBytes);
      imported = importTexture({ textureInfo: { codedSize: { width: message.width, height: message.height },
        pixelFormat: 'bgra', handle: { ntHandle: owned.buffer }, timestamp: Math.round(Math.max(0, Number(message.time) || 0) * 1e6) },
      allReferencesReleased: release });
      if (session !== active || session.stopping || disposed) return;
      await sendTexture(imported, { generation: session.generation, width: message.width, height: message.height });
      if (!session.firstFrame) { session.firstFrame = true; clearTimer(session.startTimer); }
    } catch { fail(session, 'display_failed'); }
    finally {
      // An imported texture owns its release callback, even if sending fails. A failed import does not.
      if (imported) { try { imported.release(); } catch { /* native receiver may already be gone */ } }
      else release();
    }
  }
  function start(session) {
    if (!session || session !== active || session.stopping || disposed || sessions.size >= 2) return;
    try {
      session.worker = createWorker(session.entry, session.abort.signal);
      sessions.add(session);
      session.worker.on('message', message => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'frame') { void frame(session, message); }
        else if (message.type === 'state') state(session, { ...message });
        else if (message.type === 'error') fail(session);
      });
      session.worker.on('exit', () => {
        session.abort.abort();
        session.exited = true; clearTimer(session.startTimer); clearTimer(session.stopTimer); sessions.delete(session);
        if (!session.stopping) fail(session, 'decoder_stopped');
        if (active && !active.worker) start(active);
      });
    } catch { clearTimer(session.startTimer); state(session, { type: 'error', code: 'unavailable' }); session.stopping = true; }
  }
  function open(entry, nextGeneration) {
    generation = nextGeneration; stop(active);
    active = { generation, entry, abort: new AbortController(), stopping: false, exited: false, transfers: 0, lastFrame: 0, firstFrame: false };
    // Capture the owner: a superseded timer can never fail a later request.
    const opening = active;
    active.startTimer = setTimer(() => fail(opening, 'open_timeout'), entry.online ? 30000 : startupMs);
    active.startTimer?.unref?.();
    // At most two owned decoders including a stopping predecessor; retain only the latest open.
    start(active);
  }
  function request(message) {
    if (disposed || !message || typeof message !== 'object' || typeof message.action !== 'string' || !validGeneration(message.generation)) return { ok: false };
    const keys = { open: ['action', 'generation', 'index'], stop: ['action', 'generation'],
      pause: ['action', 'generation'], seek: ['action', 'generation', 'value'], volume: ['action', 'generation', 'value'], external: ['action', 'generation'], abort: ['action', 'generation'] };
    const allowed = Object.hasOwn(keys, message.action) ? keys[message.action] : null;
    if (!allowed || Object.keys(message).some(key => !allowed.includes(key))) return { ok: false };
    if (message.action === 'open') {
      if (message.generation <= generation || !Number.isSafeInteger(message.index)) return { ok: false };
      const entry = resolveEntry(message.index);
      if (!entry) return { ok: false };
      open(entry, message.generation); return { ok: true };
    }
    if (message.action === 'stop') {
      if (message.generation < generation) return { ok: false };
      generation = message.generation; stop(active); active = null; return { ok: true };
    }
    if (!active || active.generation !== message.generation) return { ok: false };
    if (message.action === 'external') return openExternal(active.entry);
    if (message.action === 'abort') { stop(active); return { ok: true }; }
    if (active.stopping || active.exited || !active.worker) return { ok: false };
    if (message.action === 'seek' && (!Number.isFinite(message.value) || message.value < 0 || message.value > 864000)) return { ok: false };
    if (message.action === 'volume' && (!Number.isFinite(message.value) || message.value < 0 || message.value > 100)) return { ok: false };
    post(active, { type: 'control', action: message.action, value: message.value }); return { ok: true };
  }
  return {
    request,
    stop() { stop(active); active = null; },
    reset() { stop(active); active = null; generation = 0; },
    dispose() { disposed = true; stop(active); active = null; for (const session of sessions) stop(session); },
  };
}
module.exports = { createVideoSession };
