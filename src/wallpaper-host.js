'use strict';

// Persistent PowerShell COM host for setting per-monitor wallpapers.
//
// WHY: the old approach spawned a fresh powershell.exe for every operation, and
// each one ran `Add-Type` which JIT-compiles the C# IDesktopWallpaper interop
// (~0.5-1s CPU per call). That's wasteful for the slideshow / frequent changes.
// Here we keep ONE long-lived powershell.exe, compile the interop ONCE, then send
// newline-delimited JSON commands over stdin and read one JSON line per response.
//
// Protocol: host prints `@@READY@@` once the interop is compiled, then for each
// command line it prints `@@R@@<json>`. UTF-8 both ways so Cyrillic paths work.
// main.js uses this as a FAST PATH with a full fallback to spawn-per-call, so a
// host failure never stops wallpapers from being set.

const { spawn } = require('child_process');

const READY = '@@READY@@';
const RESP = '@@R@@';

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
[Console]::Out.WriteLine('${READY}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Trim() -eq '') { continue }
  try {
    $cmd = $line | ConvertFrom-Json
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
  [Console]::Out.WriteLine('${RESP}' + ($out | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
`;

class WallpaperHost {
  constructor(scriptPath) {
    this.scriptPath = scriptPath;
    this.proc = null;
    this.buf = '';
    this.queue = [];          // FIFO of pending { resolve, reject, timer }
    this.ready = false;
    this.readyWaiters = [];
  }

  _start() {
    if (this.proc) return;
    this.ready = false;
    this.buf = '';
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
      { windowsHide: true }
    );
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => this._onData(d));
    proc.on('exit', () => this._onExit());
    proc.on('error', () => this._onExit());
  }

  _onExit() {
    const err = new Error('wallpaper host exited');
    for (const item of this.queue) { clearTimeout(item.timer); item.reject(err); }
    this.queue = [];
    for (const w of this.readyWaiters) w.reject(err);
    this.readyWaiters = [];
    this.proc = null;
    this.ready = false;
  }

  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line === READY) {
        this.ready = true;
        for (const w of this.readyWaiters) w.resolve();
        this.readyWaiters = [];
      } else if (line.startsWith(RESP)) {
        const item = this.queue.shift();
        if (!item) continue;
        clearTimeout(item.timer);
        try { item.resolve(JSON.parse(line.slice(RESP.length))); }
        catch (e) { item.reject(e); }
      }
      // any other line (Add-Type noise, etc.) is ignored
    }
  }

  _whenReady(timeoutMs) {
    if (this.ready) return Promise.resolve();
    this._start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('host start timeout')), timeoutMs);
      this.readyWaiters.push({
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  async send(cmd, timeoutMs = 8000) {
    await this._whenReady(timeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((q) => q.timer === timer);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error('host command timeout'));
        try { this.proc && this.proc.kill(); } catch {} // wedged → respawn next time
      }, timeoutMs);
      this.queue.push({ resolve, reject, timer });
      try { this.proc.stdin.write(JSON.stringify(cmd) + '\n', 'utf8'); }
      catch { /* exit/timeout handlers will reject */ }
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

  dispose() {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch {}
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }
}

module.exports = { WallpaperHost, HOST_SCRIPT };
