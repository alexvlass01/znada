'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { makeTempProfile, loadMain, unloadMain, writeJson, writeImage } = require('./helpers/main-harness');
const library = require('../src/library');

(async () => {
  const dir = makeTempProfile('bookmark-main');
  const image = writeImage(path.join(dir, 'wallpapers', 'photo.png'));
  const item = library.makeItem('image', image, { addedAt: 100 });
  item.source = 'https://wallhaven.cc/w/abc123';
  writeJson(path.join(dir, 'config.json'), { autoSwitch: false, library: { [item.id]: item } });
  let main = loadMain(dir);
  main.__test.loadConfig();
  // This suite covers persistence/IPC. The provider lookup path is exercised by
  // bookmark-service.test.js; no real site is contacted from the main harness.
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline test'); };
  const card = { kind: 'internet', item: { provider: 'wallhaven', id: 'abc123', tags: ['sky'] } };
  assert.equal((await main.invoke('favorite-state', card)).on, false);
  assert.equal((await main.invoke('favorite-set', card, true)).error, null);
  const listed = await main.invoke('favorites-list');
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].kind, 'local');
  assert.equal(listed.entries[0].item.favorite, true);
  assert.equal((await main.invokeAs('viewer', 'favorite-state', card)).on, true);
  const reply = await main.invokeAs('viewer', 'favorite-set', card, false);
  assert.equal(reply.error, null);
  assert.equal(Object.hasOwn(reply, 'config'), false, 'new viewer channel must not expose the entire profile');
  assert.equal((await main.invoke('favorites-list')).entries.length, 0);
  assert.equal(fs.existsSync(image), true, 'removing a star never removes a file');
  await main.invoke('favorite-set', card, true);
  assert.equal((await main.invoke('bookmark-tags', card, ['mine'])).error, null);
  assert.ok((await main.invoke('get-config')).library[item.id].tags.includes('mine'));
  assert.equal((await main.invoke('bookmark-resolve', '__proto__')).error, 'badItem');
  unloadMain();
  global.fetch = realFetch;
  main = loadMain(dir);
  main.__test.loadConfig();
  assert.equal((await main.invoke('favorites-list')).entries.length, 1, 'restart keeps the durable link and star');
  const result = await main.invoke('library-toggle-favorite', item.id);
  assert.equal(result.library[item.id].favorite, false, 'the old local-star entry point updates the same link');
  assert.equal((await main.invoke('favorites-list')).entries.length, 0);
  unloadMain();
  console.log('bookmark-main: actual IPC, viewer isolation, local star, tags and restart PASS');
})().catch((error) => { unloadMain(); console.error(error); process.exitCode = 1; });
