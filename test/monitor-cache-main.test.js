'use strict';

// QA-020 / Issue #153. The shared monitor snapshot is written only inside main.getMonitors.
// Harnesses that call setMonitorsCache stay green if that assignment disappears, because
// they never ask the real enumeration to publish what it just learned.
//
// This drives the real WallpaperHost (its stdin/stdout protocol, with a stand-in process)
// through the real get-monitors IPC and then reads two consumers of the snapshot:
// the viewer's assign chooser (card-assign-targets) and, with singleWallpaper on, which
// photo current-image treats as current. Both must change after the first enumeration
// and again after a later one. The IPC return value alone is not the assertion: a
// getMonitors that returns the host list without storing it would still satisfy that.
// Nothing here calls setMonitorsCache, and the stand-in must not be asked to apply.

const assert = require('assert');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const { pathKey } = require('../src/path-key');
const { makeFakeHost, turns } = require('./helpers/schedule-harness');

const LEFT = { id: 'DISPLAY-LEFT', x: 0, y: 0, w: 1920, h: 1080 };
const RIGHT = { id: 'DISPLAY-RIGHT', x: 0, y: 0, w: 1080, h: 1920 };

function picture(dir, name) {
  const file = H.writeImage(path.join(dir, 'pics', `${name}.png`));
  const id = library.idFor(file);
  return { id, file, item: { id, type: 'image', path: file, tags: [], addedAt: 1 } };
}

(async () => {
  const dir = H.makeTempProfile('qa020-monitors');
  const left = picture(dir, 'left');
  const right = picture(dir, 'right');
  H.writeJson(path.join(dir, 'config.json'), {
    autoSwitch: false,
    singleWallpaper: true,
    separateThemes: true,
    style: 'fill',
    monitors: {
      [LEFT.id]: { light: { itemIds: [left.id] }, dark: { itemIds: [] } },
      [RIGHT.id]: { light: { itemIds: [right.id] }, dark: { itemIds: [] } },
    },
    themeSchedule: { mode: 'off', lightStart: '07:00', darkStart: '20:00', lat: '', lng: '' },
    wallpaperSchedule: { mode: 'off', lightStart: '07:00', darkStart: '20:00' },
    slideshow: { enabled: false, intervalEnabled: false, intervalMin: 30, order: 'sequential' },
    triggers: { onStartup: false, onWakeup: false, stealth: { enabled: false, startup: false, wakeup: false, interval: false, timeoutMin: 5 } },
  });
  H.writeJson(path.join(dir, 'config.library.json'), {
    version: 1,
    library: { [left.id]: left.item, [right.id]: right.item },
    trash: [],
  });

  delete require.cache[require.resolve(path.join(H.ROOT, 'src', 'wallpaper-host.js'))];
  const host = makeFakeHost();
  const main = H.loadMain(dir, { childProcess: { spawn: host.spawn } });
  main.__test.loadConfig();
  main.__test.setMonitorsCache = () => {
    throw new Error('QA-020 must observe the snapshot getMonitors publishes, not seed it');
  };
  assert.strictEqual(main.__test.getConfig().singleWallpaper, true, 'singleWallpaper stays on so current-image follows the snapshot');

  async function observe() {
    const chooser = await main.invoke('card-assign-targets');
    const current = await main.invoke('current-image', 'not-a-monitor', 'light');
    return {
      monitors: chooser.monitors.map((m) => ({ id: m.id, primary: !!m.primary })),
      current: pathKey(current),
    };
  }

  const before = await observe();
  assert.deepStrictEqual(before.monitors, [], 'before enumeration the chooser sees an empty snapshot');
  assert.strictEqual(before.current, '', 'before enumeration singleWallpaper has no primary photo');
  assert.deepStrictEqual(host.commands.map((c) => c.op), [], 'the stand-in is idle until getMonitors asks');

  host.answer('enum', { ok: true, monitors: [{ id: LEFT.id, x: LEFT.x, y: LEFT.y, w: LEFT.w, h: LEFT.h }] });
  const firstEnum = await main.invoke('get-monitors');
  assert.deepStrictEqual(firstEnum.map((m) => ({ id: m.id, w: m.w, h: m.h, primary: m.primary })), [
    { id: LEFT.id, w: LEFT.w, h: LEFT.h, primary: true },
  ]);
  const afterFirst = await observe();
  assert.deepStrictEqual(afterFirst.monitors, [{ id: LEFT.id, primary: true }], 'first enumeration publishes the left monitor');
  assert.strictEqual(afterFirst.current, pathKey(left.file), 'the shared snapshot makes the left photo current');

  host.answer('enum', { ok: true, monitors: [{ id: RIGHT.id, x: RIGHT.x, y: RIGHT.y, w: RIGHT.w, h: RIGHT.h }] });
  const secondEnum = await main.invoke('get-monitors');
  assert.deepStrictEqual(secondEnum.map((m) => ({ id: m.id, w: m.w, h: m.h, primary: m.primary })), [
    { id: RIGHT.id, w: RIGHT.w, h: RIGHT.h, primary: true },
  ]);
  const afterSecond = await observe();
  assert.deepStrictEqual(afterSecond.monitors, [{ id: RIGHT.id, primary: true }], 'a later enumeration replaces the shared snapshot');
  assert.strictEqual(afterSecond.current, pathKey(right.file), 'the current photo follows the refreshed snapshot');
  assert.deepStrictEqual(host.commands.map((c) => c.op), ['enum', 'enum'], 'only enumeration reached the stand-in; wallpapers were not applied');

  H.unloadMain();
  await turns();
  console.log('PASS monitor-cache-main: chooser and current photo follow both enumerations');
})().catch((error) => {
  console.error(error);
  try { H.unloadMain(); } catch {}
  process.exitCode = 1;
});
