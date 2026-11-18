'use strict';

// META-001 as the two windows perform it. The important property here is that the five
// distinct endings stay five: "found and added", "found but nothing new", "nothing has
// this file", "slow down" and "could not check" mean different things to the person
// pressing the button, and a feature that answers three of them with silence is one the
// user concludes is broken.

const assert = require('assert');
const CardMetadata = require('../renderer/card-metadata');
const CardActions = require('../renderer/card-actions');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

const key = (res) => CardMetadata.outcomeMessage(res).key;

// --- the five endings -----------------------------------------------------
ok('found with new tags reports how many', key({ status: 'found', addedTags: 7 }) === 'card.lookupAdded'
  && CardMetadata.outcomeMessage({ status: 'found', addedTags: 7 }).params.n === 7);
ok('found with nothing new says so instead of claiming a win',
  key({ status: 'found', addedTags: 0 }) === 'card.lookupNoNew');
ok('nothing found is its own message', key({ status: 'absent' }) === 'card.lookupNothing');
ok('our own limiter is not reported as a failure', key({ status: 'busy', retryAfterMs: 4000 }) === 'card.lookupBusy');
ok('and it says how long to wait, rounded up to whole seconds',
  CardMetadata.outcomeMessage({ status: 'busy', retryAfterMs: 4100 }).params.n === 5
  && CardMetadata.outcomeMessage({ status: 'busy', retryAfterMs: 0 }).params.n === 1);
ok('a timeout explains that the site did not respond', key({ status: 'error', reason: 'timeout' }) === 'card.lookupTimeout');
ok('network errors differ from absence', key({ status: 'error', reason: 'network' }) === 'card.lookupNetwork');
ok('HTTP errors preserve the status', CardMetadata.outcomeMessage({ status: 'error', reason: '403' }).params.n === 403);
ok('no answer at all is a failure, never a silent success',
  key(null) === 'card.lookupFailed' && key({}) === 'card.lookupFailed' && key({ status: 'weird' }) === 'card.lookupFailed');
// DATA-009. A move refused the write; nothing failed, so "could not check" would be wrong.
ok('a lookup refused because files are being moved says that, not "could not check"',
  key({ status: 'error', reason: 'media_move_running' }) === 'mediaFolder.frozen'
  && !CardMetadata.changedRecord({ status: 'error', reason: 'media_move_running' }));

// --- only a real change counts as one -------------------------------------
ok('only a found result with new tags counts as changing the record',
  CardMetadata.changedRecord({ status: 'found', addedTags: 1 })
  && !CardMetadata.changedRecord({ status: 'found', addedTags: 0 })
  && !CardMetadata.changedRecord({ status: 'absent' })
  && !CardMetadata.changedRecord(null));

// --- running it -----------------------------------------------------------
function harness(reply, opts = {}) {
  const said = [];
  const busy = [];
  const applied = [];
  let calls = 0;
  const bridge = {
    itemLookupMetadata: async (id) => {
      calls += 1;
      if (opts.hang) await new Promise((resolve) => { setTimeout(resolve, 5); });
      if (typeof reply === 'function') return reply(id);
      return reply;
    },
  };
  const run = (id = 'p1') => CardMetadata.run({
    bridge,
    id,
    t: (k, params) => (params ? `${k}:${JSON.stringify(params)}` : k),
    notify: (message) => said.push(message),
    onBusy: (flag) => busy.push(flag),
    onApplied: (res) => applied.push(res),
  });
  return { run, said, busy, applied, calls: () => calls };
}

