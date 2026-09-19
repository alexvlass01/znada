'use strict';

// `node test/dev-launch-main.test.js` — COLLAB-003 through the REAL main.js under the
// stubbed Electron: which launches become checks or are refused, what a second launch of
// other code is told, the label on the window, and what the end of the hour does — the
// tray's own exit, after a library change already under way, with the last pool edit
// still written even when the store refuses it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');

const MAIN = path.join(H.ROOT, 'main.js');
const DEV_TOOLS = path.join(H.ROOT, 'diagnostics', 'main', 'dev-launch.js');
const HOUR = 60 * 60 * 1000;
const SHA_A = 'a'.repeat(40);
const LAUNCH_ENV = ['ZNADA_CLOUD', 'ZNADA_DEV_USER_DATA', 'ZNADA_DIAGNOSTICS', 'ZNADA_DIAGNOSTICS_USER_DATA'];
const CLEAN = `# branch.oid ${SHA_A}\n# branch.head claude/COLLAB-003-dev-diag-launch\n`;

let passed = 0;
const failures = [];
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { failures.push({ name, err }); console.log('  ✗ ' + name); }
}

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

// The harness blocks every child process, so main.js could only ever describe an unknown
// revision. This answers `git status` like a clean checkout and records how it was asked.
function gitAnswering(text, seen = []) {
  return {
    execFileSync: (file, args, opts) => {
      seen.push({ file, args, opts });
      if (file !== 'git') throw new Error('child processes are disabled in tests');
      return text;
    },
  };
}

const devEnv = (dir) => ({ ZNADA_CLOUD: 'staging', ZNADA_DEV_USER_DATA: dir });
const diagEnv = (dir) => ({ ZNADA_DIAGNOSTICS: '1', ZNADA_DIAGNOSTICS_USER_DATA: dir });

