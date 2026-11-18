'use strict';

// DESIGN-012: дата выхода и «Что нового» в «О программе».
//
// Проверяется не вёрстка, а обещания: дату показывает только официальная сборка и только
// своей версии; окно говорит на языке интерфейса, а без перевода — по-английски, но не
// ломается и не пустеет; сборка и её проверка согласны, у кого метка есть, а у кого нет.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const whatsNew = require('../src/whats-new');
const { makeTempDir } = require('./helpers/temp-dir');
const { buildPackagerArgs, writeReleaseStamp } = require('../scripts/package-app');
const { verifyExternalResources } = require('../scripts/verify-thumbnail-package');

const ROOT = path.join(__dirname, '..');
let passed = 0;

function ok(name, fn) {
  fn();
  console.log(`  OK ${name}`);
  passed++;
}

const item = (title) => ({ title, text: title + ' text' });

ok('the shipped What\'s new file is valid and every entry has en and ru', () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'whats-new.json'), 'utf8'));
  assert.deepStrictEqual(whatsNew.validate(data), []);
  for (const version of Object.keys(data)) assert.deepStrictEqual(whatsNew.versionGaps(data, version), [], version);
});

ok('validate names a broken file instead of accepting it', () => {
  assert.ok(whatsNew.validate(null).length);
  assert.ok(whatsNew.validate({ 'next': { en: [item('a')] } }).some((p) => /не номер версии/.test(p)));
  assert.ok(whatsNew.validate({ '1.0.0': { en: [] } }).some((p) => /пустой список/.test(p)));
  assert.ok(whatsNew.validate({ '1.0.0': { en: [{ title: 'a', text: ' ' }] } }).some((p) => /title и text/.test(p)));
});

ok('versionGaps requires an entry with both reference languages', () => {
  assert.deepStrictEqual(whatsNew.versionGaps({}, '1.8.0'), ['нет записи 1.8.0']);
  assert.deepStrictEqual(whatsNew.versionGaps({ '1.8.0': { en: [item('a')] } }, '1.8.0'),
    ['нет текста 1.8.0 на языке ru']);
  assert.deepStrictEqual(whatsNew.versionGaps({ '1.8.0': { en: [item('a')], ru: [item('б')] } }, '1.8.0'), []);
});

ok('pick speaks the interface language and falls back to English, never to nothing', () => {
  const data = { '1.8.0': { en: [item('en')], ru: [item('ru')], uk: [item('uk')] } };
  assert.deepStrictEqual(whatsNew.pick(data, '1.8.0', 'uk'), { lang: 'uk', items: [item('uk')] });
  assert.deepStrictEqual(whatsNew.pick(data, '1.8.0', 'de'), { lang: 'en', items: [item('en')] });
  assert.deepStrictEqual(whatsNew.pick(data, '1.8.0', undefined), { lang: 'en', items: [item('en')] });
  // Another version's notes are never shown under this number.
  assert.strictEqual(whatsNew.pick(data, '1.7.7', 'ru'), null);
  assert.strictEqual(whatsNew.pick(null, '1.8.0', 'ru'), null);
  // A broken item is dropped, a language with nothing usable falls through to English.
  const messy = { '1.8.0': { en: [item('en'), { title: 'x' }], ru: [{ text: 'no title' }] } };
  assert.deepStrictEqual(whatsNew.pick(messy, '1.8.0', 'ru'), { lang: 'en', items: [item('en')] });
});

ok('a stamp gives a date only for its own version and a real day', () => {
  assert.strictEqual(whatsNew.stampDate('{"version":"1.8.0","date":"2026-10-30"}', '1.8.0'), '2026-10-30');
  assert.strictEqual(whatsNew.stampDate({ version: '1.8.0', date: '2026-10-30' }, '1.8.0'), '2026-10-30');
  assert.strictEqual(whatsNew.stampDate('{"version":"1.7.7","date":"2026-10-10"}', '1.8.0'), null);
  assert.strictEqual(whatsNew.stampDate('{"version":"1.8.0","date":"2026-02-30"}', '1.8.0'), null);
  assert.strictEqual(whatsNew.stampDate('{"version":"1.8.0","date":"30.10.2026"}', '1.8.0'), null);
  assert.strictEqual(whatsNew.stampDate('not json', '1.8.0'), null);
  assert.strictEqual(whatsNew.stampDate(null, '1.8.0'), null);
});

