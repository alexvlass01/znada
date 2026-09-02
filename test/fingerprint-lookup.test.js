'use strict';

// ONL-013. Asking a site "which post IS this exact file", through the ONE registry.
//
// META-001 used to carry its own second list of sites and a hand-written function per
// site in main.js. Both are gone; a site declares `capabilities.fingerprints` beside
// everything else it declares and provides one hook.
//
// The existing META-001 suites (test/metadata-lookup*.test.js) were left completely
// untouched by that move, which is what proves the behaviour did not change. This file
// covers only what the move made newly reachable: the derivation of the fingerprint list
// from the registry, and the guarantees the shared handler owes a site NOBODY has
// written yet. Those cannot be driven through the two shipped sites — a real site cannot
// be made to throw on demand.

const assert = require('assert');
const path = require('path');
const registry = require('../src/provider-registry');
const metadataLookup = require('../src/metadata-lookup');
const { makeTempProfile, loadMain, unloadMain, writeJson } = require('./helpers/main-harness');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

const HASH = 'a'.repeat(32);

// --- the list is DERIVED, not written out a second time ---------------------

ok('the shipped sites that index a file hash are exactly the two boards, in registry order',
  registry.fingerprintProviders().map((p) => p.id).join() === 'gelbooru,danbooru');

ok('and the site that indexes no hash at all is absent',
  !registry.fingerprintProviders().some((p) => p.id === 'wallhaven'));

ok('what META-001 reasons about IS that list, not a copy of it',
  metadataLookup.PROVIDERS.map((p) => p.id).join()
    === registry.fingerprintProviders().map((p) => p.id).join());

// The one fact that used to be spelled twice, in two vocabularies: the search path said
// `credentials.required`, this path said `requiresCredentials`. One could be changed
// without the other, and the symptom would have been a keyless build quietly asking a
// site that cannot answer.
ok('"needs the bundled key" is read from the same declaration the search path reads',
  registry.fingerprintProviders().every((p) => {
    const declared = registry.byId(p.id);
    return p.requiresCredentials === !!(declared.credentials && declared.credentials.required);
  }));

// Driven with sites the shipped registry cannot produce.
const site = (over) => Object.assign({
  id: over.id,
  status: 'active',
  credentials: { kind: 'none', required: false },
  capabilities: { fingerprints: ['md5'] },
  findByFingerprint: async () => ({ result: null }),
}, over);

ok('a site that declares a hash it can be searched by, but has no hook, is not listed',
  !registry.fingerprintProviders([{ id: 'talker', capabilities: { fingerprints: ['md5'] } }]).length);

ok('and neither is one with the hook that never declared it',
  !registry.fingerprintProviders([{ id: 'quiet', findByFingerprint: async () => ({}) }]).length);

ok('an empty declaration means "cannot", exactly like no declaration at all',
  !registry.fingerprintProviders([site({ id: 'none', capabilities: { fingerprints: [] } })]).length);

// Retirement splits the two questions apart, the same way it does for addresses: what
// is on disk names whoever answered, so it must stay RECOGNISED even once we stop
// asking it. Dropping it from both would throw away an answer the user already has.
{
  const retired = registry.fingerprintProviders([site({ id: 'gelbooru', status: 'retired' })]);
  ok('a retired site is still listed, because the journal on disk names it',
    retired.length === 1 && retired[0].status === 'retired');

  // …and the other half of that split: listed, but never asked.
  const mixed = [
    { id: 'old', status: 'retired', kinds: ['md5'], requiresCredentials: false },
    { id: 'live', status: 'active', kinds: ['md5'], requiresCredentials: false },
  ];
  ok('and it is still never asked anything new',
    metadataLookup.providersFor('md5', { providers: mixed }).join() === 'live');
}

// --- what the shared handler owes a site nobody has written yet -------------

