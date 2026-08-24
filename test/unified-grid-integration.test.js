'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Read sources with LF-normalized line endings so multi-line substring checks below stay
// valid on Windows working trees checked out with core.autocrlf=true (CRLF).
const readSrc = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const renderer = readSrc('renderer', 'renderer.js');
const html = readSrc('renderer', 'index.html');
const interaction = readSrc('renderer', 'card-interaction.js');
const preload = readSrc('preload.js');
const main = readSrc('main.js');
let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('  ✓ ' + name);
}

const unifiedPos = html.indexOf('<script src="unified-grid.js"></script>');
const interactionPos = html.indexOf('<script src="card-interaction.js"></script>');
const rendererPos = html.indexOf('<script src="renderer.js"></script>');
ok('the shared controller loads before renderer.js', unifiedPos >= 0 && rendererPos > unifiedPos);
ok('the card interaction model loads before renderer.js',
  interactionPos > unifiedPos && rendererPos > interactionPos);
ok('the rejected legacy grid implementation is gone', !renderer.includes('renderEntriesLazilyLegacy'));
ok('local images use a path-stable key across materialization',
  interaction.includes('return `local-${safeType}:${normalized}`')
  && renderer.includes('window.CardInteraction.localKey(path'));
ok('local folders use a separate path-stable key namespace',
  interaction.includes("type === 'folder' ? 'folder' : 'image'"));
ok('every local descriptor exposes its stable key for selection',
  (renderer.match(/selectionKey: key/g) || []).length === 2);
ok('selection is model-backed instead of restricted to pool ids',
  renderer.includes('selection: window.CardInteraction.createSelectionModel()')
  && renderer.includes("#libGrid .lib-card[data-selection-key]"));
ok('ordinary selection clicks do not build the full virtual ordering unless Shift is held',
  (renderer.match(/e\.shiftKey \? orderedSelectionRecords\(\) : \[\]/g) || []).length === 2);
ok('all local builders use the shared checkbox and context-menu controls',
  (renderer.match(/appendSelectionToggle\(card, selectionRecord\)/g) || []).length === 3
  && (renderer.match(/bindLocalCardContextMenu\(card, selectionRecord\)/g) || []).length === 3);
ok('local kebab controls are gone while Online keeps an explicit add control',
  !renderer.includes("textContent = '⋯'")
  && renderer.includes("btn.className = 'lib-menu-btn wh-add'"));
