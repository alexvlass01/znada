'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { flatten } = require('../src/i18n-state');

const ROOT = path.join(__dirname, '..');
const en = flatten(JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', 'en.json'), 'utf8')));
const langs = fs
  .readdirSync(path.join(ROOT, 'locales'))
  .filter((file) => /^[a-z]{2,3}\.json$/.test(file) && file !== 'en.json')
  .map((file) => file.replace(/\.json$/, ''));

const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lint-i18n.js')], {
  cwd: ROOT,
  encoding: 'utf8',
  windowsHide: true,
});

assert.strictEqual(result.status, 0, result.stderr || result.stdout);
// The label in parentheses carries the language tier and may be reworded; what this
// test guards is the COUNT, so match any label rather than pinning today's wording.
// A fully translated language prints "fully in sync" instead of a gap line, so each
// language is checked against exactly the line its state must produce — the guard
// survives completed languages instead of pinning one language to stay incomplete.
for (const lang of langs) {
  const dict = flatten(JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${lang}.json`), 'utf8')));
  const missing = Object.keys(en).filter((key) => typeof dict[key] !== 'string' || dict[key] === '').length;
  // Три возможные формы строки, и все три означают «непереведённых ноль»:
  //   ru      — "is in sync" без ярлыка уровня;
  //   прочие  — "(ярлык) is fully in sync";
  //   прочие с устаревшими — "(ярлык): 0 missing keys (100% translated), устарело N".
  // Третья появилась после переименования продукта: строки переведены, но их
  // отпечаток снят с прежнего текста.
  const line = missing === 0
    ? new RegExp(`locales[\\\\/]${lang}\\.json(?: \\([^)]*\\))?(?: is (?:fully )?in sync|: 0 missing keys)`)
    : new RegExp(`locales[\\\\/]${lang}\\.json \\([^)]*\\): ${missing} missing keys`);
  assert.match(
    result.stdout,
    line,
    `${lang}: extra-language summary must count missing leaf strings, not a whole absent subtree as one key`,
  );
}

assert.doesNotMatch(
  result.stdout,
  /extra language\(s\) have missing keys/,
  'aggregate warning must not claim missing keys when the remaining work may only be stale/unverified text',
);

console.log(`  OK i18n lint reports accurate leaf-gap counts for ${langs.length} languages`);
console.log('\nAll 1 i18n-lint report tests passed.');
