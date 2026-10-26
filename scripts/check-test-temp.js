'use strict';

// `npm run test:temp` — QA-019: run the whole `npm test` with %TEMP% pointed at an empty
// directory of its own and fail if anything is left in it afterwards.
//
// test/temp-dir.test.js keeps each suite on the shared helper; this is the end-to-end
// answer to "does a full run still leave anything behind", including directories made by
// the code under test rather than by a test. It runs the suite a second time, so it is
// not part of `npm test` itself.
//
// Node's own reusable compile cache is not a leak: it is one directory, reused by every
// run, not one more per run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ALLOWED = new Set(['node-compile-cache']);

function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-test-temp-'));
  try {
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
    // One command string through the shell: npm is npm.cmd on Windows.
    const run = spawnSync('npm test', { cwd: ROOT, env, stdio: 'inherit', shell: true });
    const left = fs.readdirSync(temp).filter((name) => !ALLOWED.has(name));
    // Judged on a failed run too: the helper removes its directories on failure as well.
    if (left.length) {
      console.error(`\ntest:temp: npm test left ${left.length} item(s) in its %TEMP%:`);
      for (const name of left.sort()) console.error('  ' + name);
    } else {
      console.log('\ntest:temp: npm test left nothing in %TEMP%.');
    }
    if (run.status !== 0) console.error(`test:temp: npm test itself failed (exit ${run.status}).`);
    if (run.status !== 0) return run.status || 1;
    return left.length ? 1 : 0;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

process.exitCode = main();
