'use strict';

const assert = require('assert');
const path = require('path');
const {
  normalizeLaunchFlags,
  resolveDiagnosticsBootstrap,
} = require('../src/diagnostics-gate');

let passed = 0;
const ok = (name, condition) => {
  assert.ok(condition, name);
  console.log('  OK ' + name);
  passed++;
};

ok('split launch flags tolerates Squirrel-style combined args',
  normalizeLaunchFlags(['electron', '--process-start-args', '--diagnostics --hidden']).includes('--diagnostics'));

ok('ordinary dev launch does not enable diagnostics', !resolveDiagnosticsBootstrap({
  isPackaged: false,
  env: {},
  argv: ['electron', '.'],
  localAppData: 'C:/Users/A/AppData/Local',
}).enabled);

ok('diagnostics env alone is only a partial opt-in', resolveDiagnosticsBootstrap({
  isPackaged: false,
  env: { ZNADA_DIAGNOSTICS: '1' },
  argv: ['electron', '.'],
  localAppData: 'C:/Users/A/AppData/Local',
}).reason === 'partial_opt_in');

ok('diagnostics arg alone is only a partial opt-in', resolveDiagnosticsBootstrap({
  isPackaged: false,
  env: {},
  argv: ['electron', '.', '--diagnostics'],
  localAppData: 'C:/Users/A/AppData/Local',
}).reason === 'partial_opt_in');

const enabledDefault = resolveDiagnosticsBootstrap({
  isPackaged: false,
  env: { ZNADA_DIAGNOSTICS: '1' },
  argv: ['electron', '.', '--diagnostics'],
  localAppData: 'C:/Users/A/AppData/Local',
});
ok('explicit env plus arg enables diagnostics', enabledDefault.enabled);
ok('enabled diagnostics uses the default isolated profile',
  enabledDefault.userDataPath === path.resolve('C:/Users/A/AppData/Local/Znada-Diagnostics'));

const enabledExplicit = resolveDiagnosticsBootstrap({
  isPackaged: false,
  env: {
    ZNADA_DIAGNOSTICS: 'true',
    ZNADA_DIAGNOSTICS_USER_DATA: ' C:/Temp/Znada-Diagnostics ',
  },
  argv: ['electron', '.', '--znada-diagnostics'],
  localAppData: 'C:/Users/A/AppData/Local',
});
ok('explicit diagnostics profile path is normalized',
  enabledExplicit.userDataPath === path.resolve('C:/Temp/Znada-Diagnostics'));

ok('packaged builds ignore diagnostics even with env and arg', !resolveDiagnosticsBootstrap({
  isPackaged: true,
  env: {
    ZNADA_DIAGNOSTICS: '1',
    ZNADA_DIAGNOSTICS_USER_DATA: 'C:/Temp/Znada-Diagnostics',
  },
  argv: ['Lumina.exe', '--diagnostics'],
  localAppData: 'C:/Users/A/AppData/Local',
}).enabled);

ok('missing profile path keeps diagnostics disabled', resolveDiagnosticsBootstrap({
  isPackaged: false,
  env: { ZNADA_DIAGNOSTICS: '1' },
  argv: ['electron', '.', '--diagnostics'],
  localAppData: '',
}).reason === 'missing_user_data_path');

console.log('\nAll ' + passed + ' diagnostics gate tests passed.');