ok('makeStamp records the local calendar day of the build', () => {
  assert.deepStrictEqual(whatsNew.makeStamp('1.8.0', new Date(2026, 0, 5, 23, 59)), { version: '1.8.0', date: '2026-01-05' });
});

ok('formatDate writes the date in the interface language and nothing for no date', () => {
  assert.strictEqual(whatsNew.formatDate('2026-10-10', 'en'), 'October 10, 2026');
  assert.match(whatsNew.formatDate('2026-10-10', 'ru'), /^10 октября 2026/);
  assert.strictEqual(whatsNew.formatDate(null, 'ru'), '');
  assert.strictEqual(whatsNew.formatDate('2026-13-01', 'ru'), '');
  assert.strictEqual(whatsNew.formatDate('2026-10-10', 'not a locale!'), 'October 10, 2026');
});

ok('only the official build carries the stamp, and it is written before packaging', () => {
  const stampArg = `--extra-resource=.build/${whatsNew.STAMP_FILE}`;
  assert.ok(buildPackagerArgs({ official: true }).includes(stampArg));
  assert.ok(!buildPackagerArgs({ official: false }).includes(stampArg));

  const root = makeTempDir('whats-new-stamp-');
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.8.0' }));
    const file = writeReleaseStamp(root, new Date(2026, 9, 30, 12));
    assert.strictEqual(file, path.join(root, '.build', whatsNew.STAMP_FILE));
    assert.strictEqual(whatsNew.stampDate(fs.readFileSync(file, 'utf8'), '1.8.0'), '2026-10-30');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

ok('package verification demands the stamp in official mode and forbids it otherwise', () => {
  const fixture = makeTempDir('whats-new-resources-');
  try {
    const resources = path.join(fixture, 'resources');
    const helper = path.join(resources, 'thumbnail-helper');
    fs.mkdirSync(helper, { recursive: true });
    fs.writeFileSync(path.join(resources, 'app.asar'), 'fixture');
    const video = path.join(resources, 'libmpv'); fs.mkdirSync(video);
    for (const name of require('../src/video-runtime').FILES) fs.writeFileSync(path.join(video, name), 'fixture');
    const addon = path.join(resources, 'app.asar.unpacked', 'node_modules', 'koffi', 'build', 'koffi', 'win32_x64');
    fs.mkdirSync(addon, { recursive: true }); fs.writeFileSync(path.join(addon, 'koffi.node'), 'fixture');
    fs.writeFileSync(path.join(helper, 'Znada.ThumbnailHelper.exe'), 'fixture');
    fs.writeFileSync(path.join(helper, 'source.sha256'), `${'a'.repeat(64)}\n`);
    const stamp = path.join(resources, whatsNew.STAMP_FILE);

    verifyExternalResources(fixture, { official: false, version: '1.8.0' });
    assert.throws(() => verifyExternalResources(fixture, { official: true, version: '1.8.0' }), /must contain exactly/);

    fs.writeFileSync(stamp, JSON.stringify({ version: '1.8.0', date: '2026-10-30' }));
    verifyExternalResources(fixture, { official: true, version: '1.8.0' });
    assert.throws(() => verifyExternalResources(fixture, { official: false, version: '1.8.0' }), /must contain exactly/);

    fs.writeFileSync(stamp, JSON.stringify({ version: '1.7.7', date: '2026-10-10' }));
    assert.throws(() => verifyExternalResources(fixture, { official: true, version: '1.8.0' }), /must stamp version 1\.8\.0/);
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

ok('every key the About section and the window use exists in both reference dictionaries', () => {
  for (const lang of ['en', 'ru']) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${lang}.json`), 'utf8'));
    for (const key of ['button', 'title', 'allReleases', 'released']) assert.ok(dict.whatsNew[key], `${lang}: whatsNew.${key}`);
    assert.match(dict.whatsNew.title, /\{version\}/, `${lang}: whatsNew.title needs {version}`);
    assert.match(dict.whatsNew.released, /\{date\}/, `${lang}: whatsNew.released needs {date}`);
    assert.ok(dict.details.close, `${lang}: details.close`);
  }
});

console.log(`whats-new: ${passed} passed`);
