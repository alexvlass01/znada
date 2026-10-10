'use strict';

// BUG-035, through the REAL main.js. A card learns whether its picture moves in the same
// answer as its thumbnail; a preview that stands for the desktop can ask on its own; the
// details sheet gets the frame count. A file the library does not vouch for is never
// read, and a JPEG is never even opened.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`  ok ${name}`);
}

// A GIF with `frames` frames: header, colour table, then one tiny image per frame.
function gif(frames) {
  const parts = [Buffer.from('GIF89a'), Buffer.from([2, 0, 2, 0, 0x80, 0, 0]), Buffer.alloc(6)];
  for (let f = 0; f < frames; f++) {
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]));
    parts.push(Buffer.from([0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0x00, 0x02, 0x02, 0x4c, 0x01, 0x00]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

(async () => {
  const userData = H.makeTempProfile('motion-main');
  H.writeJson(path.join(userData, 'config.json'), { monitors: {} });
  const own = path.join(userData, 'wallpapers');
  fs.mkdirSync(own, { recursive: true });
  const moving = path.join(own, 'moving.gif');
  const still = path.join(own, 'still.gif');
  const photo = path.join(own, 'photo.jpg');
  fs.writeFileSync(moving, gif(3));
  fs.writeFileSync(still, gif(1));
  fs.writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-motion-out-'));
  const outside = path.join(elsewhere, 'elsewhere.gif');
  fs.writeFileSync(outside, gif(3));
  // The details sheet reads only what the pool vouches for, so the moving GIF gets a record.
  const record = library.makeItem('image', moving);
  H.writeJson(path.join(userData, 'config.library.json'), { version: 1, library: { [record.id]: record }, trash: [] });

  const main = H.loadMain(userData);
  main.__test.loadConfig();

  await check('a card learns that its picture moves in the same answer as its thumbnail', async () => {
    const info = await main.invoke('thumb-info', moving, 320, 200, 0);
    assert.deepStrictEqual(info.motion, { format: 'gif', animated: true, frames: 3, width: 2, height: 2 });
  });

  await check('a still GIF says so, and a JPEG is not even looked at', async () => {
    const stillInfo = await main.invoke('thumb-info', still, 320, 200, 0);
    assert.deepStrictEqual(stillInfo.motion, { format: 'gif', animated: false, frames: 1, width: 2, height: 2 });
    const photoInfo = await main.invoke('thumb-info', photo, 320, 200, 0);
    assert.strictEqual(photoInfo.motion, undefined);
  });

  await check('a preview that stands for the desktop can ask on its own', async () => {
    assert.strictEqual((await main.invoke('media-motion', moving)).animated, true);
    assert.strictEqual((await main.invoke('media-motion', still)).animated, false);
    assert.strictEqual(await main.invoke('media-motion', photo), null);
  });

  await check('a file the library does not vouch for is never read', async () => {
    assert.strictEqual(await main.invoke('media-motion', outside), null);
    const info = await main.invoke('thumb-info', outside, 320, 200, 0);
    assert.strictEqual(info.motion, undefined);
    for (const bad of ['', 'relative.gif', `${own}\\a\0b.gif`, 42, null, { path: moving }]) {
      assert.strictEqual(await main.invoke('media-motion', bad), null, `refused: ${String(bad)}`);
    }
  });

  await check('the details sheet gets the exact frame count', async () => {
    const details = await main.invoke('item-details', moving);
    assert.strictEqual(details.exists, true);
    assert.deepStrictEqual(details.motion, { format: 'gif', animated: true, frames: 3, width: 2, height: 2 });
  });

  H.unloadMain();
  fs.rmSync(elsewhere, { recursive: true, force: true });
  console.log(`PASS image-motion-main: ${checks} checks`);
})().catch((err) => { console.error(err); process.exit(1); });
