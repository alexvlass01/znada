'use strict';

// CODE-001 1.4: Windows wallpaper transport and monitor enumeration. Selection,
// playlists, scheduler intent and the monitor snapshot stay with main.js. Each
// instance owns its host and script paths; all process launches use main's runner.
const fs = require('fs');
const path = require('path');

function create(deps) {
  const { userDataPath, getConfig, systemChildren, powershellExe: POWERSHELL_EXE,
    getPowerShellTimeout, createHost, hostScript: HOST_SCRIPT } = deps;

  const STYLE_MAP = {
    fill: { style: 10, tile: 0 },
    fit: { style: 6, tile: 0 },
    stretch: { style: 2, tile: 0 },
    center: { style: 0, tile: 0 },
    tile: { style: 0, tile: 1 },
    span: { style: 22, tile: 0 },
  };

  const PS_SCRIPT_PATH = path.join(userDataPath, 'set-wallpaper.ps1');

  const PS_SCRIPT = `param([string]$Path,[int]$Style,[int]$Tile)
Set-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name WallpaperStyle -Value $Style.ToString()
Set-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name TileWallpaper -Value $Tile.ToString()
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeWallpaper {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
"@
# SPI_SETDESKWALLPAPER = 20, SPIF_UPDATEINIFILE | SPIF_SENDWININICHANGE = 3
[NativeWallpaper]::SystemParametersInfo(20, 0, $Path, 3) | Out-Null
`;

  function ensurePsScript() {
    try {
      fs.mkdirSync(path.dirname(PS_SCRIPT_PATH), { recursive: true });
      fs.writeFileSync(PS_SCRIPT_PATH, PS_SCRIPT, 'utf8');
    } catch (err) {
      console.error('Не удалось записать PS-скрипт:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-monitor wallpaper via IDesktopWallpaper COM (PowerShell + Add-Type)
  // ---------------------------------------------------------------------------
  const COM_SCRIPT_PATH = path.join(userDataPath, 'wallpaper-com.ps1');
  const APPLY_DATA_PATH = path.join(userDataPath, 'apply.json');

  // our style names -> DESKTOP_WALLPAPER_POSITION
  const COM_POS = { center: 0, tile: 1, stretch: 2, fit: 3, fill: 4, span: 5 };

  const COM_SCRIPT = `param([string]$Mode='enum',[string]$DataFile='')
$ErrorActionPreference='Stop'
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
}
public static class DW {
  static IDesktopWallpaper _i;
  static IDesktopWallpaper I { get { if(_i==null){ _i=(IDesktopWallpaper)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD"))); } return _i; } }
  public static uint Count(){ return I.GetMonitorDevicePathCount(); }
  public static string PathAt(uint i){ return I.GetMonitorDevicePathAt(i); }
  public static int[] Rect(string id){ var r=I.GetMonitorRECT(id); return new int[]{r.Left,r.Top,r.Right,r.Bottom}; }
  public static void SetPosition(int p){ I.SetPosition(p); }
  public static void SetWallpaper(string id,string p){ I.SetWallpaper(id,p); }

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
}
"@
if ($Mode -eq 'enum') {
  $list = New-Object System.Collections.ArrayList
  $n = [DW]::Count()
  for ($i=0; $i -lt $n; $i++) {
    $id = [DW]::PathAt([uint32]$i)
    try { $r = [DW]::Rect($id) } catch { continue }
    [void]$list.Add([pscustomobject]@{ id=$id; x=$r[0]; y=$r[1]; w=($r[2]-$r[0]); h=($r[3]-$r[1]) })
  }
  ConvertTo-Json -InputObject @($list) -Compress
} elseif ($Mode -eq 'apply') {
  $data = Get-Content -LiteralPath $DataFile -Raw -Encoding utf8 | ConvertFrom-Json
  [DW]::SetPosition([int]$data.position)
  foreach ($it in $data.items) { [DW]::SetWallpaper([string]$it.id, [string]$it.path) }
} elseif ($Mode -eq 'check-fullscreen') {
  [DW]::IsUserBusy()
}
`;

  function ensureComScript() {
    try {
      fs.mkdirSync(path.dirname(COM_SCRIPT_PATH), { recursive: true });
      fs.writeFileSync(COM_SCRIPT_PATH, COM_SCRIPT, 'utf8');
    } catch (err) {
      console.error('Не удалось записать COM-скрипт:', err);
    }
  }

  function runCom(args) {
    return systemChildren.run(
      POWERSHELL_EXE,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', COM_SCRIPT_PATH, ...args],
      { timeoutMs: getPowerShellTimeout(), maxBuffer: 4 * 1024 * 1024 }
    ).then((result) => result.stdout);
  }

  // Живой PowerShell-хост: компилирует COM один раз, дальше применяет обои мгновенно
  // (~1 мс вместо ~400 мс на spawn+Add-Type). Быстрый путь; при сбое — фоллбек на runCom.
  const COM_HOST_SCRIPT_PATH = path.join(userDataPath, 'wallpaper-host.ps1');
  function ensureComHostScript() {
    try {
      fs.mkdirSync(path.dirname(COM_HOST_SCRIPT_PATH), { recursive: true });
      fs.writeFileSync(COM_HOST_SCRIPT_PATH, HOST_SCRIPT, 'utf8');
    } catch (err) {
      console.error('Не удалось записать COM-host-скрипт:', err);
    }
  }
  // The host runs PowerShell from System32 on its own (WIN-002). Its Add-Type starts csc.exe
  // under it, so ending the host ends that too.
  const wpHost = createHost(COM_HOST_SCRIPT_PATH);

  async function isGameOrFullscreenRunning() {
    if (!getConfig().gameModeBlock) return false;
    try {
      const isBusy = await wpHost.checkFullscreen();
      return !!isBusy;
    } catch (err) {
      console.error('[GameMode] Error checking fullscreen via host:', err);
      try {
        const out = await runCom(['-Mode', 'check-fullscreen']);
        return out.trim() === 'True';
      } catch (fallbackErr) {
        console.error('[GameMode] Error checking fullscreen via fallback:', fallbackErr);
      }
    }
    return false;
  }

  async function getMonitors() {
    let list = null;
    try {
      list = await wpHost.enumMonitors(); // быстрый путь: живой COM-хост
    } catch (e1) {
      try {
        const out = await runCom(['-Mode', 'enum']); // фоллбек: spawn-per-call
        const parsed = JSON.parse((out || '').trim() || '[]');
        list = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e2) {
        console.error('Не удалось перечислить мониторы (COM):', e2);
        list = [];
      }
    }
    return (list || []).map((m) => ({
      id: m.id,
      x: m.x, y: m.y, w: m.w, h: m.h,
      primary: m.x === 0 && m.y === 0,
    }));
  }

  function setWallpaper(imagePath) {
    if (!imagePath || !fs.existsSync(imagePath)) {
      return Promise.reject(new Error('Файл обоев не найден: ' + imagePath));
    }
    const map = STYLE_MAP[getConfig().style] || STYLE_MAP.fill;
    return systemChildren.run(
      POWERSHELL_EXE,
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', PS_SCRIPT_PATH,
        '-Path', imagePath,
        '-Style', String(map.style),
        '-Tile', String(map.tile),
      ],
      { timeoutMs: getPowerShellTimeout() }
    ).then(() => undefined);
  }

  // Keep the cancellation boundary between the host and spawned COM attempts:
  // a scheduler intent can become stale while the host is answering. 'failed'
  // lets main select its existing single-wallpaper fallback; this layer never
  // chooses library files or changes playlist positions.
  async function applyPerMonitor(items, superseded) {
    const style = getConfig().style;
    const pos = COM_POS[style] != null ? COM_POS[style] : 4;
    try {
      await wpHost.apply(pos, items); // быстрый путь: живой COM-хост (без перекомпиляции)
      return 'applied';
    } catch (eHost) {
      if (superseded()) return 'superseded'; // no second try for a wish that went stale meanwhile
      try {
        fs.writeFileSync(APPLY_DATA_PATH, JSON.stringify({ position: pos, items }), 'utf8');
        await runCom(['-Mode', 'apply', '-DataFile', APPLY_DATA_PATH]); // фоллбек: spawn-per-call
        return 'applied';
      } catch (err) {
        console.error('Ошибка применения per-monitor (COM), пробую legacy single:', err);
        // fall through to legacy single
      }
    }
    return 'failed';
  }

  async function checkCovered() {
    try { return await wpHost.checkMaximized(2000); } catch { return []; }
  }

  function ensureScripts() {
    ensurePsScript();
    ensureComScript();
    ensureComHostScript();
  }

  return Object.freeze({
    ensureScripts, getMonitors, isGameOrFullscreenRunning, applyPerMonitor,
    setWallpaper, checkCovered, dispose: () => wpHost.dispose(),
  });
}

module.exports = { create };
