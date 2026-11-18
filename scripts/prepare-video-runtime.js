'use strict';

// No installation/system writes. A pinned download in this checkout's ignored .build only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const runtime = require('../src/video-runtime');
const root = path.resolve(__dirname, '..');
async function prepare() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Video runtime requires Windows x64');
  const directory = path.join(root, '.build', 'libmpv');
  try { runtime.verifyRuntime(directory); return; } catch { /* repair only our derived files below */ }
  const cache = path.join(root, '.build', 'video-cache');
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, runtime.ARCHIVE);
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!fs.existsSync(archive) || hash(archive) !== runtime.ARCHIVE_HASH) {
    const response = await fetch(runtime.URL, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`libmpv download: HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(data).digest('hex') !== runtime.ARCHIVE_HASH) throw new Error('libmpv archive digest mismatch');
    fs.writeFileSync(archive, data);
  }
  const extracted = path.join(cache, 'extracted');
  fs.mkdirSync(extracted, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const result = spawnSync(tar, ['-xf', archive, '-C', extracted], { windowsHide: true, stdio: 'inherit', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error('Cannot extract verified libmpv archive');
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ['libmpv-2.dll', 'LICENSE.LGPL']) fs.copyFileSync(path.join(extracted, name), path.join(directory, name));
  fs.writeFileSync(path.join(directory, 'NOTICE.txt'), [
    `libmpv ${runtime.VERSION}, unmodified official Windows x64 LGPL build.`,
    'Copyright the mpv developers and dependency authors. See LICENSE.LGPL (LGPL 2.1 or later).',
    'Loaded dynamically; this DLL may be replaced by a compatible user-built libmpv.',
    `Original binary: ${runtime.URL}`, `Archive SHA-256: ${runtime.ARCHIVE_HASH}`,
    'Library source and copyright notices: https://github.com/mpv-player/mpv/tree/v0.42.0',
    'Official build scripts and dependency source recipes: https://github.com/mpv-player/mpv-winbuild-cmake',
    'FFmpeg source: https://ffmpeg.org/download.html',
    'Koffi is a separate MIT-licensed dependency; its license ships inside app.asar.', '',
  ].join('\n'));
  runtime.verifyRuntime(directory);
  console.log(`Prepared verified libmpv ${runtime.VERSION}`);
}
if (require.main === module) prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepare };
