'use strict';

// ONL-002 stage 3, wiring. The real bookmark runtime with a fake Cloud server:
// production (no /v1/bookmarks there yet) never asks the server anything; on
// staging a star becomes a queued operation, a remote change reaches the pool
// star of a downloaded original, and signing out stops the engine.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Runtime = require('../src/bookmark-runtime');
const Store = require('../src/bookmark-store');
const SyncState = require('../src/bookmark-sync-state');
const library = require('../src/library');
const Fake = require('./helpers/fake-bookmark-server');
const { makeTempDir } = require('./helpers/temp-dir');

const tick = (ms = 30) => new Promise((resolve) => { setTimeout(resolve, ms); });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Real runtime/store/queue and server: hold an already applied operation's reply
// independently of the provider lookup. No debounce timing controls this race.
async function enrichmentRace(order) {
  const configPath = path.join(makeTempDir('znada-bookmark-enrichment-'), 'config.json');
  const server = Fake.create(), lookup = deferred(), sent = deferred(), reply = deferred();
  const handlers = {}, env = { account: 'acct-a', revision: 1 };
  const bodies = [];
  function device(file, api, registry, ipc) {
    return Runtime.create({ configPath: file, getConfig: () => ({ library: {} }),
      updateItem: () => {}, savePool: () => {},
      authState: () => ({ signedIn: true, user: { id: env.account } }),
      sessionSnapshot: () => ({ token: 'fixture', revision: env.revision }),
      sessionIsCurrent: (snapshot) => snapshot.revision === env.revision,
      client: () => api, providers: { context: () => ({}), requestHeaders: () => ({}) },
      registry, publish: () => {}, ipcMain: { handle: (name, fn) => { ipc[name] = fn; } },
      syncEnabled: () => true, log: () => {},
    });
  }
  const api = { ...server.api, bookmarkOperation: async (body) => {
    bodies.push(structuredClone(body));
    const result = await server.api.bookmarkOperation(body);
    if (bodies.length === 1) { sent.resolve(); await reply.promise; }
    return result;
  } };
  const runtime = device(configPath, api, { byId: () => ({ lookup: () => lookup.promise }) }, handlers);
  try {
    assert.equal((await runtime.sync.run()).ok, true); // establish account before star
    const card = { kind: 'internet', item: { provider: 'wallhaven', id: 'abc123' } };
    handlers['favorite-set'](null, card, true);
    // A personal edit is part of the first frozen request and must survive lookup.
    handlers['bookmark-tags'](null, card, ['personal']);
    const resolving = runtime.resolveForUse('wallhaven:abc123');
    const flushing = runtime.sync.run();
    await sent.promise;
    const frozen = structuredClone(bodies[0]);
    assert.deepEqual(frozen.metadata.source_tags, []);
    const frozenState = SyncState.create({ configPath });
    assert.deepEqual(frozenState.account('acct-a').pending['wallhaven:abc123'].body, frozen,
      'the first request is durably frozen before enrichment');
    const before = frozenState.seq();
    if (order === 'reply-first') { reply.resolve(); await flushing; }
    if (order === 'unstar') handlers['favorite-set'](null, card, false);
    if (order === 'account-switch' || order === 'session-switch') {
      if (order === 'account-switch') env.account = 'acct-b';
      env.revision++;
    }
    if (order === 'write-failure') {
      const file = Store.storePathFor(configPath);
      fs.renameSync(file, file + '.saved');
      fs.mkdirSync(file); // refuse replacing the durable store, without mocking put
    }
    lookup.resolve({ item: { provider: 'wallhaven', id: 'abc123', tags: ['landscape'],
      title: 'Late title', author: 'Late author', width: 1920, height: 1080, purity: 'sfw' } });
    const result = await resolving;
    const guarded = ['unstar', 'account-switch', 'session-switch', 'write-failure'].includes(order);
    if (!guarded) {
      const queued = SyncState.create({ configPath });
      assert.ok(queued.seq() > before, `${order}: enrichment must queue a newer durable change`);
      assert.ok(queued.account('acct-a').dirty['wallhaven:abc123']);
    } else {
      assert.equal(result.error, order === 'unstar' ? 'badItem'
        : order === 'write-failure' ? 'bookmark_write_failed' : 'session_changed');
      if (order === 'write-failure') {
        assert.equal(SyncState.create({ configPath }).seq(), before, 'failed store write cannot dirty sync');
        assert.deepEqual(runtime.list().records['wallhaven:abc123'].metadata.source_tags, []);
        // Allow the held server reply to finish after checking the failed write.
        fs.rmdirSync(Store.storePathFor(configPath));
        fs.renameSync(Store.storePathFor(configPath) + '.saved', Store.storePathFor(configPath));
      }
    }
    reply.resolve(); await flushing;
    if (guarded) {
      assert.equal(bodies.some((body) => body.metadata?.source_tags?.includes('landscape')), false);
      const stored = Store.create({ configPath }).get('acct-a', 'wallhaven:abc123');
      assert.deepEqual(stored.metadata.source_tags, []);
      if (order === 'unstar') {
        assert.equal(stored.state, 'removed');
        assert.equal(server.rows.get('wallhaven:abc123').state, 'removed');
      }
      assert.equal(Store.create({ configPath }).get('acct-b', 'wallhaven:abc123'), null);
      return;
    }
    await runtime.sync.run();
    assert.deepEqual(bodies[0], frozen, 'the first operation remains immutable');
    assert.equal(bodies.length, 2, 'one new operation carries the late metadata');
    assert.notEqual(bodies[1].operation_id, frozen.operation_id);
    assert.equal(bodies[1].type, 'update');
    assert.equal(bodies[1].expected_revision, 1);
    const local = Store.create({ configPath }).get('acct-a', 'wallhaven:abc123');
    assert.deepEqual(local.metadata.source_tags, ['landscape']);
    assert.deepEqual(local.metadata.user_tags, ['personal']);
    assert.equal(local.metadata.author, 'Late author');
    assert.equal(local.metadata.width, 1920);
    assert.deepEqual(server.rows.get('wallhaven:abc123').metadata, local.metadata);
    const second = device(path.join(makeTempDir('znada-bookmark-device-'), 'config.json'), server.api,
      { byId: () => null }, {});
    try {
      await second.sync.run();
      assert.deepEqual(second.list().records['wallhaven:abc123'].metadata, local.metadata,
        'a second device receives enriched source fields and separate personal tags');
    } finally { second.sync.stop(); }
    const seq = SyncState.create({ configPath }).seq();
    await runtime.resolveForUse('wallhaven:abc123');
    await runtime.sync.run();
    assert.equal(SyncState.create({ configPath }).seq(), seq, 'no-op resolve does not dirty');
    assert.equal(bodies.length, 2, 'no-op does not send another operation');
  } finally { reply.resolve(); runtime.sync.stop(); }
}

