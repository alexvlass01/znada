'use strict';

// Plain Node test: `node test/card-details.test.js`.
//
// ONL-016. The "Details" sheet used to exist only for photos already on disk. These
// checks pin down what it now says about a card from a site, and — just as important —
// that the local sheet still says exactly what it said before.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const D = require('../renderer/card-details');
const CardActions = require('../renderer/card-actions');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; };

const rowById = (model, id) => model.rows.find((r) => r.id === id) || null;
const hasAction = (model, id) => model.actions.some((a) => a.id === id);
const NAMES = { wallhaven: 'Wallhaven', gelbooru: 'Gelbooru', danbooru: 'Danbooru', znada: 'Znada' };

// ---------------------------------------------------------------------------
// A local photo: the sheet it already had.
// ---------------------------------------------------------------------------
const localItem = {
  id: 'abc', path: 'C:\\Photos\\sunset.jpg', type: 'image', addedAt: 1750000000000,
  author: 'someone', rating: 'general', source: 'https://gelbooru.com/index.php?page=post&s=view&id=1',
  tags: ['sky', 'sunset'],
};
const localSubject = CardActions.localSubject({ path: localItem.path, type: 'image', id: 'abc' }, localItem);
const local = D.buildDetailsModel(localSubject, { item: localItem, providerNames: NAMES });

ok('local: still reads the disk', local.readsDisk === true && local.path === localItem.path);
ok('local: titled by file name', local.title === 'sunset.jpg');
ok('local: resolution/size/modified wait for the disk', ['resolution', 'size', 'modified']
  .every((id) => rowById(local, id) && rowById(local, id).kind === 'pending'));
ok('local: row order unchanged', local.rows.map((r) => r.id).join(',')
  === 'type,resolution,size,added,modified,author,rating,source,path,tags');
ok('local: an openable source is a link', rowById(local, 'source').kind === 'link');
ok('local: footer is reveal + copy path + open source', local.actions.map((a) => a.id).join(',')
  === 'openFolder,copyPath,openSource');
ok('local: preview comes from the file', local.preview && local.preview.kind === 'local'
  && local.preview.path === localItem.path);
// A card from a site that is no longer asked must still say where it came from, so the
// name lookup covers every provider and not only the active ones.
ok('local: no site row — a file on disk is not "from" a site', !rowById(local, 'site'));

const noSource = D.buildDetailsModel(localSubject, { item: { ...localItem, source: 'znada:42' }, providerNames: NAMES });
ok('local: a provenance marker is text, never a dead link', rowById(noSource, 'source').kind === 'text'
  && rowById(noSource, 'source').value === 'Znada'
  && !hasAction(noSource, 'openSource'));

const folder = D.buildDetailsModel(
  CardActions.localSubject({ path: 'C:\\Photos', type: 'folder', id: 'f1' }, { id: 'f1', path: 'C:\\Photos', type: 'folder' }),
  { item: { id: 'f1', path: 'C:\\Photos', type: 'folder' }, providerNames: NAMES },
);
ok('folder: no resolution, no size, no preview', !rowById(folder, 'resolution')
  && !rowById(folder, 'size') && folder.preview === null);
ok('folder: still asks the disk for the modified date', rowById(folder, 'modified').kind === 'pending');

// ---------------------------------------------------------------------------
// A card from a site — the whole point of the task.
// ---------------------------------------------------------------------------
const whCard = {
  id: 'wallhaven:vpe7qp', provider: 'wallhaven', page: 'https://wallhaven.cc/w/vpe7qp',
  full: 'https://w.wallhaven.cc/full/vp/wallhaven-vpe7qp.png',
  thumb: 'https://th.wallhaven.cc/orig/vp/vpe7qp.jpg', loadsDirectly: true,
  width: 3840, height: 2080, fileSize: 7649356, format: 'png', purity: 'sfw',
  artist: '', source: '', tags: [],
};
const wh = D.buildDetailsModel(CardActions.internetSubject(whCard), { providerNames: NAMES });

ok('online: the sheet opens at all', !!wh);
ok('online: never touches the disk', wh.readsDisk === false && wh.path === '');
ok('online: says which site it is from', rowById(wh, 'site').value === 'Wallhaven');
ok('online: resolution is known immediately, not pending',
  rowById(wh, 'resolution').kind === 'text' && rowById(wh, 'resolution').value === '3840 × 2080');
ok('online: file size is carried as bytes for the window to format',
  rowById(wh, 'size').kind === 'bytes' && rowById(wh, 'size').value === 7649356);
ok('online: format shown', rowById(wh, 'format').value === 'PNG');
ok('online: the post page is an openable link', rowById(wh, 'page').kind === 'link'
  && rowById(wh, 'page').value === 'https://wallhaven.cc/w/vpe7qp');
ok('online: titled by the picture file name', wh.title === 'wallhaven-vpe7qp.png');
ok('online: footer offers the page and the link', wh.actions.map((a) => a.id).join(',')
  === 'openSource,copyLink');
ok('online: preview says it may load straight from the window',
  wh.preview.kind === 'online' && wh.preview.loadsDirectly === true);
ok('online: no author row when the site does not name one', !rowById(wh, 'author'));

