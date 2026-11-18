'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeTempDir } = require('./helpers/temp-dir');

const runner = path.resolve(__dirname, '../scripts/run-tests.js');
const root = makeTempDir('znada-runner-');
const cwd = path.join(root, 'тест с пробелами');
fs.mkdirSync(cwd);
const trace = path.join(cwd, 'trace.jsonl');
const script = 'шаг с пробелами.js';
fs.writeFileSync(path.join(cwd, script), `
  const fs = require('fs');
  fs.appendFileSync('trace.jsonl', JSON.stringify({
    args: process.argv.slice(2), cwd: process.cwd(), env: process.env.ZNADA_RUNNER_TEST,
  }) + '\\n');
  console.log('child stdout'); console.error('child stderr');
  process.exitCode = Number(process.argv[2]);
`);

function run(steps, prefix = '') {
  fs.writeFileSync(trace, '');
  const result = spawnSync(process.execPath, ['-e',
    `${prefix}process.exitCode = require(${JSON.stringify(runner)}).runSteps(${JSON.stringify(steps)}, { cwd: ${JSON.stringify(cwd)} });`,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, ZNADA_RUNNER_TEST: 'inherited' } });
  const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { ...result, calls };
}

const success = run([[script, '0', 'первый аргумент'], [script, '0', 'second']]);
assert.strictEqual(success.status, 0, success.stderr);
assert.deepStrictEqual(success.calls.map((call) => call.args), [['0', 'первый аргумент'], ['0', 'second']]);
assert.ok(success.calls.every((call) => call.cwd === cwd && call.env === 'inherited'));
assert.ok(success.stdout.includes('child stdout'));
assert.ok(success.stderr.includes('child stderr'));

const failed = run([[script, '0'], [script, '7'], [script, '0', 'must not run']]);
assert.strictEqual(failed.status, 7);
assert.strictEqual(failed.calls.length, 2, 'stop at the first failing process');
assert.ok(failed.stderr.includes('Test step failed: node ' + script + ' 7'));

const missing = run([['missing.js'], [script, '0']]);
assert.notStrictEqual(missing.status, 0);
assert.strictEqual(missing.calls.length, 0);

// Run the actual CLI against a small manifest in a fixture project. Invoking it
// from another directory must still use its project root and propagate failure.
const scripts = path.join(cwd, 'scripts');
fs.mkdirSync(scripts);
fs.copyFileSync(runner, path.join(scripts, 'run-tests.js'));
fs.writeFileSync(path.join(scripts, 'test-steps.json'), JSON.stringify([[script, '9'], [script, '0']]));
fs.writeFileSync(trace, '');
const cli = spawnSync(process.execPath, [path.join(scripts, 'run-tests.js')], { cwd: root, encoding: 'utf8' });
assert.strictEqual(cli.status, 9, cli.stderr);
assert.strictEqual(fs.readFileSync(trace, 'utf8').trim().split('\n').length, 1);

// Exercise spawn failures and signal termination without killing a real Windows process.
for (const result of ["{ status: null, error: new Error('spawn ENOENT') }", "{ status: null, signal: 'SIGTERM' }"]) {
  const stopped = run([[script, '0'], [script, '0']],
    `require('child_process').spawnSync = () => (${result});`);
  assert.strictEqual(stopped.status, 1);
  assert.ok(stopped.stderr.includes('Test step failed:'));
  assert.strictEqual(stopped.calls.length, 0);
}

// The sum of all arguments exceeds cmd.exe's 8191 character limit, but each child
// gets just one small step. Adding tests must never rebuild the old shell chain.
const long = run(Array.from({ length: 90 }, (_, i) => [script, '0', String(i), 'x'.repeat(100)]));
assert.strictEqual(long.status, 0, long.stderr);
assert.strictEqual(long.calls.length, 90);
assert.deepStrictEqual(long.calls.map((call) => call.args[1]), Array.from({ length: 90 }, (_, i) => String(i)));
console.log('test runner: order, arguments, cwd/env, output, failure, spawn/signal and >8191 characters PASS');
