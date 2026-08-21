'use strict';

// Plain Node test: `node test/library.test.js`. Covers the content-pool module —
// CRUD/dedup/list + the regression-prone config migration (inline slots → itemIds).

const assert = require('assert');
const L = require('../src/library');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

// ---- idFor: stable + path-normalized ----
ok('idFor: stable for same path', L.idFor('C:/a.jpg') === L.idFor('C:/a.jpg'));
ok('idFor: case/slash/trailing-insensitive',
  L.idFor('C:\\Pics\\A.JPG\\') === L.idFor('c:/pics/a.jpg'));
ok('idFor: different paths differ', L.idFor('C:/a.jpg') !== L.idFor('C:/b.jpg'));

// ---- makeItem defaults ----
const it = L.makeItem('image', 'C:/a.jpg');
ok('makeItem: defaults', it.type === 'image' && it.favorite === false
  && Array.isArray(it.tags) && it.tags.length === 0 && it.author === ''
  && Number.isFinite(it.addedAt) && it.id === L.idFor('C:/a.jpg'));
ok('makeItem: folder type coerced', L.makeItem('folder', 'C:/d').type === 'folder');
ok('makeItem: unknown type -> image', L.makeItem('weird', 'C:/x').type === 'image');
ok('aspectOf: accepts direct aspect or dimensions and rejects junk',
  L.aspectOf({ aspect: 1.5 }) === 1.5
  && L.aspectOf({ width: 1920, height: 1080 }) === 1920 / 1080
  && L.aspectOf({ aspect: -1, width: 0, height: 10 }) === 0);
ok('makeItem: preserves valid aspect metadata', L.makeItem('image', 'C:/wide.jpg', { width: 1600, height: 900 }).aspect === 1600 / 900);
// modifiedAt is carried only when valid (>0), so a materialized live-folder image keeps
// the same secondary sort key as its ephemeral form instead of jumping under "newest first".
ok('makeItem: keeps valid modifiedAt', L.makeItem('image', 'C:/m.jpg', { addedAt: 100, modifiedAt: 42 }).modifiedAt === 42);
ok('makeItem: omits missing/invalid modifiedAt',
  !('modifiedAt' in L.makeItem('image', 'C:/n.jpg', { addedAt: 100 }))
  && !('modifiedAt' in L.makeItem('image', 'C:/o.jpg', { addedAt: 100, modifiedAt: 0 }))
  && !('modifiedAt' in L.makeItem('image', 'C:/p.jpg', { addedAt: 100, modifiedAt: -5 })));

// ---- addItem / dedup / getItem / removeItem ----
const lib = {};
const id1 = L.addPath(lib, 'image', 'C:/a.jpg');
const id2 = L.addPath(lib, 'image', 'C:/a.jpg'); // same path -> dedup
ok('addPath: dedup by id (same path => same id, one entry)',
  id1 === id2 && Object.keys(lib).length === 1);
ok('addItem: invalid -> null', L.addItem(lib, { type: 'image' }) === null && L.addPath(lib, 'image', '') === null);

// existing item preserved (metadata not clobbered on re-add)
lib[id1].favorite = true;
L.addPath(lib, 'image', 'C:/a.jpg');
ok('addItem: existing metadata preserved on re-add', lib[id1].favorite === true);

ok('getItem: hit / miss', L.getItem(lib, id1).path === 'C:/a.jpg' && L.getItem(lib, 'nope') === null);
ok('setAspect: updates matching image only',
  L.setAspect(lib, id1, 'C:/a.jpg', 1.75) === true
  && L.aspectOf(lib[id1]) === 1.75
  && L.setAspect(lib, id1, 'C:/other.jpg', 1.2) === false
  && L.setAspect(lib, 'missing', 'C:/a.jpg', 1.2) === false);
