'use strict';

// ONL-002 stage 3. Keeps the signed-in account's bookmarks in step with Znada Cloud
// (docs/bookmark-sync-api.md in the Cloud repository). What the window shows comes
// from status() below (stage 4). Rules this module exists to keep:
//
// - A local action becomes a durable "dirty" key first and an operation second. The
//   exact body of an operation whose answer was lost is stored and resent unchanged,
//   so the server's operation_id replay sees the same request.
// - The server's revision is never raised blindly. A newer revision from the server
//   wins over a local change that was made against an older one (409 or changes).
// - Signed-out links go to the FIRST account ever signed in, and only there. The
//   account limits are shared by every device, so the silent move sends the newest
//   links that fit and keeps the rest on this computer, marked as held.
// - Unknown sources from a newer server are skipped, never fatal.
const crypto = require('crypto');
const B = require('./bookmarks');
const C = require('./cloud/contracts.cjs');

const LIMITS = /** @type {any} */ (C.BOOKMARK_LIMITS);
const ACTIVE_LIMIT = LIMITS.active_keys || 2000;
const KEY_LIMIT = LIMITS.known_keys;
const BATCH_ITEMS = LIMITS.import_items;
// Leaves room for the envelope and for escaping differences between our count and theirs.
const BATCH_BYTES = LIMITS.import_request_bytes - 4096;
const OPERATION_BYTES = LIMITS.request_bytes;
const PAGE = LIMITS.max_page;
const RESET = new Set(['sync_reset_required', 'invalid_cursor']);
const LIMIT = new Set(['bookmark_active_limit', 'bookmark_key_limit']);
// How long a server that does not know /v1/bookmarks is left alone (stage 5): it gets
// them when the owner deploys, and the app notices at the next start or after this.
const UNSUPPORTED_RECHECK_MS = 6 * 60 * 60 * 1000;

class Stop extends Error {
  constructor(code) { super(code); this.code = code; }
}

function serverKey(item) { return `${item.source}:${item.post_id}`; }

// A server state as the local record it replaces. Display metadata gathered on this
// computer stays unless the server sent the same field; user_tags always follow the
// server, because they are the only field a person edits.
function toLocal(server, local) {
  if (!B.keyFor(server.source, server.post_id)) return null;
  const favoritedAt = server.favorited_at ?? local?.favorited_at ?? 0;
  if (server.state === 'removed') {
    return B.record({ source: server.source, post_id: server.post_id, favorited_at: favoritedAt,
      metadata: local?.metadata || {}, state: 'removed' });
  }
  const metadata = { ...(local?.metadata || {}), ...(server.metadata || {}) };
  if (!server.metadata?.user_tags) delete metadata.user_tags;
  const state = local?.state === 'unavailable' ? 'unavailable' : 'active';
  return B.record({ source: server.source, post_id: server.post_id, favorited_at: favoritedAt, metadata, state })
    || B.record({ source: server.source, post_id: server.post_id, favorited_at: favoritedAt,
      metadata: server.metadata || {}, state });
}

// The operation route takes 16 KiB in all. Source tags are display data the next
// lookup refills, so they are what gives way; user_tags and the key never do.
function fitOperation(body) {
  const out = structuredClone(body);
  while (Buffer.byteLength(JSON.stringify(out)) > OPERATION_BYTES && out.metadata?.source_tags?.length) {
    out.metadata.source_tags = out.metadata.source_tags.slice(0, Math.floor(out.metadata.source_tags.length / 2));
  }
  return out;
}

function importItem(record) {
  return { source: record.source, post_id: record.post_id,
    metadata: B.operationMetadata(record), favorited_at: record.favorited_at };
}

function takeBatch(records) {
  const out = [];
  let bytes = 32;
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(importItem(record))) + 1;
    if (out.length && (out.length >= BATCH_ITEMS || bytes + size > BATCH_BYTES)) break;
    out.push(record);
    bytes += size;
  }
  return out;
}

