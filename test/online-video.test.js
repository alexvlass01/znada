'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter, once } = require('node:events');
const { pathToFileURL } = require('node:url');
const H = require('./helpers/main-harness');
const { makeTempDir } = require('./helpers/temp-dir');
const { createManagedFolder } = require('../src/managed-folder');
const { fetchVideo, openVideoStream } = require('../src/online-video');
const online = require('../src/online');
const media = require('../src/media-type');
const gelbooru = require('../src/gelbooru');
const danbooru = require('../src/danbooru');
const bookmarkRuntime = require('../src/bookmark-runtime');

// A pending await whose promise can never settle empties the event loop, and Node then
// exits 0 without running the rest of this file: the runner only sees the exit status.
// Success is reaching the end, not merely exiting.
let finished = false;
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.error('online-video tests did not finish: a pending await emptied the event loop');
  process.exitCode = 1;
});

// Waits for cleanup work without letting a promise that never settles end the process
// silently: the timer keeps the event loop alive, so the error being unwound still surfaces.
async function settleWithin(promise, ms) {
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  try { await Promise.race([promise.catch(() => {}), expired]); } finally { clearTimeout(timer); }
}

const item = { provider: 'gelbooru', id: 'gelbooru:1', format: 'mp4', full: 'https://img3.gelbooru.com/images/test.mp4',
  page: 'https://gelbooru.com/index.php?page=post&s=view&id=1', artist: 'artist', purity: 'sfw', tags: ['night'] };

async function checkMainAdd() {
  const profile = H.makeTempProfile('online-video-add');
  const originalFetch = globalThis.fetch;
  try {
    const app = H.loadMain(profile);
    app.__test.loadConfig();
    const authority = app.__test.ipcAuthority;
    function windowEvent(id, role, page) {
      const mainFrame = { url: pathToFileURL(path.join(H.ROOT, 'renderer', page)).href };
      const sender = Object.assign(new EventEmitter(), { id, mainFrame, isDestroyed: () => false });
      sender.send = (channel, details) => sender.emit(channel, details);
      authority.register(sender, role, mainFrame.url);
      return { sender, senderFrame: mainFrame };
    }
    const owner = windowEvent(41, 'main', 'index.html');
    const peer = windowEvent(42, 'viewer', 'viewer.html');
    let makeVideo;
    globalThis.fetch = async (url, options) => {
      if (url !== item.full) return new Response('{}');
      assert.equal(options.headers.Referer, 'https://gelbooru.com/');
      return new Response(makeVideo(options), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '6' } });
    };
    makeVideo = ({ signal }) => new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      controller.enqueue(Buffer.from('abc'));
    } });
    // AbortSignal.timeout() does not keep the process alive: a progress event that never
    // comes would end the file with exit 0 instead of failing here. A plain timer does.
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(new Error('no download progress within 2 s')), 2000);
    const progress = once(owner.sender, 'internet-video-progress', { signal: deadline.signal });
    const adding = app.invokeRaw(owner, 'internet-add', item, '', 'one');
    try {
      assert.deepEqual((await progress)[0], { requestId: 'one', received: 3, total: 6 });
    } finally {
      clearTimeout(deadlineTimer);
    }
    assert.equal(app.invokeRaw(peer, 'internet-cancel-video', 'one'), false);
    assert.equal(app.invokeRaw(owner, 'internet-cancel-video', 'one'), true);
    assert.deepEqual(await adding, { error: 'cancelled' });
    const copies = path.join(profile, 'wallpapers');
    assert.deepEqual(await fs.readdir(copies), []);
    assert.deepEqual(app.invoke('get-config').library, {});

    // A video save needs a request id: without one nothing could cancel or track the transfer.
    // The request id became optional at the IPC boundary for photos (BUG-083), so the
    // video-only guard after resolution is the sole thing keeping this a clean refusal.
    makeVideo = () => { throw new Error('a video without a request id must not be downloaded'); };
    for (const missing of [undefined, null]) {
      const refused = await app.invokeRaw(owner, 'internet-add', item, '', missing);
      assert.equal(refused.error, 'badItem', `video add without a request id (${missing}) is refused`);
    }
    assert.deepEqual(await fs.readdir(copies), []);
    assert.deepEqual(app.invoke('get-config').library, {});

    makeVideo = () => 'abcdef';
    const result = await app.invokeRaw(owner, 'internet-add', item, '', 'two');
    assert.equal(result.error, null);
    const record = result.config.library[result.id];
    assert.equal(record.author, 'artist');
    assert.equal(record.rating, 'general');
    assert.equal(record.source, item.page);
    assert.ok(record.tags.includes('night'));
    assert.equal(await fs.readFile(record.path, 'utf8'), 'abcdef');
    assert.equal(app.invokeRaw(owner, 'internet-cancel-video', 'two'), false);
  } finally {
    globalThis.fetch = originalFetch;
    H.unloadMain();
    await fs.rm(profile, { recursive: true, force: true });
  }
}

