'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../src/folder-state');
const { pathKey } = require('../src/path-key');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  ✓ ' + name); passed++; };

const root = path.join('C:\\', 'Wallpapers');
const a = path.join(root, 'a.jpg');
const b = path.join(root, 'b.jpg');
const c = path.join(root, 'nested', 'c.png');

let result = F.reconcileFolder(F.emptyState(), {
  folderId: 'folder-1', rootPath: root, folderAddedAt: 1000, now: 9000, status: 'complete',
  entries: [{ path: a, modifiedAt: 100 }, { path: b, modifiedAt: 200 }],
});
ok('baseline inherits folder addedAt', result.added === 2
  && result.contentChanged && result.images.every((x) => x.firstSeenAt === 1000));
ok('baseline preserves initial modifiedAt', result.images.find((x) => x.path === b).modifiedAt === 200);

result = F.reconcileFolder(result.state, {
  folderId: 'folder-1', rootPath: root, folderAddedAt: 1000, now: 10000, status: 'complete',
  entries: [{ path: a, modifiedAt: 999 }, { path: b, modifiedAt: 200 }, { path: c, modifiedAt: 50 }],
});
ok('later file receives discovery time', result.added === 1
  && result.images.find((x) => x.path === c).firstSeenAt === 10000);
ok('known file keeps original metadata', result.images.find((x) => x.path === a).modifiedAt === 100);
ok('completed baseline is marked in state', result.state.folders['folder-1'].baselineComplete === true);

const beforePartial = result.state;
result = F.reconcileFolder(beforePartial, {
  folderId: 'folder-1', rootPath: root, now: 11000, status: 'partial', entries: [{ path: a }],
});
ok('partial scan never removes unseen files', result.removed === 0
  && Object.keys(result.state.folders['folder-1'].files).length === 3);

result = F.reconcileFolder(result.state, {
  folderId: 'folder-1', rootPath: root, now: 12000, status: 'complete', entries: [{ path: a }, { path: c }],
});
ok('complete scan removes missing files', result.removed === 1
  && Object.keys(result.state.folders['folder-1'].files).length === 2);

result = F.reconcileFolder(result.state, {
  folderId: 'folder-1', rootPath: root, now: 13000, status: 'complete', entries: [{ path: a }, { path: b }, { path: c }],
});
ok('reappearing file is new again', result.images.find((x) => x.path === b).firstSeenAt === 13000);

const unavailable = F.reconcileFolder(result.state, {
  folderId: 'folder-1', rootPath: root, now: 14000, status: 'unavailable', entries: [],
});
ok('unavailable folder preserves state', unavailable.changed === false
  && Object.keys(unavailable.state.folders['folder-1'].files).length === 3);

const outside = F.reconcileFolder(result.state, {
  folderId: 'folder-1', rootPath: root, now: 15000, status: 'partial',
  entries: [{ path: path.join('C:\\', 'Elsewhere', 'escape.jpg') }],
});
ok('paths outside the folder are ignored', outside.images.length === 0 && outside.added === 0);

const removedFolder = F.removeFolder(result.state, 'folder-1');
ok('explicit folder removal prunes state', removedFolder.removed && !removedFolder.state.folders['folder-1']);

const listed = F.listImages(result.state, ['folder-1']);
ok('listImages exposes persisted discovery metadata', listed.length === 3
  && listed.find((x) => x.path === b).addedAt === 13000
  && listed.every((x) => x.folderId === 'folder-1'));

let aspectState = F.reconcileFolder(result.state, {
  folderId: 'folder-overlap', rootPath: path.join(root, 'nested'), folderAddedAt: 1000,
  now: 16000, status: 'complete', entries: [{ path: c, modifiedAt: 50 }],
}).state;
const aspectUpdate = F.setAspects(aspectState, [{ path: c, aspect: 0.75 }]);
aspectState = aspectUpdate.state;
const aspectMatches = F.listImages(aspectState).filter((x) => x.path.toLowerCase() === c.toLowerCase());
ok('setAspects persists one learned aspect in every overlapping live-folder record',
  aspectUpdate.changed && aspectUpdate.updated === 2 && aspectMatches.length === 2
  && aspectMatches.every((x) => x.aspect === 0.75));
