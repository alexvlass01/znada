'use strict';

// WIN-002. The one way main.js runs a Windows system program (powershell.exe, reg.exe).
//
// Each fallback used to call execFile with a bare program name and no time limit. A bare
// name is looked up on PATH, so which program ran depended on the machine. No limit meant
// a PowerShell that never returned held its caller forever — and the wallpaper apply that
// falls back to it runs inside the library lock, so one hung child stopped every library
// change until the app was restarted. Quitting did not end such a child either.
//
// Here: the program is an absolute path inside %SystemRoot%\System32; every run has a hard
// deadline, after which the whole process tree is ended; live runs are tracked, and
// quitting ends them all without waiting for any of them.

const path = require('path');
const childProcess = require('child_process');

const SYSTEM_PROGRAMS = {
  powershell: ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
  reg: ['reg.exe'],
  taskkill: ['taskkill.exe'],
};
const DEFAULT_TIMEOUT_MS = 30000;
// taskkill itself gets a deadline too: ending a hung program must not hang in turn.
const KILL_TIMEOUT_MS = 5000;

class ChildRunnerError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ChildRunnerError';
    this.code = code;
  }
}

// %SystemRoot% as a drive path. Anything else (missing, relative, a network share) is not
// where Windows keeps its programs, and falls back to the default install location.
function systemRoot(env) {
  for (const value of [env && env.SystemRoot, env && env.windir]) {
    if (typeof value === 'string' && /^[A-Za-z]:\\/.test(value)) return value;
  }
  return 'C:\\Windows';
}

function systemExecutable(name, env = process.env) {
  const parts = SYSTEM_PROGRAMS[name];
  if (!parts) throw new Error(`unknown system program: ${name}`);
  return path.win32.join(systemRoot(env), 'System32', ...parts);
}

function createChildRunner(options = {}) {
  const execFile = options.execFile || childProcess.execFile;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const defaultTimeoutMs = options.defaultTimeoutMs || DEFAULT_TIMEOUT_MS;
  const taskkillPath = options.taskkillPath || systemExecutable('taskkill', options.env || process.env);
  const active = new Set();
  let disposed = false;

  // Ends a process AND whatever it started: PowerShell's Add-Type runs csc.exe under it.
  // taskkill /T needs the parent alive to find its children, so the parent is NOT killed
  // first; plain kill() is only the last resort when taskkill could not do it.
  function killTree(child) {
    if (!child) return;
    const lastResort = () => {
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill(); } catch {}
      }
    };
    const pid = Number(child.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      lastResort();
      return;
    }
    try {
      execFile(taskkillPath, ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, timeout: KILL_TIMEOUT_MS }, (error) => { if (error) lastResort(); });
    } catch {
      lastResort();
    }
  }

  function run(file, args, runOptions = {}) {
    if (disposed) {
      return Promise.reject(new ChildRunnerError('disposed', 'system programs are no longer started: the app is quitting'));
    }
    const timeoutMs = Number(runOptions.timeoutMs) || defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const entry = { child: null, timer: null, end: null };
      let settled = false;
      const finish = (error, value) => {
        if (settled) return false;
        settled = true;
        if (entry.timer) clearTimer(entry.timer);
        active.delete(entry);
        if (error) reject(error);
        else resolve(value);
        return true;
      };
      const execOptions = { windowsHide: true };
      if (runOptions.maxBuffer) execOptions.maxBuffer = runOptions.maxBuffer;
      try {
        entry.child = execFile(file, args, execOptions, (error, stdout, stderr) => {
          if (error) {
            const failed = new ChildRunnerError('failed', String(stderr || '') || error.message);
            finish(failed);
          } else {
            finish(null, { stdout, stderr });
          }
        });
      } catch (error) {
        finish(new ChildRunnerError('spawn_failed', error && error.message));
        return;
      }
      if (settled) return; // execFile called back synchronously
      entry.end = (error) => { if (finish(error)) killTree(entry.child); };
      active.add(entry);
      entry.timer = setTimer(() => {
        entry.end(new ChildRunnerError('timeout', `${path.win32.basename(file)} did not finish in ${timeoutMs} ms`));
      }, timeoutMs);
    });
  }

  // For quitting: ends every live run at once and refuses new ones. Nothing is awaited —
  // taskkill goes on after the app has gone.
  function disposeAll() {
    disposed = true;
    const entries = [...active];
    for (const entry of entries) entry.end(new ChildRunnerError('disposed', 'the app is quitting'));
    return entries.length;
  }

  return {
    run,
    killTree,
    disposeAll,
    activeCount: () => active.size,
  };
}

module.exports = {
  ChildRunnerError,
  createChildRunner,
  systemExecutable,
  DEFAULT_TIMEOUT_MS,
};
