'use strict';
const assert = require('assert');
const { create } = require('../renderer/content-blur');
const policy = require('../src/content-rating');
const { pathKey } = require('../src/path-key');
const { document } = require('./helpers/content-blur-dom');
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
(async () => {
  const doc = document();
  let cfg = { contentBlur: { nsfw: true, sketchy: false }, library: {
    a: { id: 'a', type: 'image', path: 'C:\\Photos\\a.png', rating: 'explicit' },
  } };
  let opens = 0;
  const blur = create({ document: doc, policy, pathKey, getConfig: () => cfg,
    openLocal: () => { opens++; }, onSettings: async patch => { cfg = { ...cfg, contentBlur: { ...cfg.contentBlur, ...patch } }; } });
  const a = doc.createElement('div');
  blur.bind(a, { path: 'c:/photos/a.png' });
  a.addEventListener('click', () => { opens++; });
  check(a.dataset.contentBlurred === 'true', 'known NSFW is concealed synchronously before loading its URL');
  await a.click();
  check(opens === 0 && a.dataset.contentBlurred === 'false', 'first click only reveals');
  await a.click();
  check(opens === 1, 'next click reaches the real card action');
  const recreated = doc.createElement('div');
  blur.bind(recreated, { path: 'C:/Photos/a.png' });
  check(recreated.dataset.contentBlurred === 'false', 'recreated/virtualized card keeps the disclosure');
  a.isConnected = false;
  blur.refresh();
  check(recreated.dataset.contentBlurred === 'false', 'refresh within the current section does not reset');
  blur.reset();
  check(recreated.dataset.contentBlurred === 'true', 'explicit tray reset conceals active cards');
  const thumb = doc.createElement('div'), button = doc.createElement('button');
  thumb.appendChild(button);
  blur.bind(thumb, { path: 'C:/Photos/a.png' });
  await thumb.click({ target: button });
  check(thumb.dataset.contentBlurred === 'true', 'favorite/menu/remove controls do not disclose');
  await thumb.click({ ctrlKey: true });
  check(thumb.dataset.contentBlurred === 'true', 'selection modifiers do not disclose');
  const online = doc.createElement('div');
  blur.bind(online, { item: { id: 'cloud-a', purity: 'nsfw' } });
  await online.click();
  cfg = { ...cfg, library: { ...cfg.library, cloud: {
    type: 'image', path: 'C:/Photos/cloud.png', rating: 'explicit', source: 'znada:cloud-a',
  } } };
  const downloaded = doc.createElement('div');
  blur.bind(downloaded, { path: 'C:/Photos/cloud.png' });
  check(downloaded.dataset.contentBlurred === 'false', 'Cloud and local cards share disclosure before leaving the section');
  cfg = { ...cfg, library: { a: { type: 'image', path: 'C:/Photos/a.png', rating: '' } } };
  blur.refresh();
  check(recreated.dataset.contentBlurred === 'false', 'unknown remains visible after config replacement');
  cfg = { ...cfg, library: { a: { type: 'image', path: 'C:/Photos/a.png', rating: 'explicit' } } };
  blur.refresh();
  check(recreated.dataset.contentBlurred === 'true', 'newly learned rating updates existing cards');
  const home = doc.createElement('button'), preview = doc.createElement('span');
  home.appendChild(preview);
  blur.bind(home, { path: 'C:/Photos/a.png' }, preview, true);
  const before = opens;
  await home.click(); await home.click();
  check(opens === before + 1, 'Home/Appearance first reveal and second open the viewer');
  preview.children = [];
  blur.bind(home, { path: 'C:/Photos/a.png' }, preview, true);
  check(preview.children.length === 1, 'preview innerHTML replacement restores its cover');
  for (const group of ['nsfw', 'sketchy']) { const input = doc.createElement('button'); input.id = 'blur-' + group; }
  blur.install();
  await doc.getElementById('blur-sketchy').click();
  check(cfg.contentBlur.nsfw && cfg.contentBlur.sketchy, 'Sketchy toggle preserves NSFW setting');
  check(doc.getElementById('blur-sketchy').attributes['aria-checked'] === 'true', 'real switch accessibility state syncs');
  // A disclosure belongs to the normalized rating as well as the image. An
  // equivalent source alias keeps it; moving to another concealed group does not.
  for (const [from, alias, to, source] of [
    ['sensitive', 'questionable', 'explicit', null],
    ['explicit', 'nsfw', 'sensitive', 'https://example.test/posts/rated'],
  ]) {
    const ratingDoc = document();
    const entry = { type: 'image', path: 'C:/Photos/rated.png', rating: from, ...(source ? { source } : {}) };
    let ratingConfig = { contentBlur: { nsfw: true, sketchy: true }, library: { rated: entry } };
    const ratingBlur = create({ document: ratingDoc, policy, pathKey, getConfig: () => ratingConfig });
    const card = ratingDoc.createElement('div');
    ratingBlur.bind(card, { path: entry.path });
    check(card.dataset.contentBlurred === 'true', `${from}: starts concealed`);
    await card.click();
    check(card.dataset.contentBlurred === 'false', `${from}: first click discloses before reclassification`);
    ratingConfig = { ...ratingConfig, library: { rated: { ...entry, rating: alias } } };
    ratingBlur.refresh();
    check(card.dataset.contentBlurred === 'false', `${from} -> ${alias}: same normalized rating keeps disclosure`);
    ratingConfig = { ...ratingConfig, library: { rated: { ...entry, rating: to } } };
    ratingBlur.refresh();
    check(card.dataset.contentBlurred === 'true', `${from} -> ${to}: changed concealed rating requires a new disclosure`);
  }
  // QA-021. openLocal and the card's own click are different counters. A shared
  // counter stays green when the controller opens the viewer and swallows the click:
  // dropping policy.hidden() from the open=true branch does exactly that for a picture
  // that is not concealed. Home/Appearance pass open=true.
  async function ordinaryOpenClick(label, entry, blurSettings) {
    const plain = document();
    let viewer = 0;
    let actions = 0;
    const local = create({
      document: plain, policy, pathKey, getConfig: () => ({
        contentBlur: blurSettings,
        library: { item: { type: 'image', ...entry } },
      }),
      openLocal: () => { viewer++; },
    });
    const host = plain.createElement('button');
    const preview = plain.createElement('span');
    host.appendChild(preview);
    local.bind(host, { path: entry.path }, preview, true);
    host.addEventListener('click', () => { actions++; });
    const stopped = await host.click();
    check(host.dataset.contentBlurred === 'false', `${label}: not concealed`);
    check(stopped === false && viewer === 0 && actions === 1,
      `${label}: open=true click reaches the card without openLocal or stop`);
  }
  const bothOn = { nsfw: true, sketchy: true };
  await ordinaryOpenClick('SFW', { path: 'C:/Photos/sfw.png', rating: 'general' }, bothOn);
  await ordinaryOpenClick('unknown', { path: 'C:/Photos/unknown.png', rating: '' }, bothOn);
  await ordinaryOpenClick('NSFW with blur off', { path: 'C:/Photos/nsfw-off.png', rating: 'explicit' },
    { nsfw: false, sketchy: true });
  await ordinaryOpenClick('Sketchy with blur off', { path: 'C:/Photos/sketchy-off.png', rating: 'sensitive' },
    { nsfw: true, sketchy: false });
  for (const [label, entry] of [
    ['NSFW', { path: 'C:/Photos/nsfw.png', rating: 'explicit' }],
    ['Sketchy', { path: 'C:/Photos/sketchy.png', rating: 'questionable' }],
  ]) {
    const plain = document();
    let viewer = 0;
    let actions = 0;
    const local = create({
      document: plain, policy, pathKey, getConfig: () => ({
        contentBlur: bothOn,
        library: { item: { type: 'image', ...entry } },
      }),
      openLocal: () => { viewer++; },
    });
    const host = plain.createElement('button');
    const preview = plain.createElement('span');
    host.appendChild(preview);
    local.bind(host, { path: entry.path }, preview, true);
    host.addEventListener('click', () => { actions++; });
    const first = await host.click();
    check(first === true && viewer === 0 && actions === 0 && host.dataset.contentBlurred === 'false',
      `${label}: first open=true click only reveals`);
    const second = await host.click();
    check(second === true && viewer === 1 && actions === 0,
      `${label}: second open=true click opens the viewer and does not run the card`);
  }
  console.log(`PASS content-blur: ${checks} controller/lifecycle/interaction cases`);
})().catch(error => { console.error(error); process.exitCode = 1; });
