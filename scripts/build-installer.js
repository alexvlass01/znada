'use strict';

// Builds and then validates the three Squirrel.Windows release artifacts.
// Refuse to reuse a non-empty output directory: stale RELEASES/nupkg files can
// silently turn a valid build into a broken auto-update feed.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const electronInstaller = require('electron-winstaller');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE = require(path.join(ROOT, 'package.json'));
const OUTPUT_DIRECTORY = path.join(ROOT, 'dist', 'installer');
const SEVEN_ZIP = path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe');
const NUGET_VERSION = '6.14.3';
const NUGET_URL = `https://dist.nuget.org/win-x86-commandline/v${NUGET_VERSION}/nuget.exe`;
const NUGET_SHA256 = '8103c5666f63528d9fec59b53c5ae4b6feed7c8aec2930e344e870375f408a90';
// Иконка приложения в списке установленных программ Windows. Забирается по сети
// в момент установки, поэтому обязана быть публично доступной; `assets/` входит
// в публичный экспорт. Пока в публичном репозитории нет первого снимка, ссылка
// отвечает 404 — для локальной тестовой сборки это неважно, а перед релизом об
// этом предупреждает проверка ниже.
const INSTALLER_ICON_URL = 'https://raw.githubusercontent.com/alexvlass01/znada/main/assets/icon.ico';

