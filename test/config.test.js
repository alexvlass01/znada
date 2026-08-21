'use strict';

// Plain Node test: `node test/config.test.js`. Covers config load / migration /
// save — the logic that silently lost user settings in the past if it regressed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/config');
const L = require('../src/library');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-cfg-'));
const p = (name) => path.join(tmp, name);

// missing file -> defaults
const d = C.load(p('nope.json'));
ok('load missing file -> defaults', d.autoSwitch === true && d.wallpaperSchedule.mode === 'system' && d.slideshow.intervalEnabled === true && d.slideshow.intervalMin === 30 && typeof d.monitors === 'object');

// freshDefaults must be independent (no shared nested objects)
const a = C.freshDefaults();
const b = C.freshDefaults();
a.monitors.X = 1; a.slideshowIndex.Y = 2; a.slideshowCurrentPath.Z = { light: 'C:/x.jpg' };
ok('freshDefaults are independent copies',
  b.monitors.X === undefined && b.slideshowIndex.Y === undefined && b.slideshowCurrentPath.Z === undefined
  && C.DEFAULT_CONFIG.monitors.X === undefined);

// legacy migration: string slot -> { items: [...] }, slideshow sanitized
fs.writeFileSync(p('legacy.json'), JSON.stringify({
  monitors: { M1: { light: 'C:/a.jpg', dark: '' } },
  slideshow: { intervalMin: 0, order: 'weird', enabled: 1 },
}));
const mig = C.load(p('legacy.json'));
ok('legacy string slot migrated to library itemIds',
  mig.monitors.M1.light.itemIds.length === 1
  && L.getItem(mig.library, mig.monitors.M1.light.itemIds[0]).path === 'C:/a.jpg'
  && mig.monitors.M1.dark.itemIds.length === 0);
ok('slideshow values sanitized',
  mig.slideshow.intervalEnabled === true && mig.slideshow.intervalMin === 30
  && mig.slideshow.order === 'sequential' && mig.slideshow.enabled === true);
fs.writeFileSync(p('interval_off.json'), JSON.stringify({ slideshow: { enabled: true, intervalEnabled: false, intervalMin: 15 } }));
const intervalOff = C.load(p('interval_off.json'));
ok('explicitly disabled slideshow interval survives load',
  intervalOff.slideshow.enabled === true && intervalOff.slideshow.intervalEnabled === false && intervalOff.slideshow.intervalMin === 15);
fs.writeFileSync(p('slideshow_paths.json'), JSON.stringify({
  slideshowCurrentPath: { M1: { light: 'C:/light.jpg', dark: 42 }, bad: 'junk' },
}));
const slideshowPaths = C.load(p('slideshow_paths.json'));
ok('slideshow current paths are normalized safely', slideshowPaths.slideshowCurrentPath.M1.light === 'C:/light.jpg'
  && slideshowPaths.slideshowCurrentPath.M1.dark === ''
  && slideshowPaths.slideshowCurrentPath.bad === undefined);

// save + reload round-trip (atomic write)
const cfg = C.freshDefaults();
cfg.style = 'fit';
cfg.monitors.MON = { light: { items: [{ type: 'folder', path: 'C:/pics' }] }, dark: { items: [] } };
C.save(cfg, p('rt.json'));
const back = C.load(p('rt.json'));
ok('save then reload round-trips (slots → library itemIds)',
  back.style === 'fit'
  && L.getItem(back.library, back.monitors.MON.light.itemIds[0]).type === 'folder');

// corrupt file -> defaults + a backup is written
fs.writeFileSync(p('bad.json'), '{ this is not valid json ');
const rec = C.load(p('bad.json'));
const backups = fs.readdirSync(tmp).filter((f) => f.startsWith('bad.json.corrupt-'));
ok('corrupt file -> defaults + backup saved', rec.autoSwitch === true && backups.length === 1);

