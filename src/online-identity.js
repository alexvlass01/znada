'use strict';

// Cross-provider identity is byte identity, not the author's post URL: a post may
// contain multiple images. Shared by main's batch merge and renderer pagination.
(function initOnlineIdentity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OnlineIdentity = api;
}(typeof window !== 'undefined' ? window : globalThis, function onlineIdentityFactory() {
  function keys(item) {
    const out = [];
    if (!item || typeof item !== 'object') return out;
    const hash = String(item.md5 || '').trim().toLowerCase();
    if (/^[a-f0-9]{32}$/.test(hash)) out.push('md5:' + hash);
    if (item.provider && item.id != null && String(item.id)) {
      out.push('at:' + item.provider + ':' + String(item.id));
    }
    return out;
  }
  return { keys };
}));
