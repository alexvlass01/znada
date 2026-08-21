'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'native', 'thumbnail-helper');
const buildDir = path.join(root, '.build', 'thumbnail-helper');
const outputPath = path.join(buildDir, 'Znada.ThumbnailHelper.exe');
const fingerprintPath = path.join(buildDir, 'source.sha256');
const sources = ['Protocol.cs', 'ShellInterop.cs', 'Program.cs'].map((name) => path.join(sourceDir, name));
const BUILD_OUTPUT_ALLOWLIST = new Set(['Znada.ThumbnailHelper.exe', 'source.sha256']);

function cleanBuildDirectory(directory = buildDir) {
  fs.mkdirSync(directory, { recursive: true });
  for (const entry of fs.readdirSync(directory)) {
    if (BUILD_OUTPUT_ALLOWLIST.has(entry)) continue;
    fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  }
}

function findCompiler() {
  const windows = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function firstAssemblyIn(directory, name) {
  if (!fs.existsSync(directory)) return '';
  const direct = path.join(directory, name);
  if (fs.existsSync(direct)) return direct;
  for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const candidate = path.join(directory, child.name, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function findReferences(compiler) {
  const windows = process.env.WINDIR || 'C:\\Windows';
  const frameworkDir = path.dirname(compiler);
  const references = [
    path.join(frameworkDir, 'System.Web.Extensions.dll'),
    firstAssemblyIn(path.join(windows, 'Microsoft.NET', 'assembly', 'GAC_MSIL', 'WindowsBase'), 'WindowsBase.dll'),
    firstAssemblyIn(path.join(windows, 'Microsoft.NET', 'assembly', 'GAC_64', 'PresentationCore'), 'PresentationCore.dll')
      || firstAssemblyIn(path.join(windows, 'Microsoft.NET', 'assembly', 'GAC_32', 'PresentationCore'), 'PresentationCore.dll'),
    firstAssemblyIn(path.join(windows, 'Microsoft.NET', 'assembly', 'GAC_MSIL', 'System.Xaml'), 'System.Xaml.dll'),
  ];
  const missing = references.find((reference) => !reference || !fs.existsSync(reference));
  if (missing !== undefined) {
    throw new Error('required .NET Framework desktop reference assemblies were not found');
  }
  return references;
}

function fingerprint(compiler, references) {
  const hash = crypto.createHash('sha256');
  hash.update('znada-thumbnail-helper-build-v1\0');
  hash.update(fs.readFileSync(__filename));
  hash.update(compiler);
  for (const reference of references) hash.update('\0' + reference);
  for (const source of sources) {
    hash.update('\0' + path.basename(source) + '\0');
    hash.update(fs.readFileSync(source));
  }
  return hash.digest('hex');
}

function verifyHelper(exePath) {
  const result = spawnSync(exePath, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !/Znada\.ThumbnailHelper\s+\S+\s+protocol=1/.test(result.stdout || '')) {
    throw new Error('thumbnail helper verification failed (exit ' + result.status + '): '
      + (result.stderr || result.stdout || '').trim());
  }
  return (result.stdout || '').trim();
}

function build() {
  if (process.platform !== 'win32') {
    throw new Error('Znada thumbnail helper can only be built on Windows');
  }
  for (const source of sources) {
    if (!fs.existsSync(source)) throw new Error('missing thumbnail helper source: ' + source);
  }

  const compiler = findCompiler();
  if (!compiler) throw new Error('C# compiler not found in Windows .NET Framework');
  const references = findReferences(compiler);
  cleanBuildDirectory(buildDir);

  const nextFingerprint = fingerprint(compiler, references);
  const currentFingerprint = fs.existsSync(fingerprintPath)
    ? fs.readFileSync(fingerprintPath, 'utf8').trim()
    : '';

  if (currentFingerprint !== nextFingerprint || !fs.existsSync(outputPath)) {
    const temporaryPath = path.join(buildDir, 'Znada.ThumbnailHelper.' + process.pid + '.tmp.exe');
    const args = [
      '/nologo',
      '/target:exe',
      '/platform:x64',
      '/optimize+',
      '/debug-',
      '/out:' + temporaryPath,
    ].concat(references.map((reference) => '/reference:' + reference), sources);
    const result = spawnSync(compiler, args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || !fs.existsSync(temporaryPath)) {
      throw new Error('thumbnail helper compile failed (exit ' + result.status + '):\n'
        + (result.stdout || '') + (result.stderr || ''));
    }
    try {
      verifyHelper(temporaryPath);
      fs.rmSync(outputPath, { force: true });
      fs.renameSync(temporaryPath, outputPath);
      fs.writeFileSync(fingerprintPath, nextFingerprint + '\n', 'utf8');
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }

  const version = verifyHelper(outputPath);
  console.log('Thumbnail helper ready: ' + path.relative(root, outputPath) + ' (' + version + ')');
  return outputPath;
}

if (require.main === module) {
  try {
    build();
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exit(1);
  }
}

module.exports = { BUILD_OUTPUT_ALLOWLIST, build, cleanBuildDirectory, findCompiler, findReferences, outputPath };
