'use strict';

// BUG-026: the tags of somebody else's photo must never land on yours.
//
// META-001 asks a catalogue "which post IS this exact file" by sending a hash of the
// bytes. Two things have to hold for the answer to be safe to write, and neither did:
//
//   1. The post must carry OUR hash. `md5:` is an ordinary search term, so a catalogue
//      that ignored it answers with an arbitrary picture. The guard demanded a match
//      only when the post HAD a hash — a post without one (Danbooru omits the file
//      fields on restricted and deleted posts) was accepted by default. That guard is
//      covered from the handler side in test/fingerprint-lookup.test.js.
//
//   2. The file must still be the same file. Hashing is streamed and the network round
//      trip that follows takes seconds; a live folder, a re-download or any outside tool
//      can replace the bytes at that path in between. Nothing re-checked, so the tags of
//      the picture that WAS there were written onto the picture that is there now.
//
// This file covers (2), end to end through the real main.js, plus the record side of the
// same question: a pool entry the user removed and added again is a new decision, not
// the record the request was started against.
//
// Run: node test/metadata-file-identity.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers/main-harness');
const library = require('../src/library');

let passed = 0;
const failures = [];

async function test(name, fn) {
  const dir = H.makeTempProfile('meta-identity');
  const captured = [];
  const real = { log: console.log, error: console.error };
  const realFetch = globalThis.fetch;
  console.log = (...a) => captured.push(a.join(' '));
  console.error = (...a) => captured.push(a.join(' '));
  try {
    await fn(dir);
    console.log = real.log; console.error = real.error;
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log = real.log; console.error = real.error;
    failures.push({ name, err, captured });
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
  } finally {
    console.log = real.log; console.error = real.error;
    globalThis.fetch = realFetch;
    H.unloadMain();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const cfgFile = (dir) => path.join(dir, 'config.json');
const storeFile = (dir) => path.join(dir, 'config.library.json');

// Written with real, differing bytes so the hash and the size both change when it is
// replaced — the two things the identity check has to notice.
function writePhoto(file, filler) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(filler)]));
  return file;
}

// One post, in a shape BOTH shipped catalogues can read: Danbooru takes json[0] of an
// array, Gelbooru takes the array itself. Which one gets asked depends on whether this
// checkout carries a bundled key, and this test must not care.
function postBody(md5) {
  const post = { id: 4242, tag_string: 'wrongtag', tags: 'wrongtag', rating: 'g' };
  if (md5 !== null) post.md5 = md5;
  return [post];
}

// Every outgoing request answered from here. `onRequest` runs BEFORE the answer, which
// is what makes "while the request was in flight" a real moment rather than a comment.
function stubNetwork({ body, onRequest }) {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    // Gelbooru asks a second time for tag kinds; that request is allowed to come back
    // empty and is swallowed by the adapter.
    const isLookup = calls === 1;
    if (isLookup && typeof onRequest === 'function') await onRequest();
    return { ok: true, status: 200, json: async () => (isLookup ? body : []) };
  };
}

function seedProfile(dir, photo) {
  const id = library.idFor(photo);
  H.writeJson(cfgFile(dir), { autoSwitch: true, style: 'fill', monitors: {} });
  H.writeJson(storeFile(dir), {
    version: 1,
    library: { [id]: { id, type: 'image', path: photo, addedAt: 1000, favorite: false, tags: [], author: '' } },
    trash: [],
  });
  return id;
}

function start(dir) {
  const m = H.loadMain(dir);
  m.__test.loadConfig();
  // Generous on purpose: this file is about identity, and a request held back by the
  // limiter would make every one of these pass without proving anything.
  m.__test.setMetadataBudget({ ratePerMinute: 6000, burst: 500, minGapMs: 0 });
  return m;
}

const md5Of = (file) => require('crypto').createHash('md5').update(fs.readFileSync(file)).digest('hex');

