'use strict';

const assert = require('assert');
const path = require('path');
const details = require('../src/item-details');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

ok('path validation accepts absolute Windows paths and rejects unsafe input',
  details.isValidAbsolutePath('C:\\Wallpapers\\image.png')
  && !details.isValidAbsolutePath('relative\\image.png')
  && !details.isValidAbsolutePath('C:\\bad\0name.png')
  && !details.isValidAbsolutePath('C:\\' + 'a'.repeat(details.MAX_PATH_CHARS)));

ok('source URLs are limited to normalized HTTP(S)',
  details.normalizeHttpUrl('https://example.com/post?id=1') === 'https://example.com/post?id=1'
  && details.normalizeHttpUrl('http://example.com') === 'http://example.com/'
  && details.normalizeHttpUrl('file:///C:/secret.txt') === ''
  && details.normalizeHttpUrl('javascript:alert(1)') === ''
  && details.normalizeHttpUrl('not a url') === '');

ok('configured folder roots authorize themselves and descendants, not sibling prefixes',
  details.isSameOrDescendant(
    'C:\\Wallpapers\\Nested\\image.png',
    'C:\\Wallpapers',
  )
  && details.isSameOrDescendant('C:\\Wallpapers', 'C:\\Wallpapers\\')
  && !details.isSameOrDescendant('C:\\Wallpapers-old\\image.png', 'C:\\Wallpapers')
  && !details.isSameOrDescendant('C:\\Secret\\image.png', 'C:\\Wallpapers'));

(async () => {
  let headerReads = 0;
  let modifiedAt = 10;
  const reader = details.createDetailsReader({
    cacheCap: 1,
    statPath: async () => ({
      size: 1234,
      mtimeMs: modifiedAt,
      isFile: () => true,
      isDirectory: () => false,
    }),
    readHeader: async () => {
      headerReads += 1;
      return pngHeader(1920, 1080);
    },
  });

  const [first, concurrent] = await Promise.all([
    reader('C:\\Wallpapers\\one.png'),
    reader('C:\\Wallpapers\\one.png'),
  ]);
  ok('concurrent metadata reads share one bounded header read',
    headerReads === 1 && first.width === 1920 && concurrent.height === 1080);

  const cached = await reader('C:\\Wallpapers\\one.png');
  ok('unchanged metadata reuses the dimensions cache',
    headerReads === 1 && cached.size === 1234 && cached.modifiedAt === 10);

  modifiedAt = 11;
  await reader('C:\\Wallpapers\\one.png');
  ok('mtime changes invalidate cached dimensions', headerReads === 2);

  let failedReads = 0;
  const retryReader = details.createDetailsReader({
    statPath: async () => ({
      size: 1234,
      mtimeMs: 30,
      isFile: () => true,
      isDirectory: () => false,
    }),
    readHeader: async () => {
      failedReads += 1;
      if (failedReads === 1) throw new Error('temporary network failure');
      return pngHeader(640, 480);
    },
  });
  const failed = await retryReader('C:\\Wallpapers\\network.png');
  const retried = await retryReader('C:\\Wallpapers\\network.png');
  ok('temporary header-read failures are not cached for the whole session',
    failed.width === 0 && retried.width === 640 && failedReads === 2);

  let folderHeaderReads = 0;
  const folderReader = details.createDetailsReader({
    statPath: async () => ({
      size: 999,
      mtimeMs: 20,
      isFile: () => false,
      isDirectory: () => true,
    }),
    readHeader: async () => { folderHeaderReads += 1; return Buffer.alloc(0); },
  });
  const folder = await folderReader('C:\\Wallpapers');
  ok('folders report their type without reading image bytes',
    folder.exists && folder.isFolder && folder.size === 0 && folderHeaderReads === 0);

  const invalid = await reader('relative.png');
  ok('invalid paths return a stable empty shape without stat',
    !invalid.exists && invalid.width === 0 && invalid.height === 0);

  const realReader = details.createDetailsReader();
  const real = await realReader(path.join(__dirname, '..', 'assets', 'icon.png'));
  ok('the real reader reports file metadata and image dimensions',
    real.exists && !real.isFolder && real.size > 0 && real.width > 0 && real.height > 0);

  console.log('\nAll ' + passed + ' item-details tests passed.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
