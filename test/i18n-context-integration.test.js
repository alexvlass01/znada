'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../src/i18n-context');

const ROOT = path.join(__dirname, '..');
const reference = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
const sources = C.DEFAULT_SOURCE_FILES.map((file) => ({
  file,
  content: fs.readFileSync(path.join(ROOT, ...file.split('/')), 'utf8'),
}));
const catalog = C.buildContextCatalog({ reference, sources });
let passed = 0;

function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  OK ${name}`);
  passed++;
}

function has(key, predicate) {
  return catalog.entries[key].contexts.some(predicate);
}

function withoutKey(dict, dottedKey) {
  const clone = JSON.parse(JSON.stringify(dict));
  const parts = dottedKey.split('.');
  const leaf = parts.pop();
  let cursor = clone;
  for (const part of parts) cursor = cursor[part];
  delete cursor[leaf];
  return clone;
}

ok('current catalog meets the stage-2 automatic context target',
  catalog.stats.total > 0 && catalog.stats.coveragePct >= 80);
ok('current production sources have no literal references missing from en.json',
  catalog.danglingReferences.length === 0);
ok('one key keeps both toolbar-button and native file-dialog contexts',
  has('library.addPhotos', (x) => x.type === 'button' && x.file === 'renderer/index.html')
  && has('library.addPhotos', (x) => x.type === 'dialog-title' && x.area === 'native-file-picker'));
ok('notification keys are derived from main-process title/body sinks',
  has('notify.wallpaperFailedTitle', (x) => x.type === 'notification-title' && x.file === 'main.js'));
ok('viewer and tray runtime files are part of the context boundary',
  has('viewer.close', (x) => x.file === 'renderer/viewer.js')
  && has('tray.open', (x) => x.file === 'src/tray.js' && x.type === 'menu-item'));
ok('dynamic rating and indexed tip families are expanded',
  has('online.ratingGeneral', (x) => x.via === 'dynamic-template')
  && has('smart.tips.0', (x) => x.via === 'collection-reference' && x.type === 'tip'));
ok('viewer add actions are classified as buttons, not high-confidence labels',
  has('online.add', (x) => x.file === 'renderer/viewer.js' && x.type === 'button')
  && !has('online.add', (x) => x.file === 'renderer/viewer.js'
    && x.type === 'label' && x.confidence === 'high'));
ok('function-name heuristics cannot move strongly namespaced keys to preferences',
  !has('design.monitorNoteSingle', (x) => x.area === 'preferences')
  && !has('online.nsfwNeedsKey', (x) => x.area === 'preferences'));
ok('object copy distinguishes card titles from descriptive details',
  has('home.automaticTheme', (x) => x.type === 'heading' && x.confidence === 'high')
  && has('home.manualChange', (x) => x.type === 'heading' && x.confidence === 'high')
  && has('home.everyMinutes', (x) => x.type === 'description' && x.confidence === 'high')
  && has('online.sourceLumina', (x) => x.type === 'heading' && x.confidence === 'high'));
ok('indirect, conditional, helper and dynamic references stay lint-visible', (() => {
  const required = [
    'library.emptyFolder',
    'details.copyFailed',
    'design.monitorNoteSingle',
    'viewer.fullscreen',
    'online.favAdd',
    'online.ratingGeneral',
    'journal.thumbs',
    'journal.themeSchedule',
  ];
  return required.every((key) => {
    const altered = C.buildContextCatalog({ reference: withoutKey(reference, key), sources });
    return altered.danglingReferences.includes(key);
  });
})());

console.log(
  `\nAll ${passed} i18n-context integration tests passed `
  + `(${catalog.stats.contextualized}/${catalog.stats.total}, ${catalog.stats.coveragePct}%).`,
);
