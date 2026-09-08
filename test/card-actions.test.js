'use strict';

// ONL-009: one answer to "what can you do with this card". These tests pin the rules
// that are easy to get wrong and expensive when wrong — above all that our own
// catalogue's cards are online AND have no page and no lasting link, so the two link
// actions must never appear on them.

const assert = require('assert');
const CardActions = require('../renderer/card-actions');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

const ids = (input, features) => CardActions.actionsFor(input, features).map((a) => a.id);

const poolItem = (over = {}) => ({
  id: 'p1', type: 'image', path: 'C:/Users/x/AppData/Roaming/znada/wallpapers/p1-light.jpg', ...over,
});
const wallhaven = (over = {}) => ({
  id: 'wh1', provider: 'wallhaven', page: 'https://wallhaven.cc/w/abc', full: 'https://w.wallhaven.cc/full/a.jpg', ...over,
});
const cloudCard = (over = {}) => ({ id: 42, title: 'Sample', width: 1920, height: 1080, ...over });

// --- our own catalogue is the special case, so it comes first ---------------
{
  const subject = CardActions.cloudSubject(cloudCard());
  const list = ids(subject);

  ok('a Znada catalogue card offers no "open source page" — there is no page to open',
    !list.includes('openSource'));
  ok('and no "copy link" — its only link is signed and would die in the user\u2019s hands',
    !list.includes('copyLink'));
  ok('but it can still be saved, copied, assigned and added, because main can fetch a fresh link',
    list.includes('saveAs') && list.includes('copyFile') && list.includes('assign') && list.includes('add'));

  // ONL-014. Those three answers come from what the CARD declares, not from which
  // catalogue it came from. Proven by taking the declaration away: nothing else about
  // the card changes, and every action that needs a file disappears.
  const noLink = ids({ ...subject, freshFileUrl: false });
  ok('a card that can neither hold a lasting link nor mint a fresh one is offered no file actions',
    !noLink.includes('saveAs') && !noLink.includes('copyFile') && !noLink.includes('add'));
  ok('and one that declares a lasting link is offered them without naming any catalogue',
    ids({ ...subject, freshFileUrl: false, stableFileUrl: true }).includes('saveAs'));

  // The trap: treating "online" as one thing. A Wallhaven card is online too and DOES
  // have both, so a rule written as "if online then show the link actions" passes a
  // careless test and breaks exactly here.
  const wh = ids(CardActions.internetSubject(wallhaven()));
  ok('a Wallhaven card, also online, DOES offer both link actions',
    wh.includes('openSource') && wh.includes('copyLink'));
}

// --- online cards, added and not added --------------------------------------
{
  const fresh = ids(CardActions.internetSubject(wallhaven()));
  ok('an online card that is not in the library offers to add it, and not to remove it',
    fresh.includes('add') && !fresh.includes('remove'));

  const added = ids(CardActions.internetSubject(wallhaven(), poolItem()));
  ok('once it is in the library the offer flips to removing it',
    added.includes('remove') && !added.includes('add'));

  // ONL-016 removed one third of this: the details sheet no longer needs a file, so an
  // online card is described like any other. Tags and favourites still do need a pool
  // record, and a card that has not been added does not have one.
  ok('online cards get no tags and no favourites until they are in the library',
    !fresh.includes('tags') && !fresh.includes('favorite'));
  ok('but they ARE describable — the sheet reads the card, not a file',
    fresh.includes('details'));

  // A provider that returned no usable file URL cannot promise a file.
  const brokenList = ids(CardActions.internetSubject(wallhaven({ full: '' })));
  ok('an online card with no file URL offers nothing that needs the file',
    !brokenList.includes('saveAs') && !brokenList.includes('copyFile')
    && !brokenList.includes('assign') && !brokenList.includes('add'));
  ok('though it can still be opened and its page copied',
    brokenList.includes('openSource') && brokenList.includes('copyLink'));
}

// --- local cards keep everything they had, and gain the two transfer actions -
{
  const record = { key: 'k', path: 'C:/photos/a.jpg', type: 'image', id: 'p1' };
  const list = ids(CardActions.localSubject(record, poolItem()));
  ok('a local photo keeps assign, favourites, tags, details and remove',
    ['assign', 'favorite', 'tags', 'details', 'remove'].every((id) => list.includes(id)));
  ok('and now also gets "save as" and "copy picture" — the same actions online cards get',
    list.includes('saveAs') && list.includes('copyFile'));
  ok('a local photo has no page unless one was stored with it, so no link actions',
    !list.includes('openSource') && !list.includes('copyLink'));

  const downloaded = ids(CardActions.localSubject(record, poolItem({ source: 'https://wallhaven.cc/w/abc' })));
  ok('a photo downloaded earlier DOES keep its source page in the menu',
    downloaded.includes('openSource') && downloaded.includes('copyLink'));

  const folder = ids(CardActions.localSubject({ path: 'C:/photos', type: 'folder' }, poolItem({ type: 'folder', path: 'C:/photos' })));
  ok('a folder can be opened and removed but never saved or copied as a picture',
    folder.includes('open') && folder.includes('remove')
    && !folder.includes('saveAs') && !folder.includes('copyFile'));

  const transient = ids(CardActions.localSubject({ path: 'C:/photos/b.jpg', type: 'image' }));
  ok('a photo inside a watched folder with no record yet still offers the full set',
    ['assign', 'favorite', 'tags', 'details', 'remove', 'saveAs', 'copyFile'].every((id) => transient.includes(id)));
}

