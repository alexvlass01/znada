'use strict';

// ONL-002 stage 3. An in-memory model of the Cloud bookmark routes, written from
// docs/bookmark-sync-api.md (Cloud a460ff1): per-key revision CAS, operation_id
// replay of the last operation, live keyset snapshot with a history boundary,
// changes with 410 after an import, and import that is all-or-nothing on limits.
// Results use the client's { ok, data } / { ok:false, error } shape.

const ACTIVE = 2000;
const KNOWN = 10000;

function create({ now = () => 1_000_000 } = {}) {
  const rows = new Map();
  const events = [];
  const lastOp = new Map();
  let sequence = 0;
  let epoch = 0;
  let importOpen = false;
  const calls = [];
  const faults = [];
  const hooks = { beforeImport: null };

  const key = (item) => `${item.source}:${item.post_id}`;
  const state = (row) => ({ source: row.source, post_id: row.post_id, revision: row.revision, state: row.state,
    favorited_at: row.favorited_at, restricted: false, ...(row.state === 'active' ? { metadata: structuredClone(row.metadata) } : {}) });
  const ok = (data) => ({ ok: true, data: structuredClone(data) });
  const fail = (status, code, extra = {}) => ({ ok: false, error: { code, message: code, status, kind: 'api', ...extra } });
  const active = () => [...rows.values()].filter((row) => row.state === 'active').length;
  const event = (type, row) => events.push({ sequence: ++sequence, type, item: state(row) });

  function seed(item, { emit = false } = {}) {
    const row = { revision: 1, state: 'active', favorited_at: 1, metadata: {}, ...item };
    rows.set(key(row), row);
    if (emit) event(row.state === 'active' ? 'add' : 'remove', row);
    return row;
  }

  function fault(route) {
    const at = faults.findIndex((entry) => entry.route === route);
    if (at < 0) return null;
    return faults.splice(at, 1)[0];
  }

  function operation(body) {
    const k = key(body);
    const payload = JSON.stringify({ ...body, operation_id: undefined });
    const last = lastOp.get(k);
    if (last && last.id === body.operation_id) {
      return last.payload === payload ? ok(last.response) : fail(409, 'operation_id_reused');
    }
    const row = rows.get(k);
    const revision = row ? row.revision : 0;
    if (body.expected_revision !== revision) return fail(409, 'revision_conflict', { current: row ? state(row) : null });
    if (body.type === 'update' && (!row || row.state !== 'active')) return fail(409, 'revision_conflict', { current: row ? state(row) : null });
    if (!row && rows.size >= KNOWN) return fail(409, 'bookmark_key_limit');
    if (body.type === 'add' && (!row || row.state !== 'active') && active() >= ACTIVE) return fail(409, 'bookmark_active_limit');
    const next = row || { source: body.source, post_id: body.post_id, revision: 0, state: 'removed', favorited_at: null, metadata: {} };
    next.revision += 1;
    if (body.type === 'remove') { next.state = 'removed'; next.metadata = {}; }
    else {
      if (next.state !== 'active') next.favorited_at = now();
      next.state = 'active';
      next.metadata = structuredClone(body.metadata);
    }
    rows.set(k, next);
    event(body.type, next);
    const response = { item: state(next) };
    lastOp.set(k, { id: body.operation_id, payload, response });
    return ok(response);
  }

  function snapshot({ cursor, limit = 100 }) {
    let position = { after: '', high: sequence, epoch };
    if (cursor) {
      position = JSON.parse(cursor.slice(2));
      if (position.epoch !== epoch) return fail(410, 'sync_reset_required');
    }
    const sorted = [...rows.values()].sort((a, b) => (key(a) < key(b) ? -1 : 1)).filter((row) => key(row) > position.after);
    const page = sorted.slice(0, limit);
    const done = sorted.length <= limit;
    const last = page.length ? key(page[page.length - 1]) : position.after;
    return ok({ items: page.map(state), done, expires_at: now() + 900000,
      next_cursor: done ? null : 's:' + JSON.stringify({ ...position, after: last }),
      changes_cursor: done ? 'c:' + JSON.stringify({ seq: position.high, epoch }) : null });
  }

  function changes({ cursor, limit = 100 }) {
    if (!cursor || !cursor.startsWith('c:')) return fail(400, 'invalid_cursor');
    const position = JSON.parse(cursor.slice(2));
    if (position.epoch !== epoch) return fail(410, 'sync_reset_required');
    const after = events.filter((entry) => entry.sequence > position.seq);
    const page = after.slice(0, limit);
    const seq = page.length ? page[page.length - 1].sequence : position.seq;
    return ok({ items: page, done: after.length <= limit, next_cursor: 'c:' + JSON.stringify({ seq, epoch }) });
  }

  function importBatch(body) {
    if (hooks.beforeImport) hooks.beforeImport(body);
    const fresh = body.items.filter((item) => !rows.has(key(item)));
    if (active() + fresh.length > ACTIVE) return fail(409, 'bookmark_active_limit');
    if (rows.size + fresh.length > KNOWN) return fail(409, 'bookmark_key_limit');
    for (const item of fresh) {
      rows.set(key(item), { source: item.source, post_id: item.post_id, revision: 1, state: 'active',
        favorited_at: Math.min(item.favorited_at ?? now(), now()), metadata: structuredClone(item.metadata) });
    }
    importOpen = true;
    if (body.final) { importOpen = false; epoch += 1; }
    return ok({ imported: fresh.length, skipped: body.items.length - fresh.length });
  }

  const routes = { bookmarkOperation: operation, bookmarkSnapshot: snapshot, bookmarkChanges: changes, bookmarkImport: importBatch };
  const api = {};
  for (const [name, handler] of Object.entries(routes)) {
    api[name] = async (input) => {
      calls.push({ route: name, input: structuredClone(input) });
      const planned = fault(name);
      if (planned?.before) return planned.before;
      const result = handler(input);
      // "applied, answer lost": the server did the work, the client sees a network error.
      if (planned?.after) return planned.after;
      return result;
    };
  }
  return {
    api, rows, events, calls, hooks, seed,
    failOnce: (route, result, { applied = false } = {}) => faults.push({ route, [applied ? 'after' : 'before']: result }),
    otherDevice: { operation: (body) => operation({ operation_id: `other-${Math.random()}`, ...body }) },
    importOpen: () => importOpen,
    epoch: () => epoch,
  };
}

const NETWORK = { ok: false, error: { code: 'network', message: 'offline', kind: 'network' } };

module.exports = { create, NETWORK, ACTIVE, KNOWN };