(async () => {
  for (const order of ['resolve-first', 'reply-first', 'unstar', 'account-switch', 'session-switch', 'write-failure']) {
    let timeout;
    try {
      await Promise.race([enrichmentRace(order), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`enrichment race timed out: ${order}`)), 10000);
      })]);
    } finally { clearTimeout(timeout); }
  }
  console.log('bookmark enrichment: both reply orders, second device, no-op, guards, IO refusal PASS');
  const dir = makeTempDir('znada-bookmark-sync-runtime-');
  const configPath = path.join(dir, 'config.json');
  const config = { library: {} };
  const server = Fake.create();
  const env = { signedIn: true, staging: false, revision: 1, published: 0, authErrors: 0, sync: [] };
  const handlers = {};
  const runtime = Runtime.create({
    configPath, getConfig: () => config,
    updateItem: (id, patch) => library.updateItem(config.library, id, patch), savePool: () => {},
    authState: () => ({ signedIn: env.signedIn, user: env.signedIn ? { id: 'acct-a' } : null }),
    sessionSnapshot: () => ({ token: env.signedIn ? 'tok' : null, revision: env.revision }),
    sessionIsCurrent: (snapshot) => snapshot.revision === env.revision,
    client: () => ({ ...server.api }),
    providers: { context: () => ({}), requestHeaders: () => ({}) },
    registry: { byId: () => null },
    publish: () => { env.published += 1; },
    publishSync: (status) => env.sync.push(status),
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    syncEnabled: () => env.staging,
    handleAuthError: () => { env.authErrors += 1; },
    log: () => {},
  });

  const id = library.addPath(config.library, 'image', path.join(dir, 'original.jpg'), {});
  library.updateItem(config.library, id, { source: 'https://danbooru.donmai.us/posts/555' });
  const card = { kind: 'internet', item: { provider: 'wallhaven', id: 'abc123', title: 'Mountains' } };

  // Production: the star works locally, the server is never asked.
  runtime.sessionChanged();
  assert.equal((await handlers['favorite-set'](null, card, true)).error, null);
  await tick();
  assert.equal(server.calls.length, 0, 'no bookmark request where the server has no /v1/bookmarks');
  assert.deepEqual(await handlers['bookmark-sync-status'](), { state: 'off', held: 0 }, 'production shows nothing about sync');
  assert.deepEqual(await handlers['bookmark-sync-retry'](), { state: 'off', held: 0 });
  assert.equal(server.calls.length, 0, 'retry cannot reach a server without bookmarks');

  // Staging: connecting moves what this account already had, then a new star is
  // sent as one operation shortly after the click.
  env.staging = true;
  runtime.sessionChanged();
  await tick(80);
  assert.equal(server.rows.get('wallhaven:abc123')?.state, 'active', 'the earlier star reached the account');
  assert.deepEqual(env.sync.map((s) => s.state).filter((s) => s !== 'off'), ['syncing', 'ok'], 'the window hears connect and success');
  assert.equal((await handlers['bookmark-sync-status']()).state, 'ok');
  const beforeRetry = server.calls.length;
  assert.equal((await handlers['bookmark-sync-retry']()).state, 'ok', 'retry runs and reports');
  // PR #210 review: the state was already ok, so prove the engine actually ran.
  assert.ok(server.calls.length > beforeRetry, 'Try again asks the server');
  runtime.sessionChanged();
  const before = server.calls.length;
  await tick();
  assert.equal(server.calls.length, before, 'asking for the session again does not restart the engine');
  const second = { kind: 'internet', item: { provider: 'gelbooru', id: '42', title: 'Lake' } };
  assert.equal((await handlers['favorite-set'](null, second, true)).error, null);
  await tick(1700);
  assert.equal(server.rows.get('gelbooru:42')?.state, 'active', 'the click became a queued operation');

  // Another device stars the downloaded original's post: after the next pull the
  // local file shows the star too.
  server.otherDevice.operation({ type: 'add', source: 'danbooru', post_id: '555', expected_revision: 0, metadata: { title: 'x' } });
  await runtime.sync.run();
  assert.equal(config.library[id].favorite, true, 'a remote star reaches the downloaded original');
  assert.ok(env.published > 0, 'windows are told the list changed');

  // Signing out stops the engine; nothing is sent for signed-out stars.
  env.signedIn = false;
  env.revision += 1;
  runtime.sessionChanged();
  const quiet = server.calls.length;
  await handlers['favorite-set'](null, { kind: 'internet', item: { provider: 'gelbooru', id: '43' } }, true);
  await tick(1700);
  assert.equal(server.calls.length, quiet, 'a signed-out star stays on this computer');
  assert.equal(server.rows.has('gelbooru:43'), false);
  assert.equal(env.sync.at(-1).state, 'off', 'sign-out clears the state in the window');
  assert.deepEqual(await handlers['bookmark-sync-status'](), { state: 'off', held: 0 });

  console.log('bookmark-sync-runtime: production silent, staging queue, remote star, sign-out PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
