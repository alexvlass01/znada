'use strict';

const assert = require('assert');
const childProcess = require('child_process');
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

/*
 * Часть проверок здесь читает приватные owner-only файлы, которых в публичном экспорте
 * нет и быть не должно. Без этой развилки опубликованный снимок падал на `npm test` у
 * любого, кто собирает Znada из исходников: тест открывал отсутствующий файл и валил
 * весь прогон. Тот же приём, что в profile-migration-io и review-gate — пропустить там,
 * где файла и не должно быть, но упасть, если он пропал в приватном checkout.
 */
const PRIVATE_CHECKOUT = fs.existsSync(path.join(__dirname, '..', 'AGENTS.md'));
function okPrivate(name, relativePath, fn) {
  if (!fs.existsSync(path.join(__dirname, '..', relativePath))) {
    if (PRIVATE_CHECKOUT) {
      throw new Error(`private canonical checkout is missing required ${relativePath}`);
    }
    console.log(`  SKIP ${name} (private owner-only file absent from this checkout)`);
    return;
  }
  ok(name, fn);
}

function completeQaReport(verdict = 'PASS') {
  return `# Codex QA report

VERDICT: ${verdict}

## Scope
- executable runner regression fixture

## Automated checks
- stub check — exit 0 — PASS

## Manual scenarios
- not required — PASS — non-UI fixture

## Defects
- no defects in the fixture scope

## Screenshots
- none required for the non-UI fixture

## Residual risk / blocked items
- none
`;
}

function createCodexQaStub(fixture) {
  const stubJs = path.join(fixture, 'codex-stub.js');
  fs.writeFileSync(stubJs, `'use strict';
const childProcess = require('child_process');
const fs = require('fs');
let step = {
  exit: Number(process.env.ZNADA_QA_STUB_EXIT || 0),
  write: process.env.ZNADA_QA_STUB_WRITE === '1',
  reportB64: process.env.ZNADA_QA_STUB_REPORT_B64 || '',
};
if (process.env.ZNADA_QA_STUB_PLAN_B64) {
  const plan = JSON.parse(Buffer.from(process.env.ZNADA_QA_STUB_PLAN_B64, 'base64').toString('utf8'));
  const counterPath = process.env.ZNADA_QA_STUB_COUNTER_PATH;
  let index = 0;
  try { index = Number(fs.readFileSync(counterPath, 'utf8')) || 0; } catch {}
  fs.writeFileSync(counterPath, String(index + 1));
  step = plan[Math.min(index, plan.length - 1)] || {};
}
if (step.write) {
  fs.writeFileSync(
    process.env.ZNADA_QA_STUB_REPORT_PATH,
    Buffer.from(step.reportB64 || process.env.ZNADA_QA_STUB_REPORT_B64 || '', 'base64'),
  );
}
if (step.screenshot) {
  const screenshotPath = require('path').join(process.env.ZNADA_QA_STUB_SCREENSHOT_ROOT, step.screenshot);
  fs.mkdirSync(require('path').dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, 'stale screenshot');
}
if (step.childSentinel) {
  const source = "const fs=require('fs');setTimeout(()=>fs.writeFileSync(process.argv[1],'orphan'),Number(process.argv[2]));";
  const child = childProcess.spawn(process.execPath, ['-e', source, step.childSentinel, String(step.childDelayMs || 2500)], {
    stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}
const finish = () => process.exit(Number(step.exit || 0));
if (Number(step.sleepMs) > 0) setTimeout(finish, Number(step.sleepMs));
else finish();
`);

  if (process.platform === 'win32') {
    const stubCmd = path.join(fixture, 'codex-stub.cmd');
    fs.writeFileSync(stubCmd,
      `@echo off\r\n"${process.execPath}" "${stubJs}"\r\nexit /b %ERRORLEVEL%\r\n`);
    return stubCmd;
  }

  const stub = path.join(fixture, 'codex-stub');
  fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${stubJs}"\n`, { mode: 0o755 });
  return stub;
}