(async () => {
  console.log('\nmetadata lookup: is it still the same file? (BUG-026)\n');

  // ---- characterization -----------------------------------------------------

  await test('a post carrying our hash is applied to the photo', async (dir) => {
    const photo = writePhoto(path.join(dir, 'wallpapers', 'a.png'), 'original');
    const id = seedProfile(dir, photo);
    const m = start(dir);
    stubNetwork({ body: postBody(md5Of(photo)) });

    const res = await m.__test.lookupItemMetadata(id);
    assert.strictEqual(res.status, 'found', `expected a find, got ${res.status}/${res.reason}`);
    assert.ok(m.__test.getConfig().library[id].tags.includes('wrongtag'), 'the tags were not written');
  });

  await test('a post carrying somebody else\'s hash is not applied', async (dir) => {
    const photo = writePhoto(path.join(dir, 'wallpapers', 'a.png'), 'original');
    const id = seedProfile(dir, photo);
    const m = start(dir);
    stubNetwork({ body: postBody('b'.repeat(32)) });

    const res = await m.__test.lookupItemMetadata(id);
    assert.notStrictEqual(res.status, 'found');
    assert.deepStrictEqual(m.__test.getConfig().library[id].tags, [], 'tags were written anyway');
  });

  await test('a photo removed while the request was in flight is not written to', async (dir) => {
    const photo = writePhoto(path.join(dir, 'wallpapers', 'a.png'), 'original');
    const id = seedProfile(dir, photo);
    const m = start(dir);
    stubNetwork({
      body: postBody(md5Of(photo)),
      onRequest: async () => { delete m.__test.getConfig().library[id]; },
    });

    await m.__test.lookupItemMetadata(id);
    assert.ok(!m.__test.getConfig().library[id], 'the removed record was brought back to life');
  });

  // ---- regression -----------------------------------------------------------

  await test('a post with no hash at all is refused end to end', async (dir) => {
    const photo = writePhoto(path.join(dir, 'wallpapers', 'a.png'), 'original');
    const id = seedProfile(dir, photo);
    const m = start(dir);
    stubNetwork({ body: postBody(null) });

    const res = await m.__test.lookupItemMetadata(id);
    assert.notStrictEqual(res.status, 'found', 'a post that never said which file it is was believed');
    assert.deepStrictEqual(
      m.__test.getConfig().library[id].tags, [],
      'somebody else\'s tags were written onto the photo',
    );
  });

  await test('a file replaced while the request was in flight is not written to', async (dir) => {
    const photo = writePhoto(path.join(dir, 'wallpapers', 'a.png'), 'original');
    const id = seedProfile(dir, photo);
    const m = start(dir);
    stubNetwork({
      body: postBody(md5Of(photo)),
      // A live folder rescan, a re-download, any outside tool. The answer in flight is
      // about the bytes that WERE there.
      onRequest: async () => {
        writePhoto(photo, 'a completely different picture entirely');
        const later = new Date(Date.now() + 60000);
        fs.utimesSync(photo, later, later);
      },
    });

    const res = await m.__test.lookupItemMetadata(id);
    assert.notStrictEqual(res.status, 'found', 'an answer about the old bytes was applied to the new ones');
    assert.deepStrictEqual(
      m.__test.getConfig().library[id].tags, [],
      'the tags of the picture that used to be there were written onto the one that is',
    );
  });

  await test('a photo removed and added again mid-request is a new decision, not the old one', async (dir) => {
    const photo = writePhoto(path.join(dir, 'wallpapers', 'a.png'), 'original');
    const id = seedProfile(dir, photo);
    const m = start(dir);
    stubNetwork({
      body: postBody(md5Of(photo)),
      onRequest: async () => {
        const pool = m.__test.getConfig().library;
        delete pool[id];
        // Same path, so the same id — but a record the user created after the request
        // they are being answered for.
        pool[id] = { id, type: 'image', path: photo, addedAt: 9999, favorite: false, tags: [], author: '' };
      },
    });

    await m.__test.lookupItemMetadata(id);
    assert.deepStrictEqual(
      m.__test.getConfig().library[id].tags, [],
      'tags from a request against the old record were written onto the new one',
    );
  });

  await test('a file replaced while it is being hashed is not fingerprinted as either one', async (dir) => {
    const photo = writePhoto(path.join(dir, 'wallpapers', 'a.png'), 'original bytes');
    const id = seedProfile(dir, photo);
    const m = start(dir);
    stubNetwork({ body: postBody('c'.repeat(32)) });

    // Swap the bytes the moment the read stream is done: the hash is then of the new
    // file while the size and mtime recorded beside it belong to the old one. Cached
    // like that, every later lookup of this photo asks about a file that never existed.
    const realCreate = fs.createReadStream;
    fs.createReadStream = function patched(p, ...rest) {
      const stream = realCreate.call(this, p, ...rest);
      if (path.resolve(String(p)) === path.resolve(photo)) {
        stream.once('end', () => {
          writePhoto(photo, 'replaced halfway through');
          const later = new Date(Date.now() + 60000);
          fs.utimesSync(photo, later, later);
        });
      }
      return stream;
    };
    let res;
    try { res = await m.__test.lookupItemMetadata(id); } finally { fs.createReadStream = realCreate; }

    assert.notStrictEqual(res.status, 'found');
    // Named apart from an unreadable file on purpose: one is a disk problem, the other
    // is a file somebody keeps rewriting, and only the second is worth pressing again.
    assert.strictEqual(res.reason, 'changed', 'expected changed, got ' + res.reason);
    const cache = m.__test.metadataCache();
    const stored = Object.values(cache.files || {})[0];
    if (stored) {
      const onDisk = fs.statSync(photo);
      assert.strictEqual(
        stored.size, onDisk.size,
        'a hash was cached against the size of a file that is no longer there',
      );
    }
    assert.deepStrictEqual(m.__test.getConfig().library[id].tags, []);
  });

  await test('a record refreshed while its lookup waited in the queue is still written to', async (dir) => {
    // Lookups run one at a time, so the wait BEFORE a lookup starts is as real as the
    // wait inside it — and a folder rescan can remove and re-add a record in that gap.
    // The file is the same and the record is the current one, so the button the user
    // pressed must still do something. Closing over the record captured before the queue
    // would refuse it, which looks to the user like the button quietly doing nothing.
    const first = writePhoto(path.join(dir, 'wallpapers', 'a.png'), 'first photo');
    const second = writePhoto(path.join(dir, 'wallpapers', 'b.png'), 'second photo');
    const idA = library.idFor(first);
    const idB = library.idFor(second);
    H.writeJson(cfgFile(dir), { autoSwitch: true, style: 'fill', monitors: {} });
    H.writeJson(storeFile(dir), {
      version: 1,
      library: {
        [idA]: { id: idA, type: 'image', path: first, addedAt: 1000, favorite: false, tags: [], author: '' },
        [idB]: { id: idB, type: 'image', path: second, addedAt: 1000, favorite: false, tags: [], author: '' },
      },
      trash: [],
    });
    const m = start(dir);

    const md5A = md5Of(first);
    const md5B = md5Of(second);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url) => {
      const u = String(url);
      const reply = (body) => ({ ok: true, status: 200, json: async () => body });
      if (u.includes(md5A)) { await held; return reply(postBody('d'.repeat(32))); }
      if (u.includes(md5B)) return reply(postBody(md5B));
      return reply([]);
    };

    const runA = m.__test.lookupItemMetadata(idA);
    const runB = m.__test.lookupItemMetadata(idB);
    await new Promise((resolve) => { setImmediate(resolve); });

    // What a rescan does: the same photo, the same path, a record created just now.
    const pool = m.__test.getConfig().library;
    delete pool[idB];
    pool[idB] = { id: idB, type: 'image', path: second, addedAt: 5000, favorite: false, tags: [], author: '' };

    release();
    await runA;
    const res = await runB;

    assert.strictEqual(res.status, 'found', 'expected a find, got ' + res.status + '/' + res.reason);
    assert.ok(
      m.__test.getConfig().library[idB].tags.includes('wrongtag'),
      'the lookup was answered against a record that no longer existed and wrote nothing',
    );
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) {
      console.log(`FAILED: ${f.name}`);
      console.log(`  ${f.err && f.err.stack}`);
      if (f.captured.length) console.log(`  --- main.js output ---\n  ${f.captured.join('\n  ')}`);
    }
    process.exit(1);
  }
})();
