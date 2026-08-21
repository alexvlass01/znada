'use strict';

// LIB-004: removing a photo that lives inside a watched folder must stick. The user
// did not ask "unlink this record", they asked to stop seeing it — so no rescan,
// restart or overlapping folder may bring it back on its own.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../src/folder-state');
// The playlist's `exclude` set is keyed by the shared canonical key, not by a plain
// lowercase string — building it any other way is what let a removed photo keep
// reaching the desktop while the grid hid it (src/path-key.js).
const { pathKey } = require('../src/path-key');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

const ROOT = 'C:/pics';
const entry = (rel) => ({ path: path.resolve(ROOT, rel), modifiedAt: 10 });

function seeded(files = ['a.png', 'b.png', 'sub/c.png']) {
  return F.reconcileFolder(F.emptyState(), {
    folderId: 'F1', rootPath: ROOT, status: 'complete', now: 100,
    entries: files.map(entry),
  }).state;
}

const names = (images) => images.map((i) => path.basename(i.path)).sort().join(',');

// --- the basic promise ------------------------------------------------------

{
  const state = seeded();
  ok('everything is visible to begin with', names(F.listImages(state)) === 'a.png,b.png,c.png');

  const res = F.setHidden(state, [path.resolve(ROOT, 'b.png')]);
  ok('hiding one photo reports the change', res.changed && res.updated === 1);
  ok('it disappears from the library view', names(F.listImages(res.state)) === 'a.png,c.png');
  ok('and it is listed as removed, so it can be restored', names(F.listImages(res.state, null, { only: 'hidden' })) === 'b.png');
  ok('the count matches', F.countHidden(res.state) === 1);
}

{
  const state = F.setHidden(seeded(), [path.resolve(ROOT, 'sub/c.png')]).state;
  ok('a photo in a subfolder hides too', names(F.listImages(state)) === 'a.png,b.png');
}

// --- restoring ---------------------------------------------------------------

{
  const hidden = F.setHidden(seeded(), [path.resolve(ROOT, 'b.png')]).state;
  const back = F.setHidden(hidden, [path.resolve(ROOT, 'b.png')], false);
  ok('restoring brings it back', back.changed && names(F.listImages(back.state)) === 'a.png,b.png,c.png');
  ok('nothing is left in the removed list', F.countHidden(back.state) === 0);
}

{
  const state = seeded();
  ok('hiding twice is a no-op the second time',
    F.setHidden(F.setHidden(state, [path.resolve(ROOT, 'a.png')]).state, [path.resolve(ROOT, 'a.png')]).changed === false);
  ok('restoring something that was never removed is a no-op',
    F.setHidden(seeded(), [path.resolve(ROOT, 'a.png')], false).changed === false);
}

// --- it must survive everything that touches the folder ---------------------

{
  const hidden = F.setHidden(seeded(), [path.resolve(ROOT, 'b.png')]).state;
  const rescan = F.reconcileFolder(hidden, {
    folderId: 'F1', rootPath: ROOT, status: 'complete', now: 200,
    entries: ['a.png', 'b.png', 'sub/c.png'].map(entry),
  });
  ok('a full rescan does NOT un-remove it', names(rescan.images) === 'a.png,c.png');
  ok('...and it is still recorded as removed', F.countHidden(rescan.state) === 1);
  ok('...and the rescan does not report it as content change', rescan.added === 0 && rescan.removed === 0);
}

{
  const hidden = F.setHidden(seeded(), [path.resolve(ROOT, 'b.png')]).state;
  const saved = JSON.parse(JSON.stringify(hidden));
  ok('the flag survives a save/load round trip', F.countHidden(F.normalizeState(saved)) === 1);
}

{
  // A removed photo must stay known to the watcher, otherwise it looks like a brand
  // new file the next time the folder is scanned.
  const hidden = F.setHidden(seeded(), [path.resolve(ROOT, 'b.png')]).state;
  const known = F.knownPathKeys(hidden, 'F1');
  ok('a removed photo is still a known path, not a new discovery',
    known.has(pathKey(path.resolve(ROOT, 'b.png'))));
}

{
  // The same file reachable through two overlapping watched folders.
  let state = seeded();
  state = F.reconcileFolder(state, {
    folderId: 'F2', rootPath: path.resolve(ROOT, 'sub'), status: 'complete', now: 100,
    entries: [{ path: path.resolve(ROOT, 'sub/c.png'), modifiedAt: 10 }],
  }).state;
  ok('the file shows once per folder before removal', F.listImages(state).length === 4);
  const res = F.setHidden(state, [path.resolve(ROOT, 'sub/c.png')]);
  ok('removing it clears BOTH folders, so it cannot come back through the other one',
    res.updated === 2 && F.listImages(res.state).length === 2);
}

