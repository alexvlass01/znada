'use strict';

// One packaging entrypoint for both ordinary source builds and the official
// release build. Ordinary builds are deliberately keyless. The official mode
// is intentionally noisy and requires two independent opt-ins so a credential-
// bearing package cannot be produced by an accidental `npm run package`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OFFICIAL_ENV = 'ZNADA_OFFICIAL_BUILD';
const PROVIDER_FILES = Object.freeze(['wallhaven-key.json', 'gelbooru-key.json']);
const FIRST_PARTY_RUNTIME_ROOTS = Object.freeze(['assets', 'locales', 'renderer', 'src']);
const PRIVATE_SENTINELS = Object.freeze([
  '.git',
  'dist',
  '.tmp',
  'scratch',
  '.agents',
  '.codex',
  '.claude',
  'plans',
  '.github',
  '.githooks',
  'AGENTS.md',
  'CLAUDE.md',
  'ROADMAP.md',
  'STATUS.md',
  'Znada-DEV.bat',
  'Znada-DIAG.bat',
  'Znada-Review.bat',
  path.join('scripts', 'migrate-profile.js'),
]);

// These patterns are relative to the source directory, as required by
// @electron/packager. Keep this list explicit: it is also inspected by the
// package-boundary regression test.
const ALWAYS_IGNORED = Object.freeze([
  '^/\\.git(?:/|$)',
  '^/dist(?:/|$)',
  '^/diagnostics(?:/|$)',
  '^/native(?:/|$)',
  '^/scripts(?:/|$)',
  '^/\\.build(?:/|$)',
  '^/\\.tmp[^/]*(?:/|$)',
  '^/scratch(?:/|$)',
  '^/\\.agents(?:/|$)',
  '^/\\.codex(?:/|$)',
  '^/\\.claude(?:/|$)',
  '^/\\.github(?:/|$)',
  '^/\\.githooks(?:/|$)',
  '^/\\.gitattributes$',
  '^/\\.gitignore$',
  '^/\\.env(?:\\..*)?$',
  '^/plans(?:/|$)',
  '^/locales/state(?:/|$)',
  '^/locales/context(?:/|$)',
  '^/test(?:/|$)',
  '^/STATUS\\.md$',
  '^/ROADMAP\\.md$',
  '^/CLAUDE\\.md$',
  '^/AGENTS\\.md$',
  '^/Znada-DEV\\.bat$',
  '^/Znada-DIAG\\.bat$',
  '^/Znada-Review\\.bat$',
  // CODE-002 dev tooling: public, but no part of what a user installs.
  '^/eslint\\.config\\.js$',
  '^/tsconfig\\.json$',
]);
const KEYLESS_IGNORED = Object.freeze([
  '^/wallhaven-key\\.json$',
  '^/gelbooru-key\\.json$',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isSensitiveRuntimePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const basename = path.posix.basename(normalized);
  const foldedBasename = basename.toLowerCase();
  if (!basename) return false;
  // Windows package inputs are case-insensitive. Treating only the canonical
  // lower-case spelling as sensitive let a nested `GELBOORU-KEY.JSON` ride into
  // app.asar even though it is the same credential filename to Windows.
  if (PROVIDER_FILES.some((name) => name.toLowerCase() === foldedBasename)) return true;
  if (/^\.env(?:\.|$)/i.test(basename)) return true;
  if (/^(?:\.npmrc|\.pypirc|id_rsa|id_ed25519)$/i.test(basename)) return true;
  if (/(?:secret|credential|token|password)/i.test(basename)) return true;
  if (/(?:api|private|dev)[._-]?key/i.test(basename)) return true;
  return /\.(?:key|pem|pfx|p12)$/i.test(basename);
}

function findSensitiveSourceEntries(root) {
  const found = [];
  const inspect = (absolute, relative) => {
    const stat = fs.lstatSync(absolute);
    const normalized = relative.replace(/\\/g, '/');
    if (stat.isSymbolicLink()) {
      found.push(`${normalized} (symbolic link)`);
      return;
    }
    if (isSensitiveRuntimePath(normalized)) found.push(normalized);
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(absolute)) {
      inspect(path.join(absolute, entry), path.posix.join(normalized, entry));
    }
  };

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    // Only the canonical root spelling is an approved official-build input.
    // A case variant would not match the packager's keyless ignore patterns, so
    // fail before creating any artifact instead of relying on postpackage cleanup.
    if (PROVIDER_FILES.includes(entry.name)) continue;
    if (isSensitiveRuntimePath(entry.name) || entry.isSymbolicLink()) found.push(entry.name);
  }
  for (const name of FIRST_PARTY_RUNTIME_ROOTS) {
    const absolute = path.join(root, name);
    if (fs.existsSync(absolute)) inspect(absolute, name);
  }
  return [...new Set(found)].sort();
}

function assertSourceBoundary(root) {
  const sensitive = findSensitiveSourceEntries(root);
  invariant(sensitive.length === 0,
    `Packaging source contains a sensitive or indirect runtime entry: ${sensitive[0]}.`);
}

