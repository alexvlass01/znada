'use strict';

// WIN-002: src/child-runner.js — how main.js runs powershell.exe and reg.exe.
// Fake execFile and a fake clock: nothing is started, nothing waits in real time.
//   node test/child-runner.test.js

const assert = require('assert');
const { EventEmitter } = require('events');
const { createChildRunner, systemExecutable } = require('../src/child-runner');

const TASKKILL = 'D:\\Win\\System32\\taskkill.exe';

function turn() {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function createClock() {
  let now = 0;
  const timers = new Map();
  let seq = 0;
  return {
    setTimer: (fn, ms) => { const h = { seq: ++seq }; timers.set(h, { at: now + ms, fn }); return h; },
    clearTimer: (h) => { timers.delete(h); },
    async advance(ms) {
      now += ms;
      for (const [h, t] of [...timers]) {
        if (t.at <= now && timers.has(h)) { timers.delete(h); t.fn(); }
      }
      await turn();
    },
    live: () => timers.size,
  };
}

// Programs answer only when the test says so; taskkill's behaviour is configurable.
function fakeExec({ taskkill = 'ok' } = {}) {
  const calls = [];
  let pid = 100;
  const execFile = (file, args, options, callback) => {
    if (file === TASKKILL) {
      const call = { file, args, options, killedParentFirst: null };
      calls.push(call);
      if (taskkill === 'throw') throw new Error('cannot start taskkill');
      setImmediate(() => callback(taskkill === 'fail' ? new Error('taskkill failed') : null, '', ''));
      return new EventEmitter();
    }
    const child = new EventEmitter();
    child.pid = ++pid;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    const call = { file, args, options, child, callback };
    calls.push(call);
    return child;
  };
  const programs = () => calls.filter((c) => c.file !== TASKKILL);
  const kills = () => calls.filter((c) => c.file === TASKKILL);
  return { execFile, calls, programs, kills };
}

function track(promise) {
  const state = { settled: false };
  promise.then(
    (value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.error = error; }
  );
  return state;
}

(async () => {
  // Program paths come from %SystemRoot%, never from PATH or the working directory.
  {
    const env = { SystemRoot: 'D:\\Win', windir: 'E:\\Other' };
    assert.strictEqual(systemExecutable('powershell', env), 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.strictEqual(systemExecutable('reg', env), 'D:\\Win\\System32\\reg.exe');
    assert.strictEqual(systemExecutable('taskkill', env), TASKKILL);
    assert.strictEqual(systemExecutable('reg', { windir: 'E:\\Other' }), 'E:\\Other\\System32\\reg.exe');
    for (const bad of [{}, { SystemRoot: 'Windows' }, { SystemRoot: '\\\\server\\share' }, { SystemRoot: '' }]) {
      assert.strictEqual(systemExecutable('reg', bad), 'C:\\Windows\\System32\\reg.exe', JSON.stringify(bad));
    }
    assert.throws(() => systemExecutable('cmd', env), /unknown system program/);
  }

  // A run that answers resolves with its output and leaves nothing behind.
  {
    const clock = createClock();
    const fake = fakeExec();
    const runner = createChildRunner({ execFile: fake.execFile, setTimer: clock.setTimer, clearTimer: clock.clearTimer, taskkillPath: TASKKILL });
    const run = track(runner.run('D:\\Win\\System32\\reg.exe', ['query', 'X'], { timeoutMs: 1000, maxBuffer: 4096 }));
    const [call] = fake.programs();
    assert.deepStrictEqual(call.args, ['query', 'X']);
    assert.strictEqual(call.options.windowsHide, true, 'a console window would flash up');
    assert.strictEqual(call.options.maxBuffer, 4096);
    assert.strictEqual(runner.activeCount(), 1);
    call.callback(null, 'out', 'err');
    await turn();
    assert.deepStrictEqual(run.value, { stdout: 'out', stderr: 'err' });
    assert.strictEqual(runner.activeCount(), 0);
    assert.strictEqual(clock.live(), 0, 'the deadline outlived the run');
    assert.strictEqual(fake.kills().length, 0);
  }

  // A failing run keeps the reason callers have always logged: stderr, else the error.
  {
    const clock = createClock();
    const fake = fakeExec();
    const runner = createChildRunner({ execFile: fake.execFile, setTimer: clock.setTimer, clearTimer: clock.clearTimer, taskkillPath: TASKKILL });
    const a = track(runner.run('p.exe', [], { timeoutMs: 1000 }));
    const b = track(runner.run('p.exe', [], { timeoutMs: 1000 }));
    fake.programs()[0].callback(new Error('exit 1'), '', 'COM said no');
    fake.programs()[1].callback(new Error('exit 2'), '', '');
    await turn();
    assert.strictEqual(a.error.code, 'failed');
    assert.strictEqual(a.error.message, 'COM said no');
    assert.strictEqual(b.error.message, 'exit 2');
    assert.strictEqual(runner.activeCount(), 0);
    assert.strictEqual(clock.live(), 0);
  }

  // A run that never answers ends at its deadline, with its whole tree, and its late
  // answer changes nothing.
  {
    const clock = createClock();
    const fake = fakeExec();
    const runner = createChildRunner({ execFile: fake.execFile, setTimer: clock.setTimer, clearTimer: clock.clearTimer, taskkillPath: TASKKILL });
    const run = track(runner.run('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-File', 'x.ps1'], { timeoutMs: 500 }));
    await clock.advance(499);
    assert.strictEqual(run.settled, false, 'ended before its deadline');
    await clock.advance(1);
    assert.strictEqual(run.error && run.error.code, 'timeout');
    assert.match(run.error.message, /powershell\.exe did not finish in 500 ms/);
    const [program] = fake.programs();
    const [kill] = fake.kills();
    assert.deepStrictEqual(kill.args, ['/PID', String(program.child.pid), '/T', '/F'], 'the tree was not ended');
    assert.strictEqual(kill.options.windowsHide, true);
    assert.ok(kill.options.timeout > 0, 'taskkill itself has no deadline');
    assert.strictEqual(program.child.killed, false,
      'the parent was killed before taskkill could walk its children');
    assert.strictEqual(runner.activeCount(), 0);
    assert.strictEqual(clock.live(), 0);
    program.callback(new Error('killed'), '', ''); // the late answer
    await turn();
    assert.strictEqual(run.error.code, 'timeout', 'the late answer replaced the outcome');
  }

  // The default deadline applies when a caller gives none.
  {
    const clock = createClock();
    const fake = fakeExec();
    const runner = createChildRunner({ execFile: fake.execFile, setTimer: clock.setTimer, clearTimer: clock.clearTimer, taskkillPath: TASKKILL, defaultTimeoutMs: 1000 });
    const run = track(runner.run('p.exe', []));
    await clock.advance(999);
    assert.strictEqual(run.settled, false);
    await clock.advance(1);
    assert.strictEqual(run.error && run.error.code, 'timeout');
  }

  // When taskkill cannot do it, the program itself is ended as a last resort.
  for (const mode of ['fail', 'throw']) {
    const clock = createClock();
    const fake = fakeExec({ taskkill: mode });
    const runner = createChildRunner({ execFile: fake.execFile, setTimer: clock.setTimer, clearTimer: clock.clearTimer, taskkillPath: TASKKILL });
    const run = track(runner.run('p.exe', [], { timeoutMs: 10 }));
    await clock.advance(10);
    await turn();
    assert.strictEqual(run.error.code, 'timeout');
    assert.strictEqual(fake.programs()[0].child.killed, true, `taskkill ${mode}: the program was left running`);
  }

  // A program that has already exited is not killed again.
  {
    const clock = createClock();
    const fake = fakeExec({ taskkill: 'fail' });
    const runner = createChildRunner({ execFile: fake.execFile, setTimer: clock.setTimer, clearTimer: clock.clearTimer, taskkillPath: TASKKILL });
    track(runner.run('p.exe', [], { timeoutMs: 10 }));
    fake.programs()[0].child.exitCode = 0;
    await clock.advance(10);
    await turn();
    assert.strictEqual(fake.programs()[0].child.killed, false);
  }

  // A program that could not be started fails at once and is not tracked.
  {
    const clock = createClock();
    const runner = createChildRunner({
      execFile: () => { throw new Error('spawn EACCES'); },
      setTimer: clock.setTimer, clearTimer: clock.clearTimer, taskkillPath: TASKKILL,
    });
    const run = track(runner.run('p.exe', [], { timeoutMs: 10 }));
    await turn();
    assert.strictEqual(run.error.code, 'spawn_failed');
    assert.strictEqual(runner.activeCount(), 0);
    assert.strictEqual(clock.live(), 0);
  }

  // Quitting ends every live run at once and starts nothing afterwards.
  {
    const clock = createClock();
    const fake = fakeExec();
    const runner = createChildRunner({ execFile: fake.execFile, setTimer: clock.setTimer, clearTimer: clock.clearTimer, taskkillPath: TASKKILL });
    const a = track(runner.run('p.exe', [], { timeoutMs: 60000 }));
    const b = track(runner.run('q.exe', [], { timeoutMs: 60000 }));
    assert.strictEqual(runner.disposeAll(), 2, 'quitting did not find both live runs');
    await turn();
    assert.ok(a.error && b.error, 'quitting left a run waiting');
    assert.strictEqual(a.error.code, 'disposed');
    assert.strictEqual(b.error.code, 'disposed');
    assert.deepStrictEqual(fake.kills().map((k) => k.args[1]),
      fake.programs().map((p) => String(p.child.pid)), 'quitting left a program running');
    assert.strictEqual(runner.activeCount(), 0);
    assert.strictEqual(clock.live(), 0, 'a deadline outlived quitting');
    const later = track(runner.run('p.exe', [], { timeoutMs: 10 }));
    await turn();
    assert.ok(later.error, 'a run was accepted after quitting began');
    assert.strictEqual(later.error.code, 'disposed');
    assert.strictEqual(fake.programs().length, 2, 'a program was started after quitting began');
    assert.strictEqual(runner.disposeAll(), 0, 'a second dispose found something to end');
  }

  console.log('child-runner.test.js ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
