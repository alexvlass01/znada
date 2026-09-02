'use strict';

// ONL-015. The feed filters formats, but an IPC caller can invoke `internet-add`
// directly. The download boundary must apply the same canonical rule before network or
// disk I/O, while the newly admitted GIF/WebP formats still work end to end.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeTempProfile, loadMain, unloadMain, writeJson } = require('./helpers/main-harness');

const userData = makeTempProfile('online-add-main');
writeJson(path.join(userData, 'config.json'), { autoSwitch: true, style: 'fill', monitors: {} });
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
let responseMode = 'valid';

const bodies = {
  gif: Buffer.from('47494638396101000100', 'hex'),
  webp: Buffer.from('524946461600000057454250565038580a0000000000000000000000000000', 'hex'),
  png: Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex'),
};

(async () => {
  const main = loadMain(userData);
  main.__test.loadConfig();
  globalThis.fetch = async (url) => {
    fetchCalls += 1;
    const format = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    const body = responseMode === 'valid' ? bodies[format] : Buffer.from('<html>not an image</html>');
    const mime = responseMode === 'valid' ? `image/${format}` : 'text/html';
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? mime : null },
      arrayBuffer: async () => body,
    };
  };

  for (const format of ['gif', 'webp']) {
    const result = await main.invoke('internet-add', {
      provider: 'wallhaven', id: format, format,
      full: `https://w.wallhaven.cc/full/accepted.${format}`,
      page: `https://wallhaven.cc/w/${format}`,
      width: 1920, height: 1080,
    }, '');
    assert.strictEqual(result.error, null, `${format} must remain addable after ONL-015`);
  }
  const records = Object.values(main.__test.getConfig().library || {});
  assert.ok(records.some((item) => item.path.endsWith('.gif') && item.source.endsWith('/gif')));
  assert.ok(records.some((item) => item.path.endsWith('.webp') && item.source.endsWith('/webp')));

  const beforeBad = fetchCalls;
  const rejectedItems = [
    { id: 'moving', format: 'webm', full: 'https://w.wallhaven.cc/full/moving.webm' },
    { id: 'lying-card', format: 'jpg', full: 'https://w.wallhaven.cc/full/lying-card.webm' },
    { id: 'lying-url', format: 'webm', full: 'https://w.wallhaven.cc/full/lying-url.jpg' },
    { id: 'cross-format', format: 'jpg', full: 'https://w.wallhaven.cc/full/cross-format.png' },
  ];
  for (const item of rejectedItems) {
    const rejected = await main.invoke('internet-add', {
      provider: 'wallhaven', page: `https://wallhaven.cc/w/${item.id}`, ...item,
    }, '');
    assert.strictEqual(rejected.error, 'badItem', 'a moving picture must not bypass the feed through IPC');
  }
  assert.strictEqual(fetchCalls, beforeBad, 'a rejected or contradictory format must not reach the network');

  responseMode = 'html';
  const disguised = await main.invoke('internet-add', {
    provider: 'wallhaven', id: 'html', format: 'jpg',
    full: 'https://w.wallhaven.cc/full/disguised.jpg',
    page: 'https://wallhaven.cc/w/html',
  }, '');
  assert.strictEqual(disguised.error, 'download', 'a non-image response must fail before entering the library');
  assert.ok(!Object.values(main.__test.getConfig().library || {}).some((item) => item.source.endsWith('/html')),
    'a rejected response must not leave a library record');

  console.log('Internet add main boundary OK for GIF/WebP and rejects WebM/non-image responses.');
})().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  globalThis.fetch = originalFetch;
  unloadMain();
  fs.rmSync(userData, { recursive: true, force: true });
});
