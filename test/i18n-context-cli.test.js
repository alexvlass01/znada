'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'i18n-context.js');
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
  const res = run(['report']);
  const ratio = /(\d+)\/(\d+) ключей \(\d+(?:\.\d+)?%\)/.exec(res.stdout);
  // Pinning the exact counts made this fail on any legitimate dictionary edit
  // (removing 40 dead keys moved 345/388 to 345/348). Assert the shape and the
  // coverage floor from the plan instead, which is what the check is really for.
  const covered = ratio ? Number(ratio[1]) : 0;
  const total = ratio ? Number(ratio[2]) : 0;
  ok('report validates the generated/manual context inputs',
    res.status === 0 && Boolean(ratio) && /Ручной sidecar/.test(res.stdout));
  ok('derived context stays above the planned 80% coverage floor',
    total > 0 && covered / total >= 0.8);
}

{
  const res = run(['report', 'unexpected']);
  ok('report rejects irrelevant trailing arguments', res.status !== 0 && /Неверные аргументы/.test(res.stderr));
}

{
  const res = run(['show', 'library.addPhotos']);
  ok('show returns both automatic and manual context channels',
    res.status === 0 && /autoContexts/.test(res.stdout) && /"manual": null/.test(res.stdout));
}

for (const inherited of ['__proto__', 'constructor', 'toString']) {
  const res = run(['show', inherited]);
  ok(`show rejects inherited object property ${inherited}`,
    res.status !== 0 && /Неизвестный ключ/.test(res.stderr));
}

{
  const res = run(['show', 'library.addPhotos', 'unexpected']);
  ok('show requires exactly one key', res.status !== 0 && /Неверные аргументы/.test(res.stderr));
}

console.log(`\nAll ${passed} i18n-context CLI tests passed.`);