async function checkBookmarkCancelDuringResolve() {
  const profile = H.makeTempProfile('online-video-bookmark-cancel');
  const originalFetch = globalThis.fetch;
  const originalCreate = bookmarkRuntime.create;
  let enteredResolve;
  let releaseResolve;
  const resolving = new Promise((resolve) => { enteredResolve = resolve; });
  const gate = new Promise((resolve) => { releaseResolve = resolve; });
  const resolvedItem = { ...item, bookmarkKey: 'gelbooru:1', cardKind: 'internet' };
  let fetchCalls = 0;
  let resolverCalls = 0;
  let holdResolve = true;
  bookmarkRuntime.create = (...args) => {
    const service = originalCreate(...args);
    service.resolveForUse = async () => {
      resolverCalls++;
      if (resolverCalls === 4) enteredResolve();
      if (holdResolve) await gate;
      return { item: resolvedItem, error: null };
    };
    return service;
  };
  let app, adding;
  try {
    app = H.loadMain(profile);
    bookmarkRuntime.create = originalCreate;
    app.__test.loadConfig();
    const authority = app.__test.ipcAuthority;
    function windowEvent(id, role, page) {
      const mainFrame = { url: pathToFileURL(path.join(H.ROOT, 'renderer', page)).href };
      const sender = Object.assign(new EventEmitter(), { id, mainFrame, isDestroyed: () => false });
      sender.send = () => {};
      authority.register(sender, role, mainFrame.url);
      return { sender, senderFrame: mainFrame };
    }
    const owner = windowEvent(51, 'main', 'index.html');
    const peer = windowEvent(52, 'viewer', 'viewer.html');
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('abcdef', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '6' } });
    };
    const requestIds = ['bookmark-cancel-1', 'bookmark-cancel-2', 'bookmark-cancel-3', 'bookmark-cancel-4'];
    const additions = requestIds.map((id) => app.invokeRaw(owner, 'internet-add', resolvedItem, '', id));
    await resolving;
    const overflow = app.invokeRaw(owner, 'internet-add', resolvedItem, '', 'bookmark-cancel-overflow');
    const duplicate = app.invokeRaw(owner, 'internet-add', resolvedItem, '', requestIds[0]);
    adding = Promise.all([...additions, overflow, duplicate]);
    assert.equal(resolverCalls, 4, 'the four-operation cap and duplicate guard apply during resolution');
    assert.equal(app.invokeRaw(peer, 'internet-cancel-video', requestIds[0]), false,
      'another authorized window cannot cancel a pending bookmark save');
    assert.equal(app.invokeRaw(owner, 'internet-cancel-video', requestIds[0]), true,
      'the owning window can cancel while bookmark metadata is resolving');
    for (const id of requestIds.slice(1)) {
      assert.equal(app.invokeRaw(owner, 'internet-cancel-video', id), true,
        'each pending operation remains cancellable until its lookup completes');
    }
    releaseResolve();
    const results = await adding;
    assert.deepEqual(results.slice(0, 4), requestIds.map(() => ({ error: 'cancelled' })));
    assert.equal(results[4].error, 'download', 'the per-window concurrency cap rejects a fifth pending save');
    assert.equal(results[5].error, 'download', 'a pending request id cannot be reused by a second save');
    assert.equal(fetchCalls, 0, 'a cancelled bookmark must not start the file download');
    assert.deepEqual(await fs.readdir(path.join(profile, 'wallpapers')), [],
      'cancellation before transfer leaves no staged or committed copy');
    assert.deepEqual(app.__test.getConfig().library, {}, 'cancellation before transfer creates no library record');
    assert.equal(app.invokeRaw(owner, 'internet-cancel-video', requestIds[0]), false,
      'completed operations are removed from the owner request map');
    holdResolve = false;
    const retry = await app.invokeRaw(owner, 'internet-add', resolvedItem, '', requestIds[0]);
    assert.equal(retry.error, null, 'the request id is reusable after the cancelled operation is cleaned up');
    assert.equal(await fs.readFile(retry.config.library[retry.id].path, 'utf8'), 'abcdef');
  } finally {
    releaseResolve?.();
    if (adding) await settleWithin(adding, 5000);
    bookmarkRuntime.create = originalCreate;
    globalThis.fetch = originalFetch;
    H.unloadMain();
    await fs.rm(profile, { recursive: true, force: true });
  }
}

