'use strict';

// Plain Node test (no framework): `node test/playlist.test.js`.
// Covers the slideshow playlist logic that powers wallpaper resolution — the
// part most prone to silent regressions as multiple people touch main.js.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/playlist');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; };

// ---- normalizeSlot (config migration) ----
ok('normalizeSlot: legacy string -> one image item',
  JSON.stringify(P.normalizeSlot('a.jpg')) === JSON.stringify({ items: [{ type: 'image', path: 'a.jpg' }] }));
ok('normalizeSlot: empty string -> empty', P.normalizeSlot('').items.length === 0);
ok('normalizeSlot: drops invalid items',
  P.normalizeSlot({ items: [{ type: 'image', path: 'x' }, { type: 'bad', path: 'y' }, { type: 'folder' }] }).items.length === 1);
ok('normalizeSlot: null -> empty', P.normalizeSlot(null).items.length === 0);

// ---- pickCurrent (index -> image) ----
ok('pickCurrent: empty list -> ""', P.pickCurrent([], 0) === '');
ok('pickCurrent: wraps out-of-range', P.pickCurrent(['a', 'b', 'c'], 5) === 'c'); // 5 % 3 = 2
ok('pickCurrent: handles negative', P.pickCurrent(['a', 'b', 'c'], -1) === 'c');
ok('pickCurrent: index 0', P.pickCurrent(['a', 'b'], 0) === 'a');

// ---- nextIndex (slideshow advance) ----
ok('nextIndex: sequential +1', P.nextIndex(0, 3, false) === 1);
ok('nextIndex: sequential wraps', P.nextIndex(2, 3, false) === 0);
ok('nextIndex: <2 items stays', P.nextIndex(0, 1, false) === 0);
ok('nextIndex: shuffle never repeats current', (() => {
  for (let i = 0; i < 100; i++) if (P.nextIndex(1, 3, true) === 1) return false;
  return true;
})());
ok('nextIndex: shuffle deterministic with rnd', P.nextIndex(0, 3, true, () => 0.99) === 2); // floor(0.99*3)=2
ok('reconcilePosition: insertion before current advances from saved path', (() => {
  const pos = P.reconcilePosition(['A', 'AA', 'B', 'C'], 'B', 1, { advance: true });
  return pos.index === 3 && pos.path === 'C';
})());
ok('reconcilePosition: removed current uses old index as successor', (() => {
  const pos = P.reconcilePosition(['A', 'C', 'D'], 'B', 1, { advance: true });
  return pos.index === 1 && pos.path === 'C';
})());
ok('reconcilePosition: removal before current does not skip', (() => {
  const pos = P.reconcilePosition(['B', 'C', 'D'], 'C', 2, { advance: true });
  return pos.index === 2 && pos.path === 'D';
})());
ok('reconcilePosition: legacy config keeps index semantics', (() => {
  const current = P.reconcilePosition(['A', 'B', 'C'], '', 1);
  const next = P.reconcilePosition(['A', 'B', 'C'], '', 1, { advance: true });
  return current.path === 'B' && next.path === 'C';
})());
ok('reconcilePosition: shuffle never repeats an existing current path',
  P.reconcilePosition(['A', 'B', 'C'], 'B', 1, { advance: true, shuffle: true, rnd: () => 0.99 }).path === 'C');
ok('usesInterval: legacy slideshow stays enabled unless explicitly disabled',
  P.usesInterval({ enabled: true }) === true
  && P.usesInterval({ enabled: true, intervalEnabled: false }) === false
  && P.usesInterval({ enabled: false, intervalEnabled: true }) === false);

// ---- resolveSlot (real temp folder) ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-pl-'));
fs.writeFileSync(path.join(dir, 'b.jpg'), 'x');
fs.writeFileSync(path.join(dir, 'a.png'), 'x');
fs.writeFileSync(path.join(dir, 'note.txt'), 'x'); // not an image
const realImg = path.join(dir, 'a.png');
const missing = path.join(dir, 'gone.jpg');
const list = P.resolveSlot({ items: [
  { type: 'image', path: realImg },   // explicit, also lives in the folder
  { type: 'image', path: missing },   // does not exist -> excluded
  { type: 'folder', path: dir },      // expands to a.png + b.jpg (sorted)
] });
ok('resolveSlot: excludes missing files', !list.includes(missing));
ok('resolveSlot: excludes non-images (.txt)', !list.some((p) => p.endsWith('.txt')));
ok('resolveSlot: de-dups folder vs explicit', list.filter((p) => p === realImg).length === 1);
ok('resolveSlot: includes folder images', list.some((p) => p.endsWith('a.png')) && list.some((p) => p.endsWith('b.jpg')));
fs.writeFileSync(path.join(dir, 'c.gif'), 'x');
ok('resolveSlot: ordinary call keeps short folder cache',
  !P.resolveSlot({ items: [{ type: 'folder', path: dir }] }).some((p) => p.endsWith('c.gif')));
ok('resolveSlot: forced folder scan sees immediate changes',
  P.resolveSlot({ items: [{ type: 'folder', path: dir }] }, null, { forceFolderScan: true }).some((p) => p.endsWith('c.gif')));

