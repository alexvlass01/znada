'use strict';

// META-002. The caption is the author, or the pixel size when there is no author.
// A filename is never invented here, and the Home row stays caption-less.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const caption = require('../src/card-caption');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; };

ok('author wins over a size', caption.text({ author: 'Ada', width: 1920, height: 1080 }) === 'Ada');
ok('artist is the author of an online card', caption.text({ artist: 'Bea', resolution: '800x600' }) === 'Bea');
ok('a blank author falls through to the artist',
  caption.text({ author: '   ', artist: 'Bea', width: 10, height: 10 }) === 'Bea');
ok('underscores in a site name stay as written', caption.text({ artist: 'artist_name' }) === 'artist_name');
ok('an author longer than 120 characters is cut there',
  caption.text({ author: 'a'.repeat(121) }) === 'a'.repeat(120));

ok('pixels become the caption when nobody is named',
  caption.text({ width: 1920, height: 1080 }) === '1920 × 1080');
ok('numeric strings are a size too', caption.text({ width: '1920', height: '1080' }) === '1920 × 1080');
ok('a resolution string is normalised to the same glyph',
  caption.text({ resolution: '1920x1080' }) === '1920 × 1080'
  && caption.text({ resolution: '1920 × 1080' }) === '1920 × 1080'
  && caption.text({ resolution: '1920X1080' }) === '1920 × 1080');

ok('zero, junk and an absurd size are not a caption',
  caption.text({ width: 0, height: 1080 }) === ''
  && caption.text({ width: -1, height: 1080 }) === ''
  && caption.text({ width: Infinity, height: 1080 }) === ''
  && caption.text({ width: 1000001, height: 10 }) === ''
  && caption.text({ resolution: '0x1080' }) === ''
  && caption.text({ resolution: 'photo.png' }) === ''
  && caption.text({ resolution: '1920x1080 extra' }) === '');
ok('a filename is never the caption',
  caption.text({ path: 'C:/wallpapers/wp-abc123.jpg', author: '' }) === '');
ok('nothing in, nothing out', caption.text(null) === '' && caption.text(undefined) === '');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const scriptAt = html.indexOf('<script src="../src/card-caption.js"></script>');
const rendererAt = html.indexOf('<script src="renderer.js"></script>');
ok('the window loads the caption before the renderer', scriptAt >= 0 && scriptAt < rendererAt);

const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');

// A whole top-level function, counted by braces. DESIGN-011 dropped the library
// card's native tooltip, so the caption is no longer written into card.title there.
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

const captionFns = [
  'renderStrip',
  'buildLibCard',
  'galleryItemFromLibrary',
  'galleryItemFromInternet',
  'buildInternetCard',
];
let captionUses = 0;
for (const name of captionFns) {
  const body = functionBody(renderer, name);
  const n = body.split('window.CardCaption.text').length - 1;
  ok(`${name} asks the caption once`, body.length > 0 && n === 1);
  captionUses += n;
}
const allCaptionUses = renderer.split('window.CardCaption.text').length - 1;
ok('the caption is asked only from those five labels', allCaptionUses === captionUses && captionUses === 5);
const homeAt = renderer.indexOf('function renderHomeRecentItems');
const home = renderer.slice(homeAt, renderer.indexOf('function layoutHomeRecentRow'));
ok('the Home row stays caption-less', homeAt >= 0 && !home.includes('CardCaption'));

console.log(`\n${passed} passed`);
