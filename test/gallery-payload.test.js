'use strict';

const assert = require('assert');
const {
  DEFAULT_MAX_GALLERY_ITEMS,
  sanitizeGalleryPayload,
  sanitizePooled,
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

// ONL-008: the viewer is told which library record an online photo already has, so its
// Add button can also take it back out. That identity crosses a window boundary, so it
// is sanitized like everything else in the payload.
{
  const pooled = sanitizePooled({
    id: 'abc123', path: 'C:/Users/x/AppData/Roaming/znada/wallpapers/abc123-light.jpg', type: 'image',
    favorite: true, tags: ['secret'], source: 'https://wallhaven.cc/w/abc',
  });
  assert.deepStrictEqual(Object.keys(pooled).sort(), ['id', 'path', 'type']);
  assert.strictEqual(pooled.id, 'abc123');
  assert.strictEqual(pooled.type, 'image');
}

{
  // Nothing to name the record by means nothing to remove — better than a record that
  // would match something else by accident.
  assert.strictEqual(sanitizePooled(null), null);
  assert.strictEqual(sanitizePooled(undefined), null);
  assert.strictEqual(sanitizePooled({}), null);
  assert.strictEqual(sanitizePooled({ id: '', path: '' }), null);
  assert.strictEqual(sanitizePooled('abc'), null);
  assert.strictEqual(sanitizePooled({ id: 42, path: 42 }), null);
}

{
  assert.strictEqual(sanitizePooled({ id: 'x'.repeat(400) }).id.length, 200);
  assert.strictEqual(sanitizePooled({ path: 'p'.repeat(9000) }).path.length, 4096);
  assert.strictEqual(sanitizePooled({ id: 'f', type: 'folder' }).type, 'folder');
  assert.strictEqual(sanitizePooled({ id: 'f', type: 'weird' }).type, 'image');
}

{
  const payload = sanitizeGalleryPayload({
    items: [
      { kind: 'internet', key: 'a', added: true, pooled: { id: 'p1', path: 'C:/w/p1.jpg', type: 'image', tags: ['x'] } },
      { kind: 'internet', key: 'b', added: false },
    ],
    index: 0,
  });
  assert.deepStrictEqual(payload.items[0].pooled, { id: 'p1', path: 'C:/w/p1.jpg', type: 'image' });
  assert.strictEqual(payload.items[1].pooled, null, 'an item that is not in the library carries no record identity');
}

console.log('gallery-payload.test.js ok');
