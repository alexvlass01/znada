'use strict';

// ONL-015. Search and download already accept every canonical wallpaper format. The
// viewer proxy must not silently keep the older thumbnail-only MIME whitelist, or a
// GIF/BMP card reaches the grid but can never upgrade from its thumbnail.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeTempProfile, loadMain, unloadMain, writeJson } = require('./helpers/main-harness');

const userData = makeTempProfile('internet-full-main');
writeJson(path.join(userData, 'config.json'), { autoSwitch: true, style: 'fill', monitors: {} });
const originalFetch = globalThis.fetch;

(async () => {
  const main = loadMain(userData);
  main.__test.loadConfig();

  const bodies = {
    gif: Buffer.from('47494638396101000100', 'hex'),
    bmp: (() => {
      const buffer = Buffer.alloc(26);
      buffer.write('BM', 0, 'latin1');
      buffer.writeUInt32LE(40, 14);
      buffer.writeInt32LE(1, 18);
      buffer.writeInt32LE(1, 22);
      return buffer;
    })(),
  };
  for (const [format, mime] of [['gif', 'image/gif'], ['bmp', 'image/bmp']]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? `${mime}; charset=binary` : null },
      arrayBuffer: async () => bodies[format],
    });
    const result = await main.invoke('internet-full', {
      provider: 'wallhaven',
      format,
      full: `https://w.wallhaven.cc/full/viewer.${format}`,
    });
    assert.strictEqual(result.error, null, `${format} must upgrade to the full viewer image`);
    assert.ok(result.dataUrl.startsWith(`data:${mime};base64,`), `${format} must keep a safe image MIME`);
  }

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/html' : null },
    arrayBuffer: async () => Buffer.from('<html>').buffer,
  });
  const rejected = await main.invoke('internet-full', {
    provider: 'wallhaven', format: 'jpg', full: 'https://w.wallhaven.cc/full/not-an-image.jpg',
  });
  assert.strictEqual(rejected.error, 'badImage', 'the wider wallpaper MIME rule must still reject HTML');

  console.log('Internet full-view boundary OK for GIF/BMP and rejects HTML.');
})().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  globalThis.fetch = originalFetch;
  unloadMain();
  fs.rmSync(userData, { recursive: true, force: true });
});
