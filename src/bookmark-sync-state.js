'use strict';

// ONL-002 stage 3. Durable sync bookkeeping beside config.bookmarks.json: what the
// server last told us per key, which local changes still have to reach it, the
// exact body of a request whose outcome is unknown, and the changes cursor.
//
// The queue is user intent and the "anonymous links already went to account X"
// marker decides where signed-out favorites may go. Losing either silently could
// upload one person's links into another account, so a damaged or future file
// disables sync (fail closed) and is kept as it is, like the bookmark store.
const fs = require('fs');
const path = require('path');
const B = require('./bookmarks');
const VERSION = 1;
const ACCOUNT_FIELDS = ['cursor', 'revisions', 'dirty', 'pending', 'held', 'migrated', 'pausedUntil'];

function statePathFor(configPath) {
  return path.join(path.dirname(configPath),
    path.basename(configPath).replace(/\.json$/i, '') + '.bookmark-sync.json');
}

function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function emptyAccount() {
  return { cursor: null, revisions: {}, dirty: {}, pending: {}, held: {}, migrated: false, pausedUntil: 0 };
}
function empty() { return { version: VERSION, anonymousClaimedBy: null, seq: 0, accounts: {} }; }

function validKey(key) {
  const at = key.indexOf(':');
  return at > 0 && B.keyFor(key.slice(0, at), key.slice(at + 1)) === key;
}

function validateAccount(raw) {
  if (!object(raw) || Object.keys(raw).some((key) => !ACCOUNT_FIELDS.includes(key))) throw new Error('Invalid sync account');
  const out = emptyAccount();
  if (raw.cursor !== null && (typeof raw.cursor !== 'string' || !raw.cursor || raw.cursor.length > 4096)) throw new Error('Invalid sync cursor');
  out.cursor = raw.cursor;
  for (const field of ['revisions', 'dirty', 'pending', 'held']) {
    if (!object(raw[field])) throw new Error('Invalid sync field');
    for (const [key, value] of Object.entries(raw[field])) {
      if (!validKey(key)) throw new Error('Invalid sync key');
      const ok = field === 'revisions' ? object(value) && count(value.r) && typeof value.a === 'boolean'
        : field === 'dirty' ? object(value) && count(value.seq)
          : field === 'pending' ? object(value) && typeof value.operation_id === 'string' && object(value.body) && count(value.seq)
            : typeof value === 'string' && value.length <= 64;
      if (!ok) throw new Error('Invalid sync entry');
      out[field][key] = value;
    }
  }
  if (typeof raw.migrated !== 'boolean' || !count(raw.pausedUntil)) throw new Error('Invalid sync account');
  out.migrated = raw.migrated;
  out.pausedUntil = raw.pausedUntil;
  return out;
}

function validate(raw) {
  if (!object(raw) || raw.version !== VERSION || !object(raw.accounts) || !count(raw.seq)
      || Object.keys(raw).some((key) => !['version', 'anonymousClaimedBy', 'seq', 'accounts'].includes(key))) {
    throw new Error('Unsupported bookmark sync state');
  }
  if (raw.anonymousClaimedBy !== null && B.partitionKey(raw.anonymousClaimedBy) === 'anonymous') {
    throw new Error('Invalid anonymous claim');
  }
  const clean = empty();
  clean.anonymousClaimedBy = raw.anonymousClaimedBy;
  clean.seq = raw.seq;
  for (const [owner, account] of Object.entries(raw.accounts)) {
    if (!owner.startsWith('account:') || B.partitionKey(owner.slice(8)) !== owner) throw new Error('Invalid sync owner');
    clean.accounts[owner] = validateAccount(account);
  }
  return clean;
}

function create({ configPath, io = fs }) {
  const file = statePathFor(configPath);
  let data = empty();
  let writable = true;
  let error = null;
  try {
    data = validate(JSON.parse(io.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  } catch (err) {
    if (err.code !== 'ENOENT') { writable = false; error = err; }
  }

  // Copy-on-write like the bookmark store: a refused write leaves memory unchanged,
  // so the engine re-reads the last durable state and simply tries again later.
  function update(mutate) {
    if (!writable) return false;
    const next = validate(data);
    mutate(next);
    const clean = validate(next);
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      io.writeFileSync(file + '.tmp', JSON.stringify(clean, null, 2), 'utf8');
      io.renameSync(file + '.tmp', file);
      data = clean;
      error = null;
      return true;
    } catch (err) { error = err; return false; }
  }

  return {
    account(accountId) {
      const owner = B.partitionKey(accountId);
      return structuredClone(data.accounts[owner] || emptyAccount());
    },
    // mutate(account, root): `root` exposes the anonymous claim and the edit counter.
    updateAccount(accountId, mutate) {
      const owner = B.partitionKey(accountId);
      if (owner === 'anonymous') throw new TypeError('Signed-out bookmarks are not synced');
      return update((next) => {
        if (!next.accounts[owner]) next.accounts[owner] = emptyAccount();
        mutate(next.accounts[owner], next);
      });
    },
    anonymousClaimedBy() { return data.anonymousClaimedBy; },
    seq() { return data.seq; },
    status() { return { writable, error: error ? error.message : null }; },
  };
}

module.exports = { VERSION, statePathFor, validate, create };