// Не валит сборку: локальные keyless-сборки делаются задолго до публикации.
// Но молча выпустить релиз с иконкой Electron тоже нельзя — поэтому предупреждаем
// ровно тем текстом, который объясняет последствие.
async function warnIfIconUrlUnreachable(url) {
  const reachable = await new Promise((resolve) => {
    const request = https.request(url, { method: 'HEAD', timeout: 5000 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 400);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.end();
  });
  if (!reachable) {
    console.warn(`ВНИМАНИЕ: ${url} недоступен. В «Параметры → Приложения» Windows покажет иконку Electron.`);
    console.warn('Для релиза это дефект: сначала опубликовать snapshot, затем пересобрать установщик.');
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEmptyOrMissingDirectory(directory) {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), `Installer output is not a real directory: ${directory}`);
  invariant(fs.readdirSync(directory).length === 0,
    `Installer output must be absent or empty before build: ${directory}`);
}

function trimReleasesToCurrentFull({ outputDirectory = OUTPUT_DIRECTORY, version = PACKAGE.version } = {}) {
  const releasesPath = path.join(outputDirectory, 'RELEASES');
  const fullName = `Znada-${version}-full.nupkg`;
  invariant(fs.existsSync(releasesPath), 'RELEASES is missing after installer build.');
  const raw = fs.readFileSync(releasesPath, 'utf8').replace(/^\uFEFF/, '');
  const matching = raw.split(/\r?\n/).filter((line) => line.trim()).filter((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[1] === fullName;
  });
  invariant(matching.length === 1, `RELEASES must contain exactly one entry for ${fullName}.`);
  fs.writeFileSync(releasesPath, `${matching[0].trim()}\n`, 'utf8');
}

function sha1File(filename) {
  const hash = crypto.createHash('sha1');
  const fd = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function downloadFile(url, destination, redirects = 0) {
  invariant(redirects <= 5, `Too many redirects while downloading ${url}.`);
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'Znada-release-tooling' } }, (response) => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve(downloadFile(new URL(response.headers.location, url).toString(), destination, redirects + 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Pinned NuGet download failed with HTTP ${status || 'unknown'}.`));
        return;
      }
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      const fail = (error) => {
        output.destroy();
        reject(error);
      };
      response.on('error', fail);
      output.on('error', reject);
      output.on('finish', () => output.close(resolve));
      response.pipe(output);
    });
    request.on('error', reject);
    request.setTimeout(60_000, () => request.destroy(new Error('Pinned NuGet download timed out.')));
  });
}

async function ensurePinnedNuget({ root = ROOT } = {}) {
  const directory = path.join(root, '.build', `nuget-${NUGET_VERSION}`);
  const filename = path.join(directory, 'nuget.exe');
  if (fs.existsSync(filename) && sha256File(filename) === NUGET_SHA256) return filename;
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filename}.download`;
  fs.rmSync(temporary, { force: true });
  await downloadFile(NUGET_URL, temporary);
  const actual = sha256File(temporary);
  if (actual !== NUGET_SHA256) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Pinned NuGet SHA256 mismatch: expected ${NUGET_SHA256}, found ${actual}.`);
  }
  fs.rmSync(filename, { force: true });
  fs.renameSync(temporary, filename);
  return filename;
}

function prepareInstallerVendor({
  root = ROOT,
  sourceVendor = path.join(root, 'node_modules', 'electron-winstaller', 'vendor'),
  targetVendor = path.join(root, '.build', 'electron-winstaller-vendor'),
  nugetPath,
  expectedSha256 = NUGET_SHA256,
} = {}) {
  invariant(nugetPath && fs.existsSync(nugetPath) && fs.statSync(nugetPath).isFile(),
    'Pinned NuGet executable is missing.');
  invariant(sha256File(nugetPath) === expectedSha256, 'Pinned NuGet executable failed SHA256 verification.');
  const buildRoot = path.resolve(root, '.build');
  const resolvedTarget = path.resolve(targetVendor);
  const relative = path.relative(buildRoot, resolvedTarget);
  invariant(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `Installer vendor target escaped .build: ${resolvedTarget}`);
  invariant(fs.existsSync(sourceVendor) && fs.statSync(sourceVendor).isDirectory(),
    `electron-winstaller vendor directory is missing: ${sourceVendor}`);
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
  fs.cpSync(sourceVendor, resolvedTarget, { recursive: true });
  fs.copyFileSync(nugetPath, path.join(resolvedTarget, 'nuget.exe'));
  invariant(sha256File(path.join(resolvedTarget, 'nuget.exe')) === expectedSha256,
    'Prepared installer vendor contains the wrong NuGet executable.');
  return resolvedTarget;
}

function readRange(fd, offset, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, buffer, read, length - read, offset + read);
    invariant(count > 0, 'Unexpected end of ZIP file.');
    read += count;
  }
  return buffer;
}

// Minimal, fail-closed ZIP reader for the single nuspec entry we need. This
// avoids depending on an undeclared transitive ZIP package in release tooling.
function readZipEntry(filename, predicate) {
  const stat = fs.statSync(filename);
  invariant(stat.isFile() && stat.size > 0, `ZIP is missing or empty: ${filename}`);
  const fd = fs.openSync(filename, 'r');
  try {
    const tailLength = Math.min(stat.size, 65_557);
    const tail = readRange(fd, stat.size - tailLength, tailLength);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
    }
    invariant(eocd >= 0, 'ZIP end-of-central-directory record is missing.');
    const commentLength = tail.readUInt16LE(eocd + 20);
    invariant(eocd + 22 + commentLength === tail.length, 'Malformed ZIP end-of-central-directory record.');
    invariant(tail.readUInt16LE(eocd + 4) === 0 && tail.readUInt16LE(eocd + 6) === 0,
      'Multi-disk ZIP files are unsupported.');
    invariant(tail.readUInt16LE(eocd + 8) === tail.readUInt16LE(eocd + 10),
      'ZIP entry count differs across disks.');
    const entryCount = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    invariant(entryCount !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff,
      'ZIP64 packages are unsupported.');
    const eocdFileOffset = stat.size - tailLength + eocd;
    invariant(centralOffset + centralSize === eocdFileOffset,
      'ZIP central directory does not end at the expected offset.');
    const central = readRange(fd, centralOffset, centralSize);
    const matches = [];
    let offset = 0;
    let parsedEntries = 0;
    while (offset < central.length) {
      invariant(offset + 46 <= central.length && central.readUInt32LE(offset) === 0x02014b50,
        'Malformed ZIP central directory.');
      const flags = central.readUInt16LE(offset + 8);
      const method = central.readUInt16LE(offset + 10);
      const compressedSize = central.readUInt32LE(offset + 20);
      const uncompressedSize = central.readUInt32LE(offset + 24);
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const localOffset = central.readUInt32LE(offset + 42);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      invariant(end <= central.length, 'Malformed ZIP central directory entry.');
      const name = central.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      if (predicate(name)) {
        matches.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
      }
      parsedEntries++;
      offset = end;
    }
    invariant(parsedEntries === entryCount, 'ZIP entry count does not match central directory.');
    invariant(matches.length === 1, `Expected exactly one matching ZIP entry, found ${matches.length}.`);

    const entry = matches[0];
    invariant((entry.flags & 1) === 0, 'Encrypted ZIP entries are unsupported.');
    invariant(entry.compressedSize <= 4 * 1024 * 1024 && entry.uncompressedSize <= 4 * 1024 * 1024,
      'Nuspec ZIP entry is unexpectedly large.');
    const local = readRange(fd, entry.localOffset, 30);
    invariant(local.readUInt32LE(0) === 0x04034b50, 'Malformed ZIP local header.');
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    const localName = readRange(fd, entry.localOffset + 30, localNameLength).toString('utf8');
    invariant(localName === entry.name, 'ZIP local and central entry names differ.');
    const dataOffset = entry.localOffset + 30 + localNameLength + localExtraLength;
    const compressed = readRange(fd, dataOffset, entry.compressedSize);
    let bytes;
    if (entry.method === 0) bytes = compressed;
    else if (entry.method === 8) bytes = zlib.inflateRawSync(compressed);
    else throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
    invariant(bytes.length === entry.uncompressedSize, 'ZIP entry size does not match central directory.');
    return { name: entry.name, bytes };
  }
  finally { fs.closeSync(fd); }
}

function xmlValue(xml, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)<\\/${name}>`, 'i').exec(xml);
  invariant(match, `NuGet nuspec is missing <${name}>.`);
  return match[1].trim();
}

function readNuspecMetadata(nupkgPath) {
  const entry = readZipEntry(nupkgPath, (name) => /(?:^|\/)znada\.nuspec$/i.test(name));
  const xml = entry.bytes.toString('utf8').replace(/^\uFEFF/, '');
  return {
    id: xmlValue(xml, 'id'),
    version: xmlValue(xml, 'version'),
    title: xmlValue(xml, 'title'),
  };
}

function verifyArchiveIntegrity(filename, sevenZipPath = SEVEN_ZIP) {
  invariant(fs.existsSync(sevenZipPath) && fs.statSync(sevenZipPath).isFile(),
    `7-Zip verifier is missing from the declared electron-winstaller dependency: ${sevenZipPath}`);
  const result = spawnSync(sevenZipPath, ['t', '-bd', '-y', '-bb0', filename], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error) throw new Error(`NuGet package archive integrity test could not run: ${result.error.message}`);
  const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
  invariant(result.status === 0,
    `NuGet package archive integrity test failed${detail ? `: ${detail}` : '.'}`);
}

function verifyInstallerArtifacts({ outputDirectory = OUTPUT_DIRECTORY, version = PACKAGE.version } = {}) {
  const outputStat = fs.existsSync(outputDirectory) ? fs.lstatSync(outputDirectory) : null;
  invariant(outputStat && outputStat.isDirectory() && !outputStat.isSymbolicLink(),
    `Installer output directory is missing: ${outputDirectory}`);
  const setupName = 'Znada-Setup.exe';
  const nupkgName = `Znada-${version}-full.nupkg`;
  const expected = [setupName, 'RELEASES', nupkgName].sort();
  const actual = fs.readdirSync(outputDirectory).sort();
  invariant(JSON.stringify(actual) === JSON.stringify(expected),
    `Installer output must contain exactly ${expected.join(', ')}; found ${actual.join(', ') || '(empty)'}.`);
  for (const name of expected) {
    const stat = fs.lstatSync(path.join(outputDirectory, name));
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0,
      `Installer artifact is missing, empty or indirect: ${name}`);
  }

  const nupkgPath = path.join(outputDirectory, nupkgName);
  const releasesRaw = fs.readFileSync(path.join(outputDirectory, 'RELEASES'), 'utf8').replace(/^\uFEFF/, '');
  const lines = releasesRaw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  invariant(lines.length === 1, `RELEASES must contain exactly one non-empty line, found ${lines.length}.`);
  const release = /^([0-9a-f]{40})\s+(\S+)\s+(\d+)$/i.exec(lines[0]);
  invariant(release, 'RELEASES line must be SHA1, filename and byte size.');
  invariant(release[2] === nupkgName, `RELEASES filename ${release[2]} does not match ${nupkgName}.`);
  const nupkgSize = fs.statSync(nupkgPath).size;
  invariant(Number(release[3]) === nupkgSize, 'RELEASES byte size does not match the full nupkg.');
  invariant(release[1].toLowerCase() === sha1File(nupkgPath), 'RELEASES SHA1 does not match the full nupkg.');

  verifyArchiveIntegrity(nupkgPath);
  const nuspec = readNuspecMetadata(nupkgPath);
  invariant(nuspec.id === 'Znada', `NuGet package id must be Znada, found ${nuspec.id || '(empty)'}.`);
  invariant(nuspec.title === 'Znada', `NuGet package title must be Znada, found ${nuspec.title || '(empty)'}.`);
  invariant(nuspec.version === version,
    `NuGet package version ${nuspec.version || '(empty)'} does not match package.json ${version}.`);
  return { setupName, nupkgName, version, sha1: release[1].toLowerCase(), bytes: nupkgSize };
}

