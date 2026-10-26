'use strict';

// I18N-003. A count picks a CLDR sibling key. Both windows call renderer/plural.js;
// a language without those siblings keeps its own unsuffixed string, not English.
//
// Run: node test/plural.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const plural = require('../renderer/plural');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];

function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  OK ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name);
  }
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function readJson(relative) {
  return JSON.parse(read(relative));
}

function leaf(dict, key) {
  return key.split('.').reduce((node, part) => (node ? node[part] : undefined), dict);
}

function placeholders(text) {
  return Array.from(String(text).matchAll(/\{([A-Za-z0-9_]+)\}/g), (match) => match[1]).sort();
}

const en = readJson('locales/en.json');
const ru = readJson('locales/ru.json');

const FORMS = {
  library: {
    photosCount: 'BASE',
    photosCount_one: 'ONE',
    photosCount_few: 'FEW',
    photosCount_many: 'MANY',
    photosCount_other: 'OTHER',
  },
};
const ENGLISH_FORMS = {
  library: {
    photosCount: 'EN-BASE',
    photosCount_one: 'EN-ONE',
    photosCount_few: 'EN-FEW',
    photosCount_many: 'EN-MANY',
    photosCount_other: 'EN-OTHER',
  },
};

ok('russian integers select one, few, many', () => {
  const want = { 0: 'MANY', 1: 'ONE', 2: 'FEW', 5: 'MANY', 11: 'MANY', 21: 'ONE', 22: 'FEW', 25: 'MANY' };
  for (const [n, label] of Object.entries(want)) {
    assert.strictEqual(
      plural.templateFor('library.photosCount', { n: Number(n) }, FORMS, ENGLISH_FORMS, 'ru'),
      label,
      'ru ' + n,
    );
  }
});

ok('english integers select one and other', () => {
  assert.strictEqual(plural.templateFor('library.photosCount', { n: 1 }, ENGLISH_FORMS, ENGLISH_FORMS, 'en'), 'EN-ONE');
  assert.strictEqual(plural.templateFor('library.photosCount', { n: 2 }, ENGLISH_FORMS, ENGLISH_FORMS, 'en'), 'EN-OTHER');
  assert.strictEqual(plural.templateFor('library.photosCount', { n: 0 }, ENGLISH_FORMS, ENGLISH_FORMS, 'en'), 'EN-OTHER');
});

ok('a language without sibling keys keeps its own string', () => {
  const german = { library: { photosCount: '{n} Fotos' } };
  assert.strictEqual(plural.templateFor('library.photosCount', { n: 1 }, german, ENGLISH_FORMS, 'de'), '{n} Fotos');
  assert.strictEqual(plural.templateFor('library.photosCount', { n: 5 }, german, ENGLISH_FORMS, 'de'), '{n} Fotos');
});

ok('a missing catalogue falls through to the english category, then the english string', () => {
  assert.strictEqual(plural.templateFor('library.photosCount', { n: 2 }, {}, ENGLISH_FORMS, 'pl'), 'EN-OTHER');
  const englishBaseOnly = { library: { photosCount: 'EN-BASE' } };
  assert.strictEqual(plural.templateFor('library.photosCount', { n: 2 }, {}, englishBaseOnly, 'pl'), 'EN-BASE');
});

ok('a missing category uses _other of the current language before the unsuffixed key', () => {
  const partial = { library: { photosCount: 'BASE', photosCount_other: 'OTHER' } };
  assert.strictEqual(plural.templateFor('library.photosCount', { n: 1 }, partial, ENGLISH_FORMS, 'en'), 'OTHER');
});

ok('a fraction or a non-number keeps the unsuffixed string', () => {
  for (const n of [1.5, '1', '5', NaN, Infinity, null, true]) {
    assert.strictEqual(
      plural.templateFor('library.photosCount', { n }, FORMS, ENGLISH_FORMS, 'ru'),
      'BASE',
      'n=' + String(n),
    );
  }
  assert.strictEqual(plural.templateFor('library.photosCount', {}, FORMS, ENGLISH_FORMS, 'ru'), 'BASE');
  assert.strictEqual(plural.templateFor('library.photosCount', null, FORMS, ENGLISH_FORMS, 'ru'), 'BASE');
  // n is present and not an integer, so a usable count beside it does not take over.
  const counted = {
    mediaFolder: {
      confirmBody: 'BASE {count}',
      confirmBody_one: 'ONE {count}',
      confirmBody_other: 'OTHER {count}',
    },
  };
  assert.strictEqual(
    plural.templateFor('mediaFolder.confirmBody', { n: 1.5, count: 2 }, counted, counted, 'en'),
    'BASE {count}',
  );
});

