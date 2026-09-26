'use strict';

// PERF-010. "Add to Library" must not download again what the viewer already has, and
// one picture added from two windows at once must be downloaded once.
//
// Everything runs through the REAL main.js: the viewer's request goes through the real
// media-proxy handler, the add through the real `internet-add` / `cloud-add`, and the
// network is a fake that counts who asked for what. The claims are about requests made
// and files written, not about which helper got called.
//
// Run: node test/add-original-main.test.js

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');

let passed = 0;
const failures = [];
const realFetch = globalThis.fetch;
let running = '';
let finished = false;

// A scenario that waits on a stream nobody will ever close leaves Node with nothing to
// do, and Node then exits with code 0 in the middle of the run, taking the failures
// already recorded with it. That is how a broken build once looked green here.
process.on('exit', () => {
  if (finished) return;
  console.log('\nStopped before the end, inside: ' + (running || '(setup)'));
  process.exitCode = 1;
});

async function test(name, fn) {
  running = name;
  const dir = H.makeTempProfile('add-original');
  const quiet = console.error;
  console.error = () => {};
  try {
    H.writeJson(path.join(dir, 'config.json'), { autoSwitch: true, style: 'fill', monitors: {} });
    H.writeJson(path.join(dir, 'config.library.json'), { version: 1, library: {}, trash: [] });
    const m = H.loadMain(dir);
    m.__test.loadConfig();
    m.__test.registerMediaProxy();
    await fn(m, dir);
    console.error = quiet;
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error = quiet;
    failures.push({ name, err });
    console.log('  ✗ ' + name + '\n    ' + (err && err.message));
  } finally {
    console.error = quiet;
    globalThis.fetch = realFetch;
    try { H.unloadMain(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(2048, 7)]);
const md5name = (bytes, ext) => `wp-${crypto.createHash('md5').update(bytes).digest('hex').slice(0, 16)}.${ext}`;
const tick = () => new Promise((resolve) => { setImmediate(resolve); });
// Wait until `done()` or `ms` passed, whichever is first.
async function settle(done, ms) {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((resolve) => { setTimeout(resolve, 10); });
}

const DAN_FULL = 'https://cdn.donmai.us/original/aa/bb/aabbcc.jpg';
const DAN_SAMPLE = 'https://cdn.donmai.us/sample/aa/bb/sample-aabbcc.jpg';
const danbooru = (full = DAN_FULL) => ({
  provider: 'danbooru', id: '7', format: 'jpg', full, sample: DAN_SAMPLE,
  page: 'https://danbooru.donmai.us/posts/7', width: 1920, height: 1080, tags: ['sky'],
});
const WH_FULL = 'https://w.wallhaven.cc/full/ab/wallhaven-abc123.jpg';
const wallhaven = () => ({
  provider: 'wallhaven', id: 'abc123', format: 'jpg', full: WH_FULL,
  page: 'https://wallhaven.cc/w/abc123', width: 1920, height: 1080,
});

const proxyUrl = (provider, tier, url) =>
  `znada-media://media/?t=${tier}&p=${provider}&u=${encodeURIComponent(url)}`;

// A network that counts requests per address. `routes` answers each address; anything
// else is a failure of the test, not a quiet 404. The query is left out of the match: a
// checkout with a bundled Wallhaven key asks for tags with `?apikey=`, and the key must
// not end up in a test's output either.
function network(routes) {
  const seen = new Map();
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const key = parsed.origin + parsed.pathname;
    seen.set(key, (seen.get(key) || 0) + 1);
    const route = routes[key];
    if (!route) throw new Error('unexpected request: ' + key);
    return route(init);
  };
  return { count: (url) => seen.get(url) || 0 };
}
const image = (bytes, mime = 'image/jpeg') => () => new Response(bytes, { status: 200, headers: { 'content-type': mime } });

// The viewer's side: ask the proxy for a tier and read all of it, as the window does.
async function viewerLoads(m, provider, tier, url) {
  const handle = m.protocol.handlers.get('znada-media');
  const res = await handle({ url: proxyUrl(provider, tier, url) });
  assert.strictEqual(res.status, 200, 'the proxy must serve the ' + tier);
  return Buffer.from(await res.arrayBuffer());
}

function recordFor(m, source) {
  return Object.values(m.__test.getConfig().library || {}).find((it) => it.source === source);
}

console.log('\nPERF-010: adding what main already has\n');

(async () => {
  await test('an original the viewer got through the proxy is added without a second download', async (m, dir) => {
    const net = network({ [DAN_FULL]: image(JPEG) });
    const shown = await viewerLoads(m, 'danbooru', 'full', DAN_FULL);
    assert.ok(shown.equals(JPEG), 'the window still receives the whole picture');
    const result = await m.invoke('internet-add', danbooru(), '');
    assert.strictEqual(result.error, null);
    assert.strictEqual(net.count(DAN_FULL), 1, 'the original was downloaded a second time');
    const record = recordFor(m, 'https://danbooru.donmai.us/posts/7');
    assert.ok(record, 'no library record');
    assert.strictEqual(path.basename(record.path), md5name(JPEG, 'jpg'), 'the same content-addressed name');
    assert.ok(fs.readFileSync(record.path).equals(JPEG), 'the file holds the original bytes');
    assert.ok(record.path.startsWith(path.join(dir, 'wallpapers')));
  });

  await test('kept bytes go through the same format check', async (m) => {
    const net = network({ [DAN_FULL]: image(JPEG, 'image/png') });
    await viewerLoads(m, 'danbooru', 'full', DAN_FULL);
    const result = await m.invoke('internet-add', danbooru(), '');
    assert.strictEqual(result.error, 'download', 'a PNG answer for a JPEG card must be refused as before');
    assert.strictEqual(recordFor(m, 'https://danbooru.donmai.us/posts/7'), undefined);
    assert.strictEqual(net.count(DAN_FULL), 1);
  });

  await test('the downscaled sample is never kept as an original', async (m) => {
    const net = network({ [DAN_SAMPLE]: image(JPEG) });
    await viewerLoads(m, 'danbooru', 'sample', DAN_SAMPLE);
    assert.deepStrictEqual(m.__test.recentOriginals.stats(), { entries: 0, bytes: 0, pending: 0 });
    assert.strictEqual(net.count(DAN_SAMPLE), 1);
  });

  await test('a download the window abandoned is not kept, and the add fetches for itself', async (m) => {
    let upstreamCancelled = false;
    const net = network({
      [DAN_FULL]: () => {
        if (net && net.count(DAN_FULL) > 1) return image(JPEG)();
        let sent = 0;
        return new Response(new ReadableStream({
          pull(controller) { sent += 1; controller.enqueue(new Uint8Array(JPEG.subarray(0, 1024))); if (sent > 5) controller.close(); },
          cancel() { upstreamCancelled = true; },
        }), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      },
    });
    const handle = m.protocol.handlers.get('znada-media');
    const res = await handle({ url: proxyUrl('danbooru', 'full', DAN_FULL) });
    const reader = res.body.getReader();
    await reader.read();
    await reader.cancel('went to another picture');
    await tick();
    assert.ok(upstreamCancelled, 'leaving must still stop the download from the site');
    assert.deepStrictEqual(m.__test.recentOriginals.stats(), { entries: 0, bytes: 0, pending: 0 });
    const result = await m.invoke('internet-add', danbooru(), '');
    assert.strictEqual(result.error, null);
    assert.strictEqual(net.count(DAN_FULL), 2, 'with nothing kept, the add downloads it');
    assert.ok(fs.readFileSync(recordFor(m, 'https://danbooru.donmai.us/posts/7').path).equals(JPEG));
  });

  await test('an original over the size limit is cut off and not kept', async (m) => {
    const megabyte = new Uint8Array(1024 * 1024);
    let sent = 0;
    network({
      [DAN_FULL]: () => new Response(new ReadableStream({
        pull(controller) { sent += 1; controller.enqueue(megabyte); if (sent > 40) controller.close(); },
      }), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    });
    const handle = m.protocol.handlers.get('znada-media');
    const res = await handle({ url: proxyUrl('danbooru', 'full', DAN_FULL) });
    await assert.rejects(res.arrayBuffer(), 'the window must see the cut, as before');
    assert.ok(sent <= 32, 'reading stopped at the limit, not at the end');
    assert.deepStrictEqual(m.__test.recentOriginals.stats(), { entries: 0, bytes: 0, pending: 0 });
  });

  await test('an add while the viewer is still downloading waits for that download', async (m) => {
    let push;
    const net = network({
      [DAN_FULL]: () => {
        // Only the viewer's request is held open; a second request is answered at once,
        // so an add that does not wait fails the count below instead of hanging.
        if (net.count(DAN_FULL) > 1) return image(JPEG)();
        return new Response(new ReadableStream({
          start(controller) { push = controller; controller.enqueue(new Uint8Array(JPEG.subarray(0, 1000))); },
        }), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      },
    });
    const handle = m.protocol.handlers.get('znada-media');
    const res = await handle({ url: proxyUrl('danbooru', 'full', DAN_FULL) });
    const reader = res.body.getReader();
    await reader.read();
    const adding = m.invoke('internet-add', danbooru(), '');
    // Long enough for the add to reach the network (it creates its folder first): one
    // that does not wait has asked the site again by then.
    await settle(() => net.count(DAN_FULL) > 1, 500);
    assert.strictEqual(net.count(DAN_FULL), 1, 'the add started its own download instead of waiting');
    push.enqueue(new Uint8Array(JPEG.subarray(1000)));
    push.close();
    while (!(await reader.read()).done) { /* the window reads to the end */ }
    const result = await adding;
    assert.strictEqual(result.error, null);
    assert.strictEqual(net.count(DAN_FULL), 1);
    assert.ok(fs.readFileSync(recordFor(m, 'https://danbooru.donmai.us/posts/7').path).equals(JPEG));
  });

  await test('two adds of one picture from two windows download it once', async (m) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const net = network({ [DAN_FULL]: async () => { await gate; return image(JPEG)(); } });
    const fromGrid = m.invokeAs('main', 'internet-add', danbooru(), 'sky');
    const fromViewer = m.invokeAs('viewer', 'internet-add', danbooru(), '');
    await tick();
    release();
    const [a, b] = await Promise.all([fromGrid, fromViewer]);
    assert.strictEqual(a.error, null);
    assert.strictEqual(b.error, null);
    assert.strictEqual(a.id, b.id, 'both windows name the same record');
    assert.strictEqual(net.count(DAN_FULL), 1, 'the picture was downloaded twice');
    const records = Object.values(m.__test.getConfig().library || {});
    assert.strictEqual(records.length, 1);
  });

  await test('Wallhaven: the add asks Chromium\'s cache first, with the site\'s headers', async (m) => {
    network({
      [WH_FULL]: image(JPEG),
      'https://wallhaven.cc/api/v1/w/abc123': () => Response.json({ data: { tags: [{ name: 'Sky' }] } }),
    });
    const before = m.calls.sessionFetches.length;
    const result = await m.invoke('internet-add', wallhaven(), '');
    assert.strictEqual(result.error, null);
    const asked = m.calls.sessionFetches.slice(before).filter((r) => r.url === WH_FULL);
    assert.strictEqual(asked.length, 1, 'the original must come through the window\'s session');
    assert.strictEqual(asked[0].init.cache, 'force-cache');
    assert.ok(asked[0].init.headers && asked[0].init.headers['User-Agent'], 'the site\'s headers are kept');
    assert.ok(recordFor(m, 'https://wallhaven.cc/w/abc123').tags.includes('sky'));
  });

  await test('the site\'s tag request runs alongside the download, not after it', async (m) => {
    let tagsAsked;
    const asked = new Promise((resolve) => { tagsAsked = resolve; });
    network({
      [WH_FULL]: async () => {
        // A download that finishes only once the tag request has started: if the two
        // were still one after the other, this would never finish.
        const waited = await Promise.race([asked.then(() => true), new Promise((r) => { setTimeout(() => r(false), 2000); })]);
        if (!waited) throw new Error('the tag request did not start during the download');
        return image(JPEG)();
      },
      'https://wallhaven.cc/api/v1/w/abc123': () => { tagsAsked(); return Response.json({ data: { tags: [{ name: 'Night' }] } }); },
    });
    const result = await m.invoke('internet-add', wallhaven(), '');
    assert.strictEqual(result.error, null);
    assert.ok(recordFor(m, 'https://wallhaven.cc/w/abc123').tags.includes('night'));
  });

  await test('save as / copy takes the kept original too', async (m, dir) => {
    const net = network({ [DAN_FULL]: image(JPEG) });
    await viewerLoads(m, 'danbooru', 'full', DAN_FULL);
    const copied = await m.invoke('card-copy-file', { kind: 'internet', id: '', item: danbooru() });
    // The harness has no real image decoder, so the copy stops at "not an image" — after
    // the file was obtained, which is the part under test.
    assert.strictEqual(copied.error, 'badImage');
    assert.strictEqual(net.count(DAN_FULL), 1);
    assert.ok(fs.existsSync(path.join(dir, 'export-cache', md5name(JPEG, 'jpg'))));
  });

  await test('two adds of one catalogue picture share one signed URL and one download', async (m) => {
    const BYTES = Buffer.from('cloud-original');
    const URL = 'https://storage.example.test/one.jpg';
    let signed = 0;
    let downloads = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url) => {
      if (String(url).includes('/v1/content/') && String(url).endsWith('/download')) {
        signed += 1;
        return { status: 200, text: async () => JSON.stringify({ url: URL, expires_at: 1900000000 }) };
      }
      if (String(url) === URL) {
        downloads += 1;
        await gate;
        return { ok: true, status: 200, arrayBuffer: async () => BYTES };
      }
      throw new Error('unexpected request: ' + url);
    };
    m.__test.setCloudSession('A'.repeat(43), {
      user: { id: 'u', display_name: 'U', email: null, role: 'user', explicit_opt_in: false, created_at: 1 },
      entitlements: ['online_catalog'],
    });
    const item = { id: 'one', width: 1920, height: 1080 };
    const first = m.invokeAs('main', 'cloud-add', item);
    const second = m.invokeAs('viewer', 'cloud-add', item);
    await tick();
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a.error, null);
    assert.strictEqual(a.id, b.id);
    assert.strictEqual(signed, 1, 'a second signed URL was asked for');
    assert.strictEqual(downloads, 1, 'the picture was downloaded twice');
  });

  finished = true;
  if (failures.length) {
    console.log('\n' + failures.length + ' test(s) failed.');
    for (const f of failures) console.log('\n--- ' + f.name + ' ---\n' + (f.err && f.err.stack));
    process.exit(1);
  }
  console.log(`\nAdd without a second download PASS: ${passed} checks`);
})();
