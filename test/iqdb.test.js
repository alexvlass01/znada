'use strict';

const assert = require('node:assert/strict');
const iqdb = require('../src/iqdb');
const positive = require('./fixtures/iqdb-best');
const absence = positive.replace('<th>Best match</th>', '<th>No relevant matches</th>');

async function main() {
  assert.deepEqual(iqdb.parse(positive), {
    status: 'candidate', candidate: {
      provider: 'danbooru', postId: '9999999', page: 'https://danbooru.donmai.us/posts/9999999', similarity: 95,
    },
  });
  // A real miss still includes links and similarity scores. Those are not a match.
  assert.deepEqual(iqdb.parse(absence), { status: 'absent' });
  assert.equal(iqdb.parse(positive.replace('95% similarity', '42% similarity')).status, 'ambiguous');
  assert.equal(iqdb.parse(positive.replace('95% similarity', '101% similarity')).status, 'ambiguous');
  assert.equal(iqdb.parse(positive.replace('95% similarity', 'NaN% similarity')).status, 'ambiguous');
  assert.equal(iqdb.parse('<html>Please enable JavaScript</html>').status, 'error');
  assert.equal(iqdb.parse('<html>captcha</html>').status, 'error');
  assert.equal(iqdb.parse('x'.repeat(512 * 1024 + 1)).status, 'error');
  assert.equal(iqdb.parse(positive.replace("id='show1'", "id='changed'")).status, 'error');
  const bestTable = positive.match(/<div><table><tr><th>Best match[\s\S]*?<\/table><\/div>/)[0];
  const ambiguous = positive.replace("<br></div><br><div id='show1'>", bestTable.replaceAll('9999999', '8888888') + "<br></div><br><div id='show1'>");
  assert.equal(iqdb.parse(ambiguous).status, 'ambiguous');
  assert.equal(iqdb.parse(positive.replace('//danbooru.donmai.us/posts/9999999', '//evil.invalid/posts/9999999')).status, 'ambiguous');
  for (const url of [
    'http://danbooru.donmai.us/posts/42', 'https://danbooru.donmai.us.evil.invalid/posts/42',
    'https://danbooru.donmai.us@evil.invalid/posts/42', 'https://x@danbooru.donmai.us/posts/42',
    'https://danbooru.donmai.us:8443/posts/42', 'https://danbooru.donmai.us/posts/42?x=1',
    'https://danbooru.donmai.us/posts/42#x', 'https://danbooru.donmai.us/posts/0',
    'https://danbooru.donmai.us/posts/42/extra', 'javascript:alert(1)',
    'https://gelbooru.com/index.php?page=post&s=view&id=1&id=2',
    'https://gelbooru.com/index.php?page=post&s=list&md5=01234567890123456789012345678901',
  ]) assert.equal(iqdb.reference(url), null, url);
  assert.deepEqual(iqdb.reference('//gelbooru.com/index.php?page=post&amp;s=view&amp;id=42'), {
    provider: 'gelbooru', postId: '42', page: 'https://gelbooru.com/index.php?page=post&s=view&id=42',
  });

  let calls = 0;
  let now = 1000;
  const image = { bytes: Buffer.from('test fixture, no real photo'), mime: 'image/png' };
  const client = iqdb.create({ now: () => now, fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://iqdb.org/');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.method, 'POST');
    assert.equal(init.body.get('file').name, 'image.png');
    assert.equal(init.body.get('file').size, image.bytes.length);
    return new Response(positive, { headers: { 'content-type': 'text/html' } });
  } });
  assert.equal((await client.search(image)).status, 'candidate');
  assert.equal((await client.search(image)).status, 'busy');
  assert.equal(calls, 1);
  now += 30001;
  assert.equal((await client.search(image)).status, 'candidate');
  assert.equal(calls, 2);
  assert.equal((await client.search({ ...image, bytes: Buffer.alloc(iqdb.MAX_IMAGE_BYTES + 1) })).reason, 'thumbnail');
  assert.equal(calls, 2);
  let refused = 0;
  const jpeg = iqdb.create({ fetchImpl: async (url, init) => {
    const file = init.body.get('file');
    assert.equal(file.name, 'image.jpg');
    assert.equal(file.type, 'image/jpeg');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), image.bytes);
    return new Response(positive, { headers: { 'content-type': 'text/html' } });
  } });
  assert.equal((await jpeg.search({ ...image, mime: 'image/jpeg' })).status, 'candidate');
  const unavailable = iqdb.create({ now: () => now, fetchImpl: async () => {
    refused++;
    return new Response('', { status: 429, headers: { 'retry-after': '3600' } });
  } });
  assert.equal((await unavailable.search(image)).status, 'error');
  now += 60001;
  const backoff = await unavailable.search(image);
  assert.equal(backoff.status, 'busy');
  assert.ok(backoff.retryAfterMs > 3000000);
  assert.equal(refused, 1);
  for (const response of [
    new Response(positive, { status: 302, headers: { location: 'https://evil.invalid/' } }),
    new Response('blocked', { status: 403 }),
    new Response(positive, { headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(512 * 1024 + 1), { headers: { 'content-type': 'text/html' } }),
    new Response('captcha', { headers: { 'content-type': 'text/html' } }),
  ]) {
    const bad = iqdb.create({ fetchImpl: async () => response });
    assert.equal((await bad.search(image)).status, 'error');
  }
  const timeout = iqdb.create({ fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  assert.equal((await timeout.search(image)).reason, 'timeout');
  console.log('IQDB: positive/negative/ambiguous, hostile URLs, protocol errors, bounded responses and backoff PASS');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
