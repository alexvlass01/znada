'use strict';

// ONL-005. One selection policy for config migration, IPC and the renderer. Site
// identities come from the registry, never from a second hardcoded provider list.
(function initOnlineSources(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OnlineSources = api;
}(typeof window !== 'undefined' ? window : globalThis, function onlineSourcesFactory() {
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  function available(definitions) {
    return (Array.isArray(definitions) ? definitions : []).filter((p) =>
      p && typeof p.id === 'string' && p.status !== 'retired'
      && (p.browse === true || (p.capabilities && p.capabilities.browse === true)));
  }
  function isCloud(provider) { return provider && provider.sourceKey === 'lumina'; }
  function enabled(value, provider) {
    const source = object(value) ? value : {};
    if (!provider || provider.status === 'retired') return false;
    if (isCloud(provider)) return !!source.lumina;
    // Once the per-site selection exists, a new site must not opt itself in.
    return object(source.providers) ? source.providers[provider.id] === true : source.internet !== false;
  }
  function normalize(value, definitions) {
    const source = object(value) ? value : {};
    const list = available(definitions);
    const external = list.filter((p) => !isCloud(p));
    const providers = Object.fromEntries(external.map((p) => [p.id, enabled(source, p)]));
    let lumina = !!source.lumina;
    let internet = Object.values(providers).some(Boolean);
    if (!lumina && !internet) {
      // Repair a malformed disk setting conservatively. Interactive patches refuse
      // all-off instead, so clicking a checkbox never enables another site.
      if (external.length) { providers[external[0].id] = true; internet = true; }
      else if (list.some(isCloud)) lumina = true;
    }
    return { lumina, internet, providers };
  }
  function patch(value, current, definitions) {
    if (!object(value)) return null;
    const allowed = ['lumina', 'internet', 'providers'];
    if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
    for (const key of ['lumina', 'internet']) {
      if (own(value, key) && typeof value[key] !== 'boolean') return null;
    }
    const list = available(definitions);
    const external = list.filter((p) => !isCloud(p));
    const out = normalize(current, list);
    if (own(value, 'lumina')) out.lumina = value.lumina;
    if (own(value, 'providers')) {
      if (!object(value.providers)) return null;
      for (const key of Object.keys(value.providers)) {
        if (!external.some((p) => p.id === key) || typeof value.providers[key] !== 'boolean') return null;
        out.providers[key] = value.providers[key];
      }
    } else if (own(value, 'internet')) {
      // Old callers can still change the former Internet switch. New callers send
      // a per-provider patch; the compatibility mirror is derived, not authoritative.
      for (const provider of external) out.providers[provider.id] = value.internet;
    }
    out.internet = Object.values(out.providers).some(Boolean);
    if (!out.internet && !out.lumina) return null;
    return out;
  }
  function signature(value) {
    const source = object(value) ? value : {};
    const ids = object(source.providers)
      ? Object.keys(source.providers).filter((id) => source.providers[id] === true).sort()
      : [source.internet !== false ? 'legacy-internet' : ''];
    return JSON.stringify([!!source.lumina, ids]);
  }
  return { available, isCloud, enabled, normalize, patch, signature };
}));