// --- dropping the folder forgets its removals (owner's decision) -------------

{
  const hidden = F.setHidden(seeded(), [path.resolve(ROOT, 'b.png')]).state;
  const dropped = F.removeFolder(hidden, 'F1');
  const readded = F.reconcileFolder(dropped.state, {
    folderId: 'F1', rootPath: ROOT, status: 'complete', now: 300,
    entries: ['a.png', 'b.png', 'sub/c.png'].map(entry),
  });
  ok('removing the folder and adding it again is a clean start',
    names(readded.images) === 'a.png,b.png,c.png' && F.countHidden(readded.state) === 0);
}

// --- bad input is ignored rather than corrupting the index ------------------

{
  const state = seeded();
  const res = F.setHidden(state, ['', null, { nope: 1 }, 'C:/elsewhere/x.png']);
  ok('paths outside every watched folder change nothing', res.changed === false && res.updated === 0);
  ok('the caller can tell which paths were actually matched', res.matched.length === 0);
}

{
  const res = F.setHidden(seeded(), [path.resolve(ROOT, 'a.png')]);
  ok('matched paths are reported back', res.matched.length === 1);
}

{
  // Undo restores exactly what THIS call hid. Reporting an already-hidden photo here
  // would make a later undo resurrect what an earlier removal had taken away.
  const once = F.setHidden(seeded(), [path.resolve(ROOT, 'a.png')]).state;
  const again = F.setHidden(once, [path.resolve(ROOT, 'a.png'), path.resolve(ROOT, 'b.png')]);
  ok('only newly changed paths are reported, not ones already removed',
    again.matched.length === 1 && again.matched[0].endsWith('b.png'));
}

