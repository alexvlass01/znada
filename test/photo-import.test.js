'use strict';

// LIB-022 + LIB-023: the name of Znada's own copy of a photo, finding an existing copy
// of the same picture, and whether a watched folder already shows a file.
//
// Run: node test/photo-import.test.js

const assert = require('assert');
const P = require('../src/photo-import');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err && err.message}`); }
}

const HASH = '126a391b49657676';

console.log('\nLIB-022: the copy is named after the original\n');

test('the copy keeps the original name, then the hash', () => {
  assert.strictEqual(P.copyFileName('C:\\Users\\me\\Pictures\\sunset.png', HASH), `sunset-${HASH}.png`);
});

test('the extension is lower case, as before', () => {
  assert.strictEqual(P.copyFileName('C:\\x\\Beach.JPG', HASH), `Beach-${HASH}.jpg`);
});

test('a file without an extension keeps the old .img placeholder', () => {
  assert.strictEqual(P.copyFileName('C:\\x\\scan', HASH), `scan-${HASH}.img`);
});

test('a longer hash is cut to the same 16 digits the old names used', () => {
  assert.strictEqual(P.copyFileName('C:\\x\\a.png', HASH + 'ffffffff'), `a-${HASH}.png`);
});

test('Cyrillic and other scripts stay as they are', () => {
  assert.strictEqual(P.copyBaseName('C:\\Фото\\Закат над морем.png'), 'Закат над морем');
  assert.strictEqual(P.copyBaseName('C:\\x\\夕焼け.webp'), '夕焼け');
});

test('characters Windows refuses in a name become _', () => {
  // A dialog never returns these in a name, but a dropped path from another tool or a
  // network share can carry them, and a forbidden name would make the write fail.
  assert.strictEqual(P.copyBaseName('/mnt/share/a<b>c:d"e|f?g*h.png'), 'a_b_c_d_e_f_g_h');
});

test('control characters become _', () => {
  assert.strictEqual(P.copyBaseName('C:\\x\\a\u0001b\u007fc.png'), 'a_b_c');
});

test('leading and trailing dots and spaces go', () => {
  // A trailing dot is silently dropped by Windows; a leading one would hide the copy next
  // to our own `.trash` and staging files, which the search for copies skips.
  assert.strictEqual(P.copyBaseName('C:\\x\\..hidden. .png'), 'hidden');
  assert.strictEqual(P.copyBaseName('C:\\x\\  name  .png'), 'name');
});

test('runs of whitespace fold to one space', () => {
  assert.strictEqual(P.copyBaseName('C:\\x\\a \t  b.png'), 'a b');
});

test('nothing usable left falls back to the old wp prefix', () => {
  assert.strictEqual(P.copyFileName('C:\\x\\....png', HASH), `wp-${HASH}.png`);
  assert.strictEqual(P.copyFileName('C:\\x\\ .png', HASH), `wp-${HASH}.png`);
  assert.strictEqual(P.copyFileName('', HASH), `wp-${HASH}.img`);
});

test('a long name is cut by characters, never in the middle of one', () => {
  const long = 'Я'.repeat(100);
  assert.strictEqual(P.copyBaseName(`C:\\x\\${long}.png`), 'Я'.repeat(P.MAX_NAME_CHARS));
  // An emoji is two UTF-16 units; cutting by units would leave half of one.
  const emoji = '😀'.repeat(100);
  const cut = P.copyBaseName(`C:\\x\\${emoji}.png`);
  assert.strictEqual(Array.from(cut).length, P.MAX_NAME_CHARS);
  assert.ok(Array.from(cut).every((ch) => ch === '😀'), 'a character was split');
});

test('a cut that ends on a space or dot does not leave it at the end', () => {
  const name = 'a'.repeat(P.MAX_NAME_CHARS - 1) + ' tail';
  assert.strictEqual(P.copyBaseName(`C:\\x\\${name}.png`), 'a'.repeat(P.MAX_NAME_CHARS - 1));
});

test('composed and decomposed spellings of a letter give the same name', () => {
  const decomposed = 'e\u0301te\u0301.png';  // é as e + combining accent (macOS-style)
  assert.strictEqual(P.copyBaseName(`C:\\x\\${decomposed}`), '\u00e9t\u00e9');
});

test('a posix-style path names the file the same way', () => {
  assert.strictEqual(P.copyFileName('/home/me/sunset.png', HASH), `sunset-${HASH}.png`);
});

console.log('\nLIB-022: the same picture is still one copy\n');

test('an old wp-<hash> copy counts as a copy of the same picture', () => {
  assert.deepStrictEqual(P.existingCopies(['wp-' + HASH + '.png'], HASH, '.png'), ['wp-' + HASH + '.png']);
});

test('a named copy of the same picture counts, whatever its name', () => {
  assert.deepStrictEqual(P.existingCopies([`beach-${HASH}.png`], HASH, '.png'), [`beach-${HASH}.png`]);
});

test('a different hash, a different extension or our own dot-files do not count', () => {
  const names = [
    'wp-0000000000000000.png',
    `sunset-${HASH}.jpg`,
    `.download-1-ab.tmp`,
    `.znada-move-x-${HASH}.png`,
    `-${HASH}.png`,                 // dash and hash with nothing before the dash (review of PR #110)
    `${HASH}.png`,                  // the bare hash, no dash at all
    `sunset${HASH}.png`,            // no dash: not one of our names
  ];
  assert.deepStrictEqual(P.existingCopies(names, HASH, '.png'), []);
});

test('the match ignores case, as Windows does', () => {
  assert.deepStrictEqual(P.existingCopies([`Sunset-${HASH.toUpperCase()}.PNG`], HASH, '.png'),
    [`Sunset-${HASH.toUpperCase()}.PNG`]);
});

test('candidates come sorted, so the disk order does not choose', () => {
  assert.deepStrictEqual(P.existingCopies([`z-${HASH}.png`, `a-${HASH}.png`, `wp-${HASH}.png`], HASH, '.png'),
    [`a-${HASH}.png`, `wp-${HASH}.png`, `z-${HASH}.png`]);
});

test('garbage input gives no candidates', () => {
  assert.deepStrictEqual(P.existingCopies(null, HASH, '.png'), []);
  assert.deepStrictEqual(P.existingCopies([null, 7, {}], HASH, '.png'), []);
});

console.log('\nLIB-023: is the file already shown by a watched folder\n');

test('a file inside a watched folder is shown by it', () => {
  assert.strictEqual(P.watchedFolderFor('C:\\Photos\\beach.png', ['C:\\Photos'], []), 'C:\\Photos');
});

test('deeper inside counts too', () => {
  assert.strictEqual(P.watchedFolderFor('C:\\Photos\\2026\\sea\\beach.png', ['D:\\Other', 'C:\\Photos'], []), 'C:\\Photos');
});

test('spelling of the path does not matter', () => {
  assert.strictEqual(P.watchedFolderFor('c:/photos/BEACH.png', ['C:\\Photos\\'], []), 'C:\\Photos\\');
  assert.strictEqual(P.watchedFolderFor('\\\\?\\C:\\Photos\\beach.png', ['C:\\Photos'], []), 'C:\\Photos');
});

test('a sibling folder with a longer name is not the folder', () => {
  assert.strictEqual(P.watchedFolderFor('C:\\Photos2\\beach.png', ['C:\\Photos'], []), '');
});

test('a file in a subfolder the user removed is not shown, so it is still copied', () => {
  assert.strictEqual(P.watchedFolderFor('C:\\Photos\\old\\beach.png', ['C:\\Photos'], ['C:\\Photos\\old']), '');
  assert.strictEqual(P.watchedFolderFor('C:\\Photos\\new\\beach.png', ['C:\\Photos'], ['C:\\Photos\\old']), 'C:\\Photos');
});

test('no folders, no path: nothing', () => {
  assert.strictEqual(P.watchedFolderFor('C:\\Photos\\beach.png', [], []), '');
  assert.strictEqual(P.watchedFolderFor('', ['C:\\Photos'], []), '');
  assert.strictEqual(P.watchedFolderFor('C:\\Photos\\beach.png', null, null), '');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`\n✗ ${f.name}\n${f.err && f.err.stack}`);
  process.exit(1);
}
