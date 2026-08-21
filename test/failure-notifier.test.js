'use strict';

const assert = require('assert');
const { createFailureNotifier } = require('../src/failure-notifier');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  OK ' + name); passed++; };

const n = createFailureNotifier();

ok('first failure is an edge', n.fail('wallpaper-auto') === true);
ok('repeated failure stays silent', n.fail('wallpaper-auto') === false && n.fail('wallpaper-auto') === false);
ok('channel reports broken state', n.isFailed('wallpaper-auto') === true);

ok('success after failure is a recovery edge', n.success('wallpaper-auto') === true);
ok('repeated success stays silent', n.success('wallpaper-auto') === false);
ok('channel reports healthy state', n.isFailed('wallpaper-auto') === false);

ok('failure after recovery is a NEW edge (break → fix → break notifies again)',
  n.fail('wallpaper-auto') === true);

ok('channels are independent', n.fail('theme-schedule') === true && n.isFailed('wallpaper-auto') === true);
ok('success on a never-failed channel is not a recovery', n.success('thumbnail-helper') === false);

ok('empty channel name is ignored', n.fail('') === false && n.success('') === false);

n.reset();
ok('reset clears all state', !n.isFailed('wallpaper-auto') && !n.isFailed('theme-schedule')
  && n.fail('wallpaper-auto') === true);

console.log('\nAll ' + passed + ' failure-notifier tests passed.');
