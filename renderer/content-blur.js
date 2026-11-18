'use strict';

(function initContentBlur(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.ContentBlur = api;
}(typeof window !== 'undefined' ? window : globalThis, function contentBlurFactory() {
  function create({ document: doc, policy, pathKey, getConfig, openLocal, onSettings }) {
    const revealed = new Set();
    const bindings = new WeakMap();
    let library = null;
    let byPath = new Map();

    function config() { return getConfig() || {}; }
    function findLocal(p) {
      const current = config().library || {};
      if (library !== current) {
        library = current;
        byPath = new Map(Object.values(current).filter((it) => it.type === 'image' && it.path)
          .map((it) => [pathKey(it.path), it]));
      }
      return byPath.get(pathKey(p));
    }
    function identity(descriptor) {
      const item = descriptor.path ? findLocal(descriptor.path) || {} : descriptor.item || {};
      const rating = policy.of(item);
      let key;
      if (descriptor.path) {
        // Local copies retain their established source/path identity.
        const source = item.source || item.page;
        key = source ? `source:${source}` : `path:${pathKey(descriptor.path)}`;
      } else {
        // Attribution can name an author shared by many different posts. Only the
        // site's post identity may disclose another mounted copy of an online card.
        const provider = item.provider || 'znada';
        const cloud = provider === 'znada' || provider === 'cloud';
        key = cloud && item.id ? `source:znada:${item.id}`
          : `online:${provider}:${item.id || item.page || item.full || item.thumb || ''}`;
      }
      return { key: `${key}|${rating}`, rating };
    }
    function covered(binding) {
      const item = identity(binding.descriptor);
      return policy.hidden(item.rating, config().contentBlur) && !revealed.has(item.key);
    }
    function paint(host) {
      const binding = bindings.get(host);
      if (!binding) return;
      // Some preview builders replace innerHTML. Recreate the cover synchronously
      // before the next paint; callers bind before installing image URLs.
      let cover = binding.preview.querySelector(':scope > .content-blur-cover');
      if (!cover) {
        cover = doc.createElement('span');
        cover.className = 'content-blur-cover';
        cover.setAttribute('aria-hidden', 'true');
        binding.preview.appendChild(cover);
      }
      const hidden = covered(binding);
      binding.preview.classList.toggle('content-blur-concealed', hidden);
      host.dataset.contentBlurred = String(hidden);
    }
    function refresh() {
      doc.querySelectorAll('[data-content-blur-host]').forEach(paint);
    }
    function bind(host, descriptor, preview = host, open = false) {
      if (!host || !preview) return;
      const existing = bindings.has(host);
      bindings.set(host, { descriptor, preview, open });
      host.dataset.contentBlurHost = 'true';
      preview.classList.add('content-blur-preview');
      if (!existing) {
        host.addEventListener('click', (event) => {
          // Dedicated controls and selection modifiers retain their own behavior.
          if (event.ctrlKey || event.shiftKey || event.metaKey || event.altKey) return;
          const control = event.target.closest('button, input, select, a, [role="menuitem"]');
          if (control && control !== host) return;
          const current = bindings.get(host);
          if (covered(current)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            revealed.add(identity(current.descriptor).key);
            refresh();
          } else if (current.open && policy.hidden(identity(current.descriptor).rating, config().contentBlur)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            openLocal(current.descriptor.path);
          }
        }, true);
      }
      paint(host);
    }
    function reset() { revealed.clear(); refresh(); }
    function syncSettings() {
      for (const group of ['nsfw', 'sketchy']) {
        const input = doc.getElementById(`blur-${group}`);
        if (input) {
          const on = !!(config().contentBlur && config().contentBlur[group]);
          input.classList.toggle('on', on);
          input.setAttribute('aria-checked', String(on));
        }
      }
      refresh();
    }
    function install() {
      for (const group of ['nsfw', 'sketchy']) {
        const input = doc.getElementById(`blur-${group}`);
        if (input) input.addEventListener('click', async () => {
          input.disabled = true;
          try { await onSettings({ [group]: !(config().contentBlur && config().contentBlur[group]) }); }
          finally { input.disabled = false; syncSettings(); }
        });
      }
      // Navigation and the main-process hide event reset disclosures explicitly.
      // Minimize, focus changes and the viewer must not reset the current section.
      syncSettings();
    }
    return { bind, refresh, reset, syncSettings, install,
      enabled: () => policy.hidden('nsfw', config().contentBlur) || policy.hidden('sketchy', config().contentBlur) };
  }
  return { create };
}));
