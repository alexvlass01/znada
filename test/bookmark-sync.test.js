'use strict';

// ONL-002 stage 3. The sync engine against a fake Cloud server (test/helpers/
// fake-bookmark-server.js): silent move into the first account only, shared
// account limits, the queue across a lost answer and a restart, conflicts, changes
// and resets. Real bookmark and sync-state files in a temp profile.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Store = require('../src/bookmark-store');
const SyncState = require('../src/bookmark-sync-state');
const Sync = require('../src/bookmark-sync');
const Service = require('../src/bookmark-service');
const Fake = require('./helpers/fake-bookmark-server');
const { createClient } = require('../src/cloud/client');
const { makeTempDir } = require('./helpers/temp-dir');

const ULID = '01HZX5V3K8Q9R2T4W6Y8Z0ABCD';

function profile() {
  const dir = makeTempDir('znada-bookmark-sync-');
  return path.join(dir, 'config.json');
}

let rigs = 0;
function rig({ configPath = profile(), server = Fake.create(), account = 'acct-a', pool = [], library = null, clock = { now: Date.now() }, frozen = { on: false } } = {}) {
  const instance = ++rigs;
  const store = Store.create({ configPath });
  const state = SyncState.create({ configPath });
  const env = { account, current: true, authErrors: 0, statuses: [], timers: [] };
  const service = library && Service.create({ store, getConfig: () => ({ library }), getAccount: () => env.account,
    updateItem: (id, patch) => Object.assign(library[id], patch), savePool() {},
    onChange: (owner, key) => engine.touch(owner, key) });
  const engine = Sync.create({
    store, state, getAccount: () => env.account,
    connect: () => (env.account ? { api: server.api, isCurrent: () => env.current, onAuthError: () => { env.authErrors += 1; } } : null),
    applyRemote: (owner, records) => service ? service.applyRemote(owner, records) : store.putMany(owner, records),
    localCandidates: () => pool, paused: () => frozen.on,
    sleep: async () => {}, setTimer: (_fn, ms) => { env.timers.push(ms); return null; }, clearTimer: () => {}, now: () => clock.now,
    onStatus: (status) => env.statuses.push(status),
    // Distinct per instance: a restarted app must reuse the STORED id, not regenerate a lookalike.
    uuid: (() => { let n = 0; return () => `00000000-0000-4000-${String(8000 + instance)}-${String(++n).padStart(12, '0')}`; })(),
  });
  return { configPath, server, store, state, env, engine, clock, service };
}

function booru(id, at, extra = {}) {
  return { source: 'gelbooru', post_id: String(id), favorited_at: at, metadata: { title: `post ${id}` }, state: 'active', ...extra };
}
const routes = (server, route) => server.calls.filter((call) => call.route === route);

