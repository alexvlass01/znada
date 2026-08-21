'use strict';

// Verifies the runtime boundary of the packaged application, not only the
// thumbnail helper. The default package must be credential-free. An official
// package is accepted only with the same explicit two-part opt-in used by the
// packaging entrypoint.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');
const {
  OFFICIAL_ENV,
  PROVIDER_FILES,
  isSensitiveRuntimePath,
  validateProviderCredential,
} = require('./package-app');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PACKAGE_ROOT = path.join(ROOT, 'dist', 'Znada-win32-x64');
const ALLOWED_RUNTIME_ROOTS = Object.freeze([
  'LICENSE',
  'README.md',
  'assets',
  'locales',
  'main.js',
  'node_modules',
  'package.json',
  'preload.js',
  'renderer',
  'src',
]);
const REQUIRED_RUNTIME_FILES = Object.freeze([
  '/main.js',
  '/preload.js',
  '/package.json',
  '/src/hotkey.js',
  '/src/thumbnail-host.js',
  '/src/windows-launch.js',
  '/renderer/index.html',
  '/renderer/renderer.js',
  '/renderer/viewer.html',
  '/renderer/viewer-preload.js',
  '/renderer/viewer.js',
  '/locales/en.json',
  '/locales/ru.json',
  '/assets/icon.ico',
  '/assets/icon.png',
  '/assets/tray-light.ico',
  '/assets/tray-dark.ico',
]);
const OPTIONAL_LOCAL_DEPENDENCIES = Object.freeze([
  // Deliberately absent from an ordinary keyless package. main.js reads them
  // inside try/catch and the official package admits exactly these two files.
  '/wallhaven-key.json',
  '/gelbooru-key.json',
  // Dev-only diagnostics are guarded by diagnostics-gate and intentionally
  // excluded from every user package.
  '/diagnostics/',
]);
const FORBIDDEN_PACKAGE_PATHS = Object.freeze([
  '/native',
  '/.build',
  '/scripts',
  '/plans',
  '/test',
  '/diagnostics',
  '/.git',
  '/.githooks',
  '/.gitattributes',
  '/.gitignore',
  '/.github',
  '/STATUS.md',
  '/ROADMAP.md',
  '/CLAUDE.md',
  '/AGENTS.md',
  '/Znada-DEV.bat',
  '/Znada-DIAG.bat',
]);

function fail(message) {
  throw new Error(`package verification failed: ${message}`);
}

function parseCli(argv = process.argv.slice(2), env = process.env) {
  let packageRoot = DEFAULT_PACKAGE_ROOT;
  let packageRootSeen = false;
  let officialFlag = false;
  for (const arg of argv) {
    if (arg === '--official') {
      officialFlag = true;
      continue;
    }
    if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
    if (packageRootSeen) fail(`unexpected argument: ${arg}`);
    packageRoot = path.resolve(arg);
    packageRootSeen = true;
  }
  const envOptIn = String(env[OFFICIAL_ENV] || '') === '1';
  if (officialFlag !== envOptIn) {
    fail(`official verification requires both --official and ${OFFICIAL_ENV}=1; default verification requires neither`);
  }
  return { packageRoot, official: officialFlag };
}

function normalizeAsarEntries(appAsar) {
  return asar.listPackage(appAsar).map((entry) => entry.replace(/\\/g, '/'));
}

