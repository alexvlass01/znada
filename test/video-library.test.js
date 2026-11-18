'use strict';

// MEDIA-002. Video is a Library card and never a wallpaper.
//
// The claims, each against the code the app actually runs:
//   - the window's copy of the video list is the same list as main's;
//   - the card wears ▶ and the length, and is never marked as a moving picture;
//   - its menu has no assigning, no clipboard picture and no tag lookup;
//   - through the REAL main.js: a video is added to the Library from every Library route,
//     shown by a watched folder, refused by a monitor (with a reason), skipped by a bulk
//     assignment next to a photo that IS assigned, and opened only through the player
//     channel, which refuses anything that is not an authorized video.
// The slideshow side (resolveSlot drops video by id, legacy item or folder) is in
// test/playlist.test.js beside the other scanners.
//
// Run: node test/video-library.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');
const libraryAssignment = require('../src/library-assignment');
const mediaType = require('../src/media-type');
const mediaKind = require('../renderer/media-kind');
const MotionBadge = require('../renderer/motion-badge');
const CardActions = require('../renderer/card-actions');
const { makeTempDir } = require('./helpers/temp-dir');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

const MONITOR = 'MONITOR-1';
const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);

// The smallest DOM the chip needs: a host with children, a dataset and classList.
function fakeHost() {
  const host = {
    children: [],
    dataset: {},
    ownerDocument: {
      createElement: () => {
        const el = {
          className: '', textContent: '', title: '', attrs: {},
          get classList() { return { contains: (c) => el.className.split(' ').includes(c) }; },
          setAttribute(k, v) { el.attrs[k] = v; },
          remove() { host.children = host.children.filter((c) => c !== el); },
        };
        return el;
      },
    },
    appendChild(el) { host.children.push(el); },
  };
  return host;
}

