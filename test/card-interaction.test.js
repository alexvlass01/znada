'use strict';

const assert = require('assert');
const CardInteraction = require('../renderer/card-interaction');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

const imageA = { key: 'local-image:c:/a.jpg', path: 'C:/a.jpg', type: 'image', id: null };
const imageB = { key: 'local-image:c:/b.jpg', path: 'C:/b.jpg', type: 'image', id: 'pool-b' };
const folder = { key: 'local-folder:c:/folder', path: 'C:/folder', type: 'folder', id: null };
const imageC = { key: 'local-image:c:/c.jpg', path: 'C:/c.jpg', type: 'image', id: 'pool-c' };
const ordered = [imageA, imageB, folder, imageC];

ok('Windows path case, slash style and trailing separators share one stable key',
  CardInteraction.localKey(' C:\\Wallpapers\\A.JPG\\ ', 'image')
    === CardInteraction.localKey('c:/wallpapers/a.jpg', 'image'));
ok('folder and image keys stay in separate namespaces',
  CardInteraction.localKey('C:\\Wallpapers', 'folder')
    !== CardInteraction.localKey('C:\\Wallpapers', 'image'));

{
  const selection = CardInteraction.createSelectionModel();
  selection.toggle(imageA, ordered, false);
  ok('a checkbox selects a transient image without modifiers', selection.has(imageA.key));
  selection.toggle(imageA, ordered, false);
  ok('clicking the same checkbox again deselects it', !selection.has(imageA.key));
}

{
  let materializeCalls = 0;
  const lazy = CardInteraction.createLazyPoolItem(null, async () => {
    materializeCalls += 1;
    return imageB;
  });
  ok('opening transient actions does not materialize the item',
    lazy.current() === null && materializeCalls === 0);
  Promise.all([lazy.ensure(), lazy.ensure()]).then(([first, second]) => {
    ok('the first committed action materializes exactly once, even when repeated concurrently',
      first === imageB && second === imageB && materializeCalls === 1);
    return lazy.ensure();
  }).then((again) => {
    ok('later committed actions reuse the materialized pool item',
      again === imageB && materializeCalls === 1);
    console.log('\nAll ' + passed + ' card-interaction tests passed.');
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

{
  const selection = CardInteraction.createSelectionModel();
  selection.toggle(imageA, ordered, false);
  selection.toggle(imageC, ordered, true);
  ok('Shift range uses the complete ordered model, including transient folders',
    selection.keys().join('|') === ordered.map((entry) => entry.key).join('|'));
  ok('the original range anchor remains stable after extending', selection.anchorKey === imageA.key);
}

{
  const selection = CardInteraction.createSelectionModel();
  selection.toggle(imageA, ordered, false);
  const materializedA = { ...imageA, id: 'pool-a' };
  selection.refresh(materializedA);
  ok('materialization keeps selection because the path key is unchanged', selection.has(imageA.key));
  ok('the selected record gains its pool id without a second selection action',
    selection.values()[0].id === 'pool-a');
  selection.delete(imageA.key);
  ok('removing the range anchor clears it for the next Shift selection',
    selection.anchorKey === null && selection.size === 0);
  selection.toggle(imageB, ordered, true);
  ok('Shift after an anchor removal starts a fresh selection',
    selection.anchorKey === imageB.key && selection.keys().join('|') === imageB.key);
  selection.clear();
  ok('clearing selection also clears the range anchor', selection.size === 0 && selection.anchorKey === null);
}

{
  const transient = CardInteraction.actionsFor(imageA);
  const persistent = CardInteraction.actionsFor(imageB);
  const transientFolder = CardInteraction.actionsFor(folder);
  // LIB-004: where a photo is stored no longer decides what the user may do with it.
  // Removal means "stop showing this in Lumina" and is offered for every card alike.
  ok('a photo shown straight from a watched folder can be removed too',
    transient.assign && transient.favorite && transient.tags && transient.remove);
  ok('persistent pool items expose remove', persistent.remove);
  // LIB-008: a subfolder the user navigated into is removable too. Removing it is
  // recorded against its path, so photos added to it later stay removed as well.
  ok('folder actions expose navigation and removal without requiring a pool id',
    transientFolder.open && transientFolder.assign && transientFolder.remove);
  ok('details are offered for transient, pool and folder records alike',
    transient.details && persistent.details && transientFolder.details);
  ok('details are withheld from an invalid record',
    !CardInteraction.actionsFor(null).details && !CardInteraction.actionsFor({}).details);
}
