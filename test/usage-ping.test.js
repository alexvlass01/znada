'use strict';

// TELEM-001 — the client half of the Cloud usage contract (docs/usage-client-api.md in
// Znada Cloud). The real scheduler runs on a fake clock and fake timers, so whole days,
// sleeps, clock jumps and server refusals are walked through instantly and nothing ever
// reaches a network. Each block names the contract line it holds.

const assert = require('assert');
const usage = require('../src/usage-ping');
const cloudClient = require('../src/cloud/client');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

const H = 60 * 60 * 1000;
const W = usage.WINDOW_MS;
// 2026-10-25 00:00:00 UTC — a window start, so offsets below read as "hours into the day".
const DAY0 = Date.UTC(2026, 9, 25);

function makeWorld({ start = DAY0 + 1 * H, online = true, state, saveOk = true, rand = 0.5 } = {}) {
  const world = {
    t: start,
    online,
    saveOk,
    saved: state ? { ...state } : undefined,
    saves: 0,
    sent: [],
    answers: [],
    timers: new Map(),
    nextId: 1,
    version: '1.7.7',
    // A request that is still running: resolve it by hand.
    hold: false,
    held: [],
  };
  world.ping = usage.createUsagePing({
    now: () => world.t,
    // A number for every call, or a list consumed in order (then 0.5).
    random: () => (Array.isArray(rand) ? (rand.length ? rand.shift() : 0.5) : rand),
    setTimer: (fn, ms) => { const id = world.nextId++; world.timers.set(id, { at: world.t + ms, fn }); return id; },
    clearTimer: (id) => { world.timers.delete(id); },
    isOnline: () => world.online,
    getVersion: () => world.version,
    isValidVersion: (v) => /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/.test(v),
    loadState: () => world.saved,
    saveState: (s) => { if (!world.saveOk) return false; world.saved = { ...s }; world.saves += 1; return true; },
    send: (version) => {
      world.sent.push({ at: world.t, version, savedBefore: { ...world.saved } });
      if (world.hold) return new Promise((resolve) => { world.held.push(resolve); });
      return Promise.resolve(world.answers.length ? world.answers.shift() : { status: 204 });
    },
  });
  return world;
}

const flush = () => new Promise((r) => { setImmediate(r); });

// Move the clock forward, firing every timer that falls due, in order.
async function advance(world, ms) {
  const end = world.t + ms;
  // A scheduler that re-arms itself for "now" forever is a bug of its own (it would spin
  // the main process); fail on it instead of hanging.
  for (let fired = 0; ; fired++) {
    if (fired > 20000) throw new Error('timer storm: the scheduler keeps re-arming itself');
    let next = null;
    for (const [id, tm] of world.timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm];
    if (!next) break;
    world.timers.delete(next[0]);
    world.t = Math.max(world.t, next[1].at);
    next[1].fn();
    await flush();
  }
  world.t = end;
  await flush();
}