async function buildInstaller({ root = ROOT, version = PACKAGE.version } = {}) {
  const appDirectory = path.join(root, 'dist', 'Znada-win32-x64');
  const outputDirectory = path.join(root, 'dist', 'installer');
  invariant(fs.existsSync(appDirectory) && fs.lstatSync(appDirectory).isDirectory()
      && !fs.lstatSync(appDirectory).isSymbolicLink(),
    `Packaged application is missing: ${appDirectory}`);
  assertEmptyOrMissingDirectory(outputDirectory);
  // electron-winstaller 5.4 still bundles NuGet 2.8, which deterministically
  // throws "Can not access a closed Stream" while packing Electron 43's
  // dxcompiler.dll. Use one pinned Microsoft binary, verify its digest, and keep
  // the dependency's remaining Squirrel/rcedit tools unchanged.
  const nugetPath = await ensurePinnedNuget({ root });
  const vendorDirectory = prepareInstallerVendor({ root, nugetPath });

  await electronInstaller.createWindowsInstaller({
    appDirectory,
    outputDirectory,
    exe: 'Znada.exe',
    name: 'Znada',
    title: 'Znada',
    authors: 'alexv',
    setupExe: 'Znada-Setup.exe',
    setupIcon: path.join(root, 'assets', 'icon.ico'),
    // Иконка в «Параметры → Приложения». Без неё Windows показывает иконку
    // Electron: значение по умолчанию у electron-winstaller ссылается на
    // electron.ico в их репозитории. Принимается только публичный http(s) URL —
    // `file:` не годится, — и Windows забирает файл в момент установки.
    iconUrl: INSTALLER_ICON_URL,
    noMsi: true,
    vendorDirectory,
  });
  await warnIfIconUrlUnreachable(INSTALLER_ICON_URL);
  trimReleasesToCurrentFull({ outputDirectory, version });
  return verifyInstallerArtifacts({ outputDirectory, version });
}

async function main() {
  const result = await buildInstaller();
  console.log(`Installer verified: dist/installer/${result.setupName}, RELEASES, ${result.nupkgName}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Installer build failed: ${error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertEmptyOrMissingDirectory,
  buildInstaller,
  ensurePinnedNuget,
  NUGET_SHA256,
  NUGET_URL,
  NUGET_VERSION,
  prepareInstallerVendor,
  readNuspecMetadata,
  readZipEntry,
  sha1File,
  sha256File,
  trimReleasesToCurrentFull,
  verifyArchiveIntegrity,
  verifyInstallerArtifacts,
};
