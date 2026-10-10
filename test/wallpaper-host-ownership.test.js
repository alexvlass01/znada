'use strict';

// WIN-002. The persistent PowerShell host that sets wallpapers used to answer strictly in
// order: the first answer to arrive went to the oldest waiting command, whoever it came
// from. So a stuck command that timed out could hand its late answer to the NEXT command,
// an old process that reported its exit after a new one had started threw away the new
// one's commands, and dispose left pending calls and timers behind.
//
// Every case below drives the real module with a fake process and a fake clock. The fake
// is installed both as an option and in place of child_process.spawn, and the clock both
// as options and as the global timers, so the same file also runs against the pre-fix
// module - which is how its regression cases were shown to fail before the fix.
//   node test/wallpaper-host-ownership.test.js

const assert = require('assert');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

let spawnHook = null;
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => spawnHook(...args);
const hostModule = require('../src/wallpaper-host');
childProcess.spawn = originalSpawn;
const { WallpaperHost } = hostModule;
const READY_LINE = hostModule.READY_LINE || '@@READY@@';

const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;

function turn() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function createClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const setTimer = (fn, ms) => {
    const handle = { seq: ++seq };
    timers.set(handle, { at: now + Math.max(0, Number(ms) || 0), fn, seq: handle.seq });
    return handle;
  };
  const clearTimer = (handle) => { timers.delete(handle); };
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const [handle, timer] of timers) {
        if (timer.at > target) continue;
        if (!next || timer.at < next.timer.at || (timer.at === next.timer.at && timer.seq < next.timer.seq)) {
          next = { handle, timer };
        }
      }
      if (!next) break;
      timers.delete(next.handle);
      now = next.timer.at;
      next.timer.fn();
      await turn();
    }
    now = target;
    await turn();
  }
  return { setTimer, clearTimer, advance, live: () => timers.size };
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.lines = [];
    this.killed = false;
    this.exitOnKill = true;
    this.brokenInput = false;
    this.stdin = new EventEmitter();
    this.stdin.write = (data, encoding, callback) => {
      if (this.brokenInput) throw new Error('EPIPE');
      this.lines.push(String(data));
      if (typeof callback === 'function') callback(null);
      return true;
    };
    this.stdin.end = () => { this.stdinEnded = true; };
  }

  requests() {
    return this.lines.map((line) => JSON.parse(line));
  }

  ready() {
    this.stdout.write(READY_LINE + '\n');
  }

  // Answers the index-th command this process received, echoing its id the way the
  // host script does.
  answer(index, payload) {
    const request = this.requests()[index];
    const body = { ...payload };
    if (request && request.id !== undefined) body.id = request.id;
    this.stdout.write('@@R@@' + JSON.stringify(body) + '\n');
  }

  raw(text) {
    this.stdout.write(text);
  }

  kill() {
    this.killed = true;
    if (this.exitOnKill) queueMicrotask(() => this.emit('exit', 1, null));
    return true;
  }
}

function makeHost(clock, options = {}) {
  const children = [];
  spawnHook = (file, args, spawnOptions) => {
    const child = new FakeChild(4000 + children.length);
    child.file = file;
    child.args = args;
    child.spawnOptions = spawnOptions;
    children.push(child);
    return child;
  };
  global.setTimeout = clock.setTimer;
  global.clearTimeout = clock.clearTimer;
  const host = new WallpaperHost('C:\\profile\\wallpaper-host.ps1', {
    spawnImpl: (...args) => spawnHook(...args),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    startupTimeoutMs: 5000,
    ...options,
  });
  return { host, children };
}

function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.error = error; }
  );
  return state;
}

// Old and new field names, so the leak checks read the same thing before and after.
const pendingCount = (host) => (host.pending instanceof Map ? host.pending.size : host.queue.length);
const waiterCount = (host) => host.readyWaiters.length;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}

