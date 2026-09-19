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
const { pathToFileURL } = require('url');

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
    opened: [],
    // COLLAB-003. How a launch ends and what it announces are the behaviour under test
    // there: a refused launch must exit before opening a profile, a busy one must quit,
    // and the hour must end through quit, not exit. Recorded rather than swallowed.
    singleInstanceLock: [],
    quit: 0,
    exit: [],
    errorBoxes: [],
    windows: [],
    trayTooltips: [],
    appUserModelIds: [],
  };
  const listeners = new Map();
  const on = (map) => (event, fn) => {
    if (!map.has(event)) map.set(event, []);
    map.get(event).push(fn);
  };
  // Lets a test deliver an app event (second-instance, before-quit) the way Electron would.
  const emit = (event, ...args) => {
    for (const fn of (listeners.get(event) || []).slice()) fn(...args);
  };

  const app = {
    isQuitting: false,
    // Tests run from source, never from a packaged build, and some gates ask. Left
    // undefined it defaulted to "packaged", which quietly closed the diagnostics gate
    // and made a test about diagnostics measure the ordinary path instead. A test that is
    // ABOUT the packaged build says so explicitly.
    isPackaged: options.isPackaged === true,
    getPath: (key) => (key === 'userData' ? userData : path.join(userData, key)),
    setPath: () => {},
    getAppPath: () => ROOT,
    getVersion: () => '0.0.0-test',
    getName: () => 'Znada',
    getLocale: () => 'en-US',
    requestSingleInstanceLock: (...args) => {
      calls.singleInstanceLock.push(args);
      return options.singleInstanceLock !== false;
    },
    releaseSingleInstanceLock: () => {},
    // Quitting runs the quit-time handlers only when a test asks for it: most tests load
    // main.js to drive a handler, and flushing writers behind their back would change
    // what they measure.
    quit: () => {
      calls.quit += 1;
      if (options.emitQuitEvents) {
        emit('before-quit', {});
        emit('will-quit', {});
      }
    },
    exit: (code) => { calls.exit.push(code); },
    relaunch: () => {},
    // Записываем, а не глотаем: смысл теста BUG-013 в том, ПЫТАЛОСЬ ли
    // приложение тронуть автозапуск, а не в том, что получилось.
    setLoginItemSettings: (settings) => { calls.loginItems.push(settings); },
    getLoginItemSettings: () => ({ openAtLogin: false }),
    // Recorded: it is the first statement of the startup block, so a test can tell that the block
    // really began instead of never having been reached.
    setAppUserModelId: (id) => { calls.appUserModelIds.push(id); },
    disableHardwareAcceleration: () => {},
    commandLine: { appendSwitch: () => {} },
    // Never ready by default: the whole startup block stays out of the test. `whenReady: 'resolve'`
    // lets it begin — meant ONLY for a launch that did not get the profile lock (BUG-044), where the
    // block has to stop at once. With the lock held it would run the real startup under the stubs.
    whenReady: options.whenReady === 'resolve' ? () => Promise.resolve() : () => new Promise(() => {}),
    on: on(listeners),
    once: on(listeners),
    removeAllListeners: () => {},
  };

  // A window that is never really opened, but remembers what it was created with and
  // what listened to it: the title and the page arguments are what a launch decides.
  const windowClass = class BrowserWindow {
    constructor(windowOptions) {
      this.options = windowOptions || {};
      this.listeners = new Map();
      this.webContents = { send: () => {}, on: () => {}, session: { webRequest: { onHeadersReceived: () => {} } } };
      calls.windows.push(this);
    }
    static getAllWindows() { return []; }
    static fromWebContents() { return null; }
    on(event, fn) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(fn);
    }
    once(event, fn) { this.on(event, fn); }
    loadFile() {} show() {} hide() {} destroy() {}
    isDestroyed() { return true; }
    setTitleBarOverlay() {}
  };

  return {
    handlers,
    calls,
    emit,
    electron: {
      app,
      BrowserWindow: windowClass,
      Tray: class { constructor() {} setToolTip(tip) { calls.trayTooltips.push(tip); } setContextMenu() {} on() {} destroy() {} setImage() {} },
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
        // Cancelled, deliberately: a test asking "was this file allowed through" wants to
        // see the handler REACH the dialog, not to write a file. A cancel is reported
        // differently from a refusal, so the two are easy to tell apart.
        showSaveDialog: async () => ({ canceled: true, filePath: '' }),
        showErrorBox: (title, content) => { calls.errorBoxes.push({ title, content }); },
      },
      shell: {
        // A promise, because main chains .catch() onto it. Returning undefined threw a
        // TypeError inside a listen callback, which took the whole process down rather
        // than failing the call - so nothing had ever driven sign-in here.
        openExternal: async (url) => { calls.opened.push(url); },
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
      screen: {
        getAllDisplays: () => [],
        getPrimaryDisplay: () => ({ id: 1, bounds: {}, scaleFactor: 1 }),
        // Where the viewer opens. Enough for main to create that window under the stub.
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({
          id: 1,
          bounds: { x: 0, y: 0, width: 1280, height: 720 },
          workArea: { x: 0, y: 0, width: 1280, height: 680 },
        }),
        on: () => {},
      },
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
      safeStorage: options.safeStorage
        || { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
      Notification: class { constructor() {} show() {} on() {} static isSupported() { return false; } },
      clipboard: { writeText: () => {} },
      protocol: {
        registeredSchemes: [],
        handlers: new Map(),
        registerSchemesAsPrivileged(list) {
          this.registeredSchemes.push(...(Array.isArray(list) ? list : []));
        },
        handle(scheme, handler) { this.handlers.set(scheme, handler); },
      },
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
  // A test may put back ONE child-process function with a fake of its own (COLLAB-003
  // answers `git status` with a known revision). Everything else stays disabled.
  const childStub = { ...makeChildProcessStub(), ...(options.childProcess || {}) };
  const originalLoad = Module._load;
  const originalArgv = process.argv.slice();
  // A packaged Electron always has `process.resourcesPath`, and main.js resolves the
  // thumbnail helper from it while loading. Plain Node has none, so a test that loads main
  // AS a packaged build gets a stand-in for the length of the load, and nothing more.
  const hadResourcesPath = Object.prototype.hasOwnProperty.call(process, 'resourcesPath');
  const originalResourcesPath = process.resourcesPath;
  if (stub.electron.app.isPackaged && !process.resourcesPath) {
    process.resourcesPath = path.join(userData, 'resources');
  }
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
    // Only main.js is dropped from the cache, so a provider module keeps whatever it
    // learned in the previous test — Gelbooru caches tag kinds process-wide on purpose.
    // `resetState` is the hook a site declares for exactly this, and until now nothing
    // called it, so the protection its comment describes did not actually exist.
    for (const descriptor of require(path.join(ROOT, 'src', 'provider-registry')).PROVIDERS) {
      if (typeof descriptor.resetState === 'function') descriptor.resetState();
    }
    api = require(path.join(ROOT, 'main.js'));
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
    if (!hadResourcesPath) delete process.resourcesPath;
    else process.resourcesPath = originalResourcesPath;
  }
  // SEC-002. Handlers now refuse anything that is not one of Znada's own windows, on its
  // own page, in its top frame. The harness therefore has to BE one: stand-in webContents
  // are registered through the real authority and events are shaped the way Electron
  // shapes them. Nothing here bypasses the guard — a seam that did would make every test
  // above it meaningless.
  const roleFiles = {
    main: path.join(ROOT, 'renderer', 'index.html'),
    viewer: path.join(ROOT, 'renderer', 'viewer.html'),
    diagnostics: path.join(ROOT, 'diagnostics', 'ui', 'control.html'),
  };
  const senders = {};
  const authority = api && api.__test && api.__test.ipcAuthority;
  if (authority) {
    for (const [role, file] of Object.entries(roleFiles)) {
      const frame = { url: pathToFileURL(file).href };
      const contents = { mainFrame: frame };
      authority.register(contents, role, frame.url);
      senders[role] = { sender: contents, senderFrame: frame };
    }
  }
  const roles = authority ? authority.roles() : {};
  // Whichever window really owns the channel, so a test does not have to know. Explicit
  // cases use invokeAs / invokeRaw.
  const roleFor = (channel) => (Array.isArray(roles[channel]) && roles[channel][0]) || 'main';
  const eventFor = (role) => senders[role] || {};
  const invokeRaw = (event, channel, ...args) => {
    const fn = stub.handlers.get(channel);
    if (!fn) throw new Error(`no IPC handler registered for '${channel}'`);
    return fn(event, ...args);
  };
  const invoke = (channel, ...args) => invokeRaw(eventFor(roleFor(channel)), channel, ...args);
  const invokeAs = (role, channel, ...args) => invokeRaw(eventFor(role), channel, ...args);
  return {
    ...api,
    invoke,
    invokeAs,
    invokeRaw,
    senders,
    handlers: stub.handlers,
    protocol: stub.electron.protocol,
    calls: stub.calls,
    app: stub.electron.app,
    emitApp: stub.emit,
    userData,
  };
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
