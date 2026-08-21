'use strict';

const assert = require('assert');
const J = require('../renderer/justified-layout');

let passed = 0;
const ok = (name, condition) => { assert.ok(condition, name); console.log('  ✓ ' + name); passed++; };
const near = (a, b, epsilon = 0.01) => Math.abs(a - b) <= epsilon;

ok('normalizeAspect: uses fallback and clamps extremes',
  J.normalizeAspect(null) === 1.6
  && J.normalizeAspect(0.1) === 0.5
  && J.normalizeAspect(8) === 3);

const full = J.layout([1.5, 1.5, 1.5, 1.5], 1000, { gap: 10, targetHeight: 200 });
ok('complete row fills the available width',
  near(full.slice(0, 3).reduce((sum, box) => sum + box.width, 0) + 20, 1000));
ok('row break chooses the height closest to target',
  near(full[0].height, full[2].height)
  && Math.abs(full[0].height - 200) < Math.abs(161.67 - 200)
  && near(full[3].height, 200));
ok('layout preserves source aspect ratios', full.every((box) => near(box.width / box.height, 1.5)));

const last = J.layout([1.5, 1.5], 1000, { gap: 10, targetHeight: 200 });
ok('incomplete final row keeps target height instead of stretching',
  last.every((box) => near(box.height, 200))
  && last.reduce((sum, box) => sum + box.width, 0) + 10 < 1000);

const mixed = J.layout([0.2, 1, 6], 620, { gap: 10, targetHeight: 150 });
ok('extreme portraits and panoramas are capped without overflow',
  mixed.length === 3
  && near(mixed[0].width / mixed[0].height, 0.5)
  && near(mixed[2].width / mixed[2].height, 3)
  && mixed.reduce((sum, box) => sum + box.width, 0) + 20 <= 620.01);

ok('empty input returns no boxes', J.layout([], 500).length === 0);

// A 562px container used to produce three serialized widths whose sum was 562.01px.
// Flexbox then wrapped the third card even though the layout model kept it in row one,
// breaking both visual width and virtual scroll geometry.
const cssSafe = J.layoutRows(new Array(20).fill(1.6), 562, { gap: 10, targetHeight: 142 });
ok('CSS-rounded complete rows never overflow and wrap their final card',
  cssSafe.rows.slice(0, -1).every((row) => {
    const serializedWidth = cssSafe.boxes.slice(row.start, row.end)
      .reduce((sum, box) => sum + Number(box.width.toFixed(2)), 0)
      + 10 * (row.end - row.start - 1);
    return serializedWidth <= 562 && 562 - serializedWidth < 0.05;
  }));

// --- layoutRows: row geometry for the virtualized grid ---
const rich = J.layoutRows([1.5, 1.5, 1.5, 1.5], 1000, { gap: 10, targetHeight: 200 });
ok('layoutRows returns the same boxes as layout', rich.boxes.length === 4
  && rich.boxes.every((box, i) => near(box.width, full[i].width) && near(box.height, full[i].height)));
ok('rows partition the boxes without gaps or overlap', rich.rows.length === 2
  && rich.rows[0].start === 0 && rich.rows[0].end === 3
  && rich.rows[1].start === 3 && rich.rows[1].end === 4);
ok('row tops are cumulative heights plus gaps',
  rich.rows[0].top === 0 && near(rich.rows[1].top, rich.rows[0].height + 10));
ok('totalHeight covers all rows and inner gaps',
  near(rich.totalHeight, rich.rows[0].height + 10 + rich.rows[1].height));
ok('every box height matches its row height', rich.rows.every((row) => {
  for (let i = row.start; i < row.end; i++) if (!near(rich.boxes[i].height, row.height)) return false;
  return true;
}));
const emptyRows = J.layoutRows([], 500);
ok('layoutRows on empty input yields no rows and zero height',
  emptyRows.rows.length === 0 && emptyRows.totalHeight === 0 && emptyRows.boxes.length === 0);

console.log('\nAll ' + passed + ' justified-layout tests passed.');
