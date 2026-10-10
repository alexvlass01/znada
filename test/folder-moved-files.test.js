'use strict';

// LIB-024: a file renamed or moved inside a watched folder is the SAME file. The folder
// index has to say so in the scan that notices it, because that scan is also the one
// that forgets the old name — and with it everything the user attached to the photo.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../src/folder-state');
const { pathKey } = require('../src/path-key');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  ✓ ' + name); passed++; };

const ROOT = path.resolve('C:/pics');
const at = (rel) => path.resolve(ROOT, rel);
const file = (rel, size, modifiedAt, extra = {}) => ({ path: at(rel), size, modifiedAt, ...extra });

// An index that already knows the folder: the first scan is a baseline, and a baseline
// has nothing to compare with.
function indexed(entries, now = 1000) {
  return F.reconcileFolder(F.emptyState(), {
    folderId: 'F', rootPath: ROOT, folderAddedAt: now, now, status: 'complete', entries,
  }).state;
}

function rescan(state, entries, now = 9000, status = 'complete') {
  return F.reconcileFolder(state, { folderId: 'F', rootPath: ROOT, now, status, entries });
}

const beach = file('beach.jpg', 100, 5000.25, { aspect: 1.5 });
const city = file('city.jpg', 200, 6000.5);

// --- the case the task is about -------------------------------------------------

{
  const res = rescan(indexed([beach, city]), [file('beach-2026.jpg', 100, 5000.25), city]);
  ok('a renamed file is reported as moved, old name to new name',
    res.moved.length === 1 && res.moved[0].from === at('beach.jpg') && res.moved[0].to === at('beach-2026.jpg'));
  ok('the old name is still forgotten and the new one indexed', res.removed === 1 && res.added === 1
    && !res.state.folders.F.files['beach.jpg'] && !!res.state.folders.F.files['beach-2026.jpg']);
  const moved = res.state.folders.F.files['beach-2026.jpg'];
  ok('it keeps its discovery date instead of becoming "just added"', moved.firstSeenAt === 1000);
  ok('it keeps the proportions already learned', moved.aspect === 1.5);
  const card = res.images.find((im) => im.path === at('beach-2026.jpg'));
  ok('the card handed to the window carries the same date', card.firstSeenAt === 1000 && card.addedAt === 1000);
  // The returned list must agree with the index it describes (review of PR #108).
  ok('...and the same proportions', card.aspect === 1.5);
}

{
  const res = rescan(indexed([beach, city]), [file('sea/beach.jpg', 100, 5000.25), city]);
  ok('a file moved into a subfolder is the same file', res.moved.length === 1
    && res.moved[0].to === at('sea/beach.jpg'));
}

// --- LIB-025: a removed photo stays removed under its new name -----------------------

{
  const removed = F.setHidden(indexed([beach, city]), [at('beach.jpg')], true).state;
  const res = rescan(removed, [file('beach-2026.jpg', 100, 5000.25), city]);
  ok('a removed photo, renamed, is reported as moved and as removed',
    res.moved.length === 1 && res.moved[0].hidden === true && res.moved[0].to === at('beach-2026.jpg'));
  ok('the new name carries the removed mark', res.state.folders.F.files['beach-2026.jpg'].hidden === true);
  ok('...so it is not in the list of photos shown', !res.images.some((im) => im.path === at('beach-2026.jpg')));
  ok('the photo beside it is unaffected', res.images.some((im) => im.path === at('city.jpg'))
    && !res.state.folders.F.files['city.jpg'].hidden);
  const listed = F.listImages(res.state, null, { only: 'hidden' }).map((im) => im.path);
  ok('the index lists it as removed by its new name only', listed.length === 1 && listed[0] === at('beach-2026.jpg'));
}

{
  const res = rescan(indexed([beach, city]), [file('beach-2026.jpg', 100, 5000.25), city]);
  ok('a photo that was not removed is reported as not removed', res.moved[0].hidden === false
    && !res.state.folders.F.files['beach-2026.jpg'].hidden);
}

{
  // Removed by its SUBFOLDER, not by itself: moving it out is not a decision about the
  // photo, so no mark of its own is invented for it.
  const start = indexed([file('old/beach.jpg', 100, 5000.25), city]);
  const removedDir = F.setHiddenDir(start, [at('old')], true).state;
  const res = rescan(removedDir, [file('beach.jpg', 100, 5000.25), city]);
  ok('a photo hidden only by its removed subfolder gets no mark of its own when moved out',
    res.moved.length === 1 && res.moved[0].hidden === false && !res.state.folders.F.files['beach.jpg'].hidden);
}

{
  const res = rescan(indexed([file('sea/beach.jpg', 100, 5000.25), city]), [file('beach.jpg', 100, 5000.25), city]);
  ok('a file moved up out of a subfolder is the same file', res.moved.length === 1
    && res.moved[0].from === at('sea/beach.jpg') && res.moved[0].to === at('beach.jpg'));
}

// --- what is NOT the same file ---------------------------------------------------

{
  const res = rescan(indexed([beach, city]), [city]);
  ok('a deleted file is only removed', res.moved.length === 0 && res.removed === 1);
}

{
  const res = rescan(indexed([beach, city]), [file('other.jpg', 101, 5000.25), city]);
  ok('a different size is a different file', res.moved.length === 0
    && res.state.folders.F.files['other.jpg'].firstSeenAt === 9000);
}

