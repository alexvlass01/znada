'use strict';

// Load the REAL main.js against a stubbed Electron and a temporary profile, then run
// its IPC handlers directly.
//
// Why this exists: four consecutive reviews found defects that every module suite
// passed straight through. The modules were individually correct; what was wrong was
// the ORDER main.js called them in, what it saved afterwards, and what it re-checked
// before touching a file. Tests that grep main.js for a string cannot see any of that
// — they prove a line exists, not that it runs at the right moment — and they reported
// green for bugs that lost tags and left photos active after being removed.
//
// So the handlers are executed for real, over a real temp directory, and the assertions
// are about the resulting files and config. Nothing here is mocked except Electron.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');

function makeTempProfile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lumina-${label}-`));
  fs.mkdirSync(path.join(dir, 'wallpapers'), { recursive: true });
  return dir;
}

// Minimal Electron surface: enough for main.js to finish loading and register its
// handlers. app.whenReady() deliberately NEVER resolves, so window creation, the tray,
// the PowerShell host and every timer stay out of the test while the top-level
// ipcMain.handle() registrations still run.
function makeElectronStub(userData, options = {}) {
  const handlers = new Map();
  const calls = {
    dialogs: [],
    trashed: [],
    notifications: [],
    shortcuts: [],
    loginItems: [],
    hotkeys: [],
    hotkeyRegistered: new Set(),
    hotkeysSuspended: false,
  };
  const listeners = new Map();
  const on = (map) => (event, fn) => {
    if (!map.has(event)) map.set(event, []);
    map.get(event).push(fn);
  };

  const app = {
    isQuitting: false,
    getPath: (key) => (key === 'userData' ? userData : path.join(userData, key)),
    setPath: () => {},
    getAppPath: () => ROOT,
    getVersion: () => '0.0.0-test',
    getName: () => 'Znada',
    getLocale: () => 'en-US',
    requestSingleInstanceLock: () => true,
    releaseSingleInstanceLock: () => {},
    quit: () => {},
    exit: () => {},
    relaunch: () => {},
    // Записываем, а не глотаем: смысл теста BUG-013 в том, ПЫТАЛОСЬ ли
    // приложение тронуть автозапуск, а не в том, что получилось.
    setLoginItemSettings: (settings) => { calls.loginItems.push(settings); },
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setAppUserModelId: () => {},
    disableHardwareAcceleration: () => {},
    commandLine: { appendSwitch: () => {} },
    whenReady: () => new Promise(() => {}),   // never ready: skip the whole startup block
    on: on(listeners),
    once: on(listeners),
    removeAllListeners: () => {},
  };

  const noopWindowClass = class BrowserWindow {
    constructor() { this.webContents = { send: () => {}, on: () => {}, session: { webRequest: { onHeadersReceived: () => {} } } }; }
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
    on() {} once() {} loadFile() {} show() {} hide() {} destroy() {}
    isDestroyed() { return true; }
    setTitleBarOverlay() {}
  };

  return {
    handlers,
    calls,
    electron: {
      app,
      BrowserWindow: noopWindowClass,
      Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} destroy() {} setImage() {} },
      Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
      ipcMain: {
        handle: (channel, fn) => handlers.set(channel, fn),
        on: () => {},
        removeHandler: (channel) => handlers.delete(channel),
      },
      nativeTheme: { shouldUseDarkColors: false, on: () => {} },
      dialog: {
        showMessageBox: async (...args) => {
          calls.dialogs.push(args[args.length - 1]);
          const answer = typeof options.onDialog === 'function'
            ? await options.onDialog(args[args.length - 1])
            : 0;
          return { response: answer };
        },
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
      shell: {
        openExternal: () => {},
        openPath: () => {},
        // Writes a real placeholder file inside the temp profile and records what it
        // was pointed at. Leaving this out of the stub made every shortcut test pass
        // for the wrong reason: the call threw, main.js caught it, and "nothing was
        // created" looked identical whether the guard under test was there or not.
        writeShortcutLink: (lnkPath, details) => {
          calls.shortcuts.push({ path: lnkPath, target: details && details.target });
          try {
            fs.mkdirSync(path.dirname(lnkPath), { recursive: true });
            fs.writeFileSync(lnkPath, JSON.stringify(details || {}), 'utf8');
            return true;
          } catch { return false; }
        },
        // The real thing moves a file to the Windows Recycle Bin. A test must never do
        // that to the machine it runs on, so the file is deleted from the temp profile
        // and recorded — the assertions are about WHICH files were passed here.
        trashItem: async (target) => {
          if (typeof options.onTrash === 'function') await options.onTrash(target);
          calls.trashed.push(target);
          try { fs.rmSync(target, { force: true }); } catch {}
        },
      },
      nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }), createEmpty: () => ({}) },
      screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, bounds: {}, scaleFactor: 1 }), on: () => {} },
      autoUpdater: { on: () => {}, setFeedURL: () => {}, checkForUpdates: () => {}, quitAndInstall: () => {} },
      globalShortcut: {
        register: (accelerator) => {
          calls.hotkeys.push(['register', accelerator]);
          if (options.refusedHotkeys && options.refusedHotkeys.has(accelerator)) return false;
          calls.hotkeyRegistered.add(accelerator);
          return true;
        },
        unregister: (accelerator) => {
          calls.hotkeys.push(['unregister', accelerator]);
          calls.hotkeyRegistered.delete(accelerator);
        },
        unregisterAll: () => calls.hotkeyRegistered.clear(),
        isRegistered: (accelerator) => calls.hotkeyRegistered.has(accelerator),
        setSuspended: (value) => {
          calls.hotkeys.push(['suspend', !!value]);
          calls.hotkeysSuspended = !!value;
        },
      },
      powerMonitor: { on: () => {} },
      safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
      Notification: class { constructor() {} show() {} on() {} static isSupported() { return false; } },
      clipboard: { writeText: () => {} },
      webContents: { getAllWebContents: () => [] },
    },
  };
}

// NOTHING in these tests may reach the real machine. Applying a wallpaper runs
// PowerShell, and the legacy fallback sets the wallpaper for the WHOLE desktop through
// SystemParametersInfo — a test profile does not isolate that. So no child process is
// ever started: every spawn returns a dead stub, the apply fails, and main's own
// fallback handling is exercised instead.
function makeChildProcessStub() {
  const { EventEmitter } = require('events');
  const { PassThrough } = require('stream');
  const dead = () => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {};
    proc.killed = false;
    proc.pid = -1;
    setImmediate(() => {
      // 'error' only when somebody is listening: an unhandled 'error' event would take
      // the whole test process down instead of exercising main's failure handling.
      if (proc.listenerCount('error')) proc.emit('error', new Error('child processes are disabled in tests'));
      proc.stdout.end();
      proc.stderr.end();
      proc.emit('exit', 1, null);
      proc.emit('close', 1, null);
    });
    return proc;
  };
  const failCb = (...args) => {
    const cb = args.find((a) => typeof a === 'function');
    if (cb) setImmediate(() => cb(new Error('child processes are disabled in tests'), '', ''));
    return dead();
  };
  return {
    spawn: dead,
    fork: dead,
    exec: failCb,
    execFile: failCb,
    execSync: () => { throw new Error('child processes are disabled in tests'); },
    execFileSync: () => { throw new Error('child processes are disabled in tests'); },
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'disabled', error: new Error('disabled') }),
  };
}

// Swap 'electron' (and the Squirrel startup shim, which is a real dependency that pokes
// at the filesystem) for the stub while main.js loads.
function loadMain(userData, options = {}) {
  const stub = makeElectronStub(userData, options);
  const childStub = makeChildProcessStub();
  const originalLoad = Module._load;
  const originalArgv = process.argv.slice();
  process.argv = [process.argv[0], ...(options.argv || [])];
  if (!options.argv) process.argv = [process.argv[0], path.join(ROOT, 'main.js')];
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return stub.electron;
    if (request === 'electron-squirrel-startup') return false;
    if (request === 'child_process' || request === 'node:child_process') return childStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  let api;
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'main.js'))];
    api = require(path.join(ROOT, 'main.js'));
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
  }
  const invoke = (channel, ...args) => {
    const fn = stub.handlers.get(channel);
    if (!fn) throw new Error(`no IPC handler registered for '${channel}'`);
    return fn({}, ...args);
  };
  return { ...api, invoke, handlers: stub.handlers, calls: stub.calls, userData };
}

// main.js is a singleton (module-level `config`, one writer, one lock). Tests therefore
// run one profile at a time and drop the module cache in between.
function unloadMain() {
  const key = require.resolve(path.join(ROOT, 'main.js'));
  const loaded = require.cache[key];
  if (loaded && loaded.exports && loaded.exports.__test) {
    try { loaded.exports.__test.disposeForTests(); } catch {}
  }
  delete require.cache[key];
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function writeImage(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Smallest thing that passes the extension check and has real bytes on disk.
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a', 'hex'));
  return file;
}

module.exports = { makeTempProfile, loadMain, unloadMain, writeJson, writeImage, ROOT };
