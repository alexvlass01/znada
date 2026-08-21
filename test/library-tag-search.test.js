'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8'));
const ru = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'ru.json'), 'utf8'));
const uk = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'uk.json'), 'utf8'));
const contexts = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'context', 'generated.json'), 'utf8'));
const manualContexts = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'context', 'manual.json'), 'utf8'));

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed++;
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const filterTags = vm.runInNewContext(`(${functionSource(renderer, 'filterLibRailTags')})`);
const tags = ['architecture', 'Nature', 'space art'];

ok('empty query preserves the complete sorted input', JSON.stringify(filterTags(tags, '')) === JSON.stringify(tags));
ok('query is trimmed and case-insensitive', JSON.stringify(filterTags(tags, '  NAT  ')) === JSON.stringify(['Nature']));
ok('query matches inside a multi-word tag', JSON.stringify(filterTags(tags, 'art')) === JSON.stringify(['space art']));
ok('zero-result query returns an empty list', filterTags(tags, 'portrait').length === 0);
ok('filtering never mutates the source tag list', JSON.stringify(tags) === JSON.stringify(['architecture', 'Nature', 'space art']));

const sectionAt = html.indexOf('id="libTagSection"');
const searchAt = html.indexOf('id="libTagSearch"');
const listAt = html.indexOf('id="libTags"');
const emptyAt = html.indexOf('id="libTagEmpty"');
ok('tag search is a static control before the dynamic result list', sectionAt >= 0 && sectionAt < searchAt && searchAt < listAt && listAt < emptyAt);
ok('tag search has separate semantics from the card search', html.includes('data-i18n-ph="library.tagSearchPh"') && html.includes('data-i18n="library.noTagsFound"'));
ok('tag search exposes its result list to assistive technology', html.includes('aria-controls="libTags"'));

const renderTags = functionSource(renderer, 'renderLibRailTags');
ok('active tag validity is checked against all tags', /LIB\.filter\.startsWith\('tag:'\)[\s\S]*tags\.includes\(LIB\.filter\.slice\(4\)\)/.test(renderTags));
ok('query creates a separate matches list', /const matches = filterLibRailTags\(tags, LIB\.tagQuery\)/.test(renderTags));

const listenerStart = renderer.indexOf("const tagSearchEl = $('#libTagSearch')");
const listenerEnd = renderer.indexOf("const refreshBtn = $('#libRefresh')", listenerStart);
const listener = renderer.slice(listenerStart, listenerEnd);
ok('typing rerenders only rail tags', listenerStart >= 0 && listener.includes('renderLibRailTags()') && !listener.includes('renderLibrary()'));
ok('typing never substitutes the card filename query', !listener.includes('LIB.q'));
ok('tag query is not part of the card-grid render identity', !functionSource(renderer, 'libRenderKey').includes('tagQuery'));

ok('nested tag section can shrink inside the sticky rail', /\.lib-tags-section\s*\{[^}]*flex:[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s.test(css));
ok('only the tag result list owns vertical scrolling', /\.lib-railtags\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s.test(css));
ok('compact rail search is bounded at narrow widths', /\.lib-tag-searchbox\s*\{[^}]*width:\s*calc\(100% - 8px\)[^}]*min-width:\s*0/s.test(css) && css.includes('flex-basis: 156px'));

ok('reference locales distinguish tag search from card search',
  en.library.tagSearchPh === 'Search tags'
  && ru.library.tagSearchPh === 'Поиск тегов');
ok('Ukrainian locale translates tag search separately from card search',
  uk.library.tagSearchPh === 'Пошук тегів');
ok('reference locales include a zero-result explanation',
  en.library.noTagsFound === 'No matching tags'
  && ru.library.noTagsFound === 'Подходящие теги не найдены');
ok('Ukrainian locale translates the zero-result explanation',
  uk.library.noTagsFound === 'Відповідних тегів не знайдено');
ok('generated semantic context records placeholder and empty-state roles',
  contexts.entries['library.tagSearchPh']
  && contexts.entries['library.noTagsFound']
  && contexts.entries['library.tagSearchPh'].contexts.some((x) => x.type === 'placeholder' && x.area === 'library')
  && contexts.entries['library.noTagsFound'].contexts.some((x) => x.area === 'library'));
ok('manual semantic context distinguishes the rail filter from the card grid',
  manualContexts.keys['library.tagSearchPh']?.note.includes('Не ищет карточки')
  && manualContexts.keys['library.noTagsFound']?.note.includes('сетка карточек'));

console.log(`\nAll ${passed} library tag-search tests passed.`);
