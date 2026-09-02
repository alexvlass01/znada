'use strict';

// ONL-011. The one list of picture sites, and the address boundary built from it.
//
// This is a security boundary, not a convenience: the address lists are what stop the
// app being talked into fetching from somewhere else. So the tests care most about the
// two ways such a list goes wrong — an empty list read as "anything goes", and a shape
// that quietly matches more than it says.

const assert = require('assert');
const registry = require('../src/provider-registry');
const online = require('../src/online');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

// --- the list itself ------------------------------------------------------
// ONL-014c. Our own catalogue is last on purpose: a public site answers first while it
// can, so an ordinary browse never waits behind an account check.
ok('the shipped sites are registered, in the order they are asked',
  registry.ids().join(',') === 'wallhaven,gelbooru,danbooru,znada');
// Its cards have no lasting address of any kind, so every one of the shared address
// checks must refuse them — an empty list means “nothing is allowed here”.
ok('the catalogue is allowed no addresses at all',
  registry.HOST_KINDS.every((kind) => registry.hostList('znada', kind).length === 0));
ok('a site can be looked up by id, and an unknown one is simply absent',
  registry.byId('gelbooru').name === 'Gelbooru'
  && registry.byId('nowhere') === null
  && registry.byId('') === null
  && registry.byId(null) === null);
ok('every shipped site declares all four kinds of address list',
  registry.PROVIDERS.every((p) => registry.HOST_KINDS.every((kind) => Array.isArray(p.hosts[kind]))));
ok('every shipped site explicitly says whether its browse cards state a format',
  registry.PROVIDERS.every((p) => typeof p.capabilities.cardFormat === 'boolean')
  && registry.byId('znada').capabilities.cardFormat === false
  && ['wallhaven', 'gelbooru', 'danbooru'].every((id) => registry.byId(id).capabilities.cardFormat === true));
ok('nothing is retired today, so every one of them is asked',
  registry.active().length === registry.ids().length);

// --- the shape of one entry ----------------------------------------------
const at = (href) => new URL(href);
ok('a plain string means exactly that host',
  registry.entryMatches('w.wallhaven.cc', at('https://w.wallhaven.cc/full/a.jpg'))
  && !registry.entryMatches('w.wallhaven.cc', at('https://evil.w.wallhaven.cc/a.jpg'))
  && !registry.entryMatches('w.wallhaven.cc', at('https://w.wallhaven.cc.evil.com/a.jpg')));
ok('a pattern matches a family of hosts and nothing beyond it',
  registry.entryMatches({ pattern: /^img\d*\.gelbooru\.com$/i }, at('https://img4.gelbooru.com/a.jpg'))
  && !registry.entryMatches({ pattern: /^img\d*\.gelbooru\.com$/i }, at('https://img4.gelbooru.com.evil.net/a.jpg')));
ok('a host+path entry is that one path and no other',
  registry.entryMatches({ host: 'gelbooru.com', path: '/hotlink.php' }, at('https://gelbooru.com/hotlink.php?hash=x'))
  && !registry.entryMatches({ host: 'gelbooru.com', path: '/hotlink.php' }, at('https://gelbooru.com/index.php')));
ok('anything that is not one of the three forms matches nothing',
  !registry.entryMatches(null, at('https://a.test/'))
  && !registry.entryMatches({}, at('https://a.test/'))
  && !registry.entryMatches({ pattern: '^a\\.test$' }, at('https://a.test/'))
  && !registry.entryMatches(42, at('https://a.test/')));

// --- an empty list denies, it does not permit -----------------------------
ok('a site that declares no thumbnail hosts allows no thumbnail at all',
  registry.hostList('wallhaven', 'thumb').length === 0
  && !registry.matchesHost('wallhaven', 'thumb', 'https://w.wallhaven.cc/small/a.jpg')
  && !registry.matchesHost('wallhaven', 'thumb', 'https://cdn.donmai.us/a.jpg'));
ok('an empty declaration matches nothing whatever is asked of it',
  !registry.matchesDeclaration({}, 'image', 'https://w.wallhaven.cc/a.jpg')
  && !registry.matchesDeclaration({ image: [] }, 'image', 'https://w.wallhaven.cc/a.jpg')
  && !registry.matchesDeclaration(null, 'image', 'https://w.wallhaven.cc/a.jpg'));
