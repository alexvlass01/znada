'use strict';

// Plain Node test: `node test/size-filter.test.js`.
//
// ONL-010, decided by the owner on 2026-08-25: show only pictures that would fit a
// screen. Filter both shape and resolution; off by default; two modes, one from the
// monitors and one typed by hand; several monitors mean "suits at least one"; the cut is
// hard; and it applies to a search as much as to the front page, because it is the
// user's setting rather than our curation.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../src/size-filter');
const wallhaven = require('../src/wallhaven');
const gelbooru = require('../src/gelbooru');
const danbooru = require('../src/danbooru');
const registry = require('../src/provider-registry');
const config = require('../src/config');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); console.log('  ✓ ' + name); passed++; };

const HD = { ratio: 16 / 9, minWidth: 1920, minHeight: 1080 };
const card = (w, h) => ({ width: w, height: h });

// ---------------------------------------------------------------------------
// The two things the owner named, both of which the filter lies without.
// ---------------------------------------------------------------------------
ok('the resolution is a floor, not a match — bigger is better, not different',
  S.matches(card(3840, 2160), [HD]) && S.matches(card(1920, 1080), [HD])
  && !S.matches(card(1280, 720), [HD]));
ok('the shape is compared with a tolerance, so one pixel off is still 16:9',
  S.matches(card(3840, 2159), [HD]) && S.matches(card(1921, 1080), [HD]));
ok('but a genuinely different shape is refused',
  !S.matches(card(1920, 1200), [HD]) && !S.matches(card(2160, 3840), [HD]));
// Height on its own. Every target built from a size also carries a shape, and the shape
// alone was enough to reject each case above — so a mutation deleting the height check
// survived the first version of these tests entirely.
{
  const tallEnough = S.normalizeTarget({ minHeight: 1080 });
  ok('a target may be a height alone, and that height is really checked',
    !tallEnough.ratio && S.matches(card(800, 1080), [tallEnough])
    && !S.matches(card(800, 720), [tallEnough]));
  const wideEnough = S.normalizeTarget({ minWidth: 1920 });
  ok('and a width alone, likewise',
    !wideEnough.ratio && S.matches(card(1920, 200), [wideEnough])
    && !S.matches(card(1900, 4000), [wideEnough]));
}
ok('the tolerance is the owner-approved 1–2%', S.RATIO_TOLERANCE > 0 && S.RATIO_TOLERANCE <= 0.02);
ok('a tighter tolerance can be asked for, and bites',
  S.matches(card(3840, 2159), [HD], { tolerance: 0.02 })
  && !S.matches(card(3800, 2160), [HD], { tolerance: 0.0001 }));

// ---------------------------------------------------------------------------
// Several monitors: suits at least one.
// ---------------------------------------------------------------------------
{
  // Built from the screen itself, deliberately. An "ultrawide 21:9" is 2.389 in real
  // life (3440/1440) and 2.333 on the box — 2.4% apart, which this tolerance rejects.
  // Both modes build targets from actual sizes, so the marketing number never gets in;
  // the first draft of this test wrote `21/9` by hand and duly failed.
  const [ultrawide] = S.targetsFromMonitors([{ w: 3440, h: 1440 }]);
  ok('a picture passes when it suits any one of the targets',
    S.matches(card(3440, 1440), [HD, ultrawide]) && S.matches(card(1920, 1080), [HD, ultrawide]));
  ok('and fails only when it suits none', !S.matches(card(1024, 768), [HD, ultrawide]));

  const targets = S.targetsFromMonitors([{ w: 1920, h: 1080 }, { w: 1920, h: 1080 }, { w: 2560, h: 1440 }]);
  ok('two identical monitors are one target — asking a site twice buys nothing',
    targets.length === 2);
  ok('a monitor becomes a target of its own shape and its own size',
    targets[0].minWidth === 1920 && targets[0].minHeight === 1080
    && Math.abs(targets[0].ratio - 16 / 9) < 1e-9);
  ok('monitors that will not state a size are skipped rather than becoming a target that matches all',
    S.targetsFromMonitors([{ w: 0, h: 1080 }, null, 'screen', { width: 2560, height: 1440 }]).length === 1);
}

// ---------------------------------------------------------------------------
// Off means off. This is the state the app ships in.
// ---------------------------------------------------------------------------
ok('with no targets everything passes — an off filter must not hide anything',
  S.matches(card(100, 100), []) && S.matches(card(100, 100), null));
ok('the filter is off by default and reads the monitors when it is on',
  S.normalizeFilter({}).enabled === false && S.normalizeFilter({}).mode === 'auto'
  && S.effectiveTargets({ enabled: false, mode: 'auto' }, [{ w: 1920, h: 1080 }]).length === 0
  && S.effectiveTargets({ enabled: true, mode: 'auto' }, [{ w: 1920, h: 1080 }]).length === 1);
