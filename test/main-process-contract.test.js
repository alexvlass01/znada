'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const espree = require('espree');
const { mainProcessSources } = require('./helpers/main-process-sources');
const { fingerprint, inventory, assertReviewed } = require('./helpers/main-process-contract');
const approved = require('./fixtures/main-process-contract.json');
const { makeTempDir } = require('./helpers/temp-dir');

let checks = 0;
const check = (name, fn) => { fn(); checks += 1; console.log('  ok ' + name); };
const parse = text => espree.parse(text, { ecmaVersion: 'latest', sourceType: 'commonjs', loc: true, range: true });

check('current sources and registrations match the explicit contract', () => {
  assertReviewed(inventory(mainProcessSources()), approved);
});
check('formatting, comments and literal spelling do not request a new review', () => {
  assert.strictEqual(fingerprint(parse("const x = 'x';\n")), fingerprint(parse('/* comment */\r\nconst x="x";')));
});
check('values, regex and tagged-template raw text remain executable differences', () => {
  for (const [a, b] of [['const x=null;', 'const x=1e400;'], ['const x=1n;', 'const x=2n;'],
    ['const x=/a/;', 'const x=/b/;'], ['tag`\\n`;', 'tag`\n`;'], ['const x=false;', 'const x=true;']]) {
    assert.notStrictEqual(fingerprint(parse(a)), fingerprint(parse(b)), a);
  }
});

const root = makeTempDir('znada-contract-');
const write = (rel, text) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};
try {
  write('main.js', "require('./diagnostics/core/redaction');");
  write('src/a.cjs', 'exports.value=1;');
  write('diagnostics/main/.keep', '');
  const original = 'module.exports = (bus) => bus.handle("read", () => 0);';
  write('diagnostics/core/redaction.js', original);
  const read = () => inventory(mainProcessSources(root));
  const initial = read();
  const snapshot = { version: 1, sources: initial.sources,
    channels: { read: { file: initial.channels.read, effect: 'no-pool-write' } } };

  check('all three former Object identity bypasses request source review', () => {
    for (const body of ['const item=Object(config.library.demo); item.favorite=true;',
      'const item=new Object(config.library.demo); item.favorite=true;',
      'Reflect.set({}, "favorite", true, Object(config.library.demo));']) {
      const config = { library: { demo: { favorite: false } } };
      vm.runInNewContext(body, { config });
      assert.strictEqual(config.library.demo.favorite, true);
      write('diagnostics/core/redaction.js', 'module.exports=(bus,config)=>bus.handle("read",()=>{' + body + '});');
      assert.throws(() => assertReviewed(read(), snapshot), /source snapshot changed.*redaction\.js/);
    }
    write('diagnostics/core/redaction.js', original);
  });
  check('safe changed source also requests review, and an explicit refresh accepts it', () => {
    write('diagnostics/core/redaction.js', 'module.exports=bus=>bus.handle("read",()=>2);');
    assert.throws(() => assertReviewed(read(), snapshot), /source snapshot changed/);
    assertReviewed(read(), { ...snapshot, sources: read().sources });
    write('diagnostics/core/redaction.js', original);
  });
  check('changed, added and removed CommonJS sources cannot disappear from the snapshot', () => {
    write('src/a.cjs', 'exports.value=2;');
    assert.throws(() => assertReviewed(read(), snapshot), /source snapshot changed.*src\/a\.cjs/);
    write('src/a.cjs', 'exports.value=1;');
    write('src/new.cjs', 'exports.value=0;');
    assert.throws(() => assertReviewed(read(), snapshot), /source snapshot changed.*src\/new\.cjs/);
    fs.unlinkSync(path.join(root, 'src/new.cjs'));
    fs.unlinkSync(path.join(root, 'src/a.cjs'));
    assert.throws(() => assertReviewed(read(), snapshot), /source snapshot changed.*src\/a\.cjs/);
    write('src/a.cjs', 'exports.value=1;');
  });
  check('new and duplicate IPC registrations require explicit decisions', () => {
    write('diagnostics/core/redaction.js', original + '\nexports.extra=bus=>bus.handle("new",()=>0);');
    assert.throws(() => assertReviewed(read(), snapshot), /IPC inventory changed/);
    write('diagnostics/core/redaction.js', original + '\nexports.extra=bus=>bus.handle("read",()=>0);');
    assert.throws(read, /duplicate static IPC registration: read/);
    write('diagnostics/core/redaction.js', 'module.exports=bus=>bus.handle("__proto__",()=>0);');
    assert.ok(Object.hasOwn(read().channels, '__proto__'));
    write('diagnostics/core/redaction.js', original);
  });
  check('unknown effects and undocumented exemptions/defects are refused', () => {
    for (const decision of [{ effect: 'automatic' }, { effect: 'exempt' },
      { effect: 'known-unfrozen', reason: 'because' }]) {
      assert.throws(() => assertReviewed(initial, { ...snapshot,
        channels: { read: { file: initial.channels.read, ...decision } } }),
      /decide its pool effect|missing reason|needs its task ID/);
    }
    assertReviewed(read(), snapshot);
  });
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`PASS main-process-contract: ${checks} checks`);