const idFolder = L.addPath(lib, 'folder', 'C:/pics');
ok('removeItem: removes', L.removeItem(lib, idFolder) === true && L.getItem(lib, idFolder) === null);
ok('removeItem: missing -> false', L.removeItem(lib, 'nope') === false);

// ---- toggleFavorite ----
lib[id1].favorite = false;
ok('toggleFavorite: flips + returns state', L.toggleFavorite(lib, id1) === true && lib[id1].favorite === true);
ok('toggleFavorite: missing -> false', L.toggleFavorite(lib, 'nope') === false);

// ---- resolveIds: order preserved, unknown skipped ----
const lib2 = {};
const a = L.addPath(lib2, 'image', 'C:/a.jpg');
const b = L.addPath(lib2, 'image', 'C:/b.jpg');
const resolved = L.resolveIds(lib2, [b, 'ghost', a]);
ok('resolveIds: order kept + unknown skipped',
  resolved.length === 2 && resolved[0].path === 'C:/b.jpg' && resolved[1].path === 'C:/a.jpg');

// ---- listItems: filter + sort ----
const lib3 = {};
L.addItem(lib3, L.makeItem('image', 'C:/z.jpg', { addedAt: 100 }));
L.addItem(lib3, L.makeItem('image', 'C:/a.jpg', { addedAt: 300, favorite: true }));
L.addItem(lib3, L.makeItem('folder', 'C:/d',    { addedAt: 200 }));
ok('listItems: sort added (newest first)',
  L.listItems(lib3, { sort: 'added' }).map((x) => x.addedAt).join() === '300,200,100');
ok('listItems: sort name', L.listItems(lib3, { sort: 'name' }).map((x) => L.baseName(x.path)).join() === 'a.jpg,d,z.jpg');
ok('listItems: filter type=image', L.listItems(lib3, { filter: { type: 'image' } }).length === 2);
ok('listItems: filter favorite', (() => {
  const f = L.listItems(lib3, { filter: { favorite: true } });
  return f.length === 1 && f[0].path === 'C:/a.jpg';
})());

// ---- tags ----
const lib4 = {};
const t1 = L.addPath(lib4, 'image', 'C:/t1.jpg');
const t2 = L.addPath(lib4, 'image', 'C:/t2.jpg');
ok('addTag: normalizes (trim/case) + creates array', (() => {
  L.addTag(lib4, t1, '  Nature  ');
  return lib4[t1].tags.length === 1 && lib4[t1].tags[0] === 'nature';
})());
ok('addTag: dedups (case-insensitive)', L.addTag(lib4, t1, 'NATURE') === false && lib4[t1].tags.length === 1);
ok('addTag: empty tag ignored', L.addTag(lib4, t1, '   ') === false);
ok('removeTag: removes', (() => { L.addTag(lib4, t1, 'space'); L.removeTag(lib4, t1, 'Nature'); return JSON.stringify(lib4[t1].tags) === JSON.stringify(['space']); })());
ok('removeTag: missing -> false', L.removeTag(lib4, t1, 'ghost') === false);
ok('allTags: distinct + sorted', (() => {
  L.addTag(lib4, t2, 'beach'); L.addTag(lib4, t2, 'space');
  return JSON.stringify(L.allTags(lib4)) === JSON.stringify(['beach', 'space']);
})());
ok('listItems: filter by tag', (() => {
  const r = L.listItems(lib4, { filter: { tag: 'space' } });
  return r.length === 2;
})());

