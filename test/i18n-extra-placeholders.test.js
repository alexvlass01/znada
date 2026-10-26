'use strict';

// I18N-004. Extra catalogues may lag behind en.json: a missing key, an empty string
// or a wrong type stays a warning. A string that is already translated has to carry
// the same placeholder names. Order may change. This runs the linter itself, so
// deleting the extra-language check or treating a gap as a hard error fails here.
//
// Run: node test/i18n-extra-placeholders.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { main, placeholderMismatches } = require('../scripts/lint-i18n');
const { makeTempDir } = require('./helpers/temp-dir');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); passed += 1; console.log('  OK ' + name); }
  catch (e) { failures.push({ name, e }); console.log('  FAIL ' + name); console.log(e && e.stack); }
}

const en = {
  greet: 'Hello {name}',
  count: '{n} photos',
  both: '{name} has {n}',
  nested: { line: 'City {city}' },
  tips: ['Keep {name}'],
  plain: 'No params',
};

function translated(text) {
  return {
    greet: 'Привіт {name}',
    count: '{n} фото',
    both: '{n} і {name}',
    nested: { line: 'Місто {city}' },
    tips: ['Тримай {name}'],
    plain: 'Без',
    ...text,
  };
}

ok('a missing key is not a placeholder error', () => {
  assert.deepStrictEqual(placeholderMismatches(en, { greet: 'Привіт {name}' }), []);
});

ok('an empty string and a wrong type stay incomplete', () => {
  assert.deepStrictEqual(placeholderMismatches(en, { greet: '', count: { n: 1 } }), []);
});

ok('placeholder order may change', () => {
  assert.deepStrictEqual(
    placeholderMismatches({ both: '{name} has {n}' }, { both: '{n} — {name}' }),
    [],
  );
});

ok('a typo, a dropped name and an extra name are mismatches', () => {
  const found = placeholderMismatches(
    { greet: 'Hello {name}', count: '{n} photos', plain: 'No params' },
    { greet: 'Привіт {nmae}', count: 'фото', plain: 'Без {name}' },
  );
  assert.deepStrictEqual(found.map((item) => item.keyPath), ['greet', 'count', 'plain']);
  assert.strictEqual(found[0].expected, 'name');
  assert.strictEqual(found[0].got, 'nmae');
});

ok('nested objects and arrays keep the key path', () => {
  const found = placeholderMismatches(en, translated({
    nested: { line: 'Місто' },
    tips: ['Без імені'],
  }));
  assert.deepStrictEqual(found.map((item) => item.keyPath), ['nested.line', 'tips.0']);
});

function writeJson(dir, name, data) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
}

function runFixture(uk) {
  const dir = makeTempDir('i18n-004-');
  writeJson(dir, 'en.json', en);
  writeJson(dir, 'ru.json', translated());
  writeJson(dir, 'uk.json', uk);
  const lines = [];
  const errors = [];
  try {
    const code = main({
      localesDir: dir,
      checkReferences: false,
      log: (line) => lines.push(String(line)),
      error: (line) => errors.push(String(line)),
    });
    return { code, lines, errors };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

ok('a missing extra-language key stays a warning and the lint passes', () => {
  const uk = translated();
  delete uk.plain;
  const result = runFixture(uk);
  assert.strictEqual(result.code, 0, result.errors.join('\n'));
  assert.ok(result.lines.some((line) => /uk\.json/.test(line) && /1 missing keys/.test(line)));
  assert.ok(!result.errors.some((line) => /Parameter mismatch/.test(line)));
});

ok('an empty extra-language string stays a warning and the lint passes', () => {
  const result = runFixture(translated({ count: '' }));
  assert.strictEqual(result.code, 0, result.errors.join('\n'));
  assert.ok(result.lines.some((line) => /1 missing keys/.test(line)));
});

ok('a coverage warning does not call the file safe when a placeholder is wrong', () => {
  const uk = translated({ greet: 'Привіт {nmae}' });
  delete uk.plain;
  const result = runFixture(uk);
  assert.strictEqual(result.code, 1);
  const warning = result.lines.find((line) => /uk\.json/.test(line) && /missing keys/.test(line));
  assert.ok(warning, result.lines.join('\n'));
  assert.ok(!/not blocking/.test(warning), warning);
});

ok('a mistyped placeholder in an extra language fails the lint', () => {
  const result = runFixture(translated({ greet: 'Привіт {nmae}' }));
  assert.strictEqual(result.code, 1);
  assert.ok(result.errors.some((line) => (
    /uk\.json/.test(line)
    && /Parameter mismatch for "greet"/.test(line)
    && /expected params: \{name\}/.test(line)
    && /got: \{nmae\}/.test(line)
  )), result.errors.join('\n'));
});

ok('the default run still rejects a catalogue that drops keys the app uses', () => {
  const dir = makeTempDir('i18n-004-refs-');
  writeJson(dir, 'en.json', { unused: 'x' });
  writeJson(dir, 'ru.json', { unused: 'x' });
  const errors = [];
  try {
    const code = main({
      localesDir: dir,
      log: () => {},
      error: (line) => errors.push(String(line)),
    });
    assert.strictEqual(code, 1);
    assert.ok(
      errors.some((line) => line.includes('используется в production-коде')),
      errors.join('\n'),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

ok('the real catalogues still pass, including every extra language', () => {
  const lines = [];
  const errors = [];
  const code = main({
    localesDir: path.join(ROOT, 'locales'),
    log: (line) => lines.push(String(line)),
    error: (line) => errors.push(String(line)),
  });
  assert.strictEqual(code, 0, errors.join('\n'));
  assert.ok(lines.some((line) => line.startsWith('All core i18n translation files are in sync')));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
