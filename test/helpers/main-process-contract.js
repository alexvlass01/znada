'use strict';

// CODE-001: a review inventory, not a JavaScript effect/identity analyzer.
// A changed source or channel must be reviewed before this snapshot is refreshed.
const assert = require('assert');
const crypto = require('crypto');
const { ipcRegistrations } = require('./ipc-registrations');

const EFFECTS = new Set(['frozen-pool', 'frozen-placement', 'no-pool-write', 'exempt', 'known-unfrozen']);

function semanticTree(value) {
  if (typeof value === 'bigint') return { bigint: String(value) };
  if (typeof value === 'number' && !Number.isFinite(value)) return { number: String(value) };
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(semanticTree);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['loc', 'range', 'start', 'end'].includes(key) && !(key === 'raw' && value.type === 'Literal'))
    .map(([key, child]) => [key, semanticTree(child)]));
}

function fingerprint(ast) {
  return crypto.createHash('sha256').update(JSON.stringify(semanticTree(ast))).digest('hex');
}

function inventory(sources) {
  const channels = new Map();
  for (const { channel, file } of ipcRegistrations(sources)) {
    assert.ok(!channels.has(channel), `duplicate static IPC registration: ${channel}`);
    channels.set(channel, file);
  }
  return {
    sources: Object.fromEntries(sources.map(({ file, ast }) => [file, fingerprint(ast)])),
    channels: Object.fromEntries(channels),
  };
}

function assertReviewed(actual, approved) {
  assert.strictEqual(approved.version, 1, 'unknown main-process contract version');
  for (const [channel, decision] of Object.entries(approved.channels)) {
    assert.ok(EFFECTS.has(decision.effect), `${channel}: decide its pool effect explicitly`);
    assert.ok(typeof decision.file === 'string', `${channel}: missing source file`);
    if (['exempt', 'known-unfrozen'].includes(decision.effect)) {
      assert.ok(typeof decision.reason === 'string' && decision.reason.trim(), `${channel}: missing reason`);
    }
    if (decision.effect === 'known-unfrozen') {
      assert.ok(/^DATA-\d+:/.test(decision.reason), `${channel}: known defect needs its task ID`);
    }
  }
  assert.deepStrictEqual(actual.channels,
    Object.fromEntries(Object.entries(approved.channels).map(([channel, row]) => [channel, row.file])),
    'IPC inventory changed: decide each added/removed/moved channel explicitly');
  const changed = [...new Set([...Object.keys(actual.sources), ...Object.keys(approved.sources)])]
    .filter(file => actual.sources[file] !== approved.sources[file]).sort();
  assert.deepStrictEqual(changed, [],
    'main-process source snapshot changed; review these files and their effects before refreshing fingerprints: ' + changed.join(', '));
}

module.exports = { fingerprint, inventory, assertReviewed };