// Hotkey normalization tests
const fresh = C.freshDefaults();
ok('fresh defaults contain hotkeys config', fresh.hotkeys && fresh.hotkeys.nextWallpaper && fresh.hotkeys.nextWallpaper.enabled === false && fresh.hotkeys.nextWallpaper.shortcut === '');

fs.writeFileSync(p('hotkeys_bad.json'), JSON.stringify({
  hotkeys: {
    nextWallpaper: {
      enabled: 1,
      shortcut: 123
    }
  }
}));
const loadedHotkeys = C.load(p('hotkeys_bad.json'));
ok('hotkeys config is normalized correctly', loadedHotkeys.hotkeys.nextWallpaper.enabled === true && loadedHotkeys.hotkeys.nextWallpaper.shortcut === '');

// Game Mode configuration tests
ok('fresh defaults contain gameModeBlock config', fresh.gameModeBlock === false);
fs.writeFileSync(p('gamemode_bad.json'), JSON.stringify({
  gameModeBlock: 1
}));
const loadedGameMode = C.load(p('gamemode_bad.json'));
ok('gameModeBlock config is normalized to boolean', loadedGameMode.gameModeBlock === true);

// Trigger configuration tests
ok('fresh defaults contain triggers config', fresh.triggers && fresh.triggers.onStartup === false && fresh.triggers.onWakeup === false
  && fresh.triggers.stealth && fresh.triggers.stealth.enabled === false && fresh.triggers.stealth.startup === true
  && fresh.triggers.stealth.wakeup === true && fresh.triggers.stealth.interval === false && fresh.triggers.stealth.timeoutMin === 5);
fs.writeFileSync(p('triggers_bad.json'), JSON.stringify({
  triggers: {
    onStartup: 1,
    onWakeup: 'yes',
    stealth: 1
  }
}));
const loadedTriggers = C.load(p('triggers_bad.json'));
// Legacy stealth:1 (truthy boolean-ish) → enabled object with startup+wakeup, interval off.
ok('triggers config is normalized (onStartup/onWakeup booleans, legacy stealth → enabled object)',
  loadedTriggers.triggers.onStartup === true && loadedTriggers.triggers.onWakeup === true
  && loadedTriggers.triggers.stealth.enabled === true && loadedTriggers.triggers.stealth.startup === true
  && loadedTriggers.triggers.stealth.wakeup === true && loadedTriggers.triggers.stealth.interval === false
  && loadedTriggers.triggers.stealth.timeoutMin === 5);

// Legacy stealth: false → disabled object (scopes default on, interval off)
fs.writeFileSync(p('triggers_legacy_off.json'), JSON.stringify({ triggers: { onStartup: true, stealth: false } }));
const legacyOff = C.load(p('triggers_legacy_off.json'));
ok('legacy stealth:false → disabled object with default scopes',
  legacyOff.triggers.stealth.enabled === false && legacyOff.triggers.stealth.startup === true
  && legacyOff.triggers.stealth.wakeup === true && legacyOff.triggers.stealth.interval === false);

// New object shape is preserved + timeout clamped
fs.writeFileSync(p('triggers_obj.json'), JSON.stringify({
  triggers: { stealth: { enabled: true, startup: false, wakeup: true, interval: true, timeoutMin: 0 } },
}));
const objStealth = C.load(p('triggers_obj.json'));
ok('object stealth preserved, invalid timeout → 5',
  objStealth.triggers.stealth.enabled === true && objStealth.triggers.stealth.startup === false
  && objStealth.triggers.stealth.interval === true && objStealth.triggers.stealth.timeoutMin === 5);
fs.writeFileSync(p('triggers_obj2.json'), JSON.stringify({ triggers: { stealth: { enabled: true, timeoutMin: 120 } } }));
ok('timeout clamped to 60 max', C.load(p('triggers_obj2.json')).triggers.stealth.timeoutMin === 60);

