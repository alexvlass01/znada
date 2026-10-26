'use strict';

// SEC-002, slice 1: who is allowed to call an IPC channel.
//
// Znada has three windows and ninety-one channels between them. Fourteen channels
// checked their sender; the other seventy-seven asked nothing at all. Two consequences,
// both reachable without any exotic assumption:
//
//   * the fullscreen viewer's bridge exposes nineteen channels, but its WebContents
//     could call all ninety-one — the whole settings surface, the library, the updater;
//   * `event.sender` is the WebContents, and an <iframe> shares it with the page that
//     embeds it, so anything embedded in either window held that window's authority.
//
// And a third that is easy to miss: a window that navigates away keeps its WebContents
// identity and its preload bridge. Without a check that it is still on the file we
// loaded, it keeps the authority of the page it used to be.
//
// The guard is a module (src/ipc-authority.js) so the rules can be driven directly, and
// the table it enforces lives in main.js. The last test here reads the three preload
// bridges back off disk and compares them to that table, because a capability list that
// drifts from the bridge it describes is worse than no list: it reads as a decision.
//
// Run: node test/ipc-authority.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const authority = require('../src/ipc-authority');
const H = require('./helpers/main-harness');
const { mainProcessSources, walk, keyName, writtenName, useOf, writtenInto } = require('./helpers/main-process-sources');
const { ipcRegistrations } = require('./helpers/ipc-registrations');
const { makeTempDir } = require('./helpers/temp-dir');

// Electron's ways to an existing window; none of them makes one.
const WINDOW_LOOKUPS = new Set(['fromWebContents', 'fromId', 'fromBrowserView', 'getAllWindows', 'getFocusedWindow']);

// Every window the main-process code constructs, and where each one does not spread the
// shared decision into the webPreferences written out at the call. A window is counted where
// BrowserWindow is constructed under that name, written however the text likes (new
// BrowserWindow, new deps.BrowserWindow, new (t ? BrowserWindow : X)). So BrowserWindow may
// travel only under its own name: const { BrowserWindow } = require('electron'), handed on as
// { BrowserWindow } or deps.BrowserWindow, and looked up with the calls above. Renamed
// (the fourth re-review: const { BrowserWindow: Window } = deps; new Window(…)), handed to a
// function by position, subclassed or read as a string, it would make windows this does not
// count, so that throws, with the place, rather than passing with a count of three.
function windowsIn(sources) {
  const isDecision = (node) => {
    if (node.type !== 'SpreadElement' || node.argument.type !== 'CallExpression') return false;
    const written = writtenName(node.argument.callee, node.argument);
    return !!written && written.name === 'windowSecurity';
  };
  const windows = new Set(); // new (t ? BrowserWindow : deps.BrowserWindow)(…) is one window
  const unshared = [];
  for (const { file, ast } of sources) {
    walk(ast, (node, parent, ancestors) => {
      const written = writtenName(node, parent);
      if (!written || written.name !== 'BrowserWindow') return;
      const { use, at, property } = useOf(node, ancestors);
      if (use === 'kept' || use === 'looked' || (use === 'member' && WINDOW_LOOKUPS.has(property))) return;
      const line = node.loc.start.line;
      if (use !== 'constructed') {
        const how = use === 'member' ? `has .${property} read off it` : use === 'called' ? 'is called without new'
          : 'is handed on under another name or none';
        throw new Error(`${file}:${line}: BrowserWindow ${how}. The window check counts a window where BrowserWindow`
          + ' is constructed under that name, so hand it on only under that name ({ BrowserWindow }, deps.BrowserWindow).');
      }
      if (windows.has(at)) return;
      windows.add(at);
      const [options] = at.arguments;
      const prefs = options && options.type === 'ObjectExpression' && options.properties.find((p) => p.type === 'Property'
        && keyName(p) === 'webPreferences');
      if (!prefs || prefs.value.type !== 'ObjectExpression' || !prefs.value.properties.some(isDecision)) {
        unshared.push(`${file}:${at.loc.start.line}`);
      }
    });
  }
  return { count: windows.size, unshared };
}

