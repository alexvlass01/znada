'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const dir = H.makeTempProfile('content-blur-main');
const realFetch = globalThis.fetch;
let checks = 0;
let finished = false;
process.on('exit', () => { if (!finished) process.exitCode = 1; });
H.writeJson(path.join(dir, 'config.json'), { firstRunDone: true, monitors: {} });
H.writeJson(path.join(dir, 'config.library.json'), { version: 1, library: {}, trash: [] });
(async () => {
  const main = H.loadMain(dir);
  main.__test.loadConfig();
  assert.deepStrictEqual(main.__test.getConfig().contentBlur, { nsfw: false, sketchy: false }); checks++;
  await main.invoke('set-config', { contentBlur: { nsfw: true } });
  await main.invoke('set-config', { contentBlur: { sketchy: true } });
  assert.deepStrictEqual(main.__test.getConfig().contentBlur, { nsfw: true, sketchy: true }); checks++;
  await assert.rejects(async () => main.invoke('set-config', { contentBlur: { nsfw: 'true' } }), /E_SETTINGS_REJECTED/);
  await assert.rejects(async () => main.invoke('set-config', { contentBlur: { unknown: true } }), /E_SETTINGS_REJECTED/); checks++;
  let requests = 0;
  globalThis.fetch = async url => {
    requests++;
    if (String(url).endsWith('/download')) return {
      status: 200, text: async () => JSON.stringify({ url: 'https://storage.example.test/cloud.png', expires_at: 1900000000 }),
    };
    const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => png };
  };
  const internet = await main.invoke('internet-add', { provider: 'wallhaven', id: 'rated', format: 'png',
    full: 'https://w.wallhaven.cc/full/rated.png', page: 'https://wallhaven.cc/w/rated', purity: 'nsfw' }, '');
  assert.strictEqual(internet.error, null);
  assert.strictEqual(main.__test.getConfig().library[internet.id].rating, 'explicit'); checks++;
  const known = main.__test.getConfig().library[internet.id].rating;
  await main.invoke('internet-add', { provider: 'wallhaven', id: 'rated', format: 'png',
    full: 'https://w.wallhaven.cc/full/rated.png', page: 'https://wallhaven.cc/w/rated' }, '');
  assert.strictEqual(main.__test.getConfig().library[internet.id].rating, known, 'unknown response cannot erase metadata'); checks++;
  const cloud = await main.invoke('cloud-add', { id: 'cloud-rated', rating: 'suggestive' });
  assert.strictEqual(cloud.error, null);
  assert.strictEqual(main.__test.getConfig().library[cloud.id].rating, 'sensitive'); checks++;
  assert.ok(requests >= 3);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'config.library.json'), 'utf8'));
  assert.strictEqual(persisted.library[cloud.id].rating, 'sensitive'); checks++;
  const storedSettings = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepStrictEqual(storedSettings.contentBlur, { nsfw: true, sketchy: true }); checks++;
  main.emitApp('second-instance', {}, [], H.ROOT, undefined);
  const win = main.calls.windows[0];
  assert.ok(win, 'real main window creation must wire the hide event');
  const sent = [];
  win.webContents.send = (...args) => sent.push(args);
  for (const event of ['blur', 'minimize']) for (const fn of win.listeners.get(event) || []) fn();
  assert.strictEqual(sent.filter(([channel]) => channel === 'content-blur-reset').length, 0);
  for (const fn of win.listeners.get('hide') || []) fn();
  assert.strictEqual(sent.filter(([channel]) => channel === 'content-blur-reset').length, 1); checks++;
  H.unloadMain();
  const reloaded = H.loadMain(dir); reloaded.__test.loadConfig();
  assert.strictEqual(reloaded.__test.getConfig().library[cloud.id].rating, 'sensitive');
  assert.deepStrictEqual(reloaded.__test.getConfig().contentBlur, { nsfw: true, sketchy: true }); checks++;
  finished = true;
  console.log(`PASS content-blur-main: ${checks} real IPC/persistence cases`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  globalThis.fetch = realFetch; H.unloadMain();
});