(async () => {
  const userData = makeTempProfile('fingerprint-handler');
  writeJson(path.join(userData, 'config.json'), { autoSwitch: true, style: 'fill', monitors: {}, library: {} });
  const main = loadMain(userData);
  main.__test.loadConfig();
  const ask = main.__test.askProviderForFingerprint;

  // Which sites are reported as holding their key. Whether a key file is actually
  // present is a fact about the machine this runs on — which is why the META-001 suite
  // refuses to pin WHICH catalogue answers — so what is pinned here is the shape:
  // exactly the sites that declared they need one, and nobody else. A site listed
  // without needing a key would be asked and refuse itself, burning an hour of rest on
  // a question that was never really open.
  {
    const reported = Object.keys(main.__test.metadataCredentials()).sort().join();
    const declared = registry.active()
      .filter((d) => d.credentials && d.credentials.required)
      .map((d) => d.id).sort().join();
    ok('only the sites that said they need a key are reported as having one',
      reported === declared && !!declared);
  }

  const base = {
    id: 'test',
    status: 'active',
    credentials: { kind: 'none', required: false },
    capabilities: { fingerprints: ['md5'] },
  };

  const thrown = await ask({ ...base, findByFingerprint: () => { throw new Error('boom'); } }, 'md5', HASH);
  ok('a site that throws becomes an error, not an exception', thrown.status === 'error');

  const rejected = await ask({ ...base, findByFingerprint: async () => { throw new Error('boom'); } }, 'md5', HASH);
  ok('and so does one that rejects', rejected.status === 'error');

  const noHook = await ask({ ...base }, 'md5', HASH);
  ok('a site with no hook cannot be asked at all', noHook.status === 'error' && noHook.reason === 'unsupported');

  const needsKey = await ask(
    { ...base, credentials: { kind: 'bundled', required: true }, findByFingerprint: async () => ({ result: null }) },
    'md5', HASH,
  );
  ok('a site that requires a key it has not got is not asked either',
    needsKey.status === 'error' && needsKey.reason === 'unavailable');

  // The distinction that costs a MONTH if it is got wrong: "not here" rests thirty days,
  // a failure rests an hour. A shape we cannot read must fall on the failure side.
  const absent = await ask({ ...base, findByFingerprint: async () => ({ result: null }) }, 'md5', HASH);
  ok('an explicit "not here" is an answer', absent.status === 'absent' && !absent.reason);

  const mute = await ask({ ...base, findByFingerprint: async () => ({}) }, 'md5', HASH);
  ok('a site that says neither yes nor no is a failure, never a month-long "not here"',
    mute.status === 'error' && mute.reason === 'malformed');

  const silent = await ask({ ...base, findByFingerprint: async () => undefined }, 'md5', HASH);
  ok('and so is one that answers nothing at all', silent.status === 'error');

  // The check that must never move into a site's own file.
  const wrongPost = await ask(
    { ...base, findByFingerprint: async () => ({ result: { postId: '1', md5: 'b'.repeat(32), tags: [] } }) },
    'md5', HASH,
  );
  ok('a post carrying somebody else\'s hash is refused by the handler, not trusted',
    wrongPost.status === 'absent' && wrongPost.reason === 'mismatch');

  const rightPost = await ask(
    { ...base, findByFingerprint: async () => ({ result: { postId: '1', md5: HASH, tags: [] } }) },
    'md5', HASH,
  );
  ok('and the post that does carry ours is believed', rightPost.status === 'found');

  // BUG-026. The hole the check above left open: it demanded a hash only when the post
  // HAD one. A post with no hash — Danbooru omits the file fields on restricted and
  // deleted posts, and postSummary turns that into an empty string — sailed straight
  // through, and its tags were written onto the user's photo. "I cannot tell you what
  // file this is" is not the same answer as "this is your file".
  const noHash = await ask(
    { ...base, findByFingerprint: async () => ({ result: { postId: '1', md5: '', tags: [] } }) },
    'md5', HASH,
  );
  ok('a post that carries no hash at all is refused, not accepted by default',
    noHash.status === 'absent' && noHash.reason === 'mismatch');

  const missingField = await ask(
    { ...base, findByFingerprint: async () => ({ result: { postId: '1', tags: [] } }) },
    'md5', HASH,
  );
  ok('and neither does leaving the field out entirely count as a match',
    missingField.status === 'absent' && missingField.reason === 'mismatch');

  // The other side of exactness: a site that spells the same hash in capitals, or with
  // whitespace around it, HAS answered our question. Refusing it would tell the user
  // "not found" about a photo the catalogue does hold.
  const shouty = await ask(
    { ...base, findByFingerprint: async () => ({ result: { postId: '1', md5: `  ${HASH.toUpperCase()} `, tags: [] } }) },
    'md5', HASH,
  );
  ok('the same hash written differently is still the same hash', shouty.status === 'found');

  const nearly = await ask(
    { ...base, findByFingerprint: async () => ({ result: { postId: '1', md5: `${HASH}0`, tags: [] } }) },
    'md5', HASH,
  );
  ok('but a hash that merely starts the same is not ours', nearly.status === 'absent');

  // The last two need the network, so it is replaced. Nothing above reaches it.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

  // One allowed request first, so the limiter has something to hold the next one back
  // from. Asserted, because a limiter that was refusing all along would make both of the
  // checks below pass for the wrong reason.
  //
  // Set ONCE: changing the limits clears the per-site state, and a cleared state has
  // nothing to measure a minimum gap from — which is exactly how the first attempt at
  // this test passed the wrong request through.
  // Deliberately longer than the small inline wait production uses. A custom/host policy
  // must be surfaced as `busy`, not turn the one metadata worker into a multi-second
  // sleeper (the first regression used ten minutes and hung the full suite).
  main.__test.setMetadataBudget({ ratePerMinute: 6000, burst: 500, minGapMs: 2000 });
  const askedOut = { hit: 0 };
  const fetching = (result) => async (kind, value, ctx) => {
    const res = await ctx.fetchJson('https://example.test/x');
    askedOut.hit += res.error ? 0 : 1;
    return typeof result === 'function' ? result(res) : result;
  };
  const allowed = await ask({ ...base, findByFingerprint: fetching({ result: null }) }, 'md5', HASH);
  ok('with room in the budget the request goes out and the answer stands',
    allowed.status === 'absent' && askedOut.hit === 1);

  // A site is never told that a refusal came from OUR limiter — it sees an ordinary
  // failure — so the handler has to recognise its own refusal and say "wait" instead of
  // journalling a miss about a question that was never actually asked.
  const blockedAt = Date.now();
  const blocked = await ask({
    ...base,
    findByFingerprint: fetching((res) => (res.error ? { error: res.error } : { result: null })),
  }, 'md5', HASH);
  ok('our own limiter refusing is "busy, wait" — never an error, never a miss',
    blocked.status === 'busy' && blocked.retryAfterMs > 0 && askedOut.hit === 1
      && Date.now() - blockedAt < 500);

  // The regression this ordering exists to prevent: Gelbooru asks a SECOND time for tag
  // kinds, and that request is allowed to be refused. Answering "busy" then would throw
  // away a post already in hand.
  const foundAnyway = await ask({
    ...base,
    findByFingerprint: fetching({ result: { postId: '1', md5: HASH, tags: [] } }),
  }, 'md5', HASH);
  ok('a site whose EXTRA request was refused still keeps the post it found',
    foundAnyway.status === 'found');

  globalThis.fetch = originalFetch;
  unloadMain();
  console.log(`\nAll ${passed} fingerprint-lookup tests passed.`);
})().catch((err) => { console.error(err); process.exit(1); });
