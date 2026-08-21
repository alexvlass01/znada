'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'i18n-state.js');
let passed = 0;

function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  OK ${name}`);
  passed++;
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
}

{
  const res = run(['report', 'en']);
  ok('report accepts a real locale', res.status === 0 && /en\s+0/.test(res.stdout));
}

{
  const res = run(['keys', 'definitely-not-a-language']);
  ok('keys rejects an unknown locale with a nonzero exit',
    res.status !== 0 && /Неизвестный|недопустимый/.test(res.stderr));
}

{
  const res = run(['keys', '../package']);
  ok('locale arguments cannot traverse outside locales/state',
    res.status !== 0 && /Неизвестный|недопустимый/.test(res.stderr));
}

{
  const res = run(['baseline', 'uk']);
  ok('non-reference baseline requires an explicit reviewed acknowledgement',
    res.status !== 0 && /--reviewed/.test(res.stderr));
}

{
  const res = run(['baseline']);
  ok('baseline without a locale is rejected', res.status !== 0 && /Укажи язык/.test(res.stderr));
}

{
  const res = run(['report', 'en', '--reviewed']);
  ok('--reviewed is rejected outside the baseline command',
    res.status !== 0 && /только для команды baseline/.test(res.stderr));
}

{
  const invalidLocale = path.join(ROOT, 'locales', 'zz.json');
  const invalidState = path.join(ROOT, 'locales', 'state', 'zz.json');
  assert.strictEqual(fs.existsSync(invalidLocale), false, 'zz locale is reserved for this test');
  fs.writeFileSync(invalidLocale, '{ invalid json', 'utf8');
  try {
    for (const args of [['report', 'zz'], ['keys', 'zz'], ['baseline', 'zz', '--reviewed']]) {
      const res = run(args);
      ok(`${args[0]} fails when the target locale is unreadable`,
        res.status !== 0 && /не читается/.test(res.stderr));
    }
    ok('failed baseline does not create a state file', !fs.existsSync(invalidState));
  } finally {
    fs.rmSync(invalidLocale, { force: true });
    fs.rmSync(invalidState, { force: true });
  }
}

console.log(`\nAll ${passed} i18n-state CLI tests passed.`);
