'use strict';

// `node test/dev-launch-gate.test.js` — COLLAB-003: which launches are DEV or DIAG checks,
// which are refused, and that a packaged build is never either. The inputs go through the
// two gates main.js composes this from, so each case is what a real set of variables and
// arguments produces rather than a hand-made object.

const assert = require('assert');
const path = require('path');
const { REFUSALS, resolveDevLaunch } = require('../src/dev-launch-gate');
const { resolveDiagnosticsBootstrap } = require('../src/diagnostics-gate');
const { resolveStagingUserData } = require('../src/cloud/dev-profile');

let passed = 0;
const ok = (name, fn) => { fn(); console.log('  ✓ ' + name); passed++; };

const LOCAL = 'C:/Users/someone/AppData/Local';

// The same order main.js resolves them in: diagnostics, then staging, then this gate.
function launch({ isPackaged = false, env = {}, args = [], localAppData = LOCAL } = {}) {
  const argv = ['electron', '.', ...args];
  const diagnostics = resolveDiagnosticsBootstrap({ isPackaged, env, argv, localAppData });
  const stagingUserData = diagnostics.enabled ? null : resolveStagingUserData({
    isPackaged,
    cloudEnv: env.ZNADA_CLOUD,
    requestedPath: env.ZNADA_DEV_USER_DATA,
  });
  return resolveDevLaunch({
    isPackaged,
    diagnostics,
    stagingRequested: String(env.ZNADA_CLOUD || '').trim() === 'staging',
    stagingUserData,
  });
}

const DEV_CLOUD = { ZNADA_CLOUD: 'staging', ZNADA_DEV_USER_DATA: `${LOCAL}/Znada-Dev` };
const DEV_DIAGNOSTICS = { ZNADA_DIAGNOSTICS: '1', ZNADA_DIAGNOSTICS_USER_DATA: `${LOCAL}/Znada-Diagnostics` };
const ORDINARY = { mode: null, refusal: null, userDataPath: null };

ok('an ordinary source launch is neither a check nor refused', () => {
  assert.deepStrictEqual(launch(), ORDINARY);
});

ok('npm run dev:cloud is a DEV check on its own profile', () => {
  assert.deepStrictEqual(launch({ env: DEV_CLOUD }),
    { mode: 'dev', refusal: null, userDataPath: path.resolve(`${LOCAL}/Znada-Dev`) });
});

ok('the trailing space `set VAR=x&&` leaves on Windows does not break it', () => {
  assert.strictEqual(launch({ env: { ...DEV_CLOUD, ZNADA_CLOUD: 'staging ' } }).mode, 'dev');
});

ok('npm run dev:diagnostics is a DIAG check on its own profile', () => {
  assert.deepStrictEqual(launch({ env: DEV_DIAGNOSTICS, args: ['--diagnostics'] }),
    { mode: 'diag', refusal: null, userDataPath: path.resolve(`${LOCAL}/Znada-Diagnostics`) });
});

ok('staging without a profile is refused: it would open the real one', () => {
  assert.deepStrictEqual(launch({ env: { ZNADA_CLOUD: 'staging' } }),
    { mode: null, refusal: REFUSALS.DEV_WITHOUT_PROFILE, userDataPath: null });
  assert.strictEqual(launch({ env: { ZNADA_CLOUD: 'staging', ZNADA_DEV_USER_DATA: '   ' } }).refusal,
    REFUSALS.DEV_WITHOUT_PROFILE);
});

ok('half of the DIAG opt-in is refused, whichever half it is', () => {
  assert.strictEqual(launch({ env: DEV_DIAGNOSTICS }).refusal, REFUSALS.DIAG_INCOMPLETE);
  assert.strictEqual(launch({ args: ['--diagnostics'] }).refusal, REFUSALS.DIAG_INCOMPLETE);
});

ok('a DIAG check that cannot find a profile folder is refused as such', () => {
  const result = launch({ env: { ZNADA_DIAGNOSTICS: '1' }, args: ['--diagnostics'], localAppData: '' });
  assert.deepStrictEqual(result, { mode: null, refusal: REFUSALS.DIAG_WITHOUT_PROFILE, userDataPath: null });
});

ok('DIAG wins over staging, as it does for the profile', () => {
  assert.strictEqual(launch({ env: { ...DEV_CLOUD, ...DEV_DIAGNOSTICS }, args: ['--diagnostics'] }).mode, 'diag');
});

// A stray ZNADA_DIAGNOSTICS in an otherwise correct DEV launch: the two signals disagree
// about what this window is, and guessing is exactly what the refusal is there to stop.
ok('a DEV launch carrying half a DIAG opt-in is refused rather than guessed', () => {
  assert.strictEqual(launch({ env: { ...DEV_CLOUD, ZNADA_DIAGNOSTICS: '1' } }).refusal, REFUSALS.DIAG_INCOMPLETE);
});

ok('a packaged build is an ordinary launch whatever it was started with', () => {
  const envs = [{}, DEV_CLOUD, { ZNADA_CLOUD: 'staging' }, DEV_DIAGNOSTICS, { ...DEV_CLOUD, ...DEV_DIAGNOSTICS }];
  const argSets = [[], ['--diagnostics'], ['--znada-diagnostics', '--hidden']];
  for (const env of envs) {
    for (const args of argSets) {
      assert.deepStrictEqual(launch({ isPackaged: true, env, args }), ORDINARY, JSON.stringify({ env, args }));
    }
  }
});

ok('a caller that does not say whether the build is packaged is treated as packaged', () => {
  const everything = {
    diagnostics: { enabled: true, requested: true, userDataPath: 'x' },
    stagingRequested: true,
    stagingUserData: 'y',
  };
  assert.deepStrictEqual(resolveDevLaunch(everything), ORDINARY);
  assert.deepStrictEqual(resolveDevLaunch(), ORDINARY);
});

console.log('\nAll ' + passed + ' dev-launch gate tests passed.');
