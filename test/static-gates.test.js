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

// QA-010: the tests mean the same thing in a fresh clone on Windows.
//
// Git for Windows turns LF into CRLF on checkout, while a checkout made or edited another way
// can hold LF. A test that searches the program's source for a line break then passes in one
// checkout and fails in the other - and whoever holds the passing one never sees it. Two did
// exactly that (assign-slots and view-scroll): red on a clean main in a fresh clone made with
// Git for Windows' default settings, green in the long-lived checkout.
//
// So the tests that read the program's source run again, with its files read the way a fresh
// clone hands them out. The simulation was checked against a real fresh clone: on an LF
// checkout it fails exactly the tests that fail there, and nothing else.
//
// Only source-reading tests are repeated. The rest read fixtures they wrote themselves, where
// line endings change nothing, and repeating them tripled the cost. A test that reaches the
// source through a path this pattern cannot see is not covered here.
ok('tests that read the source pass with the line endings of a fresh Windows clone', () => {
  // Already inside the simulation: nothing to repeat.
  if (process.env.ZNADA_FRESH_CLONE_EOL) return;
  const hook = path.join(__dirname, 'helpers', 'fresh-clone-eol.js').split(path.sep).join('/');
  const readsSource = /readFileSync\([^)]*(?:renderer|main\.js|preload|["'`]src["'`]|src[\\/]|index\.html|styles\.css|locales|H\.ROOT|\bROOT\b)/i;
  const steps = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test.split(' && ');
  const readers = steps
    .map((step) => /^node (test\/[^ ]+\.test\.js)$/.exec(step))
    .filter(Boolean)
    .map((match) => match[1])
    .filter((file) => file !== 'test/static-gates.test.js')
    .filter((file) => readsSource.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
  // An empty list would pass by checking nothing - the very failure this file exists to catch.
  assert.ok(readers.length >= 10, `only ${readers.length} source-reading tests were found`);
  const env = {
    ...process.env,
    ZNADA_FRESH_CLONE_EOL: '1',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${hook}"`.trim(),
  };
  const broken = [];
  for (const file of readers) {
    const res = spawnSync(process.execPath, [path.join(ROOT, file)], {
      cwd: ROOT, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) {
      const why = `${res.stdout || ''}${res.stderr || ''}`.match(/AssertionError[^\r\n]*|Error:[^\r\n]*/);
      broken.push(`${file}: ${why ? why[0] : `exit ${res.status}`}`);
    }
  }
  assert.deepStrictEqual(broken, [], `these pass here but fail in a fresh Windows clone:\n  ${broken.join('\n  ')}`);
});

// A test file that `npm test` never names is another silent gate: it passes by not running.
// test/media-proxy.test.js - PERF-008's own checks of the stream proxy - sat outside the chain
// from the day it was written, so neither the suite nor the release review ever ran it.
ok('every test file in test/ is run by npm test', () => {
  const chain = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test;
  const files = fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.js')).sort();
  assert.ok(files.includes('static-gates.test.js'), 'the test directory was not read');
  const missing = files.filter((name) => !chain.includes(`node test/${name}`));
  assert.deepStrictEqual(missing, [], 'not in scripts.test: ' + missing.join(', '));
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`FAILED: ${f.name}\n  ${f.err && f.err.stack}`);
  process.exit(1);
}
