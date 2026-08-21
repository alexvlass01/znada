'use strict';

// The one key every "is this the same file" question in Znada goes through.
// Getting it wrong is not cosmetic: a trash entry written with one spelling was
// invisible to the guard protecting an active file, and the playlist kept serving a
// photo the user had removed. Run: node test/path-key.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathKey, isUnderPath, isDirectChildPath } = require('../src/path-key');
const library = require('../src/library');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log('\npath-key\n');

test('the two ways Windows spells one path are the same key', () => {
  assert.strictEqual(pathKey('C:\\photos\\a.jpg'), pathKey('C:/photos/a.jpg'));
});

test('case does not make two different files', () => {
  assert.strictEqual(pathKey('C:\\Photos\\A.JPG'), pathKey('c:/photos/a.jpg'));
});

test('a trailing separator does not make a different folder', () => {
  assert.strictEqual(pathKey('C:\\photos\\'), pathKey('C:/photos'));
});

test('"." and ".." are folded, so a folder walk and a stored path agree', () => {
  assert.strictEqual(pathKey('C:/photos/sub/../a.jpg'), pathKey('C:/photos/a.jpg'));
  assert.strictEqual(pathKey('C:/photos/./a.jpg'), pathKey('C:/photos/a.jpg'));
  assert.strictEqual(pathKey('C:/photos//a.jpg'), pathKey('C:/photos/a.jpg'));
});

test('".." never eats the drive letter', () => {
  assert.strictEqual(pathKey('C:/../../a.jpg'), 'c:/a.jpg');
});

test('a UNC host survives folding', () => {
  assert.strictEqual(pathKey('\\\\server\\share\\a.jpg'), '//server/share/a.jpg');
  assert.strictEqual(pathKey('\\\\server\\share\\sub\\..\\a.jpg'), '//server/share/a.jpg');
});

test('extended-length drive and UNC spellings collapse to ordinary keys', () => {
  assert.strictEqual(pathKey('\\\\?\\C:\\photos\\a.jpg'), pathKey('C:/photos/a.jpg'));
  assert.strictEqual(
    pathKey('\\\\?\\UNC\\server\\share\\photos\\a.jpg'),
    pathKey('\\\\server\\share/photos/a.jpg'),
  );
});

test('the browser build exposes the exact same canonical key', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'path-key.js'), 'utf8');
  const context = { self: {} };
  vm.runInNewContext(source, context, { filename: 'path-key.js' });
  assert.strictEqual(
    context.self.ZnadaPathKey.pathKey('\\\\?\\C:\\photos\\sub\\..\\a.jpg'),
    pathKey('C:/photos/a.jpg'),
  );
});

test('empty and rubbish inputs give an empty key rather than throwing', () => {
  assert.strictEqual(pathKey(''), '');
  assert.strictEqual(pathKey(null), '');
  assert.strictEqual(pathKey(undefined), '');
  assert.strictEqual(pathKey(42), '42');
});

test('the pool id is derived from the key, so both spellings share one record', () => {
  assert.strictEqual(library.idFor('C:\\photos\\a.jpg'), library.idFor('C:/photos/a.jpg'));
  assert.strictEqual(library.idFor('C:/photos/sub/../a.jpg'), library.idFor('C:/photos/a.jpg'));
});

test('a sibling folder with a longer name is not "inside" its neighbour', () => {
  // Raw prefix matching says C:\photos2 is under C:\photos. It is not, and treating it
  // that way would hide an unrelated folder's photos when a folder is removed.
  assert.strictEqual(isUnderPath('C:/photos2/a.jpg', 'C:/photos'), false);
  assert.strictEqual(isUnderPath('C:/photos/a.jpg', 'C:/photos'), true);
  assert.strictEqual(isUnderPath('C:\\photos\\sub\\a.jpg', 'C:/photos'), true);
});

test('a folder is "under" itself, so removing it covers its own record', () => {
  assert.strictEqual(isUnderPath('C:/photos', 'C:/photos/'), true);
});

test('ancestor matching accepts extended-length and separator aliases', () => {
  assert.strictEqual(isUnderPath('\\\\?\\C:\\photos\\sub/a.jpg', 'C:/photos'), true);
  assert.strictEqual(isUnderPath('\\\\?\\UNC\\server\\share\\photos\\a.jpg', '\\\\server\\share/photos'), true);
});

test('direct-child matching excludes the root and nested descendants', () => {
  assert.strictEqual(isDirectChildPath('\\\\?\\C:\\wallpapers\\a.jpg', 'C:/wallpapers'), true);
  assert.strictEqual(isDirectChildPath('C:/wallpapers/cache/a.jpg', 'C:\\wallpapers\\'), false);
  assert.strictEqual(isDirectChildPath('C:/wallpapers', 'C:/wallpapers'), false);
  assert.strictEqual(isDirectChildPath('C:/wallpapers2/a.jpg', 'C:/wallpapers'), false);
});

console.log(`\n${failures.length ? `${failures.length} FAILED, ` : ''}${passed} path-key tests passed.\n`);
if (failures.length) {
  for (const f of failures) console.error(`FAILED: ${f.name}\n${f.err.stack}`);
  process.exit(1);
}
