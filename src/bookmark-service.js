'use strict';

// ONL-002. A link never enters the file pool. This service joins the two collections
// only for display and keeps the star consistent when the original is downloaded.
const B = require('./bookmarks');
const C = require('./cloud/contracts.cjs');

function reference(item) {
  if (!item || typeof item !== 'object') return null;
  let source = item.provider || item.source;
  let id = item.post_id || item.id;
  if (item.path) {
    const mark = String(item.source || '').match(/^(?:lumina|znada):([0-9A-Z]{26})$/);
    if (mark) { source = 'znada'; id = mark[1]; }
    else {
      let url;
      try { url = new URL(item.source); } catch { return null; }
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      const host = url.hostname.replace(/^www\./, '');
      if (host === 'wallhaven.cc') { source = 'wallhaven'; id = url.pathname.match(/^\/w\/([a-z0-9]+)\/?$/)?.[1]; }
      else if (host === 'danbooru.donmai.us') { source = 'danbooru'; id = url.pathname.match(/^\/posts\/(\d+)\/?$/)?.[1]; }
      else if (host === 'gelbooru.com' && url.pathname === '/index.php'
        && url.searchParams.get('page') === 'post' && url.searchParams.get('s') === 'view') {
        source = 'gelbooru'; id = url.searchParams.get('id');
      } else return null;
    }
  }
  if (!['wallhaven', 'gelbooru', 'danbooru', 'znada'].includes(source)) return null;
  id = typeof id === 'string' ? id.replace(new RegExp(`^${source}:`), '') : '';
  return B.keyFor(source, id) ? { source, post_id: id } : null;
}

function metadata(item) {
  const out = {};
  for (const field of ['title', 'author']) {
    const value = item[field] || (field === 'author' ? item.artist : '');
    if (typeof value === 'string' && value) out[field] = value.slice(0, field === 'title' ? 300 : 120);
  }
  const tags = (value) => [...new Set((Array.isArray(value) ? value : [])
    .filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter((tag) => tag && tag.length <= 128))].slice(0, 100);
  out.source_tags = tags(item.tags);
  if (item.width > 0 && item.height > 0 && item.width <= 100000 && item.height <= 100000) {
    out.width = Math.floor(item.width); out.height = Math.floor(item.height);
  }
  const rating = B.wallhavenRating(item.purity) || item.rating || item.contentRating;
  if (['general', 'suggestive', 'explicit'].includes(rating)) out.source_rating = rating;
  const checked = C.BookmarkMetadata.safeParse(out);
  return checked.success ? checked.data : {};
}

