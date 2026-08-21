'use strict';

const assert = require('assert');
const C = require('../src/i18n-context');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  OK ${name}`);
  passed++;
}

const reference = {
  nav: { home: 'Home' },
  prefs: {
    group: 'Preferences',
    title: 'Setting',
    sub: 'Explanation',
    hint: 'Helpful hint',
  },
  action: { run: 'Run', aria: 'Run action', ph: 'Type here', label: 'Value' },
  toast: { failed: 'Failed', fallback: 'Could not apply' },
  journal: { thumbs: 'Thumbnail helper', themeSchedule: 'Theme schedule' },
  smart: { tips: ['One', 'Two'] },
  online: { ratingGeneral: 'General', ratingExplicit: 'Explicit' },
};

{
  const attrs = C.parseHtmlAttributes(' id="x" class=\'a b\' data-i18n=nav.home disabled');
  ok('HTML attributes support quoted, single-quoted and bare values',
    attrs.id === 'x' && attrs.class === 'a b' && attrs['data-i18n'] === 'nav.home'
    && 'disabled' in attrs);
}

const html = `
<header id="titlebar"><button class="navbtn"><span data-i18n="nav.home">Home</span></button></header>
<section class="view" id="viewPrefs">
  <h2 class="group-title" data-i18n="prefs.group">Preferences</h2>
  <div class="row-title" data-i18n="prefs.title">Setting</div>
  <div class="row-sub" data-i18n="prefs.sub">Explanation</div>
  <button><span data-i18n="action.run">Run</span></button>
  <input data-i18n-ph="action.ph">
  <span data-i18n-title="prefs.hint"></span>
</section>`;

{
  const result = C.scanHtml(html, 'renderer/index.html', new Set(Object.keys(C.buildContextCatalog({
    reference,
    sources: [],
  }).entries)));
  const contexts = Object.fromEntries(
    result.contexts.map(({ key, context }) => [key, context]),
  );
  ok('HTML child inside a button is classified as a button',
    contexts['action.run'].type === 'button');
  ok('HTML option/title/subtitle heuristics keep semantic element types',
    contexts['prefs.group'].type === 'heading'
    && contexts['prefs.title'].type === 'setting-title'
    && contexts['prefs.sub'].type === 'description');
  ok('HTML i18n title and placeholder attributes get their own types',
    contexts['prefs.hint'].type === 'tooltip'
    && contexts['action.ph'].type === 'placeholder');
  ok('HTML area follows the nearest application view',
    contexts['prefs.title'].area === 'preferences'
    && contexts['nav.home'].area === 'navigation');
}

const js = `
// t('ghost.comment') and "toast.failed" in comments are not references.
const docs = \`Example only: t('ghost.templateText')\`;
const regex = /t('ghost.regexText')/;
if (ready) /t('ghost.regexAfterCondition')/.test(input);
const APPLY_ERRORS = {
  bad: 'toast.failed',
};
function renderAction(code, suffix) {
  toast(t(APPLY_ERRORS[code] || 'toast.fallback'));
  button.title = t("prefs.hint");
  button.setAttribute('aria-label', t(\`action.aria\`));
  input.placeholder = t('action.ph');
  label.textContent = t('action.label');
  const tips = tPath(I18N.dict, 'smart.tips');
  return t(\`online.rating\${suffix}\`);
}
t('missing.deletedKey');
const add = document.createElement('button');
add.textContent = t('action.run');
const conditional = t(true ? 'action.run' : 'missing.conditionalKey');
setLibEmptyText('missing.helperKey');
node.dataset.i18n = true ? 'prefs.title' : 'missing.datasetKey';
reportChannelFailure('thumbnail-helper', 'journal.thumbs', { host: 'example.com' });
reportChannelFailure('channel.name', 'journal.thumbs', { titleKey: 'toast.failed' });
reportChannelSuccess('theme-schedule', 'journal.themeSchedule');
t('action.label', { host: 'params.example.com' });
addAction(t('action.run'), () => api.open('callback.example.com'), 'toast.failed');
node.dataset.i18n = 'prefs.title'; api.open('after.dataset.com');
`;

