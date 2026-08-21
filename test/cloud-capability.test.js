'use strict';

// Plain Node test: `node test/cloud-capability.test.js`. Covers the pure cloud
// capability resolver — environment gating + the renderer-safe public subset.

const assert = require('assert');
const CAP = require('../src/cloud/capability');
const { STAGING_BASE } = require('../src/cloud/client');

let passed = 0;
const ok = (n, c) => { assert.ok(c, n); console.log('  ✓ ' + n); passed++; };

// installed builds use production by default
ok('packaged + no opt-in → production', (() => {
  const c = CAP.resolveCapability({ isPackaged: true, stagingOptIn: false });
  return c.environment === 'production' && c.available === true && c.authAvailable === true
    && c.reason === null && c.apiBase === CAP.PRODUCTION_BASE;
})());

// installed build can NEVER reach staging, even if the environment variable is set
ok('packaged + opt-in → production (no accidental staging)', (() => {
  const c = CAP.resolveCapability({ isPackaged: true, stagingOptIn: true });
  return c.environment === 'production' && c.apiBase === CAP.PRODUCTION_BASE;
})());

// ordinary dev follows the same production environment users receive
ok('dev + no opt-in → production', (() => {
  return CAP.resolveCapability({ isPackaged: false, stagingOptIn: false }).environment === 'production';
})());

// dev build with explicit opt-in → staging + the staging base URL
ok('dev + opt-in → staging w/ staging base', (() => {
  const c = CAP.resolveCapability({ isPackaged: false, stagingOptIn: true });
  return c.environment === 'staging' && c.available === true && c.authAvailable === true
    && c.reason === null && c.apiBase === STAGING_BASE;
})());

// production only when enabled AND a base exists
ok('production enabled + base → production', (() => {
  const c = CAP.resolveCapability({ isPackaged: true, productionEnabled: true, productionBase: 'https://api.example.com' });
  return c.environment === 'production' && c.available === true && c.apiBase === 'https://api.example.com';
})());
ok('explicit dev staging wins over production', (() => {
  return CAP.resolveCapability({ isPackaged: false, stagingOptIn: true, productionEnabled: true, productionBase: 'https://api.example.com' }).environment === 'staging';
})());
ok('production enabled but no base → explicit staging fallback', (() => {
  return CAP.resolveCapability({ isPackaged: false, stagingOptIn: true, productionEnabled: true, productionBase: '' }).environment === 'staging';
})());
ok('production disabled + no staging → unavailable', (() => {
  return CAP.resolveCapability({ isPackaged: true, productionEnabled: false }).environment === 'unavailable';
})());

ok('production defaults are enabled and use HTTPS', CAP.PRODUCTION_ENABLED === true && CAP.PRODUCTION_BASE === 'https://api.vos.pp.ua');

// publicCapability hides apiBase and normalizes the shape
ok('publicCapability: strips apiBase', (() => {
  const full = CAP.resolveCapability({ isPackaged: true });
  const pub = CAP.publicCapability(full);
  return !('apiBase' in pub) && pub.environment === 'production' && pub.available === true;
})());
ok('publicCapability: safe defaults for junk', (() => {
  const pub = CAP.publicCapability(undefined);
  return pub.environment === 'unavailable' && pub.available === false && pub.authAvailable === false && pub.reason === null;
})());

console.log('\nAll ' + passed + ' cloud-capability tests passed.');
