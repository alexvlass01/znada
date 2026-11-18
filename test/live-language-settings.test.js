'use strict';

// BUG-055. A live language switch goes through refreshTexts(). Two lines of the settings
// page are drawn by their own functions — the event journal (with its "nothing happened"
// line) and the media folder label — and refreshTexts() did not redraw them, so they kept
// the previous language until a restart. BUG-057 covers out-of-order media folder updates.
// Run the renderer functions and the settings move binding with a stand-in DOM and IPC.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MediaFolder = require('../renderer/media-folder');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8').split('\r\n').join('\n');

let passed = 0;
function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
  passed++;
}

function functionSource(name) {
  const start = source.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `missing function ${name}`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start + 1, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function element() {
  const classes = new Set();
  return {
    children: [], textContent: '', title: '', className: '', hidden: false,
    classes,
    classList: { toggle(name, active) {
      if (active) classes.add(name);
      else classes.delete(name);
    } },
    addEventListener(name, listener) { this[name] = listener; },
    set innerHTML(_v) { this.children = []; },
    appendChild(child) { this.children.push(child); return child; },
    removeAttribute() {},
    get text() {
      return this.textContent + this.children.map((c) => c.text).join('');
    },
  };
}

const DICTS = {
  de: { 'journal.empty': 'Keine Probleme', 'mediaFolder.inProfile': 'Im Profil' },
  ru: { 'journal.empty': 'Проблем не было', 'mediaFolder.inProfile': 'В профиле' },
};
let lang = 'de';
const dom = {
  '#eventLogList': element(),
  '#mediaFolderPath': element(),
  '#btnMediaFolder': element(),
  '#btnMediaFolderBack': element(),
};
const pathRow = dom['#mediaFolderPath'];
const backButton = dom['#btnMediaFolderBack'];
const currentFolder = { custom: true, root: 'D:\\Copies', state: 'ok' };
const unavailableFolder = { custom: true, root: 'E:\\Copies', state: 'unavailable' };
const profileFolder = { custom: false, state: 'ok' };
let reportMoveState;

const stubs = [
  'applyI18n', 'applyThemeToUI', 'renderCloudAccount', 'buildMonitorMap', 'updateSingleWallRow',
  'renderPreviews', 'renderHome', 'updateShortcutButtons', 'renderUpdate', 'renderSmartPanel',
  'renderAboutVersion', 'closeLibPopup', 'syncSelectionUI',
];
const ctx = {
  $: (sel) => dom[sel] || null,
  document: { createElement: () => element() },
  t: (key) => DICTS[lang][key] || key,
  window: {
    api: {
      eventLogGet: async () => ({ entries: [] }),
      mediaFolderState: async () => profileFolder,
    },
  },
  MediaFolder: { pathLabel: MediaFolder.pathLabel, async openMoveDialog({ onState }) { reportMoveState = onState; } },
  formatFileSize() {},
  toast() {},
  WhatsNewDialog: { close() {} },
  currentTheme: 'light',
};
for (const name of stubs) ctx[name] = () => {};
vm.createContext(ctx);
const rowStart = source.indexOf('// read out of the config, because the answer');
const rowEnd = source.indexOf('// Event journal (settings page)', rowStart);
const moveStart = source.indexOf("const btnMediaFolder = $('#btnMediaFolder');");
const moveEnd = source.indexOf('// ---- settings: re-open the welcome screen', moveStart);
assert.ok(rowStart >= 0 && rowEnd > rowStart && moveStart >= 0 && moveEnd > moveStart);
vm.runInContext([
  functionSource('renderEventLog'),
  source.slice(rowStart, rowEnd),
  functionSource('refreshTexts'),
  source.slice(moveStart, moveEnd),
].join('\n'), ctx);

function assertMediaFolderRow({ text, title, away, backHidden }) {
  assert.deepStrictEqual(
    { text: pathRow.textContent, title: pathRow.title, away: pathRow.classes.has('media-folder-away'), backHidden: backButton.hidden },
    { text, title, away, backHidden },
  );
}

(async () => {
  console.log('live language switch on the settings page (BUG-055)');
  await ctx.renderEventLog();
  await ctx.renderMediaFolderRow();
  ok('starts in the first language', dom['#eventLogList'].text === 'Keine Probleme'
    && dom['#mediaFolderPath'].textContent === 'Im Profil');

  lang = 'ru';
  ctx.refreshTexts();
  await new Promise((resolve) => { setImmediate(resolve); });
  ok('empty journal line follows the new language', dom['#eventLogList'].text === 'Проблем не было');
  ok('media folder label follows the new language', dom['#mediaFolderPath'].textContent === 'В профиле');

  console.log('media folder row rejects superseded IPC responses (BUG-057)');
  const pending = [];
  ctx.window.api.mediaFolderState = () => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
  });

  const beforeMove = ctx.renderMediaFolderRow();
  await dom['#btnMediaFolder'].click();
  assert.equal(pending.length, 2, 'opening the move dialog starts its own refresh');
  await reportMoveState(currentFolder);
  const movedRow = { text: currentFolder.root, title: currentFolder.root, away: false, backHidden: false };
  assertMediaFolderRow(movedRow);
  pending.shift().resolve(profileFolder);
  await beforeMove;
  assertMediaFolderRow(movedRow);
  pending.shift().resolve(profileFolder);
  await new Promise(setImmediate);
  assertMediaFolderRow(movedRow);
  ok('both pre-move replies leave the dialog result intact', pending.length === 0);

  const older = ctx.renderMediaFolderRow();
  const newer = ctx.renderMediaFolderRow();
  pending[1].resolve(unavailableFolder);
  await newer;
  pending[0].resolve(profileFolder);
  await older;
  pending.length = 0;
  const awayRow = { text: unavailableFolder.root, title: unavailableFolder.root, away: true, backHidden: false };
  assertMediaFolderRow(awayRow);
  ok('reversed replies retain the newer unavailable folder', pathRow.textContent === unavailableFolder.root);

  const superseded = ctx.renderMediaFolderRow();
  lang = 'de';
  ctx.refreshTexts();
  pending[0].reject(new Error('superseded IPC request failed'));
  await superseded;
  assertMediaFolderRow(awayRow);
  pending[1].resolve(profileFolder);
  await new Promise(setImmediate);
  assertMediaFolderRow({ text: 'Im Profil', title: '', away: false, backHidden: true });
  ok('language refresh replaces the path even after an obsolete IPC failure', pathRow.textContent === 'Im Profil');

  await ctx.renderMediaFolderRow(currentFolder);
  const current = ctx.renderMediaFolderRow();
  pending[2].reject(new Error('current IPC request failed'));
  await current;
  assertMediaFolderRow({ text: 'Im Profil', title: '', away: false, backHidden: true });

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
