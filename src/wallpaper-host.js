'use strict';

// Persistent PowerShell COM host for setting per-monitor wallpapers.
//
// WHY: the old approach spawned a fresh powershell.exe for every operation, and
// each one ran `Add-Type` which JIT-compiles the C# IDesktopWallpaper interop
// (~0.5-1s CPU per call). That's wasteful for the slideshow / frequent changes.
// Here we keep ONE long-lived powershell.exe, compile the interop ONCE, then send
// newline-delimited JSON commands over stdin and read one JSON line per response.
//
// Protocol: host prints `@@READY@@v2` once the interop is compiled, then for each
// command line it prints `@@R@@<json>`, echoing the command's `id`. UTF-8 both ways
// so Cyrillic paths work. main.js uses this as a FAST PATH with a full fallback to
// spawn-per-call, so a host failure never stops wallpapers from being set.
//
// WIN-002. Answers are matched to commands by id, never by arrival order. Each
// spawned process is its own generation: its data, error and exit events count only
// while it is the current process, so the late exit of an old one cannot reject the
// commands of its successor. Whatever ends a generation (exit, error, a timed-out
// command, an unreadable answer, dispose) settles every call waiting on it at once.

const { spawn } = require('child_process');
const { systemExecutable } = require('./child-runner');

const READY = '@@READY@@';
const RESP = '@@R@@';
// The script is rewritten into the profile at every start, so a host that greets in
// another protocol means that write failed and an older script is still there. It would
// answer without ids; refusing it at once lets the caller fall back straight away
// instead of after a timeout.
const PROTOCOL_VERSION = 2;
const READY_LINE = `${READY}v${PROTOCOL_VERSION}`;
const DEFAULT_COMMAND_TIMEOUT_MS = 8000;
// A start that never finishes (a wedged Add-Type, say) is ended here. A caller's own
// wait is usually shorter and does NOT end the start: short callers such as the Stealth
// check would otherwise kill every slow cold start, and the host would never come up.
const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
// An answer is a monitor list or a handful of paths. Anything this long without a line
// break is not an answer, and buffering it would only grow.
const FRAME_LIMIT = 4 * 1024 * 1024;

const HOST_SCRIPT = `$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.Encoding]::UTF8
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct DW_RECT { public int Left, Top, Right, Bottom; }
[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDesktopWallpaper {
  void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint monitorIndex);
  uint GetMonitorDevicePathCount();
  DW_RECT GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
  void SetBackgroundColor(uint color);
  uint GetBackgroundColor();
  void SetPosition(int position);
  int GetPosition();
}
public static class DW {
  static IDesktopWallpaper _i;
  static IDesktopWallpaper I { get { if(_i==null){ _i=(IDesktopWallpaper)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD"))); } return _i; } }
  public static uint Count(){ return I.GetMonitorDevicePathCount(); }
  public static string PathAt(uint i){ return I.GetMonitorDevicePathAt(i); }
  public static int[] Rect(string id){ var r=I.GetMonitorRECT(id); return new int[]{r.Left,r.Top,r.Right,r.Bottom}; }
  public static void SetPosition(int p){ I.SetPosition(p); }
  public static int GetPos(){ return I.GetPosition(); }
  public static void SetWallpaper(string id,string p){ I.SetWallpaper(id,p); }
  public static string GetWp(string id){ return I.GetWallpaper(id); }

  [DllImport("shell32.dll")]
  public static extern int SHQueryUserNotificationState(out int pqunsState);
  public static bool IsUserBusy() {
    int state;
    int hr = SHQueryUserNotificationState(out state);
    if (hr == 0) {
      return (state == 2 || state == 3 || state == 4 || state == 6);
    }
    return false;
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out DW_RECT lpRect);
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

  public static bool IsCloaked(IntPtr hWnd) {
      int cloaked;
      if (DwmGetWindowAttribute(hWnd, 14, out cloaked, 4) == 0) return cloaked != 0;
      return false;
  }

  public static string[] GetCoveredMonitors() {
    var covered = new System.Collections.Generic.List<string>();
    uint count = Count();
    var monitorRects = new System.Collections.Generic.Dictionary<string, DW_RECT>();
    for (uint i = 0; i < count; i++) {
        string id = PathAt(i);
        try { monitorRects[id] = I.GetMonitorRECT(id); } catch {}
    }

    EnumWindows((hWnd, lParam) => {
        if (IsWindowVisible(hWnd) && IsZoomed(hWnd) && !IsCloaked(hWnd)) {
            DW_RECT wRect;
            if (GetWindowRect(hWnd, out wRect)) {
                int cx = wRect.Left + (wRect.Right - wRect.Left) / 2;
                int cy = wRect.Top + (wRect.Bottom - wRect.Top) / 2;
                foreach (var kvp in monitorRects) {
                    var r = kvp.Value;
                    if (cx >= r.Left && cx <= r.Right && cy >= r.Top && cy <= r.Bottom) {
                        if (!covered.Contains(kvp.Key)) covered.Add(kvp.Key);
                        break;
                    }
                }
            }
        }
        return true;
    }, IntPtr.Zero);
    
    return covered.ToArray();
  }
}
"@
[Console]::Out.WriteLine('${READY_LINE}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Trim() -eq '') { continue }
  $requestId = $null
  try {
    $cmd = $line | ConvertFrom-Json
    $requestId = $cmd.id
    if ($cmd.op -eq 'enum') {
      $list = New-Object System.Collections.ArrayList
      $n = [DW]::Count()
      for ($i=0; $i -lt $n; $i++) {
        $id = [DW]::PathAt([uint32]$i)
        try { $r = [DW]::Rect($id) } catch { continue }
        [void]$list.Add([pscustomobject]@{ id=$id; x=$r[0]; y=$r[1]; w=($r[2]-$r[0]); h=($r[3]-$r[1]) })
      }
      $out = [pscustomobject]@{ ok=$true; monitors=@($list) }
    } elseif ($cmd.op -eq 'apply') {
      [DW]::SetPosition([int]$cmd.position)
      foreach ($it in $cmd.items) { [DW]::SetWallpaper([string]$it.id, [string]$it.path) }
      $out = [pscustomobject]@{ ok=$true }
    } elseif ($cmd.op -eq 'get') {
      $list = New-Object System.Collections.ArrayList
      $n = [DW]::Count()
      for ($i=0; $i -lt $n; $i++) {
        $id = [DW]::PathAt([uint32]$i)
        [void]$list.Add([pscustomobject]@{ id=$id; path=[DW]::GetWp($id) })
      }
      $out = [pscustomobject]@{ ok=$true; position=[DW]::GetPos(); items=@($list) }
    } elseif ($cmd.op -eq 'check-fullscreen') {
      $out = [pscustomobject]@{ ok=$true; busy=[DW]::IsUserBusy() }
    } elseif ($cmd.op -eq 'check-maximized') {
      $out = [pscustomobject]@{ ok=$true; coveredMonitors=[DW]::GetCoveredMonitors() }
    } else {
      $out = [pscustomobject]@{ ok=$false; error='unknown op' }
    }
  } catch {
    $out = [pscustomobject]@{ ok=$false; error=$_.Exception.Message }
  }
  $out | Add-Member -NotePropertyName id -NotePropertyValue $requestId -Force
  [Console]::Out.WriteLine('${RESP}' + ($out | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
`;

