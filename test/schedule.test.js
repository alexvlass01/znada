'use strict';

// Plain Node test: `node test/schedule.test.js`. Covers the day/night schedule math
// (parseHM / sunrise equation / boundaries / saysDark / next-boundary timer) that drives
// "switch theme by time / by sun" — previously untested inside main.js.

const assert = require('assert');
const S = require('../src/schedule');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

// ---- parseHM ----
ok('parseHM: HH:MM', S.parseHM('07:30') === 450 && S.parseHM('23:59') === 1439 && S.parseHM('00:00') === 0);
ok('parseHM: garbage/empty -> 0', S.parseHM('') === 0 && S.parseHM(null) === 0 && S.parseHM('abc') === 0);
ok('parseHM: hours only (missing minutes -> 0)', S.parseHM('7') === 420);

// ---- sunUT (classic sunrise equation; assert sane ranges, not exact astronomy) ----
const june10 = new Date(Date.UTC(2026, 5, 10, 12, 0));
const kyiv = S.sunUT(june10, 50.45, 30.52);
ok('sunUT: Kyiv summer sunrise ~01-03 UT', kyiv.sunrise > 1 && kyiv.sunrise < 3);
ok('sunUT: Kyiv summer sunset ~17-19 UT', kyiv.sunset > 17 && kyiv.sunset < 19);
const equator = S.sunUT(june10, 0, 0);
ok('sunUT: equator has both, ~12h apart',
  equator.sunrise != null && equator.sunset != null
  && Math.abs(((equator.sunset - equator.sunrise + 24) % 24) - 12) < 1);
const polar = S.sunUT(june10, 80, 0);
ok('sunUT: polar day -> null (no sunrise/sunset)', polar.sunrise === null || polar.sunset === null);

// ---- boundaries ----
const bTime = S.boundaries({ mode: 'time', lightStart: '07:00', darkStart: '20:00' }, june10);
ok('boundaries: time mode', bTime.lightMin === 420 && bTime.darkMin === 1200);
const bDef = S.boundaries({ mode: 'time' }, june10);
ok('boundaries: time mode defaults 07:00/20:00', bDef.lightMin === 420 && bDef.darkMin === 1200);
ok('boundaries: sun without coords -> null',
  S.boundaries({ mode: 'sun', lat: '', lng: '' }, june10) === null
  && S.boundaries({ mode: 'sun', lat: 'x', lng: '30' }, june10) === null);
ok('boundaries: polar -> null', S.boundaries({ mode: 'sun', lat: '80', lng: '0' }, june10) === null);
const bSun = S.boundaries({ mode: 'sun', lat: '50.45', lng: '30.52' }, june10, 0); // tz injected for determinism
ok('boundaries: sun mode returns minutes in [0,1440)',
  bSun && bSun.lightMin >= 0 && bSun.lightMin < 1440 && bSun.darkMin >= 0 && bSun.darkMin < 1440);
ok('boundaries: sun mode matches sunUT (tz=0)',
  bSun.lightMin === Math.round(kyiv.sunrise * 60) && bSun.darkMin === Math.round(kyiv.sunset * 60));
ok('boundaries: null/off schedule still yields time defaults (caller gates on mode)',
  S.boundaries(null, june10).lightMin === 420 && S.boundaries({ mode: 'off' }, june10).darkMin === 1200);

// ---- saysDark (local-time Date objects; constructor args are local => deterministic) ----
const at = (h, m) => new Date(2026, 5, 10, h, m);
const b = { lightMin: 420, darkMin: 1200 }; // 07:00 / 20:00
ok('saysDark: midday is light', S.saysDark(b, at(12, 0)) === false);
ok('saysDark: evening is dark', S.saysDark(b, at(21, 0)) === true);
ok('saysDark: small hours are dark', S.saysDark(b, at(3, 0)) === true);
ok('saysDark: boundary edges (07:00 light, 20:00 dark)',
  S.saysDark(b, at(7, 0)) === false && S.saysDark(b, at(20, 0)) === true);
const bWrap = { lightMin: 1320, darkMin: 240 }; // light 22:00 → 04:00 (wraps midnight)
ok('saysDark: light period wrapping midnight',
  S.saysDark(bWrap, at(23, 0)) === false && S.saysDark(bWrap, at(2, 0)) === false
  && S.saysDark(bWrap, at(12, 0)) === true);
ok('saysDark: equal boundaries -> always light', S.saysDark({ lightMin: 420, darkMin: 420 }, at(3, 0)) === false);

// ---- resolveTheme (shared by independent Windows-theme and wallpaper schedules) ----
ok('resolveTheme: time schedule selects light/dark slots',
  S.resolveTheme({ mode: 'time', lightStart: '07:00', darkStart: '20:00' }, at(12, 0), 'dark') === 'light'
  && S.resolveTheme({ mode: 'time', lightStart: '07:00', darkStart: '20:00' }, at(23, 0), 'light') === 'dark');
ok('resolveTheme: off/system modes keep fallback',
  S.resolveTheme({ mode: 'off' }, at(12, 0), 'dark') === 'dark'
  && S.resolveTheme({ mode: 'system' }, at(12, 0), 'light') === 'light');
ok('resolveTheme: sun without coordinates keeps fallback',
  S.resolveTheme({ mode: 'sun', lat: '', lng: '' }, at(12, 0), 'dark') === 'dark');

// ---- wallpaper startup orchestration ----
ok('wallpaper startup: slideshow takes priority',
  S.wallpaperStartupAction({ separateThemes: false, slideshow: { enabled: true }, wallpaperSchedule: { mode: 'time' } }) === 'slideshow');
ok('wallpaper startup: unified mode always applies its shared slot',
  S.wallpaperStartupAction({ separateThemes: false, slideshow: { enabled: false }, wallpaperSchedule: { mode: 'time' } }) === 'apply'
  && S.wallpaperStartupAction({ separateThemes: false, slideshow: { enabled: false }, wallpaperSchedule: { mode: 'sun' } }) === 'apply');
ok('wallpaper startup: separate modes choose their scheduler behavior',
  S.wallpaperStartupAction({ separateThemes: true, slideshow: { enabled: false }, wallpaperSchedule: { mode: 'system' } }) === 'apply'
  && S.wallpaperStartupAction({ separateThemes: true, slideshow: { enabled: false }, wallpaperSchedule: { mode: 'time' } }) === 'schedule'
  && S.wallpaperStartupAction({ separateThemes: true, slideshow: { enabled: false }, wallpaperSchedule: { mode: 'sun' } }) === 'schedule'
  && S.wallpaperStartupAction({ separateThemes: true, slideshow: { enabled: false }, wallpaperSchedule: { mode: 'off' } }) === 'none');

// ---- minutesUntilNextBoundary ----
ok('minutesUntil: picks the nearer upcoming boundary', S.minutesUntilNextBoundary(b, at(10, 0)) === 600);
ok('minutesUntil: one minute before a flip', S.minutesUntilNextBoundary(b, at(19, 59)) === 1);
ok('minutesUntil: exactly on a boundary -> next one, not 0',
  S.minutesUntilNextBoundary(b, at(7, 0)) === 780 && S.minutesUntilNextBoundary(b, at(20, 0)) === 660);
ok('minutesUntil: never below 1', S.minutesUntilNextBoundary({ lightMin: 0, darkMin: 0 }, at(0, 0)) >= 1);

console.log('\nAll ' + passed + ' schedule tests passed.');