{
  const keys = new Set(Object.keys(C.buildContextCatalog({ reference, sources: [] }).entries));
  const result = C.scanJavaScript(js, 'renderer/renderer.js', keys);
  const forKey = (key) => result.contexts.filter((x) => x.key === key).map((x) => x.context);
  ok('direct t calls support single, double and backtick quotes',
    forKey('prefs.hint').length === 1
    && forKey('action.aria').length === 1
    && forKey('action.ph').length === 1);
  ok('JavaScript sinks infer toast, aria, placeholder and label',
    forKey('toast.fallback').some((x) => x.type === 'toast')
    && forKey('action.aria').some((x) => x.type === 'aria-label')
    && forKey('action.ph').some((x) => x.type === 'placeholder')
    && forKey('action.label').some((x) => x.type === 'label'));
  ok('lookup-map keys inherit the type of their t/toast consumer',
    forKey('toast.failed').some((x) => x.type === 'toast' && x.via === 'lookup-map:APPLY_ERRORS'));
  ok('tPath collection references expand indexed translation leaves',
    forKey('smart.tips.0').some((x) => x.type === 'tip' && x.via === 'collection-reference')
    && forKey('smart.tips.1').length > 0);
  ok('dynamic template families expand only matching dictionary leaves',
    forKey('online.ratingGeneral').some((x) => x.via === 'dynamic-template')
    && forKey('online.ratingExplicit').some((x) => x.via === 'dynamic-template'));
  ok('comment examples are ignored while a deleted direct key remains detectable',
    !result.definiteReferences.has('ghost.comment')
    && !result.definiteReferences.has('ghost.templateText')
    && !result.definiteReferences.has('ghost.regexText')
    && !result.definiteReferences.has('ghost.regexAfterCondition')
    && result.definiteReferences.has('missing.deletedKey'));
  ok('conditional and helper/dataset key sinks remain detectable after key deletion',
    result.definiteReferences.has('missing.conditionalKey')
    && result.definiteReferences.has('missing.helperKey')
    && result.definiteReferences.has('missing.datasetKey'));
  ok('helper key arguments are detected without treating unrelated arguments as keys',
    result.definiteReferences.has('journal.thumbs')
    && result.definiteReferences.has('journal.themeSchedule')
    && !result.definiteReferences.has('example.com')
    && !result.definiteReferences.has('channel.name')
    && !result.definiteReferences.has('params.example.com')
    && !result.definiteReferences.has('callback.example.com')
    && !result.definiteReferences.has('after.dataset.com'));
  ok('journal helper keys are classified as event messages',
    forKey('journal.thumbs').some((x) => x.type === 'event-message')
    && forKey('journal.themeSchedule').some((x) => x.type === 'event-message'));
  ok('text assigned to a created button is not mislabeled as a generic label',
    forKey('action.run').some((x) => x.type === 'button' && x.confidence === 'high'));
}

{
  const objectCopy = C.scanJavaScript(`
    const copy = { title: t('action.run'), detail: t('prefs.sub') };
  `, 'renderer/renderer.js', new Set(['action.run', 'prefs.sub']));
  const kind = (key) => objectCopy.contexts.find((item) => item.key === key).context;
  ok('object title and detail fields are classified independently on the same line',
    kind('action.run').type === 'heading'
    && kind('prefs.sub').type === 'description'
    && kind('action.run').confidence === 'high');
}

{
  const insideTemplate = C.scanJavaScript(
    "const x = `${tPath(getCatalog('catalog.name'), 'smart.tips')}`;",
    'renderer/renderer.js',
    new Set(['smart.tips.0', 'smart.tips.1']),
  );
  ok('template-expression calls use the same argument-position rules',
    !insideTemplate.definiteReferences.has('catalog.name')
    && insideTemplate.definiteReferences.has('smart.tips')
    && insideTemplate.contexts.some((item) => (
      item.key === 'smart.tips.0' && item.context.via === 'collection-reference'
    )));
}

{
  const sources = [
    { file: 'renderer/renderer.js', content: js },
    { file: 'renderer/index.html', content: html },
  ];
  const first = C.buildContextCatalog({ reference, sources });
  const second = C.buildContextCatalog({ reference, sources: sources.slice().reverse() });
  ok('catalog generation is byte-deterministic regardless of source input order',
    C.stableJson(first) === C.stableJson(second));
  ok('catalog preserves multiple contexts for one reused key',
    first.entries['prefs.hint'].contexts.length === 2);
  ok('catalog reports direct references deleted from en.json',
    first.danglingReferences.includes('missing.deletedKey')
    && first.danglingReferences.includes('missing.conditionalKey')
    && first.danglingReferences.includes('missing.helperKey')
    && first.danglingReferences.includes('missing.datasetKey'));
  ok('catalog reports keys with no invented context as unresolved',
    first.unresolved.includes('action.run') === false
    && first.unresolved.length < first.stats.total);
}

{
  const withoutRating = JSON.parse(JSON.stringify(reference));
  delete withoutRating.online.ratingGeneral;
  const catalog = C.buildContextCatalog({
    reference: withoutRating,
    sources: [{ file: 'renderer/renderer.js', content: js }],
  });
  ok('finite dynamic families catch a deleted member',
    catalog.danglingReferences.includes('online.ratingGeneral'));
}

{
  const emptyCatalog = C.buildContextCatalog({ reference, sources: [] });
  const manual = {
    schemaVersion: 1,
    keys: {
      'action.run': {
        meaning: 'Runs the current action',
        contexts: [{ type: 'button', area: 'preferences' }],
      },
    },
  };
  ok('manual sidecar validates known keys and required context fields',
    C.validateManualCatalog(manual, reference).length === 0);
  ok('manual sidecar rejects stale keys and incomplete contexts', (() => {
    const bad = {
      schemaVersion: 1,
      keys: {
        'missing.key': { contexts: [{ type: 'button' }] },
      },
    };
    const errors = C.validateManualCatalog(bad, reference);
    return errors.some((x) => x.includes('absent from en.json'))
      && errors.some((x) => x.includes('.area is required'));
  })());
  ok('manual contexts participate in combined coverage and lookup',
    C.combinedCoverage(emptyCatalog, manual).contextualized === 1
    && C.manualEntry(manual, 'action.run').meaning === 'Runs the current action'
    && C.manualEntry(manual, '__proto__') === null);
  ok('artifact comparison can normalize a Windows CRLF checkout',
    C.normalizeEol('{\r\n  \"a\": 1\r\n}\r\n') === '{\n  "a": 1\n}\n');
}

console.log(`\nAll ${passed} i18n-context tests passed.`);