(async () => {
  assert(online.allowedVideo(item));
  assert(!online.allowedVideo({ ...item, full: 'https://gelbooru.com/hotlink.php?file=test.mp4' }));
  assert(!online.allowedVideo({ ...item, full: 'https://img3.gelbooru.com/test.jpg?file=test.mp4' }));
  assert(!online.allowedVideo({ ...item, full: 'https://127.0.0.1/test.mp4' }));
  assert(!media.isWallpaperPath('test.mp4'));
  assert.equal(media.wallpaperMime('video/mp4'), '');
  const gelCard = gelbooru.mapItem({ id: 1, image: 'test.webm', file_url: item.full });
  assert.equal(gelCard.format, 'mp4');
  assert.equal(gelCard.fileType, 'video/mp4');
  assert.equal(gelCard.durationMs, undefined);
  assert.equal(gelCard.thumb, '');
  assert.match(gelbooru.buildSearchTags({ formats: ['jpg'] }), /(?:^| )-video(?: |$)/);
  assert.match(gelbooru.buildSearchTags({ formats: ['mp4'] }), /(?:^| )video(?: |$)/);
  assert.doesNotMatch(gelbooru.buildSearchTags({ formats: ['jpg', 'mp4'] }), /video/);
  const danCard = danbooru.mapItem({ id: 2, file_url: 'https://cdn.donmai.us/original/test.webm', media_asset: { duration: 2.25 } });
  assert.equal(danCard.durationMs, 2250);
  assert.equal(danCard.thumb, '');
  assert.match(danbooru.buildSearchTags({ formats: ['mp4', 'webm'] }), /filetype:mp4,webm/);

  let calls = 0;
  const controller = new AbortController();
  const stream = await openVideoStream(item, { Referer: 'https://gelbooru.com/' }, {
    signal: controller.signal,
    fetchImpl: async (url, init) => {
      assert.equal(url, item.full);
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Referer, 'https://gelbooru.com/');
      assert.equal(init.headers.Range, 'bytes=2-4');
      calls++;
      return new Response('cde', { status: 206, headers: {
        'Content-Type': 'video/mp4', 'Content-Length': '3',
        'Content-Range': calls === 1 ? 'bytes 2-4/8' : 'bytes 3-5/8',
      } });
    },
  });
  try {
    const wrongRoute = await fetch(stream.url + 'x');
    assert.equal(wrongRoute.status, 404);
    assert.equal((await fetch(stream.url, { headers: { Range: 'bytes=1-2,3-4' } })).status, 416);
    assert.equal(calls, 0);
    const part = await fetch(stream.url, { headers: { Range: 'bytes=2-4' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-4/8');
    assert.equal(await part.text(), 'cde');
    assert.equal((await fetch(stream.url, { headers: { Range: 'bytes=2-4' } })).status, 502);
  } finally { controller.abort(); }

  await assert.rejects(fetchVideo(item, {}, {
    fetchImpl: async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
  }), /Invalid video response/);

  const dir = makeTempDir('znada-online-video-');
  const folder = createManagedFolder({ userDataPath: dir, getConfig: () => ({}) });
  try {
    const operation = new AbortController();
    const data = Readable.from(['abc', 'def'].map(s => Buffer.from(s)));
    const progress = [];
    const artifact = await folder.stageDownloadVideo(dir, 'mp4', { body: data, contentLength: '6' }, {
      signal: operation.signal, onProgress: (received, total) => progress.push([received, total]),
    });
    assert.deepEqual(progress, [[3, 6], [6, 6]]);
    await assert.rejects(fs.stat(artifact.path), { code: 'ENOENT' });
    folder.commitDownloadArtifact(artifact, dir);
    assert.equal(await fs.readFile(artifact.path, 'utf8'), 'abcdef');
    const aborted = new AbortController();
    const body = new Readable({ read() { this.push(Buffer.from('partial')); } });
    const result = folder.stageDownloadVideo(dir, 'webm', { body, contentLength: '100' }, {
      signal: aborted.signal, onProgress: () => aborted.abort(),
    });
    await assert.rejects(result, { name: 'AbortError' });
    // A cancelled second copy cannot remove the previous file.
    assert.deepEqual(await fs.readdir(dir), [path.basename(artifact.path)]);
    const incomplete = Readable.from([Buffer.from('abc')]);
    await assert.rejects(folder.stageDownloadVideo(dir, 'mp4', { body: incomplete, contentLength: '6' }, {
      signal: operation.signal, onProgress() {},
    }), /Incomplete/);
    assert.deepEqual(await fs.readdir(dir), [path.basename(artifact.path)]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  await checkMainAdd();
  await checkBookmarkCancelDuringResolve();
  console.log('PASS Online video media, authorization, ranged playback and cancellable staging');
  finished = true;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