// ONL-008. Both kinds of Online card go through ONE control, and it goes both ways.
// The two builders used to carry a copy each, and each copy latched: added meant
// disabled forever, with the only way back through the Library tab.
ok('both kinds of Online card share one two-way add control',
  (renderer.match(/attachOnlineAddButton\(card, '(?:cloud|internet)', item,/g) || []).length === 2
  && renderer.includes('OnlineAdd.buttonState(')
  && renderer.includes('await removeOnlineFromLibrary(state.pooled)')
  && !renderer.includes('const markAdded'));
const massAssignStart = renderer.indexOf('function openMassAssignMenu(');
const massAssignEnd = renderer.indexOf('function closeLibPopup(', massAssignStart);
const massAssign = renderer.slice(massAssignStart, massAssignEnd);
ok('bulk assignment uses the atomic record IPC instead of materialize-then-assign',
  massAssign.includes('await assignLibraryRecords(records, monitorId, th)')
  && !massAssign.includes('ensurePoolItemForRecord(record)'));
ok('bulk assignment is guarded against repeated clicks while IPC is pending',
  renderer.includes('if (librarySelectionBatchPending()) return;')
  && massAssign.includes("pop.setAttribute('aria-busy', 'true')")
  && massAssign.includes('button.disabled = true'));
ok('bulk assignment completion only closes its own popup and removes its own snapshot',
  massAssign.includes("pop.isConnected && $('#libPopup') === pop")
  && massAssign.includes('removeSelectionSnapshot(records)')
  && !massAssign.includes('clearSelection()'));
ok('single and batch atomic assignment channels cross preload and main',
  preload.includes("ipcRenderer.invoke('library-assign-record'")
  && main.includes("ipcMain.handle('library-assign-record'")
  && preload.includes("ipcRenderer.invoke('library-assign-records'")
  && main.includes("ipcMain.handle('library-assign-records'"));
const assignRecordsMainStart = main.indexOf("ipcMain.handle('library-assign-records'");
const assignRecordsMainEnd = main.indexOf("ipcMain.handle('library-materialize'", assignRecordsMainStart);
const assignRecordsMain = main.slice(assignRecordsMainStart, assignRecordsMainEnd);
ok('existing-card batch assignment skips the unlimited live-folder discovery scan',
  assignRecordsMain.includes('const needsDiscovery = records.some')
  && assignRecordsMain.indexOf('if (needsDiscovery)') < assignRecordsMain.indexOf('folderState.listImages(liveFolderState)'));
ok('transient action popups share one lazy materialization promise',
  renderer.includes('window.CardInteraction.createLazyPoolItem(it, materializeFn)'));
// LIB-004 reversed this deliberately: removal now means "stop showing this in
// Lumina" and is offered for every card, because where a photo is stored is an
// implementation detail the user cannot see and should not be judged by.
ok('removal is available for every selected card, not only pool records',
  renderer.includes('remove.disabled = batchPending;')
  && !renderer.includes('remove.disabled = batchPending || removable !== n')
  && renderer.includes('window.api.libraryRemoveMany(records)'));
ok('the renderer sends the path and kind of each card, since only some have a pool id',
  renderer.includes("return { path: (item && item.path) || record.path, id: (item && item.id) || '', type: record.type };"));
ok('bulk removal crosses one batch IPC instead of looping config writes',
  preload.includes("ipcRenderer.invoke('library-remove-many'")
  && main.includes("ipcMain.handle('library-remove-many'"));
const removeManyStart = main.indexOf("ipcMain.handle('library-remove-many'");
const removeManyEnd = main.indexOf("ipcMain.handle('library-toggle-favorite'", removeManyStart);
const removeMany = main.slice(removeManyStart, removeManyEnd);
ok('bulk removal filters each slot once and never loops the single-item path',
  removeMany.includes('slot.itemIds.filter((id) => !removedIds.has(id))')
  && !removeMany.includes('removeFromLibrary('));
ok('bulk removal never truncates the batch it was given',
  !removeMany.includes('rawRecords.slice(') && !removeMany.includes('records.slice('));
// The whole point of LIB-004 is that a photo can be removed without deleting it.
ok('bulk removal marks folder-backed photos as removed instead of touching files',
  removeMany.includes('folderState.setHidden(liveFolderState')
  && !/fs\.(unlink|rm|rmSync|unlinkSync)/.test(removeMany));
ok('removal keeps enough state to be undone, including slot membership',
  removeMany.includes('undo.slots.push(')
  && removeMany.includes('lastLibraryRemoval = ')
  && main.includes("ipcMain.handle('library-undo-remove'"));
ok('removed photos can still be found and put back later',
  main.includes("ipcMain.handle('library-hidden-list'")
  && main.includes("ipcMain.handle('library-restore'")
  && renderer.includes('if (inRemovedView()) { renderRemovedView(tok); return; }'));
ok('failed bulk removal keeps selection instead of reporting a partial success',
  renderer.includes('if (!res || res.error) {')
  && renderer.includes("toast(t('library.massDeleteFailed'))"));
// A card can be on screen before it reaches the folder index, so "N removed" has to
// come from what main actually did — otherwise the app claims a destructive action
// it did not perform and the card is still there after the re-render.
ok('the success message counts what main reports, not what was requested',
  (renderer.match(/const affected = res\.affected \|\| 0;/g) || []).length === 2
  && renderer.includes("if (!affected) { toast(t('library.massDeleteFailed')); return; }")
  && !renderer.includes('toastRemoved(records.length'));
// One photo can be both a library record and a file inside a watched folder, and can
// be reachable through two overlapping folders. Adding main's internal row counts
// together therefore said "2" for a single removed photo.
// Three reviews in a row found defects in main's orchestration while the suite was
// green, because the modules it calls were correct in isolation. These read the two
// handlers directly.
const purgeStart = main.indexOf("ipcMain.handle('library-delete-forever'");
const purgeEnd = main.indexOf("ipcMain.handle('library-restore'", purgeStart);
const purge = main.slice(purgeStart, purgeEnd);
ok('deleting a file from disk never marks it visible again',
  purgeStart > 0 && !purge.includes('setHidden(liveFolderState, Array.from(gone), false)')
  && !/setHidden\([^)]*false\)/.test(purge));