// ---- resolveSlot via library pool (new model: { itemIds } + library) ----
const L = require('../src/library');
const lib = {};
const idImg = L.addPath(lib, 'image', realImg);
const idDir = L.addPath(lib, 'folder', dir);
const idGhost = L.addPath(lib, 'image', missing);
const viaLib = P.resolveSlot({ itemIds: [idImg, idGhost, idDir] }, lib);
ok('resolveSlot(lib): resolves itemIds via pool',
  viaLib.some((p) => p.endsWith('a.png')) && viaLib.some((p) => p.endsWith('b.jpg')));
ok('resolveSlot(lib): excludes missing', !viaLib.includes(missing));
ok('resolveSlot(lib): de-dups explicit vs folder', viaLib.filter((p) => p === realImg).length === 1);
ok('resolveSlot(lib): unknown id skipped', P.resolveSlot({ itemIds: ['nope'] }, lib).length === 0);
ok('resolveSlot: legacy {items} still works w/o library',
  P.resolveSlot({ items: [{ type: 'image', path: realImg }] }).length === 1);

// ---- resolvedIndexOf (path -> EXPANDED index; folder expands so strip idx != real idx) ----
const slotFD = { itemIds: [idDir, idImg] }; // folder(dir)=a.png,b.jpg THEN explicit a.png (dedups)
ok('resolvedIndexOf: folder image maps to its expanded index',
  P.resolvedIndexOf(slotFD, lib, path.join(dir, 'b.jpg')) === 1);
ok('resolvedIndexOf: first image at 0', P.resolvedIndexOf(slotFD, lib, realImg) === 0);
ok('resolvedIndexOf: missing path -> -1', P.resolvedIndexOf(slotFD, lib, path.join(dir, 'zzz.jpg')) === -1);
ok('resolvedIndexOf: case-insensitive', P.resolvedIndexOf(slotFD, lib, path.join(dir, 'B.JPG')) === 1);
ok('resolvedIndexOf: extended-length and separator alias maps to the same frame',
  P.resolvedIndexOf(slotFD, lib, `\\\\?\\${realImg.replace(/\\/g, '/')}`) === 0);

fs.rmSync(dir, { recursive: true, force: true });

// ---- scanFolderEntries + scanFolderImagesDeep (real temp tree with nesting) ----
const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-fold-'));
fs.writeFileSync(path.join(tree, 'top.jpg'), 'x');
fs.writeFileSync(path.join(tree, 'note.txt'), 'x'); // not an image
const sub = path.join(tree, 'sub');
fs.mkdirSync(sub);
fs.writeFileSync(path.join(sub, 'deep.png'), 'x');
const sub2 = path.join(sub, 'sub2');
fs.mkdirSync(sub2);
fs.writeFileSync(path.join(sub2, 'deeper.webp'), 'x');

const ent = P.scanFolderEntries(tree);
ok('scanFolderEntries: lists subfolders', ent.folders.some((p) => p.endsWith('sub')));
ok('scanFolderEntries: lists one-level images', ent.images.some((p) => p.endsWith('top.jpg')));
ok('scanFolderEntries: excludes non-images', !ent.images.some((p) => p.endsWith('.txt')));
ok('scanFolderEntries: does NOT recurse images', !ent.images.some((p) => p.endsWith('deep.png')));

const deep = P.scanFolderImagesDeep(tree);
ok('scanFolderImagesDeep: includes top + all nested levels',
  deep.some((p) => p.endsWith('top.jpg')) && deep.some((p) => p.endsWith('deep.png')) && deep.some((p) => p.endsWith('deeper.webp')));
ok('scanFolderImagesDeep: excludes non-images', !deep.some((p) => p.endsWith('.txt')));
ok('scanFolderImagesDeep: respects maxDepth (0 = top level only)', (() => {
  const d0 = P.scanFolderImagesDeep(tree, { maxDepth: 0 });
  return d0.some((p) => p.endsWith('top.jpg')) && !d0.some((p) => p.endsWith('deep.png'));
})());
ok('scanFolderImagesDeep: respects cap', P.scanFolderImagesDeep(tree, { cap: 1 }).length === 1);

fs.rmSync(tree, { recursive: true, force: true });

// ONL-015. Exercise the actual scanners, not only their exported Set: casing comes from
// real filenames and every one of the six formats must cross all three local paths.
const formatsTree = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-formats-'));
const formatNames = ['a.JPG', 'b.JpEg', 'c.PNG', 'd.BmP', 'e.WeBp', 'f.GIF'];
formatNames.forEach((name) => fs.writeFileSync(path.join(formatsTree, name), 'x'));
fs.writeFileSync(path.join(formatsTree, 'moving.WEBM'), 'x');
fs.writeFileSync(path.join(formatsTree, 'note.TXT'), 'x');
const shallowFormats = P.scanFolder(formatsTree).map((p) => path.basename(p)).sort();
const entryFormats = P.scanFolderEntries(formatsTree).images.map((p) => path.basename(p)).sort();
const deepFormats = P.scanFolderImagesDeep(formatsTree).map((p) => path.basename(p)).sort();
ok('all local playlist scanners accept the six formats case-insensitively and reject the rest',
  shallowFormats.join() === formatNames.slice().sort().join()
  && entryFormats.join() === shallowFormats.join()
  && deepFormats.join() === shallowFormats.join());
fs.rmSync(formatsTree, { recursive: true, force: true });

console.log('\nAll ' + passed + ' playlist tests passed.');