function nextUtcMidnight(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function create({ store, state, getAccount, connect, applyRemote, localCandidates = () => [], paused = () => false,
  now = Date.now, uuid = () => crypto.randomUUID(), sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }),
  setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}, onStatus = () => {} }) {
  function guard(ctx) {
    if (getAccount() !== ctx.accountId || !ctx.conn.isCurrent()) throw new Stop('session_changed');
  }
  function must(ctx, result) {
    if (result.ok) return result.data;
    if (result.error.status === 401) { ctx.conn.onAuthError(result); throw new Stop('auth'); }
    // ONL-002 stage 5. A server without /v1/bookmarks answers a plain "404 Not Found",
    // not a Cloud ApiError (that arrives as kind 'api', e.g. not_found for an
    // unpublished wallpaper). Only the former means "this server cannot sync yet".
    if (result.error.status === 404 && result.error.kind === 'http') throw new Stop('unsupported');
    throw new Stop(result.error.code || 'retry');
  }
  function transient(result) {
    return !result.ok && (result.error.kind === 'network' || result.error.status >= 500);
  }
  // A lost answer is repeated with the same body; the server makes that safe for
  // both routes. Bounded: a repeat still costs the server reads.
  async function send(ctx, request) {
    let result;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(1000 * 2 ** attempt);
      result = await request();
      guard(ctx);
      if (!transient(result)) return result;
    }
    return result;
  }
  function saveState(ctx, mutate) {
    if (!state.updateAccount(ctx.accountId, mutate)) throw new Stop('storage');
  }
  // DATA-006: the freeze can begin while a request is out, so it is asked again at
  // the moment of writing, not only when the run starts.
  function writeLocal(ctx, records) {
    if (!records.length) return;
    if (paused()) throw new Stop('frozen');
    if (!applyRemote(ctx.accountId, records)) throw new Stop('storage');
  }

  async function fullSnapshot(ctx) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const items = new Map();
      const cursors = new Set();
      let cursor;
      // A valid schema does not guarantee progress. Bound the whole snapshot
      // before applying it, so a broken server cannot loop or commit partial data.
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const result = await send(ctx, () => ctx.conn.api.bookmarkSnapshot({ cursor, limit: PAGE }));
        if (!result.ok && RESET.has(result.error.code)) break;
        const page = must(ctx, result);
        // The server answered: from here on a connect is really running.
        if (ctx.connecting && current !== 'syncing') setState('syncing');
        // Pages are live: a key changed meanwhile may come twice. Keep the newest.
        for (const item of page.items) {
          const previous = items.get(serverKey(item));
          if (!previous || item.revision > previous.revision) items.set(serverKey(item), item);
        }
        if (page.done) {
          if (!page.changes_cursor) throw new Stop('retry');
          return { items: [...items.values()], cursor: page.changes_cursor };
        }
        if (!page.next_cursor || cursors.has(page.next_cursor)) throw new Stop('retry');
        cursors.add(page.next_cursor);
        cursor = page.next_cursor;
        if (pageNumber === 99) throw new Stop('retry');
      }
    }
    throw new Stop('retry');
  }

  // Applies only revisions newer than the last one we know. Such a revision beats a
  // local change made against the older one, but not one made after `since`: the
  // queue counter read before the request that brought this answer (an operation,
  // an import, a snapshot or a page of changes). The answer cannot know that edit;
  // its revision is recorded and the edit stays queued against it.
  function apply(ctx, items, since) {
    const account = state.account(ctx.accountId);
    const writes = [];
    const seen = {};
    for (const item of items) {
      const key = B.keyFor(item.source, item.post_id);
      if (!key || item.revision <= (account.revisions[key]?.r ?? 0)) continue;
      if (seen[key] && seen[key].r >= item.revision) continue;
      const dirty = account.dirty[key];
      const keepLocal = !!(dirty && dirty.seq > since);
      seen[key] = { r: item.revision, a: item.state === 'active', keepLocal };
      if (!keepLocal) {
        const record = toLocal(item, store.get(ctx.accountId, key));
        if (record) writes.push(record);
      }
    }
    writeLocal(ctx, writes);
    if (Object.keys(seen).length) {
      saveState(ctx, (next) => {
        for (const [key, value] of Object.entries(seen)) {
          next.revisions[key] = { r: value.r, a: value.a };
          delete next.pending[key];
          if (!value.keepLocal) { delete next.dirty[key]; delete next.held[key]; }
        }
      });
    }
  }

  // Silent move. Plan step 3, "Молчаливый перенос при входе".
  async function migrate(ctx, snapshot) {
    let known = new Set(snapshot.items.map(serverKey));
    let active = snapshot.items.filter((item) => item.state === 'active').length;
    let claim = state.anonymousClaimedBy();
    if (claim === null) {
      saveState(ctx, (_account, root) => { root.anonymousClaimedBy = ctx.accountId; });
      claim = ctx.accountId;
    }
    const candidates = new Map();
    const offer = (record) => {
      const key = record && record.state !== 'removed' && B.keyFor(record.source, record.post_id);
      if (key && !known.has(key) && !candidates.has(key)) candidates.set(key, record);
    };
    Object.values(store.snapshot(ctx.accountId)).forEach(offer);
    if (claim === ctx.accountId) {
      Object.values(store.snapshot(null)).forEach(offer);
      localCandidates().forEach(offer);
    }
    const sorted = [...candidates.values()].sort((a, b) => b.favorited_at - a.favorited_at);
    const room = () => Math.max(0, Math.min(ACTIVE_LIMIT - active, KEY_LIMIT - known.size));
    const held = {};
    const keep = (records, reason) => records.forEach((r) => { held[B.keyFor(r.source, r.post_id)] = reason; });

    // Catalog wallpapers are refused by import; they become queued adds instead.
    const fit = sorted.slice(0, room());
    keep(sorted.slice(fit.length), 'limit');
    const catalog = fit.filter((record) => record.source === 'znada');
    let pending = fit.filter((record) => record.source !== 'znada');
    let open = false;
    const signature = (records) => records.map((r) => B.keyFor(r.source, r.post_id)).join(',');
    for (let round = 0; pending.length && round < 2000; round++) {
      const batch = takeBatch(pending);
      const final = batch.length === pending.length;
      const result = await send(ctx, () => ctx.conn.api.bookmarkImport({ items: batch.map(importItem), final }));
      if (result.ok) { open = !final; pending = pending.slice(batch.length); continue; }
      if (LIMIT.has(result.error.code)) {
        // Another device took the room between our snapshot and this batch. Nothing
        // of it was stored, so it is not repeated: close, re-read, recount.
        if (open) must(ctx, await send(ctx, () => ctx.conn.api.bookmarkImport({ items: [], final: true })));
        open = false;
        const fresh = await fullSnapshot(ctx);
        known = new Set(fresh.items.map(serverKey));
        active = fresh.items.filter((item) => item.state === 'active').length;
        pending = pending.filter((record) => !known.has(B.keyFor(record.source, record.post_id)));
        const n = room();
        keep(pending.slice(n), 'limit');
        pending = pending.slice(0, n);
        // The recount still says the refused batch fits, so the server and its own
        // snapshot disagree. Sending it again cannot help: keep the rest here.
        if (pending.length && signature(takeBatch(pending)) === signature(batch)) { keep(pending, 'limit'); pending = []; }
        continue;
      }
      if (result.error.code === 'invalid_request' || result.error.code === 'request_too_large') {
        log('bookmark import refused', result.error.code);
        keep(batch, 'invalid');
        pending = pending.slice(batch.length);
        if (!pending.length && open) must(ctx, await send(ctx, () => ctx.conn.api.bookmarkImport({ items: [], final: true })));
        continue;
      }
      must(ctx, result);
    }
    // Whatever the loop could not place is held, never silently dropped before the
    // account is marked migrated.
    if (pending.length) {
      keep(pending, 'limit');
      if (open) must(ctx, await send(ctx, () => ctx.conn.api.bookmarkImport({ items: [], final: true })));
    }
    // Held and catalog links become this account's records, so they stay visible here.
    const local = [...catalog, ...sorted.filter((r) => held[B.keyFor(r.source, r.post_id)])]
      .filter((record) => !store.get(ctx.accountId, B.keyFor(record.source, record.post_id)));
    if (local.length && paused()) throw new Stop('frozen');
    if (local.length && !store.putMany(ctx.accountId, local)) throw new Stop('storage');
    saveState(ctx, (account, root) => {
      for (const [key, reason] of Object.entries(held)) account.held[key] = reason;
      notice = Object.values(held).filter((reason) => reason === 'limit').length;
      for (const record of catalog) {
        root.seq += 1;
        account.dirty[B.keyFor(record.source, record.post_id)] = { seq: root.seq };
      }
    });
  }

  function buildOperation(ctx, key, account) {
    const local = store.get(ctx.accountId, key);
    const known = account.revisions[key];
    if (!local) return null;
    const base = { source: local.source, post_id: local.post_id };
    if (local.state === 'removed') {
      return known?.a ? { ...base, type: 'remove', expected_revision: known.r } : null;
    }
    return fitOperation({ ...base, type: known?.a ? 'update' : 'add',
      expected_revision: known?.r ?? 0, metadata: B.operationMetadata(local) });
  }

  async function flush(ctx) {
    const conflicts = {};
    for (let step = 0; step < 5000; step++) {
      const account = state.account(ctx.accountId);
      if (account.pausedUntil > now()) return;
      const key = Object.keys(account.dirty).find((k) => !account.held[k]);
      if (!key) return;
      let pending = account.pending[key];
      if (!pending) {
        const operation = buildOperation(ctx, key, account);
        if (!operation) { saveState(ctx, (next) => { delete next.dirty[key]; }); continue; }
        const operationId = uuid();
        pending = { operation_id: operationId, body: { operation_id: operationId, ...operation }, seq: account.dirty[key].seq };
        // Durable before it leaves: after a crash the same body is what is resent.
        const stored = pending;
        saveState(ctx, (next) => { next.pending[key] = stored; });
      }
      const body = pending.body, seq = pending.seq;
      const result = await send(ctx, () => ctx.conn.api.bookmarkOperation(body));
      if (result.ok) { apply(ctx, [result.data.item], seq); settle(ctx, key, seq); continue; }
      const code = result.error.code;
      if (code === 'revision_conflict') {
        const current = C.BookmarkState.safeParse(result.error.current);
        conflicts[key] = (conflicts[key] || 0) + 1;
        if (conflicts[key] > 2) { saveState(ctx, (next) => { delete next.pending[key]; next.held[key] = 'conflict'; }); continue; }
        if (current.success && current.data) {
          saveState(ctx, (next) => { delete next.pending[key]; });
          apply(ctx, [current.data], seq);
          // apply() keeps a later local edit; an equal or older one has lost.
          saveState(ctx, (next) => { if (next.dirty[key]?.seq <= seq) delete next.dirty[key]; });
        } else {
          saveState(ctx, (next) => { delete next.pending[key]; next.revisions[key] = { r: 0, a: false }; });
        }
        continue;
      }
      if (code === 'operation_id_reused') { saveState(ctx, (next) => { delete next.pending[key]; }); continue; }
      if (code === 'bookmark_daily_limit') {
        saveState(ctx, (next) => { next.pausedUntil = nextUtcMidnight(now()); });
        return;
      }
      const reason = LIMIT.has(code) ? 'limit'
        : code === 'not_found' || code === 'explicit_forbidden' ? 'unavailable'
          : code === 'invalid_request' || code === 'request_too_large' ? 'invalid' : null;
      if (reason) { saveState(ctx, (next) => { delete next.pending[key]; next.held[key] = reason; }); continue; }
      must(ctx, result);
    }
  }
  // The operation reached the server. A local edit made while it was in flight
  // stays queued and is sent against the new revision.
  function settle(ctx, key, seq) {
    saveState(ctx, (next) => {
      delete next.pending[key];
      if ((next.dirty[key]?.seq ?? 0) <= seq) delete next.dirty[key];
    });
  }

  async function connectAccount(ctx) {
    // Counted once, before anything is read: an edit made at any point while the
    // account connects (an import batch out included) is newer than every answer.
    const since = state.seq();
    let snapshot = await fullSnapshot(ctx);
    apply(ctx, snapshot.items, since);
    if (!state.account(ctx.accountId).migrated) {
      await migrate(ctx, snapshot);
      snapshot = await fullSnapshot(ctx);
      apply(ctx, snapshot.items, since);
      saveState(ctx, (account) => { account.migrated = true; });
    }
    saveState(ctx, (account) => { account.cursor = snapshot.cursor; });
  }

  async function pull(ctx) {
    for (let page = 0; page < 100; page++) {
      const cursor = state.account(ctx.accountId).cursor;
      if (!cursor) return connectAccount(ctx);
      const since = state.seq();
      const result = await send(ctx, () => ctx.conn.api.bookmarkChanges({ cursor, limit: PAGE }));
      if (!result.ok && RESET.has(result.error.code)) {
        // History is gone or an import finished elsewhere: start from a full snapshot.
        // The queue is kept; only the cursor is dropped.
        saveState(ctx, (account) => { account.cursor = null; });
        continue;
      }
      const changes = must(ctx, result);
      apply(ctx, changes.items.map((change) => change.item), since);
      saveState(ctx, (account) => { account.cursor = changes.next_cursor; });
      if (changes.done) return;
    }
  }

  async function once() {
    const accountId = getAccount();
    if (accountId === null) return { skipped: 'signed_out' };
    const conn = connect();
    if (!conn) return { skipped: 'unavailable' };
    // A server that did not know bookmarks is asked again only after a while (or at the
    // next start), not on every poll or star.
    if (unsupportedUntil > now()) return { skipped: 'unsupported' };
    if (!state.status().writable || !store.status().writable) return { skipped: 'storage' };
    // DATA-006: a media-folder move freezes library edits, and applying a remote star
    // edits the pool. Wait it out; the failure path below retries.
    if (paused()) return { error: 'frozen' };
    const ctx = { accountId, conn };
    try {
      if (!state.account(accountId).cursor || !state.account(accountId).migrated) {
        // Only connecting is announced, and only once the server has answered: a
        // five-minute poll, or a server without bookmarks, must not make the line under
        // the name blink for nothing.
        ctx.connecting = true;
        await connectAccount(ctx);
      }
      await flush(ctx);
      await pull(ctx);
      return { ok: true };
    } catch (err) {
      if (err instanceof Stop) {
        // Set here, not after run() settles: a run requested while this one was out
        // (a star, the poll) loops straight back into once() and must find the pause.
        if (err.code === 'unsupported') unsupportedUntil = now() + UNSUPPORTED_RECHECK_MS;
        log('bookmark sync stopped', err.code);
        return { error: err.code };
      }
      throw err;
    }
  }

  // ONL-002 stage 4. What the window shows: off (signed out or no server), syncing
  // (connecting), ok, offline, error, paused (daily limit), plus how many links did not
  // fit in the account. `notice` is that count from a move that just happened; it is
  // handed out once, for the one-time message. `settled` is the last state that was not
  // "syncing": what to fall back to when a connect stops without finishing.
  let current = 'off', settled = 'off', notice = 0, unsupportedUntil = 0;
  function view() {
    const accountId = getAccount();
    const account = accountId === null ? null : state.account(accountId);
    const held = account ? Object.values(account.held).filter((reason) => reason === 'limit').length : 0;
    let shown = accountId === null ? 'off' : current;
    if (shown === 'ok' && account && account.pausedUntil > now()) shown = 'paused';
    return { state: shown, held };
  }
  function setState(next) {
    current = next;
    if (next !== 'syncing') settled = next;
    const status = view();
    if (notice) { status.notice = notice; notice = 0; }
    onStatus(status);
  }
  function settleState(result) {
    if (!result) return;
    if (result.ok) return setState('ok');
    if (result.skipped === 'storage') return setState('error');
    if (result.skipped) return setState('off');
    if (result.error === 'network' || result.error === 'timeout') return setState('offline');
    if (result.error === 'unsupported') return setState('off');
    // The session owner reports a dead session; a freeze or an account switch says
    // nothing about the link. A connect interrupted by them is not still running, so
    // "Syncing…" must not stay up for the length of a folder move: a freeze falls back
    // to the last real state (nothing, before the first connect), the others to off.
    if (['frozen', 'session_changed', 'auth'].includes(result.error)) {
      if (current === 'syncing') setState(result.error === 'frozen' ? settled : 'off');
      return;
    }
    setState('error');
  }

  let running = null, again = false, timer = null, failures = 0, idle = null;
  function run() {
    if (running) { again = true; return running; }
    running = (async () => {
      let result;
      do { again = false; result = await once(); } while (again);
      return result;
    })().finally(() => { running = null; });
    return running.then((result) => {
      settleState(result);
      // A failed exchange retries on its own, slower each time; success resets it.
      if (result?.error && !['session_changed', 'auth', 'storage', 'unsupported'].includes(result.error)) {
        failures += 1;
        schedule(Math.min(15 * 60 * 1000, 30 * 1000 * 2 ** (failures - 1)));
      } else if (result?.ok) failures = 0;
      return result;
    });
  }
  function schedule(delay = 1500) {
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; void run().catch((err) => log('bookmark sync failed', err)); }, delay);
    if (timer?.unref) timer.unref();
  }
  function touch(accountId, key) {
    const [source, id] = splitKey(key);
    if (accountId === null || !B.keyFor(source, id)) return;
    const stored = state.updateAccount(accountId, (account, root) => {
      root.seq += 1;
      account.dirty[key] = { seq: root.seq };
      delete account.held[key];
    });
    if (!stored) log('bookmark sync queue write failed', key);
    schedule();
  }
  function splitKey(key) {
    const at = String(key).indexOf(':');
    return [String(key).slice(0, at), String(key).slice(at + 1)];
  }
  // Remote changes have no push channel; a modest poll while the app runs is enough.
  function start(interval = 5 * 60 * 1000) {
    stop();
    unsupportedUntil = 0;
    schedule(0);
    idle = setInterval(() => schedule(0), interval);
    if (idle?.unref) idle.unref();
  }
  function stop() {
    if (timer) clearTimer(timer);
    if (idle) clearInterval(idle);
    timer = null; idle = null;
    if (current !== 'off') setState('off');
  }
  return { run, touch, schedule, start, stop, status: view };
}

module.exports = { create, toLocal, takeBatch, fitOperation, nextUtcMidnight, ACTIVE_LIMIT, KEY_LIMIT };
