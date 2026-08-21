'use strict';

const assert = require('assert');
const path = require('path');
const { resolveStagingUserData } = require('../src/cloud/dev-profile');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  OK ' + name); passed++; };

ok('packaged builds ignore staging profile path', resolveStagingUserData({
  isPackaged: true, cloudEnv: 'staging', requestedPath: 'C:/Temp/Znada-Dev',
}) === null);
ok('ordinary dev ignores staging profile path', resolveStagingUserData({
  isPackaged: false, cloudEnv: 'production', requestedPath: 'C:/Temp/Znada-Dev',
}) === null);
ok('staging without an explicit path keeps normal userData', resolveStagingUserData({
  isPackaged: false, cloudEnv: 'staging', requestedPath: '',
}) === null);
ok('explicit staging path is normalized', resolveStagingUserData({
  isPackaged: false, cloudEnv: ' staging ', requestedPath: ' C:/Temp/Znada-Dev ',
}) === path.resolve('C:/Temp/Znada-Dev'));

console.log('\nAll ' + passed + ' cloud dev-profile tests passed.');