// ---- migrateSlot ----
const ms = {};
ok('migrateSlot: legacy string -> itemIds', (() => {
  const s = L.migrateSlot(ms, 'C:/one.jpg');
  return s.itemIds.length === 1 && L.getItem(ms, s.itemIds[0]).path === 'C:/one.jpg';
})());
ok('migrateSlot: {items} image+folder -> 2 ids w/ types', (() => {
  const lc = {};
  const s = L.migrateSlot(lc, { items: [{ type: 'image', path: 'C:/p.jpg' }, { type: 'folder', path: 'C:/dir' }] });
  return s.itemIds.length === 2
    && L.getItem(lc, s.itemIds[0]).type === 'image'
    && L.getItem(lc, s.itemIds[1]).type === 'folder';
})());
ok('migrateSlot: dedup same path within slot', (() => {
  const lc = {};
  const s = L.migrateSlot(lc, { items: [{ type: 'image', path: 'C:/dup.jpg' }, { type: 'image', path: 'C:/dup.jpg' }] });
  return s.itemIds.length === 1 && Object.keys(lc).length === 1;
})());
ok('migrateSlot: already-new {itemIds} kept', (() => {
  const s = L.migrateSlot({}, { itemIds: ['abc', 'def'] });
  return s.itemIds.join() === 'abc,def';
})());
ok('migrateSlot: explicit empty marker survives only on empty slots', (() => {
  const empty = L.migrateSlot({}, { itemIds: [], legacyFallbackDisabled: true });
  const full = L.migrateSlot({}, { itemIds: ['abc'], legacyFallbackDisabled: true });
  return empty.itemIds.length === 0 && empty.legacyFallbackDisabled === true
    && full.itemIds.length === 1 && full.legacyFallbackDisabled !== true;
})());
ok('slot explicit empty helpers gate legacy fallback', (() => {
  const slot = { itemIds: [] };
  return L.allowsLegacyFallback(slot)
    && L.markSlotExplicitEmpty(slot) === true
    && L.allowsLegacyFallback(slot) === false
    && L.clearSlotExplicitEmpty(slot) === true
    && L.allowsLegacyFallback(slot) === true;
})());

// ---- migrateConfig: the real thing ----
ok('migrateConfig: two monitors, light/dark not mixed up', (() => {
  const cfg = {
    monitors: {
      M1: { light: 'C:/m1-light.jpg', dark: 'C:/m1-dark.jpg' },
      M2: { light: { items: [{ type: 'image', path: 'C:/m2-light.jpg' }] }, dark: '' },
    },
  };
  L.migrateConfig(cfg);
  const m1l = L.getItem(cfg.library, cfg.monitors.M1.light.itemIds[0]);
  const m1d = L.getItem(cfg.library, cfg.monitors.M1.dark.itemIds[0]);
  return m1l.path === 'C:/m1-light.jpg' && m1d.path === 'C:/m1-dark.jpg'
    && cfg.monitors.M2.light.itemIds.length === 1 && cfg.monitors.M2.dark.itemIds.length === 0
    && L.getItem(cfg.library, cfg.monitors.M2.light.itemIds[0]).path === 'C:/m2-light.jpg';
})());

ok('migrateConfig: legacy globals folded into pool, string fields kept', (() => {
  const cfg = { monitors: {}, lightWallpaper: 'C:/glob-l.jpg', darkWallpaper: 'C:/glob-d.jpg' };
  L.migrateConfig(cfg);
  const paths = Object.values(cfg.library).map((x) => x.path).sort();
  return paths.join() === 'C:/glob-d.jpg,C:/glob-l.jpg'
    && cfg.lightWallpaper === 'C:/glob-l.jpg' && cfg.darkWallpaper === 'C:/glob-d.jpg';
})());

ok('migrateConfig: idempotent (run twice = same)', (() => {
  const cfg = { monitors: { M: { light: 'C:/a.jpg', dark: '' } } };
  L.migrateConfig(cfg);
  const snap = JSON.stringify(cfg);
  L.migrateConfig(cfg);
  return JSON.stringify(cfg) === snap;
})());

ok('migrateConfig: empty/garbage safe', (() => {
  const cfg = {};
  L.migrateConfig(cfg);
  return typeof cfg.library === 'object' && Object.keys(cfg.library).length === 0;
})());