// The three switches the shared decision owns, set by hand anywhere in main-process code:
// as a key of an object written out ({ sandbox: false }, { ['sandbox']: x }) or a property
// written into (prefs.sandbox = …, ({ x: prefs.sandbox } = o)), to anything but the safe value
// written as a plain literal; or named as a string that something receives
// (Reflect.set(prefs, 'sandbox', false), Object.defineProperty, const k = 'sandbox'). Only
// windowSecurity in main.js, which is that decision, may compute them. This used to be a
// search of the text for `sandbox: false`, which a comment before the value got past.
// A Chromium switch (app.commandLine.appendSwitch('no-sandbox')) turns the sandbox off for
// every window at once, past that decision; nothing in main uses one, so any is reported.
const SAFE_SWITCHES = { sandbox: true, contextIsolation: true, nodeIntegration: false };
const PROCESS_SWITCHES = new Set(['appendSwitch', 'appendArgument']);
function handSetSwitches(sources) {
  const found = [];
  const isSwitch = (name) => Object.prototype.hasOwnProperty.call(SAFE_SWITCHES, name);
  const safe = (name, value) => value.type === 'Literal' && value.value === SAFE_SWITCHES[name];
  for (const { file, ast } of sources) {
    const decision = new Set();
    if (file === 'main.js') {
      walk(ast, (node) => {
        if (node.type === 'FunctionDeclaration' && node.id.name === 'windowSecurity') walk(node, (inner) => decision.add(inner));
      });
    }
    walk(ast, (node, parent, ancestors) => {
      if (decision.has(node)) return;
      const at = `${file}:${node.loc.start.line}`;
      if (node.type === 'Property' && parent.type === 'ObjectExpression') {
        const name = keyName(node);
        if (isSwitch(name) && !safe(name, node.value)) found.push(`${at} ${name}`);
        return;
      }
      const written = writtenName(node, parent);
      if (!written) return;
      if (PROCESS_SWITCHES.has(written.name) && written.how !== 'name') { found.push(`${at} ${written.name}`); return; }
      if (!isSwitch(written.name)) return;
      if (writtenInto(node, ancestors)) {
        if (!(parent.type === 'AssignmentExpression' && parent.operator === '=' && safe(written.name, parent.right))) {
          found.push(`${at} ${written.name}`);
        }
      } else if (written.how === 'string' && useOf(node, ancestors).use !== 'looked') {
        found.push(`${at} '${written.name}'`);
      }
    });
  }
  return found;
}