// Gelbooru: no size field exists on its posts at all (checked against the live API),
// so the row must be absent rather than "unknown".
const gelCard = {
  id: 'gelbooru:1', provider: 'gelbooru', page: 'https://gelbooru.com/index.php?id=1',
  full: 'https://img3.gelbooru.com/images/aa/bb/x.jpg', thumb: 'https://img3.gelbooru.com/thumb.jpg',
  width: 1920, height: 1080, fileSize: 0, format: 'jpg', purity: 'sketchy',
  artist: 'kantoku', source: 'https://x.com/kantoku/status/1', tags: ['1girl', 'sky'],
};
const gel = D.buildDetailsModel(CardActions.internetSubject(gelCard), { providerNames: NAMES });
ok('gelbooru: no size row, because the site reports no size', !rowById(gel, 'size'));
ok('gelbooru: booru previews are declared as needing the main process',
  gel.preview.kind === 'online' && gel.preview.loadsDirectly === false);
ok('gelbooru: the artist is shown as the author', rowById(gel, 'author').value === 'kantoku');
ok('gelbooru: the uploader-credited original is a separate row from the post page',
  rowById(gel, 'page').value === gelCard.page
  && rowById(gel, 'original').value === gelCard.source);
ok('gelbooru: tags travel with the card', rowById(gel, 'tags').values.join(',') === '1girl,sky');
// The feed's three-level bucket and a pool record's exact word are different scales,
// and both have to end up as a label rather than as a raw token.
ok('gelbooru: the middle purity bucket gets a label', rowById(gel, 'rating').valueKey === 'details.ratingSensitive');

const sameSource = D.buildDetailsModel(
  CardActions.internetSubject({ ...gelCard, source: gelCard.page }), { providerNames: NAMES },
);
ok('a source equal to the post page is not repeated', !rowById(sameSource, 'original'));

const relativeSource = D.buildDetailsModel(
  CardActions.internetSubject({ ...gelCard, source: 'pixiv id 12345' }), { providerNames: NAMES },
);
ok('a source that is not a web address is not shown as one', !rowById(relativeSource, 'original'));

// ---------------------------------------------------------------------------
// Our own catalogue: the card that must NOT be given link buttons.
// ---------------------------------------------------------------------------
const cloudCard = {
  id: '77', provider: 'znada', title: 'Nordic morning', page: '', full: '',
  thumb: 'https://signed.example/thumb?exp=1', width: 2560, height: 1440,
  format: '', purity: 'nsfw',
};
const cloud = D.buildDetailsModel(CardActions.cloudSubject(cloudCard), { providerNames: NAMES });
ok('catalogue: described like any other card', rowById(cloud, 'site').value === 'Znada'
  && rowById(cloud, 'resolution').value === '2560 × 1440');
ok('catalogue: no page row and no link buttons — it has neither',
  !rowById(cloud, 'page') && cloud.actions.length === 0);
ok('catalogue: titled by its own title', cloud.title === 'Nordic morning');
ok('catalogue: an unstated format produces no row', !rowById(cloud, 'format'));

// ---------------------------------------------------------------------------
// Junk in, nothing out.
// ---------------------------------------------------------------------------
ok('junk subjects are refused', D.buildDetailsModel(null) === null
  && D.buildDetailsModel({}) === null && D.buildDetailsModel('x') === null);
ok('a card with no provider name still opens', (() => {
  const m = D.buildDetailsModel(CardActions.internetSubject(whCard), {});
  return !!m && !rowById(m, 'site') && m.title === 'wallhaven-vpe7qp.png';
})());
ok('an unknown rating word is dropped rather than shown raw',
  D.ratingKey('brand-new-word') === '' && D.ratingKey('EXPLICIT') === 'details.ratingExplicit');
ok('resolutionText refuses nonsense', D.resolutionText(0, 100) === ''
  && D.resolutionText(100, 0) === '' && D.resolutionText('a', 'b') === '');
ok('tagList trims, drops blanks and reports the overflow', (() => {
  const r = D.tagList([' sky ', '', null, 'sun'], 1);
  return r.shown.join(',') === 'sky' && r.hidden === 1;
})());
ok('fileNameFromUrl survives a junk address', D.fileNameFromUrl('not a url') === ''
  && D.fileNameFromUrl('') === '');

// ---------------------------------------------------------------------------
// The menu has to actually offer it, and the window has to actually load the module.
// A model nobody can reach would pass every check above.
// ---------------------------------------------------------------------------
ok('the card menu offers Details for an online card', CardActions
  .actionsFor(CardActions.internetSubject(whCard)).some((a) => a.id === 'details'));
ok('the card menu still offers Details for a local card', CardActions
  .actionsFor(localSubject).some((a) => a.id === 'details'));

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
ok('the window loads card-details.js', html.includes('card-details.js'));

const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
ok('the sheet is drawn from the model, not from a path',
  rendererSrc.includes('CardDetails.buildDetailsModel(subject, {')
  && rendererSrc.includes('if (model.readsDisk && !model.path) return;'));
ok('the menu hands the sheet the whole card', rendererSrc.includes('details: () => openCardDetails(subject, record),'));
// Without this the sheet would ask the disk about a picture that has no file.
ok('an online sheet stops before the disk read', rendererSrc.includes('if (!model.readsDisk) return;'));

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok('main tells the window what the sites are called',
  mainSrc.includes('providers: providerRegistry.PROVIDERS.map((p) => ({ id: p.id, name: p.name }))'));

const en = require('../locales/en.json');
const ru = require('../locales/ru.json');
ok('both reference languages carry the new labels', ['site', 'format', 'originalSource']
  .every((k) => en.details[k] && ru.details[k]));

console.log('\nAll ' + passed + ' card-details tests passed.');
