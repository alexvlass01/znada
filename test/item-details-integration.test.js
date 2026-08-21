'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const main = read('main.js');
const preload = read('preload.js');
const renderer = read('renderer', 'renderer.js');
const styles = read('renderer', 'styles.css');
const locales = ['en', 'ru', 'uk'].map((locale) => JSON.parse(read('locales', `${locale}.json`)));

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  OK ' + name);
}

const detailsStart = renderer.indexOf('async function openCardDetails(record)');
const detailsEnd = renderer.indexOf('function openLocalCardContextMenu(', detailsStart);
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
  && main.includes('isTrustedMainWindowSender(e)')
  && main.includes('isAuthorizedItemPath(p)')
  && main.includes('itemDetails.normalizeHttpUrl(raw)')
  && main.includes('config.library[id]'));

const mainDetailsStart = main.indexOf('// --- Details view ("Подробнее")');
const mainDetailsEnd = main.indexOf("ipcMain.handle('library-add-tag'", mainDetailsStart);
const mainDetailsBlock = main.slice(mainDetailsStart, mainDetailsEnd);
ok('reveal checks the disk asynchronously instead of blocking Electron main',
  mainDetailsBlock.includes('await fs.promises.access(p, fs.constants.F_OK)')
  && !mainDetailsBlock.includes('fs.existsSync'));

ok('opening read-only details never materializes a transient card',
  detailsBlock.includes('poolItemForRecord(record)')
  && !detailsBlock.includes('ensurePoolItemForRecord')
  && !detailsBlock.includes('libraryMaterialize'));

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

ok('non-HTTP Cloud provenance stays readable without a broken open-source action',
  detailsBlock.includes('const sourceIsOpenable')
  && renderer.includes("low.startsWith('znada:') || low.startsWith('lumina:') ? 'Znada' : raw")
  && detailsBlock.includes('if (sourceIsOpenable)'));

ok('very large tag sets stay bounded and report the hidden count',
  detailsBlock.includes('const maxVisibleTags = 80')
  && detailsBlock.includes("t('library.moreTags', { n: item.tags.length - maxVisibleTags })")
  && locales.every((locale) => typeof locale.library.moreTags === 'string'
    && locale.library.moreTags.includes('{n}')));

ok('details appear in the local context menu without replacing existing actions',
  renderer.includes("appendContextMenuItem(pop, t('library.details'), () => openCardDetails(freshRecord))"));

ok('the modal stays above app popovers while toasts stay visible above it',
  /\.lib-modal-backdrop\s*\{[\s\S]*?z-index:\s*250;/.test(styles)
  && /\.toast\s*\{[\s\S]*?z-index:\s*300;/.test(styles));

console.log('\nAll ' + passed + ' item-details integration tests passed.');