ok('an invented kind of list is not a way in',
  !registry.matchesDeclaration({ anything: ['a.test'] }, 'anything', 'https://a.test/')
  && registry.hostList('gelbooru', 'anything').length === 0);
ok('rubbish instead of an address is refused rather than thrown',
  !registry.matchesHost('gelbooru', 'image', 'not a url')
  && !registry.matchesHost('gelbooru', 'image', '')
  && !registry.matchesHost('', 'image', 'https://img4.gelbooru.com/a.jpg')
  && !registry.matchesHost('nowhere', 'image', 'https://img4.gelbooru.com/a.jpg'));

// --- retiring a site ------------------------------------------------------
// The rule is checked against a made-up retired site, because none exists yet and the
// point is that the rule works BEFORE we need it.
const retired = { id: 'oldsite', name: 'Old', status: 'retired', hosts: { page: ['old.example'], image: ['cdn.old.example'], imageProxyOnly: [], thumb: [] } };
const bothSites = [registry.byId('gelbooru'), retired];
ok('a retired site is not asked for new pictures', registry.activeFrom(bothSites).map((p) => p.id).join() === 'gelbooru');
ok('but its addresses are still recognised, so saved pictures keep working',
  registry.matchesDeclaration(retired.hosts, 'page', 'https://old.example/post/1'));
ok('retiring is a status, never a deletion — an absent site recognises nothing',
  !registry.matchesHost('oldsite', 'page', 'https://old.example/post/1'));

// --- what the boundary actually answers, through online.js ----------------
// The six checks in online.test.js pin today's behaviour and were written before this
// change; these add the cases the registry made expressible.
ok('one site\'s CDN is not another site\'s',
  !online.allowedDownloadUrl({ provider: 'wallhaven', full: 'https://cdn.donmai.us/original/a.jpg' })
  && !online.allowedDownloadUrl({ provider: 'danbooru', full: 'https://w.wallhaven.cc/full/a.jpg' })
  && !online.allowedPageUrl({ provider: 'danbooru', page: 'https://gelbooru.com/index.php' }));
ok('a site nobody registered is refused everywhere',
  !online.allowedDownloadUrl({ provider: 'nowhere', full: 'https://img4.gelbooru.com/a.jpg' })
  && !online.allowedThumbnailUrl({ provider: 'nowhere', thumb: 'https://cdn.donmai.us/a.jpg' })
  && !online.allowedPageUrl({ provider: 'nowhere', page: 'https://gelbooru.com/index.php' })
  && !online.allowedFullFetchUrl({ provider: 'nowhere', full: 'https://img4.gelbooru.com/a.jpg' }));
// The catalogue deliberately owns no lasting URL. Supplying an otherwise valid address
// from another registered site must not let it borrow that site's permissions.
{
  const borrowed = {
    provider: 'znada',
    page: 'https://wallhaven.cc/w/abc',
    full: 'https://w.wallhaven.cc/full/a.jpg',
    sample: 'https://img4.gelbooru.com/a.jpg',
    thumb: 'https://cdn.donmai.us/a.jpg',
  };
  ok('a catalogue card cannot borrow any permanent address from another site',
    !online.allowedDownloadUrl(borrowed)
    && !online.allowedFullFetchUrl(borrowed)
    && !online.allowedSampleFetchUrl(borrowed)
    && !online.allowedThumbnailUrl(borrowed)
    && !online.allowedPageUrl(borrowed));
}
ok('the proxy-only address is exactly that: fetchable by main, never a download target',
  online.allowedFullFetchUrl({ provider: 'gelbooru', full: 'https://gelbooru.com/hotlink.php?hash=x' })
  && !online.allowedDownloadUrl({ provider: 'gelbooru', full: 'https://gelbooru.com/hotlink.php?hash=x' }));
