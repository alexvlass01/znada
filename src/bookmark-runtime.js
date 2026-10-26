'use strict';

const path = require('path');
const B = require('./bookmarks');
const Store = require('./bookmark-store');
const Service = require('./bookmark-service');
const Resolver = require('./bookmark-resolver');
const Preview = require('./bookmark-preview');
const SyncState = require('./bookmark-sync-state');
const Sync = require('./bookmark-sync');

function create({ configPath, getConfig, updateItem, savePool, authState, sessionSnapshot,
  sessionIsCurrent, client, providers, registry, publish, ipcMain, publishSync = () => {},
  syncEnabled = () => false, handleAuthError = () => {}, poolFrozen = () => false, log = console.error }) {
  const store = Store.create({ configPath });
  const account = () => {
    const auth = authState();
    return auth.signedIn && auth.user?.id ? String(auth.user.id) : null;
  };
  const syncState = SyncState.create({ configPath });
  // Late-bound: the service reports local changes, the engine is built on the service.
  let sync = null;
  const service = Service.create({ store, getConfig, updateItem, savePool, getAccount: account,
    onChange: (owner, key) => { if (sync && syncEnabled()) sync.touch(owner, key); } });
  // ONL-002. Allowed for any configured Cloud; a server without /v1/bookmarks is
  // detected by the engine (stage 5). Every call carries the session it started with,
  // and a late answer is ignored.
  sync = Sync.create({
    store, state: syncState, getAccount: account, log, paused: poolFrozen,
    connect: () => {
      const api = syncEnabled() && client();
      const snapshot = sessionSnapshot();
      if (!api || !snapshot.token) return null;
      const token = snapshot.token;
      return {
        api: {
          bookmarkOperation: (body) => api.bookmarkOperation(body, token),
          bookmarkSnapshot: (query) => api.bookmarkSnapshot(query, token),
          bookmarkChanges: (query) => api.bookmarkChanges(query, token),
          bookmarkImport: (body) => api.bookmarkImport(body, token),
        },
        isCurrent: () => sessionIsCurrent(snapshot),
        onAuthError: (result) => handleAuthError(result, snapshot),
      };
    },
    applyRemote: (owner, records) => {
      const stored = service.applyRemote(owner, records);
      if (stored) publish();
      return stored;
    },
    localCandidates: () => service.poolFavorites(),
    onStatus: (status) => publishSync(status),
  });
  const descriptor = (input) => input?.kind === 'cloud'
    ? { ...input, item: { ...input.item, provider: 'znada' } } : input;
  const resolver = Resolver.create({
    directory: path.join(path.dirname(configPath), 'bookmark-previews'),
    getOwner: () => B.partitionKey(account()),
    getGeneration: () => B.partitionKey(account()) + ':' + sessionSnapshot().revision,
    lookup: async (source, id) => {
      const provider = registry.byId(source);
      if (!provider?.lookup) return { error: 'unavailable' };
      const ctx = providers.context(provider);
      if (source === 'znada' && !ctx.credentials) {
        const snapshot = sessionSnapshot();
        ctx.credentials = { client: client(), token: null, isCurrent: () => sessionIsCurrent(snapshot) };
      }
      const result = await provider.lookup(id, ctx);
      return result.item ? { ...result, item: { ...result.item,
        loadsDirectly: !!provider.loadsDirectly, cardKind: provider.cardKind || 'internet' } } : result;
    },
    preview: (item) => Preview.fetchPreview(item, providers.requestHeaders(item)),
  });
  async function resolve(key, source) {
    const owner = account(), generation = sessionSnapshot().revision;
    const record = store.get(owner, key);
    if (!record || record.state === 'removed' || (source && source !== record.source)) return { error: 'badItem' };
    const result = await resolver.resolve(record);
    if (account() !== owner || sessionSnapshot().revision !== generation) return { error: 'session_changed' };
    const latest = store.get(owner, key);
    if (!latest || latest.state === 'removed') return { error: 'badItem' };
    const state = result.item ? 'active' : result.unavailable ? 'unavailable' : latest.state;
    const metadata = result.item ? { ...latest.metadata, ...Service.metadata(result.item),
      ...(latest.metadata.user_tags ? { user_tags: latest.metadata.user_tags } : {}) } : latest.metadata;
    if (state !== latest.state || JSON.stringify(metadata) !== JSON.stringify(latest.metadata)) {
      const next = { ...latest, state, metadata };
      if (!store.put(owner, next)) return { error: 'bookmark_write_failed' };
      // A frozen operation cannot include this lookup. Give changed wire metadata
      // a newer durable sequence so its late reply keeps it and queues an update.
      // Availability and Znada catalog display fields are local, so do not sync them.
      if (syncEnabled() && JSON.stringify(B.operationMetadata(next)) !== JSON.stringify(B.operationMetadata(latest))) {
        sync.touch(owner, key);
      }
    }
    return result;
  }
  ipcMain.handle('favorites-list', () => service.list());
  ipcMain.handle('favorite-state', (_event, input) => service.state(descriptor(input)));
  ipcMain.handle('favorite-set', (_event, input, on) => {
    const result = service.set(descriptor(input), on);
    if (!result.error) {
      publish();
      const ref = service.state(descriptor(input)).ref;
      // Resolve metadata and a small preview after the durable star; never fetch an
      // original here. This also makes source tags searchable before the first visit.
      if (on && ref) void resolve(B.keyFor(ref.source, ref.post_id)).then(() => publish()).catch(() => {});
    }
    return { on: result.on, error: result.error };
  });
  ipcMain.handle('bookmark-tags', (_event, input, tags) => {
    const result = service.tags(descriptor(input), tags);
    if (!result.error) publish();
    return result;
  });
  ipcMain.handle('bookmark-resolve', (_event, key) => resolve(key));
  // ONL-002 stage 4. Off wherever sync is off, so nothing about the cloud is shown to a
  // signed-out window or on a server without bookmarks.
  const syncView = () => (syncEnabled() && account() ? sync.status() : { state: 'off', held: 0 });
  ipcMain.handle('bookmark-sync-status', () => syncView());
  ipcMain.handle('bookmark-sync-retry', async () => {
    if (!syncEnabled() || !account()) return syncView();
    await sync.run();
    return syncView();
  });
  // Called on start and whenever the signed-in account changes.
  // Idempotent: the window asks for the session often, the engine restarts only
  // when the account itself changed.
  let syncedAccount = null;
  function sessionChanged() {
    const current = syncEnabled() ? account() : null;
    if (current === syncedAccount) return;
    syncedAccount = current;
    if (current) sync.start(); else sync.stop();
  }
  return { ...service, resolveForUse: resolve, publish, sessionChanged, sync, syncStatus: () => syncState.status() };
}

module.exports = { create };
