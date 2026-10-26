'use strict';

// CODE-001. scripts/code-map.js is the measurement behind the split plan: who reads and
// writes which module variable, and what a region would have to be handed if it became a
// module. A wrong count there would steer the plan wrongly without anything failing, so its
// answers are pinned on a file small enough to count by hand.

const assert = require('assert');
const { analyze, cluster, fieldWrites, parseRanges } = require('../scripts/code-map');

const SOURCE = [
  "const fs = require('fs');",          // 1  a require is not shared state
  'let config = { a: 1 };',             // 2
  'let timer = null;',                  // 3
  'function load() {',                  // 4
  "  config = JSON.parse(fs.readFileSync('x', 'utf8'));", // 5
  '}',                                  // 6
  'function arm() {',                   // 7
  '  timer = setTimeout(load, 10);',    // 8
  '  return config.a;',                 // 9
  '}',                                  // 10
  'function edit(v) {',                 // 11
  '  config.a = v;',                    // 12
  '  helper(config);',                  // 13
  '  arm();',                           // 14
  '}',                                  // 15
  'function helper(c) { return c; }',  // 16
].join('\n');

const map = analyze(SOURCE);
const unit = (name) => map.units.find((u) => u.name === name);

assert.deepStrictEqual(map.state.map((v) => v.name).sort(), ['config', 'timer'],
  'module variables are the shared state; requires and functions are not');
assert.deepStrictEqual(unit('load').writes, ['config'], 'reassigning the variable is a write');
assert.deepStrictEqual(unit('arm').reads, ['config'], 'reading a field is a read of the variable');
assert.deepStrictEqual(unit('arm').writes, ['timer']);
assert.deepStrictEqual(unit('arm').calls, ['load'], 'a function passed by name is counted as used');
assert.deepStrictEqual(unit('edit').calls, ['arm', 'helper']);
assert.deepStrictEqual(unit('edit').writes, [], 'a field write is not a reassignment; fields mode counts it');

assert.deepStrictEqual(fieldWrites(SOURCE, 'config'), { sites: 2, units: 1 },
  'config.a = v and helper(config) are the two places its fields can change, both in edit()');

// A module made of arm() alone: it would need load() and both variables handed to it, and
// edit() would have to reach in for arm.
const armOnly = cluster(map, parseRanges('7-10'));
assert.deepStrictEqual(armOnly.callsOut, [['load', 1]]);
assert.deepStrictEqual(armOnly.readsOut, [['config', 1]]);
assert.deepStrictEqual(armOnly.writesOut, [['timer', 1]]);
assert.deepStrictEqual(armOnly.inbound, [['arm', 1]]);
assert.strictEqual(armOnly.lines, 4);

// Handlers stay in the file as one-line calls into a module, so the guarded IPC door is not
// a dependency of the region: it is counted apart, by the units that register through it.
const IPC_SOURCE = [
  'let config = { a: 1 };',                     // 1
  'const ipcMain = { handle() {} };',           // 2
  "ipcMain.handle('get-a', () => config.a);",  // 3
  "ipcMain.handle('get-b', () => 2);",         // 4
].join('\n');
const handlersOnly = cluster(analyze(IPC_SOURCE), parseRanges('3-4'));
assert.deepStrictEqual(handlersOnly.readsOut, [['config', 1]], 'ipcMain is not counted as something the region reads');
assert.strictEqual(handlersOnly.handlers, 2);

console.log('PASS code-map: counts match a file counted by hand');
