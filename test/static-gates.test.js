'use strict';

// CODE-002: proof that the two static gates can fail.
//
// This is the test the task is actually about. A linter pointed at the wrong files, or a
// type checker whose scope is empty, reports nothing at all - and "nothing" is exactly
// what a healthy run looks like. So each gate is run twice: once over the real code,
// where it must be silent, and once over a file built to break it, where it must not be.
//
// The offenders live in test/fixtures/static-gates/ and are excluded from the ordinary
// run, or `npm run lint` could never pass.
//
// Run: node test/static-gates.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'static-gates');

let passed = 0;
const failures = [];

function ok(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err && err.message}`);
    failures.push({ name, err });
  }
}

// The tools' own entry scripts, run by this node. The .bin shims are .cmd files on
// Windows and would need a shell, and a shell would need the project path quoted - which
// it was not, and the whole check silently became "the command was not found".
const ENTRY = {
  eslint: path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'),
  tsc: path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
};

function run(bin, args) {
  const res = spawnSync(process.execPath, [ENTRY[bin], ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

console.log('\nCODE-002: the static gates, and proof they can fail\n');

ok('the linter is configured and reads the whole first-party tree', () => {
  const config = fs.readFileSync(path.join(ROOT, 'eslint.config.js'), 'utf8');
  for (const area of ['main.js', 'src/**/*.js', 'renderer/*.js', 'test/**/*.js', 'scripts/**/*.js']) {
    assert.ok(config.includes(`'${area}'`), `the lint scope does not mention ${area}`);
  }
  assert.ok(config.includes("'test/fixtures/**'"), 'the deliberately broken fixtures are not excluded');
});

ok('the linter refuses a call to a function that does not exist', () => {
  // --no-ignore, because the fixture is excluded from the ordinary run on purpose.
  const res = run('eslint', ['--no-ignore', path.join(FIXTURES, 'lint-offender.js')]);
  assert.notStrictEqual(res.code, 0, 'the linter accepted an undefined name:\n' + res.out);
  assert.ok(/no-undef/.test(res.out), 'it failed, but not for the reason expected:\n' + res.out);
  assert.ok(/isTrustedThumbnailSender/.test(res.out), 'it did not name the offending call:\n' + res.out);
});

ok('the type checker refuses an options object missing a required member', () => {
  const res = run('tsc', [
    '--noEmit', '--allowJs', '--checkJs', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node',
    path.join(FIXTURES, 'typecheck-offender.js'),
  ]);
  assert.notStrictEqual(res.code, 0, 'the type checker accepted an incomplete options object:\n' + res.out);
  assert.ok(/isSameOrDescendant/.test(res.out), 'it did not name the missing member:\n' + res.out);
});

ok('and both are silent on the real code', () => {
  // The other half of the proof. Run through the project scripts, so this checks the
  // command a person would actually type rather than a private invocation.
  const lint = run('eslint', ['.']);
  assert.strictEqual(lint.code, 0, 'the linter reports problems in the real tree:\n' + lint.out);
  const types = run('tsc', ['--noEmit']);
  assert.strictEqual(types.code, 0, 'the type checker reports problems in the real tree:\n' + types.out);
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`FAILED: ${f.name}\n  ${f.err && f.err.stack}`);
  process.exit(1);
}