// Loads main.js with exactly these launch variables and arguments. Its console is kept,
// not shown; the environment and the module cache are put back whatever happens.
async function launch({ env = () => ({}), args = [], ...options }, body) {
  const saved = {};
  for (const key of LAUNCH_ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  const dir = H.makeTempProfile('dev-launch');
  const printed = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  const keep = (...a) => { printed.push(a.map(String).join(' ')); };
  try {
    Object.assign(process.env, env(dir));
    console.log = keep; console.error = keep; console.warn = keep;
    const m = H.loadMain(dir, { argv: [MAIN, ...args], ...options });
    await body(m, { dir, printed });
  } finally {
    console.log = real.log; console.error = real.error; console.warn = real.warn;
    for (const key of LAUNCH_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// Moves both clocks the hour is measured by, for the length of `fn` only.
async function atClock(offsetMs, fn) {
  const realNow = Date.now;
  const realPerf = performance.now;
  Date.now = () => realNow() + offsetMs;
  performance.now = () => realPerf.call(performance) + offsetMs;
  try { return await fn(); } finally { Date.now = realNow; performance.now = realPerf; }
}

(async () => {
  await ok('an ordinary source launch is neither a check nor refused, and does not load the dev tools', () => {
    delete require.cache[DEV_TOOLS];
    return launch({}, (m) => {
      const d = m.__test.devLaunch();
      assert.deepStrictEqual([d.mode, d.refusal, d.info, d.session], [null, null, null, null]);
      assert.deepStrictEqual(m.calls.singleInstanceLock, [[]], 'an ordinary launch asks for the lock exactly as before');
      assert.deepStrictEqual(m.calls.exit, []);
      assert.deepStrictEqual(m.calls.errorBoxes, []);
      assert.strictEqual(require.cache[DEV_TOOLS], undefined);
    });
  });

  await ok('a DEV launch names the code it runs and starts its hour', () => {
    const seen = [];
    return launch({ env: devEnv, childProcess: gitAnswering(CLEAN, seen) }, (m, { dir }) => {
      const { mode, info, session } = m.__test.devLaunch();
      assert.strictEqual(mode, 'dev');
      assert.strictEqual(info.badgeText, 'DEV · COLLAB-003 · aaaaaaa');
      assert.strictEqual(info.profilePath, dir);
      assert.strictEqual(session.state().limitMs, HOUR);
      assert.strictEqual(session.state().armed, true);
      assert.strictEqual(session.state().expired, false);
      const gitCalls = seen.filter((call) => call.file === 'git');
      assert.strictEqual(gitCalls.length, 1);
      assert.strictEqual(path.resolve(gitCalls[0].opts.cwd), path.resolve(H.ROOT),
        'the revision must be read where the running main.js lives');
      assert.deepStrictEqual(m.calls.singleInstanceLock, [[{
        znadaDevLaunch: { mode: 'dev', known: true, sha: SHA_A, dirty: false, badgeText: 'DEV · COLLAB-003 · aaaaaaa' },
      }]]);
    });
  });

  await ok('without a readable git the check still opens, and says its code is unknown', () => launch({ env: devEnv }, (m) => {
    const { mode, info } = m.__test.devLaunch();
    assert.strictEqual(mode, 'dev');
    assert.strictEqual(info.badgeText, 'DEV · версия не определена');
  }));

  await ok('a full DIAG launch is a DIAG check', () => launch({
    env: diagEnv, args: ['--diagnostics'], childProcess: gitAnswering(CLEAN),
  }, (m) => {
    assert.strictEqual(m.__test.devLaunch().info.badgeText, 'DIAG · COLLAB-003 · aaaaaaa');
  }));

  await ok('a packaged build started with every check variable stays ordinary and never loads the dev tools', () => {
    const seen = [];
    delete require.cache[DEV_TOOLS];
    return launch({
      env: (dir) => ({ ...devEnv(dir), ...diagEnv(dir) }),
      args: ['--diagnostics'],
      isPackaged: true,
      childProcess: gitAnswering(CLEAN, seen),
    }, (m) => {
      const d = m.__test.devLaunch();
      assert.deepStrictEqual([d.mode, d.refusal, d.info, d.session], [null, null, null, null]);
      assert.deepStrictEqual(m.calls.singleInstanceLock, [[]]);
      assert.deepStrictEqual(m.calls.exit, []);
      assert.deepStrictEqual(m.calls.errorBoxes, []);
      assert.deepStrictEqual(seen, [], 'a user build must not even ask git');
      assert.strictEqual(require.cache[DEV_TOOLS], undefined, 'a user build must not load a file its package does not contain');
    });
  });

  await ok('staging without a profile is refused before it can open the real profile', () => launch({
    env: () => ({ ZNADA_CLOUD: 'staging' }),
  }, (m, { printed }) => {
    const d = m.__test.devLaunch();
    assert.strictEqual(d.refusal, 'dev_without_profile');
    assert.strictEqual(d.session, null);
    assert.deepStrictEqual(m.calls.exit, [2]);
    assert.deepStrictEqual(m.calls.singleInstanceLock, [],
      'a refused launch must not ask for the lock: that would wake the user\'s own Znada on that profile');
    assert.strictEqual(m.calls.errorBoxes.length, 1);
    assert.ok(m.calls.errorBoxes[0].content.includes('ZNADA_DEV_USER_DATA'));
    assert.ok(printed.some((line) => line.includes('ZNADA_DEV_USER_DATA')),
      'the console must say it too: a launch from a terminal may have nobody to read a dialog');
  }));

  await ok('half a DIAG opt-in is refused, whichever half', async () => {
    for (const spec of [{ env: () => ({ ZNADA_DIAGNOSTICS: '1' }) }, { args: ['--diagnostics'] }]) {
      await launch(spec, (m) => {
        assert.strictEqual(m.__test.devLaunch().refusal, 'diag_incomplete', spec.args ? 'argument only' : 'variable only');
        assert.deepStrictEqual(m.calls.exit, [2]);
        assert.deepStrictEqual(m.calls.singleInstanceLock, []);
      });
    }
  });

  await ok('a second launch on a profile already open quits and says so, naming the profile', () => launch({
    env: devEnv, singleInstanceLock: false, childProcess: gitAnswering(CLEAN),
  }, (m, { dir, printed }) => {
    assert.ok(m.calls.quit >= 1, 'the second launch did not quit');
    assert.ok(printed.some((line) => line.includes('уже открыт') && line.includes(dir)),
      `nothing said the profile was already open:\n${printed.join('\n')}`);
  }));

  await ok('a second launch of other code is refused out loud and the running hour is untouched', () => launch({
    env: devEnv, childProcess: gitAnswering(CLEAN),
  }, (m) => {
    const { info, session } = m.__test.devLaunch();
    const deadline = session.state().deadline;
    const other = { mode: 'dev', known: true, sha: 'b'.repeat(40), dirty: false, badgeText: 'DEV · LIB-009 · bbbbbbb' };
    m.emitApp('second-instance', {}, [], H.ROOT, { znadaDevLaunch: other });
    assert.strictEqual(m.calls.dialogs.length, 1, 'no refusal was shown');
    assert.ok(m.calls.dialogs[0].detail.includes(info.badgeText) && m.calls.dialogs[0].detail.includes(other.badgeText),
      m.calls.dialogs[0].detail);
    assert.strictEqual(m.calls.windows.length, 1, 'the running window was not brought forward');
    m.emitApp('second-instance', {}, [], H.ROOT, undefined);   // an older launch that sends nothing
    assert.strictEqual(m.calls.dialogs.length, 2);
    assert.strictEqual(session.state().deadline, deadline);
    assert.strictEqual(session.state().armed, true);
    assert.strictEqual(session.state().expired, false);
  }));

  await ok('the same code launched again only brings the window forward', () => launch({
    env: devEnv, childProcess: gitAnswering(CLEAN),
  }, (m) => {
    const tools = require(DEV_TOOLS);
    const { info } = m.__test.devLaunch();
    m.emitApp('second-instance', {}, [], H.ROOT, { znadaDevLaunch: tools.identityOf(info) });
    assert.strictEqual(m.calls.dialogs.length, 0);
    assert.strictEqual(m.calls.windows.length, 1);
  }));

  await ok('the main window carries the label in its title and keeps it over the page title', () => launch({
    env: devEnv, childProcess: gitAnswering(CLEAN),
  }, (m) => {
    const tools = require(DEV_TOOLS);
    const { info } = m.__test.devLaunch();
    m.emitApp('second-instance', {}, [], H.ROOT, { znadaDevLaunch: tools.identityOf(info) });
    const win = m.calls.windows[0];
    assert.strictEqual(win.options.title, 'Znada · DEV · COLLAB-003 · aaaaaaa');
    assert.ok(win.options.webPreferences.additionalArguments.includes(tools.rendererArg(info)),
      'the page never receives the label');
    const handlers = win.listeners.get('page-title-updated') || [];
    assert.strictEqual(handlers.length, 1);
    let prevented = false;
    handlers[0]({ preventDefault: () => { prevented = true; } }, 'Znada');
    assert.strictEqual(prevented, true, 'the page <title> would replace the label on load');
  }));

  await ok('the viewer window carries the label in its title too', () => launch({
    env: devEnv, childProcess: gitAnswering(CLEAN),
  }, (m, { dir }) => {
    m.__test.loadConfig();
    const opened = m.invoke('gallery-open', { items: [{ kind: 'local', key: 'k', path: path.join(dir, 'x.png') }], index: 0 });
    assert.strictEqual(opened && opened.ok, true, JSON.stringify(opened));
    const viewer = m.calls.windows.find((w) => String(w.options.title || '').startsWith('Znada Media Viewer'));
    assert.ok(viewer, 'no viewer window was created');
    assert.strictEqual(viewer.options.title, 'Znada Media Viewer · DEV · COLLAB-003 · aaaaaaa');
    assert.strictEqual((viewer.listeners.get('page-title-updated') || []).length, 1);
  }));

  await ok('the tray tooltip names the code too, and stays plain for an ordinary launch', async () => {
    await launch({ env: devEnv, childProcess: gitAnswering(CLEAN) }, (m) => {
      m.__test.loadConfig();
      m.__test.createTray();
      assert.deepStrictEqual(m.calls.trayTooltips, ['Znada · DEV · COLLAB-003 · aaaaaaa']);
    });
    await launch({}, (m) => {
      m.__test.loadConfig();
      m.__test.createTray();
      assert.deepStrictEqual(m.calls.trayTooltips, ['Znada']);
    });
  });

  await ok('an ordinary window is titled as always and gets no label', () => launch({}, (m) => {
    m.emitApp('second-instance', {}, [], H.ROOT, undefined);
    const win = m.calls.windows[0];
    assert.ok(win, 'second-instance did not open the window');
    assert.strictEqual(win.options.title, 'Znada');
    assert.ok(!win.options.webPreferences.additionalArguments.some((a) => String(a).startsWith('--znada-dev-launch=')));
    assert.strictEqual((win.listeners.get('page-title-updated') || []).length, 0);
  }));

  await ok('when the hour runs out the app quits the tray way, after the library change under way', () => launch({
    env: devEnv, childProcess: gitAnswering(CLEAN),
  }, async (m) => {
    const { session } = m.__test.devLaunch();
    let release;
    const held = m.__test.withLibraryLock(() => new Promise((resolve) => { release = resolve; }));
    await settle();
    assert.strictEqual(typeof release, 'function', 'the library change never started');
    assert.strictEqual(await atClock(HOUR, () => session.check()), true);
    await settle();
    assert.strictEqual(m.calls.quit, 0, 'quit while a library change was still running');
    assert.strictEqual(m.app.isQuitting, false);
    release();
    await held;
    await settle();
    assert.strictEqual(m.calls.quit, 1);
    assert.strictEqual(m.app.isQuitting, true, 'without isQuitting closing the window only hides it to the tray');
    assert.deepStrictEqual(m.calls.exit, [], 'the hour must end through quit, which saves; exit skips that');
  }));

  await ok('a library change that never finishes cannot hold the app past the bound', () => launch({
    env: devEnv, childProcess: gitAnswering(CLEAN),
  }, async (m) => {
    const tools = require(DEV_TOOLS);
    const { session } = m.__test.devLaunch();
    m.__test.withLibraryLock(() => new Promise(() => {}));
    await settle();
    const realSetTimeout = global.setTimeout;
    const bounds = [];
    global.setTimeout = (fn, ms, ...rest) => {
      if (ms === tools.SETTLE_LIMIT_MS) {
        bounds.push(fn);
        return { unref() { return this; }, ref() { return this; } };
      }
      return realSetTimeout(fn, ms, ...rest);
    };
    try {
      await atClock(HOUR, () => session.check());
    } finally {
      global.setTimeout = realSetTimeout;
    }
    await settle();
    assert.strictEqual(bounds.length, 1, 'the exit did not wait with the declared bound');
    assert.strictEqual(m.calls.quit, 0);
    bounds[0]();
    await settle();
    assert.strictEqual(m.calls.quit, 1);
  }));

  await ok('the last pool edit before the hour ran out is still written', () => launch({
    env: devEnv, emitQuitEvents: true, childProcess: gitAnswering(CLEAN),
  }, async (m, { dir }) => {
    m.__test.loadConfig();
    const id = m.__test.addToPool('image', H.writeImage(path.join(dir, 'photos', 'a.png')));
    m.__test.saveConfig();
    m.__test.flushLibraryWriter();
    m.invoke('library-toggle-favorite', id);
    assert.strictEqual(m.__test.poolWritePending(), true, 'the favourite was written at once, so this would prove nothing');
    await atClock(HOUR, () => m.__test.devLaunch().session.check());
    await settle();
    assert.strictEqual(m.calls.quit, 1);
    assert.strictEqual(m.__test.poolWritePending(), false);
    const store = JSON.parse(fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8'));
    assert.strictEqual(store.library[id].favorite, true);
  }));

  await ok('a store that refuses that write does not keep the app open, and the edit survives inline', () => launch({
    env: devEnv, emitQuitEvents: true, childProcess: gitAnswering(CLEAN),
  }, async (m, { dir }) => {
    m.__test.loadConfig();
    const id = m.__test.addToPool('image', H.writeImage(path.join(dir, 'photos', 'b.png')));
    m.__test.saveConfig();
    m.__test.flushLibraryWriter();
    const storePath = path.join(dir, 'config.library.json');
    m.invoke('library-toggle-favorite', id);
    fs.chmodSync(storePath, 0o444);   // read-only: the replacing rename is refused
    try {
      await atClock(HOUR, () => m.__test.devLaunch().session.check());
      await settle();
      assert.strictEqual(m.calls.quit, 1, 'a refused write kept the app from quitting');
      const settings = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      assert.ok(settings.library && settings.library[id], 'the pool was not carried into config.json');
      assert.strictEqual(settings.library[id].favorite, true, 'the favourite was lost with the refused write');
    } finally {
      fs.chmodSync(storePath, 0o666);
    }
  }));

  // BUG-044. A launch that did not get the profile's lock has already asked to quit, but Electron
  // still emits `ready`. The startup block used to run in full in that dying process: measured, it
  // rewrote the helper scripts inside the running app's profile; by the order of the code it would
  // go on to open a window and a tray icon, take the hotkey and apply wallpapers.
  const STARTUP_SCRIPTS = ['set-wallpaper.ps1', 'wallpaper-com.ps1', 'wallpaper-host.ps1', 'set-theme.ps1'];
  const assertNoStartup = (m, dir) => {
    if (process.platform === 'win32') {
      assert.strictEqual(m.calls.appUserModelIds.length, 1, 'the startup block never began, so nothing below proves anything');
    }
    for (const script of STARTUP_SCRIPTS) {
      assert.strictEqual(fs.existsSync(path.join(dir, script)), false, `${script} was written by a launch that is quitting`);
    }
    assert.deepStrictEqual(m.calls.windows, [], 'a quitting launch opened a window');
    assert.deepStrictEqual(m.calls.trayTooltips, [], 'a quitting launch put up a tray icon');
    assert.deepStrictEqual(m.calls.hotkeys.filter(([kind]) => kind === 'register'), [], 'a quitting launch took a hotkey');
    assert.ok(m.calls.quit >= 1, 'the launch did not ask to quit');
  };
  await ok('a second DEV launch that did not get the profile runs none of the startup', () => launch({
    env: devEnv, singleInstanceLock: false, whenReady: 'resolve', childProcess: gitAnswering(CLEAN),
  }, async (m, { dir }) => {
    await settle();
    assertNoStartup(m, dir);
  }));
  await ok('neither does a second ordinary launch, the one a second click on the shortcut makes', () => launch({
    singleInstanceLock: false, whenReady: 'resolve',
  }, async (m, { dir }) => {
    await settle();
    assertNoStartup(m, dir);
  }));

  await ok('quitting before the hour disposes its timer', () => launch({
    env: devEnv, emitQuitEvents: true, childProcess: gitAnswering(CLEAN),
  }, (m) => {
    const { session } = m.__test.devLaunch();
    m.app.quit();
    assert.strictEqual(session.state().disposed, true);
    assert.strictEqual(session.state().armed, false);
  }));

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log(`FAILED: ${f.name}\n  ${f.err && f.err.stack}`);
    process.exit(1);
  }
})();