ok('manual mode uses what was typed and ignores the monitors',
  S.effectiveTargets({ enabled: true, mode: 'manual', targets: [{ minWidth: 800, minHeight: 600 }] },
    [{ w: 1920, h: 1080 }]).length === 1
  && S.effectiveTargets({ enabled: true, mode: 'manual', targets: [] }, [{ w: 1920, h: 1080 }]).length === 0);
// A site that does not state a picture's size cannot be judged, and hiding those would
// look like the filter is broken rather than strict.
ok('a card with no size stated is kept rather than silently dropped',
  S.matches({}, [HD]) && S.matches({ width: 1920 }, [HD]) && S.matches(null, [HD]));

// ---------------------------------------------------------------------------
// Stored settings arrive from a file a human may have edited.
// ---------------------------------------------------------------------------
ok('junk normalizes to the off state instead of throwing',
  S.normalizeFilter(null).enabled === false && S.normalizeFilter('on').targets.length === 0
  && S.normalizeFilter({ mode: 'sideways' }).mode === 'auto');
ok('an empty target is refused — it would match everything and look like a broken filter',
  S.normalizeTarget({}) === null && S.normalizeTarget({ minWidth: 0 }) === null
  && S.normalizeTarget(null) === null && S.normalizeTarget('1920x1080') === null);
ok('a target given only a size infers its shape',
  Math.abs(S.normalizeTarget({ minWidth: 1920, minHeight: 1080 }).ratio - 16 / 9) < 1e-9);
ok('absurd numbers are clamped rather than stored',
  S.normalizeTarget({ minWidth: 1e9, minHeight: 1e9 }).minWidth <= 30000);
ok('duplicates and overlong lists are trimmed',
  S.normalizeTargets([HD, { ...HD }, HD]).length === 1
  && S.normalizeTargets(Array.from({ length: 40 }, (_, i) => ({ minWidth: 1000 + i, minHeight: 500 }))).length === S.MAX_TARGETS);

// ---------------------------------------------------------------------------
// The manual field.
// ---------------------------------------------------------------------------
ok('sizes are read the way people write them',
  S.parseTargets('3840x2160, 1920×1080; 2560:1440').length === 3);
ok('nonsense between them is skipped, not fatal',
  S.parseTargets('3840x2160, banana, 12, x, 1920x1080').length === 2
  && S.parseTargets('').length === 0 && S.parseTargets(null).length === 0);
ok('what was typed comes back recognisably', S.formatTargets(S.parseTargets('3840x2160,1920x1080'))
  === '3840x2160, 1920x1080');

// ---------------------------------------------------------------------------
// What the SITES are asked. Never the decision — only a narrowing.
// ---------------------------------------------------------------------------
{
  const targets = [HD, S.targetsFromMonitors([{ w: 3440, h: 1440 }])[0]];
  const hints = S.serverHints(targets);
  ok('the bound sent to a site is the loosest that still covers every target',
    hints.minWidth === 1920 && hints.minHeight === 1080 && hints.ratios.length === 2);
  // Sending one target's exact shape would silently cut away what the other allows.
  ok('a target without a shape stops any shape being asked for',
    S.serverHints([HD, { minWidth: 800, minHeight: 600 }]).everyTargetHasRatio === false);
  ok('no targets means nothing to ask for', S.serverHints([]) === null && S.serverHints(null) === null);

  // Measured against the live APIs on 2026-09-03 — the declarations are facts about the
  // sites, and this is what keeps them honest if one is edited on a hunch.
  const decl = (id) => registry.byId(id).capabilities.sizeFilter;
  ok('Wallhaven declares it narrows by both, and takes a list of shapes',
    decl('wallhaven').resolution === true && decl('wallhaven').ratio === true
    && decl('wallhaven').ratioList === true);
  ok('Danbooru declares both, one shape at a time',
    decl('danbooru').resolution === true && decl('danbooru').ratio === true
    && decl('danbooru').ratioList === false);
  // The odd one out, and the reason the client-side check can never be skipped: every
  // spelling of a ratio metatag returns an empty page there.
  ok('Gelbooru declares size only — it has no ratio metatag at all',
    decl('gelbooru').resolution === true && decl('gelbooru').ratio === false);

  const whUrl = wallhaven.buildSearchUrl({ ...wallhaven.sizeParams(hints), q: 'x' });
  ok('Wallhaven is asked with its own spelling', whUrl.includes('atleast=1920x1080')
    && /ratios=16x9(%2C|,)43x18/.test(whUrl));
  ok('a single-shape site is asked for the smallest shape, not one of several', (() => {
    const one = danbooru.buildSearchUrl({ sizeHints: S.serverHints([HD]) });
    return one.includes('width%3A%3E%3D1920') && one.includes('ratio%3A%3E%3D1.7');
  })());
  ok('Gelbooru is asked for the size and never for a shape it does not have', (() => {
    const url = gelbooru.buildSearchUrl({ sizeHints: hints, purity: { sfw: true } });
    return url.includes('width%3A%3E%3D1920') && url.includes('height%3A%3E%3D1080')
      && !url.includes('ratio');
  })());
  ok('with the filter off no site is asked to narrow anything',
    !wallhaven.buildSearchUrl({ ...wallhaven.sizeParams(null), q: 'x' }).includes('atleast')
    && !gelbooru.buildSearchUrl({ purity: { sfw: true } }).includes('width'));
  // A shape only every target agrees on may be sent; otherwise the site would cut away
  // what a shapeless target was meant to allow.
  ok('a mixed list of targets asks no site for a shape', (() => {
    const mixed = S.serverHints([HD, { minWidth: 800, minHeight: 600 }]);
    return !wallhaven.sizeParams(mixed).ratios
      && !danbooru.buildSearchUrl({ sizeHints: mixed }).includes('ratio%3A');
  })());
  // Any whole-number pair, not a fixed menu: checked against the live API on
  // 2026-09-03, where ratios=43x18 returned 3440x1440 and 45x19 returned 3840x1617.
  // An ultrawide owner would otherwise get an empty feed and no explanation.
  // ONL-017. "Ask for more, not more often." A site that cannot narrow by shape returns
  // a page that is mostly discarded here — four cards in a hundred on an anime board —
  // so while the filter is on it is asked for its biggest page: one request instead of
  // several. A site that narrows properly gets the ordinary page, because a bigger one
  // would only be a bigger download of things that already fit.
  ok('the site that cannot narrow by shape is asked for its biggest page',
    S.pageSizeFor(24, decl('gelbooru')) === 100);
  ok('the sites that can narrow are asked for the ordinary page',
    S.pageSizeFor(24, decl('wallhaven')) === 24 && S.pageSizeFor(24, decl('danbooru')) === 24);
  ok('a site that sets its own page size has nothing to widen',
    decl('wallhaven').maxPageSize === 0 && S.pageSizeFor(0, decl('wallhaven')) === 0);
  ok('a bigger page is never asked for below what the caller wanted',
    S.pageSizeFor(200, decl('gelbooru')) === 200);
  ok('junk declarations leave the page size alone rather than inventing one',
    S.pageSizeFor(24, null) === 24 && S.pageSizeFor(24, 'wide') === 24
    && S.pageSizeFor(24, { maxPageSize: 'a hundred' }) === 24);

  ok('an unusual screen still gets a spelling the site understands',
    wallhaven.ratioToPair(16 / 9) === '16x9' && wallhaven.ratioToPair(3440 / 1440) === '43x18'
    && wallhaven.ratioToPair(0) === '' && wallhaven.ratioToPair('wide') === '');
}

