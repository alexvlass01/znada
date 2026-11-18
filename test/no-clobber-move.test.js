'use strict';

// BUG-084. src/no-clobber-move.js on real files, plus injected failures for the
// branches a healthy NTFS temp folder never takes: no hard links, a name taken in the
// instant between attempts, and a source that cannot be removed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { moveNoClobber, candidateName } = require('../src/no-clobber-move');
const { makeTempDir } = require('./helpers/temp-dir');

let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`  ok ${name}`);
}

function setup(label) {
  const root = makeTempDir(`znada-noclobber-${label}-`);
  const trash = path.join(root, '.trash');
  fs.mkdirSync(trash);
  return { root, trash };
}

function err(code) {
  return Object.assign(new Error(code), { code });
}

// A real fs with chosen calls replaced.
function fsWith(overrides) {
  return Object.assign(Object.create(fs), overrides); // constants come through the prototype
}

check('candidate names: plain first, then numbered before the extension', () => {
  assert.strictEqual(candidateName('wp-a.png', 1), 'wp-a.png');
  assert.strictEqual(candidateName('wp-a.png', 2), 'wp-a (2).png');
  assert.strictEqual(candidateName('noext', 3), 'noext (3)');
});

check('free name: moved under its own name', () => {
  const { root, trash } = setup('free');
  const src = path.join(root, 'a.png');
  fs.writeFileSync(src, 'A');
  const dest = moveNoClobber(src, trash);
  assert.strictEqual(dest, path.join(trash, 'a.png'));
  assert.ok(!fs.existsSync(src));
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'A');
});

check('taken name: the existing file keeps its bytes, the newcomer gets (2)', () => {
  const { root, trash } = setup('taken');
  fs.writeFileSync(path.join(trash, 'a.png'), 'OLD');
  const src = path.join(root, 'a.png');
  fs.writeFileSync(src, 'NEW');
  const dest = moveNoClobber(src, trash);
  assert.strictEqual(dest, path.join(trash, 'a (2).png'));
  assert.strictEqual(fs.readFileSync(path.join(trash, 'a.png'), 'utf8'), 'OLD');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'NEW');
});

check('race: the name is taken between choosing and linking — still no overwrite', () => {
  const { root, trash } = setup('race-link');
  const src = path.join(root, 'a.png');
  fs.writeFileSync(src, 'NEW');
  const rival = path.join(trash, 'a.png');
  const fake = fsWith({
    linkSync(from, to) {
      // Another writer wins the plain name a moment before us.
      if (to === rival && !fs.existsSync(rival)) fs.writeFileSync(rival, 'RIVAL');
      return fs.linkSync(from, to);
    },
  });
  const dest = moveNoClobber(src, trash, { fs: fake });
  assert.strictEqual(fs.readFileSync(rival, 'utf8'), 'RIVAL');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'NEW');
  assert.ok(!fs.existsSync(src));
});

check('no hard links on this drive: exclusive copy, still no overwrite', () => {
  const { root, trash } = setup('nolink');
  fs.writeFileSync(path.join(trash, 'a.png'), 'OLD');
  const src = path.join(root, 'a.png');
  fs.writeFileSync(src, 'NEW');
  const fake = fsWith({ linkSync() { throw err('EPERM'); } });
  const dest = moveNoClobber(src, trash, { fs: fake });
  assert.strictEqual(dest, path.join(trash, 'a (2).png'));
  assert.strictEqual(fs.readFileSync(path.join(trash, 'a.png'), 'utf8'), 'OLD');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'NEW');
  assert.ok(!fs.existsSync(src));
});

check('copy route race: a name taken just before the copy is skipped', () => {
  const { root, trash } = setup('race-copy');
  const src = path.join(root, 'a.png');
  fs.writeFileSync(src, 'NEW');
  const rival = path.join(trash, 'a.png');
  const fake = fsWith({
    linkSync() { throw err('ENOTSUP'); },
    copyFileSync(from, to, mode) {
      if (to === rival && !fs.existsSync(rival)) fs.writeFileSync(rival, 'RIVAL');
      return fs.copyFileSync(from, to, mode);
    },
  });
  const dest = moveNoClobber(src, trash, { fs: fake });
  assert.strictEqual(fs.readFileSync(rival, 'utf8'), 'RIVAL');
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'NEW');
});

check('source cannot be removed (link route): source kept, no stray link left', () => {
  const { root, trash } = setup('unlink-fail');
  const src = path.join(root, 'a.png');
  fs.writeFileSync(src, 'NEW');
  const fake = fsWith({
    unlinkSync(p) { if (p === src) throw err('EBUSY'); return fs.unlinkSync(p); },
  });
  assert.throws(() => moveNoClobber(src, trash, { fs: fake }), /EBUSY/);
  assert.strictEqual(fs.readFileSync(src, 'utf8'), 'NEW');
  assert.deepStrictEqual(fs.readdirSync(trash), []);
});

check('source cannot be removed (copy route): source kept, our copy withdrawn', () => {
  const { root, trash } = setup('unlink-fail-copy');
  const src = path.join(root, 'a.png');
  fs.writeFileSync(src, 'NEW');
  const fake = fsWith({
    linkSync() { throw err('EPERM'); },
    unlinkSync(p) { if (p === src) throw err('EBUSY'); return fs.unlinkSync(p); },
  });
  assert.throws(() => moveNoClobber(src, trash, { fs: fake }), /EBUSY/);
  assert.strictEqual(fs.readFileSync(src, 'utf8'), 'NEW');
  assert.deepStrictEqual(fs.readdirSync(trash), []);
});

check('copy comes out short (copy route): source kept, short copy withdrawn', () => {
  const { root, trash } = setup('copy-short');
  const src = path.join(root, 'a.png');
  fs.writeFileSync(src, 'NEW-FULL-BYTES');
  const fake = fsWith({
    linkSync() { throw err('EPERM'); },
    // The copy "succeeds" but only part of the bytes landed (a dying drive, a full share).
    copyFileSync(from, to, mode) {
      fs.copyFileSync(from, to, mode);
      fs.truncateSync(to, 3);
    },
  });
  assert.throws(() => moveNoClobber(src, trash, { fs: fake }), (e) => e.code === 'EIO');
  assert.strictEqual(fs.readFileSync(src, 'utf8'), 'NEW-FULL-BYTES');
  assert.deepStrictEqual(fs.readdirSync(trash), []);
});

check('copy fails outright: the source is untouched', () => {
  const { root, trash } = setup('copy-fail');
  const src = path.join(root, 'a.png');
  fs.writeFileSync(src, 'NEW');
  const fake = fsWith({
    linkSync() { throw err('EPERM'); },
    copyFileSync() { throw err('ENOSPC'); },
  });
  assert.throws(() => moveNoClobber(src, trash, { fs: fake }), /ENOSPC/);
  assert.strictEqual(fs.readFileSync(src, 'utf8'), 'NEW');
});

check('missing source: reported, nothing created', () => {
  const { root, trash } = setup('missing');
  assert.throws(() => moveNoClobber(path.join(root, 'gone.png'), trash), (e) => e.code === 'ENOENT');
  assert.deepStrictEqual(fs.readdirSync(trash), []);
});

console.log(`PASS no-clobber-move: ${checks} checks`);
