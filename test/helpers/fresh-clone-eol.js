'use strict';

// Loaded with `--require`. Reads this repository's own text files the way a fresh clone on
// Windows hands them out.
//
// Git for Windows sets core.autocrlf=true in its system config by default, so a checkout turns
// LF into CRLF. A checkout that was made or edited some other way can hold LF instead. A test that is
// green in one and red in the other is checking the checkout, not the program.
//
// Only files inside this repository are affected, and never its .tmp or node_modules, nor the
// system temp directory: tests write fixtures there and compare them byte for byte.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const rootKey = ROOT.toLowerCase() + path.sep;
const skipped = [path.join(ROOT, '.tmp'), path.join(ROOT, 'node_modules'), os.tmpdir()]
  .map((dir) => path.resolve(dir).toLowerCase() + path.sep);
const TEXT = /\.(?:js|cjs|mjs|json|html|css|md|txt|ps1|cs)$/i;

const original = fs.readFileSync;

fs.readFileSync = function readFileSyncAsFreshWindowsClone(file, ...rest) {
  const out = original.call(this, file, ...rest);
  if (typeof out !== 'string') return out;
  let abs;
  if (typeof file === 'string') abs = path.resolve(file);
  else if (file instanceof URL) abs = fileURLToPath(file);
  else return out;
  const key = abs.toLowerCase();
  if (!key.startsWith(rootKey) || skipped.some((dir) => key.startsWith(dir)) || !TEXT.test(abs)) {
    return out;
  }
  return out.split('\r\n').join('\n').split('\n').join('\r\n');
};
