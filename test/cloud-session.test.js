'use strict';

// CODE-001 1.3: exercise the service directly, independently of Electron/main's cache.
const assert = require('assert');
const path = require('path');
const { makeTempDir } = require('./helpers/temp-dir');
const { createCloudSession } = require('../src/cloud/session');
const cloudOauth = require('../src/cloud/oauth');
const { buildGoogleStartUrl } = require('../src/cloud/client');
const profile = name => ({ user: { id: name, explicit_opt_in: name === 'B' }, entitlements: ['catalog'] });
let checks = 0;
function make(options = {}) {
  let client = options.client || null;
  let base = 'https://cloud.example.test';
  // A partial storage override (e.g. a failing write) restores the real mkdir/rm.
  // Keep every profile under the shared helper even when most IO is mocked.
  let userData = makeTempDir('znada-cloud-session-');
  const writes = [], states = [];
  const service = createCloudSession({
    cloudClient: () => client,
    cloudCapability: () => ({ apiBase: base }),
    getUserDataPath: () => userData,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from('encrypted:' + value), decryptString: value => String(value).slice(10) },
    openExternal: () => Promise.resolve(), publishState: state => states.push(state),
    cloudOauth, buildGoogleStartUrl,
  });
  service.setStorage({ existsSync: () => false, mkdirSync: () => {}, writeFileSync: (p, bytes) => writes.push([p, String(bytes)]), renameSync: () => {}, rmSync: () => {} });
  return { service, writes, states, setClient: value => { client = value; }, setBase: value => { base = value; }, setPath: value => { userData = value; } };
}
async function check(name, fn) { await fn(); checks++; console.log('  ok ' + name); }
(async () => {
  await check('two instances keep bearer, profile, generation and broadcasts separate', () => {
    const a = make(), b = make();
    const beforeB = b.service.cloudSessionSnapshot();
    a.service.replaceCloudSession('A-secret', profile('A'), { broadcast: true });
    assert.strictEqual(a.service.cloudAuthState().user.id, 'A');
    assert.deepStrictEqual(b.service.cloudSessionSnapshot(), beforeB);
    assert.strictEqual(b.service.cloudAuthState().signedIn, false);
    assert.strictEqual(a.states.length, 1); assert.strictEqual(b.states.length, 0);
    assert.ok(!JSON.stringify(a.states).includes('A-secret'));
  });
  await check('same bearer after a logout is a different generation', () => {
    const { service: s } = make();
    s.replaceCloudSession('same', profile('A')); const old = s.cloudSessionSnapshot();
    s.replaceCloudSession(null, null); s.replaceCloudSession('same', profile('B'));
    assert.strictEqual(s.cloudSessionIsCurrent(old), false);
    s.cloudHandleAuthError({ ok: false, error: { status: 401 } }, old);
    assert.strictEqual(s.cloudAuthState().user.id, 'B');
  });
  await check('provider callbacks retain their session identity', () => {
    const { service: s } = make({ client: {} });
    s.replaceCloudSession('same', profile('A')); const old = s.appSession();
    s.replaceCloudSession(null, null); s.replaceCloudSession('same', profile('B'));
    assert.strictEqual(old.isCurrent(), false); assert.strictEqual(old.explicitAllowed, false);
    old.onAuthError({ ok: false, error: { status: 401 } });
    assert.strictEqual(s.appSession().explicitAllowed, true);
  });
  await check('capability and client are obtained at call time', async () => {
    const h = make(); assert.strictEqual(h.service.appSession(), null);
    h.setBase(null); assert.strictEqual(h.service.cloudAuthState().available, false);
    assert.deepStrictEqual(await h.service.favorites(), { items: [], error: 'unavailable' });
    h.setClient({ getFavorites: async token => ({ ok: true, data: { items: [token] } }) });
    h.setBase('https://new.example.test'); h.service.replaceCloudSession('A', profile('A'));
    assert.deepStrictEqual(await h.service.favorites(), { items: ['A'], error: null });
    assert.strictEqual(h.service.cloudAuthState().available, true);
  });
  await check('storage override belongs to its instance and profile path is read when saving', () => {
    const a = make(), b = make(); const nextPath = makeTempDir('znada-cloud-session-new-');
    a.setPath(nextPath);
    assert.strictEqual(a.service.replaceCloudSession('A', profile('A'), { persist: true }), true);
    assert.strictEqual(a.writes[0][0], path.join(nextPath, 'cloud-session.bin.tmp'));
    assert.strictEqual(a.writes[0][1], 'encrypted:A'); assert.deepStrictEqual(b.writes, []);
  });
  await check('failed token save does not publish a candidate', () => {
    const h = make(); h.service.replaceCloudSession('A', profile('A'));
    h.service.setStorage({ writeFileSync: () => { throw Error('write failed'); } });
    assert.strictEqual(h.service.replaceCloudSession('B', profile('B'), { persist: true, broadcast: true }), false);
    assert.strictEqual(h.service.cloudAuthState().user.id, 'A'); assert.strictEqual(h.states.length, 0);
  });
  await check('late favorite result for an identical bearer in a new generation is rejected', async () => {
    let finish; const h = make({ client: { addFavorite: () => new Promise(resolve => { finish = resolve; }) } });
    h.service.replaceCloudSession('same', profile('A')); const pending = h.service.favorite('photo', true);
    h.service.replaceCloudSession(null, null); h.service.replaceCloudSession('same', profile('B'));
    finish({ ok: true }); assert.deepStrictEqual(await pending, { ok: false, error: 'session_changed' });
  });
  await check('late stored-profile validation cannot republish a previous generation', async () => {
    let finish; const h = make({ client: { getMe: () => new Promise(resolve => { finish = resolve; }) } });
    h.service.replaceCloudSession('same', null); const pending = h.service.readSession();
    h.service.replaceCloudSession(null, null); h.service.replaceCloudSession('same', profile('B'));
    finish({ ok: true, data: profile('A') }); assert.strictEqual((await pending).user.id, 'B');
  });
  await check('signout revokes the captured bearer after dropping local state', async () => {
    const calls = []; const h = make({ client: { logout: async token => { calls.push(token); assert.strictEqual(h.service.cloudAuthState().signedIn, false); } } });
    h.service.replaceCloudSession('A', profile('A'));
    assert.strictEqual((await h.service.signout()).state.signedIn, false); assert.deepStrictEqual(calls, ['A']);
    assert.strictEqual(h.service.cancelSignin().cancelled, false);
  });
  console.log(`PASS cloud-session: ${checks} checks`);
})().catch(err => { console.error(err); process.exitCode = 1; });
