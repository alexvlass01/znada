'use strict';

// Behavior baseline through the real IPC handlers, stores, GC and tray controller.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./helpers/main-harness');
const L = require('../src/library');

function setup(dir) {
  const a = H.writeImage(path.join(dir, 'wallpapers', 'a.png'));
  const b = H.writeImage(path.join(dir, 'wallpapers', 'b.png'));
  const orphan = H.writeImage(path.join(dir, 'wallpapers', 'orphan.png'));
  const aId = L.idFor(a), bId = L.idFor(b);
  H.writeJson(path.join(dir, 'config.json'), {
    autoSwitch: false, separateThemes: true, wallpaperSchedule: { mode: 'off' },
    themeSchedule: { mode: 'off' }, lightWallpaper: a, darkWallpaper: b,
    monitors: { M1: { light: { itemIds: [aId, bId] }, dark: { itemIds: [bId] } },
      M2: { light: { itemIds: [bId] }, dark: { itemIds: [aId] } } },
    slideshowIndex: { M1: { light: 7, dark: 8 } },
    slideshowCurrentPath: { M1: { light: a, dark: b } },
  });
  H.writeJson(path.join(dir, 'config.library.json'), { version: 1, trash: [], library: {
    [aId]: { id: aId, type: 'image', path: a, addedAt: 1 },
    [bId]: { id: bId, type: 'image', path: b, addedAt: 2 },
  } });
  const m = H.loadMain(dir); m.__test.loadConfig(); m.__test.createTray();
  return { m, a, b, aId, bId, orphan };
}
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function poolStamp(dir) {
  const file = path.join(dir, 'config.library.json');
  return { sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    mtime: fs.statSync(file).mtimeMs };
}
// Observe actual filesystem effects and the real tray's menu build. No replacement
// for save/GC: all original calls still execute. Every assertion runs before restore.
let observationTime = Date.now();
function observe(dir, m, fn, expected) {
  // Advance the coalescer's clock between user actions; no real timer wait needed.
  const realNow = Date.now;
  observationTime += 1000;
  Date.now = () => observationTime;
  const events = [];
  const rename = fs.renameSync, link = fs.linkSync, readdir = fs.readdirSync;
  const stamp = poolStamp(dir);
  // The harness records the actual tray boundary below, rather than spying on main's text.
  const prior = m.calls.trayMenus.length;
  const sawGcMove = (to) => {
    if (path.resolve(to) !== path.join(dir, 'wallpapers', '.trash', 'orphan.png')) return;
    events.push('gc');
    assert.strictEqual(m.calls.trayMenus.length, prior + 1, 'save broadcasts before GC; explicit tray refresh follows GC');
    assert.deepStrictEqual(json(path.join(dir, 'config.json')).monitors,
      m.__test.getConfig().monitors, 'settings must be durable before GC');
  };
  fs.renameSync = (from, to) => {
    const dest = path.resolve(to);
    if (dest === path.join(dir, 'config.json')) events.push('settings');
    if (dest === path.join(dir, 'config.library.json')) events.push('pool');
    sawGcMove(to);
    return rename(from, to);
  };
  // BUG-084: the sweeper moves into .trash with a no-clobber hard link, not a rename.
  fs.linkSync = (from, to) => {
    sawGcMove(to);
    return link(from, to);
  };
  fs.readdirSync = (file, ...args) => {
    if (path.resolve(file) === path.join(dir, 'wallpapers')) events.push('scan');
    return readdir(file, ...args);
  };
  try {
    const result = fn();
    assert.strictEqual(result, m.__test.getConfig(), 'synchronous config response');
    assert.ok(!(result instanceof Promise));
    assert.deepStrictEqual(events, expected.events);
    assert.strictEqual(m.calls.trayMenus.length - prior,
      expected.tray + (expected.events.includes('settings') ? 1 : 0));
    assert.deepStrictEqual(poolStamp(dir), stamp, 'settings-only: pool bytes AND mtime unchanged');
    return result;
  } finally { fs.renameSync = rename; fs.linkSync = link; fs.readdirSync = readdir; Date.now = realNow; }
}
function reload(dir) {
  H.unloadMain(); const m = H.loadMain(dir); m.__test.loadConfig(); return m.__test.getConfig();
}
let passed = 0;
async function check(name, fn) {
  const dir = H.makeTempProfile('slot-placement');
  try { await fn(dir); passed++; console.log(`PASS ${name}`); }
  finally { H.unloadMain(); }
}
(async () => {
  await check('remove one then last: position, theme/monitor isolation, fallback and reload', dir => {
    const { m, a, b, aId, bId, orphan } = setup(dir);
    const before = structuredClone(m.__test.getConfig());
    const cfg = observe(dir, m, () => m.invoke('remove-slot-item', 'M1', 'other', '0'),
      { events: ['settings', 'scan', 'gc'], tray: 1 });
    assert.deepStrictEqual(cfg.monitors.M1.light.itemIds, [bId]);
    assert.ok(!cfg.monitors.M1.light.legacyFallbackDisabled);
    assert.strictEqual(cfg.slideshowIndex.M1.light, 7);
    assert.strictEqual(cfg.slideshowCurrentPath.M1.light, a);
    assert.deepStrictEqual(cfg.monitors.M1.dark, before.monitors.M1.dark);
    assert.deepStrictEqual(cfg.monitors.M2, before.monitors.M2);
    assert.ok(!fs.existsSync(orphan));
    observe(dir, m, () => m.invoke('remove-slot-item', 'M1', 'light', 0),
      { events: ['settings', 'scan'], tray: 1 });
    assert.deepStrictEqual(cfg.monitors.M1.light, { itemIds: [], legacyFallbackDisabled: true });
    assert.strictEqual(cfg.slideshowIndex.M1.light, 0);
    assert.strictEqual(cfg.slideshowCurrentPath.M1.light, '');
    assert.strictEqual(cfg.slideshowIndex.M1.dark, 8);
    assert.strictEqual(L.allowsLegacyFallback(cfg.monitors.M1.light), false, 'last removal suppresses legacy fallback');
    assert.ok(fs.existsSync(a) && fs.existsSync(b));
    assert.deepStrictEqual(Object.keys(cfg.library).sort(), [aId, bId].sort());
    const saved = reload(dir);
    assert.deepStrictEqual(saved.monitors.M1.light, cfg.monitors.M1.light);
    assert.strictEqual(saved.slideshowCurrentPath.M1.light, '');
  });
  for (const index of ['1', 0.8, NaN, -1, 2, 'bad', undefined]) {
    await check(`old index coercion ${String(index)}`, dir => {
      const { m, aId, bId } = setup(dir);
      const cfg = observe(dir, m, () => m.invoke('remove-slot-item', 'M1', 'light', index),
        { events: ['settings', 'scan', 'gc'], tray: 1 });
      const expected = index === '1' ? [aId] : index === 0.8 ? [bId] : [aId, bId];
      assert.deepStrictEqual(cfg.monitors.M1.light.itemIds, expected);
      assert.ok(!cfg.monitors.M1.light.legacyFallbackDisabled);
      assert.strictEqual(cfg.slideshowIndex.M1.light, 7);
    });
  }
  await check('clear dark, repeat and already empty: unconditional reset, no tray and reload', dir => {
    const { m, a } = setup(dir); const cfg = m.__test.getConfig();
    const light = structuredClone(cfg.monitors.M1.light);
    observe(dir, m, () => m.invoke('clear-slot', 'M1', 'dark'),
      { events: ['settings', 'scan', 'gc'], tray: 0 });
    assert.deepStrictEqual(cfg.monitors.M1.dark, { itemIds: [], legacyFallbackDisabled: true });
    assert.strictEqual(cfg.slideshowIndex.M1.dark, 0);
    assert.strictEqual(cfg.slideshowCurrentPath.M1.dark, '');
    assert.strictEqual(L.allowsLegacyFallback(cfg.monitors.M1.dark), false);
    assert.deepStrictEqual(cfg.monitors.M1.light, light);
    assert.strictEqual(cfg.slideshowCurrentPath.M1.light, a);
    cfg.slideshowIndex.M1.dark = 4; cfg.slideshowCurrentPath.M1.dark = a;
    observe(dir, m, () => m.invoke('clear-slot', 'M1', 'dark'),
      { events: ['settings', 'scan'], tray: 0 });
    assert.strictEqual(cfg.slideshowIndex.M1.dark, 0);
    assert.strictEqual(cfg.slideshowCurrentPath.M1.dark, '');
    assert.deepStrictEqual(reload(dir).monitors, cfg.monitors);
  });
  for (const channel of ['remove-slot-item', 'clear-slot']) {
    await check(`${channel}: missing/malformed slot and falsy monitor`, dir => {
      const { m } = setup(dir); const cfg = m.__test.getConfig();
      const before = structuredClone(cfg);
      for (const monitor of ['', null, undefined, 0, false]) {
        observe(dir, m, () => m.invoke(channel, monitor, 'dark', 0), { events: [], tray: 0 });
        assert.deepStrictEqual(cfg, before);
      }
      cfg.monitors.NEW = { light: null, dark: { itemIds: 'bad' } };
      observe(dir, m, () => m.invoke(channel, 'NEW', 'unknown', 0),
        { events: ['settings', 'scan', 'gc'], tray: channel === 'clear-slot' ? 0 : 1 });
      assert.deepStrictEqual(cfg.monitors.NEW.dark, { itemIds: [] });
      assert.deepStrictEqual(cfg.monitors.NEW.light,
        channel === 'clear-slot' ? { itemIds: [], legacyFallbackDisabled: true } : { itemIds: [] });
      assert.strictEqual(L.allowsLegacyFallback(cfg.monitors.NEW.light), channel !== 'clear-slot');
      observe(dir, m, () => m.invoke(channel, 'MISSING', 'dark', 0),
        { events: ['settings', 'scan'], tray: channel === 'clear-slot' ? 0 : 1 });
      assert.deepStrictEqual(cfg.monitors.MISSING.light, { itemIds: [] });
      assert.deepStrictEqual(reload(dir).monitors, cfg.monitors);
    });
    await check(`${channel}: remains unlocked while another library transaction is pending`, async dir => {
      const { m } = setup(dir); let release;
      const held = m.__test.withLibraryLock(() => new Promise(resolve => { release = resolve; }));
      await Promise.resolve();
      try {
        observe(dir, m, () => m.invoke(channel, 'M1', 'dark', 0),
          { events: ['settings', 'scan', 'gc'], tray: channel === 'clear-slot' ? 0 : 1 });
      } finally { release(); await held; }
    });
  }
  console.log(`All ${passed} slot-placement main checks passed.`);
})().catch(err => { console.error(err); process.exitCode = 1; });