function parseAsarJson(appAsar, repoPath) {
  let raw;
  try { raw = asar.extractFile(appAsar, repoPath.replace(/^\//, '')); }
  catch (_) { fail(`cannot extract ${repoPath} from app.asar`); }
  try { return JSON.parse(raw.toString('utf8')); }
  catch (_) { fail(`${repoPath} in app.asar is not valid JSON`); }
}

function verifyPackageMetadata(appAsar, sourcePackagePath = path.join(ROOT, 'package.json')) {
  const source = JSON.parse(fs.readFileSync(sourcePackagePath, 'utf8'));
  const packaged = parseAsarJson(appAsar, '/package.json');
  for (const field of ['name', 'version', 'license', 'main']) {
    if (packaged[field] !== source[field]) {
      fail(`packaged package.json ${field} does not match source package.json`);
    }
  }
  if (packaged.name !== 'znada') fail('packaged package.json name must be znada');
  if (packaged.main !== 'main.js') fail('packaged package.json main must be main.js');
  return packaged;
}

function credentialLikeEntries(entries) {
  return entries.filter((entry) => {
    const normalized = entry.replace(/\\/g, '/');
    if (/^\/node_modules(?:\/|$)/i.test(normalized)) return false;
    return isSensitiveRuntimePath(normalized);
  }).sort();
}

function verifyRootBoundary(entries, official) {
  const allowed = new Set(ALLOWED_RUNTIME_ROOTS);
  if (official) for (const name of PROVIDER_FILES) allowed.add(name);
  const roots = [...new Set(entries
    .map((entry) => entry.replace(/^\/+/, '').split('/')[0])
    .filter(Boolean))].sort();
  const unexpected = roots.filter((name) => !allowed.has(name));
  if (unexpected.length > 0) fail(`unexpected app.asar root: ${unexpected[0]}`);
  return roots;
}

function verifyCredentialBoundary(appAsar, entries, official) {
  const expected = official ? PROVIDER_FILES.map((name) => `/${name}`).sort() : [];
  const actual = credentialLikeEntries(entries);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(official
      ? 'official package must contain exactly the two approved provider credential files'
      : 'default package contains a credential or sensitive runtime file');
  }

  for (const name of PROVIDER_FILES) {
    const repoPath = `/${name}`;
    if (!official && entries.includes(repoPath)) fail(`default package contains ${name}`);
    if (!official) continue;
    if (!entries.includes(repoPath)) fail(`official package is missing ${name}`);
    validateProviderCredential(name, parseAsarJson(appAsar, repoPath));
  }
}

function resolveLocalDependency(fromPath, request, entries) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), request));
  if (!base.startsWith('/')) fail(`local dependency escaped app.asar: ${fromPath} -> ${request}`);
  const extension = path.posix.extname(base);
  const candidates = extension
    ? [base]
    : [`${base}.js`, `${base}.json`, `${base}.cjs`, path.posix.join(base, 'index.js'), path.posix.join(base, 'index.json')];
  return candidates.find((candidate) => entries.has(candidate)) || base;
}

function isOptionalLocalDependency(repoPath) {
  return OPTIONAL_LOCAL_DEPENDENCIES.some((entry) => (
    entry.endsWith('/') ? repoPath.startsWith(entry) : repoPath === entry
  ));
}

