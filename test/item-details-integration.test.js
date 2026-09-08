'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const main = read('main.js');
const preload = read('preload.js');
const renderer = read('renderer', 'renderer.js');
const styles = read('renderer', 'styles.css');
const cardDetails = read('renderer', 'card-details.js');
const locales = ['en', 'ru', 'uk'].map((locale) => JSON.parse(read('locales', `${locale}.json`)));

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

const detailsStart = renderer.indexOf('async function openCardDetails(subject, record = null)');
// ONL-009 replaced openLocalCardContextMenu with the shared card menu, so the block
// now ends at the first thing after the details sheet.
const detailsEnd = renderer.indexOf('// ONL-009. One menu for every card in this window', detailsStart);
ok('details view has a bounded implementation block', detailsStart >= 0 && detailsEnd > detailsStart);
const detailsBlock = renderer.slice(detailsStart, detailsEnd);

ok('details are exposed through narrow preload methods',
  preload.includes("ipcRenderer.invoke('item-details', p)")
  && preload.includes("ipcRenderer.invoke('item-reveal', p)")
  && preload.includes("ipcRenderer.invoke('item-open-source', id)")
  && preload.includes("ipcRenderer.invoke('item-copy-path', p)")
  && !preload.includes("ipcRenderer.invoke('copy-text'"));

ok('main validates details paths and stored source URLs',
  main.includes("ipcMain.handle('item-details'")
  && main.includes('? readItemDetails(p) : itemDetails.emptyDetails()')
  && main.includes("ipcMain.handle('item-copy-path'")
  && main.includes('itemDetails.isValidAbsolutePath(p)')
  // SEC-002 removed the hand-written sender guard here: the registrar in
  // src/ipc-authority.js now answers that question for every channel, and asks three
  // more besides. Naming the old helper again would pin a mechanism that is gone.
  && main.includes("IPC_ROLES[channel] = ['main']")
  && main.includes('isAuthorizedItemPath(p)')
  && main.includes('itemDetails.normalizeHttpUrl(raw)')
  && main.includes('config.library[id]'));

const mainDetailsStart = main.indexOf('// --- Details view ("Подробнее")');
// ONL-009 added the card-action handlers between the details block and library-add-tag,
// so the block now ends at that section header instead of sweeping them in.
const mainDetailsEnd = main.indexOf('// ONL-009 — card actions', mainDetailsStart);
const mainDetailsBlock = main.slice(mainDetailsStart, mainDetailsEnd);
ok('reveal checks the disk asynchronously instead of blocking Electron main',
  mainDetailsBlock.includes('await fs.promises.access(p, fs.constants.F_OK)')
  && !mainDetailsBlock.includes('fs.existsSync'));

ok('opening read-only details never materializes a transient card',
  detailsBlock.includes('poolItemForRecord(record)')
  && !detailsBlock.includes('ensurePoolItemForRecord')
  && !detailsBlock.includes('libraryMaterialize'));

// META-001, owner QA 2026-08-28. The sheet and the card menu must answer "can this photo
// be looked up" with the SAME rule. The sheet asked its own question — "is it already in
// the pool" — which hid the button for every photo inside a watched folder: exactly the
// population the action exists for. It read as "the button needs tags", because tags can
// only live on a pool record.
ok('the lookup button is drawn from the shared registry, not from pool membership',
  detailsBlock.includes("only: ['lookupMeta']")
  && detailsBlock.includes('CardActions.localSubject')
  && detailsBlock.includes('removedView: inRemovedView()')
  && !detailsBlock.includes("if (item && item.type === 'image') {"));

// The record is created on commit, not on draw — the same call the card menu makes, and
// deliberately outside the block the assertion above scans. Scoped to this function's
// own body: the identical call also sits in the card-menu handler, so an unscoped search
// would keep passing over a sheet that had quietly stopped making one.
const detailsLookupStart = renderer.indexOf('async function runDetailsLookup(record, redraw)');
const detailsLookupBlock = detailsLookupStart >= 0
  ? renderer.slice(detailsLookupStart, renderer.indexOf('\n}\n', detailsLookupStart))
  : '';
ok('the sheet materializes on click, through the same helper the card menu uses',
  detailsLookupBlock.includes('const item = await ensurePoolItemForRecord(record);'));