(async () => {
  await check('the window mirrors main\'s video list exactly, and both answer alike', async () => {
    assert.deepStrictEqual([...mediaKind.VIDEO_FORMATS].sort(), [...mediaType.VIDEO_FORMATS].sort());
    for (const p of ['C:\\v\\a.MP4', 'C:\\v\\b.webm', 'C:\\trip.mp4\\c.jpg', 'C:\\v\\noext', 'D:\\x.gif']) {
      assert.strictEqual(mediaKind.isVideoPath(p), mediaType.isVideoPath(p), p);
    }
    assert.strictEqual(mediaType.isWallpaperPath('C:\\v\\a.mp4'), false);
    assert.ok(!mediaType.WALLPAPER_FORMATS.some((f) => mediaType.isVideoFormat(f)),
      'no format is both a wallpaper and a video');
  });

  await check('the chip reads ▶ and the length, and a reused card swaps GIF for ▶ and back', async () => {
    assert.strictEqual(MotionBadge.formatDuration(43900), '0:44');
    assert.strictEqual(MotionBadge.formatDuration(73967), '1:14');
    assert.strictEqual(MotionBadge.formatDuration(3725000), '1:02:05');
    assert.strictEqual(MotionBadge.formatDuration(0), '');
    const host = fakeHost();
    MotionBadge.sync(host, MotionBadge.fromLocal({ animated: true, format: 'gif', frames: 3 }), t);
    assert.strictEqual(host.dataset.motion, 'GIF');
    MotionBadge.sync(host, MotionBadge.fromVideo({ durationMs: 73967 }), t);
    assert.strictEqual(host.children.length, 1);
    assert.strictEqual(host.children[0].textContent, '▶ 1:14');
    assert.ok(host.children[0].className.includes('video'));
    assert.strictEqual(host.dataset.video, '1');
    assert.strictEqual(host.dataset.motion, undefined,
      'a video must not carry the moving-picture mark: it drives hover play and the first-frame note');
    MotionBadge.sync(host, MotionBadge.fromVideo({ durationMs: 0 }), t);
    assert.strictEqual(host.children[0].textContent, '▶');
    MotionBadge.sync(host, MotionBadge.fromLocal({ animated: true, format: 'webp', frames: 2 }), t);
    assert.strictEqual(host.children[0].textContent, 'GIF');
    assert.strictEqual(host.dataset.video, undefined);
    MotionBadge.sync(host, null, t);
    assert.strictEqual(host.children.length, 0);
  });

  await check('a video card offers no assigning, no clipboard picture and no tag lookup', async () => {
    const ids = (p) => CardActions.actionsFor(CardActions.localSubject({ type: 'image', path: p }))
      .map((a) => a.id);
    const photo = ids('C:\\v\\still.jpg');
    const video = ids('C:\\v\\clip.mp4');
    for (const id of ['assign', 'copyFile', 'lookupMeta']) {
      assert.ok(photo.includes(id), `a photo still has ${id}`);
      assert.ok(!video.includes(id), `a video has no ${id}`);
    }
    for (const id of ['favorite', 'tags', 'details', 'remove']) assert.ok(video.includes(id), `a video keeps ${id}`);
  });

  await check('assignment refuses a video before any record exists, and a batch skips it beside a photo', async () => {
    const cfg = { library: {}, monitors: {} };
    const single = libraryAssignment.assignRecord(cfg, { type: 'image', path: 'C:\\v\\clip.mp4' }, MONITOR, 'light',
      { allowCreate: true });
    assert.strictEqual(single.ok, false);
    assert.strictEqual(single.error, 'video');
    assert.deepStrictEqual(cfg.library, {}, 'a refusal leaves no record behind');
    const batch = libraryAssignment.assignRecords(cfg, [
      { record: { type: 'image', path: 'C:\\v\\clip.mp4' }, options: { allowCreate: true } },
      { record: { type: 'image', path: 'C:\\v\\still.jpg' }, options: { allowCreate: true } },
    ], MONITOR, 'light');
    assert.strictEqual(batch.assigned, 1);
    assert.strictEqual(batch.videos, 1);
    assert.strictEqual(batch.failed, 0);
    const slot = cfg.monitors[MONITOR].light.itemIds.map((id) => cfg.library[id].path);
    assert.deepStrictEqual(slot, ['C:\\v\\still.jpg']);
    const onlyVideo = libraryAssignment.assignRecords({ library: {}, monitors: {} }, [
      { record: { type: 'image', path: 'C:\\v\\clip.mp4' }, options: { allowCreate: true } },
    ], MONITOR, 'light');
    assert.strictEqual(onlyVideo.error, 'video');
  });

  // ---- the real main.js ----
  const dir = H.makeTempProfile('video-library');
  const outside = makeTempDir('znada-video-src-');
  const quiet = { error: console.error, warn: console.warn };
  console.error = () => {}; console.warn = () => {};
  const pick = { files: [] };
  try {
    const folder = path.join(outside, 'Clips');
    fs.mkdirSync(folder, { recursive: true });
    const inFolder = path.join(folder, 'in-folder.mkv');
    const folderPhoto = path.join(folder, 'still.png');
    fs.writeFileSync(inFolder, Buffer.alloc(32, 7));
    fs.writeFileSync(folderPhoto, Buffer.from('89504e470d0a1a0a', 'hex'));
    const dropped = path.join(outside, 'dropped.mp4');
    const picked = path.join(outside, 'picked.mov');
    const photo = path.join(outside, 'photo.png');
    fs.writeFileSync(dropped, Buffer.alloc(64, 1));
    fs.writeFileSync(picked, Buffer.alloc(64, 2));
    fs.writeFileSync(photo, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16, 3)]));
    const folderId = library.idFor(folder);
    H.writeJson(path.join(dir, 'config.json'), { autoSwitch: false, style: 'fill', monitors: {} });
    H.writeJson(path.join(dir, 'config.library.json'), {
      version: 1,
      library: { [folderId]: { id: folderId, type: 'folder', path: folder, addedAt: 1, favorite: false, tags: [] } },
      trash: [],
    });
    const m = H.loadMain(dir, { onOpenDialog: () => pick.files });
    m.__test.loadConfig();
    const cfg = () => m.__test.getConfig();
    const pooledPaths = () => Object.values(cfg().library).filter((it) => it.type === 'image').map((it) => it.path);
    const slot = () => (((cfg().monitors[MONITOR] || {}).light || {}).itemIds || [])
      .map((id) => cfg().library[id] && cfg().library[id].path);

    await check('a watched folder shows its video in "All" and counts it on the folder card', async () => {
      await m.invoke('library-refresh');
      const { images } = await m.invoke('expand-folders');
      assert.ok(images.some((it) => it.path === inFolder), 'the video is a card');
      const info = await m.invoke('folder-info', folder);
      assert.strictEqual(info.count, 2, 'photos and video, all together');
      assert.strictEqual(info.videos, 1);
    });

    await check('Save as reaches the dialog for a watched video only the library authorizes', async () => {
      const card = { kind: 'local', path: inFolder };
      assert.deepStrictEqual(await m.invoke('card-save-as', card), { ok: false, error: null, canceled: true });
      assert.strictEqual((await m.invoke('card-save-as', { ...card, path: dropped })).error, 'missing');
      assert.strictEqual((await m.invoke('card-copy-file', card)).error, 'missing');
    });

    await check('the Library takes a video by drop and by "Add photos…", copying it like a photo', async () => {
      await m.invoke('library-add-paths', [dropped]);
      pick.files = [picked];
      await m.invoke('library-add-images');
      const own = m.__test.managedRoot().root;
      const copies = fs.readdirSync(own).filter((n) => !n.startsWith('.'));
      assert.ok(copies.some((n) => n.startsWith('dropped-') && n.endsWith('.mp4')), copies.join());
      assert.ok(copies.some((n) => n.startsWith('picked-') && n.endsWith('.mov')), copies.join());
      const copy = path.join(own, copies.find((n) => n.startsWith('dropped-')));
      assert.deepStrictEqual(fs.readFileSync(copy), fs.readFileSync(dropped), 'the copy is the whole file');
      assert.ok(pooledPaths().includes(copy));
    });

    await check('a monitor refuses a dropped video and says how many it left out', async () => {
      const res = await m.invoke('add-slot-paths', MONITOR, 'light', [dropped]);
      assert.strictEqual(res.added, 0);
      assert.strictEqual(res.videos, 1);
      assert.deepStrictEqual(slot(), []);
    });

    await check('a bulk assignment puts the photo on the monitor and skips the video', async () => {
      const res = await m.invoke('library-assign-records', [
        { type: 'image', path: inFolder }, { type: 'image', path: folderPhoto },
      ], MONITOR, 'light');
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.assigned, 1);
      assert.strictEqual(res.videos, 1);
      assert.deepStrictEqual(slot(), [folderPhoto]);
      const single = await m.invoke('library-assign-record', { type: 'image', path: inFolder }, MONITOR, 'light');
      assert.strictEqual(single.ok, false);
      assert.strictEqual(single.error, 'video');
      assert.ok(!pooledPaths().includes(inFolder), 'refusing made no record for the folder video');
    });

    await check('a video card learns it is one from the thumbnail answer, length or not', async () => {
      const info = await m.invoke('thumb-info', inFolder, 320, 200, 0);
      assert.ok(info.video && typeof info.video.durationMs === 'number');
      const still = await m.invoke('thumb-info', folderPhoto, 320, 200, 0);
      assert.strictEqual(still.video, undefined);
    });

    await check('the player channel opens an authorized video and nothing else', async () => {
      const before = m.calls.openedPaths.length;
      assert.deepStrictEqual(await m.invoke('open-video', inFolder), { ok: true });
      assert.strictEqual((await m.invoke('open-video', folderPhoto)).ok, false, 'not a video');
      const stranger = path.join(makeTempDir('znada-video-stranger-'), 'secret.mp4');
      fs.writeFileSync(stranger, 'x');
      assert.strictEqual((await m.invoke('open-video', stranger)).ok, false, 'not vouched for by the Library');
      assert.deepStrictEqual(m.calls.openedPaths.slice(before), [inFolder]);
    });
  } finally {
    console.error = quiet.error; console.warn = quiet.warn;
    try { H.unloadMain(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
  }

  console.log(`PASS video-library: ${passed} checks`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