ok('count selects a form only when the string uses {count}', () => {
  assert.strictEqual(plural.templateFor('library.photosCount', { count: 1 }, FORMS, ENGLISH_FORMS, 'en'), 'BASE');
  const counted = {
    mediaFolder: {
      confirmBody: 'BASE {count}',
      confirmBody_one: 'ONE {count}',
      confirmBody_other: 'OTHER {count}',
    },
  };
  assert.strictEqual(plural.templateFor('mediaFolder.confirmBody', { count: 1 }, counted, counted, 'en'), 'ONE {count}');
  assert.strictEqual(plural.templateFor('mediaFolder.confirmBody', { count: 2 }, counted, counted, 'en'), 'OTHER {count}');
  assert.strictEqual(plural.templateFor('mediaFolder.confirmBody', { count: 1.5 }, counted, counted, 'en'), 'BASE {count}');
});

ok('an unknown language tag does not replace the current string with english', () => {
  const german = { library: { photosCount: '{n} Fotos' } };
  assert.strictEqual(
    plural.templateFor('library.photosCount', { n: 1 }, german, ENGLISH_FORMS, 'not a language'),
    '{n} Fotos',
  );
});

ok('the catalogues agree, and the counted sentences actually change', () => {
  const bases = [
    'library.photosCount',
    'library.assignedAdded',
    'card.lookupAdded',
    'library.deleteForeverMessage',
    'library.removeConfirmMessage',
    'mediaFolder.confirmBody',
    'mediaFolder.doneBody',
  ];
  for (const base of bases) {
    const enBase = leaf(en, base);
    const ruBase = leaf(ru, base);
    assert.strictEqual(typeof enBase, 'string', base);
    assert.strictEqual(typeof ruBase, 'string', base);
    for (const suffix of ['_one', '_few', '_many', '_other']) {
      const enForm = leaf(en, base + suffix);
      const ruForm = leaf(ru, base + suffix);
      assert.strictEqual(typeof enForm, 'string', base + suffix);
      assert.strictEqual(typeof ruForm, 'string', base + suffix);
      assert.deepStrictEqual(placeholders(enForm), placeholders(enBase), 'en ' + base + suffix);
      assert.deepStrictEqual(placeholders(ruForm), placeholders(ruBase), 'ru ' + base + suffix);
    }
  }
  assert.strictEqual(plural.format('library.photosCount', { n: 1 }, en, en, 'en'), '1 photo');
  assert.strictEqual(plural.format('library.photosCount', { n: 2 }, en, en, 'en'), '2 photos');
  assert.strictEqual(plural.format('library.photosCount', { n: 1 }, ru, en, 'ru'), '1 фото');
  assert.strictEqual(plural.format('library.photosCount', { n: 5 }, ru, en, 'ru'), '5 фото');
  const russianFiles = {
    1: 'Удалить с диска 1 файл?',
    2: 'Удалить с диска 2 файла?',
    5: 'Удалить с диска 5 файлов?',
    11: 'Удалить с диска 11 файлов?',
    21: 'Удалить с диска 21 файл?',
    22: 'Удалить с диска 22 файла?',
    25: 'Удалить с диска 25 файлов?',
  };
  for (const [n, text] of Object.entries(russianFiles)) {
    assert.strictEqual(plural.format('library.deleteForeverMessage', { n: Number(n) }, ru, en, 'ru'), text);
  }
  assert.strictEqual(plural.format('library.selected', { n: 1 }, en, en, 'en'), 'Selected: 1');
  assert.strictEqual(plural.format('library.selected', { n: 5 }, ru, en, 'ru'), 'Выбрано: 5');
  assert.strictEqual(
    plural.format('mediaFolder.doneBody', { count: 1, path: 'D:\\Znada' }, en, en, 'en'),
    '1 file is now in D:\\Znada. The old folder is cleared.',
  );
  assert.strictEqual(
    plural.format('card.lookupAdded', { n: 2 }, ru, en, 'ru'),
    'Нашлось — добавлено 2 тега',
  );
});