// These four checks used to disagree about the SHAPE of an address: one refused a
// password where its sibling allowed the very same address, and only one of the four
// refused an odd port. ONL-011 pinned that disagreement rather than settling it; the
// review settled it. No picture site's address legitimately carries either.
ok('an address carrying a password is refused by every one of the four',
  !online.allowedFullFetchUrl({ provider: 'wallhaven', full: 'https://u:p@w.wallhaven.cc/full/a.jpg' })
  && !online.allowedDownloadUrl({ provider: 'wallhaven', full: 'https://u:p@w.wallhaven.cc/full/a.jpg' })
  && !online.allowedThumbnailUrl({ provider: 'gelbooru', thumb: 'https://u:p@img4.gelbooru.com/a.jpg' })
  && !online.allowedPageUrl({ provider: 'wallhaven', page: 'https://u:p@wallhaven.cc/w/abc' }));
ok('and so is one carrying a port',
  !online.allowedDownloadUrl({ provider: 'wallhaven', full: 'https://w.wallhaven.cc:8443/full/a.jpg' })
  && !online.allowedFullFetchUrl({ provider: 'wallhaven', full: 'https://w.wallhaven.cc:8443/full/a.jpg' })
  && !online.allowedThumbnailUrl({ provider: 'gelbooru', thumb: 'https://img4.gelbooru.com:8443/a.jpg' })
  && !online.allowedPageUrl({ provider: 'wallhaven', page: 'https://wallhaven.cc:8443/w/abc' }));
ok('the ordinary addresses those four rules exist for still pass',
  online.allowedDownloadUrl({ provider: 'wallhaven', full: 'https://w.wallhaven.cc/full/a.jpg' })
  && online.allowedFullFetchUrl({ provider: 'wallhaven', full: 'https://w.wallhaven.cc/full/a.jpg' })
  && online.allowedThumbnailUrl({ provider: 'gelbooru', thumb: 'https://img4.gelbooru.com/a.jpg' })
  && online.allowedPageUrl({ provider: 'wallhaven', page: 'https://wallhaven.cc/w/abc' }));
// Two holes a mutation walked straight through: the checks above ask the REGISTRY, and
// the declarations they use are written out by hand. Both have to be asked through the
// real boundary, against the real shipped declarations.
ok('previews are refused for a site whose previews the window loads itself',
  !online.allowedThumbnailUrl({ provider: 'wallhaven', thumb: 'https://w.wallhaven.cc/small/a.jpg' })
  && !online.allowedThumbnailUrl({ provider: 'wallhaven', thumb: 'https://wallhaven.cc/small/a.jpg' }));
ok('the SHIPPED host patterns refuse a lookalike domain',
  !online.allowedDownloadUrl({ provider: 'gelbooru', full: 'https://img4.gelbooru.com.evil.net/a.jpg' })
  && !online.allowedThumbnailUrl({ provider: 'gelbooru', thumb: 'https://img4.gelbooru.com.evil.net/a.jpg' })
  && !online.allowedFullFetchUrl({ provider: 'gelbooru', full: 'https://notimg.gelbooru.com/a.jpg' })
  && !online.allowedPageUrl({ provider: 'gelbooru', page: 'https://gelbooru.com.evil.net/index.php' }));
ok('plain http is never enough, whichever check is asked',
  !online.allowedDownloadUrl({ provider: 'wallhaven', full: 'http://w.wallhaven.cc/full/a.jpg' })
  && !online.allowedThumbnailUrl({ provider: 'gelbooru', thumb: 'http://img4.gelbooru.com/a.jpg' })
  && !online.allowedPageUrl({ provider: 'gelbooru', page: 'http://gelbooru.com/index.php' }));

// --- and the ladders are gone ---------------------------------------------
// Comment lines are dropped rather than the whole file scanned: a comment naming a site
// as an example is useful, while a site name in CODE is the ladder creeping back. Only
// whole-line comments are stripped, so nothing inside a string can be mistaken for one.
const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'online.js'), 'utf8');
const executable = source
  .split(String.fromCharCode(10))
  .map((line) => line.replace(String.fromCharCode(13), ''))
  .filter((line) => !line.trim().startsWith('//'))
  .join(String.fromCharCode(10));
const shippedSitePattern = new RegExp(
  registry.ids().map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);
ok('no picture site is named anywhere in what online.js RUNS',
  !shippedSitePattern.test(executable));
ok('and the check would notice if one came back',
  shippedSitePattern.test(executable + `if (item.provider === '${registry.ids()[0]}') return true;`));

console.log(`\nAll ${passed} provider-registry tests passed.`);
