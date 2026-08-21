'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pkg = require('../package.json');
const {
  ALWAYS_IGNORED,
  KEYLESS_IGNORED,
  OFFICIAL_ENV,
  assertSourceBoundary,
  buildPackagerArgs,
  findSensitiveSourceEntries,
  resolveMode,
  validateProviderCredential,
} = require('../scripts/package-app');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  OK ' + name);
  passed++;
};

function packageIgnorePatterns() {
  return [...ALWAYS_IGNORED, ...KEYLESS_IGNORED].map((entry) => new RegExp(entry));
}

const ignorePatterns = packageIgnorePatterns();

ok('package command excludes dev-only diagnostics directory',
  ignorePatterns.some((pattern) => pattern.test('/diagnostics/core/session.js')));
ok('package command keeps production-safe diagnostics gate',
  !ignorePatterns.some((pattern) => pattern.test('/src/diagnostics-gate.js')));
// Privacy boundary: internal agent handoff docs and scratch dirs must never ship
// inside the public installer (they used to leak into app.asar until v1.4.6).
// `/scratch/x` joined the list on 2026-07-29: the folder sat in the repo root unignored by
// both git and the packager, so anything dropped there would have ridden into app.asar. It
// was empty at the time, which is exactly why nobody noticed — the v1.4.6 leak started the
// same way.
for (const leak of ['/plans/index.md', '/STATUS.md', '/ROADMAP.md', '/CLAUDE.md', '/AGENTS.md', '/.tmp/x', '/.tmp-stealth-ui.err.log', '/scratch/x', '/.agents', '/.codex', '/test/config.test.js', '/Znada-DEV.bat', '/Znada-DIAG.bat']) {
  ok(`package command excludes ${leak}`,
    ignorePatterns.some((pattern) => pattern.test(leak)));
}
// Translation freshness state is agent/maintenance bookkeeping, not runtime data:
// the app must still get its dictionaries, but the sidecar has no business shipping.
ok('package command excludes the i18n state sidecar',
  ignorePatterns.some((pattern) => pattern.test('/locales/state/de.json')));
ok('package command excludes generated and manual i18n context',
  ignorePatterns.some((pattern) => pattern.test('/locales/context/generated.json'))
  && ignorePatterns.some((pattern) => pattern.test('/locales/context/manual.json')));
ok('package command still ships the runtime dictionaries',
  !ignorePatterns.some((pattern) => pattern.test('/locales/de.json'))
  && !ignorePatterns.some((pattern) => pattern.test('/locales/en.json')));
ok('package command excludes thumbnail helper sources, build scripts and intermediate tree',
  ignorePatterns.some((pattern) => pattern.test('/native/thumbnail-helper/Program.cs'))
  && ignorePatterns.some((pattern) => pattern.test('/scripts/build-thumbnail-helper.js'))
  && ignorePatterns.some((pattern) => pattern.test('/.build/thumbnail-helper/build.json')));
ok('package command ships the compiled thumbnail helper as an extra resource',
  buildPackagerArgs().includes('--extra-resource=.build/thumbnail-helper'));
ok('default package is keyless while official mode admits only the approved inputs',
  KEYLESS_IGNORED.every((pattern) => buildPackagerArgs().includes(`--ignore=${pattern}`))
  && KEYLESS_IGNORED.every((pattern) => !buildPackagerArgs({ official: true }).includes(`--ignore=${pattern}`)));
ok('default package command delegates to the fail-closed wrapper',
  pkg.scripts.package === 'node scripts/package-app.js');
ok('package lifecycle verifies the compiled helper after packing',
  pkg.scripts.postpackage === 'node scripts/verify-thumbnail-package.js');
ok('official package and verifier each require the explicit credential-bearing opt-in',
  /ZNADA_OFFICIAL_BUILD=1/.test(pkg.scripts['package:official'])
  && /package-app\.js --official/.test(pkg.scripts['package:official'])
  && /ZNADA_OFFICIAL_BUILD=1/.test(pkg.scripts['postpackage:official'])
  && /verify-thumbnail-package\.js --official/.test(pkg.scripts['postpackage:official']));
ok('official installer is chained through the verified official package lifecycle',
  pkg.scripts['installer:official'] === 'npm run package:official && node scripts/build-installer.js');
ok('package command still ships runtime dirs',
  !ignorePatterns.some((pattern) => pattern.test('/src/library.js'))
  && !ignorePatterns.some((pattern) => pattern.test('/renderer/renderer.js'))
  && !ignorePatterns.some((pattern) => pattern.test('/locales/en.json'))
  && !ignorePatterns.some((pattern) => pattern.test('/src/thumbnail-host.js')));
// index.html грузит и файлы ВНЕ renderer/ (например общий с main src/next-change.js).
// Такой скрипт ломается тихо: в собранном приложении он просто не найдётся, глобали не
// будет, а интерфейс молча свалится в запасной текст. Поэтому каждая ссылка «наружу»
// обязана существовать и не попадать под исключения упаковщика.
{
  const indexHtml = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
  const outside = [...indexHtml.matchAll(/<script\s+src="(\.\.\/[^"]+)"/g)].map((m) => m[1]);
  ok('renderer scripts outside renderer/ exist and are packaged', outside.every((rel) => {
    const packaged = `/${rel.replace(/^\.\.\//, '')}`;
    return fs.existsSync(require.resolve(`../renderer/${rel}`))
      && !ignorePatterns.some((pattern) => pattern.test(packaged));
  }));
}

ok('diagnostics launcher does not enable Cloud staging',
  !/ZNADA_CLOUD=staging/.test(pkg.scripts['dev:diagnostics']));