// --- persisted format --------------------------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-hidden-'));
  const file = path.join(dir, 'folder-state.json');
  F.saveState(file, F.setHidden(seeded(), [path.resolve(ROOT, 'b.png')]).state);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('the file records the version that knows about removals', raw.version === F.VERSION);
  ok('only removed entries carry the flag, so the file does not grow for everyone else',
    Object.values(raw.folders.F1.files).filter((f) => f.hidden === true).length === 1
    && Object.values(raw.folders.F1.files).filter((f) => 'hidden' in f).length === 1);
  const loaded = F.loadState(file);
  ok('reloading keeps the removal', F.countHidden(loaded.state) === 1 && !loaded.recovered);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  // An index written by an older build simply has nothing removed yet.
  const older = { version: 3, folders: { F1: { rootPath: ROOT, baselineComplete: true, files: {
    'a.png': { relativePath: 'a.png', firstSeenAt: 1, modifiedAt: 2 },
  } } } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-hidden-old-'));
  const file = path.join(dir, 'folder-state.json');
  fs.writeFileSync(file, JSON.stringify(older), 'utf8');
  const loaded = F.loadState(file);
  ok('an older index still loads and shows everything',
    !loaded.recovered && F.listImages(loaded.state).length === 1 && F.countHidden(loaded.state) === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- removing a whole subfolder (LIB-008) -----------------------------------
//
// Hiding each photo one at a time would let the folder leak back in: the next photo
// dropped into it would be brand new and therefore visible. The removal is recorded
// against the path prefix instead.
{
  const state = F.setHiddenDir(seeded(['a.png', 'sub/c.png', 'sub/d.png']), [path.resolve(ROOT, 'sub')]).state;
  ok('removing a subfolder hides everything inside it', names(F.listImages(state)) === 'a.png');
  ok('...and the count reflects it', F.countHidden(state) === 2);
  ok('...and it is listed as a removed folder, not as N removed photos',
    F.listHiddenDirs(state).length === 1 && path.basename(F.listHiddenDirs(state)[0].path) === 'sub');

  // The point of hiding by prefix: a file that appears later is hidden too.
  const later = F.reconcileFolder(state, {
    folderId: 'F1', rootPath: ROOT, status: 'complete', now: 500,
    entries: ['a.png', 'sub/c.png', 'sub/d.png', 'sub/BRAND-NEW.png'].map(entry),
  });
  ok('a photo added to a removed subfolder is hidden from the start',
    names(later.images) === 'a.png');
  ok('...and is counted with the rest', F.countHidden(later.state) === 3);

  const back = F.setHiddenDir(later.state, [path.resolve(ROOT, 'sub')], false);
  ok('restoring the subfolder brings back everything, including what arrived later',
    names(F.listImages(back.state)) === 'BRAND-NEW.png,a.png,c.png,d.png');
}

{
  // A photo removed on its own stays removed even after its folder is restored:
  // two different decisions, neither one overriding the other.
  let state = seeded(['a.png', 'sub/c.png', 'sub/d.png']);
  state = F.setHidden(state, [path.resolve(ROOT, 'sub/c.png')]).state;
  state = F.setHiddenDir(state, [path.resolve(ROOT, 'sub')]).state;
  state = F.setHiddenDir(state, [path.resolve(ROOT, 'sub')], false).state;
  ok('restoring the folder does not undo a photo the user removed by itself',
    names(F.listImages(state)) === 'a.png,d.png');
}

{
  const state = seeded(['a.png', 'sub/c.png']);
  ok('hiding the same subfolder twice is a no-op the second time',
    F.setHiddenDir(F.setHiddenDir(state, [path.resolve(ROOT, 'sub')]).state, [path.resolve(ROOT, 'sub')]).changed === false);
  ok('a folder outside every watched root changes nothing',
    F.setHiddenDir(state, ['C:/elsewhere/x']).changed === false);
  ok('the watched root itself is not hideable this way — dropping the folder does that',
    F.setHiddenDir(state, [ROOT]).changed === false);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-hdirs-'));
  const file = path.join(dir, 'folder-state.json');
  F.saveState(file, F.setHiddenDir(seeded(['a.png', 'sub/c.png']), [path.resolve(ROOT, 'sub')]).state);
  const loaded = F.loadState(file);
  ok('a removed subfolder survives save and load',
    F.listHiddenDirs(loaded.state).length === 1 && names(F.listImages(loaded.state)) === 'a.png');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- the seam that shipped broken (BUG-004) ---------------------------------
//
// The whole point of removing a photo is that it stops being used. The grid read
// the folder index and honoured the removal, but the wallpaper playlist expands an
// assigned folder by reading the disk, so it kept serving the photo the user had
// just taken away. Module-level tests could not see this: the defect lives between
// folder-state and playlist. These use real files and the real playlist.
{
  const playlist = require('../src/playlist');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-slot-'));
  const a = path.join(dir, 'a.jpg');
  const b = path.join(dir, 'b.jpg');
  fs.writeFileSync(a, 'x');
  fs.writeFileSync(b, 'x');

  const lib = { f1: { id: 'f1', type: 'folder', path: dir } };
  const slot = { itemIds: ['f1'] };
  let state = F.reconcileFolder(F.emptyState(), {
    folderId: 'f1', rootPath: dir, status: 'complete', now: 1,
    entries: [{ path: a }, { path: b }],
  }).state;

  const excluded = () => new Set(F.listImages(state, null, { only: 'hidden' })
    .map((i) => pathKey(i.path)));
  const wallpapers = () => playlist
    .resolveSlot(slot, lib, { forceFolderScan: true, exclude: excluded() })
    .map((p) => path.basename(p)).sort().join(',');
  const grid = () => F.listImages(state).map((i) => path.basename(i.path)).sort().join(',');

  ok('an assigned folder serves both photos to begin with', wallpapers() === 'a.jpg,b.jpg' && grid() === 'a.jpg,b.jpg');

  state = F.setHidden(state, [b], true).state;
  ok('a removed photo leaves the grid', grid() === 'a.jpg');
  ok('...AND stops being served as wallpaper', wallpapers() === 'a.jpg');

  const rescan = F.reconcileFolder(state, {
    folderId: 'f1', rootPath: dir, status: 'complete', now: 2,
    entries: [{ path: a }, { path: b }],
  });
  state = rescan.state;
  ok('a rescan does not put it back into the playlist either', wallpapers() === 'a.jpg');

  ok('the index of a path inside the slot skips removed photos',
    playlist.resolvedIndexOf(slot, lib, b, { forceFolderScan: true, exclude: excluded() }) === -1
    && playlist.resolvedIndexOf(slot, lib, a, { forceFolderScan: true, exclude: excluded() }) === 0);

  state = F.setHidden(state, [b], false).state;
  ok('putting it back returns it to the playlist too', wallpapers() === 'a.jpg,b.jpg' && grid() === 'a.jpg,b.jpg');

  ok('without an exclude set the playlist behaves exactly as before',
    playlist.resolveSlot(slot, lib, { forceFolderScan: true }).length === 2);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nAll ${passed} folder-hidden tests passed.`);