// ---- flattenImages: pool images + expanded folders, deduped by id ----
const lib5 = {};
L.addPath(lib5, 'image', 'C:/photos/a.jpg');
L.addPath(lib5, 'folder', 'C:/photos/dir');
// stub scanDeep: the folder expands to b.jpg + a.jpg (a.jpg duplicates the pool image by path)
const scanDeep = (d) => (d === 'C:/photos/dir' ? ['C:/photos/dir/b.jpg', 'C:/photos/a.jpg'] : []);
const flat = L.flattenImages(lib5, scanDeep);
ok('flattenImages: pool image present + inPool=true',
  flat.some((x) => x.path === 'C:/photos/a.jpg' && x.inPool === true));
ok('flattenImages: folder image present + inPool=false',
  flat.some((x) => x.path === 'C:/photos/dir/b.jpg' && x.inPool === false));
ok('flattenImages: dedup pool vs folder by id (a.jpg once, pool wins)',
  flat.filter((x) => x.id === L.idFor('C:/photos/a.jpg')).length === 1
  && flat.find((x) => x.id === L.idFor('C:/photos/a.jpg')).inPool === true);
ok('flattenImages: folder items themselves excluded', !flat.some((x) => x.path === 'C:/photos/dir'));
ok('flattenImages: no scanDeep -> pool images only',
  L.flattenImages(lib5, null).every((x) => x.inPool) && L.flattenImages(lib5, null).length === 1);

const ephemeral = L.ephemeralFolderImages(lib5, [
  { path: 'C:/photos/a.jpg', addedAt: 500, modifiedAt: 50 }, // pool wins -> omitted
  { path: 'C:/photos/new.jpg', addedAt: 300, modifiedAt: 30, aspect: 1.75 },
  { path: 'c:\\PHOTOS\\NEW.JPG', addedAt: 200, modifiedAt: 20 }, // same normalized path, earlier discovery wins
]);
ok('ephemeralFolderImages: pool wins and duplicate keeps earliest discovery', ephemeral.length === 1
  && ephemeral[0].id === L.idFor('C:/photos/new.jpg')
  && ephemeral[0].addedAt === 200
  && ephemeral[0].modifiedAt === 20
  && ephemeral[0].aspect === 1.75);
ok('ephemeralFolderImages: learned aspect survives overlap deduplication',
  L.ephemeralFolderImages({}, [
    { path: 'C:/same.jpg', addedAt: 1 },
    { path: 'c:\\SAME.JPG', addedAt: 2, aspect: 0.8 },
  ])[0].aspect === 0.8);

const recentLib = {};
L.addItem(recentLib, L.makeItem('image', 'C:/pool.jpg', { addedAt: 150 }));
const recent = L.recentImages(recentLib, [
  { path: 'C:/pool.jpg', addedAt: 999, modifiedAt: 999 }, // pool metadata wins
  { path: 'C:/folder-old.jpg', addedAt: 100, modifiedAt: 10 },
  { path: 'C:/folder-new.jpg', addedAt: 300, modifiedAt: 30 },
], 3);
ok('recentImages: combines pool and folders in discovery order', recent.length === 3
  && recent.map((x) => x.path).join('|') === 'C:/folder-new.jpg|C:/pool.jpg|C:/folder-old.jpg');
ok('recentImages: marks only folder records ephemeral', recent[0].ephemeral === true
  && recent[1].ephemeral === false);