(async () => {
  // Two devices, both with downloaded originals. An explicit personal edit
  // travels both ways; legacy mixed tags remain local display data.
  {
    const file = { id: 'photo', path: 'C:/fixture.jpg', source: 'https://wallhaven.cc/w/abc123',
      tags: ['sky', 'legacy'], favorite: true, favoritedAt: 1 };
    const a = rig({ library: { photo: structuredClone(file) } });
    const b = rig({ server: a.server, library: { photo: structuredClone(file) } });
    a.service.set({ kind: 'local', id: 'photo' }, true);
    await a.engine.run(); await b.engine.run();
    assert.equal(a.service.tags({ kind: 'local', id: 'photo' }, ['sunset']).error, null);
    assert.ok(a.state.account('acct-a').dirty['wallhaven:abc123'], 'edit is durably queued');
    await a.engine.run(); await b.engine.run();
    assert.deepEqual(b.service.list().entries[0].item.tags, ['sky', 'legacy', 'sunset']);
    assert.deepEqual(a.server.rows.get('wallhaven:abc123').metadata.user_tags, ['sunset']);
    b.service.tags({ kind: 'local', id: 'photo' }, []);
    await b.engine.run(); await a.engine.run();
    assert.deepEqual(a.service.list().entries[0].item.tags, ['sky', 'legacy']);
    assert.deepEqual(a.store.get('acct-a', 'wallhaven:abc123').metadata.user_tags || [], []);
  }
  // BUG-059: a schema-valid but broken snapshot must settle without applying a
  // partial snapshot, importing candidates or dropping the pending local edit.
  for (const mode of ['null', 'repeat', 'cycle', 'endless', 'missing-final']) {
    const r = rig();
    r.store.put('acct-a', booru(77, 10, { metadata: { user_tags: ['unsent'] } }));
    r.engine.touch('acct-a', 'gelbooru:77');
    const queued = r.state.account('acct-a').dirty['gelbooru:77'];
    let calls = 0;
    const snapshot = r.server.api.bookmarkSnapshot;
    r.server.api.bookmarkSnapshot = async () => {
      calls++;
      // The sentinel turns the old infinite loop into a deterministic RED.
      assert.ok(calls <= 100, mode + ': snapshot requests must be bounded');
      return { ok: true, data: { items: [{ ...booru(77, 10), revision: 99 }],
        done: mode === 'missing-final', changes_cursor: null,
        next_cursor: mode === 'null' ? null : mode === 'repeat' ? 'same'
          : mode === 'cycle' ? (calls % 2 ? 'a' : 'b') : String(calls),
      } };
    };
    assert.deepEqual(await r.engine.run(), { error: 'retry' }, mode);
    assert.equal(r.engine.status().state, 'error', mode + ': no stuck syncing caption');
    assert.deepEqual(r.state.account('acct-a').dirty['gelbooru:77'], queued);
    assert.deepEqual(r.store.get('acct-a', 'gelbooru:77').metadata.user_tags, ['unsent']);
    assert.equal(r.state.account('acct-a').cursor, null);
    assert.equal(routes(r.server, 'bookmarkImport').length, 0);
    assert.ok(r.env.timers.includes(30000), 'retry backs off instead of looping');
    r.server.api.bookmarkSnapshot = snapshot;
    assert.equal((await r.engine.run()).ok, true, 'recovers when server pagination is repaired');
    assert.deepEqual(r.server.rows.get('gelbooru:77').metadata.user_tags, ['unsent']);
  }
  // 1. Silent move on the first sign-in: booru by import with their own dates,
  // catalog wallpapers by operation; the signed-out links are claimed by this
  // account, and a second account never receives them.
  {
    const r = rig({ account: null });
    r.store.put(null, booru(10, 500));
    r.store.put(null, { source: 'wallhaven', post_id: 'abc123', favorited_at: 700, metadata: { user_tags: ['mine'] }, state: 'active' });
    r.store.put(null, { source: 'znada', post_id: ULID, favorited_at: 600, metadata: { title: 'catalog', user_tags: ['z'] }, state: 'active' });
    r.store.put(null, booru(11, 400, { state: 'removed' }));
    assert.deepEqual(await r.engine.run(), { skipped: 'signed_out' }, 'nothing leaves the computer while signed out');
    r.env.account = 'acct-a';
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.equal(r.server.rows.get('gelbooru:10').favorited_at, 500, 'the original star date travels');
    assert.equal(r.server.rows.get('wallhaven:abc123').metadata.user_tags[0], 'mine');
    assert.equal(r.server.rows.has('gelbooru:11'), false, 'a removed signed-out link is not uploaded');
    const catalogOp = routes(r.server, 'bookmarkOperation')[0].input;
    assert.equal(catalogOp.source, 'znada');
    assert.deepEqual(catalogOp.metadata, { user_tags: ['z'] }, 'only user_tags leave for a catalog wallpaper');
    assert.equal(routes(r.server, 'bookmarkImport').some((call) => call.input.items.some((item) => item.source === 'znada')), false,
      'import never carries catalog wallpapers');
    assert.equal(routes(r.server, 'bookmarkImport').at(-1).input.final, true, 'the import is closed');
    assert.equal(r.state.anonymousClaimedBy(), 'acct-a');
    for (const k of ['gelbooru:10', 'wallhaven:abc123', `znada:${ULID}`]) {
      assert.equal(r.store.get('acct-a', k).state, 'active', `${k} is now the account's record`);
    }
    assert.ok(r.state.account('acct-a').cursor, 'changes start where the snapshot ended');

    const b = rig({ configPath: r.configPath, server: Fake.create(), account: 'acct-b' });
    assert.deepEqual(await b.engine.run(), { ok: true });
    assert.equal(b.server.rows.size, 0, 'signed-out links went to the first account only');
    assert.equal(routes(b.server, 'bookmarkImport').length, 0);
  }

  // 2. 1950 active in the account, 100 new here: the 50 newest go, 50 stay held.
  {
    const server = Fake.create();
    for (let i = 0; i < 1950; i++) server.seed({ source: 'danbooru', post_id: String(100000 + i) });
    const r = rig({ server, account: null });
    r.store.putMany(null, Array.from({ length: 100 }, (_, i) => booru(i + 1, 1000 + i)));
    r.env.account = 'acct-a';
    assert.deepEqual(await r.engine.run(), { ok: true });
    const sent = routes(server, 'bookmarkImport').flatMap((call) => call.input.items.map((item) => Number(item.post_id)));
    assert.equal(sent.length, 50);
    assert.equal(Math.min(...sent), 51, 'the newest fifty, by star date');
    const held = r.state.account('acct-a').held;
    assert.equal(Object.keys(held).length, 50);
    assert.equal(held['gelbooru:1'], 'limit');
    assert.equal(r.store.get('acct-a', 'gelbooru:1').state, 'active', 'a held link stays visible on this computer');
    await r.engine.run();
    assert.equal(routes(server, 'bookmarkImport').length, 1, 'held links are not retried on every run');
  }

  // 3. 10 000 known keys (removed ones) and few active: no import starts at all.
  {
    const server = Fake.create();
    for (let i = 0; i < Fake.KNOWN; i++) server.seed({ source: 'danbooru', post_id: String(200000 + i), state: 'removed' });
    const r = rig({ server, account: null });
    r.store.putMany(null, [booru(1, 10), booru(2, 20)]);
    r.env.account = 'acct-a';
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.equal(routes(server, 'bookmarkImport').length, 0, 'the key ceiling is counted before any batch');
    assert.equal(Object.keys(r.state.account('acct-a').held).length, 2);
  }

  // 4. Another device takes the room between our snapshot and the second batch:
  // that batch is not repeated, the started import is closed, the room recounted.
  {
    const server = Fake.create();
    for (let i = 0; i < 1800; i++) server.seed({ source: 'danbooru', post_id: String(300000 + i) });
    const r = rig({ server, account: null });
    r.store.putMany(null, Array.from({ length: 250 }, (_, i) => booru(i + 1, 5000 + i)));
    server.hooks.beforeImport = () => {
      if (routes(server, 'bookmarkImport').length === 2) {
        for (let i = 0; i < 60; i++) server.seed({ source: 'danbooru', post_id: String(400000 + i) });
      }
    };
    r.env.account = 'acct-a';
    assert.deepEqual(await r.engine.run(), { ok: true });
    const imports = routes(server, 'bookmarkImport');
    const refused = JSON.stringify(imports[1].input.items);
    assert.equal(imports.filter((call) => JSON.stringify(call.input.items) === refused).length, 1,
      'a batch refused for the limit is never sent again');
    assert.equal(imports[2].input.items.length, 0, 'the started import is closed with an empty batch');
    assert.equal(imports[2].input.final, true);
    assert.equal(imports[3].input.items.length, 40, 'the recount leaves room for forty');
    assert.equal(server.importOpen(), false);
    assert.equal(Object.keys(r.state.account('acct-a').held).length, 110);
    assert.equal([...server.rows.values()].filter((row) => row.state === 'active').length, Fake.ACTIVE);
  }

  // 5. Queue: an operation whose answer was lost is resent with the same body and
  // operation_id, even after a restart, and the server records it once.
  {
    const r = rig();
    assert.deepEqual(await r.engine.run(), { ok: true }, 'connect an empty account');
    r.store.put('acct-a', booru(77, 900));
    r.engine.touch('acct-a', 'gelbooru:77');
    for (let i = 0; i < 4; i++) r.server.failOnce('bookmarkOperation', Fake.NETWORK, { applied: i === 0 });
    assert.equal((await r.engine.run()).error, 'network', 'four lost answers stop the run');
    const pending = r.state.account('acct-a').pending['gelbooru:77'];
    assert.ok(pending, 'the exact request survives on disk');
    // Restart: fresh instances read the same files.
    const again = rig({ configPath: r.configPath, server: r.server });
    assert.deepEqual(await again.engine.run(), { ok: true });
    const sent = routes(r.server, 'bookmarkOperation').map((call) => call.input.operation_id);
    assert.ok(sent.every((id) => id === pending.operation_id), 'every attempt carries the same operation_id');
    assert.equal(r.server.events.filter((entry) => entry.item.post_id === '77').length, 1, 'recorded once');
    assert.equal(again.state.account('acct-a').revisions['gelbooru:77'].r, 1);
    assert.deepEqual(again.state.account('acct-a').dirty, {});
  }

  // 6. Conflict: another device changed the key since our revision; the server's
  // state wins and the stale local change is dropped, not re-sent with a raised revision.
  {
    const r = rig();
    r.store.put('acct-a', booru(5, 100));
    r.engine.touch('acct-a', 'gelbooru:5');
    assert.deepEqual(await r.engine.run(), { ok: true });
    r.server.otherDevice.operation({ type: 'update', source: 'gelbooru', post_id: '5', expected_revision: 1, metadata: { title: 'theirs', user_tags: ['t'] } });
    r.store.put('acct-a', booru(5, 100, { state: 'removed' }));
    r.engine.touch('acct-a', 'gelbooru:5');
    // flush runs before pull: the remove is sent against revision 1 and refused.
    assert.deepEqual(await r.engine.run(), { ok: true });
    const removes = routes(r.server, 'bookmarkOperation').filter((call) => call.input.type === 'remove');
    assert.equal(removes.length, 1, 'no second attempt with a raised revision');
    assert.equal(r.store.get('acct-a', 'gelbooru:5').state, 'active', 'the newer server state is applied');
    assert.deepEqual(r.store.get('acct-a', 'gelbooru:5').metadata.user_tags, ['t']);
    assert.deepEqual(r.state.account('acct-a').dirty, {});
  }

  // 7. Changes from another device arrive; a 410 restarts from a snapshot and keeps
  // the queue; an unknown source from a newer server is skipped.
  {
    const r = rig();
    assert.deepEqual(await r.engine.run(), { ok: true });
    r.server.otherDevice.operation({ type: 'add', source: 'danbooru', post_id: '9', expected_revision: 0, metadata: { title: 'x' } });
    r.server.seed({ source: 'pixiv', post_id: '1' }, { emit: true });
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.equal(r.store.get('acct-a', 'danbooru:9').state, 'active');
    r.store.put('acct-a', booru(8, 50));
    r.engine.touch('acct-a', 'gelbooru:8');
    r.server.failOnce('bookmarkChanges', { ok: false, error: { code: 'sync_reset_required', status: 410, kind: 'api' } });
    r.server.failOnce('bookmarkOperation', Fake.NETWORK);
    r.server.failOnce('bookmarkOperation', Fake.NETWORK);
    r.server.failOnce('bookmarkOperation', Fake.NETWORK);
    r.server.failOnce('bookmarkOperation', Fake.NETWORK);
    await r.engine.run();
    assert.ok(r.state.account('acct-a').dirty['gelbooru:8'], 'still queued');
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.equal(r.server.rows.get('gelbooru:8').state, 'active', 'the queue survived the reset');
  }

  // 7b. A stale state (older revision than we know) never overwrites the record.
  {
    const r = rig();
    await r.engine.run();
    r.store.put('acct-a', booru(6, 10));
    r.engine.touch('acct-a', 'gelbooru:6');
    await r.engine.run();
    r.server.otherDevice.operation({ type: 'update', source: 'gelbooru', post_id: '6', expected_revision: 1, metadata: { title: 'v2' } });
    await r.engine.run();
    assert.equal(r.store.get('acct-a', 'gelbooru:6').metadata.title, 'v2');
    const cursor = r.state.account('acct-a').cursor;
    r.server.failOnce('bookmarkChanges', { ok: true, data: { items: [{ sequence: 1, type: 'add',
      item: { source: 'gelbooru', post_id: '6', revision: 1, state: 'removed', favorited_at: 10, restricted: false } }],
    done: true, next_cursor: cursor } });
    await r.engine.run();
    assert.equal(r.store.get('acct-a', 'gelbooru:6').state, 'active', 'revision 1 does not undo revision 2');
    assert.equal(r.store.get('acct-a', 'gelbooru:6').metadata.title, 'v2');
  }

  // 7c. A reset while the queue is paused keeps the queue; it is sent the next day.
  {
    const r = rig();
    await r.engine.run();
    r.store.put('acct-a', booru(12, 1));
    r.engine.touch('acct-a', 'gelbooru:12');
    r.server.failOnce('bookmarkOperation', { ok: false, error: { code: 'bookmark_daily_limit', status: 429, kind: 'api' } });
    r.server.failOnce('bookmarkChanges', { ok: false, error: { code: 'sync_reset_required', status: 410, kind: 'api' } });
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.ok(routes(r.server, 'bookmarkSnapshot').length >= 2, 'the reset took a new snapshot');
    assert.ok(r.state.account('acct-a').dirty['gelbooru:12'], 'the paused change is still queued after the reset');
    r.clock.now = Sync.nextUtcMidnight(r.clock.now) + 1;
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.equal(r.server.rows.get('gelbooru:12').state, 'active');
  }

  // 7d. An edit made while the previous operation was in flight is not lost: it is
  // sent next, against the revision that operation produced.
  {
    const r = rig();
    await r.engine.run();
    r.store.put('acct-a', booru(13, 1));
    r.engine.touch('acct-a', 'gelbooru:13');
    const send = r.server.api.bookmarkOperation;
    let once = true;
    r.server.api.bookmarkOperation = async (body) => {
      const result = await send(body);
      if (once) {
        once = false;
        r.store.put('acct-a', booru(13, 1, { metadata: { title: 'post 13', user_tags: ['later'] } }));
        r.engine.touch('acct-a', 'gelbooru:13');
      }
      return result;
    };
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.deepEqual(r.server.rows.get('gelbooru:13').metadata.user_tags, ['later']);
    assert.equal(r.server.rows.get('gelbooru:13').revision, 2, 'second operation used the new revision');
    assert.deepEqual(r.store.get('acct-a', 'gelbooru:13').metadata.user_tags, ['later'], 'the echo did not overwrite the edit');
  }

  // 8. Daily limit pauses operations until the next UTC midnight.
  {
    const r = rig();
    await r.engine.run();
    r.store.put('acct-a', booru(3, 1));
    r.engine.touch('acct-a', 'gelbooru:3');
    r.server.failOnce('bookmarkOperation', { ok: false, error: { code: 'bookmark_daily_limit', status: 429, kind: 'api' } });
    await r.engine.run();
    assert.equal(r.state.account('acct-a').pausedUntil, Sync.nextUtcMidnight(r.clock.now));
    const before = routes(r.server, 'bookmarkOperation').length;
    await r.engine.run();
    assert.equal(routes(r.server, 'bookmarkOperation').length, before, 'no operation until the day turns');
  }

  // 9. Session changes mid-run and a 401: the run stops; a damaged sync file
  // disables sync and is left untouched.
  {
    const r = rig();
    r.server.hooks.beforeImport = null;
    const original = r.server.api.bookmarkSnapshot;
    r.server.api.bookmarkSnapshot = async (q) => { r.env.current = false; return original(q); };
    assert.deepEqual(await r.engine.run(), { error: 'session_changed' });
    r.server.api.bookmarkSnapshot = original;
    r.env.current = true;
    r.server.failOnce('bookmarkSnapshot', { ok: false, error: { code: 'unauthorized', status: 401, kind: 'api' } });
    assert.deepEqual(await r.engine.run(), { error: 'auth' });
    assert.equal(r.env.authErrors, 1, 'a 401 goes to the session owner');

    const configPath = profile();
    const file = SyncState.statePathFor(configPath);
    fs.writeFileSync(file, '{"version":99}');
    const broken = rig({ configPath });
    assert.deepEqual(await broken.engine.run(), { skipped: 'storage' });
    assert.equal(fs.readFileSync(file, 'utf8'), '{"version":99}');
    assert.equal(broken.server.calls.length, 0);
  }

  // 9b. During a media-folder move nothing is asked or written; afterwards it runs.
  {
    const frozen = { on: true };
    const r = rig({ frozen });
    assert.deepEqual(await r.engine.run(), { error: 'frozen' });
    assert.equal(r.server.calls.length, 0);
    frozen.on = false;
    assert.deepEqual(await r.engine.run(), { ok: true });
  }

  // PR #208 review 1. The server refuses for the limit while its own snapshot still
  // shows room: the same batch is not sent again, and the links are held, not lost.
  {
    const r = rig({ account: null });
    r.store.putMany(null, [booru(10, 2), booru(11, 1)]);
    const real = r.server.api.bookmarkImport;
    r.server.api.bookmarkImport = async (body) => (body.items.length
      ? (r.server.calls.push({ route: 'bookmarkImport', input: body }), { ok: false, error: { code: 'bookmark_active_limit', status: 409, kind: 'api' } })
      : real(body));
    r.env.account = 'acct-a';
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.equal(routes(r.server, 'bookmarkImport').filter((call) => call.input.items.length).length, 1, 'the refused batch is sent once');
    assert.deepEqual(r.state.account('acct-a').held, { 'gelbooru:10': 'limit', 'gelbooru:11': 'limit' });
    assert.equal(r.store.get('acct-a', 'gelbooru:10').state, 'active', 'the held star stays in the account list here');
    assert.equal(r.state.account('acct-a').migrated, true);
  }

  // PR #208 review 2. A tag edit made while the import batch is out is not replaced
  // by the server's copy of the batch; it goes next as an update.
  {
    const r = rig();
    r.store.put('acct-a', booru(20, 5, { metadata: { title: 't', user_tags: ['old'] } }));
    const real = r.server.api.bookmarkImport;
    r.server.api.bookmarkImport = async (body) => {
      const result = await real(body);
      if (body.items.length) {
        r.store.put('acct-a', booru(20, 5, { metadata: { title: 't', user_tags: ['новое'] } }));
        r.engine.touch('acct-a', 'gelbooru:20');
      }
      return result;
    };
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.deepEqual(r.store.get('acct-a', 'gelbooru:20').metadata.user_tags, ['новое'], 'the local edit survives');
    assert.deepEqual(r.server.rows.get('gelbooru:20').metadata.user_tags, ['новое'], 'and reaches the server');
    assert.equal(routes(r.server, 'bookmarkOperation').at(-1).input.type, 'update');
    assert.deepEqual(r.state.account('acct-a').dirty, {});
  }

  // An edit made while a page of changes is out wins over that page: the page was
  // read before the edit existed.
  {
    const r = rig();
    r.store.put('acct-a', booru(21, 5, { metadata: { title: 't', user_tags: ['a'] } }));
    r.engine.touch('acct-a', 'gelbooru:21');
    await r.engine.run();
    r.server.otherDevice.operation({ type: 'update', source: 'gelbooru', post_id: '21', expected_revision: 1, metadata: { title: 't', user_tags: ['theirs'] } });
    const real = r.server.api.bookmarkChanges;
    r.server.api.bookmarkChanges = async (query) => {
      r.store.put('acct-a', booru(21, 5, { metadata: { title: 't', user_tags: ['mine-later'] } }));
      r.engine.touch('acct-a', 'gelbooru:21');
      r.server.api.bookmarkChanges = real;
      return real(query);
    };
    await r.engine.run();
    await r.engine.run();
    assert.deepEqual(r.store.get('acct-a', 'gelbooru:21').metadata.user_tags, ['mine-later']);
    assert.deepEqual(r.server.rows.get('gelbooru:21').metadata.user_tags, ['mine-later'], 'sent against the newer revision');
  }

  // PR #208 review 3. The media-folder freeze starts while the snapshot is out:
  // nothing is written into the pool path; the run stops and is retried.
  {
    const frozen = { on: false };
    const r = rig({ frozen });
    r.server.seed({ source: 'danbooru', post_id: '31' });
    const writes = [];
    const real = r.server.api.bookmarkSnapshot;
    r.server.api.bookmarkSnapshot = async (query) => { frozen.on = true; return real(query); };
    const store = r.store, putMany = store.putMany;
    store.putMany = (owner, records) => { writes.push(records.length); return putMany(owner, records); };
    assert.deepEqual(await r.engine.run(), { error: 'frozen' });
    assert.deepEqual(writes, [], 'no record written after the freeze began');
    r.server.api.bookmarkSnapshot = real;
    frozen.on = false;
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.equal(r.store.get('acct-a', 'danbooru:31').state, 'active', 'after the move the run completes');
  }

  // PR #208 re-review. The freeze begins while a refused import batch is out and the
  // next snapshot is empty, so writeLocal() has nothing to write and never asks:
  // the move's own write into the account list must stop on its own check.
  {
    const frozen = { on: false };
    const r = rig({ account: null, frozen });
    r.store.put(null, booru(31, 1));
    const real = r.server.api.bookmarkImport;
    r.server.api.bookmarkImport = async (body) => {
      if (!body.items.length) return real(body);
      frozen.on = true;
      return { ok: false, error: { code: 'bookmark_active_limit', status: 409, kind: 'api' } };
    };
    r.env.account = 'acct-a';
    assert.deepEqual(await r.engine.run(), { error: 'frozen' });
    assert.equal(r.store.get('acct-a', 'gelbooru:31'), null, 'nothing written into the account list during the move');
    assert.equal(r.state.account('acct-a').migrated, false);
    assert.deepEqual(r.state.account('acct-a').held, {});
    r.server.api.bookmarkImport = real;
    frozen.on = false;
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.equal(r.server.rows.get('gelbooru:31').state, 'active', 'after the move the link is uploaded');
  }

  // Stage 4. What the window is told: connecting is announced, a poll is not; a lost
  // connection is "offline", a server failure is "error", the daily limit is "paused",
  // and links that did not fit are counted, with a one-time notice after the move.
  {
    const server = Fake.create();
    for (let i = 0; i < 1999; i++) server.seed({ source: 'danbooru', post_id: String(500000 + i) });
    const r = rig({ server, account: null });
    r.store.putMany(null, [booru(1, 1), booru(2, 2), booru(3, 3)]);
    assert.deepEqual(r.engine.status(), { state: 'off', held: 0 }, 'signed out: nothing to show');
    r.env.account = 'acct-a';
    await r.engine.run();
    assert.deepEqual(r.env.statuses.map((s) => s.state), ['syncing', 'ok']);
    assert.equal(r.env.statuses[1].held, 2, 'two of three did not fit in the last free place');
    assert.equal(r.env.statuses[1].notice, 2, 'the move announces them once');
    r.env.statuses.length = 0;
    await r.engine.run();
    assert.deepEqual(r.env.statuses.map((s) => s.state), ['ok'], 'an ordinary poll does not say "syncing"');
    assert.equal(r.env.statuses[0].notice, undefined, 'the notice is not repeated');
    assert.equal(r.env.statuses[0].held, 2, 'the held count stays for the popover');

    for (let i = 0; i < 4; i++) server.failOnce('bookmarkChanges', Fake.NETWORK);
    await r.engine.run();
    assert.equal(r.engine.status().state, 'offline');
    for (let i = 0; i < 4; i++) server.failOnce('bookmarkChanges', { ok: false, error: { code: 'internal_error', status: 500, kind: 'api' } });
    await r.engine.run();
    assert.equal(r.engine.status().state, 'error');
    await r.engine.run();
    assert.equal(r.engine.status().state, 'ok', 'a later success clears the error');

    r.store.put('acct-a', booru(9, 9));
    r.engine.touch('acct-a', 'gelbooru:9');
    server.failOnce('bookmarkOperation', { ok: false, error: { code: 'bookmark_daily_limit', status: 429, kind: 'api' } });
    await r.engine.run();
    assert.equal(r.engine.status().state, 'paused');
    r.clock.now = Sync.nextUtcMidnight(r.clock.now) + 1;
    assert.equal(r.engine.status().state, 'ok', 'the pause ends with the day');

    r.engine.stop();
    assert.equal(r.env.statuses.at(-1).state, 'off', 'stopping (sign-out) clears the state');
  }

  // PR #210 review. A media-folder move freezes sync in the middle of the first
  // connect: "Syncing…" must not stay up while nothing runs, and a second run during
  // the same freeze must not bring it back. After the move the connect finishes.
  {
    const frozen = { on: false };
    const r = rig({ frozen });
    const real = r.server.api.bookmarkSnapshot;
    r.server.api.bookmarkSnapshot = async (query) => { frozen.on = true; return real(query); };
    r.server.seed({ source: 'danbooru', post_id: '77' });
    assert.deepEqual(await r.engine.run(), { error: 'frozen' });
    assert.deepEqual(r.engine.status(), { state: 'off', held: 0 }, 'before any connect there is nothing to show');
    assert.deepEqual(await r.engine.run(), { error: 'frozen' });
    assert.notEqual(r.engine.status().state, 'syncing', 'a run during the freeze does not put it back');
    r.server.api.bookmarkSnapshot = real;
    frozen.on = false;
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.equal(r.engine.status().state, 'ok');

    // Once connected, a freeze during a later reconnect falls back to that state.
    r.state.updateAccount('acct-a', (account) => { account.cursor = null; });
    r.server.otherDevice.operation({ type: 'update', source: 'danbooru', post_id: '77', expected_revision: 1, metadata: { title: 'v2' } });
    r.server.api.bookmarkSnapshot = async (query) => { frozen.on = true; return real(query); };
    assert.deepEqual(await r.engine.run(), { error: 'frozen' });
    assert.equal(r.engine.status().state, 'ok', 'the last real state, not "Syncing…"');
  }

  // Stage 5. Production before the Cloud deploy: every bookmark route answers a plain
  // "404 Not Found". Sync stays invisible, claims nothing, asks again only after six
  // hours or at the next start, and connects by itself once the server has the routes.
  {
    const server = Fake.create();
    const missing = { ok: false, error: { code: 'http_404', message: 'Request failed with HTTP 404.', status: 404, kind: 'http' } };
    const real = { ...server.api };
    let deployed = false;
    for (const name of Object.keys(real)) {
      server.api[name] = async (input) => { server.calls.push({ route: name, input }); return deployed ? real[name](input) : missing; };
    }
    const r = rig({ server, account: null });
    r.store.put(null, booru(1, 1));
    r.env.account = 'acct-a';
    assert.deepEqual(await r.engine.run(), { error: 'unsupported' });
    assert.deepEqual(r.env.statuses.map((s) => s.state), ['off'], 'no "Syncing…" on a server without bookmarks');
    assert.equal(r.state.anonymousClaimedBy(), null, 'signed-out links are not given to the account');
    assert.equal(r.state.account('acct-a').migrated, false);
    assert.deepEqual(r.env.timers, [], 'no short retry: the server is asked again only after hours');
    const asked = server.calls.length;
    assert.deepEqual(await r.engine.run(), { skipped: 'unsupported' });
    // PR #212 review (Grok): a moment before six hours it still does not ask.
    r.clock.now += 6 * 60 * 60 * 1000 - 1;
    assert.deepEqual(await r.engine.run(), { skipped: 'unsupported' });
    assert.equal(server.calls.length, asked, 'six hours minus a moment: still quiet');
    r.store.put('acct-a', booru(2, 2));
    r.engine.touch('acct-a', 'gelbooru:2');
    await r.engine.run();
    assert.equal(server.calls.length, asked, 'no request until the recheck time');
    assert.ok(r.state.account('acct-a').dirty['gelbooru:2'], 'the star waits in the queue');

    deployed = true;
    r.clock.now += 2;
    assert.deepEqual(await r.engine.run(), { ok: true }, 'after the deploy it connects by itself');
    assert.equal(r.state.anonymousClaimedBy(), 'acct-a');
    assert.equal(server.rows.get('gelbooru:1')?.state, 'active', 'the silent move happens then');
    assert.equal(server.rows.get('gelbooru:2')?.state, 'active', 'and the queued star is sent');
    assert.deepEqual(r.env.statuses.slice(-2).map((s) => s.state), ['syncing', 'ok']);

    // A legitimate not_found from Cloud (an unpublished wallpaper) is not "unsupported".
    const ulid = '01HZX5V3K8Q9R2T4W6Y8Z0ABCE';
    r.store.put('acct-a', { source: 'znada', post_id: ulid, favorited_at: 3, metadata: {}, state: 'active' });
    r.engine.touch('acct-a', `znada:${ulid}`);
    server.failOnce('bookmarkOperation', { ok: false, error: { code: 'not_found', message: 'x', status: 404, kind: 'api' } });
    assert.deepEqual(await r.engine.run(), { ok: true });
    assert.equal(r.state.account('acct-a').held[`znada:${ulid}`], 'unavailable');
    assert.equal(r.engine.status().state, 'ok');
  }

  // Stage 5: a 404 that IS a Cloud answer (ApiError body) is a failure to retry, not
  // "this server has no bookmarks".
  {
    const r = rig();
    r.server.failOnce('bookmarkSnapshot', { ok: false, error: { code: 'account_not_found', message: 'x', status: 404, kind: 'api' } });
    assert.deepEqual(await r.engine.run(), { error: 'account_not_found' });
    assert.equal(r.engine.status().state, 'error');
    assert.deepEqual(await r.engine.run(), { ok: true }, 'and the next run asks again');
  }

  // PR #212 review (Codex, Antigravity): a run asked for while the first probe is out
  // (a star, the poll) must find the pause at once, not send a second request.
  {
    const server = Fake.create();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let probes = 0;
    server.api.bookmarkSnapshot = async () => { probes += 1; await gate; return { ok: false, error: { code: 'http_404', status: 404, kind: 'http' } }; };
    const r = rig({ server });
    const first = r.engine.run();
    const second = r.engine.run();
    release();
    assert.deepEqual(await first, { skipped: 'unsupported' }, 'the coalesced rerun finds the pause');
    await second;
    assert.equal(probes, 1, 'one request, not two');
    assert.equal(r.engine.status().state, 'off');
    assert.deepEqual(r.env.timers, [], 'and no short retry');
  }

  // PR #212 review (Antigravity): a temporary proxy failure (plain 502) is not
  // "unsupported": it is retried, shown as an error, and asked again next time.
  {
    const r = rig();
    for (let i = 0; i < 4; i++) r.server.failOnce('bookmarkSnapshot', { ok: false, error: { code: 'http_502', status: 502, kind: 'http' } });
    assert.deepEqual(await r.engine.run(), { error: 'http_502' });
    assert.equal(r.engine.status().state, 'error');
    assert.ok(r.env.timers.length > 0, 'a short retry is scheduled');
    assert.deepEqual(await r.engine.run(), { ok: true });
  }

  // Stage 5: start() (app start, sign-in) asks a previously unsupported server again.
  {
    const server = Fake.create();
    let deployed = false;
    const real = { ...server.api };
    for (const name of Object.keys(real)) {
      server.api[name] = async (input) => (deployed ? real[name](input) : { ok: false, error: { code: 'http_404', status: 404, kind: 'http' } });
    }
    const r = rig({ server });
    assert.deepEqual(await r.engine.run(), { error: 'unsupported' });
    deployed = true;
    assert.deepEqual(await r.engine.run(), { skipped: 'unsupported' });
    r.engine.start(); r.engine.stop();
    assert.deepEqual(await r.engine.run(), { ok: true }, 'a restart probes again');
  }

  // 10. Pool stars with a site link join the first silent move as source_tags only.
  {
    const pool = [{ source: 'danbooru', post_id: '42', favorited_at: 3, metadata: { source_tags: ['sky', 'mine'] }, state: 'active' }];
    const r = rig({ account: null, pool });
    r.env.account = 'acct-a';
    await r.engine.run();
    assert.deepEqual(r.server.rows.get('danbooru:42').metadata, { source_tags: ['sky', 'mine'] });
  }

  // 11. Pure helpers: oversized operations shed source tags; batches respect bytes.
  {
    const tags = Array.from({ length: 100 }, (_, i) => `${'t'.repeat(120)}${i}`);
    const op = Sync.fitOperation({ operation_id: 'x', type: 'add', source: 'gelbooru', post_id: '1', expected_revision: 0,
      metadata: { title: 'a'.repeat(300), source_tags: tags, user_tags: ['keep'] } });
    assert.ok(Buffer.byteLength(JSON.stringify(op)) <= 16384);
    assert.deepEqual(op.metadata.user_tags, ['keep']);
    const big = Array.from({ length: 100 }, (_, i) => booru(i + 1, i, { metadata: { title: 'a'.repeat(300), source_tags: tags.slice(0, 20) } }));
    const batch = Sync.takeBatch(big);
    assert.ok(batch.length < 100 && batch.length > 0, 'the 256 KiB body limit splits a batch');
    const local = Sync.toLocal({ source: 'gelbooru', post_id: '1', revision: 2, state: 'active', favorited_at: 9, restricted: false,
      metadata: { title: 'server' } }, booru(1, 1, { metadata: { title: 'local', author: 'me', user_tags: ['old'] } }));
    assert.deepEqual(local.metadata, { title: 'server', author: 'me' }, 'server fields win; dropped user_tags follow the server');
    assert.equal(Sync.toLocal({ source: 'pixiv', post_id: '1', revision: 1, state: 'active', favorited_at: 1, restricted: false }, null), null);
  }

  // 12. Client routes: paths, bearer, and the conflict's current state reaches the engine.
  {
    const seen = [];
    const client = createClient({ baseUrl: 'https://cloud.test', fetchImpl: async (url, init) => {
      seen.push({ url, init });
      if (url.includes('operations')) {
        return { status: 409, text: async () => JSON.stringify({ error: { code: 'revision_conflict', message: 'x' }, current: null }) };
      }
      return { status: 200, text: async () => JSON.stringify({ items: [], done: true, expires_at: 1, next_cursor: null, changes_cursor: 'c' }) };
    } });
    const snap = await client.bookmarkSnapshot({ limit: 200 }, 'tok');
    assert.equal(snap.ok, true);
    assert.equal(seen[0].url, 'https://cloud.test/v1/bookmarks/snapshot?limit=200');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer tok');
    const conflict = await client.bookmarkOperation({ operation_id: 'x' }, 'tok');
    assert.equal(conflict.error.code, 'revision_conflict');
    assert.equal(Object.hasOwn(conflict.error, 'current'), true);
    assert.equal((await client.bookmarkImport({ items: [], final: true }, null)).error.code, 'missing_token');
  }

  console.log('bookmark-sync: silent move, shared limits, queue, conflicts, changes, resets PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
