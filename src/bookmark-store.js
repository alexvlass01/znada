'use strict';

// User-owned links, not a disposable cache. No startup wiring until ONL-002 stage 2.
// All writes go through an opened instance: a corrupt/future/unreadable file locks
// that instance against writes. The damaged bytes and the last backup are retained.
const fs = require('fs');
const path = require('path');
const B = require('./bookmarks');
const VERSION = 1;

function storePathFor(configPath) {
  return path.join(path.dirname(configPath),
    path.basename(configPath).replace(/\.json$/i, '') + '.bookmarks.json');
}

function empty() { return { version: VERSION, partitions: {} }; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }

// Reject, never "normalize away", anything we would lose on the next write.
function validate(raw) {
  if (!object(raw) || raw.version !== VERSION || !object(raw.partitions)
      || Object.keys(raw).some((key) => !['version', 'partitions'].includes(key))) {
    throw new Error('Unsupported bookmark store');
  }
  const clean = empty();
  for (const [owner, records] of Object.entries(raw.partitions)) {
    if (!(owner === 'anonymous' || (owner.startsWith('account:')
        && B.partitionKey(owner.slice(8)) === owner)) || !object(records)) {
      throw new Error('Invalid bookmark partition');
    }
    clean.partitions[owner] = {};
    for (const [key, value] of Object.entries(records)) {
      const item = B.record(value);
      if (!item || B.keyFor(item.source, item.post_id) !== key) {
        throw new Error('Invalid bookmark record');
      }
      clean.partitions[owner][key] = item;
    }
  }
  return clean;
}

function create({ configPath, io = fs }) {
  const file = storePathFor(configPath);
  let data = empty();
  let writable = true;
  let error = null;
  let primaryBytes = null;
  function read(name) {
    const bytes = io.readFileSync(name, 'utf8');
    return { bytes, data: validate(JSON.parse(bytes.replace(/^\uFEFF/, ''))) };
  }
  try {
    const loaded = read(file);
    data = loaded.data;
    primaryBytes = loaded.bytes;
  } catch (err) {
    if (err.code !== 'ENOENT') { writable = false; error = err; }
    // Even a missing primary can be an interrupted recovery. Load the backup for
    // display, but do not overwrite either copy without an explicit repair path.
    try {
      const backup = read(file + '.bak');
      data = backup.data;
      writable = false;
      error = error || new Error('Bookmark primary missing; backup available');
    } catch (backupError) {
      if (backupError.code !== 'ENOENT') { writable = false; error = error || backupError; }
    }
  }

  function put(accountId, value) { return putMany(accountId, [value]); }

  // ONL-002 stage 3. A cloud snapshot applies hundreds of records at once; one write
  // keeps it all-or-nothing and avoids rewriting the file once per bookmark.
  function putMany(accountId, values) {
    if (!writable) return false;
    const items = values.map((value) => {
      const item = B.record(value);
      if (!item) throw new TypeError('Invalid bookmark');
      return item;
    });
    const owner = B.partitionKey(accountId);
    if (!items.length) return true;
    // Copy-on-write: failed IO leaves the in-memory committed view intact. Callers
    // must keep an action pending on false; it has not been durably accepted.
    const next = validate(data);
    if (!next.partitions[owner]) next.partitions[owner] = {};
    for (const item of items) next.partitions[owner][B.keyFor(item.source, item.post_id)] = item;
    const bytes = JSON.stringify(next, null, 2);
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      io.writeFileSync(file + '.tmp', bytes, 'utf8');
      if (primaryBytes !== null) {
        io.writeFileSync(file + '.bak.tmp', primaryBytes, 'utf8');
        io.renameSync(file + '.bak.tmp', file + '.bak');
      }
      io.renameSync(file + '.tmp', file);
      data = next;
      primaryBytes = bytes;
      error = null;
      return true;
    } catch (err) { error = err; return false; }
  }

  return {
    put,
    putMany,
    get(accountId, key) {
      const records = data.partitions[B.partitionKey(accountId)];
      return records && Object.hasOwn(records, key) ? structuredClone(records[key]) : null;
    },
    hasElsewhere(accountId, key) {
      const owner = B.partitionKey(accountId);
      // Tombstones still identify an account-owned link. Ignoring them would let
      // stale local favorite flags become another account's anonymous fallback.
      return Object.entries(data.partitions).some(([partition, records]) => partition !== owner && Object.hasOwn(records, key));
    },
    snapshot(accountId) {
      const owner = B.partitionKey(accountId);
      return structuredClone(data.partitions[owner] || {});
    },
    status() { return { writable, error: error ? error.message : null }; },
  };
}

module.exports = { VERSION, storePathFor, validate, create };