function validateProviderCredential(name, value) {
  invariant(isPlainObject(value), `${name}: expected a JSON object.`);
  const keys = Object.keys(value).sort();
  if (name === 'wallhaven-key.json') {
    invariant(keys.every((key) => key === '_comment' || key === 'apikey'),
      `${name}: unexpected field in credential input.`);
    invariant(typeof value.apikey === 'string' && value.apikey.trim().length >= 8,
      `${name}: apikey is missing or malformed.`);
    invariant(value._comment === undefined || typeof value._comment === 'string',
      `${name}: _comment must be a string when present.`);
    return;
  }
  if (name === 'gelbooru-key.json') {
    invariant(keys.length === 2 && keys[0] === 'apiKey' && keys[1] === 'userId',
      `${name}: expected exactly userId and apiKey.`);
    invariant(typeof value.userId === 'string' && /^\d+$/.test(value.userId.trim()),
      `${name}: userId is missing or malformed.`);
    invariant(typeof value.apiKey === 'string' && value.apiKey.trim().length >= 16,
      `${name}: apiKey is missing or malformed.`);
    return;
  }
  throw new Error(`Unknown provider credential input: ${name}`);
}

function readAndValidateProviderFile(root, name) {
  const filename = path.join(root, name);
  invariant(fs.existsSync(filename) && fs.statSync(filename).isFile(),
    `Official build requires ${name}.`);
  let value;
  try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (_) { throw new Error(`${name}: invalid JSON.`); }
  validateProviderCredential(name, value);
}

function assertSanitizedOfficialRoot(root) {
  const present = PRIVATE_SENTINELS.filter((entry) => fs.existsSync(path.join(root, entry)));
  invariant(present.length === 0,
    `Official build requires a sanitized public export; private sentinel present: ${present[0]}.`);
  const localEnvironmentFile = fs.readdirSync(root, { withFileTypes: true })
    .find((entry) => entry.isFile() && /^\.env(?:\.|$)/i.test(entry.name));
  invariant(!localEnvironmentFile,
    `Official build requires a sanitized public export; local environment file present: ${localEnvironmentFile?.name}.`);
  const localScratchEntry = fs.readdirSync(root, { withFileTypes: true })
    .find((entry) => /^\.tmp/i.test(entry.name));
  invariant(!localScratchEntry,
    `Official build requires a sanitized public export; temporary entry present: ${localScratchEntry?.name}.`);

  const publicIgnore = path.join(root, '.gitignore');
  invariant(fs.existsSync(publicIgnore) && fs.statSync(publicIgnore).isFile(),
    'Official build requires the generated .gitignore from a sanitized public export.');
  const publicIgnoreText = fs.readFileSync(publicIgnore, 'utf8');
  for (const marker of ['plans/', 'AGENTS.md', 'wallhaven-key.json', 'gelbooru-key.json']) {
    invariant(publicIgnoreText.split(/\r?\n/).map((line) => line.trim()).includes(marker),
      `Official build .gitignore is missing sanitized-export marker: ${marker}.`);
  }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }
  catch (_) { throw new Error('Official build requires a valid package.json in the sanitized export.'); }
  invariant(pkg.name === 'znada' && pkg.license === 'SEE LICENSE IN LICENSE'
      && typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version),
    'Official build package metadata does not match the Znada release identity.');

  const credentialLike = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /(?:key|secret|credential|token)/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  invariant(JSON.stringify(credentialLike) === JSON.stringify([...PROVIDER_FILES].sort()),
    'Official build root must contain exactly the two approved provider credential files.');
  for (const name of PROVIDER_FILES) readAndValidateProviderFile(root, name);
}

function resolveMode(argv = process.argv.slice(2), env = process.env, root = ROOT) {
  const unknown = argv.filter((arg) => arg !== '--official');
  invariant(unknown.length === 0, `Unknown package option: ${unknown[0]}`);
  const flag = argv.includes('--official');
  const envOptIn = String(env[OFFICIAL_ENV] || '') === '1';
  invariant(flag === envOptIn,
    `Official packaging requires both --official and ${OFFICIAL_ENV}=1; ordinary packaging requires neither.`);
  if (flag) assertSanitizedOfficialRoot(root);
  assertSourceBoundary(root);
  return { official: flag };
}

function buildPackagerArgs({ root = ROOT, official = false } = {}) {
  const packager = path.join(root, 'node_modules', '@electron', 'packager', 'bin', 'electron-packager.mjs');
  const args = [
    packager,
    '.',
    'Znada',
    '--platform=win32',
    '--arch=x64',
    '--icon=assets/icon.ico',
    '--out=dist',
    '--overwrite',
    '--app-copyright=Copyright (c) 2026 alexv. All rights reserved.',
    '--extra-resource=.build/thumbnail-helper',
  ];
  for (const pattern of [...ALWAYS_IGNORED, ...(official ? [] : KEYLESS_IGNORED)]) {
    args.push(`--ignore=${pattern}`);
  }
  return args;
}

function run(argv = process.argv.slice(2), env = process.env, root = ROOT) {
  const { official } = resolveMode(argv, env, root);
  const args = buildPackagerArgs({ root, official });
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Electron packaging failed with exit code ${result.status}.`);
  console.log(`Znada package completed (${official ? 'official credential-bearing' : 'keyless'} mode).`);
}

if (require.main === module) {
  try { run(); }
  catch (error) {
    console.error(`Package failed: ${error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  ALWAYS_IGNORED,
  FIRST_PARTY_RUNTIME_ROOTS,
  KEYLESS_IGNORED,
  OFFICIAL_ENV,
  PRIVATE_SENTINELS,
  PROVIDER_FILES,
  assertSanitizedOfficialRoot,
  assertSourceBoundary,
  buildPackagerArgs,
  findSensitiveSourceEntries,
  isSensitiveRuntimePath,
  resolveMode,
  validateProviderCredential,
};
