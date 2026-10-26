'use strict';

// Resolves a stable key through the site's own adapter. No renderer-supplied URL
// is fetched. Preview bytes are a disposable, bounded, account-isolated cache.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const B = require('./bookmarks');

function create({ directory, lookup, preview, getOwner, getGeneration = getOwner, maxEntries = 160 }) {
  const pending = new Map();
  const memo = new Map();
  const waiting = [];
  let active = 0;
  async function limited(run) {
    if (active >= 2) await new Promise((resolve) => { waiting.push(resolve); });
    active++;
    try { return await run(); }
    finally { active--; waiting.shift()?.(); }
  }
  const hash = (owner, key) => crypto.createHash('sha256').update(owner + '\0' + key).digest('hex');
  function cached(owner, key) {
    try {
      const data = fs.readFileSync(path.join(directory, hash(owner, key) + '.json'), 'utf8');
      if (data.length > 360000) return '';
      const raw = JSON.parse(data);
      return /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.thumb) ? raw.thumb : '';
    } catch { return ''; }
  }
  function save(owner, key, thumb) {
    if (!thumb || thumb.length > 360000) return;
    try {
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, hash(owner, key) + '.json');
      fs.writeFileSync(file + '.tmp', JSON.stringify({ thumb })); fs.renameSync(file + '.tmp', file);
      const files = fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => ({ name, time: fs.statSync(path.join(directory, name)).mtimeMs })).sort((a, b) => b.time - a.time);
      for (const entry of files.slice(maxEntries)) fs.unlinkSync(path.join(directory, entry.name));
    } catch { /* A lost preview never loses the bookmark. */ }
  }
  async function resolve(record) {
    const key = B.keyFor(record?.source, record?.post_id);
    if (!key) return { error: 'badItem' };
    const owner = getOwner(), generation = getGeneration(), token = generation + '\0' + key;
    const remembered = memo.get(token);
    if (remembered && Date.now() - remembered.at < (remembered.value.error ? 5000 : 60000)) return remembered.value;
    if (pending.has(token)) return pending.get(token);
    const task = limited(async () => {
      if (getGeneration() !== generation) return { error: 'session_changed' };
      const thumb = cached(owner, key);
      let answer;
      try { answer = await lookup(record.source, record.post_id); }
      catch { answer = { error: 'network' }; }
      if (getGeneration() !== generation) return { error: 'session_changed' };
      if (!answer?.item) return { thumb, error: answer?.error || 'unavailable',
        unavailable: ['403', '404', 'explicit_forbidden', 'not_found'].includes(answer?.error) };
      let fresh = '';
      try { fresh = await preview(answer.item); } catch { /* Keep cached bytes offline. */ }
      if (getGeneration() !== generation) return { error: 'session_changed' };
      if (fresh) save(owner, key, fresh);
      return { item: answer.item, thumb: fresh || thumb, error: null };
    }).then((value) => {
      if (getGeneration() === generation) {
        memo.set(token, { at: Date.now(), value });
        if (memo.size > maxEntries) memo.delete(memo.keys().next().value);
      }
      return value;
    }).finally(() => pending.delete(token));
    pending.set(token, task);
    return task;
  }
  return { resolve, cached };
}

module.exports = { create };