{
  const res = rescan(indexed([beach, city]), [file('other.jpg', 100, 5000.5), city]);
  ok('a different modification time is a different file', res.moved.length === 0);
}

{
  const res = rescan(indexed([beach, city]), [file('beach.png', 100, 5000.25), city]);
  ok('a different extension is a different file', res.moved.length === 0);
}

{
  // Renamed AND copied in the same moment: two candidates, and nothing says which one
  // the user meant. Attaching the star to the wrong one is worse than losing it.
  const res = rescan(indexed([beach, city]),
    [file('beach-a.jpg', 100, 5000.25), file('beach-b.jpg', 100, 5000.25), city]);
  ok('two candidates for one vanished file: neither is chosen', res.moved.length === 0);
}

{
  const twins = [file('one.jpg', 100, 5000.25), file('two.jpg', 100, 5000.25), city];
  const res = rescan(indexed(twins), [file('three.jpg', 100, 5000.25), city]);
  ok('two vanished files that look identical: neither claims the new one', res.moved.length === 0);
}

{
  // Indexed before sizes were stored: no identity yet, so no guess either.
  const res = rescan(indexed([{ path: at('beach.jpg'), modifiedAt: 5000.25 }, city]),
    [file('beach-2026.jpg', 100, 5000.25), city]);
  ok('a file whose size was never measured is not matched on time alone', res.moved.length === 0);
}

// --- when the question may be asked at all ---------------------------------------

{
  const res = rescan(indexed([beach, city]), [file('beach-2026.jpg', 100, 5000.25)], 9000, 'partial');
  ok('a partial scan proves nothing is gone, so nothing is moved', res.moved.length === 0
    && res.removed === 0 && !!res.state.folders.F.files['beach.jpg']);
}

{
  // A folder whose first scan never finished: everything in it is still "baseline".
  const unfinished = F.reconcileFolder(F.emptyState(), {
    folderId: 'F', rootPath: ROOT, folderAddedAt: 1000, now: 1000, status: 'partial', entries: [beach],
  }).state;
  const res = rescan(unfinished, [file('beach-2026.jpg', 100, 5000.25)]);
  ok('the first complete scan of a folder pairs nothing', res.moved.length === 0);
}

{
  // A large folder is indexed in batches; the renamed file may arrive in an early one.
  const before = indexed([beach, city]);
  const batch = rescan(before, [file('beach-2026.jpg', 100, 5000.25)], 9000, 'partial');
  const done = rescan(batch.state, [file('beach-2026.jpg', 100, 5000.25), city], 9000, 'complete');
  ok('a file first seen by an earlier batch of the same scan is still a candidate',
    done.moved.length === 1 && done.moved[0].to === at('beach-2026.jpg')
    && done.state.folders.F.files['beach-2026.jpg'].firstSeenAt === 1000);
}

{
  // The new name was already indexed by an EARLIER scan, and only now does the old one
  // turn out to be gone: that is two separate files, not a rename seen in one go.
  const both = rescan(indexed([beach, city]), [beach, file('beach-2026.jpg', 100, 5000.25), city], 5000);
  const res = rescan(both.state, [file('beach-2026.jpg', 100, 5000.25), city], 9000);
  ok('a file first seen by an earlier scan is not a candidate', res.moved.length === 0);
}

// --- sizes: stored, measured once, kept ------------------------------------------

{
  const state = indexed([beach, city]);
  const saved = F.normalizeState(JSON.parse(JSON.stringify(state)));
  ok('the size survives a save and load', saved.folders.F.files['beach.jpg'].size === 100);
}

{
  const legacy = indexed([{ path: at('beach.jpg'), modifiedAt: 5000.25 }, city]);
  ok('an unmeasured file is left for the next scan to measure',
    !F.knownPathKeys(legacy, 'F').has(pathKey(at('beach.jpg')))
    && F.knownPathKeys(legacy, 'F').has(pathKey(at('city.jpg'))));
  const measured = rescan(legacy, [file('beach.jpg', 100, 7777), city]);
  const entry = measured.state.folders.F.files['beach.jpg'];
  ok('that scan stores the size', entry.size === 100);
  ok('...without touching the modification time recorded when it was found', entry.modifiedAt === 5000.25);
  ok('...and without telling the window anything changed', measured.changed && !measured.contentChanged);
  const later = rescan(measured.state, [file('beach-2026.jpg', 100, 5000.25), city], 12000);
  ok('once measured, a later rename is recognised', later.moved.length === 1);
}

// --- the scan measures exactly what it has to ------------------------------------

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-moved-files-'));
  try {
    fs.writeFileSync(path.join(dir, 'measured.jpg'), Buffer.alloc(300, 1));
    fs.writeFileSync(path.join(dir, 'unmeasured.jpg'), Buffer.alloc(400, 1));
    const stats = [];
    const io = {
      ...fs.promises,
      stat: async (p) => { stats.push(path.basename(p)); return fs.promises.stat(p); },
    };
    const scan = await F.scanFolderTree(dir, {
      knownPaths: new Set([path.join(dir, 'measured.jpg')]),
      fsPromises: io,
    });
    const byName = (name) => scan.entries.find((e) => path.basename(e.path) === name);
    ok('the scan reads the size of a file it measures', byName('unmeasured.jpg').size === 400);
    ok('...and skips a file already measured', !stats.includes('measured.jpg') && !byName('measured.jpg').size);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nAll ${passed} folder-moved-files tests passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