(async () => {
  await check('one process serves every command and each answer keeps its shape', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const first = track(host.enumMonitors(1000));
    await turn();
    assert.strictEqual(children.length, 1);
    assert.ok(children[0].args.includes('-File'), 'the script is run with -File');
    assert.ok(children[0].args.includes('C:\\profile\\wallpaper-host.ps1'));
    assert.strictEqual(children[0].spawnOptions.windowsHide, true, 'no console window flashes up');
    children[0].ready();
    await turn();
    assert.strictEqual(children[0].requests()[0].op, 'enum');
    // A single monitor comes back from ConvertTo-Json as an object, not a list.
    children[0].answer(0, { ok: true, monitors: { id: 'M1', x: 0, y: 0, w: 1920, h: 1080 } });
    await turn();
    assert.deepStrictEqual(first.value, [{ id: 'M1', x: 0, y: 0, w: 1920, h: 1080 }]);

    const applied = track(host.apply(4, [{ id: 'M1', path: 'C:\\a.jpg' }], 1000));
    await turn();
    const applyRequest = children[0].requests()[1];
    assert.strictEqual(applyRequest.op, 'apply');
    assert.strictEqual(applyRequest.position, 4);
    assert.deepStrictEqual(applyRequest.items, [{ id: 'M1', path: 'C:\\a.jpg' }]);
    children[0].answer(1, { ok: true });
    await turn();
    assert.strictEqual(applied.value, true);

    const refused = track(host.get(1000));
    await turn();
    children[0].answer(2, { ok: false, error: 'COM said no' });
    await turn();
    assert.ok(refused.error && /COM said no/.test(refused.error.message), 'a refusal keeps its reason');

    const busy = track(host.checkFullscreen(1000));
    await turn();
    children[0].answer(3, { ok: true, busy: true });
    await turn();
    assert.strictEqual(busy.value, true);

    const covered = track(host.checkMaximized(1000));
    await turn();
    children[0].answer(4, { ok: true, coveredMonitors: 'M1' });
    await turn();
    assert.deepStrictEqual(covered.value, ['M1']);

    assert.strictEqual(children.length, 1, 'every command reused the one live process');
    host.dispose();
    await turn();
  });

  await check('without an explicit path the host runs PowerShell from System32', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const a = track(host.enumMonitors(1000));
    await turn();
    // Never whatever PATH or the working directory offers under that name.
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const expected = require('path').win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert.strictEqual(children[0].file, expected, 'PowerShell was looked up on PATH');
    children[0].ready();
    await turn();
    children[0].answer(0, { ok: true, monitors: [] });
    await turn();
    assert.deepStrictEqual(a.value, []);
    host.dispose();
    await turn();
  });

  await check('a late answer of a timed-out command never resolves the next command', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const first = track(host.enumMonitors(100));
    await turn();
    children[0].exitOnKill = false; // wedged: it takes its time dying
    children[0].ready();
    await turn();
    await clock.advance(100);
    assert.ok(first.error, 'the stuck command gave up at its timeout');
    assert.strictEqual(children[0].killed, true, 'the stuck process was told to go');

    const second = track(host.get(1000));
    await turn();
    if (children[1]) {
      children[1].ready();
      await turn();
    }
    // The dying process now finishes the first command, and starts one more line it
    // never ends. Neither may reach the command that came after the timeout.
    children[0].answer(0, { ok: true, position: 99, items: [{ id: 'LATE', path: 'C:\\late.jpg' }] });
    children[0].raw('@@R@@{"ok":tr');
    await turn();
    assert.strictEqual(second.settled, false, 'the late answer of the stuck command resolved the next one');
    assert.strictEqual(children.length, 2, 'the next command went to a fresh process');
    children[1].answer(0, { ok: true, position: 4, items: [{ id: 'M1', path: 'C:\\own.jpg' }] });
    await turn();
    assert.deepStrictEqual(second.value, { position: 4, items: [{ id: 'M1', path: 'C:\\own.jpg' }] });
    host.dispose();
    await turn();
  });

  await check('an error and a late exit of the old process do not touch the new one', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const first = track(host.enumMonitors(1000));
    await turn();
    children[0].ready();
    await turn();
    children[0].emit('error', new Error('pipe broke'));
    await turn();
    assert.ok(first.error, 'the failing process rejected its own command');

    const second = track(host.enumMonitors(1000));
    await turn();
    assert.strictEqual(children.length, 2, 'the next command started a new process');
    children[1].ready();
    await turn();
    children[0].emit('exit', 1, null); // the old process reports its exit only now
    await turn();
    assert.strictEqual(second.settled, false, 'the exit of the old process rejected a command of the new one');
    children[1].answer(0, { ok: true, monitors: [{ id: 'M2', x: 0, y: 0, w: 10, h: 10 }] });
    await turn();
    assert.deepStrictEqual(second.value.map((m) => m.id), ['M2']);

    const third = track(host.enumMonitors(1000));
    await turn();
    assert.strictEqual(children.length, 2, 'the new process is still the current one');
    children[1].answer(1, { ok: true, monitors: [] });
    await turn();
    assert.deepStrictEqual(third.value, []);
    host.dispose();
    await turn();
  });

  await check('an answer that cannot be read ends the process and settles all its commands', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const a = track(host.get(1000));
    const b = track(host.checkFullscreen(1000));
    await turn();
    children[0].ready();
    await turn();
    assert.strictEqual(children[0].requests().length, 2);
    children[0].raw('@@R@@{"ok":tru\n');
    await turn();
    assert.ok(a.error && b.error, 'both commands of the broken process are settled at once');
    assert.strictEqual(children[0].killed, true);
    assert.strictEqual(pendingCount(host), 0);

    const c = track(host.get(1000));
    await turn();
    assert.strictEqual(children.length, 2, 'the next command gets a fresh process');
    children[1].ready();
    await turn();
    children[1].answer(0, { ok: true, position: 4, items: [] });
    await turn();
    assert.deepStrictEqual(c.value, { position: 4, items: [] });
    host.dispose();
    await turn();
  });

  await check('an answer without an id is refused rather than guessed', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const a = track(host.get(1000));
    await turn();
    children[0].ready();
    await turn();
    children[0].raw('@@R@@' + JSON.stringify({ ok: true, position: 1, items: [] }) + '\n');
    await turn();
    assert.ok(a.error, 'an answer nobody can match is not handed to whoever waits first');
    assert.strictEqual(children[0].killed, true);
    host.dispose();
    await turn();
  });

  await check('concurrent commands are matched by id, not by order', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const a = track(host.get(1000));
    const b = track(host.checkFullscreen(1000));
    await turn();
    children[0].ready();
    await turn();
    const [requestA, requestB] = children[0].requests();
    assert.notStrictEqual(requestA.id, requestB.id, 'every command carries its own id');
    children[0].answer(1, { ok: true, busy: true });
    children[0].answer(0, { ok: true, position: 2, items: [] });
    await turn();
    assert.strictEqual(b.value, true);
    assert.deepStrictEqual(a.value, { position: 2, items: [] });
    host.dispose();
    await turn();
  });

  await check('a caller stops waiting on its own; a start that never finishes ends at the deadline', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock, { startupTimeoutMs: 1000 });
    const a = track(host.enumMonitors(200));
    await turn();
    await clock.advance(200);
    assert.ok(a.error, 'the caller stopped waiting at its own timeout');
    assert.strictEqual(waiterCount(host), 0, 'a caller who stopped waiting is not kept');
    assert.strictEqual(children[0].killed, false, 'a caller giving up does not kill a slow start');
    await clock.advance(800);
    assert.strictEqual(children[0].killed, true, 'a start that never finishes is ended at the deadline');

    const b = track(host.enumMonitors(1000));
    await turn();
    assert.strictEqual(children.length, 2, 'the next command gets a fresh process');
    children[1].ready();
    await turn();
    children[1].answer(0, { ok: true, monitors: [] });
    await turn();
    assert.deepStrictEqual(b.value, []);
    host.dispose();
    await turn();
  });

  await check('the deadline of a start that already ended does not end the next one', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock, { startupTimeoutMs: 1000 });
    const a = track(host.enumMonitors(5000));
    await turn();
    await clock.advance(100);
    children[0].emit('exit', 1, null); // crashed while starting
    await turn();
    assert.ok(a.error, 'the crashed start rejects whoever waited for it');
    await clock.advance(50);
    const b = track(host.enumMonitors(5000));
    await turn();
    assert.strictEqual(children.length, 2);
    await clock.advance(900); // past the first start's deadline, before the second one's
    assert.strictEqual(children[1].killed, false, 'the old deadline ended the new start');
    children[1].ready();
    await turn();
    children[1].answer(0, { ok: true, monitors: [] });
    await turn();
    assert.deepStrictEqual(b.value, []);
    host.dispose();
    await turn();
  });

  await check('dispose settles a pending command, keeps no timer and refuses new work', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const a = track(host.get(1000));
    await turn();
    children[0].exitOnKill = false; // it will not report its exit
    children[0].ready();
    await turn();
    host.dispose();
    await turn();
    assert.ok(a.error, 'dispose settles the pending command');
    assert.strictEqual(pendingCount(host), 0);
    assert.strictEqual(clock.live(), 0, 'no timer outlives dispose');
    assert.strictEqual(children[0].killed, true);
    host.dispose(); // a second dispose is harmless
    const after = track(host.enumMonitors(1000));
    await turn();
    assert.ok(after.error, 'a disposed host refuses new work at once');
    assert.strictEqual(children.length, 1, 'and starts no process for it');
  });

  await check('dispose settles callers still waiting for the start', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const w1 = track(host.enumMonitors(1000));
    const w2 = track(host.checkFullscreen(1000));
    await turn();
    children[0].exitOnKill = false;
    host.dispose();
    await turn();
    assert.ok(w1.error && w2.error, 'both callers are settled');
    assert.strictEqual(waiterCount(host), 0);
    assert.strictEqual(clock.live(), 0, 'no timer outlives dispose');
  });

  await check('a host script of another protocol is refused at once, not after the timeout', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const a = track(host.enumMonitors(5000));
    await turn();
    children[0].raw('@@READY@@\n'); // the greeting of the script before WIN-002
    await turn();
    assert.ok(a.error, 'the old script was accepted');
    assert.strictEqual(children[0].killed, true);
    host.dispose();
    await turn();
  });

  await check('a command that cannot be written fails at once and ends the process', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const warm = track(host.enumMonitors(1000));
    await turn();
    children[0].ready();
    await turn();
    children[0].answer(0, { ok: true, monitors: [] });
    await turn();
    assert.deepStrictEqual(warm.value, []);
    children[0].brokenInput = true;
    const a = track(host.get(5000));
    await turn();
    assert.ok(a.error, 'the command waited for its timeout instead of failing');
    assert.strictEqual(children[0].killed, true);
    host.dispose();
    await turn();
  });

  await check('a command for a process that ended meanwhile fails at once', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const a = track(host.get(5000));
    const b = track(host.checkFullscreen(5000));
    await turn();
    // Both callers are released by the same greeting; the first write kills the
    // process, so the second caller resumes against a generation that is already over.
    children[0].brokenInput = true;
    children[0].ready();
    await turn();
    assert.ok(a.error, 'the first command failed on the broken pipe');
    assert.ok(b.error, 'the second command waited for its timeout instead of failing');
    assert.strictEqual(pendingCount(host), 0);
    host.dispose();
    await turn();
  });

  await check('an answer before the greeting ends the start', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const a = track(host.enumMonitors(5000));
    await turn();
    children[0].raw('@@R@@' + JSON.stringify({ ok: true, monitors: [], id: 1 }) + '\n');
    await turn();
    assert.ok(a.error, 'the caller waited on a process that answers before it is ready');
    assert.strictEqual(children[0].killed, true);
    host.dispose();
    await turn();
  });

  await check('an endless line without a break ends the process', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const a = track(host.get(5000));
    await turn();
    children[0].ready();
    await turn();
    children[0].raw('@@R@@' + 'x'.repeat(4 * 1024 * 1024 + 1));
    await turn();
    assert.ok(a.error, 'the host kept buffering an answer that never ends');
    assert.strictEqual(children[0].killed, true);
    host.dispose();
    await turn();
  });

  await check('a pipe error on the input ends the process instead of being thrown', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const a = track(host.get(5000));
    await turn();
    children[0].ready();
    await turn();
    // Node reports a write to a dead process on the pipe too; an 'error' event nobody
    // listens to is thrown, which in the main process means a crash dialog.
    children[0].stdin.emit('error', new Error('EPIPE'));
    await turn();
    assert.ok(a.error, 'the command on the broken pipe is settled at once');
    assert.strictEqual(children[0].killed, true);
    host.dispose();
    await turn();
  });

  await check('the host reads what the process writes to stderr', async () => {
    const clock = createClock();
    const { host, children } = makeHost(clock);
    const a = track(host.enumMonitors(1000));
    await turn();
    // An unread stderr pipe fills up and then blocks the process on its next write.
    assert.ok(children[0].stderr.listenerCount('data') > 0, 'nobody reads stderr');
    children[0].ready();
    await turn();
    children[0].answer(0, { ok: true, monitors: [] });
    await turn();
    assert.deepStrictEqual(a.value, []);
    host.dispose();
    await turn();
  });

  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.error && r.error.message}`}`);
  }
  if (failed.length) {
    console.error(`\nwallpaper-host-ownership.test.js: ${failed.length} of ${results.length} failed`);
    process.exit(1);
  }
  console.log(`\nwallpaper-host-ownership.test.js ok (${results.length} cases)`);
})().catch((error) => {
  global.setTimeout = originalSetTimeout;
  global.clearTimeout = originalClearTimeout;
  console.error(error);
  process.exit(1);
});
