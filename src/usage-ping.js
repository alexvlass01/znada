'use strict';

// TELEM-001 — the mandatory minimal usage signal: "this install was running in this
// quarter of the UTC day, with this version". The whole external contract is the Cloud
// document docs/usage-client-api.md (FEAT-001); this module is its client half.
//
// What goes out is fixed by that contract and nothing else: the existing anonymous
// install id (X-Lumina-Anon-Id, the same one catalog requests carry) and
// {"app_version":"x.y.z"}. Time and country are decided by the server. No wallpapers,
// paths, searches, account or hardware data ever reach this module.
//
// The settings switch `telemetry` is a DIFFERENT, optional and not yet built feature;
// this module neither reads nor changes it (owner decision 2026-10-25).
//
// Shape of the schedule, per window of six UTC hours:
//   - at most one primary attempt and one retry — so at most 8 requests a day;
//   - the primary fires 0–300 s after the window starts while the app keeps running, or
//     5–15 s after startup / wake / the network coming back if the window is still unused;
//   - a missed window is never replayed, and there is no queue of past events;
//   - the attempt is marked as used and SAVED before the request leaves. If that save
//     fails, nothing is sent: an attempt we cannot remember would repeat on every start.
//
// Everything with a side effect is injected (clock, randomness, timers, persistence,
// network), so test/usage-ping.test.js drives the real scheduler through days, sleeps and
// clock jumps without waiting and without a network.

const WINDOW_MS = 6 * 60 * 60 * 1000;
const WINDOW_JITTER_MS = 300 * 1000;
const TRIGGER_DELAY_MIN_MS = 5 * 1000;
const TRIGGER_DELAY_MAX_MS = 15 * 1000;
const RETRY_DELAY_MIN_MS = 60 * 1000;
const RETRY_DELAY_MAX_MS = 120 * 1000;
// While offline nothing is spent; the local "is there a network" check is repeated this
// often, and its turning true is the contract's "network appeared" trigger.
const OFFLINE_POLL_MS = 60 * 1000;

function windowIndex(ms) { return Math.floor(ms / WINDOW_MS); }
function windowStart(index) { return index * WINDOW_MS; }

// Which builds send at all. Only the ones people actually run: the installed app (it
// talks to production) and DEV on staging. A plain `npm start` from sources would count
// every developer launch as an install. Without an API base there is nowhere to send.
/** @param {{ isPackaged?: boolean, environment?: string, apiBase?: string|null }} [build] */
function isSender({ isPackaged, environment, apiBase } = {}) {
  return !!apiBase && (isPackaged === true || environment === 'staging');
}

function defaultState() {
  return { window: -1, primaryUsed: false, retryUsed: false, notBefore: 0 };
}

// Config load hands us whatever is on disk. Anything unexpected falls back to "nothing
// recorded", which at worst costs one extra attempt in the current window.
function normalizeState(raw) {
  const s = defaultState();
  if (!raw || typeof raw !== 'object') return s;
  if (Number.isSafeInteger(raw.window) && raw.window >= -1) s.window = raw.window;
  s.primaryUsed = raw.primaryUsed === true;
  s.retryUsed = raw.retryUsed === true;
  if (Number.isFinite(raw.notBefore) && raw.notBefore > 0) s.notBefore = raw.notBefore;
  return s;
}

// What a finished request means for this window. `result` comes from the cloud client's
// usagePing(): { status, code, retryAfterMs } on an answer, { network: true } when no
// answer arrived (connection failure or the 5 s deadline).
function classify(result) {
  if (!result || result.network) return 'retryable';
  const status = Number(result.status);
  if (status === 204) return 'done';
  // An intentional stop of collection is final for the window, unlike other 503s.
  if (status === 503 && result.code === 'collection_disabled') return 'final';
  if (status >= 500) return 'retryable';
  // 400/403/405/408/413/415/429 and anything else 4xx: never retried in the window.
  return 'final';
}

/**
 * @typedef {{ status?: number, code?: string|null, retryAfterMs?: number, network?: boolean }} PingResult
 * @typedef {{ window: number, primaryUsed: boolean, retryUsed: boolean, notBefore: number }} PingState
 * @param {{
 *   now?: () => number,
 *   random?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 *   isOnline?: () => boolean,
 *   getVersion: () => string,
 *   isValidVersion?: (version: string) => boolean,
 *   loadState: () => any,
 *   saveState: (state: PingState) => boolean,
 *   send: (version: string) => Promise<PingResult>,
 *   log?: (...args: any[]) => void,
 * }} deps
 */