const aspectRepeat = F.setAspects(aspectState, [
  { path: c, aspect: 0.75 },
  { path: a, aspect: 0 },
  { path: path.join(root, 'missing.jpg'), aspect: 1.5 },
]);
ok('setAspects is idempotent and ignores invalid or unknown paths',
  !aspectRepeat.changed && aspectRepeat.updated === 0);

const sanitized = F.normalizeState({ version: 1, folders: { bad: { rootPath: root, files: {
  '../escape.jpg': { firstSeenAt: 1 },
  'C:/absolute.jpg': { firstSeenAt: 2 },
  'safe.jpg': { firstSeenAt: 3 },
} } } });
ok('stored traversal and absolute paths are rejected', Object.keys(sanitized.folders.bad.files).length === 1
  && sanitized.folders.bad.files['safe.jpg'].firstSeenAt === 3
  && sanitized.folders.bad.baselineComplete === false);
ok('version 1 state migrates without losing discovery history', sanitized.version === F.VERSION);
const version2Aspect = F.normalizeState({ version: 2, folders: { old: { rootPath: root, files: {
  'a.jpg': { relativePath: 'a.jpg', firstSeenAt: 1, modifiedAt: 2, aspect: 1.25 },
  'b.jpg': { relativePath: 'b.jpg', firstSeenAt: 1, modifiedAt: 2, aspect: -4 },
} } } });
ok('version 2 state migrates valid aspects and drops invalid values',
  version2Aspect.version === F.VERSION
  && version2Aspect.folders.old.files['a.jpg'].aspect === 1.25
  && !Object.prototype.hasOwnProperty.call(version2Aspect.folders.old.files['b.jpg'], 'aspect'));
ok('knownPathKeys returns canonical absolute paths', F.knownPathKeys(result.state, 'folder-1').has(pathKey(a)));

let progressive = F.reconcileFolder(F.emptyState(), {
  folderId: 'progress', rootPath: root, folderAddedAt: 500, now: 9000, status: 'partial',
  entries: [{ path: a, modifiedAt: 1 }],
});
ok('partial baseline remains unfinished', progressive.state.folders.progress.baselineComplete === false
  && progressive.images[0].firstSeenAt === 500);
progressive = F.reconcileFolder(progressive.state, {
  folderId: 'progress', rootPath: root, folderAddedAt: 500, now: 10000, status: 'partial',
  entries: [{ path: b, modifiedAt: 2 }],
});
ok('later baseline batch still inherits folder addedAt', progressive.images[0].firstSeenAt === 500);
progressive = F.reconcileFolder(progressive.state, {
  folderId: 'progress', rootPath: root, folderAddedAt: 500, now: 11000, status: 'complete',
  entries: [{ path: a }, { path: b }],
});
ok('complete progressive scan closes baseline', progressive.state.folders.progress.baselineComplete === true);
const emptyBaseline = F.reconcileFolder(F.emptyState(), {
  folderId: 'empty', rootPath: root, folderAddedAt: 500, now: 12000, status: 'complete', entries: [],
});
ok('baseline completion without files is metadata-only', emptyBaseline.changed && !emptyBaseline.contentChanged);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-folder-state-'));
const statePath = path.join(temp, 'folder-state.json');
try {
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, folders: {
    legacy: { rootPath: root, files: { 'a.jpg': { relativePath: 'a.jpg', firstSeenAt: 7, modifiedAt: 8 } } },
  } }), 'utf8');
  const migrated = F.loadState(statePath);
  ok('version 1 file loads as resumable current-version state', !migrated.recovered
    && migrated.state.version === F.VERSION
    && migrated.state.folders.legacy.files['a.jpg'].firstSeenAt === 7
    && migrated.state.folders.legacy.baselineComplete === false);

  const saved = F.saveState(statePath, aspectState);
  const loaded = F.loadState(statePath);
  ok('state round-trips through disk', !loaded.recovered
    && JSON.stringify(loaded.state) === JSON.stringify(saved)
    && F.listImages(loaded.state).filter((x) => x.path.toLowerCase() === c.toLowerCase())
      .every((x) => x.aspect === 0.75));

  fs.writeFileSync(statePath, '{broken json', 'utf8');
  const recovered = F.loadState(statePath, { now: 4242 });
  ok('corrupt state is backed up and rebuilt safely', recovered.recovered
    && recovered.brokenPath.endsWith('.broken-4242')
    && fs.existsSync(recovered.brokenPath)
    && Object.keys(recovered.state.folders).length === 0);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