// triggers missing entirely → defaults
fs.writeFileSync(p('triggers_missing.json'), JSON.stringify({ autoSwitch: true }));
const loadedNoTriggers = C.load(p('triggers_missing.json'));
ok('missing triggers → defaults (events off, stealth disabled object)',
  loadedNoTriggers.triggers.onStartup === false && loadedNoTriggers.triggers.onWakeup === false
  && loadedNoTriggers.triggers.stealth.enabled === false && loadedNoTriggers.triggers.stealth.timeoutMin === 5);

// ---- A real user's config survives an update unchanged (no settings "wiped") ----
// Mirrors a populated installed config (legacy boolean stealth) to guard against migration
// data loss: loading it must preserve every user setting and only migrate the shape.
const realUser = {
  singleWallpaper: false, separateThemes: true,
  monitors: { 'DISPLAY#A': { light: { itemIds: ['id1'] }, dark: { itemIds: ['id2'] } } },
  library: {
    id1: { id: 'id1', type: 'image', path: 'C:/a.jpg', addedAt: 111, favorite: true, tags: ['x'] },
    id2: { id: 'id2', type: 'image', path: 'C:/b.jpg', addedAt: 222, favorite: false, tags: [] },
  },
  style: 'fit', autostart: true, startMinimized: false, language: 'ru', gameModeBlock: true,
  slideshow: { enabled: true, intervalEnabled: true, intervalMin: 120, order: 'shuffle' },
  slideshowIndex: { 'DISPLAY#A': { light: 3, dark: 1 } },
  slideshowCurrentPath: { 'DISPLAY#A': { light: 'C:/a.jpg', dark: 'C:/b.jpg' } },
  hotkeys: { nextWallpaper: { enabled: true, shortcut: 'Ctrl+Alt+N' } },
  triggers: { onStartup: true, onWakeup: true, stealth: true }, // legacy boolean
  wallpaperSchedule: { mode: 'sun', lightStart: '06:30', darkStart: '21:00' },
  themeSchedule: { mode: 'time', lightStart: '08:00', darkStart: '19:00', lat: '50', lng: '30' },
  onlineSources: { lumina: true, internet: true }, onlineSort: 'random',
  onlinePurity: { sfw: true, sketchy: false, nsfw: true }, viewerBackground: 'charcoal',
};
fs.writeFileSync(p('real_user.json'), JSON.stringify(realUser));
const ru = C.load(p('real_user.json'));
ok('update keeps slideshow settings', ru.slideshow.enabled === true && ru.slideshow.intervalMin === 120 && ru.slideshow.order === 'shuffle');
ok('update keeps library + monitor slots', Object.keys(ru.library).length === 2 && ru.library.id1.favorite === true
  && ru.library.id1.tags[0] === 'x' && ru.monitors['DISPLAY#A'].light.itemIds[0] === 'id1' && ru.monitors['DISPLAY#A'].dark.itemIds[0] === 'id2');
ok('update keeps slideshow position', ru.slideshowIndex['DISPLAY#A'].light === 3 && ru.slideshowCurrentPath['DISPLAY#A'].dark === 'C:/b.jpg');
ok('update keeps misc settings', ru.style === 'fit' && ru.autostart === true && ru.startMinimized === false && ru.language === 'ru'
  && ru.gameModeBlock === true && ru.hotkeys.nextWallpaper.shortcut === 'Ctrl+Alt+N' && ru.viewerBackground === 'charcoal');
ok('update keeps schedules + online prefs', ru.wallpaperSchedule.mode === 'sun' && ru.themeSchedule.lightStart === '08:00'
  && ru.onlineSort === 'random' && ru.onlinePurity.nsfw === true && ru.onlineSources.lumina === true);
ok('legacy stealth boolean migrates, enabled state kept', ru.triggers.stealth.enabled === true && ru.triggers.onStartup === true && ru.triggers.onWakeup === true);
// Re-loading the already-migrated config must not drift (a second update is a no-op).
fs.writeFileSync(p('real_user2.json'), JSON.stringify(ru));
const ru2 = C.load(p('real_user2.json'));
ok('migration is idempotent (no drift on the next update)',
  ru2.slideshow.intervalMin === 120 && ru2.slideshow.order === 'shuffle' && ru2.triggers.stealth.enabled === true
  && Object.keys(ru2.library).length === 2 && ru2.slideshowIndex['DISPLAY#A'].light === 3);

