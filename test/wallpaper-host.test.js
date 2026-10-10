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
const { createChildRunner } = require('../src/child-runner');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

(async () => {
  if (process.platform !== 'win32') { console.log('SKIPPED: not Windows'); return; }
  const sp = path.join(os.tmpdir(), 'lumina-host-test-' + Date.now() + '.ps1');
  fs.writeFileSync(sp, HOST_SCRIPT, 'utf8');
  // Wired the way main.js wires it: ending the host ends its tree, through taskkill.
  const runner = createChildRunner();
  const host = new WallpaperHost(sp, { killProcess: (proc) => runner.killTree(proc) });
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

    // WIN-002. Every answer must carry the id of its command, and that is the SCRIPT's
    // job: the fake-process tests echo ids themselves and never see it. The first
    // version reused `$id`, which the enum and get loops overwrite with a monitor path,
    // and only this live run noticed. So every branch of the script is asked once:
    // the read-only Stealth check, and an op the script does not know, which must come
    // back as a refusal on the SAME process rather than as an answer nobody can match.
    const covered = await host.checkMaximized();
    console.log(`checkMaximized: ${covered.length} covered monitor(s)`);
    const procBefore = host.proc;
    const unknown = await host.send({ op: 'no-such-op' });
    const sameProcess = host.proc === procBefore && procBefore !== null;
    console.log(`unknown op: ok=${unknown.ok}, error=${unknown.error}, same process=${sameProcess}`);

    // Quitting disposes the host: the real process must be gone, not merely forgotten.
    const hostPid = host.proc ? host.proc.pid : 0;
    host.dispose();
    const until = Date.now() + 5000;
    while (hostPid > 0 && alive(hostPid) && Date.now() < until) {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    const gone = hostPid > 0 && !alive(hostPid);
    console.log(`dispose ended the host process ${hostPid}: ${gone}`);

    const ok = m1.length >= 1
      && m1.every((m) => typeof m.id === 'string' && Number.isFinite(m.w) && Number.isFinite(m.h))
      && m2.length === m1.length
      && second < first
      && applyOk === true
      && typeof isBusy === 'boolean'
      && Array.isArray(covered)
      && unknown.ok === false && unknown.error === 'unknown op'
      && sameProcess
      && gone;
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
