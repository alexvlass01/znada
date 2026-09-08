'use strict';

const assert = require('assert');
const {
  DEFAULT_MAX_GALLERY_ITEMS,
  sanitizeGalleryPayload,
  sanitizePooled,
  windowItemsAroundIndex,
  windowThenMap,
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

// ---------------------------------------------------------------------------
// Which library record the viewer is told a photo already has.
//
// Owner QA 2026-08-28: in the fullscreen viewer "Найти теги и источник" was offered and
// did nothing at all. The handler needed a pool record, and this function answered "no
// record" for EVERY local picture — including ones the user keeps in the library — so
// the viewer treated a photo on the disk like an online card nobody had downloaded yet.
// Remove and assign were dead the same way. That is why the fix belongs here and not in
// the three handlers: one answer, not three patches.
// ---------------------------------------------------------------------------
{
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const pathKeyMod = require('../src/path-key');
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8')
    .split('\r\n').join('\n');
  const rendererFn = (name) => {
    const m = rendererSrc.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `${name} must remain an explicit renderer boundary`);
    return m[0];
  };

  const pool = {
    p1: { id: 'p1', type: 'image', path: 'C:\\pics\\a.jpg' },
    f1: { id: 'f1', type: 'folder', path: 'C:\\pics' },
  };
  const cardInteraction = require('../renderer/card-interaction');
  const ctx = {
    config: { library: pool },
    window: { ZnadaPathKey: pathKeyMod, CardInteraction: cardInteraction },
    OnlineAdd: { pooledItem: () => ({ id: 'online1', type: 'image', path: 'C:\\dl\\1.jpg' }) },
  };
  vm.createContext(ctx);
  vm.runInContext(rendererFn('normPathKey'), ctx);
  vm.runInContext(rendererFn('poolItemForRecord'), ctx);
  const galleryPoolRecord = vm.runInContext(`(${rendererFn('galleryPoolRecord')})`, ctx);

  const kept = galleryPoolRecord({ kind: 'library', path: 'C:\\pics\\a.jpg', raw: pool.p1 });
  assert.ok(kept && kept.id === 'p1',
    'a photo the user keeps reached the viewer with no library record, so its menu could only refuse');

  const byPath = galleryPoolRecord({ kind: 'path', path: 'C:\\PICS\\A.JPG', raw: { path: 'C:\\PICS\\A.JPG' } });
  assert.ok(byPath && byPath.id === 'p1',
    'a folder photo that HAS a record was not matched by path');

  assert.strictEqual(
    galleryPoolRecord({ kind: 'path', path: 'C:\\pics\\new.jpg', raw: { path: 'C:\\pics\\new.jpg' } }), null,
    'a photo with no record was invented one',
  );

  const online = galleryPoolRecord({ kind: 'internet', path: '', raw: { id: 'x' } });
  assert.ok(online && online.id === 'online1', 'the online path stopped working');

  // Only the kinds this function actually knows about get an answer. Dropping that guard
  // would hand an image record to any future card kind that happens to carry a path -
  // including folder cards, whose identity is a folder and not the photo at that path.
  assert.strictEqual(
    galleryPoolRecord({ kind: 'subfolder', path: 'C:\\pics\\a.jpg', raw: { path: 'C:\\pics\\a.jpg' } }), null,
    'a card kind the viewer treats differently was handed an image record anyway',
  );
  assert.strictEqual(galleryPoolRecord({ kind: 'pool-folder', path: 'C:\\pics', raw: pool.f1 }), null,
    'a folder card was handed an image record');
}

// ---------------------------------------------------------------------------
// Открытие просмотрщика не должно стоить пропорционально размеру списка.
//
// Владелец нашёл это в выпущенной сборке: клик по фото на вкладках «Усі» и «Папки»
// замораживал приложение на две-три секунды ДО появления просмотрщика, а из «Обране» и
// «Онлайн» открывалось мгновенно. Разница в том, что первые две вкладки разворачивают
// живые папки в тысячи записей. Ограничение payload применялось ПОСЛЕ обхода всего
// списка, и на каждый элемент шёл поиск по всему пулу свежим `Object.values`.
//
// В dev-профиле библиотека пустая, поэтому ни один прогон этого не показывал.
// ---------------------------------------------------------------------------
{
  const big = Array.from({ length: 5000 }, (_, i) => ({ id: i }));
  let mapped = 0;
  const out = windowThenMap(big, 2500, (entry) => { mapped += 1; return entry; }, 500);

  assert.strictEqual(mapped, 500,
    'дорогая работа выполнена сверх окна — окно взято после обхода списка, а не до');
  assert.strictEqual(out.items.length, 500, 'окно отдало не столько элементов, сколько просили');
  assert.strictEqual(out.items[out.index].id, 2500,
    'после обрезки под курсором оказалось не то фото, по которому кликнули');

  // Короткий список не режется и не смещается: обычный случай не должен пострадать.
  const small = Array.from({ length: 7 }, (_, i) => ({ id: i }));
  const smallOut = windowThenMap(small, 3, (e) => e, 500);
  assert.strictEqual(smallOut.items.length, 7, 'короткий список зачем-то обрезали');
  assert.strictEqual(smallOut.items[smallOut.index].id, 3, 'в коротком списке сместился индекс');
}

// Готовая карта должна ИСПОЛЬЗОВАТЬСЯ, а не игнорироваться. Запись кладётся только в
// карту и отсутствует в `config.library`: если поиск снова начнёт перебирать пул, он
// ничего не найдёт и тест покраснеет.
{
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const pathKeyMod = require('../src/path-key');
  const cardInteraction = require('../renderer/card-interaction');
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8')
    .split('\r\n').join('\n');
  const rendererFn = (name) => {
    const m = rendererSrc.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(m, `${name} must remain an explicit renderer boundary`);
    return m[0];
  };

  const ctx = {
    config: { library: {} },
    window: { ZnadaPathKey: pathKeyMod, CardInteraction: cardInteraction },
    OnlineAdd: { pooledItem: () => null },
  };
  vm.createContext(ctx);
  vm.runInContext(rendererFn('normPathKey'), ctx);
  vm.runInContext(rendererFn('poolItemForRecord'), ctx);
  const galleryPoolRecord = vm.runInContext(`(${rendererFn('galleryPoolRecord')})`, ctx);

  const record = { id: 'only-in-map', type: 'image', path: 'C:\\pics\\a.jpg' };
  const map = new Map([[cardInteraction.localKey(record.path, 'image'), record]]);
  const found = galleryPoolRecord(
    { kind: 'library', path: record.path, raw: { path: record.path } }, map,
  );
  assert.ok(found && found.id === 'only-in-map',
    'готовая карта записей проигнорирована — поиск снова перебирает весь пул на каждое фото');
}

console.log('gallery-payload.test.js ok');
