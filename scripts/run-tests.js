'use strict';

// QA-027: keep cmd.exe's command short. Each manifest step still gets its own Node
// process, in the old order, including the two i18n CLI checks between/after tests.
const { spawnSync } = require('child_process');
const path = require('path');
const STEPS = require('./test-steps.json');
const ROOT = path.join(__dirname, '..');

function runSteps(steps = STEPS, { cwd = ROOT } = {}) {
  for (const args of steps) {
    const result = spawnSync(process.execPath, args, {
      cwd, stdio: 'inherit', windowsHide: true,
    });
    if (result.error || result.signal || result.status !== 0) {
      console.error(`Test step failed: node ${args.join(' ')}`);
      if (result.error) console.error(result.error.message);
      if (result.signal) console.error(`Terminated by ${result.signal}`);
      return result.status || 1;
    }
  }
  return 0;
}

if (require.main === module) process.exitCode = runSteps();

module.exports = { runSteps };