// ---------------------------------------------------------------------------
// Wiring: settings, the guard on them, and the client-side check that always runs.
// ---------------------------------------------------------------------------
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

ok('the setting exists and ships off', config.DEFAULT_CONFIG.onlineSizeFilter.enabled === false
  && config.DEFAULT_CONFIG.onlineSizeFilter.mode === 'auto');
// BUG-022: the window may only change settings on a named list, each with its own check.
ok('the window may change it, through the module that also does the matching',
  main.includes('onlineSizeFilter: asMergedObject({')
  && main.includes('const targets = sizeFilter.normalizeTargets(v);'));
ok('every card is judged here whatever a site managed',
  main.includes('.filter((item) => sizeFilter.matches(item, targets))'));
ok('the sites are told the loosest bound, not the decision',
  main.includes('const hints = sizeFilter.serverHints(targets);')
  && main.includes('const first = await run({ sizeHints: hints });'));
// The owner's instruction: top the page up, but the user must not be shown a problem —
// and this must not become the request storm BUG-020 had just finished limiting.
ok('a short page is topped up a bounded number of times and then left short',
  main.includes('for (let round = 0; round < SIZE_FILTER_EXTRA_ROUNDS; round++)')
  && main.includes('if (merged.items.length >= SIZE_FILTER_MIN_CARDS) break;')
  && main.includes('if (!gained.length && !(next.items || []).length) break;'));
// It is the user's setting, so it holds for a typed search exactly as for the front page.
ok('the filter applies to a search as well as to the front page',
  main.includes('const run = (extra) => (browsing') && main.includes('await searchFiltered(o, token, browsing)'));

ok('the window offers the switch, the mode and the manual list',
  html.includes('id="whSizeOn"') && html.includes('id="whSizeMode"') && html.includes('id="whSizeTargets"'));
ok('the controls are wired and re-ask the feed when they change',
  renderer.includes('bindSizeFilterControls();')
  && renderer.includes("if (LIB.filter === 'online' && ONLINE.view === 'search') doOnlineSearch(true);"));
// Typing "384" on the way to "3840" must not fire a search per character.
ok('the manual list is committed, not searched on every keystroke',
  renderer.includes("targets.addEventListener('change', commit);")
  && !renderer.includes("targets.addEventListener('input', commit)"));

const en = require('../locales/en.json');
const ru = require('../locales/ru.json');
ok('both reference languages carry the new strings',
  ['sizeFilter', 'sizeAuto', 'sizeManual', 'sizePlaceholder', 'sizeNoTargets']
    .every((k) => en.online[k] && ru.online[k]));

console.log('\nAll ' + passed + ' size-filter tests passed.');
