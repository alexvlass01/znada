'use strict';

// Real application and renderer, deterministic SAFE image/API fixtures. No DOM,
// IPC, window, input or screenshot replacement. Never runs against an owner profile.
// Preload with NODE_OPTIONS=--require=<this file>, then launch ordinary electron .
// Requires ZNADA_LIB016_FIXTURE_ROOT; preserves the normal app/package/helper paths.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const fixture = path.resolve(process.env.ZNADA_LIB016_FIXTURE_ROOT || '.');
if (!fixture.startsWith(path.join(root, '.tmp') + path.sep)
    || path.resolve(process.env.ZNADA_DEV_USER_DATA || '.') !== path.join(fixture, 'profile')
    || process.env.ZNADA_CLOUD !== 'staging') {
  throw new Error('LIB-016 fixture launch requires its own explicit .tmp profile');
}
const picture = index => fs.readFileSync(path.join(fixture, 'images', `test-${String(index % 18).padStart(2, '0')}.png`));
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
globalThis.fetch = async input => {
  const url = new URL(String(input));
  if (url.hostname === 'wallhaven.cc' && url.pathname.startsWith('/api/v1/search')) {
    const mask = url.searchParams.get('purity') || '100';
    const groups = ['sfw', 'sketchy', 'nsfw'].filter((_group, i) => mask[i] === '1');
    const data = groups.flatMap((purity, group) => [0, 1].map(n => {
      const id = `aaa${group}${n}0`;
      return { id, url: `https://wallhaven.cc/w/${id}`, path: `https://w.wallhaven.cc/full/aa/wallhaven-${id}.png`,
        thumbs: { original: `https://th.wallhaven.cc/orig/${id}.png` },
        dimension_x: 640, dimension_y: 360, file_type: 'image/png', purity, category: 'general' };
    }));
    return json({ data, meta: { current_page: 1, last_page: 1, total: data.length } });
  }
  if (url.hostname === 'wallhaven.cc') return json({ data: { tags: [] } });
  if (url.hostname === 'w.wallhaven.cc') return new Response(picture(1), { headers: { 'content-type': 'image/png' } });
  if (url.hostname.includes('danbooru')) return json([]);
  if (url.hostname.includes('gelbooru')) return json({ post: [], '@attributes': { count: 0 } });
  return json({ error: 'fixture_network_disabled' });
};
// NODE_OPTIONS runs before Electron's browser API has been installed. Defer until
// the ordinary entrypoint has it, without replacing the application bootstrap.
let attempts = 0;
function configure() {
  const { app, session } = require('electron');
  if (!app) {
    if (process.type && process.type !== 'browser') return;
    if (++attempts > 100) throw new Error('Electron browser API did not initialize for fixture');
    setTimeout(configure, 10);
    return;
  }
  app.whenReady().then(() => {
    if (path.resolve(app.getAppPath()) !== root) throw new Error('Fixture must preload the ordinary app entrypoint');
    session.defaultSession.protocol.handle('https', request => {
      const url = new URL(request.url);
      if (url.hostname === 'th.wallhaven.cc' || url.hostname === 'w.wallhaven.cc') {
        const number = Number((url.pathname.match(/aaa(\d)/) || [])[1]) || 0;
        return new Response(picture(number), { headers: { 'content-type': 'image/png' } });
      }
      return new Response('', { status: 404 });
    });
    const main = require('../../main');
    main.__test.setProviderCredentials('wallhaven', { key: 'fixture-only-not-a-real-key' });
    fs.writeFileSync(path.join(fixture, 'fixture-ready.json'), JSON.stringify({ appPath: app.getAppPath(), safeNetwork: true, createdAt: new Date().toISOString() }));
  });
}
setImmediate(configure);