ok('the other 28 catalogues have a form for every counted integer', () => {
  // I18N-005. Same 28 keys as en. A category the language does not use repeats
  // its own _other text, so the string is never empty and never English by accident.
  // Arabic zero/two and Hebrew two are real Intl categories, but en has no _zero/_two
  // key: templateFor falls through to _other. That limit is recorded on the PR.
  const langs = fs.readdirSync(path.join(ROOT, 'locales'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .filter((lang) => lang !== 'en' && lang !== 'ru')
    .sort();
  assert.deepStrictEqual(langs, [
    'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'fi', 'fr', 'he', 'hi', 'hu',
    'id', 'it', 'ja', 'ko', 'nl', 'no', 'pl', 'pt', 'ro', 'sk', 'sv', 'th',
    'tr', 'uk', 'vi', 'zh',
  ]);
  const numbers = [0, 1, 2, 3, 5, 11, 21, 22, 101];
  const bases = [
    'library.photosCount',
    'library.assignedAdded',
    'card.lookupAdded',
    'library.deleteForeverMessage',
    'library.removeConfirmMessage',
    'mediaFolder.confirmBody',
    'mediaFolder.doneBody',
  ];
  for (const lang of langs) {
    const dict = readJson('locales/' + lang + '.json');
    const rules = new Intl.PluralRules(lang);
    const categories = new Set(rules.resolvedOptions().pluralCategories);
    for (const base of bases) {
      const enBase = leaf(en, base);
      assert.strictEqual(typeof leaf(dict, base), 'string', lang + ' kept ' + base);
      const other = leaf(dict, base + '_other');
      assert.strictEqual(typeof other, 'string', lang + ' ' + base + '_other');
      assert.ok(other.trim(), lang + ' empty ' + base + '_other');
      for (const suffix of ['one', 'few', 'many', 'other']) {
        const form = leaf(dict, base + '_' + suffix);
        assert.strictEqual(typeof form, 'string', lang + ' missing ' + base + '_' + suffix);
        assert.ok(form.trim(), lang + ' empty ' + base + '_' + suffix);
        assert.deepStrictEqual(placeholders(form), placeholders(enBase), lang + ' ' + base + '_' + suffix);
        if (!categories.has(suffix)) {
          assert.strictEqual(form, other, lang + ' unused ' + base + '_' + suffix + ' must repeat _other');
        }
      }
      assert.strictEqual(leaf(dict, base + '_zero'), undefined, lang + ' must not add _zero');
      assert.strictEqual(leaf(dict, base + '_two'), undefined, lang + ' must not add _two');
    }
    for (const n of numbers) {
      for (const base of bases) {
        const enBase = leaf(en, base);
        const params = enBase.includes('{count}')
          ? { count: n, size: '1 MB', path: 'C:\\Znada' }
          : { n };
        const got = plural.templateFor(base, params, dict, en, lang);
        assert.strictEqual(typeof got, 'string', lang + ' ' + n + ' ' + base);
        assert.ok(got.trim(), lang + ' blank ' + n + ' ' + base);
        assert.deepStrictEqual(placeholders(got), placeholders(enBase), lang + ' ' + n + ' ' + base);
        const category = rules.select(n);
        const own = leaf(dict, base + '_' + category);
        const expected = typeof own === 'string' ? own : leaf(dict, base + '_other');
        assert.strictEqual(got, expected, lang + ' ' + base + ' n=' + n + ' category=' + category);
      }
    }
  }
});

ok('both windows call the shared function and load it first', () => {
  for (const file of ['renderer/renderer.js', 'renderer/viewer.js']) {
    const source = read(file);
    assert.ok(source.includes('ZnadaPlural.format('), file + ' does not call ZnadaPlural.format');
    assert.ok(!source.includes('Intl.PluralRules'), file + ' has its own plural rules');
  }
  const index = read('renderer/index.html');
  const viewer = read('renderer/viewer.html');
  const pluralTag = '<script src="plural.js"></script>';
  assert.ok(index.indexOf(pluralTag) >= 0 && index.indexOf(pluralTag) < index.indexOf('<script src="renderer.js"></script>'));
  assert.ok(viewer.indexOf(pluralTag) >= 0 && viewer.indexOf(pluralTag) < viewer.indexOf('<script src="viewer.js"></script>'));
});

if (failures.length) {
  console.log('\n' + failures.length + ' test(s) failed.');
  for (const failure of failures) console.log('\n--- ' + failure.name + ' ---\n' + (failure.err && failure.err.stack));
  process.exit(1);
}
console.log('\nAll ' + passed + ' plural tests passed.');