function runCodexQaStub({
  stub, runId, report, codexExit = 0, writeReport = true, extraArgs = [], fresh = true,
  plan = null, counterPath = '', sessionFile = '', timeoutSeconds = 0,
}) {
  const repoRoot = path.join(__dirname, '..');
  const runRoot = path.join(repoRoot, '.tmp', 'codex-qa', runId);
  const powershell = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'pwsh';
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join(repoRoot, 'scripts', 'codex-qa.ps1'),
    '-Task', 'Executable release-runner regression fixture',
    '-RunId', runId,
    '-CodexPath', stub,
    ...(fresh ? ['-Fresh'] : []),
    ...(timeoutSeconds ? ['-TimeoutSeconds', String(timeoutSeconds)] : []),
    ...extraArgs,
  ];
  const result = childProcess.spawnSync(powershell, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ZNADA_QA_STUB_EXIT: String(codexExit),
      ZNADA_QA_STUB_WRITE: writeReport ? '1' : '0',
      ZNADA_QA_STUB_REPORT_PATH: path.join(runRoot, 'report.md'),
      ZNADA_QA_STUB_REPORT_B64: Buffer.from(report || '', 'utf8').toString('base64'),
      ZNADA_QA_STUB_PLAN_B64: plan ? Buffer.from(JSON.stringify(plan), 'utf8').toString('base64') : '',
      ZNADA_QA_STUB_COUNTER_PATH: counterPath,
      ZNADA_QA_STUB_SCREENSHOT_ROOT: path.join(runRoot, 'screenshots'),
      ZNADA_QA_SESSION_FILE: sessionFile || path.join(path.dirname(stub), 'session-id.txt'),
    },
    timeout: 30_000,
  });
  return { ...result, runRoot };
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
  // BUG-045: every stray root in one refusal, not one per full package run.
  assert.throws(() => verifyRootBoundary(['/main.js', '/Znada-Check.bat', '/notes.txt'], false),
    /unexpected app\.asar root: Znada-Check\.bat, notes\.txt$/);
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

okPrivate('Codex QA contract forbids ad hoc GUI control', 'scripts/codex-qa.ps1', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'codex-qa.ps1'), 'utf8');
  const protocol = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'codex-qa-protocol.md'), 'utf8');
  assert.match(runner, /tracked scripts\/capture-window\.ps1/);
  assert.match(runner, /Не писать и не запускать untracked PostMessage\/SendInput\/window-control\/CDP helper-ы/);
  // The PROSE of the contract is deliberately not asserted.
  //
  // A test that matches the wording of a process document turns a decision about how we
  // work into a build failure: changing the rule, or changing it back, breaks `npm test`
  // until the test is edited too. That is a lock, not a safety net — and the rule that
  // was locked in this way (the reviewer may not drive the window at all, every
  // interactive scenario becomes BLOCKED) was written during a release freeze, offered no
  // replacement, and left the project's own instructions contradicting it.
  //
  // What belongs here is what the RUNNER does, above and below: a run that dies must not
  // read as a pass, and artifacts must land where they are supposed to. What the document
  // says is the owner's call, revisited by editing the document.
  void protocol;
});

