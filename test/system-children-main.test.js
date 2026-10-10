'use strict';

// WIN-002, second half: the system programs main.js starts itself.
//
// Every fallback used to call execFile with a bare program name and no time limit. The
// name was looked up on PATH, so which program ran depended on the machine. And a
// PowerShell that never returned held its caller forever — the wallpaper apply that
// falls back to it runs inside the library lock, so one hung child stopped every
// library change until the app was restarted. Quitting did not end such a child either.
//
// These run the REAL main.js over a temp profile, with execFile replaced by a recorder
// whose children never answer. Nothing reaches the real machine.
//
// Run: node test/system-children-main.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const H = require('./helpers/main-harness');

const SYSTEM_ROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
const POWERSHELL = path.win32.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const REG = path.win32.join(SYSTEM_ROOT, 'System32', 'reg.exe');
const TASKKILL = path.win32.join(SYSTEM_ROOT, 'System32', 'taskkill.exe');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = H.makeTempProfile('system-children');
  const realError = console.error;
  const realLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    await fn(dir);
    console.log = realLog; console.error = realError;
    console.log('  OK ' + name);
    passed++;
  } catch (err) {
    console.log = realLog; console.error = realError;
    console.log('  FAIL ' + name);
    failures.push({ name, err });
  } finally {
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// execFile stand-in: taskkill answers at once, every other program hangs like a wedged
// PowerShell and never calls back.
function recordingExecFile() {
  const calls = [];
  let pid = 7000;
  const execFile = (file, args, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const child = new EventEmitter();
    child.pid = ++pid;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    calls.push({ file, args, options, child });
    if (/taskkill(\.exe)?$/i.test(String(file)) && typeof callback === 'function') {
      setImmediate(() => callback(null, '', ''));
    }
    return child;
  };
  return { execFile, calls };
}

// spawn stand-in for the wallpaper host. 'dead' fails at once, like the harness default;
// 'silent' greets in the current protocol and then never answers a command.
const HOST_READY_LINE = require('../src/wallpaper-host').READY_LINE || '@@READY@@';
function recordingSpawn(mode) {
  const calls = [];
  let pid = 9000;
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = ++pid;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.written = [];
    child.stdin.on('data', (chunk) => child.written.push(String(chunk)));
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    calls.push({ file, args, options, child });
    if (mode === 'dead') {
      setImmediate(() => {
        if (child.listenerCount('error')) child.emit('error', new Error('child processes are disabled in tests'));
        child.emit('exit', 1, null);
      });
    } else {
      setImmediate(() => child.stdout.write(HOST_READY_LINE + '\n'));
    }
    return child;
  };
  return { spawn, calls };
}

const isPowerShell = (call) => /powershell(\.exe)?$/i.test(String(call.file));
const isReg = (call) => /(^|\\)reg(\.exe)?$/i.test(String(call.file));
const isTaskkill = (call) => /taskkill(\.exe)?$/i.test(String(call.file));
const isThemeFlip = (call) => isPowerShell(call) && call.args.some((a) => /set-theme\.ps1$/i.test(String(a)));
const treeKillOf = (call) => [TASKKILL, '/PID', String(call.child.pid), '/T', '/F'];

// A "time" schedule whose dark hours are now: the flip to dark is due at once.
function hm(date) {
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}
function darkNowSchedule() {
  const now = Date.now();
  return { mode: 'time', darkStart: hm(new Date(now - 60 * 60000)), lightStart: hm(new Date(now + 60 * 60000)), lat: '', lng: '' };
}

function within(ms, promise, what) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still waiting after ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate, ms, what) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`${what}: not seen within ${ms} ms`);
    await sleep(5);
  }
}

function writeProfile(dir, extra = {}) {
  const wall = H.writeImage(path.join(dir, 'pics', 'wall.png'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    autoSwitch: true, style: 'fill', monitors: {}, library: {},
    separateThemes: false, lightWallpaper: wall, darkWallpaper: wall,
    ...extra,
  }, null, 2), 'utf8');
}

// The host takes spawn from child_process when its module is first loaded, and the module
// stays cached: without dropping it, every test here would talk to the fake of whichever
// test loaded it first.
function loadWithHost(dir, childProcess) {
  delete require.cache[require.resolve(path.join(H.ROOT, 'src', 'wallpaper-host.js'))];
  return H.loadMain(dir, { childProcess });
}

function shortDeadlines(m, ms) {
  // Without the seam the old main.js has no deadline at all; the waits below report it.
  if (typeof m.__test.setSystemChildTimeouts === 'function') {
    m.__test.setSystemChildTimeouts({ powershell: ms, reg: ms });
  }
}