// themeOverride / librarySort: invalid values collapse to safe defaults, valid pass through
fs.writeFileSync(p('override_bad.json'), JSON.stringify({ themeOverride: 'banana', _lastAutoTheme: 42, librarySort: 'nope' }));
const loadedBadOverride = C.load(p('override_bad.json'));
ok('invalid themeOverride/_lastAutoTheme → null, bad librarySort → added',
  loadedBadOverride.themeOverride === null && loadedBadOverride._lastAutoTheme === null && loadedBadOverride.librarySort === 'added');
fs.writeFileSync(p('override_ok.json'), JSON.stringify({ themeOverride: 'dark', _lastAutoTheme: 'light', librarySort: 'shuffle' }));
const loadedOkOverride = C.load(p('override_ok.json'));
ok('valid themeOverride/_lastAutoTheme/librarySort pass through',
  loadedOkOverride.themeOverride === 'dark' && loadedOkOverride._lastAutoTheme === 'light' && loadedOkOverride.librarySort === 'shuffle');

// separateThemes: defaults ON; only an explicit false turns it off (old configs without
// the field — i.e. every pre-1.2.5 user — must stay in the classic day/night mode)
ok('separateThemes defaults to true', C.freshDefaults().separateThemes === true);
fs.writeFileSync(p('sep_missing.json'), JSON.stringify({ autoSwitch: true }));
ok('missing separateThemes → true (existing users keep day/night)', C.load(p('sep_missing.json')).separateThemes === true);
fs.writeFileSync(p('sep_off.json'), JSON.stringify({ separateThemes: false }));
ok('explicit separateThemes:false survives load', C.load(p('sep_off.json')).separateThemes === false);
fs.writeFileSync(p('sep_junk.json'), JSON.stringify({ separateThemes: 0 }));
ok('junk separateThemes coerces to true (safe default)', C.load(p('sep_junk.json')).separateThemes === true);

// wallpaperSchedule: migrate the legacy autoSwitch flag and keep the mirror compatible
// with old installed builds that may read the same config after a dev run.
fs.writeFileSync(p('wall_legacy_on.json'), JSON.stringify({ autoSwitch: true }));
const wallLegacyOn = C.load(p('wall_legacy_on.json'));
ok('legacy autoSwitch:true -> wallpaper system mode', wallLegacyOn.wallpaperSchedule.mode === 'system' && wallLegacyOn.autoSwitch === true);
fs.writeFileSync(p('wall_legacy_off.json'), JSON.stringify({ autoSwitch: false }));
const wallLegacyOff = C.load(p('wall_legacy_off.json'));
ok('legacy autoSwitch:false -> wallpaper off mode', wallLegacyOff.wallpaperSchedule.mode === 'off' && wallLegacyOff.autoSwitch === false);
fs.writeFileSync(p('wall_time.json'), JSON.stringify({ autoSwitch: true, wallpaperSchedule: { mode: 'time', lightStart: '06:30', darkStart: '22:15' } }));
const wallTime = C.load(p('wall_time.json'));
ok('wallpaper time schedule survives and disables legacy system-follow mirror',
  wallTime.wallpaperSchedule.mode === 'time'
  && wallTime.wallpaperSchedule.lightStart === '06:30'
  && wallTime.wallpaperSchedule.darkStart === '22:15'
  && wallTime.autoSwitch === false);
fs.writeFileSync(p('wall_bad.json'), JSON.stringify({ wallpaperSchedule: { mode: 'banana', lightStart: 7, darkStart: null } }));
const wallBad = C.load(p('wall_bad.json'));
ok('invalid wallpaper schedule falls back safely',
  wallBad.wallpaperSchedule.mode === 'system'
  && wallBad.wallpaperSchedule.lightStart === '07:00'
  && wallBad.wallpaperSchedule.darkStart === '20:00');

