'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '0.42.0';
const ARCHIVE = `libmpv-v${VERSION}-x86_64-w64-mingw32-lgpl.zip`;
const URL = `https://github.com/mpv-player/mpv/releases/download/v${VERSION}/${ARCHIVE}`;
const ARCHIVE_HASH = '8e5f77430efc53ef175804ba6618527e3af0448a0dcabf04d3cc72659d1a6fce';
const DLL_HASH = '94fb87247732c59915cd59808bc582e843a71c22214b7b6c1e5563aa8149cef4';
const LICENSE_HASH = '72b672113d642cbb8ef5dcc76938db801983c56e50b1400ab930f1a64d6dc8d9';
const FILES = ['LICENSE.LGPL', 'NOTICE.txt', 'libmpv-2.dll'];
function runtimeDirectory(app) {
  return app.isPackaged ? path.join(process.resourcesPath, 'libmpv') : path.join(app.getAppPath(), '.build', 'libmpv');
}
function verifyRuntime(directory, { verifyDigest = true } = {}) {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Invalid libmpv resource directory');
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.some(e => !e.isFile() || e.isSymbolicLink())
    || JSON.stringify(entries.map(e => e.name).sort()) !== JSON.stringify([...FILES].sort())) throw new Error('Invalid libmpv resource boundary');
  const dll = path.join(directory, 'libmpv-2.dll');
  if (verifyDigest) {
    for (const [file, expected] of [['libmpv-2.dll', DLL_HASH], ['LICENSE.LGPL', LICENSE_HASH]]) {
      if (crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex') !== expected) throw new Error(`libmpv digest mismatch: ${file}`);
    }
  }
  return dll;
}
module.exports = { VERSION, ARCHIVE, URL, ARCHIVE_HASH, DLL_HASH, LICENSE_HASH, FILES, runtimeDirectory, verifyRuntime };
