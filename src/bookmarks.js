'use strict';

// ONL-002 stage 1. Local bookmark records, independent of downloaded library items.
// A source id stays a string: converting a booru id to Number can lose digits.
const C = require('./cloud/contracts.cjs');

function keyFor(source, postId) {
  const result = C.BookmarkKey.safeParse({ source, post_id: postId });
  return result.success ? `${source}:${postId}` : null;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function record(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const allowed = ['source', 'post_id', 'favorited_at', 'metadata', 'state'];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return null;
  if (!keyFor(raw.source, raw.post_id) || !timestamp(raw.favorited_at)) return null;
  if (!['active', 'removed', 'unavailable'].includes(raw.state)) return null;
  const metadata = C.BookmarkMetadata.safeParse(raw.metadata);
  if (!metadata.success) return null;
  return { source: raw.source, post_id: raw.post_id, favorited_at: raw.favorited_at,
    metadata: metadata.data, state: raw.state };
}

// The local display copy can contain catalog metadata. Only user_tags may leave
// the device in a znada operation; keep that boundary in one tested function.
function operationMetadata(item) {
  const clean = record(item);
  if (!clean) throw new TypeError('Invalid bookmark');
  return clean.source === 'znada'
    ? (clean.metadata.user_tags ? { user_tags: clean.metadata.user_tags.slice() } : {})
    : clean.metadata;
}

function wallhavenRating(purity) {
  const ratings = { sfw: 'general', sketchy: 'suggestive', nsfw: 'explicit' };
  return Object.hasOwn(ratings, purity) ? ratings[purity] : null;
}

// Accounts are namespaces, never file names. Prefixing prevents an account named
// "anonymous" (or an object prototype property) from colliding with signed-out data.
function partitionKey(accountId) {
  if (accountId === null) return 'anonymous';
  if (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 256) {
    throw new TypeError('An account id or explicit null is required');
  }
  return `account:${accountId}`;
}

function list(records) {
  return Object.values(records || {}).map(record)
    .filter((item) => item && item.state !== 'removed')
    .sort((a, b) => b.favorited_at - a.favorited_at
      || keyFor(a.source, a.post_id).localeCompare(keyFor(b.source, b.post_id)));
}

module.exports = { keyFor, record, operationMetadata, wallhavenRating, partitionKey, list };
