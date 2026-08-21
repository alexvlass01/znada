'use strict';

const assert = require('assert');
const assignment = require('../src/library-assignment');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

function fresh() { return { library: {}, monitors: {} }; }

{
  const config = fresh();
  const before = JSON.stringify(config);
  const result = assignment.assignRecord(config,
    { path: 'C:\\gone.jpg', type: 'image' }, 'monitor-1', 'light');
  ok('a non-validated transient path fails without mutating pool or slots',
    !result.ok && result.error === 'missing_item' && JSON.stringify(config) === before);
}

{
  const slotIds = [];
  slotIds.includes = () => { throw new Error('batch must not linearly scan the growing slot'); };
  const config = {
    library: {},
    monitors: { 'monitor-1': { light: { itemIds: slotIds }, dark: { itemIds: [] } } },
  };
  const prepared = Array.from({ length: 200 }, (_, index) => ({
    record: { path: `C:\\wallpapers\\batch-${index}.jpg`, type: 'image' },
    options: { allowCreate: true },
  }));
  const result = assignment.assignRecords(config, prepared, 'monitor-1', 'light');
  ok('large batches use one Set instead of repeated linear slot includes',
    result.ok && result.assigned === 200 && slotIds.length === 200);
}

{
  const config = fresh();
  const result = assignment.assignRecords(config, [
    { record: { path: 'C:\\wallpapers\\a.jpg', type: 'image' }, options: { allowCreate: true } },
    { record: { path: 'C:\\wallpapers\\gone.jpg', type: 'image' } },
    { record: { path: 'C:\\wallpapers\\b.jpg', type: 'image' }, options: { allowCreate: true } },
  ], 'monitor-1', 'light');
  ok('a prepared batch mutates one shared slot and skips invalid records without pool orphans',
    result.ok && result.assigned === 2 && result.failed === 1
      && Object.keys(config.library).length === 2
      && config.monitors['monitor-1'].light.itemIds.length === 2);
  const repeated = assignment.assignRecords(config, [
    { record: { path: 'c:/wallpapers/a.jpg', type: 'image' }, options: { allowCreate: true } },
    { record: { path: 'c:/wallpapers/b.jpg', type: 'image' }, options: { allowCreate: true } },
  ], 'monitor-1', 'light');
  ok('a repeated batch reuses one slot-id Set and never duplicates assignments',
    repeated.ok && repeated.createdIds.length === 0
      && config.monitors['monitor-1'].light.itemIds.length === 2);
}

{
  const config = fresh();
  const result = assignment.assignRecord(config,
    { path: 'C:\\wallpapers\\a.jpg', type: 'image' }, 'monitor-1', 'dark',
    { allowCreate: true, extra: { addedAt: 123 } });
  ok('a validated transient path is materialized and assigned in one mutation',
    result.ok && result.created && config.library[result.id]
      && config.monitors['monitor-1'].dark.itemIds[0] === result.id);
  ok('transaction keeps supplied discovery metadata', config.library[result.id].addedAt === 123);

  const repeat = assignment.assignRecord(config,
    { path: 'c:/wallpapers/a.jpg', type: 'image' }, 'monitor-1', 'dark',
    { allowCreate: true });
  ok('a path-normalized repeat reuses the pool item and does not duplicate the slot',
    repeat.ok && !repeat.created && Object.keys(config.library).length === 1
      && config.monitors['monitor-1'].dark.itemIds.length === 1);
}

{
  const config = fresh();
  const created = assignment.assignRecord(config,
    { path: 'C:\\wallpapers', type: 'folder' }, 'monitor-1', 'light', { allowCreate: true });
  const byId = assignment.assignRecord(config,
    { id: created.id, path: 'C:\\untrusted-renderer-path', type: 'image' }, 'monitor-2', 'light');
  ok('an existing id uses the authoritative pool item instead of renderer path/type',
    byId.ok && !byId.created && byId.item.type === 'folder'
      && byId.item.path === 'C:\\wallpapers');
}

{
  const config = fresh();
  const before = JSON.stringify(config);
  const result = assignment.assignRecord(config,
    { path: 'C:\\wallpapers\\a.jpg', type: 'image' }, null, 'light', { allowCreate: true });
  ok('an invalid monitor is rejected before materialization',
    !result.ok && result.error === 'bad_request' && JSON.stringify(config) === before);
}

console.log('\nAll ' + passed + ' library-assignment tests passed.');