// --- the trash view ---------------------------------------------------------
{
  const removed = { key: 'k', path: 'C:/photos/a.jpg', type: 'image', id: 'p1', removedView: true };
  const list = ids(CardActions.localSubject(removed, poolItem()), { physicalDelete: false });
  ok('a removed photo offers to be put back, and is not offered assign/tags/remove again',
    list.includes('restore')
    && !list.includes('assign') && !list.includes('tags') && !list.includes('remove'));
  ok('nor is it offered save/copy — it is not part of the library right now',
    !list.includes('saveAs') && !list.includes('copyFile'));
  ok('"delete from disk" stays hidden while the feature switch is off, as it is in production',
    !list.includes('deleteForever'));
  ok('and appears only when that switch is on',
    ids(CardActions.localSubject(removed, poolItem()), { physicalDelete: true }).includes('deleteForever'));
  ok('a removed FOLDER is never offered delete-from-disk, even with the switch on',
    !ids(CardActions.localSubject({ ...removed, type: 'folder' }, poolItem({ type: 'folder' })), { physicalDelete: true })
      .includes('deleteForever'));
}

// --- several cards at once (not in the UI yet, but the model must be ready) --
{
  const a = CardActions.internetSubject(wallhaven());
  const b = CardActions.internetSubject(wallhaven({ id: 'wh2', page: 'https://wallhaven.cc/w/def' }));
  const many = ids([a, b]);
  ok('actions that make sense for a whole selection survive it',
    many.includes('add') && many.includes('assign') && many.includes('saveAs'));
  ok('actions that only make sense for one card drop out of a selection',
    !many.includes('copyLink') && !many.includes('copyFile') && !many.includes('openSource'));

  // The rule that keeps a menu honest: an action offered for a selection must be valid
  // for every card in it, not for most of them.
  const mixed = ids([a, CardActions.cloudSubject(cloudCard())]);
  ok('mixing a card that can do something with one that cannot removes the action',
    !mixed.includes('openSource') && mixed.includes('saveAs'));

  const withFolder = ids([CardActions.localSubject({ path: 'C:/photos', type: 'folder' }), CardActions.localSubject({ path: 'C:/a.jpg', type: 'image' })]);
  ok('a folder in the selection removes the picture-only actions from all of it',
    !withFolder.includes('saveAs') && withFolder.includes('remove'));
}

// --- grouping, so the menu never draws a stray separator --------------------
{
  const groups = CardActions.menuGroupsFor(CardActions.cloudSubject(cloudCard()));
  ok('groups come back in menu order and none of them is empty',
    groups.length > 0 && groups.every((g) => g.length > 0));
  ok('the destructive group is last when it is present',
    CardActions.menuGroupsFor(CardActions.localSubject({ path: 'C:/a.jpg', type: 'image' }, poolItem()))
      .at(-1).every((a) => a.group === 'danger'));
  ok('a card with nothing to offer produces no groups at all, not one empty one',
    CardActions.menuGroupsFor(null).length === 0);
}

// --- the file boundary ------------------------------------------------------
{
  ok('every action that needs the picture says so, so main can route them all one way',
    ['add', 'assign', 'saveAs', 'copyFile'].every((id) => CardActions.actionById(id).needsFile === true));
  ok('and the ones that do not touch the file say that too',
    ['copyLink', 'openSource', 'tags', 'details', 'remove', 'restore']
      .every((id) => CardActions.actionById(id).needsFile === false));

  ok('"can we produce a file" is false for folders and for a card with no source at all',
    !CardActions.canProduceFile(CardActions.localSubject({ path: 'C:/x', type: 'folder' }))
    && !CardActions.canProduceFile(CardActions.internetSubject({ page: 'https://x/1' }))
    && !CardActions.canProduceFile(null));
  ok('and true for anything already on disk, whatever it came from',
    CardActions.canProduceFile(CardActions.internetSubject(wallhaven({ full: '' }), poolItem())));
}