function create({ store, getConfig, getAccount = () => null, updateItem, savePool, now = Date.now,
  onChange = () => {} }) {
  function localMatches(ref) {
    const key = B.keyFor(ref.source, ref.post_id);
    return Object.values(getConfig().library || {}).filter((item) => {
      const candidate = reference(item);
      return candidate && B.keyFor(candidate.source, candidate.post_id) === key;
    });
  }
  function state(input) {
    const local = input?.kind === 'local' ? getConfig().library?.[input.id] : null;
    const ref = reference(local || input?.item || input);
    const owner = B.partitionKey(getAccount());
    if (!ref) return { on: !!local?.favorite, ref: null, owner };
    const record = store.get(getAccount(), B.keyFor(ref.source, ref.post_id));
    const claimedElsewhere = store.hasElsewhere(getAccount(), B.keyFor(ref.source, ref.post_id));
    return { on: record ? record.state !== 'removed' : !claimedElsewhere && localMatches(ref).some((item) => item.favorite), ref, owner };
  }
  function set(input, on) {
    if (typeof on !== 'boolean') return { error: 'badItem' };
    if (input?.owner && input.owner !== B.partitionKey(getAccount())) return { error: 'session_changed' };
    const local = input?.kind === 'local' ? getConfig().library?.[input.id] : null;
    const current = state(input);
    if (!current.ref) {
      if (!local) return { error: 'badItem' };
      updateItem(local.id, { favorite: on, favoritedAt: on ? now() : null }); savePool();
      return { on, config: getConfig(), error: null };
    }
    const owner = getAccount();
    const key = B.keyFor(current.ref.source, current.ref.post_id);
    const previous = store.get(owner, key);
    const item = local || input.item || input;
    const record = { ...current.ref, metadata: previous?.metadata || metadata(item),
      favorited_at: on && !current.on ? now() : previous?.favorited_at ?? local?.favoritedAt ?? now(),
      state: on ? 'active' : 'removed' };
    // Commit the user-owned link first. An IO refusal must not turn the star on in
    // memory, nor leave a local star changed while the corresponding link is stale.
    if (!store.put(owner, record)) return { error: 'bookmark_write_failed' };
    onChange(owner, key);
    let changed = false;
    for (const match of localMatches(current.ref)) {
      updateItem(match.id, { favorite: on, favoritedAt: on ? record.favorited_at : null }); changed = true;
    }
    if (changed) savePool();
    return { on, config: getConfig(), error: null };
  }
  function list() {
    const records = store.snapshot(getAccount());
    const entries = [];
    const seen = new Set();
    for (const item of Object.values(getConfig().library || {})) {
      const ref = reference(item), key = ref && B.keyFor(ref.source, ref.post_id), record = key && records[key];
      if (key && !record && store.hasElsewhere(getAccount(), key)) continue;
      if (record ? record.state === 'removed' : !item.favorite) continue;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      entries.push({ key: key || `local:${item.id}`, kind: 'local', item, record,
        favoritedAt: record?.favorited_at ?? item.favoritedAt ?? item.addedAt ?? 0 });
    }
    for (const record of B.list(records)) {
      const key = B.keyFor(record.source, record.post_id);
      if (!seen.has(key)) entries.push({ key, kind: 'bookmark', record, favoritedAt: record.favorited_at });
    }
    entries.sort((a, b) => b.favoritedAt - a.favoritedAt || a.key.localeCompare(b.key));
    return { owner: B.partitionKey(getAccount()), entries, records, writable: store.status().writable };
  }
  function tags(input, value) {
    if (input?.owner && input.owner !== B.partitionKey(getAccount())) return { error: 'session_changed' };
    const ref = state(input).ref;
    if (!ref || !Array.isArray(value)) return { error: 'badItem' };
    const owner = getAccount(), key = B.keyFor(ref.source, ref.post_id), previous = store.get(owner, key);
    if (!previous || previous.state === 'removed') return { error: 'badItem' };
    const record = B.record({ ...previous, metadata: { ...previous.metadata, user_tags: value } });
    if (!record) return { error: 'badItem' };
    if (!store.put(owner, record)) return { error: 'bookmark_write_failed' };
    onChange(owner, key);
    const previousTags = new Set(previous.metadata.user_tags || []);
    const matches = localMatches(ref);
    for (const item of matches) updateItem(item.id, { tags: [...new Set([
      ...(item.tags || []).filter((tag) => !previousTags.has(tag)),
      ...(record.metadata.source_tags || []), ...value,
    ])] });
    if (matches.length) savePool();
    return { error: null };
  }
  function adopt(id) {
    const item = getConfig().library?.[id], ref = reference(item);
    if (!ref) return;
    const record = store.get(getAccount(), B.keyFor(ref.source, ref.post_id));
    if (record) updateItem(id, { favorite: record.state !== 'removed',
      favoritedAt: record.state !== 'removed' ? record.favorited_at : null,
      tags: [...new Set([...(item.tags || []), ...(record.metadata.source_tags || []), ...(record.metadata.user_tags || [])])] });
  }
  // ONL-002 stage 3. Records that came from the account replace this account's
  // copies, and a downloaded original shows the same star as its link. A pool flag
  // is touched only when it differs: updateItem moves the merge revision.
  function applyRemote(accountId, records) {
    const previous = new Map(records.map((record) => {
      const key = B.keyFor(record.source, record.post_id);
      return [key, store.get(accountId, key)];
    }));
    if (!store.putMany(accountId, records)) return false;
    if (accountId !== getAccount()) return true;
    let changed = false;
    for (const record of records) {
      const on = record.state !== 'removed';
      const oldTags = new Set(previous.get(B.keyFor(record.source, record.post_id))?.metadata.user_tags || []);
      for (const match of localMatches(record)) {
        // Only identified personal tags are replaced. Old pool tags have mixed
        // provenance and must neither be erased nor promoted to account user_tags.
        const tags = on ? [...new Set([...(match.tags || []).filter((tag) => !oldTags.has(tag)),
          ...(record.metadata.source_tags || []), ...(record.metadata.user_tags || [])])] : (match.tags || []);
        const tagsChanged = JSON.stringify(match.tags || []) !== JSON.stringify(tags);
        if (!!match.favorite === on && (!on || match.favoritedAt === record.favorited_at) && !tagsChanged) continue;
        updateItem(match.id, { favorite: on, favoritedAt: on ? record.favorited_at : null, ...(tagsChanged ? { tags } : {}) });
        changed = true;
      }
    }
    if (changed) savePool();
    return true;
  }
  // Downloaded stars that predate links: the silent move offers them with the
  // signed-out bookmarks. Pool tags mix site and personal tags, so they travel as
  // source_tags (display data), never as the account's user_tags.
  function poolFavorites() {
    const out = [];
    for (const item of Object.values(getConfig().library || {})) {
      const ref = item.favorite && reference(item);
      if (!ref) continue;
      const record = B.record({ ...ref, metadata: metadata(item), state: 'active',
        favorited_at: item.favoritedAt ?? item.addedAt ?? now() });
      if (record) out.push(record);
    }
    return out;
  }
  return { list, state, set, tags, adopt, applyRemote, poolFavorites };
}

module.exports = { reference, metadata, create };
