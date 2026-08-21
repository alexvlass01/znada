'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanBuildDirectory } = require('../scripts/build-thumbnail-helper');
const {
  assertEmptyOrMissingDirectory,
  prepareInstallerVendor,
  readNuspecMetadata,
  sha256File,
  trimReleasesToCurrentFull,
  verifyInstallerArtifacts,
} = require('../scripts/build-installer');
const {
  FORBIDDEN_PACKAGE_PATHS,
  REQUIRED_RUNTIME_FILES,
  credentialLikeEntries,
  parseCli,
  verifyRuntimeClosureEntries,
  verifyExternalResources,
  verifyRootBoundary,
} = require('../scripts/verify-thumbnail-package');

let passed = 0;
function ok(name, fn) {
  fn();
  console.log(`  OK ${name}`);
  passed++;
}

function storedZip(entryName, bytes) {
  const name = Buffer.from(entryName, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  const crc = crc32(bytes);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + name.length + bytes.length;
  const centralSize = central.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, bytes, central, name, eocd]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function rewriteReleaseForPackage(outputDirectory, nupkgName) {
  const nupkg = fs.readFileSync(path.join(outputDirectory, nupkgName));
  const sha1 = crypto.createHash('sha1').update(nupkg).digest('hex');
  fs.writeFileSync(path.join(outputDirectory, 'RELEASES'), `${sha1} ${nupkgName} ${nupkg.length}\n`, 'utf8');
}

function writeInstallerFixture(outputDirectory, version = '1.6.0', nuspecVersion = version) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'Znada-Setup.exe'), 'fixture setup');
  const nuspec = Buffer.from(
    `<?xml version="1.0"?><package><metadata><id>Znada</id><version>${nuspecVersion}</version><title>Znada</title></metadata></package>`,
    'utf8'
  );
  const nupkgName = `Znada-${version}-full.nupkg`;
  const nupkg = storedZip('Znada.nuspec', nuspec);
  fs.writeFileSync(path.join(outputDirectory, nupkgName), nupkg);
  const sha1 = crypto.createHash('sha1').update(nupkg).digest('hex');
  fs.writeFileSync(path.join(outputDirectory, 'RELEASES'), `${sha1} ${nupkgName} ${nupkg.length}\n`, 'utf8');
}

