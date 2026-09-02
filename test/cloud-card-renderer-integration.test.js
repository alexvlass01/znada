'use strict';

// ONL-014c. A catalogue item crosses a shape boundary: the Cloud API speaks
// `thumb_url`/`rating`, while the shared provider result speaks `thumb`/`purity`.
// Exercise the REAL renderer functions against both shapes so search cards and the
// legacy favorites feed cannot silently diverge again.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cloudProvider = require('../src/cloud/provider');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8')
  .split('\r\n').join('\n');

function functionSource(name) {
  const match = renderer.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `${name} must remain an explicit renderer boundary`);
  return match[0];
}

function optionalHelper(name) {
  const match = renderer.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  return match ? vm.runInNewContext(`(${match[0]})`) : undefined;
}

const helpers = {};
for (const name of ['cloudThumbUrl', 'cloudRating']) {
  const helper = optionalHelper(name);
  if (helper) helpers[name] = helper;
}

const galleryItemFromCloud = vm.runInNewContext(`(${functionSource('galleryItemFromCloud')})`, {
  ...helpers,
  t: (key) => key,
  gallerySubtitle: (parts) => parts.filter(Boolean).join(' | '),
});

let addKind = '';
let addFn = null;
let addCalls = 0;
const buildCloudCard = vm.runInNewContext(`(${functionSource('buildCloudCard')})`, {
  ...helpers,
  document: {
    createElement: () => ({
      className: '', title: '', style: {}, dataset: {},
      addEventListener: () => {}, appendChild: () => {},
    }),
  },
  makeLibCardFocusable: () => {},
  setLibCardAspect: () => {},
  galleryItemFromCloud,
  attachOnlineAddButton: (_card, kind, _item, fn) => { addKind = kind; addFn = fn; },
  bindOnlineCardContextMenu: () => {},
  cloudSignedIn: () => false,
  setLibStatus: () => {},
  openGalleryFromCard: () => {},
  t: (key) => key,
  window: { api: { cloudAdd: async () => { addCalls += 1; return { error: null }; } } },
});

const apiItem = {
  id: 'cloud-1', title: 'Sky', rating: 'general', width: 1920, height: 1080,
  thumb_url: 'https://storage.example/thumb/cloud-1.webp?X-Amz-Expires=900',
};
const sharedItem = cloudProvider.mapItem(apiItem);

function assertRendered(name, item) {
  const gallery = galleryItemFromCloud(item);
  const card = buildCloudCard(item);
  assert.strictEqual(gallery.previewUrl, apiItem.thumb_url, `${name}: viewer preview must use the catalogue thumbnail`);
  assert.ok(gallery.subtitle.includes('online.ratingGeneral'), `${name}: rating must survive the shape boundary`);
  assert.ok(card.style.backgroundImage.includes(apiItem.thumb_url), `${name}: grid card must paint the catalogue thumbnail`);
}

assertRendered('shared search card', sharedItem);
assertRendered('legacy favorites card', apiItem);
assert.strictEqual(addKind, 'cloud', 'the shared card must keep the Cloud download path');

(async () => {
  assert.strictEqual(typeof addFn, 'function');
  await addFn();
  assert.strictEqual(addCalls, 1, 'the add action must request a fresh Cloud download');

  const auth = {
    state: { available: true, signedIn: true, user: { id: 'account-a' }, entitlements: [] },
    fetched: true,
  };
  const favorites = { ids: new Set(['private-a']), fetched: true };
  const online = { view: 'favorites', loaded: true };
  let toastText = '';
  const doCloudSignout = vm.runInNewContext(`(${functionSource('doCloudSignout')})`, {
    window: {
      api: {
        // Sign-out no longer fails because a bearer file could not be deleted — that
        // stranded the account. What is left is the request not reaching main at all,
        // where the session state is genuinely unknown.
        cloudSignout: async () => { throw new Error('ipc gone'); },
      },
    },
    CardTransfer: require('../renderer/card-transfer'),
    CLOUDAUTH: auth,
    CLOUDFAV: favorites,
    ONLINE: online,
    LIB: { filter: 'library' },
    renderCloudAccount: () => {},
    applyFavToggleUI: () => {},
    doOnlineSearch: () => {},
    toast: (text) => { toastText = text; },
    t: (key, params) => `${key}:${(params && params.e) || ''}`,
  });
  await doCloudSignout();
  assert.strictEqual(auth.state.signedIn, true,
    'a sign-out that never reached main was treated as if it had succeeded');
  assert.strictEqual(favorites.ids.has('private-a'), true,
    'a failed sign-out must not erase the current account favorites from renderer state');
  assert.strictEqual(online.view, 'favorites',
    'a failed sign-out must not switch the current account away from its favorites view');
  assert.strictEqual(toastText, 'online.offline:',
    'a request that never left the window was reported as something the user cannot act on');
  console.log('Cloud card renderer integration OK for shared and legacy shapes.');
})().catch((err) => { console.error(err); process.exit(1); });
