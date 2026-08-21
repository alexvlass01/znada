'use strict';

// Day/night schedule math — the PURE core behind "switch theme by time / by sun".
//
// Extracted from main.js (2026-06-10) without behavior changes, for two reasons:
// 1. The sunrise math and boundary logic were the largest untested pure code in the app.
// 2. The schedule is PARAMETERIZED here (passed in, not read from the global config), so a
//    second independent schedule (e.g. wallpapers by time/sun, decoupled from the Windows
//    theme) can reuse this module instead of copying it.
//
// A schedule object looks like config.themeSchedule / config.wallpaperSchedule:
//   { mode: 'off'|'system'|'time'|'sun', lightStart: 'HH:MM', darkStart: 'HH:MM', lat: '', lng: '' }
// Boundaries are minutes after LOCAL midnight: { lightMin, darkMin }, or null when unknown
// (missing coordinates / polar day or night).

// "HH:MM" → minutes after midnight. Garbage in → 0 (matches the historical behavior).
function parseHM(s) {
  const [h, m] = String(s || '').split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

// Sunrise/sunset in UTC hours for a date + coordinates (classic sunrise equation).
// Returns { sunrise, sunset } where either can be null on polar day/night.
function sunUT(date, lat, lng) {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI, zenith = 90.833;
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 0);
  const N = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - yearStart) / 86400000);
  function calc(rise) {
    const lngHour = lng / 15;
    const t = N + ((rise ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(M * D2R) + 0.020 * Math.sin(2 * M * D2R) + 282.634;
    L = (L % 360 + 360) % 360;
    let RA = R2D * Math.atan(0.91764 * Math.tan(L * D2R));
    RA = (RA % 360 + 360) % 360;
    RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90;
    RA /= 15;
    const sinDec = 0.39782 * Math.sin(L * D2R);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(zenith * D2R) - sinDec * Math.sin(lat * D2R)) / (cosDec * Math.cos(lat * D2R));
    if (cosH > 1 || cosH < -1) return null; // polar day / night
    let H = rise ? 360 - R2D * Math.acos(cosH) : R2D * Math.acos(cosH);
    H /= 15;
    const UT = (H + RA - 0.06571 * t - 6.622 - lngHour) % 24;
    return (UT + 24) % 24;
  }
  return { sunrise: calc(true), sunset: calc(false) };
}

// Light/dark boundaries for a schedule as minutes after LOCAL midnight, or null if unknown.
// `tzOffsetMin` defaults to the date's own timezone offset; injectable for deterministic tests.
function boundaries(schedule, date, tzOffsetMin) {
  const sch = schedule || {};
  if (sch.mode === 'sun') {
    const lat = parseFloat(sch.lat);
    const lng = parseFloat(sch.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const { sunrise, sunset } = sunUT(date, lat, lng);
    if (sunrise == null || sunset == null) return null;
    const tz = Number.isFinite(tzOffsetMin) ? tzOffsetMin : date.getTimezoneOffset(); // local = UTC - tz
    const toMin = (ut) => ((Math.round(ut * 60 - tz)) % 1440 + 1440) % 1440;
    return { lightMin: toMin(sunrise), darkMin: toMin(sunset) };
  }
  return { lightMin: parseHM(sch.lightStart || '07:00'), darkMin: parseHM(sch.darkStart || '20:00') };
}

// Should it be dark right now, given the boundaries? The light period may wrap midnight
// (lightMin > darkMin); equal boundaries degenerate to "always light".
function saysDark(b, date) {
  const now = date.getHours() * 60 + date.getMinutes();
  const ls = b.lightMin, ds = b.darkMin;
  let isLight;
  if (ls === ds) isLight = true;
  else if (ls < ds) isLight = now >= ls && now < ds;
  else isLight = now >= ls || now < ds; // light period wraps midnight
  return !isLight;
}

// Resolve a schedule to 'light'/'dark'. Non-scheduled modes and schedules whose
// boundaries cannot be calculated (e.g. sun mode without coordinates) keep fallback.
function resolveTheme(schedule, date, fallback = 'light', tzOffsetMin) {
  const sch = schedule || {};
  const safeFallback = fallback === 'dark' ? 'dark' : 'light';
  if (sch.mode !== 'time' && sch.mode !== 'sun') return safeFallback;
  const b = boundaries(sch, date, tzOffsetMin);
  if (!b) return safeFallback;
  return saysDark(b, date) ? 'dark' : 'light';
}

// Decide how the main process initializes wallpapers after monitors are enumerated.
// Unified mode must always apply its shared ('light') slot, even when a previously
// selected independent schedule is still stored but hidden in the UI.
function wallpaperStartupAction(config) {
  const cfg = config || {};
  if (cfg.slideshow && cfg.slideshow.enabled) return 'slideshow';
  if (cfg.separateThemes === false) return 'apply';
  const mode = cfg.wallpaperSchedule && cfg.wallpaperSchedule.mode;
  if (mode === 'system') return 'apply';
  if (mode === 'time' || mode === 'sun') return 'schedule';
  return 'none';
}

// Minutes until the NEXT boundary (light or dark), minimum 1 — used to arm the flip timer.
function minutesUntilNextBoundary(b, date) {
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const until = [b.lightMin, b.darkMin].map((x) => { let d = x - nowMin; if (d <= 0) d += 1440; return d; });
  return Math.max(1, Math.min(...until));
}

module.exports = {
  parseHM,
  sunUT,
  boundaries,
  saysDark,
  resolveTheme,
  wallpaperStartupAction,
  minutesUntilNextBoundary,
};
