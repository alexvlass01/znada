'use strict';

const fs = require('fs');
const path = require('path');

// Bounded persistent journal of background/manual failures and recoveries (plan:
// error_notifications T3). Lives in its OWN file under userData — writing it must not
// touch config.json (a config save broadcasts config-changed and would re-render the
// UI for every logged event). Entries store i18n KEYS + params, not rendered text, so
// switching the app language re-renders history correctly.
//
// Shape on disk: { version: 1, entries: [newest, ..., oldest] }, entries capped.
// Corrupt/missing file is an empty journal, never an application failure. Writes are
// atomic (tmp + rename) and serialized through a promise chain.

const LOG_VERSION = 1;
const DEFAULT_CAP = 50;

function sanitizeEntry(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const messageKey = typeof raw.messageKey === 'string' ? raw.messageKey.trim() : '';
  if (!messageKey) return null;
  const entry = {
    atMs: Number.isFinite(raw.atMs) ? raw.atMs : now(),
    channel: typeof raw.channel === 'string' ? raw.channel.slice(0, 64) : 'unknown',
    kind: raw.kind === 'recovered' ? 'recovered' : 'failure',
    messageKey: messageKey.slice(0, 128),
  };
  if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
    const params = {};
    for (const [key, value] of Object.entries(raw.params)) {
      if (typeof value === 'string') params[key] = value.slice(0, 200);
      else if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
    }
    if (Object.keys(params).length) entry.params = params;
  }
  return entry;
}

function createEventLog({ filePath, fsModule = fs, cap = DEFAULT_CAP, now = () => Date.now() } = {}) {
  if (!filePath) throw new Error('filePath is required');
  const max = Math.max(1, Math.floor(Number(cap) || DEFAULT_CAP));
  let entries = [];
  let chain = Promise.resolve(); // serialized writes; a failed write never breaks the app

  // The file is tiny (≤cap entries), so a one-time sync load at startup is fine.
  try {
    const raw = JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
    if (raw && Array.isArray(raw.entries)) {
      entries = raw.entries.map((e) => sanitizeEntry(e, now)).filter(Boolean).slice(0, max);
    }
  } catch {
    entries = []; // missing or corrupt journal = empty journal
  }

  const persist = () => {
    const snapshot = JSON.stringify({ version: LOG_VERSION, entries }, null, 2);
    chain = chain.then(async () => {
      const tmp = `${filePath}.tmp`;
      await fsModule.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fsModule.promises.writeFile(tmp, snapshot, 'utf8');
      await fsModule.promises.rename(tmp, filePath);
    }).catch(() => {
      // Journal persistence is best-effort; in-memory entries stay available.
    });
    return chain;
  };

  return {
    append(raw) {
      const entry = sanitizeEntry(raw, now);
      if (!entry) return null;
      entries.unshift(entry);
      if (entries.length > max) entries.length = max;
      persist();
      return entry;
    },
    list() {
      return entries.map((entry) => ({ ...entry }));
    },
    clear() {
      entries = [];
      return persist();
    },
    // Awaitable in tests / on shutdown; the app itself never blocks on it.
    flush() {
      return chain;
    },
  };
}

module.exports = { createEventLog, DEFAULT_CAP, LOG_VERSION };