ok('installer output must be absent or empty before a build', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-installer-empty-'));
  try {
    assertEmptyOrMissingDirectory(path.join(fixture, 'missing'));
    assertEmptyOrMissingDirectory(fixture);
    fs.writeFileSync(path.join(fixture, 'stale.nupkg'), 'stale');
    assert.throws(() => assertEmptyOrMissingDirectory(fixture), /absent or empty/);
  }
  finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

ok('thumbnail-helper staging removes stale files before packaging', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-helper-stage-'));
  try {
    fs.writeFileSync(path.join(fixture, 'Znada.ThumbnailHelper.exe'), 'fixture');
    fs.writeFileSync(path.join(fixture, 'source.sha256'), 'fixture');
    fs.writeFileSync(path.join(fixture, 'PRODUCTION-TOKEN.txt'), 'leak');
    fs.mkdirSync(path.join(fixture, 'stale'), { recursive: true });
    cleanBuildDirectory(fixture);
    assert.deepStrictEqual(fs.readdirSync(fixture).sort(), ['Znada.ThumbnailHelper.exe', 'source.sha256']);
  }
  finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

ok('RELEASES trimming keeps only the exact current full package entry', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-releases-trim-'));
  try {
    fs.writeFileSync(path.join(fixture, 'RELEASES'), [
      `${'a'.repeat(40)} Znada-1.5.0-full.nupkg 10`,
      `${'b'.repeat(40)} Znada-1.6.0-full.nupkg 20`,
      `${'c'.repeat(40)} Znada-1.6.0-delta.nupkg 5`,
    ].join('\n'), 'utf8');
    trimReleasesToCurrentFull({ outputDirectory: fixture, version: '1.6.0' });
    assert.strictEqual(fs.readFileSync(path.join(fixture, 'RELEASES'), 'utf8'),
      `${'b'.repeat(40)} Znada-1.6.0-full.nupkg 20\n`);
  }
  finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

ok('installer vendor replaces only NuGet after verifying its pinned digest', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-installer-vendor-'));
  try {
    const sourceVendor = path.join(fixture, 'source-vendor');
    const targetVendor = path.join(fixture, '.build', 'prepared-vendor');
    const nugetPath = path.join(fixture, 'nuget.exe');
    fs.mkdirSync(sourceVendor, { recursive: true });
    fs.writeFileSync(path.join(sourceVendor, 'Squirrel.exe'), 'squirrel fixture');
    fs.writeFileSync(path.join(sourceVendor, 'nuget.exe'), 'obsolete nuget fixture');
    fs.writeFileSync(nugetPath, 'pinned nuget fixture');
    const expectedSha256 = sha256File(nugetPath);
    assert.strictEqual(prepareInstallerVendor({
      root: fixture, sourceVendor, targetVendor, nugetPath, expectedSha256,
    }), targetVendor);
    assert.strictEqual(fs.readFileSync(path.join(targetVendor, 'Squirrel.exe'), 'utf8'), 'squirrel fixture');
    assert.strictEqual(fs.readFileSync(path.join(targetVendor, 'nuget.exe'), 'utf8'), 'pinned nuget fixture');
    fs.writeFileSync(nugetPath, 'tampered');
    assert.throws(() => prepareInstallerVendor({
      root: fixture, sourceVendor, targetVendor, nugetPath, expectedSha256,
    }), /SHA256 verification/);
  }
  finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

ok('installer verifier checks exact files, RELEASES hash/size and nuspec identity', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-installer-verify-'));
  try {
    writeInstallerFixture(fixture);
    const result = verifyInstallerArtifacts({ outputDirectory: fixture, version: '1.6.0' });
    assert.strictEqual(result.nupkgName, 'Znada-1.6.0-full.nupkg');
    assert.deepStrictEqual(readNuspecMetadata(path.join(fixture, result.nupkgName)), {
      id: 'Znada', version: '1.6.0', title: 'Znada'
    });

    fs.appendFileSync(path.join(fixture, 'RELEASES'), 'extra line\n');
    assert.throws(() => verifyInstallerArtifacts({ outputDirectory: fixture, version: '1.6.0' }),
      /exactly one non-empty line/);
    writeInstallerFixture(fixture);
    const releases = fs.readFileSync(path.join(fixture, 'RELEASES'), 'utf8');
    fs.writeFileSync(path.join(fixture, 'RELEASES'), releases.replace(/^[0-9a-f]{40}/, '0'.repeat(40)), 'utf8');
    assert.throws(() => verifyInstallerArtifacts({ outputDirectory: fixture, version: '1.6.0' }),
      /SHA1 does not match/);
    writeInstallerFixture(fixture);
    const validRelease = fs.readFileSync(path.join(fixture, 'RELEASES'), 'utf8');
    fs.writeFileSync(path.join(fixture, 'RELEASES'), validRelease.replace(/\d+\s*$/, '999999\n'), 'utf8');
    assert.throws(() => verifyInstallerArtifacts({ outputDirectory: fixture, version: '1.6.0' }),
      /byte size does not match/);
    writeInstallerFixture(fixture, '1.6.0', '1.7.0');
    assert.throws(() => verifyInstallerArtifacts({ outputDirectory: fixture, version: '1.6.0' }),
      /NuGet package version 1\.7\.0 does not match/);
    writeInstallerFixture(fixture);
    const nupkgName = 'Znada-1.6.0-full.nupkg';
    const nupkgPath = path.join(fixture, nupkgName);
    const corrupt = fs.readFileSync(nupkgPath);
    const nameLength = corrupt.readUInt16LE(26);
    corrupt[30 + nameLength + 8] ^= 0xff;
    fs.writeFileSync(nupkgPath, corrupt);
    rewriteReleaseForPackage(fixture, nupkgName);
    assert.throws(() => verifyInstallerArtifacts({ outputDirectory: fixture, version: '1.6.0' }),
      /archive integrity test failed/);
    writeInstallerFixture(fixture);
    fs.writeFileSync(path.join(fixture, 'extra.zip'), 'stale');
    assert.throws(() => verifyInstallerArtifacts({ outputDirectory: fixture, version: '1.6.0' }),
      /must contain exactly/);
  }
  finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

ok('package verifier declares runtime/private and credential boundaries', () => {
  assert.ok(REQUIRED_RUNTIME_FILES.includes('/package.json'));
  assert.ok(REQUIRED_RUNTIME_FILES.includes('/src/hotkey.js'));
  assert.ok(REQUIRED_RUNTIME_FILES.includes('/src/windows-launch.js'));
  assert.ok(REQUIRED_RUNTIME_FILES.includes('/assets/tray-light.ico'));
  assert.ok(FORBIDDEN_PACKAGE_PATHS.includes('/.githooks'));
  assert.ok(FORBIDDEN_PACKAGE_PATHS.includes('/.gitattributes'));
  assert.deepStrictEqual(credentialLikeEntries(['/wallhaven-key.json', '/main.js']), ['/wallhaven-key.json']);
  assert.deepStrictEqual(credentialLikeEntries([
    '/src/dev-token.json', '/src/.env', '/renderer/secret.key', '/node_modules/pkg/token.js'
  ]), ['/renderer/secret.key', '/src/.env', '/src/dev-token.json']);
  assert.deepStrictEqual(verifyRootBoundary(['/main.js', '/src/library.js'], false), ['main.js', 'src']);
  assert.throws(() => verifyRootBoundary(['/main.js', '/.tmp-leak.log'], false), /unexpected app\.asar root/);
  assert.throws(() => verifyRootBoundary(['/main.js', '/wallhaven-key.json'], false), /unexpected app\.asar root/);
  assert.deepStrictEqual(
    verifyRootBoundary(['/main.js', '/wallhaven-key.json', '/gelbooru-key.json'], true),
    ['gelbooru-key.json', 'main.js', 'wallhaven-key.json']
  );
  assert.deepStrictEqual(parseCli([], {}), {
    packageRoot: path.resolve(__dirname, '..', 'dist', 'Znada-win32-x64'), official: false
  });
  assert.throws(() => parseCli(['--official'], {}), /requires both/);
});

ok('package verifier follows the static first-party runtime dependency closure', () => {
  const files = new Map([
    ['/main.js', "require('./src/library');"],
    ['/preload.js', "require('./diagnostics/renderer/preload-attach');"],
    ['/src/library.js', "require('./path-key');"],
    ['/src/path-key.js', "module.exports = {};"],
    ['/renderer/index.html', '<link rel="stylesheet" href="styles.css"><script src="renderer.js"></script>'],
    ['/renderer/styles.css', 'body { color: black; }'],
    ['/renderer/renderer.js', 'window.ready = true;'],
  ]);
  const read = (repoPath) => files.get(repoPath);
  const closure = verifyRuntimeClosureEntries([...files.keys()], read);
  assert.ok(closure.includes('/src/library.js'));
  assert.ok(closure.includes('/src/path-key.js'));
  assert.ok(closure.includes('/renderer/styles.css'));
  const missing = new Map(files);
  missing.delete('/src/library.js');
  assert.throws(
    () => verifyRuntimeClosureEntries([...missing.keys()], (repoPath) => missing.get(repoPath)),
    /missing local runtime dependency: \/main\.js -> \.\/src\/library/,
  );
  const unstyled = new Map(files);
  unstyled.delete('/renderer/styles.css');
  assert.throws(
    () => verifyRuntimeClosureEntries([...unstyled.keys()], (repoPath) => unstyled.get(repoPath)),
    /missing local runtime dependency: \/renderer\/index\.html -> styles\.css/,
  );
});

ok('package verifier rejects every unapproved external resource', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-external-resources-'));
  try {
    const resources = path.join(fixture, 'resources');
    const helper = path.join(resources, 'thumbnail-helper');
    fs.mkdirSync(helper, { recursive: true });
    fs.writeFileSync(path.join(resources, 'app.asar'), 'fixture');
    fs.writeFileSync(path.join(helper, 'Znada.ThumbnailHelper.exe'), 'fixture');
    fs.writeFileSync(path.join(helper, 'source.sha256'), `${'a'.repeat(64)}\n`);
    assert.strictEqual(verifyExternalResources(fixture).helper,
      path.join(helper, 'Znada.ThumbnailHelper.exe'));
    fs.writeFileSync(path.join(helper, 'PRODUCTION-TOKEN.txt'), 'leak');
    assert.throws(() => verifyExternalResources(fixture), /must contain exactly/);
    fs.rmSync(path.join(helper, 'PRODUCTION-TOKEN.txt'));
    fs.writeFileSync(path.join(resources, 'debug.log'), 'leak');
    assert.throws(() => verifyExternalResources(fixture), /resources must contain exactly/);
  }
  finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

console.log(`\nAll ${passed} release-tooling tests passed.`);