async function testScanner() {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-folder-scan-'));
  try {
    fs.writeFileSync(path.join(tree, 'top.jpg'), 'x');
    fs.writeFileSync(path.join(tree, 'ignore.txt'), 'x');
    const nested = path.join(tree, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'deep.png'), 'x');

    const complete = await F.scanFolderTree(tree);
    ok('recursive scanner returns supported images', complete.status === 'complete'
      && complete.entries.length === 2
      && complete.entries.every((x) => Number.isFinite(x.modifiedAt)));

    const formatTree = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-folder-formats-'));
    try {
      const accepted = ['a.JPG', 'b.JpEg', 'c.PNG', 'd.BmP', 'e.WeBp', 'f.GIF'];
      accepted.forEach((name) => fs.writeFileSync(path.join(formatTree, name), 'x'));
      fs.writeFileSync(path.join(formatTree, 'moving.WEBM'), 'x');
      const formats = await F.scanFolderTree(formatTree);
      ok('folder-state scans the same six formats case-insensitively and no moving picture',
        formats.status === 'complete'
        && formats.entries.map((entry) => path.basename(entry.path)).sort().join() === accepted.sort().join());
    } finally {
      fs.rmSync(formatTree, { recursive: true, force: true });
    }

    const shallow = await F.scanFolderTree(tree, { maxDepth: 0 });
    ok('depth limit produces a conservative partial result', shallow.status === 'partial'
      && shallow.entries.length === 1
      && shallow.entries[0].path.endsWith('top.jpg'));

    const capped = await F.scanFolderTree(tree, { cap: 1 });
    ok('file cap produces a conservative partial result', capped.status === 'partial'
      && capped.entries.length === 1);

    const batches = [];
    let yields = 0;
    const batched = await F.scanFolderTree(tree, {
      batchSize: 1,
      onBatch: async (entries, progress) => batches.push({ entries, progress }),
      yieldFn: async () => { yields++; },
    });
    ok('default scanner has no total cap', batched.status === 'complete' && batched.entries.length === 2);
    ok('scanner reports full batches and yields between them', batches.length === 2
      && batches[0].entries.length === 1 && batches[1].progress.processed === 2 && yields === 2);

    const virtualCount = 10005;
    const virtualRoot = path.resolve('C:\\VirtualWallpapers');
    const virtualChildren = Array.from({ length: virtualCount }, (_, i) => ({
      name: `image-${String(i).padStart(5, '0')}.jpg`,
      isDirectory: () => false,
      isFile: () => true,
    }));
    const virtualBatches = [];
    const virtual = await F.scanFolderTree(virtualRoot, {
      fsPromises: {
        stat: async (p) => p === virtualRoot ? { isDirectory: () => true } : { mtimeMs: 1 },
        realpath: async (p) => p,
        readdir: async () => virtualChildren,
      },
      onBatch: async (entries) => virtualBatches.push(entries.length),
      yieldFn: async () => {},
    });
    ok('scanner indexes beyond the former 10k ceiling', virtual.status === 'complete'
      && virtual.entries.length === virtualCount && virtualBatches.join(',') === '10000');

    const unavailable = await F.scanFolderTree(path.join(tree, 'missing'));
    ok('missing root is unavailable, not an empty complete folder', unavailable.status === 'unavailable'
      && unavailable.entries.length === 0);

    const emptyRoot = await F.scanFolderTree('');
    ok('empty root never scans the process working directory', emptyRoot.status === 'unavailable'
      && emptyRoot.entries.length === 0);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}

testScanner()
  .then(() => console.log('\nAll ' + passed + ' folder-state tests passed.'))
  .catch((err) => { console.error(err); process.exitCode = 1; });
