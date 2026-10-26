'use strict';

// QA-009. A sandboxed Electron preload may load only `electron` and a few built-ins.
// The diagnostics probe used to be a relative load inside the two app preloads, so a
// diagnostics run turned the sandbox off and a bug of that kind could not be seen.
// These checks load the real preloads with a stub that refuses every other load, and
// they execute the composed probe script the same way.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeTempDir } = require('./helpers/temp-dir');
const probePreload = require('../diagnostics/main/probe-preload');

const ROOT = path.join(__dirname, '..');
let passed = 0;

function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function runPreloadSource(source, filename, argvExtra) {
  const exposed = {};
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, value) { exposed[name] = value; },
    },
    ipcRenderer: {
      invoke() { return Promise.resolve({ now: 1 }); },
      on() {},
    },
    webUtils: { getPathForFile() { return ''; } },
  };
  const originalLoad = Module._load;
  const originalArgv = process.argv;
  const originalSetTimeout = global.setTimeout;
  const originalRaf = global.requestAnimationFrame;
  const originalCaf = global.cancelAnimationFrame;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === 'events' || request === 'timers' || request === 'url') {
      return originalLoad.call(this, request, parent, isMain);
    }
    const error = new Error(`sandbox refused ${request}`);
    error.code = 'SANDBOX_REQUIRE';
    throw error;
  };
  global.setTimeout = function patchedTimeout(...args) {
    const timer = originalSetTimeout.apply(this, args);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };
  global.requestAnimationFrame = (fn) => {
    const timer = originalSetTimeout(fn, 0);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  process.argv = ['electron.exe', '--type=renderer', ...argvExtra];
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  try {
    mod._compile(source, filename);
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
    global.setTimeout = originalSetTimeout;
    if (originalRaf === undefined) delete global.requestAnimationFrame;
    else global.requestAnimationFrame = originalRaf;
    if (originalCaf === undefined) delete global.cancelAnimationFrame;
    else global.cancelAnimationFrame = originalCaf;
  }
  return exposed;
}

ok('the scanner ignores comments and strings, and still sees a load inside a template expression', () => {
  assert.deepStrictEqual(probePreload.findRequires("require('./kept');"), ['./kept']);
  assert.deepStrictEqual(probePreload.findRequires("// require('./hidden')\nconst x = 1;"), []);
  assert.deepStrictEqual(probePreload.findRequires("/* require('./hidden') */\nconst x = 1;"), []);
  assert.deepStrictEqual(probePreload.findRequires("const s = 'require(\"./hidden\")';"), []);
  assert.deepStrictEqual(probePreload.findRequires('const s = `require("./hidden")`;'), []);
  assert.deepStrictEqual(
    probePreload.findRequires('const s = `${require("./seen")}`;'),
    ['./seen']
  );
  assert.deepStrictEqual(
    probePreload.findRequires('const s = `${prefix}=`;\nrequire("electron");'),
    ['electron']
  );
  assert.throws(() => probePreload.findRequires('require(name);'), /non-string require/);
  assert.throws(() => probePreload.findRequires("require('open"), /unclosed string/);
});

ok('the three real preloads load only electron', () => {
  const files = ['preload.js', 'renderer/viewer-preload.js', 'diagnostics/ui/control-preload.js'];
  for (const file of files) {
    const loads = probePreload.findRequires(read(file));
    assert.deepStrictEqual(loads, ['electron'], file);
    for (const request of loads) {
      assert.ok(probePreload.SANDBOX_REQUIRE_ALLOW.has(request), `${file} loads ${request}`);
    }
  }
});

ok('a top-level relative load takes the bridge down under the sandbox stub', () => {
  const dir = makeTempDir('qa009-fixture-');
  const filename = path.join(dir, 'fixture-preload.js');
  const source = [
    "'use strict';",
    "const { contextBridge } = require('electron');",
    "require('./src/media-proxy');",
    "contextBridge.exposeInMainWorld('api', { getConfig() { return 'ok'; } });",
    '',
  ].join('\n');
  assert.deepStrictEqual(probePreload.findRequires(source), ['electron', './src/media-proxy']);
  let exposed = { api: 'survived' };
  assert.throws(() => {
    exposed = runPreloadSource(source, filename, []);
  }, /sandbox refused \.\/src\/media-proxy/);
  assert.ok(!exposed.api || exposed.api === 'survived', 'the bridge was exposed after a refused load');
});

