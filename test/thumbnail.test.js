'use strict';

const assert = require('assert');
const thumbnail = require('../src/thumbnail');

function fakeImage({ alpha = 255, jpeg = 'jpeg', png = 'png', empty = false } = {}) {
  return {
    isEmpty: () => empty,
    getSize: () => ({ width: 320, height: 200 }),
    toBitmap: () => Buffer.from([10, 20, 30, alpha, 40, 50, 60, 255]),
    toJPEG: (quality) => {
      assert.strictEqual(quality, thumbnail.DEFAULT_JPEG_QUALITY);
      return Buffer.from(jpeg);
    },
    toPNG: () => Buffer.from(png),
  };
}

assert.strictEqual(thumbnail.hasTransparency(Buffer.from([0, 0, 0, 255])), false);
assert.strictEqual(thumbnail.hasTransparency(Buffer.from([0, 0, 0, 254])), true);
assert.strictEqual(thumbnail.hasTransparency(Buffer.alloc(0)), true);

const opaque = thumbnail.encodeThumbnail(fakeImage());
assert.strictEqual(opaque.width, 320);
assert.strictEqual(opaque.height, 200);
assert.ok(opaque.url.startsWith('data:image/jpeg;base64,'));

const transparent = thumbnail.encodeThumbnail(fakeImage({ alpha: 120 }));
assert.ok(transparent.url.startsWith('data:image/png;base64,'));

const empty = thumbnail.encodeThumbnail(fakeImage({ empty: true }));
assert.deepStrictEqual(empty, { url: '', width: 0, height: 0 });

console.log('thumbnail.test.js ok');
