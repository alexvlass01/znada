'use strict';

// What a cached fingerprint is allowed to claim about a file.
//
// The dangerous direction here is one-way: believing a stale fingerprint means asking a
// catalogue about the WRONG bytes and then writing somebody else's tags onto the user's
// photo. Recomputing unnecessarily costs one hash. So every case below that is at all
// ambiguous must come out as "compute again".

const assert = require('assert');
const fp = require('../src/fingerprint');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

// --- stamps ---------------------------------------------------------------
const stat = { size: 1024, mtimeMs: 1700000000123.456 };
const stamp = fp.stampOf(stat);
ok('a stamp is size plus a whole-millisecond mtime', stamp.size === 1024 && stamp.mtimeMs === 1700000000123);
ok('the same stat produces an equal stamp', fp.sameStamp(stamp, fp.stampOf(stat)));
ok('a JSON round trip does not make a stamp look stale',
  fp.sameStamp(stamp, fp.stampOf(JSON.parse(JSON.stringify({ size: 1024, mtimeMs: 1700000000123 })))));
ok('a stat without usable numbers has no stamp',
  fp.stampOf(null) === null && fp.stampOf({ size: -1, mtimeMs: 5 }) === null && fp.stampOf({ size: 5 }) === null);

// --- when the cached value may be used ------------------------------------
ok('an unknown file must be hashed', fp.needsCompute(null, stamp, 'md5'));
const entry = fp.withValues(null, stamp, { md5: 'ABCDEF' });
ok('a computed value is stored folded to lower case', fp.valueOf(entry, stamp, 'md5') === 'abcdef');
ok('a matching stamp uses the cached value', !fp.needsCompute(entry, stamp, 'md5'));

const grown = fp.stampOf({ size: 2048, mtimeMs: stat.mtimeMs });
ok('a changed size invalidates the cached value', fp.needsCompute(entry, grown, 'md5'));
const touched = fp.stampOf({ size: 1024, mtimeMs: stat.mtimeMs + 1000 });
ok('a changed mtime invalidates the cached value', fp.needsCompute(entry, touched, 'md5'));
ok('an invalidated value is not handed out anyway', fp.valueOf(entry, touched, 'md5') === '');

// The file changed, so every value it used to have describes bytes that are gone.
// Carrying one forward is the exact wrong-file failure this module exists to prevent —
// and it is only visible by folding in NOTHING: with a value supplied for every kind,
// dropping and overwriting look identical.
ok('an unchanged file keeps what was already computed for it',
  fp.withValues(entry, stamp, {}).values.md5.value === 'abcdef');
ok('a changed file keeps nothing that was computed for the old bytes',
  Object.keys(fp.withValues(entry, touched, {}).values).length === 0);
const rehashed = fp.withValues(entry, touched, { md5: 'newhash' });
ok('and what it does keep is the freshly computed value, under the new stamp',
  rehashed.values.md5.value === 'newhash' && fp.sameStamp(rehashed, touched));

// --- versioning -----------------------------------------------------------
const oldVersion = { size: 1024, mtimeMs: stamp.mtimeMs, values: { md5: { value: 'abcdef', v: 0 } } };
ok('a value computed by an older algorithm is recomputed', fp.needsCompute(oldVersion, stamp, 'md5'));
ok('an unknown kind is never claimed to be cached', fp.needsCompute(entry, stamp, 'phash'));
ok('an unknown kind cannot be stored either',
  !Object.prototype.hasOwnProperty.call(fp.withValues(null, stamp, { nonsense: 'x' }).values, 'nonsense'));

// --- damaged entries ------------------------------------------------------
ok('a damaged entry is recomputed rather than trusted',
  fp.needsCompute({ size: 1024 }, stamp, 'md5')
  && fp.needsCompute({ size: 1024, mtimeMs: stamp.mtimeMs, values: { md5: { value: '' } } }, stamp, 'md5')
  && fp.needsCompute({ size: 1024, mtimeMs: stamp.mtimeMs, values: 'nope' }, stamp, 'md5')
  && fp.needsCompute([], stamp, 'md5'));
ok('no stamp means no cached answer', fp.needsCompute(entry, null, 'md5'));

// --- keys and batches -----------------------------------------------------
ok('the same file spelled two ways shares one cache key',
  fp.fileKey('C:\\photos\\a.jpg') === fp.fileKey('c:/photos/sub/../a.jpg'));
ok('missingKinds names only what still has to be computed',
  fp.missingKinds(entry, stamp, ['md5']).length === 0
  && fp.missingKinds(null, stamp, ['md5']).join() === 'md5'
  && fp.missingKinds(entry, stamp, ['md5', 'nonsense']).length === 0);

console.log(`\nAll ${passed} fingerprint tests passed.`);
