'use strict';

// Live test of the persistent wallpaper COM host (Windows only).
// Uses the READ-ONLY `enum` op so it does NOT touch the desktop wallpaper.
// Proves: the host spawns, compiles the COM interop once, returns monitors, and
// that a SECOND call reuses the same process (the whole point of the optimization).
//   node test/wallpaper-host.test.js

const os = require('os');
const fs = require('fs');
const path = require('path');
const { WallpaperHost, HOST_SCRIPT } = require('../src/wallpaper-host');

(async () => {
  if (process.platform !== 'win32') { console.log('SKIPPED: not Windows'); return; }
  const sp = path.join(os.tmpdir(), 'lumina-host-test-' + Date.now() + '.ps1');
  fs.writeFileSync(sp, HOST_SCRIPT, 'utf8');
  const host = new WallpaperHost(sp);
  try {
    const t0 = Date.now();
    const m1 = await host.enumMonitors();
    const t1 = Date.now();
    const m2 = await host.enumMonitors(); // reuse — should be much faster
    const t2 = Date.now();

    const first = t1 - t0;
    const second = t2 - t1;
    console.log(`monitors detected: ${m1.length}`);
    console.log(`first call: ${first} ms (includes one-time C# compile)`);
    console.log(`second call: ${second} ms (reused process)`);
    console.log(`reuse-is-faster: ${second < first}`);

    // SAFE apply round-trip: read current wallpapers + position, re-apply EXACTLY
    // the same → exercises the write path with zero visible change to the desktop.
    const cur = await host.get();
    // Skip monitors whose current wallpaper is not reachable RIGHT NOW as well as
    // monitors with none. A picture on a disk the user has unplugged makes the
    // re-apply fail for a reason that has nothing to do with this code, and a
    // release gate that goes red because of the state of somebody's desktop is
    // worse than no gate. Found 2026-08-16: one monitor was showing a file from a
    // disconnected drive.
    const sameItems = cur.items.filter((it) => it.path && fs.existsSync(it.path));
    const applyOk = await host.apply(cur.position, sameItems);
    console.log(`apply round-trip (re-applied current wallpapers, no change): ok=${applyOk}, monitors=${sameItems.length}, position=${cur.position}`);

    // Test the new checkFullscreen operation
    const isBusy = await host.checkFullscreen();
    console.log(`checkFullscreen: ${isBusy}`);

    const ok = m1.length >= 1
      && m1.every((m) => typeof m.id === 'string' && Number.isFinite(m.w) && Number.isFinite(m.h))
      && m2.length === m1.length
      && second < first
      && applyOk === true
      && typeof isBusy === 'boolean';
    console.log(ok ? '\nPASS: host works and reuse is faster.' : '\nFAIL: see values above.');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.log('FAIL:', e.message);
    process.exitCode = 1;
  } finally {
    host.dispose();
    try { fs.rmSync(sp, { force: true }); } catch {}
  }
})();