// ---- confirmed stale materialized live-folder images ----
const liveLib = {};
L.addPath(liveLib, 'folder', 'C:/Live');
const liveGone = L.addPath(liveLib, 'image', 'C:/Live/gone.jpg');
const liveStillIndexed = L.addPath(liveLib, 'image', 'C:/Live/still-indexed.jpg');
const liveStillExists = L.addPath(liveLib, 'image', 'C:/Live/still-exists.jpg');
const outsideGone = L.addPath(liveLib, 'image', 'C:/Other/gone.jpg');
const indexedLiveRows = [{ path: 'C:/Live/still-indexed.jpg', addedAt: 1, modifiedAt: 1 }];
const existingLive = new Set(['C:/Live', 'C:/Live/still-exists.jpg']);
const staleLive = L.findConfirmedMissingLiveFolderImageIds(
  liveLib,
  indexedLiveRows,
  (p) => existingLive.has(p),
  (p) => existingLive.has(p)
);
ok('findConfirmedMissingLiveFolderImageIds: removes only confirmed missing files under available roots',
  staleLive.length === 1 && staleLive[0] === liveGone
  && !staleLive.includes(liveStillIndexed)
  && !staleLive.includes(liveStillExists)
  && !staleLive.includes(outsideGone));
ok('findConfirmedMissingLiveFolderImageIds: offline root keeps materialized images',
  L.findConfirmedMissingLiveFolderImageIds(liveLib, [], () => false, () => false).length === 0);
ok('isPathInsideRoot: matches only real children',
  L.isPathInsideRoot('C:/Live/a.jpg', 'C:/Live')
  && !L.isPathInsideRoot('C:/Live2/a.jpg', 'C:/Live')
  && !L.isPathInsideRoot('C:/Live', 'C:/Live'));
ok('isPathInsideRoot: accepts extended-length and separator aliases',
  L.isPathInsideRoot('\\\\?\\C:\\Live\\nested/a.jpg', 'C:/Live/')
  && !L.isPathInsideRoot('\\\\?\\C:\\Live', 'C:/Live/'));

// ---- findMissingIds: pool entries whose path no longer exists (refresh sanity check) ----
const lib6 = {};
const okId = L.addPath(lib6, 'image', 'C:/exists.jpg');
const goneId = L.addPath(lib6, 'image', 'C:/gone.jpg');
const goneDir = L.addPath(lib6, 'folder', 'C:/missing-dir');
const existing = new Set(['C:/exists.jpg']);
const missing = L.findMissingIds(lib6, (p) => existing.has(p));
ok('findMissingIds: flags only the missing image + folder',
  missing.length === 2 && missing.includes(goneId) && missing.includes(goneDir) && !missing.includes(okId));
ok('findMissingIds: nothing missing -> empty', L.findMissingIds(lib6, () => true).length === 0);
ok('findMissingIds: no existsFn -> empty (safe no-op)', L.findMissingIds(lib6).length === 0);

// ---- referencedFiles: the GC keep-set (SAFETY-CRITICAL — under-inclusion loses user files) ----
const key = (p) => L.pathKey(p);
const lib7 = {};
L.addPath(lib7, 'image', 'C:/store/A.jpg');
L.addPath(lib7, 'image', 'C:/store/b.png');
L.addPath(lib7, 'folder', 'C:/pics/dir'); // folders are external sources, not GC-swept files
const cfg7 = { library: lib7, lightWallpaper: 'C:/store/legacy-light.jpg', darkWallpaper: '' };
const keep = L.referencedFiles(cfg7);
ok('referencedFiles: keeps every pool image (normalized, case-insensitive)',
  keep.has(key('C:/store/A.jpg')) && keep.has(key('C:/store/b.png')));
ok('referencedFiles: keeps legacy globals, skips empty ones',
  keep.has(key('C:/store/legacy-light.jpg')) && keep.size === 3);
const aliasLib = {};
L.addPath(aliasLib, 'image', '\\\\?\\C:\\store\\Alias.jpg');
const aliasKeep = L.referencedFiles({ library: aliasLib });
ok('referencedFiles: extended-length stored path protects the ordinary GC path',
  aliasKeep.has(key('C:/store/Alias.jpg')));
ok('referencedFiles: folder paths are not file refs', !keep.has(key('C:/pics/dir')));
ok('referencedFiles: empty/missing config -> empty set',
  L.referencedFiles(null).size === 0 && L.referencedFiles({}).size === 0);

console.log('\nAll ' + passed + ' library tests passed.');