ok('diagnostics launcher requires env and CLI opt-in',
  /ZNADA_DIAGNOSTICS=1/.test(pkg.scripts['dev:diagnostics']) &&
  /--diagnostics/.test(pkg.scripts['dev:diagnostics']));

{
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-package-boundary-'));
  try {
    fs.writeFileSync(path.join(fixture, '.gitignore'),
      [`plans${path.posix.sep}`, 'AGENTS.md', 'wallhaven-key.json', 'gelbooru-key.json', ''].join('\n'), 'utf8');
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
      name: 'znada', version: '1.6.0', license: 'SEE LICENSE IN LICENSE'
    }), 'utf8');
    fs.writeFileSync(path.join(fixture, 'wallhaven-key.json'), JSON.stringify({ apikey: 'fixture-wallhaven' }), 'utf8');
    fs.writeFileSync(path.join(fixture, 'gelbooru-key.json'), JSON.stringify({
      userId: '123', apiKey: 'fixture-gelbooru-key'
    }), 'utf8');
    ok('ordinary packaging needs no release opt-in', !resolveMode([], {}, fixture).official);
    ok('official packaging requires both independent opt-ins',
      resolveMode(['--official'], { [OFFICIAL_ENV]: '1' }, fixture).official);
    assert.throws(() => resolveMode(['--official'], {}, fixture), /requires both/);
    assert.throws(() => resolveMode([], { [OFFICIAL_ENV]: '1' }, fixture), /requires both/);
    fs.writeFileSync(path.join(fixture, 'release-token.txt'), 'fixture', 'utf8');
    assert.throws(() => resolveMode(['--official'], { [OFFICIAL_ENV]: '1' }, fixture), /exactly the two approved/);
    ok('unapproved credential-like official input fails closed', true);
    fs.rmSync(path.join(fixture, 'release-token.txt'));
    fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'src', 'dev-token.json'), '{}', 'utf8');
    assert.deepStrictEqual(findSensitiveSourceEntries(fixture), ['src/dev-token.json']);
    assert.throws(() => assertSourceBoundary(fixture), /sensitive or indirect runtime entry/);
    fs.rmSync(path.join(fixture, 'src', 'dev-token.json'));
    fs.writeFileSync(path.join(fixture, 'src', 'GELBOORU-KEY.JSON'), '{}', 'utf8');
    assert.throws(() => assertSourceBoundary(fixture), /GELBOORU-KEY\.JSON/);
    fs.rmSync(path.join(fixture, 'src', 'GELBOORU-KEY.JSON'));
    fs.rmSync(path.join(fixture, 'gelbooru-key.json'));
    fs.writeFileSync(path.join(fixture, 'GELBOORU-KEY.JSON'), '{}', 'utf8');
    assert.throws(() => assertSourceBoundary(fixture), /GELBOORU-KEY\.JSON/);
    fs.rmSync(path.join(fixture, 'GELBOORU-KEY.JSON'));
    fs.writeFileSync(path.join(fixture, 'gelbooru-key.json'), JSON.stringify({
      userId: '123', apiKey: 'fixture-gelbooru-key'
    }), 'utf8');
    ok('provider credential filenames are sensitive regardless of Windows casing', true);
    fs.mkdirSync(path.join(fixture, 'renderer'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'renderer', '.env.local'), 'fixture', 'utf8');
    assert.throws(() => resolveMode([], {}, fixture), /renderer\/\.env\.local/);
    ok('nested first-party credentials and environment files fail closed', true);
  }
  finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}

ok('provider credential schemas reject unknown or malformed fields', (() => {
  validateProviderCredential('wallhaven-key.json', { apikey: 'fixture-wallhaven' });
  validateProviderCredential('gelbooru-key.json', { userId: '123', apiKey: 'fixture-gelbooru-key' });
  assert.throws(() => validateProviderCredential('wallhaven-key.json', {
    apikey: 'fixture-wallhaven', token: 'unexpected'
  }), /unexpected field/);
  assert.throws(() => validateProviderCredential('gelbooru-key.json', {
    userId: 123, apiKey: 'fixture-gelbooru-key'
  }), /userId/);
  return true;
})());

const controlHtml = fs.readFileSync(require.resolve('../diagnostics/ui/control.html'), 'utf8');
const controlJs = fs.readFileSync(require.resolve('../diagnostics/ui/control.js'), 'utf8');
const controlPreload = fs.readFileSync(require.resolve('../diagnostics/ui/control-preload.js'), 'utf8');
const mainJs = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const installerJs = fs.readFileSync(require.resolve('../scripts/build-installer.js'), 'utf8');
ok('diagnostics control exposes a dedicated force-delivery notification test',
  /id="btnTestNotification"/.test(controlHtml)
  && /api\.testNotification\(\)/.test(controlJs)
  && /diagnostics-test-notification/.test(controlPreload));
ok('force-delivery copy explains that it does not create a fake journal failure',
  /без записи ложного сбоя в журнал/.test(controlHtml));
ok('Windows notification identity matches the Squirrel shortcut identity',
  /WINDOWS_APP_USER_MODEL_ID\s*=\s*['"]com\.squirrel\.Znada\.Znada['"]/.test(mainJs)
  && /app\.whenReady\(\)\.then\(async \(\) => \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*if \(process\.platform === 'win32'\) app\.setAppUserModelId\(WINDOWS_APP_USER_MODEL_ID\)/.test(mainJs)
  && /name:\s*['"]Znada['"]/.test(installerJs)
  && /exe:\s*['"]Znada\.exe['"]/.test(installerJs));

console.log('\nAll ' + passed + ' diagnostics package-boundary tests passed.');