// The redraw must not depend on a broadcast arriving before the reply: config-changed is
// coalesced, and the materialize this path performs stamps that window immediately
// before the lookup. Losing that race would say "added N tags" over a sheet showing none.
ok('the post-lookup redraw reads the config instead of racing the broadcast',
  detailsLookupBlock.includes('config = await window.api.getConfig()'));

ok('async thumbnail and metadata results are discarded after the sheet closes',
  (detailsBlock.match(/!backdrop\.isConnected/g) || []).length >= 2);

ok('the modal restores focus, traps Tab and closes on Escape',
  detailsBlock.includes('backdrop.__restoreFocus = document.activeElement')
  && detailsBlock.includes("if (e.key === 'Escape')")
  && detailsBlock.includes("if (e.key !== 'Tab') return")
  && detailsBlock.includes('last.focus({ preventScroll: true })')
  && detailsBlock.includes('first.focus({ preventScroll: true })'));

ok('source and clipboard actions surface failures instead of rejecting silently',
  detailsBlock.includes("'details.openFailed'")
  && detailsBlock.includes("'details.copyFailed'")
  && detailsBlock.includes("'details.revealFailed'")
  && detailsBlock.includes("b.className = 'pill ghost'")
  && !detailsBlock.includes("b.className = 'btn'")
  && detailsBlock.includes('try { ok = (await handler()) !== false; } catch { ok = false; }'));

// ONL-016 moved both of these decisions into renderer/card-details.js, where they are
// pure and tested. They are still checked here, because this file is what proves the
// sheet is WIRED to them: a rule that moved into a module nobody calls has not moved.
ok('non-HTTP Cloud provenance stays readable without a broken open-source action',
  cardDetails.includes("low.startsWith('znada:') || low.startsWith('lumina:') ? 'Znada' : raw")
  // The row falls back to plain text, and the footer button is simply not offered.
  && cardDetails.includes("kind: isOpenableUrl(item.source) ? 'link' : 'text'")
  && detailsBlock.includes("if (row.kind === 'link')"));

ok('very large tag sets stay bounded and report the hidden count',
  cardDetails.includes('function tagList(value, max = 80)')
  && detailsBlock.includes("t('library.moreTags', { n: row.hidden })")
  && locales.every((locale) => typeof locale.library.moreTags === 'string'
    && locale.library.moreTags.includes('{n}')));

// ONL-009 moved the menu onto the shared action registry, so this asks the registry
// what a local card offers instead of matching the old inline call.
{
  const CardActions = require('../renderer/card-actions');
  const offered = CardActions.actionsFor(
    CardActions.localSubject({ path: 'C:/photos/a.jpg', type: 'image', id: 'p1' },
      { id: 'p1', type: 'image', path: 'C:/photos/a.jpg' }),
  ).map((a) => a.id);
  ok('details appear in the local context menu without replacing existing actions',
    offered.includes('details')
    && ['assign', 'favorite', 'tags', 'remove'].every((id) => offered.includes(id))
    && renderer.includes('details: () => openCardDetails(subject, record),'));
  // ONL-016. The sheet no longer reads a file to describe a card, so a picture on a site
  // is described like any other. This was the owner's complaint on 2026-09-02: he wanted
  // to know where an online picture is from and how big it is, before downloading it.
  ok('details ARE offered for an online card that has no file yet',
    CardActions.actionsFor(CardActions.internetSubject({ page: 'https://x/1', full: 'https://x/1.jpg' }))
      .map((a) => a.id).includes('details'));
  // And the sheet must stop before the disk read for such a card, or it would ask about
  // a file that does not exist and report the picture as missing.
  ok('an online sheet is finished without touching the disk',
    detailsBlock.includes('if (!model.readsDisk) return;')
    && detailsBlock.indexOf('if (!model.readsDisk) return;')
      < detailsBlock.indexOf('await window.api.itemDetails(filePath)'));
}

ok('the modal stays above app popovers while toasts stay visible above it',
  /\.lib-modal-backdrop\s*\{[\s\S]*?z-index:\s*250;/.test(styles)
  && /\.toast\s*\{[\s\S]*?z-index:\s*300;/.test(styles));

console.log('\nAll ' + passed + ' item-details integration tests passed.');