ok('deleting from disk goes to the recycle bin and only for already-removed paths',
  purge.includes('shell.trashItem(')
  && purge.includes("return { config, deleted: 0, error: 'not_removed' }")
  && !/fs\.(unlink|rmSync|unlinkSync)/.test(purge));
ok('a removed folder is hidden by prefix even when it has a pool record of its own',
  removeMany.includes("records.filter((r) => r.type === 'folder').map((r) => r.path)")
  && !removeMany.includes("r.type === 'folder' && !r.item"));
ok('bulk delete-from-disk skips folder cards, like the card menu does',
  renderer.includes("LIB.selection.values().filter((r) => r.type !== 'folder').map((r) => r.path)"));

// A photo cannot be active and removed at the same time. Every route back into the
// pool goes through one funnel, so a leftover removed-marker or trash entry cannot
// survive underneath an active record and authorise deleting a file in use.
//
// ⚠️ The checks below can only prove a line EXISTS. Whether the funnel actually runs,
// in the right order, and whether the result is written to disk is proved by
// test/library-orchestration.test.js, which executes these handlers for real. Do not
// treat a green result here as evidence that removal works.
const assignment = readSrc('src', 'library-assignment.js');
ok('there is one funnel into the pool, and it clears the removed state',
  main.includes('function addToPool(type, srcPath, extra) {')
  && main.includes('const revisionMoved = markRecordRevived(item);')
  && main.includes('clearRemovedState(srcPath) || revisionMoved')
  && (main.match(/library\.addPath\(config\.library/g) || []).length === 1);
// The funnel is worthless if another module creates pool entries beside it: the
// assignment path did exactly that, so a photo could land in a slot while still
// marked removed.
ok('the assignment module creates pool entries through the same funnel',
  assignment.includes("if (typeof options.addToPool === 'function') return options.addToPool(type, p, options.extra);")
  && (assignment.match(/library\.addPath\(/g) || []).length === 1
  && main.includes('{ ...options, addToPool }')
  && main.includes('options: { ...(entry.options || {}), addToPool },'));
// "In use" is asked of the playlist itself rather than rebuilt beside it. Building a
// parallel list was how an assigned FOLDER contributed its own path but not the photos
// it actually serves. Behaviour: test/library-invariants.test.js.
ok('deleting from disk asks the playlist what is in use, not a parallel list',
  purge.includes('const activePaths = () => inUsePaths();')
  && main.includes('function inUsePaths() {')
  && main.includes('resolved = playlist.resolveSlot(slotFor(monitorId, theme), config.library, {')
  && purge.includes('allowed.has(pathKey(p)) && !before.has(pathKey(p))'));
// One re-check after the dialog says nothing about the state between the second and
// the third file. Every target is re-checked immediately before it is erased, inside
// the lock that every route back into the pool also takes.
// Behaviour proved in test/library-orchestration.test.js ("restored while the dialog
// is open", "becomes active between two deletions").
ok('each deletion is guarded at the moment it happens, inside the library lock',
  purge.includes('return withLibraryLock(async () => {')
  && purge.includes('if (!deletable().has(key) || activePaths().has(key)) { skipped++; continue; }')
  && main.includes('function withLibraryLock(fn) {'));
// Windows hands the same file back as C:/x/a.jpg and C:\x\a.jpg; comparing raw
// lowercased strings let a guard miss the file it was meant to protect. One module
// owns that key and both the pool and the playlist use it (test/path-key.test.js).
ok('paths are compared through one canonical key',
  main.includes("const { pathKey, isDirectChildPath } = require('./src/path-key');")
  && !purge.includes('.toLowerCase()')
  && readSrc('src', 'library.js').includes("require('./path-key')")
  && readSrc('src', 'playlist.js').includes("require('./path-key')")
  && renderer.includes('window.ZnadaPathKey.pathKey(p)')
  && main.includes('set.add(pathKey(im.path));'));
ok('removal clears a matching legacy fallback and undo puts it back',
  removeMany.includes("for (const key of ['lightWallpaper', 'darkWallpaper'])")
  && main.includes('for (const [key, value] of Object.entries(undo.legacy || {}))'));
ok('undo returns only what it removed instead of overwriting the slot',
  main.includes('const undoRestoredIds = new Set();')
  && main.includes('if (!undoRestoredIds.has(id) || present.has(id)) return;')
  && !main.includes('slot.itemIds = snap.itemIds.slice();'));
ok('a restored watched folder is scanned, not just watched',
  main.includes('requestLiveFolderRefresh(restoredFolders.map((it) => it.id));'));
// Exact-path matching let a removed folder still be entered and list its children,
// and restoring one of those children did nothing because the removal is on the parent.
// "Inside that folder" has ONE answer now (library.isUnderPath), instead of a prefix
// compare rewritten at each site — one of which called C:\photos2 a child of C:\photos.
ok('a removed folder hides its descendants through the shared containment helper',
  main.includes('const visibleFolders = folders.filter((f) => !underRemoved(f));')
  && (main.match(/library\.isUnderPath\(/g) || []).length >= 5
  && !/key === dir \|\| key\.startsWith\(`\$\{dir\}\/`\)/.test(main));
// The descendants must be known BEFORE the snapshot and the pool/slot removal — the
// previous attempt found them afterwards and then did nothing with them. Executable
// proof, including undo and the playlist, is in test/library-orchestration.test.js.
ok('a removed folder takes its already-materialized photos with it, collected up front',
  removeMany.includes('const removedDirKeys = records')
  && removeMany.indexOf('const descendants = []') < removeMany.indexOf('const undo = {')
  && removeMany.indexOf('const descendants = []') < removeMany.indexOf('for (const id of removedIds) library.removeItem')
  && removeMany.includes('for (const it of descendants) {'));
ok('undo keeps the recovery entry when the copy could not be brought back',
  main.includes('if (isOwnWallpaperCopy(item.path) && !restoreOwnCopyFile(item)) {'));
// Not "refuse the click" — do not offer the action at all. A star, a bulk Assign or a
// tag row in the trash is an offer to make a removed photo active again.
ok('the trash offers no action that would quietly revive a photo',
  renderer.includes("function inRemovedView() { return LIB.filter === 'removed'; }")
  && renderer.includes("if (inRemovedView()) { toast(t('library.restoreFirst')); return null; }")
  && renderer.includes('assign.hidden = restoring;')
  && renderer.includes("if (inRemovedView()) { toast(t('library.restoreFirst')); return; }")
  // The grid recycles cards in BOTH directions, so the star is always built and hidden
  // by CSS in the trash. Omitting it there was the earlier attempt, and it broke the
  // other way round: a card first built in the trash came back to "All" with no star.
  && renderer.includes("gridEl.classList.toggle('removed-view', inRemovedView());")
  && readSrc('renderer', 'styles.css').includes('#libGrid.removed-view .lib-fav { display: none; }')
  && !renderer.includes('if (!inRemovedView()) {'));
// Deleting files is switched OFF for users (owner's decision 2026-08-10) until the
// transaction around it is proved. One flag in main decides, and the renderer asks main
// rather than keeping its own copy, so the button and the handler cannot disagree.
// Behaviour: test/library-invariants.test.js ("deleting from disk is off").
ok('bulk delete-from-disk stays hidden without an image, and while the feature is off',
  renderer.includes("const hasImage = LIB.selection.values().some((r) => r.type !== 'folder');")
  && renderer.includes('purge.hidden = !restoring || !hasImage || !FEATURES.physicalDelete;')
  // ONL-009 moved the card menu onto the shared action registry, so the switch is now
  // handed to it rather than checked inline. Both halves of the old inline condition —
  // images only, and only while the feature is on — are covered directly by
  // test/card-actions.test.js; what matters here is that the flag still reaches it.
  && renderer.includes('CardActions.menuGroupsFor(subject, { physicalDelete: FEATURES.physicalDelete })')
  && readSrc('renderer', 'card-actions.js').includes("if (action.id === 'deleteForever' && !features.physicalDelete) return false;")
  && renderer.includes('await loadFeatureFlags();')
  && main.includes("if (!physicalDeleteEnabled) return { config, deleted: 0, error: 'disabled' };")
  && preload.includes("getFeatureFlags: () => ipcRenderer.invoke('feature-flags')"));
ok('the removed view keeps a folder a folder',
  renderer.includes("kind: im.type === 'folder' ? 'subfolder' : undefined,"));
// Deciding by entry counts was wrong: a tag or a favourite leaves the counts identical,
// so those edits were never written. Saving the pool is safe by default now, and the
// cheap path is opt-in for handlers that provably touch settings only.
// The window is generous on purpose: this reads source text, so it fails on a comment
// being added as readily as on the call being removed, and it did exactly that when the
// write ORDER changed for DATA-005. What it really guards is covered behaviourally in
// test/pool-consistency.test.js, which asserts the record is on disk before the settings
// that name it. This stays as a cheap tripwire, not as the proof.
ok('persisting the pool is safe by default',
  main.includes('function saveConfig() {')
  && /function saveConfig\(\)[\s\S]{0,1200}saveLibrarySoon\(\);/.test(main)
  && !main.includes('poolCounts()'));
ok('the cheap settings path exists and is used by the settings handler',
  main.includes('function saveSettingsOnly() {')
  && main.includes('if (!saveSettingsOnly()) { // settings only: never touches the pool')
  && !/function saveSettingsOnly\(\)[\s\S]{0,240}saveLibrarySoon\(\);/.test(main));
ok('an unreadable pool file suppresses every write instead of overwriting it',
  main.includes('if (libraryUnsafeToWrite) return;')
  && main.includes('libraryUnsafeToWrite = true;'));
ok('the inline copy is only dropped once the pool write is confirmed',
  /const ok = libraryStore\.save\(config\.library,[\s\S]{0,500}if \(ok\) \{[\s\S]{0,300}keepInline: false/.test(main)
  && /const ok = libraryStore\.save\(config\.library,[\s\S]{0,900}else \{[\s\S]{0,300}enterLibraryWriteDegradedMode\(\);/.test(main));

ok('the count is in cards, not in internal bookkeeping rows',
  main.includes('const affected = records.filter((rec) => (')
  && !renderer.includes('(res.removed || 0) + (res.hidden || 0)'));
// Twice now a defect has survived a green suite because a SECOND, un-updated call
// existed in the interface. Removal has to have exactly one way in: the older
// single-item IPC skipped the trash and the removed-marker, so removing a downloaded
// photo from the Home strip destroyed its only route back (BUG-007).
ok('there is only one removal path — the old single-item IPC is gone',
  !preload.includes('libraryRemove:')
  && !preload.includes("invoke('library-remove'")
  && !main.includes("ipcMain.handle('library-remove'")
  && !renderer.includes('window.api.libraryRemove('));
ok('the assign menu removes through the same path as everything else',
  renderer.includes('await removeRecordFromLibrary(localSelectionRecord(item.path, item.type, item.id));'));

// Every mutating entry in the card menu must be closed in the removed view, or a
// photo comes back into the pool while still marked as removed.
//
// ONL-009 moved this rule from four inline conditions into the shared action registry,
// so it is now checked by ASKING the registry rather than by matching source. That also
// makes the check cover actions added later — including this task's own save/copy,
// which the old string form would have silently ignored.
const CardActions = require('../renderer/card-actions');
{
  const removed = CardActions.localSubject(
    { path: 'C:/photos/a.jpg', type: 'image', id: 'p1', removedView: true },
    { id: 'p1', type: 'image', path: 'C:/photos/a.jpg' },
  );
  const offered = CardActions.actionsFor(removed, { physicalDelete: true }).map((a) => a.id);
  const mutating = ['favorite', 'assign', 'tags', 'remove', 'add', 'saveAs', 'copyFile'];
  ok('no mutating action is offered on a removed card',
    mutating.every((id) => !offered.includes(id)) && offered.includes('restore'));
  // And the menu must be asking with the removed flag set at all — a registry that is
  // right while nobody tells it the card is in the trash protects nothing.
  ok('the card menu tells the registry when it is drawing a removed card',
    renderer.includes('removedView: inRemovedView()'));
}
ok('bulk removal is guarded against repeated clicks and always releases its busy state',
  (renderer.match(/if \(librarySelectionBatchPending\(\)\) return;/g) || []).length >= 5
  && renderer.includes('libraryBatchRemovePending = true;')
  && renderer.includes('libraryBatchRemovePending = false;')
  && renderer.includes("bar.toggleAttribute('aria-busy', batchPending)")
  && renderer.includes('clear.disabled = batchPending'));
ok('bulk removal completion removes only the original selection snapshot',
  renderer.includes('removeSelectionSnapshot(selected)'));
// The per-card pool lookup is shared rather than rebuilt for every selected record.
// syncSelectionUI no longer needs it at all since LIB-004 dropped the availability
// predicate, but the bulk action still resolves records through the shared map.
ok('bulk actions reuse the pool lookup built for the current grid',
  renderer.includes('poolItemForRecord(record, LIB.poolBySelectionKey)'));
ok('ephemeral Home cards never show a dead remove-from-library command',
  renderer.includes('{ assignmentRecord: record, remove: false }'));
ok('the first Escape closes an open tag suggestion list without bubbling to the popup',
  renderer.includes("e.key === 'Escape' && !suggest.hidden")
  && renderer.includes('e.stopPropagation();\n      suggest.hidden = true;'));
ok('a mixed image/folder materialization falls back to a complete grid refresh',
  renderer.includes("addedItems.some((it) => it.type !== 'image')")
  && renderer.includes('new Set(Object.keys(config.library || {}))'));
const upgradeStart = renderer.indexOf('function tryUpgradeMaterializedCards(');
const upgradeEnd = renderer.indexOf('// Shared monitor×theme grid', upgradeStart);
const upgradeSource = renderer.slice(upgradeStart, upgradeEnd);
ok('multi-card materialization rebuilds the gallery lookup only once after all replacements',
  upgradeSource.includes('syncVirtualCardReplacement(card, replacement, it, true)')
  && (upgradeSource.match(/setGridGallerySource\(/g) || []).length === 1);
ok('mixed folder/image views assign gallery indexes independently from grid indexes',
  renderer.includes('galleryIndex: entry && entry.galleryItem ? galleryIndex++ : -1'));
ok('aspect refinement writes by virtual grid index',
  renderer.includes('virtual.setAspect(gridIndex, safe, { relayout: false })'));
// One definition plus one call per local view (All, open folder, pool filters,
// removed). A new view must reuse this adapter rather than grow a parallel path.
ok('every local view enters the shared local adapter',
  (renderer.match(/renderEntriesLazily\(/g) || []).length === 5);
ok('the active resize target switches between local and Online grids',
  renderer.includes("return LIB.filter === 'online' ? $('#whGrid') : $('#libGrid');"));

const onlineStart = renderer.indexOf('// ---- External online providers ----');
const onlineEnd = renderer.indexOf('// Page navigation', onlineStart);
const online = renderer.slice(onlineStart, onlineEnd);
ok('Online state is model-backed instead of counted from materialized DOM',
  online.includes('ONLINE.entries.length') && !online.includes('grid.children.length'));
ok('Online rendering never appends cards directly to the grid',
  !online.includes('grid.appendChild(card)') && !online.includes("grid.innerHTML = ''"));
ok('Online reset and pagination are guarded by a generation token',
  online.includes('++ONLINE.generation')
  && online.includes("generation !== ONLINE.generation || ONLINE.view !== 'search'"));
ok('Cloud favorite removal updates the shared model',
  online.includes('removeOnlineEntry(`cloud:${item.id}`)'));
ok('both local and Online adapters call the same mount function',
  renderer.includes('mountUnifiedGrid(grid, descriptors, LOCAL_GRID_ADAPTER')
  && renderer.includes('mountUnifiedGrid(grid, ONLINE.entries, ONLINE_GRID_ADAPTER'));
const mountStart = renderer.indexOf('function mountUnifiedGrid(');
const mountEnd = renderer.indexOf('const LOCAL_GRID_ADAPTER', mountStart);
const mountSource = renderer.slice(mountStart, mountEnd);
ok('an adapter switch restores grid context after destroying the old controller',
  mountSource.indexOf('destroyUnifiedGrid(grid)') < mountSource.indexOf('grid.__gridContext ='));
ok('local folder cards use a refresh epoch while image versions stay structural',
  renderer.includes("entry.kind === 'subfolder' || entry.kind === 'pool-folder'")
  && renderer.includes('return `${entry.kind}:${folderCardEpoch}`')
  && renderer.includes('getVersion: (entry) => localGridVersion(entry)'));
ok('Online providers publish independently while stale hidden-tab results are rejected',
  online.includes('publishOnlineBatch(internetTask, generation)')
  && online.includes('publishOnlineBatch(znadaTask, generation)')
  && online.includes("return LIB.filter === 'online'"));
ok('fresh Online feeds cancel the previous feed resize lifecycle',
  online.includes('if (opts.fresh) resetLibObservers(grid)'));
ok('session expiry replaces an invalid in-flight favorites feed',
  renderer.includes("if (wasFavorites && ONLINE.view !== 'favorites')")
  && renderer.includes('ONLINE.loaded = false;\n        doOnlineSearch(true);'));

console.log('\nAll ' + passed + ' unified-grid integration tests passed.');
