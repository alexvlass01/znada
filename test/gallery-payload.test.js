'use strict';

const assert = require('assert');
const {
  DEFAULT_MAX_GALLERY_ITEMS,
  sanitizeGalleryPayload,
  windowItemsAroundIndex,
} = require('../src/gallery-payload');

function item(n) {
  return {
    kind: 'path',
    key: `path:${n}`,
    title: `Image ${n}`,
    subtitle: 'Local',
    path: `C:\\pics\\${n}.jpg`,
    raw: { n },
  };
}

{
  const items = Array.from({ length: 600 }, (_, i) => item(i));
  const payload = sanitizeGalleryPayload({ items, index: 550 });
  assert.strictEqual(payload.items.length, DEFAULT_MAX_GALLERY_ITEMS);
  assert.strictEqual(payload.items[payload.index].key, 'path:550');
}

{
  const items = Array.from({ length: 600 }, (_, i) => item(i));
  const win = windowItemsAroundIndex(items, 5, 100);
  assert.strictEqual(win.start, 0);
  assert.strictEqual(win.index, 5);
  assert.strictEqual(win.items[5].key, 'path:5');
}

{
  const items = Array.from({ length: 600 }, (_, i) => item(i));
  const win = windowItemsAroundIndex(items, 599, 100);
  assert.strictEqual(win.start, 500);
  assert.strictEqual(win.index, 99);
  assert.strictEqual(win.items[99].key, 'path:599');
}

{
  const payload = sanitizeGalleryPayload({
    items: [{
      kind: 'library',
      key: 'k',
      title: 'x'.repeat(400),
      subtitle: 's'.repeat(400),
      path: 42,
      previewUrl: 'https://example.invalid/a.jpg',
      query: 'q'.repeat(600),
      added: 1,
      raw: null,
    }],
    index: 0,
  });
  assert.strictEqual(payload.items[0].title.length, 300);
  assert.strictEqual(payload.items[0].subtitle.length, 300);
  assert.strictEqual(payload.items[0].path, '');
  assert.strictEqual(payload.items[0].query.length, 500);
  assert.deepStrictEqual(payload.items[0].raw, {});
  assert.strictEqual(payload.items[0].added, true);
}

console.log('gallery-payload.test.js ok');