ok('the real app preloads still expose their bridges with and without the diagnostics argument', () => {
  const dir = makeTempDir('qa009-preload-');
  const mainExposed = runPreloadSource(read('preload.js'), path.join(ROOT, 'preload.js'), [
    '--znada-diagnostics-renderer=renderer-main',
  ]);
  assert.strictEqual(typeof mainExposed.api.getConfig, 'function');
  assert.strictEqual(mainExposed.znadaDiag, undefined, 'the app preload must not attach the probe');
  const plain = runPreloadSource(read('preload.js'), path.join(dir, 'preload.js'), []);
  assert.strictEqual(typeof plain.api.getConfig, 'function');
  const viewer = runPreloadSource(
    read('renderer/viewer-preload.js'),
    path.join(ROOT, 'renderer', 'viewer-preload.js'),
    ['--znada-diagnostics-renderer=renderer-viewer']
  );
  assert.strictEqual(typeof viewer.viewerApi.getPayload, 'function');
  assert.strictEqual(viewer.znadaDiag, undefined);
  const panel = runPreloadSource(
    read('diagnostics/ui/control-preload.js'),
    path.join(ROOT, 'diagnostics', 'ui', 'control-preload.js'),
    ['--znada-diagnostics-renderer=renderer-diagnostics']
  );
  assert.strictEqual(typeof panel.diag.status, 'function');
  assert.strictEqual(panel.znadaDiag, undefined);
});

ok('the composed probe loads only electron and exposes znadaDiag only for a diagnostics window', () => {
  const script = probePreload.composeProbePreload(
    read('diagnostics/renderer/probe.js'),
    read('diagnostics/renderer/preload-attach.js')
  );
  assert.deepStrictEqual(probePreload.findRequires(script), ['electron']);
  assert.ok(
    script.includes("cardSelector: role === 'renderer-main' ? '.lib-card' : ''"),
    'the main window must still count .lib-card; the viewer must not'
  );
  const dir = makeTempDir('qa009-compose-');
  const file = path.join(dir, 'probe-preload.js');
  const mainProbe = runPreloadSource(script, file, ['--znada-diagnostics-renderer=renderer-main']);
  assert.strictEqual(typeof mainProbe.znadaDiag.span, 'function');
  assert.strictEqual(typeof mainProbe.znadaDiag.mark, 'function');
  const viewerProbe = runPreloadSource(script, file, ['--znada-diagnostics-renderer=renderer-viewer']);
  assert.strictEqual(typeof viewerProbe.znadaDiag.span, 'function');
  const idle = runPreloadSource(script, file, []);
  assert.strictEqual(idle.znadaDiag, undefined, 'the probe ran without the diagnostics argument');
});

ok('composition refuses a probe that loads a module', () => {
  assert.throws(
    () => probePreload.composeProbePreload(
      "require('fs');\nmodule.exports = { createRendererProbe() {} };\n",
      read('diagnostics/renderer/preload-attach.js')
    ),
    /probe source loads a module/
  );
});

ok('composition refuses an attach file whose probe load is not the expected line', () => {
  const attach = read('diagnostics/renderer/preload-attach.js')
    .replace("require('./probe')", "require('./probe.js')");
  assert.throws(
    () => probePreload.composeProbePreload(read('diagnostics/renderer/probe.js'), attach),
    /must load only \.\/probe|not the expected line/
  );
});

ok('install writes the script and registers that path, including a directory with spaces', () => {
  const dir = path.join(makeTempDir('qa009-install-'), 'проба probe');
  const registered = [];
  const session = {
    setPreloads(paths) { registered.push(paths); },
  };
  const out = probePreload.install(session, dir);
  assert.strictEqual(registered.length, 1);
  assert.deepStrictEqual(registered[0], [out]);
  assert.strictEqual(path.resolve(out), path.resolve(dir, 'probe-preload.js'));
  const written = fs.readFileSync(out);
  assert.notStrictEqual(written[0], 0xef, 'the script must not start with a UTF-8 BOM');
  assert.deepStrictEqual(probePreload.findRequires(written.toString('utf8')), ['electron']);
  const exposed = runPreloadSource(written.toString('utf8'), out, ['--znada-diagnostics-renderer=renderer-main']);
  assert.strictEqual(typeof exposed.znadaDiag.span, 'function');
});

ok('install fails closed when it cannot register the script', () => {
  assert.throws(() => probePreload.install({ setPreloads() {} }, ''), /userData/);
  assert.throws(() => probePreload.install({}, makeTempDir('qa009-nosession-')), /setPreloads/);
  const session = { setPreloads() { throw new Error('register failed'); } };
  assert.throws(() => probePreload.install(session, makeTempDir('qa009-register-')), /register failed/);
});

ok('main keeps the sandbox on and installs the probe only for a diagnostics run', () => {
  const main = read('main.js');
  assert.ok(
    main.includes("require('./diagnostics/main/probe-preload').install"),
    'diagnostics startup does not install the probe preload'
  );
  assert.ok(!main.includes("sandbox: role === 'diagnostics'"), 'the sandbox exception is still in main.js');
  assert.ok(main.includes('sandbox: true'), 'windowSecurity must force the sandbox on');
});

console.log(`preload-sandbox: ${passed} passed`);
