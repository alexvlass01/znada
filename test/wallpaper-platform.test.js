'use strict';

// CODE-001 1.4. Real files in disposable profiles, fake host/runner: no desktop changes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeTempDir } = require('./helpers/temp-dir');
const { create } = require('../src/wallpaper-platform');
const { HOST_SCRIPT } = require('../src/wallpaper-host');

const MONITOR = { id: 'device\\экран 1', x: 0, y: 0, w: 1920, h: 1080 };
const SECOND = { id: 'device-2', x: -1920, y: 0, w: 1920, h: 1080 };
function setup() {
  const dir = makeTempDir('znada-platform-');
  let config = { style: 'fill', gameModeBlock: true };
  let timeout = 123;
  const calls = [];
  const hostCalls = [];
  const host = {
    enumMonitors: async () => [MONITOR, SECOND],
    apply: async (...args) => { hostCalls.push(args); },
    checkFullscreen: async () => true,
    checkMaximized: async (ms) => { assert.strictEqual(ms, 2000); return [MONITOR.id]; },
    dispose: () => { hostCalls.push('dispose'); },
  };
  const runner = { run: async (...args) => { calls.push(args); return { stdout: '[]' }; } };
  const service = create({
    userDataPath: dir, getConfig: () => config, powershellExe: 'System32/powershell.exe',
    getPowerShellTimeout: () => timeout, systemChildren: runner,
    createHost: (p) => { assert.strictEqual(p, path.join(dir, 'wallpaper-host.ps1')); return host; },
    hostScript: HOST_SCRIPT,
  });
  const items = [{ id: MONITOR.id, path: path.join(dir, 'картинка с пробелом.png') }];
  fs.writeFileSync(items[0].path, 'test image');
  const reply = (stdout) => { runner.run = async (...args) => { calls.push(args); return { stdout }; }; };
  return { dir, service, host, runner, calls, hostCalls, items, reply,
    setConfig: (next) => { config = next; }, setTimeout: (next) => { timeout = next; } };
}
const fail = async () => { throw new Error('transport failed'); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
let passed = 0;
async function test(name, fn) {
  const originalError = console.error;
  console.error = () => {};
  try { await fn(); passed++; console.log('  OK ' + name); }
  finally { console.error = originalError; }
}

(async () => {
  await test('writes exactly the original PowerShell scripts and injected host script', () => {
    const t = setup(); t.service.ensureScripts();
    // Digests of runtime strings on cc2bba2 (LF-normalized source), before extraction.
    assert.strictEqual(sha(fs.readFileSync(path.join(t.dir, 'set-wallpaper.ps1'))),
      'c55a7a4480002f7635153f555dfcdad36f58f25966bc807422aca595dec74a13');
    assert.strictEqual(sha(fs.readFileSync(path.join(t.dir, 'wallpaper-com.ps1'))),
      'df11717ab87ec63c1bc5f71f67db0e94135ab1c7a12e63aee73f6a08c009558e');
    assert.strictEqual(fs.readFileSync(path.join(t.dir, 'wallpaper-host.ps1'), 'utf8'), HOST_SCRIPT);
    t.service.ensureScripts();
    assert.strictEqual(t.calls.length, 0);
  });
  await test('host enumeration retains stable device paths, negative coordinates and primary', async () => {
    const t = setup();
    assert.deepStrictEqual(await t.service.getMonitors(), [
      { ...MONITOR, primary: true }, { ...SECOND, primary: false },
    ]);
    assert.strictEqual(t.calls.length, 0);
    t.host.enumMonitors = async () => [];
    assert.deepStrictEqual(await t.service.getMonitors(), []);
  });
  await test('enumeration falls back to bounded COM for singleton, array and empty responses', async () => {
    const t = setup(); t.host.enumMonitors = fail;
    for (const [wire, expected] of [[MONITOR, [MONITOR]], [[SECOND], [SECOND]], [[], []]]) {
      t.reply(JSON.stringify(wire));
      assert.deepStrictEqual(await t.service.getMonitors(), expected.map(m => ({ ...m, primary: m.x === 0 && m.y === 0 })));
    }
    t.reply(''); assert.deepStrictEqual(await t.service.getMonitors(), []);
    assert.deepStrictEqual(t.calls[0], ['System32/powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(t.dir, 'wallpaper-com.ps1'), '-Mode', 'enum',
    ], { timeoutMs: 123, maxBuffer: 4 * 1024 * 1024 }]);
    t.setTimeout(7); await t.service.getMonitors();
    assert.strictEqual(t.calls.at(-1)[2].timeoutMs, 7);
  });
  await test('invalid JSON or failed COM enumeration returns the previous empty-list outcome', async () => {
    const t = setup(); t.host.enumMonitors = fail;
    t.reply('broken JSON'); assert.deepStrictEqual(await t.service.getMonitors(), []);
    t.runner.run = fail; assert.deepStrictEqual(await t.service.getMonitors(), []);
  });
  await test('fullscreen uses current config and preserves host and COM boolean semantics', async () => {
    const t = setup();
    assert.strictEqual(await t.service.isGameOrFullscreenRunning(), true);
    t.host.checkFullscreen = fail; t.reply(' True\r\n');
    assert.strictEqual(await t.service.isGameOrFullscreenRunning(), true);
    assert.deepStrictEqual(t.calls.at(-1)[1].slice(-2), ['-Mode', 'check-fullscreen']);
    t.reply('true'); assert.strictEqual(await t.service.isGameOrFullscreenRunning(), false);
    t.runner.run = fail; assert.strictEqual(await t.service.isGameOrFullscreenRunning(), false);
    t.setConfig({ gameModeBlock: false });
    t.host.checkFullscreen = () => { assert.fail('disabled game mode asked the host'); };
    assert.strictEqual(await t.service.isGameOrFullscreenRunning(), false);
  });
  await test('host applies every style with current config; success never spawns COM', async () => {
    const t = setup();
    for (const [style, position] of Object.entries({ center: 0, tile: 1, stretch: 2, fit: 3, fill: 4, span: 5, unknown: 4 })) {
      t.setConfig({ style });
      assert.strictEqual(await t.service.applyPerMonitor(t.items, () => false), 'applied');
      assert.deepStrictEqual(t.hostCalls.at(-1), [position, t.items]);
    }
    assert.strictEqual(t.calls.length, 0);
    assert.strictEqual(fs.existsSync(path.join(t.dir, 'apply.json')), false);
  });
  await test('host failure writes exact Unicode payload and preserves chosen style across await', async () => {
    const t = setup(); t.setConfig({ style: 'fit' });
    t.host.apply = async () => { t.setConfig({ style: 'tile' }); throw new Error('host lost'); };
    assert.strictEqual(await t.service.applyPerMonitor(t.items, () => false), 'applied');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(t.dir, 'apply.json'))), { position: 3, items: t.items });
    assert.deepStrictEqual(t.calls[0][1].slice(-4), ['-Mode', 'apply', '-DataFile', path.join(t.dir, 'apply.json')]);
    assert.deepStrictEqual(t.calls[0][2], { timeoutMs: 123, maxBuffer: 4 * 1024 * 1024 });
  });
  await test('superseded intent after failed host neither writes nor starts the COM fallback', async () => {
    const t = setup(); t.host.apply = fail;
    assert.strictEqual(await t.service.applyPerMonitor(t.items, () => true), 'superseded');
    assert.strictEqual(t.calls.length, 0);
    assert.strictEqual(fs.existsSync(path.join(t.dir, 'apply.json')), false);
  });
  await test('COM failure or unwritable payload hands legacy selection back to main', async () => {
    const t = setup(); t.host.apply = fail; t.runner.run = fail;
    assert.strictEqual(await t.service.applyPerMonitor(t.items, () => false), 'failed');
    fs.unlinkSync(path.join(t.dir, 'apply.json')); fs.mkdirSync(path.join(t.dir, 'apply.json'));
    t.reply('');
    assert.strictEqual(await t.service.applyPerMonitor(t.items, () => false), 'failed');
    assert.strictEqual(t.calls.length, 0);
  });
  await test('legacy uses the same style mapping, runner deadline and unescaped file argument', async () => {
    const t = setup();
    for (const [style, values] of Object.entries({ fill: [10, 0], fit: [6, 0], stretch: [2, 0], center: [0, 0], tile: [0, 1], span: [22, 0], unknown: [10, 0] })) {
      t.setConfig({ style }); t.setTimeout(99);
      assert.strictEqual(await t.service.setWallpaper(t.items[0].path), undefined);
      assert.deepStrictEqual(t.calls.at(-1), ['System32/powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(t.dir, 'set-wallpaper.ps1'),
        '-Path', t.items[0].path, '-Style', String(values[0]), '-Tile', String(values[1]),
      ], { timeoutMs: 99 }]);
    }
    const count = t.calls.length;
    await assert.rejects(t.service.setWallpaper(''), /Файл обоев не найден/);
    await assert.rejects(t.service.setWallpaper(path.join(t.dir, 'missing.png')), /Файл обоев не найден/);
    assert.strictEqual(t.calls.length, count);
    t.runner.run = fail; await assert.rejects(t.service.setWallpaper(t.items[0].path), /transport failed/);
  });
  await test('coverage keeps its deadline and empty fallback; disposal belongs to its instance', async () => {
    const a = setup(), b = setup();
    assert.deepStrictEqual(await a.service.checkCovered(), [MONITOR.id]);
    a.host.checkMaximized = fail; assert.deepStrictEqual(await a.service.checkCovered(), []);
    a.service.dispose(); assert.deepStrictEqual(a.hostCalls, ['dispose']);
    assert.deepStrictEqual(b.hostCalls, []);
    b.host.apply = fail; await b.service.applyPerMonitor(b.items, () => false);
    assert.strictEqual(fs.existsSync(path.join(a.dir, 'apply.json')), false);
    assert.strictEqual(fs.existsSync(path.join(b.dir, 'apply.json')), true);
  });
  console.log(`\n${passed} wallpaper-platform tests passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
