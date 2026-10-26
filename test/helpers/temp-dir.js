'use strict';

// QA-019. The one way a test makes a temporary directory.
//
// Before this, each suite called fs.mkdtempSync itself and removed the directory at the
// end of the happy path, if at all. Removal sat after the assertions, so a failing test
// skipped it, and dozens of suites never removed anything: by 2026-10-13 the owner's
// %TEMP% held ~76,600 leftover directories (~275 MB), roughly 150 more per `npm test`.
//
// Every directory made here is removed when the process exits — on success, on a thrown
// assertion and on process.exit() alike — so a suite no longer has to remember. Explicit
// early removal stays allowed; the exit pass just finds nothing left.
// test/temp-dir.test.js keeps every test going through this helper.

const fs = require('fs');
const os = require('os');
const path = require('path');

const made = new Set();
let hooked = false;

function removeAll() {
  for (const dir of made) {
    // Retries cover a Windows handle (fs.watch, a just-closed child) that lets go a moment
    // after the test finished. One stubborn directory must not stop the others.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  }
  made.clear();
}

function makeTempDir(prefix) {
  if (!hooked) {
    hooked = true;
    process.on('exit', removeAll);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  return dir;
}

module.exports = { makeTempDir, removeAll };
