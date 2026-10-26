'use strict';

// `node test/temp-dir.test.js` — QA-019: tests do not leave directories in %TEMP%.
//
// Two halves, because either alone lets the leak back in:
//  - every test makes its temporary directories through test/helpers/temp-dir.js, so a new
//    suite that calls fs.mkdtempSync itself fails here instead of quietly adding a
//    directory per `npm test` again;
//  - the helper really removes them when a suite passes, throws or calls process.exit(),
//    checked in a child process with %TEMP% pointed at a directory of our own.
// The whole-suite check is `npm run test:temp` (scripts/check-test-temp.js).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeTempDir } = require('./helpers/temp-dir');

const TEST_DIR = __dirname;
const HELPER = path.join(TEST_DIR, 'helpers', 'temp-dir.js');

let passed = 0;
const ok = (name, fn) => { fn(); console.log('  ✓ ' + name); passed++; };

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'fixtures') out.push(...jsFiles(full)); }
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

ok('no test makes a temporary directory past the shared helper', () => {
  const offenders = [];
  for (const file of jsFiles(TEST_DIR)) {
    if (file === HELPER || file === __filename) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/\bmkdtemp(Sync)?\s*\(/.test(line)) offenders.push(`${path.relative(TEST_DIR, file)}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(offenders, [], 'use makeTempDir from test/helpers/temp-dir.js: ' + offenders.join(', '));
});

// The child makes two directories (one with a file and a subfolder inside), reports them,
// then ends the way the case says. Its %TEMP% is a directory of ours, so nothing it does
// can touch the real one.
function runChild(ending) {
  const temp = makeTempDir('znada-qa019-child-');
  const script = [
    `const fs = require('fs'); const path = require('path');`,
    `const { makeTempDir } = require(${JSON.stringify(HELPER)});`,
    `const a = makeTempDir('qa019-a-'); const b = makeTempDir('qa019-b-');`,
    `fs.mkdirSync(path.join(a, 'deep', 'er'), { recursive: true });`,
    `fs.writeFileSync(path.join(a, 'deep', 'er', 'file.txt'), 'x');`,
    `console.log(JSON.stringify([a, b]));`,
    ending,
  ].join('\n');
  const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
  const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  const made = JSON.parse(result.stdout.trim().split(/\r?\n/)[0]);
  return { result, made, temp };
}

for (const [name, ending, expectStatus] of [
  ['a suite that finishes normally', '', 0],
  ['a suite whose assertion throws', `throw new Error('assertion failed on purpose');`, 1],
  ['a suite that calls process.exit(3)', 'process.exit(3);', 3],
]) {
  ok(`temporary directories are removed after ${name}`, () => {
    const { result, made, temp } = runChild(ending);
    assert.strictEqual(result.status, expectStatus, result.stderr);
    for (const dir of made) {
      assert.ok(path.dirname(dir) === temp, `child made ${dir} outside its own %TEMP% ${temp}`);
      assert.ok(!fs.existsSync(dir), `${dir} was left behind`);
    }
    assert.deepStrictEqual(fs.readdirSync(temp), [], 'child %TEMP% is not empty');
  });
}

// QA-023: partial storage mocks can still reach the real filesystem. Run the actual
// suite in an empty working directory so an existing profile-a cannot hide a leak.
ok('cloud-session leaves its working directory empty', () => {
  const cwd = makeTempDir('znada-qa023-cwd-');
  const result = spawnSync(process.execPath, [path.join(TEST_DIR, 'cloud-session.test.js')], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
  assert.strictEqual(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  assert.deepStrictEqual(fs.readdirSync(cwd), [], 'cloud-session wrote into its working directory');
});

console.log(`\ntemp-dir: ${passed} passed`);
