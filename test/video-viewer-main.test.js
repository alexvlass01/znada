'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const { makeTempDir } = require('./helpers/temp-dir');
(async () => {
  const profile = H.makeTempProfile('video-viewer'), outside = makeTempDir('video-outside-');
  H.writeJson(path.join(profile, 'config.json'), { autoSwitch: false, monitors: {} });
  H.writeJson(path.join(profile, 'config.library.json'), { version: 1, library: {}, trash: [] });
  const quiet = console.error; console.error = () => {};
  try {
    const main = H.loadMain(profile); main.__test.loadConfig();
    const managed = main.__test.managedRoot().root;
    fs.mkdirSync(managed, { recursive: true });
    const video = path.join(managed, 'clip.mp4'), photo = path.join(managed, 'still.png'), secret = path.join(outside, 'unauthorized.mp4');
    for (const file of [video, photo, secret]) fs.writeFileSync(file, 'fixture');
    assert.equal((await main.invoke('gallery-open', { items: [
      { kind: 'path', path: photo }, { kind: 'path', path: video }, { kind: 'path', path: secret },
      { kind: 'internet', path: video },
    ], index: 1 })).ok, true);
    assert.equal((await main.invoke('gallery-video', { action: 'open', index: 0, generation: 1 })).ok, false, 'photo is not a video');
    assert.equal((await main.invoke('gallery-video', { action: 'open', index: 2, generation: 1 })).ok, false, 'payload membership does not grant file authority');
    assert.equal((await main.invoke('gallery-video', { action: 'open', index: 3, generation: 1 })).ok, false, 'online entry cannot start local playback');
    assert.throws(() => main.invokeAs('main', 'gallery-video', { action: 'open', index: 1, generation: 1 }), /E_IPC_DENIED/, 'only viewer may drive playback');
    assert.equal((await main.invoke('gallery-video', { action: 'open', index: 1, generation: 1, path: secret })).ok, false);
    // The stub has no native runtime. An authorized open still owns an entry and exposes the explicit fallback.
    assert.equal((await main.invoke('gallery-video', { action: 'open', index: 1, generation: 1 })).ok, true);
    assert.equal(main.calls.openedPaths.length, 0, 'decoder failure cannot auto-launch an external player');
    assert.equal((await main.invoke('gallery-video', { action: 'external', generation: 1 })).ok, true);
    assert.deepEqual(main.calls.openedPaths, [video]);
    assert.equal((await main.invoke('gallery-video', { action: 'stop', generation: 2 })).ok, true);
    assert.equal((await main.invoke('gallery-video', { action: 'external', generation: 1 })).ok, false);
    console.log('PASS video-viewer-main: role, payload/path/type authority and explicit fallback');
  } finally { console.error = quiet; H.unloadMain(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
