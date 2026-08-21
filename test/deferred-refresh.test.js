'use strict';

const assert = require('assert');
const DeferredRefresh = require('../renderer/deferred-refresh');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  ✓ ' + name); passed++; };

const state = DeferredRefresh.create(['home', 'library']);

ok('starts with no pending targets', !state.has('home') && !state.has('library'));

state.markAll();
ok('markAll marks every view independently', state.has('home') && state.has('library'));
ok('consuming Home does not consume Library', state.consume('home') && !state.has('home') && state.has('library'));
ok('Library remains consumable later', state.consume('library') && !state.has('library'));
ok('consuming a clean target reports false', state.consume('library') === false);

state.mark('library');
state.mark('library');
ok('repeated marks are deduplicated', state.consume('library') && !state.consume('library'));

state.mark('unknown');
ok('unknown targets are ignored', !state.has('unknown'));

console.log('\nAll ' + passed + ' deferred-refresh tests passed.');