(async () => {
  const found = harness({ status: 'found', addedTags: 3 });
  const res = await found.run();
  ok('the user is told the work started and then how it ended',
    found.said.length === 2 && found.said[0] === 'card.lookupRunning' && found.said[1].startsWith('card.lookupAdded'));
  ok('the control is disabled for the duration and released after', found.busy.join() === 'true,false');
  ok('a real change notifies the caller so the sheet can be redrawn',
    found.applied.length === 1 && res.status === 'found');

  const nothing = harness({ status: 'absent' });
  await nothing.run();
  ok('a lookup that changed nothing does not ask for a redraw', nothing.applied.length === 0);
  ok('but still says something', nothing.said[1] === 'card.lookupNothing');

  const broken = harness(() => { throw new Error('bridge is gone'); });
  await broken.run();
  ok('a bridge that throws is reported, not swallowed', broken.said[1] === 'card.lookupFailed');
  ok('and the control is released even then', broken.busy.join() === 'true,false');

  // A double click must not produce two progress notices; main serialises the real
  // work, but the user would see the duplicate long before main ever got involved.
  const twice = harness({ status: 'absent' }, { hang: true });
  const [a, b] = await Promise.all([twice.run('p1'), twice.run('p1')]);
  ok('a second click while one is running is ignored', twice.calls() === 1 && b === null && a !== null);
  ok('and the photo is askable again once it finishes', !CardMetadata.isRunning('p1'));

  const other = harness({ status: 'absent' }, { hang: true });
  await Promise.all([other.run('p1'), other.run('p2')]);
  ok('two DIFFERENT photos are not blocked by each other', other.calls() === 2);

  const noBridge = await CardMetadata.run({ bridge: {}, id: 'p1' });
  ok('a window whose bridge lacks the method does nothing rather than throwing',
    noBridge === null && (await CardMetadata.run({ bridge: null, id: 'p1' })) === null
    && (await CardMetadata.run({ bridge: { itemLookupMetadata: () => {} }, id: '' })) === null);

  // The action and the operation have to agree about who can be looked up: an action
  // offered on a card the operation cannot serve is a button that always fails.
  const localPooled = CardActions.localSubject({ path: 'C:/x/a.jpg', type: 'image', id: 'p1' }, { id: 'p1', type: 'image', path: 'C:/x/a.jpg' });
  const localLoose = CardActions.localSubject({ path: 'C:/x/b.jpg', type: 'image' }, null);
  const folder = CardActions.localSubject({ path: 'C:/x', type: 'folder', id: 'f1' }, { id: 'f1', type: 'folder', path: 'C:/x' });
  const has = (subject) => CardActions.actionsFor(subject).some((action) => action.id === 'lookupMeta');
  ok('a photo the user keeps can be looked up', has(localPooled));
  ok('a folder cannot', !has(folder));
  // A file inside a watched folder has no pool record until it is used. Requiring one
  // made the action vanish for most of a real library, while "change tags" — which needs
  // a record just as much — sat right next to it and made one on commit. Same rule now.
  ok('a file inside a watched folder can too, and gets its record when the user commits',
    has(localLoose));
  ok('a removed photo cannot, so a lookup cannot revive it through a side door',
    !has(CardActions.localSubject({ path: 'C:/x/a.jpg', type: 'image', id: 'p1', removedView: true }, { id: 'p1', type: 'image', path: 'C:/x/a.jpg' })));
  ok('an online card that was never downloaded cannot: there is no local file to hash',
    !CardActions.actionsFor(CardActions.internetSubject({ page: 'https://x/1', full: 'https://x/a.jpg' })).some((a) => a.id === 'lookupMeta'));

  // --- the third surface ---------------------------------------------------
  //
  // Owner QA 2026-08-28: in the fullscreen viewer the menu offered "Найти теги и
  // источник" and the click did nothing whatsoever - no progress, no result, no failure.
  // The handler needed a pool record and returned a bare `Promise.resolve(null)` without
  // it, which is the one ending this whole module exists to forbid.
  //
  // This is a source scan and says so: there is no real viewer window in these tests, so
  // what can be proved here is that the refusal and the silence are gone and that the
  // materialize goes through the one authorized channel. The behaviour itself is an
  // owner check.
  const viewerSrc = require('fs')
    .readFileSync(require('path').join(__dirname, '..', 'renderer', 'viewer.js'), 'utf8');
  const lookupFn = viewerSrc.slice(
    viewerSrc.indexOf('async function lookupViewerCardMetadata(entry)'),
    viewerSrc.indexOf('// Taking the picture back out'),
  );
  ok('the viewer no longer refuses a photo that has no record yet',
    lookupFn.length > 0
    && !lookupFn.includes('if (!pooled || !pooled.id) return Promise.resolve(null);')
    && lookupFn.includes('await ensureViewerRecord(entry)'));
  ok('and when it truly cannot look one up, it says so instead of going quiet',
    lookupFn.includes("showViewerMessage(viewerFailureText(made.error, 'card.lookupFailed'))"));
  ok('the record is made through the viewer’s one authorized channel',
    viewerSrc.includes('async function ensureViewerRecord(entry)')
    // LIB-031: the path is the entry's own or, for an Online card the user already has, that file's.
    && viewerSrc.includes('window.viewerApi.cardEnsureRecord(filePath')
    && !viewerSrc.includes('libraryMaterialize'));

  // DATA-009. The two viewer functions run for real, extracted the way
  // test/ipc-contract.test.js runs applyViewerUndoResult: main's actual refusal shapes in,
  // what the user reads out.
  const vm = require('vm');
  const extract = (pattern, context) => {
    const found = viewerSrc.match(pattern);
    assert.ok(found, 'viewer function present: ' + pattern);
    return vm.runInNewContext(`(${found[0]})`, context);
  };
  const CardTransfer = require('../renderer/card-transfer');
  const tKey = (k) => k;
  const viewerFailureText = extract(/function viewerFailureText\([^)]*\) \{[\s\S]*?\n\}/,
    { CardTransfer, t: tKey });
  ok('a refusal during a move is worded as the move, in every viewer action',
    viewerFailureText('media_move_running', 'card.lookupFailed') === 'mediaFolder.frozen'
    && viewerFailureText('media_move_running', 'library.assignMissingToast') === 'mediaFolder.frozen');
  ok('any other failure keeps the action’s own words',
    viewerFailureText('', 'card.lookupFailed') === 'card.lookupFailed'
    && viewerFailureText('missing_file', 'library.assignMissingToast') === 'library.assignMissingToast'
    && viewerFailureText(undefined, 'library.assignMissingToast') === 'library.assignMissingToast');

  const ensureWith = (reply) => extract(/async function ensureViewerRecord\([^)]*\) \{[\s\S]*?\n\}/, {
    window: { viewerApi: { cardEnsureRecord: async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    } } },
  });
  const refusedEntry = { kind: 'path', path: 'C:/photos/a.png' };
  const refused = await ensureWith({ id: '', error: 'media_move_running' })(refusedEntry);
  ok('a refused record says why and leaves the entry as it was',
    refused.id === '' && refused.error === 'media_move_running'
    && !refusedEntry.added && !refusedEntry.pooled);
  const madeEntry = { kind: 'library', path: 'C:/photos/b.png' };
  const made = await ensureWith({ id: 'p-b' })(madeEntry);
  ok('a made record is remembered on the entry, with no error',
    made.id === 'p-b' && made.error === ''
    && madeEntry.added === true && madeEntry.pooled.id === 'p-b');
  const thrown = await ensureWith(new Error('bridge gone'))({ kind: 'path', path: 'C:/x.png' });
  ok('a broken bridge is "no record", not a move',
    thrown.id === '' && thrown.error === '');
  const pooledEntry = { kind: 'library', path: 'C:/c.png', pooled: { id: 'p-c' } };
  ok('an entry that already has a record is not asked about again',
    (await ensureWith(new Error('must not be called'))(pooledEntry)).id === 'p-c');
  // A source scan, as the lines above it: the assignment chooser needs a real window.
  const viewerAssign = viewerSrc.slice(
    viewerSrc.indexOf('onPick: async (monitorId, theme) => {'),
    viewerSrc.indexOf('window.MotionBadge.appendFirstFrameNote(pop, t)'),
  );
  ok('assigning from the viewer words a refused assignment, never as "Assigned"',
    viewerAssign.length > 0
    && viewerAssign.includes('const made = await ensureViewerRecord(entry);')
    && viewerAssign.includes("viewerFailureText(made.error, 'library.assignMissingToast')")
    && viewerAssign.includes("viewerFailureText(res && res.error, 'library.assignMissingToast')"));
  ok('removing from the viewer no longer requires a record either',
    !viewerSrc.includes('if (!entry || !entry.added || !entry.pooled) return false;')
    && viewerSrc.includes("path: (pooled && pooled.path) || entry.path || ''"));

  console.log(`\nAll ${passed} card-metadata tests passed.`);
})();
