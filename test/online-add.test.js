'use strict';

// ONL-008: the Online tab's add button is a two-way control. These tests cover the
// decision behind it — "is this online card already in the library, and what does the
// button therefore do" — for BOTH card kinds, because the whole point of the module is
// that Znada Cloud cards and Internet cards ask the same question.

const assert = require('assert');
const OnlineAdd = require('../src/online-add');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

const record = (id, source, extra = {}) => ({
  id, type: 'image', path: `C:/Users/x/AppData/Roaming/znada/wallpapers/${id}-light.jpg`, source, ...extra,
});

// --- which pool record belongs to an online card ---------------------------
{
  const library = {
    a1: record('a1', 'znada:42'),
    b2: record('b2', 'lumina:77'),
    c3: record('c3', 'https://wallhaven.cc/w/abcdef'),
    d4: record('d4', ''),
    e5: { id: 'e5', type: 'image', path: 'C:/photos/local.jpg' },
  };

  ok('a Znada Cloud card downloaded now is found by its znada: marker',
    OnlineAdd.pooledItem(library, 'cloud', { id: '42' }) === library.a1);

  ok('a Znada Cloud card downloaded BEFORE the rename is still found by its lumina: marker',
    OnlineAdd.pooledItem(library, 'cloud', { id: '77' }) === library.b2);

  ok('a Znada Cloud card that was never downloaded is not found',
    OnlineAdd.pooledItem(library, 'cloud', { id: '999' }) === null);

  ok('an Internet card is found by the source page it was downloaded from',
    OnlineAdd.pooledItem(library, 'internet', { page: 'https://wallhaven.cc/w/abcdef' }) === library.c3);

  ok('an Internet card from a different page is not found',
    OnlineAdd.pooledItem(library, 'internet', { page: 'https://wallhaven.cc/w/zzzzzz' }) === null);

  // The trap: a record with no source and a card with no page both reduce to "" and
  // would match each other, marking an arbitrary local photo as "this one is downloaded".
  ok('a card with no source page never matches a record with an empty source',
    OnlineAdd.pooledItem(library, 'internet', { page: '' }) === null
    && OnlineAdd.pooledItem(library, 'internet', {}) === null);

  ok('a Cloud card with no id never matches anything',
    OnlineAdd.pooledItem(library, 'cloud', { id: '' }) === null
    && OnlineAdd.pooledItem(library, 'cloud', {}) === null);

  ok('a missing or malformed library answers "not added" instead of throwing',
    OnlineAdd.pooledItem(null, 'cloud', { id: '42' }) === null
    && OnlineAdd.pooledItem(undefined, 'internet', { page: 'https://x/1' }) === null);

  ok('a missing item answers "not added" instead of throwing',
    OnlineAdd.pooledItem(library, 'cloud', null) === null
    && OnlineAdd.pooledItem(library, 'internet', undefined) === null);

  // The grid refreshes every mounted card at once; it passes one prebuilt index rather
  // than walking the whole pool per card. Both routes must agree.
  const index = OnlineAdd.sourceIndex(library);
  ok('a prebuilt source index gives the same answer as the library object',
    OnlineAdd.pooledItem(index, 'cloud', { id: '42' }) === library.a1
    && OnlineAdd.pooledItem(index, 'internet', { page: 'https://wallhaven.cc/w/abcdef' }) === library.c3
    && OnlineAdd.pooledItem(index, 'cloud', { id: '999' }) === null);

  ok('records without a source stay out of the index entirely',
    !index.has('') && index.size === 3);
}

// --- the markers themselves ------------------------------------------------
{
  ok('a Cloud card is looked up under both the current and the pre-rename marker',
    JSON.stringify(OnlineAdd.sourceMarkers('cloud', { id: '5' })) === JSON.stringify(['znada:5', 'lumina:5']));
  ok('an Internet card is looked up under its page URL alone',
    JSON.stringify(OnlineAdd.sourceMarkers('internet', { page: 'https://x/1' })) === JSON.stringify(['https://x/1']));
  ok('a numeric Cloud id is accepted the same way a string one is',
    JSON.stringify(OnlineAdd.sourceMarkers('cloud', { id: 5 })) === JSON.stringify(['znada:5', 'lumina:5']));

  // Emptiness is guarded twice — the markers are empty AND the index refuses records
  // with no source. The pool test above only proved the second one: it went on passing
  // with the first removed. Both are pinned here, because the lookup also accepts an
  // index built elsewhere, where only this guard stands between "no source" and a match.
  ok('a card with no source yields no markers at all, so it cannot match by emptiness',
    OnlineAdd.sourceMarkers('internet', { page: '' }).length === 0
    && OnlineAdd.sourceMarkers('internet', {}).length === 0
    && OnlineAdd.sourceMarkers('cloud', { id: '' }).length === 0);

  const dirtyIndex = new Map([['', record('d4', '')]]);
  ok('even an index that does contain an empty source stays unreachable from a card without one',
    OnlineAdd.pooledItem(dirtyIndex, 'internet', { page: '' }) === null
    && OnlineAdd.pooledItem(dirtyIndex, 'cloud', {}) === null);
}

// --- what the button shows and does ----------------------------------------
{
  const library = { a1: record('a1', 'znada:42') };

  const off = OnlineAdd.buttonState(library, 'cloud', { id: '999' });
  ok('a photo that is not in the library offers to add it',
    off.added === false && off.action === 'add' && off.glyph === '+'
    && off.titleKey === 'online.add' && off.pooled === null);

  const on = OnlineAdd.buttonState(library, 'cloud', { id: '42' });
  ok('a photo that IS in the library offers to take it back out',
    on.added === true && on.action === 'remove' && on.glyph === '✓'
    && on.titleKey === 'online.remove' && on.pooled === library.a1);
}

// --- the removal payload ---------------------------------------------------
{
  const item = record('a1', 'znada:42');
  const payload = OnlineAdd.removalPayload(item);
  ok('removal names the pool record by id AND by path, the way the Library tab does',
    Array.isArray(payload) && payload.length === 1
    && payload[0].id === 'a1' && payload[0].path === item.path && payload[0].type === 'image');

  ok('a folder record keeps its type', OnlineAdd.removalPayload({ id: 'f', path: 'C:/f', type: 'folder' })[0].type === 'folder');
  ok('an unknown type falls back to image', OnlineAdd.removalPayload({ id: 'f', path: 'C:/f', type: 'weird' })[0].type === 'image');

  ok('nothing identifiable produces no payload at all, rather than a request that removes something else',
    OnlineAdd.removalPayload(null) === null
    && OnlineAdd.removalPayload({}) === null
    && OnlineAdd.removalPayload({ id: '', path: '' }) === null);
}

console.log('\nAll ' + passed + ' online-add tests passed.');
