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
    // The diagnostics probe is not a bridge of its own: it is attached INSIDE the main
    // and viewer preloads, so whatever it invokes is invoked by those two windows. Left
    // out of this union, its two channels looked like they belonged to nobody - which is
    // exactly the mistake that took diagnostics mode down once already.
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
      const files = ['main.js', path.join('diagnostics', 'main', 'controller.js')];
      const registered = new Set();
      for (const file of files) {
        for (const m of read(file).matchAll(/ipcMain\.handle\('([^']+)'/g)) registered.add(m[1]);
      }
      assert.ok(registered.size > 90, `only ${registered.size} handlers found: the scan is broken`);
      const undeclared = [...registered].filter((c) => !Array.isArray(roles[c]));
      assert.deepStrictEqual(undeclared, [], `channels with no declared role: ${undeclared.join(', ')}`);
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
      const source = read('main.js');
      const starts = [];
      for (const m of source.matchAll(/new BrowserWindow\(/g)) starts.push(m.index);
      assert.strictEqual(starts.length, 3, `expected 3 windows, found ${starts.length}`);
      for (const start of starts) {
        let depth = 0;
        let end = start;
        for (let i = source.indexOf('{', start); i < source.length; i++) {
          if (source[i] === '{') depth++;
          else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        const block = source.slice(start, end);
        assert.ok(block.includes('...windowSecurity('),
          `a window is created without the shared security decision:\n${block.slice(0, 120)}`);
      }
      assert.ok(!/sandbox:\s*false/.test(source), 'a window turns the sandbox off by hand');
      assert.ok(!/contextIsolation:\s*false/.test(source), 'a window turns context isolation off by hand');
      assert.ok(!/nodeIntegration:\s*true/.test(source), 'a window is given Node by hand');
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

  // The exception itself, driven rather than described: a diagnostics run turns the
  // sandbox off for the two app windows, because their preloads pull in the measuring
  // probe with a relative require and a sandboxed preload cannot do that. If this ever
  // stops being true - because the probe got bundled - the sandbox should go back on
  // everywhere, and this is the test that will say so.
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

      ok('the app windows drop the sandbox there, and only there', () => {
        assert.strictEqual(diag.__test.windowSecurity('main').sandbox, false);
        assert.strictEqual(diag.__test.windowSecurity('viewer').sandbox, false);
      });

      ok('the panel keeps it even then', () => {
        assert.strictEqual(diag.__test.windowSecurity('diagnostics').sandbox, true);
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