(async () => {
  // --- the request itself ---------------------------------------------------------
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { status: 204, headers: { get: () => null }, text: async () => { throw new Error('204 must not be read'); } };
    };
    const client = cloudClient.createClient({ baseUrl: 'https://api.example', fetchImpl, anonId: 'install_abc123' });
    const res = await client.usagePing('1.7.7');
    ok('a 204 comes back as status 204 without reading a body', res.status === 204 && !res.network);
    const c = calls[0];
    ok('it is a POST to /v1/usage/ping', c.init.method === 'POST' && c.url === 'https://api.example/v1/usage/ping');
    ok('the body is exactly {"app_version": ...}', c.init.body === '{"app_version":"1.7.7"}');
    ok('the body stays inside the 256-byte limit', Buffer.byteLength(c.init.body) <= 256);
    ok('it carries the one existing install id and JSON type, and no token',
      c.init.headers['X-Lumina-Anon-Id'] === 'install_abc123'
      && c.init.headers['Content-Type'] === 'application/json'
      && !('Authorization' in c.init.headers));
    const keys = Object.keys(c.init.headers).sort().join(',');
    ok('no other header leaves (no Origin, nothing personal)', keys === 'Content-Type,X-Lumina-Anon-Id');
  }
  {
    const client = cloudClient.createClient({
      baseUrl: 'https://api.example', anonId: 'install_abc123',
      fetchImpl: async () => ({
        status: 429,
        headers: { get: (h) => (h === 'retry-after' ? '120' : null) },
        text: async () => '{"error":{"code":"usage_budget_exhausted","message":"x"}}',
      }),
    });
    const res = await client.usagePing('1.7.7');
    ok('an error answer gives its machine code and Retry-After in ms',
      res.status === 429 && res.code === 'usage_budget_exhausted' && res.retryAfterMs === 120000);
  }
  {
    let signalSeen = null;
    const client = cloudClient.createClient({
      baseUrl: 'https://api.example', anonId: 'install_abc123',
      makeTimeoutSignal: (ms) => { signalSeen = ms; return undefined; },
      fetchImpl: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; },
    });
    const res = await client.usagePing('1.7.7');
    ok('the deadline is the contract 5 s', signalSeen === 5000);
    ok('a timeout is a network failure, not an answer', res.network === true && res.code === 'timeout');
  }
  {
    const client = cloudClient.createClient({ baseUrl: 'https://api.example', anonId: '', fetchImpl: async () => { throw new Error('must not send'); } });
    const res = await client.usagePing('1.7.7');
    ok('without a valid install id nothing is sent', res.status === 0 && res.code === 'missing_anon_id');
  }
  for (const [status, code] of [[429, 'rate_limited'], [400, 'invalid_request'], [503, 'collection_disabled']]) {
    // Headers arrived, then the 5 s deadline hit while the body was still coming.
    const client = cloudClient.createClient({
      baseUrl: 'https://api.example', anonId: 'install_abc123',
      fetchImpl: async () => ({
        status,
        headers: { get: (h) => (h === 'retry-after' ? '600' : null) },
        text: async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; },
      }),
    });
    const res = await client.usagePing('1.7.7');
    ok(`a ${status} whose body timed out keeps its status and Retry-After`,
      res.status === status && !res.network && res.retryAfterMs === 600000);
    ok(`... so ${status} is ${status >= 500 && code !== 'collection_disabled' ? 'retryable' : 'not retried'}`,
      usage.classify(res) === (status === 503 ? 'retryable' : 'final'));
  }
  ok('Retry-After junk, dates and absence grant nothing',
    cloudClient.parseRetryAfter({ get: () => 'Wed, 21 Oct 2026 07:28:00 GMT' }) === 0
    && cloudClient.parseRetryAfter({ get: () => null }) === 0
    && cloudClient.parseRetryAfter(undefined) === 0
    && cloudClient.parseRetryAfter({ get: () => ' 30 ' }) === 30000);

  // --- which builds send ---------------------------------------------------------
  ok('the installed app sends to production', usage.isSender({ isPackaged: true, environment: 'production', apiBase: 'https://p' }));
  ok('DEV on staging sends', usage.isSender({ isPackaged: false, environment: 'staging', apiBase: 'https://s' }));
  ok('a plain npm start (unpackaged, production) never sends',
    !usage.isSender({ isPackaged: false, environment: 'production', apiBase: 'https://p' }));
  ok('nothing sends without an API base', !usage.isSender({ isPackaged: true, environment: 'unavailable', apiBase: null }));
  ok('nothing sends when nothing is known', !usage.isSender());

  // --- what each answer means -----------------------------------------------------
  ok('204 finishes the window', usage.classify({ status: 204 }) === 'done');
  ok('collection_disabled is final, not retried', usage.classify({ status: 503, code: 'collection_disabled' }) === 'final');
  ok('other 503 and 5xx are retryable', usage.classify({ status: 503, code: 'usage_unavailable' }) === 'retryable'
    && usage.classify({ status: 500 }) === 'retryable');
  ok('network and timeout are retryable', usage.classify({ network: true }) === 'retryable');
  ok('408, 429, 400, 403, 405, 413, 415 are all final',
    [408, 429, 400, 403, 405, 413, 415, 401, 404].every((s) => usage.classify({ status: s }) === 'final'));

  // --- startup ------------------------------------------------------------------
  {
    const w = makeWorld();
    w.ping.start();
    await advance(w, 4999);
    ok('nothing goes out in the first 5 s after start', w.sent.length === 0);
    await advance(w, 11 * 1000);
    ok('the first attempt goes out 5-15 s after start', w.sent.length === 1);
    ok('the attempt was marked as used and saved BEFORE it left',
      w.sent[0].savedBefore.primaryUsed === true && w.sent[0].savedBefore.window === usage.windowIndex(w.sent[0].at));
    ok('the current version is sent', w.sent[0].version === '1.7.7');
    await advance(w, 4 * H);
    ok('a 204 ends the window: nothing more in it', w.sent.length === 1);
  }

  // --- continuous running in the tray -------------------------------------------
  {
    const w = makeWorld();
    w.ping.start();
    await advance(w, 3 * 24 * H);
    ok('running three days in the tray from 01:00: one per window, 13 windows', w.sent.length === 13);
    const windows = new Set(w.sent.map((s) => usage.windowIndex(s.at)));
    ok('one per distinct window, never two in one', windows.size === 13);
    const offsets = w.sent.slice(1).map((s) => s.at - Math.floor(s.at / W) * W);
    ok('each later window fires within 0-300 s of its start', offsets.every((o) => o >= 0 && o <= 300 * 1000));
  }

  // --- repeated triggers ----------------------------------------------------------
  {
    const w = makeWorld();
    w.ping.start();
    w.ping.trigger('resume'); w.ping.trigger('resume'); w.ping.trigger('online');
    await advance(w, 60 * 1000);
    ok('several triggers at once still make one attempt', w.sent.length === 1);
    w.ping.trigger('resume');
    await advance(w, 60 * 1000);
    ok('a wake after a used window adds nothing', w.sent.length === 1);
  }

  {
    // Wake/network events every few seconds must not keep pushing the attempt back.
    const w = makeWorld();
    w.ping.start();
    for (let i = 0; i < 15; i++) { w.ping.trigger('resume'); await advance(w, 4000); }
    ok('a stream of triggers does not postpone the waiting attempt', w.sent.length === 1 && w.sent[0].at <= DAY0 + 1 * H + 15 * 1000);
  }

  // --- restart in the same window -----------------------------------------------
  {
    const a = makeWorld();
    a.ping.start();
    await advance(a, 20 * 1000);
    a.ping.stop();
    const b = makeWorld({ start: a.t + 60 * 1000, state: a.saved });
    b.ping.start();
    await advance(b, 60 * 1000);
    ok('a restart in the same window sends nothing again', b.sent.length === 0);
    await advance(b, 6 * H);
    ok('the next window still gets its attempt after a restart', b.sent.length === 1);
  }

  // --- version update -----------------------------------------------------------
  {
    const a = makeWorld();
    a.ping.start();
    await advance(a, 20 * 1000);
    a.ping.stop();
    const b = makeWorld({ start: a.t + 120 * 1000, state: a.saved });
    b.version = '1.7.8';
    b.ping.start();
    await advance(b, 60 * 1000);
    ok('an update does not open a new attempt in a used window', b.sent.length === 0);
    await advance(b, 6 * H);
    ok('the next window reports the NEW version', b.sent.length === 1 && b.sent[0].version === '1.7.8');
  }

  // --- the one retry ------------------------------------------------------------
  {
    const w = makeWorld();
    w.answers.push({ network: true }, { network: true });
    w.ping.start();
    await advance(w, 20 * 1000);
    ok('the first attempt failed on the network', w.sent.length === 1);
    await advance(w, 59 * 1000);
    ok('no retry before 60 s', w.sent.length === 1);
    await advance(w, 62 * 1000);
    ok('one retry 60-120 s later', w.sent.length === 2);
    ok('the retry was saved as used before it left', w.sent[1].savedBefore.retryUsed === true);
    await advance(w, 4 * H);
    ok('a second failure is not retried again in the window', w.sent.length === 2);
  }
  {
    const w = makeWorld();
    w.answers.push({ status: 503, code: 'usage_unavailable' });
    w.ping.start();
    await advance(w, 5 * 60 * 1000);
    ok('a plain 503 gets its one retry', w.sent.length === 2);
  }
  for (const [label, answer] of [
    ['collection_disabled', { status: 503, code: 'collection_disabled' }],
    ['429 rate_limited', { status: 429, code: 'rate_limited' }],
    ['408 request_timeout', { status: 408, code: 'request_timeout' }],
    ['400 invalid_request', { status: 400, code: 'invalid_request' }],
  ]) {
    const w = makeWorld();
    w.answers.push(answer);
    w.ping.start();
    await advance(w, 4 * H);
    ok(`${label} is not retried in the window`, w.sent.length === 1);
  }
  {
    // A retry that would land past the window end is cancelled.
    const w = makeWorld({ start: DAY0 + 6 * H - 30 * 1000 });
    w.answers.push({ network: true });
    w.ping.start();
    await advance(w, 29 * 1000);
    ok('an attempt right before the window ends goes out', w.sent.length === 1);
    await advance(w, 200 * 1000);
    const inFirst = w.sent.filter((s) => usage.windowIndex(s.at) === usage.windowIndex(DAY0));
    ok('its retry, out of time, is cancelled rather than spilling into the next window', inFirst.length === 1);
  }

  // --- Retry-After --------------------------------------------------------------
  {
    const w = makeWorld({ start: DAY0 + 5 * H });
    w.answers.push({ status: 429, code: 'usage_budget_exhausted', retryAfterMs: 8 * H });
    w.ping.start();
    await advance(w, 20 * 1000);
    ok('the refused attempt went out', w.sent.length === 1);
    await advance(w, 7 * H);
    ok('Retry-After holds across the window boundary', w.sent.length === 1);
    await advance(w, 6 * H);
    ok('after it expires, the next allowed window sends again', w.sent.length === 2
      && w.sent[1].at >= DAY0 + 5 * H + 8 * H);
  }
  {
    // Retry-After also outlives a restart.
    const a = makeWorld();
    a.answers.push({ status: 429, code: 'rate_limited', retryAfterMs: 10 * H });
    a.ping.start();
    await advance(a, 20 * 1000);
    a.ping.stop();
    const b = makeWorld({ start: a.t + 6 * H, state: a.saved });
    b.ping.start();
    await advance(b, 60 * 1000);
    ok('a restart does not shorten Retry-After', b.sent.length === 0);
  }
  {
    const w = makeWorld();
    w.answers.push({ network: true, retryAfterMs: 0 }, { status: 204 });
    w.answers[0] = { status: 500, retryAfterMs: 200 * 1000 };
    w.ping.start();
    await advance(w, 20 * 1000 + 150 * 1000);
    ok('a retry waits for Retry-After even past its own 60-120 s', w.sent.length === 1);
    await advance(w, 60 * 1000);
    ok('then retries once', w.sent.length === 2);
  }

  // --- offline, sleep, network back ----------------------------------------------
  {
    const w = makeWorld({ online: false });
    w.ping.start();
    await advance(w, 30 * 60 * 1000);
    ok('offline: nothing is sent and nothing is spent', w.sent.length === 0 && !(w.saved && w.saved.primaryUsed));
    w.online = true;
    await advance(w, 60 * 1000 + 15 * 1000);
    ok('the network coming back sends the unused window', w.sent.length === 1);
  }
  {
    // The network goes in the 5-15 s between planning and firing.
    const w = makeWorld();
    w.ping.start();
    await advance(w, 3000);
    w.online = false;
    await advance(w, 20 * 60 * 1000);
    ok('a network lost before the timer fires spends nothing', w.sent.length === 0 && !(w.saved && w.saved.primaryUsed));
    w.online = true;
    await advance(w, 2 * 60 * 1000);
    ok('and the window is sent once the network is back', w.sent.length === 1);
  }
  {
    // Woken half a minute into a window whose attempt is planned minutes later.
    const w = makeWorld({ start: DAY0 + 6 * H - 60 * 1000, rand: [0, 0.95, 0, 0.95] });
    w.ping.start();
    await advance(w, 60 * 1000);
    ok('the old window was used', w.sent.length === 1);
    await advance(w, 30 * 1000);
    w.ping.trigger('resume');
    await advance(w, 16 * 1000);
    ok('a wake brings a later planned attempt forward to 5-15 s', w.sent.length === 2 && w.sent[1].at <= DAY0 + 6 * H + 30 * 1000 + 15 * 1000);
  }
  {
    const w = makeWorld();
    w.ping.start();
    await advance(w, 20 * 1000);
    // Sleep across two windows: timers do not run, the clock does.
    const parked = new Map(w.timers); w.timers.clear();
    w.t += 13 * H;
    w.ping.trigger('resume');
    for (const [id, tm] of parked) if (!w.timers.has(id)) w.timers.set(id, tm);
    await advance(w, 60 * 1000);
    ok('waking up after sleep sends for the current window only, no catching up', w.sent.length === 2);
  }

  // --- clocks -----------------------------------------------------------------------
  {
    const a = makeWorld({ start: DAY0 + 13 * H });
    a.ping.start();
    await advance(a, 20 * 1000);
    a.ping.stop();
    const b = makeWorld({ start: DAY0 + 7 * H, state: a.saved });
    b.ping.start();
    await advance(b, 4 * H);
    ok('a clock set back does not reopen an earlier window', b.sent.length === 0);
  }
  {
    const w = makeWorld();
    w.ping.start();
    await advance(w, 20 * 1000);
    w.t += 30 * H; // jump forward
    w.ping.trigger('resume');
    await advance(w, 60 * 1000);
    ok('a clock jump forward replays none of the skipped windows', w.sent.length === 2);
  }

  // --- one request at a time ------------------------------------------------------
  {
    const w = makeWorld({ start: DAY0 + 6 * H - 20 * 1000 });
    w.hold = true;
    w.ping.start();
    await advance(w, 16 * 1000);
    ok('a request is running', w.sent.length === 1 && w.held.length === 1);
    await advance(w, 10 * 60 * 1000);
    ok('the next window waits while the old request runs', w.sent.length === 1);
    w.hold = false;
    w.held.shift()({ status: 204 });
    await flush(); await flush();
    await advance(w, 30 * 1000);
    ok('after it finishes, the new window is looked at again and sends once', w.sent.length === 2);
  }

  // --- saving the mark first --------------------------------------------------------
  {
    const w = makeWorld({ saveOk: false });
    w.ping.start();
    await advance(w, 24 * H);
    ok('if the mark cannot be saved, nothing is sent at all', w.sent.length === 0);
  }

  // --- the daily ceiling ------------------------------------------------------------
  {
    const w = makeWorld({ start: DAY0 });
    for (let i = 0; i < 40; i++) w.answers.push({ network: true });
    w.ping.start();
    for (let i = 0; i < 24 * 6; i++) { w.ping.trigger(i % 2 ? 'resume' : 'online'); await advance(w, 10 * 60 * 1000); }
    const day = w.sent.filter((s) => s.at < DAY0 + 24 * H);
    ok('even failing constantly and triggered every 10 min: at most 4 + 4 a day', day.length <= 8 && day.length >= 4);
  }

  // --- stop -------------------------------------------------------------------------
  {
    const w = makeWorld();
    w.ping.start();
    w.ping.stop();
    await advance(w, 12 * H);
    ok('stop clears every timer and sends nothing', w.sent.length === 0 && w.ping._timers().length === 0);
  }

  // --- stored state -----------------------------------------------------------------
  ok('junk on disk becomes "nothing recorded"',
    JSON.stringify(usage.normalizeState({ window: 'x', primaryUsed: 'yes', notBefore: -5 })) === JSON.stringify(usage.defaultState()));
  ok('a valid record survives normalization',
    usage.normalizeState({ window: 5, primaryUsed: true, retryUsed: false, notBefore: 9 }).window === 5);
  const cfg = require('../src/config');
  ok('a fresh config carries the empty record', cfg.normalize({}).usagePing.window === -1);

  console.log(`usage-ping: ${passed} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