// Verify the static first-party JavaScript/HTML dependency graph, not only a
// hand-picked list of sentinels. This catches a package where main.js exists but
// one of the modules it immediately requires (for example src/library.js) was
// accidentally excluded. Dynamic resources still have explicit sentinels and
// dedicated runtime tests; optional credentials/diagnostics are documented above.
function verifyRuntimeClosureEntries(rawEntries, readText) {
  const entries = new Set(rawEntries.map((entry) => entry.replace(/\\/g, '/')));
  const queue = ['/main.js', '/preload.js'];
  for (const entry of entries) {
    if (/\.html$/i.test(entry)) queue.push(entry);
  }
  const visited = new Set();

  while (queue.length) {
    const repoPath = queue.shift();
    if (visited.has(repoPath)) continue;
    if (!entries.has(repoPath)) fail(`runtime closure entry is missing: ${repoPath}`);
    visited.add(repoPath);
    if (!/\.(?:js|cjs|html|css)$/i.test(repoPath)) continue;

    let text;
    try { text = String(readText(repoPath)); }
    catch (_) { fail(`cannot read runtime closure entry: ${repoPath}`); }
    const requests = [];
    if (/\.html$/i.test(repoPath)) {
      for (const match of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/gi)) {
        const request = match[2].trim();
        if (request.startsWith('.') || !/^[a-z][a-z0-9+.-]*:/i.test(request)) requests.push(request);
      }
      for (const match of text.matchAll(/<link\b[^>]*>/gi)) {
        const tag = match[0];
        if (!/\brel\s*=\s*(["'])[^"']*\bstylesheet\b[^"']*\1/i.test(tag)) continue;
        const href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(tag);
        if (href) requests.push(href[2].trim());
      }
      for (const match of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/gi)) {
        requests.push(match[2].trim());
      }
    } else if (/\.css$/i.test(repoPath)) {
      for (const match of text.matchAll(/(?:@import\s+|url\(\s*)(["']?)([^"')\s]+)\1/gi)) {
        requests.push(match[2].trim());
      }
    } else {
      for (const match of text.matchAll(/\brequire\s*\(\s*(["'])(\.{1,2}\/[^"']+)\1\s*\)/g)) {
        requests.push(match[2]);
      }
    }

    for (const request of requests) {
      if (!request || request.startsWith('#') || /^https?:/i.test(request)) continue;
      const resolved = resolveLocalDependency(repoPath, request, entries);
      if (!entries.has(resolved)) {
        if (isOptionalLocalDependency(resolved)) continue;
        fail(`missing local runtime dependency: ${repoPath} -> ${request} (${resolved})`);
      }
      if (/\.(?:js|cjs|html|css)$/i.test(resolved)) queue.push(resolved);
    }
  }
  return [...visited].sort();
}

function verifyRuntimeClosure(appAsar, entries) {
  return verifyRuntimeClosureEntries(entries, (repoPath) => (
    asar.extractFile(appAsar, repoPath.replace(/^\//, '').split('/').join(path.sep)).toString('utf8')
  ));
}

function verifyExternalResources(packageRoot) {
  const resources = path.join(packageRoot, 'resources');
  let roots;
  try { roots = fs.readdirSync(resources, { withFileTypes: true }); }
  catch (_) { fail('resources directory is missing or unreadable'); }
  const actualRoots = roots.map((entry) => entry.name).sort();
  if (JSON.stringify(actualRoots) !== JSON.stringify(['app.asar', 'thumbnail-helper'])) {
    fail(`resources must contain exactly app.asar and thumbnail-helper, found: ${actualRoots.join(', ')}`);
  }
  const asarEntry = roots.find((entry) => entry.name === 'app.asar');
  const helperEntry = roots.find((entry) => entry.name === 'thumbnail-helper');
  if (!asarEntry?.isFile() || asarEntry.isSymbolicLink()) fail('resources/app.asar must be a regular file');
  if (!helperEntry?.isDirectory() || helperEntry.isSymbolicLink()) {
    fail('resources/thumbnail-helper must be a real directory');
  }
  const helperDir = path.join(resources, 'thumbnail-helper');
  const helperEntries = fs.readdirSync(helperDir, { withFileTypes: true });
  const helperNames = helperEntries.map((entry) => entry.name).sort();
  if (JSON.stringify(helperNames) !== JSON.stringify(['Znada.ThumbnailHelper.exe', 'source.sha256'])) {
    fail(`thumbnail-helper resources must contain exactly the executable and fingerprint, found: ${helperNames.join(', ')}`);
  }
  for (const entry of helperEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) fail(`thumbnail-helper resource is indirect: ${entry.name}`);
  }
  const fingerprint = fs.readFileSync(path.join(helperDir, 'source.sha256'), 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(fingerprint)) fail('thumbnail-helper source fingerprint is malformed');
  return {
    appAsar: path.join(resources, 'app.asar'),
    helper: path.join(helperDir, 'Znada.ThumbnailHelper.exe'),
  };
}

function verifyPackage({ packageRoot = DEFAULT_PACKAGE_ROOT, official = false, sourcePackagePath } = {}) {
  const { helper, appAsar } = verifyExternalResources(packageRoot);
  const executable = path.join(packageRoot, 'Znada.exe');

  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) fail('Znada.exe is missing');
  if (!fs.existsSync(helper) || !fs.statSync(helper).isFile()) fail('compiled thumbnail helper is missing from resources');
  if (!fs.existsSync(appAsar) || !fs.statSync(appAsar).isFile()) fail('app.asar is missing');

  const version = spawnSync(helper, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  if (version.error) throw version.error;
  if (version.status !== 0 || !/Znada\.ThumbnailHelper\s+\S+\s+protocol=1/.test(version.stdout || '')) {
    fail('packaged helper did not pass its version handshake');
  }

  const entries = normalizeAsarEntries(appAsar);
  if (entries.some((entry) => /^\/\.env(?:\.|$)/i.test(entry))) {
    fail('environment file leaked into app.asar');
  }
  for (const forbidden of FORBIDDEN_PACKAGE_PATHS) {
    if (entries.some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`))) {
      fail(`development-only path leaked into app.asar: ${forbidden}`);
    }
  }
  verifyRootBoundary(entries, official);
  for (const required of REQUIRED_RUNTIME_FILES) {
    if (!entries.includes(required)) fail(`required runtime file is missing: ${required}`);
  }
  verifyRuntimeClosure(appAsar, entries);

  const packaged = verifyPackageMetadata(appAsar, sourcePackagePath);
  verifyCredentialBoundary(appAsar, entries, official);
  return {
    packageRoot,
    official,
    version: packaged.version,
    helper,
    entryCount: entries.length,
  };
}

function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseCli(argv, env);
  const result = verifyPackage(options);
  console.log(`Packaged Znada verified (${result.official ? 'official credential-bearing' : 'keyless'} mode, ${result.entryCount} asar entries, version ${result.version}).`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_RUNTIME_ROOTS,
  FORBIDDEN_PACKAGE_PATHS,
  OPTIONAL_LOCAL_DEPENDENCIES,
  REQUIRED_RUNTIME_FILES,
  credentialLikeEntries,
  normalizeAsarEntries,
  parseCli,
  verifyCredentialBoundary,
  verifyPackage,
  verifyPackageMetadata,
  verifyRootBoundary,
  verifyRuntimeClosure,
  verifyRuntimeClosureEntries,
  verifyExternalResources,
};