// --- what main is told ------------------------------------------------------
{
  const wh = CardActions.descriptorFor(CardActions.internetSubject(wallhaven(), poolItem()));
  ok('an online descriptor carries the kind, the pool id and the provider item',
    wh.kind === 'internet' && wh.id === 'p1' && wh.item.page === 'https://wallhaven.cc/w/abc');

  const local = CardActions.descriptorFor(CardActions.localSubject({ path: 'C:/a.jpg', type: 'image', id: 'p9' }));
  ok('a local descriptor sends no provider item — main has the record already',
    local.kind === 'local' && local.id === 'p9' && local.item === null);
  // BUG-029. A photo shown out of a watched folder has no record and therefore no id, so
  // the path travels too. It is a CLAIM by the window: main honours it only if the
  // library already vouches for it, which is checked in test/media-path-authority.
  ok('a local descriptor also states the path, because a folder photo has no id',
    local.path === 'C:/a.jpg'
    && CardActions.descriptorFor(CardActions.localSubject({ path: 'C:/b.jpg', type: 'image' })).path === 'C:/b.jpg');
  ok('an online descriptor states no local path — it has none', wh.path === '');

  // The descriptor must not become a place where the renderer decides addresses:
  // main looks up or validates every URL. Keeping it to these four fields is the
  // enforcement — a path is not an address, and is checked before it is used.
  ok('a descriptor has exactly four fields and no URL of its own',
    JSON.stringify(Object.keys(wh).sort()) === JSON.stringify(['id', 'item', 'kind', 'path']));

  ok('rubbish produces no descriptor rather than a half-built one',
    CardActions.descriptorFor(null) === null && CardActions.descriptorFor({}) === null);
}

// --- DESIGN-004: a card that is PLACED in a monitor-and-theme spot -----------
{
  const spot = { monitorId: '\\\\?\\DISPLAY#1', theme: 'light', itemId: 'p1', index: 0 };
  const placed = CardActions.localSubject(
    { path: poolItem().path, type: 'image', id: 'p1', slot: spot }, poolItem(),
  );
  const loose = CardActions.localSubject({ path: poolItem().path, type: 'image', id: 'p1' }, poolItem());

  ok('a placed card can be taken out of its spot', ids(placed).includes('removeFromSlot'));
  ok('the same card in the library cannot — it is not placed anywhere',
    !ids(loose).includes('removeFromSlot'));
  // The owner's decision on 2026-09-03: keep both, do not shorten the menu.
  ok('taking it out of the spot does NOT replace removing it from the library',
    ids(placed).includes('remove') && ids(placed).includes('removeFromSlot'));
  ok('the narrower command is offered first, so the bigger one is never the default',
    ids(placed).indexOf('removeFromSlot') < ids(placed).indexOf('remove'));
  ok('a placed card keeps everything an ordinary local card has',
    ['assign', 'favorite', 'tags', 'details', 'saveAs', 'copyFile'].every((id) => ids(placed).includes(id)));
  // In the trash a card is not placed anywhere, and offering to unplace it would be a
  // second door back into the library — the class of bug LIB-006 already was.
  ok('a removed card is never offered it, placement or not', !ids(CardActions.localSubject(
    { path: poolItem().path, type: 'image', id: 'p1', slot: spot, removedView: true }, poolItem(),
  )).includes('removeFromSlot'));
  // One spot at a time: the strip has no multi-select, and "which of these spots"
  // would have no answer.
  ok('it is not offered for a selection of several cards',
    !ids([placed, placed]).includes('removeFromSlot'));

  // A half-filled placement is worse than none: it would offer to remove a picture from
  // a spot it cannot name, which is how the wrong one goes.
  ok('a placement missing the monitor, the theme or the item is refused',
    CardActions.placement({ theme: 'light', itemId: 'p1' }) === null
    && CardActions.placement({ monitorId: 'm', itemId: 'p1' }) === null
    && CardActions.placement({ monitorId: 'm', theme: 'light' }) === null
    && CardActions.placement({ monitorId: 'm', theme: 'sideways', itemId: 'p1' }) === null
    && CardActions.placement(null) === null && CardActions.placement('light') === null);
  ok('a placement without a usable index still stands — the index is only a hint',
    CardActions.placement({ monitorId: 'm', theme: 'dark', itemId: 'p1' }).index === -1
    && CardActions.placement({ monitorId: 'm', theme: 'dark', itemId: 'p1', index: 2.5 }).index === -1
    && CardActions.placement({ monitorId: 'm', theme: 'dark', itemId: 'p1', index: 3 }).index === 3);
  ok('an online card is never placed', CardActions.internetSubject(wallhaven()).slot === null);
}

// --- malformed input --------------------------------------------------------
{
  ok('rubbish in produces an empty list rather than a thrown error',
    ids(null).length === 0 && ids(undefined).length === 0
    && ids([]).length === 0 && ids([null, undefined]).length === 0);
  ok('an unknown action id is answered with null, not undefined behaviour',
    CardActions.actionById('nope') === null);
}

console.log('\nAll ' + passed + ' card-actions tests passed.');