(async () => {
  console.log('\nWIN-002: system programs started by main.js\n');

  await test('a hung PowerShell fallback ends at its deadline and releases the library lock', async (dir) => {
    // Game mode on and no monitors cached: the apply asks the fullscreen check, the
    // monitor list and finally the single-image fallback — three PowerShell runs, all
    // of which hang here, because the host itself cannot start under the harness.
    writeProfile(dir, { gameModeBlock: true });
    const rec = recordingExecFile();
    const host = recordingSpawn('dead');
    const m = loadWithHost(dir, { execFile: rec.execFile, spawn: host.spawn });
    m.__test.loadConfig();
    m.__test.setMonitorsCache([]);
    shortDeadlines(m, 40);

    const applied = m.__test.withLibraryLock(() => m.__test.applyForTheme('light', false));
    const next = m.__test.withLibraryLock(async () => 'next library change ran');
    assert.strictEqual(await within(3000, next, 'the next library change'), 'next library change ran',
      'a hung PowerShell held the library lock');
    const result = await within(3000, applied, 'the apply');
    assert.strictEqual(result.ok, false);

    const ps = rec.calls.filter(isPowerShell);
    assert.strictEqual(ps.length, 3, `expected the fullscreen check, the monitor list and the fallback, saw ${ps.length}`);
    for (const call of ps) {
      assert.strictEqual(call.file, POWERSHELL, 'PowerShell was looked up on PATH: ' + call.file);
      assert.strictEqual(call.options.windowsHide, true);
    }
    // Each hung run is ended with its whole tree: Add-Type starts csc.exe under it.
    const kills = rec.calls.filter(isTaskkill);
    assert.deepStrictEqual(kills.map((k) => [k.file, ...k.args]), ps.map(treeKillOf));
    assert.strictEqual(m.__test.systemChildren().activeCount(), 0, 'a finished run is still tracked');
    // The host is PowerShell too, and it is started the same way.
    assert.ok(host.calls.length >= 1, 'the wallpaper host was never started');
    for (const call of host.calls) {
      assert.strictEqual(call.file, POWERSHELL, 'the wallpaper host was looked up on PATH: ' + call.file);
      assert.ok(call.args.some((a) => /wallpaper-host\.ps1$/i.test(String(a))), 'not the host script');
    }
  });

  await test('a hung theme flip ends at its deadline, with its whole tree', async (dir) => {
    writeProfile(dir);
    const rec = recordingExecFile();
    const m = loadWithHost(dir, { execFile: rec.execFile, spawn: recordingSpawn('dead').spawn });
    m.__test.loadConfig();
    shortDeadlines(m, 40);
    await m.invoke('set-config', { themeSchedule: darkNowSchedule() });

    await waitFor(() => rec.calls.some(isThemeFlip), 3000, 'the flip to dark');
    const flip = rec.calls.find(isThemeFlip);
    assert.strictEqual(flip.file, POWERSHELL, 'the flip looked PowerShell up on PATH: ' + flip.file);
    assert.deepStrictEqual(flip.args.slice(-2), ['-Light', '0']);
    const flipKill = () => rec.calls.find((c) => isTaskkill(c) && c.args[1] === String(flip.child.pid));
    await waitFor(flipKill, 3000, 'ending the hung flip');
    assert.deepStrictEqual([flipKill().file, ...flipKill().args], treeKillOf(flip));
    await waitFor(() => m.__test.systemChildren().activeCount() === 0, 3000, 'the flip leaving the runner');
  });

  await test('quitting ends the wallpaper host with its whole tree', async (dir) => {
    writeProfile(dir);
    const rec = recordingExecFile();
    const host = recordingSpawn('silent');
    const m = loadWithHost(dir, { execFile: rec.execFile, spawn: host.spawn });
    m.__test.loadConfig();
    m.__test.setMonitorsCache([{ id: 'MON1', x: 0, y: 0, w: 1920, h: 1080, primary: true }]);
    // The host takes the apply and never answers; only quitting can end it now.
    const applied = m.__test.applyForTheme('light', true);
    await waitFor(() => host.calls.length === 1 && host.calls[0].child.written.join('').includes('"op":"apply"'),
      3000, 'the apply reaching the host');

    m.emitApp('before-quit', {});
    const result = await within(3000, applied, 'the apply after quitting began');
    assert.strictEqual(result.ok, false);
    const hostKill = rec.calls.find((c) => isTaskkill(c) && c.args[1] === String(host.calls[0].child.pid));
    assert.ok(hostKill, 'quitting did not end the host with its tree');
    assert.deepStrictEqual([hostKill.file, ...hostKill.args], treeKillOf(host.calls[0]));
    assert.strictEqual(rec.calls.filter(isPowerShell).length, 0, 'a fallback PowerShell was started after quitting began');
    assert.strictEqual(host.calls.length, 1, 'a new host was started after quitting began');
  });

  await test('quitting ends a hung system program and starts no new one', async (dir) => {
    writeProfile(dir);
    const rec = recordingExecFile();
    const m = loadWithHost(dir, { execFile: rec.execFile, spawn: recordingSpawn('dead').spawn });
    m.__test.loadConfig();
    m.__test.setMonitorsCache([]);
    // Deadlines stay at their real length: only quitting can end this run in time.
    const applied = m.__test.applyForTheme('light', true);
    await waitFor(() => rec.calls.some(isPowerShell), 3000, 'the monitor-list fallback');

    m.emitApp('before-quit', {});
    const result = await within(3000, applied, 'the apply after quitting began');
    assert.strictEqual(result.ok, false);

    const ps = rec.calls.filter(isPowerShell);
    assert.strictEqual(ps.length, 1, 'after quitting began, another PowerShell was started');
    const kills = rec.calls.filter(isTaskkill);
    assert.deepStrictEqual(kills.map((k) => [k.file, ...k.args]),
      [[TASKKILL, '/PID', String(ps[0].child.pid), '/T', '/F']], 'quitting left the hung PowerShell running');
    assert.strictEqual(m.__test.systemChildren().activeCount(), 0);
  });

  await test('the stray autostart cleanup runs reg.exe from System32 under a deadline', async (dir) => {
    const rec = recordingExecFile();
    const m = H.loadMain(dir, { childProcess: { execFile: rec.execFile } });
    assert.strictEqual(typeof m.__test.cleanLegacyAutostartRegistryValues, 'function',
      'the cleanup cannot be reached from a test');
    shortDeadlines(m, 40);
    m.__test.cleanLegacyAutostartRegistryValues();

    const regs = rec.calls.filter(isReg);
    assert.ok(regs.length >= 2, 'the cleanup ran no reg.exe');
    for (const call of regs) {
      assert.strictEqual(call.file, REG, 'reg was looked up on PATH: ' + call.file);
      assert.strictEqual(call.args[0], 'delete');
      assert.strictEqual(call.options.windowsHide, true, 'a console window would flash up at login');
    }
    await waitFor(() => rec.calls.filter(isTaskkill).length === regs.length, 3000, 'ending every hung reg.exe');
    assert.strictEqual(m.__test.systemChildren().activeCount(), 0);
  });

  await test('uninstall deletes the autostart entries with reg.exe from System32 and a deadline', async (dir) => {
    const seen = [];
    H.loadMain(dir, {
      argv: ['--squirrel-uninstall'],
      childProcess: { execFileSync: (file, args, options) => { seen.push({ file, args, options }); return ''; } },
    });
    const regs = seen.filter(isReg);
    assert.ok(regs.length >= 2, 'the uninstall step ran no reg.exe');
    assert.strictEqual(regs.length, seen.length, 'the uninstall step ran something other than reg.exe');
    for (const call of regs) {
      assert.strictEqual(call.file, REG, 'reg was looked up on PATH: ' + call.file);
      assert.strictEqual(call.args[0], 'delete');
      assert.ok(call.options && call.options.timeout > 0, 'reg.exe ran without a deadline');
      assert.strictEqual(call.options.windowsHide, true);
    }
  });

  await test('main.js starts no system program except through the runner', async () => {
    // The class, not the four places fixed today: a fifth execFile with a bare name and
    // no deadline would bring the whole defect back.
    const source = fs.readFileSync(path.join(H.ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    const direct = source.match(/\bexecFile\s*\(/g) || [];
    assert.strictEqual(direct.length, 0, `main.js calls execFile directly ${direct.length} time(s)`);
    assert.ok(!/\bspawn\s*\(/.test(source), 'main.js spawns a process directly');
    assert.ok(!/\bexecFileSync\s*\(\s*['"]/.test(source), 'main.js runs a program by bare name');
    // The resolver is the one place allowed to name a program; everywhere else a bare
    // name would be looked up on PATH.
    const named = source.replace(/\bsystemExecutable\(\s*'[a-z]+'\s*\)/g, '');
    assert.ok(!/['"]powershell(\.exe)?['"]/i.test(named), 'main.js names PowerShell without its path');
    assert.ok(!/['"]reg(\.exe)?['"]/i.test(named), 'main.js names reg without its path');
    assert.strictEqual((source.match(/\bsystemExecutable\(/g) || []).length, 2,
      'a new system program should be named here on purpose');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) {
    console.log(`\n✗ ${f.name}`);
    console.log('  ' + (f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 3).join('\n  ') : f.err));
  }
  if (failures.length) process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
