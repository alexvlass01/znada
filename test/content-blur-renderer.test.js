'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { create } = require('../renderer/content-blur');
const policy = require('../src/content-rating');
const { pathKey } = require('../src/path-key');
const { document } = require('./helpers/content-blur-dom');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8').replace(/\r\n/g, '\n');
function load(name, globals) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, 'm'));
  assert.ok(match, name + ' boundary');
  return vm.runInNewContext('(' + match[0] + ')', globals);
}
const doc = document();
const item = { id: 'a', type: 'image', path: 'C:/Images/a.png', rating: 'explicit' };
const cfg = { contentBlur: { nsfw: true, sketchy: true }, library: { a: item } };
let opens = 0;
const blur = create({ document: doc, policy, pathKey, getConfig: () => cfg, openLocal: () => { opens++; } });
const no = () => {};
const globals = { document: doc, contentBlur: blur, config: cfg, selectedMonitorId: 'monitor',
  t: key => key, baseName: p => p, setLibStatus: no, makeLibCardFocusable: no,
  localSelectionRecord: p => ({ path: p }), primeLibCardAspect: no, lazyThumb: no,
  setCardFavorite: no, appendSelectionToggle: no, bindLocalCardContextMenu: no,
  attachBookmarkStar: no, syncBookmarkStar: no,
  handleSelectionModifierClick: () => false, galleryItemFromLibrary: it => ({ raw: it }),
  galleryItemFromPath: p => ({ raw: { path: p } }), openGalleryFromCard: () => { opens++; },
  cloudThumbUrl: () => 'data:image/png;base64,fixture', galleryItemFromCloud: it => ({ raw: it }),
  galleryItemFromInternet: it => ({ raw: it }), attachOnlineAddButton: no, bindOnlineCardContextMenu: no,
  cloudSignedIn: () => false, setLibCardAspect: no, setInternetCardThumbnail: no,
  window: { api: {}, MediaKind: require('../renderer/media-kind'), MotionBadge: { sync: no, fromSite: () => null },
    CardCaption: { text: () => '' } },
};
let checks = 0;
async function clicks(host, preview = host) {
  assert.strictEqual(preview.classList.contains('content-blur-concealed'), true, 'builder must bind before thumbnail paint');
  const before = opens;
  await host.click(); assert.strictEqual(opens, before, 'first click must never open the viewer');
  await host.click(); assert.strictEqual(opens, before + 1, 'second click opens viewer');
  blur.reset(); checks++;
}
(async () => {
  await clicks(load('buildLibCard', globals)(item, false));
  await clicks(load('buildEphemeralImageCard', globals)(item.path));
  await clicks(load('buildCloudCard', globals)({ id: 'cloud', rating: 'suggestive' }));
  await clicks(load('buildInternetCard', globals)({ id: 'internet', provider: 'wallhaven', purity: 'nsfw' }));
  const changing = load('buildInternetCard', globals)({ id: 'changing', provider: 'wallhaven', purity: 'sfw' });
  load('bindUnifiedGalleryCard', { ...globals,
    bindCardGalleryItem: (card, entry) => { card.__galleryItem = entry; },
  })(changing, { kind: 'internet', item: { id: 'changing', provider: 'wallhaven', purity: 'nsfw' },
    galleryItem: { raw: { id: 'changing', purity: 'nsfw' } }, galleryIndex: 0 });
  await clicks(changing);
  const monitor = doc.createElement('button'); monitor.className = 'home-display';
  const screen = doc.createElement('span'), wallpaper = doc.createElement('span');
  monitor.appendChild(screen); screen.appendChild(wallpaper);
  load('applyHomeDisplayWallpaper', { ...globals, STYLE_CSS: { fill: {} } })(wallpaper,
    { url: 'data:fixture', path: item.path });
  await clicks(monitor, wallpaper);
  const preview = doc.createElement('div'); preview.id = 'previewLight';
  const setPreview = load('setPreview', { ...globals, $: () => preview, applyPreviewStyle: no,
    stillFrameView: async () => null,
    window: { ...globals.window, api: { fileUrl: async () => 'data:fixture' } },
    Image: class { set src(value) { this.url = value; this.onload(); } },
  });
  await setPreview('light', item.path, 'monitor');
  await clicks(preview);
  const elements = {};
  for (const id of ['homeRecentGrid', 'homeRecentEmpty', 'homeRecentAll', 'stripLight', 'stripDark']) {
    elements[id] = doc.createElement('div');
  }
  const localGlobals = { ...globals, $: selector => elements[selector.slice(1)],
    normPathKey: pathKey, homeRecentRenderVersion: 1, layoutHomeRecentRow: no,
    thumbWithMotion: async () => ({ url: 'data:fixture' }), slotItems: () => [item], bindSlotCardContextMenu: no,
    localCardMedia: () => ({ chip: null, moving: null }),
    window: { ...globals.window, MotionHover: { mark: no },
      MotionBadge: { sync: no, fromLocal: () => null }, MediaKind: require('../renderer/media-kind'), api: {} },
  };
  load('renderHomeRecentItems', localGlobals)([item], 1);
  const recent = elements.homeRecentGrid.children[0];
  await clicks(recent, recent.children[0]);
  load('renderStrip', localGlobals)('light');
  await clicks(elements.stripLight.children[0]);
  const folder = doc.createElement('div');
  load('fillFolderCollage', { ...globals, normPathKey: pathKey, folderInfoCache: new Map(),
    window: { api: { folderInfo: async () => ({ count: 1, previews: [item.path] }), thumb: async () => 'data:fixture' } },
  })(folder, 'C:/Images');
  await new Promise(resolve => { setImmediate(resolve); });
  await clicks(folder.children[0].children[0]);
  // Run the actual navigation against the real controller: an existing grid can
  // be reused on return, so resetting only newly built cards would miss this case.
  const navCard = load('buildLibCard', globals)(item, false);
  const page = doc.createElement('div'); page.scrollTop = 470;
  const views = ['viewHome', 'viewLibrary', 'viewDesign', 'viewPrefs'].map(id => {
    const view = doc.createElement('div'); view.id = id; return view;
  });
  const queryAll = doc.querySelectorAll.bind(doc);
  doc.querySelector = selector => selector === '.page' ? page : null;
  doc.querySelectorAll = selector => selector === '.view' ? views
    : selector === '.navbtn' ? [] : queryAll(selector);
  let rendered = null;
  const nav = { ...globals, activePage: 'library', pageScroll: { home: 0, library: 470, design: 0, prefs: 0 },
    LIB: { filter: 'all', folderPath: null }, ONLINE: { view: 'search', generation: 0, renderEpoch: 0 },
    $: selector => selector === '#libGrid' ? { childElementCount: 1 } : null,
    diagSpan: () => no, deferredLiveRefresh: { has: () => false },
    libRenderKey: () => 'cached', lastLibRenderKey: 'cached',
    renderHome: () => { rendered = navCard.dataset.contentBlurred; },
    renderLibrary: no, scheduleAllLibraryLayouts: no, renderPreviews: no, layoutMonitors: no,
    renderEventLog: no, renderMediaFolderRow: no, syncHomeCountdownTimer: no,
    closeLibPopup: no, clearSelection: no, syncSelectionUI: no,
    exitFolderState: () => { nav.LIB.folderPath = null; },
  };
  const showPage = load('showPage', nav), selectSection = load('selectLibrarySection', nav);
  await navCard.click(); showPage('library');
  assert.strictEqual(navCard.dataset.contentBlurred, 'false', 'same page does not conceal'); checks++;
  showPage('home');
  assert.strictEqual(rendered, 'true', 'leaving a page conceals before rendering the next one'); checks++;
  await navCard.click(); showPage('library');
  assert.strictEqual(navCard.dataset.contentBlurred, 'true', 'cached Library grid is concealed on return'); checks++;
  await navCard.click(); showPage('prefs');
  assert.strictEqual(navCard.dataset.contentBlurred, 'true', 'opening settings is a section change'); checks++;
  showPage('library'); await navCard.click(); selectSection('all');
  assert.strictEqual(navCard.dataset.contentBlurred, 'false', 'same Library section keeps disclosure'); checks++;
  selectSection('favorite');
  assert.strictEqual(navCard.dataset.contentBlurred, 'true', 'local Library section change conceals'); checks++;
  await navCard.click(); selectSection('online');
  assert.strictEqual(navCard.dataset.contentBlurred, 'true', 'entering Online conceals'); checks++;
  await navCard.click(); selectSection('favorite', 'cloud');
  assert.strictEqual(navCard.dataset.contentBlurred, 'true', 'Online search and Cloud favorites are distinct sections'); checks++;
  await navCard.click(); blur.refresh();
  const recycled = load('buildLibCard', globals)(item, false);
  assert.strictEqual(recycled.dataset.contentBlurred, 'false', 'scroll refresh and virtualized replacement keep disclosure'); checks++;
  console.log(`PASS content-blur-renderer: ${checks} actual builders, clicks and navigation cases`);
})().catch(error => { console.error(error); process.exitCode = 1; });
