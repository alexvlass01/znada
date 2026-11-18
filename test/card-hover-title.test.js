'use strict';

// DESIGN-011. A photo card must not carry a native Windows tooltip. The library
// status line already says the name. Button tooltips stay. The Appearance strip
// has no status line, so its thumbnail title stays too.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8')
  .replace(/\r\n/g, '\n');

function functionBody(name) {
  const start = renderer.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = renderer.indexOf('{', renderer.indexOf(')', start));
  let depth = 0;
  for (let i = bodyStart; i < renderer.length; i++) {
    if (renderer[i] === '{') depth++;
    else if (renderer[i] === '}') {
      depth--;
      if (depth === 0) return renderer.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ✓ ' + name);
  passed++;
}

for (const name of [
  'buildLibCard', 'buildEphemeralImageCard', 'buildCloudCard', 'buildInternetCard',
  'fillFolderCollage', 'buildSubfolderCard',
]) {
  ok(`${name} sets no native card tooltip`, !functionBody(name).includes('card.title'));
}

const library = functionBody('buildLibCard');
ok('the library star keeps its tooltip', library.includes("fav.title = t('library.favorite')"));
ok('a pool folder reports its full path', library.includes("setLibStatus(it.type === 'folder' ? it.path"));
ok('a subfolder reports its full path', functionBody('buildSubfolderCard').includes('setLibStatus(f.path)'));
ok('a library photo still reports its caption or file name',
  library.includes('window.CardCaption.text(it)') && library.includes('baseName(it.path)'));

const folderPhoto = functionBody('buildEphemeralImageCard');
ok('a folder photo star keeps its tooltip', folderPhoto.includes("fav.title = t('library.favorite')"));
ok('a folder photo still reports its file name', folderPhoto.includes('setLibStatus(baseName(p))'));

const cloud = functionBody('buildCloudCard');
ok('a catalogue card keeps its name without a tooltip',
  cloud.includes("setAttribute('aria-label', label || t('online.sourceLumina'))")
  && cloud.includes("setLibStatus(label || t('online.sourceLumina'))"));

const site = functionBody('buildInternetCard');
ok('a site card keeps its name without a tooltip',
  site.includes("setAttribute('aria-label', label || t('online.source'))")
  && site.includes("setLibStatus(label || t('online.source'))"));

const strip = functionBody('renderStrip');
ok('the Appearance strip still names a folder', strip.includes('el.title = it.path'));
ok('the Appearance strip still names a photo',
  strip.includes('el.title = (window.CardCaption && window.CardCaption.text(it)) || baseName(it.path)'));

// MEDIA-002: a video there opens the player instead, so it names that instead.
ok('Home recently added keeps the assign hint',
  functionBody('renderHomeRecentItems').includes("card.title = isVideo ? t('video.openHint') : t('home.recentAssignHint')"));

console.log(`\n${passed} passed`);