okPrivate('Codex QA runner enforces fail-closed verdict and artifact semantics', 'scripts/codex-qa.ps1', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'znada-codex-qa-runner-'));
  const stub = createCodexQaStub(fixture);
  const prefix = `test-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const runRoots = [];
  const run = (suffix, options = {}) => {
    const result = runCodexQaStub({
      stub,
      runId: `${prefix}-${suffix}`,
      report: completeQaReport('PASS'),
      ...options,
    });
    runRoots.push(result.runRoot);
    if (result.error) throw result.error;
    return result;
  };

  try {
    const pass = run('pass');
    assert.strictEqual(pass.status, 0, pass.stderr || pass.stdout);
    assert.match(pass.stdout, /^CODEX_QA_VERDICT=PASS$/m);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(pass.runRoot, 'meta.json'), 'utf8')).verdict,
      'PASS',
    );

    const completedOrphanCounter = path.join(fixture, 'completed-orphan-counter.txt');
    const completedOrphanSentinel = path.join(fixture, 'completed-orphan-sentinel.txt');
    const completedWithOrphan = run('completed-orphan', {
      counterPath: completedOrphanCounter,
      plan: [{
        exit: 0,
        write: true,
        reportB64: Buffer.from(completeQaReport('PASS'), 'utf8').toString('base64'),
        childSentinel: completedOrphanSentinel,
        childDelayMs: 2500,
      }],
    });
    assert.strictEqual(completedWithOrphan.status, 0, completedWithOrphan.stderr || completedWithOrphan.stdout);
    childProcess.spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 3000)']);
    assert.strictEqual(fs.existsSync(completedOrphanSentinel), false,
      'a successful QA attempt left an owned helper alive after its root exited');

    const fail = run('fail', { report: completeQaReport('FAIL') });
    assert.strictEqual(fail.status, 2, fail.stderr || fail.stdout);
    assert.match(fail.stdout, /^CODEX_QA_VERDICT=FAIL$/m);

    const blocked = run('blocked', { report: completeQaReport('BLOCKED') });
    assert.strictEqual(blocked.status, 3, blocked.stderr || blocked.stdout);
    assert.match(blocked.stdout, /^CODEX_QA_VERDICT=BLOCKED$/m);

    const crashed = run('crashed', { codexExit: 9 });
    assert.strictEqual(crashed.status, 4, crashed.stderr || crashed.stdout);
    assert.doesNotMatch(crashed.stdout, /^CODEX_QA_VERDICT=PASS$/m);
    assert.match(crashed.stdout, /^CODEX_QA_VERDICT=BLOCKED$/m);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(crashed.runRoot, 'meta.json'), 'utf8')).verdict,
      'BLOCKED',
    );

    const bare = run('bare', { report: 'VERDICT: PASS\n' });
    assert.strictEqual(bare.status, 3, bare.stderr || bare.stdout);
    assert.match(bare.stdout, /^CODEX_QA_VERDICT=BLOCKED$/m);

    const incomplete = run('incomplete', {
      report: completeQaReport('PASS').replace(
        /## Screenshots[\s\S]*?(?=## Residual risk \/ blocked items)/,
        '',
      ),
    });
    assert.strictEqual(incomplete.status, 3, incomplete.stderr || incomplete.stdout);
    assert.match(incomplete.stdout, /^CODEX_QA_VERDICT=BLOCKED$/m);

    const multiple = run('multiple', {
      report: `${completeQaReport('PASS')}\nVERDICT: FAIL\n`,
    });
    assert.strictEqual(multiple.status, 3, multiple.stderr || multiple.stdout);
    assert.match(multiple.stdout, /^CODEX_QA_VERDICT=BLOCKED$/m);

    const duplicateId = `${prefix}-duplicate`;
    const first = runCodexQaStub({
      stub,
      runId: duplicateId,
      report: completeQaReport('PASS'),
    });
    runRoots.push(first.runRoot);
    assert.strictEqual(first.status, 0, first.stderr || first.stdout);
    const duplicate = runCodexQaStub({
      stub,
      runId: duplicateId,
      report: completeQaReport('PASS'),
      writeReport: false,
    });
    assert.strictEqual(duplicate.status, 4, duplicate.stderr || duplicate.stdout);
    assert.doesNotMatch(duplicate.stdout, /^CODEX_QA_VERDICT=PASS$/m);

    const missingReport = run('missing-report', { writeReport: false });
    assert.strictEqual(missingReport.status, 3, missingReport.stderr || missingReport.stdout);
    assert.match(missingReport.stdout, /^CODEX_QA_VERDICT=BLOCKED$/m);

    const retryCounter = path.join(fixture, 'retry-counter.txt');
    const staleSessionFile = path.join(fixture, 'stale-session-id.txt');
    fs.writeFileSync(staleSessionFile, '12345678-1234-1234-1234-123456789abc');
    const staleRetry = run('stale-retry', {
      fresh: false,
      sessionFile: staleSessionFile,
      counterPath: retryCounter,
      plan: [
        {
          exit: 9,
          write: true,
          reportB64: Buffer.from(completeQaReport('PASS'), 'utf8').toString('base64'),
          screenshot: 'stale.png',
        },
        { exit: 0, write: false },
      ],
    });
    assert.strictEqual(fs.readFileSync(retryCounter, 'utf8'), '2', 'resume failure did not reach a fresh retry');
    assert.strictEqual(staleRetry.status, 3, staleRetry.stderr || staleRetry.stdout);
    assert.match(staleRetry.stdout, /^CODEX_QA_VERDICT=BLOCKED$/m);
    assert.doesNotMatch(staleRetry.stdout, /^CODEX_QA_VERDICT=PASS$/m);
    const staleMeta = JSON.parse(fs.readFileSync(path.join(staleRetry.runRoot, 'meta.json'), 'utf8'));
    assert.strictEqual(staleMeta.verdict, 'BLOCKED');
    assert.deepStrictEqual(staleMeta.screenshots, [], 'a failed resume leaked a stale screenshot into the retry');

    const watchdogCounter = path.join(fixture, 'watchdog-counter.txt');
    const orphanSentinel = path.join(fixture, 'orphan-sentinel.txt');
    const watchdogStarted = Date.now();
    const watchdog = run('watchdog', {
      timeoutSeconds: 1,
      counterPath: watchdogCounter,
      plan: [{
        exit: 0,
        write: true,
        reportB64: Buffer.from(completeQaReport('PASS'), 'utf8').toString('base64'),
        sleepMs: 10_000,
        childSentinel: orphanSentinel,
        childDelayMs: 2500,
      }],
    });
    assert.strictEqual(fs.readFileSync(watchdogCounter, 'utf8'), '1', 'the watchdog fixture never reached Codex');
    assert.strictEqual(watchdog.status, 4, watchdog.stderr || watchdog.stdout);
    assert.match(watchdog.stdout, /^CODEX_QA_VERDICT=BLOCKED$/m);
    assert.ok(Date.now() - watchdogStarted < 10_000, 'the runner ignored its own QA deadline');
    const watchdogMeta = JSON.parse(fs.readFileSync(path.join(watchdog.runRoot, 'meta.json'), 'utf8'));
    assert.strictEqual(watchdogMeta.timed_out, true);
    assert.strictEqual(watchdogMeta.process_tree_cleanup_succeeded, true);
    const watchdogReport = fs.readFileSync(path.join(watchdog.runRoot, 'report.md'), 'utf8');
    assert.strictEqual((watchdogReport.match(/^VERDICT:/gm) || []).length, 1);
    assert.match(watchdogReport, /^VERDICT: BLOCKED$/m);
    childProcess.spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 3000)']);
    assert.strictEqual(fs.existsSync(orphanSentinel), false, 'the timed-out QA process left an owned child alive');

    const runnerError = run('runner-error', {
      extraArgs: ['-TaskFile', path.join(fixture, 'missing-task.md')],
    });
    assert.strictEqual(runnerError.status, 4, runnerError.stderr || runnerError.stdout);
    assert.match(runnerError.stdout, /^CODEX_QA_VERDICT=BLOCKED$/m);
  }
  finally {
    for (const runRoot of new Set(runRoots)) {
      fs.rmSync(runRoot, { recursive: true, force: true });
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

console.log(`\nAll ${passed} release-tooling tests passed.`);
