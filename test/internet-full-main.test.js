'use strict';

// ONL-015. Search and download already accept every canonical wallpaper format. The
// viewer proxy must not silently keep the older thumbnail-only MIME whitelist, or a
// GIF/BMP card reaches the grid but can never upgrade from its thumbnail.
//
// PERF-008 moved that proxy from three IPC channels handing base64 strings across to a
// stream on our own scheme. The rule under test did not change, so this file follows the
// rule rather than the removed channels: it drives the real protocol handler that main
// registers, with the same formats and the same rejection.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeTempProfile, loadMain, unloadMain, writeJson } = require('./helpers/main-harness');

const userData = makeTempProfile('internet-full-main');
writeJson(path.join(userData, 'config.json'), { autoSwitch: true, style: 'fill', monitors: {} });
const originalFetch = globalThis.fetch;

const mediaUrl = (provider, tier, url) =>
  `znada-media://media/?t=${tier}&p=${provider}&u=${encodeURIComponent(url)}`;

// Upstream answer shaped the way `fetch` shapes one, with a body that can be streamed.
function upstream(mime, bytes) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? `${mime}; charset=binary` : null) },
    body: new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); },
    }),
  });
}

(async () => {
  const main = loadMain(userData);
  main.__test.loadConfig();
  main.__test.registerMediaProxy();
  const handle = main.protocol.handlers.get('znada-media');
  assert.ok(handle, 'main must register a handler for its own media scheme');

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
    globalThis.fetch = upstream(mime, bodies[format]);
    const res = await handle({
      url: mediaUrl('wallhaven', 'full', `https://w.wallhaven.cc/full/viewer.${format}`),
    });
    assert.strictEqual(res.status, 200, `${format} must upgrade to the full viewer image`);
    assert.strictEqual(res.headers.get('content-type'), mime, `${format} must keep a safe image MIME`);
    const served = Buffer.from(await res.arrayBuffer());
    assert.ok(served.equals(bodies[format]), `${format} must arrive unchanged through the stream`);
  }

  globalThis.fetch = upstream('text/html', Buffer.from('<html>'));
  const rejected = await handle({
    url: mediaUrl('wallhaven', 'full', 'https://w.wallhaven.cc/full/not-an-image.jpg'),
  });
  assert.strictEqual(rejected.status, 415, 'the wider wallpaper MIME rule must still reject HTML');

  // The host check the proxy exists for. Same rule as before, still refused before any
  // request leaves: a provider name does not make someone else's host acceptable.
  let reached = false;
  globalThis.fetch = async () => { reached = true; throw new Error('must not be called'); };
  const foreign = await handle({
    url: mediaUrl('wallhaven', 'full', 'https://evil.example/full/viewer.jpg'),
  });
  assert.strictEqual(foreign.status, 403, 'a host the provider never declared must be refused');
  assert.strictEqual(reached, false, 'the refusal must happen before anything is fetched');

  console.log('Internet full-view boundary OK for GIF/BMP, rejects HTML and foreign hosts.');
})().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  globalThis.fetch = originalFetch;
  unloadMain();
  fs.rmSync(userData, { recursive: true, force: true });
});