// A throwaway project for the source checks: { 'relative/path': 'text' }, with the two folders
// the main-process set walks. The folder name has a space in it, as Windows profiles do.
function withProject(files, fn) {
  const root = makeTempDir('znada windows-');
  try {
    for (const [rel, text] of Object.entries({ 'diagnostics/main/.keep': '', 'src/.keep': '', ...files })) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    return fn(mainProcessSources(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

let passed = 0;
const failures = [];

function ok(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
    failures.push({ name, err });
  }
}

// A stand-in for one of Electron's windows: a WebContents whose top frame is on a URL.
function fakeWindow(url) {
  const frame = { url };
  const contents = { mainFrame: frame };
  return { contents, frame, event: { sender: contents, senderFrame: frame } };
}

function makeAuthority(roles) {
  const handlers = new Map();
  const quiet = { error: () => {} };
  const auth = authority.create({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    roles,
    log: quiet,
  });
  return { auth, handlers, call: (channel, event, ...args) => handlers.get(channel)(event, ...args) };
}

const HOME = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;
const VIEW = pathToFileURL(path.join(__dirname, '..', 'renderer', 'viewer.html')).href;

console.log('\nSEC-002: which window may call which channel\n');

// --- the four questions the guard asks ---------------------------------------

{
  const { auth, call } = makeAuthority({ 'main-only': ['main'], shared: ['main', 'viewer'] });
  const main = fakeWindow(HOME);
  const viewer = fakeWindow(VIEW);
  auth.register(main.contents, 'main', HOME);
  auth.register(viewer.contents, 'viewer', VIEW);
  auth.handle('main-only', () => 'ran');
  auth.handle('shared', () => 'ran');

  ok('the window a channel belongs to can call it',
    () => assert.strictEqual(call('main-only', main.event), 'ran'));

  ok('a channel both windows own can be called by both', () => {
    assert.strictEqual(call('shared', main.event), 'ran');
    assert.strictEqual(call('shared', viewer.event), 'ran');
  });

  ok('the viewer cannot call a channel only the main window has', () => {
    assert.throws(() => call('main-only', viewer.event), /E_IPC_DENIED/);
  });

  ok('a WebContents we never registered cannot call anything', () => {
    const stranger = fakeWindow(HOME);
    assert.throws(() => call('shared', stranger.event), /E_IPC_DENIED/);
  });

  ok('a frame inside the page cannot borrow the page\'s authority', () => {
    // An <iframe> shares the WebContents with the page that embeds it, which is exactly
    // why `event.sender` alone was never enough.
    const embedded = {
      sender: main.contents,
      senderFrame: { url: 'https://example.test/ad', parent: main.frame },
    };
    assert.throws(() => call('main-only', embedded), /E_IPC_DENIED/);
    // ...and the same holds when the frame is dressed as the page it sits in. Without
    // this the URL check alone was doing the work, and the top-frame rule was untested.
    const disguised = { sender: main.contents, senderFrame: { url: HOME, parent: main.frame } };
    assert.throws(() => call('main-only', disguised), /E_IPC_DENIED/);
  });

  ok('a window that has been navigated away loses its authority', () => {
    const moved = fakeWindow('https://example.test/');
    auth.register(moved.contents, 'main', HOME);
    assert.throws(() => call('main-only', moved.event), /E_IPC_DENIED/);
  });

  ok('a fragment or a query is not navigation away', () => {
    const same = fakeWindow(`${HOME}?bigmock=3#library`);
    auth.register(same.contents, 'main', HOME);
    assert.strictEqual(call('main-only', same.event), 'ran');
  });

  ok('an event with no frame at all is refused', () => {
    assert.throws(() => call('main-only', { sender: main.contents }), /E_IPC_DENIED/);
    assert.throws(() => call('main-only', {}), /E_IPC_DENIED/);
  });

  ok('a sender whose frame cannot be read is refused, not trusted', () => {
    const hostile = {
      sender: main.contents,
      get senderFrame() { throw new Error('frame is gone'); },
    };
    assert.throws(() => call('main-only', hostile), /E_IPC_DENIED/);
  });

  ok('a window that closed stops being a sender', () => {
    auth.forget(viewer.contents);
    assert.throws(() => call('shared', viewer.event), /E_IPC_DENIED/);
  });
}

// --- registration itself is deny-by-default ----------------------------------

ok('a channel nobody declared cannot even be registered', () => {
  const { auth } = makeAuthority({ known: ['main'] });
  assert.throws(() => auth.handle('undeclared', () => {}), /no declared role/);
});

ok('a channel declared for nobody is refused too', () => {
  const { auth } = makeAuthority({ orphan: [] });
  const win = fakeWindow(HOME);
  auth.register(win.contents, 'main', HOME);
  auth.handle('orphan', () => 'ran');
  assert.throws(() => auth.handle('orphan', () => {}), /twice/);
});

ok('the same channel cannot be registered twice', () => {
  const { auth } = makeAuthority({ once: ['main'] });
  auth.handle('once', () => {});
  assert.throws(() => auth.handle('once', () => {}), /twice/);
});

ok('a refused call never reaches the handler', () => {
  const { auth, call } = makeAuthority({ 'main-only': ['main'] });
  let ran = 0;
  auth.handle('main-only', () => { ran += 1; });
  assert.throws(() => call('main-only', fakeWindow(HOME).event), /E_IPC_DENIED/);
  assert.strictEqual(ran, 0, 'the handler ran for a sender that was refused');
});

// --- the table in main.js against the bridges that define it -----------------

(async () => {
  const dir = H.makeTempProfile('ipc-authority');
  const captured = [];
  const real = { log: console.log, error: console.error };
  try {
    console.log = (...a) => captured.push(a.join(' '));
    console.error = (...a) => captured.push(a.join(' '));
    const m = H.loadMain(dir);
    console.log = real.log; console.error = real.error;

    const roles = m.__test.ipcAuthority.roles();
    const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
    const invoked = (text) => new Set([...text.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((x) => x[1]));
    // QA-009. The diagnostics probe is its own preload script, registered only for a
    // diagnostics run, and it still runs inside the main and viewer windows. Whatever
    // it invokes is invoked by those two windows. Left out of this union, its two
    // channels looked like they belonged to nobody.
    const probe = invoked(read('diagnostics', 'renderer', 'preload-attach.js'));
    const bridges = {
      main: new Set([...invoked(read('preload.js')), ...probe]),
      viewer: new Set([...invoked(read('renderer', 'viewer-preload.js')), ...probe]),
      diagnostics: invoked(read('diagnostics', 'ui', 'control-preload.js')),
    };

    ok('every registered channel has a declared role', () => {
      const undeclared = m.__test.ipcAuthority.denials; // touched so the seam is real
      assert.ok(typeof undeclared === 'function');
      const missing = [...m.handlers.keys()].filter((c) => !Array.isArray(roles[c]));
      assert.deepStrictEqual(missing, [], `channels with no role: ${missing.join(', ')}`);
    });

    ok('and the roles are exactly what the three bridges expose', () => {
      const wrong = [];
      for (const [channel, allowedRoles] of Object.entries(roles)) {
        for (const role of ['main', 'viewer', 'diagnostics']) {
          const inBridge = bridges[role].has(channel);
          const inTable = allowedRoles.includes(role);
          if (inBridge !== inTable) wrong.push(`${channel}: ${role} bridge=${inBridge} table=${inTable}`);
        }
      }
      assert.deepStrictEqual(wrong, [], `the table and the bridges disagree:\n  ${wrong.join('\n  ')}`);
    });

    ok('every handler in the whole app has a declared role, not just the ones here', () => {
      // The check that was missing. main.js is not the only file that registers a
      // handler: the diagnostics controller registers ten through the very same ipcMain
      // it is handed, and a channel this table does not name cannot be registered at all
      // - it throws. The first time that happened, diagnostics mode started with no
      // handlers whatsoever. Only a source scan can see registrations that live behind a
      // gate the harness never opens.
      // CODE-001: every main-process file, not a list of two. A handler moved out of main.js
      // into a module would otherwise leave this scan without anything failing. And read off
      // the syntax tree (test/helpers/ipc-registrations.js): the text search was got past by
      // a comment before the channel.
      const registered = new Set(ipcRegistrations(mainProcessSources()).map((r) => r.channel));
      assert.ok(registered.size > 90, `only ${registered.size} handlers found: the scan is broken`);
      // Everything main registers when it starts is in the scan; the scan also holds what
      // only a gate registers (diagnostics), which the harness never opens.
      const notScanned = [...m.handlers.keys()].filter((c) => !registered.has(c));
      assert.deepStrictEqual(notScanned, [], `registered at start but not found by the scan: ${notScanned.join(', ')}`);
      const undeclared = [...registered].filter((c) => !Array.isArray(roles[c]));
      assert.deepStrictEqual(undeclared, [], `channels with no declared role: ${undeclared.join(', ')}`);
    });

    ok('a registration is found however it is written, and refused where it cannot be read', () => {
      // The third re-review hid a handler from the old text search with a comment before the
      // channel; a module handed ipcMain under another name, double quotes or a template
      // string did the same.
      const make = (files) => {
        const root = makeTempDir('znada ipc Ж-');
        for (const [rel, text] of Object.entries({ 'main.js': '', 'src/.keep': '', 'diagnostics/main/.keep': '', ...files })) {
          fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
          fs.writeFileSync(path.join(root, rel), text);
        }
        return root;
      };
      const roots = [];
      const channelsIn = (files) => {
        roots.push(make(files));
        return ipcRegistrations(mainProcessSources(roots[roots.length - 1])).map((r) => `${r.file}:${r.line} ${r.channel}`);
      };
      try {
        assert.deepStrictEqual(channelsIn({
          'main.js': "require('./diagnostics/core/redaction');\n",
          'diagnostics/core/redaction.js': [
            'module.exports.register = (ipcMain, bus, protocol) => {',
            "  ipcMain.handle(/* registration comment */ 'review-unfrozen', () => 1);",
            '  bus.handle("review-double", async () => 2);',
            '  bus["handleOnce"](`review-template`, function () { return 3; });',
            "  protocol.handle('znada-thumb', () => null);", // a URL scheme, not a channel
            '};',
          ].join('\n'),
        }), ['diagnostics/core/redaction.js:2 review-unfrozen', 'diagnostics/core/redaction.js:3 review-double',
          'diagnostics/core/redaction.js:4 review-template']);
        const refused = {
          "const name = 'x';\nmodule.exports = (ipcMain) => ipcMain.handle(name, () => 1);": /src\/a\.js:2: \.handle\(\) of a channel that is not a plain string/,
          "module.exports = (ipcMain, run) => ipcMain.handle('x', run);": /the handler for 'x' is not a function written out/,
          "module.exports = (ipcMain) => ipcMain.handle.call(ipcMain, 'x', () => 1);": /\.handle is read without being called/,
          "module.exports = (ipcMain) => { const { handle } = ipcMain; handle('x', () => 1); };": /\.handle is read without being called/,
          "module.exports = (ipcMain) => Reflect.apply(Reflect.get(ipcMain, 'handle'), ipcMain, ['x', () => 1]);": /\.handle is read without being called/,
        };
        for (const [code, pattern] of Object.entries(refused)) {
          roots.push(make({ 'src/a.js': code }));
          assert.throws(() => ipcRegistrations(mainProcessSources(roots[roots.length - 1])), pattern);
        }
        // A door that passes on what its caller named is counted: a second one is refused.
        roots.push(make({ 'src/ipc-authority.js': [
          'exports.handle = (ipcMain, channel, fn) => ipcMain.handle(channel, (e) => fn(e));',
          'exports.again = (ipcMain, channel, fn) => ipcMain.handle(channel, fn);',
        ].join('\n') }));
        assert.throws(() => ipcRegistrations(mainProcessSources(roots[roots.length - 1])),
          /src\/ipc-authority\.js: 2 registrations of a channel that is not a plain string, where 1 pass/);
      } finally {
        for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
      }
    });

    ok('a channel is never allowed for a role with no window of that kind', () => {
      const empty = Object.entries(roles).filter(([, list]) => !Array.isArray(list) || !list.length);
      assert.deepStrictEqual(empty.map(([c]) => c), []);
    });

    ok('the viewer cannot reach the settings channel through the real registration', () => {
      // The concrete version of the whole slice: `set-config` is a main-window channel,
      // and BUG-022 made it the one that guards authoritative state.
      assert.throws(() => m.invokeAs('viewer', 'set-config', { style: 'fit' }), /E_IPC_DENIED/);
    });

    ok('and the main window still can', async () => {
      assert.ok(m.handlers.has('set-config'));
    });

    // --- the window policy itself -------------------------------------------
    // Three refusals are installed on every window Znada creates. Before this slice none
    // of them existed, and none of them had ever been executed by a test.

    function fakeElectronWindow() {
      const listeners = new Map();
      const captured = { open: null, permissionRequest: null, permissionCheck: null };
      const contents = {
        mainFrame: { url: '' },
        setWindowOpenHandler: (fn) => { captured.open = fn; },
        on: (event, fn) => {
          if (!listeners.has(event)) listeners.set(event, []);
          listeners.get(event).push(fn);
        },
        session: {
          setPermissionRequestHandler: (fn) => { captured.permissionRequest = fn; },
          setPermissionCheckHandler: (fn) => { captured.permissionCheck = fn; },
        },
      };
      const emit = (event, ...args) => (listeners.get(event) || []).forEach((fn) => fn(...args));
      return { win: { isDestroyed: () => false, webContents: contents }, contents, captured, emit };
    }

    const viewerUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'viewer.html')).href;
    const homeUrl = pathToFileURL(path.join(__dirname, '..', 'renderer', 'index.html')).href;

    ok('a window is registered under the role it was hardened with', () => {
      const w = fakeElectronWindow();
      m.__test.hardenWindow(w.win, 'viewer');
      w.contents.mainFrame.url = viewerUrl;
      const event = { sender: w.contents, senderFrame: w.contents.mainFrame };
      assert.strictEqual(m.__test.ipcAuthority.roleOf(event), 'viewer',
        'the viewer was registered as something other than the viewer');
    });

    ok('a page cannot open a window of its own', () => {
      const w = fakeElectronWindow();
      m.__test.hardenWindow(w.win, 'main');
      assert.ok(typeof w.captured.open === 'function', 'no window-open policy was installed');
      assert.deepStrictEqual(w.captured.open({ url: 'https://example.test/' }), { action: 'deny' });
    });

    ok('a page cannot navigate itself somewhere else', () => {
      const w = fakeElectronWindow();
      m.__test.hardenWindow(w.win, 'main');
      let prevented = 0;
      w.emit('will-navigate', { preventDefault: () => { prevented += 1; } }, 'https://example.test/');
      assert.strictEqual(prevented, 1, 'a remote navigation was allowed');
    });

    ok('but a reload of its own page is not navigation away', () => {
      const w = fakeElectronWindow();
      m.__test.hardenWindow(w.win, 'main');
      let prevented = 0;
      w.emit('will-navigate', { preventDefault: () => { prevented += 1; } }, `${homeUrl}#top`);
      assert.strictEqual(prevented, 0, 'the window was stopped from reloading itself');
    });

    ok('no page of ours may be granted a device permission', () => {
      const w = fakeElectronWindow();
      m.__test.hardenWindow(w.win, 'main');
      assert.ok(typeof w.captured.permissionRequest === 'function', 'no permission policy was installed');
      let answered = null;
      w.captured.permissionRequest({}, 'media', (allowed) => { answered = allowed; });
      assert.strictEqual(answered, false, 'a permission request was granted');
      assert.strictEqual(w.captured.permissionCheck(), false, 'a permission check said yes');
    });

    ok('a role that is not one of our three windows cannot be hardened at all', () => {
      assert.throws(() => m.__test.hardenWindow(fakeElectronWindow().win, 'admin'),
        /unknown window role/);
    });

    ok('the window kinds and the roles in the table are the same three', () => {
      // A role named in the table with no window that can ever hold it is a channel
      // nobody can call — a capability list that reads as a decision and is not one.
      const kinds = m.__test.windowPages().slice().sort();
      const used = [...new Set(Object.values(roles).flat())].sort();
      assert.deepStrictEqual(used, kinds);
    });

    // --- what a window is allowed to be (slice 4) ---------------------------

    ok('the windows people actually use run sandboxed', () => {
      for (const role of ['main', 'viewer']) {
        const opts = m.__test.windowSecurity(role);
        assert.strictEqual(opts.sandbox, true, `${role} runs without the sandbox`);
        assert.strictEqual(opts.contextIsolation, true, `${role} lost context isolation`);
        assert.strictEqual(opts.nodeIntegration, false, `${role} was given Node`);
      }
    });

    ok('and so does the diagnostics panel, whose preload needs nothing but electron', () => {
      assert.strictEqual(m.__test.windowSecurity('diagnostics').sandbox, true);
    });

    ok('every window is created through that one decision, not by hand', () => {
      // A source check, deliberately. The decision itself is behavioural above; what this
      // adds is that the three creation sites USE it, and no real BrowserWindow exists in
      // a test to observe that from the outside. A mutation replacing the spread with
      // hand-written options survived every behavioural test, which is precisely the gap.
      // CODE-001: read over all main-process code. The windows will not stay in main.js,
      // and a check that only looks there would pass the day they leave.
      const sources = mainProcessSources();
      const { count, unshared } = windowsIn(sources);
      assert.deepStrictEqual(unshared, [], 'a window is created without the shared security decision');
      assert.deepStrictEqual(handSetSwitches(sources), [], 'a window switch is set by hand outside windowSecurity');
      assert.strictEqual(count, 3, `expected 3 windows, found ${count}`);
    });

    ok('a switch set by hand is found however it is written', () => {
      const switches = withProject({
        'main.js': [
          "function windowSecurity(role) { return { sandbox: role !== 'x', contextIsolation: true, nodeIntegration: false }; }",
          "const safe = { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } };",
          'const { sandbox } = windowSecurity(1);',
        ].join('\n'),
        'src/a.js': [
          'const prefs = { sandbox: /* off */ false };',
          "const more = { 'contextIsolation': !1, ['nodeIntegration']: 1 };",
          'prefs.nodeIntegration = true;',
          'const computed = { sandbox: process.env.X === "1" };',
          // Named by a string that something receives, and written into by destructuring.
          "Reflect.set(prefs, 'sandbox', false);",
          '({ off: prefs.contextIsolation } = { off: false });',
          "const key = 'nodeIntegration';",
          // Read, compared, or set to the safe value: nothing to report.
          "if (key === 'sandbox' || prefs.sandbox) prefs.sandbox = true;",
          // A Chromium switch is past the decision for every window at once.
          "app.commandLine.appendSwitch('no-sandbox');",
        ].join('\n'),
      }, handSetSwitches);
      assert.deepStrictEqual(switches, ['src/a.js:1 sandbox', 'src/a.js:2 contextIsolation', 'src/a.js:2 nodeIntegration',
        'src/a.js:3 nodeIntegration', 'src/a.js:4 sandbox', "src/a.js:5 'sandbox'", 'src/a.js:6 contextIsolation',
        "src/a.js:7 'nodeIntegration'", 'src/a.js:9 appendSwitch']);
    });

    ok('a window built in a module from what main hands it counts the same', () => {
      // The re-review's question: the old text pattern saw only `new BrowserWindow(`, and a
      // module is handed Electron by main (new deps.BrowserWindow). Options built elsewhere
      // and passed by name cannot be read at the call, so they are not taken on trust.
      const windows = withProject({
        'main.js': "require('./src/viewer');\n",
        'src/viewer.js': [
          'module.exports = (deps, opts) => [',
          "  new deps.BrowserWindow({ webPreferences: { ...deps.windowSecurity('viewer') } }),",
          '  new deps.BrowserWindow({ webPreferences: { sandbox: true } }),',
          '  new deps.BrowserWindow(opts),',
          "  new deps.electron.BrowserWindow({ show: false, ...deps.windowSecurity('viewer') }),",
          '];',
        ].join('\n'),
      }, windowsIn);
      assert.deepStrictEqual(windows, { count: 4, unshared: ['src/viewer.js:3', 'src/viewer.js:4', 'src/viewer.js:5'] });
    });

    ok('a window class under another name is refused, not left out of the count', () => {
      // The fourth re-review: the class renamed while destructuring made a window the check
      // never counted, and the three real ones still added up to three. Every way of giving
      // it another name, or none, is refused at the place it happens.
      const reviewed = [
        'module.exports.reviewAliasWindow = (deps) => {',
        '  const { BrowserWindow: Window } = deps;',
        '  return new Window({ show: false });',
        '};',
      ].join('\n');
      const renamings = {
        [reviewed]: 2,
        'module.exports = (deps) => { const W = deps.BrowserWindow; return new W({}); };': 1,
        'module.exports = (make, electron) => make(electron.BrowserWindow);': 1,
        'module.exports = (deps) => class Viewer extends deps.BrowserWindow {};': 1,
        'module.exports = (deps) => { const Window = ((_parts, value) => value)`${deps.BrowserWindow}`; return new Window({}); };': 1,
        'module.exports = (deps) => Reflect.construct(deps.BrowserWindow, [{}]);': 1,
        "module.exports = (electron) => Reflect.get(electron, 'BrowserWindow');": 1,
        'module.exports = (deps) => deps.BrowserWindow.bind(null, {});': 1,
        'module.exports = (deps) => deps.BrowserWindow;': 1,
      };
      for (const [code, line] of Object.entries(renamings)) {
        assert.throws(() => withProject({
          'main.js': "require('./diagnostics/core/redaction');\n",
          'diagnostics/core/redaction.js': code,
        }, windowsIn), new RegExp(`diagnostics/core/redaction\\.js:${line}: BrowserWindow`), code);
      }
      // Under its own name it may be destructured, handed on, looked up and tested, and one
      // `new` is one window, reported once, whichever way its class is chosen.
      const windows = withProject({
        'main.js': "require('./src/viewer');\n",
        'src/viewer.js': [
          'module.exports = (deps, win) => {',
          '  const { BrowserWindow } = deps;',
          '  const open = BrowserWindow.getAllWindows().length + (BrowserWindow.fromWebContents(win.webContents) ? 1 : 0);',
          "  if (typeof BrowserWindow !== 'function' || win instanceof BrowserWindow) return open;",
          '  const view = new (deps.ready ? deps.BrowserWindow : BrowserWindow)({ show: false });',
          '  return { BrowserWindow, view };',
          '};',
        ].join('\n'),
      }, windowsIn);
      assert.deepStrictEqual(windows, { count: 1, unshared: ['src/viewer.js:5'] });
    });

    ok('this run is not a diagnostics run, so the exception below is not what was measured', () => {
      assert.strictEqual(m.__test.diagnosticsEnabled(), false);
    });

    ok('a window that closes stops being a sender', () => {
      const w = fakeElectronWindow();
      m.__test.hardenWindow(w.win, 'main');
      w.contents.mainFrame.url = homeUrl;
      const event = { sender: w.contents, senderFrame: w.contents.mainFrame };
      assert.strictEqual(m.__test.ipcAuthority.roleOf(event), 'main');
      w.emit('destroyed');
      assert.strictEqual(m.__test.ipcAuthority.roleOf(event), '',
        'a destroyed window kept its authority');
    });
  } finally {
    console.log = real.log; console.error = real.error;
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  // QA-009. A diagnostics run used to turn the sandbox off for the two app windows so
  // their preloads could pull the measuring probe in with a relative load. The probe is
  // now a separate script that loads only electron, so the sandbox stays on for every
  // role. Context isolation and "no Node" were never relaxed and still must not be.
  {
    const dir = H.makeTempProfile('ipc-authority-diag');
    const real = { log: console.log, error: console.error };
    const hadEnv = process.env.ZNADA_DIAGNOSTICS;
    try {
      // The gate needs BOTH the flag and the variable, and an unpackaged build: a
      // half opt-in is deliberately not enough to turn diagnostics on.
      process.env.ZNADA_DIAGNOSTICS = '1';
      process.env.ZNADA_DIAGNOSTICS_USER_DATA = dir;
      console.log = () => {}; console.error = () => {};
      const diag = H.loadMain(dir, { argv: [path.join(__dirname, '..', 'main.js'), '--diagnostics'] });
      console.log = real.log; console.error = real.error;

      ok('a diagnostics run is recognised as one', () => {
        assert.strictEqual(diag.__test.diagnosticsEnabled(), true,
          'the diagnostics gate did not open, so the next two checks prove nothing');
      });

      ok('every window keeps the sandbox on during a diagnostics run', () => {
        for (const role of ['main', 'viewer', 'diagnostics']) {
          assert.strictEqual(diag.__test.windowSecurity(role).sandbox, true, role);
        }
      });

      ok('an unknown window role is refused rather than unsandboxed', () => {
        assert.throws(() => diag.__test.windowSecurity('admin'), /unknown window role/);
      });

      ok('and nothing else about a window is relaxed for diagnostics', () => {
        for (const role of ['main', 'viewer', 'diagnostics']) {
          assert.strictEqual(diag.__test.windowSecurity(role).contextIsolation, true);
          assert.strictEqual(diag.__test.windowSecurity(role).nodeIntegration, false);
        }
      });
    } finally {
      console.log = real.log; console.error = real.error;
      if (hadEnv === undefined) delete process.env.ZNADA_DIAGNOSTICS;
      else process.env.ZNADA_DIAGNOSTICS = hadEnv;
      delete process.env.ZNADA_DIAGNOSTICS_USER_DATA;
      H.unloadMain();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log(`FAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exit(1);
  }
})();
