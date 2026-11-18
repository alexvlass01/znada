'use strict';

// MEDIA-004. Which kind a Library card is, and whether the ticks in "Filters" let it show.
const assert = require('assert');
const LibraryKind = require('../renderer/library-kind');
const imageMotion = require('../src/image-motion');

let checks = 0;
function check(name, fn) {
  try { fn(); checks += 1; } catch (err) { console.error(`FAIL ${name}`); throw err; }
}

const ALL = ['photo', 'gif', 'video'];
const moving = (answers) => (p) => answers[p];

check('the window\'s list of formats that can move is the one main reads', () => {
  assert.deepStrictEqual(LibraryKind.CAN_MOVE.slice().sort(), imageMotion.CAN_MOVE.slice().sort());
});

check('ticks: fixed order, unknown dropped, the last tick cannot be cleared', () => {
  assert.deepStrictEqual(LibraryKind.normalize(['video', 'photo', 'nope']), ['photo', 'video']);
  assert.deepStrictEqual(LibraryKind.normalize([]), ALL, 'nothing ticked means everything');
  assert.strictEqual(LibraryKind.isNarrowed(ALL), false);
  assert.strictEqual(LibraryKind.isNarrowed(['photo', 'video']), true);
  assert.deepStrictEqual(LibraryKind.toggle(ALL, 'gif', false), ['photo', 'video']);
  assert.deepStrictEqual(LibraryKind.toggle(['video'], 'video', false), ['video'], 'last one stays');
  assert.deepStrictEqual(LibraryKind.toggle(['video'], 'photo', true), ['photo', 'video']);
});

check('a video is known by its name, a JPEG is a photo without asking', () => {
  assert.strictEqual(LibraryKind.kindOf({ path: 'C:\\v\\clip.MP4' }, moving({})), 'video');
  assert.strictEqual(LibraryKind.kindOf({ path: 'C:\\p\\a.jpg' }, moving({})), 'photo');
  assert.strictEqual(LibraryKind.kindOf({ path: 'C:\\trip.mp4\\a.jpg' }, moving({})), 'photo', 'a folder name lends no format');
});

check('a picture that can move is GIF only when main says it moves; unknown until then', () => {
  assert.strictEqual(LibraryKind.kindOf({ path: 'a.gif' }, moving({ 'a.gif': true })), 'gif');
  assert.strictEqual(LibraryKind.kindOf({ path: 'a.webp' }, moving({ 'a.webp': true })), 'gif', 'animated WebP is GIF');
  assert.strictEqual(LibraryKind.kindOf({ path: 'one.gif' }, moving({ 'one.gif': false })), 'photo', 'a one-frame GIF is a photo');
  assert.strictEqual(LibraryKind.kindOf({ path: 'a.png' }, moving({})), null);
});

check('a site card moves when the site said so; a folder always shows', () => {
  assert.strictEqual(LibraryKind.kindOf({ local: false, path: 'x', item: { animated: true, format: 'gif' } }), 'gif');
  assert.strictEqual(LibraryKind.kindOf({ local: false, path: 'x.mp4', item: {} }), 'photo');
  assert.strictEqual(LibraryKind.kindOf({ folder: true, path: 'C:\\f' }), 'folder');
  assert.strictEqual(LibraryKind.matches(['video'], 'folder'), true);
});

check('an unknown kind shows only when photo and GIF are both ticked', () => {
  assert.strictEqual(LibraryKind.matches(['photo', 'gif'], null), true);
  assert.strictEqual(LibraryKind.matches(['photo', 'video'], null), false);
  assert.strictEqual(LibraryKind.matches(['gif'], null), false);
  assert.strictEqual(LibraryKind.matches(['photo', 'video'], 'video'), true);
  assert.strictEqual(LibraryKind.matches(['photo', 'video'], 'gif'), false);
});

check('main is asked only when photo and GIF are ticked differently', () => {
  assert.strictEqual(LibraryKind.needsMotion(ALL), false);
  assert.strictEqual(LibraryKind.needsMotion(['photo', 'gif']), false);
  assert.strictEqual(LibraryKind.needsMotion(['video']), false);
  assert.strictEqual(LibraryKind.needsMotion(['photo', 'video']), true);
  assert.strictEqual(LibraryKind.needsMotion(['gif']), true);
});

console.log(`PASS library-kind: ${checks} checks`);
