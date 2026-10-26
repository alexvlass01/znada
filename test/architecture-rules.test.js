'use strict';

// CODE-001 / CODE-007. Check a real dependency boundary, wherever the code lives.
// File length is not an architecture boundary: a hard line budget rewards moving
// coupled code into another file, or deleting useful comments, without simplifying it.
// Module responsibility, state ownership and coupling are reviewed with the callers.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mainProcessSources } = require('./helpers/main-process-sources');
const { makeTempDir } = require('./helpers/temp-dir');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

// What a main-process module may reach for ---------------------------------------
//
// Modules under src/ run under plain Node in the tests. Electron is handed to them by
// main.js, never required: a module that required it could not be loaded by a test at
// all, and could not be given the harness's stand-ins.
// Asked of what each file requires, not of its text, so 'electron/main' and a comment inside
// the parentheses count too.
function electronInSrc(sources) {
  return sources
    .filter(({ file }) => file.startsWith('src/'))
    .flatMap(({ file, requires }) => requires
      .filter(({ spec }) => /^electron(\/|$)/.test(spec))
      .map(({ spec, line }) => `${file}:${line} requires '${spec}'`));
}

ok('no module under src/ requires electron', () => {
  const offenders = electronInSrc(mainProcessSources());
  assert.deepStrictEqual(offenders, [], 'Electron is injected by main.js, not required: ' + offenders.join(', '));
});

ok('in any spelling of the require', () => {
  const root = makeTempDir('znada architecture-');
  try {
    const files = {
      'main.js': "require('electron');\n",
      'src/a.js': "const { app } = require('electron/main');\n",
      'src/b.js': "const e = require(/* injected? */ 'electron');\n",
      'diagnostics/main/c.js': "require('electron');\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    assert.deepStrictEqual(electronInSrc(mainProcessSources(root)),
      ["src/a.js:1 requires 'electron/main'", "src/b.js:1 requires 'electron'"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Which modules may start a program (and hold child_process at all) is the WIN-002 rule and
// lives with it: test/system-children-main.test.js, "and neither does any other
// main-process module".

console.log(`\nPASS architecture-rules: ${passed} checks`);