class WallpaperHostError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'WallpaperHostError';
    this.code = code;
  }
}

class WallpaperHost {
  constructor(scriptPath, options = {}) {
    this.scriptPath = scriptPath;
    // From System32 by absolute path, never looked up on PATH (WIN-002).
    this.executablePath = options.executablePath || systemExecutable('powershell');
    this.spawnImpl = options.spawnImpl || spawn;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.killProcess = typeof options.killProcess === 'function' ? options.killProcess : (proc) => proc.kill();
    this.startupTimeoutMs = options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS;
    this.proc = null;          // the current generation; events of any other process are ignored
    this.buf = '';
    this.ready = false;
    this.startTimer = null;
    this.readyWaiters = [];    // callers waiting for THIS start: { resolve, reject, timer }
    this.pending = new Map();  // id -> { resolve, reject, timer } of commands sent to THIS process
    this.nextId = 1;
    this.disposed = false;
  }

  _error(code, message) {
    return new WallpaperHostError(code, message);
  }

  _start() {
    if (this.proc) return this.proc;
    const proc = this.spawnImpl(
      this.executablePath,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
      { windowsHide: true }
    );
    this.proc = proc;
    this.ready = false;
    this.buf = '';
    if (proc.stdout && typeof proc.stdout.setEncoding === 'function') proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._onData(proc, chunk));
    // An unread stderr pipe fills up and then blocks the process on its next write.
    if (proc.stderr && typeof proc.stderr.on === 'function') proc.stderr.on('data', () => {});
    // A write to a process that has just died fails on the pipe as well as in the write
    // callback. Unheard, that pipe error would be thrown in the main process.
    if (proc.stdin && typeof proc.stdin.on === 'function') {
      proc.stdin.on('error', () => this._end(proc, 'process_lost', 'wallpaper host input failed'));
    }
    proc.on('exit', () => this._terminate(proc, this._error('process_lost', 'wallpaper host exited')));
    proc.on('error', () => this._terminate(proc, this._error('process_lost', 'wallpaper host failed')));
    this.startTimer = this.setTimer(() => {
      if (this.proc !== proc || this.ready) return;
      this._end(proc, 'start_timeout', 'wallpaper host did not start');
    }, this.startupTimeoutMs);
    return proc;
  }

  _onData(proc, chunk) {
    if (this.proc !== proc) return;
    this.buf += String(chunk);
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line.startsWith(READY)) {
        if (line !== READY_LINE) {
          this._end(proc, 'protocol_error', 'wallpaper host speaks another protocol');
          return;
        }
        this._onReady(proc);
      } else if (line.startsWith(RESP)) {
        if (!this._onResponse(proc, line.slice(RESP.length))) return;
      }
      // any other line (Add-Type noise, etc.) is ignored
    }
    if (this.buf.length > FRAME_LIMIT) this._end(proc, 'protocol_error', 'wallpaper host line is too long');
  }

  _onReady(proc) {
    if (this.ready) return;
    this.ready = true;
    if (this.startTimer) this.clearTimer(this.startTimer);
    this.startTimer = null;
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.resolve(proc);
  }

  // False when the answer ended this generation.
  _onResponse(proc, text) {
    let message = null;
    try { message = JSON.parse(text); } catch {}
    const id = message && typeof message === 'object' ? message.id : undefined;
    if (!this.ready || !Number.isSafeInteger(id) || id <= 0) {
      // Nobody can tell whose answer this is. Handing it to whoever waits longest is
      // exactly how a late answer used to land on the wrong command.
      this._end(proc, 'protocol_error', 'wallpaper host sent an answer that matches no command');
      return false;
    }
    const item = this.pending.get(id);
    if (!item) return true;
    this.pending.delete(id);
    this.clearTimer(item.timer);
    item.resolve(message);
    return true;
  }

  _kill(proc) {
    try { this.killProcess(proc); } catch {}
  }

  _end(proc, code, message) {
    if (this.proc !== proc) return;
    this._kill(proc);
    this._terminate(proc, this._error(code, message));
  }

  // Ends one generation and settles every call waiting on it. Idempotent, and a no-op
  // for any process that is no longer the current one.
  _terminate(proc, error) {
    if (this.proc !== proc) return;
    this.proc = null;
    this.ready = false;
    this.buf = '';
    if (this.startTimer) this.clearTimer(this.startTimer);
    this.startTimer = null;
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) {
      this.clearTimer(item.timer);
      item.reject(error);
    }
  }

  _whenReady(timeoutMs) {
    if (this.disposed) return Promise.reject(this._error('disposed', 'wallpaper host is disposed'));
    if (this.proc && this.ready) return Promise.resolve(this.proc);
    try {
      this._start();
    } catch {
      return Promise.reject(this._error('start_failed', 'wallpaper host could not be started'));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        timer: null,
        resolve: (proc) => { this.clearTimer(waiter.timer); resolve(proc); },
        reject: (error) => { this.clearTimer(waiter.timer); reject(error); },
      };
      // Giving up waiting removes only this caller. The start itself goes on: it has
      // its own deadline, and ending it here would restart it for every short caller.
      waiter.timer = this.setTimer(() => {
        const index = this.readyWaiters.indexOf(waiter);
        if (index >= 0) this.readyWaiters.splice(index, 1);
        reject(this._error('start_timeout', 'wallpaper host was not ready in time'));
      }, timeoutMs);
      this.readyWaiters.push(waiter);
    });
  }

  async send(cmd, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    const proc = await this._whenReady(timeoutMs);
    // The process that became ready may have been ended since (dispose, exit).
    if (this.proc !== proc || !this.ready) throw this._error('process_lost', 'wallpaper host is gone');
    const id = this.nextId;
    this.nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1;
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(this._error('timeout', 'wallpaper host command timed out'));
        // A command that does not come back means the process is wedged, and every
        // command queued behind it would wait just as long. End this generation; the
        // next command starts a fresh one.
        this._end(proc, 'process_lost', 'wallpaper host was ended after a timeout');
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const inputFailed = () => {
        if (this.pending.has(id)) this._end(proc, 'process_lost', 'wallpaper host did not take the command');
      };
      try {
        proc.stdin.write(JSON.stringify({ ...cmd, id }) + '\n', 'utf8', (error) => { if (error) inputFailed(); });
      } catch {
        inputFailed();
      }
    });
  }

  async enumMonitors(timeoutMs) {
    const r = await this.send({ op: 'enum' }, timeoutMs);
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'enum failed');
    const m = r.monitors;
    return Array.isArray(m) ? m : (m ? [m] : []);
  }

  async apply(position, items, timeoutMs) {
    const r = await this.send({ op: 'apply', position, items }, timeoutMs);
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'apply failed');
    return true;
  }

  // current position + per-monitor wallpaper (read-only). Useful for tests/diagnostics.
  async get(timeoutMs) {
    const r = await this.send({ op: 'get' }, timeoutMs);
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'get failed');
    const items = Array.isArray(r.items) ? r.items : (r.items ? [r.items] : []);
    return { position: r.position, items };
  }

  async checkFullscreen(timeoutMs) {
    const r = await this.send({ op: 'check-fullscreen' }, timeoutMs);
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'check-fullscreen failed');
    return !!r.busy;
  }

  async checkMaximized(timeoutMs) {
    const r = await this.send({ op: 'check-maximized' }, timeoutMs);
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'check-maximized failed');
    return Array.isArray(r.coveredMonitors) ? r.coveredMonitors : (r.coveredMonitors ? [r.coveredMonitors] : []);
  }

  // For quitting: nothing may be left waiting, and no process is started afterwards.
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const proc = this.proc;
    if (!proc) return;
    try { proc.stdin.end(); } catch {}
    this._kill(proc);
    this._terminate(proc, this._error('disposed', 'wallpaper host was disposed'));
  }
}

module.exports = { WallpaperHost, WallpaperHostError, HOST_SCRIPT, READY_LINE, PROTOCOL_VERSION };