// onlineSources (Cloud C2): default external-only; booleanized; never both-off
ok('fresh defaults: onlineSources internet on, lumina off',
  fresh.onlineSources && fresh.onlineSources.internet === true && fresh.onlineSources.lumina === false);
fs.writeFileSync(p('sources_missing.json'), JSON.stringify({ autoSwitch: true }));
ok('missing onlineSources → external only', (() => {
  const s = C.load(p('sources_missing.json')).onlineSources;
  return s.internet === true && s.lumina === false;
})());
fs.writeFileSync(p('sources_both.json'), JSON.stringify({ onlineSources: { lumina: 1, internet: 'yes' } }));
ok('onlineSources coerced to booleans', (() => {
  const s = C.load(p('sources_both.json')).onlineSources;
  return s.lumina === true && s.internet === true;
})());
fs.writeFileSync(p('sources_none.json'), JSON.stringify({ onlineSources: { lumina: false, internet: false } }));
ok('both sources off → internet forced on (no empty Online page)', (() => {
  const s = C.load(p('sources_none.json')).onlineSources;
  return s.internet === true && s.lumina === false;
})());
fs.writeFileSync(p('sources_lumina.json'), JSON.stringify({ onlineSources: { lumina: true, internet: false } }));
ok('lumina-only selection survives', (() => {
  const s = C.load(p('sources_lumina.json')).onlineSources;
  return s.lumina === true && s.internet === false;
})());

// onlineSort / onlinePurity (persisted Online search params)
ok('fresh defaults: onlineSort date_added, purity sfw+sketchy',
  fresh.onlineSort === 'date_added' && fresh.onlinePurity.sfw === true && fresh.onlinePurity.sketchy === true && fresh.onlinePurity.nsfw === false);
fs.writeFileSync(p('online_params.json'), JSON.stringify({ onlineSort: 'toplist', onlinePurity: { sfw: false, sketchy: 0, nsfw: 'yes' } }));
ok('valid onlineSort survives; purity coerced to booleans', (() => {
  const c = C.load(p('online_params.json'));
  return c.onlineSort === 'toplist' && c.onlinePurity.sfw === false && c.onlinePurity.sketchy === false && c.onlinePurity.nsfw === true;
})());
fs.writeFileSync(p('online_bad.json'), JSON.stringify({ onlineSort: 'banana', onlinePurity: { sfw: false, sketchy: false, nsfw: false } }));
ok('bad onlineSort → date_added; all-off purity → sfw forced on', (() => {
  const c = C.load(p('online_bad.json'));
  return c.onlineSort === 'date_added' && c.onlinePurity.sfw === true;
})());

// viewerBackground: fresh default is ambient; valid values pass; bad → ambient
ok('fresh default: viewerBackground ambient', fresh.viewerBackground === 'ambient');
fs.writeFileSync(p('viewerbg_ok.json'), JSON.stringify({ viewerBackground: 'aurora' }));
ok('valid viewerBackground passes through', C.load(p('viewerbg_ok.json')).viewerBackground === 'aurora');
fs.writeFileSync(p('viewerbg_bad.json'), JSON.stringify({ viewerBackground: 'banana' }));
ok('bad viewerBackground → ambient', C.load(p('viewerbg_bad.json')).viewerBackground === 'ambient');

// anonId: fresh default empty; well-formed passes; garbage/non-string → '' (main regenerates)
ok('fresh default: anonId empty', fresh.anonId === '');
fs.writeFileSync(p('anon_ok.json'), JSON.stringify({ anonId: '0123456789abcdef0123456789abcdef' }));
ok('valid anonId passes through', C.load(p('anon_ok.json')).anonId === '0123456789abcdef0123456789abcdef');
fs.writeFileSync(p('anon_bad.json'), JSON.stringify({ anonId: 'short!!' }));
ok('garbage anonId → empty', C.load(p('anon_bad.json')).anonId === '');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll ' + passed + ' config tests passed.');