function createUsagePing({
  now = () => Date.now(),
  random = Math.random,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  isOnline = () => true,
  getVersion,
  isValidVersion = () => true,
  loadState,
  saveState,
  send,
  log = () => {},
}) {
  if (typeof send !== 'function') throw new TypeError('createUsagePing: send is required');
  if (typeof loadState !== 'function' || typeof saveState !== 'function') {
    throw new TypeError('createUsagePing: loadState and saveState are required');
  }

  let state = normalizeState(loadState());
  let started = false;
  let inFlight = false;
  let recheckAfterFlight = false;
  // One timer per purpose; re-arming always clears the previous one, so repeated
  // triggers can never stack attempts.
  const timers = { primary: null, retry: null, boundary: null, offline: null };
  let primaryAt = 0;

  function between(min, max) { return min + Math.floor(random() * (max - min + 1)); }

  function disarm(name) {
    if (timers[name] !== null) clearTimer(timers[name]);
    timers[name] = null;
    if (name === 'primary') primaryAt = 0;
  }

  function arm(name, at, fn) {
    disarm(name);
    const handle = setTimer(() => { timers[name] = null; if (name === 'primary') primaryAt = 0; fn(); },
      Math.max(0, at - now()));
    if (handle && typeof handle.unref === 'function') handle.unref();
    timers[name] = handle;
    if (name === 'primary') primaryAt = at;
  }

  function persist() {
    let ok = false;
    try { ok = saveState({ ...state }) !== false; } catch (err) { log('save failed', err); }
    return ok;
  }

  // Bring `state` to the window the clock is in now. A later window starts fresh and
  // cancels a retry still waiting for the old one. An EARLIER window (the clock went
  // back) is not reopened: the saved, later window simply stays in force.
  function rollWindow() {
    const w = windowIndex(now());
    if (w > state.window) {
      disarm('retry');
      disarm('primary');
      state = { window: w, primaryUsed: false, retryUsed: false, notBefore: state.notBefore };
    }
    return w;
  }

  function armBoundary(w) {
    // The next window opens at its start plus up to five minutes, so not every install
    // in the world asks at the same second.
    const next = Math.max(w, state.window) + 1;
    arm('boundary', windowStart(next) + between(0, WINDOW_JITTER_MS), () => evaluate('window'));
  }

  function evaluate(trigger) {
    if (!started) return;
    if (inFlight) { recheckAfterFlight = true; return; }
    const w = rollWindow();
    armBoundary(w);
    // Clock behind the saved window: wait until it has caught up.
    if (w < state.window || state.primaryUsed) return;
    if (!isOnline()) {
      disarm('primary');
      arm('offline', now() + OFFLINE_POLL_MS, () => evaluate('online'));
      return;
    }
    disarm('offline');
    const t = now();
    let at = trigger === 'window'
      ? Math.max(t, windowStart(w) + between(0, WINDOW_JITTER_MS))
      : t + between(TRIGGER_DELAY_MIN_MS, TRIGGER_DELAY_MAX_MS);
    // An attempt already waiting keeps its place unless this one would come sooner.
    if (timers.primary !== null && primaryAt <= at) return;
    at = Math.max(at, state.notBefore);
    // Retry-After reaching past this window skips it; the boundary timer picks up later.
    if (at >= windowStart(w + 1)) { disarm('primary'); return; }
    arm('primary', at, () => attempt('primary', w));
  }

  async function attempt(kind, w) {
    if (!started) return;
    // One request at a time. A timer that fires meanwhile is not lost: once the running
    // request ends, the window is looked at again.
    if (inFlight) { recheckAfterFlight = true; return; }
    rollWindow();
    if (state.window !== w) { evaluate('window'); return; }
    if (now() < state.notBefore) { evaluate('window'); return; }
    if (kind === 'primary' ? state.primaryUsed : (state.retryUsed || !state.primaryUsed)) return;
    // The network may have gone between planning and firing (a laptop leaving Wi-Fi in
    // the 5-15 s or 0-300 s wait). Spend nothing then: wait for it to come back instead.
    if (!isOnline()) { evaluate('online'); return; }
    const version = getVersion();
    if (!isValidVersion(version)) { log('app version is not sendable', version); return; }
    if (kind === 'primary') state.primaryUsed = true; else state.retryUsed = true;
    // Marked before the request leaves; an unrecorded attempt is not made at all.
    if (!persist()) {
      if (kind === 'primary') state.primaryUsed = false; else state.retryUsed = false;
      return;
    }
    inFlight = true;
    let result;
    try { result = await send(version); } catch (err) { result = { network: true }; log('send threw', err); }
    inFlight = false;
    if (!started) return;
    handleResult(kind, w, result);
    if (recheckAfterFlight) { recheckAfterFlight = false; evaluate('recheck'); }
  }

  function handleResult(kind, w, result) {
    // Retry-After holds across the window boundary and across a restart.
    if (result && Number(result.retryAfterMs) > 0) {
      state.notBefore = Math.max(state.notBefore, now() + Number(result.retryAfterMs));
      persist();
    }
    const verdict = classify(result);
    log(`usage ping ${kind}: ${verdict}`, result && (result.status || (result.network ? 'network' : '')));
    if (verdict !== 'retryable' || kind !== 'primary' || state.retryUsed) return;
    if (windowIndex(now()) !== w || state.window !== w) return;
    const at = Math.max(now() + between(RETRY_DELAY_MIN_MS, RETRY_DELAY_MAX_MS), state.notBefore);
    if (at >= windowStart(w + 1)) return; // out of time in this window: the retry is cancelled
    arm('retry', at, () => attempt('retry', w));
  }

  return {
    // Startup is itself a trigger: the first attempt of an unused window waits 5–15 s.
    start() {
      if (started) return;
      started = true;
      evaluate('startup');
    },
    // Wake from sleep, or anything else that should look again. Never adds an attempt.
    trigger(reason) { evaluate(reason || 'trigger'); },
    stop() {
      started = false;
      for (const name of Object.keys(timers)) disarm(name);
    },
    // For tests and diagnostics only.
    _state: () => ({ ...state }),
    _timers: () => Object.keys(timers).filter((n) => timers[n] !== null),
  };
}

module.exports = {
  WINDOW_MS,
  windowIndex,
  isSender,
  normalizeState,
  defaultState,
  classify,
  createUsagePing,
};
